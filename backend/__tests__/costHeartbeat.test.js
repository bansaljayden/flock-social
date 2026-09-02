// Run: node --test  (from backend/)
//
// THE COST HEARTBEAT WATCHES THE EXPENSE PICTURE, NOT A JOB.
//
// Two things on the admin cost panel can go stale or go wrong silently. The
// reconciled Google line is hand-entered from an invoice, and it sat at a
// mid-month snapshot for twelve days before anybody noticed (2026-09-01). The
// photo budget is a hard monthly ceiling, and reaching it degrades quietly:
// new venues lose their picture until the 1st. The contract, pinned here:
//   1. A reconciled date inside the window means silence. Older than the
//      window, or unreadable, means a finding.
//   2. Photo spend under the warning fraction means silence. At or over it
//      means a finding, and a spent budget is worded as spent, not nearly.
//   3. Each finding mails at most ONCE per calendar day, across restarts,
//      via ops_alert_ledger, and a failed send releases the claim.
//   4. A database failure inside the sweep is caught: the heartbeat can
//      never take the app down.

const test = require('node:test');
const assert = require('node:assert');

process.env.MODERATION_ALERT_EMAIL = 'jayden@example.com';

const pool = require('../config/database');
const emailService = require('../services/emailService');
const costModel = require('../services/costModel');
const photoStore = require('../services/photoStore');

// The durable dedupe ledger, emulated with ON CONFLICT DO NOTHING semantics,
// keyed by alert_key so the two findings dedupe independently.
const ledger = new Set();
let queryError = null;
pool.query = async (text, params) => {
  if (queryError) throw queryError;
  const sql = String(text).replace(/\s+/g, ' ');
  const day = new Date().toISOString().slice(0, 10);
  if (sql.includes('DELETE FROM ops_alert_ledger')) {
    ledger.delete(`${params[0]}:${day}`);
    return { rows: [] };
  }
  if (sql.includes('INSERT INTO ops_alert_ledger')) {
    const key = `${params[0]}:${day}`;
    if (ledger.has(key)) return { rows: [] };
    ledger.add(key);
    return { rows: [{ sent_on: day }] };
  }
  return { rows: [] };
};

const sent = [];
let sendError = null;
emailService.sendEmail = async (msg) => {
  if (sendError) throw sendError;
  sent.push(msg);
  return { id: 'msg_' + sent.length };
};

// Load after the stubs so the module binds to them.
const hb = require('../services/costHeartbeat');

function reset() {
  ledger.clear();
  sent.length = 0;
  queryError = null;
  sendError = null;
}

// ---------------------------------------------------------------------------
// 1. The reconciled-date finding, pure.
// ---------------------------------------------------------------------------
test('a reconciled date inside the window is silent', () => {
  const now = new Date('2026-09-10T12:00:00Z');
  assert.equal(hb.reconciledFinding({ asOf: '2026-09-01' }, now), null);
  assert.equal(hb.reconciledFinding({ asOf: '2026-08-07' }, now), null, '34 days is still inside a 35 day window');
});

test('a reconciled date at or past the window is a finding', () => {
  const now = new Date('2026-09-10T12:00:00Z');
  const f = hb.reconciledFinding({ asOf: '2026-08-06' }, now);
  assert.ok(f, '35 days must produce a finding');
  assert.equal(f.key, 'cost_reconciled_stale');
  assert.ok(f.lines.join('\n').includes('35 days ago'), 'the email names the age');
  assert.ok(f.lines.join('\n').includes('2026-08-06'), 'the email names the date it is judging');
});

test('an unreadable reconciled date is stale, never current', () => {
  const now = new Date('2026-09-10T12:00:00Z');
  for (const bad of [{}, { asOf: null }, { asOf: 'yesterday' }, null]) {
    const f = hb.reconciledFinding(bad, now);
    assert.ok(f, `expected a finding for ${JSON.stringify(bad)}`);
    assert.ok(f.lines.join('\n').includes('no readable date'));
  }
});

test('the shipped RECONCILED block is judged by the same function the sweep uses', () => {
  // Whatever costModel carries today, the function must return either null or a
  // well-formed finding, never throw. This is the seam the sweep relies on.
  const f = hb.reconciledFinding(costModel.RECONCILED);
  assert.ok(f === null || (f.key === 'cost_reconciled_stale' && Array.isArray(f.lines)));
});

// ---------------------------------------------------------------------------
// 2. The photo-budget finding, pure.
// ---------------------------------------------------------------------------
const limits = { fetchesPerMonth: 4571, budgetUsdPerMonth: 25 };

test('photo spend under the warning line is silent', () => {
  assert.equal(hb.photoFinding({ monthUsed: 100, monthUsd: 0, limits }), null);
  assert.equal(hb.photoFinding({ monthUsed: 4000, monthUsd: 21, limits }), null, '87.5% is under a 90% line');
});

test('photo spend at the warning line is a finding worded as nearly spent', () => {
  const f = hb.photoFinding({ monthUsed: 4114, monthUsd: 21.8, limits });
  assert.ok(f, '90% must produce a finding');
  assert.equal(f.key, 'cost_photo_budget');
  assert.ok(/nearly spent/.test(f.subject));
  assert.ok(f.lines.join('\n').includes('4114 of 4571'));
});

test('a spent photo budget is worded as spent, not nearly', () => {
  const f = hb.photoFinding({ monthUsed: 4571, monthUsd: 25, limits });
  assert.ok(f);
  assert.ok(/is spent/.test(f.subject));
  assert.ok(f.lines.join('\n').includes('until the 1st'));
});

test('an unreadable photo status is silent rather than a false alarm', () => {
  for (const bad of [null, {}, { monthUsed: 5 }, { monthUsed: 5, limits: {} }, { monthUsed: 'x', limits }]) {
    assert.equal(hb.photoFinding(bad), null, `expected silence for ${JSON.stringify(bad)}`);
  }
});

// ---------------------------------------------------------------------------
// 3. Once per day per finding, across restarts, with release on failure.
// ---------------------------------------------------------------------------
test('a stale invoice mails exactly once per day even across a restart', async () => {
  reset();
  const saved = costModel.RECONCILED.asOf;
  costModel.RECONCILED.asOf = '2026-01-01';
  photoStore.photoSpendStatus = async () => ({ monthUsed: 0, monthUsd: 0, limits });
  try {
    await hb.runCostHeartbeat();
    await hb.runCostHeartbeat();
    // A "restart" forgets nothing here because the ledger is the database,
    // which is the whole point of putting it there.
    await hb.runCostHeartbeat();
    assert.equal(sent.length, 1, 'one email for one stale day, not one per sweep');
    assert.equal(sent[0].to, 'jayden@example.com');
    assert.ok(/fresh invoice/.test(sent[0].subject));
  } finally {
    costModel.RECONCILED.asOf = saved;
  }
});

test('the two findings dedupe independently and both can mail on the same day', async () => {
  reset();
  const saved = costModel.RECONCILED.asOf;
  costModel.RECONCILED.asOf = '2026-01-01';
  photoStore.photoSpendStatus = async () => ({ monthUsed: 4571, monthUsd: 25, limits });
  try {
    await hb.runCostHeartbeat();
    await hb.runCostHeartbeat();
    assert.equal(sent.length, 2, 'one email per finding, then silence');
    const subjects = sent.map((m) => m.subject).sort();
    assert.ok(subjects.some((s) => /fresh invoice/.test(s)));
    assert.ok(subjects.some((s) => /photo budget/.test(s)));
  } finally {
    costModel.RECONCILED.asOf = saved;
  }
});

test('a failed send releases the claim so the next sweep can try again', async () => {
  reset();
  const saved = costModel.RECONCILED.asOf;
  costModel.RECONCILED.asOf = '2026-01-01';
  photoStore.photoSpendStatus = async () => ({ monthUsed: 0, monthUsd: 0, limits });
  try {
    sendError = new Error('provider down');
    await hb.runCostHeartbeat();
    assert.equal(sent.length, 0);
    sendError = null;
    await hb.runCostHeartbeat();
    assert.equal(sent.length, 1, 'the claim was released, so the retry mailed');
  } finally {
    costModel.RECONCILED.asOf = saved;
  }
});

test('a healthy picture is silent', async () => {
  reset();
  const saved = costModel.RECONCILED.asOf;
  costModel.RECONCILED.asOf = new Date().toISOString().slice(0, 10);
  photoStore.photoSpendStatus = async () => ({ monthUsed: 10, monthUsd: 0, limits });
  try {
    await hb.runCostHeartbeat();
    assert.equal(sent.length, 0);
  } finally {
    costModel.RECONCILED.asOf = saved;
  }
});

// ---------------------------------------------------------------------------
// 4. It can never take the app down.
// ---------------------------------------------------------------------------
test('a database failure inside the sweep is caught', async () => {
  reset();
  const saved = costModel.RECONCILED.asOf;
  costModel.RECONCILED.asOf = '2026-01-01';
  photoStore.photoSpendStatus = async () => ({ monthUsed: 0, monthUsd: 0, limits });
  queryError = new Error('connection terminated');
  try {
    await assert.doesNotReject(() => hb.runCostHeartbeat());
    assert.equal(sent.length, 0);
  } finally {
    costModel.RECONCILED.asOf = saved;
    queryError = null;
  }
});

test('the kill switch shared with the collection heartbeat silences it', async () => {
  reset();
  const saved = costModel.RECONCILED.asOf;
  costModel.RECONCILED.asOf = '2026-01-01';
  process.env.HEARTBEAT_DISABLED = 'true';
  try {
    assert.equal(hb.costHeartbeatEnabled(), false);
    await hb.runCostHeartbeat();
    assert.equal(sent.length, 0);
  } finally {
    delete process.env.HEARTBEAT_DISABLED;
    costModel.RECONCILED.asOf = saved;
  }
});
