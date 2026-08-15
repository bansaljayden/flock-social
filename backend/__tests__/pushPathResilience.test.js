// Run: node --test  (from backend/)
//
// Push path resilience — the failure modes BETWEEN the ones already pinned.
//
// __tests__/pushDelivery.test.js covers deep links, the visibility gate and the
// stale-token codes; __tests__/pushDeliveryHardening.test.js covers text
// integrity, deadlines, prune scoping and the crowd-alert copy. This file
// covers what survived both:
//
//   1. DEDUPE UNDER CONCURRENCY. Two instances that both pass the cheap
//      "already alerted?" pre-check must still produce exactly one push. The
//      pre-check is a check-then-act window by design; the INSERT ... ON
//      CONFLICT (flock_id, alert_type) DO NOTHING claim is the actual lock,
//      and this file drives two overlapping sweeps through the widest possible
//      window to prove the claim closes it.
//   2. MIXED-OUTCOME BATCHES. One dead token, one 5xx, one live device in the
//      same fan-out: the live device is reached, only the corpse is pruned,
//      and a 404-class-vs-transient misread never deletes a live token.
//   3. THE PRUNE IS BEST-EFFORT. The stale-token DELETE used to sit inside the
//      same try as the send accounting, so a transient DB failure during
//      CLEANUP reported { sent: 0, failed: 0 } for a batch that was already
//      delivered — and services/crowdAlerts.js releases its once-per-flock
//      claim on that answer, so the next sweep re-sent the same alert to every
//      member who already had it on their lock screen.
//   4. ISOLATION. One member's send rejecting must not cancel the rest of the
//      flock, and a Firebase init failure must degrade every caller to a
//      no-op rather than crash a request path or burn a claim.
//   5. HONESTY. The only numbers in crowd-alert copy are ones the engine
//      computed, and no em or en dash ever reaches a lock screen.
const test = require('node:test');
const { mock } = require('node:test');
const assert = require('node:assert');

process.env.JWT_SECRET = 'push-resilience-test-secret';
delete process.env.FIREBASE_SERVICE_ACCOUNT;
delete process.env.WEATHER_API_KEY;
delete process.env.PAYWALL_ENABLED;

// firebase-admin is stubbed at the module boundary (the require cache), the
// way the auth suites stub jwks/resend/appleAuth. services/firebaseService.js
// requires it LAZILY inside init(), so seeding the cache here intercepts the
// first real init even though firebaseService is loaded below.
const adminPath = require.resolve('firebase-admin');
const adminStub = { initCalls: 0, initError: null };
require.cache[adminPath] = {
  id: adminPath,
  filename: adminPath,
  loaded: true,
  exports: {
    credential: { cert: (x) => x },
    initializeApp: () => {
      adminStub.initCalls += 1;
      if (adminStub.initError) throw adminStub.initError;
      return {};
    },
    messaging: () => ({ send: async () => 'ok' }),
  },
};

const pool = require('../config/database');

let handlers = [];
let log = [];

function dispatch(sql, params) {
  log.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
  for (const [re, fn] of handlers) {
    if (re.test(sql)) {
      const out = fn(params || [], String(sql));
      return Promise.resolve(out === undefined ? { rows: [], rowCount: 0 } : out);
    }
  }
  return Promise.reject(new Error(`unscripted query: ${String(sql).replace(/\s+/g, ' ').slice(0, 120)}`));
}

pool.query = (sql, params) => dispatch(sql, params);

const firebaseService = require('../services/firebaseService');
const pushHelper = require('../services/pushHelper');
const crowdAlerts = require('../services/crowdAlerts');

function reset() {
  handlers = [];
  log = [];
  pushHelper._resetDebounce();
  firebaseService.__setSenderForTests(null);
}

function on(re, fn) { handlers.push([re, fn]); }

// A confirmed flock at a well-reviewed bar 90 minutes out, pinned to a Friday
// 8pm ET so the rule engine's score clears the alert threshold no matter when
// the suite actually runs. Latitude/longitude are null so the sweep skips the
// weather call entirely rather than depending on an unset API key.
function flockRow() {
  return {
    id: 7, name: 'Fri', venue_id: 'p1', venue_name: 'The Pearl',
    venue_latitude: null, venue_longitude: null,
    event_time: new Date(Date.now() + 90 * 60 * 1000),
  };
}

function scriptBusyFlock({ members } = {}) {
  on(/DELETE FROM crowd_alert_sends WHERE sent_at/i, () => ({ rowCount: 0 }));
  on(/FROM flocks f\s+WHERE f\.status/i, () => ({ rows: [flockRow()] }));
  on(/SELECT 1 FROM crowd_alert_sends/i, () => ({ rows: [], rowCount: 0 }));
  on(/FROM ml_venues/i, () => ({
    rows: [{ google_types: ['bar', 'night_club'], review_count: 4000, rating: 4.5, price_level: 2, timezone: 'America/New_York' }],
  }));
  on(/FROM flock_members/i, () => ({
    rows: members || [{ user_id: 1, user_settings: null }],
  }));
  on(/FROM users u/i, () => ({ rows: [{ is_banned: false, actor_banned: false, can_see: true }] }));
}

// ---------------------------------------------------------------------------
// 1. Dedupe under concurrency
// ---------------------------------------------------------------------------
test('two instances racing through the pre-check window cannot both push the same flock', async () => {
  mock.timers.enable({ apis: ['Date'], now: new Date('2026-08-15T00:00:00Z') }); // Fri 8pm ET
  reset();

  // Real ON CONFLICT semantics for the claim: a shared marker set stands in
  // for the primary key, exactly one INSERT can win.
  const markers = new Set();
  const claims = [];
  const sent = [];

  scriptBusyFlock();
  // The pre-check tells BOTH instances "not yet alerted" — the widest possible
  // check-then-act window. If the pre-check were the only dedupe, this test
  // would deliver twice.
  on(/INSERT INTO crowd_alert_sends/i, (params, sql) => {
    // The claim must BE the lock: atomic conflict handling in the statement,
    // not a read followed by a write.
    assert.match(sql, /ON CONFLICT \(flock_id, alert_type\) DO NOTHING/i);
    const key = `${params[0]}|${params[1]}`;
    const won = !markers.has(key);
    if (won) markers.add(key);
    claims.push(won);
    return { rowCount: won ? 1 : 0 };
  });

  const prevEnabled = firebaseService.isEnabled;
  const prevSend = firebaseService.sendPushToUser;
  firebaseService.isEnabled = () => true;
  firebaseService.sendPushToUser = async (userId) => { sent.push(userId); return { sent: 1, failed: 0 }; };
  try {
    await Promise.all([crowdAlerts.checkCrowdAlerts(), crowdAlerts.checkCrowdAlerts()]);
  } finally {
    firebaseService.isEnabled = prevEnabled;
    firebaseService.sendPushToUser = prevSend;
    mock.timers.reset();
  }

  assert.strictEqual(claims.length, 2, 'both instances really reached the claim — the race window was open');
  assert.strictEqual(claims.filter(Boolean).length, 1, 'exactly one instance won the row');
  assert.deepStrictEqual(sent, [1], 'the member was pushed once, not once per instance');
});

// ---------------------------------------------------------------------------
// 2. Mixed-outcome batches
// ---------------------------------------------------------------------------
test('one dead token, one flaky backend, one live device: the live device is reached, only the corpse is pruned', async () => {
  reset();
  on(/SELECT id, token FROM device_tokens/i, () => ({
    rows: [{ id: 1, token: 't-dead' }, { id: 2, token: 't-5xx' }, { id: 3, token: 't-live' }],
  }));
  const deletes = [];
  on(/DELETE FROM device_tokens/i, (params, sql) => { deletes.push({ params, sql }); return { rowCount: 1 }; });
  firebaseService.__setSenderForTests((message) => {
    if (message.token === 't-dead') {
      const e = new Error('Requested entity was not found.');
      e.code = 'messaging/registration-token-not-registered'; // 404-class: the token is gone
      throw e;
    }
    if (message.token === 't-5xx') {
      const e = new Error('Internal error encountered.');
      e.code = 'messaging/internal-error'; // 5xx-class: the token may be fine
      throw e;
    }
    return 'ok';
  });

  const res = await firebaseService.sendPushToUser(9, 'T', 'B', {});
  assert.deepStrictEqual(res, { sent: 1, failed: 2 });
  assert.strictEqual(deletes.length, 1, 'exactly one prune, for exactly the dead token');
  assert.deepStrictEqual(deletes[0].params, [[1], 9], 'the 5xx token and the live token survive');
  assert.match(deletes[0].sql, /user_id\s*=\s*\$2/i, 'scoped to the account that was pushed');
});

test('invalid-argument is only fatal to the token when the token is the invalid part', async () => {
  // Same provider code, two meanings: a malformed PAYLOAD (our bug, token
  // fine) and a malformed TOKEN. Deleting on the first would unsubscribe a
  // healthy device because we sent it a bad body.
  reset();
  on(/SELECT id, token FROM device_tokens/i, () => ({ rows: [{ id: 5, token: 't1' }] }));
  firebaseService.__setSenderForTests(() => {
    const e = new Error('Invalid JSON payload received.');
    e.code = 'messaging/invalid-argument';
    throw e;
  });
  await firebaseService.sendPushToUser(9, 'T', 'B', {});
  assert.ok(!log.some((q) => /DELETE FROM device_tokens/i.test(q.sql)), 'a payload complaint never deletes a token');

  reset();
  on(/SELECT id, token FROM device_tokens/i, () => ({ rows: [{ id: 5, token: 't1' }] }));
  const deletes = [];
  on(/DELETE FROM device_tokens/i, (params) => { deletes.push(params); return { rowCount: 1 }; });
  firebaseService.__setSenderForTests(() => {
    const e = new Error('The registration token is not a valid FCM registration token');
    e.code = 'messaging/invalid-argument';
    throw e;
  });
  await firebaseService.sendPushToUser(9, 'T', 'B', {});
  assert.deepStrictEqual(deletes, [[[5], 9]], 'a token complaint prunes the token');
});

// ---------------------------------------------------------------------------
// 3. The prune is best-effort cleanup, not part of the delivery verdict
// ---------------------------------------------------------------------------
test('a failed stale-token prune does not convert delivered pushes into a reported failure', async () => {
  reset();
  on(/SELECT id, token FROM device_tokens/i, () => ({ rows: [{ id: 1, token: 't-dead' }, { id: 2, token: 't-live' }] }));
  on(/DELETE FROM device_tokens/i, () => Promise.reject(new Error('connection terminated unexpectedly')));
  firebaseService.__setSenderForTests((message) => {
    if (message.token === 't-dead') {
      const e = new Error('gone'); e.code = 'messaging/registration-token-not-registered'; throw e;
    }
    return 'ok';
  });

  const res = await firebaseService.sendPushToUser(9, 'T', 'B', {});
  // The push reached a device. A DELETE that failed AFTERWARDS is a cleanup
  // problem for the next send, not evidence that nothing was delivered.
  assert.deepStrictEqual(res, { sent: 1, failed: 1 });
});

test('a database blip during token cleanup cannot re-arm a crowd alert that was delivered', async () => {
  // End to end through the sweep: the member's live device gets the alert, the
  // dead token's prune DELETE fails, and the once-per-flock claim must STAY —
  // releasing it schedules the same lock-screen push again next sweep for
  // everyone who already received it.
  mock.timers.enable({ apis: ['Date'], now: new Date('2026-08-15T00:00:00Z') });
  reset();
  let released = 0;
  scriptBusyFlock();
  on(/INSERT INTO crowd_alert_sends/i, () => ({ rowCount: 1 }));
  on(/DELETE FROM crowd_alert_sends WHERE flock_id/i, () => { released += 1; return { rowCount: 1 }; });
  on(/SELECT settings FROM user_settings/i, () => ({ rows: [] })); // never opted out
  on(/SELECT id, token FROM device_tokens/i, () => ({
    rows: [{ id: 21, token: 't-live' }, { id: 22, token: 't-dead' }],
  }));
  on(/DELETE FROM device_tokens/i, () => Promise.reject(new Error('deadlock detected')));

  const delivered = [];
  firebaseService.__setSenderForTests((message) => {
    if (message.token === 't-dead') {
      const e = new Error('gone'); e.code = 'messaging/registration-token-not-registered'; throw e;
    }
    delivered.push(message.token);
    return 'ok';
  });
  try {
    await crowdAlerts.checkCrowdAlerts();
  } finally {
    mock.timers.reset();
  }

  assert.deepStrictEqual(delivered, ['t-live'], 'the alert really reached a device');
  assert.strictEqual(released, 0, 'a delivered alert keeps its claim even when cleanup failed');
});

// ---------------------------------------------------------------------------
// 4. Isolation
// ---------------------------------------------------------------------------
test('one member whose send rejects does not cost the rest of the flock their alert', async () => {
  mock.timers.enable({ apis: ['Date'], now: new Date('2026-08-15T00:00:00Z') });
  reset();
  let released = 0;
  scriptBusyFlock({ members: [{ user_id: 1, user_settings: null }, { user_id: 2, user_settings: null }] });
  on(/INSERT INTO crowd_alert_sends/i, () => ({ rowCount: 1 }));
  on(/DELETE FROM crowd_alert_sends WHERE flock_id/i, () => { released += 1; return { rowCount: 1 }; });

  const sent = [];
  const prevEnabled = firebaseService.isEnabled;
  const prevSend = firebaseService.sendPushToUser;
  firebaseService.isEnabled = () => true;
  firebaseService.sendPushToUser = async (userId) => {
    if (userId === 1) throw new Error('provider exploded for this recipient');
    sent.push(userId);
    return { sent: 1, failed: 0 };
  };
  try {
    await crowdAlerts.checkCrowdAlerts();
  } finally {
    firebaseService.isEnabled = prevEnabled;
    firebaseService.sendPushToUser = prevSend;
    mock.timers.reset();
  }

  assert.deepStrictEqual(sent, [2], 'the healthy recipient was still told');
  assert.strictEqual(released, 0, 'one delivery is enough to keep the claim');
});

// ---------------------------------------------------------------------------
// 5. Copy honesty
// ---------------------------------------------------------------------------
test('crowd alert copy contains no number the engine did not compute, and no em dash', () => {
  const { buildAlertMessage } = crowdAlerts.__testables;
  const score = (n, label) => ({ score: n, label });

  const noPeak = [
    buildAlertMessage({ venueName: 'The Pearl', currentScore: score(30, 'Not Busy'), eventScore: score(90, 'Very Busy'), peak: null }),
    buildAlertMessage({ venueName: 'The Pearl', currentScore: score(30, 'Not Busy'), eventScore: score(60, 'Moderate'), peak: null }),
    buildAlertMessage({ venueName: 'The Pearl', currentScore: score(70, 'Busy'), eventScore: score(74, 'Busy'), peak: null }),
  ];
  for (const c of noPeak) {
    assert.ok(!/\d/.test(c.title + c.body), `invented a number: ${c.title} / ${c.body}`);
    assert.ok(!/[—–]/.test(c.title + c.body), `em/en dash: ${c.title} / ${c.body}`);
  }

  const peak = { hour: '11 PM', score: 80 };
  const peaked = buildAlertMessage({ venueName: 'The Pearl', currentScore: score(70, 'Busy'), eventScore: score(72, 'Busy'), peak });
  assert.ok(peaked.body.includes(peak.hour), 'the computed peak hour is the claim');
  assert.ok(!/\d/.test((peaked.title + peaked.body).split(peak.hour).join('')), `a number beyond the computed hour: ${peaked.body}`);
  assert.ok(!/[—–]/.test(peaked.title + peaked.body));
});

// ---------------------------------------------------------------------------
// 6. Init failure degrades to no-op — LAST, because the failure is sticky by
//    design and every earlier test drives the provider through the test seam.
// ---------------------------------------------------------------------------
test('a service account Firebase rejects degrades every push caller to a no-op', async () => {
  reset(); // senderOverride cleared: the real init path runs
  process.env.FIREBASE_SERVICE_ACCOUNT = JSON.stringify({ project_id: 'demo' });
  adminStub.initError = new Error('Failed to parse private key: Error: Invalid PEM formatted message.');
  try {
    // The init throws inside firebase-admin; nothing may escape.
    assert.strictEqual(firebaseService.isEnabled(), false);
    assert.strictEqual(adminStub.initCalls, 1, 'initializeApp was actually attempted');

    // Request path: a plain no-op answer, no throw, no database work.
    const direct = await firebaseService.sendPushToUser(9, 'T', 'B', {});
    assert.deepStrictEqual(direct, { sent: 0, failed: 0 });
    const helper = await pushHelper.pushAlways(9, 'T', 'B', { type: 'crowd_alert' });
    assert.deepStrictEqual(helper, { skipped: true, reason: 'disabled' });

    // Background path: the sweep does no work at all — in particular it never
    // burns a crowd_alert_sends claim for a push it cannot deliver.
    await crowdAlerts.checkCrowdAlerts();
    assert.strictEqual(log.length, 0, `queried: ${log.map((q) => q.sql).join(' | ')}`);

    // Sticky: a malformed credential is not re-parsed and re-thrown per push.
    assert.strictEqual(firebaseService.isEnabled(), false);
    assert.strictEqual(adminStub.initCalls, 1, 'the failed init is not retried on every call');
  } finally {
    delete process.env.FIREBASE_SERVICE_ACCOUNT;
    adminStub.initError = null;
  }
});
