// Run: node --test __tests__/rateLimitHonesty.test.js   (from backend/)
//
// ---------------------------------------------------------------------------
// WHAT A REFUSAL IS ALLOWED TO PROMISE.
// ---------------------------------------------------------------------------
// A 429 that names the wrong window is worse than a 429 that names none. The
// person follows the advice, comes back at the time they were given, is refused
// a second time, and concludes the feature is broken rather than that they were
// throttled. Every assertion in this file is about that one failure.
//
// The defects this pins, all of which shipped:
//
//   * "Loading venues too fast. Give it a few seconds." on utils/placesBudget.js,
//     which is 30 calls per ROLLING HOUR. Five seconds later: the same refusal.
//   * "Too many tries. Give it a minute." on the invite-join counter, whose
//     window is an HOUR. Wrong by a factor of sixty.
//   * "Try again in a few minutes" on the verification-resend and password-reset
//     budgets, which have a leg measured in DAYS. That one locks somebody out of
//     confirming their email and out of account recovery.
//   * One sentence serving a rolling hour, a shared UTC day and a calendar
//     month on the photo proxy. No wording is true across all three.
//   * 429 on two permanent capacity caps in routes/guest.js, where waiting
//     never helps and the fix is somebody else's action.
//
// WHY PINNED RATHER THAN REVIEWED. Copy is the thing that rots first: nothing
// else in the build goes red when a sentence stops being true, and the comment
// in routes/venueSearch.js that said "THE WINDOW IS AN HOUR, SO THE SENTENCE
// MAY NOT SAY SECONDS" sat 152 lines above a second call site that said seconds
// anyway. A comment is not enforcement.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'rate-limit-honesty-test-secret';

const {
  retryAfterSeconds, resetsAtISO, waitPhrase,
  msUntilUtcMidnight, msUntilUtcMonthStart,
} = require('../utils/retryAfter');

const HOUR_MS = 60 * 60 * 1000;

// ===========================================================================
// PART 1 - the phrasing itself
// ===========================================================================

test('a window measured in hours never comes out of waitPhrase as seconds', () => {
  // The original defect in one line. Nothing waitPhrase produces may contain the
  // word "second", because every window in this codebase that a user waits on is
  // minutes at the shortest.
  for (const ms of [1, 999, 60_000, HOUR_MS, 5 * HOUR_MS, 26 * HOUR_MS, 30 * 24 * HOUR_MS]) {
    assert.ok(!/second/i.test(waitPhrase(ms)), `waitPhrase(${ms}) said seconds`);
  }
});

test('the phrase is never longer than the wait it describes', () => {
  // Rounding DOWN is the direction that reproduces the bug: a caller told ten
  // minutes who needed an hour has been told something untrue. Every bucket
  // here is checked against the number of milliseconds it claims.
  const cases = [
    [30_000, 'in under a minute'],
    [60_000, 'in under a minute'],
    [61_000, 'in about 2 minutes'],
    [10 * 60_000, 'in about 10 minutes'],
    [50 * 60_000, 'in about an hour'],
    [3 * HOUR_MS, 'in about 3 hours'],
    [24 * HOUR_MS, 'in about a day'],
    [20 * 24 * HOUR_MS, 'in about 20 days'],
  ];
  for (const [ms, expected] of cases) {
    assert.strictEqual(waitPhrase(ms), expected, `${ms}ms`);
  }
});

test('a zero or nonsense wait says "in a moment" rather than inventing a number', () => {
  for (const bad of [0, -1, NaN, undefined, null, 'soon']) {
    assert.strictEqual(waitPhrase(bad), 'in a moment', String(bad));
  }
});

test('Retry-After is always at least one second, because zero means retry now', () => {
  // A header of 0 is an instruction to retry immediately into the same refusal,
  // which is a retry loop rather than a rate limit.
  for (const bad of [0, -5, NaN, undefined]) assert.strictEqual(retryAfterSeconds(bad), 1);
  assert.strictEqual(retryAfterSeconds(1500), 2, 'partial seconds round up, never down');
  assert.strictEqual(retryAfterSeconds(HOUR_MS), 3600);
});

test('resetsAt is an instant, and it is in the future', () => {
  const iso = resetsAtISO(HOUR_MS);
  const at = new Date(iso).getTime();
  assert.ok(Number.isFinite(at), 'resetsAt must parse');
  assert.ok(at - Date.now() > HOUR_MS - 5_000 && at - Date.now() <= HOUR_MS + 5_000);
});

test('the UTC day and month boundaries are real boundaries, not fixed offsets', () => {
  const day = msUntilUtcMidnight();
  assert.ok(day > 0 && day <= 24 * HOUR_MS, `${day}ms is not inside a day`);
  const at = new Date(Date.now() + day);
  assert.strictEqual(at.getUTCHours(), 0);
  assert.strictEqual(at.getUTCMinutes(), 0);

  const month = msUntilUtcMonthStart();
  assert.ok(month >= day, 'the next month cannot arrive before the next midnight');
  const first = new Date(Date.now() + month);
  assert.strictEqual(first.getUTCDate(), 1, 'the month boundary is the 1st');
  assert.strictEqual(first.getUTCHours(), 0);
});

// ===========================================================================
// PART 2 - the Places ledger knows which leg refused, and when it lifts
// ===========================================================================

const placesBudget = require('../utils/placesBudget');
const {
  allowPlacesSearch, allowGlobalPlacesCall, placesRetryAfter, globalPlacesRetryAfter,
  __resetPlacesBudget, PER_USER_HOURLY, GLOBAL_DAILY, UNAUTH_DAILY,
} = placesBudget;

test('the hourly leg reports an hour, not a few seconds', () => {
  __resetPlacesBudget();
  for (let i = 0; i < PER_USER_HOURLY; i++) assert.strictEqual(allowPlacesSearch(41), true);
  assert.strictEqual(allowPlacesSearch(41), false);

  const { leg, ms } = placesRetryAfter(41);
  assert.strictEqual(leg, 'user-hour');
  // Everything was spent in one burst, so the first unit frees an hour from now.
  assert.ok(ms > HOUR_MS - 10_000 && ms <= HOUR_MS, `${ms}ms is not most of an hour`);
  assert.strictEqual(waitPhrase(ms), 'in about an hour');
});

test('a two-unit request is told when TWO units free up, not one', () => {
  // routes/crowd.js /alternatives charges 2 on a cold cache. Reporting the
  // oldest charge would send that caller back before the second slot exists,
  // which is the same defect one step smaller.
  __resetPlacesBudget();
  const now = Date.now();
  for (let i = 0; i < PER_USER_HOURLY; i++) allowPlacesSearch(42);
  const one = placesRetryAfter(42, 1).ms;
  const two = placesRetryAfter(42, 2).ms;
  assert.ok(two >= one, 'two units cannot free up before one does');
  assert.ok(two > 0 && two <= HOUR_MS + (Date.now() - now));
});

test('the shared daily leg reports the UTC day and is not blamed on the caller', () => {
  __resetPlacesBudget();
  // Spend the global day through the unauthenticated door so no single user
  // holds an hourly bucket. This is the leg a venue owner or a first-time
  // searcher can meet without having done anything at all.
  for (let i = 0; i < UNAUTH_DAILY; i++) assert.strictEqual(allowGlobalPlacesCall(1), true);
  assert.strictEqual(allowGlobalPlacesCall(1), false, 'the unauthenticated share is spent');
  assert.strictEqual(globalPlacesRetryAfter(1).leg, 'unauth-day');
  assert.ok(Math.abs(globalPlacesRetryAfter(1).ms - msUntilUtcMidnight()) < 5_000);

  // And the authenticated reserve, once it is gone too.
  for (let i = 0; i < GLOBAL_DAILY - UNAUTH_DAILY; i++) allowPlacesSearch(1000 + (i % 500));
  const after = placesRetryAfter(77);
  assert.strictEqual(after.leg, 'global-day');
  assert.ok(Math.abs(after.ms - msUntilUtcMidnight()) < 5_000);
  __resetPlacesBudget();
});

test('an identity the ledger cannot pin down is not offered a window', () => {
  // It is refused every time, forever. Any wait reported would be a lie of a
  // different kind, so the routes answer "sign in again" instead.
  __resetPlacesBudget();
  assert.strictEqual(placesRetryAfter(null).leg, 'identity');
  assert.strictEqual(placesRetryAfter(null).ms, 0);
});

test('a caller with budget left is told nothing is refusing', () => {
  __resetPlacesBudget();
  assert.strictEqual(placesRetryAfter(43).leg, null);
  assert.strictEqual(placesRetryAfter(43).ms, 0);
});

// ===========================================================================
// PART 3 - the per-user probe budget behind event search
// ===========================================================================

const { createUserBudget } = require('../utils/probeBudget');

test('a spent hourly probe budget reports the hour it actually runs on', () => {
  const b = createUserBudget({ name: 'honesty', hourly: 3, daily: 100 });
  for (let i = 0; i < 3; i++) assert.strictEqual(b.allow(5), true);
  assert.strictEqual(b.allow(5), false);
  const ms = b.retryAfterMs(5);
  assert.ok(ms > HOUR_MS - 10_000 && ms <= HOUR_MS, `${ms}ms`);
});

test('when the day and the hour are both spent, the answer is the LATER of the two', () => {
  // A caller freed by the hour and still held by the day has not been freed,
  // and telling them the hour sends them back into the same refusal.
  const b = createUserBudget({ name: 'honesty-day', hourly: 100, daily: 2 });
  assert.strictEqual(b.allow(6), true);
  assert.strictEqual(b.allow(6), true);
  assert.strictEqual(b.allow(6), false);
  const ms = b.retryAfterMs(6);
  assert.ok(ms > 23 * HOUR_MS, `a daily window reported as ${ms}ms is the hour, not the day`);
});

test('a budget with room left reports no wait at all', () => {
  const b = createUserBudget({ name: 'honesty-free', hourly: 5, daily: 5 });
  assert.strictEqual(b.retryAfterMs(7), 0, 'an untouched key');
  b.allow(7);
  assert.strictEqual(b.retryAfterMs(7), 0, 'a key with budget left');
});

// ===========================================================================
// PART 4 - the guest counters, which face people with no account at all
// ===========================================================================

const guest = require('../routes/guest');

test('the guest counters report their own fixed window rather than "later"', () => {
  const counter = guest.createGuestCounter({
    name: 'honesty-guest', limit: 2, windowMs: HOUR_MS, maxKeys: 10,
  });
  assert.strictEqual(counter.allow('k'), true);
  assert.strictEqual(counter.allow('k'), true);
  assert.strictEqual(counter.allow('k'), false);
  const ms = counter.retryAfterMs('k');
  assert.ok(ms > HOUR_MS - 10_000 && ms <= HOUR_MS, `${ms}ms is not the hour this counter runs on`);
  assert.strictEqual(waitPhrase(ms), 'in about an hour');
  assert.strictEqual(counter.retryAfterMs('never-seen'), 0);
});

// ===========================================================================
// PART 5 - the mail budgets, and the Postgres trap a stubbed pool cannot see
// ===========================================================================

const { buildMailBudgetQuery } = require('../routes/auth').__testing;

test('every parameter the mail-budget query binds is one the query references', () => {
  // Postgres infers a parameter's type from its use, so binding $1 without
  // mentioning it fails the whole statement with "could not determine data type
  // of parameter $1". Only the EXHAUSTED legs appear in this query, so the set
  // of parameters depends on which limit refused: a fixed [key, ip] prefix was
  // unreferenced whenever the address leg was not the one that bit.
  //
  // Every stubbed test in this suite would pass with that bug in place. This is
  // the assertion that would not.
  const legSets = [
    [{ scope: 'account', interval: '1 hour', count: 5, limit: 5, exhausted: true }],
    [{ scope: 'ip', interval: '1 hour', count: 30, limit: 30, exhausted: true }],
    [
      { scope: 'account', interval: '1 hour', count: 9, limit: 5, exhausted: true },
      { scope: 'account', interval: '1 day', count: 12, limit: 10, exhausted: true },
      { scope: 'ip', interval: '1 hour', count: 31, limit: 30, exhausted: true },
    ],
  ];
  for (const legs of legSets) {
    const q = buildMailBudgetQuery('email_verifications', 'user_id', 7, '1.2.3.4', legs);
    assert.ok(q, 'an exhausted leg must produce a query');
    for (let i = 1; i <= q.params.length; i++) {
      assert.ok(q.sql.includes(`$${i}`), `$${i} is bound and never referenced`);
    }
    const highest = Math.max(...[...q.sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
    assert.strictEqual(highest, q.params.length, 'the query references a parameter nobody bound');
  }
});

test('a budget with nothing exhausted asks Postgres nothing', () => {
  const q = buildMailBudgetQuery('password_reset_requests', 'email_key', 'abc', '1.2.3.4', [
    { scope: 'email', interval: '1 hour', count: 1, limit: 3, exhausted: false },
  ]);
  assert.strictEqual(q, null, 'a refusal that is only the minimum gap must not run a second query');
});

test('the offset is how many rows have to age out, never a negative', () => {
  const q = buildMailBudgetQuery('email_verifications', 'user_id', 7, null, [
    { scope: 'account', interval: '1 day', count: 14, limit: 10, exhausted: true },
  ]);
  assert.deepStrictEqual(q.params, [7, 4]);
  assert.match(q.sql, /ORDER BY created_at ASC OFFSET \$2::int LIMIT 1/);
  assert.match(q.sql, /\+ INTERVAL '1 day'/, 'the window added back must be the window measured');
});

// ===========================================================================
// PART 6 - the retired sentences, so they cannot come back
// ===========================================================================

const ROUTES = path.join(__dirname, '..', 'routes');
const src = (f) => fs.readFileSync(path.join(ROUTES, f), 'utf8');

// A sentence is retired only where it was DISPLAY COPY. The comments that
// record why each one was wrong are the documentation of this fix and must
// survive, so the sweep looks for the string inside a quoted literal rather
// than anywhere in the file.
function saysInCopy(file, phrase) {
  return src(file)
    .split('\n')
    .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
    .some((line) => line.includes(phrase));
}

test('no route still promises a wait in seconds for an hourly budget', () => {
  for (const file of ['crowd.js', 'venueSearch.js', 'venueDashboard.js']) {
    assert.ok(!saysInCopy(file, 'Give it a few seconds'),
      `${file} still tells an hourly budget to wait a few seconds`);
    assert.ok(!saysInCopy(file, 'Loading venues too fast'),
      `${file} still blames the caller's speed for a rolling-hour ceiling`);
  }
});

test('no route still answers an hourly counter with "Give it a minute"', () => {
  assert.ok(!saysInCopy('guest.js', 'Give it a minute'),
    'the invite-join counter runs on an hour and is telling strangers to wait a minute');
});

test('the vaguest refusals on the metered routes are gone', () => {
  const retired = [
    ['guest.js', 'Try again later.'],
    ['events.js', 'Try again in a bit.'],
    ['stories.js', 'Try again in a little while.'],
    ['venueDashboard.js', 'Try again in a little while.'],
    ['venueSearch.js', 'Too many photo requests right now'],
  ];
  for (const [file, phrase] of retired) {
    assert.ok(!saysInCopy(file, phrase), `${file} still says "${phrase}"`);
  }
});

test('the venue badge no longer answers a throttle with an empty body', () => {
  // The only 429 in the codebase that sent nothing at all. A venue saw a broken
  // image on their own homepage and had no string to search for, no sentence to
  // read and no header to act on. They are also the person best placed to
  // notice, which made silence the worst available answer.
  assert.ok(!/res\.status\(429\)\.send\(''\)/.test(src('badge.js')),
    'the badge is back to refusing with an empty body');
  assert.match(src('badge.js'), /setRetryAfter\(res, ms\)/,
    'the badge refusal must carry Retry-After, the only channel an <img> can act on');
});

test('the two permanent capacity caps in guest.js are 409s, not 429s', () => {
  // Neither is a rate. The 50-guest cap and LINK_JOIN_MEMBER_CAP are ceilings on
  // the PLAN: nothing ages out of either, so a status that tells the client to
  // retry later is telling it something that will never become true. The action
  // belongs to the host.
  const s = src('guest.js');
  assert.match(s, /status\(409\)[\s\S]{0,220}as many guests as it can take/);
  assert.match(s, /status\(409\)[\s\S]{0,200}This plan is full/);
  assert.ok(!/status\(429\)[\s\S]{0,160}This plan is full/.test(s));
});

test('every refusal built by these routes goes through the shared window helper', () => {
  // The point is not the import. It is that a route which invents its own
  // adjective is a route with nothing pinning that adjective to a real window,
  // which is how all ten of these got written in the first place.
  for (const file of [
    'crowd.js', 'venueSearch.js', 'guest.js', 'auth.js',
    'events.js', 'stories.js', 'ai.js', 'venueDashboard.js', 'badge.js',
  ]) {
    assert.match(src(file), /require\('\.\.\/utils\/retryAfter'\)/,
      `${file} refuses callers without a way to tell them when the refusal lifts`);
  }
});

// ===========================================================================
// PART 7 - the badge, driven for real, because the defect was the BODY
// ===========================================================================
// A source scan can prove the empty send is gone. It cannot prove what arrives
// instead is a thing a browser will paint and a person can read, and that was
// the whole complaint: a venue saw a broken image on their own homepage with
// nothing to search for.

const http = require('node:http');
const express = require('express');

test('a throttled badge answers with a readable SVG and a Retry-After', async () => {
  const pool = require('../config/database');
  // Nothing here should reach Postgres: the per-address meter refuses before
  // the venue lookup, which is the point of metering the MISS.
  let dbCalls = 0;
  const realQuery = pool.query;
  pool.query = (...a) => { dbCalls += 1; return realQuery.apply(pool, a); };

  const badge = require('../routes/badge');
  badge.__test.resetBadgeBudget();

  const app = express();
  app.set('trust proxy', true);
  app.use('/api/badge', badge);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    // Spend this address's hourly allowance. Every one of these is a cache miss
    // on a place id no venue has claimed, so they all fall through the meter.
    const id = 'ChIJrateLimitHonestyTestPlaceIdAAA';
    for (let i = 0; i < badge.__test.BADGE_IP_HOURLY; i++) {
      await fetch(`${base}/api/badge/${id}${i}.svg`);
    }
    const res = await fetch(`${base}/api/badge/${id}X.svg`);
    assert.strictEqual(res.status, 429);
    assert.match(res.headers.get('content-type') || '', /image\/svg\+xml/,
      'a badge refusal that is not an image is a broken image on a venue homepage');
    assert.ok(Number(res.headers.get('retry-after')) > 0,
      'the only channel an <img> tag can act on is the header, and it was absent');
    assert.strictEqual(res.headers.get('cache-control'), 'no-store',
      'a refusal cached for the 15 minutes a real badge is cached for outlives its own window');

    const body = await res.text();
    assert.ok(body.length > 0, 'this was the only 429 in the codebase with no body at all');
    assert.match(body, /^<svg /, 'the body has to be something a browser paints');
    assert.match(body, /Live status paused/, 'and something a person can read and search for');
    assert.match(body, /aria-label=/, 'including for a screen reader');
  } finally {
    badge.__test.resetBadgeBudget();
    pool.query = realQuery;
    await new Promise((r) => server.close(r));
    await pool.end?.().catch(() => {});
  }
});
