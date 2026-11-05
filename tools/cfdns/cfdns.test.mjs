// tools/cfdns/cfdns.test.mjs
// Run: node --test tools/cfdns/cfdns.test.mjs
//
// Offline throughout: every Cloudflare answer comes from FakeCloudflare below,
// handed to main() as its fetch. Covers argument parsing, the token file, the
// dry-run plans (which must write nothing), the live records that refuse a
// write without --i-know-this-is-live, and verify's checks.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  EXIT,
  LIVE_FLAG,
  UsageError,
  checkContent,
  defaultTokenPath,
  fullName,
  loadToken,
  main,
  parseArgs,
  parseTtl,
  protectionFor,
  sameRecord,
} from './cfdns.mjs';

const TOKEN = 'fake-test-token';
const ZONE_ID = '0000000000000000000000000000f001';
const ACCOUNT_ID = '0000000000000000000000000000ac01';
const rid = (n) => n.toString(16).padStart(32, '0');

const rec = (n, type, name, content, over = {}) => ({
  id: rid(n),
  type,
  name,
  content,
  proxiable: ['A', 'AAAA', 'CNAME'].includes(type),
  proxied: false,
  ttl: 1,
  ...(type === 'MX' ? { priority: 10 } : {}),
  comment: null,
  tags: [],
  created_on: '2026-10-21T00:00:00Z',
  modified_on: '2026-10-21T00:00:00Z',
  ...over,
});

// The zone as it stands: the site at the apex and www, the backend at api,
// Email Routing's three MX records and its SPF line, and one spare record.
const seed = () => [
  rec(1, 'CNAME', 'flockcorp.com', 'flock-site.pages.dev', { proxied: true }),
  rec(2, 'CNAME', 'www.flockcorp.com', 'flock-site.pages.dev', { proxied: true }),
  rec(3, 'CNAME', 'api.flockcorp.com', 'example.up.railway.app'),
  rec(4, 'MX', 'flockcorp.com', 'route1.mx.cloudflare.net', { priority: 12 }),
  rec(5, 'MX', 'flockcorp.com', 'route2.mx.cloudflare.net', { priority: 61 }),
  rec(6, 'MX', 'flockcorp.com', 'route3.mx.cloudflare.net', { priority: 89 }),
  rec(7, 'TXT', 'flockcorp.com', '"v=spf1 include:_spf.mx.cloudflare.net ~all"'),
  rec(8, 'TXT', '_dmarc.flockcorp.com', '"v=DMARC1; p=none"'),
  rec(9, 'A', 'old.flockcorp.com', '192.0.2.10', { ttl: 300 }),
];

const response = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => null },
  text: async () => (body === undefined ? '' : JSON.stringify(body)),
});
const ok = (result, resultInfo) => response(200, { success: true, errors: [], messages: [], result, ...(resultInfo ? { result_info: resultInfo } : {}) });
const fail = (status, code, message) => response(status, { success: false, errors: [{ code, message }], messages: [], result: null });

class FakeCloudflare {
  constructor({
    records = seed(),
    zones = ['flockcorp.com'],
    token = 'user',
    tokenStatus = 'active',
    expiresOn = null,
    zoneRead = true,
    dnsRead = true,
    dnsWrite = true,
    echo = false,
  } = {}) {
    this.calls = [];
    this.records = records;
    this.zones = zones.map((name, i) => ({ id: name === 'flockcorp.com' ? ZONE_ID : rid(0xe000 + i), name, status: 'active', account: { id: ACCOUNT_ID, name: 'Flock' } }));
    this.token = token;
    this.tokenStatus = tokenStatus;
    this.expiresOn = expiresOn;
    this.zoneRead = zoneRead;
    this.dnsRead = dnsRead;
    this.dnsWrite = dnsWrite;
    this.echo = echo;
    this.next = 100;
    this.fetch = this.fetch.bind(this);
  }

  get writes() {
    return this.calls.filter((c) => c.method !== 'GET');
  }

  async fetch(url, init = {}) {
    const u = new URL(url);
    const method = String(init.method || 'GET').toUpperCase();
    const call = { method, url, host: u.host, path: u.pathname, query: u.searchParams, headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : undefined };
    this.calls.push(call);
    assert.equal(u.host, 'api.cloudflare.com', 'only Cloudflare is ever called');
    assert.ok(u.pathname.startsWith('/client/v4/'));
    if (this.echo) return fail(400, 6003, `Invalid request headers: Authorization ${init.headers.Authorization}`);
    const p = u.pathname.slice('/client/v4'.length);
    const valid = this.token !== 'invalid';
    let m;
    if (p === '/user/tokens/verify') {
      return this.token === 'user' ? ok({ id: rid(0xabc), status: this.tokenStatus, ...(this.expiresOn ? { expires_on: this.expiresOn } : {}) }) : fail(401, 1000, 'Invalid API Token');
    }
    if ((m = /^\/accounts\/([^/]+)\/tokens\/verify$/.exec(p))) {
      return this.token === 'account' && m[1] === ACCOUNT_ID ? ok({ id: rid(0xabd), status: this.tokenStatus }) : fail(401, 1000, 'Invalid API Token');
    }
    if (!valid) return fail(401, 10000, 'Authentication error');
    if (p === '/zones') {
      if (!this.zoneRead) return fail(403, 9109, 'Unauthorized to access requested resource');
      const name = u.searchParams.get('name');
      const list = this.zones.filter((z) => !name || z.name === name);
      return ok(list, { page: 1, per_page: 50, count: list.length, total_count: list.length, total_pages: 1 });
    }
    const zm = /^\/zones\/([^/]+)\/dns_records(?:\/([^/]+))?$/.exec(p);
    if (!zm || zm[1] !== ZONE_ID) return fail(404, 7003, `fake has no route for ${method} ${p}`);
    const id = zm[2];
    if (method === 'GET' && !id) {
      if (!this.dnsRead) return fail(403, 10000, 'Authentication error');
      const type = u.searchParams.get('type');
      const name = u.searchParams.get('name');
      const per = Number(u.searchParams.get('per_page') || 100);
      const pageNo = Number(u.searchParams.get('page') || 1);
      const all = this.records.filter((r) => (!type || r.type === type) && (!name || r.name === name));
      const pages = Math.max(1, Math.ceil(all.length / per));
      return ok(all.slice((pageNo - 1) * per, pageNo * per), { page: pageNo, per_page: per, count: Math.min(per, all.length), total_count: all.length, total_pages: pages });
    }
    if (method === 'GET' && id) {
      const r = this.records.find((x) => x.id === id);
      return r ? ok(r) : fail(404, 81044, 'Record does not exist.');
    }
    if (!this.dnsWrite) return fail(403, 10000, 'Authentication error');
    if (method === 'POST' && !id) {
      const b = call.body;
      if (this.records.some((r) => r.type === b.type && r.name === b.name && r.content === b.content)) return fail(400, 81058, 'An identical record already exists.');
      const made = rec(this.next, b.type, b.name, b.content, { ttl: b.ttl, ...(b.priority !== undefined ? { priority: b.priority } : {}), ...(b.proxied !== undefined ? { proxied: b.proxied } : {}) });
      this.next += 1;
      this.records.push(made);
      return ok(made);
    }
    if (method === 'DELETE' && id) {
      const i = this.records.findIndex((x) => x.id === id);
      if (i === -1) return fail(404, 81044, 'Record does not exist.');
      this.records.splice(i, 1);
      return ok({ id });
    }
    return fail(405, 10405, 'Method not allowed');
  }
}

async function run(argv, fake, extra = {}) {
  const out = [];
  const err = [];
  const code = await main(argv, {
    env: { CF_DNS_TOKEN: TOKEN },
    fetch: fake ? fake.fetch : async () => { throw new Error('no network in this test'); },
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
    sleep: async () => {},
    now: () => new Date('2026-11-05T18:00:00Z'),
    ...extra,
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const tempHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cfdns-home-'));

// ---------------------------------------------------------------------------
// Arguments, names and values
// ---------------------------------------------------------------------------

test('parseArgs reads each command, normalises names, and fills in ttl and proxied', () => {
  assert.deepEqual(parseArgs(['list']).filter, { type: null, name: null });
  assert.deepEqual(parseArgs(['list', '--type', 'mx', '--name=receipts']).filter, { type: 'MX', name: 'receipts.flockcorp.com' });
  const mx = parseArgs(['add', '--type', 'MX', '--name', 'receipts', '--content', 'Route1.MX.cloudflare.net.', '--priority', '10']);
  assert.equal(mx.write, true);
  assert.deepEqual(mx.record, { type: 'MX', name: 'receipts.flockcorp.com', content: 'route1.mx.cloudflare.net', ttl: 1, priority: 10 });
  const a = parseArgs(['add', '--type', 'a', '--name', 'test.flockcorp.com', '--content', '192.0.2.7', '--ttl', '300', '--yes']);
  assert.deepEqual(a.record, { type: 'A', name: 'test.flockcorp.com', content: '192.0.2.7', ttl: 300, proxied: false });
  assert.equal(parseArgs(['add', '--type', 'CNAME', '--name', 'x', '--content', 'example.pages.dev', '--proxied', 'true']).record.proxied, true);
  const txt = parseArgs(['add', '--type', 'TXT', '--name', '@', '--content', 'v=spf1 -all', '--proxied', 'false', `--${LIVE_FLAG}`]);
  assert.deepEqual(txt.record, { type: 'TXT', name: 'flockcorp.com', content: 'v=spf1 -all', ttl: 1 });
  assert.equal(txt.opts[LIVE_FLAG], true);
  assert.equal(parseArgs(['remove', rid(9).toUpperCase()]).id, rid(9));
  assert.equal(parseArgs(['verify']).write, false);
  assert.equal(parseArgs([]).command, 'help');
});

test('parseArgs refuses what it cannot run, naming the problem', () => {
  const bad = [
    [['nope'], /unknown command "nope"/],
    [['remove'], /needs a record id/],
    [['remove', '1234'], /not a Cloudflare record id/],
    [['remove', rid(1), rid(2)], /unexpected/],
    [['add', '--type', 'MX', '--name', 'r'], /needs --content/],
    [['add', '--type', 'MX', '--name', 'r', '--content', 'route1.mx.cloudflare.net'], /needs --priority/],
    [['add', '--type', 'MX', '--name', 'r', '--content', 'route1.mx.cloudflare.net', '--priority', '70000'], /0 to 65535/],
    [['add', '--type', 'TXT', '--name', 'r', '--content', 'x', '--priority', '1'], /for MX records only/],
    [['add', '--type', 'MX', '--name', 'r', '--content', 'route1.mx.cloudflare.net', '--priority', '1', '--proxied', 'true'], /for A, AAAA and CNAME/],
    [['add', '--type', 'A', '--name', 'r', '--content', '192.0.2.1', '--proxied', 'maybe'], /true or false/],
    [['add', '--type', 'A', '--name', 'r', '--content', '192.0.2.1', '--ttl', '30'], /auto or a number of seconds from 60 to 86400/],
    [['add', '--type', 'A', '--name', 'r', '--content', '300.1.1.1'], /not an IPv4 address/],
    [['add', '--type', 'AAAA', '--name', 'r', '--content', '192.0.2.1'], /not an IPv6 address/],
    [['add', '--type', 'MX', '--name', 'r', '--content', 'not a host', '--priority', '1'], /not a host name/],
    [['add', '--type', 'SRV', '--name', 'r', '--content', 'x'], /add writes A, AAAA, CNAME, MX, TXT records/],
    [['add', '--type', 'TXT', '--name', 'bad name', '--content', 'x'], /not a DNS label/],
    [['add', '--type', 'TXT', '--name', 'r', '--content', ''], /--content is empty/],
    [['list', '--type', 'BOGUS'], /not a DNS record type/],
    [['list', '--yes'], /does not apply to "list"/],
    [['verify', '--name', 'x'], /does not apply to "verify"/],
    [['list', '--bogus'], /unknown option --bogus/],
    [['list', '--type'], /needs a value/],
    [['list', '--type', 'A', '--type', 'MX'], /given twice/],
    [['remove', rid(1), '--yes=sure'], /takes no value/],
  ];
  for (const [argv, re] of bad) {
    assert.throws(() => parseArgs(argv), (e) => e instanceof UsageError && re.test(e.message), argv.join(' '));
  }
});

test('fullName takes relative, absolute and @ names, and refuses ones DNS cannot hold', () => {
  assert.equal(fullName('receipts'), 'receipts.flockcorp.com');
  assert.equal(fullName('Receipts.FlockCorp.com.'), 'receipts.flockcorp.com');
  assert.equal(fullName('@'), 'flockcorp.com');
  assert.equal(fullName('flockcorp.com'), 'flockcorp.com');
  assert.equal(fullName('resend._domainkey.receipts'), 'resend._domainkey.receipts.flockcorp.com');
  assert.equal(fullName('*.preview'), '*.preview.flockcorp.com');
  for (const badName of ['', 'bad name', '-x', 'caf\u00e9', 'a..b', `${'x'.repeat(64)}`]) {
    assert.throws(() => fullName(badName), UsageError, JSON.stringify(badName));
  }
  assert.equal(checkContent('TXT', ' keep spaces '), ' keep spaces ');
  assert.equal(parseTtl('AUTO'), 1);
  assert.equal(parseTtl(undefined), 1);
});

test('the live records: everything at the apex, www and api; nothing else', () => {
  assert.match(protectionFor('flockcorp.com', { type: 'MX', content: 'route2.mx.cloudflare.net' }), /MX records of flockcorp\.com \(route1, route2 and route3\.mx\.cloudflare\.net\) carry every email/);
  assert.match(protectionFor('flockcorp.com', { type: 'TXT' }), /flockcorp\.com itself is the live site/);
  assert.match(protectionFor('flockcorp.com.'), /live site/);
  assert.match(protectionFor('WWW.flockcorp.com'), /www\.flockcorp\.com is the live site/);
  assert.match(protectionFor('api.flockcorp.com'), /api\.flockcorp\.com is the app's live backend/);
  for (const free of ['receipts.flockcorp.com', 'api2.flockcorp.com', 'v1.api.flockcorp.com', '_dmarc.flockcorp.com', 'old.flockcorp.com']) {
    assert.equal(protectionFor(free), null, free);
  }
});

test('sameRecord: type, name, value and MX priority, with the quoting and case Cloudflare adds', () => {
  const live = { type: 'MX', name: 'flockcorp.com', content: 'route1.mx.cloudflare.net', priority: 12 };
  assert.ok(sameRecord(live, { type: 'MX', name: 'flockcorp.com', content: 'Route1.mx.cloudflare.net.', priority: 12 }));
  assert.ok(!sameRecord(live, { ...live, priority: 13 }));
  assert.ok(sameRecord({ type: 'TXT', name: 'x.flockcorp.com', content: '"v=1"' }, { type: 'TXT', name: 'x.flockcorp.com', content: 'v=1' }));
  assert.ok(!sameRecord({ type: 'TXT', name: 'x.flockcorp.com', content: 'v=1' }, { type: 'TXT', name: 'x.flockcorp.com', content: 'V=1' }));
});

test('a usage error exits 2 without a single call', async () => {
  const r = await run(['add', '--type', 'MX', '--name', 'r', '--content', 'route1.mx.cloudflare.net'], null);
  assert.equal(r.code, EXIT.USAGE);
  assert.match(r.err, /needs --priority/);
});

// ---------------------------------------------------------------------------
// The token
// ---------------------------------------------------------------------------

test('loadToken: --token-file beats CF_DNS_TOKEN, which beats the default file', () => {
  const home = tempHome();
  const def = defaultTokenPath(home);
  assert.equal(def, path.join(home, '.secrets', 'flock', 'cloudflare-dns-token'));
  fs.mkdirSync(path.dirname(def), { recursive: true });
  fs.writeFileSync(def, 'from-the-default-file\n');
  const named = path.join(home, 'named');
  fs.writeFileSync(named, 'from-the-named-file');
  assert.equal(loadToken({ env: {}, home }).token, 'from-the-default-file');
  assert.equal(loadToken({ env: { CF_DNS_TOKEN: 'from-the-env' }, home }).token, 'from-the-env');
  assert.equal(loadToken({ env: { CF_DNS_TOKEN: 'from-the-env' }, home, tokenFile: named }).token, 'from-the-named-file');
});

test('a missing token file is a plain message naming the file, CF_DNS_TOKEN and the README, and exits 2 before any call', async () => {
  const home = tempHome();
  const fake = new FakeCloudflare();
  const r = await run(['list'], fake, { env: {}, home });
  assert.equal(r.code, EXIT.USAGE);
  assert.ok(r.err.includes(defaultTokenPath(home)), r.err);
  assert.match(r.err, /CF_DNS_TOKEN/);
  assert.match(r.err, /README\.md/);
  assert.equal(fake.calls.length, 0);
});

test("token files: Notepad's .txt, a BOM and a pasted Bearer prefix are read; an empty or two-line file is refused without echoing it", () => {
  const home = tempHome();
  const def = defaultTokenPath(home);
  fs.mkdirSync(path.dirname(def), { recursive: true });
  fs.writeFileSync(`${def}.txt`, '\uFEFFBearer saved-by-notepad\r\n');
  assert.equal(loadToken({ env: {}, home }).token, 'saved-by-notepad');
  for (const [content, re] of [['  \r\n', /is empty/], ['first-line\nsecond-line', /alone, on one line/], ['CF_DNS_TOKEN=abcdefghij', /NAME=value/]]) {
    fs.writeFileSync(def, content);
    assert.throws(() => loadToken({ env: {}, home }), (e) => e instanceof UsageError && re.test(e.message) && !e.message.includes('second-line') && !e.message.includes('abcdefghij'), JSON.stringify(content));
  }
});

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

test('list prints each record with its id, marks the live ones, passes the filters on, and writes nothing', async () => {
  const fake = new FakeCloudflare();
  const r = await run(['list'], fake);
  assert.equal(r.code, EXIT.OK);
  assert.match(r.out, /^flockcorp\.com: 9 records/);
  assert.ok(r.out.includes(`${rid(4)}  MX    flockcorp.com  route1.mx.cloudflare.net  priority 12  ttl auto  LIVE`), r.out);
  assert.ok(r.out.includes(`${rid(2)}  CNAME www.flockcorp.com  flock-site.pages.dev  ttl auto  proxied  LIVE`), r.out);
  assert.ok(r.out.includes(`${rid(9)}  A     old.flockcorp.com  192.0.2.10  ttl 300  DNS only`), r.out);
  assert.ok(!/old\.flockcorp\.com.*LIVE/.test(r.out));
  assert.match(r.out, /LIVE records change only with --i-know-this-is-live/);
  assert.equal(fake.calls[0].headers.Authorization, `Bearer ${TOKEN}`);

  const mx = new FakeCloudflare();
  const f = await run(['list', '--type', 'mx', '--name', '@'], mx);
  assert.equal(f.code, EXIT.OK);
  assert.match(f.out, /3 records \(MX at flockcorp\.com\)/);
  const q = mx.calls.find((c) => c.path.endsWith('/dns_records')).query;
  assert.equal(q.get('type'), 'MX');
  assert.equal(q.get('name'), 'flockcorp.com');
  assert.equal(fake.writes.length + mx.writes.length, 0);
});

test('list reads every page', async () => {
  const many = Array.from({ length: 230 }, (_, i) => rec(1000 + i, 'TXT', `t${i}.flockcorp.com`, `"n=${i}"`));
  const fake = new FakeCloudflare({ records: many });
  const r = await run(['list'], fake);
  assert.equal(r.code, EXIT.OK);
  assert.match(r.out, /230 records/);
  assert.equal(fake.calls.filter((c) => c.path.endsWith('/dns_records')).length, 3);
});

// ---------------------------------------------------------------------------
// add
// ---------------------------------------------------------------------------

const ADD_MX = ['add', '--type', 'MX', '--name', 'receipts', '--content', 'route1.mx.cloudflare.net', '--priority', '10'];

test('add without --yes prints the record, what is already at that name and the exact POST, adds nothing and exits 4', async () => {
  const fake = new FakeCloudflare({ records: [...seed(), rec(20, 'TXT', 'receipts.flockcorp.com', '"v=spf1 include:_spf.mx.cloudflare.net ~all"')] });
  const r = await run(ADD_MX, fake);
  assert.equal(r.code, EXIT.UNCONFIRMED);
  assert.match(r.out, /\(new\)  MX {4}receipts\.flockcorp\.com  route1\.mx\.cloudflare\.net  priority 10  ttl auto/);
  assert.match(r.out, /Already at receipts\.flockcorp\.com:\n {2}0+14 {2}TXT/);
  assert.ok(r.out.includes(`POST /zones/${ZONE_ID}/dns_records {"type":"MX","name":"receipts.flockcorp.com","content":"route1.mx.cloudflare.net","ttl":1,"priority":10}`), r.out);
  assert.match(r.out, /Nothing added: add --yes/);
  assert.equal(fake.writes.length, 0);

  const dry = new FakeCloudflare();
  const d = await run([...ADD_MX, '--dry-run'], dry);
  assert.equal(d.code, EXIT.OK);
  assert.match(d.out, /Already at receipts\.flockcorp\.com: nothing/);
  assert.match(d.out, /Dry run: nothing added/);
  assert.equal(dry.writes.length, 0);
});

test('add --yes makes one POST in the shape Cloudflare takes and reads the record back', async () => {
  const fake = new FakeCloudflare();
  const r = await run([...ADD_MX, '--yes'], fake);
  assert.equal(r.code, EXIT.OK, r.err);
  assert.equal(fake.writes.length, 1);
  assert.equal(fake.writes[0].method, 'POST');
  assert.deepEqual(fake.writes[0].body, { type: 'MX', name: 'receipts.flockcorp.com', content: 'route1.mx.cloudflare.net', ttl: 1, priority: 10 });
  assert.match(r.out, /Added 0+64:\n {2}0+64 {2}MX {4}receipts\.flockcorp\.com  route1\.mx\.cloudflare\.net  priority 10/);
  assert.ok(fake.calls.some((c) => c.method === 'GET' && c.path.endsWith(`/dns_records/${rid(100)}`)), 'read back');

  const a = new FakeCloudflare();
  await run(['add', '--type', 'A', '--name', 'test', '--content', '192.0.2.7', '--yes'], a);
  assert.deepEqual(a.writes[0].body, { type: 'A', name: 'test.flockcorp.com', content: '192.0.2.7', ttl: 1, proxied: false });
});

test('add at the apex, www or api is refused without --i-know-this-is-live, before any write', async () => {
  for (const [name, re] of [['@', /flockcorp\.com itself is the live site/], ['www', /www\.flockcorp\.com is the live site/], ['api', /api\.flockcorp\.com is the app's live backend/]]) {
    const fake = new FakeCloudflare();
    const r = await run(['add', '--type', 'TXT', '--name', name, '--content', 'google-site-verification=example', '--yes'], fake);
    assert.equal(r.code, EXIT.REFUSED, name);
    assert.match(r.out, re);
    assert.match(r.out, /Refused, nothing added/);
    assert.ok(r.out.includes(`--${LIVE_FLAG}`));
    assert.equal(fake.writes.length, 0, name);
  }
  const mx = new FakeCloudflare();
  const m = await run(['add', '--type', 'MX', '--name', '@', '--content', 'mx.example.test', '--priority', '5', '--yes'], mx);
  assert.equal(m.code, EXIT.REFUSED);
  assert.match(m.out, /MX records of flockcorp\.com .* carry every email/);
  assert.equal(mx.writes.length, 0);

  const flagged = new FakeCloudflare();
  const f = await run(['add', '--type', 'TXT', '--name', '@', '--content', 'google-site-verification=example', '--yes', `--${LIVE_FLAG}`], flagged);
  assert.equal(f.code, EXIT.OK);
  assert.equal(flagged.writes.length, 1);
});

test('add of a record that is already there changes nothing, even at a live name', async () => {
  const fake = new FakeCloudflare();
  const r = await run(['add', '--type', 'MX', '--name', '@', '--content', 'route1.mx.cloudflare.net.', '--priority', '12', '--yes'], fake);
  assert.equal(r.code, EXIT.OK);
  assert.ok(r.out.includes(`That record is already there (${rid(4)}). Nothing to add.`));
  assert.equal(fake.writes.length, 0);
});

test('a refusal from Cloudflare exits 1 with its code and the token setup', async () => {
  const fake = new FakeCloudflare({ dnsWrite: false });
  const r = await run([...ADD_MX, '--yes'], fake);
  assert.equal(r.code, EXIT.API);
  assert.match(r.err, /POST \/zones\/0+f001\/dns_records -> HTTP 403: 10000 Authentication error \(README\.md beside this tool has the token setup: Zone DNS Edit and Zone Read/);
});

// ---------------------------------------------------------------------------
// remove
// ---------------------------------------------------------------------------

test('remove without --yes shows the record and the exact DELETE and removes nothing; with --yes it removes it and checks', async () => {
  const fake = new FakeCloudflare();
  const r = await run(['remove', rid(9)], fake);
  assert.equal(r.code, EXIT.UNCONFIRMED);
  assert.ok(r.out.includes(`${rid(9)}  A     old.flockcorp.com  192.0.2.10`));
  assert.ok(r.out.includes(`DELETE /zones/${ZONE_ID}/dns_records/${rid(9)}`));
  assert.match(r.out, /Nothing removed: add --yes/);
  assert.equal(fake.writes.length, 0);

  const y = await run(['remove', rid(9), '--yes'], fake);
  assert.equal(y.code, EXIT.OK);
  assert.equal(fake.writes.length, 1);
  assert.equal(fake.writes[0].method, 'DELETE');
  assert.ok(y.out.includes(`Removed ${rid(9)}.`));
  assert.ok(!fake.records.some((x) => x.id === rid(9)));
});

test('remove of a live record is refused even with --yes; --i-know-this-is-live lets it through', async () => {
  for (const [n, re] of [[4, /MX records of flockcorp\.com \(route1, route2 and route3\.mx\.cloudflare\.net\)/], [1, /flockcorp\.com itself/], [2, /www\.flockcorp\.com is the live site/], [3, /api\.flockcorp\.com is the app's live backend/], [7, /flockcorp\.com itself/]]) {
    const fake = new FakeCloudflare();
    const r = await run(['remove', rid(n), '--yes'], fake);
    assert.equal(r.code, EXIT.REFUSED, `record ${n}`);
    assert.match(r.out, re);
    assert.match(r.out, /Refused, nothing removed/);
    assert.equal(fake.writes.length, 0, `record ${n}`);
  }
  const fake = new FakeCloudflare();
  const ok2 = await run(['remove', rid(4), '--yes', `--${LIVE_FLAG}`], fake);
  assert.equal(ok2.code, EXIT.OK);
  assert.equal(fake.writes.length, 1);
});

test('remove of an id the zone does not have is refused and deletes nothing', async () => {
  const fake = new FakeCloudflare();
  const r = await run(['remove', rid(0x777), '--yes'], fake);
  assert.equal(r.code, EXIT.REFUSED);
  assert.match(r.err, /no record 0+777 in flockcorp\.com/);
  assert.equal(fake.writes.length, 0);
});

// ---------------------------------------------------------------------------
// verify
// ---------------------------------------------------------------------------

test('verify: an active token that reaches flockcorp.com alone and reads its DNS is ready', async () => {
  const fake = new FakeCloudflare({ expiresOn: '2026-11-12T00:00:00Z' });
  const r = await run(['verify'], fake);
  assert.equal(r.code, EXIT.OK, r.out);
  assert.match(r.out, /token {6}active, user token, expires 2026-11-12 \(in 6 days\)/);
  assert.ok(r.out.includes(`zone       flockcorp.com (zone id ${ZONE_ID}), active`));
  assert.match(r.out, /reach {6}flockcorp\.com only/);
  assert.match(r.out, /DNS read {3}yes, 9 records/);
  assert.match(r.out, /DNS edit/);
  assert.match(r.out, /Ready: the token is active and reaches flockcorp\.com alone/);
  assert.ok(fake.calls.some((c) => c.path === '/client/v4/user/tokens/verify'));
  assert.equal(fake.writes.length, 0, 'verify never writes');
});

test('verify: a token that reaches other zones too is not ready, and says how to narrow it', async () => {
  const r = await run(['verify'], new FakeCloudflare({ zones: ['flockcorp.com', 'example-client.test'] }));
  assert.equal(r.code, EXIT.REFUSED);
  assert.match(r.out, /reach {6}2 zones: example-client\.test, flockcorp\.com/);
  assert.match(r.out, /should reach flockcorp\.com alone\. Edit it on Cloudflare: Zone Resources, Include, Specific zone, flockcorp\.com/);
});

test('verify: a token without Zone Read, an expired token and a token Cloudflare rejects are each named', async () => {
  const noRead = await run(['verify'], new FakeCloudflare({ zoneRead: false }));
  assert.equal(noRead.code, EXIT.REFUSED);
  assert.match(noRead.out, /zone: the token cannot look up flockcorp\.com .*HTTP 403: 9109 Unauthorized.*Zone DNS Edit and Zone Read/);

  const expired = await run(['verify'], new FakeCloudflare({ tokenStatus: 'expired' }));
  assert.equal(expired.code, EXIT.REFUSED);
  assert.match(expired.out, /token: it is expired, not active/);

  const invalid = await run(['verify'], new FakeCloudflare({ token: 'invalid' }));
  assert.equal(invalid.code, EXIT.REFUSED);
  assert.match(invalid.out, /token: Cloudflare does not accept it \(GET \/user\/tokens\/verify -> HTTP 401: 1000 Invalid API Token/);
});

test("verify: an account-owned token is checked at its account's address", async () => {
  const fake = new FakeCloudflare({ token: 'account' });
  const r = await run(['verify'], fake);
  assert.equal(r.code, EXIT.OK, r.out);
  assert.match(r.out, /token {6}active, account token/);
  assert.ok(fake.calls.some((c) => c.path === `/client/v4/accounts/${ACCOUNT_ID}/tokens/verify`));
});

test('no output line carries the token, even an error that echoes it', async () => {
  const r = await run(['list'], new FakeCloudflare({ echo: true }));
  assert.equal(r.code, EXIT.API);
  assert.ok(!r.out.includes(TOKEN) && !r.err.includes(TOKEN), r.err);
  assert.match(r.err, /Authorization Bearer \{token\}/);
});
