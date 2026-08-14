// Run: node --test  (from backend/)
//
// Round 18 — THE SOS LOCATION FOLLOW-UP.
//
// The client used to hold an emergency alert back for up to fifteen seconds
// while it waited on a GPS fix. It now sends immediately and chases the fix
// afterwards, posting it as a second alert. That second alert carries the only
// thing a trusted contact can actually act on, and it lands three to eight
// seconds behind the first — inside ALERT_FLOOR_MS, which refused it. The
// location for an alert that went out without one arrived over a minute late.
//
// The exemption below is deliberately narrow: it applies only when this request
// carries coordinates, only when the previous alert genuinely had none, only
// inside a short window, and only once. Everything else keeps the floor, and
// nothing here raises MAX_ATTEMPTS_PER_WINDOW or MAX_ESCALATIONS, so the total
// volume an account can produce in fifteen minutes is unchanged.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'sos-followup-test-secret';
// No mail provider: sendAlertEmail short-circuits, so "was the alert CLAIMED?"
// is what these assert on, which is exactly the question the floor decides.
delete process.env.RESEND_API_KEY;

const pool = require('../config/database');
const safetyRoutes = require('../routes/safety');
const S = safetyRoutes.__test;

const ME = { id: 7, email: 'me@example.com', name: 'Me', role: 'user', is_banned: false, token_version: 0 };

async function call(method, urlPath, body) {
  const app = express();
  app.use(express.json());
  app.use('/api', safetyRoutes);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const token = jwt.sign({ userId: ME.id, tv: 0 }, process.env.JWT_SECRET);
  try {
    const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  } finally {
    await new Promise((r) => server.close(r));
  }
}

function stubPool(handler) {
  const realQuery = pool.query;
  const realConnect = pool.connect;
  const calls = [];
  const run = async (text, params) => {
    const sql = String(text);
    calls.push({ text: sql, params });
    if (sql.includes('FROM users WHERE id = $1') && sql.includes('token_version')) return { rows: [ME] };
    return (await handler(sql, params)) || { rows: [], rowCount: 0 };
  };
  pool.query = run;
  pool.connect = async () => ({
    query: async (text, params) => {
      const sql = String(text);
      if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(sql) || sql.includes('pg_advisory_xact_lock')) {
        calls.push({ text: sql, params });
        return { rows: [], rowCount: 0 };
      }
      return run(text, params);
    },
    release: () => {},
  });
  return { calls, restore: () => { pool.query = realQuery; pool.connect = realConnect; } };
}

const claimed = (calls) => calls.some((c) => c.text.includes('INSERT INTO emergency_alerts'));

// One reachable contact and a name, so nothing except the floor can refuse.
function baseFixtures(sql, lastAlertRow) {
  if (sql.includes('FROM emergency_alerts') && !sql.includes('INSERT') && !sql.includes('UPDATE')) {
    return { rows: lastAlertRow ? [lastAlertRow] : [] };
  }
  if (sql.includes('FROM trusted_contacts')) {
    return { rows: [{ id: 1, contact_name: 'Mum', contact_email: 'mum@example.com' }] };
  }
  if (sql.includes('SELECT name FROM users')) return { rows: [{ name: 'Ava' }] };
  if (sql.includes('INSERT INTO emergency_alerts')) return { rows: [{ id: 101 }] };
  return { rows: [], rowCount: 0 };
}

const lastAlert = (over = {}) => ({
  created_at: new Date().toISOString(),
  latitude: null,
  longitude: null,
  contacts_alerted: 2,
  age_ms: 8_000,
  delivered_in_window: 1,
  attempts_in_window: 1,
  ...over,
});

const WITH_LOCATION = { latitude: 40.7128, longitude: -74.006, includeLocation: true };

// ===========================================================================
// The predicate itself
// ===========================================================================

test('the exemption needs all three of: a location, a previous alert without one, and promptness', () => {
  const noLocationAlert = { latitude: null, longitude: null };

  assert.strictEqual(
    S.isLocationFollowUp({ lat: 40.7, lng: -74 }, noLocationAlert, 8_000), true,
    'the case the exemption exists for'
  );

  // 1. It must actually add a location, so a bare re-tap can never buy one.
  assert.strictEqual(S.isLocationFollowUp(null, noLocationAlert, 8_000), false);

  // 2. The previous alert must genuinely have had none. An alert that already
  //    said where the user was is an ordinary update: floor plus the 250 m rule.
  assert.strictEqual(
    S.isLocationFollowUp({ lat: 40.7, lng: -74 }, { latitude: '40.7', longitude: '-74.0' }, 8_000), false,
    'NUMERIC comes back from node-postgres as a string, which is still not null'
  );
  assert.strictEqual(S.isLocationFollowUp({ lat: 40.7, lng: -74 }, { latitude: 40.7, longitude: null }, 8_000), false);

  // 3. It must be prompt.
  assert.strictEqual(S.isLocationFollowUp({ lat: 40.7, lng: -74 }, noLocationAlert, S.LOCATION_FOLLOWUP_WINDOW_MS), true);
  assert.strictEqual(S.isLocationFollowUp({ lat: 40.7, lng: -74 }, noLocationAlert, S.LOCATION_FOLLOWUP_WINDOW_MS + 1), false);

  assert.strictEqual(S.isLocationFollowUp({ lat: 40.7, lng: -74 }, null, 1_000), false, 'no previous alert, no exemption to grant');
});

test('a previous alert on the equator or the prime meridian counts as having had a location', () => {
  // This file has been bitten by falsy coordinates before: `!latitude` once
  // rejected 0, which is a real place. "Had no location" is null, not falsy.
  const coords = { lat: 40.7, lng: -74 };
  assert.strictEqual(S.isLocationFollowUp(coords, { latitude: 0, longitude: 0 }, 5_000), false);
  assert.strictEqual(S.isLocationFollowUp(coords, { latitude: '0', longitude: '0' }, 5_000), false);
  assert.strictEqual(S.isLocationFollowUp(coords, { latitude: null, longitude: null }, 5_000), true);
});

test('an alert sent from 0,0 is itself a location follow-up, not a blank one', async () => {
  // The mirror of the above on the request side: readCoords already range-checks
  // rather than truth-checks, so 0,0 must reach the claim row as 0,0.
  const { calls, restore } = stubPool((sql) => baseFixtures(sql, lastAlert()));
  try {
    const res = await call('POST', '/api/alert', { latitude: 0, longitude: 0, includeLocation: true });
    assert.notStrictEqual(res.status, 429);
    const claim = calls.find((c) => c.text.includes('INSERT INTO emergency_alerts'));
    assert.strictEqual(claim.params[1], 0);
    assert.strictEqual(claim.params[2], 0);
  } finally { restore(); }
});

test('the exemption can never outlive the floor it lifts', () => {
  // Past the floor there is nothing to exempt: isEscalation already treats
  // "they had no location and now they do" as a reason to let an alert through.
  // A window wider than the floor would therefore be dead code that reads as a
  // licence, so this is pinned rather than left to be re-derived.
  assert.ok(S.LOCATION_FOLLOWUP_WINDOW_MS <= S.ALERT_FLOOR_MS);
  assert.strictEqual(S.isEscalation({ lat: 40.7, lng: -74 }, { latitude: null, longitude: null }), true);
});

// ===========================================================================
// The route
// ===========================================================================

test('the location for an alert that went out without one is sent at once, not a minute later', async () => {
  const { calls, restore } = stubPool((sql) => baseFixtures(sql, lastAlert()));
  try {
    const res = await call('POST', '/api/alert', WITH_LOCATION);
    assert.notStrictEqual(res.status, 429, 'the floor must not hold the location back');
    assert.ok(claimed(calls), 'the follow-up is claimed and sent');

    const claim = calls.find((c) => c.text.includes('INSERT INTO emergency_alerts'));
    assert.strictEqual(claim.params[1], 40.7128, 'and it carries the coordinates it was sent for');
    assert.strictEqual(claim.params[2], -74.006);
  } finally { restore(); }
});

test('the follow-up is exempt while the first alert is still fanning out, which is when it actually arrives', async () => {
  // Three seconds after the SOS the emails are still going, so contacts_alerted
  // is still 0 and the row reads as in flight. Exempting only the delivered
  // branch would have left this fix inert for its own timing.
  const { calls, restore } = stubPool((sql) => baseFixtures(sql, lastAlert({ contacts_alerted: 0, age_ms: 3_000, delivered_in_window: 0 })));
  try {
    const res = await call('POST', '/api/alert', WITH_LOCATION);
    assert.notStrictEqual(res.status, 429);
    assert.ok(claimed(calls));
  } finally { restore(); }
});

test('an alert that already carried a location keeps the full floor', async () => {
  const { calls, restore } = stubPool((sql) => baseFixtures(sql, lastAlert({ latitude: 40.7128, longitude: -74.006 })));
  try {
    const res = await call('POST', '/api/alert', { latitude: 40.7129, longitude: -74.0061, includeLocation: true });
    assert.strictEqual(res.status, 429);
    assert.strictEqual(res.body.alreadySent, true);
    assert.ok(!claimed(calls), 'a refused alert must not claim a slot');
  } finally { restore(); }
});

test('a re-tap that adds nothing is still refused, whatever the first alert carried', async () => {
  for (const body of [{ includeLocation: false }, { latitude: 'garbage', longitude: {}, includeLocation: true }]) {
    const { calls, restore } = stubPool((sql) => baseFixtures(sql, lastAlert()));
    try {
      const res = await call('POST', '/api/alert', body);
      assert.strictEqual(res.status, 429, `no coordinates, no exemption: ${JSON.stringify(body)}`);
      assert.ok(!claimed(calls));
    } finally { restore(); }
  }
});

test('only once: the granted follow-up writes its coordinates before any email leaves, and that closes the door', async () => {
  // The claim row is INSERTed inside the advisory-locked transaction with
  // coords already on it, so the very next request — concurrent or not — reads
  // a most-recent alert that HAS a location and meets the ordinary floor.
  // There is no counter because the claim row IS the counter.
  const { calls, restore } = stubPool((sql) => baseFixtures(sql, lastAlert({
    latitude: 40.7128, longitude: -74.006, contacts_alerted: 0, age_ms: 1_000,
  })));
  try {
    const res = await call('POST', '/api/alert', { latitude: 40.7130, longitude: -74.0062, includeLocation: true });
    assert.strictEqual(res.status, 429);
    assert.ok(!claimed(calls), 'a second follow-up is not a thing');
  } finally { restore(); }
});

test('the exemption lifts the floor and nothing else: the abuse ceilings still bite', async () => {
  // Outer bound on attempts of any kind.
  const attempts = stubPool((sql) => baseFixtures(sql, lastAlert({ attempts_in_window: S.MAX_ATTEMPTS_PER_WINDOW })));
  try {
    const res = await call('POST', '/api/alert', WITH_LOCATION);
    assert.strictEqual(res.status, 429);
    assert.ok(!claimed(attempts.calls), 'the floor is exempt, the attempt ceiling is not');
  } finally { attempts.restore(); }

  // Cap on delivered alerts inside the escalation window.
  const escalations = stubPool((sql) => baseFixtures(sql, lastAlert({ delivered_in_window: S.MAX_ESCALATIONS })));
  try {
    const res = await call('POST', '/api/alert', WITH_LOCATION);
    assert.strictEqual(res.status, 429);
    assert.ok(!claimed(escalations.calls));
  } finally { escalations.restore(); }
});

test('a user with nobody to alert is told so, exemption or not', async () => {
  // The exemption must not become a way around the honest refusals that run
  // after it, and it must not burn a slot on a send that could never land.
  const { calls, restore } = stubPool((sql) => {
    if (sql.includes('FROM trusted_contacts')) return { rows: [{ id: 1, contact_name: 'Mum', contact_email: null }] };
    return baseFixtures(sql, lastAlert());
  });
  try {
    const res = await call('POST', '/api/alert', WITH_LOCATION);
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.unreachableContacts, true);
    assert.ok(!claimed(calls));
  } finally { restore(); }
});
