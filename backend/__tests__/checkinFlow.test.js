// Run: node --test  (from backend/)
//
// Round 17 — the NFC check-in path end to end.
//
// A check-in is the app's only physical-world claim. It is what mints the
// `checkin_source = 'nfc'` rows that routes/feedback.js trusts as proof of
// presence (and therefore what the ML pipeline exports as trusted training
// data), what routes/venueDashboard.js trusts to let someone review a venue,
// and what routes/sensors.js sums for the public occupancy figure. Every test
// below pins one way that claim could be manufactured, doubled or lost.
//
// The comment on each test is the failure it prevents, not the assertion.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

process.env.JWT_SECRET = 'checkin-flow-test-secret';
process.env.NFC_TAG_SECRET = 'checkin-flow-tag-secret';

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

// A checkout must never happen on this route — it does not need a transaction,
// and a pool client that is taken and not released is how a Node service dies
// slowly. If anything ever calls connect(), the test that triggered it fails.
let connectCalls = 0;
pool.connect = async () => {
  connectCalls++;
  throw new Error('routes/checkin.js must not check a client out of the pool');
};

// authenticate() is replaced BEFORE the router is required — the router
// destructures it at module load.
const authMod = require('../middleware/auth');
let CURRENT_USER = { id: 1, name: 'Ava', role: 'user', is_banned: false, email_verified: true };
authMod.authenticate = (req, _res, next) => {
  if (!CURRENT_USER) return res401(_res);
  req.user = CURRENT_USER;
  next();
};
function res401(res) { return res.status(401).json({ error: 'No token provided' }); }

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

function call(method, path, { token, ip } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (token) headers.authorization = `Bearer ${token}`;
    // app.set('trust proxy') is not on in this harness, so req.ip is the socket
    // address for every request. Tests that need distinct anonymous identities
    // use distinct place ids instead.
    if (ip) headers['x-forwarded-for'] = ip;
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(body); } catch { parsed = body; }
        resolve({ status: res.statusCode, body: parsed, headers: res.headers });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

const KNOWN = 'ChIJknownVenue000001';
const UNKNOWN = 'ChIJfabricated00001';

function sigFor(placeId) {
  return crypto.createHmac('sha256', process.env.NFC_TAG_SECRET)
    .update(placeId).digest('hex').slice(0, 32);
}

// The default script: the venue is known, the insert succeeds, no flock matches.
function scriptHappyPath({ knownIds = [KNOWN], insert } = {}) {
  let inserts = 0;
  handlers = [
    // knownIds === null means "every shaped id is known", the worst case for
    // anything that has to bound writes across venues.
    [/EXISTS \(SELECT 1 FROM venue_profiles/, (p) => ({ rows: [{ known: knownIds === null || knownIds.includes(p[0]) }] })],
    [/INSERT INTO venue_checkins/, (p, sql) => {
      inserts++;
      if (insert) return insert(p, sql, inserts);
      return { rows: [{ created_at: '2026-08-14T21:00:00.000Z' }], rowCount: 1 };
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
  connectCalls = 0;
  checkin.tapCache.clear();
  checkin.tapBudget.reset();
  checkin.anonTapBudget.clear();
  places.clearKnownVenueCache();
  CURRENT_USER = { id: 1, name: 'Ava', role: 'user', is_banned: false, email_verified: true };
}

const insertQueries = () => log.filter((q) => /INSERT INTO venue_checkins/.test(q.sql));
const tokenFor = (id, tv = 0) => jwt.sign({ userId: id, tv }, process.env.JWT_SECRET);

// An anonymous write binds user_id as a SQL literal NULL rather than a
// parameter, so there is no positional slot an id could ever end up in.
function assertAnonymousInsert(q, why = 'the row must not be attributed to anyone') {
  assert.ok(q, 'a row must have been written');
  assert.match(q.sql, /VALUES \(\$1, NULL, \$2\)/, why);
  assert.strictEqual(q.params.length, 2, why);
  assert.ok(!q.params.some((p) => typeof p === 'number'), why);
}

// ---------------------------------------------------------------------------
// 1. The GET is idempotent — the shape the frontend had to opt out of
// ---------------------------------------------------------------------------

test('a repeated GET tap writes one row, emits once and answers the same', async () => {
  // GET /api/checkin/:placeId writes. Any link prefetcher, browser speculative
  // fetch or generic "retry idempotent methods" layer can therefore replay a
  // tap, which is why frontend/src/services/api.js had to pass `retry: false`.
  // A client opt-out is not a fix; the repeat has to be a no-op server-side.
  reset();
  scriptHappyPath();
  const token = tokenFor(1);

  const first = await call('GET', `/api/checkin/${KNOWN}`, { token });
  const second = await call('GET', `/api/checkin/${KNOWN}`, { token });
  const third = await call('GET', `/api/checkin/${KNOWN}`, { token });

  assert.strictEqual(first.status, 200);
  assert.strictEqual(first.body.checked_in_at, '2026-08-14T21:00:00.000Z');
  for (const r of [second, third]) {
    assert.strictEqual(r.status, 200, 'a replay is a success, not an error');
    assert.strictEqual(r.body.deduped, true);
    assert.strictEqual(r.body.venue_place_id, KNOWN);
  }
  assert.strictEqual(insertQueries().length, 1, 'one tap, one row');
  assert.strictEqual(emits.length, 1, 'and one live event, not three');
});

test('the dedupe survives a process restart, because it is enforced in SQL', async () => {
  // The in-memory Map is per-process. A Railway restart, a deploy or a second
  // replica hands the caller a brand new window — and that is EXACTLY the case
  // a retry layer hits, because the retry happens BECAUSE the first attempt met
  // a restarting instance. Losing the row to a fresh process would double-count
  // the tap in the ML export and in live occupancy.
  reset();
  scriptHappyPath({
    // Stand in for "a row already exists inside the window": the conditional
    // INSERT ... WHERE NOT EXISTS writes nothing, so RETURNING yields no rows.
    insert: () => ({ rows: [], rowCount: 0 }),
  });
  const token = tokenFor(1);

  checkin.tapCache.clear(); // the restart
  const res = await call('GET', `/api/checkin/${KNOWN}`, { token });

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.deduped, true, 'the database caught what memory forgot');
  assert.strictEqual(emits.length, 0, 'and no live event for a row that was not written');
});

test('the SQL dedupe window is the same number as the in-memory one', async () => {
  // Two windows that are written down twice drift. The interval is passed as a
  // bound parameter from the one constant, so it cannot.
  reset();
  scriptHappyPath();
  await call('GET', `/api/checkin/${KNOWN}`, { token: tokenFor(1) });

  const q = insertQueries()[0];
  assert.match(q.sql, /WHERE NOT EXISTS/, 'the authenticated insert must be conditional');
  assert.match(q.sql, /INTERVAL '1 millisecond' \* \$4/, 'the window must be a parameter, not a literal');
  assert.strictEqual(q.params[3], checkin.TAP_DEDUPE_MS);
});

test('a POST twin of the tap exists, so the client can stop writing over GET', async () => {
  // The real fix for "a GET mutates state" is a verb nothing replays on its
  // own. The GET stays only because a shipped iOS binary carries the web bundle
  // and keeps calling it until App Review lets a new build through.
  reset();
  scriptHappyPath();

  const res = await call('POST', `/api/checkin/${KNOWN}/tap?sig=${sigFor(KNOWN)}`, { token: tokenFor(1) });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.checked_in_at, '2026-08-14T21:00:00.000Z');
  assert.strictEqual(insertQueries()[0].params[2], 'nfc', 'the POST honours the tag signature too');
});

test('the GET and the POST tap share one dedupe window, not one each', async () => {
  // A client migrating from one verb to the other, or retrying across the
  // switch, must not get a second free write.
  reset();
  scriptHappyPath();
  const token = tokenFor(1);

  const viaGet = await call('GET', `/api/checkin/${KNOWN}`, { token });
  const viaPost = await call('POST', `/api/checkin/${KNOWN}/tap`, { token });

  assert.strictEqual(viaGet.body.deduped, undefined);
  assert.strictEqual(viaPost.body.deduped, true);
  assert.strictEqual(insertQueries().length, 1);
});

test('a check-in response is never cacheable', async () => {
  // A GET that writes is a GET a shared cache would happily store and serve
  // again. It should not be a GET at all; while it is one, it must at least say
  // so out loud.
  reset();
  scriptHappyPath();
  const res = await call('GET', `/api/checkin/${KNOWN}`, { token: tokenFor(1) });
  assert.strictEqual(res.headers['cache-control'], 'no-store');
});

// ---------------------------------------------------------------------------
// 2. Forgery: can a tap that never happened mint verified presence?
// ---------------------------------------------------------------------------

test('an unsigned tap is recorded as presence-UNPROVEN', async () => {
  // routes/feedback.js trusts `checkin_source = 'nfc'` as physical presence and
  // routes/venueDashboard.js trusts it for 30 days to gate reviews. Opening the
  // URL by hand must never produce that value.
  reset();
  scriptHappyPath();
  await call('GET', `/api/checkin/${KNOWN}`, { token: tokenFor(1) });
  assert.strictEqual(insertQueries()[0].params[2], 'nfc_unverified');
});

test('a wrong, truncated, extended or array signature is not a signature', async () => {
  const good = sigFor(KNOWN);
  const cases = [
    ['', 'empty'],
    [good.slice(0, 31), 'truncated by one'],
    [`${good}0`, 'extended by one'],
    [`${good.slice(0, 31)}${good[31] === 'a' ? 'b' : 'a'}`, 'one character off'],
    [sigFor(UNKNOWN), "another venue's signature"],
    [good.toUpperCase(), 'case-flipped hex'],
  ];
  for (const [sig, why] of cases) {
    assert.strictEqual(checkin.nfcSigValid(KNOWN, sig), false, `${why} must not verify`);
  }
  // ?sig[]=a&sig[]=b arrives as an array. A non-string must be refused, not
  // coerced — String(['a','b']) is a value an attacker controls entirely.
  assert.strictEqual(checkin.nfcSigValid(KNOWN, [good]), false, 'an array is not a signature');
  assert.strictEqual(checkin.nfcSigValid(KNOWN, { toString: () => good }), false, 'nor is an object');
  assert.strictEqual(checkin.nfcSigValid(KNOWN, good), true, 'the real one still verifies');
});

test('a signature for venue A does not verify a tap at venue B', async () => {
  // The HMAC covers the place id, so one leaked tag cannot be re-pointed at the
  // venue an attacker actually wants to inflate.
  reset();
  scriptHappyPath({ knownIds: [KNOWN, UNKNOWN] });
  await call('GET', `/api/checkin/${UNKNOWN}?sig=${sigFor(KNOWN)}`, { token: tokenFor(1) });
  assert.strictEqual(insertQueries()[0].params[2], 'nfc_unverified');
});

test('with no NFC_TAG_SECRET configured, nothing verifies', async () => {
  // A missing secret must fail closed. Failing open would make every tap on a
  // misconfigured deploy "verified" — the exact rows feedback trusts.
  const realSig = sigFor(KNOWN);
  const saved = process.env.NFC_TAG_SECRET;
  delete process.env.NFC_TAG_SECRET;
  try {
    assert.strictEqual(checkin.nfcSigValid(KNOWN, realSig), false);
    assert.strictEqual(checkin.nfcSigValid(KNOWN, 'anything'), false);
  } finally { process.env.NFC_TAG_SECRET = saved; }
});

test('the manual check-in can never claim to be an NFC tap', async () => {
  // Manual is self-reported. A `sig` on the manual route, or any other input,
  // must not be able to promote it to the source feedback trusts.
  reset();
  scriptHappyPath();
  await call('POST', `/api/checkin/${UNKNOWN}?sig=${sigFor(UNKNOWN)}`);
  assert.strictEqual(insertQueries()[0].params[2], 'manual');
});

test('a signature is never echoed back to the caller', async () => {
  // The sig IS the credential (see the replay note in the route). The server
  // must not become a way to read one back.
  reset();
  scriptHappyPath();
  const sig = sigFor(KNOWN);
  const res = await call('GET', `/api/checkin/${KNOWN}?sig=${sig}`, { token: tokenFor(1) });
  assert.ok(!JSON.stringify(res.body).includes(sig), 'the response must not carry the signature');
});

// ---------------------------------------------------------------------------
// 3. The known-venue gate — the self-serve clause is gone
// ---------------------------------------------------------------------------

test('a venue is "known" only on evidence WE created, never on a flock', async () => {
  // `OR EXISTS (SELECT 1 FROM flocks WHERE venue_id = $1)` was self-serve:
  // creating a flock is free and its venue_id is a client string, so anyone
  // could promote a place id of their choosing to "known" and thereby land a
  // fabricated tap in the table sensors.js sums and the ML pipeline exports.
  reset();
  let asked = null;
  handlers = [[/EXISTS \(SELECT 1 FROM venue_profiles/, (_p, sql) => {
    asked = sql;
    return { rows: [{ known: false }] };
  }]];

  await places.isKnownVenue(KNOWN);

  assert.ok(asked, 'the lookup must actually run');
  assert.ok(!/FROM flocks/.test(asked), 'a flock must not make a venue known');
  for (const table of ['venue_profiles', 'sensor_devices', 'ml_venues']) {
    assert.match(asked, new RegExp(table), `${table} is still real evidence`);
  }
});

test('an unknown venue is a 404 and writes nothing', async () => {
  reset();
  scriptHappyPath();
  const res = await call('GET', `/api/checkin/${UNKNOWN}`, { token: tokenFor(1) });
  assert.strictEqual(res.status, 404);
  assert.strictEqual(insertQueries().length, 0);
  assert.strictEqual(emits.length, 0);
});

test('a database failure during the lookup refuses the tap instead of 500ing', async () => {
  // For a route whose whole job is deciding whether to trust a tap, "cannot
  // tell" has to mean no.
  reset();
  handlers = [[/EXISTS \(SELECT 1 FROM venue_profiles/, () => { throw new Error('connection reset'); }]];
  const res = await call('GET', `/api/checkin/${KNOWN}`);
  assert.strictEqual(res.status, 404);
  assert.strictEqual(insertQueries().length, 0);
});

test('a malformed or oversized place id is a 400 and never reaches SQL', async () => {
  // VARCHAR(255): an over-long id used to arrive as a Postgres 22001, i.e. a
  // 500 on an unauthenticated endpoint.
  reset();
  scriptHappyPath();
  for (const bad of ['x'.repeat(300), 'short', 'has%20space', encodeURIComponent("'; DROP TABLE users--")]) {
    const res = await call('GET', `/api/checkin/${bad}`);
    assert.strictEqual(res.status, 400, `${bad.slice(0, 20)} must be refused`);
  }
  assert.strictEqual(log.length, 0, 'no query of any kind for a malformed id');
});

test('the manual route shape-checks too, even though it skips the known gate', async () => {
  // Skipping the known-venue gate is deliberate — a manual check-in legitimately
  // happens at a Google Places venue we have never seen. Skipping the SHAPE
  // check would not be.
  reset();
  scriptHappyPath();
  const res = await call('POST', `/api/checkin/${'x'.repeat(300)}`);
  assert.strictEqual(res.status, 400);
  assert.strictEqual(insertQueries().length, 0);
});

test('the known-venue cache evicts oldest-first instead of wiping itself', async () => {
  // Negative answers are cached (that is what stops a spray of fabricated ids
  // becoming a query per request), so anyone can push the map over its bound.
  // `clear()` then threw away every genuine venue at once, at a moment the
  // sprayer chose.
  places.clearKnownVenueCache();
  const cache = places.__test.knownVenueCache;
  const remember = places.__test.rememberKnownVenue;

  for (let i = 0; i < places.KNOWN_VENUE_MAX_ENTRIES; i++) remember(`ChIJfill${i}`, false);
  assert.strictEqual(cache.size, places.KNOWN_VENUE_MAX_ENTRIES);

  remember('ChIJoneMore00001', true);
  assert.strictEqual(cache.size, places.KNOWN_VENUE_MAX_ENTRIES, 'still bounded');
  assert.strictEqual(cache.has('ChIJfill0'), false, 'the oldest went');
  assert.strictEqual(cache.get('ChIJoneMore00001')?.known, true, 'the newest stayed');
  assert.strictEqual(cache.has('ChIJfill4999'), true, 'and everything between survived');
  places.clearKnownVenueCache();
});

test('a spray of fabricated ids cannot evict the real venues from the cache', async () => {
  // A `known: true` entry names a venue that exists — there are only as many as
  // we have venues, and each saves a query for a real tap. A `known: false`
  // entry is whatever string the last caller made up, and the supply is
  // unlimited. Evicting by age alone let a spray push every genuine venue out,
  // so the real taps that followed all went back to the database at a moment
  // the sprayer chose.
  places.clearKnownVenueCache();
  const cache = places.__test.knownVenueCache;
  const remember = places.__test.rememberKnownVenue;

  const real = [];
  for (let i = 0; i < 100; i++) { real.push(`ChIJreal${i}`); remember(`ChIJreal${i}`, true); }
  for (let i = 0; i < places.KNOWN_VENUE_MAX_ENTRIES + 500; i++) remember(`ChIJmadeup${i}`, false);

  assert.ok(cache.size <= places.KNOWN_VENUE_MAX_ENTRIES, 'still bounded');
  for (const id of real) {
    assert.strictEqual(cache.get(id)?.known, true, `${id} must survive the spray`);
  }
  places.clearKnownVenueCache();
});

// ---------------------------------------------------------------------------
// 4. Identity: whose check-in is it?
// ---------------------------------------------------------------------------

test('a revoked or banned token taps as a stranger, not as its victim', async () => {
  // tryAuth is best-effort by design (a tap from a logged-out phone must work),
  // which is exactly why it has to apply the same revocation rules every other
  // route gets. A stale token_version means the account was claimed back by its
  // verified owner; a ban means the account is out.
  reset();
  handlers = [
    [/EXISTS \(SELECT 1 FROM venue_profiles/, () => ({ rows: [{ known: true }] })],
    [/INSERT INTO venue_checkins/, () => ({ rows: [{ created_at: '2026-08-14T21:00:00.000Z' }], rowCount: 1 })],
    [/SELECT id, is_banned, token_version FROM users/, () => ({ rows: [{ id: 9, is_banned: true, token_version: 0 }] })],
  ];

  const res = await call('GET', `/api/checkin/${KNOWN}`, { token: tokenFor(9) });

  assert.strictEqual(res.status, 200, 'still records the tap, as an anonymous one');
  assertAnonymousInsert(insertQueries()[0], 'never attributed to the banned account');
  assert.ok(res.body.redirect, 'and it is treated as anonymous end to end');
});

test('an anonymous tap is never attributed and never emits a live event', async () => {
  // routes/sensors.js counts COUNT(DISTINCT user_id) WHERE user_id IS NOT NULL,
  // so an anonymous row is invisible to the REST figure. Emitting for one made
  // the live number in every viewer's browser disagree with the number a
  // refresh shows — and made the live number the softer of the two to inflate,
  // since anonymous taps are keyed on IP.
  reset();
  scriptHappyPath();
  const res = await call('GET', `/api/checkin/${KNOWN}`);

  assert.strictEqual(res.status, 200);
  assertAnonymousInsert(insertQueries()[0]);
  assert.strictEqual(emits.length, 0, 'the live counter must only move for rows the REST count sees');
  assert.ok(res.body.redirect, 'a phone on the landing URL still gets sent somewhere');
});

test('a deduped anonymous tap still gets a redirect', async () => {
  // Dropping it stranded the second tap of the evening on a blank page.
  reset();
  scriptHappyPath();
  await call('GET', `/api/checkin/${KNOWN}`);
  const second = await call('GET', `/api/checkin/${KNOWN}`);
  assert.strictEqual(second.body.deduped, true);
  assert.ok(second.body.redirect);
});

test('an identified tap emits the count and nothing about the person', async () => {
  // `venue:{placeId}` is not a private room — sockets/handlers.js join_venue
  // takes any place id from any authenticated socket. Carrying user_id made it
  // a live feed of which accounts walked into which venues.
  reset();
  scriptHappyPath();
  await call('GET', `/api/checkin/${KNOWN}`, { token: tokenFor(1) });

  assert.strictEqual(emits.length, 1);
  assert.strictEqual(emits[0].room, `venue:${KNOWN}`);
  assert.deepStrictEqual(Object.keys(emits[0].payload).sort(), ['created_at', 'venue_place_id']);
});

// ---------------------------------------------------------------------------
// 5. Attendance credit
// ---------------------------------------------------------------------------

test('attendance is only ever credited to an accepted member, in the event window', async () => {
  // Reliability scoring reads this column. Crediting a flock the user is not in
  // (or one happening next week) made the score inflatable above 100%.
  reset();
  scriptHappyPath();
  await call('POST', `/api/checkin/${KNOWN}`);
  await new Promise((r) => setImmediate(r)); // the update is fire-and-forget

  const upd = log.find((q) => /UPDATE flock_members SET attendance/.test(q.sql));
  assert.ok(upd, 'the attendance update must run');
  assert.match(upd.sql, /user_id = \$1/, 'scoped to the caller');
  assert.match(upd.sql, /status = 'accepted'/, 'membership must be accepted, not merely invited');
  assert.match(upd.sql, /venue_id = \$2/, 'and the flock must be AT this venue');
  // NOW_UTC accepts both the bare NOW() this clause carries today and the
  // (NOW() AT TIME ZONE 'UTC') it will carry once routes/checkin.js gets the
  // same correction services/flockSweep.js, services/crowdAlerts.js and
  // routes/venueDashboard.js already got. That rewrite is a real fix and not a
  // rename: flocks.event_time is TIMESTAMP WITHOUT TIME ZONE holding a UTC wall
  // clock, so a bare NOW() casts the naive side at the database session zone
  // and this window is right only because Railway runs UTC. The WINDOW LENGTHS
  // are what this assertion is about, and they are the same under either
  // spelling. Pinning the spelling would have failed the correction instead of
  // the defect, which is exactly how presenceParity and incomingFlocksWindow
  // went red earlier.
  const NOW_UTC = "(?:NOW\\(\\)|\\(NOW\\(\\) AT TIME ZONE 'UTC'\\))";
  assert.match(upd.sql, new RegExp(`${NOW_UTC} BETWEEN event_time - INTERVAL '3 hours' AND event_time \\+ INTERVAL '12 hours'`));
  assert.match(upd.sql, /status NOT IN \('completed', 'cancelled'\)/);
  assert.deepStrictEqual(upd.params, [1, KNOWN]);
});

test('an anonymous tap credits nobody', async () => {
  reset();
  scriptHappyPath();
  await call('GET', `/api/checkin/${KNOWN}`);
  await new Promise((r) => setImmediate(r));
  assert.ok(!log.some((q) => /UPDATE flock_members/.test(q.sql)), 'there is no one to credit');
});

test('a deduped tap does no work at all', async () => {
  // "Idempotent" has to mean the repeat is a no-op, not that it merely writes
  // no row: an attendance UPDATE on every prefetch is still a write.
  reset();
  scriptHappyPath();
  await call('POST', `/api/checkin/${KNOWN}`);
  await new Promise((r) => setImmediate(r));
  log = [];
  emits = [];

  const res = await call('POST', `/api/checkin/${KNOWN}`);
  await new Promise((r) => setImmediate(r));

  assert.strictEqual(res.body.deduped, true);
  assert.strictEqual(log.length, 0, 'a repeat inside the window touches the database zero times');
  assert.strictEqual(emits.length, 0);
});

test('a failing attendance update never fails the check-in', async () => {
  reset();
  scriptHappyPath();
  handlers.push([/UPDATE flock_members SET attendance/, () => { throw new Error('deadlock detected'); }]);
  handlers = [handlers.pop(), ...handlers.slice(0, -1)]; // the throwing rule wins
  const res = await call('POST', `/api/checkin/${KNOWN}`);
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(res.status, 200, 'presence is recorded even if scoring is not');
});

// ---------------------------------------------------------------------------
// 6. Budgets, windows and pool discipline
// ---------------------------------------------------------------------------

test('one account cannot spray check-ins across thousands of venues', async () => {
  // The dedupe is per venue, so it says nothing about how many DISTINCT venues
  // one account may claim. The manual route has no known-venue gate at all, so
  // this was ~3,000 fabricated rows per 15 minutes per account — every one with
  // a real user_id, and therefore counted by sensors.js and exported for
  // training.
  reset();
  scriptHappyPath();

  let accepted = 0;
  let refused = 0;
  for (let i = 0; i < 25; i++) {
    const res = await call('POST', `/api/checkin/ChIJsprayed${String(i).padStart(6, '0')}`);
    if (res.status === 200) accepted++;
    else if (res.status === 429) refused++;
  }

  assert.strictEqual(accepted, checkin.tapBudget.limits.hourly, 'the hourly ceiling holds');
  assert.strictEqual(refused, 25 - checkin.tapBudget.limits.hourly);
  assert.strictEqual(insertQueries().length, accepted, 'a refused tap writes nothing');
});

test('a refused tap does not burn the venue it was refused at', async () => {
  // The dedupe window is claimed BEFORE the write — that is what makes it a
  // lock. A tap that is then refused has to give the claim back, or a single
  // 429 locks that person out of that venue for the next 30 minutes.
  reset();
  scriptHappyPath();
  for (let i = 0; i < checkin.tapBudget.limits.hourly; i++) {
    await call('POST', `/api/checkin/ChIJburn${String(i).padStart(8, '0')}`);
  }
  const refused = await call('POST', `/api/checkin/${KNOWN}`);
  assert.strictEqual(refused.status, 429);

  checkin.tapBudget.reset(); // as an hour passing would
  const retry = await call('POST', `/api/checkin/${KNOWN}`);
  assert.strictEqual(retry.status, 200);
  assert.ok(!retry.body.deduped, 'and it is a real check-in, not a dedupe stub');
});

test('a check-in whose insert fails can be retried immediately, on both verbs', async () => {
  reset();
  scriptHappyPath({
    insert: (_p, _sql, n) => {
      if (n === 1) throw new Error('deadlock detected');
      return { rows: [{ created_at: '2026-08-14T21:00:00.000Z' }], rowCount: 1 };
    },
  });

  const failed = await call('GET', `/api/checkin/${KNOWN}`, { token: tokenFor(1) });
  assert.strictEqual(failed.status, 500);
  const retry = await call('GET', `/api/checkin/${KNOWN}`, { token: tokenFor(1) });
  assert.strictEqual(retry.status, 200);
  assert.ok(!retry.body.deduped, 'the failed attempt must not have claimed the window');
});

test('an anonymous insert failure gives the IP its window back too', async () => {
  reset();
  scriptHappyPath({
    insert: (_p, _sql, n) => {
      if (n === 1) throw new Error('disk full');
      return { rows: [{ created_at: '2026-08-14T21:00:00.000Z' }], rowCount: 1 };
    },
  });
  assert.strictEqual((await call('GET', `/api/checkin/${KNOWN}`)).status, 500);
  const retry = await call('GET', `/api/checkin/${KNOWN}`);
  assert.strictEqual(retry.status, 200);
  assert.ok(!retry.body.deduped);
});

test('an insert failure never leaks the database error to the caller', async () => {
  reset();
  scriptHappyPath({ insert: () => { throw new Error('relation "venue_checkins" does not exist'); } });
  const res = await call('GET', `/api/checkin/${KNOWN}`);
  assert.strictEqual(res.status, 500);
  assert.strictEqual(res.body.error, 'Failed to record checkin');
  assert.ok(!JSON.stringify(res.body).includes('relation'));
});

test('no route on this file checks a client out of the pool', async () => {
  // Nothing here needs a transaction, and a client taken and not released is
  // how a Node service dies slowly. pool.connect throws in this harness.
  reset();
  scriptHappyPath();
  await call('GET', `/api/checkin/${KNOWN}`, { token: tokenFor(1) });
  await call('POST', `/api/checkin/${KNOWN}/tap`, { token: tokenFor(2) });
  await call('POST', `/api/checkin/${KNOWN}`);
  assert.strictEqual(connectCalls, 0);
});

test('a HEAD request reads, it does not check anybody in', async () => {
  // Express serves HEAD out of a `router.get` handler automatically, so the tap
  // used to run in full — validate, dedupe, INSERT, emit, credit attendance —
  // and then Express threw the body away. HEAD is what link preview bots,
  // uptime monitors and scanners send unprompted; none of them walked into a
  // bar. The HEAD route must also be registered ABOVE the GET, or the GET keeps
  // claiming the method.
  reset();
  scriptHappyPath();

  const res = await call('HEAD', `/api/checkin/${KNOWN}`, { token: tokenFor(1) });
  assert.strictEqual(res.status, 200, 'reachability still answers');
  assert.strictEqual(insertQueries().length, 0, 'and records nothing');
  assert.strictEqual(emits.length, 0);
  assert.strictEqual(res.headers['cache-control'], 'no-store');

  // And it must not have quietly consumed the tap window either.
  const real = await call('GET', `/api/checkin/${KNOWN}`, { token: tokenFor(1) });
  assert.strictEqual(real.body.deduped, undefined, 'the real tap that follows is the first one');
  assert.strictEqual(insertQueries().length, 1);
});

test('the tap endpoint answers to POST and to nothing else', async () => {
  // The point of moving the write is that no safe-method replay can reach it.
  // If a GET or a HEAD ever started matching /:placeId/tap, the fix would have
  // undone itself.
  reset();
  scriptHappyPath();
  for (const method of ['GET', 'HEAD']) {
    const res = await call(method, `/api/checkin/${KNOWN}/tap`);
    assert.strictEqual(res.status, 404, `${method} must not reach the tap write`);
  }
  assert.strictEqual(insertQueries().length, 0);
});

test('HEAD still refuses a malformed or unknown venue', async () => {
  reset();
  scriptHappyPath();
  assert.strictEqual((await call('HEAD', '/api/checkin/short')).status, 400);
  assert.strictEqual((await call('HEAD', `/api/checkin/${UNKNOWN}`)).status, 404);
  assert.strictEqual(insertQueries().length, 0);
});

test('a refusal is uncacheable too, so it cannot outlive onboarding', async () => {
  // A stored 404 for a venue onboarded an hour later would refuse real taps
  // from behind that cache for as long as it kept the entry.
  reset();
  scriptHappyPath();
  const res = await call('GET', `/api/checkin/${UNKNOWN}`);
  assert.strictEqual(res.status, 404);
  assert.strictEqual(res.headers['cache-control'], 'no-store');
});

test('one IP cannot fill the table with anonymous taps across every known venue', async () => {
  // The GET is the app's only unauthenticated INSERT besides guest RSVP. Its
  // dedupe is per (ip, venue), and the known-venue gate admits every curated
  // ml_venues row — thousands of them — so one IP could write on the order of a
  // hundred thousand NULL-user rows a day.
  reset();
  scriptHappyPath({ knownIds: null }); // every shaped id is known, worst case

  let accepted = 0;
  let refused = 0;
  for (let i = 0; i < checkin.ANON_TAPS_PER_HOUR + 5; i++) {
    const res = await call('GET', `/api/checkin/ChIJanonspray${String(i).padStart(5, '0')}`);
    if (res.status === 200) accepted++;
    else if (res.status === 429) refused++;
  }

  assert.strictEqual(accepted, checkin.ANON_TAPS_PER_HOUR);
  assert.strictEqual(refused, 5);
  assert.strictEqual(insertQueries().length, accepted, 'a refused anonymous tap writes nothing');
});

test('flooding the anonymous budget map does not hand the flooder a fresh allowance', async () => {
  // The counter this replaces would have been reset by its own overflow. Anyone
  // able to push the map past its bound could therefore wipe their own entry.
  reset();
  const { anonTapAllowed, anonTapBudget, ANON_TAPS_PER_HOUR } = checkin;

  for (let i = 0; i < ANON_TAPS_PER_HOUR; i++) assert.strictEqual(anonTapAllowed('9.9.9.9'), true);
  assert.strictEqual(anonTapAllowed('9.9.9.9'), false, 'at the ceiling');

  for (let i = 0; i < 6000; i++) anonTapAllowed(`10.1.${Math.floor(i / 256)}.${i % 256}`);

  assert.ok(anonTapBudget.size <= 5000, 'still bounded');
  assert.strictEqual(anonTapAllowed('9.9.9.9'), false, "the flooder's own counter must survive");
});

test('an anonymous write that fails does not cost the caller an hour of allowance', async () => {
  reset();
  scriptHappyPath({ insert: () => { throw new Error('disk full'); } });
  const before = checkin.anonTapBudget.get('::ffff:127.0.0.1')?.length || 0;
  assert.strictEqual((await call('GET', `/api/checkin/${KNOWN}`)).status, 500);
  const after = checkin.anonTapBudget.get('::ffff:127.0.0.1')?.length || 0;
  assert.strictEqual(after, before, 'the failed tap was refunded');
});

test('a socket fan-out failure never un-records a committed check-in', async () => {
  // The row is already written by the time the emit runs. Letting the emit throw
  // turned a recorded check-in into a 500 the client would then retry — the same
  // "post-commit work inside the try block" bug the billing route had.
  reset();
  scriptHappyPath();
  const savedTo = io.to;
  io.to = () => { throw new Error('adapter is gone'); };
  try {
    const res = await call('POST', `/api/checkin/${KNOWN}`);
    assert.strictEqual(res.status, 200, 'the check-in stands');
    assert.strictEqual(res.body.checked_in_at, '2026-08-14T21:00:00.000Z');
  } finally { io.to = savedTo; }
});

test('an insert that reports no row is an error, not a half-recorded tap', async () => {
  // The anonymous path used to read `rows[0].created_at` outside the try, so a
  // driver returning nothing threw a TypeError PAST the refund path and left
  // the 30-minute window claimed for a row that does not exist.
  reset();
  scriptHappyPath({ insert: () => ({ rows: [], rowCount: 0 }) });

  const res = await call('GET', `/api/checkin/${KNOWN}`);
  assert.strictEqual(res.status, 500);
  assert.strictEqual(res.body.error, 'Failed to record checkin');

  scriptHappyPath(); // the database recovers
  const retry = await call('GET', `/api/checkin/${KNOWN}`);
  assert.strictEqual(retry.status, 200);
  assert.ok(!retry.body.deduped, 'the window was given back');
});

test('the dedupe binds to the account, so rotating IPs buys nothing', () => {
  reset();
  assert.strictEqual(checkin.tapIsDuplicate(7, KNOWN, '1.1.1.1'), false);
  assert.strictEqual(checkin.tapIsDuplicate(7, KNOWN, '9.9.9.9'), true, 'a new IP does not reset a user');
  assert.strictEqual(checkin.tapIsDuplicate(null, KNOWN, '1.1.1.1'), false, 'anon is its own key');
  assert.strictEqual(checkin.tapIsDuplicate(null, KNOWN, '1.1.1.1'), true);
  assert.strictEqual(checkin.tapIsDuplicate(null, KNOWN, '2.2.2.2'), false, 'a different IP is a different phone');
});
