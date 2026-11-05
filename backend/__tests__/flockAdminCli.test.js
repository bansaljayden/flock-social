'use strict';
// Run: node --test  (from backend/)
//
// tools/flock-admin/admin.mjs, THE ADMIN ROUTES FROM A TERMINAL.
//
// The tool holds an admin access key, so what it must never do matters as
// much as what it does: print the key, send it anywhere but the API over
// https (or plain http to this machine), reach a path outside /api/admin, or
// write anything without --yes. Each command runs here against a fake API on
// this machine that records every request, so "nothing was sent" is a list of
// requests that is empty, not a claim.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Readable } = require('node:stream');
const { pathToFileURL } = require('node:url');

const CLI = path.join(__dirname, '..', '..', 'tools', 'flock-admin', 'admin.mjs');

let cli;
let server;
let base;
let requests = [];
// What the fake API answers, by "METHOD /path". A function gets the request.
let routes = {};

// Built at run time from random bytes, so no key-shaped literal is in this file.
const KEY = `flk_admin_${crypto.randomBytes(32).toString('base64url')}`;
const SESSION = ['eyJhbGciOiJIUzI1NiJ9', Buffer.from(JSON.stringify({ userId: 1 })).toString('base64url'), 'c2lnbmF0dXJlc2lnbmF0dXJl'].join('.');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'flock-admin-cli-'));
const keyFile = path.join(tmp, 'secrets', 'flock-admin-key');

test.before(async () => {
  cli = await import(pathToFileURL(CLI).href);
  server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let json;
      try { json = body ? JSON.parse(body) : undefined; } catch { json = body; }
      const entry = { method: req.method, url: req.url, auth: req.headers.authorization, body: json, type: req.headers['content-type'] };
      requests.push(entry);
      const answer = routes[`${req.method} ${req.url}`];
      const out = typeof answer === 'function' ? answer(entry) : answer;
      if (!out) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Not found' }));
      }
      res.writeHead(out.status || 200, { 'Content-Type': 'application/json', ...(out.headers || {}) });
      return res.end(out.raw !== undefined ? out.raw : JSON.stringify(out.json));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((r) => server.close(r));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test.beforeEach(() => {
  requests = [];
  routes = {};
  fs.rmSync(keyFile, { force: true });
});

// Runs the tool in this process. `key: true` writes the key file first;
// `key: false` leaves the key file as it is.
async function run(args, { key = true, stdin = null, env = {}, pollMs } = {}) {
  if (key) cli.writeKeyFile(keyFile, KEY, { replace: true });
  let out = '';
  let err = '';
  const code = await cli.main(args, {
    env: { FLOCK_API_URL: base, FLOCK_ADMIN_KEY_FILE: keyFile, ...env },
    stdout: (s) => { out += s; },
    stderr: (s) => { err += s; },
    stdin,
    pollMs,
  });
  const all = out + err;
  assert.ok(!all.includes(KEY) && !all.includes(KEY.slice(10, 40)), `the key was printed:\n${all}`);
  assert.ok(!all.includes(SESSION), `the session token was printed:\n${all}`);
  for (const r of requests) {
    if (r.url.startsWith('/api/admin/keys') && r.method === 'POST') continue;
    assert.strictEqual(r.auth, `Bearer ${KEY}`, `${r.method} ${r.url} went without the key, or with something else`);
  }
  return { code, out, err };
}

const sent = () => requests.map((r) => `${r.method} ${r.url}`);

const WHOAMI = {
  authVia: 'admin_key',
  user: { id: 1, name: 'Owner Admin', role: 'admin' },
  key: { id: 4, name: 'PC tools', scopes: ['admin'], createdAt: '2026-11-05T15:00:00.000Z', expiresAt: '2027-02-03T15:00:00.000Z', daysLeft: 89 },
};

const BILL = {
  id: 5, vendor: 'Example Host', product: 'Pro plan', category: 'Hosting', kind: 'infrastructure', amountCents: 2000,
  currency: 'USD', cadence: 'monthly', lastChargedOn: '2026-10-16', renewsOn: '2026-11-16', active: true, verified: true,
  note: null, replacesLine: null, isCredit: false, endsOn: null, updatedAt: '2026-10-16T12:00:00.000Z',
};

// ---------------------------------------------------------------------------
// The command line
// ---------------------------------------------------------------------------

test('arguments: positionals, --name value, --name=value, and the flags that take none', () => {
  assert.deepStrictEqual(cli.parseArgs(['expenses', 'stop', '5', '--yes']), { positionals: ['expenses', 'stop', '5'], flags: { yes: true } });
  assert.deepStrictEqual(
    cli.parseArgs(['expenses', 'add', '--vendor', 'Example Host', '--amount=12.34', '--kind', 'tooling', '--cadence', 'monthly', '--verified']).flags,
    { vendor: 'Example Host', amount: '12.34', kind: 'tooling', cadence: 'monthly', verified: true }
  );
  assert.deepStrictEqual(cli.parseArgs(['get', '--', '--odd']).positionals, ['get', '--odd']);
  for (const bad of [['--yes=1'], ['--vendor'], ['--vendor', '--yes'], ['--bogus'], ['-y'], ['--name', 'a', '--name', 'b']]) {
    assert.throws(() => cli.parseArgs(bad), cli.UsageError, bad.join(' '));
  }
});

test('get reaches /api/admin and nothing else, and a query string is rebuilt from its parts', () => {
  assert.strictEqual(cli.adminPath('/api/admin/money'), '/api/admin/money');
  assert.strictEqual(cli.adminPath('/api/admin'), '/api/admin');
  assert.strictEqual(cli.adminPath('/api/admin/moderation-actions?include_evidence=true'), '/api/admin/moderation-actions?include_evidence=true');
  assert.strictEqual(cli.adminPath('/api/admin/money?refresh=1&x=a b'), '/api/admin/money?refresh=1&x=a+b');
  for (const bad of [
    '/api/users/me', '/api/admin/../users/me', '/api/adminx/money', 'api/admin/money', 'https://example.com/api/admin/money',
    '//example.com/api/admin', '/api/admin//money', '/api/admin/%2e%2e/users', '/api/admin/money/..', '', '   ', undefined,
  ]) {
    assert.throws(() => cli.adminPath(bad), cli.UsageError, String(bad));
  }
});

test('the key goes only to https, or to http on this machine, and only to an origin', () => {
  assert.strictEqual(cli.apiBase({}, {}), 'https://api.flockcorp.com');
  assert.strictEqual(cli.apiBase({ api: 'https://api.example.org' }, {}), 'https://api.example.org');
  assert.strictEqual(cli.apiBase({}, { FLOCK_API_URL: 'http://127.0.0.1:5000' }), 'http://127.0.0.1:5000');
  assert.strictEqual(cli.apiBase({ api: 'http://localhost:5000/' }, {}), 'http://localhost:5000');
  for (const bad of ['http://api.flockcorp.com', 'ftp://127.0.0.1', 'https://api.flockcorp.com/api', 'https://u:p@api.flockcorp.com', 'https://api.flockcorp.com/?x=1', 'not a url']) {
    assert.throws(() => cli.apiBase({ api: bad }, {}), cli.UsageError, bad);
  }
});

test('the key is read from FLOCK_ADMIN_KEY or the key file, however the file was written, and a bad one is never echoed', () => {
  assert.strictEqual(cli.readKey({ FLOCK_ADMIN_KEY: `  ${KEY}\n` }).key, KEY);
  const f = path.join(tmp, 'variants');
  for (const [label, bytes] of [
    ['utf8', Buffer.from(`${KEY}\r\n`)],
    ['utf8 with a BOM', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(KEY)])],
    ['utf16le, as PowerShell 5 writes with >', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`${KEY}\r\n`, 'utf16le')])],
  ]) {
    fs.writeFileSync(f, bytes);
    assert.strictEqual(cli.readKey({ FLOCK_ADMIN_KEY_FILE: f }).key, KEY, label);
  }
  fs.writeFileSync(f, 'flk_admin_short-and-wrong');
  assert.throws(() => cli.readKey({ FLOCK_ADMIN_KEY_FILE: f }), (e) => e instanceof cli.UsageError && !e.message.includes('short-and-wrong'));
  assert.throws(() => cli.readKey({ FLOCK_ADMIN_KEY: 'nope' }), (e) => e instanceof cli.UsageError && !e.message.includes('nope'));
  assert.throws(() => cli.readKey({ FLOCK_ADMIN_KEY_FILE: path.join(tmp, 'missing') }), /No admin key at/);
  fs.rmSync(f, { force: true });
});

test('the key file is written whole, kept from being overwritten by accident, and holds nothing but the key', () => {
  const f = path.join(tmp, 'nested', 'dir', 'flock-admin-key');
  cli.writeKeyFile(f, KEY);
  assert.strictEqual(fs.readFileSync(f, 'utf8'), `${KEY}\n`);
  assert.throws(() => cli.writeKeyFile(f, KEY), /already holds a key/);
  assert.throws(() => cli.writeKeyFile(f, 'not a key', { replace: true }), cli.UsageError);
  cli.writeKeyFile(f, KEY, { replace: true });
  assert.deepStrictEqual(fs.readdirSync(path.dirname(f)), ['flock-admin-key'], 'a temporary file was left behind');
  fs.rmSync(path.join(tmp, 'nested'), { recursive: true, force: true });
});

test('help, an unknown command and a missing key are answered without a request', async () => {
  assert.strictEqual((await run(['--help'])).code, cli.EXIT.ok);
  assert.strictEqual((await run([])).code, cli.EXIT.usage);
  assert.strictEqual((await run(['launch'])).code, cli.EXIT.usage);
  fs.rmSync(keyFile, { force: true });
  const nokey = await run(['status'], { key: false });
  assert.strictEqual(nokey.code, cli.EXIT.usage);
  assert.match(nokey.err, /No admin key at/);
  assert.deepStrictEqual(requests, []);
});

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

test('status says who the key acts as and when it expires', async () => {
  routes['GET /api/admin/whoami'] = { json: WHOAMI };
  const r = await run(['status']);
  assert.strictEqual(r.code, cli.EXIT.ok, r.err);
  assert.deepStrictEqual(sent(), ['GET /api/admin/whoami']);
  assert.match(r.out, /Admin key "PC tools" \(key 4\), acting as Owner Admin \(user 1, admin\)\./);
  assert.match(r.out, /expires Feb 3, 2027, in 89 days/);
  assert.ok(!/runs out soon/.test(r.out));
  routes['GET /api/admin/whoami'] = { json: { ...WHOAMI, key: { ...WHOAMI.key, daysLeft: 6 } } };
  assert.match((await run(['status'])).out, /It runs out soon/);
});

test('money prints the month as the dashboard words it: four figures, then what needs you', async () => {
  const words = await cli.loadHubWords();
  const hub = {
    generatedAt: '2026-11-05T19:04:00.000Z',
    month: { label: 'November 2026', dayOfMonth: 5, daysInMonth: 30 },
    net: { revenueThisMonthCents: 94407, costsThisMonthCents: 20844, netThisMonthCents: 73563, burnCents: 20844, revenueMissing: [], costsMissing: [], netMissing: [] },
    revenue: { stripe: { status: 'ok', mode: 'live', subscriptions: { status: 'ok' }, disputes: { status: 'ok', open: 1, openAmountCents: 1200, openOtherCurrency: 0 }, prices: { status: 'ok' } }, revenuecat: { status: 'not_connected' }, flags: {} },
    health: { collector: { status: 'ok', state: 'stopped', minutesSinceLatest: 400 } },
  };
  routes['GET /api/admin/money'] = { json: hub };
  const r = await run(['money']);
  assert.strictEqual(r.code, cli.EXIT.ok, r.err);
  assert.deepStrictEqual(sent(), ['GET /api/admin/money']);
  assert.match(r.out, /November 2026, day 5 of 30, New York time\./);
  for (const t of words.hubMonthTiles(hub)) {
    assert.ok(r.out.includes(t.label) && r.out.includes(t.value), `the ${t.label} tile is missing: ${t.value}`);
  }
  assert.match(r.out, /Money in\s+\$944\.07/);
  assert.match(r.out, /Profit or loss\s+\+\$735\.63/);
  const needs = words.hubAttention(hub).problems;
  assert.ok(needs.length >= 2);
  assert.match(r.out, new RegExp(`${needs.length} things need you:`));
  for (const p of needs) assert.ok(r.out.includes(`${p.label}: ${p.value}`), `missing: ${p.label}`);
  assert.match(r.out, /\[bad\]  ?Disputes to answer: 1/);

  const json = await run(['money', '--json']);
  const parsed = JSON.parse(json.out);
  assert.deepStrictEqual(parsed.tiles.map((t) => t.label), ['Money in', 'Costs', 'Profit or loss', 'Monthly bills']);
  assert.deepStrictEqual(parsed.needs.map((p) => p.key), needs.map((p) => p.key));
});

test('expenses list prints each bill on a line', async () => {
  routes['GET /api/admin/expenses'] = { json: { expenses: [BILL, { ...BILL, id: 6, vendor: 'Old Tool', product: null, active: false, renewsOn: null }], limit: 500 } };
  const r = await run(['expenses', 'list']);
  assert.strictEqual(r.code, cli.EXIT.ok, r.err);
  assert.match(r.out, /5\s+Example Host, Pro plan\s+\$20\.00 a month\s+running\s+renews Nov 16, 2026/);
  assert.match(r.out, /6\s+Old Tool\s+\$20\.00 a month\s+stopped/);
});

test('get prints the JSON of any /api/admin path, and refuses every other path before a request', async () => {
  routes['GET /api/admin/costs'] = { json: { fixed: { total: 1 } } };
  const r = await run(['get', '/api/admin/costs']);
  assert.strictEqual(r.code, cli.EXIT.ok);
  assert.deepStrictEqual(JSON.parse(r.out), { fixed: { total: 1 } });
  requests = [];
  for (const p of ['/api/users/me', '/api/flocks', '/api/admin/../auth/me']) {
    const refused = await run(['get', p]);
    assert.strictEqual(refused.code, cli.EXIT.usage, p);
  }
  assert.deepStrictEqual(requests, []);
});

test('a refusal from the API is said in its own words, with the key scrubbed out of anything it echoes', async () => {
  routes['GET /api/admin/whoami'] = { status: 401, json: { error: `This admin key was revoked. (${KEY})` } };
  const r = await run(['status']);
  assert.strictEqual(r.code, cli.EXIT.api);
  assert.match(r.err, /Refused \(401\): This admin key was revoked\. \(\[admin key\]\)/);
});

test('a redirect is never followed with the key', async () => {
  routes['GET /api/admin/whoami'] = { status: 302, headers: { Location: `${base}/elsewhere` }, raw: '' };
  routes['GET /elsewhere'] = { json: WHOAMI };
  const r = await run(['status']);
  assert.strictEqual(r.code, cli.EXIT.api);
  assert.deepStrictEqual(sent(), ['GET /api/admin/whoami']);
});

// ---------------------------------------------------------------------------
// Writing: nothing without --yes
// ---------------------------------------------------------------------------

test('expenses stop reads the bill, says what it would do, and changes nothing without --yes', async () => {
  routes['GET /api/admin/expenses'] = { json: { expenses: [BILL] } };
  const dry = await run(['expenses', 'stop', '5']);
  assert.strictEqual(dry.code, cli.EXIT.confirm);
  assert.match(dry.err, /Would mark bill 5 \(Example Host, Pro plan\) as no longer charged\. Nothing was sent\./);
  assert.deepStrictEqual(sent(), ['GET /api/admin/expenses']);

  requests = [];
  routes['PUT /api/admin/expenses/5'] = (req) => ({ json: { success: true, expense: { ...BILL, ...req.body } } });
  const done = await run(['expenses', 'stop', '5', '--yes']);
  assert.strictEqual(done.code, cli.EXIT.ok, done.err);
  assert.deepStrictEqual(sent(), ['GET /api/admin/expenses', 'PUT /api/admin/expenses/5']);
  const { id, updatedAt, ...row } = BILL;
  assert.deepStrictEqual(requests[1].body, { ...row, active: false }, 'the whole row goes back, as the dashboard sends it, with active false');
  assert.strictEqual(requests[1].type, 'application/json');
});

test('expenses stop on a bill already stopped, or not on the list, writes nothing', async () => {
  routes['GET /api/admin/expenses'] = { json: { expenses: [{ ...BILL, active: false }] } };
  assert.strictEqual((await run(['expenses', 'stop', '5', '--yes'])).code, cli.EXIT.ok);
  assert.strictEqual((await run(['expenses', 'stop', '9', '--yes'])).code, cli.EXIT.api);
  assert.strictEqual((await run(['expenses', 'stop', 'abc', '--yes'])).code, cli.EXIT.usage);
  assert.ok(requests.every((r) => r.method === 'GET'));
});

test('expenses add sends the bill only with --yes, and refuses an incomplete one before any request', async () => {
  const args = ['expenses', 'add', '--vendor', 'Example Host', '--amount', '12.34', '--kind', 'tooling', '--cadence', 'monthly',
    '--product', 'Team', '--renews', '2026-12-01', '--verified'];
  const dry = await run(args, { key: false });
  assert.strictEqual(dry.code, cli.EXIT.confirm, 'without --yes it stops before it even needs the key');
  assert.match(dry.err, /Would add Example Host, Team: \$12\.34 a month, tooling\. Nothing was sent\./);
  assert.deepStrictEqual(requests, []);

  for (const missing of ['--vendor', '--kind', '--cadence', '--amount']) {
    const i = args.indexOf(missing);
    const short = [...args.slice(0, i), ...args.slice(i + 2), '--yes'];
    assert.strictEqual((await run(short)).code, cli.EXIT.usage, missing);
  }
  assert.strictEqual((await run([...args, '--ends', 'soon', '--yes'])).code, cli.EXIT.usage);
  assert.deepStrictEqual(requests, []);

  routes['POST /api/admin/expenses'] = (req) => ({ status: 201, json: { success: true, expense: { ...BILL, id: 9, ...req.body, amountCents: 1234 } } });
  const done = await run([...args, '--yes']);
  assert.strictEqual(done.code, cli.EXIT.ok, done.err);
  assert.deepStrictEqual(requests.map((r) => r.body), [{
    vendor: 'Example Host', kind: 'tooling', cadence: 'monthly', amount: '12.34', product: 'Team', renewsOn: '2026-12-01', verified: true,
  }]);
  assert.match(done.out, /Added bill 9/);
});

// The receipts the money hub's payload carries (services/receiptInbox.js
// readForHub): a new bill under a vendor already on the list, a new bill from
// a shop, and one the server could not read.
const RECEIPTS = {
  status: 'ok',
  pending: [
    { id: 23, vendor: 'Example Host', product: 'Pro plan', amountCents: 2400, currency: 'USD', paidOn: '2026-11-03', status: 'new', knownVendor: true, suggestedKind: 'infrastructure' },
    { id: 24, vendor: 'Parts Shop', product: null, amountCents: 3805, currency: 'EUR', paidOn: null, status: 'new', knownVendor: false, suggestedKind: null },
  ],
  toCheck: [{ id: 25, vendor: null, product: null, amountCents: null, status: 'to_check', sender: 'billing@example.com', subject: 'Your invoice' }],
};

test('receipts list prints the new bills and the receipts to check, from the money hub', async () => {
  routes['GET /api/admin/money'] = { json: { emailReceipts: RECEIPTS } };
  const r = await run(['receipts', 'list']);
  assert.strictEqual(r.code, cli.EXIT.ok, r.err);
  assert.match(r.out, /New bills, in no total until each is added:/);
  assert.match(r.out, /23\s+Example Host, Pro plan\s+\$24\.00\s+\S+ \d+, 2026\s+infrastructure/);
  assert.match(r.out, /24\s+Parts Shop\s+38\.05 EUR/);
  assert.match(r.out, /Receipts the server could not record, to check in Gmail:\n.*\n25\s+Your invoice\s+billing@example\.com/);
  assert.deepStrictEqual(sent(), ['GET /api/admin/money']);

  routes['GET /api/admin/money'] = { json: { emailReceipts: { status: 'ok', pending: [], toCheck: [] } } };
  assert.match((await run(['receipts', 'list'])).out, /No receipts from email are waiting\./);
  routes['GET /api/admin/money'] = { json: { emailReceipts: { status: 'error', reason: 'The receipts from email could not be read.', pending: [], toCheck: [] } } };
  const failed = await run(['receipts', 'list']);
  assert.strictEqual(failed.code, cli.EXIT.api);
  assert.match(failed.err, /The receipts from email could not be read\./);
});

test('receipts confirm adds a waiting bill as its vendor\'s kind, or --kind, and only with --yes', async () => {
  routes['GET /api/admin/money'] = { json: { emailReceipts: RECEIPTS } };
  const dry = await run(['receipts', 'confirm', '23']);
  assert.strictEqual(dry.code, cli.EXIT.confirm);
  assert.match(dry.err, /Would add Example Host, Pro plan, \$24\.00 paid \S+ \d+, 2026, to the expense list as infrastructure\. Nothing was sent\./);
  assert.deepStrictEqual(sent(), ['GET /api/admin/money']);

  requests = [];
  routes['POST /api/admin/email-receipts/23/confirm'] = () => ({ json: { success: true, expenseId: 41 } });
  const done = await run(['receipts', 'confirm', '23', '--yes']);
  assert.strictEqual(done.code, cli.EXIT.ok, done.err);
  assert.match(done.out, /Added Example Host, Pro plan to the expense list as infrastructure, bill 41\./);
  assert.deepStrictEqual(sent(), ['GET /api/admin/money', 'POST /api/admin/email-receipts/23/confirm']);
  assert.deepStrictEqual(requests[1].body, { kind: 'infrastructure' });

  requests = [];
  routes['POST /api/admin/email-receipts/24/confirm'] = () => ({ json: { success: true, expenseId: 42 } });
  assert.strictEqual((await run(['receipts', 'confirm', '24', '--kind', 'other', '--yes'])).code, cli.EXIT.ok);
  assert.deepStrictEqual(requests[1].body, { kind: 'other' }, '--kind wins over the default');
  requests = [];
  assert.strictEqual((await run(['receipts', 'confirm', '24', '--yes'])).code, cli.EXIT.ok);
  assert.deepStrictEqual(requests[1].body, { kind: 'tooling' }, 'with no vendor kind to go on, the dashboard\'s default');
});

test('receipts confirm refuses a receipt with no bill in it, an id that is not waiting, and a bad id, writing nothing', async () => {
  routes['GET /api/admin/money'] = { json: { emailReceipts: RECEIPTS } };
  const unread = await run(['receipts', 'confirm', '25', '--yes']);
  assert.strictEqual(unread.code, cli.EXIT.usage);
  assert.match(unread.err, /Receipt 25 could not be read, so it holds no bill to add\. Record it with expenses add, then run receipts dismiss 25 --yes to mark it checked\./);
  assert.strictEqual((await run(['receipts', 'confirm', '99', '--yes'])).code, cli.EXIT.api);
  assert.ok(requests.every((r) => r.method === 'GET'));
  requests = [];
  assert.strictEqual((await run(['receipts', 'confirm', 'abc', '--yes'], { key: false })).code, cli.EXIT.usage);
  assert.strictEqual((await run(['receipts', 'dismiss', '', '--yes'], { key: false })).code, cli.EXIT.usage);
  assert.strictEqual((await run(['receipts', 'file', '23'])).code, cli.EXIT.usage);
  assert.deepStrictEqual(requests, [], 'a bad id is refused before the key is read or anything is sent');
});

test('receipts dismiss sets a bill aside or marks a receipt checked, and only with --yes', async () => {
  routes['GET /api/admin/money'] = { json: { emailReceipts: RECEIPTS } };
  const dryBill = await run(['receipts', 'dismiss', '24']);
  assert.strictEqual(dryBill.code, cli.EXIT.confirm);
  assert.match(dryBill.err, /Would set aside Parts Shop, 38\.05 EUR, as not a Flock bill\. Later receipts for the same product from the same sender are set aside too\. Nothing was sent\./);
  const dryCheck = await run(['receipts', 'dismiss', '25']);
  assert.match(dryCheck.err, /Would mark receipt 25 \("Your invoice", from billing@example\.com\) as checked\. Nothing was sent\./);
  assert.ok(requests.every((r) => r.method === 'GET'));

  requests = [];
  routes['POST /api/admin/email-receipts/24/dismiss'] = () => ({ json: { success: true, status: 'dismissed' } });
  routes['POST /api/admin/email-receipts/25/dismiss'] = () => ({ json: { success: true, status: 'checked' } });
  const bill = await run(['receipts', 'dismiss', '24', '--yes']);
  assert.strictEqual(bill.code, cli.EXIT.ok, bill.err);
  assert.match(bill.out, /Parts Shop is set aside as not a Flock bill\./);
  const check = await run(['receipts', 'dismiss', '25', '--yes']);
  assert.match(check.out, /Receipt 25 is marked as checked\./);
  assert.deepStrictEqual(sent(), ['GET /api/admin/money', 'POST /api/admin/email-receipts/24/dismiss', 'GET /api/admin/money', 'POST /api/admin/email-receipts/25/dismiss']);
  assert.deepStrictEqual(requests[1].body, {});
  assert.strictEqual((await run(['receipts', 'dismiss', '99', '--yes'])).code, cli.EXIT.api);
});

test('the waitlist dry run asks the server and sends no email; a send needs --yes', async () => {
  routes['POST /api/admin/waitlist/announce'] = (req) => (req.body && req.body.dry_run === true
    ? { json: { dry_run: true, total: 120, converted: 20, announced: 90, pending: 10 } }
    : { json: { dry_run: false, batch: 10, sent: 10, suppressed: 0, failed: 0, unknown: 0, unknown_ids: [], stopped_early: false, remaining: 0 } });
  const dry = await run(['waitlist', 'announce', '--dry-run']);
  assert.strictEqual(dry.code, cli.EXIT.ok, dry.err);
  assert.deepStrictEqual(requests.map((r) => r.body), [{ dry_run: true }]);
  assert.match(dry.out, /10 waiting for the launch email\. 90 already sent, 20 already have an account, 120 on the waitlist in all\./);

  requests = [];
  const unconfirmed = await run(['waitlist', 'announce'], { key: false });
  assert.strictEqual(unconfirmed.code, cli.EXIT.confirm);
  assert.match(unconfirmed.err, /Nothing was sent/);
  assert.deepStrictEqual(requests, []);

  const sentOnce = await run(['waitlist', 'announce', '--yes']);
  assert.strictEqual(sentOnce.code, cli.EXIT.ok, sentOnce.err);
  assert.deepStrictEqual(requests.map((r) => r.body), [{}]);
  assert.match(sentOnce.out, /Batch 1: sent 10\. 0 still waiting\./);
});

test('--all sends batch after batch until nobody is left, and stops when the server does', async () => {
  let left = 250;
  routes['POST /api/admin/waitlist/announce'] = () => {
    const batch = Math.min(100, left);
    left -= batch;
    return { json: { dry_run: false, batch, sent: batch, suppressed: 0, failed: 0, unknown: 0, unknown_ids: [], stopped_early: false, remaining: left } };
  };
  const r = await run(['waitlist', 'announce', '--yes', '--all']);
  assert.strictEqual(r.code, cli.EXIT.ok, r.err);
  assert.strictEqual(requests.length, 3);
  assert.match(r.out, /Batch 3: sent 50\. 0 still waiting\./);

  requests = [];
  routes['POST /api/admin/waitlist/announce'] = { json: { dry_run: false, batch: 3, sent: 0, suppressed: 0, failed: 0, unknown: 3, unknown_ids: [7, 8, 9], stopped_early: true, remaining: 80 } };
  const stopped = await run(['waitlist', 'announce', '--yes', '--all']);
  assert.strictEqual(requests.length, 1);
  assert.match(stopped.out, /3 with no word from the mail service \(waitlist ids 7, 8, 9/);
  assert.match(stopped.out, /The server stopped the batch/);
});

// ---------------------------------------------------------------------------
// The key itself
// ---------------------------------------------------------------------------

test('mint sends the piped session token, saves the key it gets back, and prints neither', async () => {
  routes['POST /api/admin/keys'] = (req) => ({
    status: 201,
    json: { key: KEY, id: 11, name: req.body.name, scopes: ['admin'], createdAt: '2026-11-05T15:00:00.000Z', expiresAt: '2027-02-03T15:00:00.000Z', state: 'active', shownOnce: true },
  });
  const unconfirmed = await run(['mint', '--name', 'PC tools'], { key: false, stdin: Readable.from([SESSION]) });
  assert.strictEqual(unconfirmed.code, cli.EXIT.confirm);
  assert.deepStrictEqual(requests, []);

  const r = await run(['mint', '--name', 'PC tools', '--days', '60', '--yes'], { key: false, stdin: Readable.from([`${SESSION}\r\n`]) });
  assert.strictEqual(r.code, cli.EXIT.ok, r.err);
  assert.deepStrictEqual(sent(), ['POST /api/admin/keys']);
  assert.strictEqual(requests[0].auth, `Bearer ${SESSION}`, 'minting rides on the session, never on a key');
  assert.deepStrictEqual(requests[0].body, { name: 'PC tools', days: 60 });
  assert.strictEqual(fs.readFileSync(keyFile, 'utf8'), `${KEY}\n`);
  assert.match(r.out, /Minted admin key "PC tools" \(key 11\)\. It expires Feb 3, 2027\./);

  // A second mint does not overwrite the saved key without --replace.
  requests = [];
  const again = await run(['mint', '--name', 'again', '--yes'], { key: false, stdin: Readable.from([SESSION]) });
  assert.strictEqual(again.code, cli.EXIT.usage);
  assert.deepStrictEqual(requests, []);
  // Something that is not a session token is never sent.
  fs.rmSync(keyFile, { force: true });
  const junk = await run(['mint', '--name', 'x', '--yes'], { key: false, stdin: Readable.from(['hello']) });
  assert.strictEqual(junk.code, cli.EXIT.usage);
  assert.deepStrictEqual(requests, []);
});

test('a pending mint saves the key, says to tap Approve in the email, and --wait waits until whoami answers 200', async () => {
  const pendingAnswer = (req) => ({
    status: 202,
    json: {
      key: KEY, id: 12, name: req.body.name, scopes: ['admin'], createdAt: '2026-11-05T15:00:00.000Z',
      expiresAt: '2027-02-03T15:00:00.000Z', state: 'pending', pending: true, shownOnce: true,
      approval: { sentTo: 'o*****@example.com', expiresAt: new Date(Date.now() + 15 * 60000).toISOString() },
    },
  });
  routes['POST /api/admin/keys'] = pendingAnswer;
  const r = await run(['mint', '--name', 'Phone', '--yes'], { key: false, stdin: Readable.from([SESSION]) });
  assert.strictEqual(r.code, cli.EXIT.ok, r.err);
  assert.match(r.out, /Minted admin key "Phone" \(key 12\), pending: tap Approve in the email sent to o\*{5}@example\.com\. It does nothing until then\./);
  assert.strictEqual(fs.readFileSync(keyFile, 'utf8'), `${KEY}\n`, 'a pending key is saved at mint time');
  assert.deepStrictEqual(sent(), ['POST /api/admin/keys'], 'without --wait it does not wait');

  // --wait: two answers of "awaiting approval", then approved.
  fs.rmSync(keyFile, { force: true });
  requests = [];
  let asked = 0;
  routes['GET /api/admin/whoami'] = () => {
    asked += 1;
    return asked < 3
      ? { status: 403, json: { error: 'This admin key is awaiting approval. Tap Approve in the email.', adminKeyPending: true } }
      : { json: WHOAMI };
  };
  const waited = await run(['mint', '--name', 'Phone', '--yes', '--wait'], { key: false, stdin: Readable.from([SESSION]), pollMs: 5 });
  assert.strictEqual(waited.code, cli.EXIT.ok, waited.err);
  assert.strictEqual(asked, 3);
  assert.deepStrictEqual(sent(), ['POST /api/admin/keys', 'GET /api/admin/whoami', 'GET /api/admin/whoami', 'GET /api/admin/whoami']);
  assert.match(waited.out, /Waiting for the approval, for up to 15 minutes\.\nApproved\. The key works now, until Feb 3, 2027\./);
  assert.strictEqual(fs.readFileSync(keyFile, 'utf8'), `${KEY}\n`);

  // Revoked from the email instead: whoami answers 401, and the wait ends.
  fs.rmSync(keyFile, { force: true });
  routes['GET /api/admin/whoami'] = { status: 401, json: { error: 'This admin key was revoked.' } };
  const denied = await run(['mint', '--name', 'Phone', '--yes', '--wait'], { key: false, stdin: Readable.from([SESSION]), pollMs: 5 });
  assert.strictEqual(denied.code, cli.EXIT.api);
  assert.match(denied.err, /The key will not work: This admin key was revoked\./);

  // An approval that never comes ends the wait once the link has expired.
  fs.rmSync(keyFile, { force: true });
  routes['POST /api/admin/keys'] = (req) => {
    const a = pendingAnswer(req);
    a.json.approval.expiresAt = new Date(Date.now() - 31000).toISOString();
    return a;
  };
  routes['GET /api/admin/whoami'] = { status: 403, json: { error: 'awaiting approval', adminKeyPending: true } };
  const lapsed = await run(['mint', '--name', 'Phone', '--yes', '--wait'], { key: false, stdin: Readable.from([SESSION]), pollMs: 5 });
  assert.strictEqual(lapsed.code, cli.EXIT.api);
  assert.match(lapsed.err, /No approval came before the link expired/);
});

test('key save moves a downloaded key into place, or saves one piped in', async () => {
  const download = path.join(tmp, 'flock-admin-key-download');
  fs.writeFileSync(download, `${KEY}\n`);
  const moved = await run(['key', 'save', download], { key: false });
  assert.strictEqual(moved.code, cli.EXIT.ok, moved.err);
  assert.strictEqual(fs.readFileSync(keyFile, 'utf8'), `${KEY}\n`);
  assert.ok(!fs.existsSync(download), 'the downloaded copy of the key was left behind');

  fs.rmSync(keyFile, { force: true });
  const piped = await run(['key', 'save'], { key: false, stdin: Readable.from([KEY]) });
  assert.strictEqual(piped.code, cli.EXIT.ok, piped.err);
  assert.strictEqual(fs.readFileSync(keyFile, 'utf8'), `${KEY}\n`);

  fs.writeFileSync(download, 'not a key at all');
  assert.strictEqual((await run(['key', 'save', download, '--replace'], { key: false })).code, cli.EXIT.usage);
  assert.ok(fs.existsSync(download), 'a file that held no key was deleted');
  fs.rmSync(download, { force: true });
  assert.deepStrictEqual(requests, []);
});

test('revoke asks first, then revokes this key and deletes the key file', async () => {
  routes['GET /api/admin/whoami'] = { json: WHOAMI };
  routes['DELETE /api/admin/keys/4'] = { json: { revoked: true, alreadyRevoked: false } };
  const dry = await run(['revoke']);
  assert.strictEqual(dry.code, cli.EXIT.confirm);
  assert.deepStrictEqual(sent(), ['GET /api/admin/whoami']);
  assert.ok(fs.existsSync(keyFile));

  requests = [];
  cli.writeKeyFile(keyFile, KEY, { replace: true });
  let out = '';
  const code = await cli.main(['revoke', '--yes'], {
    env: { FLOCK_API_URL: base, FLOCK_ADMIN_KEY_FILE: keyFile },
    stdout: (s) => { out += s; },
    stderr: (s) => { out += s; },
    stdin: null,
  });
  assert.strictEqual(code, cli.EXIT.ok, out);
  assert.deepStrictEqual(sent(), ['GET /api/admin/whoami', 'DELETE /api/admin/keys/4']);
  assert.ok(!fs.existsSync(keyFile), 'the dead key was left on disk');
  assert.match(out, /Admin key "PC tools" \(key 4\) is revoked\./);
});

test('run as a program it exits with the codes it documents', async () => {
  const exec = (args) => new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, FLOCK_API_URL: base, FLOCK_ADMIN_KEY_FILE: path.join(tmp, 'absent') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { out += c; });
    child.on('close', (code) => resolve({ code, out }));
  });
  assert.strictEqual((await exec(['--help'])).code, 0);
  assert.strictEqual((await exec(['get', '/api/users/me'])).code, 2);
  assert.strictEqual((await exec(['status'])).code, 2);
  assert.strictEqual((await exec(['waitlist', 'announce'])).code, 3);
  assert.deepStrictEqual(requests, []);
});
