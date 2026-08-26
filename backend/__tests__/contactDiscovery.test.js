// Run: node --test  (from backend/)
//
// ---------------------------------------------------------------------------
// CONTACT DISCOVERY: the privacy properties, executed rather than described.
// ---------------------------------------------------------------------------
// This is the only feature in the product that asks one person to hand over
// another person's personal data, and a meaningful share of the people holding
// the phone are 13. Every claim the code and the privacy policy make about it
// is asserted here, because a claim about privacy that nothing checks is a
// claim that will quietly stop being true:
//
//   1. A number resolves to ONE canonical whole number or to nothing. The old
//      rule took the last 10 digits and accepted 7, then asked Postgres for a
//      suffix match, so one address-book slot covered a thousand real numbers.
//   2. Matching is a KEYED digest. The same number under two different keys
//      must produce two unrelated digests, or the digest is a lookup table.
//   3. The discovery digest and the ban-tombstone digest live in separate
//      namespaces, so neither table's rows can be compared with the other's.
//   4. Nobody is findable by phone unless they opted in.
//   5. Blocked pairs and banned accounts never come back from this path.
//   6. The response does not say WHICH number produced WHICH person, and its
//      order carries no trace of the order the numbers arrived in.
//   7. The budget is charged after normalisation, on hits and misses alike, and
//      a single-number lookup is metered as a probe rather than as a sync.
//   8. Nothing about an uploaded number is ever written.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');

process.env.JWT_SECRET = 'test-secret-for-contact-discovery';
delete process.env.CONTACT_DISCOVERY_SECRET;
delete process.env.FIREBASE_SERVICE_ACCOUNT; // push stays a no-op

const pool = require('../config/database');
const { signUserToken } = require('../middleware/auth');
const { toE164, discoveryDigest, phoneDiscoveryHash, normalizePhoneList } = require('../utils/phone');

// ---------------------------------------------------------------------------
// 1. utils/phone.js — the canonical form
// ---------------------------------------------------------------------------

test('a bare NANP number becomes one canonical E.164 string, however it was typed', () => {
  for (const written of [
    '2025550101', '202-555-0101', '(202) 555-0101', ' 202.555.0101 ',
    '+1 (202) 555-0101', '1-202-555-0101', '+12025550101', '12025550101',
  ]) {
    assert.strictEqual(toE164(written), '+12025550101', `${written} did not canonicalise`);
  }
});

test('a fragment resolves to NOTHING, which is the whole point', () => {
  // THE DEFECT THIS CLOSES. The old comparison stripped non-digits, took the
  // last 10 and accepted anything 7 or longer, then ran
  // `... SIMILAR TO '%(5550101|...)'`. That is a suffix match: '5550101' hit
  // every user whose number ends in those digits, in any of a thousand area
  // codes. One slot in an uploaded address book bought a thousand numbers of
  // coverage, and an enumerator wants exactly that.
  for (const fragment of ['5550101', '555-0101', '0101', '12', '', '   ']) {
    assert.strictEqual(toE164(fragment), null, `${fragment} is still a lookup key`);
  }
});

test('an impossible NANP number is refused before it can be guessed with', () => {
  // NPA and NXX both begin 2-9 by definition, so these cannot belong to
  // anybody. Refusing them costs no real user anything and removes about a
  // fifth of the space a guesser would walk.
  for (const impossible of ['0000000000', '1111111111', '0205550101', '1025550101', '2020550101']) {
    assert.strictEqual(toE164(impossible), null, `${impossible} was accepted`);
  }
});

test('an international number is kept whole, and a country is never guessed', () => {
  // Written with a +, it is taken as written.
  assert.strictEqual(toE164('+44 20 7946 0958'), '+442079460958');
  // 011 is the North American dial-out prefix; iOS hands numbers back that way.
  assert.strictEqual(toE164('011 44 20 7946 0958'), '+442079460958');
  // A bare 10-digit number is read as NANP, and that is a DEFAULT REGION rather
  // than a guess: there is no country picker anywhere in the client, so a bare
  // 10-digit string typed by a US teenager and a UK national number of the same
  // length are the same bytes and nothing can tell them apart. What is NOT
  // guessed at is a bare national number of any OTHER length, which is where a
  // wrong guess would silently resolve a stranger's number to a real account.
  assert.strictEqual(toE164('2079460958'), '+12079460958');
  for (const bareForeign of ['07911123456', '0611234567', '861012345678']) {
    assert.strictEqual(toE164(bareForeign), null, `${bareForeign} was guessed at`);
  }
  // E.164 tops out at 15 digits, and a country code never starts with 0.
  assert.strictEqual(toE164(`+${'9'.repeat(16)}`), null);
  assert.strictEqual(toE164('+0442079460958'), null);
});

test('a non-string, an object and an over-long string are all nothing', () => {
  for (const junk of [null, undefined, {}, [], true, () => {}, 'x'.repeat(200)]) {
    assert.strictEqual(toE164(junk), null);
  }
  // A number primitive is allowed, because JSON carries phone numbers that way
  // more often than anyone would like.
  assert.strictEqual(toE164(12025550101), '+12025550101');
});

test('the list is de-duplicated and capped, and order does not survive it', () => {
  // "Mom" and "Mom mobile" are one number. Without the dedupe they would each
  // consume one of the caller's capped slots.
  const out = normalizePhoneList(['202-555-0101', '+1 (202) 555-0101', '2025550102', 'nope'], 10);
  assert.deepStrictEqual([...out].sort(), ['+12025550101', '+12025550102']);
  const capped = normalizePhoneList(Array.from({ length: 50 }, (_, i) => `20255501${String(i).padStart(2, '0')}`), 5);
  assert.strictEqual(capped.length, 5);
});

// ---------------------------------------------------------------------------
// 2. utils/phone.js — the digest
// ---------------------------------------------------------------------------

test('the digest is KEYED, so it is not a lookup table of every phone number', () => {
  // A phone number carries about 30 bits of entropy inside a space a laptop
  // walks in seconds. A bare SHA-256 of one is not a one-way function in any
  // sense that matters here; the key is the entire protection.
  const plain = crypto.createHash('sha256').update('+12025550101').digest('hex');
  const keyed = discoveryDigest('+12025550101');
  assert.notStrictEqual(keyed, plain, 'the digest is a bare hash of the number');
  assert.match(keyed, /^[0-9a-f]{64}$/);

  const before = process.env.CONTACT_DISCOVERY_SECRET;
  process.env.CONTACT_DISCOVERY_SECRET = 'a-different-key';
  const underOtherKey = discoveryDigest('+12025550101');
  if (before === undefined) delete process.env.CONTACT_DISCOVERY_SECRET;
  else process.env.CONTACT_DISCOVERY_SECRET = before;
  assert.notStrictEqual(underOtherKey, keyed, 'the key does not change the digest');
});

test('discovery digests cannot be compared against ban-tombstone digests', () => {
  // routes/users.js digests a phone as `phone:<last 10>` for banned_identities.
  // If this file used the same input, a row in one table would be a row in the
  // other, and the two tables have completely different retention rules and
  // completely different reasons to exist.
  const tombstoneShaped = crypto.createHmac('sha256', process.env.JWT_SECRET)
    .update('phone:2025550101').digest('hex');
  assert.notStrictEqual(discoveryDigest('+12025550101'), tombstoneShaped);
});

test('no key means no discovery, not a weaker digest', () => {
  const jwt = process.env.JWT_SECRET;
  delete process.env.JWT_SECRET;
  try {
    assert.strictEqual(discoveryDigest('+12025550101'), null);
    assert.strictEqual(phoneDiscoveryHash('202-555-0101'), null);
  } finally {
    process.env.JWT_SECRET = jwt;
  }
});

test('phoneDiscoveryHash agrees with normalise-then-digest, for every spelling', () => {
  // The column and the lookup must be written by the same rule or an opted-in
  // user is silently unfindable.
  for (const written of ['2025550101', '(202) 555-0101', '+1 202 555 0101']) {
    assert.strictEqual(phoneDiscoveryHash(written), discoveryDigest('+12025550101'));
  }
  assert.strictEqual(phoneDiscoveryHash('5550101'), null);
});

// ---------------------------------------------------------------------------
// 3. The route
// ---------------------------------------------------------------------------

const ME = {
  id: 1, email: 'ava@example.com', name: 'Ava', role: 'user',
  profile_image_url: null, email_verified: true, is_banned: false, token_version: 0,
};

// The fake directory: every row users.phone_hash could hold, plus the two
// columns the query gates on.
let directory;   // [{ id, name, phone, discoverable, banned }]
let blocks;      // [[a, b]]
let queries;     // every statement after the auth lookup
let writes;      // every INSERT/UPDATE/DELETE seen, for the "nothing is stored" pin
let myPhone;     // users.phone for the caller, as PUT /phone-discovery reads it
let myRow;       // the three columns migration 051 added, as the toggle writes them

const AUTH_SQL = /^SELECT id, email, name, role,.*FROM users WHERE id = \$1$/i;

function dispatch(text, params) {
  const sql = String(text).replace(/\s+/g, ' ').trim();
  if (AUTH_SQL.test(sql)) return Promise.resolve({ rows: [ME], rowCount: 1 });
  queries.push({ sql, params: params || [] });
  if (/^(INSERT|UPDATE|DELETE)/i.test(sql)) writes.push({ sql, params: params || [] });

  if (/WHERE phone_hash = ANY\(\$2::text\[\]\)/i.test(sql)) {
    const me = Number(params[0]);
    const wanted = new Set(params[1]);
    const rows = directory
      .filter((u) => u.id !== me)
      .filter((u) => u.discoverable && !u.banned)
      .filter((u) => !blocks.some(([a, b]) => (a === me && b === u.id) || (a === u.id && b === me)))
      .filter((u) => wanted.has(phoneDiscoveryHash(u.phone)))
      .map((u) => ({ id: u.id, name: u.name, profile_image_url: null }))
      .sort((a, b) => a.id - b.id);
    return Promise.resolve({ rows, rowCount: rows.length });
  }
  if (/FROM friendships/i.test(sql)) return Promise.resolve({ rows: [], rowCount: 0 });

  // PUT /api/users/phone-discovery reads the caller's own number, then writes
  // the flag and the digest together.
  if (/^SELECT phone FROM users WHERE id = \$1$/i.test(sql)) {
    return Promise.resolve({ rows: [{ phone: myPhone }], rowCount: 1 });
  }
  if (/^UPDATE users SET phone_discoverable = FALSE/i.test(sql)) {
    myRow.phone_discoverable = false;
    myRow.phone_hash = null;
    myRow.phone_discoverable_at = null;
    return Promise.resolve({ rows: [], rowCount: 1 });
  }
  if (/SET phone_discoverable = TRUE, phone_hash = \$2/i.test(sql)) {
    myRow.phone_discoverable = true;
    myRow.phone_hash = params[1];
    myRow.phone_discoverable_at = 'now';
    return Promise.resolve({ rows: [], rowCount: 1 });
  }
  return Promise.resolve({ rows: [], rowCount: 0 });
}
pool.query = (text, params) => dispatch(text, params);
pool.connect = async () => ({ query: (t, p) => dispatch(t, p), release: () => {} });

const friendsRouter = require('../routes/friends');
const usersRouter = require('../routes/users');
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use('/api/friends', friendsRouter);
app.use('/api/users', usersRouter);

let base;
const server = http.createServer(app);
test.before(() => new Promise((r) => {
  server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; r(); });
}));
test.after(() => new Promise((r) => server.close(() => r())));

test.beforeEach(() => {
  queries = [];
  writes = [];
  blocks = [];
  directory = [
    { id: 2, name: 'Bo', phone: '+12025550102', discoverable: true, banned: false },
    { id: 3, name: 'Cal', phone: '+12025550103', discoverable: true, banned: false },
    { id: 4, name: 'Dee', phone: '+12025550104', discoverable: false, banned: false },
    { id: 5, name: 'Eve', phone: '+12025550105', discoverable: true, banned: true },
    { id: 6, name: 'Fay', phone: '+12025550106', discoverable: true, banned: false },
  ];
  myPhone = '+1 (202) 555-0101';
  myRow = { phone_discoverable: false, phone_hash: null, phone_discoverable_at: null };
  friendsRouter.__resetBudgets();
});

async function find(phones) {
  const res = await fetch(`${base}/api/friends/find-by-phone`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${signUserToken(ME)}` },
    body: JSON.stringify({ phones }),
  });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, text, body };
}

test('somebody who has not opted in is not findable, even by their real number', () => {
  // Dee gave Flock her number. She never agreed to be found with it. This is
  // the property the whole feature turns on, and before migration 051 every
  // account with a number on file was findable by anybody who had it.
  return find(['+12025550104']).then((res) => {
    assert.strictEqual(res.status, 200, res.text);
    assert.deepStrictEqual(res.body.users, []);
    assert.strictEqual(res.body.checked, 1);
  });
});

test('somebody who HAS opted in is findable by their number, in any spelling', async () => {
  const res = await find(['(202) 555-0102']);
  assert.strictEqual(res.status, 200, res.text);
  assert.deepStrictEqual(res.body.users.map((u) => u.id), [2]);
  assert.strictEqual(res.body.users[0].friendship_status, null);
});

test('a blocked pair never rediscovers each other through a contact sync', async () => {
  blocks.push([1, 3]);
  const res = await find(['+12025550102', '+12025550103']);
  assert.deepStrictEqual(res.body.users.map((u) => u.id), [2]);

  // And in the other direction: it does not matter who blocked whom.
  blocks = [[2, 1]];
  const back = await find(['+12025550102', '+12025550103']);
  assert.deepStrictEqual(back.body.users.map((u) => u.id), [3]);
});

test('a banned account is not handed to anybody by this path', async () => {
  const res = await find(['+12025550105', '+12025550102']);
  assert.deepStrictEqual(res.body.users.map((u) => u.id), [2]);
});

test('the response does not say which number produced which person', async () => {
  // Uploaded LAST, matched FIRST, and the other way round: the response order
  // is the directory's, never the caller's. This is what stops one request
  // being a straight number-to-person map.
  const res = await find(['+12025550106', '+12025550103', '+12025550102']);
  assert.deepStrictEqual(res.body.users.map((u) => u.id), [2, 3, 6]);
  // Nothing in the payload echoes a number back.
  assert.ok(!res.text.includes('5550102'), 'the response echoes an uploaded number');
  for (const u of res.body.users) {
    assert.deepStrictEqual(Object.keys(u).sort(), ['friendship_status', 'id', 'name', 'profile_image_url']);
  }
});

test('an uploaded number is never written anywhere', async () => {
  await find(['+12025550102', '+12025550199', 'not a number']);
  assert.deepStrictEqual(writes, [], 'contact sync wrote to the database');
  // And no raw number reaches a statement either: the only parameter that
  // carries the caller's numbers is the digest array.
  const all = JSON.stringify(queries);
  assert.ok(!all.includes('5550199'), 'a non-user number reached a query in the clear');
  assert.ok(!all.includes('5550102'), 'a matched number reached a query in the clear');
});

test('nothing usable in the list costs nothing, and reaches no directory at all', async () => {
  // A budget denominated in directory reads may only be charged for a directory
  // read. An address book of email-only contacts, or a first run where the OS
  // hands back placeholders, must not spend the user's whole allowance.
  for (let i = 0; i < 12; i += 1) {
    const res = await find(['not a number', '5550101', '']);
    assert.strictEqual(res.status, 200, `attempt ${i}: ${res.text}`);
    assert.strictEqual(res.body.checked, 0);
  }
  assert.deepStrictEqual(queries.filter((q) => /phone_hash = ANY/i.test(q.sql)), []);
  // The allowance is untouched: a real sync still works afterwards.
  const real = await find(['+12025550102', '+12025550103']);
  assert.strictEqual(real.status, 200, real.text);
});

test('the bulk lane is charged on misses as well as hits', async () => {
  // If only hits were charged, an enumerator would walk the space for free and
  // pay only on the rare occasion they found somebody, which inverts the meter.
  for (let i = 0; i < 3; i += 1) {
    const res = await find(['+12025559991', '+12025559992']);
    assert.strictEqual(res.status, 200, `sync ${i}: ${res.text}`);
    assert.deepStrictEqual(res.body.users, []);
  }
  const over = await find(['+12025559991', '+12025559992']);
  assert.strictEqual(over.status, 429, over.text);
});

test('a single-number lookup is metered as a probe, not as an address-book sync', async () => {
  // "Add this person by their number" is the friend probe's question asked with
  // a phone number. Under the sync budget a user could do it three times an
  // hour, which is not a feature.
  for (let i = 0; i < 20; i += 1) {
    const res = await find(['+12025550102']);
    assert.strictEqual(res.status, 200, `lookup ${i}: ${res.text}`);
  }
  assert.strictEqual((await find(['+12025550102'])).status, 429);
  // The bulk allowance is separate and still intact.
  assert.strictEqual((await find(['+12025550102', '+12025550103'])).status, 200);
});

test('splitting a list into singles buys an enumerator less, not more', async () => {
  // 60 single lookups a day against 10 syncs of 200. If the small lane were
  // ever the cheaper way to walk numbers, it would be a hole rather than a
  // convenience, so the arithmetic is pinned rather than argued.
  const single = friendsRouter.__budgetLimits().phoneLookup;
  const bulk = friendsRouter.__budgetLimits().contactSync;
  assert.ok(single.daily < bulk.daily * 200,
    `the single lane (${single.daily}/day) is not smaller than the bulk lane (${bulk.daily * 200} numbers/day)`);
});

test('an exhausted budget says so, because here the refusal leaks nothing', async () => {
  // The block probe in moderation.js shapes its refusal like a miss, and must:
  // there a miss is an answer about ONE named id. Here the caller already knows
  // every number they sent and the refusal covers the whole request, so the
  // honest answer costs nothing. A silent empty result would read as "nobody in
  // your contacts uses Flock", which is the one sentence this screen must never
  // say when it does not know.
  for (let i = 0; i < 3; i += 1) await find(['+12025550102', '+12025550103']);
  const over = await find(['+12025550102', '+12025550103']);
  assert.strictEqual(over.status, 429);
  assert.match(over.body.error, /synced your contacts/i);
  assert.ok(!/—/.test(over.body.error), 'no em dashes in user-visible copy');
});

test('the list is bounded, and an unusable shape is a 400 rather than a 500', async () => {
  assert.strictEqual((await find([])).status, 400);
  assert.strictEqual((await find(Array(201).fill('+12025550102'))).status, 400);
  const notArray = await fetch(`${base}/api/friends/find-by-phone`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${signUserToken(ME)}` },
    body: JSON.stringify({ phones: '+12025550102' }),
  });
  assert.strictEqual(notArray.status, 400);
});

test('a 200-number address book is one statement, not two hundred', async () => {
  const book = Array.from({ length: 200 }, (_, i) => `+1202555${String(1000 + i)}`);
  book[0] = '+12025550102';
  const res = await find(book);
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(queries.filter((q) => /phone_hash = ANY/i.test(q.sql)).length, 1);
});

// ---------------------------------------------------------------------------
// 4. The consent switch, and keeping the digest in step with the number
// ---------------------------------------------------------------------------

async function setDiscovery(enabled) {
  const res = await fetch(`${base}/api/users/phone-discovery`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${signUserToken(ME)}` },
    body: JSON.stringify({ enabled }),
  });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, text, body };
}

test('turning discovery ON is the moment the digest is written, and it is a digest', async () => {
  const res = await setDiscovery(true);
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(res.body.phone_discoverable, true);
  assert.strictEqual(myRow.phone_discoverable, true);
  assert.strictEqual(myRow.phone_hash, phoneDiscoveryHash('+12025550101'));
  // The number itself is not what went into the column.
  assert.ok(!String(myRow.phone_hash).includes('5550101'));
});

test('turning it OFF erases the digest, not just the flag', async () => {
  await setDiscovery(true);
  const res = await setDiscovery(false);
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(myRow.phone_discoverable, false);
  assert.strictEqual(myRow.phone_hash, null,
    'a digest was kept for somebody who opted out');
  assert.strictEqual(myRow.phone_discoverable_at, null);
});

test('you cannot become findable by a number you have not given', async () => {
  myPhone = null;
  const res = await setDiscovery(true);
  assert.strictEqual(res.status, 400, res.text);
  assert.strictEqual(res.body.phone_discoverable, false);
  assert.strictEqual(myRow.phone_hash, null);
  assert.ok(!/—/.test(res.body.error), 'no em dashes in user-visible copy');
});

test('a number this server cannot canonicalise cannot be turned on either', async () => {
  // A stored value that is not a whole number would produce a null digest, and
  // a switch that flips to ON while nothing can ever match it is a lie told in
  // a settings screen.
  myPhone = '555-0101';
  const res = await setDiscovery(true);
  assert.strictEqual(res.status, 400, res.text);
  assert.strictEqual(myRow.phone_discoverable, false);
});

test('the toggle refuses a value that is not a boolean', async () => {
  for (const bad of ['maybe', 42, [true], {}, null]) {
    const res = await fetch(`${base}/api/users/phone-discovery`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${signUserToken(ME)}` },
      body: JSON.stringify({ enabled: bad }),
    });
    assert.strictEqual(res.status, 400, `${JSON.stringify(bad)} was accepted`);
  }
});
