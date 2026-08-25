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
// Attacking the INCENTIVE rather than the arithmetic, three properties fell
// out, and each of them pointed the same way: the strike could only ever land
// on a reading that was not doing any harm. All three are closed here, and
// each test now pins the closure rather than the hole.
//
//   M. A READING THAT IS THE PUBLISHED NUMBER COULD NOT BE STRUCK. markDiverged
//      was called from inside the `reporters >= MIN_CALIBRATION_REPORTERS`
//      branch, which is the branch that returns `applied: false`. The override
//      branch stamped nothing. So the strike system was disarmed in exactly
//      the state it exists to punish: a venue with fewer than three verified
//      reporters in that venue-hour over 28 days, where the owner's slider IS
//      the number every user sees. Which branch a reading lands in is a fact
//      about the venue's report history, not about the owner's honesty, so it
//      was never allowed to gate the penalty. Judgement now runs above both
//      branches, on the one test that is made of evidence.
//
//   N. REFRESHING THE READING WIPED THE EVIDENCE. contemporaneousReports
//      windowed from the CURRENT row's created_at, and only the newest row per
//      place is ever handed to applyOwnerReport. Posting again, allowed once
//      every 60 seconds and 48 times a day, made every report filed against
//      the previous reading fall outside the window, permanently and by
//      construction. The window now starts where the ASSERTION starts
//      (assertion_since), so re-posting the same number carries the evidence
//      forward instead of dropping it.
//
//   O. RETRACTION WAS A FREE RESET. A retracted row is dropped by
//      liveOwnerReport before any judgement, which is right: taking the number
//      down is the remedy, and it has to stay free. What was not right is that
//      it also erased what the room had said, so retract-and-re-post bought a
//      clean slate every 60 seconds. The assertion walk counts retracted rows,
//      so it does not any more. The asymmetry that was already correct is
//      preserved: the suppression subquery carries no `retracted` predicate,
//      so a strike already stamped survives retraction.
//
// What HELD is asserted too: the 90-minute expiry is enforced twice, one
// account cannot be three reporters, the 25-point boundary is exclusive, and
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
// `assertionAgoMs` is the assertion_since the read computes: the oldest of this
// venue's recent readings that says materially the same thing. Left undefined
// it means "this row is the whole assertion", which is what the column
// resolves to for a first posting.
function ownerRow({
  id = 1, percent = 95, agoMs = 0, retracted = false, diverged = false, assertionAgoMs,
} = {}) {
  return {
    id,
    google_place_id: 'ChIJsliderabuse00001',
    busy_percent: percent,
    created_at: new Date(NOW - agoMs).toISOString(),
    retracted,
    diverged,
    profile_category: 'bar',
    assertion_since: new Date(NOW - (assertionAgoMs === undefined ? agoMs : assertionAgoMs)).toISOString(),
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
// M. THE READING THAT MATTERS IS THE READING THAT IS JUDGED
// ═════════════════════════════════════════════════════════════════════════════

test('ABUSE M: with the slider driving the published number, contemporaneous reporters stamp a strike', async () => {
  const row = ownerRow({ percent: 95, agoMs: 10 * MIN });
  // Ten distinct verified accounts, all in the room, all saying "quiet" (20),
  // all filed while the owner's 95 was the number on the card. That is 75
  // points of disagreement, three times the threshold.
  const contradiction = reports([11, 12, 13, 14, 15, 16, 17, 18, 19, 20], 1, NOW - 5 * MIN);

  // This venue has fewer than three verified reporters in its 28-day
  // calibration window for this venue-hour, which is the default state of any
  // venue without a dense report history. It used to be the state in which no
  // strike could ever land.
  const result = ownerReports.applyOwnerReport(payload({ reportCount: 2, consensus: 20 }), row, {
    now: NOW,
    feedbackRows: contradiction,
  });
  await settle();

  // The reading still ships on THIS serve. The penalty is accrual, not
  // censorship of the current request: three stamped rows inside 30 days is
  // what suppresses the override, and that is enforced in the read.
  assert.strictEqual(result.score, 95, 'the owner\'s number is still what ships on this request');
  assert.strictEqual(result.ownerReport.applied, true);
  assert.strictEqual(result.confidenceMeans, 'owner_asserted');
  assert.deepStrictEqual(stamps, [1],
    'and the strike lands, on the reading that was actually on screen');

  assert.strictEqual(
    ownerReports.strikeableDivergence(contradiction, row, 95, NOW), true,
    'the service\'s own test says strikeable, and it is now the test that is asked',
  );
});

test('ABUSE M2: an outranked reading is struck on the same evidence, so the branch decides nothing', async () => {
  const contradiction = reports([11, 12, 13], 1, NOW - 5 * MIN);

  // Identical reading, identical room. The only difference between these two
  // calls is how many verified reporters this venue-hour collected over the
  // last 28 days, which is a fact about the venue's history.
  const published = ownerReports.applyOwnerReport(
    payload({ reportCount: 2, consensus: 20 }), ownerRow({ id: 6, percent: 95, agoMs: 10 * MIN }),
    { now: NOW, feedbackRows: contradiction },
  );
  const outranked = ownerReports.applyOwnerReport(
    payload({ reportCount: 3, consensus: 20 }), ownerRow({ id: 7, percent: 95, agoMs: 10 * MIN }),
    { now: NOW, feedbackRows: contradiction },
  );
  await settle();

  assert.strictEqual(published.ownerReport.applied, true, 'the owner won precedence here');
  assert.strictEqual(outranked.score, 30, 'and the people won it here');
  assert.strictEqual(outranked.ownerReport.applied, false);
  assert.deepStrictEqual(stamps, [6, 7],
    'both are struck: precedence answers which number ships, never who is accountable');
});

test('ABUSE M3: no rows in hand is still no penalty, on either branch', async () => {
  // The cache-hit card path holds a cached payload with no reports behind it.
  // Under-stamping is the safe direction for the only punitive mechanism here,
  // and hoisting the judgement must not have changed that.
  ownerReports.applyOwnerReport(payload({ reportCount: 2, consensus: 20 }), ownerRow({ id: 4 }), { now: NOW });
  ownerReports.applyOwnerReport(payload({ reportCount: 5, consensus: 20 }), ownerRow({ id: 5 }), { now: NOW });
  await settle();
  assert.deepStrictEqual(stamps, [], 'no evidence, no penalty, ever by default');
});

test('ABUSE M4: a reading already stamped is not re-stamped once per serve', async () => {
  const row = ownerRow({ id: 8, percent: 95, agoMs: 10 * MIN, diverged: true });
  const contradiction = reports([11, 12, 13], 1, NOW - 5 * MIN);
  // The override branch is the hot one: every card view, every row of every
  // /batch, every alternatives neighbour. The guard is what keeps that from
  // being one fire-and-forget UPDATE per serve for 90 minutes.
  for (let i = 0; i < 5; i += 1) {
    ownerReports.applyOwnerReport(payload({ reportCount: 2, consensus: 20 }), row, {
      now: NOW, feedbackRows: contradiction,
    });
  }
  await settle();
  assert.deepStrictEqual(stamps, []);
});

// ═════════════════════════════════════════════════════════════════════════════
// N. REFRESHING THE READING NO LONGER WIPES THE EVIDENCE
// ═════════════════════════════════════════════════════════════════════════════

test('ABUSE N: re-posting the same false number carries the evidence forward', async () => {
  const first = ownerRow({ id: 1, percent: 95, agoMs: 40 * MIN });
  // Three verified reporters contradicted it while it stood.
  const contradiction = reports([11, 12, 13], 1, NOW - 30 * MIN);

  assert.strictEqual(
    ownerReports.contemporaneousReports(contradiction, first, NOW).length, 3,
    'against the reading they were actually contradicting, all three count',
  );

  // The owner re-posts the same number. One request, allowed once every 60
  // seconds. assertion_since still points at the first row, because 95 and 95
  // are the same claim about the room.
  const second = ownerRow({ id: 2, percent: 95, agoMs: 0, assertionAgoMs: 40 * MIN });
  assert.strictEqual(
    ownerReports.contemporaneousReports(contradiction, second, NOW).length, 3,
    'against the NEW row they still count: it is the same assertion, still up',
  );
  assert.strictEqual(ownerReports.strikeableDivergence(contradiction, second, 95, NOW), true);

  const result = ownerReports.applyOwnerReport(payload({ reportCount: 3, consensus: 20 }), second, {
    now: NOW,
    feedbackRows: contradiction,
  });
  await settle();
  assert.strictEqual(result.ownerReport.applied, false);
  assert.deepStrictEqual(stamps, [2], 're-posting costs the owner a strike instead of buying a clean slate');
});

test('ABUSE N2: the 48-a-day re-post cadence no longer bounds how much evidence can accumulate', () => {
  // routes/venueDashboard.js: OWNER_REPORT_DAILY_CAP = 48, one per 60 seconds.
  // Spread evenly that is a re-post every 30 minutes, which used to be the
  // longest any contradicting evidence could survive against a sustained false
  // reading: a third of the nominal 90-minute life of a reading.
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'routes', 'venueDashboard.js'), 'utf8');
  assert.match(src, /OWNER_REPORT_DAILY_CAP\s*=\s*48/);
  assert.match(src, /INTERVAL '60 seconds'/);
  assert.strictEqual(Math.floor((24 * 60) / 48), 30);

  // Four re-posts of the same number over 80 minutes, one reporter against
  // each. Under the old rule the newest row saw only the last of them.
  const newest = ownerRow({ id: 9, percent: 95, agoMs: 0, assertionAgoMs: 80 * MIN });
  const room = [
    ...reports([11], 1, NOW - 75 * MIN),
    ...reports([12], 1, NOW - 50 * MIN),
    ...reports([13], 1, NOW - 20 * MIN),
  ];
  assert.strictEqual(ownerReports.contemporaneousReports(room, newest, NOW).length, 3);
  assert.strictEqual(ownerReports.strikeableDivergence(room, newest, 95, NOW), true);
});

test('ABUSE N3: the evidence window reaches back one reading\'s life and not one minute further', () => {
  // A claimed assertion older than the TTL is clamped, so the window is always
  // the nominal life of a reading however long the venue has been re-posting.
  const clamped = ownerReports.assertionWindow(ownerRow({ agoMs: 0, assertionAgoMs: 10 * 60 * MIN }));
  assert.strictEqual(NOW - clamped.from, ownerReports.OWNER_REPORT_TTL_MS);

  // And a row claiming an assertion that starts AFTER it was written cannot
  // narrow the window either.
  const forged = ownerRow({ agoMs: 30 * MIN });
  forged.assertion_since = new Date(NOW).toISOString();
  assert.strictEqual(ownerReports.assertionWindow(forged).from, NOW - 30 * MIN);

  // A row with no assertion_since at all falls back to its own created_at.
  const bare = ownerRow({ agoMs: 20 * MIN });
  delete bare.assertion_since;
  assert.strictEqual(ownerReports.assertionWindow(bare).from, NOW - 20 * MIN);
});

test('ABUSE N4: the read computes the assertion span itself, so no caller can forget it', () => {
  const sql = ownerReports.LIVE_OWNER_REPORTS_SQL.replace(/\s+/g, ' ');
  assert.match(sql, /MIN\(p\.created_at\)[\s\S]*AS assertion_since/,
    'the oldest reading in the current assertion, projected on the row being served');
  assert.match(sql, new RegExp(`ABS\\(p\\.busy_percent - r\\.busy_percent\\) <= ${ownerReports.OWNER_DIVERGENCE_POINTS}`),
    'same number, same claim, at the same constant the strike uses');
  const walk = sql.slice(sql.indexOf('MIN(p.created_at)'), sql.indexOf('AS assertion_since'));
  assert.strictEqual(/retracted/.test(walk), false,
    'the walk counts retracted rows: taking the number down must not erase what the room said');
  assert.match(walk, /p\.created_at > r\.created_at - INTERVAL '90 minutes'/,
    'and it is bounded to one reading\'s life');

  // The reason any of this is needed: only the newest row per place is ever
  // read, so a superseded row is never examined again on its own.
  assert.match(sql, /DISTINCT ON \(r\.google_place_id\)/);
  assert.match(sql, /ORDER BY r\.google_place_id, r\.created_at DESC/);
});

// ═════════════════════════════════════════════════════════════════════════════
// THE HONEST OWNER
// ═════════════════════════════════════════════════════════════════════════════

test('an owner who corrects a genuine mistake is not struck, and speed is not what saves them', async () => {
  const room = reports([11, 12, 13], 1, NOW - 35 * MIN); // the room says 20

  // 95 was wrong. The owner corrects it to 30, which is what the room sees.
  // A correction of more than OWNER_DIVERGENCE_POINTS is a different claim, so
  // the read starts a fresh assertion and the old evidence does not follow it.
  const correctedFast = ownerRow({ id: 21, percent: 30, agoMs: 39 * MIN, assertionAgoMs: 39 * MIN });
  const correctedSlow = ownerRow({ id: 22, percent: 30, agoMs: 5 * MIN, assertionAgoMs: 5 * MIN });
  for (const row of [correctedFast, correctedSlow]) {
    ownerReports.applyOwnerReport(payload({ reportCount: 2, consensus: 20 }), row, {
      now: NOW, feedbackRows: room,
    });
  }
  await settle();
  assert.deepStrictEqual(stamps, [], 'one minute later or forty, a correction is a correction');

  // And it is the EVIDENCE doing the work, not the fresh window: hand the
  // corrected reading the whole run of evidence anyway and it still stands,
  // because 30 is what the room is describing.
  const carried = ownerRow({ id: 23, percent: 30, agoMs: 5 * MIN, assertionAgoMs: 40 * MIN });
  assert.strictEqual(ownerReports.contemporaneousReports(room, carried, NOW).length, 3);
  assert.strictEqual(ownerReports.strikeableDivergence(room, carried, 30, NOW), false,
    'the current reading is what is measured against the room, and it agrees with it');

  // A "correction" the room does not recognise is not one.
  assert.strictEqual(ownerReports.strikeableDivergence(room, carried, 70, NOW), true);
});

test('a busy night history did not predict is not a strike, because the 28-day blend no longer decides one', async () => {
  // The slider exists for the night the venue-hour's own average is wrong and
  // the operator can see the room. Nobody in the building has contradicted it.
  const row = ownerRow({ id: 24, percent: 95, agoMs: 10 * MIN });
  const lastMonth = reports([11, 12, 13], 1, NOW - 21 * 24 * 60 * MIN);
  ownerReports.applyOwnerReport(payload({ reportCount: 3, consensus: 20 }), row, {
    now: NOW, feedbackRows: lastMonth,
  });
  await settle();
  assert.deepStrictEqual(stamps, [], 'a 28-day-old average is not somebody contradicting a live reading');
  assert.strictEqual(ownerReports.ownerDivergesFromReports(payload({ reportCount: 3, consensus: 20 }), 95), true,
    'the blend does disagree, and that is precedence talking, not accountability');
});

// ═════════════════════════════════════════════════════════════════════════════
// O. RETRACTION IS A REMEDY, NOT A RESET
// ═════════════════════════════════════════════════════════════════════════════

test('ABUSE O: retracting takes the number down, and takes the evidence with it no longer', async () => {
  const row = ownerRow({ id: 3, percent: 95, agoMs: 20 * MIN, retracted: true });
  const contradiction = reports([11, 12, 13], 1, NOW - 10 * MIN);

  // Unchanged and deliberate: a retracted row publishes nothing. The owner's
  // kill switch has to stay free, and the reading is off every screen.
  assert.strictEqual(ownerReports.liveOwnerReport(row, NOW), null);
  const result = ownerReports.applyOwnerReport(payload({ reportCount: 3, consensus: 20 }), row, {
    now: NOW,
    feedbackRows: contradiction,
  });
  await settle();
  assert.strictEqual(result.ownerReport, undefined, 'the payload comes back untouched');
  assert.deepStrictEqual(stamps, [], 'nothing is published, so nothing is charged for on this serve');

  // What has changed is what the retraction BUYS. Put the same number back up
  // a minute later and the retracted row still anchors the assertion, so the
  // reports filed against it are the evidence against the new one.
  const reposted = ownerRow({ id: 4, percent: 95, agoMs: 0, assertionAgoMs: 20 * MIN });
  const back = ownerReports.applyOwnerReport(payload({ reportCount: 2, consensus: 20 }), reposted, {
    now: NOW,
    feedbackRows: contradiction,
  });
  await settle();
  assert.strictEqual(back.ownerReport.applied, true, 'the number is up again');
  assert.deepStrictEqual(stamps, [4], 'and so is the evidence, so the strike lands');
});

test('ABUSE O2: retraction does NOT clear a strike already stamped', () => {
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
