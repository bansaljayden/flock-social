// Run: node --test  (from backend/)
//
// A CRASH REPORT THE PERSON CHOSE TO SEND, AND NOTHING ELSE.
//
// The crash screen's "Send this to Flock" button posts here. What is pinned:
//
//   1. a report is stored once per crash shape per day, scrubbed, with no
//      account, address or device attached, whatever the request carries;
//   2. the first report of a shape each day is mailed, through the ops ledger,
//      and repeats only count;
//   3. an open endpoint that writes and mails is bounded: 4KB, a closed shape
//      for every field, 200 new shapes a day, 10 emails a day;
//   4. it is mounted where a signed-out phone can reach it.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const express = require('express');

process.env.JWT_SECRET = 'client-crash-test-secret';

const pool = require('../config/database');

// client_crash_reports for today, emulated with the statement's own rules.
const table = new Map(); // fingerprint -> row
let inserts = [];
let prunes = 0;
let dbError = null;
pool.query = async (sql, params = []) => {
  if (dbError) throw dbError;
  const flat = String(sql).replace(/\s+/g, ' ');
  if (/INSERT INTO client_crash_reports/.test(flat)) {
    const [fingerprint, boundary, name, message, components, build, platform, cap] = params;
    inserts.push({ sql: flat, params });
    const row = table.get(fingerprint);
    if (row) { row.reports += 1; return { rows: [{ reports: row.reports, inserted: false }] }; }
    if (table.size >= cap) return { rows: [] };
    table.set(fingerprint, { fingerprint, boundary, name, message, components, build, platform, reports: 1 });
    return { rows: [{ reports: 1, inserted: true }] };
  }
  if (/SELECT COUNT\(\*\)::int AS n FROM client_crash_reports/.test(flat)) return { rows: [{ n: table.size }] };
  if (/DELETE FROM client_crash_reports/.test(flat)) { prunes += 1; return { rows: [] }; }
  return { rows: [] };
};

const opsAlertModule = require('../services/opsAlert');
let alerts = [];
opsAlertModule.opsAlert = async (a) => { alerts.push(a); return { sent: true, legs: ['email'] }; };

const clientCrash = require('../routes/clientCrash');
const { MAX_BODY_BYTES, MAX_NEW_ROWS_PER_DAY, MAX_EMAILS_PER_DAY } = clientCrash.__test;

const app = express();
app.use(express.json({ limit: 64 * 1024 }));
app.use('/api/client-crash', clientCrash);
const server = http.createServer(app);
let base;
test.before(() => new Promise((r) => server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; r(); })));
test.after(() => new Promise((r) => server.close(() => r())));

const realError = console.error;
test.before(() => { console.error = () => {}; });
test.after(() => { console.error = realError; });

function reset() {
  table.clear();
  inserts = [];
  alerts = [];
  prunes = 0;
  dbError = null;
}

async function post(bodyObj, headers = {}) {
  const res = await fetch(`${base}/api/client-crash`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof bodyObj === 'string' ? bodyObj : JSON.stringify(bodyObj),
  });
  let json = null;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, body: json };
}

const REPORT = {
  boundary: 'screen',
  name: 'TypeError',
  message: 'Cannot read properties of undefined (reading \'votes\')',
  components: ['FlockChat', 'ScreenSlot', 'FlockAppInner'],
  build: 'a1b2c3d4',
  platform: 'native',
};

// The alert is sent after the answer, so give it a moment.
const settle = () => new Promise((r) => setTimeout(r, 20));

test('a report is stored, answered 201, and carries nothing that names a person', async () => {
  reset();
  const out = await post(REPORT, { authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJpZCI6NDJ9.abcdefghijk' });
  assert.strictEqual(out.status, 201);
  assert.deepStrictEqual(out.body, { ok: true });
  assert.strictEqual(table.size, 1);
  const row = [...table.values()][0];
  assert.deepStrictEqual(row.components, REPORT.components);
  assert.strictEqual(row.platform, 'native');
  // Seven values and the cap: no user id, no address, no user agent.
  assert.strictEqual(inserts[0].params.length, 8);
  assert.doesNotMatch(JSON.stringify(inserts[0].params), /42|127\.0\.0\.1|Bearer/);
});

test('the message is scrubbed on the server too, and clamped', async () => {
  reset();
  await post({
    ...REPORT,
    message: 'Failed for ava@example.com at 40.6084,-75.4902 fetching https://api.flockcorp.com/api/weather?lat=40.6&lon=-75.4 on /i/AbCdEf123 with eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signaturepart '.repeat(3),
  });
  const { message } = [...table.values()][0];
  assert.ok(message.length <= 200);
  assert.doesNotMatch(message, /ava@example\.com|40\.6084|lat=|AbCdEf123|eyJhbGci/);
  assert.match(message, /\[email\]/);
  assert.match(message, /https:\/\/api\.flockcorp\.com\/api\/weather/);
});

test('the first report of a crash each day is mailed once; repeats only count', async () => {
  reset();
  await post(REPORT);
  await post(REPORT);
  await post({ ...REPORT, message: 'the same crash, a different message' });
  await settle();
  assert.strictEqual(table.size, 1, 'one row per crash shape per day');
  assert.strictEqual([...table.values()][0].reports, 3);
  assert.strictEqual(alerts.length, 1);
  const a = alerts[0];
  assert.match(a.key, /^client_crash_[0-9a-f]{32}$/);
  assert.deepStrictEqual(a.legs, ['email']);
  assert.match(a.subject, /phone app: TypeError/);
  assert.match(a.text, /FlockChat < ScreenSlot < FlockAppInner/);
  assert.match(a.text, /No account is attached/);
  assert.doesNotMatch(`${a.subject}\n${a.text}`, /—/, 'no em dashes in copy a person reads');
});

test('a different boundary, error or top component is a different crash', async () => {
  reset();
  await post(REPORT);
  await post({ ...REPORT, boundary: 'root' });
  await post({ ...REPORT, name: 'ChunkLoadError' });
  await post({ ...REPORT, components: ['DiscoverLayer'] });
  await post({ ...REPORT, components: [...REPORT.components.slice(0, 1), 'Other'] });
  assert.strictEqual(table.size, 4, 'only the top component is part of the shape');
});

test('every field has a closed shape', async () => {
  reset();
  for (const bad of [
    { ...REPORT, platform: 'android' },
    { ...REPORT, name: 'Type Error<script>' },
    { ...REPORT, boundary: '' },
    { ...REPORT, boundary: 'x'.repeat(41) },
    { ...REPORT, components: ['has spaces in it'] },
    { ...REPORT, components: Array.from({ length: 9 }, (_, i) => `C${i}`) },
    { ...REPORT, build: 'not/a/build' },
    { ...REPORT, message: 42 },
  ]) {
    const out = await post(bad);
    assert.strictEqual(out.status, 400, JSON.stringify(bad));
  }
  assert.strictEqual(table.size, 0);
});

test('a body over 4KB is refused before anything is read', async () => {
  reset();
  const out = await post({ ...REPORT, message: 'x'.repeat(MAX_BODY_BYTES) });
  assert.strictEqual(out.status, 413);
  assert.strictEqual(inserts.length, 0);
});

test('new crash shapes stop at the daily cap; one already seen is still counted', async () => {
  reset();
  assert.strictEqual((await post(REPORT)).status, 201);
  for (let i = 1; i < MAX_NEW_ROWS_PER_DAY; i += 1) {
    table.set(`seed${i}`, { reports: 1 });
  }
  const fresh = await post({ ...REPORT, name: 'RangeError' });
  assert.strictEqual(fresh.status, 429);
  assert.match(fresh.body.error, /not saved/);
  assert.strictEqual(table.size, MAX_NEW_ROWS_PER_DAY);
  const again = await post(REPORT);
  assert.strictEqual(again.status, 201, 'a crash already on today\'s list is always counted');
  const seen = [...table.values()].find((r) => r.name === 'TypeError');
  assert.strictEqual(seen.reports, 2);
});

test('only the first ten crash shapes a day are mailed', async () => {
  reset();
  for (let i = 0; i < MAX_EMAILS_PER_DAY + 5; i += 1) {
    await post({ ...REPORT, components: [`Screen${i}`] });
    await settle();
  }
  assert.strictEqual(alerts.length, MAX_EMAILS_PER_DAY);
});

test('old reports are deleted on a timer of their own, so the 90 days hold with no new reports', async () => {
  reset();
  await post(REPORT);
  await settle();
  assert.strictEqual(prunes, 0, 'a report never waits on, or triggers, the delete');
  await clientCrash.pruneCrashReports();
  assert.strictEqual(prunes, 1);
  assert.strictEqual(clientCrash.RETENTION_DAYS, 90);
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(src, /crashReportPruneInterval = setInterval\(crashPrune, 60 \* 60 \* 1000\);/);
  const shutdown = /function shutdown\(signal\) \{([\s\S]*?)\n\}/.exec(src)[1];
  assert.match(shutdown, /clearInterval\(crashReportPruneInterval\)/);
});

test('a database failure is a 500 with a plain sentence', async () => {
  reset();
  dbError = new Error('connection terminated');
  const out = await post(REPORT);
  assert.strictEqual(out.status, 500);
  assert.strictEqual(out.body.error, 'That report could not be saved.');
});

test('the route never reads who sent it', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'clientCrash.js'), 'utf8');
  const code = src.replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /req\.user|authorization|req\.ip\b|user-agent|authenticate/i);
});

test('server.js mounts it with its own limiter, before the catch-alls that demand a session', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8').replace(/\r\n/g, '\n');
  const mount = src.indexOf("app.use('/api/client-crash', clientCrashLimiter, require('./routes/clientCrash'));");
  assert.ok(mount > 0);
  assert.ok(mount < src.indexOf("app.use('/api', apiLimiter, moderationRoutes);"));
  assert.match(src, /const clientCrashLimiter = isDev \? \(_req, _res, next\) => next\(\) : rateLimit\(\{\n {2}windowMs: 60 \* 60 \* 1000,\n {2}max: 10,/);
});

test('the migration is additive and keyed one row per shape per day', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '101_client_crash_reports.sql'), 'utf8');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS client_crash_reports/);
  assert.match(sql, /UNIQUE \(fingerprint, seen_on\)/);
  assert.match(sql, /-- @requires table client_crash_reports/);
  assert.doesNotMatch(sql.replace(/^--.*$/gm, ''), /user_id|ip_address|device/i, 'no column that could name a person');
  // eslint-disable-next-line no-control-regex
  assert.doesNotMatch(sql, /[^\x00-\x7F]/, 'ASCII only: the boot-safety server is WIN1252');
});
