// Run: node --test  (from backend/)
//
// STORIES, WALKED END TO END AS THE PEOPLE IN IT: post, see, expire, moderate,
// pay for, and fail.
//
// __tests__/storiesFlow.test.js already pins the route's individual rules. This
// file exists because nobody had ever walked the FEATURE, and three of the four
// things found by doing so are things no per-rule test could have caught: they
// are properties of how the pieces join up, or of a piece that is correct and
// unreachable.
//
//   1. THE RETENTION PURGE COULD NOT RUN. It hung off one trigger, a feed read,
//      and the feed has no callers: the 2026-08-14 product decision is that
//      stories never get a UI, and `getStories` in frontend/src/services/api.js
//      is uncalled by design. Meanwhile POST is live and routes/users.js's data
//      export says so out loud ("No UI can create a story (server-only by
//      decision), but the API can"). Rows could be created and nothing would
//      ever delete one, so "stories last 24 hours" was true of the VIEW and
//      false of the ROW, which is the exact case the purge's own comment says
//      must not happen. It now runs off the write doors too.
//
//   2. THE TWO RATE-LIMIT REFUSALS NAMED THE WRONG TIME. Both instants came
//      out of `TIMESTAMP` columns, timestamp WITHOUT time zone, and node-
//      postgres builds a Date for that type out of the LOCAL calendar fields,
//      because there is no offset to honour. Whenever the app process and the
//      database session disagree about the zone, the whole difference lands in
//      the answer. Measured against a real Postgres with the session on UTC and
//      the process on America/New_York: a ten-minute wait was reported as four
//      hours ten minutes, with `Retry-After: 15000` on it. Both legs are cast
//      to timestamptz now. It is the same class as the naive-column bug
//      `__tests__/dumpLiteralRestore.test.js` exists for.
//
//   3. THE FEED WAS CACHEABLE. It hands out other people's photographs as
//      inline base64 under a promise that they stop existing in a day.
//      routes/admin.js sets `no-store, private` on the SAME BYTES for one
//      moderator; the feed set nothing for everyone the author is friends with.
//
//   4. THE EXIF PROOF FOR THIS DOOR WAS A GREP. imageMetadataStrip.test.js
//      checks that routes/stories.js CONTAINS the string
//      `sanitizeStoredImage(image_url)`. That is the kind of assertion that
//      keeps passing after it has stopped meaning anything. Below, a real JPEG
//      carrying a real GPS block goes through the real door, and the bytes
//      handed to the INSERT are read.
//
// No database is involved. pool.query is a fixture-backed dispatcher and an
// unmodelled statement is recorded rather than answered with zero rows, which
// is how an authorization test passes for the wrong reason.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

process.env.JWT_SECRET = 'stories-end-to-end-test-secret';

const pool = require('../config/database');
const moderation = require('../utils/moderation');
const { signUserToken } = require('../middleware/auth');
const { storyVisibilitySql } = require('../utils/relationships');

const ROUTE_SRC = fs.readFileSync(path.join(__dirname, '..', 'routes', 'stories.js'), 'utf8');

const USERS = {
  1: { id: 1, email: 'ava@example.com', name: 'Ava', role: 'user', email_verified: true, is_banned: false, token_version: 0 },
  2: { id: 2, email: 'bo@example.com', name: 'Bo', role: 'user', email_verified: true, is_banned: false, token_version: 0 },
};

// --- fixtures ---------------------------------------------------------------

let queries;
let unknown;
let state;

function reset() {
  queries = [];
  unknown = [];
  state = {
    lastHour: 0,
    active: 0,
    // What the driver hands back for the two refusal instants. The FIXED query
    // asks for timestamptz, so these are parsed with a real offset; see the
    // clock tests for what the naive column used to produce instead.
    hourFreesAt: new Date(Date.now() + 10 * 60 * 1000),
    activeFreesAt: new Date(Date.now() + 9 * 60 * 60 * 1000),
    insertReturns: [{ id: 501, user_id: 1, caption: null, created_at: new Date(), expires_at: new Date() }],
    feedRows: [],
    feedThrows: false,
    deleteReturns: [{ id: 501 }],
    updateReturns: [{ id: 501 }],
    purgeRowCount: 0,
    purgeThrows: false,
    purgeCalls: 0,
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
  // Checked before the feed: the purge's subquery also selects FROM stories s.
  if (has('DELETE FROM stories WHERE id IN (')) {
    state.purgeCalls += 1;
    if (state.purgeThrows) throw new Error('purge exploded');
    return { rows: [], rowCount: state.purgeRowCount };
  }
  if (has('SELECT s.id, s.user_id, s.image_url')) {
    if (state.feedThrows) throw new Error('feed query exploded');
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
    return { rows: state.deleteReturns, rowCount: state.deleteReturns.length };
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
app.use(express.json({ limit: '2mb' }));
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

test.beforeEach(() => {
  reset();
  // The purge is debounced to once an hour per process and its clock starts at
  // module load, so without this every test after the first would see a no-op
  // and pass for the wrong reason.
  S.setLastPurgeAt(0);
});

const TOKENS = { ava: () => signUserToken(USERS[1]), bo: () => signUserToken(USERS[2]) };

function call(method, urlPath, who, body) {
  return fetch(base + urlPath, {
    method,
    headers: {
      Authorization: `Bearer ${TOKENS[who]()}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

const find = (needle) => queries.find((q) => q.sql.includes(needle));
const assertUnderstood = () =>
  assert.deepStrictEqual(unknown, [], 'fixture did not model a query the route ran');

function stubImageModeration(impl) {
  const real = moderation.moderateImage;
  const seen = [];
  moderation.moderateImage = async (url, opts) => {
    seen.push({ url, opts });
    return impl(url);
  };
  test.afterEach(() => { moderation.moderateImage = real; });
  return seen;
}

// Wait for the fire-and-forget purge to be dispatched. It is started after the
// response is written, so the fetch resolving does not mean it has run.
const settle = () => new Promise((r) => setImmediate(() => setImmediate(r)));

// --- a real JPEG carrying a real GPS block ----------------------------------
// Built byte by byte, the same way imageMetadataStrip.test.js does it, because
// a fixture that is not actually a JPEG proves nothing about a JPEG.

const GPS_NEEDLE = 'GPSLatitudeRef=N;40.0193,-75.2952';

function jpegSegment(marker, payload) {
  const head = Buffer.alloc(4);
  head[0] = 0xFF;
  head[1] = marker;
  head.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([head, payload]);
}

// APP1/Exif holding the needle, then a minimal SOS + entropy + EOI so the
// stripper's walker reaches a real stopping point.
const PHOTO_WITH_GPS = Buffer.concat([
  Buffer.from([0xFF, 0xD8]),
  jpegSegment(0xE1, Buffer.concat([
    Buffer.from('Exif\0\0', 'latin1'),
    Buffer.from(GPS_NEEDLE, 'latin1'),
  ])),
  jpegSegment(0xDA, Buffer.from([0x01, 0x01, 0x00])),
  Buffer.from([0x11, 0x22, 0x33, 0x44, 0x55]),
  Buffer.from([0xFF, 0xD9]),
]);
const PHOTO_WITH_GPS_URL = `data:image/jpeg;base64,${PHOTO_WITH_GPS.toString('base64')}`;

const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';

// ═══════════════════════════════════════════════════════════════════════════
// 1. POSTING ONE
// ═══════════════════════════════════════════════════════════════════════════

test('the GPS block in a phone photo is screened but never stored', async () => {
  const seen = stubImageModeration(async () => ({ allowed: true, reason: null }));
  const res = await call('POST', '/api/stories', 'ava', { image_url: PHOTO_WITH_GPS_URL });
  assert.strictEqual(res.status, 201);

  // What was SCREENED is what the person actually sent. Stripping runs after,
  // so nothing can hide behind it.
  assert.strictEqual(seen.length, 1);
  assert.ok(Buffer.from(seen[0].url.slice(seen[0].url.indexOf(',') + 1), 'base64')
    .includes(GPS_NEEDLE), 'moderation was handed the stripped copy, not the upload');

  // What was STORED has no location in it. This is the assertion the source
  // grep in imageMetadataStrip.test.js cannot make: it reads the file, not the
  // bytes, so it would keep passing if the call were moved, shadowed or made
  // conditional.
  const insert = find('INSERT INTO stories');
  const stored = insert.params[1];
  assert.ok(stored.startsWith('data:image/jpeg;base64,'), 'the stored MIME was not re-typed from the bytes');
  const storedBytes = Buffer.from(stored.slice(stored.indexOf(',') + 1), 'base64');
  assert.ok(!storedBytes.includes(GPS_NEEDLE),
    'the story row carries the photo GPS fix: EXIF stripping does not apply on this door');

  // Stripping only ever removes whole segments, so the picture survives.
  assert.ok(storedBytes.subarray(0, 2).equals(Buffer.from([0xFF, 0xD8])), 'not a JPEG any more');
  assert.ok(storedBytes.includes(Buffer.from([0x11, 0x22, 0x33, 0x44, 0x55])), 'entropy data was destroyed');
  assert.ok(storedBytes.length < PHOTO_WITH_GPS.length, 'nothing was removed at all');
  assertUnderstood();
});

test('a post with no photo is refused by name, and costs nothing', async () => {
  const seen = stubImageModeration(async () => ({ allowed: true, reason: null }));
  const res = await call('POST', '/api/stories', 'ava', { caption: 'just words' });
  assert.strictEqual(res.status, 400);
  const said = await res.json();
  assert.strictEqual(said.error, 'A photo is required');
  assert.deepStrictEqual(seen, [], 'a request with no image reached the paid screen');
});

test('the size refusal quotes a photo size, not the encoded ceiling it is derived from', async () => {
  // The two numbers are in different units on purpose: the ceiling is on the
  // base64 data URL, the person is holding a photo, and base64 inflates by 4/3.
  // A refusal that quoted 700 would send someone back with a 700 KB photo to be
  // refused a second time by the same sentence.
  assert.ok(S.IMAGE_TOO_LARGE_MESSAGE.includes(String(S.ADVERTISED_PHOTO_KB)));
  assert.ok(!S.IMAGE_TOO_LARGE_MESSAGE.includes(String(Math.round(S.MAX_IMAGE_DATA_URL_BYTES / 1024))),
    'the refusal quotes the encoded ceiling, which is not a number the user can act on');
  // Advertised size, once encoded, must fit under the enforced ceiling.
  const encoded = Math.ceil((S.ADVERTISED_PHOTO_KB * 1024) / 3) * 4 + 'data:image/jpeg;base64,'.length;
  assert.ok(encoded < S.MAX_IMAGE_DATA_URL_BYTES,
    'a photo of exactly the advertised size does not fit under the enforced ceiling');

  const seen = stubImageModeration(async () => ({ allowed: true, reason: null }));
  const huge = `data:image/png;base64,${'A'.repeat(S.MAX_IMAGE_DATA_URL_BYTES)}`;
  const res = await call('POST', '/api/stories', 'ava', { image_url: huge });
  assert.strictEqual(res.status, 400);
  assert.strictEqual((await res.json()).error, S.IMAGE_TOO_LARGE_MESSAGE);
  assert.deepStrictEqual(seen, [], 'an oversized image was sent to a billed screen');
});

test('a refusal is never dressed as an empty state: every 400 on this door says what to do', async () => {
  stubImageModeration(async () => ({ allowed: false, reason: 'unsafe_adult' }));
  const refusals = [
    [{ caption: 'hi' }, /photo is required/i],
    [{ image_url: 'https://example.com/a.png' }, /JPEG, PNG or WebP/],
    [{ image_url: TINY_PNG, caption: 'x'.repeat(S.MAX_CAPTION_LENGTH + 1) }, /limited to \d+ characters/],
    [{ image_url: TINY_PNG }, /couldn't verify that image is safe/],
  ];
  for (const [body, shape] of refusals) {
    const res = await call('POST', '/api/stories', 'ava', body);
    assert.strictEqual(res.status, 400);
    const said = await res.json();
    assert.match(said.error, shape);
    assert.ok(said.error.length > 12, `an unhelpful refusal: ${said.error}`);
    assert.ok(!/^Invalid value$/.test(said.error), 'express-validator default leaked to the user');
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. WHO CAN SEE IT
// ═══════════════════════════════════════════════════════════════════════════

test('the feed enforces the visibility rule by CALLING it, not by keeping a copy of it', async () => {
  await call('GET', '/api/stories', 'bo');
  const feed = find('SELECT s.id, s.user_id, s.image_url');

  // utils/relationships.js owns the rule. The route must run byte-for-byte what
  // that owner emits for the feed's settings, so a hand-edit in either place is
  // a failure here rather than a silent divergence, which is exactly how the
  // report gate and the feed drifted apart before the rule was centralised.
  const owned = storyVisibilitySql({ viewer: '$1', authorAlias: 'u' })
    .replace(/\s+/g, ' ').trim();
  assert.ok(feed.sql.includes(owned),
    'the feed is running its own copy of the visibility rule');
  assert.deepStrictEqual(feed.params, [USERS[2].id, S.DEFAULT_FEED_LIMIT, 0],
    'the viewer travels as a bind parameter, and the page defaults are the route constants');
  assertUnderstood();
});

test('the rule is exactly: live, not taken down, author not banned, no block either way, and one of own / friend / flock mate', () => {
  const sql = storyVisibilitySql({ viewer: '$1', authorAlias: 'u' }).replace(/\s+/g, ' ');

  // Live.
  assert.ok(sql.includes('s.expires_at > NOW()'), 'expired stories are not filtered');
  // A moderator takedown holds on the feed.
  assert.ok(sql.includes('s.is_hidden IS NOT TRUE'), 'a taken-down story is still on the feed');
  // A ban retracts what the account already posted. Not a login lock: middleware
  // only stops the banned user, which left their photos up for up to 24 hours.
  assert.ok(sql.includes('u.is_banned IS NOT TRUE'), 'a banned author keeps their stories on other feeds');
  // Blocks are mutual and read BOTH ways, because shared-flock membership
  // survives a block and would otherwise leak the story back across it.
  assert.ok(sql.includes('b.blocker_id = $1 AND b.blocked_id = s.user_id'), 'blocker direction missing');
  assert.ok(sql.includes('b.blocker_id = s.user_id AND b.blocked_id = $1'), 'blocked-by direction missing');

  // Reach is a closed list of three. Anyone else, including a stranger holding a
  // story id, is outside it: there is no link, no public tier and no by-id read.
  assert.ok(sql.includes('s.user_id = $1'), 'you cannot see your own story');
  assert.ok(/friendships WHERE \(requester_id = \$1 OR addressee_id = \$1\) AND status = 'accepted'/.test(sql),
    'friendship reach is not restricted to accepted friendships');
  assert.ok(/fm1\.user_id = \$1 AND fm1\.status = 'accepted'/.test(sql), 'flock reach ignores the viewer status');
  assert.ok(/fm2\.status = 'accepted'/.test(sql), 'flock reach ignores the author status');

  // Someone who WAS a friend when it was posted and is not now: the friendship
  // predicate is evaluated at read time against the current row, and an
  // unfriend deletes it, so there is nothing left to match. Nothing anywhere
  // records who could see a story when it was written.
  assert.ok(!/posted_at|snapshot|audience_at/.test(sql),
    'the audience is frozen at post time somewhere, which an unfriend cannot undo');
});

test('a deleted account takes its stories off every feed by construction', () => {
  // Two independent reasons, and it is worth having both written down: the row
  // is CASCADE-deleted with the user (migrations/000_bootstrap.sql), and the
  // feed inner-JOINs users for the name and avatar, so a story with no author
  // row cannot be selected even if one somehow survived.
  const bootstrap = fs.readFileSync(
    path.join(__dirname, '..', 'migrations', '000_bootstrap.sql'), 'utf8');
  const table = bootstrap.slice(bootstrap.indexOf('CREATE TABLE IF NOT EXISTS stories'));
  assert.match(table.slice(0, 400), /user_id INTEGER REFERENCES users\(id\) ON DELETE CASCADE/);
  assert.match(ROUTE_SRC, /FROM stories s\s*\n\s*JOIN users u ON u\.id = s\.user_id/,
    'the feed no longer inner-joins the author, so a story whose account is gone could still be selected');
});

test('there is no by-id read path, so no story is reachable by guessing a number', () => {
  const routes = stories.stack.filter((l) => l.route).map((l) => ({
    path: l.route.path,
    methods: Object.keys(l.route.methods).sort(),
  }));
  assert.deepStrictEqual(routes, [
    { path: '/', methods: ['get'] },
    { path: '/', methods: ['post'] },
    { path: '/:id', methods: ['delete'] },
  ], 'the story router grew a route; check it against the visibility rule before allowing it');
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. EXPIRY: which clock decides, and where the filter runs
// ═══════════════════════════════════════════════════════════════════════════

test('one clock decides expiry, and it is the database', () => {
  const code = ROUTE_SRC.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  // Written by NOW(), read against NOW(), purged against NOW(). No JS date
  // arithmetic anywhere near the lifetime, so the app process clock cannot move
  // an expiry and two instances cannot disagree about one.
  assert.match(code, /expires_at\)\s*\n?\s*SELECT [^\n]*NOW\(\) \+ INTERVAL '24 hours'/,
    'the 24 hours is not written by the database clock');
  assert.ok(!/Date\.now\(\)\s*\+|new Date\([^)]*\)\s*\.\s*setHours/.test(code),
    'a JavaScript clock is computing part of a story lifetime');
});

test('expiry is filtered in SQL before the LIMIT, never in JavaScript after the fetch', async () => {
  // The difference is not stylistic. Filtering after the rows are fetched means
  // the expired row was selected, serialised and sent to this process, and one
  // forgotten `.filter` puts it on the wire.
  state.feedRows = [
    { id: 1, user_id: 9, image_url: 'a', caption: null, created_at: 't', expires_at: 't', user_name: 'Cy', profile_image_url: null },
    { id: 2, user_id: 9, image_url: 'b', caption: null, created_at: 't', expires_at: 't', user_name: 'Cy', profile_image_url: null },
  ];
  const res = await call('GET', '/api/stories', 'bo');
  const body = await res.json();

  const feed = find('SELECT s.id, s.user_id, s.image_url');
  const wherePos = feed.sql.indexOf('WHERE');
  const limitPos = feed.sql.indexOf('LIMIT $2');
  assert.ok(feed.sql.slice(wherePos, limitPos).includes('s.expires_at > NOW()'),
    'expiry is not part of the WHERE that runs before the LIMIT');

  // And the handler passes every row through. A route that re-filtered here
  // would be admitting the SQL does not decide, and would drop these two.
  assert.strictEqual(body.story_groups.length, 1);
  assert.strictEqual(body.story_groups[0].stories.length, 2);
  assertUnderstood();
});

test('the live predicate and the purge predicate are exact complements, so the boundary has no gap and no overlap', async () => {
  await call('GET', '/api/stories', 'bo');
  await settle();
  const purge = find('DELETE FROM stories WHERE id IN (');
  // Strict > on the read, <= on the delete. A story is live or purgeable, never
  // both and never neither, at every instant including expires_at itself.
  assert.ok(storyVisibilitySql().includes('s.expires_at > NOW()'));
  assert.ok(purge.sql.includes('s.expires_at <= NOW()'));
  // Belt and braces on the same row: a second, independent predicate that the
  // grace window has also passed, with the grace clamped non-negative.
  assert.ok(purge.sql.includes("s.expires_at <= NOW() - ($1::int * INTERVAL '1 hour')"));
  assert.ok(S.PURGE_GRACE_HOURS >= 0, 'a negative grace would aim the delete at live stories');
  assert.strictEqual(purge.params[0], S.PURGE_GRACE_HOURS);
  assert.strictEqual(purge.params[1], S.PURGE_BATCH);
});

// --- the two refusal clocks -------------------------------------------------

test('neither refusal instant reaches the driver as a naive timestamp', () => {
  // stories.created_at and stories.expires_at are TIMESTAMP, and node-postgres
  // parses that type by reading the calendar fields as LOCAL time. Cast to
  // timestamptz, Postgres sends an offset and the driver honours it.
  const sql = ROUTE_SRC.match(/const STORY_LIMIT_STATE_SQL = `([\s\S]*?)`;/)[1];
  const legs = sql.split('\n').filter((l) => /AS (hour|active)_frees_at/.test(l));
  assert.strictEqual(legs.length, 2, 'the limit statement no longer has two frees-at legs');
  for (const leg of legs) {
    assert.match(leg, /\)::timestamptz AS (hour|active)_frees_at/,
      `this leg hands a naive timestamp to the driver, which will read it in the process time zone: ${leg.trim()}`);
  }
});

// The test above pins TWO legs by name. That was the whole guard, and it is why
// the same bug was still in this file: when the naive-timestamp problem was
// found, the two refusal legs were cast, a test was written that named those
// two legs, and the feed and the post response went on handing the driver a
// bare `timestamp` for weeks. The guard proved the fix, not the property.
//
// So this one asks the question by property instead of by name: take every SQL
// literal in the module, look at what each one SELECTs or RETURNS, and require
// that no naive timestamp column is in that output list without a cast. A leg
// added tomorrow is covered without anyone remembering to come back here.
//
// Parenthesised groups are removed first, which is what keeps this honest
// rather than noisy: `COUNT(*) FILTER (WHERE created_at > NOW())::int` and
// `(SELECT MIN(expires_at) ...)::timestamptz` both MENTION a naive column, and
// neither one hands it to the driver. Only the top level does that.
test('no SELECT or RETURNING in this module hands the driver a naive timestamp', () => {

  const stripParens = (text) => {
    let out = '', depth = 0;
    for (const ch of text) {
      if (ch === '(') { depth += 1; continue; }
      if (ch === ')') { depth = Math.max(0, depth - 1); continue; }
      if (depth === 0) out += ch;
    }
    return out;
  };

  const literals = ROUTE_SRC.match(/`[^`]*`/g) || [];
  const outputLists = [];
  for (const lit of literals) {
    const body = lit.slice(1, -1);
    if (!/\bSELECT\b|\bRETURNING\b/i.test(body)) continue;
    for (const m of body.matchAll(/\bSELECT\b([\s\S]*?)\bFROM\b/gi)) outputLists.push(m[1]);
    for (const m of body.matchAll(/\bRETURNING\b([\s\S]*)$/gi)) outputLists.push(m[1]);
  }
  assert.ok(outputLists.length >= 3,
    `expected to find the module's SELECT/RETURNING lists; found ${outputLists.length}, so this guard is scanning nothing`);

  // A regex LITERAL, deliberately, and not `new RegExp` over a template string.
  // The first version of this guard built its pattern with new RegExp and a
  // template literal, and a template literal eats its own backslashes: the \b
  // became a backspace character, \s and \w became plain s and w, and the
  // pattern matched nothing at all. The test passed on every input, including
  // the two bare columns it had been written that same minute to catch. An
  // inert guard is worse than no guard, because it reads like coverage.
  const COLUMN = /(AS\s+)?(?:\w+\.)?\b(created_at|expires_at)\b(::timestamptz)?/g;

  // The pattern must be known to fire on a string that IS an offender, or an
  // empty offender list below proves nothing. This is exactly the check the
  // broken version would have failed on immediately.
  const canary = [...' s.expires_at, u.name '.matchAll(COLUMN)];
  assert.strictEqual(canary.length, 1,
    'the column pattern no longer matches a bare column, so an empty offender list means nothing');
  assert.strictEqual(canary[0][3], undefined,
    'the column pattern reports a bare column as already cast');

  const offenders = [];
  for (const list of outputLists) {
    const top = stripParens(list);
    for (const m of top.matchAll(COLUMN)) {
      if (m[1]) continue;            // an output alias, not a column read
      if (m[3]) continue;            // cast, which is the whole point
      offenders.push(`${m[2]} in: ${top.trim().replace(/\s+/g, ' ').slice(0, 90)}`);
    }
  }

  assert.deepStrictEqual(offenders, [],
    'these output lists hand a naive TIMESTAMP to node-postgres, which reads its calendar fields in the PROCESS time zone; production runs UTC so it looks fine until it is not:\n  ' + offenders.join('\n  '));
});

test('the wait a rate-limited poster is told is the wait the database meant', async () => {
  // Both legs, both refusal sentences, and the header and body fields with
  // them. utils/retryAfter.js exists because a refusal that names a window the
  // caller can follow and still be refused is worse than one that names none.
  for (const leg of ['hour', 'active']) {
    reset();
    S.setLastPurgeAt(0);
    stubImageModeration(async () => ({ allowed: true, reason: null }));
    const minutes = leg === 'hour' ? 10 : 9 * 60;
    const at = new Date(Date.now() + minutes * 60 * 1000);
    if (leg === 'hour') { state.lastHour = S.STORIES_PER_HOUR; state.hourFreesAt = at; }
    else { state.active = S.MAX_ACTIVE_STORIES; state.activeFreesAt = at; }

    const res = await call('POST', '/api/stories', 'ava', { image_url: TINY_PNG });
    assert.strictEqual(res.status, 429);
    const said = await res.json();
    const truth = Math.ceil((at.getTime() - Date.now()) / 1000);
    assert.ok(Math.abs(said.retryAfterSeconds - truth) <= 3,
      `${leg}: told to come back in ${said.retryAfterSeconds}s when the slot opens in ${truth}s`);
    assert.strictEqual(res.headers.get('retry-after'), String(said.retryAfterSeconds),
      `${leg}: the header and the body disagree about when to come back`);
    assert.ok(Math.abs(Date.parse(said.resetsAt) - at.getTime()) <= 3000, `${leg}: resetsAt is not that instant`);
  }
});

test('the capacity refusal offers the thing that clears it, and the rate refusal does not pretend to', async () => {
  // Different ceilings on different clocks. Deleting a story frees a live slot
  // instantly and does nothing at all for the hourly rate, so offering it on
  // the wrong one sends somebody back all evening to the same refusal.
  stubImageModeration(async () => ({ allowed: true, reason: null }));
  state.active = S.MAX_ACTIVE_STORIES;
  const capacity = await (await call('POST', '/api/stories', 'ava', { image_url: TINY_PNG })).json();
  assert.match(capacity.error, /delete one to post now/);
  assert.match(capacity.error, /which is the most at once/);

  reset();
  S.setLastPurgeAt(0);
  state.lastHour = S.STORIES_PER_HOUR;
  const rate = await (await call('POST', '/api/stories', 'ava', { image_url: TINY_PNG })).json();
  assert.ok(!/delete one/.test(rate.error), 'the hourly rate offers a fix that does not clear it');
  assert.match(rate.error, /most per hour/);
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. RETENTION: the purge has to be able to run
// ═══════════════════════════════════════════════════════════════════════════

test('the feed is not the only thing that can trigger the purge, because nothing reads the feed', async () => {
  // The launch client never calls GET /api/stories: the product decision of
  // 2026-08-14 is that stories get no UI, and it holds. So a purge wired only
  // to the read path is a purge that never runs on any deployed instance, and
  // "stories last 24 hours" stops being true of the row.
  const api = fs.readFileSync(
    path.join(__dirname, '..', '..', 'frontend', 'src', 'services', 'api.js'), 'utf8');
  assert.ok(/export async function getStories/.test(api), 'the wrapper this reasoning rests on is gone');
  // Every mention of the name in CODE, minus the declaration itself. Comment
  // lines are dropped first, because the comment sitting above that declaration
  // names the function while arguing that nothing calls it. This is that claim
  // measured rather than believed.
  const apiCode = api.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  const callers = (apiCode.match(/getStories\b/g) || []).length - 1;
  assert.strictEqual(callers, 0, 'getStories now has callers; re-read the purge trigger comment');

  // Trigger 1: a successful post. A row exists because POST created it, so this
  // is the door guaranteed to be running wherever there is anything to purge.
  stubImageModeration(async () => ({ allowed: true, reason: null }));
  const posted = await call('POST', '/api/stories', 'ava', { image_url: TINY_PNG });
  assert.strictEqual(posted.status, 201);
  await settle();
  assert.strictEqual(state.purgeCalls, 1, 'posting a story does not drive the retention purge');
});

test('a delete drives the purge, and so does the branch that only pretends to delete', async () => {
  // The retire branch is the one that most needs it. The row survived because a
  // moderator has an open report on it; the author was told "Story removed" and
  // all that happened was an expiry brought forward. The bytes leave when the
  // purge runs, and only then.
  state.deleteReturns = [];                  // evidence guard held
  state.updateReturns = [{ id: 501 }];       // so the row was retired instead
  const retired = await call('DELETE', '/api/stories/501', 'ava');
  assert.strictEqual(retired.status, 200);
  assert.strictEqual((await retired.json()).message, 'Story removed');
  assert.ok(find('UPDATE stories SET expires_at'), 'the retire branch did not run');
  await settle();
  assert.strictEqual(state.purgeCalls, 1, 'the retire branch leaves the row with nothing to remove it');

  // And a real delete.
  reset();
  S.setLastPurgeAt(0);
  const deleted = await call('DELETE', '/api/stories/501', 'ava');
  assert.strictEqual(deleted.status, 200);
  await settle();
  assert.strictEqual(state.purgeCalls, 1, 'deleting a story does not drive the retention purge');
});

test('a delete that matched nothing is a 404 and drives nothing', async () => {
  state.deleteReturns = [];
  state.updateReturns = [];
  const res = await call('DELETE', '/api/stories/501', 'bo');
  assert.strictEqual(res.status, 404);
  await settle();
  assert.strictEqual(state.purgeCalls, 0, 'an id-walker can drive the delete sweep');
});

test('a purge failure can never fail the write that triggered it', async () => {
  state.purgeThrows = true;
  stubImageModeration(async () => ({ allowed: true, reason: null }));
  const posted = await call('POST', '/api/stories', 'ava', { image_url: TINY_PNG });
  assert.strictEqual(posted.status, 201, 'a cleanup failure turned a successful post into an error');
  await settle();

  reset();
  S.setLastPurgeAt(0);
  state.purgeThrows = true;
  const deleted = await call('DELETE', '/api/stories/501', 'ava');
  assert.strictEqual(deleted.status, 200, 'a cleanup failure turned a successful delete into an error');
  await settle();
});

test('the purge is still debounced across the new triggers, so three doors are not three deletes', async () => {
  stubImageModeration(async () => ({ allowed: true, reason: null }));
  await call('POST', '/api/stories', 'ava', { image_url: TINY_PNG });
  await settle();
  await call('DELETE', '/api/stories/501', 'ava');
  await call('GET', '/api/stories', 'ava');
  await settle();
  assert.strictEqual(state.purgeCalls, 1, 'the debounce does not cover every trigger');
  assert.strictEqual(S.PURGE_INTERVAL_MS, 60 * 60 * 1000);
});

test('the purge preserves evidence a moderator is still being asked to judge', async () => {
  await call('GET', '/api/stories', 'ava');
  await settle();
  const purge = find('DELETE FROM stories WHERE id IN (');
  assert.match(purge.sql, /NOT EXISTS \( SELECT 1 FROM content_reports r WHERE r\.content_type = 'story'/);
  assert.match(purge.sql, /r\.status IN \('open', 'under_review'\)/);
  assert.match(purge.sql, /ORDER BY s\.expires_at LIMIT \$2::int FOR UPDATE SKIP LOCKED/,
    'the purge is unbounded or unordered');
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. MODERATION: a takedown has to hold, and a ban has to retract
// ═══════════════════════════════════════════════════════════════════════════

test('a hidden story still counts against the live cap: a takedown does not hand back a slot', async () => {
  stubImageModeration(async () => ({ allowed: true, reason: null }));
  await call('POST', '/api/stories', 'ava', { image_url: TINY_PNG });
  const insert = find('INSERT INTO stories');
  const capacity = insert.sql.slice(insert.sql.indexOf('expires_at > NOW()) <'));
  assert.ok(!/is_hidden/.test(capacity),
    'the live-story count excludes hidden rows, so a takedown earns the poster a free slot');
});

test('the report gate and the feed differ only where a reason is recorded for it', () => {
  // Two callers of one rule. The feed hides takedowns and banned authors; the
  // report gate must not, or reporting a story someone else has already
  // reported answers "that content could not be found".
  const feed = storyVisibilitySql({ viewer: '$1', authorAlias: 'u' });
  const gate = storyVisibilitySql({ viewer: '$2', includeOwn: true, excludeHidden: false, excludeBannedAuthor: false });
  assert.ok(feed.includes('is_hidden') && !gate.includes('is_hidden'));
  assert.ok(feed.includes('is_banned') && !gate.includes('is_banned'));
  // Everything that protects a person is in BOTH: expiry, and blocks both ways.
  for (const shared of ['s.expires_at > NOW()', 'user_blocks b']) {
    assert.ok(feed.includes(shared) && gate.includes(shared), `${shared} is missing from one of the two`);
  }
});

test('there is no edit route and no un-expire route, so screened bytes stay the served bytes', async () => {
  for (const method of ['PUT', 'PATCH']) {
    const res = await call(method, '/api/stories/501', 'ava', { image_url: TINY_PNG });
    assert.strictEqual(res.status, 404, `${method} /api/stories/:id must not exist`);
  }
  // And the delete's retire branch can only ever move an expiry FORWARD, so
  // the one UPDATE on this table cannot put an expired story back on a feed.
  state.deleteReturns = [];
  await call('DELETE', '/api/stories/501', 'ava');
  const update = find('UPDATE stories SET expires_at');
  assert.match(update.sql, /CASE WHEN expires_at > NOW\(\) THEN NOW\(\) ELSE expires_at END/,
    'the retire branch can push an expiry later, which un-expires a story');
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. COST, ABUSE AND WHAT LEAVES THE SERVER
// ═══════════════════════════════════════════════════════════════════════════

test("the feed is never cached: it is other people's photographs under a 24 hour promise", async () => {
  state.feedRows = [];
  const res = await call('GET', '/api/stories', 'bo');
  assert.strictEqual(res.status, 200);
  assert.match(res.headers.get('cache-control') || '', /no-store/,
    'the story feed is cacheable, so a copy outlives the expiry the feed itself enforces');
  assert.match(res.headers.get('cache-control') || '', /private/);
});

test('the worst-case feed response is bounded, and the bound is the reason the page size is small', () => {
  // Images are inline base64, so a page of stories is a page of whole images.
  const worst = S.MAX_FEED_LIMIT * S.MAX_IMAGE_DATA_URL_BYTES;
  assert.ok(S.MAX_FEED_LIMIT <= 50, 'the page cap moved without the response-size argument moving with it');
  assert.ok(worst <= 40 * 1024 * 1024, `a single feed read can return ${Math.round(worst / 1024 / 1024)}MB`);
  assert.ok(S.DEFAULT_FEED_LIMIT <= S.MAX_FEED_LIMIT);
});

test('a capped account cannot spend a Cloud Vision call, and every call this door makes is metered to its account', async () => {
  // The flood check runs BEFORE the paid screen, so a script that has already
  // hit either ceiling burns none of the day's budget. That ordering is the
  // only thing this door contributes to the spend controls: a REFUSED image
  // writes no row, so neither story ceiling counts it, and what actually bounds
  // an attacker here is utils/visionBudget.js's per-account leg.
  const seen = stubImageModeration(async () => ({ allowed: true, reason: null }));
  state.lastHour = S.STORIES_PER_HOUR;
  const res = await call('POST', '/api/stories', 'ava', { image_url: TINY_PNG });
  assert.strictEqual(res.status, 429);
  assert.deepStrictEqual(seen, [], 'a rate-limited post spent a billed Cloud Vision call');

  reset();
  S.setLastPurgeAt(0);
  const seen2 = stubImageModeration(async () => ({ allowed: true, reason: null }));
  await call('POST', '/api/stories', 'ava', { image_url: TINY_PNG });
  assert.strictEqual(seen2.length, 1);
  assert.deepStrictEqual(seen2[0].opts, { userId: 1 },
    'the story screen is not metered to the account that asked for it');
});

test('a moderation refusal and a budget exhaustion read the same to the user, and neither stores anything', async () => {
  // Telling somebody the moderation budget ran out invites them to retry until
  // it comes back, and tells an attacker their spend attack landed.
  for (const reason of ['moderation_budget', 'moderation_error', 'unsafe_adult']) {
    reset();
    S.setLastPurgeAt(0);
    stubImageModeration(async () => ({ allowed: false, reason }));
    const res = await call('POST', '/api/stories', 'ava', { image_url: TINY_PNG });
    assert.strictEqual(res.status, 400);
    const said = await res.json();
    assert.strictEqual(said.error, moderation.IMAGE_REJECTED_MESSAGE, `${reason} leaked its cause`);
    assert.ok(!/budget|quota|billing|vision/i.test(said.error));
    assert.ok(!find('INSERT INTO stories'), `${reason} stored the image anyway`);
  }
  // The one refusal that must NOT wear the generic sentence: an animated image
  // is refused by policy, and there is nothing a person can do to a GIF to make
  // it verify as safe.
  reset();
  S.setLastPurgeAt(0);
  stubImageModeration(async () => ({ allowed: false, reason: 'animated_image' }));
  const res = await call('POST', '/api/stories', 'ava', { image_url: TINY_PNG });
  assert.strictEqual((await res.json()).error, moderation.ANIMATED_IMAGE_REJECTED_MESSAGE);
});

test('a feed that fails is an error, never an empty feed', async () => {
  state.feedThrows = true;
  const res = await call('GET', '/api/stories', 'bo');
  assert.strictEqual(res.status, 500);
  const said = await res.json();
  assert.strictEqual(said.error, 'Failed to fetch stories');
  assert.ok(!('story_groups' in said),
    'a failed read answers with a feed shape, so the client draws "nothing here yet" over an outage');
});

test('no user-visible string on this door carries an em dash', () => {
  // A sweep fails the build on one, and every sentence here is a sentence a
  // person reads at the moment something went wrong.
  const strings = ROUTE_SRC.split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('--'))
    .join('\n')
    .match(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g) || [];
  for (const s of strings) {
    assert.ok(!s.includes('—'), `em dash in a route string: ${s}`);
  }
  for (const message of [S.IMAGE_TOO_LARGE_MESSAGE]) {
    assert.ok(!message.includes('—'), message);
  }
});

// ---------------------------------------------------------------------------
// THE PURGE HAS A TIMER OF ITS OWN, AND KEEPS IT
// ---------------------------------------------------------------------------
// The route deletes expired stories opportunistically, off a feed read, a
// successful post and a delete. That is a floor. It is not retention.
//
// Before this sweep existed the ONLY unattended trigger was the tail of
// GET /api/stories, and the shipping client never calls that route, so a table
// of expired rows in a process nobody posts to stayed full forever. The feed
// filtered on expires_at, so "stories last 24 hours" was true of what a person
// could SEE and false of what the database HELD: the image stayed. That is a
// retention promise about a photograph on a product whose enforced age floor is
// 13, so it is worth a test rather than a comment.
//
// Deleting the schedule is invisible: every stories test still passes, because
// they all drive the route, which still purges. Nothing would notice until
// somebody looked at the table. So this asserts the two halves that make it
// unattended, and asserts them by property rather than by spelling: the purge
// is handed to setInterval somewhere in boot, and the handle is cleared in
// shutdown. A rename of the local variable is fine; losing the timer is not.
test('the expired-story purge is scheduled on its own timer and cleared on shutdown', () => {
  // Comments are stripped before anything is matched here, and that is not a
  // flourish. The first version of this test read the raw file, so commenting
  // the schedule out left the words setInterval(storyPurge sitting in the
  // source and the assertion passed while the timer was gone. My own mutation
  // check is what caught it. It is the same shape the em dash sweep had to fix:
  // a check that reads source text cannot tell code from a comment unless it is
  // made to.
  const rawServerSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  // The \r strip is load-bearing on Windows and was the second bug in this one
  // assertion. This repository checks out CRLF here and LF in CI, and a JS dot
  // does not match \r, so `//.*$` stopped before the carriage return, never
  // matched, and left the comment in place. The guard then passed over a
  // commented-out timer on a developer machine and would have behaved
  // differently in CI, which is the environment-dependent class this session
  // has already been bitten by twice.
  const serverSrc = rawServerSrc
    .replace(/\r/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/(^|[^:])\/\/[^\n]*$/, '$1'))
    .join('\n');

  const scheduled = /setInterval\(\s*storyPurge\b/.test(serverSrc)
    || /setInterval\(\s*\(\)\s*=>\s*purgeExpiredStories\b/.test(serverSrc);
  assert.ok(scheduled,
    'nothing in server.js hands the expired-story purge to setInterval, so expired photos are only deleted when somebody happens to read a feed the shipping client never reads');

  assert.match(serverSrc, /clearInterval\(storyPurgeInterval\)/,
    'the story purge timer is never cleared, so shutdown cannot drain cleanly');

  // The route half is the floor and must stay: a running process should not
  // wait up to an hour to honour a delete it just performed.
  const routeSrc = fs.readFileSync(path.join(__dirname, '..', 'routes', 'stories.js'), 'utf8');
  assert.ok(/purgeExpiredStories\(\)/.test(routeSrc),
    'the route stopped purging opportunistically; the hourly sweep alone leaves a window');
});

// This one is not a source-text check, and that is the point: the two above can
// only ever prove that some words are present in a file. This one loads the
// module the way boot() loads it and asks the object what it actually has, so
// it fails on the thing that would really take production down, which is the
// export disappearing or being wrapped in an environment check. Boot happens
// before listen(), so this is not a degraded feature: it is the port never
// opening.
test('routes/stories exports purgeExpiredStories to boot code, unconditionally', () => {
  const stories = require('../routes/stories');
  assert.strictEqual(typeof stories.purgeExpiredStories, 'function',
    'server.js destructures purgeExpiredStories from this module at boot; without it boot() throws before listen() and the service never opens its port');

  // And it must not be reachable only outside production. NODE_ENV is read at
  // require time by anything that gates on it, so the check has to survive a
  // fresh load with the production value set.
  const before = process.env.NODE_ENV;
  const modPath = require.resolve('../routes/stories');
  try {
    process.env.NODE_ENV = 'production';
    delete require.cache[modPath];
    const prod = require('../routes/stories');
    assert.strictEqual(typeof prod.purgeExpiredStories, 'function',
      'purgeExpiredStories is gated on NODE_ENV, so it exists in tests and is missing in the only environment that matters');
  } finally {
    process.env.NODE_ENV = before;
    delete require.cache[modPath];
    require('../routes/stories');
  }
});
