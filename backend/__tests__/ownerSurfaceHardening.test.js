// Run: node --test  (from backend/)
//
// ===========================================================================
// THE OWNER-FACING SURFACES, FOUR HOLES THE 2026-08-19 SECURITY ROUND FOUND
// AND COULD NOT LAND (routes/venueDashboard.js and services/ownerReports.js
// were held open by other work at the time).
//
//   1. POST /busy-now counted, then inserted, as two autocommit statements.
//      Concurrent posts all read the same pre-insert counts, so both the
//      one-a-minute rule and the daily cap were bypassable by parallelism —
//      and the daily cap is the only bound on how many owner-authored
//      TRAINING LABELS one account can manufacture in a day.
//   2. GET /this-week had no cache while its two neighbours (/intelligence,
//      /strip) share a 60-minute one. Four fourteen-day aggregates ran on
//      every dashboard mount for a panel whose smallest unit is a week.
//   3. crowdReports.avgLevel published the mean of what identifiable people
//      said, to the one party who can put names to them, with no floor —
//      while the repo already defines MIN_CALIBRATION_REPORTERS = 3 for this
//      exact table.
//   4. The SERVE path never re-checked venue_profiles.verified. Verification
//      was enforced only at write time, so an admin revoking a fraudulent
//      claim left that owner's number on every user's card for the rest of
//      its 90 minutes.
//
//   + POST /busy-now's `percent` skipped the scalarOnly guard the router's own
//     header says every body field carries.
// ===========================================================================

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

process.env.JWT_SECRET = 'owner-surface-hardening-secret';
process.env.GOOGLE_PLACES_API_KEY = 'test-places-key';
delete process.env.VENUE_BILLING_ENABLED;

const pool = require('../config/database');

// --- pg fake ------------------------------------------------------------------
// Every statement is logged with the connection it was issued on, because half
// of what is under test here is "did these run on ONE connection inside ONE
// transaction" — a fake that flattens pool.query and client.query into one
// stream cannot tell a serialised read-then-write from the race it replaced.
let handlers = [];
let log = [];
let nextClientId = 0;
let releasedClients = 0;

function dispatch(sql, params, conn) {
  const text = String(sql).replace(/\s+/g, ' ').trim();
  log.push({ text, params, conn });
  for (const [re, fn] of handlers) {
    if (re.test(text)) {
      const out = fn(params || [], text);
      return out instanceof Error ? Promise.reject(out) : Promise.resolve(out === undefined ? { rows: [], rowCount: 0 } : out);
    }
  }
  return Promise.reject(new Error(`unscripted query: ${text.slice(0, 160)}`));
}

pool.query = (sql, params) => dispatch(sql, params, 'pool');
pool.connect = async () => {
  const id = `client${++nextClientId}`;
  return {
    query: (sql, params) => dispatch(sql, params, id),
    release: () => { releasedClients += 1; },
  };
};

const authMod = require('../middleware/auth');
let CURRENT_USER = { id: 7, name: 'Owner', role: 'venue_owner' };
authMod.authenticate = (req, _res, next) => { req.user = CURRENT_USER; next(); };

// The training-context capture is somebody else's fire-and-forget path; it has
// its own suite. Stubbed so an unmodelled statement from it cannot be mistaken
// for one of these routes'.
const ownerReportContext = require('../services/ownerReportContext');
let contextCaptures = [];
ownerReportContext.captureOwnerReportContext = async (id, meta) => { contextCaptures.push({ id, meta }); };

const crowdEngine = require('../services/crowdEngine');
const ownerReports = require('../services/ownerReports');
const venueDashboardRouter = require('../routes/venueDashboard');

const app = express();
app.use(express.json());
app.use('/api/venue-dashboard', venueDashboardRouter);

let base;
const server = http.createServer(app);
test.before(() => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); });
}));
test.after(() => new Promise((resolve) => {
  server.close(() => resolve());
  pool.end?.().catch(() => {});
}));

test.beforeEach(() => {
  handlers = [];
  log = [];
  contextCaptures = [];
  releasedClients = 0;
});

async function call(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, body: json, text };
}

// A fresh, shaped place id per test: /this-week and its neighbours share ONE
// module-level cache keyed on the place id, so reusing one would leak a cached
// payload from a previous case into the next.
let placeSeq = 0;
const freshPlace = () => `ChIJownerSurface${String(++placeSeq).padStart(6, '0')}aa`;

// The venue this owner has claimed. `verified: true` unless a case says
// otherwise — every route below refuses an unverified claim on its own.
function ctxHandler(placeId, overrides = {}) {
  return [/FROM venue_profiles WHERE user_id/, () => ({
    rows: [{ id: 3, google_place_id: placeId, verified: true, category: 'bar', ...overrides }],
  })];
}

// The two reads ownerBusyState makes after a write. Neither is under test here.
const busyStateHandlers = [
  [/DISTINCT ON \(r\.google_place_id\)/, () => ({ rows: [] })],
  [/AS strikes FROM venue_owner_reports/, () => ({ rows: [{ strikes: 0 }] })],
];

// ─── 1. THE COUNT-THEN-INSERT RACE ──────────────────────────────────────────

function busyNowHandlers(placeId, counts = { last_minute: 0, last_day: 0 }) {
  return [
    ctxHandler(placeId),
    [/^(BEGIN|COMMIT|ROLLBACK)/i, () => ({ rows: [] })],
    [/pg_advisory_xact_lock/i, () => ({ rows: [{}] })],
    [/AS last_minute/, () => ({ rows: [counts] })],
    [/^INSERT INTO venue_owner_reports/i, () => ({ rows: [{ id: 555 }] })],
    ...busyStateHandlers,
  ];
}

test('the two ceilings and the insert run in ONE locked transaction, on ONE connection', async () => {
  const place = freshPlace();
  handlers = busyNowHandlers(place);
  const r = await call('POST', '/api/venue-dashboard/busy-now', { percent: 80 });
  assert.equal(r.status, 201, r.text);

  const tx = log.filter((q) => q.conn !== 'pool');
  const at = (re) => tx.findIndex((q) => re.test(q.text));
  const begin = at(/^BEGIN/i);
  const lock = at(/pg_advisory_xact_lock/i);
  const count = at(/AS last_minute/);
  const ins = at(/^INSERT INTO venue_owner_reports/i);
  const commit = at(/^COMMIT/i);

  assert.ok(begin === 0, 'the transaction opens first');
  // Without the lock, N concurrent posts all read the same pre-insert counts
  // and all of them land. This is the whole fix.
  assert.ok(lock > begin && lock < count, 'the lock is taken BEFORE the counts are read');
  assert.ok(count < ins && ins < commit, 'read-then-write, then commit, inside the tx');

  // One connection for all five: a count on a pooled connection and an insert
  // on another is the race wearing a transaction's clothes.
  const conns = new Set(tx.map((q) => q.conn));
  assert.equal(conns.size, 1, 'every statement in the critical section is on the same connection');
  assert.equal(releasedClients, 1, 'the connection is returned to the pool');
});

test('the advisory lock is keyed to the owner, in its own namespace', async () => {
  const place = freshPlace();
  handlers = busyNowHandlers(place);
  await call('POST', '/api/venue-dashboard/busy-now', { percent: 80 });
  const lock = log.find((q) => /pg_advisory_xact_lock/i.test(q.text));
  assert.deepEqual(lock.params, [String(CURRENT_USER.id)], 'per owner, not global — one venue must not block another');
  assert.match(lock.text, /owner_busy:/, 'its own namespace string, colliding with no other lock in the repo');
});

test('the one-a-minute rule still refuses, from inside the transaction', async () => {
  const place = freshPlace();
  handlers = busyNowHandlers(place, { last_minute: 1, last_day: 3 });
  const r = await call('POST', '/api/venue-dashboard/busy-now', { percent: 80 });
  assert.equal(r.status, 429, r.text);
  assert.match(r.body.error, /One update a minute/);
  assert.ok(!log.some((q) => /^INSERT INTO venue_owner_reports/i.test(q.text)), 'nothing was written');
  assert.ok(log.some((q) => /^COMMIT/i.test(q.text)), 'a refusal still ends the transaction, releasing the lock');
  assert.equal(contextCaptures.length, 0, 'and no training-context capture fires for a reading that does not exist');
});

test('the daily cap still refuses, and the capture never runs on a refusal', async () => {
  const place = freshPlace();
  handlers = busyNowHandlers(place, { last_minute: 0, last_day: 999 });
  const r = await call('POST', '/api/venue-dashboard/busy-now', { percent: 80 });
  assert.equal(r.status, 429, r.text);
  assert.match(r.body.error, /Daily limit/);
  assert.ok(!log.some((q) => /^INSERT INTO venue_owner_reports/i.test(q.text)));
  assert.equal(contextCaptures.length, 0);
});

test('the training-context capture starts only after the row is committed', async () => {
  const place = freshPlace();
  handlers = busyNowHandlers(place);
  const r = await call('POST', '/api/venue-dashboard/busy-now', { percent: 80 });
  assert.equal(r.status, 201, r.text);
  // The capture reads its OWN connection out of the pool. Started inside the
  // transaction it would look for a row that is not committed yet and store
  // NULLs for the one field it exists to record.
  assert.equal(contextCaptures.length, 1);
  assert.equal(contextCaptures[0].id, 555);
  const commitAt = log.findIndex((q) => /^COMMIT/i.test(q.text));
  const insertAt = log.findIndex((q) => /^INSERT INTO venue_owner_reports/i.test(q.text));
  assert.ok(insertAt >= 0 && commitAt > insertAt);
});

// ─── 5. THE SHAPE GUARD THE ROUTER'S OWN HEADER MANDATES ────────────────────

test('an array percent is a 400 at the shape guard, not a 500 at the SMALLINT', async () => {
  const place = freshPlace();
  handlers = busyNowHandlers(place);
  // Two elements: validator.js joins to "8,0", which isInt rejects — but the
  // point is WHERE it is rejected. Without scalarOnly a one-element array
  // ([80]) coerces to "80", passes isInt, stays an array in req.body, and
  // Number([80]) === 80 puts a value into the database that never passed a
  // shape check. Both shapes must die in the validator.
  for (const percent of [[80], [8, 0], { v: 80 }]) {
    log = [];
    const r = await call('POST', '/api/venue-dashboard/busy-now', { percent });
    assert.equal(r.status, 400, `${JSON.stringify(percent)} must be a 400: ${r.text}`);
    assert.ok(!log.some((q) => /INSERT INTO venue_owner_reports/i.test(q.text)),
      'and it must never reach a write');
  }
});

test('a scalar percent still works, including the edges', async () => {
  for (const percent of [0, 100, 43]) {
    const place = freshPlace();
    handlers = busyNowHandlers(place);
    const r = await call('POST', '/api/venue-dashboard/busy-now', { percent });
    assert.equal(r.status, 201, `${percent}: ${r.text}`);
  }
});

// ─── 2 & 3. /this-week: the cache, and the k-anonymity floor ────────────────

function weekHandlers(placeId, feedbackRow) {
  return [
    ctxHandler(placeId),
    [/FROM venue_votes/, () => ({ rows: [{ this_week: 4, last_week: 2 }] })],
    [/FROM venue_feedback/, () => ({ rows: [feedbackRow] })],
    [/FROM venue_reviews/, () => ({ rows: [{ this_week: 1, avg_rating: 4.5 }] })],
    [/FROM venue_owner_reports/, () => ({ rows: [{ this_week: 6, median_percent: 55 }] })],
  ];
}

const feedbackRow = (reporters, avg = 2.4) => ({
  this_week: 9, last_week: 4, reporters, avg_level: avg,
});

test('the weekly panel is cached on the same 60-minute clock as its neighbours', async () => {
  const place = freshPlace();
  handlers = weekHandlers(place, feedbackRow(5));

  const first = await call('GET', '/api/venue-dashboard/this-week');
  assert.equal(first.status, 200, first.text);
  const aggregates = (q) => /FROM venue_votes|FROM venue_feedback|FROM venue_reviews|FROM venue_owner_reports/.test(q.text);
  assert.equal(log.filter(aggregates).length, 4, 'four aggregates on a cold cache');

  log = [];
  const second = await call('GET', '/api/venue-dashboard/this-week');
  assert.equal(second.status, 200, second.text);
  assert.equal(log.filter(aggregates).length, 0, 'the second mount runs no aggregate at all');
  assert.deepEqual(second.body, first.body, 'and answers the identical payload');
});

test('the cache is keyed per venue, so one owner never reads another owner\'s week', async () => {
  const a = freshPlace();
  handlers = weekHandlers(a, feedbackRow(5, 2.4));
  const ra = await call('GET', '/api/venue-dashboard/this-week');
  assert.equal(ra.status, 200, ra.text);

  const b = freshPlace();
  handlers = weekHandlers(b, feedbackRow(5, 1.1));
  const rb = await call('GET', '/api/venue-dashboard/this-week');
  assert.equal(rb.status, 200, rb.text);
  // 2.4 and 1.1 are what the query returns; 2.5 and 1.0 are what ships. The
  // published value is coarsened to a half point (LEVEL_GRID, and the
  // rolling-window note beside it in routes/venueDashboard.js), so these
  // assert the COARSENED numbers and would catch the grid being removed.
  assert.equal(ra.body.crowdReports.avgLevel, 2.5);
  assert.equal(rb.body.crowdReports.avgLevel, 1.0, 'a second venue got its own numbers, not the cached first');
});

test('avgLevel is withheld below the reporter floor, with a reason rather than a silent null', async () => {
  for (const n of [0, 1, 2]) {
    const place = freshPlace();
    handlers = weekHandlers(place, feedbackRow(n));
    const r = await call('GET', '/api/venue-dashboard/this-week');
    assert.equal(r.status, 200, r.text);
    const cr = r.body.crowdReports;
    assert.equal(cr.avgLevel, null, `${n} reporters must not publish an average`);
    assert.equal(cr.avgLevelWithheld, true);
    assert.ok(typeof cr.avgLevelReason === 'string' && cr.avgLevelReason.length > 0,
      'a withheld number says why — the dashboard must not have to invent an explanation');
    // The COUNTS are volume, not content: they say nothing about what any one
    // person reported, and an owner losing them would lose the whole panel.
    assert.equal(cr.thisWeek, 9);
    assert.equal(cr.lastWeek, 4);
    // And the count of reporters is itself withheld — "2 of 3" re-identifies
    // as well as the average does.
    assert.equal(cr.reporters, undefined);
  }
});

test('the floor IS MIN_CALIBRATION_REPORTERS, not a second copy of the number', async () => {
  // Three is already what venue_feedback needs before it may move the score
  // users see (crowdEngine) or outrank the owner's live reading
  // (ownerReports). A venue-facing readout of the same rows must not be looser
  // than the consumer-facing one, and must not drift from it either.
  assert.equal(crowdEngine.MIN_CALIBRATION_REPORTERS, 3);

  const place = freshPlace();
  handlers = weekHandlers(place, feedbackRow(crowdEngine.MIN_CALIBRATION_REPORTERS));
  const r = await call('GET', '/api/venue-dashboard/this-week');
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.crowdReports.avgLevel, 2.5, 'exactly at the floor, the average is published (on the half-point grid)');
  assert.equal(r.body.crowdReports.avgLevelWithheld, false);
  assert.equal(r.body.crowdReports.minReporters, crowdEngine.MIN_CALIBRATION_REPORTERS,
    'the floor is published so the dashboard quotes the shipped number');
});

test('the floor counts DISTINCT accounts, not rows - and neither does the average', async () => {
  // One person filing three reports is one person. A floor that counts rows is
  // not a floor: the single reporter whose average this hides can clear it
  // alone, by correcting themselves twice.
  //
  // SECURITY ROUND 5, 2026-08-20: the same argument applies to the AVERAGE, and
  // it did not hold there. The floor counted accounts while the mean was taken
  // over rows, so three reporters cleared the gate and one of them filing six
  // of the eight rows made the published number substantially their own,
  // handed to the party who can put a name to them. The average now has the
  // same unit the floor is counted in: one value per person, then the average
  // of those.
  const place = freshPlace();
  handlers = weekHandlers(place, feedbackRow(5));
  await call('GET', '/api/venue-dashboard/this-week');
  const q = log.find((x) => /FROM venue_feedback/.test(x.text));
  assert.match(q.text, /GROUP BY user_id/,
    'the average must be per person, so one prolific reporter cannot become the number');
  assert.match(q.text, /COUNT\(\*\) FROM per_reporter/,
    'the reporter count must be over accounts, the way crowdEngine.usableCalibrationReports dedupes');
  assert.doesNotMatch(q.text, /AVG\(crowd_level\)[^)]*FILTER/,
    'a straight row-average is the shape this replaced; it must not come back');
});

test('the published level is coarsened, so the rolling window cannot be differenced', async () => {
  // THE ATTACK THIS GRID EXISTS TO KILL, in full. crowd_level is a SMALLINT in
  // {1,2,3}. The panel publishes an exact row count beside the average, and the
  // window is a SEVEN-DAY ROLL: it drops whatever aged out overnight and adds
  // whatever arrived. With the average at one decimal place, count times
  // average recovers the integer sum EXACTLY, so on any night where the count
  // falls by one and nothing new lands, yesterday's sum minus today's IS the
  // level one identifiable person filed, with its date attached. An owner with
  // an incoming-flocks feed and a reviews tab does the rest.
  //
  // A wider floor does nothing to that: the subtraction works at any n. Losing
  // the last decimal place kills it at every n at once, which is why the fix is
  // a grid and not a bigger number. It is the same guard advisorCohort.js
  // applies to the cohort median (its guard 4), read against a 1-to-3 scale.
  const cases = [
    [2.4, 2.5], [2.6, 2.5], [1.1, 1.0], [1.24, 1.0], [1.26, 1.5], [3, 3], [2.75, 3],
  ];
  for (const [raw, shown] of cases) {
    const place = freshPlace();
    handlers = weekHandlers(place, feedbackRow(5, raw));
    const r = await call('GET', '/api/venue-dashboard/this-week');
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.crowdReports.avgLevel, shown,
      `${raw} must publish as ${shown}: anything finer is invertible against the count`);
    // The precision is published, so the dashboard can say "about" and mean it
    // rather than printing a deliberately blunt number as if it were exact.
    assert.equal(r.body.crowdReports.avgLevelPrecision, 0.5);
  }
});

// ─── 4. VERIFICATION IS RE-CHECKED AT SERVE TIME ────────────────────────────

test('the serve read requires a live verified claim, not one that was verified at write time', async () => {
  // The write path checks ctx.verified (POST /busy-now, 403). That is a check
  // at ONE instant. Verification is revocable — routes/admin.js exists to
  // revoke a fraudulent claim — and until this clause the revoked owner's
  // number stayed on every user's card for the rest of its 90 minutes, on
  // every surface routes/crowd.js applies the override to.
  const sql = ownerReports.LIVE_OWNER_REPORTS_SQL;
  assert.match(sql, /venue_profiles/, 'the serve read must consult the claim, not just the report');
  assert.match(sql, /vp\.verified = true/, 'and it must require the claim to be verified NOW');
  // Both halves of the claim: the same account, on the same place id. A row
  // matched on place id alone would let any verified profile anywhere keep a
  // revoked owner's readings alive.
  assert.match(sql, /vp\.user_id = r\.venue_user_id/);
  assert.match(sql, /vp\.google_place_id = r\.google_place_id/);
});

test('a revoked claim stops being served, without deleting the owner\'s history', async () => {
  // The rows stay in the table: an expired, retracted or unverified reading is
  // still a labelled observation for the training export (031's rule). It just
  // stops being the number.
  handlers = [[/FROM venue_owner_reports/, (params, text) => {
    assert.match(text, /venue_profiles/, 'the verified join must be in the statement that runs');
    return { rows: [] }; // Postgres, with the claim revoked, returns nothing.
  }]];
  const out = await ownerReports.getLiveOwnerReports(['ChIJrevoked00000000000000']);
  assert.deepEqual(out, {}, 'no live reading, so routes/crowd.js publishes the prediction');
});

test('a verified claim is still served — the clause refuses nothing legitimate', async () => {
  const row = {
    id: 1,
    google_place_id: 'ChIJverified0000000000000',
    busy_percent: 70,
    created_at: new Date(),
    diverged: false,
  };
  handlers = [[/FROM venue_owner_reports/, () => ({ rows: [row] })]];
  const out = await ownerReports.getLiveOwnerReports([row.google_place_id]);
  assert.equal(out[row.google_place_id]?.busy_percent, 70);
});
