// Run: node --test  (from backend/)
//
// ===========================================================================
// THE INCOMING-FLOCKS FEED IS A WINDOW, NOT AN ARCHIVE.
//
// GET /api/venue-dashboard/incoming-flocks shipped with NO `event_time`
// predicate and `ORDER BY f.event_time DESC`, so what a venue owner read under
// the heading "Incoming Flocks" was "the furthest-future non-cancelled flock
// that ever voted for my place id", forever. In production that is flock 117, a
// confirmed Birthday Dinner dated 2026-04-26, which would still have been
// sitting at the top of that card in December. An owner staffing against it
// would be staffing for a party that already happened.
//
// Two properties are pinned here, and they are the two the defect broke:
//
//   1. THE WINDOW. Nothing outside [NOW() - 12h, NOW() + 7d] is served. The
//      lower bound is the tail of the check-in window routes/checkin.js already
//      defines ("NOW() BETWEEN event_time - 3h AND event_time + 12h"), so the
//      feed stops showing a group at exactly the moment the app stops letting
//      that group check in — a flock two hours past its start is IN the
//      building and must stay on the card. The upper bound is measured: of the
//      eight production flocks that have ever carried an event_time the longest
//      created_at -> event_time gap is 2.7 days, so 7 days covers every plan
//      this product has seen with 2x headroom.
//
//   2. THE ORDER. Ascending. `DESC` put the furthest-away plan first, which is
//      backwards for a feed whose job is "what is about to hit me".
//
// AND THE GAP THAT IS PUBLISHED RATHER THAN GUESSED AT. `venue_votes.venue_id`
// is nullable and best-effort — sockets/handlers.js writes it with COALESCE
// precisely because ids arrive missing — so votes carrying only `venue_name`
// never reach the owner they belong to. Measured read-only against production
// 2026-08-18: 6 rows in venue_votes, 2 with a NULL venue_id. Matching those on
// the name would be an AUTHORIZATION decision made on a free-text string that
// is neither unique nor scoped to a city, so the route publishes a COUNT of
// them and nothing else. This file pins that the count is a count: no flock id,
// no name, no date, no member count can ride out on that query.
//
// THE FAKE FILTERS ONLY WHAT THE SQL ASKS IT TO. It extracts the window and the
// sort direction out of the statement the route actually sent, exactly the way
// __tests__/venueDashboardAuthz.test.js extracts ownership predicates. If the
// route drops the window, the fake stops filtering, the stale row comes back,
// and the assertion fails — the fake cannot supply the correctness the route
// forgot.
// ===========================================================================
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

process.env.JWT_SECRET = 'incoming-flocks-window-test-secret';
process.env.GOOGLE_PLACES_API_KEY = 'test-places-key';
delete process.env.VENUE_BILLING_ENABLED;

const pool = require('../config/database');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

let log = [];
let FLOCKS = [];
let UNATTRIBUTED_ROWS = [{ n: 2 }];
let COUNT_QUERY_THROWS = false;

const PROFILE = { user_id: 1, id: 11, google_place_id: 'PLACE_A', verified: true, tier: 'free' };

function resetTables() {
  const now = Date.now();
  FLOCKS = [
    // The production defect itself: a confirmed flock four months in the past.
    { id: 31, venue_id: 'PLACE_A', name: 'Birthday Dinner', event_time: new Date(now - 120 * DAY), status: 'confirmed', member_count: 4 },
    // Past the check-in tail — those people came and went yesterday.
    { id: 36, venue_id: 'PLACE_A', name: 'Last night', event_time: new Date(now - 20 * HOUR), status: 'confirmed', member_count: 3 },
    // Started two hours ago: standing in the building right now.
    { id: 35, venue_id: 'PLACE_A', name: 'Here now', event_time: new Date(now - 2 * HOUR), status: 'confirmed', member_count: 5 },
    { id: 32, venue_id: 'PLACE_A', name: 'Thursday crew', event_time: new Date(now + 2 * DAY), status: 'confirmed', member_count: 6 },
    { id: 33, venue_id: 'PLACE_A', name: 'Next weekend', event_time: new Date(now + 6 * DAY), status: 'confirmed', member_count: 2 },
    // Beyond the horizon: real, but not something to staff for this week.
    { id: 34, venue_id: 'PLACE_A', name: 'A month out', event_time: new Date(now + 30 * DAY), status: 'confirmed', member_count: 8 },
    // Undated. Not schedulable, so it cannot be placed in any window honestly.
    { id: 37, venue_id: 'PLACE_A', name: 'Someday', event_time: null, status: 'confirmed', member_count: 2 },
    // Another venue's, to keep the ownership predicate honest here too.
    { id: 41, venue_id: 'PLACE_B', name: "B's crew", event_time: new Date(now + DAY), status: 'confirmed', member_count: 9 },
  ];
  UNATTRIBUTED_ROWS = [{ n: 2 }];
  COUNT_QUERY_THROWS = false;
}

const UNIT_MS = { hours: HOUR, hour: HOUR, days: DAY, day: DAY };

// Pull the window out of the statement the route actually sent. Returns nulls
// when a bound is absent, in which case that side is not filtered — which is
// what a real database would do, and is how the pre-fix query fails this file.
function windowFrom(sql) {
  // NOW_UTC matches both the bare NOW() this feed used to carry and the
  // (NOW() AT TIME ZONE 'UTC') it carries now. The rewrite was a real fix:
  // event_time is TIMESTAMP WITHOUT TIME ZONE holding a UTC wall clock, and a
  // bare NOW() casts it at the database session zone, so the window was correct
  // only because Railway runs UTC. The offset from now is identical either way,
  // which is why the expected math below is unchanged; only the spelling moved,
  // and this helper had pinned the spelling.
  const NOW_UTC = "(?:NOW\\(\\)|\\(NOW\\(\\) AT TIME ZONE 'UTC'\\))";
  const past = sql.match(new RegExp(`event_time > ${NOW_UTC} - INTERVAL '(\\d+) (hours?|days?)'`));
  const ahead = sql.match(new RegExp(`event_time < ${NOW_UTC} \\+ INTERVAL '(\\d+) (hours?|days?)'`));
  return {
    from: past ? Date.now() - Number(past[1]) * UNIT_MS[past[2]] : null,
    to: ahead ? Date.now() + Number(ahead[1]) * UNIT_MS[ahead[2]] : null,
    dropUndated: /event_time IS NOT NULL/.test(sql),
    desc: /ORDER BY f\.event_time DESC/.test(sql),
  };
}

function dispatch(rawSql, params = []) {
  const sql = String(rawSql).replace(/\s+/g, ' ').trim();
  log.push({ sql, params });

  if (/SELECT id, google_place_id, verified, category, verification_requested_at FROM venue_profiles/.test(sql)) {
    return { rows: [{ id: PROFILE.id, google_place_id: PROFILE.google_place_id, verified: PROFILE.verified }] };
  }
  if (/FROM venue_profiles vp LEFT JOIN venue_subscriptions/.test(sql)) return { rows: [{ tier: PROFILE.tier }] };

  // The unattributed count. Matched on its own shape so it can never be
  // answered by the feed branch below.
  if (/FROM venue_votes vv JOIN flocks f/.test(sql)) {
    if (COUNT_QUERY_THROWS) throw new Error('count query blew up');
    return { rows: UNATTRIBUTED_ROWS };
  }

  // The feed.
  if (/FROM flocks f JOIN venue_votes vv/.test(sql)) {
    const m = sql.match(/vv\.venue_id = \$(\d+)/);
    const placeIdx = m ? Number(m[1]) - 1 : null;
    const w = windowFrom(sql);
    const rows = FLOCKS
      .filter((f) => placeIdx === null || f.venue_id === params[placeIdx])
      .filter((f) => !(w.dropUndated && f.event_time == null))
      .filter((f) => w.from === null || (f.event_time && f.event_time.getTime() > w.from))
      .filter((f) => w.to === null || (f.event_time && f.event_time.getTime() < w.to))
      .sort((a, b) => {
        const at = a.event_time ? a.event_time.getTime() : (w.desc ? -Infinity : Infinity);
        const bt = b.event_time ? b.event_time.getTime() : (w.desc ? -Infinity : Infinity);
        return w.desc ? bt - at : at - bt;
      })
      // THE FAKE HANDS BACK ONLY WHAT THE STATEMENT ASKED FOR. `flocks.name` is
      // the group's own name for their night, typed on the create screen for
      // their own use, and it must not cross into a venue's dashboard. A fake
      // that returns it unconditionally would keep serving it after the route
      // stopped selecting it, and the redaction below would pass on a lie.
      .map(({ id, name, event_time, status, member_count }) => {
        const row = { id, event_time, status, member_count };
        if (/f\.name AS title/.test(sql)) row.title = name;
        return row;
      });
    return { rows };
  }

  return Promise.reject(new Error(`unscripted query: ${sql.slice(0, 160)}`));
}

pool.query = (sql, params) => {
  try {
    return Promise.resolve(dispatch(sql, params));
  } catch (err) {
    return Promise.reject(err);
  }
};

const placesBudget = require('../utils/placesBudget');
placesBudget.allowPlacesSearch = () => true;
const weatherService = require('../services/weatherService');
weatherService.getWeather = async () => ({ temp: 60, condition: 'Clear' });

const authMod = require('../middleware/auth');
authMod.authenticate = (req, _res, next) => { req.user = { id: 1, name: 'Ava', role: 'venue_owner' }; next(); };

const venueDashboardRouter = require('../routes/venueDashboard');

const app = express();
app.use(express.json());
app.use('/api/venue-dashboard', venueDashboardRouter);

let base;
const server = http.createServer(app);
test.before(() => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); });
}));
test.after(() => new Promise((resolve) => {
  server.close(() => resolve());
  pool.end?.().catch(() => {});
}));

test.beforeEach(() => { log = []; resetTables(); });

async function get(path_) {
  const res = await fetch(base + path_);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const feedQuery = () => log.find((q) => /FROM flocks f JOIN venue_votes vv/.test(q.sql));
const countQuery = () => log.find((q) => /FROM venue_votes vv JOIN flocks f/.test(q.sql));

// ── 1. The window ──────────────────────────────────────────────────────────

test('a flock four months in the past is not "incoming"', async () => {
  const res = await get('/api/venue-dashboard/incoming-flocks');
  assert.strictEqual(res.status, 200);
  const ids = res.body.flocks.map((f) => f.id);
  assert.ok(!ids.includes(31),
    'the stale confirmed flock from four months ago was served as incoming demand');
  assert.ok(!ids.includes(36),
    'a flock that ended yesterday was served as incoming demand');
});

test('a flock past the far end of the horizon is not served either', async () => {
  const res = await get('/api/venue-dashboard/incoming-flocks');
  assert.ok(!res.body.flocks.map((f) => f.id).includes(34),
    'a flock a month out was served under a heading that says it is coming');
});

test('a flock that started two hours ago stays on the card — those people are in the building', async () => {
  const res = await get('/api/venue-dashboard/incoming-flocks');
  assert.ok(res.body.flocks.map((f) => f.id).includes(35),
    'the feed dropped a group at its start time, while routes/checkin.js still accepts their check-in');
});

test('the feed is soonest-first, not furthest-away-first', async () => {
  const res = await get('/api/venue-dashboard/incoming-flocks');
  assert.deepStrictEqual(res.body.flocks.map((f) => f.id), [35, 32, 33],
    'the incoming feed is not in ascending event_time order');
});

test('undated flocks are excluded rather than pinned to one end by fiat', async () => {
  const res = await get('/api/venue-dashboard/incoming-flocks');
  assert.ok(!res.body.flocks.map((f) => f.id).includes(37));
  assert.ok(/event_time IS NOT NULL/.test(feedQuery().sql));
});

test('the window is published, so an empty list cannot be misread as "nobody is coming"', async () => {
  const res = await get('/api/venue-dashboard/incoming-flocks');
  assert.deepStrictEqual(res.body.window, { pastHours: 12, aheadHours: 168 });
});

test('the window is server-side only: the place id is still the sole bound value', async () => {
  const res = await get('/api/venue-dashboard/incoming-flocks?pastHours=99999&aheadHours=99999');
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(feedQuery().params, ['PLACE_A'],
    'the feed query bound something other than the server-derived place id');
  assert.deepStrictEqual(res.body.flocks.map((f) => f.id), [35, 32, 33],
    'a client-supplied window widened the feed');
});

test('the lower bound is the tail of the check-in window, not an invented number', async () => {
  await get('/api/venue-dashboard/incoming-flocks');
  const w = windowFrom(feedQuery().sql);
  assert.ok(w.from !== null && w.to !== null, 'the feed has no time window at all');
  // routes/checkin.js: NOW() BETWEEN event_time - 3h AND event_time + 12h.
  // The tail of that is event_time > NOW() - 12h. One definition, not two.
  const checkin = require('node:fs')
    .readFileSync(require('node:path').join(__dirname, '..', 'routes', 'checkin.js'), 'utf8');
  assert.ok(/event_time \+ INTERVAL '12 hours'/.test(checkin),
    'routes/checkin.js no longer ends its window at +12 hours — the feed must follow it');
  assert.ok(Math.abs((Date.now() - w.from) - 12 * HOUR) < 5000,
    'the feed keeps a flock for a different length of time than the check-in window does');
});

test('the published window is the window the SQL actually applies', async () => {
  // The interval literals and the numbers in the payload are written
  // separately, so they can drift. If they do, the card captions itself with a
  // horizon it does not have.
  const res = await get('/api/venue-dashboard/incoming-flocks');
  const w = windowFrom(feedQuery().sql);
  assert.ok(Math.abs((Date.now() - w.from) - res.body.window.pastHours * HOUR) < 5000,
    'the feed publishes a different past horizon than it queries');
  assert.ok(Math.abs((w.to - Date.now()) - res.body.window.aheadHours * HOUR) < 5000,
    'the feed publishes a different forward horizon than it queries');
});

test('the group\'s own name for their night never reaches the venue', async () => {
  // SECURITY ROUND 5, 2026-08-20. This feed used to select `f.name AS title`
  // and App.js rendered it as the card's heading. Group names are not neutral
  // strings: "Emma's 21st", "Sarah's leaving do", "Dan + Priya anniversary" are
  // the normal case, and each pairs a real first name with a venue, a date and
  // a time, delivered to a business that will be at the door when those people
  // walk in.
  //
  // Three things make it worse than it first reads. NOBODY IN THE GROUP CHOSE
  // IT — the name is typed on the create screen for the group's own use and
  // nothing there says a business will read it. THE PRIVACY POLICY DOES NOT SAY
  // IT HAPPENS — "Who we share with" names service providers, other flock
  // members and trusted contacts, and venue owners are not on that list. And
  // THE PRODUCT'S OWN VOICE ALREADY FORBIDS IT — Roost refuses this in so many
  // words (advisorFreeText REFUSAL_BY_REASON.private_people: "We never report
  // anything about the individual people who use Flock ... or what they
  // planned"). The chat refused it while the card above the chat printed it.
  const r = await get('/api/venue-dashboard/incoming-flocks');
  assert.strictEqual(r.status, 200);
  assert.ok(r.body.flocks.length > 0, 'there is something in the window to check');

  const sql = log.find((q) => /FROM flocks f JOIN venue_votes vv/.test(q.sql)).sql;
  assert.doesNotMatch(sql, /f\.name/, 'the column is not selected at all, so it cannot be forwarded by accident');

  const typed = ['Here now', 'Thursday crew', 'Next weekend', 'Birthday Dinner', 'Someday'];
  const body = JSON.stringify(r.body);
  for (const t of typed) {
    assert.ok(!body.includes(t), `"${t}" was typed by a user and must not appear anywhere in the payload`);
  }
});

test('the heading the venue reads is the party size, derived from a count', async () => {
  // What a door actually needs is the operational shape of the night: how many
  // people, when, and whether it is confirmed. `title` stays as a KEY so the
  // dashboard needs no change, but the server writes it now, from a COUNT.
  const r = await get('/api/venue-dashboard/incoming-flocks');
  assert.strictEqual(r.status, 200);
  for (const f of r.body.flocks) {
    assert.match(String(f.title), /^Party of \d+$/, 'a size, not a name');
    assert.strictEqual(f.title, `Party of ${f.member_count}`);
  }
});

test('a flock whose accepted count has not landed is "A group", not "Party of 0"', async () => {
  // The count IS the thing being said here, so saying it wrong is worse than
  // not saying it. Zero accepted members is not a party of zero.
  FLOCKS = [{
    id: 51, venue_id: 'PLACE_A', name: 'Whatever', status: 'confirmed',
    event_time: new Date(Date.now() + 2 * DAY), member_count: 0,
  }];
  const r = await get('/api/venue-dashboard/incoming-flocks');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.flocks[0].title, 'A group');
  assert.ok(!JSON.stringify(r.body).includes('Whatever'));
});

test('the count is measured over the same window as the list', async () => {
  // A count taken over a different span than the list is not comparable to it,
  // and the owner has no way to tell.
  await get('/api/venue-dashboard/incoming-flocks');
  const list = windowFrom(feedQuery().sql);
  const count = windowFrom(countQuery().sql);
  assert.ok(Math.abs(list.from - count.from) < 5000 && Math.abs(list.to - count.to) < 5000,
    'the unattributed count spans a different window than the feed it sits beside');
});

// ── 2. Votes with no place id ──────────────────────────────────────────────

test('votes that name this venue without a place id are counted, not silently dropped', async () => {
  const res = await get('/api/venue-dashboard/incoming-flocks');
  assert.deepStrictEqual(res.body.unattributed, {
    count: 2,
    basis: 'venue_name_only',
    reason: 'no_place_id',
  });
});

test('the count is a count: nothing identifying a flock can ride out on that query', async () => {
  await get('/api/venue-dashboard/incoming-flocks');
  const q = countQuery();
  assert.ok(q, 'no unattributed-vote count query ran, so the gap is invisible again');
  assert.ok(/^SELECT COUNT\(DISTINCT f\.id\)::int AS n\b/.test(q.sql),
    `the name-matched query selects more than a count: ${q.sql.slice(0, 120)}`);
  assert.ok(/vv\.venue_id IS NULL/.test(q.sql),
    'the count is not restricted to votes that are missing a place id');
});

test('the count uses the owner\'s own profile row, never a client-supplied name', async () => {
  const res = await get('/api/venue-dashboard/incoming-flocks?businessName=Somebody%20Else');
  assert.strictEqual(res.status, 200);
  const q = countQuery();
  assert.deepStrictEqual(q.params, [11], 'the name comparison bound something other than the profile id');
  assert.ok(/vp\.business_name/.test(q.sql) && !/Somebody/.test(q.sql));
});

test('the served list itself never matches on a name — attribution stays on the place id', async () => {
  await get('/api/venue-dashboard/incoming-flocks');
  assert.ok(!/venue_name/.test(feedQuery().sql),
    'the feed matched on venue_name, which can hand one group\'s plan to a business they never chose');
});

test('a failed count is "we do not know", never a 500 over the whole feed', async () => {
  COUNT_QUERY_THROWS = true;
  const res = await get('/api/venue-dashboard/incoming-flocks');
  assert.strictEqual(res.status, 200, 'an auxiliary count took the feed down with it');
  assert.deepStrictEqual(res.body.flocks.map((f) => f.id), [35, 32, 33]);
  assert.strictEqual(res.body.unattributed.count, null);
  assert.strictEqual(res.body.unattributed.reason, 'lookup_failed');
});

test('an unverified claim still gets nothing, and no count leaks either', async () => {
  PROFILE.verified = false;
  try {
    const res = await get('/api/venue-dashboard/incoming-flocks');
    assert.deepStrictEqual(res.body.flocks, []);
    assert.strictEqual(res.body.unverified, true);
    assert.strictEqual(countQuery(), undefined,
      'an unverified claim on an arbitrary place id got a count of who named it');
  } finally {
    PROFILE.verified = true;
  }
});
