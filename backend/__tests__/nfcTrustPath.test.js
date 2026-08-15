// Run: node --test  (from backend/)
//
// Adversarial sweep of the NFC check-in trust path (2026-08-14).
//
// An NFC tap is the app's strongest presence evidence: routes/checkin.js writes
// checkin_source = 'nfc' ONLY for a tap whose URL carries a valid HMAC under
// NFC_TAG_SECRET, and that value is what routes/feedback.js trusts (3-hour
// window) to mark crowd feedback "verified" and what routes/venueDashboard.js
// trusts (30 days) to let someone review a venue. This file attacks that path
// the way an outsider would — forged and re-pointed signatures, captured-URL
// replay from a second account, revoked tokens, a deploy with no secret
// configured, client-supplied clocks — and pins what held.
//
// The comment on each test is the failure it prevents, not the assertion.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

process.env.JWT_SECRET = 'nfc-trust-path-test-secret';
process.env.NFC_TAG_SECRET = 'nfc-trust-path-tag-secret';

const pool = require('../config/database');

// --- Scripted pool --------------------------------------------------------
let handlers = [];
let log = [];

function dispatch(sql, params) {
  log.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params: params || [] });
  for (const [re, fn] of handlers) {
    if (re.test(sql)) {
      const out = fn(params || [], String(sql));
      return Promise.resolve(out === undefined ? { rows: [], rowCount: 0 } : out);
    }
  }
  return Promise.reject(new Error(`unscripted query: ${String(sql).replace(/\s+/g, ' ').slice(0, 140)}`));
}
pool.query = (sql, params) => dispatch(sql, params);
pool.connect = async () => { throw new Error('routes/checkin.js must not check a client out of the pool'); };

// authenticate() is replaced BEFORE the router is required — the router
// destructures it at module load.
const authMod = require('../middleware/auth');
let CURRENT_USER = { id: 1, name: 'Ava', role: 'user', is_banned: false, email_verified: true };
authMod.authenticate = (req, res, next) => {
  if (!CURRENT_USER) return res.status(401).json({ error: 'No token provided' });
  req.user = CURRENT_USER;
  next();
};

const checkinRouter = require('../routes/checkin');
const { __test: checkin } = checkinRouter;
const places = require('../utils/places');

let emits = [];
const io = { to(room) { return { emit(event, payload) { emits.push({ room, event, payload }); } }; } };

const app = express();
app.use(express.json());
app.set('io', io);
app.use('/api/checkin', checkinRouter);
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

const server = app.listen(0);
const port = server.address().port;
test.after(() => server.close());

function call(method, reqPath, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (token) headers.authorization = `Bearer ${token}`;
    let payload = null;
    if (body !== undefined) {
      payload = JSON.stringify(body);
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(payload);
    }
    const req = http.request({ host: '127.0.0.1', port, path: reqPath, method, headers }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(data); } catch { parsed = data; }
        resolve({ status: res.statusCode, body: parsed, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

const VENUE_A = 'ChIJnfcVenueAlpha001';
const VENUE_B = 'ChIJnfcVenueBravo001';

function sigFor(placeId, secret = process.env.NFC_TAG_SECRET) {
  return crypto.createHmac('sha256', secret).update(placeId).digest('hex').slice(0, 32);
}

function script({ knownIds = [VENUE_A, VENUE_B], insert } = {}) {
  let inserts = 0;
  handlers = [
    [/EXISTS \(SELECT 1 FROM venue_profiles/, (p) => ({ rows: [{ known: knownIds === null || knownIds.includes(p[0]) }] })],
    [/INSERT INTO venue_checkins/, (p, sql) => {
      inserts++;
      if (insert) return insert(p, sql, inserts);
      return { rows: [{ created_at: '2026-08-14T22:00:00.000Z' }], rowCount: 1 };
    }],
    [/UPDATE flock_members SET attendance/, () => ({ rows: [], rowCount: 0 })],
    [/SELECT id, is_banned, token_version FROM users/, (p) => ({
      rows: [{ id: Number(p[0]), is_banned: false, token_version: 0 }],
    })],
  ];
  return () => inserts;
}

function reset() {
  handlers = [];
  log = [];
  emits = [];
  checkin.tapCache.clear();
  checkin.tapBudget.reset();
  checkin.anonTapBudget.clear();
  places.clearKnownVenueCache();
  CURRENT_USER = { id: 1, name: 'Ava', role: 'user', is_banned: false, email_verified: true };
}

const insertQueries = () => log.filter((q) => /INSERT INTO venue_checkins/.test(q.sql));
const tokenFor = (id, tv = 0) => jwt.sign({ userId: id, tv }, process.env.JWT_SECRET);
const routeSource = fs.readFileSync(path.join(__dirname, '..', 'routes', 'checkin.js'), 'utf8');

// ---------------------------------------------------------------------------
// 1. Signature verification
// ---------------------------------------------------------------------------

test("only a valid signature mints 'nfc'; everything else lands as 'nfc_unverified'", async () => {
  // feedback.js and venueDashboard.js trust exactly the string 'nfc'. If a
  // missing or forged sig ever produced it, opening a URL in a browser would
  // mint verified presence.
  reset();
  script();

  await call('GET', `/api/checkin/${VENUE_A}?sig=${sigFor(VENUE_A)}`, { token: tokenFor(1) });
  await call('GET', `/api/checkin/${VENUE_A}`, { token: tokenFor(2) });
  const good = sigFor(VENUE_A);
  const flipped = good.slice(0, 31) + (good[31] === 'a' ? 'b' : 'a');
  await call('GET', `/api/checkin/${VENUE_A}?sig=${flipped}`, { token: tokenFor(3) });

  const rows = insertQueries();
  assert.strictEqual(rows.length, 3);
  assert.strictEqual(rows[0].params[2], 'nfc', 'the real tag verifies');
  assert.strictEqual(rows[1].params[2], 'nfc_unverified', 'no sig is not a tag');
  assert.strictEqual(rows[2].params[2], 'nfc_unverified', 'one flipped character is not a tag');
});

test('the comparison is constant-time and type-strict, pinned in source', () => {
  // A char-by-char === compare would let an attacker recover the HMAC one byte
  // at a time from response timing — on an endpoint that requires no account.
  // The buffers must go through crypto.timingSafeEqual, and a non-string
  // (?sig[]=a&sig[]=b arrives as an array) must be refused before coercion,
  // because String(['a','b']) is a value the attacker controls entirely.
  const fnBody = routeSource.slice(routeSource.indexOf('function nfcSigValid'), routeSource.indexOf('\n}', routeSource.indexOf('function nfcSigValid')));
  assert.match(fnBody, /crypto\.timingSafeEqual\(/, 'signature compare must be timing-safe');
  assert.match(fnBody, /typeof sig !== 'string'/, 'non-strings must be refused, not coerced');
  assert.ok(!/[!=]==?\s*expected/.test(fnBody), 'no direct equality on the expected MAC');

  const good = sigFor(VENUE_A);
  assert.strictEqual(checkin.nfcSigValid(VENUE_A, [good]), false, 'an array is not a signature');
  assert.strictEqual(checkin.nfcSigValid(VENUE_A, { toString: () => good }), false, 'nor is an object');
  assert.strictEqual(checkin.nfcSigValid(VENUE_A, good.slice(0, 31)), false, 'a truncated MAC throws inside timingSafeEqual and must read as false');
  assert.strictEqual(checkin.nfcSigValid(VENUE_A, good), true);
});

test('the MAC covers the venue id: a tag cut for venue A is dead at venue B', async () => {
  // Tag-swap: peel the tag off the quiet bar, stick it on the busy one — or
  // just replay A's captured URL against B's path. The place id is inside the
  // HMAC, so the signature stops meaning anything the moment the venue changes.
  reset();
  script();

  await call('GET', `/api/checkin/${VENUE_B}?sig=${sigFor(VENUE_A)}`, { token: tokenFor(1) });
  const swapped = insertQueries()[0];
  assert.strictEqual(swapped.params[0], VENUE_B, 'recorded at the venue actually tapped');
  assert.strictEqual(swapped.params[2], 'nfc_unverified', "venue A's signature proves nothing at venue B");
});

test('nothing attacker-controlled outside the MAC reaches the trust decision', async () => {
  // The trust inputs are the URL venue id and the sig — both inside the HMAC
  // check. A client-supplied source, checkin_source, timestamp or body placeId
  // must all be dead inputs: source is chosen server-side, the row's venue is
  // the URL's, and the clock is the database's (so skewing a phone clock, or
  // POSTing created_at, changes nothing).
  reset();
  script();

  const res = await call(
    'POST',
    `/api/checkin/${VENUE_A}/tap?sig=${sigFor(VENUE_A)}&source=gps&checkin_source=gps&ts=1&created_at=2020-01-01T00:00:00Z`,
    { token: tokenFor(1), body: { placeId: VENUE_B, venue_place_id: VENUE_B, source: 'gps', created_at: '2020-01-01T00:00:00Z' } }
  );

  assert.strictEqual(res.status, 200);
  const q = insertQueries()[0];
  assert.deepStrictEqual(q.params, [VENUE_A, 1, 'nfc', checkin.TAP_DEDUPE_MS],
    'exactly the URL venue, the token identity, the server-chosen source and the server window — nothing from the query or body');
  assert.strictEqual(res.body.checked_in_at, '2026-08-14T22:00:00.000Z', 'the timestamp is the database row, not the client claim');
});

// ---------------------------------------------------------------------------
// 2. Degraded mode: NFC_TAG_SECRET missing or empty
// ---------------------------------------------------------------------------

test('with no secret configured, real tag URLs still check in — as nfc_unverified, never nfc', async () => {
  // .env.example documents this fail-open: a deploy without NFC_TAG_SECRET
  // degrades trust, it does not break taps. The degrade direction matters —
  // if the missing-secret branch ever answered "verified", every tap on a
  // misconfigured deploy would mint the rows feedback trusts. Route-level pin,
  // not just the unit: the sig here is the one that WAS valid before the
  // secret vanished.
  reset();
  script();
  const goodSig = sigFor(VENUE_A);
  const saved = process.env.NFC_TAG_SECRET;
  delete process.env.NFC_TAG_SECRET;
  try {
    const res = await call('GET', `/api/checkin/${VENUE_A}?sig=${goodSig}`, { token: tokenFor(1) });
    assert.strictEqual(res.status, 200, 'the tap is recorded, not refused');
    assert.strictEqual(insertQueries()[0].params[2], 'nfc_unverified');
  } finally { process.env.NFC_TAG_SECRET = saved; }

  // The secret is read at call time, so restoring it restores verification
  // without a restart — and proves the degraded rows above were about the
  // secret, not the sig.
  const again = await call('GET', `/api/checkin/${VENUE_A}?sig=${goodSig}`, { token: tokenFor(2) });
  assert.strictEqual(again.status, 200);
  assert.strictEqual(insertQueries()[1].params[2], 'nfc');
});

test('an empty-string secret is treated as missing, not as an HMAC key', async () => {
  // crypto.createHmac('sha256', '') is a perfectly computable MAC — one an
  // attacker can compute too, since the key is public knowledge the moment
  // "empty" is accepted. NFC_TAG_SECRET= in a copied .env must mean "off".
  reset();
  script();
  const saved = process.env.NFC_TAG_SECRET;
  process.env.NFC_TAG_SECRET = '';
  try {
    const emptyKeySig = sigFor(VENUE_A, '');
    assert.strictEqual(checkin.nfcSigValid(VENUE_A, emptyKeySig), false, 'a MAC under the empty key must not verify');
    const res = await call('GET', `/api/checkin/${VENUE_A}?sig=${emptyKeySig}`, { token: tokenFor(1) });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(insertQueries()[0].params[2], 'nfc_unverified');
  } finally { process.env.NFC_TAG_SECRET = saved; }
});

// ---------------------------------------------------------------------------
// 3. Replay
// ---------------------------------------------------------------------------

test('same-account replay: one row per venue per window, durable across a restart', async () => {
  // A captured URL re-submitted by the SAME account is the retry/prefetch
  // shape. In memory it is collapsed synchronously; in SQL the conditional
  // INSERT catches the replay that arrives after a deploy or on another
  // replica — the case the Map loses.
  reset();
  script();
  const url = `/api/checkin/${VENUE_A}?sig=${sigFor(VENUE_A)}`;

  const first = await call('GET', url, { token: tokenFor(1) });
  const second = await call('GET', url, { token: tokenFor(1) });
  assert.strictEqual(first.body.deduped, undefined);
  assert.strictEqual(second.body.deduped, true);
  assert.strictEqual(insertQueries().length, 1, 'one credential presentation inside the window, one row');

  checkin.tapCache.clear(); // the restart
  script({ insert: () => ({ rows: [], rowCount: 0 }) }); // the DB still has the row
  const afterRestart = await call('GET', url, { token: tokenFor(1) });
  assert.strictEqual(afterRestart.body.deduped, true, 'the SQL window catches what memory forgot');
});

test('cross-account replay is RECORDED — the documented limit of static tags — and the warning must stay in the file', async () => {
  // The payload is placeId + HMAC(placeId): no counter, no timestamp, no
  // nonce. Every tap of one tag, by every patron, is the SAME BYTES, so there
  // is nothing a time-window or a single-use check could key on — "single-use
  // per payload" would mean one verified check-in per venue EVER, across all
  // users, and there is no timestamp in the payload to window. A captured URL
  // therefore mints 'nfc' for any account that replays it. That cannot be
  // fixed in routes/checkin.js without rejecting every deployed tag; the real
  // fixes (per-venue secrets with re-cut tags, or NTAG 424 DNA SUN counters)
  // are recorded in the route's Round 17 REPLAY block, and this test fails if
  // that warning — or the bounds that DO hold — ever disappears.
  reset();
  script();
  const capturedUrl = `/api/checkin/${VENUE_A}?sig=${sigFor(VENUE_A)}`;

  await call('GET', capturedUrl, { token: tokenFor(1) });   // the genuine tap
  await call('GET', capturedUrl, { token: tokenFor(2) });   // the replay, elsewhere, later

  const rows = insertQueries();
  assert.strictEqual(rows.length, 2, 'the replayer gets their own row (pinned so a future fix must update this test consciously)');
  assert.strictEqual(rows[1].params[1], 2, 'attributed to the replayer, never to the original tapper');
  assert.strictEqual(rows[1].params[2], 'nfc', 'and it verifies — this is the documented hole');

  assert.match(routeSource, /Round 17, REPLAY/, 'the in-file replay warning must not be deleted');
  assert.match(routeSource, /NTAG 424/, 'including the named real fixes');
});

test('a replayed URL on a revoked or banned session is recorded as nobody', async () => {
  // The likeliest replayer of a captured URL is someone who USED to hold the
  // account — a squatter evicted by an OAuth claim, or a banned user. Their
  // still-live JWT plus the captured sig must not keep minting verified
  // presence rows under the victim's user_id: a stale token_version taps as a
  // stranger, and an anonymous 'nfc' row can verify nothing downstream because
  // feedback and reviews both join on user_id.
  reset();
  handlers = [
    [/EXISTS \(SELECT 1 FROM venue_profiles/, () => ({ rows: [{ known: true }] })],
    [/INSERT INTO venue_checkins/, () => ({ rows: [{ created_at: '2026-08-14T22:00:00.000Z' }], rowCount: 1 })],
    [/SELECT id, is_banned, token_version FROM users/, () => ({ rows: [{ id: 7, is_banned: false, token_version: 5 }] })],
  ];

  const res = await call('GET', `/api/checkin/${VENUE_A}?sig=${sigFor(VENUE_A)}`, { token: tokenFor(7, 0) });
  assert.strictEqual(res.status, 200);
  const q = insertQueries()[0];
  assert.match(q.sql, /VALUES \(\$1, NULL, \$2\)/, 'user_id is a SQL literal NULL — no slot an id could land in');
  assert.deepStrictEqual(q.params, [VENUE_A, 'nfc'], 'verified about the place, attributed to no one');

  // Same for a ban: the account is out everywhere, including here.
  handlers[2] = [/SELECT id, is_banned, token_version FROM users/, () => ({ rows: [{ id: 8, is_banned: true, token_version: 0 }] })];
  checkin.tapCache.clear();
  const banned = await call('GET', `/api/checkin/${VENUE_A}?sig=${sigFor(VENUE_A)}`, { token: tokenFor(8, 0) });
  assert.strictEqual(banned.status, 200);
  const q2 = insertQueries()[1];
  assert.match(q2.sql, /VALUES \(\$1, NULL, \$2\)/, 'a banned account taps as a stranger too');
  assert.deepStrictEqual(q2.params, [VENUE_A, 'nfc']);
});

test('replaying one captured URL against many venues, or many URLs from one account, hits the ceiling', async () => {
  // A leaked tag URL only speaks for its own venue (the MAC pins that), so the
  // spray shape left is one account replaying a COLLECTION of captured URLs.
  // The per-account budget bounds that at the same ceiling as any other
  // check-in spray, and a refused replay writes nothing.
  reset();
  script({ knownIds: null });

  let accepted = 0;
  let refused = 0;
  for (let i = 0; i < checkin.tapBudget.limits.hourly + 5; i++) {
    const venue = `ChIJreplayfarm${String(i).padStart(6, '0')}`;
    const res = await call('GET', `/api/checkin/${venue}?sig=${sigFor(venue)}`, { token: tokenFor(4) });
    if (res.status === 200) accepted++;
    else if (res.status === 429) refused++;
  }

  assert.strictEqual(accepted, checkin.tapBudget.limits.hourly);
  assert.strictEqual(refused, 5);
  assert.strictEqual(insertQueries().length, accepted, 'a refused replay writes nothing');
  assert.ok(insertQueries().every((q) => q.params[2] === 'nfc'), 'these were all validly signed — the ceiling is what stopped them');
});

test('the signature is never echoed back, on any verb or outcome', async () => {
  // The sig IS the credential. A response that repeats it turns every
  // screenshot of a check-in confirmation into a working replay URL.
  reset();
  script();
  const sig = sigFor(VENUE_A);

  const recorded = await call('POST', `/api/checkin/${VENUE_A}/tap?sig=${sig}`, { token: tokenFor(1) });
  const deduped = await call('POST', `/api/checkin/${VENUE_A}/tap?sig=${sig}`, { token: tokenFor(1) });
  const anon = await call('GET', `/api/checkin/${VENUE_B}?sig=${sigFor(VENUE_B)}`);

  for (const res of [recorded, deduped, anon]) {
    assert.ok(!JSON.stringify(res.body).includes(sig) && !JSON.stringify(res.body).includes(sigFor(VENUE_B)),
      'no response carries a signature');
  }
});

test('HEAD is not a signature oracle', async () => {
  // HEAD exists so bots can probe reachability without minting presence. If
  // its answer varied with the sig, it would also let an attacker confirm a
  // guessed MAC without ever writing a row. Valid, garbage and absent sigs
  // must be indistinguishable.
  reset();
  script();

  const withValid = await call('HEAD', `/api/checkin/${VENUE_A}?sig=${sigFor(VENUE_A)}`);
  const withGarbage = await call('HEAD', `/api/checkin/${VENUE_A}?sig=${'f'.repeat(32)}`);
  const withNone = await call('HEAD', `/api/checkin/${VENUE_A}`);

  for (const res of [withValid, withGarbage, withNone]) {
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers['cache-control'], 'no-store');
  }
  assert.strictEqual(insertQueries().length, 0, 'and none of the probes wrote anything');
});

// ---------------------------------------------------------------------------
// 4. Downstream honesty: what 'nfc' buys, nothing else may buy
// ---------------------------------------------------------------------------

test("the manual route writes 'manual' even when handed a perfectly valid signature", async () => {
  // POST /api/checkin/:placeId is a button in the app. If a sig on that route
  // could promote the row to 'nfc', the strongest presence signal would be
  // mintable from the couch by anyone who ever captured a tag URL — through
  // the route that deliberately skips the known-venue gate.
  reset();
  script();
  const res = await call('POST', `/api/checkin/${VENUE_A}?sig=${sigFor(VENUE_A)}`, { body: { sig: sigFor(VENUE_A), source: 'nfc' } });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(insertQueries()[0].params[2], 'manual');
});

test("the tap routes can write exactly two sources: 'nfc' and 'nfc_unverified'", async () => {
  // 'gps' and 'manual' exist in the CHECK constraint but must be unreachable
  // from the tap path no matter what the request carries — the source column
  // is the entire downstream trust decision.
  reset();
  script({ knownIds: null });
  const attempts = [
    [`/api/checkin/${VENUE_A}?sig=${sigFor(VENUE_A)}`, 1],
    [`/api/checkin/${VENUE_B}?sig=${sigFor(VENUE_A)}`, 2],
    [`/api/checkin/${VENUE_A}?sig=gps`, 3],
    [`/api/checkin/${VENUE_B}?sig[]=a&sig[]=b`, 4],
    [`/api/checkin/${VENUE_A}?checkin_source=gps`, 5],
  ];
  for (const [url, uid] of attempts) await call('GET', url, { token: tokenFor(uid) });

  const sources = new Set(insertQueries().map((q) => q.params[2]));
  assert.strictEqual(insertQueries().length, attempts.length);
  for (const s of sources) {
    assert.ok(s === 'nfc' || s === 'nfc_unverified', `tap route wrote unexpected source '${s}'`);
  }
});

test("feedback and review verification trust exactly checkin_source = 'nfc', scoped to the user", () => {
  // The consumers this file cannot edit are pinned read-only: both allowlist
  // the literal 'nfc' (never a blocklist like <> 'manual', which would trust
  // 'nfc_unverified' and 'gps'), both join the caller's user_id (so anonymous
  // and stranger rows prove nothing), and neither trusts 'nfc_unverified' in
  // any SQL clause. presenceParity.test.js compares the two statements clause
  // by clause; this is the trust-path half of that pin.
  const feedback = fs.readFileSync(path.join(__dirname, '..', 'routes', 'feedback.js'), 'utf8');
  const dashboard = fs.readFileSync(path.join(__dirname, '..', 'routes', 'venueDashboard.js'), 'utf8');

  for (const [name, src] of [['feedback.js', feedback], ['venueDashboard.js', dashboard]]) {
    assert.match(src, /checkin_source = 'nfc'/, `${name} must allowlist the signed source`);
    assert.ok(!/checkin_source\s*(=|!=|<>|IN)\s*[^\n]*nfc_unverified/.test(src),
      `${name} must never reference nfc_unverified in a SQL comparison`);
    assert.ok(!/checkin_source\s*<>\s*'manual'/.test(src),
      `${name} must not regress to the blocklist shape`);
  }
  // Both presence checks bind the caller: the tap row must be THEIRS.
  assert.match(feedback, /WHERE user_id = \$1\s*AND venue_place_id = \$2\s*AND created_at > NOW\(\) - INTERVAL '3 hours'\s*AND checkin_source = 'nfc'/,
    "feedback's trusted-tap clause: caller's own row, 3-hour window, signed source");
  assert.match(dashboard, /WHERE user_id = \$1\s*AND venue_place_id = \$2\s*AND checkin_source = 'nfc'\s*AND created_at > NOW\(\) - INTERVAL '30 days'/,
    "the review gate's trusted-tap clause: caller's own row, 30-day window, signed source");
});

test('the checkin_source CHECK constraint and the route agree on the value set', () => {
  // Migration 004 is what makes an unexpected source a database error instead
  // of a silently trusted string. If the route ever grew a new source value,
  // the constraint must grow in the same change (this has nearly shipped
  // broken three times per the migration table's history — 003, 016, 017).
  const migration = fs.readFileSync(path.join(__dirname, '..', 'migrations', '004_checkin_sources.sql'), 'utf8');
  assert.match(migration, /CHECK \(checkin_source IN \('nfc', 'nfc_unverified', 'manual', 'gps'\)\)/);

  assert.match(routeSource, /\? 'nfc' : 'nfc_unverified'/,
    'the tap source must be the signature ternary — nfc only behind nfcSigValid');
  const assigned = [...routeSource.matchAll(/source:\s*'([a-z_]+)'/g)].map((m) => m[1]);
  assert.deepStrictEqual(assigned, ['manual'],
    "the only literal source assignment besides the ternary is the manual route's 'manual' — in particular, nothing assigns 'gps'");
});
