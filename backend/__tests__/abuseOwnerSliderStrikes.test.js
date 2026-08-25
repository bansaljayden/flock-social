// Run: node --test  (from backend/)
//
// ─────────────────────────────────────────────────────────────────────────────
// GAME-RULE ABUSE — the owner occupancy slider and the divergence strike
// system (services/ownerReports.js, routes/venueDashboard.js /busy-now)
// ─────────────────────────────────────────────────────────────────────────────
//
// The stated design: an owner posts an attributable 0-100 reading that expires
// after 90 minutes; user reports outrank it once three or more verified
// reporters disagree; three diverged readings in 30 days suppress the venue's
// override for a month.
//
// Attacking the INCENTIVE rather than the arithmetic, three properties fall
// out, and each of them points the same way — the strike can only ever land on
// a reading that was not doing any harm.
//
//   M. A READING THAT IS THE PUBLISHED NUMBER CANNOT BE STRUCK. markDiverged
//      is called from inside the `reporters >= MIN_CALIBRATION_REPORTERS`
//      branch, which is the branch that returns `applied: false`. The override
//      branch below it stamps nothing. So the strike system is disarmed in
//      exactly the state it exists to punish: a venue with fewer than three
//      verified reporters in that venue-hour over 28 days, where the owner's
//      slider IS the number every user sees.
//
//   N. REFRESHING THE READING WIPES THE EVIDENCE. contemporaneousReports
//      windows from the CURRENT row's created_at, and only the newest row per
//      place is ever handed to applyOwnerReport. Posting again — allowed once
//      every 60 seconds, 48 times a day — makes every report filed against the
//      previous reading fall outside the window, permanently and by
//      construction, because the superseded row is never examined again.
//
//   O. RETRACTION IS A FREE ESCAPE, BUT NOT A PENALTY RESET. A retracted row
//      is dropped by liveOwnerReport before any judgement, so a reading pulled
//      before three contemporaneous reporters accumulate can never be struck.
//      The suppression subquery carries no `retracted` predicate, so a strike
//      already stamped survives retraction. Retraction helps only the owner
//      who has not been caught yet.
//
// What HELD is asserted too: with three contemporaneous verified reporters
// present the strike does land, the 90-minute expiry is enforced twice, and
// suppression is keyed on the place id so it cannot be shed by moving the
// claim to a new account.
const test = require('node:test');
const assert = require('node:assert');

const pool = require('../config/database');

// markDiverged is the only database write in this service and it is
// fire-and-forget, so the stamp is observed by watching pool.query.
let stamps = [];
let otherQueries = [];
pool.query = async (sql, params) => {
  const flat = String(sql).replace(/\s+/g, ' ').trim();
  if (/^UPDATE venue_owner_reports SET diverged = true/.test(flat)) {
    stamps.push(Number(params[0]));
    return { rows: [], rowCount: 1 };
  }
  otherQueries.push(flat);
  return { rows: [], rowCount: 0 };
};

const ownerReports = require('../services/ownerReports');
const crowdEngine = require('../services/crowdEngine');

const NOW = Date.UTC(2026, 7, 25, 22, 0, 0);
const MIN = 60e3;

test.beforeEach(() => { stamps = []; otherQueries = []; });
const settle = () => new Promise((r) => setImmediate(r));

// An owner reading row exactly as LIVE_OWNER_REPORTS_SQL returns it.
function ownerRow({ id = 1, percent = 95, agoMs = 0, retracted = false, diverged = false } = {}) {
  return {
    id,
    google_place_id: 'ChIJsliderabuse00001',
    busy_percent: percent,
    created_at: new Date(NOW - agoMs).toISOString(),
    retracted,
    diverged,
    profile_category: 'bar',
  };
}

// A crowd payload the way routes/crowd.js assembles one. rawEngineScore plus
// calibration.predictionDrift is how ownerDivergesFromReports recovers the
// reporters' 28-day consensus.
function payload({ reportCount, consensus, engine = 30 }) {
  const feedbackUsed = reportCount >= crowdEngine.MIN_CALIBRATION_REPORTERS;
  return {
    score: engine,
    label: 'Some people',
    rawEngineScore: engine,
    venueTypes: ['bar'],
    priceLevel: 2,
    waitEstimate: 'No wait',
    capacity: { current: 10, max: 100 },
    calibration: feedbackUsed
      ? { feedbackUsed: true, reportCount, predictionDrift: consensus - engine }
      : { feedbackUsed: false, reportCount },
  };
}

// Verified user reports, filed while the owner's reading was on screen.
// crowd_level 1 -> 20, 2 -> 50, 3 -> 80.
function reports(userIds, level, atMs) {
  return userIds.map((uid) => ({ user_id: uid, crowd_level: level, created_at: new Date(atMs).toISOString() }));
}

// ═════════════════════════════════════════════════════════════════════════════
// M. THE READING THAT MATTERS CANNOT BE STRUCK
// ═════════════════════════════════════════════════════════════════════════════

test('ABUSE M: with the slider driving the published number, ten contemporaneous reporters cannot stamp a strike', async () => {
  const row = ownerRow({ percent: 95, agoMs: 10 * MIN });
  // Ten distinct verified accounts, all in the room, all saying "quiet" (20),
  // all filed while the owner's 95 was the number on the card. That is 75
  // points of disagreement, three times the threshold.
  const contradiction = reports([11, 12, 13, 14, 15, 16, 17, 18, 19, 20], 1, NOW - 5 * MIN);

  // But this venue has fewer than three verified reporters in its 28-day
  // calibration window for this venue-hour, which is the ONLY thing the
  // precedence branch looks at.
  const result = ownerReports.applyOwnerReport(payload({ reportCount: 2, consensus: 20 }), row, {
    now: NOW,
    feedbackRows: contradiction,
  });
  await settle();

  assert.strictEqual(result.score, 95, 'the owner\'s number is what ships');
  assert.strictEqual(result.ownerReport.applied, true);
  assert.strictEqual(result.confidenceMeans, 'owner_asserted');
  assert.deepStrictEqual(stamps, [],
    'and no strike is stamped, because markDiverged lives inside the branch that did NOT apply the reading');

  // Stated as the invariant the code implements, so it cannot be read as a
  // borderline case: the strike test itself says "strikeable", and it does.
  assert.strictEqual(
    ownerReports.strikeableDivergence(contradiction, row, 95, NOW), true,
    'the reading IS strikeable by the service\'s own test — it is simply never asked',
  );
});

test('ABUSE M2: the same reading, same contradiction, IS struck the moment it stops being the published number', async () => {
  const row = ownerRow({ id: 7, percent: 95, agoMs: 10 * MIN });
  const contradiction = reports([11, 12, 13], 1, NOW - 5 * MIN);

  // Identical inputs but three reporters in the 28-day window, so users win.
  const result = ownerReports.applyOwnerReport(payload({ reportCount: 3, consensus: 20 }), row, {
    now: NOW,
    feedbackRows: contradiction,
  });
  await settle();

  assert.strictEqual(result.score, 30, 'the model blend ships, not the owner');
  assert.strictEqual(result.ownerReport.applied, false);
  assert.deepStrictEqual(stamps, [7], 'and NOW it is a strike');
  // The two tests differ in one input, and it is not the owner's honesty.
});

// ═════════════════════════════════════════════════════════════════════════════
// N. REFRESHING THE READING WIPES THE EVIDENCE
// ═════════════════════════════════════════════════════════════════════════════

test('ABUSE N: reposting the same false number restarts the evidence window from zero', async () => {
  const first = ownerRow({ id: 1, percent: 95, agoMs: 40 * MIN });
  // Three verified reporters contradicted it while it stood.
  const contradiction = reports([11, 12, 13], 1, NOW - 30 * MIN);

  assert.strictEqual(
    ownerReports.contemporaneousReports(contradiction, first, NOW).length, 3,
    'against the reading they were actually contradicting, all three count',
  );

  // The owner reposts. One request, allowed once every 60 seconds.
  const second = ownerRow({ id: 2, percent: 95, agoMs: 0 });
  assert.deepStrictEqual(
    ownerReports.contemporaneousReports(contradiction, second, NOW), [],
    'against the NEW row every one of them is before `from` and is discarded',
  );
  assert.strictEqual(ownerReports.strikeableDivergence(contradiction, second, 95, NOW), false);

  // And the old row can never be revisited: LIVE_OWNER_REPORTS_SQL is
  // DISTINCT ON (google_place_id) ... ORDER BY created_at DESC, so only the
  // newest row per place is ever read, and only a read can stamp.
  const sql = ownerReports.LIVE_OWNER_REPORTS_SQL.replace(/\s+/g, ' ');
  assert.match(sql, /DISTINCT ON \(r\.google_place_id\)/);
  assert.match(sql, /ORDER BY r\.google_place_id, r\.created_at DESC/);

  // Driven through the real entry point for completeness.
  const result = ownerReports.applyOwnerReport(payload({ reportCount: 3, consensus: 20 }), second, {
    now: NOW,
    feedbackRows: contradiction,
  });
  await settle();
  assert.strictEqual(result.ownerReport.applied, false);
  assert.deepStrictEqual(stamps, [], 'a refresh is a clean slate, for one request every 60 seconds');
});

test('ABUSE N2: the refresh cost is bounded only by 48 readings a day, which is a 30-minute evidence window', () => {
  // routes/venueDashboard.js: OWNER_REPORT_DAILY_CAP = 48, one per 60 seconds.
  // Spread evenly that is a repost every 30 minutes, so the longest a piece of
  // contradicting evidence can ever accumulate against a sustained false
  // reading is a third of the nominal 90-minute life of a reading.
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'routes', 'venueDashboard.js'), 'utf8');
  assert.match(src, /OWNER_REPORT_DAILY_CAP\s*=\s*48/);
  assert.match(src, /INTERVAL '60 seconds'/);
  const perDayMinutes = 24 * 60;
  assert.strictEqual(Math.floor(perDayMinutes / 48), 30);
  assert.ok(30 < ownerReports.OWNER_REPORT_TTL_MINUTES,
    'a sustained misreport is refreshable well inside its own expiry');
});

// ═════════════════════════════════════════════════════════════════════════════
// O. RETRACTION
// ═════════════════════════════════════════════════════════════════════════════

test('ABUSE O: retracting before three reporters arrive makes the reading permanently unjudgeable', async () => {
  const row = ownerRow({ id: 3, percent: 95, agoMs: 20 * MIN, retracted: true });
  const contradiction = reports([11, 12, 13], 1, NOW - 10 * MIN);

  assert.strictEqual(ownerReports.liveOwnerReport(row, NOW), null,
    'a retracted row is dropped before any judgement can run');

  const result = ownerReports.applyOwnerReport(payload({ reportCount: 3, consensus: 20 }), row, {
    now: NOW,
    feedbackRows: contradiction,
  });
  await settle();
  assert.strictEqual(result.ownerReport, undefined, 'the payload comes back untouched');
  assert.deepStrictEqual(stamps, [], 'and nothing is stamped, however loudly the room disagreed');
});

test('ABUSE O2: retraction does NOT clear a strike already stamped, so it only ever helps the uncaught', () => {
  // The suppression subquery counts diverged rows with no retracted predicate.
  const sql = ownerReports.LIVE_OWNER_REPORTS_SQL.replace(/\s+/g, ' ');
  const suppression = sql.slice(sql.indexOf('NOT EXISTS'), sql.indexOf('ORDER BY'));
  assert.match(suppression, /s\.diverged = true/);
  assert.strictEqual(/retracted/.test(suppression), false,
    'an existing strike is counted whether or not the reading was later retracted');

  // And the retraction route writes only `retracted`.
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'routes', 'venueDashboard.js'), 'utf8');
  const retract = src.slice(src.indexOf('UPDATE venue_owner_reports SET retracted = true'));
  assert.ok(retract.length > 0, 'the retraction statement exists');
  assert.strictEqual(/SET retracted = true, diverged/.test(retract), false,
    'nothing on the retraction path touches diverged in either direction');
});

// ═════════════════════════════════════════════════════════════════════════════
// WHAT HELD
// ═════════════════════════════════════════════════════════════════════════════

test('HELD: the 90-minute expiry is enforced in SQL and again in JavaScript', () => {
  const sql = ownerReports.LIVE_OWNER_REPORTS_SQL.replace(/\s+/g, ' ');
  assert.match(sql, /INTERVAL '90 minutes'/);
  assert.strictEqual(ownerReports.OWNER_REPORT_TTL_MINUTES, 90);
  // On the boundary, and one millisecond either side.
  assert.strictEqual(ownerReports.liveOwnerReport(ownerRow({ agoMs: 90 * MIN }), NOW), null);
  assert.strictEqual(ownerReports.liveOwnerReport(ownerRow({ agoMs: 90 * MIN - 1 }), NOW).percent, 95);
});

test('HELD: suppression is keyed on the place id, so moving the claim to a new account does not shed strikes', () => {
  const sql = ownerReports.LIVE_OWNER_REPORTS_SQL.replace(/\s+/g, ' ');
  const suppression = sql.slice(sql.indexOf('NOT EXISTS'), sql.indexOf('ORDER BY'));
  assert.match(suppression, /s\.google_place_id = r\.google_place_id/);
  assert.strictEqual(/venue_user_id/.test(suppression), false,
    'a fresh owner account on the same listing inherits the listing\'s strikes');
  assert.match(suppression, /INTERVAL '30 days'/);
  assert.match(suppression, /HAVING COUNT\(\*\) >= 3/);
});

test('HELD: one account filing six reports is one reporter, so the strike floor is not row-countable', () => {
  const row = ownerRow({ percent: 95, agoMs: 10 * MIN });
  const spam = reports([11, 11, 11, 11, 11, 11], 1, NOW - 5 * MIN);
  assert.strictEqual(ownerReports.contemporaneousReports(spam, row, NOW).length, 1);
  assert.strictEqual(ownerReports.strikeableDivergence(spam, row, 95, NOW), false);
});

test('HELD: a reading inside 25 points of the room is never struck, at the exact boundary', () => {
  const row = ownerRow({ percent: 45, agoMs: 10 * MIN });
  const room = reports([11, 12, 13], 1, NOW - 5 * MIN); // consensus 20
  assert.strictEqual(ownerReports.OWNER_DIVERGENCE_POINTS, 25);
  assert.strictEqual(ownerReports.strikeableDivergence(room, row, 45, NOW), false, '45 - 20 = 25 is not > 25');
  assert.strictEqual(ownerReports.strikeableDivergence(room, row, 46, NOW), true, '26 is');
});
