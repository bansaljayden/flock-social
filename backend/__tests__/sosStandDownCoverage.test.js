// Run: node --test  (from backend/)
//
// ---------------------------------------------------------------------------
// A STAND-DOWN IS FINAL, AND IT REACHES EVERYONE THE ALARM DID
// ---------------------------------------------------------------------------
// Two defects found on 2026-09-25, both in the gap between "the person said
// they are OK" and what the server did next.
//
// 1. THE CHASE OUTLIVED THE STAND-DOWN. An SOS pressed indoors goes out with
//    no position, and the app posts the fix as a second alert when it lands.
//    The server let that second alert through its sixty second floor because
//    "the last alert had no location and this one does", and nothing on the
//    alert row said it had been withdrawn. So a fix that landed after "Tell
//    them I'm OK" went out as a new emergency email and a new flock alarm
//    with a map. The stand-down now marks every alert in its window
//    withdrawn (migration 084) under the alert's own lock, and /alert refuses
//    a follow-up to a withdrawn alert: tagged ones outright, an older build's
//    untagged ones by the floor.
//
// 2. THE STAND-DOWN READ ONLY THE NEWEST ALERT. Each SOS, follow-up and
//    escalation is its own row with its own recipients, and anybody an
//    earlier one reached but the newest did not kept their alarm. The
//    stand-down now covers every alert still standing in its window. And a
//    follow-up read the LIVE contact list, so an address added or edited in
//    the seconds after the SOS was mailed the map under the emergency
//    category; it now goes only to the addresses the first alert went to.
//
// The same guarantees run end to end on a real Postgres in
// sosStandDownEndsTheChase.test.js. This file drives the route's branches
// with scripted statements, which is how the edge cases get exact timing.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'sos-stand-down-coverage-secret';

const pool = require('../config/database');
const pushHelper = require('../services/pushHelper');
const emailService = require('../services/emailService');

// routes/safety.js takes pushAlways when it loads, so this goes first.
const pushes = [];
pushHelper.pushAlways = async (userId, title, body, data) => {
  pushes.push({ userId, title, body, data });
  return { sent: 1 };
};

const safetyRoutes = require('../routes/safety');
const S = safetyRoutes.__test;

const ME = { id: 7, email: 'me@example.com', name: 'Ava', role: 'user', is_banned: false, token_version: 0 };

const emitted = [];
const io = { to: (room) => ({ emit: (event, payload) => emitted.push({ room, event, payload }) }) };

async function call(method, urlPath, body) {
  const app = express();
  app.use(express.json());
  app.set('io', io);
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

function stubMail(result = { sent: true, id: 't' }) {
  const real = emailService.sendEmail;
  const mails = [];
  emailService.sendEmail = async (msg) => {
    mails.push(msg);
    return typeof result === 'function' ? result(msg) : result;
  };
  return { mails, restore: () => { emailService.sendEmail = real; } };
}

const claimed = (calls) => calls.some((c) => c.text.includes('INSERT INTO emergency_alerts'));
const settle = () => new Promise((r) => setTimeout(r, 20));
function resetLegs() { pushes.length = 0; emitted.length = 0; }

const MUM = { id: 1, contact_name: 'Mum', contact_email: 'mum@example.com' };
const WITH_LOCATION = { latitude: 40.7128, longitude: -74.006, includeLocation: true, accuracy: 30 };

// The most recent alert, as the claim transaction's SELECT returns it.
const lastAlert = (over = {}) => ({
  id: 101,
  created_at: new Date(Date.now() - 8000),
  withdrawn_at: null,
  flock_recipient_ids: [21, 22],
  latitude: null,
  longitude: null,
  contacts_alerted: 1,
  age_ms: 8_000,
  delivered_in_window: 1,
  attempts_in_window: 1,
  ...over,
});

// Answers the statements /alert issues. `target` is what the follow-up's
// named alert looks like; `last` is the newest alert.
function alertFixtures({ last = lastAlert(), target = null, contacts = [MUM], members = [] } = {}) {
  return (sql) => {
    if (sql.includes('FROM emergency_alerts') && sql.includes('WHERE id = $1 AND user_id = $2')) {
      return { rows: target ? [target] : [] };
    }
    if (sql.includes('INSERT INTO emergency_alerts')) return { rows: [{ id: 202 }] };
    if (sql.includes('UPDATE emergency_alerts') && sql.includes('RETURNING id')) return { rows: [{ id: 202 }], rowCount: 1 };
    if (sql.includes('FROM emergency_alerts') && !sql.includes('UPDATE')) return { rows: last ? [last] : [] };
    if (sql.includes('FROM trusted_contacts')) return { rows: contacts };
    if (sql.includes('SELECT name FROM users')) return { rows: [{ name: 'Ava' }] };
    if (/FROM flock_members fm/.test(sql) || /FROM users u\s+WHERE u\.id = ANY/.test(sql)) return { rows: members };
    return null;
  };
}

// ===========================================================================
// 1. Nothing goes out after "I am OK"
// ===========================================================================

test('a follow-up that names a withdrawn alert is refused: nothing claimed, mailed or rung', async () => {
  resetLegs();
  const mail = stubMail();
  const { calls, restore } = stubPool(alertFixtures({
    target: { id: 101, created_at: new Date(), withdrawn_at: new Date(), flock_recipient_ids: [21] },
    members: [{ user_id: 21 }],
  }));
  try {
    const res = await call('POST', '/api/alert', { ...WITH_LOCATION, followUpTo: 101 });
    await settle();
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body.withdrawn, true);
    assert.match(res.body.error, /said you are OK/);
    assert.match(res.body.error, /911/, 'every refusal on this route names 911');
    assert.ok(!claimed(calls), 'no alert row is written');
    assert.strictEqual(mail.mails.length, 0, 'no contact is mailed');
    assert.strictEqual(pushes.length, 0, 'no flockmate is pushed');
    assert.strictEqual(emitted.length, 0, 'no flockmate is signalled');
    // The check runs under the alert's lock, so a stand-down cannot slip in
    // between it and the claim.
    const lock = calls.findIndex((c) => c.text.includes('pg_advisory_xact_lock'));
    const look = calls.findIndex((c) => c.text.includes('WHERE id = $1 AND user_id = $2'));
    assert.ok(lock > -1 && look > lock);
    assert.deepStrictEqual(calls[look].params, [101, ME.id], 'only the sender\'s own alert can be named');
  } finally { mail.restore(); restore(); }
});

test('an older build\'s untagged follow-up after a stand-down is refused inside the floor', async () => {
  // It does not name the alert, so the withdrawn row itself has to refuse it.
  // Its fix lands well inside sixty seconds, which is where the floor holds.
  resetLegs();
  const mail = stubMail();
  const { calls, restore } = stubPool(alertFixtures({
    last: lastAlert({ withdrawn_at: new Date(), age_ms: 12_000 }),
    members: [{ user_id: 21 }],
  }));
  try {
    const res = await call('POST', '/api/alert', WITH_LOCATION);
    await settle();
    assert.strictEqual(res.status, 429, JSON.stringify(res.body));
    assert.strictEqual(res.body.withdrawn, true);
    assert.ok(!('alreadySent' in res.body), 'the contacts no longer hold that alert, so the band must not re-arm');
    assert.match(res.body.error, /You said you are OK/);
    assert.match(res.body.error, /48 seconds/, 'says when a new alert can go');
    assert.match(res.body.error, /911/);
    assert.ok(!claimed(calls));
    assert.strictEqual(mail.mails.length, 0);
    assert.strictEqual(pushes.length + emitted.length, 0);
  } finally { mail.restore(); restore(); }
});

test('a withdrawn alert is never the thing a location follows up', () => {
  const coords = { lat: 40.7, lng: -74 };
  assert.strictEqual(S.isLocationFollowUp(coords, { latitude: null, longitude: null }, 8_000), true);
  assert.strictEqual(S.isLocationFollowUp(coords, { latitude: null, longitude: null, withdrawn_at: new Date() }, 8_000), false);
  assert.strictEqual(S.isLocationFollowUp(coords, { latitude: null, longitude: null, withdrawn_at: '2026-09-25 01:00:00' }, 8_000), false);
});

test('past the floor, a new press after a stand-down is a NEW alert, not an update to the withdrawn one', async () => {
  // Everybody it reaches was told the person is OK, so it is not a duplicate
  // of anything. The old cooldown would have refused it for five minutes
  // ("your alert already went out"), and the update framing would have told
  // a contact holding an all-clear that this was "an update".
  resetLegs();
  const mail = stubMail();
  const { calls, restore } = stubPool(alertFixtures({
    last: lastAlert({ withdrawn_at: new Date(), age_ms: 90_000, latitude: 40.7, longitude: -74 }),
  }));
  try {
    const res = await call('POST', '/api/alert', { latitude: 40.7, longitude: -74, includeLocation: true });
    await settle();
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.ok(claimed(calls));
    assert.strictEqual(mail.mails.length, 1);
    assert.doesNotMatch(mail.mails[0].subject, /Update/);
    assert.doesNotMatch(mail.mails[0].html, /This is an update/);
    // A new alert reads the live list, not the withdrawn alert's.
    const who = calls.find((c) => c.text.includes('FROM trusted_contacts'));
    assert.doesNotMatch(who.text, /email_set_at/);
  } finally { mail.restore(); restore(); }
});

test('the attempt ceiling still bites on a new alert after a stand-down', async () => {
  const mail = stubMail();
  const { calls, restore } = stubPool(alertFixtures({
    last: lastAlert({ withdrawn_at: new Date(), age_ms: 90_000, attempts_in_window: S.MAX_ATTEMPTS_PER_WINDOW }),
  }));
  try {
    const res = await call('POST', '/api/alert', WITH_LOCATION);
    assert.strictEqual(res.status, 429);
    assert.ok(!claimed(calls));
  } finally { mail.restore(); restore(); }
});

test('a follow-up to a standing alert still goes out at once, and answers with its own id', async () => {
  resetLegs();
  const mail = stubMail();
  const { calls, restore } = stubPool(alertFixtures({
    target: { id: 101, created_at: new Date(Date.now() - 8000), withdrawn_at: null, flock_recipient_ids: [21] },
    members: [{ user_id: 21 }],
  }));
  try {
    const res = await call('POST', '/api/alert', { ...WITH_LOCATION, followUpTo: 101 });
    await settle();
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.alertId, 202, 'the app names this id if it has to follow it up');
    assert.ok(claimed(calls));
    assert.match(mail.mails[0].subject, /^🚨 Update: /);
    assert.match(mail.mails[0].html, /Their location is now available; the first alert had none\./);
  } finally { mail.restore(); restore(); }
});

test('a tag that is not a plausible id is ignored, so it can never cost a delivery', async () => {
  for (const bogus of ['abc', -3, 0, 1.5, '12; DROP', { id: 1 }, 99999999999]) {
    const mail = stubMail();
    const { calls, restore } = stubPool(alertFixtures({ last: null }));
    try {
      const res = await call('POST', '/api/alert', { ...WITH_LOCATION, followUpTo: bogus });
      assert.strictEqual(res.status, 200, `${JSON.stringify(bogus)}: ${JSON.stringify(res.body)}`);
      assert.ok(!calls.some((c) => c.text.includes('WHERE id = $1 AND user_id = $2')), `looked up ${JSON.stringify(bogus)}`);
    } finally { mail.restore(); restore(); }
  }
});

// ===========================================================================
// 2. A follow-up goes only to the people the alert it follows was sent to
// ===========================================================================

test('a follow-up reads only the addresses that were on the list when the first alert went out', async () => {
  resetLegs();
  const mail = stubMail();
  const firstAt = new Date(Date.now() - 8000);
  const { calls, restore } = stubPool(alertFixtures({
    target: { id: 101, created_at: firstAt, withdrawn_at: null, flock_recipient_ids: [21, 22] },
    members: [{ user_id: 21 }, { user_id: 22 }],
  }));
  try {
    const res = await call('POST', '/api/alert', { ...WITH_LOCATION, followUpTo: 101 });
    await settle();
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    const who = calls.find((c) => c.text.includes('FROM trusted_contacts'));
    assert.match(who.text, /COALESCE\(email_set_at, created_at\) <= \$2/);
    assert.strictEqual(who.params[1], firstAt, 'the first alert\'s own time is the cut-off');
    // And the flock: the first alert's recorded audience, less bans and
    // blocks, not whoever is on the plan now.
    const flock = calls.find((c) => /FROM users u\s+WHERE u\.id = ANY/.test(c.text));
    assert.ok(flock, 'the recorded audience was asked');
    assert.deepStrictEqual(flock.params, [ME.id, [21, 22]]);
    assert.ok(!calls.some((c) => /FROM flock_members fm/.test(c.text)), 'the live plan was not consulted');
    assert.deepStrictEqual(pushes.map((p) => p.userId).sort(), [21, 22]);
  } finally { mail.restore(); restore(); }
});

test('an untagged follow-up is held to the same list, keyed on the alert it was granted against', async () => {
  const mail = stubMail();
  const last = lastAlert();
  const { calls, restore } = stubPool(alertFixtures({ last, members: [{ user_id: 21 }] }));
  try {
    const res = await call('POST', '/api/alert', WITH_LOCATION);
    await settle();
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    const who = calls.find((c) => c.text.includes('FROM trusted_contacts'));
    assert.match(who.text, /email_set_at/);
    assert.strictEqual(who.params[1], last.created_at);
  } finally { mail.restore(); restore(); }
});

test('with nobody left from the first alert, the follow-up says so rather than "no contacts"', async () => {
  const mail = stubMail();
  const { calls, restore } = stubPool(alertFixtures({
    target: { id: 101, created_at: new Date(), withdrawn_at: null, flock_recipient_ids: [] },
    contacts: [],
  }));
  try {
    const res = await call('POST', '/api/alert', { ...WITH_LOCATION, followUpTo: 101 });
    assert.strictEqual(res.status, 400);
    assert.match(res.body.error, /None of the contacts your first alert went to/);
    assert.match(res.body.error, /911/);
    assert.ok(!claimed(calls));
    assert.strictEqual(mail.mails.length, 0);
  } finally { mail.restore(); restore(); }
});

// ===========================================================================
// 2. The stand-down reaches everyone any still-standing alert reached
// ===========================================================================

const row = (over) => ({
  id: 1,
  created_at: new Date('2026-09-25T02:00:00Z'),
  withdrawn_at: null,
  contacts_alerted: 1,
  flock_recipient_ids: [],
  contact_recipients: [],
  ...over,
});

test('coverage: the union of every standing alert, each contact and flockmate once', () => {
  const found = [
    // newest first, as the route selects them
    row({ id: 3, created_at: new Date('2026-09-25T02:05:00Z'), contacts_alerted: 1, flock_recipient_ids: [22],
      contact_recipients: [{ name: 'Dad', email: 'dad@example.com' }] }),
    row({ id: 2, created_at: new Date('2026-09-25T02:00:30Z'), contacts_alerted: 2, flock_recipient_ids: [21, 22],
      contact_recipients: [{ name: 'Mum', email: 'MUM@example.com' }, { name: 'Dad', email: 'dad@example.com' }] }),
    row({ id: 1, created_at: new Date('2026-09-25T02:00:00Z'), contacts_alerted: 1, flock_recipient_ids: [21, 23],
      contact_recipients: [{ name: 'Mum', email: 'mum@example.com' }] }),
  ];
  const cover = S.standDownCoverage(found, []);
  assert.strictEqual(cover.alerts, 3);
  assert.deepStrictEqual(cover.flockIds.sort(), [21, 22, 23], 'the one who left before the newest alert is still told');
  assert.deepStrictEqual(cover.contacts.map((c) => c.contact_email), ['dad@example.com', 'MUM@example.com'],
    'one all-clear per address, however many alerts reached it');
  assert.strictEqual(cover.legacyCutoff, null);
  assert.strictEqual(cover.oldestAt, found[2].created_at, 'the oldest covered alert widens a legacy window');
});

test('coverage: an alert that reached nobody is not covered, and an in-flight one is picked up from the mark', () => {
  const found = [
    // Still sending when the stand-down took the lock: nothing recorded yet.
    row({ id: 5, contacts_alerted: 0, flock_recipient_ids: [], contact_recipients: [] }),
    row({ id: 4, contacts_alerted: 0, flock_recipient_ids: [], contact_recipients: [] }),
    row({ id: 3, contact_recipients: [{ name: 'Mum', email: 'mum@example.com' }] }),
  ];
  // The mark returned row 5 with the audience its flock leg wrote while this
  // request waited on the lock.
  const marked = [
    row({ id: 5, contacts_alerted: 0, flock_recipient_ids: [30], contact_recipients: [] }),
    row({ id: 4, contacts_alerted: 0, flock_recipient_ids: [], contact_recipients: [] }),
    row({ id: 3, contact_recipients: [{ name: 'Mum', email: 'mum@example.com' }] }),
  ];
  const cover = S.standDownCoverage(found, marked);
  assert.strictEqual(cover.alerts, 2);
  assert.deepStrictEqual(cover.flockIds, [30]);
  assert.deepStrictEqual(cover.contacts.map((c) => c.contact_name), ['Mum']);
});

test('coverage: a repeat covers what the last stand-down covered, not an alert withdrawn before a newer one', () => {
  const first = new Date('2026-09-25T02:01:00Z');
  const second = new Date('2026-09-25T02:10:00Z');
  const found = [
    // Newer alert, stood down at `second` (a stand-down whose mail failed).
    row({ id: 9, created_at: new Date('2026-09-25T02:05:00Z'), withdrawn_at: second, flock_recipient_ids: [22],
      contact_recipients: [{ name: 'Dad', email: 'dad@example.com' }] }),
    // Older alert, already stood down at `first`, BEFORE the newer one went
    // out: its people were told it was over before the newer alarm.
    row({ id: 8, created_at: new Date('2026-09-25T02:00:00Z'), withdrawn_at: first, flock_recipient_ids: [21],
      contact_recipients: [{ name: 'Mum', email: 'mum@example.com' }] }),
  ];
  const cover = S.standDownCoverage(found, []);
  assert.strictEqual(cover.alerts, 1);
  assert.deepStrictEqual(cover.flockIds, [22]);
  assert.deepStrictEqual(cover.contacts.map((c) => c.contact_name), ['Dad']);
});

test('coverage: an empty recorded list is nobody, and only a pre-snapshot NULL reads the contact list', () => {
  const legacyAt = new Date('2026-09-25T02:00:00Z');
  const recordedEmpty = S.standDownCoverage([row({ id: 1, contacts_alerted: 0, flock_recipient_ids: [4], contact_recipients: [] })]);
  assert.deepStrictEqual(recordedEmpty.contacts, []);
  assert.strictEqual(recordedEmpty.legacyCutoff, null);

  const legacy = S.standDownCoverage([
    row({ id: 2, created_at: new Date('2026-09-25T02:03:00Z'), flock_recipient_ids: [5], contact_recipients: [{ name: 'Dad', email: 'dad@example.com' }] }),
    row({ id: 1, created_at: legacyAt, contacts_alerted: 1, flock_recipient_ids: null, contact_recipients: null }),
  ]);
  assert.strictEqual(legacy.legacyCutoff, legacyAt);
  assert.strictEqual(legacy.flockIds, null, 'a pre-snapshot row falls back to the live audience');
});

test('the stand-down mails the union and pushes the union, under the alert\'s lock', async () => {
  S.resetCancels();
  resetLegs();
  const mail = stubMail();
  const windowRows = [
    { id: 12, created_at: new Date(Date.now() - 60_000), withdrawn_at: null, contacts_alerted: 1,
      flock_recipient_ids: [22], contact_recipients: [{ name: 'Dad', email: 'dad@example.com' }] },
    { id: 11, created_at: new Date(Date.now() - 120_000), withdrawn_at: null, contacts_alerted: 1,
      flock_recipient_ids: [21, 22], contact_recipients: [{ name: 'Mum', email: 'mum@example.com' }] },
  ];
  const { calls, restore } = stubPool(async (sql) => {
    if (sql.includes('UPDATE emergency_alerts')) return { rows: windowRows.map((r) => ({ ...r, withdrawn_at: new Date() })) };
    if (sql.includes('FROM emergency_alerts')) return { rows: windowRows };
    if (/FROM users u\s+WHERE u\.id = ANY/.test(sql)) return { rows: [{ user_id: 21 }, { user_id: 22 }] };
    if (sql.includes('SELECT name FROM users')) return { rows: [{ name: 'Ava' }] };
    return null;
  });
  try {
    const res = await call('POST', '/api/alert/cancel', { timezone: 'America/New_York' });
    await settle();
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(mail.mails.map((m) => m.to).sort(), ['dad@example.com', 'mum@example.com'],
      'Mum got only the first alert and is told it is over too');
    assert.ok(mail.mails.every((m) => m.category === 'emergency'));
    const flock = calls.find((c) => /FROM users u\s+WHERE u\.id = ANY/.test(c.text));
    assert.deepStrictEqual(flock.params[1].sort(), [21, 22]);
    assert.deepStrictEqual(pushes.map((p) => p.userId).sort(), [21, 22]);
    assert.ok(pushes.every((p) => p.data.type === 'safety_alert_cancelled'));
    // Locked, read, marked, in that order, before anything is sent.
    const lock = calls.findIndex((c) => c.text.includes('pg_advisory_xact_lock'));
    const read = calls.findIndex((c) => c.text.includes('FROM emergency_alerts') && !c.text.includes('UPDATE'));
    const mark = calls.findIndex((c) => c.text.includes('SET withdrawn_at = NOW()'));
    assert.ok(lock > -1 && read > lock && mark > read);
    assert.deepStrictEqual(calls[mark].params, [ME.id, [12, 11]]);
  } finally { mail.restore(); restore(); S.resetCancels(); }
});

test('the mark is the person\'s word: it is written even when every all-clear fails', async () => {
  S.resetCancels();
  const mail = stubMail({ sent: false, error: 'provider down' });
  const { calls, restore } = stubPool(async (sql) => {
    if (sql.includes('UPDATE emergency_alerts')) return { rows: [] };
    if (sql.includes('FROM emergency_alerts')) {
      return { rows: [{ id: 3, created_at: new Date(), withdrawn_at: null, contacts_alerted: 1, flock_recipient_ids: [],
        contact_recipients: [{ name: 'Mum', email: 'mum@example.com' }] }] };
    }
    if (sql.includes('SELECT name FROM users')) return { rows: [{ name: 'Ava' }] };
    return null;
  });
  try {
    const res = await call('POST', '/api/alert/cancel', {});
    assert.strictEqual(res.status, 502);
    assert.ok(calls.some((c) => c.text.includes('SET withdrawn_at = NOW()')));
  } finally { mail.restore(); restore(); S.resetCancels(); }
});

test('a refused stand-down marks nothing', async () => {
  // Nothing to cancel, and over the meter: neither may leave a mark, because
  // neither told anybody anything.
  S.resetCancels();
  const mail = stubMail();
  const nothing = stubPool(async (sql) => (sql.includes('FROM emergency_alerts')
    ? { rows: [{ id: 3, created_at: new Date(), withdrawn_at: null, contacts_alerted: 0, flock_recipient_ids: [], contact_recipients: [] }] }
    : null));
  try {
    const res = await call('POST', '/api/alert/cancel', {});
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.nothingToCancel, true);
    assert.ok(!nothing.calls.some((c) => c.text.includes('UPDATE emergency_alerts')));
  } finally { nothing.restore(); }

  const over = stubPool(async (sql) => {
    if (sql.includes('UPDATE emergency_alerts')) return { rows: [] };
    if (sql.includes('FROM emergency_alerts')) {
      return { rows: [{ id: 3, created_at: new Date(), withdrawn_at: null, contacts_alerted: 1, flock_recipient_ids: [],
        contact_recipients: [{ name: 'Mum', email: 'mum@example.com' }] }] };
    }
    if (sql.includes('SELECT name FROM users')) return { rows: [{ name: 'Ava' }] };
    return null;
  });
  try {
    for (let i = 0; i < S.MAX_CANCELS_PER_WINDOW; i++) await call('POST', '/api/alert/cancel', {});
    const before = over.calls.filter((c) => c.text.includes('UPDATE emergency_alerts')).length;
    const refused = await call('POST', '/api/alert/cancel', {});
    assert.strictEqual(refused.status, 429);
    assert.strictEqual(over.calls.filter((c) => c.text.includes('UPDATE emergency_alerts')).length, before);
  } finally { over.restore(); mail.restore(); S.resetCancels(); }
});

// ===========================================================================
// The flock leg of an alert withdrawn while its emails were going out
// ===========================================================================

test('a flock leg whose alert was stood down during the email fan-out tells nobody', async () => {
  resetLegs();
  const { calls, restore } = stubPool(async (sql) => {
    if (/FROM flock_members fm/.test(sql)) return { rows: [{ user_id: 21 }] };
    // The audience write finds the row already withdrawn...
    if (sql.includes('UPDATE emergency_alerts SET flock_recipient_ids')) return { rows: [], rowCount: 0 };
    // ...and the follow-up read confirms that is why.
    if (sql.includes('SELECT withdrawn_at FROM emergency_alerts')) return { rows: [{ withdrawn_at: new Date() }] };
    return null;
  });
  try {
    const leg = await S.alertFlockMembers(io, { id: ME.id, name: 'Ava' }, { lat: 40.7, lng: -74 }, 1, 202);
    assert.strictEqual(leg.withdrawn, true);
    assert.strictEqual(leg.notified, 0);
    assert.strictEqual(pushes.length, 0, 'no "needs help" after "is OK"');
    assert.strictEqual(emitted.length, 0);
    const write = calls.find((c) => c.text.includes('UPDATE emergency_alerts SET flock_recipient_ids'));
    assert.match(write.text, /WHERE id = \$2 AND withdrawn_at IS NULL/);
  } finally { restore(); }
});

test('a flock leg whose alert is still standing rings as before', async () => {
  resetLegs();
  const { restore } = stubPool(async (sql) => {
    if (/FROM flock_members fm/.test(sql)) return { rows: [{ user_id: 21 }] };
    if (sql.includes('UPDATE emergency_alerts SET flock_recipient_ids')) return { rows: [{ id: 202 }], rowCount: 1 };
    return null;
  });
  try {
    const leg = await S.alertFlockMembers(io, { id: ME.id, name: 'Ava' }, { lat: 40.7, lng: -74 }, 1, 202);
    assert.strictEqual(leg.notified, 1);
    assert.deepStrictEqual(pushes.map((p) => p.userId), [21]);
  } finally { restore(); }
});

// ===========================================================================
// Share location reports a failed send, the way /alert does
// ===========================================================================

test('share location: a send that was attempted and failed is counted, not dropped', async () => {
  // Two provider failures and one success used to come back as "Location
  // shared with 1 contact", and the toast was that sentence.
  const mail = stubMail((msg) => (msg.to === 'dad@example.com'
    ? { sent: true, id: 'x' }
    : { sent: false, error: 'provider refused' }));
  const { restore } = stubPool(async (sql) => {
    if (sql.includes('FROM trusted_contacts')) {
      return { rows: [
        { id: 1, contact_name: 'Mum', contact_email: 'mum@example.com' },
        { id: 2, contact_name: 'Dad', contact_email: 'dad@example.com' },
        { id: 3, contact_name: 'Gran', contact_email: 'gran@example.com' },
        { id: 4, contact_name: 'Old', contact_email: 'old@unclaimed.invalid' },
      ] };
    }
    if (sql.includes('SELECT name FROM users')) return { rows: [{ name: 'Ava' }] };
    return null;
  });
  try {
    const res = await call('POST', '/api/share-location', { latitude: 40.7, longitude: -74 });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.message,
      'Location shared with 1 contact, 2 contacts could not be reached, 1 skipped (no usable email address)');
    assert.strictEqual(res.body.contactsShared, 1);
    assert.strictEqual(res.body.notReached, 3);
    assert.strictEqual(mail.mails.length, 3, 'the unusable address is not attempted');
  } finally { mail.restore(); restore(); }
});
