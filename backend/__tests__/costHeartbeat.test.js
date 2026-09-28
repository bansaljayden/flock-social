// Run: node --test  (from backend/)
//
// THE COST HEARTBEAT WATCHES THE EXPENSE PICTURE, NOT A JOB.
//
// Two things on the admin cost panel can go stale or go wrong silently. The
// reconciled lines (Google Cloud off an invoice, Railway off its own estimated
// bill) are hand-entered, and the Google one sat at a mid-month snapshot for
// twelve days before anybody noticed (2026-09-01). The photo budget is a hard
// monthly ceiling, and reaching it degrades quietly: new venues lose their
// picture until the 1st. The contract, pinned here:
//   1. Every reconciled line is judged on its own date. All inside the window
//      means silence. Any line older than the window, or unreadable, means one
//      finding naming each stale line, and a fresh line never hides a stale
//      one.
//   2. Photo spend under the warning fraction means silence. At or over it
//      means a finding, and a spent budget is worded as spent, not nearly.
//   3. Each finding mails at most ONCE per calendar day, across restarts,
//      via ops_alert_ledger, and a failed send releases the claim.
//   4. A database failure inside the sweep is caught: the heartbeat can
//      never take the app down.

const test = require('node:test');
const assert = require('node:assert');

process.env.MODERATION_ALERT_EMAIL = 'jayden@example.com';
// The alerts go through services/opsAlert.js, which also pushes to each
// ADMIN_USER_IDS account. This suite pins the email leg alone, so a push that
// reached somebody must not be what holds or releases a claim here.
delete process.env.ADMIN_USER_IDS;

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
// What a real failed send looks like. sendEmail never throws; it RESOLVES
// { sent: false, ... }, and a stub that only threw hid a claim that no real
// failure ever released.
let sendResult = null;
emailService.sendEmail = async (msg) => {
  if (sendError) throw sendError;
  if (sendResult) return sendResult;
  sent.push(msg);
  return { sent: true, id: 'msg_' + sent.length };
};

// Load after the stubs so the module binds to them.
const hb = require('../services/costHeartbeat');

function reset() {
  ledger.clear();
  sent.length = 0;
  queryError = null;
  sendError = null;
  sendResult = null;
}

// The code's own reconciled dates, set per line for a sweep and put back
// afterwards. The sweep reads the merged block, and with no saved rows in this
// stubbed database every line reads its code date. A string sets every line;
// an object sets the lines it names.
async function withCodeDates(dates, fn) {
  const saved = costModel.RECONCILED.lines.map((l) => l.asOf);
  for (const l of costModel.RECONCILED.lines) {
    if (typeof dates === 'string') l.asOf = dates;
    else if (Object.prototype.hasOwnProperty.call(dates, l.id)) l.asOf = dates[l.id];
  }
  try {
    return await fn();
  } finally {
    costModel.RECONCILED.lines.forEach((l, i) => { l.asOf = saved[i]; });
  }
}
const TODAY = () => new Date().toISOString().slice(0, 10);

// Two lines shaped like readReconciled's, for the pure checks.
const block = (googleAsOf, railwayAsOf) => ({
  lines: [
    { id: 'google-cloud', label: 'Google Cloud', asOf: googleAsOf, readFrom: 'the latest paid invoice on the Google Cloud billing page' },
    { id: 'railway', label: 'Railway', asOf: railwayAsOf, readFrom: 'the estimated bill `railway usage` prints for the current billing period' },
  ],
});

// ---------------------------------------------------------------------------
// 1. The reconciled-date finding, pure.
// ---------------------------------------------------------------------------
test('reconciled lines all inside the window are silent', () => {
  const now = new Date('2026-09-10T12:00:00Z');
  assert.equal(hb.reconciledFinding(block('2026-09-01', '2026-09-10'), now), null);
  assert.equal(hb.reconciledFinding(block('2026-08-07', '2026-08-07'), now), null, '34 days is still inside a 35 day window');
});

test('a reconciled line at or past the window is a finding that names it', () => {
  const now = new Date('2026-09-10T12:00:00Z');
  const f = hb.reconciledFinding(block('2026-08-06', '2026-09-09'), now);
  assert.ok(f, '35 days must produce a finding');
  assert.equal(f.key, 'cost_reconciled_stale');
  const text = f.lines.join('\n');
  assert.ok(text.includes('Google Cloud line was last read 35 days ago'), 'the email names the line and its age');
  assert.ok(text.includes('2026-08-06'), 'the email names the date it is judging');
  assert.ok(text.includes('latest paid invoice on the Google Cloud billing page'), 'and where the next figure comes from');
  assert.ok(!text.includes('Railway line'), 'a line inside the window is not named');
});

test('a fresh line never hides a stale one', () => {
  // The block's own asOf is the newest line date. Judging that one date let a
  // Railway figure recorded this week vouch for a Google invoice months old.
  const now = new Date('2026-12-01T12:00:00Z');
  const b = { asOf: '2026-11-30', ...block('2026-09-01', '2026-11-30') };
  const f = hb.reconciledFinding(b, now);
  assert.ok(f, 'the Google line is 91 days old and must be reported');
  assert.ok(f.lines.join('\n').includes('Google Cloud line was last read 91 days ago, on 2026-09-01'));
  // And the other way round: an old Railway line under a fresh Google one.
  const g = hb.reconciledFinding(block('2026-11-30', '2026-09-28'), now);
  assert.ok(g, 'the Railway line is 64 days old and must be reported');
  const text = g.lines.join('\n');
  assert.ok(text.includes('Railway line was last read 64 days ago, on 2026-09-28'));
  assert.ok(text.includes('`railway usage`'), 'the email says where the Railway figure is read');
  assert.ok(!text.includes('Google Cloud line'));
});

test('two stale lines make one finding, under one key, naming both', () => {
  const now = new Date('2026-12-01T12:00:00Z');
  const f = hb.reconciledFinding(block('2026-09-01', '2026-09-28'), now);
  assert.equal(f.key, 'cost_reconciled_stale');
  const text = f.lines.join('\n');
  assert.ok(text.includes('Google Cloud line was last read 91 days ago'));
  assert.ok(text.includes('Railway line was last read 64 days ago'));
});

test('an unreadable reconciled date is stale, never current', () => {
  const now = new Date('2026-09-10T12:00:00Z');
  for (const bad of [
    {}, null, { asOf: '2026-09-09' }, { lines: [] }, { lines: 'x' },
    block(null, '2026-09-09'), block('yesterday', '2026-09-09'), block('2026-09-09', undefined),
    { lines: [null] },
  ]) {
    const f = hb.reconciledFinding(bad, now);
    assert.ok(f, `expected a finding for ${JSON.stringify(bad)}`);
    assert.ok(f.lines.join('\n').includes('no readable date'), `no readable date not said for ${JSON.stringify(bad)}`);
  }
});

test('the shipped RECONCILED block is judged by the same function the sweep uses', () => {
  // Whatever costModel carries today, the function must return either null or a
  // well-formed finding, never throw. This is the seam the sweep relies on.
  const f = hb.reconciledFinding(costModel.RECONCILED);
  assert.ok(f === null || (f.key === 'cost_reconciled_stale' && Array.isArray(f.lines)));
  // On the day after the newest code date, a line is judged by its own date:
  // silent while the oldest is inside the window, a finding once it is not.
  const dates = costModel.RECONCILED.lines.map((l) => l.asOf).sort();
  const at = (ymd, days) => new Date(Date.parse(`${ymd}T12:00:00Z`) + days * 86400000);
  assert.equal(hb.reconciledFinding(costModel.RECONCILED, at(dates[0], hb.RECONCILED_STALE_DAYS - 1)), null);
  assert.ok(hb.reconciledFinding(costModel.RECONCILED, at(dates[0], hb.RECONCILED_STALE_DAYS)));
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
test('a stale line mails exactly once per day even across a restart', async () => {
  reset();
  photoStore.photoSpendStatus = async () => ({ monthUsed: 0, monthUsd: 0, limits });
  await withCodeDates('2026-01-01', async () => {
    await hb.runCostHeartbeat();
    await hb.runCostHeartbeat();
    // A "restart" forgets nothing here because the ledger is the database,
    // which is the whole point of putting it there.
    await hb.runCostHeartbeat();
    assert.equal(sent.length, 1, 'one email for one stale day, not one per sweep, however many lines are stale');
    assert.equal(sent[0].to, 'jayden@example.com');
    assert.ok(/fresh bill figure/.test(sent[0].subject));
    for (const l of costModel.RECONCILED.lines) {
      assert.ok(sent[0].text.includes(`${l.label} line was last read`), `the email does not name ${l.id}`);
    }
  });
});

test('the sweep reports only the stale line when the other is fresh', async () => {
  // Railway recorded today, Google Cloud left months old: the fresh Railway
  // date must not vouch for the Google one, and the Railway line is not named.
  reset();
  photoStore.photoSpendStatus = async () => ({ monthUsed: 0, monthUsd: 0, limits });
  await withCodeDates({ 'google-cloud': '2026-01-01', railway: TODAY() }, async () => {
    await hb.runCostHeartbeat();
    assert.equal(sent.length, 1);
    const google = costModel.RECONCILED.lines.find((l) => l.id === 'google-cloud');
    const railway = costModel.RECONCILED.lines.find((l) => l.id === 'railway');
    assert.ok(sent[0].text.includes(`${google.label} line was last read`));
    assert.ok(!sent[0].text.includes(`${railway.label} line`));
  });
  reset();
  await withCodeDates({ 'google-cloud': TODAY(), railway: '2026-01-01' }, async () => {
    await hb.runCostHeartbeat();
    assert.equal(sent.length, 1);
    assert.ok(sent[0].text.includes('Railway (backend and Postgres) line was last read'));
    assert.ok(sent[0].text.includes('railway usage'), 'the email says where the Railway figure is read');
  });
});

test('the two findings dedupe independently and both can mail on the same day', async () => {
  reset();
  photoStore.photoSpendStatus = async () => ({ monthUsed: 4571, monthUsd: 25, limits });
  await withCodeDates('2026-01-01', async () => {
    await hb.runCostHeartbeat();
    await hb.runCostHeartbeat();
    assert.equal(sent.length, 2, 'one email per finding, then silence');
    const subjects = sent.map((m) => m.subject).sort();
    assert.ok(subjects.some((s) => /fresh bill figure/.test(s)));
    assert.ok(subjects.some((s) => /photo budget/.test(s)));
  });
});

test('a failed send releases the claim so the next sweep can try again', async () => {
  reset();
  photoStore.photoSpendStatus = async () => ({ monthUsed: 0, monthUsd: 0, limits });
  await withCodeDates('2026-01-01', async () => {
    sendError = new Error('provider down');
    await hb.runCostHeartbeat();
    assert.equal(sent.length, 0);
    sendError = null;
    await hb.runCostHeartbeat();
    assert.equal(sent.length, 1, 'the claim was released, so the retry mailed');
  });
});

test('a send that RESOLVES as failed releases the claim and is not logged as mailed', async () => {
  // The shape every real failure takes. The photo budget crossing 90% while
  // Resend answers 429 used to keep the day's claim and log "Alert mailed.",
  // so the three sweeps after it stayed silent and the warning came a day
  // late, if the budget had not run out by then.
  const saved = costModel.RECONCILED.lines.map((l) => l.asOf);
  for (const l of costModel.RECONCILED.lines) l.asOf = TODAY();
  photoStore.photoSpendStatus = async () => ({ monthUsed: 4200, monthUsd: 23, limits });
  const realError = console.error;
  // What a delivered alert logs through services/opsAlert.js is "Alert sent by
  // <legs>.". The recovery run below checks this pattern does match a real
  // delivery, so its absence on a failure means something.
  const MAILED = /Alert sent by|Alert mailed/;
  const capture = async (fn) => {
    const logged = [];
    console.error = (...a) => logged.push(a.join(' '));
    try {
      await fn();
    } finally {
      console.error = realError;
    }
    return logged;
  };
  try {
    for (const failure of [
      { sent: false, error: 'Too many requests', refused: true },
      { sent: false, error: 'This operation was aborted' },
      { sent: false, error: 'per-recipient daily cap', refused: true },
      { sent: false, skipped: true },
    ]) {
      reset();
      sendResult = failure;
      const logged = await capture(() => hb.runCostHeartbeat());
      assert.equal(ledger.size, 0, `${JSON.stringify(failure)} kept the day's claim`);
      assert.ok(!logged.some((l) => MAILED.test(l)), `${JSON.stringify(failure)} was logged as mailed`);
      assert.ok(logged.some((l) => /NOT delivered/.test(l)), 'the failure is said out loud');
      assert.ok(logged.some((l) => /\[COST-HEARTBEAT\] Flock photo budget is nearly spent, and the alert was NOT delivered/.test(l)),
        'the failure line names what went unreported');

      sendResult = null;
      const recovered = await capture(() => hb.runCostHeartbeat());
      assert.equal(sent.length, 1, 'the next sweep mails once the provider recovers');
      assert.ok(/photo budget/.test(sent[0].subject));
      assert.ok(recovered.some((l) => MAILED.test(l)), 'a delivered alert is logged as sent');
      assert.ok(!recovered.some((l) => /NOT delivered/.test(l)), 'and not as undelivered');
    }
  } finally {
    console.error = realError;
    costModel.RECONCILED.lines.forEach((l, i) => { l.asOf = saved[i]; });
  }
});

test('a healthy picture is silent', async () => {
  reset();
  photoStore.photoSpendStatus = async () => ({ monthUsed: 10, monthUsd: 0, limits });
  await withCodeDates(TODAY(), async () => {
    await hb.runCostHeartbeat();
    assert.equal(sent.length, 0);
  });
});

// ---------------------------------------------------------------------------
// 4. It can never take the app down.
// ---------------------------------------------------------------------------
test('a database failure inside the sweep is caught', async () => {
  reset();
  photoStore.photoSpendStatus = async () => ({ monthUsed: 0, monthUsd: 0, limits });
  queryError = new Error('connection terminated');
  try {
    await withCodeDates('2026-01-01', async () => {
      await assert.doesNotReject(() => hb.runCostHeartbeat());
      assert.equal(sent.length, 0);
    });
  } finally {
    queryError = null;
  }
});

test('the kill switch shared with the collection heartbeat silences it', async () => {
  reset();
  process.env.HEARTBEAT_DISABLED = 'true';
  try {
    await withCodeDates('2026-01-01', async () => {
      assert.equal(hb.costHeartbeatEnabled(), false);
      await hb.runCostHeartbeat();
      assert.equal(sent.length, 0);
    });
  } finally {
    delete process.env.HEARTBEAT_DISABLED;
  }
});
