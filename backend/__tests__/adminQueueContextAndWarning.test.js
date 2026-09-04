// Run: node --test  (from backend/)
//
// ROUND 25. THE MODERATION CONSOLE, WALKED RATHER THAN READ.
//
// Four things this file pins, all of them found by following one report from
// the tap that files it to the click that closes it:
//
//   1. TEN REPORTS, ONE MESSAGE. routes/moderation.js dedupes per REPORTER and
//      not per content, deliberately, so ten people reporting one message is
//      ten rows in the queue. Nothing told the moderator that, and nothing
//      closed the other nine when the content came down: each of those cards
//      was left with Dismiss as its only legal move, one click at a time. A
//      takedown now closes them in the SAME transaction, one direction only,
//      and the response says how many.
//   2. THE CARD HAD NO MEMORY. No count of who else is waiting on this content,
//      no count of what this account has already been reported for, no record
//      of what was decided last time, and no name against a report somebody had
//      already handled. Every one of those changes the decision, and every one
//      of them was a psql prompt away.
//   3. CHILD SAFETY LOOKED LIKE SPAM. services/moderationAlerts.js has always
//      given a 'sexual' report its own subject line and its own log token, and
//      the queue rendered it as an ordinary row beside the buttons
//      MODERATION-LEGAL.md § 4 step 2 says not to press yet. The flag is
//      derived from the alert path's own function so the two cannot drift.
//   4. THERE WAS NO MIDDLE RUNG. 'user_warned' has been a legal value in the
//      moderation_actions CHECK since migration 001 and nothing ever wrote one:
//      the only account-level outcomes were "leave it" and "banned forever", on
//      an app whose floor is 13. Warn sends a real email, BEFORE anything is
//      written, and refuses the whole action if it cannot be delivered so no
//      audit row ever claims a warning nobody received.
//
// Harness: scripted pg fake, same shape as adminEvidence.test.js.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

process.env.JWT_SECRET = 'admin-queue-context-test-secret';

const pool = require('../config/database');

let handlers = [];
let log = [];

function dispatch(sql, params) {
  log.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
  for (const [re, fn] of handlers) {
    if (re.test(String(sql).replace(/\s+/g, ' '))) {
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

const authMod = require('../middleware/auth');
let CURRENT_USER = { id: 9, name: 'Mod', role: 'admin' };
authMod.authenticate = (req, _res, next) => { req.user = CURRENT_USER; next(); };

// The warning email is the only network leg on this router. Replaced on the
// module object, not destructured, because routes/admin.js holds the module for
// exactly this reason.
const emailService = require('../services/emailService');
const realSendEmail = emailService.sendEmail;
let mail = [];
let mailResult = { sent: true, id: 'test-message-id' };
emailService.sendEmail = async (args) => { mail.push(args); return mailResult; };
test.after(() => { emailService.sendEmail = realSendEmail; });

const adminRouter = require('../routes/admin');

const app = express();
app.use(express.json());
app.set('io', { to: () => ({ emit: () => {} }), in: () => ({ disconnectSockets: () => {} }) });
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
  mail = [];
  mailResult = { sent: true, id: 'test-message-id' };
  CURRENT_USER = { id: 9, name: 'Mod', role: 'admin' };
});

async function call(method, p, body) {
  const res = await fetch(base + p, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, body: json, text };
}

const ran = (re) => log.filter((q) => re.test(q.sql));
const ADMIN_SRC = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin.js'), 'utf8');
const CONSOLE_SRC = fs.readFileSync(
  path.join(__dirname, '..', '..', 'frontend', 'src', 'website', 'ModerationDashboard.js'), 'utf8'
);

function reportRow(over = {}) {
  return {
    id: 7,
    reporter_id: 1,
    reported_user_id: 3,
    content_type: 'flock_message',
    content_id: 55,
    reason: 'harassment',
    status: 'open',
    ...over,
  };
}
const reportLookup = (row) => [/SELECT \* FROM content_reports WHERE id/, () => ({ rows: row ? [row] : [], rowCount: row ? 1 : 0 })];
// The primary resolution and the sibling sweep are two different statements
// against the same table, so they are scripted apart on purpose: a test that
// cannot tell them apart is a test that would not have caught the ordering.
const resolvePrimary = [/UPDATE content_reports SET status = \$1/, () => ({ rows: [], rowCount: 1 })];
const sweepSiblings = (n) => [/UPDATE content_reports SET status = 'resolved'/, () => ({ rows: [], rowCount: n })];
const auditInsert = [/INSERT INTO moderation_actions/, () => ({ rows: [{ id: 1 }], rowCount: 1 })];
// The live-retraction fan-out, which runs after COMMIT and is not what any of
// these tests are about. Scripted so a takedown test does not print a socket
// failure that looks like a defect.
const flockFanout = [/SELECT user_id FROM flock_members/, () => ({ rows: [], rowCount: 0 })];
const queueHandlers = (rows) => [
  [/FROM content_reports r/, () => ({ rows, rowCount: rows.length })],
  [/SELECT status, COUNT/, () => ({ rows: [{ status: 'open', count: rows.length }] })],
];

// ===========================================================================
// 1. What the card now knows
// ===========================================================================

test('the queue asks how many people are waiting on this same content', async () => {
  handlers = queueHandlers([]);
  await call('GET', '/api/admin/reports');
  const q = ran(/FROM content_reports r/)[0].sql;
  assert.match(q, /content_open_reports/, 'the duplicate count is not asked for');
  assert.match(
    q,
    /FROM content_reports dup WHERE r\.content_id IS NOT NULL AND dup\.content_type = r\.content_type AND dup\.content_id = r\.content_id AND dup\.status IN \('open', 'under_review'\)/,
    'the duplicate count must key on the CONTENT and must not group every report that names no content',
  );
});

test('the queue asks what this account has already been reported for, and what we did last time', async () => {
  handlers = queueHandlers([]);
  await call('GET', '/api/admin/reports');
  const q = ran(/FROM content_reports r/)[0].sql;
  assert.match(q, /AS user_total_reports/);
  assert.match(q, /pr\.reported_user_id = r\.reported_user_id AND pr\.id <> r\.id/,
    'the account record must exclude the report being looked at');
  assert.match(q, /prior\.action AS user_last_action/);
  assert.match(q, /ma\.action <> 'evidence_viewed'/,
    "a record of a moderator READING is not what we did last time");
  assert.match(q, /ma\.report_id IS DISTINCT FROM r\.id/,
    'the last action must not be the one this very report produced');
});

test('the queue names who already handled a report', async () => {
  handlers = queueHandlers([]);
  await call('GET', '/api/admin/reports');
  const q = ran(/FROM content_reports r/)[0].sql;
  assert.match(q, /LEFT JOIN users hb ON hb\.id = r\.handled_by/);
  assert.match(q, /hb\.name AS handled_by_name/);
});

test('every added column is NULL-guarded on the id it keys off', () => {
  // A profile report carries no content_id and a guest RSVP report carries no
  // account. Without the guards, every one of them would group with every
  // other one and the card would announce a crowd that does not exist.
  assert.match(ADMIN_SRC, /WHERE r\.content_id IS NOT NULL\s+AND dup\.content_type/);
  assert.match(ADMIN_SRC, /WHERE r\.reported_user_id IS NOT NULL\s+AND pr\.reported_user_id/);
  assert.match(ADMIN_SRC, /WHERE r\.reported_user_id IS NOT NULL\s+AND ma\.target_user_id/);
});

test('the console renders the record and does not invent one the server did not send', () => {
  assert.match(CONSOLE_SRC, /content_open_reports/);
  assert.match(CONSOLE_SRC, /user_total_reports/);
  assert.match(CONSOLE_SRC, /user_last_action/);
  assert.match(CONSOLE_SRC, /handled_by_name/);
  assert.match(CONSOLE_SRC, /Already handled by/);
  // The whole block is withheld when there is nothing true to say, rather than
  // printing a confident "0 earlier reports" a server too old to send the
  // columns never actually measured.
  assert.match(CONSOLE_SRC, /if \(dup < 2 && prior === 0 && !lastAction && !handled\) return null;/);
});

// ===========================================================================
// 2. Ten reports, one message
// ===========================================================================

test('hiding content closes the other open reports about that same content', async () => {
  handlers = [
    reportLookup(reportRow()),
    [/UPDATE messages SET is_hidden/, () => ({ rows: [{ flock_id: 8, notify_a: null, notify_b: null, place_id: null }], rowCount: 1 })],
    resolvePrimary,
    sweepSiblings(9),
    auditInsert,
    flockFanout,
  ];
  const res = await call('PUT', '/api/admin/reports/7', { action: 'hide' });
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(res.body.alsoResolved, 9, 'the moderator is not told what the click did');
  const sweep = ran(/UPDATE content_reports SET status = 'resolved'/);
  assert.strictEqual(sweep.length, 1);
  assert.deepStrictEqual(sweep[0].params, [9, 'flock_message', 55, 7],
    'the sweep must be keyed on the content, carry the acting moderator, and never touch the report in the URL');
  assert.match(sweep[0].sql, /status IN \('open', 'under_review'\)/,
    'a sweep that reopens or rewrites finished reports is not a sweep');
});

test('the sweep is inside the same transaction as the takedown, and after this report\'s own resolution', async () => {
  handlers = [
    reportLookup(reportRow()),
    [/UPDATE messages SET is_hidden/, () => ({ rows: [{ flock_id: 8, notify_a: null, notify_b: null, place_id: null }], rowCount: 1 })],
    resolvePrimary,
    sweepSiblings(2),
    auditInsert,
    flockFanout,
  ];
  await call('PUT', '/api/admin/reports/7', { action: 'hide' });
  const order = log.map((q) => q.sql);
  const at = (re) => order.findIndex((sql) => re.test(sql));
  assert.ok(at(/^BEGIN/) >= 0 && at(/^COMMIT/) > at(/^BEGIN/), 'no transaction');
  assert.ok(at(/UPDATE content_reports SET status = 'resolved'/) > at(/^BEGIN/), 'the sweep escaped the transaction');
  assert.ok(at(/UPDATE content_reports SET status = 'resolved'/) < at(/^COMMIT/), 'the sweep escaped the transaction');
  assert.ok(
    at(/UPDATE content_reports SET status = \$1/) < at(/UPDATE content_reports SET status = 'resolved'/),
    "this report's own resolution must be the first content_reports write, so nothing reading the log confuses the two",
  );
});

test('a takedown that changed nothing sweeps nothing', async () => {
  handlers = [
    reportLookup(reportRow()),
    [/UPDATE messages SET is_hidden/, () => ({ rows: [], rowCount: 0 })],
  ];
  const res = await call('PUT', '/api/admin/reports/7', { action: 'hide' });
  assert.strictEqual(res.status, 404, res.text);
  assert.strictEqual(ran(/UPDATE content_reports SET status/).length, 0);
});

test('putting content back does NOT reopen the reports the takedown closed', async () => {
  handlers = [
    reportLookup(reportRow({ status: 'resolved' })),
    [/UPDATE messages SET is_hidden/, () => ({ rows: [{ flock_id: 8, notify_a: null, notify_b: null, place_id: null }], rowCount: 1 })],
    resolvePrimary,
    auditInsert,
    flockFanout,
  ];
  const res = await call('PUT', '/api/admin/reports/7', { action: 'unhide' });
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(res.body.alsoResolved, 0);
  assert.strictEqual(ran(/UPDATE content_reports SET status = 'resolved'/).length, 0,
    'an un-hide that quietly pushes two hundred rows back into the queue is a second surprise');
});

test('a ban does not close other reports: they may be about content still up', async () => {
  handlers = [
    reportLookup(reportRow()),
    [/UPDATE users SET is_banned = true/, () => ({ rows: [], rowCount: 1 })],
    resolvePrimary,
    auditInsert,
  ];
  const res = await call('PUT', '/api/admin/reports/7', { action: 'ban' });
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(ran(/UPDATE content_reports SET status = 'resolved'/).length, 0);
});

// ===========================================================================
// 3. Child safety is not one more row
// ===========================================================================

test('the queue flags a child-safety report, using the alert path\'s own rule', async () => {
  handlers = queueHandlers([
    { id: 1, reason: 'sexual', status: 'open' },
    { id: 2, reason: 'spam', status: 'open' },
    { id: 3, reason: 'harassment', status: 'open' },
  ]);
  const res = await call('GET', '/api/admin/reports');
  assert.strictEqual(res.status, 200, res.text);
  assert.deepStrictEqual(res.body.reports.map((r) => r.child_safety), [true, false, false]);
});

test('a date of birth never leaves the server, only the answer to the question does', async () => {
  handlers = queueHandlers([
    { id: 1, reason: 'sexual', status: 'open', reported_user_dob: '2013-01-01', reporter_dob: '1990-01-01' },
    { id: 2, reason: 'sexual', status: 'open', reported_user_dob: '1990-01-01', reporter_dob: '2013-01-01' },
    { id: 3, reason: 'sexual', status: 'open', reported_user_dob: null, reporter_dob: null },
  ]);
  const res = await call('GET', '/api/admin/reports');
  assert.strictEqual(res.status, 200, res.text);
  const q = ran(/FROM content_reports r/)[0].sql;
  assert.match(q, /tu\.date_of_birth AS reported_user_dob/);
  assert.match(q, /ru\.date_of_birth AS reporter_dob/);
  assert.deepStrictEqual(res.body.reports.map((r) => r.reported_user_is_minor), [true, false, null]);
  assert.deepStrictEqual(res.body.reports.map((r) => r.reporter_is_minor), [false, true, null]);
  for (const r of res.body.reports) {
    assert.ok(!('reported_user_dob' in r), 'a birthday reached the console');
    assert.ok(!('reporter_dob' in r), 'a birthday reached the console');
  }
  // Not a second copy of the age arithmetic: the signup gate owns it.
  assert.match(ADMIN_SRC, /require\('\.\.\/utils\/age'\)/);
});

test('the flag comes from services/moderationAlerts.js and is not a second copy of the list', () => {
  assert.match(ADMIN_SRC, /require\('\.\.\/services\/moderationAlerts'\)/);
  assert.match(ADMIN_SRC, /isChildSafetyReason\(row\.reason\)/);
  const alerts = require('../services/moderationAlerts');
  assert.strictEqual(typeof alerts.isChildSafetyReason, 'function',
    'the queue depends on this export; it is not a test seam');
  assert.strictEqual(alerts.isChildSafetyReason('sexual'), true);
  assert.strictEqual(alerts.isChildSafetyReason('spam'), false);
});

test('the console tells the moderator to preserve before acting, and names the runbook', () => {
  assert.match(CONSOLE_SRC, /child_safety/);
  assert.match(CONSOLE_SRC, /Preserve the evidence before you act/);
  assert.match(CONSOLE_SRC, /MODERATION-LEGAL\.md/);
  assert.ok(fs.existsSync(path.join(__dirname, '..', '..', 'MODERATION-LEGAL.md')),
    'the console points at a runbook that has to exist');
  // Above the buttons, not in the header: it is an instruction to read before
  // pressing, and a card header is the part nobody reads twice.
  assert.ok(
    CONSOLE_SRC.indexOf('Preserve the evidence before you act') < CONSOLE_SRC.indexOf("act(r, 'hide')"),
    'the notice must be rendered before the controls it is about',
  );
});

// ===========================================================================
// 4. The middle rung
// ===========================================================================

test('warning a user sends the email BEFORE anything is written', async () => {
  handlers = [
    reportLookup(reportRow()),
    [/SELECT id, name, email, is_banned FROM users/, () => ({ rows: [{ id: 3, name: 'Ada', email: 'ada@example.com', is_banned: false }], rowCount: 1 })],
    resolvePrimary,
    auditInsert,
  ];
  const res = await call('PUT', '/api/admin/reports/7', { action: 'warn', reason: 'first offence' });
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(res.body.action, 'user_warned');
  assert.strictEqual(res.body.status, 'resolved');
  assert.strictEqual(mail.length, 1);
  assert.strictEqual(mail[0].to, 'ada@example.com');
  assert.ok(mail[0].text.includes('warning'), 'the email has to say what it is');
  const audit = ran(/INSERT INTO moderation_actions/)[0];
  assert.strictEqual(audit.params[3], 'user_warned');
  assert.strictEqual(audit.params[1], 9, 'the moderator comes from the session');
  assert.strictEqual(audit.params[6], 'first offence');
});

test('a warning that could not be delivered records nothing at all', async () => {
  mailResult = { sent: false, error: 'provider down' };
  handlers = [
    reportLookup(reportRow()),
    [/SELECT id, name, email, is_banned FROM users/, () => ({ rows: [{ id: 3, name: 'Ada', email: 'ada@example.com', is_banned: false }], rowCount: 1 })],
  ];
  const res = await call('PUT', '/api/admin/reports/7', { action: 'warn' });
  assert.strictEqual(res.status, 502, res.text);
  assert.match(res.body.error, /could not be sent/);
  assert.match(res.body.error, /ban the account/, 'a refusal has to name what the moderator can do instead');
  assert.strictEqual(ran(/INSERT INTO moderation_actions/).length, 0,
    'an audit row claiming a warning nobody received is worse than no warning');
  assert.strictEqual(ran(/UPDATE content_reports SET status/).length, 0);
});

test('a warning is refused where there is nobody to send one to, and nothing is mailed', async () => {
  const cases = [
    {
      what: 'no user named',
      row: reportRow({ reported_user_id: null }),
      user: null,
      status: 400,
      match: /nobody to warn/,
    },
    {
      what: 'the account is gone',
      row: reportRow(),
      user: undefined,
      status: 404,
      match: /no longer exists/,
    },
    {
      what: 'already banned',
      row: reportRow(),
      user: { id: 3, name: 'Ada', email: 'ada@example.com', is_banned: true },
      status: 409,
      match: /already banned/,
    },
    {
      what: 'an address nothing can be delivered to',
      row: reportRow(),
      user: { id: 3, name: 'Ada', email: 'x@apple-signin.invalid', is_banned: false },
      status: 409,
      match: /no address/,
    },
  ];
  for (const c of cases) {
    handlers = [
      reportLookup(c.row),
      [/SELECT id, name, email, is_banned FROM users/, () => ({ rows: c.user ? [c.user] : [], rowCount: c.user ? 1 : 0 })],
    ];
    log = [];
    mail = [];
    const res = await call('PUT', '/api/admin/reports/7', { action: 'warn' });
    assert.strictEqual(res.status, c.status, `${c.what}: ${res.text}`);
    assert.match(res.body.error, c.match, c.what);
    assert.strictEqual(mail.length, 0, `${c.what}: an email went out anyway`);
    assert.strictEqual(ran(/INSERT INTO moderation_actions/).length, 0, c.what);
  }
});

test("'user_warned' is a value the database already allows, so no migration is owed", () => {
  const migrations = fs.readdirSync(path.join(__dirname, '..', 'migrations'))
    .filter((f) => f.endsWith('.sql'))
    .map((f) => fs.readFileSync(path.join(__dirname, '..', 'migrations', f), 'utf8'))
    .join('\n');
  // 001 wrote it into the original CHECK and 020 carried it forward. The rule
  // this file inherits from migration 017 is that a route widening a value set
  // owes a migration in the same commit; here the constraint was already ahead
  // of the code, which is the rarer and quieter version of the same drift.
  assert.match(migrations, /'user_warned'/);
  assert.match(ADMIN_SRC, /actionType = 'user_warned'/);
});

test('the console offers Warn, says it sends an email, and never offers it on a banned account', () => {
  assert.match(CONSOLE_SRC, /act\(r, 'warn'\)/);
  assert.match(CONSOLE_SRC, /Warn user/);
  assert.match(CONSOLE_SRC, /Email a warning to/,
    'the confirm has to say what actually happens, because what happens is an email');
  assert.match(CONSOLE_SRC, /const canWarn = canBan && !r\.reported_user_banned && r\.reported_user_mailable !== false;/);
  assert.match(CONSOLE_SRC, /user_warned: 'User warned'/,
    'an action the audit log cannot name renders as a shrugged "user warned"');
});
