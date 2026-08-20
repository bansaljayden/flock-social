// Run: node --test  (from backend/)
//
// ===========================================================================
// THE OWNER'S 0-100 SLIDER, and the four rules that keep it honest.
//
// A venue owner may assert "we are at X% right now" and, while that reading is
// live, it REPLACES the published prediction — labelled as the venue's own
// claim (the category-derived attribution from utils/venueLabel.js), never as
// Flock's. services/ownerReports.js is the one place the rules live; this
// file pins each of them:
//
//   1. OVERRIDE — a live reading replaces score, label and basis, and the
//      derived fields (wait, capacity.current) are re-derived from it so one
//      card cannot say "95% full" and "No wait" at once.
//   2. EXPIRY — 90 minutes, enforced in SQL and re-checked in JS. A stale row
//      handed in from anywhere publishes nothing; the number falls back to the
//      prediction on its own, because forgetting to clear it is the normal
//      case and the design assumes it (VENUE-ADVISOR.md).
//   3. PRECEDENCE — three or more verified reporters outrank the owner. The
//      published number stays the existing capped user-report blend
//      (crowdEngine.buildCalibrationAdjustment, untouched); the owner's figure
//      rides along as information with applied: false.
//   4. ACCOUNTABILITY — an owner reading that diverges from those reporters by
//      more than OWNER_DIVERGENCE_POINTS is stamped diverged=true, and the
//      read SQL suppresses venues with OWNER_DIVERGENCE_STRIKES stamps in the
//      window. Misreporting costs the venue the override itself.
//
// And the FTC rule that is not a behaviour but a boundary: the write path is
// free at every tier. A paid tier that buys influence over a consumer-shown
// number is the LendEDU order. Pinned as source text on the dashboard router:
// the busy-now routes must never sit behind requireVenueTier.
// ===========================================================================

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

process.env.JWT_SECRET = 'owner-busy-reports-test-secret';

const pool = require('../config/database');

// pg fake: scripted per test via `handlers`; every statement is logged.
let handlers = [];
let queryLog = [];
pool.query = (sql, params) => {
  const flat = String(sql).replace(/\s+/g, ' ').trim();
  queryLog.push({ sql: flat, params: params || [] });
  for (const [re, fn] of handlers) {
    if (re.test(flat)) {
      const out = fn(params || [], flat);
      return Promise.resolve(out === undefined ? { rows: [], rowCount: 0 } : out);
    }
  }
  return Promise.resolve({ rows: [], rowCount: 0 });
};

const ownerReports = require('../services/ownerReports');
const crowdEngine = require('../services/crowdEngine');

const NOW = Date.parse('2026-08-19T21:00:00Z');
const minutesAgo = (m) => new Date(NOW - m * 60 * 1000);

function freshRow(overrides = {}) {
  return {
    id: 5,
    google_place_id: 'ChIJownerplace0000000000000',
    busy_percent: 85,
    retracted: false,
    diverged: false,
    created_at: minutesAgo(10),
    ...overrides,
  };
}

// A card-shaped payload the way routes/crowd.js assembles one.
function cardResult(overrides = {}) {
  return {
    placeId: 'ChIJownerplace0000000000000',
    score: 42,
    label: 'Moderate',
    rawEngineScore: 42,
    confidence: 70,
    predictionMethod: 'ml',
    confidenceBasis: 'model_holdout',
    confidenceMeans: 'measured_accuracy',
    supported: true,
    capacity: { current: 50, max: 120 },
    waitEstimate: 'No wait',
    venueTypes: ['bar'],
    priceLevel: 2,
    calibration: { feedbackUsed: false, reportCount: 0, predictionDrift: 0 },
    ...overrides,
  };
}

// ── 1. liveOwnerReport: the liveness rule itself ────────────────────────────

test('a fresh reading is live, with expiresAt exactly TTL after it was set', () => {
  const live = ownerReports.liveOwnerReport(freshRow(), NOW);
  assert.ok(live, 'fresh reading must be live');
  assert.strictEqual(live.percent, 85);
  assert.strictEqual(
    Date.parse(live.expiresAt) - Date.parse(live.reportedAt),
    ownerReports.OWNER_REPORT_TTL_MS
  );
});

test('a reading older than 90 minutes is not live — expiry needs no cleanup job', () => {
  const stale = freshRow({ created_at: minutesAgo(ownerReports.OWNER_REPORT_TTL_MINUTES + 1) });
  assert.strictEqual(ownerReports.liveOwnerReport(stale, NOW), null);
  // The boundary itself: exactly TTL old is dead, one minute inside is alive.
  const atBoundary = freshRow({ created_at: minutesAgo(ownerReports.OWNER_REPORT_TTL_MINUTES) });
  assert.strictEqual(ownerReports.liveOwnerReport(atBoundary, NOW), null);
  const justInside = freshRow({ created_at: minutesAgo(ownerReports.OWNER_REPORT_TTL_MINUTES - 1) });
  assert.ok(ownerReports.liveOwnerReport(justInside, NOW));
});

test('retracted, unreadable and out-of-range rows publish nothing', () => {
  assert.strictEqual(ownerReports.liveOwnerReport(freshRow({ retracted: true }), NOW), null);
  assert.strictEqual(ownerReports.liveOwnerReport(freshRow({ busy_percent: 101 }), NOW), null);
  assert.strictEqual(ownerReports.liveOwnerReport(freshRow({ busy_percent: -1 }), NOW), null);
  assert.strictEqual(ownerReports.liveOwnerReport(freshRow({ busy_percent: 'packed' }), NOW), null);
  assert.strictEqual(ownerReports.liveOwnerReport(freshRow({ created_at: 'not a date' }), NOW), null);
  assert.strictEqual(ownerReports.liveOwnerReport(null, NOW), null);
});

// ── 2. applyOwnerReport: the serve-path override ────────────────────────────

test('a live reading replaces the number, labelled as the bar\'s own claim', () => {
  const out = ownerReports.applyOwnerReport(cardResult(), freshRow(), { now: NOW });
  assert.strictEqual(out.score, 85);
  assert.strictEqual(out.confidenceBasis, 'owner_report');
  assert.strictEqual(out.confidenceMeans, 'owner_asserted');
  assert.strictEqual(out.supported, true);
  // Stated as fact, not hedged into "Usually ..." — the hedge is for priors.
  assert.strictEqual(out.label, crowdEngine.getLabel(85));
  assert.ok(out.ownerReport.applied, 'payload must say the number is the owner\'s');
  assert.ok(out.ownerReport.reportedAt && out.ownerReport.expiresAt,
    'attribution must carry when it was said and when it dies');
  // The model\'s own answer stays visible beside it.
  assert.strictEqual(out.rawEngineScore, 42);
  assert.strictEqual(out.predictionMethod, 'ml');
});

test('derived fields follow the override — no "95% full" above "No wait"', () => {
  const out = ownerReports.applyOwnerReport(cardResult(), freshRow({ busy_percent: 95 }), { now: NOW });
  assert.strictEqual(out.capacity.max, 120);
  assert.strictEqual(out.capacity.current, Math.round((120 * 95) / 100));
  assert.strictEqual(out.waitEstimate, crowdEngine.estimateWait(95, ['bar'], 2));
  assert.notStrictEqual(out.waitEstimate, 'No wait');
});

test('an expired reading changes nothing — the prediction is back on its own', () => {
  const stale = freshRow({ created_at: minutesAgo(91) });
  const result = cardResult();
  const out = ownerReports.applyOwnerReport(result, stale, { now: NOW });
  assert.deepStrictEqual(out, result);
  assert.strictEqual(out.ownerReport, undefined);
});

test('a batch-shaped row without wait/capacity overrides only what it carries', () => {
  const row = cardResult();
  delete row.capacity;
  delete row.waitEstimate;
  delete row.venueTypes;
  delete row.priceLevel;
  const out = ownerReports.applyOwnerReport(row, freshRow(), { now: NOW });
  assert.strictEqual(out.score, 85);
  assert.strictEqual(out.confidenceBasis, 'owner_report');
  assert.strictEqual(out.capacity, undefined);
  assert.strictEqual(out.waitEstimate, undefined);
});

// ── 3. Precedence: three verified reporters outrank the owner ───────────────

test('at >= 3 reporters the users\' capped blend stands and the owner is information', () => {
  const blended = cardResult({
    score: 47, // buildCalibrationAdjustment already produced this
    confidenceBasis: 'user_reports',
    confidenceMeans: 'input_completeness',
    calibration: {
      feedbackUsed: true,
      reportCount: crowdEngine.MIN_CALIBRATION_REPORTERS,
      predictionDrift: 5,
    },
  });
  const out = ownerReports.applyOwnerReport(blended, freshRow({ busy_percent: 90 }), { now: NOW });
  assert.strictEqual(out.score, 47, 'the blend is the published number, untouched');
  assert.strictEqual(out.confidenceBasis, 'user_reports');
  assert.strictEqual(out.ownerReport.applied, false);
  assert.strictEqual(out.ownerReport.outrankedBy, 'user_reports');
  assert.strictEqual(out.ownerReport.percent, 90);
});

test('below the reporter floor the owner still wins — 2 reporters are 0 evidence', () => {
  const under = cardResult({
    calibration: { feedbackUsed: false, reportCount: 2, predictionDrift: 0 },
  });
  const out = ownerReports.applyOwnerReport(under, freshRow(), { now: NOW });
  assert.strictEqual(out.score, 85);
  assert.strictEqual(out.confidenceBasis, 'owner_report');
});

// ── 4. Accountability: divergence is stamped, agreement is not ──────────────

test('an owner reading far from the reporters\' consensus earns a strike', async () => {
  handlers = [[/UPDATE venue_owner_reports SET diverged = true/, () => ({ rows: [], rowCount: 1 })]];
  queryLog = [];
  // reporters said ~engine+drift = 42+3 = 45; the owner says 90: diverges.
  const blended = cardResult({
    score: 46,
    calibration: { feedbackUsed: true, reportCount: 4, predictionDrift: 3 },
  });
  ownerReports.applyOwnerReport(blended, freshRow({ busy_percent: 90 }), { now: NOW });
  await new Promise((r) => setImmediate(r));
  const stamp = queryLog.find((q) => /SET diverged = true/.test(q.sql));
  assert.ok(stamp, 'divergence must be stamped');
  assert.deepStrictEqual(stamp.params, [5]);
});

test('an owner reading the reporters roughly agree with is not stamped', async () => {
  queryLog = [];
  const blended = cardResult({
    score: 46,
    calibration: { feedbackUsed: true, reportCount: 4, predictionDrift: 3 },
  });
  // consensus ~45, owner says 55: inside OWNER_DIVERGENCE_POINTS.
  ownerReports.applyOwnerReport(blended, freshRow({ busy_percent: 55 }), { now: NOW });
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(queryLog.filter((q) => /SET diverged/.test(q.sql)).length, 0);
});

test('ownerDivergesFromReports is exactly the points constant, exclusive', () => {
  const blended = cardResult({
    calibration: { feedbackUsed: true, reportCount: 3, predictionDrift: 0 },
  });
  const d = ownerReports.OWNER_DIVERGENCE_POINTS;
  assert.strictEqual(ownerReports.ownerDivergesFromReports(blended, 42 + d), false);
  assert.strictEqual(ownerReports.ownerDivergesFromReports(blended, 42 + d + 1), true);
  assert.strictEqual(ownerReports.ownerDivergesFromReports(cardResult(), 100), false,
    'no reporters, no divergence — there is nothing to diverge from');
});

// ── The SQL and the constants cannot drift ──────────────────────────────────

test('the read SQL enforces the same TTL, window and strike count as the constants', () => {
  const sql = ownerReports.LIVE_OWNER_REPORTS_SQL;
  assert.ok(sql.includes(`INTERVAL '${ownerReports.OWNER_REPORT_TTL_MINUTES} minutes'`),
    'expiry must be enforced in the database, at the constant');
  assert.ok(sql.includes(`INTERVAL '${ownerReports.OWNER_STRIKE_WINDOW_DAYS} days'`),
    'strike window must be enforced in the database, at the constant');
  assert.ok(sql.includes(`COUNT(*) >= ${ownerReports.OWNER_DIVERGENCE_STRIKES}`),
    'strike suppression must live in the read, so no caller can forget it');
  assert.ok(/retracted = false/.test(sql), 'a retracted reading must never leave the database');
  assert.ok(/DISTINCT ON \(r\.google_place_id\)/.test(sql), 'newest reading per venue, exactly one');
});

test('getLiveOwnerReports never throws — a failed read serves the prediction', async () => {
  handlers = [[/FROM venue_owner_reports/, () => { throw new Error('connection refused'); }]];
  const out = await ownerReports.getLiveOwnerReports(['ChIJx']);
  assert.deepStrictEqual(out, {});
  handlers = [];
  assert.deepStrictEqual(await ownerReports.getLiveOwnerReports([]), {},
    'no place ids is no round trip');
});

// ── The training-label path: export-only, owner-median anchored ─────────────

const ownerExport = require('../scripts/ml/train/ownerLabelExport');

function exportRow(overrides = {}) {
  return {
    report_id: 1,
    busy_percent: 50,
    created_at: new Date(NOW),
    day_of_week: 5,
    hour: 21,
    local_date: '2026-08-14',
    venue_id: 12,
    city: 'philadelphia',
    google_place_id: 'ChIJownerplace0000000000000',
    google_types: ['bar'],
    latitude: 39.95,
    longitude: -75.16,
    venue_category: 'bar',
    price_level: 2,
    rating: 4.4,
    review_count: 812,
    baseline_busyness: 40,
    ...overrides,
  };
}

// Five readings across three venue-local dates — the smallest exportable venue.
function anchorableRows(percents, base = {}) {
  const dates = ['2026-08-12', '2026-08-13', '2026-08-14', '2026-08-12', '2026-08-13'];
  return percents.map((p, i) => exportRow({
    report_id: i + 1,
    busy_percent: p,
    local_date: dates[i],
    hour: 18 + i,
    created_at: new Date(NOW - i * 3600 * 1000),
    ...base,
  }));
}

test('constant inflation cancels out of the label entirely — the anchor working', () => {
  // An owner who always says 90 teaches delta 0: every label IS the baseline.
  const [group] = ownerExport.groupOwnerVenues(anchorableRows([90, 90, 90, 90, 90]));
  const out = ownerExport.ownerVenueToTrainingRows(group);
  assert.strictEqual(out.rows.length, 5);
  for (const row of out.rows) {
    assert.strictEqual(row.busyness_pct, row.baseline_busyness);
    assert.strictEqual(row.label_source, ownerExport.OWNER_LABEL_SOURCE);
  }
});

test('honest dynamics survive the anchor as deltas against the served baseline', () => {
  const [group] = ownerExport.groupOwnerVenues(anchorableRows([20, 40, 50, 60, 80]));
  const out = ownerExport.ownerVenueToTrainingRows(group);
  // median 50: the packed reading trains +30 over baseline, the dead one -30.
  const byId = Object.fromEntries(out.rows.map((r, i) => [i, r]));
  assert.strictEqual(out.rows[4].busyness_pct, 40 + (80 - 50));
  assert.strictEqual(out.rows[0].busyness_pct, 40 + (20 - 50));
  assert.ok(byId, 'rows exported');
});

test('below the anchor floor nothing exports — a median of four is not an anchor', () => {
  const four = anchorableRows([90, 90, 90, 90, 90]).slice(0, 4);
  const [group] = ownerExport.groupOwnerVenues(four);
  const out = ownerExport.ownerVenueToTrainingRows(group);
  assert.strictEqual(out.rows.length, 0);
  assert.ok(out.excluded.every((e) => e.reason === 'below_anchor_floor'));
});

test('five readings on one evening are one date, not an anchor', () => {
  const oneNight = anchorableRows([20, 40, 50, 60, 80]).map((r, i) => ({
    ...r, local_date: '2026-08-14', hour: 17 + i,
  }));
  const [group] = ownerExport.groupOwnerVenues(oneNight);
  assert.strictEqual(ownerExport.ownerVenueToTrainingRows(group).rows.length, 0);
});

test('the newest reading per venue-hour-date wins — a nudged slider is one opinion', () => {
  const rows = anchorableRows([20, 40, 50, 60, 80]);
  rows.push(exportRow({
    report_id: 99,
    busy_percent: 95,
    local_date: rows[0].local_date,
    hour: rows[0].hour,
    created_at: new Date(NOW + 1000), // newer than rows[0]
  }));
  const [group] = ownerExport.groupOwnerVenues(rows);
  const out = ownerExport.ownerVenueToTrainingRows(group);
  assert.strictEqual(out.rows.length, 5, 'six readings, five cells');
});

test('the handoff numbers are pinned: weight 0.10, source owner_report', () => {
  assert.strictEqual(ownerExport.OWNER_LABEL_WEIGHT, 0.10);
  assert.strictEqual(ownerExport.OWNER_LABEL_SOURCE, 'owner_report');
});

test('the candidate SQL excludes retracted and diverged readings at the source', () => {
  const { text } = ownerExport.ownerCandidateQuery('philadelphia', 'SELECT 1 AS baseline');
  assert.ok(/retracted = false AND diverged = false/.test(text),
    'a withdrawn or falsified reading is not a label');
  assert.ok(/vp\.verified = true/.test(text), 'unverified claims never train');
  assert.ok(/AT TIME ZONE z\.name/.test(text), 'the hour column is venue-local or the row does not exist');
});

test('the export path never writes — no INSERT, UPDATE or DELETE in the module', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'ml', 'train', 'ownerLabelExport.js'), 'utf8');
  assert.ok(!/\b(INSERT INTO|UPDATE |DELETE FROM)\b/.test(src),
    'export-only: nothing here may feed serving tables');
  assert.ok(!/ml_venue_baselines/.test(src.replace(/\/\/[^\n]*/g, '')),
    'the serving baseline is off limits to self-reports');
});

// ── The serve-path wiring, pinned as source text ────────────────────────────
//
// Behaviour is covered above against the service; these pins are about the
// ROUTES not quietly dropping the call, the way predictionMethod was once
// dropped on the floor (routes/crowd.js round history). One rule per surface.

test('every crowd surface applies the override, and none bakes it into a cache', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'crowd.js'), 'utf8');
  const applications = (src.match(/ownerReports\.applyOwnerReport\(/g) || []).length;
  assert.ok(applications >= 5,
    `expected the card (cache hit + cold), the batch list and the alternatives (target + rows) to apply the override; found ${applications} call(s)`);
  // The card's cache stores the model's answer; the override lands after
  // getCached and after setCache, never before either.
  assert.ok(!/applyOwnerReport[\s\S]{0,400}?setCache\(cacheKey/.test(src),
    'an owner-asserted result must never be written into the crowd cache');
  // What was PUBLISHED is what is recorded — feedback.js verifies client
  // claims against these rows, and the client saw the owner number.
  assert.ok(/confidenceBasis === 'owner_report' \? 'owner_report'/.test(src),
    'served_predictions must record owner_report when that is what shipped');
});

test('Birdie quotes the same number as the card, with the same attribution', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'ai.js'), 'utf8');
  assert.ok(/ownerReports\.liveOwnerReport\(/.test(src),
    'the Birdie crowd tool must read the owner reading');
  assert.ok(/crowd_source/.test(src),
    'the tool result must say whose number it is, or the model narrates a claim as a measurement');
});

// ── The FTC boundary, pinned as source text ─────────────────────────────────

test('the busy-now write path is free at every tier — no requireVenueTier on it', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'venueDashboard.js'), 'utf8');
  const routes = src.match(/router\.(get|post|delete)\(\s*'\/busy-now'[^\n]*/g) || [];
  assert.ok(routes.length >= 3, `expected GET+POST+DELETE /busy-now on the dashboard router, found ${routes.length}`);
  for (const line of routes) {
    assert.ok(!/requirePremium|requireVenueTier|requirePro/.test(line),
      `paid influence over a consumer-shown number is the LendEDU shape — found a tier gate on: ${line}`);
  }
});
