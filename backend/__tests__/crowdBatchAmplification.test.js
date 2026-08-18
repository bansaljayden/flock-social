// Run: node --test  (from backend/)
//
// ---------------------------------------------------------------------------
// POST /api/crowd/batch AS A COST AMPLIFIER — money audit round 2, finding M1
// (plus the invite-push half of M3, which is the same shape one layer up).
// ---------------------------------------------------------------------------
//
// The endpoint accepts twenty venue objects and hands each one to
// predictBusyness, which fans out to Ticketmaster once per venue. Two separate
// facts made that a lever rather than a cost:
//
//   1. THE CACHE KEY WAS THE CALLER'S TO CHOOSE. eventCache keys on
//      `lat.toFixed(3),lng.toFixed(3),<UTC hour>` and lat/lng came straight off
//      the request body, so walking the FOURTH decimal place missed the cache
//      on every item of every request, forever. Twenty paid calls per POST that
//      could never be served from memory.
//   2. THE ONLY CEILING HAD NO CALLER ON IT. EVENT_DAILY_BUDGET is 1500 and
//      process-wide. 1500 / 20 = 75 requests, and apiLimiter allows 200 a
//      minute, so ~23 seconds of one authenticated session stripped event
//      enrichment from every crowd surface, for every user, until UTC midnight.
//
// The fix is the pair: bucket the coordinates to the same ~1 km precision
// routes/publicCrowd.js has always applied to ITS caller coordinates, and give
// the event budget the per-account leg that utils/placesBudget.js and
// services/birdieUsage.js already have.
//
// WHAT EACH TEST BELOW IS ALLOWED TO CONCLUDE. The route-level cases drive the
// real router with a predictBusyness that forwards to the REAL
// _internals.getNearbyEvents, so "one upstream call" is counted at global.fetch
// and not asserted from a mock's argument list. The budget cases drive the real
// allowEventFetch. The one link neither can execute end to end without a loaded
// ONNX model — predictBusyness handing its userId down to getNearbyEvents — is
// pinned against the source, in the same style edgeCaseSweep.test.js pins the
// event-cache clear.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

process.env.JWT_SECRET = 'crowd-batch-amplification-test-secret';
process.env.TICKETMASTER_API_KEY = 'tm-amplification-test-key';
delete process.env.PAYWALL_ENABLED;
delete process.env.FIREBASE_SERVICE_ACCOUNT;

// --- pg fake that dispatches on the clause under test -----------------------
// House rule: an unrecognised statement is RECORDED, never silently answered
// with zero rows. A fake that answers everything with `{ rows: [] }` cannot
// tell a query on the right thing from a query on the wrong thing.
const pool = require('../config/database');

let unknownSql = [];
let BLOCKED_PAIRS = [];   // [[a, b]]
let VISIBLE = true;       // what canNotify's roster lookup answers

pool.query = (sql, params) => {
  const flat = String(sql).replace(/\s+/g, ' ').trim();
  if (/FROM venue_feedback/.test(flat)) return Promise.resolve({ rows: [], rowCount: 0 });
  if (/SELECT 1 FROM user_blocks/.test(flat)) {
    const [a, b] = params || [];
    const hit = BLOCKED_PAIRS.some(([x, y]) => (
      (Number(x) === Number(a) && Number(y) === Number(b))
      || (Number(x) === Number(b) && Number(y) === Number(a))
    ));
    return Promise.resolve({ rows: hit ? [{ ok: 1 }] : [], rowCount: hit ? 1 : 0 });
  }
  // canNotify's single lookup: recipient ban state, actor ban state, visibility.
  if (/FROM users u/.test(flat) && /can_see/.test(flat)) {
    return Promise.resolve({
      rows: [{ is_banned: false, actor_banned: false, can_see: VISIBLE }],
      rowCount: 1,
    });
  }
  unknownSql.push(flat);
  return Promise.resolve({ rows: [], rowCount: 0 });
};

const authMod = require('../middleware/auth');
authMod.authenticate = (req, _res, next) => {
  req.user = { id: Number(req.headers['x-test-user'] || 3), name: 'Ava', role: 'user' };
  next();
};

const weatherService = require('../services/weatherService');
weatherService.getWeather = async () => null;
weatherService.getForecast = async () => [];

const crowdEngine = require('../services/crowdEngine');
const mlPredictor = require('../services/mlPredictor');
const { _internals } = mlPredictor;

// --- upstream counter -------------------------------------------------------
// Only Ticketmaster is counted. A call to Google from this route is a bug in
// its own right (the batch endpoint is fed from the request body) and fails
// loudly rather than being tallied.
const realFetch = global.fetch;
let tmCalls = [];
let TM_EVENTS = [];

global.fetch = async (url) => {
  const u = String(url);
  if (u.startsWith('https://places.googleapis.com/')) {
    throw new Error(`the batch route called Google: ${u}`);
  }
  if (u.startsWith('https://app.ticketmaster.com/')) {
    tmCalls.push(u);
    return { ok: true, status: 200, json: async () => ({ _embedded: { events: TM_EVENTS } }) };
  }
  throw new Error(`unexpected upstream: ${u}`);
};
test.after(() => { global.fetch = realFetch; });

// --- predictBusyness stand-in that spends the REAL event path ---------------
// The ONNX model is not loaded in the test process, so the real predictBusyness
// answers from the rule engine and never reaches Ticketmaster. This stand-in
// takes the two arguments the route actually controls — the venue's location
// and the options bag — and drives the genuine getNearbyEvents with them, which
// is the leg under audit. The timestamp is pinned so the UTC hour slot in the
// cache key cannot change under a test that straddles an hour boundary.
const FIXED_EVENT_INSTANT = new Date('2026-08-14T23:00:00Z');
let PREDICT_CALLS = [];

mlPredictor.predictBusyness = async (v, _w, ts, options = {}) => {
  const lat = (v.location && v.location.latitude) || 0;
  const lng = (v.location && v.location.longitude) || 0;
  const eventData = await _internals.getNearbyEvents(lat, lng, FIXED_EVENT_INSTANT, options.userId);
  PREDICT_CALLS.push({ place_id: v.place_id, lat, lng, options, eventData, hour: ts.getHours() });
  return {
    score: 50,
    label: crowdEngine.getLabel(50),
    confidence: 60,
    factors: {},
    dataSourcesUsed: ['ml_model'],
    predictionMethod: 'ml',
    modelVersion: 'test',
  };
};

const crowdRouter = require('../routes/crowd');
const app = express();
app.use(express.json());
app.use('/api/crowd', crowdRouter);

let base;
const server = http.createServer(app);
test.before(() => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); });
}));
test.after(() => new Promise((resolve) => { server.close(resolve); }));

function postBatch(body, userId = 3) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(`${base}/api/crowd/batch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-test-user': String(userId),
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(raw); } catch (_) { parsed = raw; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function resetAll() {
  tmCalls = [];
  TM_EVENTS = [];
  PREDICT_CALLS = [];
  unknownSql = [];
  _internals.__resetEventBudget();
}

// ---------------------------------------------------------------------------
// 1. THE CACHE KEY IS NO LONGER THE CALLER'S TO CHOOSE
// ---------------------------------------------------------------------------

test('two batch requests differing only in the 4th decimal of lat share one cache entry and one upstream call', async () => {
  resetAll();

  const first = await postBatch({
    venues: [{ place_id: 'ChIJprobe0000000000001', name: 'The Fig', location: { latitude: 40.71234, longitude: -73.98765 } }],
    localHour: 20,
    localDay: 5,
  });
  assert.strictEqual(first.status, 200);
  assert.strictEqual(tmCalls.length, 1, 'the first, genuinely cold lookup must reach Ticketmaster exactly once');

  // Same venue, same metre-ish spot, fourth decimal walked. Before bucketing
  // this minted a brand new cache key and bought a second call.
  const second = await postBatch({
    venues: [{ place_id: 'ChIJprobe0000000000001', name: 'The Fig', location: { latitude: 40.71239, longitude: -73.98761 } }],
    localHour: 20,
    localDay: 5,
  });
  assert.strictEqual(second.status, 200);
  assert.strictEqual(tmCalls.length, 1,
    'walking the 4th decimal must be answered from cache — it bought a second paid Ticketmaster call before bucketing');

  // And the reason it is one call: both requests were rounded to the same
  // ~1 km bucket before anything downstream saw them.
  assert.deepStrictEqual(
    PREDICT_CALLS.map((c) => [c.lat, c.lng]),
    [[40.71, -73.99], [40.71, -73.99]],
    'the predictor must be handed coordinates bucketed to 2 decimals, matching routes/publicCrowd.js');
});

test('a 20-venue body walking the 4th decimal collapses to one bucket, not twenty', async () => {
  resetAll();
  const venues = [];
  for (let i = 0; i < 20; i++) {
    venues.push({
      place_id: `ChIJspray${String(i).padStart(14, '0')}`,
      name: `Venue ${i}`,
      location: { latitude: 40.7100 + i * 0.0001, longitude: -73.9900 + i * 0.0001 },
    });
  }
  const res = await postBatch({ venues, localHour: 20, localDay: 5 });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.predictions.length, 20, 'every venue must still be scored');
  assert.strictEqual(tmCalls.length, 1,
    'twenty venues inside one ~1 km bucket must be one Ticketmaster call, not twenty');
});

test('bucketing changes the cache key, never which venues are answered', async () => {
  // The rounding is a cache/upstream concern. It must not change WHICH venues
  // are answered or how many, or "make the number go down" would have been
  // bought by dropping data.
  resetAll();
  const res = await postBatch({
    venues: [
      { place_id: 'ChIJfarapart000000001', name: 'A', location: { latitude: 40.71, longitude: -73.99 } },
      { place_id: 'ChIJfarapart000000002', name: 'B', location: { latitude: 41.88, longitude: -87.63 } },
    ],
    localHour: 20,
    localDay: 5,
  });
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body.predictions.map((p) => p.placeId),
    ['ChIJfarapart000000001', 'ChIJfarapart000000002']);
  assert.strictEqual(tmCalls.length, 2,
    'two venues a thousand kilometres apart are still two different questions');
});

// ---------------------------------------------------------------------------
// 2. THE PER-ACCOUNT CEILING BITES BEFORE THE GLOBAL ONE
// ---------------------------------------------------------------------------

test('one account cannot exhaust the process-wide event budget', () => {
  const { EVENT_DAILY_BUDGET, EVENT_USER_DAILY, EVENT_USER_HOURLY, EVENT_CACHE_MAX } = _internals;

  // The two inequalities the comment above allowEventFetch calls load-bearing.
  assert.ok(EVENT_USER_DAILY < EVENT_DAILY_BUDGET,
    `a per-account ceiling of ${EVENT_USER_DAILY} must sit below the global ${EVENT_DAILY_BUDGET}, or one account is still the whole budget`);
  assert.ok(EVENT_USER_DAILY < EVENT_CACHE_MAX,
    `a per-account ceiling of ${EVENT_USER_DAILY} must sit below EVENT_CACHE_MAX (${EVENT_CACHE_MAX}): an entry is only written after a charged upstream call, so this is what stops one account evicting everybody else's cached areas`);

  _internals.__resetEventBudget();
  let allowed = 0;
  for (let i = 0; i < EVENT_DAILY_BUDGET; i++) {
    if (!_internals.allowEventFetch(4242)) break;
    allowed++;
  }
  assert.strictEqual(allowed, EVENT_USER_HOURLY,
    'the rolling per-account hourly ceiling is what must stop the run, well before the global daily one');
  assert.strictEqual(_internals.allowEventFetch(4242), false, 'and it must stay refused');

  // The global budget still has almost everything left, which is the point:
  // the attacker degraded their own enrichment, not everyone's.
  assert.strictEqual(_internals.allowEventFetch(9999), true,
    'a second, innocent account must still be served after the first has spent its allowance');
});

test('a refused per-account charge spends nothing, and an unidentified caller keeps the old global-only metering', () => {
  const { EVENT_USER_HOURLY } = _internals;
  _internals.__resetEventBudget();

  for (let i = 0; i < EVENT_USER_HOURLY; i++) assert.strictEqual(_internals.allowEventFetch(51), true);
  for (let i = 0; i < 50; i++) assert.strictEqual(_internals.allowEventFetch(51), false);

  // Background producers (services/crowdAlerts.js) and the unauthenticated
  // marketing demo pass no userId and must be unaffected.
  assert.strictEqual(_internals.allowEventFetch(), true,
    'a caller with no account must still be metered globally rather than refused');
  assert.strictEqual(_internals.allowEventFetch(null), true);

  // A userId that is supplied but malformed fails CLOSED — same rule as
  // utils/placesBudget.js keyOf().
  assert.strictEqual(_internals.allowEventFetch(true), false);
  assert.strictEqual(_internals.allowEventFetch(-1), false);
  assert.strictEqual(_internals.allowEventFetch('abc'), false);
});

test('the batch route charges the event budget to the caller, per upstream call', async () => {
  resetAll();
  const venues = [];
  for (let i = 0; i < 20; i++) {
    venues.push({
      place_id: `ChIJcharge${String(i).padStart(13, '0')}`,
      name: `V${i}`,
      // A full degree apart, so bucketing cannot collapse them: twenty real
      // upstream calls, twenty charges.
      location: { latitude: 10 + i, longitude: 20 + i },
    });
  }
  const before = _internals.eventBudgetRemaining(77);
  const res = await postBatch({ venues, localHour: 20, localDay: 5 }, 77);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(tmCalls.length, 20);
  const after = _internals.eventBudgetRemaining(77);
  assert.strictEqual(before.hourly - after.hourly, 20,
    'twenty Ticketmaster calls must cost the caller twenty units — a fan-out charged as one request is how the budget was defeated');
  assert.ok(PREDICT_CALLS.every((c) => c.options && c.options.userId === 77),
    'every prediction on this route must carry the caller identity the budget is charged against');
});

test('a cache HIT costs the caller nothing', async () => {
  resetAll();
  const body = {
    venues: [{ place_id: 'ChIJfreehit0000000001', name: 'Warm', location: { latitude: 40.71, longitude: -73.99 } }],
    localHour: 20,
    localDay: 5,
  };
  await postBatch(body, 78);
  const afterCold = _internals.eventBudgetRemaining(78);
  await postBatch(body, 78);
  const afterWarm = _internals.eventBudgetRemaining(78);
  assert.strictEqual(tmCalls.length, 1);
  assert.strictEqual(afterCold.hourly, afterWarm.hourly,
    'charging for a call we did not make masks the real burn rate (utils/placesBudget.js)');
});

// ---------------------------------------------------------------------------
// 3. A REAL REQUEST STILL GETS EVENT ENRICHMENT
//
// The failure mode this whole change must not have is "the number went down
// because the feature stopped working".
// ---------------------------------------------------------------------------

test('a real batch request still receives event enrichment', async () => {
  resetAll();
  TM_EVENTS = [{
    name: 'Sold Out At The Garden',
    classifications: [{ segment: { name: 'Music' } }],
    _embedded: {
      venues: [{
        name: 'Madison Square Garden',
        location: { latitude: '40.7505', longitude: '-73.9934' },
        capacity: 20000,
      }],
    },
  }];

  const res = await postBatch({
    venues: [{
      place_id: 'ChIJrealuser000000001',
      name: 'Bar Near The Garden',
      types: ['bar'],
      location: { latitude: 40.7505, longitude: -73.9934 },
    }],
    localHour: 20,
    localDay: 5,
  }, 91);

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.predictions.length, 1);
  assert.strictEqual(tmCalls.length, 1, 'a cold, legitimate lookup must still reach Ticketmaster');

  const enrichment = PREDICT_CALLS[0].eventData;
  assert.strictEqual(enrichment.hasEvent, true,
    'event enrichment must survive the fix — this is the feature, not the leak');
  assert.strictEqual(enrichment.nearestName, 'Sold Out At The Garden');
  assert.ok(enrichment.totalEvents >= 1);

  // And the coordinates that went up the wire are the bucketed ones, which is
  // still well inside Ticketmaster's 2 km search radius for this venue.
  assert.match(tmCalls[0], /latlong=40\.75%2C-73\.99/,
    'the upstream query must use the bucketed coordinates, or the cache key and the call describe different places');
});

// ---------------------------------------------------------------------------
// 4. THE ONE LINK THE TESTS ABOVE CANNOT EXECUTE
//
// predictBusyness -> getNearbyEvents needs a loaded ONNX model to run for real,
// so it is pinned against the source instead of being left unpinned. Same
// approach edgeCaseSweep.test.js takes for the event-cache clear.
// ---------------------------------------------------------------------------

test('predictBusyness forwards the caller identity down to the event fetch', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'mlPredictor.js'), 'utf8');
  assert.match(src, /async function predictBusyness\(venue, weather, timestamp, options = \{\}\)/,
    'predictBusyness must accept the options bag the routes pass');
  assert.match(src, /getNearbyEvents\(lat, lng, eventInstant, userId\)/,
    'the userId must reach getNearbyEvents, or the per-account ceiling is decorative');
  assert.match(src, /if \(!allowEventFetch\(userId\)\) return noEvents;/,
    'getNearbyEvents must charge the identified budget, not the anonymous one');
  assert.match(src, /const result = await predictBusyness\(venue, weather, ts, options\);/,
    'the 24-hour forecast is the biggest event fan-out in the app and must be charged too');
});

test('every authenticated crowd surface passes a caller identity to the predictor', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'crowd.js'), 'utf8');
  const calls = src.match(/mlPredictor\.predict(?:Busyness|HourlyForecast)\([^;]*?\);/g) || [];
  assert.ok(calls.length >= 5, `expected every predictor call site to be found, saw ${calls.length}`);
  for (const call of calls) {
    assert.match(call, /\{ userId: req\.user\.id \}/,
      `an unidentified predictor call is an uncharged Ticketmaster fan-out: ${call}`);
  }
  assert.match(src, /latitude: \+\(\+v\.location\.latitude\)\.toFixed\(2\)/,
    'the batch route must bucket caller coordinates to 2 decimals, as routes/publicCrowd.js does');
});

// ---------------------------------------------------------------------------
// 5. THE INVITE PUSH DEBOUNCE IS KEYED ON THE RECIPIENT (finding M3)
//
// pushHelper debounces per conversation — `${userId}|${type}|f${flockId}` — and
// an invite's flock id is new by construction, so the window could never fire.
// POST /:id/rerun made that concrete: it mints a fresh flock from an old roster
// on demand, so the whole invite allowance landed as distinct lock-screen
// notifications on one person.
// ---------------------------------------------------------------------------

const firebaseService = require('../services/firebaseService');
const flocksRouter = require('../routes/flocks');
const { pushInvitesToOffline } = flocksRouter.__testables;

let SENT = [];
firebaseService.isEnabled = () => true;
firebaseService.sendPushToUser = async (userId, title, body, data) => {
  SENT.push({ userId, title, body, data });
  return { sent: 1, failed: 0 };
};

// Nobody is connected, so every invite is a lock-screen push — which is the
// case the debounce exists for.
const offlineIo = { sockets: { adapter: { rooms: new Map() } } };
const inviter = { id: 1, name: 'Mallory' };

function resetPush() {
  SENT = [];
  BLOCKED_PAIRS = [];
  VISIBLE = true;
  flocksRouter.__resetBudgets();
}

test('N reruns inviting the same person from N different flocks produce ONE push', async () => {
  resetPush();
  // Ten distinct flock ids: exactly what ten reruns of one completed flock mint.
  for (let flockId = 500; flockId < 510; flockId++) {
    // eslint-disable-next-line no-await-in-loop
    await pushInvitesToOffline({
      io: offlineIo,
      inviter,
      flockId,
      flockName: `Rooftop Friday #${flockId}`,
      invited: [{ user_id: 42 }],
    });
  }
  assert.strictEqual(SENT.length, 1,
    'ten flocks, one victim: a flock-scoped debounce key mints a fresh key every time and never fires');
  assert.strictEqual(SENT[0].userId, 42);
});

test('the debounce is per recipient, so it never swallows a different persons invite', async () => {
  resetPush();
  await pushInvitesToOffline({
    io: offlineIo,
    inviter,
    flockId: 600,
    flockName: 'Rooftop Friday',
    invited: [{ user_id: 11 }, { user_id: 12 }, { user_id: 13 }],
  });
  assert.deepStrictEqual(SENT.map((s) => s.userId).sort((a, b) => a - b), [11, 12, 13],
    'three different people are three different notifications — the recipient is in the key for exactly this reason');
});

test('a suppressed push does not suppress the invite: the payload and the flock id are untouched', async () => {
  resetPush();
  await pushInvitesToOffline({
    io: offlineIo, inviter, flockId: 700, flockName: 'First', invited: [{ user_id: 55 }],
  });
  await pushInvitesToOffline({
    io: offlineIo, inviter, flockId: 701, flockName: 'Second', invited: [{ user_id: 55 }],
  });
  assert.strictEqual(SENT.length, 1);
  // Deep-link navigation still works off the one push that did go out.
  assert.strictEqual(SENT[0].data.type, 'flock_invite');
  assert.strictEqual(SENT[0].data.flockId, '700');
  assert.strictEqual(SENT[0].data.fromUserId, '1');
});

test('a push that never went out releases the window rather than burning it', async () => {
  resetPush();
  // Blocked pair: canNotify refuses, deliver returns { skipped }. The next
  // legitimate invite to the same person must NOT be suppressed on the strength
  // of a delivery that never happened.
  BLOCKED_PAIRS = [[42, 1]];
  await pushInvitesToOffline({
    io: offlineIo, inviter, flockId: 800, flockName: 'Blocked', invited: [{ user_id: 42 }],
  });
  assert.strictEqual(SENT.length, 0, 'a blocked pair must not receive a push at all');

  BLOCKED_PAIRS = [];
  await pushInvitesToOffline({
    io: offlineIo, inviter, flockId: 801, flockName: 'Allowed', invited: [{ user_id: 42 }],
  });
  assert.strictEqual(SENT.length, 1,
    'the suppressed delivery must have released the debounce window');
});

test('the pg fake understood every statement these cases produced', () => {
  assert.deepStrictEqual(unknownSql, [],
    `unmodelled SQL reached the fake — a test that answers an unknown query with zero rows passes for the wrong reason:\n${unknownSql.join('\n')}`);
});
