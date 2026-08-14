// Run: node --test  (from backend/)
//
// App Review 4.5.4 — push notification compliance.
//
// The guideline's operative sentence: "Push Notifications should not be used
// for promotions or direct marketing purposes unless customers have explicitly
// opted in to receive them via consent language displayed in your app's UI,
// and you provide a method in your app for a user to opt out." Plus: push must
// not be REQUIRED for the app to function.
//
// Every push this app sends is classified transactional (the inventory lives
// at the top of services/pushHelper.js). This file pins the properties that
// keep that classification true, so a rejection-shaped drift fails a test
// instead of an App Review:
//
//   1. THE SWITCH WORKS AT THE CHOKEPOINT. The crowd-alert opt-out used to be
//      enforced only inside the one producer's recipient filter; a second
//      producer reusing type 'crowd_alert' would have bypassed the user's
//      switch entirely. pushHelper.deliver now re-checks it for every
//      crowd_alert send, whoever built it.
//   2. UNREADABLE MEANS UNSET, NOT OFF. The preference check fails open on a
//      database error, per the switch's own doctrine; the fail-closed safety
//      gate (blocks/bans/membership) still runs after it either way.
//   3. NO MARKETING COPY. The crowd alert is transactional only while its copy
//      states a forecast about the recipient's own plan. The moment a sentence
//      names Pro, an upgrade, an offer, or a price, it is a promotion needing
//      explicit opt-in — so the copy builder is scanned for that lexicon.
//   4. THE PRO GATE DELIVERS THE PERK, NEVER ADVERTISES IT. With the paywall
//      live, only premium members are even considered; free users get nothing,
//      not an upsell.
//   5. ONE PRODUCER. Only services/crowdAlerts.js may send type 'crowd_alert'.
//      Anyone adding a second producer (the VENUE-BILLING.md "slow-night push
//      offers" design is the known temptation) must confront this guard and
//      the 4.5.4 block in pushHelper first.
//   6. NOTHING REQUIRES PUSH. With delivery unconfigured, senders no-op
//      without touching the database and without throwing into their callers.
const test = require('node:test');
const { mock } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

process.env.JWT_SECRET = 'push-454-test-secret';
delete process.env.FIREBASE_SERVICE_ACCOUNT;
delete process.env.PAYWALL_ENABLED;

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

let pushEnabled = true;
let sends = [];
firebaseService.isEnabled = () => pushEnabled;
firebaseService.sendPushToUser = async (userId, title, body, data) => {
  sends.push({ userId, title, body, data });
  return { sent: 1, failed: 0 };
};

function reset() {
  handlers = [];
  log = [];
  sends = [];
  pushEnabled = true;
  pushHelper._resetDebounce();
}

function on(re, fn) { handlers.push([re, fn]); }

const io = { sockets: { adapter: { rooms: new Map() } } };
const offline = io;

// ---------------------------------------------------------------------------
// 1 + 2. The opt-out is enforced at delivery time, for any producer
// ---------------------------------------------------------------------------
test('the delivery chokepoint refuses a crowd alert the recipient switched off', async () => {
  reset();
  on(/FROM user_settings/i, () => ({ rows: [{ settings: { crowdAlerts: false } }] }));
  // Called DIRECTLY, not through the sweep: this models a future producer that
  // never heard of the recipient filter in services/crowdAlerts.js.
  const res = await pushHelper.pushAlways(1, 'The Pearl is filling up', 'Busy soon', {
    type: 'crowd_alert', flockId: 7,
  });
  assert.strictEqual(res.skipped, true);
  assert.strictEqual(res.reason, 'opted-out');
  assert.strictEqual(sends.length, 0, 'an opted-out user received a crowd alert anyway');
  assert.ok(!log.some((q) => /FROM users u/i.test(q.sql)), 'refused before any further lookup');
});

test('the string form the client round-trip produces switches it off at the chokepoint too', async () => {
  // frontend userSettings.js stringifies through localStorage, so a switched-off
  // account can carry the JSON string "false" rather than a boolean.
  reset();
  on(/FROM user_settings/i, () => ({ rows: [{ settings: { crowdAlerts: 'false' } }] }));
  const res = await pushHelper.pushAlways(1, 'T', 'B', { type: 'crowd_alert', flockId: 7 });
  assert.strictEqual(res.reason, 'opted-out');
  assert.strictEqual(sends.length, 0);
});

test('an account that never touched the setting still gets the alert delivered', async () => {
  reset();
  on(/FROM user_settings/i, () => ({ rows: [] })); // no settings row at all
  on(/FROM users u/i, () => ({ rows: [{ is_banned: false, can_see: true }] }));
  const res = await pushHelper.pushAlways(1, 'T', 'B', { type: 'crowd_alert', flockId: 7 });
  assert.strictEqual(res.sent, 1);
  assert.strictEqual(sends.length, 1);
});

test('a preference read that fails does not silently mute a user who never opted out', async () => {
  // Fail OPEN, unlike the safety gate: the switch's doctrine is "unreadable
  // means unset, unset means on". The fail-closed canNotify still runs next.
  reset();
  on(/FROM user_settings/i, () => Promise.reject(new Error('connection terminated')));
  on(/FROM users u/i, () => ({ rows: [{ is_banned: false, can_see: true }] }));
  const res = await pushHelper.pushAlways(1, 'T', 'B', { type: 'crowd_alert', flockId: 7 });
  assert.strictEqual(res.sent, 1, 'a database blip must not turn the default off');
});

test('the safety gate still fails closed even when the preference read failed open', async () => {
  reset();
  on(/FROM user_settings/i, () => Promise.reject(new Error('connection terminated')));
  on(/FROM users u/i, () => Promise.reject(new Error('connection terminated')));
  const res = await pushHelper.pushAlways(1, 'T', 'B', { type: 'crowd_alert', flockId: 7 });
  assert.strictEqual(res.reason, 'not-visible', 'block/ban enforcement keeps its own rules');
  assert.strictEqual(sends.length, 0);
});

test('transactional types do not pay the preference read', async () => {
  // The switch governs crowd alerts. A DM about a message someone just sent
  // needs no opt-out check and must not grow one silently.
  reset();
  on(/FROM user_blocks/i, () => ({ rows: [] }));
  on(/FROM users u/i, () => ({ rows: [{ is_banned: false, can_see: true }] }));
  const res = await pushHelper.pushIfOffline(offline, 1, 'Ava', 'hey', {
    type: 'dm_message', senderId: 2,
  });
  assert.strictEqual(res.sent, 1);
  assert.ok(!log.some((q) => /user_settings/i.test(q.sql)), 'dm_message consulted the crowd switch');
});

// ---------------------------------------------------------------------------
// 6. Push is never required: no delivery config means no work and no throw
// ---------------------------------------------------------------------------
test('with push unconfigured the crowd-alert path does no database work at all', async () => {
  reset();
  pushEnabled = false;
  // No handlers registered: any query (including the new preference read)
  // would reject as unscripted.
  const res = await pushHelper.pushAlways(1, 'T', 'B', { type: 'crowd_alert', flockId: 7 });
  assert.strictEqual(res.reason, 'disabled');
  assert.strictEqual(log.length, 0, 'the opt-out check must sit BEHIND the disabled check');
  assert.strictEqual(sends.length, 0);
});

// ---------------------------------------------------------------------------
// 3. Copy audit: no branch of the crowd-alert copy is a promotion
// ---------------------------------------------------------------------------
const { buildAlertMessage } = crowdAlerts.__testables;

// The lexicon that turns a forecast into a promotion. Word-bounded so
// "progress" does not trip "pro"; currency and percent are flat bans because
// no honest crowd forecast contains a price.
const MARKETING = /\b(pro|premium|upgrade|subscribe|subscription|offer|deal|discount|sale|trial|unlock|paywall|buy|redeem|promo|exclusive|limited time|free)\b|[%$]/i;

test('no branch of the crowd-alert copy promotes anything', () => {
  const score = (n, label) => ({ score: n, label });
  const branches = [
    // eventScore >= 85: "packed"
    buildAlertMessage({ venueName: 'The Pearl', currentScore: score(30, 'Not Busy'), eventScore: score(90, 'Very Busy'), peak: null }),
    // gettingBusier, labels differ
    buildAlertMessage({ venueName: 'The Pearl', currentScore: score(30, 'Not Busy'), eventScore: score(60, 'Moderate'), peak: null }),
    // gettingBusier, labels identical (the repaired sentence)
    buildAlertMessage({ venueName: 'The Pearl', currentScore: score(41, 'Moderate'), eventScore: score(57, 'Moderate'), peak: null }),
    // peakSoon
    buildAlertMessage({ venueName: 'The Pearl', currentScore: score(70, 'Busy'), eventScore: score(72, 'Busy'), peak: { hour: '11 PM', score: 80 } }),
    // default
    buildAlertMessage({ venueName: 'The Pearl', currentScore: score(70, 'Busy'), eventScore: score(72, 'Busy'), peak: null }),
    // and the nameless-venue fallback string
    buildAlertMessage({ venueName: null, currentScore: score(30, 'Not Busy'), eventScore: score(90, 'Very Busy'), peak: null }),
  ];
  for (const b of branches) {
    assert.ok(b && b.title && b.body, 'every branch produces copy');
    const text = `${b.title} ${b.body}`;
    const hit = text.match(MARKETING);
    assert.strictEqual(hit, null, `marketing lexicon in crowd-alert copy: "${hit && hit[0]}" in "${text}"`);
  }
});

// ---------------------------------------------------------------------------
// 4. The Pro gate delivers the perk to subscribers; free users get silence
// ---------------------------------------------------------------------------
function scriptBusyFlock(memberRows) {
  on(/DELETE FROM crowd_alert_sends WHERE sent_at/i, () => ({ rowCount: 0 }));
  on(/FROM flocks f\s+WHERE f\.status/i, () => ({
    rows: [{
      id: 7, name: 'Fri', venue_id: 'p1', venue_name: 'The Pearl',
      venue_latitude: 40, venue_longitude: -74,
      event_time: new Date(Date.now() + 90 * 60 * 1000),
    }],
  }));
  on(/SELECT 1 FROM crowd_alert_sends/i, () => ({ rows: [], rowCount: 0 }));
  on(/FROM ml_venues/i, () => ({
    rows: [{ google_types: ['bar', 'night_club'], review_count: 4000, rating: 4.5, price_level: 2, timezone: 'America/New_York' }],
  }));
  // Registered BEFORE the canNotify handler: the paywalled variant of this
  // query contains "JOIN users u", which a looser users-u regex would swallow.
  on(/FROM flock_members fm/i, () => ({ rows: memberRows }));
  on(/INSERT INTO crowd_alert_sends/i, () => ({ rowCount: 1 }));
  on(/DELETE FROM crowd_alert_sends WHERE flock_id/i, () => ({ rowCount: 1 }));
  on(/FROM user_settings/i, () => ({ rows: [] }));
  on(/FROM users u\s+WHERE/i, () => ({ rows: [{ is_banned: false, actor_banned: false, can_see: true }] }));
}

async function runSweep(memberRows) {
  mock.timers.enable({ apis: ['Date'], now: new Date('2026-08-15T00:00:00Z') }); // Fri 8pm ET
  reset();
  scriptBusyFlock(memberRows);
  try {
    await crowdAlerts.checkCrowdAlerts();
  } finally {
    mock.timers.reset();
  }
  const memberQuery = log.find((q) => /FROM flock_members fm/i.test(q.sql));
  return { memberQuery };
}

test('with the paywall live, only premium members are even considered', async () => {
  process.env.PAYWALL_ENABLED = 'true';
  try {
    const { memberQuery } = await runSweep([{ user_id: 1, user_settings: null }]);
    assert.ok(memberQuery, 'the sweep read flock_members');
    assert.match(memberQuery.sql, /is_premium\s*=\s*true/i,
      'a Pro perk sent to non-subscribers is either a billing bug or an upsell push; both are wrong');
    // The perk is DELIVERED to the subscriber, with the transactional copy.
    assert.strictEqual(sends.length, 1);
    assert.strictEqual(sends[0].data.type, 'crowd_alert');
    assert.strictEqual(MARKETING.test(`${sends[0].title} ${sends[0].body}`), false);
  } finally {
    delete process.env.PAYWALL_ENABLED;
  }
});

test('with the paywall dormant, everyone gets the alert and nobody is upsold', async () => {
  delete process.env.PAYWALL_ENABLED;
  const { memberQuery } = await runSweep([{ user_id: 9, user_settings: null }]);
  assert.ok(memberQuery);
  assert.doesNotMatch(memberQuery.sql, /is_premium/i, 'the dormant paywall must not gate anyone out');
  assert.strictEqual(sends.length, 1);
  assert.strictEqual(sends[0].userId, 9);
});

test('the sweep only ever addresses members who accepted the flock', async () => {
  const { memberQuery } = await runSweep([{ user_id: 1, user_settings: null }]);
  assert.match(memberQuery.sql, /status\s*=\s*'accepted'/i,
    'an alert to someone who declined or was merely invited is unsolicited in the 4.5.4 sense');
});

// ---------------------------------------------------------------------------
// 5. One producer: only services/crowdAlerts.js sends type 'crowd_alert'
// ---------------------------------------------------------------------------
// Strip the parts of a source line no send is built from: a // comment and a
// SQL -- comment inside a template literal.
function codeOnly(line) {
  let s = line;
  const slash = s.indexOf('//');
  if (slash !== -1) s = s.slice(0, slash);
  const dash = s.indexOf('--');
  if (dash !== -1) s = s.slice(0, dash);
  return s;
}

test('no second producer of crowd_alert pushes exists', () => {
  // pushHelper.js (the chokepoint) and firebaseService.js (the type registry
  // and deep-link table) reference the type without producing it. Everything
  // else that names it in code is building a send.
  const allowed = new Set([
    'services/crowdAlerts.js',
    'services/pushHelper.js',
    'services/firebaseService.js',
  ]);
  const roots = ['routes', 'services', 'sockets'];
  const offenders = [];
  for (const root of roots) {
    const dir = path.join(__dirname, '..', root);
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.js')) continue;
      const rel = `${root}/${file}`;
      if (allowed.has(rel)) continue;
      const code = fs.readFileSync(path.join(dir, file), 'utf8')
        .split('\n').map(codeOnly).join('\n');
      if (/crowd_alert(?!_sends)/.test(code)) offenders.push(rel);
    }
  }
  assert.deepStrictEqual(offenders, [],
    'A new crowd_alert producer must route through the recipient opt-out filter and the 4.5.4 '
    + 'classification in services/pushHelper.js. If it promotes a venue or Flock Pro, it is not a '
    + 'crowd_alert at all: it is marketing, and it needs explicit opt-in consent UI first.');
});
