// Run: node --test  (from backend/)
//
// ROUND 21 — THE MODERATION CONSOLE'S EVIDENCE, AND THE GATE IN FRONT OF IT.
//
// Three things are pinned here, and all three fail silently in production:
//
//   1. CONTENT A USER CAN REPORT THAT A MODERATOR CANNOT READ. The queue built
//      its excerpt from one column per content type, and for two types that is
//      not where the words are. A venue card keeps its name, address and
//      category in `venue_data` (JSONB) — three strings that utils/venuePayload.js
//      clamps and profanity-screens and otherwise takes verbatim from the
//      sender, because nothing on the server checks a place_id against Google.
//      A venue review's `venue_reply` is the owner's public answer, rendered
//      under the review by the same screen, and there is no separate report type
//      for it, so reporting the review IS how a user reports the reply. Both
//      arrived at the moderator as somebody else's words, or as "No text on this
//      item."
//
//   2. NO WAY TO READ PAST THE EXCERPT. 280 characters is the right size for a
//      200-row list and the wrong size for judging a 5,000-character message.
//      GET /reports/:id/content is the text twin of the existing per-report
//      image endpoint: same admin gate, same serialId rule, same no-store, same
//      hasOwnProperty-guarded map.
//
//   3. THE ADMIN GATE ITSELF. Before this file, `grep -rn "Admin access
//      required" __tests__/` returned NOTHING: deleting `router.use(requireAdmin)`
//      from routes/admin.js broke no test, on the router that hides content,
//      bans accounts and reads the audit log. The sweep below walks
//      adminRouter.stack, so a route added tomorrow is covered without anyone
//      remembering to add a case.
//
// Plus the object-authorization rotation this router had never had run against
// it: id parameters that reach Postgres out of range, caller-supplied keys that
// walk the prototype chain, list queries with no ceiling, and — the one that
// turned out to matter most — a ban that can permanently close the console.
//
// NOT tested here, on purpose: the SQL semantics of the excerpt expressions.
// A scripted pg fake cannot tell you whether `venue_data->>'name'` returns
// anything, so those were verified against a REAL Postgres (the repo's
// embedded-postgres dev dependency, migrations 000-019 applied, throwaway
// script outside the repo). What IS pinned here is that the route asks for
// them at all, which is the half that rots.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

process.env.JWT_SECRET = 'admin-evidence-test-secret';

const pool = require('../config/database');

// ---------------------------------------------------------------------------
// Harness — scripted pg fake + fake io on one timeline (same shape as
// __tests__/unhidePath.test.js, so the two read alike).
// ---------------------------------------------------------------------------
let handlers = [];
let log = [];
let emitted = [];
let disconnected = [];

function dispatch(sql, params) {
  log.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
  for (const [re, fn] of handlers) {
    if (re.test(sql)) {
      const out = fn(params || [], String(sql));
      return Promise.resolve(out === undefined ? { rows: [], rowCount: 0 } : out);
    }
  }
  return Promise.reject(new Error(`unscripted query: ${String(sql).replace(/\s+/g, ' ').slice(0, 200)}`));
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
  to: () => ({ emit: (event, payload) => emitted.push({ event, payload }) }),
  in: (room) => ({ disconnectSockets: () => disconnected.push(room) }),
};

// Patched BEFORE the router is required: admin.js destructures `authenticate`
// at require time and mounts it with router.use.
const authMod = require('../middleware/auth');
let CURRENT_USER = { id: 9, name: 'Mod', role: 'admin' };
authMod.authenticate = (req, _res, next) => { req.user = CURRENT_USER; next(); };

const adminRouter = require('../routes/admin');
const { CONTENT_TEXT_SQL, REPORT_TEXT_SOURCES, REPORT_IMAGE_SOURCES, FULL_TEXT_MAX } = adminRouter.__test;

const app = express();
app.use(express.json());
app.set('io', fakeIo);
app.use('/api/admin', adminRouter);

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
  disconnected = [];
  CURRENT_USER = { id: 9, name: 'Mod', role: 'admin' };
});

async function call(method, p, body, headers) {
  const res = await fetch(base + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(headers || {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, body: json, text, headers: res.headers };
}

const ran = (re) => log.filter((q) => re.test(q.sql));
const timeline = () => log.map((q) => q.sql);

const ADMIN_SRC = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin.js'), 'utf8');
const MODERATION_SRC = fs.readFileSync(path.join(__dirname, '..', 'routes', 'moderation.js'), 'utf8');

// The authoritative list of what a user may report, read from the file that
// owns it rather than copied (the copy is how every previous drift started).
const VALID_CONTENT_TYPES = (() => {
  const m = /const VALID_CONTENT_TYPES = \[([^\]]*)\]/.exec(MODERATION_SRC);
  assert.ok(m, 'VALID_CONTENT_TYPES not found in routes/moderation.js');
  const types = [...m[1].matchAll(/'([^']+)'/g)].map((q) => q[1]);
  assert.ok(types.length >= 8, `parsed only ${types.length} content types; the parser is wrong, not the code`);
  return types;
})();

function reportRow(contentType, over = {}) {
  return {
    id: 7,
    reporter_id: 1,
    reported_user_id: 3,
    content_type: contentType,
    content_id: 55,
    reason: 'harassment',
    status: 'open',
    ...over,
  };
}

const reportLookup = (row) => [/SELECT \* FROM content_reports WHERE id/, () => ({ rows: row ? [row] : [], rowCount: row ? 1 : 0 })];
const reportMeta = (row) => [/SELECT id, content_type, content_id, reported_user_id FROM content_reports/, () => ({ rows: row ? [row] : [], rowCount: row ? 1 : 0 })];
const resolveAndAudit = [
  [/UPDATE content_reports SET status/, () => ({ rows: [], rowCount: 1 })],
  [/INSERT INTO moderation_actions/, () => ({ rows: [{ id: 1 }], rowCount: 1 })],
];

// ===========================================================================
// PART 1 — content a user can report that a moderator cannot read
// ===========================================================================

test('every reportable content type has an excerpt expression', () => {
  // The enumeration itself. A type a user may report and the queue cannot
  // render is a report that arrives describing nothing, which is the exact
  // Guideline 1.2 shape this whole area keeps producing: reportable first,
  // renderable several rounds later (venue_review, guest_rsvp, venue_event).
  for (const type of VALID_CONTENT_TYPES) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(CONTENT_TEXT_SQL, type),
      `CONTENT_TEXT_SQL has no entry for "${type}", so GET /api/admin/reports renders that report as "No text on this item." and a moderator is asked to hide or ban on the reporter's word alone.`
    );
    assert.strictEqual(typeof CONTENT_TEXT_SQL[type], 'function', `CONTENT_TEXT_SQL.${type} must be an alias -> SQL function`);
    const sql = CONTENT_TEXT_SQL[type]('t');
    assert.ok(sql.includes('t.'), `CONTENT_TEXT_SQL.${type} ignores the alias it was given`);
  }
  // And nothing extra: an entry with no report type behind it is a column
  // nobody can reach, which is how you end up believing a surface is covered.
  for (const type of Object.keys(CONTENT_TEXT_SQL)) {
    assert.ok(VALID_CONTENT_TYPES.includes(type), `CONTENT_TEXT_SQL.${type} names a type routes/moderation.js will not accept`);
  }
});

test('the queue asks for the venue card, not just the message text', async () => {
  // THE ROUTED FINDING. A venue card's name/addr/category are stored in
  // venue_data, screened for profanity and otherwise taken verbatim from the
  // sender — the server never resolves a place_id against Google, so "venue
  // name" is a 256-character free-text field that renders as the card title on
  // every recipient's screen. A client that sends a bland message_text
  // alongside an abusive card was invisible to the moderator.
  handlers = [
    [/FROM content_reports r/, () => ({ rows: [] })],
    [/SELECT status, COUNT/, () => ({ rows: [] })],
  ];
  const res = await call('GET', '/api/admin/reports');
  assert.strictEqual(res.status, 200);

  const sql = ran(/FROM content_reports r/)[0].sql;
  for (const key of ['name', 'addr', 'category']) {
    assert.ok(
      sql.includes(`m.venue_data->>'${key}'`),
      `the flock_message excerpt no longer reads venue_data->>'${key}'; a reported venue card renders as "No text on this item."`
    );
    assert.ok(
      sql.includes(`d.venue_data->>'${key}'`),
      `the dm excerpt no longer reads venue_data->>'${key}'; a reported DM venue card renders as "No text on this item."`
    );
  }
  assert.ok(sql.includes('m.message_text'), 'the ordinary message text must still be in the excerpt');
  assert.ok(sql.includes('d.message_text'), 'the ordinary DM text must still be in the excerpt');
});

test('the queue asks for the venue owner\'s reply, not only the review it answers', async () => {
  // Same class, found while enumerating. venue_reviews.venue_reply is
  // owner-typed public UGC (1000 chars, routes/venueDashboard.js) rendered
  // under the review — and there is no 'venue_review_reply' content type, so
  // reporting the review is the ONLY way to report the reply. The queue showed
  // vr.text: the moderator read the reviewer's words while judging a complaint
  // about the owner's.
  handlers = [
    [/FROM content_reports r/, () => ({ rows: [] })],
    [/SELECT status, COUNT/, () => ({ rows: [] })],
  ];
  await call('GET', '/api/admin/reports');
  const sql = ran(/FROM content_reports r/)[0].sql;
  assert.ok(sql.includes('vr.venue_reply'), 'a report about an abusive venue reply shows the moderator the review instead');
  assert.ok(sql.includes('vr.text'), 'the review body must still be in the excerpt');
});

test('the queue reads every public column of a promotion and an event, not the headline one', async () => {
  // Found on the third pass, same class as the two above. GET
  // /public-promotions serves title, description, time_slot AND days to every
  // user who opens the venue card (routes/venueDashboard.js screens all four
  // for profanity precisely because all four are published) — the queue showed
  // the first two. venue_events was worse: rejectIfProfane ran on `title` alone,
  // leaving event_date and event_time — 40 characters each of owner-typed text —
  // through no screen at all. Round 22 closed that; both the events POST and PUT
  // screen all three strings now. The queue must still READ all three, because a
  // wordlist catches slurs and does not catch "text me at 555-0100".
  handlers = [
    [/FROM content_reports r/, () => ({ rows: [] })],
    [/SELECT status, COUNT/, () => ({ rows: [] })],
  ];
  await call('GET', '/api/admin/reports');
  const sql = ran(/FROM content_reports r/)[0].sql;
  for (const col of ['vp.title', 'vp.description', 'vp.time_slot', 'vp.days']) {
    assert.ok(sql.includes(col), `the promotion excerpt no longer reads ${col}, which is served publicly`);
  }
  for (const col of ['ve.title', 've.event_date', 've.event_time']) {
    assert.ok(sql.includes(col), `the venue event excerpt no longer reads ${col}`);
  }
});

test('the excerpt and the full text come from ONE definition', () => {
  // The queue's LATERAL and the detail endpoint used to be two hand-written
  // renderings of the same rows, which is the shape every drift in this file
  // has taken. Both interpolate CONTENT_TEXT_SQL now, so they cannot disagree.
  for (const type of VALID_CONTENT_TYPES) {
    const expr = CONTENT_TEXT_SQL[type];
    // Whatever alias the queue used, the distinctive column names must appear
    // in the file exactly once per reader.
    const probe = expr('ZZ').replace(/ZZ\./g, '');
    for (const col of [...probe.matchAll(/\b(message_text|venue_reply|caption|title|description|interests)\b/g)].map((m) => m[1])) {
      assert.ok(ADMIN_SRC.includes(col), `${col} vanished from routes/admin.js`);
    }
  }
  assert.ok(
    /CONTENT_TEXT_SQL\.flock_message\('m'\)/.test(ADMIN_SRC),
    'the queue no longer builds its excerpt from CONTENT_TEXT_SQL; the list and the detail endpoint can drift again'
  );
  assert.ok(
    /bodySql\('t'\)/.test(ADMIN_SRC),
    'the detail endpoint no longer builds its text from CONTENT_TEXT_SQL'
  );
});

// ===========================================================================
// PART 2 — reading past the excerpt
// ===========================================================================

// The fake dispatches on the RAW sql (newlines and all), so the matcher spans
// lines rather than assuming the collapsed form the log keeps.
const textSource = (table, body = 'the whole message', over = {}) => [
  new RegExp(`AS total_length[\\s\\S]*FROM ${table} t WHERE`),
  () => ({ rows: [{ body, clipped: false, total_length: body ? body.length : 0, ...over }], rowCount: 1 }),
];

test('GET /reports/:id/content serves the text the 280-character excerpt cut off', async () => {
  const long = 'A'.repeat(300) + 'THE-ACTUAL-THREAT';
  handlers = [reportMeta({ id: 7, content_type: 'flock_message', content_id: 55, reported_user_id: 3 }), textSource('messages', long)];
  const res = await call('GET', '/api/admin/reports/7/content');
  assert.strictEqual(res.status, 200);
  assert.match(res.body.text, /THE-ACTUAL-THREAT/, 'the part of the message past 280 characters is the part being reported');
  assert.strictEqual(res.body.totalLength, long.length);
  assert.strictEqual(res.body.clipped, false);
  assert.strictEqual(res.body.contentType, 'flock_message');
  assert.strictEqual(res.body.reportId, 7);
});

test('the reported text is never cached by a proxy or a browser', async () => {
  handlers = [reportMeta({ id: 7, content_type: 'dm', content_id: 55, reported_user_id: 3 }), textSource('direct_messages')];
  const res = await call('GET', '/api/admin/reports/7/content');
  assert.strictEqual(res.status, 200);
  assert.match(res.headers.get('cache-control') || '', /no-store/,
    'reported UGC, sometimes written by a minor, must not sit in a cache — same rule as the image endpoint');
});

test('every reportable type can be opened in full, and each reads its own table', async () => {
  // Type by type, mechanically. A type present in the excerpt map but absent
  // from the source map is a report a moderator can half-read.
  for (const type of VALID_CONTENT_TYPES) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(REPORT_TEXT_SOURCES, type),
      `REPORT_TEXT_SOURCES has no entry for "${type}"; the console can show 280 characters of it and never the rest.`
    );
    const src = REPORT_TEXT_SOURCES[type];
    const keyed = src.keyedOn === 'reported_user_id';
    handlers = [
      reportMeta({ id: 7, content_type: type, content_id: keyed ? null : 55, reported_user_id: 3 }),
      textSource(src.table, `full ${type} text`),
    ];
    log = [];
    const res = await call('GET', '/api/admin/reports/7/content');
    assert.strictEqual(res.status, 200, `${type}: ${res.text}`);
    assert.strictEqual(res.body.text, `full ${type} text`, type);
    const q = ran(new RegExp(`FROM ${src.table} t WHERE`));
    assert.strictEqual(q.length, 1, `${type} did not read ${src.table}`);
    assert.deepStrictEqual(q[0].params, [keyed ? 3 : 55], `${type} keyed off the wrong column`);
  }
});

test('the served text is bounded — one row is still an attacker-sized column', async () => {
  // venue_reviews.text is an uncapped TEXT column any signed-in user can write
  // to. "Serve whatever is in there" makes the response size somebody else's
  // decision; `clipped` says so rather than trailing off silently.
  assert.strictEqual(typeof FULL_TEXT_MAX, 'number');
  assert.ok(FULL_TEXT_MAX >= 5000, 'must exceed the longest text any write path accepts (5000)');
  handlers = [
    reportMeta({ id: 7, content_type: 'venue_review', content_id: 55, reported_user_id: 3 }),
    textSource('venue_reviews', 'x'.repeat(FULL_TEXT_MAX), { clipped: true, total_length: 999999 }),
  ];
  const res = await call('GET', '/api/admin/reports/7/content');
  assert.strictEqual(res.body.clipped, true);
  assert.strictEqual(res.body.totalLength, 999999);
  assert.ok(ran(/AS total_length FROM venue_reviews t/)[0].sql.includes('LEFT('), 'the body must be clipped in SQL, not after transfer');
});

test('an empty body is "no text", a missing row is "no longer exists", and neither is a 500', async () => {
  handlers = [reportMeta({ id: 7, content_type: 'story', content_id: 55, reported_user_id: 3 }), textSource('stories', null)];
  let res = await call('GET', '/api/admin/reports/7/content');
  assert.strictEqual(res.status, 404);
  assert.match(res.body.error, /no text/i);

  handlers = [
    reportMeta({ id: 7, content_type: 'story', content_id: 55, reported_user_id: 3 }),
    [/AS total_length[\s\S]*FROM stories t WHERE/, () => ({ rows: [], rowCount: 0 })],
  ];
  res = await call('GET', '/api/admin/reports/7/content');
  assert.strictEqual(res.status, 404);
  assert.match(res.body.error, /no longer exists/i, 'a deleted row must name the action still available (dismiss), not read as a broken console');
});

test('a profile report with no reported user, and an unknown report, are 404 without touching a content table', async () => {
  handlers = [reportMeta({ id: 7, content_type: 'profile', content_id: null, reported_user_id: null })];
  let res = await call('GET', '/api/admin/reports/7/content');
  assert.strictEqual(res.status, 404);
  assert.strictEqual(ran(/FROM users t WHERE/).length, 0, 'a null key must never reach the query');

  handlers = [reportMeta(null)];
  res = await call('GET', '/api/admin/reports/7/content');
  assert.strictEqual(res.status, 404);
  assert.match(res.body.error, /Report not found/);
});

// ===========================================================================
// PART 3 — the admin gate
// ===========================================================================

// Every route the router actually exposes, discovered rather than listed, so a
// route added tomorrow is swept without anyone remembering to add it here.
function routeTable() {
  const out = [];
  for (const layer of adminRouter.stack) {
    if (!layer.route) continue;
    for (const method of Object.keys(layer.route.methods)) {
      if (!layer.route.methods[method]) continue;
      out.push({ method: method.toUpperCase(), path: layer.route.path });
    }
  }
  return out;
}

// Bodies that get each route PAST its own body validation, so the sweep below
// is testing the gate and the id rule rather than a 400 that happens first.
const VALID_BODY = {
  'PUT /reports/:id': { action: 'dismiss' },
  'POST /venues/:userId/tier': { tier: 'free' },
  'PUT /venues/:profileId/verify': { verified: true },
};

const concrete = (p) => p.replace(/:[A-Za-z0-9_]+/g, '1');

test('requireAdmin is mounted, and mounted BEFORE the first route', () => {
  // Structural half. `router.use(requireAdmin)` sitting after a route
  // definition would gate everything below it and nothing above — the kind of
  // edit a behavioural test catches only for the routes that already exist.
  const names = adminRouter.stack.map((l) => (l.route ? '<route>' : (l.handle && l.handle.name) || '<anon>'));
  const guard = names.indexOf('requireAdmin');
  assert.notStrictEqual(guard, -1, 'router.use(requireAdmin) is gone from routes/admin.js. Everything on this router — takedowns, bans, the audit log, every user\'s email on /venues/unverified — is now open to any signed-in account.');
  const firstRoute = names.indexOf('<route>');
  assert.ok(guard < firstRoute, 'requireAdmin is mounted after a route, so that route is ungated');
});

test('EVERY admin route refuses a non-admin with 403, and refuses it before any query', async () => {
  // The behavioural half, and the one that was missing entirely: before this
  // file, no test in the suite asserted "Admin access required" at all, so
  // deleting the guard failed nothing.
  const routes = routeTable();
  assert.ok(routes.length >= 8, `only found ${routes.length} admin routes; the stack walk is wrong`);

  for (const role of ['user', 'venue_owner', undefined, null, 'Admin', 'ADMIN']) {
    for (const { method, path: p } of routes) {
      CURRENT_USER = { id: 42, name: 'Nosy', role };
      handlers = [];   // ANY query is a failure: the gate must run first
      log = [];
      const res = await call(method, '/api/admin' + concrete(p), VALID_BODY[`${method} ${p}`]);
      assert.strictEqual(res.status, 403, `${method} ${p} answered ${res.status} for role=${String(role)}: ${res.text}`);
      assert.strictEqual(res.body.error, 'Admin access required', `${method} ${p}`);
      assert.deepStrictEqual(log, [], `${method} ${p} queried the database before checking the role`);
    }
  }
});

test('a request that reached the router with no user at all is refused, not crashed', async () => {
  // requireAdmin reads a property off req.user. Mounted before authenticate —
  // or on a router whose authenticate was moved — that is a TypeError and a
  // 500, and a gate that fails by CRASHING is a gate nobody notices has
  // stopped gating. Same doctrine as requireVerified in middleware/auth.js.
  CURRENT_USER = undefined;
  handlers = [];
  const res = await call('GET', '/api/admin/reports');
  assert.strictEqual(res.status, 403, 'a missing user must be a refusal, not a 500');
  assert.deepStrictEqual(log, []);
});

// ===========================================================================
// PART 4 — ids that reach Postgres out of range
// ===========================================================================

test('every id parameter is settled before the query, for every route that takes one', async () => {
  // users.id, content_reports.id and venue_profiles.id are all int4. An id
  // Postgres answers with 22003 lands in the route's catch as a 500, and on the
  // moderation queue a 500 is indistinguishable from "the takedown failed" —
  // the one thing a moderator must never be unsure about.
  const OUT_OF_RANGE = '99999999999';
  const bad = [OUT_OF_RANGE, 'abc', '12abc', '1.5', '-1', '0', '', ' 1', '1%20', 'NaN', '0x10', '1e3'];
  const routes = routeTable().filter((r) => /:/.test(r.path));
  assert.ok(routes.length >= 4, `only found ${routes.length} parameterised admin routes`);

  for (const { method, path: p } of routes) {
    for (const raw of bad) {
      // Anything the route DOES reach the database for is answered emptily, so
      // the only way to a 500 is the id itself.
      handlers = [[/.*/, () => ({ rows: [], rowCount: 0 })]];
      log = [];
      const url = '/api/admin' + p.replace(/:[A-Za-z0-9_]+/g, encodeURIComponent(raw));
      const res = await call(method, url, VALID_BODY[`${method} ${p}`]);
      assert.notStrictEqual(res.status, 500, `${method} ${p} with id "${raw}" answered 500: ${res.text}`);
      for (const q of log) {
        for (const param of q.params || []) {
          assert.ok(
            !(typeof param === 'number' && (param > 2147483647 || Number.isNaN(param))),
            `${method} ${p} sent ${param} to Postgres from id "${raw}"`
          );
          assert.notStrictEqual(param, raw, `${method} ${p} passed the raw id "${raw}" straight through`);
        }
      }
    }
  }
});

test('serialId is what settles them — not a second, drifting copy of the rule', () => {
  // Four routes take an id and all four must go through the one helper. A
  // hand-rolled parseInt on a fifth is how the last one got missed.
  const paramRoutes = routeTable().filter((r) => /:/.test(r.path));
  const calls = (ADMIN_SRC.match(/serialId\(req\.params\./g) || []).length;
  assert.ok(
    calls >= paramRoutes.length,
    `${paramRoutes.length} admin routes take an id parameter but only ${calls} call serialId(req.params.…)`
  );
  assert.ok(!/parseInt\(req\.params\./.test(ADMIN_SRC), 'a raw parseInt on a route parameter bypasses the int4 ceiling');
});

// ===========================================================================
// PART 5 — caller-supplied keys reaching the prototype chain
// ===========================================================================

const PROTO_KEYS = ['constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable'];

test('a content_type from the prototype chain refuses cleanly on all three maps', async () => {
  // The CHECK constraint on content_reports makes these unreachable TODAY.
  // 003, 016 and 017 are three separate occasions on which route code widened
  // a value set and the constraint behind it did not, so "unreachable today" is
  // exactly the assumption this codebase has broken three times.
  for (const key of PROTO_KEYS) {
    // (a) the takedown map
    handlers = [reportLookup(reportRow(key)), ...resolveAndAudit];
    log = [];
    let res = await call('PUT', '/api/admin/reports/7', { action: 'hide' });
    assert.strictEqual(res.status, 400, `hide with content_type "${key}": ${res.text}`);
    assert.strictEqual(ran(/UPDATE undefined|UPDATE function|SET is_hidden/).length, 0, `hide "${key}" built a query from the prototype chain`);
    assert.strictEqual(ran(/INSERT INTO moderation_actions/).length, 0, `hide "${key}" wrote an audit row for work nobody did`);
    assert.ok(timeline().includes('ROLLBACK'), `hide "${key}" did not roll back`);

    // (b) the image map
    handlers = [reportMeta({ id: 7, content_type: key, content_id: 55, reported_user_id: 3 })];
    log = [];
    res = await call('GET', '/api/admin/reports/7/image');
    assert.strictEqual(res.status, 404, `image with content_type "${key}"`);
    assert.strictEqual(log.length, 1, `image "${key}" ran a second query`);

    // (c) the text map, new in this round
    handlers = [reportMeta({ id: 7, content_type: key, content_id: 55, reported_user_id: 3 })];
    log = [];
    res = await call('GET', '/api/admin/reports/7/content');
    assert.strictEqual(res.status, 404, `content with content_type "${key}"`);
    assert.strictEqual(log.length, 1, `content "${key}" ran a second query`);
  }
});

test('all three maps are read with hasOwnProperty, and none of them is a bare lookup', () => {
  const bare = [
    /TAKEDOWN_TARGETS\[report\.content_type\]\s*;/,
    /REPORT_IMAGE_SOURCES\[report\.content_type\]\s*;/,
    /REPORT_TEXT_SOURCES\[report\.content_type\]\s*;/,
    /CONTENT_TEXT_SQL\[report\.content_type\]\s*;/,
  ];
  for (const re of bare) {
    assert.ok(!re.test(ADMIN_SRC), `a bare lookup (${re}) answers 'constructor' from the prototype chain with a truthy value`);
  }
  assert.ok(
    (ADMIN_SRC.match(/Object\.prototype\.hasOwnProperty\.call/g) || []).length >= 3,
    'fewer hasOwnProperty guards than maps keyed on a request value'
  );
  // Every map keyed on content_type must reject inherited keys at runtime too,
  // not only by inspection.
  for (const map of [REPORT_TEXT_SOURCES, REPORT_IMAGE_SOURCES, CONTENT_TEXT_SQL]) {
    for (const key of PROTO_KEYS) {
      assert.ok(!Object.prototype.hasOwnProperty.call(map, key), `a map has a real "${key}" entry, which defeats the guard`);
    }
  }
});

// ===========================================================================
// PART 6 — list queries with no ceiling
// ===========================================================================

test('every admin list query carries a LIMIT', async () => {
  // One row, not none: the analytics route reads .rows[0] off its aggregates.
  handlers = [[/.*/, () => ({ rows: [{}], rowCount: 1 })]];

  const cases = [
    ['GET', '/api/admin/reports', [/FROM content_reports r/]],
    ['GET', '/api/admin/venues/unverified', [/FROM venue_profiles vp/]],
    ['GET', '/api/admin/moderation-actions', [/FROM moderation_actions ma/]],
    // The one that had none. stall_point is server-chosen from five words
    // TODAY — by routes/flocks.js, a different file, which is precisely the
    // arrangement that has drifted four times in this repo.
    ['GET', '/api/admin/analytics', [/GROUP BY stall_point/]],
  ];
  for (const [method, p, matchers] of cases) {
    log = [];
    const res = await call(method, p);
    assert.strictEqual(res.status, 200, `${p}: ${res.text}`);
    for (const re of matchers) {
      const q = ran(re);
      assert.strictEqual(q.length, 1, `${p}: expected one query matching ${re}`);
      assert.match(q[0].sql, /LIMIT \d+/, `${p}: ${re} has no LIMIT, so its response size is set by the row count`);
    }
  }
});

test('the blocked-accounts list is bounded too, and says when it was cut', async () => {
  // routes/moderation.js. Nothing caps how many accounts one user may block —
  // POST /blocks/:userId has no per-user quota the way POST /reports does — so
  // this row count, and the response size with it, was the caller's to choose.
  assert.match(MODERATION_SRC, /LIMIT \$2/, 'GET /api/blocks lost its ceiling');
  assert.match(MODERATION_SRC, /BLOCK_LIST_LIMIT/, 'the ceiling is no longer a named constant');
  assert.match(MODERATION_SRC, /truncated/, 'a list silently showing 500 of 900 is worse than one that says so');
});

// ===========================================================================
// PART 7 — the audit log, and who can write or read it
// ===========================================================================

test('the audit log can only be read by an admin, and it is the whole router that says so', async () => {
  // Covered mechanically by the sweep in PART 3; asserted here by name because
  // this is the record of who banned whom and why.
  CURRENT_USER = { id: 42, name: 'Nosy', role: 'user' };
  handlers = [];
  const res = await call('GET', '/api/admin/moderation-actions');
  assert.strictEqual(res.status, 403);
  assert.deepStrictEqual(log, [], 'the audit log was queried before the role was checked');
});

test('nothing outside routes/admin.js inserts a moderation_actions row', () => {
  // The audit log is only trustworthy if the admin router is the only author.
  // routes/users.js touches the table (it NULLs target_user_id when an account
  // deletes itself, so a ban survives its subject) and must not write one.
  const dir = path.join(__dirname, '..');
  const offenders = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '__tests__' || entry.name.startsWith('.')) continue;
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.js')) continue;
      const src = fs.readFileSync(full, 'utf8');
      if (/INSERT\s+INTO\s+moderation_actions/i.test(src) && full !== path.join(dir, 'routes', 'admin.js')) {
        offenders.push(path.relative(dir, full));
      }
    }
  };
  walk(dir);
  assert.deepStrictEqual(offenders, [], `these files write the moderation audit log from outside the admin router: ${offenders.join(', ')}`);
});

test('an action that performed nothing writes no audit row and resolves no report', async () => {
  // A profile report has no row to hide. The route used to answer "Action
  // applied", resolve the report, and record content_hidden for work nobody
  // did — an audit log that lies is worse than none.
  handlers = [reportLookup(reportRow('profile', { content_id: null })), ...resolveAndAudit];
  const res = await call('PUT', '/api/admin/reports/7', { action: 'hide' });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(ran(/INSERT INTO moderation_actions/).length, 0);
  assert.strictEqual(ran(/UPDATE content_reports SET status/).length, 0);
  assert.ok(timeline().includes('ROLLBACK'));
});

test('the moderator who acted is recorded from the session, never from the body', async () => {
  handlers = [
    reportLookup(reportRow('flock_message')),
    [/UPDATE messages SET is_hidden/, () => ({ rows: [{ flock_id: 8, notify_a: null, notify_b: null }], rowCount: 1 })],
    ...resolveAndAudit,
  ];
  const res = await call('PUT', '/api/admin/reports/7', {
    action: 'hide', reason: 'harassment', moderator_id: 1, handled_by: 1, report_id: 999,
  });
  assert.strictEqual(res.status, 200);
  const audit = ran(/INSERT INTO moderation_actions/)[0];
  assert.strictEqual(audit.params[0], 7, 'report_id must come from the URL');
  assert.strictEqual(audit.params[1], 9, 'moderator_id must come from req.user');
  assert.strictEqual(audit.params[6], 'harassment');
  assert.strictEqual(ran(/UPDATE content_reports SET status/)[0].params[1], 9, 'handled_by must come from req.user');
});

test('an audit reason is text or it is refused, never quietly converted', async () => {
  // node-postgres does not reject a non-string for a TEXT parameter, it
  // CONVERTS one: ["harassment"] lands as the array literal {harassment} and an
  // object as its JSON. The permanent record of why an account was banned would
  // read as neither what was sent nor what was meant.
  for (const reason of [['harassment'], { a: 1 }, 5, true, { toString: 1 }]) {
    handlers = [reportLookup(reportRow('flock_message')), ...resolveAndAudit];
    log = [];
    const res = await call('PUT', '/api/admin/reports/7', { action: 'dismiss', reason });
    assert.strictEqual(res.status, 400, `reason ${JSON.stringify(reason)} was accepted: ${res.text}`);
    assert.strictEqual(res.body.error, 'reason must be text');
    assert.deepStrictEqual(log, [], 'a refused body must not open a transaction');
  }

  handlers = [reportLookup(reportRow('flock_message')), ...resolveAndAudit];
  log = [];
  let res = await call('PUT', '/api/admin/reports/7', { action: 'dismiss', reason: 'x'.repeat(1001) });
  assert.strictEqual(res.status, 400);
  assert.match(res.body.error, /too long/);

  // The boundary, and absence, both still work.
  handlers = [reportLookup(reportRow('flock_message')), ...resolveAndAudit];
  res = await call('PUT', '/api/admin/reports/7', { action: 'dismiss', reason: 'x'.repeat(1000) });
  assert.strictEqual(res.status, 200);
  handlers = [reportLookup(reportRow('flock_message')), ...resolveAndAudit];
  log = [];
  res = await call('PUT', '/api/admin/reports/7', { action: 'dismiss' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(ran(/INSERT INTO moderation_actions/)[0].params[6], null);
});

test('a request with no parseable body is a 400, not a 500', async () => {
  // A behaviour pin, and NOT a proof of the `|| {}` in the route: body-parser
  // assigns req.body before it decides whether to parse, so under
  // express.json() every shape below already arrives as {}. What this does pin
  // is that an unparseable body is answered as a refusal with no query behind
  // it, on the route where a 500 reads as "the takedown failed" — the one
  // answer a moderator must never be unsure about.
  handlers = [];
  let res = await fetch(base + '/api/admin/reports/7', { method: 'PUT' });
  assert.strictEqual(res.status, 400, 'empty body');
  assert.deepStrictEqual(log, []);

  for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'application/octet-stream']) {
    log = [];
    res = await fetch(base + '/api/admin/reports/7', {
      method: 'PUT',
      headers: { 'Content-Type': type },
      body: 'action=hide',
    });
    assert.strictEqual(res.status, 400, `${type} answered ${res.status}, not a refusal`);
    assert.deepStrictEqual(log, [], `${type} reached the database`);
  }
});

// ===========================================================================
// PART 8 — a moderator acting on a moderator, or on themselves
// ===========================================================================

const banHandlers = (targetRole, targetExists = true) => [
  reportLookup(reportRow('profile', { content_id: null, reported_user_id: 3 })),
  [/UPDATE users SET is_banned = true/, (_p, sql) => ({
    rows: [],
    // The route's own WHERE decides, read off the SQL it actually sent rather
    // than assumed: delete the role predicate from the statement and this fake
    // stops refusing, which is what makes the assertions below go red instead
    // of passing against a guard that is no longer there.
    rowCount: targetExists && !(/<> 'admin'/.test(sql) && targetRole === 'admin') ? 1 : 0,
  })],
  [/SELECT id, role FROM users WHERE id/, () => ({ rows: targetExists ? [{ id: 3, role: targetRole }] : [], rowCount: targetExists ? 1 : 0 })],
  ...resolveAndAudit,
];

test('a moderator cannot ban their own account out of the console', async () => {
  // middleware/auth.js refuses a banned account with 403 BEFORE requireAdmin
  // runs, and server.js only ever GRANTS role='admin' — it never clears
  // is_banned. So this click removes that account's access to the only
  // moderation surface the product has, permanently, recoverable only from a
  // psql prompt against production. With one admin (and today ADMIN_USER_IDS is
  // unset, so there are none) it removes the Guideline 1.2 control entirely.
  CURRENT_USER = { id: 3, name: 'Mod', role: 'admin' };
  handlers = banHandlers('admin');
  const res = await call('PUT', '/api/admin/reports/7', { action: 'ban' });
  assert.strictEqual(res.status, 403, res.text);
  assert.match(res.body.error, /your own moderator account/i);
  assert.strictEqual(ran(/INSERT INTO moderation_actions/).length, 0);
  assert.strictEqual(ran(/UPDATE content_reports SET status/).length, 0);
  assert.ok(timeline().includes('ROLLBACK'));
  assert.deepStrictEqual(disconnected, [], 'a refused ban must not disconnect anybody');
});

test('a moderator cannot ban another moderator out of the console either', async () => {
  handlers = banHandlers('admin');
  const res = await call('PUT', '/api/admin/reports/7', { action: 'ban' });
  assert.strictEqual(res.status, 403, res.text);
  assert.match(res.body.error, /moderator/i);
  assert.match(res.body.error, /admin role/i, 'the refusal must name the thing that actually works (deployment config), not a dead end');
  assert.ok(timeline().includes('ROLLBACK'));
});

test('the refusal is carried by the UPDATE\'s own WHERE, not by a check that can race it', async () => {
  handlers = banHandlers('admin');
  await call('PUT', '/api/admin/reports/7', { action: 'ban' });
  const upd = ran(/UPDATE users SET is_banned = true/)[0];
  assert.match(upd.sql, /role/, 'the role guard left the ban statement; a separate SELECT reopens a check-then-act window');
  // And the extra read only happens on the refusal path.
  handlers = banHandlers('user');
  log = [];
  const ok = await call('PUT', '/api/admin/reports/7', { action: 'ban' });
  assert.strictEqual(ok.status, 200, ok.text);
  assert.strictEqual(ran(/SELECT id, role FROM users WHERE id/).length, 0, 'the success path must not pay for a second round trip');
});

test('banning an ordinary account still works, still audits, still disconnects', async () => {
  handlers = banHandlers('user');
  const res = await call('PUT', '/api/admin/reports/7', { action: 'ban' });
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(res.body.action, 'user_banned');
  assert.strictEqual(ran(/INSERT INTO moderation_actions/)[0].params[3], 'user_banned');
  assert.deepStrictEqual(disconnected, ['user:3']);
  assert.ok(timeline().includes('COMMIT'));
});

test('a ban naming an account that is gone is still "no longer exists", not "that is a moderator"', async () => {
  handlers = banHandlers('user', false);
  const res = await call('PUT', '/api/admin/reports/7', { action: 'ban' });
  assert.strictEqual(res.status, 404, res.text);
  assert.match(res.body.error, /no longer exists/i);
  assert.ok(timeline().includes('ROLLBACK'));
});

test('UN-banning is never blocked — it is the recovery direction', async () => {
  // Guarding the un-ban would make a mistaken ban unrecoverable, which is the
  // failure this whole guard exists to prevent.
  handlers = [
    reportLookup(reportRow('profile', { content_id: null, reported_user_id: 3 })),
    [/UPDATE users SET is_banned = false/, () => ({ rows: [], rowCount: 1 })],
    ...resolveAndAudit,
  ];
  const res = await call('PUT', '/api/admin/reports/7', { action: 'unban' });
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(res.body.action, 'user_unbanned');
  assert.strictEqual(ran(/SELECT id, role FROM users WHERE id/).length, 0);
});

test('hiding a moderator\'s own content IS allowed, deliberately', async () => {
  // The asymmetry is the point. A takedown is reversible (un-hide, round 18),
  // audited, and locks nobody out; a ban on an admin is none of those things.
  // Refusing self-takedowns on a one-moderator deployment would mean the only
  // person who can act cannot act on the flock they are in.
  CURRENT_USER = { id: 3, name: 'Mod', role: 'admin' };
  handlers = [
    reportLookup(reportRow('flock_message', { reported_user_id: 3 })),
    [/UPDATE messages SET is_hidden/, () => ({ rows: [{ flock_id: 8, notify_a: null, notify_b: null }], rowCount: 1 })],
    ...resolveAndAudit,
  ];
  const res = await call('PUT', '/api/admin/reports/7', { action: 'hide' });
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(res.body.action, 'content_hidden');
});
