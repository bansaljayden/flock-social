// Run: node --test  (from backend/)
//
// ---------------------------------------------------------------------------
// THE TWO SUBMISSION-CRITICAL ROUTES, SWEPT TOGETHER
// ---------------------------------------------------------------------------
//   routes/moderation.js   report + block. App Review tests both under 1.2.
//   routes/safety.js       the SOS the product promises on the Safety screen.
//
// The existing suites already walk the happy journey (safetyFlow), the seams
// between the four safety files (safetyPathAudit), the queue's reach
// (moderationReach, moderationConsoleContract) and the SOS follow-up timing
// (sosLocationFollowup). This file does not repeat any of them. It pins the
// five things that were still only true by inspection:
//
//   A. CHECK-CONSTRAINT PARITY, computed from the EFFECTIVE constraint rather
//      than from one migration by name. The route-widened-ahead-of-the-schema
//      bug has shipped three times (003, 016, 017 are its post-mortems). The
//      pin that exists today reads 019 specifically, which means the NEXT
//      widening — correctly written as a new migration, because db/migrate.js
//      never re-runs a recorded one — fails the test and points the maintainer
//      at the one file they must not edit. This computes what the database
//      would actually hold after every migration has run.
//   B. SELF-REPORT. A report naming yourself was filed, queued and paged a
//      moderator. Ten an hour, from one account, needing no other user and no
//      content.
//   C. BLOCK, mutual and immediate — including the half of "immediate" that
//      lives on the blocker's own device.
//   D. SOS CHANNEL ISOLATION, per recipient and between the send fan-out and
//      the bookkeeping write.
//   E. TRUSTED CONTACT VALIDATION, on the phone field as well as the email one,
//      and the FIELD_LIMITS-vs-column-width parity that is the same bug family
//      as A one table over.
//
// No database and no network.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-unit-tests';

const pool = require('../config/database');
const emailService = require('../services/emailService');
const blocks = require('../utils/blocks');

const ROOT = path.join(__dirname, '..');
const MIGRATIONS_DIR = path.join(ROOT, 'migrations');
const MODERATION_SRC = fs.readFileSync(path.join(ROOT, 'routes', 'moderation.js'), 'utf8');
const SAFETY_SRC = fs.readFileSync(path.join(ROOT, 'routes', 'safety.js'), 'utf8');
const USERS_SRC = fs.readFileSync(path.join(ROOT, 'routes', 'users.js'), 'utf8');
const AUTH_MW_SRC = fs.readFileSync(path.join(ROOT, 'middleware', 'auth.js'), 'utf8');

const moderationRoutes = require('../routes/moderation');
const safetyRoutes = require('../routes/safety');
const M = moderationRoutes.__test;
const S = safetyRoutes.__test;

// ---------------------------------------------------------------------------
// Harnesses
// ---------------------------------------------------------------------------
// Each report costs one of REPORTS_PER_HOUR per USER, and the meter is module
// state with no reset seam, so every report test below authenticates as its own
// id rather than sharing one budget.
function userRow(id) {
  return { id, email: `u${id}@example.com`, name: `User ${id}`, role: 'user', is_banned: false, token_version: 0 };
}

async function call(router, method, urlPath, body, { userId = 7, io = null } = {}) {
  const app = express();
  app.use(express.json());
  if (io) app.set('io', io);
  app.use('/api', router);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const token = jwt.sign({ userId, tv: 0 }, process.env.JWT_SECRET);
  try {
    const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  } finally {
    await new Promise((r) => server.close(r));
  }
}

function stubPool(handler) {
  const realQuery = pool.query;
  const realConnect = pool.connect;
  const calls = [];
  const answer = async (sql, params) => {
    if (sql.includes('FROM users WHERE id = $1') && sql.includes('token_version')) {
      return { rows: [userRow(Number(params[0]))] };
    }
    return (await handler(sql, params)) || { rows: [], rowCount: 0 };
  };
  pool.query = async (text, params) => {
    const sql = String(text);
    calls.push({ text: sql, params });
    return answer(sql, params);
  };
  pool.connect = async () => ({
    query: async (text, params) => {
      const sql = String(text);
      calls.push({ text: sql, params });
      if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(sql) || sql.includes('pg_advisory_xact_lock')) {
        return { rows: [], rowCount: 0 };
      }
      return answer(sql, params);
    },
    release: () => {},
  });
  return { calls, restore: () => { pool.query = realQuery; pool.connect = realConnect; } };
}

const ran = (calls, fragment) => calls.filter((c) => c.text.includes(fragment));

// The moderator page-out is fire-and-forget inside the route. Replacing the
// module's export is how a test can assert that a refused report did not page
// anybody — the route re-requires and destructures per call, so the patch is
// seen.
const alertsModule = require('../services/moderationAlerts');
function stubModeratorAlerts() {
  const real = alertsModule.alertModerators;
  const sent = [];
  alertsModule.alertModerators = async (io, payload) => { sent.push(payload); };
  return { sent, restore: () => { alertsModule.alertModerators = real; } };
}

// Replace the shared sender per recipient. safety.js holds emailService as a
// module object precisely so this is possible.
function stubSender(behaviour) {
  const real = emailService.sendEmail;
  const attempts = [];
  emailService.sendEmail = async (opts) => {
    attempts.push(opts);
    return behaviour(opts);
  };
  return { attempts, restore: () => { emailService.sendEmail = real; } };
}

function captureConsole() {
  const real = { error: console.error, warn: console.warn, log: console.log };
  const lines = [];
  console.error = (...a) => lines.push(a.join(' '));
  console.warn = (...a) => lines.push(a.join(' '));
  console.log = (...a) => lines.push(a.join(' '));
  return { lines, restore: () => Object.assign(console, real) };
}

// ---------------------------------------------------------------------------
// Migration reader: what the database actually holds after every file has run.
// ---------------------------------------------------------------------------
function migrationFiles() {
  return fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
}

function sqlBody(file) {
  return fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8')
    .split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');
}

// The LAST migration, in the order db/migrate.js applies them, that redefines
// `constraintName` — plus the values it allows. This is the effective
// constraint: earlier definitions were dropped by later ones.
function effectiveCheck(constraintName) {
  let found = null;
  for (const file of migrationFiles()) {
    const body = sqlBody(file);
    const re = new RegExp(`ADD CONSTRAINT ${constraintName}[\\s\\S]*?\\)\\s*\\)`, 'g');
    for (const m of body.matchAll(re)) {
      found = { file, values: new Set([...m[0].matchAll(/'([a-z_]+)'/g)].map((v) => v[1])) };
    }
  }
  return found;
}

// A width read out of a CREATE TABLE is only the truth while no later migration
// has retyped the column. Every width assertion below asks this first, so the
// day somebody narrows content_type or contact_phone the parity tests say so
// instead of quietly reading a stale number.
function assertColumnNeverRetyped(table, column) {
  for (const file of migrationFiles()) {
    const re = new RegExp(`ALTER TABLE ${table}[\\s\\S]{0,80}ALTER COLUMN ${column}\\s+(SET DATA )?TYPE`, 'i');
    assert.ok(!re.test(sqlBody(file)),
      `${file} retypes ${table}.${column}; the width these tests read from the CREATE TABLE is stale`);
  }
}

// A constraint written inline in a CREATE TABLE, for the columns no later
// migration has touched.
function inlineCheck(table, column) {
  let found = null;
  for (const file of migrationFiles()) {
    const body = sqlBody(file);
    const create = new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\n\\s*\\);`, 'i').exec(body);
    if (!create) continue;
    const col = new RegExp(`${column}\\s+VARCHAR\\((\\d+)\\)([^\\n]*)`, 'i').exec(create[1]);
    if (!col) continue;
    const check = /CHECK\s*\(\s*\w+\s+IN\s*\(([^)]*)\)/i.exec(col[2]);
    found = {
      file,
      width: Number(col[1]),
      values: check ? new Set([...check[1].matchAll(/'([a-z_]+)'/g)].map((v) => v[1])) : null,
    };
  }
  return found;
}

// ===========================================================================
// A. CHECK-CONSTRAINT PARITY — value by value, against the EFFECTIVE constraint
// ===========================================================================

test('parity: every content_type the route accepts is allowed by the effective CHECK', () => {
  const eff = effectiveCheck('content_reports_content_type_check');
  assert.ok(eff, 'no migration defines content_reports_content_type_check');
  const missing = M.VALID_CONTENT_TYPES.filter((t) => !eff.values.has(t));
  assert.deepStrictEqual(missing, [],
    `routes/moderation.js accepts ${missing.join(', ')} and the last migration to define the ` +
    `constraint (${eff.file}) refuses it. Every report of that type is a 23514 the catch serves ` +
    'as "500 Failed to submit report". Add a NEW migration widening the constraint in the same ' +
    'commit — never edit an applied one, db/migrate.js records it and never re-runs it.');
});

test('parity: the effective CHECK allows nothing the route will not accept', () => {
  // The other direction. A value only the database knows about is a report type
  // no user can file and no queue card can render: dead schema that reads, to
  // the next maintainer, as a supported surface.
  const eff = effectiveCheck('content_reports_content_type_check');
  const orphans = [...eff.values].filter((t) => !M.VALID_CONTENT_TYPES.includes(t));
  assert.deepStrictEqual(orphans, [],
    `${eff.file} allows ${orphans.join(', ')} and routes/moderation.js will not accept it`);
});

test('parity: the effective CHECK is the newest migration that defines it', () => {
  // The trap this file exists to close. The pin that shipped before this one
  // read migration 019 by name, so a correctly written 023 that added a ninth
  // type would fail it — and the obvious way to "fix" that failure is to edit
  // 019, which every database that has already recorded it will never re-run.
  // Asserting the LAST definition is the authority makes the correct fix the
  // one that passes.
  const eff = effectiveCheck('content_reports_content_type_check');
  const definers = migrationFiles().filter((f) =>
    sqlBody(f).includes('ADD CONSTRAINT content_reports_content_type_check'));
  assert.strictEqual(eff.file, definers[definers.length - 1]);
  assert.ok(definers.length >= 2, 'the constraint has been widened before; the history must stay readable');
});

test('parity: every content_type value fits the column, so a drift cannot arrive as 22001', () => {
  // content_type is VARCHAR(20). A value longer than that is a 22001, not a
  // 23514, so it never trips the "VALID_CONTENT_TYPES has drifted" alarm in the
  // catch and the maintainer is sent looking for a missing migration that does
  // not exist.
  assertColumnNeverRetyped('content_reports', 'content_type');
  const col = inlineCheck('content_reports', 'content_type');
  assert.ok(col && col.width, 'content_reports.content_type width not found in the migrations');
  const tooLong = M.VALID_CONTENT_TYPES.filter((t) => t.length > col.width);
  assert.deepStrictEqual(tooLong, [],
    `${tooLong.join(', ')} does not fit content_type VARCHAR(${col.width})`);
});

test('parity: every reason fits its column, and the enum is route-only by design', () => {
  // reason is VARCHAR(50) with NO CHECK constraint anywhere in the migrations,
  // so VALID_REASONS is enforced by express-validator alone. That is a fine
  // arrangement and it must be recorded as one: the alarm in the route's catch
  // says a 23514 on this table means exactly one thing (a content_type drift),
  // which is only true while reason has no constraint of its own.
  assertColumnNeverRetyped('content_reports', 'reason');
  const col = inlineCheck('content_reports', 'reason');
  assert.ok(col && col.width, 'content_reports.reason width not found');
  const tooLong = M.VALID_REASONS.filter((r) => r.length > col.width);
  assert.deepStrictEqual(tooLong, [], `${tooLong.join(', ')} does not fit reason VARCHAR(${col.width})`);

  const reasonCheck = effectiveCheck('content_reports_reason_check') || (col.values ? col : null);
  if (reasonCheck && reasonCheck.values) {
    // Somebody added one. Then it is a parity surface like content_type, and
    // both directions have to hold.
    const missing = M.VALID_REASONS.filter((r) => !reasonCheck.values.has(r));
    assert.deepStrictEqual(missing, [],
      `a reason CHECK now exists and refuses ${missing.join(', ')}; the route's 23514 alarm also needs updating`);
  }
});

test('parity: both statuses the duplicate-report query filters on are real status values', () => {
  // The dupe suppression reads `status IN ('open','under_review')`. A status the
  // CHECK does not allow can never appear, so the query would silently stop
  // suppressing duplicates: every re-file becomes a new row and a new page-out.
  const col = inlineCheck('content_reports', 'status');
  assert.ok(col && col.values, 'content_reports.status CHECK not found');
  for (const status of ['open', 'under_review']) {
    assert.ok(col.values.has(status),
      `the dupe query filters status = '${status}' and no such status can exist`);
    assert.ok(MODERATION_SRC.includes(`'${status}'`), `${status} is no longer read by the route`);
  }
});

test('parity: moderation.js writes no moderation_actions row, so it owns one constraint surface', () => {
  // The action CHECK (001, widened by 017 and 020) belongs to routes/admin.js.
  // If a ban or a takedown ever moves here, this assertion is the reminder that
  // the action vocabulary comes with it.
  assert.ok(!/INSERT INTO moderation_actions/.test(MODERATION_SRC),
    'moderation.js now writes moderation_actions: diff its action strings against the effective CHECK too');
  const eff = effectiveCheck('moderation_actions_action_check');
  assert.ok(eff && eff.values.has('user_banned'), 'the action vocabulary is still where it was');
});

test('a ban is not this route\'s to write, and an outstanding token dies without a version bump', () => {
  // The brief asks whether a ban here kills outstanding tokens. This route does
  // not ban — and the reason a ban needs no token_version bump is that
  // middleware/auth.js re-reads is_banned from the row on EVERY authenticated
  // request and answers 403. token_version (migration 009) exists for
  // credential changes, where the check is against a claim rather than a live
  // column. If banning ever moves into this file, both halves have to move with
  // it.
  assert.ok(!/is_banned\s*=/.test(MODERATION_SRC), 'moderation.js must not write is_banned');
  assert.ok(!/token_version\s*=/.test(MODERATION_SRC), 'moderation.js must not write token_version');
  assert.match(AUTH_MW_SRC, /is_banned, token_version FROM users WHERE id = \$1/);
  assert.match(AUTH_MW_SRC, /is_banned && !allowBanned/);
});

test('every reportable type with content behind it has a visibility branch in the route', () => {
  // A type that passes isIn() and matches no branch reaches the INSERT with no
  // check at all — round 19's array bug, arrived at by a different road.
  const missing = M.VALID_CONTENT_TYPES.filter(
    (t) => t !== 'profile' && !MODERATION_SRC.includes(`content_type === '${t}'`)
  );
  assert.deepStrictEqual(missing, [],
    `${missing.join(', ')} is accepted with no visibility check: any id can be reported`);
  assert.ok(!MODERATION_SRC.includes("content_type === 'profile'"),
    "a profile report has no content row; it is gated on reported_user_id instead");
});

// ===========================================================================
// B. SELF-REPORT
// ===========================================================================

test('self-report: naming yourself is refused, files nothing and pages nobody', async () => {
  // THE CHEAPEST QUEUE-FLOODING PAYLOAD IN THE APP. `{content_type:'profile',
  // reason:'spam', reported_user_id: <me>}` needs no other user, no content and
  // no visibility: the only gate on that shape is "does this user exist", and
  // the reporter is proof that they do. Ten an hour per account, every one of
  // them a row in a LIMIT 200 queue and a push to every moderator, and every
  // one unactionable — admin.js refuses to hide a profile, and the only person
  // to ban is the reporter.
  const alerts = stubModeratorAlerts();
  const { calls, restore } = stubPool(async () => null);
  try {
    const res = await call(moderationRoutes, 'POST', '/api/reports', {
      content_type: 'profile', reason: 'spam', reported_user_id: 101,
    }, { userId: 101 });
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    assert.match(res.body.error, /yourself/i);
    assert.strictEqual(ran(calls, 'INSERT INTO content_reports').length, 0);
    assert.strictEqual(alerts.sent.length, 0, 'a self-report must not page a moderator');
  } finally { restore(); alerts.restore(); }
});

test('self-report: refused before the hourly budget is spent', async () => {
  // Round 15's rule (validate first, meter second) applied to the same class of
  // non-report: somebody who taps report on their own profile by accident must
  // not lose one of the ten reports they may need for a real one. Eleven
  // attempts, all refused the same way — if the meter were charged, the
  // eleventh would be a 429.
  const { restore } = stubPool(async () => null);
  try {
    for (let i = 0; i < 11; i++) {
      // eslint-disable-next-line no-await-in-loop
      const res = await call(moderationRoutes, 'POST', '/api/reports', {
        content_type: 'profile', reason: 'spam', reported_user_id: 102,
      }, { userId: 102 });
      assert.strictEqual(res.status, 400, `attempt ${i + 1}: ${JSON.stringify(res.body)}`);
    }
  } finally { restore(); }
});

test('self-report: reporting your own content is refused, on every type that has an author', async () => {
  // The other road to the same row. The story branch deliberately carries
  // includeOwn:true so that a report against your own story is not answered
  // with "that content could not be found" — the honest answer is that you
  // cannot report yourself, not a denial that the story exists.
  const cases = [
    ['story', 'FROM stories'],
    ['venue_review', 'FROM venue_reviews'],
    ['dm', 'FROM direct_messages'],
    ['flock_message', 'FROM messages'],
  ];
  for (const [type, table] of cases) {
    const alerts = stubModeratorAlerts();
    const { calls, restore } = stubPool(async (sql) => {
      if (sql.includes(table)) return { rows: [{ sender_id: 110, is_hidden: false }] };
      return null;
    });
    try {
      // eslint-disable-next-line no-await-in-loop
      const res = await call(moderationRoutes, 'POST', '/api/reports', {
        content_type: type, content_id: 55, reason: 'harassment',
      }, { userId: 110 });
      assert.strictEqual(res.status, 400, `${type}: ${JSON.stringify(res.body)}`);
      assert.match(res.body.error, /your own|yourself/i, type);
      assert.strictEqual(ran(calls, 'INSERT INTO content_reports').length, 0, type);
      assert.strictEqual(alerts.sent.length, 0, type);
    } finally { restore(); alerts.restore(); }
  }
});

test('self-report: a report against somebody else is untouched', async () => {
  // The refusal must be narrow. This is the whole point of the route.
  const alerts = stubModeratorAlerts();
  const { calls, restore } = stubPool(async (sql) => {
    if (sql.includes('FROM venue_reviews')) return { rows: [{ sender_id: 9, is_hidden: false }] };
    if (sql.includes('SELECT id, status, created_at FROM content_reports')) return { rows: [] };
    if (sql.includes('INSERT INTO content_reports')) return { rows: [{ id: 3, status: 'open', created_at: 'now' }] };
    return null;
  });
  try {
    const res = await call(moderationRoutes, 'POST', '/api/reports', {
      content_type: 'venue_review', content_id: 55, reported_user_id: 9, reason: 'hate',
    }, { userId: 111 });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    assert.strictEqual(res.body.message, M.REPORT_ACCEPTED);
    assert.strictEqual(ran(calls, 'INSERT INTO content_reports').length, 1);
    assert.strictEqual(alerts.sent.length, 1, 'a real report still pages a moderator');
  } finally { restore(); alerts.restore(); }
});

test('self-report: a guest RSVP has no account behind it and stays reportable', async () => {
  // sender_id is NULL::int for this type. A self-check that treated "no author"
  // as "the author is me" would take the only takedown path for an abusive
  // guest name back off the board — which is exactly the outage migration 016
  // was written to end.
  const { calls, restore } = stubPool(async (sql) => {
    if (sql.includes('FROM guest_rsvps')) return { rows: [{ sender_id: null, is_hidden: false }] };
    if (sql.includes('SELECT id, status, created_at FROM content_reports')) return { rows: [] };
    if (sql.includes('INSERT INTO content_reports')) return { rows: [{ id: 4, status: 'open', created_at: 'now' }] };
    return null;
  });
  const alerts = stubModeratorAlerts();
  try {
    const res = await call(moderationRoutes, 'POST', '/api/reports', {
      content_type: 'guest_rsvp', content_id: 12, reason: 'harassment',
    }, { userId: 112 });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    assert.strictEqual(ran(calls, 'INSERT INTO content_reports').length, 1);
  } finally { restore(); alerts.restore(); }
});

test('self-report and self-block give the same answer to the same question', () => {
  // The two halves of the 1.2 control had different doctrines: blocking
  // yourself was refused in so many words, reporting yourself was filed.
  assert.match(MODERATION_SRC, /You cannot block yourself/);
  assert.match(MODERATION_SRC, /You cannot report yourself/);
});

// ===========================================================================
// C. BLOCK — mutual and immediate
// ===========================================================================

test('block: the 30s cached decision is dropped for the pair, whichever way it was keyed', async () => {
  // The cache is what live location and typing consult, so a block that does
  // not evict it keeps leaking coordinates for up to thirty seconds. pairKey is
  // order-independent; this proves the route's invalidation and the socket
  // layer's lookup land on the same entry.
  const { pairKey, blockCache } = blocks.__test;
  blockCache.clear();
  blockCache.set(pairKey(9, 7), { ts: Date.now(), blocked: false });
  const { restore } = stubPool(async (sql) => {
    if (sql.includes('SELECT id FROM users WHERE id = $1')) return { rows: [{ id: 9 }] };
    return null;
  });
  try {
    const res = await call(moderationRoutes, 'POST', '/api/blocks/9', undefined, { userId: 7 });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    assert.strictEqual(blockCache.has(pairKey(7, 9)), false,
      'a fresh block must not wait out the cache TTL on live location');
  } finally { restore(); blockCache.clear(); }
});

test('block: both devices are told to stop emitting at the other', async () => {
  // THE HALF THAT WAS MISSING. The server refuses live DM location in both
  // directions the moment the block lands, but only the BLOCKED user's client
  // was told. The blocker — who may have been sharing their live location with
  // the person they are blocking, which is a plausible reason to block someone
  // — kept a 10-second emit loop running and kept a Safety-adjacent UI saying
  // "sharing location with <the person you just blocked>" until they navigated
  // away. App.js's onBlockedBy handler reads the payload as "stop emitting at
  // this id", so each side is sent the OTHER id and no client change is needed.
  const emits = [];
  const io = { to: (room) => ({ emit: (event, payload) => emits.push({ room, event, payload }) }) };
  const { restore } = stubPool(async (sql) => {
    if (sql.includes('SELECT id FROM users WHERE id = $1')) return { rows: [{ id: 9 }] };
    return null;
  });
  try {
    const res = await call(moderationRoutes, 'POST', '/api/blocks/9', undefined, { userId: 7, io });
    assert.strictEqual(res.status, 201);
    const rooms = emits.filter((e) => e.event === 'blocked_by');
    assert.deepStrictEqual(
      rooms.map((e) => [e.room, e.payload.userId]).sort(),
      [['user:7', 9], ['user:9', 7]],
      'each side must be told which id to stop emitting at'
    );
  } finally { restore(); }
});

test('block: mutual, self-refused, bounded, and it separates the two accounts', async () => {
  const { calls, restore } = stubPool(async (sql) => {
    if (sql.includes('SELECT id FROM users WHERE id = $1')) return { rows: [{ id: 9 }] };
    return null;
  });
  try {
    const ok = await call(moderationRoutes, 'POST', '/api/blocks/9', undefined, { userId: 7 });
    assert.strictEqual(ok.status, 201);
    // The block row itself is one-directional; invisibility is mutual because
    // utils/blocks.js reads both directions. Pin the pair, not the copy.
    assert.strictEqual(ran(calls, 'INSERT INTO user_blocks').length, 1);
    assert.strictEqual(ran(calls, 'DELETE FROM friendships').length, 1,
      'a block that leaves the friendship in place leaves a relationship the app still reads');
    const both = ran(calls, 'DELETE FROM friendships')[0].text;
    assert.ok(both.includes('requester_id = $1 AND addressee_id = $2'), both);
    assert.ok(both.includes('requester_id = $2 AND addressee_id = $1'), both);

    const self = await call(moderationRoutes, 'POST', '/api/blocks/7', undefined, { userId: 7 });
    assert.strictEqual(self.status, 400);
    const junk = await call(moderationRoutes, 'POST', '/api/blocks/12abc', undefined, { userId: 7 });
    assert.strictEqual(junk.status, 400, 'parseInt("12abc") silently blocked user 12');
    const huge = await call(moderationRoutes, 'POST', '/api/blocks/99999999999', undefined, { userId: 7 });
    assert.strictEqual(huge.status, 400, 'an id past int4 is a 22003 the catch serves as a 500');
  } finally { restore(); }
});

test('block: unblock evicts the cache too, and an unblock of nothing is a 404', async () => {
  const { pairKey, blockCache } = blocks.__test;
  blockCache.clear();
  blockCache.set(pairKey(7, 9), { ts: Date.now(), blocked: true });
  const { restore } = stubPool(async (sql) => {
    if (sql.includes('DELETE FROM user_blocks')) return { rows: [{ id: 1 }], rowCount: 1 };
    return null;
  });
  try {
    const res = await call(moderationRoutes, 'DELETE', '/api/blocks/9', undefined, { userId: 7 });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(blockCache.has(pairKey(7, 9)), false,
      'an unblock that leaves blocked:true cached keeps two people invisible to each other');
  } finally { restore(); blockCache.clear(); }

  const { restore: r2 } = stubPool(async () => ({ rows: [], rowCount: 0 }));
  try {
    const res = await call(moderationRoutes, 'DELETE', '/api/blocks/9', undefined, { userId: 7 });
    assert.strictEqual(res.status, 404);
  } finally { r2(); }
});

// ===========================================================================
// D. SOS — channel isolation
// ===========================================================================
//
// WHAT THE CHANNELS ACTUALLY ARE. An SOS has ONE delivery channel: email, one
// message per trusted contact. There is no push leg and there cannot be one —
// a trusted contact is an address somebody typed, not a Flock account, so there
// is no device token to send to. PrivacyPolicy.js states this to users in so
// many words ("SOS alerts are sent by email only"), and the phone column exists
// only because the form asks for it. The isolation that matters here is
// therefore between RECIPIENTS, and between the fan-out and the bookkeeping
// write that follows it. Both are proved below.

const ALERT_BODY = { latitude: 40.7128, longitude: -74.006, includeLocation: true };

function alertPool(contacts, { onUpdate } = {}) {
  return stubPool(async (sql) => {
    if (sql.includes('FROM emergency_alerts')) return { rows: [] };
    if (sql.includes('FROM trusted_contacts')) return { rows: contacts };
    if (sql.includes('SELECT name FROM users')) return { rows: [{ name: 'Ada' }] };
    if (sql.includes('INSERT INTO emergency_alerts')) return { rows: [{ id: 900 }] };
    if (sql.includes('UPDATE emergency_alerts') && onUpdate) return onUpdate(sql);
    return null;
  });
}

const TWO_CONTACTS = [
  { id: 1, contact_name: 'Mum', contact_email: 'mum@example.com', contact_phone: '5550100' },
  { id: 2, contact_name: 'Dad', contact_email: 'dad@example.com', contact_phone: '5550101' },
];

test('sos: one recipient failing does not stop the other', async () => {
  const sender = stubSender(async ({ to }) =>
    (to === 'mum@example.com' ? { sent: false, error: 'provider refused' } : { sent: true, id: 'x' }));
  const { calls, restore } = alertPool(TWO_CONTACTS);
  const cap = captureConsole();
  try {
    const res = await call(safetyRoutes, 'POST', '/api/alert', ALERT_BODY);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(sender.attempts.length, 2, 'both contacts must be attempted');
    const byName = Object.fromEntries(res.body.alerts.map((a) => [a.contactName, a.sent]));
    assert.deepStrictEqual(byName, { Mum: false, Dad: true });
    const update = ran(calls, 'UPDATE emergency_alerts SET contacts_alerted')[0];
    assert.strictEqual(update.params[0], 1, 'the row must record the confirmed count, not the attempted one');
  } finally { cap.restore(); sender.restore(); restore(); }
});

test('sos: a recipient whose send THROWS does not stop the other', async () => {
  // emailService's contract is that it never throws, and routes/safety.js is
  // written not to depend on that: the fan-out is allSettled, so a violated
  // contract costs one contact rather than the whole alert. This is the test
  // that keeps the second half true if the first half ever regresses.
  const sender = stubSender(async ({ to }) => {
    if (to === 'mum@example.com') throw new Error('contract violated');
    return { sent: true, id: 'x' };
  });
  const { calls, restore } = alertPool(TWO_CONTACTS);
  const cap = captureConsole();
  try {
    const res = await call(safetyRoutes, 'POST', '/api/alert', ALERT_BODY);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.success, true);
    const byName = Object.fromEntries(res.body.alerts.map((a) => [a.contactName, a.sent]));
    assert.deepStrictEqual(byName, { Mum: false, Dad: true });
    assert.strictEqual(ran(calls, 'UPDATE emergency_alerts SET contacts_alerted')[0].params[0], 1);
  } finally { cap.restore(); sender.restore(); restore(); }
});

test('sos: an unmailable contact is skipped by name and the mailable one still goes', async () => {
  const sender = stubSender(async () => ({ sent: true, id: 'x' }));
  const { restore } = alertPool([
    { id: 1, contact_name: 'Nan', contact_email: 'nan@example.invalid', contact_phone: '5550102' },
    ...TWO_CONTACTS.slice(1),
  ]);
  const cap = captureConsole();
  try {
    const res = await call(safetyRoutes, 'POST', '/api/alert', ALERT_BODY);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(sender.attempts.length, 1, 'an address that can never be delivered to is not attempted');
    const nan = res.body.alerts.find((a) => a.contactName === 'Nan');
    assert.strictEqual(nan.sent, false);
    assert.match(nan.reason, /cannot receive mail/);
    // Round 23: the message names WHO was told rather than counting SMTP
    // transactions, and it still has to account for the contact who was not.
    assert.match(res.body.message, /Dad has been told/);
    assert.match(res.body.message, /1 contact could not be reached/);
  } finally { cap.restore(); sender.restore(); restore(); }
});

test('sos: the bookkeeping write failing cannot turn a delivered alert into a 500', async () => {
  // The second isolation seam. contacts_alerted is cooldown bookkeeping and
  // runs AFTER every email is out, so a blip on it once answered "500 Failed to
  // send alert" for an alert that had been delivered — and left the row at 0,
  // which reads as in flight and refused the retry for another minute.
  const sender = stubSender(async () => ({ sent: true, id: 'x' }));
  const { restore } = alertPool(TWO_CONTACTS, {
    onUpdate: () => { throw new Error('connection terminated'); },
  });
  const cap = captureConsole();
  try {
    const res = await call(safetyRoutes, 'POST', '/api/alert', ALERT_BODY);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.success, true);
    assert.ok(cap.lines.some((l) => /DELIVERED to 2 contact/.test(l)),
      'the lost bookkeeping must be loud in the log, since the cooldown is not armed');
  } finally { cap.restore(); sender.restore(); restore(); }
});

test('sos: the shared sender is the only way mail leaves this route', async () => {
  // Comments stripped: the header of routes/safety.js quotes the private client
  // it was migrated off, and a test that matched the quotation could never pass.
  const code = SAFETY_SRC.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  assert.ok(!/require\(['"]resend['"]\)/.test(code), 'routes/safety.js must not build its own Resend client');
  assert.ok(!/new Resend\(/.test(code));
  assert.match(SAFETY_SRC, /require\('\.\.\/services\/emailService'\)/);
  // And it uses the module object, not a destructured copy, so the never-throws
  // contract is resolved per send rather than captured at require time.
  assert.match(SAFETY_SRC, /emailService\.sendEmail\(/);
});

test('sos: only consented coordinates are stored, and the row matches what the export hands back', async () => {
  const sender = stubSender(async () => ({ sent: true, id: 'x' }));
  const { calls, restore } = alertPool(TWO_CONTACTS);
  const cap = captureConsole();
  try {
    await call(safetyRoutes, 'POST', '/api/alert', { ...ALERT_BODY, includeLocation: false });
    const insert = ran(calls, 'INSERT INTO emergency_alerts')[0];
    assert.deepStrictEqual(insert.params.slice(1, 3), [null, null],
      'a user who declined to attach their location must not have it persisted');
  } finally { cap.restore(); sender.restore(); restore(); }

  const sender2 = stubSender(async () => ({ sent: true, id: 'x' }));
  const { calls: c2, restore: r2 } = alertPool(TWO_CONTACTS);
  const cap2 = captureConsole();
  try {
    await call(safetyRoutes, 'POST', '/api/alert', ALERT_BODY);
    const insert = ran(c2, 'INSERT INTO emergency_alerts')[0];
    assert.deepStrictEqual(insert.params.slice(1, 3), [40.7128, -74.006]);
  } finally { cap2.restore(); sender2.restore(); r2(); }

  // What is stored, what the privacy policy admits to, and what the data export
  // returns have to be the same three things.
  assert.match(USERS_SRC, /SELECT latitude, longitude, contacts_alerted, created_at\s*\n\s*FROM emergency_alerts/);
  const privacy = fs.readFileSync(
    path.join(ROOT, '..', 'frontend', 'src', 'website', 'PrivacyPolicy.js'), 'utf8');
  assert.match(privacy, /we store that alert \(your account, the coordinates, and how many contacts were emailed\)/);
  assert.match(privacy, /SOS alerts are sent by <strong>email only<\/strong>/);
});

test('sos: a degraded input degrades the alert, it never fails it', async () => {
  // The fail-open family this route actually has. There is no block lookup on
  // an SOS — a trusted contact is an address, not an account, so there is no
  // relationship to consult and nothing that could fail closed. What CAN fail
  // is the trimming around the message, and every one of those degrades:
  // unreadable coordinates send an alert without a location, an unknown
  // timezone falls back to a labelled UTC, a missing display name falls back to
  // "A Flock user". None of them may cost a delivery.
  const sender = stubSender(async () => ({ sent: true, id: 'x' }));
  const { calls, restore } = stubPool(async (sql) => {
    if (sql.includes('FROM emergency_alerts')) return { rows: [] };
    if (sql.includes('FROM trusted_contacts')) return { rows: TWO_CONTACTS };
    if (sql.includes('SELECT name FROM users')) return { rows: [] };   // no name row
    if (sql.includes('INSERT INTO emergency_alerts')) return { rows: [{ id: 901 }] };
    return null;
  });
  const cap = captureConsole();
  try {
    const res = await call(safetyRoutes, 'POST', '/api/alert', {
      latitude: 'not-a-number', longitude: {}, timezone: 'Mars/Olympus', includeLocation: true,
    });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(sender.attempts.length, 2);
    assert.match(sender.attempts[0].html, /Location was not available/);
    assert.match(sender.attempts[0].subject, /A Flock user/);
    assert.deepStrictEqual(ran(calls, 'INSERT INTO emergency_alerts')[0].params.slice(1, 3), [null, null]);
  } finally { cap.restore(); sender.restore(); restore(); }
  assert.ok(!/utils\/blocks/.test(SAFETY_SRC),
    'an SOS must not depend on a block lookup: there is no relationship to consult, and a lookup that ' +
    'errored would be a reason not to send');
});

// ===========================================================================
// D2. THE RATE LIMIT ON AN EMERGENCY SURFACE — the numbers, and why
// ===========================================================================
//
// The rule an emergency limiter has to satisfy is not "be strict", it is
// "never be the reason an SOS did not go out". Walking the three retries a
// frightened person actually makes:
//
//   the first alert FAILED         -> allowed at once. The claim row backdates
//                                     itself past the floor the moment the
//                                     sends settle, so the retry the 502 tells
//                                     them to make is open. This is the case a
//                                     naive limiter gets wrong and it is the
//                                     one that matters most.
//   the first alert DELIVERED,
//   they have moved                -> allowed after 60s, up to 3 delivered
//                                     alerts per 15 minutes. The update a
//                                     contact needs is the new location.
//   the first alert DELIVERED,
//   nothing has changed            -> refused, and the refusal SAYS the earlier
//                                     alert went out, to how many people, how
//                                     long ago, and names 911. A duplicate of
//                                     an alert that is confirmed delivered adds
//                                     nothing; being told it was delivered
//                                     does.
//
// MAX_ATTEMPTS_PER_WINDOW is the outer bound that keeps a total-failure loop
// (a provider outage: every retry allowed, every retry mails everybody) from
// running forever, and it is checked last so every more useful refusal answers
// first. The numbers below are the policy; the tests are that they still are.

test('rate limit: the constants leave no gap and no lockout', () => {
  assert.ok(S.ALERT_FLOOR_MS < S.ALERT_COOLDOWN_MS);
  assert.ok(S.MAX_ESCALATIONS < S.MAX_ATTEMPTS_PER_WINDOW,
    'the attempt ceiling must not bite before the escalation ceiling, or a moved user is refused by the wrong rule');
  assert.ok(S.LOCATION_FOLLOWUP_WINDOW_MS >= S.ALERT_FLOOR_MS,
    'a follow-up window shorter than the floor leaves a stretch where the first location cannot get through');
  assert.strictEqual(S.ALERT_FLOOR_MS, 60 * 1000);
  assert.strictEqual(S.ALERT_COOLDOWN_MS, 5 * 60 * 1000);
  assert.strictEqual(S.MAX_ESCALATIONS, 3);
  assert.strictEqual(S.MAX_ATTEMPTS_PER_WINDOW, 6);
  assert.strictEqual(S.ESCALATION_METERS, 250);
});

test('rate limit: the retry after a total failure is open immediately', async () => {
  // The previous attempt reached nobody and backdated itself past the floor, so
  // this one is not refused. Anything else is telling somebody their SOS failed
  // and then refusing to let them try again.
  const sender = stubSender(async () => ({ sent: true, id: 'x' }));
  const { calls, restore } = stubPool(async (sql) => {
    if (sql.includes('FROM emergency_alerts')) {
      return { rows: [{
        created_at: 'then', latitude: null, longitude: null, contacts_alerted: 0,
        age_ms: S.ALERT_FLOOR_MS + 1000, delivered_in_window: 0, attempts_in_window: 1,
      }] };
    }
    if (sql.includes('FROM trusted_contacts')) return { rows: TWO_CONTACTS };
    if (sql.includes('SELECT name FROM users')) return { rows: [{ name: 'Ada' }] };
    if (sql.includes('INSERT INTO emergency_alerts')) return { rows: [{ id: 902 }] };
    return null;
  });
  const cap = captureConsole();
  try {
    const res = await call(safetyRoutes, 'POST', '/api/alert', ALERT_BODY);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(ran(calls, 'INSERT INTO emergency_alerts').length, 1);
  } finally { cap.restore(); sender.restore(); restore(); }
});

test('rate limit: a refusal after a delivered alert says it was delivered, and names 911', async () => {
  const { calls, restore } = stubPool(async (sql) => {
    if (sql.includes('FROM emergency_alerts')) {
      return { rows: [{
        created_at: 'then', latitude: 40.7128, longitude: -74.006, contacts_alerted: 2,
        age_ms: 90 * 1000, delivered_in_window: 1, attempts_in_window: 1,
      }] };
    }
    return null;
  });
  try {
    const res = await call(safetyRoutes, 'POST', '/api/alert', ALERT_BODY);
    assert.strictEqual(res.status, 429);
    assert.strictEqual(res.body.alreadySent, true);
    assert.strictEqual(res.body.contactsAlerted, 2);
    assert.match(res.body.error, /went out to 2 contacts/);
    assert.match(res.body.error, /call 911/i);
    assert.strictEqual(ran(calls, 'INSERT INTO emergency_alerts').length, 0);
  } finally { restore(); }
});

test('rate limit: moving somewhere new gets through the cooldown', async () => {
  const sender = stubSender(async () => ({ sent: true, id: 'x' }));
  const { calls, restore } = stubPool(async (sql) => {
    if (sql.includes('FROM emergency_alerts')) {
      return { rows: [{
        created_at: 'then', latitude: 40.7128, longitude: -74.006, contacts_alerted: 2,
        age_ms: 90 * 1000, delivered_in_window: 1, attempts_in_window: 1,
      }] };
    }
    if (sql.includes('FROM trusted_contacts')) return { rows: TWO_CONTACTS };
    if (sql.includes('SELECT name FROM users')) return { rows: [{ name: 'Ada' }] };
    if (sql.includes('INSERT INTO emergency_alerts')) return { rows: [{ id: 903 }] };
    return null;
  });
  const cap = captureConsole();
  try {
    const res = await call(safetyRoutes, 'POST', '/api/alert', { ...ALERT_BODY, latitude: 40.75 });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(ran(calls, 'INSERT INTO emergency_alerts').length, 1);
  } finally { cap.restore(); sender.restore(); restore(); }
});

test('rate limit: the contact-write throttle is not on the alert', () => {
  // The lever against a mail relay lives on the contact form, deliberately.
  // Throttling the SOS to slow a spammer is a trade this file may not make.
  const start = SAFETY_SRC.indexOf("router.post('/alert'");
  const end = SAFETY_SRC.indexOf("router.post('/share-location'");
  assert.ok(start > 0 && end > start, 'could not isolate the /alert handler');
  const alertHandler = SAFETY_SRC.slice(start, end);
  assert.ok(!alertHandler.includes('refuseContactWriteBurst'));
  assert.ok(!alertHandler.includes('shareCooldowns.set'));
});

// ===========================================================================
// E. TRUSTED CONTACT VALIDATION
// ===========================================================================

test('contacts: the phone field has to look like a phone number', () => {
  // The email rules were tightened onto the shared deliverability question and
  // the phone field beside them was checked for nothing but length. It is not
  // dialled by anything (PrivacyPolicy says so), but it IS the ON CONFLICT key
  // that decides whether a save updates a contact or adds one, it is rendered
  // on the Safety screen, and a field that accepts anything at all on a safety
  // form is one somebody stores a note in and then wonders why their contact
  // list has four entries for their mother.
  for (const bad of ['<script>alert(1)</script>', 'call me maybe', 'mum@example.com', '+1 555 ext. 42', '++', '---']) {
    const r = S.readContactFields({ name: 'Mum', phone: bad, email: 'mum@example.com' });
    assert.ok(r.error, `phone ${JSON.stringify(bad)} was accepted`);
  }
  for (const good of ['5550100', '+1 (202) 555-0111', '+442071234567', '202.555.0111', '555030']) {
    const r = S.readContactFields({ name: 'Mum', phone: good, email: 'mum@example.com' });
    assert.ok(!r.error, `phone ${JSON.stringify(good)} was refused: ${r.error}`);
  }
});

test('contacts: a bad email still answers about the email, not the phone', () => {
  // Ordering. The email rules carry the messages that tell somebody what to fix
  // on the one field an alert actually uses; a phone check that answered first
  // would bury them.
  const r = S.readContactFields({ name: 'Mum', phone: '5550100', email: 'mum@example.invalid' });
  assert.match(r.error, /does not look right/);
  const long = S.readContactFields({ name: 'Mum', phone: '5550100', email: `${'a'.repeat(250)}@example.com` });
  assert.match(long.error, /too long/i);
});

test('contacts: the field limits agree with the column widths', () => {
  // The same drift as the CHECK constraints, one table over: a limit wider than
  // its column is a 22001 served as "Failed to add contact" on a safety screen.
  const widths = {
    name: 'contact_name', phone: 'contact_phone', email: 'contact_email', relationship: 'relationship',
  };
  const table = (() => {
    for (const file of migrationFiles().reverse()) {
      const m = /CREATE TABLE IF NOT EXISTS trusted_contacts \(([\s\S]*?)\n\s*\);/i.exec(sqlBody(file));
      if (m) return m[1];
    }
    return null;
  })();
  assert.ok(table, 'trusted_contacts DDL not found in the migrations');
  for (const column of Object.values(widths)) assertColumnNeverRetyped('trusted_contacts', column);
  for (const [field, column] of Object.entries(widths)) {
    const w = new RegExp(`${column}\\s+VARCHAR\\((\\d+)\\)`, 'i').exec(table);
    assert.ok(w, `${column} width not found`);
    assert.ok(S.FIELD_LIMITS[field] <= Number(w[1]),
      `FIELD_LIMITS.${field} (${S.FIELD_LIMITS[field]}) is wider than ${column} VARCHAR(${w[1]})`);
  }
});

test('contacts: a phone that already belongs to another contact is a 409, not a 500', async () => {
  // POST carries ON CONFLICT (user_id, contact_phone); PUT did not, so editing
  // one contact's number to match another's raised 23505 and came back as
  // "Failed to update contact" — a safety screen reporting that the app is
  // broken when the real answer is one the user can act on.
  S.resetContactWrites();
  const { restore } = stubPool(async (sql) => {
    if (sql.includes('UPDATE trusted_contacts')) {
      const err = new Error('duplicate key value violates unique constraint');
      err.code = '23505';
      throw err;
    }
    return null;
  });
  const cap = captureConsole();
  try {
    const res = await call(safetyRoutes, 'PUT', '/api/contacts/3', {
      name: 'Mum', phone: '5550100', email: 'mum@example.com',
    });
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
    assert.match(res.body.error, /already/i);
  } finally { cap.restore(); restore(); S.resetContactWrites(); }
});

test('contacts: at the cap, re-saving a number already on the list still updates it', async () => {
  // The refusal this closes is the one that stops the exact repair /alert tells
  // an unreachable user to make. Five contacts, one of them with a dead
  // address, and the add form answering "You can have up to 5 trusted contacts"
  // for a write that the very next statement would have resolved as an UPDATE.
  S.resetContactWrites();
  const { calls, restore } = stubPool(async (sql) => {
    if (sql.includes('SELECT COUNT(*)::int AS n FROM trusted_contacts')) {
      // Four OTHER contacts; the fifth is the one being re-saved.
      return { rows: [{ n: 4 }] };
    }
    if (sql.includes('INSERT INTO trusted_contacts')) {
      return { rows: [{ id: 5, contact_name: 'Mum' }], rowCount: 1 };
    }
    return null;
  });
  try {
    const res = await call(safetyRoutes, 'POST', '/api/contacts', {
      name: 'Mum', phone: '5550100', email: 'mum@example.com',
    });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const count = ran(calls, 'SELECT COUNT(*)::int AS n FROM trusted_contacts')[0];
    assert.ok(count.text.includes('contact_phone IS DISTINCT FROM $2'),
      'the cap must count the rows this write will not touch');
    assert.strictEqual(count.params[1], '5550100');
    assert.strictEqual(ran(calls, 'INSERT INTO trusted_contacts').length, 1);
  } finally { restore(); S.resetContactWrites(); }
});

test('contacts: a sixth person is still refused', async () => {
  S.resetContactWrites();
  const { calls, restore } = stubPool(async (sql) => {
    if (sql.includes('SELECT COUNT(*)::int AS n FROM trusted_contacts')) return { rows: [{ n: 5 }] };
    return null;
  });
  try {
    const res = await call(safetyRoutes, 'POST', '/api/contacts', {
      name: 'New', phone: '5559999', email: 'new@example.com',
    });
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    assert.match(res.body.error, /up to 5/);
    assert.strictEqual(ran(calls, 'INSERT INTO trusted_contacts').length, 0);
  } finally { restore(); S.resetContactWrites(); }
});

test('contacts: a control character in the middle of a phone number is not stored', () => {
  // Trimming settles the ends; a newline in the MIDDLE survived it.
  for (const bad of ['555\n0100', '555\t0100', '555\r0100']) {
    assert.ok(S.phoneError(bad), `phone ${JSON.stringify(bad)} was accepted`);
  }
});

test('contacts: email stays mandatory, because it is the only channel there is', () => {
  const r = S.readContactFields({ name: 'Mum', phone: '5550100' });
  assert.match(r.error, /email address is required/i);
  for (const bad of ['a@b.co,x@y.co', 'Mum<a@b.co>', 'mum@example.invalid', 'nope']) {
    assert.ok(S.readContactFields({ name: 'Mum', phone: '5550100', email: bad }).error, bad);
  }
});
