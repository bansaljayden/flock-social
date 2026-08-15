// Run: node --test  (from backend/)
//
// TWO PROPERTIES FROM THE 2026-08-14 AUDIT, PINNED TOGETHER BECAUSE BOTH ARE
// "a window or a filter silently decided what an admin/user never sees":
//
//   1. AN OPEN REPORT IS ALWAYS REACHABLE BY THE CONSOLE. The queue used to
//      cut open-first/newest-first at a bare LIMIT 200, so the rows that fell
//      off were the OLDEST open reports — the backlog that most needs review.
//      Now unhandled work (open + under_review) sorts oldest-first, limit and
//      offset are real request parameters with hard ceilings, and hasMore is
//      measured by fetching one row past the window. This file proves the
//      arithmetic end to end: a paged walk over a fixed dataset serves every
//      row exactly once, and the report that has waited longest is row one of
//      page one under the default call the console actually makes.
//
//   2. venue_profiles.photo_url CANNOT NAME A FOREIGN HOST. The dashboard
//      renders it as <img src>, and the PUT used to accept any https URL. The
//      only photo source this app mints is its own Places photo proxy
//      (/api/venues/photo?...), so that is the whole allowlist —
//      utils/venuePayload.safeVenuePhotoUrl, the same helper that clamps
//      venue-card and DM-pin photos. Direct maps.googleapis.com /
//      googleusercontent URLs are rejected too, deliberately: no code path in
//      this app ever hands a client one (routes/venues.js rewrites Places
//      photo references into the proxy path before they leave the server), so
//      a raw Google URL in this column could only have been typed by hand.
//      Absolute spellings that CONTAIN the proxy path are re-anchored to the
//      relative form, so even a hostile prefix host is never stored.
//
// Plus one response-shape fact the console depends on: both admin GET lists
// serve the `reason` columns (content_reports.reason on the queue via r.*,
// moderation_actions.reason on the audit log via ma.*), so a projection that
// strips either breaks this file before it breaks the console.
//
// Harness: scripted pg fake, same shape as adminQueuePagination.test.js.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

process.env.JWT_SECRET = 'admin-window-photo-hosts-test-secret';

const pool = require('../config/database');

let handlers = [];
let log = [];

function dispatch(sql, params) {
  const flat = String(sql).replace(/\s+/g, ' ').trim();
  log.push({ sql: flat, params });
  for (const [re, fn] of handlers) {
    if (re.test(flat)) {
      const out = fn(params || [], flat);
      return Promise.resolve(out === undefined ? { rows: [], rowCount: 0 } : out);
    }
  }
  return Promise.reject(new Error(`unscripted query: ${flat.slice(0, 160)}`));
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

// Patched BEFORE the routers are required: both destructure `authenticate` at
// require time and mount it with router.use.
const authMod = require('../middleware/auth');
let CURRENT_USER = { id: 9, name: 'Mod', role: 'admin' };
authMod.authenticate = (req, _res, next) => { req.user = CURRENT_USER; next(); };

const adminRouter = require('../routes/admin');
const venueProfileRouter = require('../routes/venueProfile');
const { QUEUE_LIMIT_DEFAULT, QUEUE_LIMIT_MAX } = adminRouter.__test;

const app = express();
app.use(express.json());
app.set('io', { to: () => ({ emit: () => {} }), in: () => ({ disconnectSockets: () => {} }) });
app.use('/api/admin', adminRouter);
app.use('/api/venue-profile', venueProfileRouter);

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
  CURRENT_USER = { id: 9, name: 'Mod', role: 'admin' };
});

async function call(method, p, body) {
  const res = await fetch(base + p, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, body: json, text };
}

const ran = (re) => log.filter((q) => re.test(q.sql));

const ADMIN_SRC = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin.js'), 'utf8');
const VENUE_PROFILE_SRC = fs.readFileSync(path.join(__dirname, '..', 'routes', 'venueProfile.js'), 'utf8');

// A fake that honours the LIMIT/OFFSET the route wrote into the SQL, over a
// dataset held in the order the pinned ORDER BY would return it (unhandled
// oldest-first). Everything past the window arithmetic is therefore the
// route's own doing: the +1 probe row, the slice, hasMore, the response shape.
function pagedHandlers(dataset) {
  return [
    [/FROM content_reports r/, (_params, sql) => {
      const m = /LIMIT (\d+) OFFSET (\d+)/.exec(sql);
      assert.ok(m, 'the reports query lost its LIMIT/OFFSET literals');
      const rows = dataset.slice(Number(m[2]), Number(m[2]) + Number(m[1]));
      return { rows, rowCount: rows.length };
    }],
    [/SELECT status, COUNT/, () => ({ rows: [{ status: 'open', count: dataset.length }] })],
  ];
}

const openRows = (n) => Array.from({ length: n }, (_, i) => ({
  id: i + 1,
  status: 'open',
  reason: 'spam',
  created_at: new Date(1700000000000 + i * 60000).toISOString(),
}));

// ===========================================================================
// 1. An open report is always reachable by the console
// ===========================================================================

test('unhandled work is one bucket, oldest-first, with a deterministic tiebreak', async () => {
  handlers = pagedHandlers([]);
  const res = await call('GET', '/api/admin/reports');
  assert.strictEqual(res.status, 200, res.text);
  const sql = ran(/FROM content_reports r/)[0].sql;
  const order = sql.slice(sql.indexOf('ORDER BY'));
  assert.match(order, /\(r\.status IN \('open', 'under_review'\)\) DESC/,
    'open and under_review no longer outrank handled work');
  assert.match(order, /CASE WHEN r\.status IN \('open', 'under_review'\) THEN r\.created_at END ASC/,
    'unhandled work is not oldest-first; the longest-waiting report can fall off the window again');
  assert.match(order, /r\.id ASC/, 'no deterministic tiebreak; paging can duplicate or drop a same-second row');
});

test('a paged offset walk serves every open report exactly once', async () => {
  const dataset = openRows(25);
  handlers = pagedHandlers(dataset);
  const seen = [];
  const expectMore = [true, true, false];
  for (let page = 0; page < 3; page++) {
    log = [];
    const res = await call('GET', `/api/admin/reports?limit=10&offset=${page * 10}`);
    assert.strictEqual(res.status, 200, res.text);
    assert.strictEqual(res.body.hasMore, expectMore[page], `page ${page} hasMore`);
    for (const r of res.body.reports) seen.push(r.id);
  }
  assert.deepStrictEqual(seen, dataset.map((r) => r.id),
    'the three pages together must be the whole queue, in order, with no row served twice and none dropped');
});

test('when open reports outgrow the default window, the invisible rows are the NEWEST, and one more page reaches them', async () => {
  // The inverted failure this whole change exists to prevent: before, the rows
  // past the window were the oldest. Now the oldest is row one of page one,
  // hasMore says plainly that the window was not the whole queue, and the next
  // offset serves the remainder.
  const dataset = openRows(QUEUE_LIMIT_DEFAULT + 5);
  handlers = pagedHandlers(dataset);

  const first = await call('GET', '/api/admin/reports');
  assert.strictEqual(first.status, 200, first.text);
  assert.strictEqual(first.body.hasMore, true);
  assert.strictEqual(first.body.reports.length, QUEUE_LIMIT_DEFAULT);
  assert.strictEqual(first.body.reports[0].id, 1,
    'the longest-waiting open report must be row one of the default call');
  assert.strictEqual(first.body.reports.at(-1).id, QUEUE_LIMIT_DEFAULT,
    'the rows past the window must be the newest arrivals, never the backlog');

  const rest = await call('GET', `/api/admin/reports?offset=${QUEUE_LIMIT_DEFAULT}`);
  assert.strictEqual(rest.status, 200, rest.text);
  assert.strictEqual(rest.body.hasMore, false);
  assert.deepStrictEqual(rest.body.reports.map((r) => r.id),
    [201, 202, 203, 204, 205].map((n) => n + QUEUE_LIMIT_DEFAULT - 200),
    'the second page must be exactly the rows the first page could not carry');
});

test('the console\'s growing-limit strategy also reaches everything', async () => {
  // ModerationDashboard.js does not use offset: it re-asks with a larger
  // limit. Same property, other parameterization.
  const dataset = openRows(QUEUE_LIMIT_DEFAULT + 5);
  handlers = pagedHandlers(dataset);
  const widened = await call('GET', `/api/admin/reports?limit=${QUEUE_LIMIT_DEFAULT + 5}`);
  assert.strictEqual(widened.status, 200, widened.text);
  assert.strictEqual(widened.body.hasMore, false);
  assert.strictEqual(widened.body.reports.length, dataset.length);
});

test('hostile limit/offset strings die at validation, before any SQL text exists', async () => {
  // limit and offset are interpolated as literals (the adminEvidence
  // LIMIT-visibility pin is why they are not bound), so this refusal is the
  // injection boundary.
  for (const p of ['limit=1;DROP TABLE users', 'offset=1 OFFSET 0--', 'limit=1e3', `limit=${QUEUE_LIMIT_MAX + 1}`, 'limit=0', 'offset=-1']) {
    handlers = [];
    log = [];
    const res = await call('GET', `/api/admin/reports?${encodeURI(p)}`);
    assert.strictEqual(res.status, 400, `${p} answered ${res.status}: ${res.text}`);
    assert.deepStrictEqual(log, [], `${p} reached the database`);
  }
});

test('the response stays backward compatible: reports + counts, additions only', async () => {
  handlers = pagedHandlers(openRows(2));
  const res = await call('GET', '/api/admin/reports');
  assert.ok(Array.isArray(res.body.reports), 'reports array gone; the console breaks');
  assert.ok(Array.isArray(res.body.counts), 'counts array gone; the queue header breaks');
  assert.strictEqual(typeof res.body.hasMore, 'boolean');
  assert.strictEqual(typeof res.body.limit, 'number');
  assert.strictEqual(typeof res.body.offset, 'number');
});

// ===========================================================================
// 2. The queue and the audit log both serve their reason columns
// ===========================================================================

test('the queue serves content_reports.reason (r.* passthrough, not a projection)', async () => {
  handlers = pagedHandlers(openRows(1));
  const res = await call('GET', '/api/admin/reports');
  assert.strictEqual(res.body.reports[0].reason, 'spam',
    'GET /api/admin/reports no longer passes the report row through; the console cannot say why a report was filed');
  assert.match(ran(/FROM content_reports r/)[0].sql, /SELECT r\.\*/,
    'the queue stopped selecting r.*; every column the console reads is now an explicit dependency');
});

test('the audit log serves moderation_actions.reason (ma.* passthrough)', async () => {
  handlers = [
    [/FROM moderation_actions ma/, () => ({
      rows: [{ id: 1, action: 'user_banned', reason: 'repeat harassment, third report', moderator_name: 'Mod', target_user_name: 'X' }],
    })],
  ];
  const res = await call('GET', '/api/admin/moderation-actions');
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(res.body.actions[0].reason, 'repeat harassment, third report',
    'GET /api/admin/moderation-actions dropped the reason; the audit log cannot say why an action was taken');
  assert.match(ran(/FROM moderation_actions ma/)[0].sql, /SELECT ma\.\*/);
});

// ===========================================================================
// 3. photo_url host allowlist: only what this app mints may be stored
// ===========================================================================

const venueUpdateHandlers = () => [
  [/UPDATE venue_profiles SET/, (params) => ({
    rows: [{ id: 1, user_id: CURRENT_USER.id, photo_url: params[9] }],
    rowCount: 1,
  })],
];

test('the one minted shape is accepted and stored verbatim', async () => {
  handlers = venueUpdateHandlers();
  const res = await call('PUT', '/api/venue-profile', { photoUrl: '/api/venues/photo?ref=abc123&maxwidth=400' });
  assert.strictEqual(res.status, 200, res.text);
  const upd = ran(/UPDATE venue_profiles SET/);
  assert.strictEqual(upd.length, 1);
  assert.strictEqual(upd[0].params[9], '/api/venues/photo?ref=abc123&maxwidth=400');
});

test('an absolute spelling that contains the proxy path is re-anchored, so a hostile prefix host is never stored', async () => {
  // This is the deliberate normalization, not a bypass: whatever host the
  // sender wrote, the stored value is the RELATIVE proxy path, so the image
  // request goes to our own origin and the foreign host receives nothing.
  for (const spelling of [
    'https://flock-backend.example.railway.app/api/venues/photo?ref=abc',
    'https://evil.example.com/api/venues/photo?ref=abc',
    'http://evil.example.com/api/venues/photo?ref=abc',
    // A host spelled to LOOK like the path ("https://api/venues/photo?...")
    // also lands here: the path anchor wins and the fake host is discarded.
    'https://api/venues/photo?ref=abc',
  ]) {
    handlers = venueUpdateHandlers();
    log = [];
    const res = await call('PUT', '/api/venue-profile', { photoUrl: spelling });
    assert.strictEqual(res.status, 200, `${spelling}: ${res.text}`);
    assert.strictEqual(ran(/UPDATE venue_profiles SET/)[0].params[9], '/api/venues/photo?ref=abc',
      `${spelling} was stored with its own host instead of re-anchored to the proxy`);
  }
});

test('every foreign host and every downgrade is a 400 that names the rule, with no write', async () => {
  const hostile = [
    'https://evil.example.com/logo.png',            // arbitrary https host
    'http://evil.example.com/logo.png',             // http downgrade
    '//evil.example.com/logo.png',                  // protocol-relative
    'https://maps.googleapis.com/maps/api/place/photo?photoreference=x', // real Google host — the app never mints this, only the proxy path
    'https://lh3.googleusercontent.com/places/photo123',                 // ditto
    'https://maps.googleapis.com.evil.example.com/photo?x=1',            // subdomain suffix trick
    'https://maps-googleapis.com/photo?x=1',                             // lookalike domain
    'https://maps.googleapis.com@evil.example.com/photo?x=1',            // userinfo trick
    'javascript:alert(1)',                          // scheme smuggle
    'data:image/png;base64,AAAA',                   // cannot be told from an unmoderated raw data URL
    '/uploads/logo.png',                            // the dead disk store
    '/api/venues/photo',                            // proxy path with no query is nothing the app mints
    '/api/venues/photo?ref=abc#@evil.example.com',  // fragment/userinfo chars in the query
    '/api/venues/photo?ref=abc&next=/../secret',    // path chars in the query
    '/api/venues/photo?ref=a b',                    // whitespace in the query
  ];
  for (const photoUrl of hostile) {
    handlers = [];
    log = [];
    const res = await call('PUT', '/api/venue-profile', { photoUrl });
    assert.strictEqual(res.status, 400, `${photoUrl} answered ${res.status}: ${res.text}`);
    assert.match(res.body.error, /\/api\/venues\/photo/,
      `${photoUrl}: the refusal must name the rule so the dashboard can say what a photo URL has to be`);
    assert.deepStrictEqual(ran(/UPDATE venue_profiles/), [], `${photoUrl} reached the database`);
  }
});

test('the userinfo spelling of the proxy host cannot smuggle a foreign query through', async () => {
  // https://ourhost@evil.com/api/venues/photo?... still contains the proxy
  // path, so it re-anchors — the evil host is discarded, not honoured.
  handlers = venueUpdateHandlers();
  const res = await call('PUT', '/api/venue-profile', {
    photoUrl: 'https://flockcorp.com@evil.example.com/api/venues/photo?ref=abc',
  });
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(ran(/UPDATE venue_profiles SET/)[0].params[9], '/api/venues/photo?ref=abc');
});

test('empty string still means "leave the photo alone"', async () => {
  handlers = venueUpdateHandlers();
  const res = await call('PUT', '/api/venue-profile', { photoUrl: '' });
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(ran(/UPDATE venue_profiles SET/)[0].params[9], null,
    'an empty photoUrl must become NULL so COALESCE keeps the stored value');
});

test('the create path takes no photo at all, so there is no second, unguarded writer', async () => {
  // POST /api/venue-profile never accepted photoUrl; prove a smuggled one is
  // ignored rather than stored, and pin the absence in the source so a future
  // INSERT column has to come back through this file.
  handlers = [
    [/UPDATE users SET role/, () => ({ rows: [], rowCount: 1 })],
    [/INSERT INTO venue_profiles/, (params) => ({ rows: [{ id: 1, business_name: params[1] }], rowCount: 1 })],
  ];
  const res = await call('POST', '/api/venue-profile', {
    businessName: 'The Nest',
    photoUrl: 'https://evil.example.com/logo.png',
  });
  assert.strictEqual(res.status, 201, res.text);
  const ins = ran(/INSERT INTO venue_profiles/)[0];
  assert.ok(!ins.sql.includes('photo_url'), 'the create path grew a photo_url column without the allowlist');
  assert.ok(!ins.params.some((p) => typeof p === 'string' && p.includes('evil.example.com')),
    'a smuggled photoUrl reached the INSERT parameters');
});

test('structural pins: one shared allowlist helper, and the stored value never comes from the raw body', () => {
  // The decision lives in utils/venuePayload.safeVenuePhotoUrl — the SAME
  // helper that clamps venue-card and DM-pin photos — so "which photo URLs do
  // we vouch for" keeps one definition across the app.
  assert.match(VENUE_PROFILE_SRC, /require\('\.\.\/utils\/venuePayload'\)/,
    'venueProfile.js no longer imports the shared photo allowlist');
  assert.match(VENUE_PROFILE_SRC, /photoUrl \? safeVenuePhotoUrl\(photoUrl\) : null/,
    'the UPDATE no longer stores the normalized value; the raw request string can reach the column');
  // And the helper itself keeps the properties the hostile list above relies
  // on: nothing but the proxy path survives, in a closed query charset.
  const helperSrc = fs.readFileSync(path.join(__dirname, '..', 'utils', 'venuePayload.js'), 'utf8');
  assert.match(helperSrc, /\/api\/venues\/photo\?/, 'the proxy path anchor left safeVenuePhotoUrl');
  assert.match(helperSrc, /A-Za-z0-9=&%\._~-/, 'the query charset allowlist left safeVenuePhotoUrl');
  // The admin queue text pin from the same audit: no request value is ever
  // interpolated into admin SQL.
  assert.ok(!/\$\{req\.(query|params|body)/.test(ADMIN_SRC),
    'a request value is interpolated into SQL somewhere in routes/admin.js');
});
