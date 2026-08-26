// Run: node --test  (from backend/)
//
// Stories are user-generated photos on an app used by minors, which makes them
// a moderation surface first and a feature second. These tests pin, from the
// outside:
//
//   * the feed applies takedowns, bans, blocks and expiry in SQL BEFORE the
//     LIMIT, so nothing hidden can surface by paging past it;
//   * a story cannot be posted without passing the text and image screens, and
//     every way the image screen can fail ends with no row written;
//   * one account cannot flood the feed, and cannot edit a story after the
//     moderation that approved it;
//   * expired stories are actually deleted, in bounded idempotent batches that
//     can never touch a story that is still live or one a moderator is still
//     looking at.
//
// No database is involved: pool.query is replaced with a fixture-backed
// dispatcher, and an unrecognised query is recorded rather than silently
// answered with zero rows — which is how an authorization test passes for the
// wrong reason.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

process.env.JWT_SECRET = 'test-secret-for-stories-tests';

const pool = require('../config/database');
const moderation = require('../utils/moderation');
const { signUserToken } = require('../middleware/auth');

const USERS = {
  1: { id: 1, email: 'alice@example.com', name: 'Alice', role: 'user', email_verified: true, is_banned: false, token_version: 0 },
  2: { id: 2, email: 'mallory@example.com', name: 'Mallory', role: 'user', email_verified: true, is_banned: false, token_version: 0 },
};

const STORY = {
  id: 77,
  user_id: 1,
  image_url: 'data:image/png;base64,AAAA',
  caption: 'rooftop',
  created_at: '2026-08-14T00:00:00.000Z',
  expires_at: '2026-08-15T00:00:00.000Z',
};

let queries;   // every statement the routes issued, whitespace-normalised
let unknown;   // statements the fixture did not model
let state;     // per-test fixture switches

function reset() {
  queries = [];
  unknown = [];
  state = {
    lastHour: 0,        // stories this user posted in the last hour
    active: 0,          // stories this user has live
    // When each of the two ceilings frees a slot. They are DIFFERENT CLOCKS and
    // that is the whole point: the hourly one is an hour after the post that
    // filled it, the active one is whenever the earliest live story expires,
    // which with a 24-hour format is most of a day away.
    hourFreesAt: new Date(Date.now() + 55 * 60 * 1000).toISOString(),
    activeFreesAt: new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString(),
    insertReturns: [STORY],
    feedRows: [],
    openReport: false,  // an unhandled report names the story being deleted
    deleteReturns: [{ id: STORY.id }],
    updateReturns: [{ id: STORY.id }],
    purgeRowCount: 0,
  };
}
reset();

const realQuery = pool.query.bind(pool);
pool.query = async (text, params = []) => {
  const sql = String(text).replace(/\s+/g, ' ').trim();
  queries.push({ sql, params });
  const has = (s) => sql.includes(s);

  if (has('FROM users WHERE id = $1')) {
    const u = USERS[params[0]];
    return { rows: u ? [u] : [], rowCount: u ? 1 : 0 };
  }
  // Retention purge — checked before the feed, because its subquery also
  // selects FROM stories s.
  if (has('DELETE FROM stories WHERE id IN (')) {
    return { rows: [], rowCount: state.purgeRowCount };
  }
  if (has('SELECT s.id, s.user_id, s.image_url')) {
    return { rows: state.feedRows, rowCount: state.feedRows.length };
  }
  if (has('COUNT(*) FILTER (WHERE created_at')) {
    return {
      rows: [{
        last_hour: state.lastHour,
        active: state.active,
        hour_frees_at: state.hourFreesAt,
        active_frees_at: state.activeFreesAt,
      }],
      rowCount: 1,
    };
  }
  if (has('INSERT INTO stories')) {
    return { rows: state.insertReturns, rowCount: state.insertReturns.length };
  }
  if (has('DELETE FROM stories WHERE id = $1 AND user_id = $2')) {
    // The evidence guard is a predicate inside the statement, so an open report
    // is modelled here rather than by a separate lookup the route no longer does.
    const rows = state.openReport ? [] : state.deleteReturns;
    return { rows, rowCount: rows.length };
  }
  if (has('UPDATE stories SET expires_at')) {
    return { rows: state.updateReturns, rowCount: state.updateReturns.length };
  }

  unknown.push(sql);
  return { rows: [], rowCount: 0 };
};

const stories = require('../routes/stories');
const S = stories.__test;

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use('/api/stories', stories);

let base;
const server = http.createServer(app);
test.before(() => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => {
    base = `http://127.0.0.1:${server.address().port}`;
    resolve();
  });
}));
test.after(() => new Promise((resolve) => server.close(resolve)));
test.after(() => { pool.query = realQuery; return pool.end().catch(() => {}); });

test.beforeEach(reset);

const TOKENS = { alice: () => signUserToken(USERS[1]), mallory: () => signUserToken(USERS[2]) };

function call(method, path, who, body) {
  return fetch(base + path, {
    method,
    headers: {
      Authorization: `Bearer ${TOKENS[who]()}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

const find = (needle) => queries.find((q) => q.sql.includes(needle));
const noQuery = (needle) =>
  assert.ok(!queries.some((q) => q.sql.includes(needle)), `unexpected query: ${needle}`);
const assertUnderstood = () =>
  assert.deepStrictEqual(unknown, [], 'fixture did not model a query the route ran');

// A moderation stub that records what it was asked to screen. Restored after
// every test that installs one.
function stubImageModeration(impl) {
  const real = moderation.moderateImage;
  const calls = [];
  moderation.moderateImage = async (url) => {
    calls.push(url);
    return impl(url);
  };
  test.afterEach(() => { moderation.moderateImage = real; });
  return calls;
}

const TINY_IMAGE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';

// ── Feed visibility ─────────────────────────────────────────────────────────

test('the feed applies takedowns, bans, blocks and expiry in SQL before the LIMIT', async () => {
  const res = await call('GET', '/api/stories', 'mallory');
  assert.strictEqual(res.status, 200);
  assertUnderstood();

  const q = find('FROM stories s');
  assert.ok(q, 'no feed query ran');
  assert.strictEqual(q.params[0], 2, 'the feed must be scoped to the caller');

  const gates = [
    's.expires_at > NOW()',            // expiry
    's.is_hidden IS NOT TRUE',         // moderator takedown
    'u.is_banned IS NOT TRUE',         // suspended author
    'NOT EXISTS ( SELECT 1 FROM user_blocks',  // blocks, both directions
  ];
  const limitAt = q.sql.indexOf('LIMIT $2');
  assert.ok(limitAt > -1, 'the feed is not paginated');
  for (const gate of gates) {
    const at = q.sql.indexOf(gate);
    assert.ok(at > -1, `feed is missing the gate: ${gate}`);
    assert.ok(at < limitAt, `${gate} must be applied before the LIMIT, not after it`);
  }

  // Every grant is relationship-based: self, accepted friendship, accepted
  // shared flock. Nothing else may reach the feed.
  assert.match(q.sql, /friendships WHERE \(requester_id = \$1 OR addressee_id = \$1\) AND status = 'accepted'/);
  assert.match(q.sql, /fm2\.status = 'accepted'/);
  assert.match(q.sql, /fm1\.user_id = \$1 AND fm1\.status = 'accepted'/);
});

test('an out-of-range offset is a 400, not a 500 from Postgres', async () => {
  const res = await call('GET', '/api/stories?offset=99999999999999999999', 'alice');
  assert.strictEqual(res.status, 400);
  noQuery('FROM stories s');
});

test('a page size above the cap is refused rather than silently clamped', async () => {
  const res = await call('GET', `/api/stories?limit=${S.MAX_FEED_LIMIT + 1}`, 'alice');
  assert.strictEqual(res.status, 400);
  noQuery('FROM stories s');

  const ok = await call('GET', `/api/stories?limit=${S.MAX_FEED_LIMIT}`, 'alice');
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(find('FROM stories s').params[1], S.MAX_FEED_LIMIT);
});

test('the default page size is bounded', async () => {
  const res = await call('GET', '/api/stories', 'alice');
  assert.strictEqual(res.status, 200);
  const q = find('FROM stories s');
  assert.strictEqual(q.params[1], S.DEFAULT_FEED_LIMIT);
  assert.strictEqual(q.params[2], 0);
  assert.ok(S.DEFAULT_FEED_LIMIT <= S.MAX_FEED_LIMIT);
});

test('the feed keeps the newest poster first instead of sorting by account id', async () => {
  // The query returns rows created_at DESC. User 9 (a newer account) posted
  // minutes ago; user 2 posted yesterday. Grouping into a plain object keyed by
  // user_id used to re-sort this into ascending id order, because that is how
  // JS enumerates integer-like keys — burying fresh stories under stale ones.
  state.feedRows = [
    { id: 3, user_id: 9, image_url: 'a', caption: null, created_at: '2026-08-14T10:00:00.000Z', expires_at: 'x', user_name: 'Nine', profile_image_url: null },
    { id: 2, user_id: 2, image_url: 'b', caption: null, created_at: '2026-08-13T10:00:00.000Z', expires_at: 'x', user_name: 'Two', profile_image_url: null },
    { id: 1, user_id: 9, image_url: 'c', caption: null, created_at: '2026-08-13T09:00:00.000Z', expires_at: 'x', user_name: 'Nine', profile_image_url: null },
  ];
  const res = await call('GET', '/api/stories', 'alice');
  assert.strictEqual(res.status, 200);
  const { story_groups } = await res.json();
  assert.deepStrictEqual(story_groups.map((g) => g.user_id), [9, 2]);
  assert.deepStrictEqual(story_groups[0].stories.map((s) => s.id), [3, 1]);
});

// ── Creation ────────────────────────────────────────────────────────────────

test('an https image URL is refused: only bytes we screened may be stored', async () => {
  const calls = stubImageModeration(async () => ({ allowed: true, reason: null }));
  const res = await call('POST', '/api/stories', 'alice', {
    image_url: 'https://attacker.example/swap-me-later.png',
  });
  assert.strictEqual(res.status, 400);
  assert.deepStrictEqual(calls, []);
  noQuery('INSERT INTO stories');
});

test('a data URL with trailing junk after the payload is refused', async () => {
  stubImageModeration(async () => ({ allowed: true, reason: null }));
  const res = await call('POST', '/api/stories', 'alice', {
    image_url: `${TINY_IMAGE}<script>alert(1)</script>`,
  });
  assert.strictEqual(res.status, 400);
  noQuery('INSERT INTO stories');
});

// This test used to be called "an animated GIF is refused: SafeSearch only ever
// sees the first frame", and every clause of that was wrong. The payload below
// is a one-frame GIF, nothing here inspects frames, and the refusal comes from
// the FORMAT ALLOWLIST in routes/stories.js, which cannot see frames at all.
// Naming it after the animation gate made the format rule look like a safety
// control, which is the reading that talks the next person into widening it.
//
// The rule it actually pins, and the reason the omission survived a review that
// asked whether it should: refusing GIF by format costs ZERO billed Cloud
// Vision calls. Animation is not what is being bought — an animated GIF that
// reached moderateImage would be refused by the byte-level frame gate before
// the provider is contacted, i.e. for free as well. What is bought is the STILL
// GIF, which is a real image and would otherwise cost a paid call to reach an
// answer nobody needs, for a format no camera roll produces.
test('a GIF story is refused by the format allowlist, for free', async () => {
  const calls = stubImageModeration(async () => ({ allowed: true, reason: null }));
  const res = await call('POST', '/api/stories', 'alice', {
    image_url: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=',
  });
  assert.strictEqual(res.status, 400);
  assert.deepStrictEqual(calls, [], 'a format refusal must never reach the billed screen');
  noQuery('INSERT INTO stories');
});

test('the GIF rule is about the format, not about frames', async () => {
  // A GIF87a header: the version that predates animation entirely, so there is
  // no reading of "we refuse animation" that reaches it. It is refused all the
  // same, which is what makes this a product rule rather than a safety one, and
  // it is refused before the billed screen, which is what makes it worth
  // keeping. If someone widens the allowlist to admit GIF, this goes red and
  // they get to decide the money question deliberately.
  const calls = stubImageModeration(async () => ({ allowed: true, reason: null }));
  const res = await call('POST', '/api/stories', 'alice', {
    image_url: 'data:image/gif;base64,R0lGODdhAQABAAAAACw=',
  });
  assert.strictEqual(res.status, 400);
  assert.deepStrictEqual(calls, []);
  noQuery('INSERT INTO stories');
});

test('an oversized image is refused before it costs a moderation call', async () => {
  const calls = stubImageModeration(async () => ({ allowed: true, reason: null }));
  const huge = `data:image/png;base64,${'A'.repeat(S.MAX_IMAGE_DATA_URL_BYTES)}`;
  const res = await call('POST', '/api/stories', 'alice', { image_url: huge });
  assert.strictEqual(res.status, 400);
  assert.deepStrictEqual(calls, []);
  noQuery('INSERT INTO stories');
});

test('a caption longer than the cap is a 400', async () => {
  stubImageModeration(async () => ({ allowed: true, reason: null }));
  const res = await call('POST', '/api/stories', 'alice', {
    image_url: TINY_IMAGE,
    caption: 'x'.repeat(S.MAX_CAPTION_LENGTH + 1),
  });
  assert.strictEqual(res.status, 400);
  noQuery('INSERT INTO stories');
});

test('the image screen runs on the create path and a refusal stores nothing', async () => {
  const calls = stubImageModeration(async () => ({ allowed: false, reason: 'unsafe_adult' }));
  const res = await call('POST', '/api/stories', 'alice', { image_url: TINY_IMAGE, caption: 'hi' });
  assert.strictEqual(res.status, 400);
  assert.deepStrictEqual(calls, [TINY_IMAGE]);
  noQuery('INSERT INTO stories');
  assertUnderstood();
});

test('the image screen FAILS CLOSED when the provider throws', async () => {
  const calls = stubImageModeration(async () => { throw new Error('vision 503'); });
  const res = await call('POST', '/api/stories', 'alice', { image_url: TINY_IMAGE });
  assert.strictEqual(res.status, 400, 'a moderation outage must not become a stored image');
  assert.strictEqual(calls.length, 1);
  noQuery('INSERT INTO stories');
});

test('the image screen FAILS CLOSED when the provider answers with nothing', async () => {
  stubImageModeration(async () => undefined);
  const res = await call('POST', '/api/stories', 'alice', { image_url: TINY_IMAGE });
  assert.strictEqual(res.status, 400);
  noQuery('INSERT INTO stories');
});

test('the text screen runs before the image screen, and its refusal stores nothing', async () => {
  const realReject = moderation.rejectIfProfane;
  moderation.rejectIfProfane = (res) => { res.status(400).json({ error: 'nope' }); return true; };
  const calls = stubImageModeration(async () => ({ allowed: true, reason: null }));
  try {
    const res = await call('POST', '/api/stories', 'alice', { image_url: TINY_IMAGE, caption: 'anything' });
    assert.strictEqual(res.status, 400);
    assert.deepStrictEqual(calls, [], 'a rejected caption must not reach the image provider');
    noQuery('INSERT INTO stories');
  } finally {
    moderation.rejectIfProfane = realReject;
  }
});

test('a clean story is stored, scoped to the caller, with a 24 hour expiry', async () => {
  stubImageModeration(async () => ({ allowed: true, reason: null }));
  const res = await call('POST', '/api/stories', 'alice', { image_url: TINY_IMAGE, caption: '  rooftop  ' });
  assert.strictEqual(res.status, 201);
  assertUnderstood();

  const q = find('INSERT INTO stories');
  assert.ok(q, 'nothing was inserted');
  assert.strictEqual(q.params[0], 1, 'the author is the authenticated caller, never the body');
  assert.strictEqual(q.params[1], TINY_IMAGE);
  assert.strictEqual(q.params[2], 'rooftop', 'the caption is trimmed and sanitised');
  assert.match(q.sql, /NOW\(\) \+ INTERVAL '24 hours'/);
  // INSERT ... SELECT resolves a bare parameter to text, and text -> integer is
  // an explicit-only cast: without these the statement can fail at parse time.
  assert.match(q.sql, /SELECT \$1::int, \$2::text, \$3::text/);
  // The ~700KB data URL the client just uploaded is not echoed back to it.
  assert.ok(!/RETURNING[^;]*image_url/.test(q.sql), 'the created story echoes the image back');

  const body = await res.json();
  assert.strictEqual(body.story.id, STORY.id);
});

test('a caption carrying markup is sanitised before it is stored', async () => {
  stubImageModeration(async () => ({ allowed: true, reason: null }));
  const res = await call('POST', '/api/stories', 'alice', {
    image_url: TINY_IMAGE,
    caption: '<img src=x onerror=alert(1)>at the bar',
  });
  assert.strictEqual(res.status, 201);
  const stored = find('INSERT INTO stories').params[2];
  assert.ok(!/<img/i.test(stored), `markup survived sanitisation: ${stored}`);
  assert.ok(!/onerror/i.test(stored), `an event handler survived sanitisation: ${stored}`);
});

// ── Abuse ───────────────────────────────────────────────────────────────────

test('one account cannot flood the feed: the hourly cap answers 429, not 500', async () => {
  const calls = stubImageModeration(async () => ({ allowed: true, reason: null }));
  state.lastHour = S.STORIES_PER_HOUR;
  const res = await call('POST', '/api/stories', 'alice', { image_url: TINY_IMAGE });
  assert.strictEqual(res.status, 429);
  const said = await res.json();
  // The hourly ceiling is a RATE, so it says the hour it runs on. Both ceilings
  // used to answer "You've posted a lot of stories recently. Try again in a
  // little while", which described neither of them.
  assert.match(said.error, /in the last hour/);
  assert.match(said.error, /in about an hour/);
  assert.ok(!/delete one/.test(said.error),
    'deleting a story does not clear the hourly rate, so it must not be offered here');
  assert.ok(said.retryAfterSeconds > 0 && said.resetsAt,
    'a rate limit that will not say when it lifts is the defect this test exists for');
  assert.deepStrictEqual(calls, [], 'a rate-limited post must not spend moderation quota');
  noQuery('INSERT INTO stories');
});

test('the live-story cap is enforced too', async () => {
  stubImageModeration(async () => ({ allowed: true, reason: null }));
  state.active = S.MAX_ACTIVE_STORIES;
  const res = await call('POST', '/api/stories', 'alice', { image_url: TINY_IMAGE });
  assert.strictEqual(res.status, 429);
  const said = await res.json();
  // A CAPACITY, not a rate, and on a different clock: nine hours away in this
  // fixture. It also has an instant fix the hourly one does not, and saying so
  // is the difference between waiting all evening and posting now.
  assert.match(said.error, /in about 9 hours/);
  assert.match(said.error, /delete one to post now/);
  assert.ok(!/in the last hour, which is the most per hour/.test(said.error),
    'the capacity cap is answering with the hourly rate\'s sentence');
  noQuery('INSERT INTO stories');
});

test('the rate limit is re-checked inside the INSERT, so a race cannot beat it', async () => {
  stubImageModeration(async () => ({ allowed: true, reason: null }));
  state.insertReturns = [];   // the guarded INSERT wrote nothing
  const res = await call('POST', '/api/stories', 'alice', { image_url: TINY_IMAGE });
  assert.strictEqual(res.status, 429);

  const q = find('INSERT INTO stories');
  assert.match(q.sql, /WHERE \(SELECT COUNT\(\*\) FROM stories WHERE user_id = \$1 AND created_at > NOW\(\) - INTERVAL '1 hour'\) < \$4/);
  assert.match(q.sql, /AND \(SELECT COUNT\(\*\) FROM stories WHERE user_id = \$1 AND expires_at > NOW\(\)\) < \$5/);
  assert.strictEqual(q.params[3], S.STORIES_PER_HOUR);
  assert.strictEqual(q.params[4], S.MAX_ACTIVE_STORIES);
  // A hidden story still counts against the live cap: a takedown must not free
  // a slot for the account that earned it.
  assert.ok(!/expires_at > NOW\(\)\) AND is_hidden/.test(q.sql));
});

test('there is no edit route, so nothing can be swapped in after the screen passed', async () => {
  for (const method of ['PUT', 'PATCH']) {
    const res = await call(method, `/api/stories/${STORY.id}`, 'alice', { caption: 'new' });
    assert.strictEqual(res.status, 404, `${method} /api/stories/:id must not exist`);
    noQuery('UPDATE stories SET caption');
  }
});

// ── Deletion ────────────────────────────────────────────────────────────────

test('a story you do not own answers 404, and the delete is scoped by author', async () => {
  state.deleteReturns = [];
  state.updateReturns = [];
  const res = await call('DELETE', `/api/stories/${STORY.id}`, 'mallory');
  assert.strictEqual(res.status, 404);
  assertUnderstood();

  const q = find('DELETE FROM stories WHERE id = $1 AND user_id = $2');
  assert.ok(q, 'the delete was not scoped to the author');
  assert.deepStrictEqual(q.params, [STORY.id, 2]);
});

test('a non-numeric story id is a 400, not a 500 from Postgres', async () => {
  const res = await call('DELETE', '/api/stories/12abc', 'alice');
  assert.strictEqual(res.status, 400);
  noQuery('DELETE FROM stories');
});

test('an out-of-int4-range story id is a 400', async () => {
  const res = await call('DELETE', '/api/stories/2147483648', 'alice');
  assert.strictEqual(res.status, 400);
  noQuery('DELETE FROM stories');
});

test('deleting a story under an open report retires it without destroying the evidence', async () => {
  state.openReport = true;
  const res = await call('DELETE', `/api/stories/${STORY.id}`, 'alice');
  assert.strictEqual(res.status, 200);
  assertUnderstood();

  // The evidence guard is decided in the same statement as the delete, so a
  // report landing mid-request cannot be raced.
  const del = find('DELETE FROM stories WHERE id = $1 AND user_id = $2');
  assert.match(del.sql, /NOT EXISTS \( SELECT 1 FROM content_reports r WHERE r\.content_type = 'story'/);
  assert.match(del.sql, /r\.status IN \('open', 'under_review'\)/);

  // Off every feed immediately (expiry is the predicate every read applies),
  // while the row survives for the moderator who was asked to judge it.
  const q = find('UPDATE stories SET expires_at');
  assert.ok(q, 'the story was not taken off the feed');
  assert.deepStrictEqual(q.params, [STORY.id, 1]);
});

test('an unreported story is really deleted, not just expired', async () => {
  state.openReport = false;
  const res = await call('DELETE', `/api/stories/${STORY.id}`, 'alice');
  assert.strictEqual(res.status, 200);
  assert.ok(find('DELETE FROM stories WHERE id = $1 AND user_id = $2'));
  noQuery('UPDATE stories SET expires_at');
});

// ── Retention purge ─────────────────────────────────────────────────────────

test('the purge is bounded, and can never delete a story that is still live', async () => {
  state.purgeRowCount = 3;
  const deleted = await S.purgeExpiredStories();
  assert.strictEqual(deleted, 3);

  const q = find('DELETE FROM stories WHERE id IN (');
  assert.ok(q, 'no purge query ran');

  // Two independent predicates must both hold before a row is eligible, and
  // the grace window can never be negative.
  assert.match(q.sql, /WHERE s\.expires_at <= NOW\(\)/);
  assert.match(q.sql, /AND s\.expires_at <= NOW\(\) - \(\$1::int \* INTERVAL '1 hour'\)/);
  assert.ok(S.PURGE_GRACE_HOURS >= 0, 'a negative grace window would reach into live stories');
  assert.strictEqual(q.params[0], S.PURGE_GRACE_HOURS);

  // Bounded: one batch per run, oldest first, and concurrent runs do not fight.
  assert.match(q.sql, /LIMIT \$2::int/);
  assert.strictEqual(q.params[1], S.PURGE_BATCH);
  assert.ok(S.PURGE_BATCH > 0 && S.PURGE_BATCH <= 5000);
  assert.match(q.sql, /ORDER BY s\.expires_at/);
  assert.match(q.sql, /FOR UPDATE SKIP LOCKED/);
});

test('the purge leaves alone any story a moderator is still being asked to judge', async () => {
  await S.purgeExpiredStories();
  const q = find('DELETE FROM stories WHERE id IN (');
  assert.match(q.sql, /NOT EXISTS \( SELECT 1 FROM content_reports r WHERE r\.content_type = 'story'/);
  assert.match(q.sql, /r\.status IN \('open', 'under_review'\)/);
});

test('the purge is idempotent: a run that deletes nothing is a normal run', async () => {
  state.purgeRowCount = 0;
  assert.strictEqual(await S.purgeExpiredStories(), 0);
  assert.strictEqual(await S.purgeExpiredStories(), 0);
});

test('a purge failure can never fail the read that triggered it', async () => {
  S.setLastPurgeAt(Date.now() - S.PURGE_INTERVAL_MS - 1);
  const boom = pool.query;
  pool.query = async (text, params) => {
    const sql = String(text).replace(/\s+/g, ' ').trim();
    if (sql.includes('DELETE FROM stories WHERE id IN (')) throw new Error('database is down');
    return boom(text, params);
  };
  try {
    const res = await call('GET', '/api/stories', 'alice');
    assert.strictEqual(res.status, 200);
    await new Promise((r) => setTimeout(r, 20));  // let the fire-and-forget settle
  } finally {
    pool.query = boom;
  }
});

test('the purge is debounced, and does not run on a freshly booted process', async () => {
  // lastPurgeAt starts at module load, so a short-lived process never purges.
  assert.strictEqual(S.maybePurgeStories(), false);
  S.setLastPurgeAt(Date.now() - S.PURGE_INTERVAL_MS - 1);
  assert.strictEqual(S.maybePurgeStories(), true);
  assert.strictEqual(S.maybePurgeStories(), false, 'a second call inside the window must be a no-op');
  await new Promise((r) => setTimeout(r, 20));
});
