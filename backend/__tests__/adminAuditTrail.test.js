// Run: node --test  (from backend/)
//
// ROUND 23 — THE AUDIT TRAIL'S THREE BLIND SPOTS.
//
// The moderation queue writes an audit row for every takedown, inside the same
// transaction as the takedown (round 11). Around that well-lit path there were
// three dark ones, and every one of them fails silently:
//
//   1. AN OWNER COULD DESTROY EVIDENCE. DELETE /venue-dashboard/promotions/:id
//      and /events/:id had no report predicate at all, so the author of
//      reported content — the one person with a motive — could erase the row a
//      moderator had been asked to judge. Hide preserved the evidence; delete
//      destroyed it. routes/stories.js solved this exact problem for story
//      deletion: the refusal is a predicate INSIDE the delete (no
//      check-then-act window), and the author gets a retirement that looks
//      exactly like a delete, because naming the open report tips off the one
//      person who would sanitize the evidence. The venue routes now match
//      those semantics via owner_deleted_at (migration 020), and this file
//      pins the two status lists to stories.js so they cannot drift apart.
//
//   2. TWO ADMIN POWERS WROTE NO AUDIT ROW. PUT /venues/:profileId/verify
//      flips who may speak as a business and recorded nothing in either
//      direction. POST /venues/:userId/tier is the only server-side writer of
//      venue_profiles.tier — the whole manual billing control — and it took a
//      `reason` and threw it into console.log, which Railway rotates away.
//      Both write moderation_actions rows now, in the SAME STATEMENT as the
//      mutation (a data-modifying CTE reading FROM upd), so the record and the
//      change land together or not at all, with no second round trip.
//
//   3. EVIDENCE ACCESS WAS UNRECORDED. GET /reports/:id/image and /content
//      serve reported UGC in full — deliberately unfiltered on is_hidden, and
//      sometimes from a minor's camera roll (the route's own words). Nothing
//      distinguished a moderator who opened one report from one who enumerated
//      the queue. Each successful serve now writes an 'evidence_viewed' row
//      BEFORE the response (a failed write is a failed read, so the record
//      cannot be skipped), and the default audit-log list excludes those rows
//      so access records do not drown the decisions; ?include_evidence=true
//      serves them.
//
// All three write new moderation_actions.action values, which is the exact
// constraint-drift 003, 016 and 017 shipped: route widened, CHECK not.
// Migration 020 carries the widening and this file diffs the two, the same way
// unhidePath.test.js pins 017.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

process.env.JWT_SECRET = 'admin-audit-trail-test-secret';
delete process.env.VENUE_BILLING_ENABLED;

const pool = require('../config/database');

// ---------------------------------------------------------------------------
// Harness: scripted pg fake on one timeline (same shape as unhidePath.test.js;
// a handler may return an Error to model a failing statement, as
// venueTierGate.test.js does).
// ---------------------------------------------------------------------------
let handlers = [];
let log = [];

function dispatch(sql, params) {
  log.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
  for (const [re, fn] of handlers) {
    if (re.test(String(sql).replace(/\s+/g, ' '))) {
      const out = fn(params || [], String(sql));
      if (out instanceof Error) return Promise.reject(out);
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
  to: () => ({ emit: () => {} }),
  in: () => ({ disconnectSockets: () => {} }),
};

// Patched BEFORE the routers are required: both destructure `authenticate` at
// require time and mount it with router.use.
const authMod = require('../middleware/auth');
const MOD = { id: 9, name: 'Mod', role: 'admin' };
const OWNER = { id: 2, name: 'Ava', role: 'venue_owner' };
let CURRENT_USER = MOD;
authMod.authenticate = (req, _res, next) => { req.user = CURRENT_USER; next(); };

const adminRouter = require('../routes/admin');
const venueDashboardRouter = require('../routes/venueDashboard');

const app = express();
app.use(express.json());
app.set('io', fakeIo);
app.use('/api/admin', adminRouter);
app.use('/api/venue-dashboard', venueDashboardRouter);

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
  CURRENT_USER = MOD;
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

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');
const MIGRATION_020 = path.join(MIGRATIONS_DIR, '020_admin_audit_and_evidence.sql');
const ADMIN_SRC = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin.js'), 'utf8');
const DASHBOARD_SRC = fs.readFileSync(path.join(__dirname, '..', 'routes', 'venueDashboard.js'), 'utf8');
const STORIES_SRC = fs.readFileSync(path.join(__dirname, '..', 'routes', 'stories.js'), 'utf8');

function constraintValuesIn(file) {
  const sql = fs.readFileSync(file, 'utf8');
  const body = sql.slice(sql.indexOf('ADD CONSTRAINT moderation_actions_action_check'));
  const check = body.slice(body.indexOf('CHECK'));
  return new Set([...check.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]));
}

const NEW_ACTIONS = ['venue_verified', 'venue_unverified', 'tier_changed', 'evidence_viewed'];

// ===========================================================================
// A. Migration 020 — the constraint the route changes cannot ship without
// ===========================================================================

test('020 exists and is the only migration claiming that number', () => {
  assert.ok(fs.existsSync(MIGRATION_020), 'migration 020 must exist');
  const twenties = fs.readdirSync(MIGRATIONS_DIR).filter((f) => /^020[_.]/.test(f));
  assert.deepStrictEqual(twenties, ['020_admin_audit_and_evidence.sql'],
    'exactly one 020, and 018/019 are not renumbered');
});

test('020 is a strict superset of 017 plus the four new actions', () => {
  const seventeen = constraintValuesIn(path.join(MIGRATIONS_DIR, '017_moderation_action_content_restored.sql'));
  const twenty = constraintValuesIn(MIGRATION_020);
  for (const kept of seventeen) {
    assert.ok(twenty.has(kept), `020 dropped '${kept}', which historic rows may hold — the ADD CONSTRAINT would fail validation in production`);
  }
  for (const added of NEW_ACTIONS) {
    assert.ok(twenty.has(added), `020 does not allow '${added}'; the route that writes it dies as a 23514`);
  }
});

test('020 drops the old constraint before re-adding it, and does not swallow its own failure', () => {
  const sql = fs.readFileSync(MIGRATION_020, 'utf8');
  assert.match(sql, /DROP CONSTRAINT IF EXISTS moderation_actions_action_check/);
  assert.ok(sql.indexOf('DROP CONSTRAINT IF EXISTS moderation_actions_action_check')
    < sql.indexOf('ADD CONSTRAINT moderation_actions_action_check'),
  'ADD before DROP leaves the 017 constraint in place');
  const noComments = sql.replace(/^\s*--.*$/gm, '');
  assert.ok(!/EXCEPTION\s+WHEN/i.test(noComments),
    'a swallowed ALTER is indistinguishable from a working one — 017 spells out why');
});

test('020 gives both venue tables the owner_deleted_at retirement column', () => {
  const sql = fs.readFileSync(MIGRATION_020, 'utf8');
  assert.match(sql, /ALTER TABLE venue_promotions ADD COLUMN IF NOT EXISTS owner_deleted_at TIMESTAMPTZ/);
  assert.match(sql, /ALTER TABLE venue_events ADD COLUMN IF NOT EXISTS owner_deleted_at TIMESTAMPTZ/);
});

test('DRIFT GUARD: every new action value is written by admin.js and allowed by 020, both directions', () => {
  const twenty = constraintValuesIn(MIGRATION_020);
  for (const action of NEW_ACTIONS) {
    assert.ok(ADMIN_SRC.includes(`'${action}'`),
      `020 allows '${action}' but routes/admin.js never writes it — a constraint entry nobody uses is how coverage gets believed, not had`);
    assert.ok(twenty.has(action),
      `routes/admin.js writes '${action}' and 020 forbids it — the 003/016/017 drift again`);
  }
  // The audit log stays single-author: venueDashboard.js gained writes in this
  // round and none of them may touch moderation_actions (unhidePath.test.js
  // scrapes only admin.js, so a second writer would dodge that guard).
  assert.ok(!/INSERT\s+INTO\s+moderation_actions/i.test(DASHBOARD_SRC),
    'routes/venueDashboard.js writes the moderation audit log');
});

// ===========================================================================
// B. Venue verification writes an audit row — in the same statement
// ===========================================================================

const verifyReturns = (row) => [/UPDATE venue_profiles SET verified/, () => ({ rows: row ? [row] : [] })];
const VERIFIED_ROW = { id: 7, business_name: 'The Bar', verified: true, google_place_id: 'PLACE_A', conflict_user_id: null };

test('verifying a venue audits venue_verified, from the session, atomically', async () => {
  handlers = [verifyReturns(VERIFIED_ROW)];
  const res = await call('PUT', '/api/admin/venues/7/verify', { verified: true });
  assert.strictEqual(res.status, 200, res.text);
  assert.deepStrictEqual(res.body, { id: 7, business_name: 'The Bar', verified: true });

  assert.strictEqual(log.length, 1, 'the mutation and its audit row must be ONE statement — a second query is a window in which one lands without the other');
  const sql = log[0].sql;
  assert.match(sql, /INSERT INTO moderation_actions/, 'PUT /venues/:profileId/verify flips who may speak as a business and records nothing');
  assert.match(sql, /'venue_verified'/, 'the audit action for the grant direction');
  assert.match(sql, /'venue_unverified'/, 'the audit action for the revoke direction');
  assert.match(sql, /INSERT INTO moderation_actions[\s\S]*FROM upd/,
    'the audit CTE must read FROM upd, so a refused or missing profile writes no row');
  assert.strictEqual(log[0].params[2], MOD.id, 'the moderator is recorded from the session, never the body');
});

test('un-verifying still works and both directions share the one statement', async () => {
  handlers = [verifyReturns({ ...VERIFIED_ROW, verified: false })];
  const res = await call('PUT', '/api/admin/venues/7/verify', { verified: false });
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(res.body.verified, false);
  assert.strictEqual(log[0].params[0], false);
  assert.match(log[0].sql, /CASE WHEN \$1::boolean THEN 'venue_verified' ELSE 'venue_unverified' END/,
    'the action is derived from the same bound boolean as the write, so the record cannot say the opposite of what happened');
});

test('the verify reason is optional, bound, and refused when it is not text', async () => {
  handlers = [verifyReturns(VERIFIED_ROW)];
  let res = await call('PUT', '/api/admin/venues/7/verify', { verified: true, reason: 'LLC docs checked' });
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(log[0].params[3], 'LLC docs checked');

  handlers = [verifyReturns(VERIFIED_ROW)];
  log = [];
  res = await call('PUT', '/api/admin/venues/7/verify', { verified: true });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(log[0].params[3], null, 'no reason is NULL, not the string "undefined"');

  for (const bad of [['x'], { a: 1 }, 5, true]) {
    handlers = [verifyReturns(VERIFIED_ROW)];
    log = [];
    res = await call('PUT', '/api/admin/venues/7/verify', { verified: true, reason: bad });
    assert.strictEqual(res.status, 400, `reason ${JSON.stringify(bad)} was accepted`);
    assert.strictEqual(res.body.error, 'reason must be text');
    assert.deepStrictEqual(log, [], 'a refused body must not reach the database');
  }

  handlers = [verifyReturns(VERIFIED_ROW)];
  log = [];
  res = await call('PUT', '/api/admin/venues/7/verify', { verified: true, reason: 'x'.repeat(1001) });
  assert.strictEqual(res.status, 400);
  assert.match(res.body.error, /too long/);
});

test('a refused verify (conflict) and a missing profile keep their answers', async () => {
  handlers = [verifyReturns({ id: null, business_name: null, verified: null, google_place_id: 'PLACE_A', conflict_user_id: 42 })];
  let res = await call('PUT', '/api/admin/venues/7/verify', { verified: true });
  assert.strictEqual(res.status, 409);
  assert.strictEqual(res.body.code, 'PLACE_ALREADY_VERIFIED');

  handlers = [verifyReturns(null)];
  res = await call('PUT', '/api/admin/venues/7/verify', { verified: true });
  assert.strictEqual(res.status, 404);
});

// ===========================================================================
// C. The tier change writes an audit row — the manual billing control
// ===========================================================================

const tierReturns = (row) => [/UPDATE venue_profiles SET tier/, () => ({ rows: row ? [row] : [], rowCount: row ? 1 : 0 })];
const TIER_ROW = { id: 7, business_name: 'The Bar', tier: 'premium' };

test('a tier change audits tier_changed with the transition, atomically', async () => {
  handlers = [tierReturns(TIER_ROW)];
  const res = await call('POST', '/api/admin/venues/2/tier', { tier: 'premium', reason: 'hand-sold, 6mo comp' });
  assert.strictEqual(res.status, 200, res.text);
  assert.deepStrictEqual(res.body, TIER_ROW);

  assert.strictEqual(log.length, 1, 'the tier write and its audit row must be ONE statement');
  const sql = log[0].sql;
  assert.match(sql, /INSERT INTO moderation_actions/,
    'POST /venues/:userId/tier is the only writer of venue_profiles.tier and its reason went to console.log, which Railway rotates away');
  assert.match(sql, /'tier_changed'/);
  assert.match(sql, /old\.tier AS old_tier/,
    'the OLD tier is captured in the same statement, so the audit row records a transition and not just that something changed');
  assert.match(sql, /INSERT INTO moderation_actions[\s\S]*FROM upd/,
    'the audit CTE must read FROM upd, so a missing profile writes no row');
  assert.strictEqual(log[0].params[2], MOD.id, 'the moderator is recorded from the session');
  assert.strictEqual(log[0].params[3], 'hand-sold, 6mo comp', 'the reason is a bound parameter in the durable record, not a log line');
});

test('the tier reason is validated like every other audit reason', async () => {
  for (const bad of [['x'], { a: 1 }, 5, true]) {
    handlers = [tierReturns(TIER_ROW)];
    log = [];
    const res = await call('POST', '/api/admin/venues/2/tier', { tier: 'premium', reason: bad });
    assert.strictEqual(res.status, 400, `reason ${JSON.stringify(bad)} was accepted: ${res.text}`);
    assert.strictEqual(res.body.error, 'reason must be text');
    assert.deepStrictEqual(log, [], 'a refused body must not reach the database');
  }
  handlers = [tierReturns(TIER_ROW)];
  log = [];
  const long = await call('POST', '/api/admin/venues/2/tier', { tier: 'premium', reason: 'x'.repeat(1001) });
  assert.strictEqual(long.status, 400);
  assert.match(long.body.error, /too long/);

  // No reason still works — the transition itself is always recorded.
  handlers = [tierReturns(TIER_ROW)];
  log = [];
  const bare = await call('POST', '/api/admin/venues/2/tier', { tier: 'premium' });
  assert.strictEqual(bare.status, 200, bare.text);
  assert.strictEqual(log[0].params[3], null);
});

test('a missing venue profile is still 404, and an invalid tier is still 400', async () => {
  handlers = [tierReturns(null)];
  let res = await call('POST', '/api/admin/venues/2/tier', { tier: 'premium' });
  assert.strictEqual(res.status, 404);

  handlers = [];
  log = [];
  res = await call('POST', '/api/admin/venues/2/tier', { tier: 'platinum' });
  assert.strictEqual(res.status, 400);
  assert.deepStrictEqual(log, []);
});

// ===========================================================================
// D. Evidence access is recorded — before the bytes leave the building
// ===========================================================================

const reportMeta = (row) => [/SELECT id, content_type, content_id, reported_user_id FROM content_reports/,
  () => ({ rows: row ? [row] : [], rowCount: row ? 1 : 0 })];
const auditInsert = () => [/INSERT INTO moderation_actions/, () => ({ rows: [{ id: 1 }], rowCount: 1 })];

test('serving a reported image writes an evidence_viewed row first', async () => {
  handlers = [
    reportMeta({ id: 7, content_type: 'story', content_id: 55, reported_user_id: 3 }),
    [/SELECT image_url AS image_url FROM stories/, () => ({ rows: [{ image_url: 'data:image/png;base64,AAAA' }], rowCount: 1 })],
    auditInsert(),
  ];
  const res = await call('GET', '/api/admin/reports/7/image');
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(res.body.imageUrl, 'data:image/png;base64,AAAA');

  const audit = ran(/INSERT INTO moderation_actions/);
  assert.strictEqual(audit.length, 1,
    'the image endpoint serves reported UGC, sometimes from a minor\'s camera roll, and nothing recorded the access');
  assert.match(audit[0].sql, /'evidence_viewed'/);
  assert.match(audit[0].sql, /'image'/, 'the record says WHICH half was read');
  assert.deepStrictEqual(audit[0].params, [7, MOD.id, 'story', 55],
    'report id, the moderator from the session, and the content coordinates');
});

test('serving the full text writes an evidence_viewed row too', async () => {
  handlers = [
    reportMeta({ id: 7, content_type: 'venue_review', content_id: 55, reported_user_id: 3 }),
    [/AS total_length[\s\S]*FROM venue_reviews t WHERE/, () => ({ rows: [{ body: 'the whole review', clipped: false, total_length: 16 }], rowCount: 1 })],
    auditInsert(),
  ];
  const res = await call('GET', '/api/admin/reports/7/content');
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(res.body.text, 'the whole review');
  const audit = ran(/INSERT INTO moderation_actions/);
  assert.strictEqual(audit.length, 1);
  assert.match(audit[0].sql, /'evidence_viewed'/);
  assert.match(audit[0].sql, /'full text'/);
  assert.deepStrictEqual(audit[0].params, [7, MOD.id, 'venue_review', 55]);
});

test('a failed access record is a failed access — the evidence is not served', async () => {
  // Fail closed. Written BEFORE the response on purpose: an access log that
  // fails open records nothing exactly when the database is flaky, which is
  // when you least know who read what.
  handlers = [
    reportMeta({ id: 7, content_type: 'story', content_id: 55, reported_user_id: 3 }),
    [/SELECT image_url AS image_url FROM stories/, () => ({ rows: [{ image_url: 'data:image/png;base64,SECRET' }], rowCount: 1 })],
    [/INSERT INTO moderation_actions/, () => Object.assign(new Error('constraint violation'), { code: '23514' })],
  ];
  const res = await call('GET', '/api/admin/reports/7/image');
  assert.strictEqual(res.status, 500);
  assert.ok(!res.text.includes('SECRET'), 'an unrecorded serve leaked the image anyway');
});

test('refusals record nothing — only a serve is an access', async () => {
  // No image on the report, the row gone, an unmapped type, a bad id: none of
  // these handed evidence to anybody, so none of them writes a row. (The
  // access record exists to answer "who READ this", not "who knocked".)
  const cases = [
    [reportMeta({ id: 7, content_type: 'venue_review', content_id: 55, reported_user_id: 3 })],  // text-only type on /image
    [reportMeta({ id: 7, content_type: 'story', content_id: 55, reported_user_id: 3 }),
      [/SELECT image_url AS image_url FROM stories/, () => ({ rows: [], rowCount: 0 })]],        // row gone
    [reportMeta(null)],                                                                          // report gone
  ];
  for (const hs of cases) {
    handlers = hs;
    log = [];
    const res = await call('GET', '/api/admin/reports/7/image');
    assert.strictEqual(res.status, 404);
    assert.strictEqual(ran(/INSERT INTO moderation_actions/).length, 0, 'a refusal wrote an access row');
  }
  handlers = [];
  log = [];
  const res = await call('GET', '/api/admin/reports/abc/image');
  assert.strictEqual(res.status, 404);
  assert.deepStrictEqual(log, []);
});

test('the audit-log list excludes access records by default and can include them by name', async () => {
  handlers = [[/FROM moderation_actions ma/, () => ({ rows: [], rowCount: 0 })]];
  let res = await call('GET', '/api/admin/moderation-actions');
  assert.strictEqual(res.status, 200);
  let q = ran(/FROM moderation_actions ma/)[0];
  assert.match(q.sql, /\$1::boolean OR ma.action <> 'evidence_viewed'/,
    'two rows per opened report would drown the LIMIT-200 list a moderator reads for decisions');
  assert.strictEqual(q.params[0], false);
  assert.match(q.sql, /LIMIT \d+/);

  handlers = [[/FROM moderation_actions ma/, () => ({ rows: [], rowCount: 0 })]];
  log = [];
  res = await call('GET', '/api/admin/moderation-actions?include_evidence=true');
  assert.strictEqual(res.status, 200);
  q = ran(/FROM moderation_actions ma/)[0];
  assert.strictEqual(q.params[0], true, 'the rows are readable on request, not only from a psql prompt');
});

// ===========================================================================
// E. The owner's delete can no longer destroy evidence
// ===========================================================================

// What the fake returns for the guarded DELETE decides the scenario:
//   rows include the target id  -> no open report, the hard delete happened
//   rows empty                  -> the evidence guard held (or no such row)
const promoDelete = (rows) => [/DELETE FROM venue_promotions/, () => ({ rows, rowCount: rows.length })];
const promoRetire = (rows) => [/UPDATE venue_promotions SET owner_deleted_at/, () => ({ rows, rowCount: rows.length })];
const eventDelete = (rows) => [/DELETE FROM venue_events/, () => ({ rows, rowCount: rows.length })];
const eventRetire = (rows) => [/UPDATE venue_events SET owner_deleted_at/, () => ({ rows, rowCount: rows.length })];

test('an unreported promotion still deletes for real, and the guard is inside the DELETE', async () => {
  CURRENT_USER = OWNER;
  handlers = [promoDelete([{ id: 5 }])];
  const res = await call('DELETE', '/api/venue-dashboard/promotions/5');
  assert.strictEqual(res.status, 200, res.text);
  assert.deepStrictEqual(res.body, { success: true });

  const del = ran(/DELETE FROM venue_promotions/)[0];
  assert.match(del.sql, /NOT EXISTS \( SELECT 1 FROM content_reports r/,
    'the report check must be a predicate INSIDE the delete — read-then-delete is the exact race a reported owner is running (routes/stories.js says why)');
  assert.match(del.sql, /r.content_type = 'venue_promotion'/);
  assert.match(del.sql, /r.status IN \('open', 'under_review'\)/);
  assert.ok(!/is_hidden/.test(del.sql),
    'deleting hidden-but-unreported content is legitimate cleanup after moderation — the 409 CONTENT_HIDDEN copy promises exactly that');
});

test('a promotion under an open report survives its own deletion, and the owner cannot tell', async () => {
  CURRENT_USER = OWNER;
  // The guard held: the DELETE touched nothing, the retirement fires instead.
  handlers = [promoDelete([]), promoRetire([{ id: 5 }])];
  const res = await call('DELETE', '/api/venue-dashboard/promotions/5');

  const retire = ran(/UPDATE venue_promotions SET owner_deleted_at/);
  assert.strictEqual(retire.length, 1, 'the evidence row must be retired, not left looking live to its owner');
  assert.match(retire[0].sql, /active = false/,
    'a retired promotion must stop being served publicly, and /public-promotions filters on active');
  assert.match(retire[0].sql, /owner_deleted_at IS NULL/,
    'a second delete of a retired row must answer like a deleted row (404), not retire it twice');

  // THE SILENCE IS LOAD-BEARING. Same status, same body as the real delete:
  // naming the open report would tell the one person with a motive that a
  // review is coming, while the PUT route can still sanitize the words.
  // routes/stories.js retires with the same straight face.
  assert.strictEqual(res.status, 200, res.text);
  assert.deepStrictEqual(res.body, { success: true },
    'the refusal must be indistinguishable from the delete it stands in for');
  assert.ok(!/report|moderat|review/i.test(res.text), 'the response tipped off the reported owner');
});

test('the events DELETE has the same guard and the same straight face', async () => {
  CURRENT_USER = OWNER;
  handlers = [eventDelete([{ id: 5 }])];
  let res = await call('DELETE', '/api/venue-dashboard/events/5');
  assert.strictEqual(res.status, 200, res.text);
  assert.deepStrictEqual(res.body, { success: true },
    'the hard-delete body is the template the retirement must be indistinguishable from');
  const del = ran(/DELETE FROM venue_events/)[0];
  assert.match(del.sql, /NOT EXISTS \( SELECT 1 FROM content_reports r/);
  assert.match(del.sql, /r.content_type = 'venue_event'/);
  assert.match(del.sql, /r.status IN \('open', 'under_review'\)/);
  assert.ok(!/is_hidden/.test(del.sql));

  handlers = [eventDelete([]), eventRetire([{ id: 5 }])];
  log = [];
  res = await call('DELETE', '/api/venue-dashboard/events/5');
  assert.strictEqual(res.status, 200, res.text);
  assert.deepStrictEqual(res.body, { success: true });
  assert.strictEqual(ran(/UPDATE venue_events SET owner_deleted_at/).length, 1);
});

test('a promotion that does not exist, or is not yours, is still a 404', async () => {
  CURRENT_USER = OWNER;
  handlers = [promoDelete([]), promoRetire([])];
  let res = await call('DELETE', '/api/venue-dashboard/promotions/5');
  assert.strictEqual(res.status, 404);
  assert.strictEqual(res.body.error, 'Promotion not found');

  handlers = [eventDelete([]), eventRetire([])];
  res = await call('DELETE', '/api/venue-dashboard/events/5');
  assert.strictEqual(res.status, 404);
  assert.strictEqual(res.body.error, 'Event not found');
});

test('a retired row is gone from the owner lists and from the edit route', async () => {
  CURRENT_USER = OWNER;
  const venueCtx = [/SELECT id, google_place_id, verified, category, verification_requested_at FROM venue_profiles/, () => ({
    rows: [{ id: 7, google_place_id: 'place-1', verified: true }], rowCount: 1,
  })];
  handlers = [
    venueCtx,
    [/SELECT \* FROM venue_promotions WHERE venue_user_id/, () => ({ rows: [] })],
    [/SELECT \* FROM venue_events WHERE venue_user_id/, () => ({ rows: [] })],
  ];
  await call('GET', '/api/venue-dashboard/promotions');
  await call('GET', '/api/venue-dashboard/events');
  for (const re of [/SELECT \* FROM venue_promotions WHERE venue_user_id/, /SELECT \* FROM venue_events WHERE venue_user_id/]) {
    const q = ran(re)[0];
    assert.match(q.sql, /owner_deleted_at IS NULL/,
      'a row the owner deleted must not reappear in their dashboard as a ghost — to them it is deleted');
  }

  // The edit CTEs: a retired row must 404 exactly like a deleted one. (A
  // hidden row still answers 409 CONTENT_HIDDEN; retirement is not a takedown.)
  handlers = [[/WITH target AS/, () => ({ rows: [], rowCount: 0 })]];
  log = [];
  const put = await call('PUT', '/api/venue-dashboard/promotions/5', { title: 'x' });
  assert.strictEqual(put.status, 404);
  for (const table of ['venue_promotions', 'venue_events']) {
    const cteAt = DASHBOARD_SRC.indexOf(`FROM ${table} WHERE id = $5 AND venue_user_id = $6`);
    assert.notStrictEqual(cteAt, -1, `the ${table} edit CTE moved; update this probe`);
    const cte = DASHBOARD_SRC.slice(cteAt, cteAt + 160);
    assert.match(cte, /owner_deleted_at IS NULL/,
      `the ${table} edit route can still open a row its owner deleted`);
  }
});

test('the venue guard and the story guard are the same rule, byte for byte on the status list', async () => {
  // routes/stories.js defined the semantics: refuse while a report is 'open'
  // or 'under_review', silently. If either file ever adds a status the other
  // does not know, one surface becomes the cheap place to destroy evidence.
  const statusList = (src, anchor) => {
    const at = src.indexOf(anchor);
    assert.notStrictEqual(at, -1, `${anchor} not found`);
    const m = /r\.status IN \(([^)]+)\)/.exec(src.slice(at, at + 700));
    assert.ok(m, `no status predicate within reach of ${anchor}`);
    return [...m[1].matchAll(/'([a-z_]+)'/g)].map((q) => q[1]).sort();
  };
  const stories = statusList(STORIES_SRC, 'DELETE FROM stories');
  assert.deepStrictEqual(statusList(DASHBOARD_SRC, 'DELETE FROM venue_promotions'), stories);
  assert.deepStrictEqual(statusList(DASHBOARD_SRC, 'DELETE FROM venue_events'), stories);
});

test('a sweep that takes OTHER rows does not count as deleting the guarded target', async () => {
  // The delete returns every id it took. If the route read rowCount instead of
  // looking for the target id, a sweep of old retired rows would answer
  // "deleted" for a target the evidence guard was still holding — which
  // leaves it live on the owner's dashboard and public card.
  CURRENT_USER = OWNER;
  handlers = [promoDelete([{ id: 3 }]), promoRetire([{ id: 5 }])];
  const res = await call('DELETE', '/api/venue-dashboard/promotions/5');
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(ran(/UPDATE venue_promotions SET owner_deleted_at/).length, 1,
    'the guarded target must still be retired when the sweep happened to take other rows');
});

test('a later delete sweeps retired rows whose reports have closed', async () => {
  // The retention window ends with the review, like the story purge: the
  // guarded DELETE also matches this owner's already-retired rows, so any
  // whose reports are no longer open go for real on the owner's next delete.
  CURRENT_USER = OWNER;
  handlers = [promoDelete([{ id: 5 }, { id: 3 }])];
  const res = await call('DELETE', '/api/venue-dashboard/promotions/5');
  assert.strictEqual(res.status, 200, res.text);
  const del = ran(/DELETE FROM venue_promotions/)[0];
  assert.match(del.sql, /id = \$1 OR owner_deleted_at IS NOT NULL/,
    'without the sweep clause a retired row outlives the report that made it evidence');
});
