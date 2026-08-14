// Run: node --test  (from backend/)
//
// Round 20 — MODERATION REACH. One question, asked four ways:
//
//   Is there any piece of user content in this app that can be reported but not
//   judged, judged but not reported, or acted on without a moderator ever
//   seeing it?
//
// Every finding here was a "yes":
//
//   1. THE QUEUE COULD NOT SHOW A REPORTED PHOTO. routes/admin.js nulled any
//      inline `data:` image out of the list response — correctly, because 200
//      story photos is a hundred-megabyte payload — and stopped there. An image
//      message has no message_text, so a moderator opening the single most
//      important category of report in a photo app saw an empty body, no
//      picture, and two buttons that hide content permanently or ban a
//      15-year-old. The list still withholds the bytes; GET
//      /api/admin/reports/:id/image serves one report's image when a human
//      actually opens it, and the list now says which rows have one waiting.
//      Profile reports were worse still: the avatar is the reported content and
//      the queue did not join `users` at all.
//   2. TWO COPIES OF THE STORY VISIBILITY RULE. routes/stories.js (the feed)
//      and routes/moderation.js (the report gate) each carried the predicate,
//      and they had already drifted. utils/relationships.js now owns it and
//      every difference is a named argument.
//   3. venue_events HAD NO is_hidden AND NO REPORT TYPE, alone among the venue
//      tables. Inert today because nothing serves events publicly, and one
//      afternoon's feature away from shipping unmoderatable UGC.
//   4. A REPORT THAT NAMED NOTHING was accepted and queued. 'hide' refuses it,
//      'ban' refuses it, and ten an hour per account push real reports off the
//      bottom of a LIMIT 200 view.
//
// No database. pool.query / pool.connect are scripted per test.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

process.env.JWT_SECRET = 'moderation-reach-test-secret';

const pool = require('../config/database');

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------
let handlers = [];
let log = [];
let emitted = [];

function dispatch(sql, params) {
  log.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
  for (const [re, fn] of handlers) {
    if (re.test(sql)) {
      const out = fn(params || [], String(sql));
      return Promise.resolve(out === undefined ? { rows: [], rowCount: 0 } : out);
    }
  }
  return Promise.reject(new Error(`unscripted query: ${String(sql).replace(/\s+/g, ' ').slice(0, 160)}`));
}

pool.query = (sql, params) => dispatch(sql, params);
pool.connect = async () => ({
  query: (sql, params) => {
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(sql)) {
      log.push({ sql: String(sql).trim(), params: null });
      return Promise.resolve({ rows: [] });
    }
    return dispatch(sql, params);
  },
  release: () => {},
});

const fakeIo = {
  to(room) {
    return {
      emit: (event, payload) => {
        emitted.push({ room, event, payload });
        log.push({ sql: `EMIT ${event} -> ${room}`, params: null });
      },
    };
  },
  in() { return { disconnectSockets: () => {} }; },
};

// Patched before the routers are required: both destructure `authenticate` at
// require time and mount it with router.use.
const authMod = require('../middleware/auth');
let CURRENT_USER = { id: 99, name: 'Mod', role: 'admin' };
authMod.authenticate = (req, _res, next) => { req.user = CURRENT_USER; next(); };

const adminRouter = require('../routes/admin');
const moderationRouter = require('../routes/moderation');
const { storyVisibilitySql } = require('../utils/relationships');
const { VALID_CONTENT_TYPES } = moderationRouter.__test;

const app = express();
app.use(express.json());
app.set('io', fakeIo);
app.use('/api/admin', adminRouter);
app.use('/api', moderationRouter);

let base;
const server = http.createServer(app);
test.before(() => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => {
    base = `http://127.0.0.1:${server.address().port}`;
    resolve();
  });
}));
test.after(() => new Promise((resolve) => {
  server.close(() => resolve());
  pool.end?.().catch(() => {});
}));

test.beforeEach(() => {
  handlers = [];
  log = [];
  emitted = [];
  CURRENT_USER = { id: 99, name: 'Mod', role: 'admin' };
});

async function call(method, path_, body, headers = {}) {
  const res = await fetch(base + path_, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, body: json, text, headers: res.headers };
}

const ran = (re) => log.filter((q) => re.test(q.sql));

const SRC = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const ADMIN_SRC = SRC('routes', 'admin.js');
const MODERATION_SRC = SRC('routes', 'moderation.js');
const STORIES_SRC = SRC('routes', 'stories.js');
const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

// Strip line comments and collapse whitespace, so an assertion is about SQL
// rather than about how it was laid out.
const sqlText = (s) => s.replace(/^\s*--.*$/gm, '').replace(/\s+/g, ' ').trim();

// Migration files in this repo carry long prose headers that quote the very
// statements they run. Every assertion below reads the EXECUTABLE half only —
// checked by commenting a statement out and watching these go red, which they
// did not when they were matching against the whole file.
const sqlBody = (file) => fs.readFileSync(file, 'utf8').replace(/^\s*--.*$/gm, '');

// ===========================================================================
// A. Nothing reportable is unjudgeable, and nothing judgeable is unreportable
// ===========================================================================

// The takedown map is a route-private constant, read out of the source so this
// guard cannot drift by someone exporting a second copy.
function takedownTargets() {
  const start = ADMIN_SRC.indexOf('const TAKEDOWN_TARGETS = {');
  assert.ok(start > 0, 'TAKEDOWN_TARGETS must still be a literal object in routes/admin.js');
  const body = ADMIN_SRC.slice(start, ADMIN_SRC.indexOf('\n};', start));
  const out = new Map();
  for (const m of body.matchAll(/^\s{2}([a-z_]+):\s*\{\s*table:\s*'([a-z_]+)'/gm)) out.set(m[1], m[2]);
  return out;
}

test('every reportable type with a row behind it has a takedown target', () => {
  // THE BUG CLASS: 'guest_rsvp' was reportable for two rounds before anything
  // could hide it, and migration 005 had built the whole is_hidden pipeline for
  // it. A type that reaches the queue and cannot be acted on is a report button
  // that does nothing, which is exactly what Guideline 1.2 forbids.
  const targets = takedownTargets();
  const missing = VALID_CONTENT_TYPES.filter((t) => t !== 'profile' && !targets.has(t));
  assert.deepStrictEqual(missing, [],
    `routes/moderation.js accepts ${missing.join(', ')} and routes/admin.js cannot take it down. ` +
    'Add the TAKEDOWN_TARGETS entry and the is_hidden column in the same commit.');
});

test('every takedown target is a type somebody can actually report', () => {
  // The other direction, which is how you end up with a table that only a
  // moderator can hide and no user can flag.
  const targets = takedownTargets();
  const orphans = [...targets.keys()].filter((t) => !VALID_CONTENT_TYPES.includes(t));
  assert.deepStrictEqual(orphans, [],
    `routes/admin.js can hide ${orphans.join(', ')} but no report can name it`);
});

test("'profile' is the only reportable type with no row to hide, and it is handled", () => {
  const targets = takedownTargets();
  assert.ok(!targets.has('profile'), 'a profile report has no content row');
  // And the route must refuse it loudly rather than claim success — round 13.
  assert.match(ADMIN_SRC, /A profile report has no content to \$\{hiding \? 'hide' : 'restore'\}/);
});

test('every reportable type is rendered by the moderation queue', () => {
  // A takedown target that the queue cannot display is a moderator being asked
  // to act on an id. Each type must have a branch in the LATERAL.
  const missing = VALID_CONTENT_TYPES.filter(
    (t) => !ADMIN_SRC.includes(`r.content_type = '${t}'`)
  );
  assert.deepStrictEqual(missing, [],
    `GET /api/admin/reports shows no content for ${missing.join(', ')}: the card renders an id and two buttons`);
});

test('every table a takedown writes to has an is_hidden column in the migrations', () => {
  // The drift that shipped as 016 and again as 017, one level down: the route
  // map naming a column the schema does not have is a 42703 inside the takedown
  // transaction, which the moderator reads as "Failed to apply action".
  const sql = fs.readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql')).sort()
    .map((f) => sqlBody(path.join(MIGRATIONS_DIR, f)))
    .join('\n');
  for (const table of new Set(takedownTargets().values())) {
    const inAlter = new RegExp(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS is_hidden`, 'i').test(sql);
    const created = new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\n\\s*\\);`, 'i').exec(sql);
    const inCreate = !!(created && /is_hidden/i.test(created[1]));
    assert.ok(inAlter || inCreate,
      `${table} is a takedown target and no migration gives it is_hidden`);
  }
});

// ===========================================================================
// B. Migration 019 — the schema half of the venue_event fix
// ===========================================================================

const MIGRATION_019 = path.join(MIGRATIONS_DIR, '019_venue_event_moderation.sql');

test('019 exists, claims its number alone, and does not renumber its neighbours', () => {
  assert.ok(fs.existsSync(MIGRATION_019));
  const nineteens = fs.readdirSync(MIGRATIONS_DIR).filter((f) => /^019[_.]/.test(f));
  assert.deepStrictEqual(nineteens, ['019_venue_event_moderation.sql']);
  // 018 is still the file 018 was, so an already-migrated database does not
  // re-run something under a name it has recorded.
  assert.ok(fs.existsSync(path.join(MIGRATIONS_DIR, '018_stories_report_indexes.sql')));
});

test('019 gives venue_events the takedown column its siblings have', () => {
  const sql = sqlBody(MIGRATION_019);
  assert.match(sql, /ALTER TABLE venue_events ADD COLUMN IF NOT EXISTS is_hidden BOOLEAN DEFAULT false/);
});

test('019 widens the report CHECK to include venue_event, keeping all seven older types', () => {
  const sql = sqlBody(MIGRATION_019);
  const check = sql.slice(sql.indexOf('ADD CONSTRAINT content_reports_content_type_check'));
  const values = new Set([...check.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]));
  for (const t of VALID_CONTENT_TYPES) {
    assert.ok(values.has(t), `${t} is accepted by the route and refused by 019's constraint`);
  }
  // A narrowing constraint would fail on rows that already exist.
  for (const kept of ['flock_message', 'dm', 'profile', 'story', 'venue_review', 'venue_promotion', 'guest_rsvp']) {
    assert.ok(values.has(kept), `${kept} must not be dropped`);
  }
});

test('019 drops before it adds, and does not swallow its own failure', () => {
  const body = sqlBody(MIGRATION_019);
  assert.match(body, /DROP CONSTRAINT IF EXISTS content_reports_content_type_check/);
  assert.ok(body.indexOf('DROP CONSTRAINT') < body.indexOf('ADD CONSTRAINT'),
    'ADD before DROP leaves the seven-value constraint in place');
  // 017's reasoning: db/migrate.js records the file as applied either way, so a
  // swallowed ALTER marks the fix done while the old constraint stands.
  assert.ok(!/EXCEPTION\s+WHEN/i.test(body));
});

// ===========================================================================
// C. venue_event, end to end: report it, then take it down
// ===========================================================================

function reportRow(contentType, over = {}) {
  return { id: 7, content_type: contentType, content_id: 55, reported_user_id: 3, reporter_id: 4, status: 'open', ...over };
}

test('a venue event can be reported, and the report reaches the queue', async () => {
  handlers = [
    [/FROM venue_events/, () => ({ rows: [{ sender_id: 12, is_hidden: false }], rowCount: 1 })],
    [/SELECT id, status, created_at FROM content_reports/, () => ({ rows: [] })],
    [/INSERT INTO content_reports/, () => ({ rows: [{ id: 1, status: 'open', created_at: 'now' }], rowCount: 1 })],
  ];
  const res = await call('POST', '/api/reports', {
    content_type: 'venue_event', content_id: 55, reported_user_id: 12, reason: 'hate',
  });
  assert.strictEqual(res.status, 201, res.text);
  assert.strictEqual(ran(/INSERT INTO content_reports/).length, 1);
});

test('a venue event report checks the row exists before it is filed', async () => {
  handlers = [[/FROM venue_events/, () => ({ rows: [], rowCount: 0 })]];
  const res = await call('POST', '/api/reports', {
    content_type: 'venue_event', content_id: 999, reason: 'spam',
  });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(ran(/INSERT INTO content_reports/).length, 0,
    'a report naming nothing is unactionable in the queue');
});

test('a venue event already taken down answers success, in the same words as a fresh report', async () => {
  // Round 17's rule, applied to the new type: two people reporting the same
  // thing seconds apart must not have the second one told it does not exist.
  handlers = [[/FROM venue_events/, () => ({ rows: [{ sender_id: 12, is_hidden: true }], rowCount: 1 })]];
  const res = await call('POST', '/api/reports', {
    content_type: 'venue_event', content_id: 55, reason: 'spam',
  });
  assert.strictEqual(res.status, 201);
  assert.strictEqual(res.body.message, moderationRouter.__test.REPORT_ACCEPTED);
  assert.strictEqual(ran(/INSERT INTO content_reports/).length, 0);
});

test('a venue event can be hidden and restored, and the owner is told', async () => {
  for (const action of ['hide', 'unhide']) {
    handlers = [
      [/SELECT \* FROM content_reports WHERE id/, () => ({ rows: [reportRow('venue_event')], rowCount: 1 })],
      [/UPDATE venue_events SET is_hidden/, () => ({ rows: [{ flock_id: null, notify_a: 12, notify_b: null }], rowCount: 1 })],
      [/UPDATE content_reports SET status/, () => ({ rows: [], rowCount: 1 })],
      [/INSERT INTO moderation_actions/, () => ({ rows: [{ id: 1 }], rowCount: 1 })],
    ];
    log = [];
    emitted = [];
    // eslint-disable-next-line no-await-in-loop
    const res = await call('PUT', '/api/admin/reports/7', { action });
    assert.strictEqual(res.status, 200, `${action}: ${res.text}`);
    assert.strictEqual(ran(/UPDATE venue_events SET is_hidden/)[0].params[0], action === 'hide');
    assert.deepStrictEqual(emitted.map((e) => e.room), ['user:12']);
    assert.strictEqual(emitted[0].event, action === 'hide' ? 'content_removed' : 'content_restored');
  }
});

// ===========================================================================
// D. The reported image actually reaches the moderator
// ===========================================================================

const STORY_DATA_URL = `data:image/png;base64,${'A'.repeat(4000)}`;

test('the queue still withholds inline images, and now says one is waiting', () => {
  // Both halves matter. Inlining 200 story photos is a hundred-megabyte
  // response; withholding them SILENTLY is a blank card.
  const listSql = ADMIN_SRC.slice(ADMIN_SRC.indexOf('LEFT JOIN LATERAL') - 3000, ADMIN_SRC.indexOf('LEFT JOIN LATERAL'));
  // Matched on the AS clause, not the bare word: the paragraph explaining this
  // sits in the same slice, so a looser pattern passes on the comment alone.
  assert.match(listSql, /\bAS content_image_deferred\b/,
    'the list must tell the console there is an image it did not send');
  assert.match(listSql, /THEN NULL ELSE c\.image_url END AS content_image_url/,
    'hosted URLs still inline; the data: cap is what makes the queue a queue');
  assert.match(ADMIN_SRC, /router\.get\('\/reports\/:id\/image'/,
    'the flag is a promise that a fetch endpoint exists');
});

test('a reported story photo is retrievable in full, one report at a time', async () => {
  // THE BUG: this was unreachable. The queue nulled the data URL and there was
  // no other route, so "nudity" filed against a photo arrived with no photo.
  handlers = [
    [/SELECT id, content_type, content_id, reported_user_id FROM content_reports/, () => ({
      rows: [reportRow('story')], rowCount: 1,
    })],
    [/SELECT image_url AS image_url FROM stories/, () => ({ rows: [{ image_url: STORY_DATA_URL }], rowCount: 1 })],
  ];
  const res = await call('GET', '/api/admin/reports/7/image');
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(res.body.imageUrl, STORY_DATA_URL, 'the whole image, not a truncated one');
  assert.strictEqual(res.body.contentType, 'story');
  assert.strictEqual(res.body.contentId, 55);
});

test('the image lookup does NOT filter takedowns, so an un-hide can be judged', async () => {
  handlers = [
    [/FROM content_reports/, () => ({ rows: [reportRow('flock_message')], rowCount: 1 })],
    [/FROM messages/, () => ({ rows: [{ image_url: STORY_DATA_URL }], rowCount: 1 })],
  ];
  await call('GET', '/api/admin/reports/7/image');
  const lookup = ran(/FROM messages/)[0];
  assert.ok(!/is_hidden/.test(lookup.sql),
    'a moderator reversing their own takedown has to be able to see what they took down');
});

test('reported UGC is never handed to a cache', async () => {
  handlers = [
    [/FROM content_reports/, () => ({ rows: [reportRow('story')], rowCount: 1 })],
    [/FROM stories/, () => ({ rows: [{ image_url: STORY_DATA_URL }], rowCount: 1 })],
  ];
  const res = await call('GET', '/api/admin/reports/7/image');
  assert.match(String(res.headers.get('cache-control')), /no-store/);
});

test('a profile report serves the avatar, keyed on the reported USER not a content id', async () => {
  // A profile report carries no content_id at all, so keying this on content_id
  // would have answered "no image" for every one of them.
  handlers = [
    [/FROM content_reports/, () => ({ rows: [reportRow('profile', { content_id: null, reported_user_id: 42 })], rowCount: 1 })],
    [/FROM users WHERE id = \$1/, () => ({ rows: [{ image_url: 'data:image/jpeg;base64,ZZZZ' }], rowCount: 1 })],
  ];
  const res = await call('GET', '/api/admin/reports/7/image');
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(res.body.imageUrl, 'data:image/jpeg;base64,ZZZZ');
  const lookup = ran(/FROM users WHERE id/)[0];
  assert.strictEqual(lookup.params[0], 42, 'the row id is reported_user_id');
  assert.match(lookup.sql, /profile_image_url AS image_url/);
});

test('the profile card in the queue carries the profile, not just an account id', async () => {
  // The list half of the same finding: a profile report used to render the
  // reported name and nothing else, so "sexual content" against an avatar
  // reached a moderator with the avatar missing.
  assert.match(ADMIN_SRC, /FROM users pu WHERE r\.content_type = 'profile' AND pu\.id = r\.reported_user_id/);
  assert.match(ADMIN_SRC, /pu\.profile_image_url/);
});

test('a text-only report type is answered "no image", not an error and not a query', async () => {
  handlers = [
    [/FROM content_reports/, () => ({ rows: [reportRow('venue_review')], rowCount: 1 })],
  ];
  const res = await call('GET', '/api/admin/reports/7/image');
  assert.strictEqual(res.status, 404);
  assert.match(res.body.error, /no image/i);
  assert.strictEqual(ran(/FROM venue_reviews/).length, 0, 'venue reviews have no image column to read');
});

test('the image table and column come from the fixed map, never from the report row', async () => {
  // content_reports.content_type is CHECK-constrained, but this route
  // interpolates a table AND a column name, so it gets the same treatment
  // TAKEDOWN_TARGETS gets: an unmapped value produces no SQL at all.
  // 'constructor' and '__proto__' are in the list because a bare
  // `MAP[content_type]` lookup answers them from the prototype chain with a
  // truthy object, which would have put `undefined` into the table name.
  for (const bogus of ['users; DROP TABLE users', 'venue_events', '', 'profile_image_url', 'constructor', '__proto__', 'toString']) {
    handlers = [[/FROM content_reports/, () => ({ rows: [reportRow(bogus)], rowCount: 1 })]];
    log = [];
    // eslint-disable-next-line no-await-in-loop
    const res = await call('GET', '/api/admin/reports/7/image');
    assert.strictEqual(res.status, 404, `content_type ${JSON.stringify(bogus)}`);
    assert.strictEqual(log.filter((q) => /^SELECT .* AS image_url/.test(q.sql)).length, 0);
  }
});

test('the takedown map is prototype-safe too, and refuses rather than 500s', async () => {
  // The twin of the check above, on the route that writes. `UPDATE undefined
  // SET is_hidden` is a 500, and on this queue a 500 is indistinguishable from
  // "the takedown failed" — which is the one thing a moderator must never be
  // unsure about. Unreachable while the CHECK constraint holds; this is the
  // guard for the commit that widens the constraint and forgets the map.
  for (const bogus of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    handlers = [[/SELECT \* FROM content_reports WHERE id/, () => ({ rows: [reportRow(bogus)], rowCount: 1 })]];
    log = [];
    // eslint-disable-next-line no-await-in-loop
    const res = await call('PUT', '/api/admin/reports/7', { action: 'hide' });
    assert.strictEqual(res.status, 400, `content_type ${bogus} -> ${res.text}`);
    assert.strictEqual(ran(/SET is_hidden/).length, 0, bogus);
    assert.strictEqual(ran(/INSERT INTO moderation_actions/).length, 0,
      `${bogus}: the audit log must not record work nobody did`);
  }
});

test('content that has since been deleted names the action still available', async () => {
  handlers = [
    [/FROM content_reports/, () => ({ rows: [reportRow('story')], rowCount: 1 })],
    [/FROM stories/, () => ({ rows: [], rowCount: 0 })],
  ];
  const res = await call('GET', '/api/admin/reports/7/image');
  assert.strictEqual(res.status, 404);
  assert.match(res.body.error, /Dismiss the report/);
  assert.ok(!res.body.error.includes('—'), 'SLOP rule 1: no em dashes in user-visible copy');
});

test('an unknown, non-numeric or out-of-range report id is a 404, never a 500', async () => {
  handlers = [[/FROM content_reports/, () => ({ rows: [], rowCount: 0 })]];
  assert.strictEqual((await call('GET', '/api/admin/reports/8/image')).status, 404);

  // content_reports.id is SERIAL, so int4. `/^\d+$/` alone let 99999999999
  // through to Postgres, which answers 22003 and lands in the catch as a 500 —
  // on the moderation console, where a 500 reads as "the takedown failed".
  // Both report routes and both venue routes share one bound now.
  for (const bad of ['abc', '99999999999', '0', '-1', '1.5', '2147483648']) {
    log = [];
    handlers = [];
    // eslint-disable-next-line no-await-in-loop
    const res = await call('GET', `/api/admin/reports/${bad}/image`);
    assert.strictEqual(res.status, 404, `id ${bad}`);
    assert.strictEqual(log.length, 0, `id ${bad} reached the database`);
    log = [];
    // eslint-disable-next-line no-await-in-loop
    const put = await call('PUT', `/api/admin/reports/${bad}`, { action: 'dismiss' });
    assert.strictEqual(put.status, 404, `PUT id ${bad}`);
    assert.strictEqual(log.length, 0, `PUT id ${bad} reached the database`);
  }
});

test('the image endpoint is admin-only, like every other route on this router', async () => {
  CURRENT_USER = { id: 5, name: 'Ava', role: 'user' };
  handlers = [];
  const res = await call('GET', '/api/admin/reports/7/image');
  assert.strictEqual(res.status, 403);
  assert.strictEqual(log.length, 0);
});

// ===========================================================================
// E. One definition of "can this account see that story?"
// ===========================================================================

test('the helper reproduces routes/stories.js byte for byte, so adopting it is a no-op', () => {
  // The handoff this pins: stories.js is owned elsewhere and its one-line change
  // is `WHERE ${storyVisibilitySql({ viewer: '$1', authorAlias: 'u' })}`. Until
  // that lands, the two must stay identical — which is the whole point, since
  // they had already drifted once.
  const helper = sqlText(storyVisibilitySql({ viewer: '$1', authorAlias: 'u' }));

  if (STORIES_SRC.includes('storyVisibilitySql')) {
    // Adopted. Then the only thing to check is that it asks for the feed's
    // settings, not the report gate's.
    assert.match(STORIES_SRC, /storyVisibilitySql\(\{[^}]*authorAlias: 'u'/,
      'the feed must keep its is_banned filter: a ban has to retract what the account already posted');
    assert.ok(!/excludeHidden:\s*false/.test(STORIES_SRC),
      'the feed must keep filtering takedowns');
    return;
  }

  const feed = STORIES_SRC.slice(
    STORIES_SRC.indexOf('WHERE s.expires_at > NOW()') + 'WHERE '.length,
    STORIES_SRC.indexOf('ORDER BY s.created_at DESC')
  );
  assert.strictEqual(sqlText(feed), helper,
    'utils/relationships.js and routes/stories.js disagree. One of them is now wrong for the feed, ' +
    'and the report gate in routes/moderation.js follows whichever one the helper says.');
});

test('the report gate no longer carries its own copy of the predicate', () => {
  const gate = MODERATION_SRC.replace(/^\s*(\/\/|\*).*$/gm, '');
  assert.ok(!/FROM friendships WHERE \(requester_id/.test(gate),
    'the friendship grant is duplicated SQL again; it belongs in utils/relationships.js');
  assert.ok(!/JOIN flock_members fm2 ON fm2\.flock_id/.test(gate),
    'the flock-mate grant is duplicated SQL again');
  assert.match(MODERATION_SRC, /storyVisibilitySql\(/);
});

test('the report gate still runs the whole predicate, not a shortened one', async () => {
  handlers = [
    [/FROM stories s/, () => ({ rows: [{ sender_id: 9, is_hidden: false }], rowCount: 1 })],
    [/SELECT id, status, created_at FROM content_reports/, () => ({ rows: [] })],
    [/INSERT INTO content_reports/, () => ({ rows: [{ id: 1, status: 'open', created_at: 'now' }], rowCount: 1 })],
  ];
  const res = await call('POST', '/api/reports', {
    content_type: 'story', content_id: 55, reported_user_id: 9, reason: 'sexual',
  });
  assert.strictEqual(res.status, 201, res.text);
  const gate = ran(/FROM stories s/)[0].sql;
  // Without these a bare id lookup makes the report pipeline an oracle for
  // stories the reporter could never see.
  assert.match(gate, /FROM user_blocks b/);
  assert.match(gate, /FROM friendships/);
  assert.match(gate, /JOIN flock_members fm2/);
  assert.match(gate, /s\.expires_at > NOW\(\)/);
  assert.strictEqual(ran(/FROM stories s/)[0].params[1], 99, 'the viewer is the caller, bound not inlined');
});

test('the two deliberate differences from the feed are still there, and only those two', () => {
  const gate = sqlText(storyVisibilitySql({
    viewer: '$2', includeOwn: true, excludeHidden: false, excludeBannedAuthor: false,
  }));
  // is_hidden is read as a COLUMN by the route and answered as "already
  // handled"; filtering on it here would resurrect the round 17 bug where the
  // second person to report the same content was told it did not exist.
  assert.ok(!/is_hidden/.test(gate));
  // A story whose author was banned an instant ago is still a real report about
  // content that was on real screens.
  assert.ok(!/is_banned/.test(gate));
  // Everything else is shared.
  assert.match(gate, /FROM user_blocks b/);
  assert.match(gate, /FROM friendships/);
  assert.match(gate, /JOIN flock_members fm2/);
});

test('you can report your own story instead of being told it does not exist', () => {
  // The drift nobody had named: the feed granted `s.user_id = $1` and the
  // report gate did not, so reporting a story you are looking at came back
  // "That content could not be found".
  assert.match(sqlText(storyVisibilitySql({ viewer: '$2' })), /s\.user_id = \$2 OR/);
  assert.ok(!/s\.user_id = \$2 OR/.test(sqlText(storyVisibilitySql({ viewer: '$2', includeOwn: false }))));
});

test('the ban filter works without a users join, for callers that have none', () => {
  const joined = storyVisibilitySql({ viewer: '$1', authorAlias: 'u' });
  const standalone = storyVisibilitySql({ viewer: '$1' });
  assert.match(joined, /u\.is_banned IS NOT TRUE/);
  assert.match(standalone, /NOT EXISTS \(SELECT 1 FROM users ban_u/,
    'a caller that never joined users would otherwise get SQL naming an alias it did not declare');
});

test('the builder refuses anything that is not an identifier or a placeholder', () => {
  // Nothing here comes from a request today. This function is the one piece of
  // string-concatenated SQL in the codebase, so it is the one that must not be
  // a foothold if a caller ever passes something through from a body.
  for (const evil of ["s; DROP TABLE users --", 's.user_id', '', 1, null, {}]) {
    assert.throws(() => storyVisibilitySql({ story: evil }), /bare SQL identifier/, String(evil));
  }
  // null is the one legal non-identifier for authorAlias: it means "this caller
  // has not joined users, build the EXISTS form instead".
  for (const evil of ["u; DROP TABLE users --", 'u.is_banned', '', 1, {}]) {
    assert.throws(() => storyVisibilitySql({ authorAlias: evil }), /bare SQL identifier/, String(evil));
  }
  assert.doesNotThrow(() => storyVisibilitySql({ authorAlias: null }));
  for (const evil of ['1', '$1 OR 1=1', 'x', 1, '$0']) {
    assert.throws(() => storyVisibilitySql({ viewer: evil }), /bind placeholder/, String(evil));
  }
});

// ===========================================================================
// F. Reports that name a target — and the one open case that names none
// ===========================================================================

test('KNOWN GAP: a report naming neither content nor a user is still accepted', async () => {
  // Not an endorsement. This pins a hole so it cannot be forgotten, and records
  // why it was not closed here: __tests__/arrayShapeSweep.test.js asserts this
  // exact payload is NOT a 400 and DOES reach the database, making the point
  // that an explicit null must read as "absent" rather than as a validation
  // error. Both rules are right and they collide, so the fix belongs to
  // whoever owns that file.
  //
  // What lands is a content_reports row with no content_id and no
  // reported_user_id. In routes/admin.js 'hide' refuses it (no content row),
  // 'ban' refuses it (nobody named) and dismiss is the only action left, so it
  // is a queue entry that exists only to be cleared. The moment that test is
  // reconciled, this one flips to asserting a 400.
  handlers = [
    [/SELECT id, status, created_at FROM content_reports/, () => ({ rows: [] })],
    [/INSERT INTO content_reports/, () => ({ rows: [{ id: 1, status: 'open', created_at: 'now' }], rowCount: 1 })],
  ];
  const res = await call('POST', '/api/reports', { content_type: 'profile', reason: 'spam' });
  assert.strictEqual(res.status, 201);
  const insert = ran(/INSERT INTO content_reports/)[0];
  assert.strictEqual(insert.params[1], null, 'no user named');
  assert.strictEqual(insert.params[3], null, 'no content named');
});

test('a report naming only a user, or only content, is still accepted', async () => {
  handlers = [
    [/SELECT id FROM users WHERE id = \$1/, () => ({ rows: [{ id: 42 }], rowCount: 1 })],
    [/SELECT id, status, created_at FROM content_reports/, () => ({ rows: [] })],
    [/INSERT INTO content_reports/, () => ({ rows: [{ id: 1, status: 'open', created_at: 'now' }], rowCount: 1 })],
  ];
  const onlyUser = await call('POST', '/api/reports', {
    content_type: 'profile', reported_user_id: 42, reason: 'harassment',
  });
  assert.strictEqual(onlyUser.status, 201, onlyUser.text);

  handlers = [
    [/FROM guest_rsvps gr/, () => ({ rows: [{ sender_id: null, is_hidden: false }], rowCount: 1 })],
    [/SELECT id, status, created_at FROM content_reports/, () => ({ rows: [] })],
    [/INSERT INTO content_reports/, () => ({ rows: [{ id: 2, status: 'open', created_at: 'now' }], rowCount: 1 })],
  ];
  log = [];
  const onlyContent = await call('POST', '/api/reports', {
    content_type: 'guest_rsvp', content_id: 55, reason: 'hate',
  });
  assert.strictEqual(onlyContent.status, 201, onlyContent.text);
  assert.strictEqual(ran(/INSERT INTO content_reports/).length, 1,
    'a guest RSVP has no account behind it; the guard must not have made this unreportable');
});
