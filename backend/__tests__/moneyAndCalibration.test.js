// Run: node --test  (from backend/)
//
// Two live bugs found by breaking the source and re-running the suite
// (mutation audit, 2026-08-14). Neither was covered by any of the 42 test
// files that existed at the time, which is the reason both shipped.
//
//   1. THE EQUAL BILL SPLIT. `splitType` defaults to 'equal' and nothing
//      asserted its share amounts at all. It divided in dollars and handed the
//      leftover out as `+ 0.01`, so $100.00 split three ways answered
//      33.339999999999996 while the DECIMAL(8,2) column stored 33.34 — the API
//      and the database disagreeing about what one person owes. The cent
//      totals were right, so no money moved; what broke was two friends being
//      able to read the same number off two screens.
//
//   2. THE CROWD CARD'S CALIBRATION. `buildCalibrationAdjustment` overwrites
//      the model's answer with user reports to produce the number on the card,
//      and no test in the suite referenced it. With no minimum-sample floor,
//      ONE report could move a public score by up to 12 points, and with no
//      per-user dedupe one account filing repeatedly counted as a crowd.
//
// Both halves are written to fail if the fix is reverted, and both dispatch on
// real behaviour: the billing assertions drive the real Express router and
// compare the JSON body against the parameters that reach the INSERT, and the
// calibration assertions call the real exported function with no stub in the
// path at all.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

process.env.JWT_SECRET = 'money-calibration-test-secret';
// Captured at module load by routes/crowd.js.
process.env.GOOGLE_PLACES_API_KEY = 'test-places-key';
process.env.WEATHER_API_KEY = 'test-weather-key';
delete process.env.PAYWALL_ENABLED;

// ---------------------------------------------------------------------------
// Scripted pg fake. Handlers are [regex, fn(params, sql)], matched in order.
// Unmatched queries reject, so a route that grows a query fails loudly instead
// of silently reading undefined; the crowd tests add an explicit catch-all.
// ---------------------------------------------------------------------------
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
  return Promise.reject(new Error(`unscripted query: ${String(sql).slice(0, 120)}`));
}

pool.query = (sql, params) => dispatch(sql, params);
pool.connect = async () => ({
  query: (sql, params) => {
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(sql)) {
      log.push({ sql: sql.trim(), params: null });
      return Promise.resolve({ rows: [] });
    }
    return dispatch(sql, params);
  },
  release: () => {},
});

// Collaborators are destructured at module load by the routers below, so every
// stub has to be installed before the require() calls.
const authMod = require('../middleware/auth');
let CURRENT_USER = { id: 1, name: 'Ava', role: 'user' };
authMod.authenticate = (req, _res, next) => { req.user = CURRENT_USER; next(); };

const pushMod = require('../services/pushHelper');
pushMod.pushIfOffline = async () => {};
pushMod.pushAlways = async () => {};

const weatherService = require('../services/weatherService');
weatherService.getWeather = async () => null;
weatherService.getForecast = async () => [];

// Google Places, faked. utcOffsetMinutes is null on purpose: with an offset the
// route re-derives the hour from the venue's wall clock, and these tests want
// the localHour/localDay they pass in.
const PLACE = {
  id: 'PLACE_CAL',
  displayName: { text: 'The Vault' },
  formattedAddress: '1 Main St',
  rating: 4.2,
  userRatingCount: 300,
  priceLevel: 'PRICE_LEVEL_MODERATE',
  types: ['bar'],
  location: { latitude: 39.74, longitude: -104.98 },
  currentOpeningHours: { openNow: true, periods: [] },
  utcOffsetMinutes: null,
};
const realFetch = global.fetch;
global.fetch = (url, opts) => {
  const u = String(url);
  if (u.startsWith('https://places.googleapis.com/')) {
    const id = decodeURIComponent(u.split('/places/')[1] || '').split('?')[0];
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({ ...PLACE, id: id || PLACE.id }),
    });
  }
  return realFetch(url, opts);
};
test.after(() => { global.fetch = realFetch; });

const crowdEngine = require('../services/crowdEngine');
const mlPredictor = require('../services/mlPredictor');
const {
  buildCalibrationAdjustment,
  MIN_CALIBRATION_REPORTERS,
  MAX_SINGLE_REPORT_LEVERAGE,
  CALIBRATION_MAX_AGE_MS,
  CROWD_LEVEL_TO_SCORE,
} = crowdEngine;

// predictBusyness / predictHourlyForecast are called through the module object,
// so they can be replaced after load. buildCalibrationAdjustment is NOT stubbed
// anywhere — it is the code under test, and routes/crowd.js destructured the
// real one at load.
let ENGINE_SCORE = 20;
mlPredictor.predictBusyness = async () => ({
  score: ENGINE_SCORE,
  label: crowdEngine.getLabel(ENGINE_SCORE),
  confidence: 60,
  factors: {},
  dataSourcesUsed: ['ml_model'],
  predictionMethod: 'ml',
  modelVersion: 'test',
});
mlPredictor.predictHourlyForecast = async (_v, _w, startHour, count) =>
  Array.from({ length: count || 12 }, (_, i) => {
    const h = ((startHour + i) % 24 + 24) % 24;
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return { hour: `${h12} ${h < 12 ? 'AM' : 'PM'}`, score: ENGINE_SCORE, label: 'Quiet' };
  });

const billingRouter = require('../routes/billing');
const crowdRouter = require('../routes/crowd');

const app = express();
app.use(express.json());
app.use('/api/billing', billingRouter);
app.use('/api/crowd', crowdRouter);

let base;
const server = http.createServer(app);
test.before(() => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => {
    base = `http://127.0.0.1:${server.address().port}`;
    resolve();
  });
}));
test.after(() => new Promise((resolve) => {
  server.close(() => resolve());
  pool.end?.().catch(() => {});
}));

test.beforeEach(() => {
  handlers = [];
  log = [];
  CURRENT_USER = { id: 1, name: 'Ava', role: 'user' };
  ENGINE_SCORE = 20;
});

async function call(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON body */ }
  return { status: res.status, body: json, text };
}

const inserts = (table) => log.filter((q) => q.sql.startsWith(`INSERT INTO ${table}`));

// ===========================================================================
// PART 1 — the equal bill split
// ===========================================================================

function membersOf(n) {
  return Array.from({ length: n }, (_, i) => ({ id: i + 1, name: `M${i + 1}` }));
}

function scriptBillCreate(members, { creatorId = 1 } = {}) {
  log = []; // the sweep below re-scripts per combination; each one starts clean
  handlers = [
    [/SELECT id FROM flock_members WHERE flock_id = \$1 AND user_id = \$2/, () => ({ rows: [{ id: 9 }] })],
    [/SELECT u\.id, u\.name FROM flock_members/, () => ({ rows: members })],
    [/FROM user_blocks/, () => ({ rows: [] })],
    [/SELECT name, creator_id FROM flocks/, () => ({ rows: [{ name: 'Dinner', creator_id: creatorId }] })],
    [/SELECT id FROM flocks WHERE id = \$1 FOR UPDATE/, () => ({ rows: [{ id: 42 }] })],
    [/SELECT id, paid_by FROM bill_splits/, () => ({ rows: [] })],
    [/SELECT user_id, .*FROM bill_split_shares/, () => ({ rows: [] })],
    [/INSERT INTO bill_splits/, () => ({ rows: [{ id: 7 }] })],
    [/DELETE FROM bill_split_shares/, () => ({ rows: [], rowCount: 0 })],
    [/INSERT INTO bill_split_shares/, () => ({ rows: [] })],
  ];
}

// DECIMAL(8,2) stores exactly two decimal places, so the number the API sends
// and the number the column keeps are the same value only when the API's value
// is already cent-exact. This is the property that failed: 33.339999999999996
// is not, and Postgres rounded it to 33.34 on the way in.
function isCentExact(amount) {
  return typeof amount === 'number'
    && Number.isFinite(amount)
    && Number(amount.toFixed(2)) === amount;
}

test('a $100 bill split three ways answers 33.34 / 33.33 / 33.33, not a float artifact', async () => {
  scriptBillCreate(membersOf(3));

  const res = await call('POST', '/api/billing/42/create', { totalAmount: 100 });

  assert.strictEqual(res.status, 201, res.text);
  const amounts = res.body.bill.shares.map((s) => s.amount);
  assert.deepStrictEqual(amounts, [33.34, 33.33, 33.33]);
  // Not just equal-when-rounded: the exact double the client receives. Before
  // the fix the first share was 33.339999999999996, which is a different
  // double, prints as itself in JSON, and is NOT what the column holds.
  assert.ok(!res.text.includes('33.3399'), `float artifact on the wire: ${res.text}`);
});

test('every equal-split share the API returns is the value the DECIMAL(8,2) column stores', async () => {
  // A sweep, because the artifact only appeared for about 23% of
  // (total, member count) pairs — a single hand-picked example is how this
  // survived 42 test files.
  const totals = [0.01, 0.03, 7, 10, 20.05, 33.33, 55.55, 99.99, 100, 123.45, 1000.01];
  const tips = [0, 18];

  for (const total of totals) {
    for (let n = 2; n <= 8; n++) {
      for (const tipPercent of tips) {
        scriptBillCreate(membersOf(n));
        const res = await call('POST', '/api/billing/42/create', { totalAmount: total, tipPercent });
        assert.strictEqual(res.status, 201, res.text);

        const label = `$${total} / ${n} @ ${tipPercent}%`;
        const shares = res.body.bill.shares;
        assert.strictEqual(shares.length, n, label);

        const written = inserts('bill_split_shares');
        assert.strictEqual(written.length, n, `${label}: one INSERT per member`);

        for (const share of shares) {
          assert.ok(isCentExact(share.amount), `${label}: ${share.amount} is not a whole number of cents`);
          // The row that went to the database carries the identical value, so
          // the 201 body and the column cannot disagree.
          const row = written.find((q) => q.params[1] === share.userId);
          assert.ok(row, `${label}: no INSERT for user ${share.userId}`);
          assert.strictEqual(row.params[2], share.amount, `${label}: response and INSERT disagree`);
        }

        // The shares add up to the billed total exactly, in cents.
        const totalCents = Math.round(res.body.bill.totalWithTip * 100);
        const sumCents = shares.reduce((a, s) => a + Math.round(s.amount * 100), 0);
        assert.strictEqual(sumCents, totalCents, `${label}: shares do not sum to the total`);

        // Nobody carries more than one leftover cent, and the leftover lands
        // on the first members in id order — deterministic, so re-creating the
        // same bill never moves the extra cent to a different person.
        const base = Math.floor(totalCents / n);
        const remainder = totalCents - base * n;
        const expected = shares.map((_, i) => (base + (i < remainder ? 1 : 0)) / 100);
        assert.deepStrictEqual(shares.map((s) => s.amount), expected, label);
      }
    }
  }
});

test('the members query orders the roster, so the leftover cent has a stable owner', async () => {
  scriptBillCreate(membersOf(3));
  await call('POST', '/api/billing/42/create', { totalAmount: 100 });

  const roster = log.find((q) => /SELECT u\.id, u\.name FROM flock_members/.test(q.sql));
  assert.ok(roster, 'the create path reads the roster');
  assert.match(roster.sql, /ORDER BY u\.id/, 'an unordered roster gives the extra cent to whoever Postgres returns first');
});

test('the push notification quotes the same amount the API and the column carry', async () => {
  // `You owe ... $${share.amount.toFixed(2)}` was the third rendering of one
  // debt. It only agrees with the other two when the share is cent-exact.
  scriptBillCreate(membersOf(3));
  const res = await call('POST', '/api/billing/42/create', { totalAmount: 100 });

  for (const share of res.body.bill.shares) {
    assert.strictEqual(Number(share.amount.toFixed(2)), share.amount);
  }
});

test('POST answers the bill at the precision the columns hold, so GET cannot disagree', async () => {
  // Found re-auditing the share fix: the same disease one level up.
  // total_amount is DECIMAL(8,2) and tip_percent is DECIMAL(4,1), and both
  // used to be echoed back at whatever precision the client sent. A tip of
  // 18.55% was stored as 18.6, so GET /:flockId recomputed totalWithTip from
  // 18.6 while the shares had been divided against 18.55 — the sheet stopped
  // adding up on refresh, with no edit in between.
  const cases = [
    { sent: { totalAmount: 33.333 }, total: 33.33, tip: 0 },
    { sent: { totalAmount: 100, tipPercent: 18.55 }, total: 100, tip: 18.6 },
    { sent: { totalAmount: 100.006, tipPercent: 7.04 }, total: 100.01, tip: 7 },
    { sent: { totalAmount: '90', tipPercent: '10' }, total: 90, tip: 10 },
  ];

  for (const c of cases) {
    scriptBillCreate(membersOf(3));
    const res = await call('POST', '/api/billing/42/create', c.sent);
    assert.strictEqual(res.status, 201, res.text);

    const bill = res.body.bill;
    const label = JSON.stringify(c.sent);
    assert.strictEqual(bill.totalAmount, c.total, label);
    assert.strictEqual(bill.tipPercent, c.tip, label);

    // The row carries the identical values...
    const row = inserts('bill_splits')[0];
    assert.strictEqual(row.params[1], c.total, label);
    assert.strictEqual(row.params[4], c.tip, label);

    // ...so GET's recomputation off those columns lands on the same total the
    // POST published, and the shares still add up to it.
    const asGetWouldCompute = Math.round(row.params[1] * (1 + row.params[4] / 100) * 100) / 100;
    assert.strictEqual(bill.totalWithTip, asGetWouldCompute, label);
    const sumCents = bill.shares.reduce((a, s) => a + Math.round(s.amount * 100), 0);
    assert.strictEqual(sumCents, Math.round(asGetWouldCompute * 100), label);
  }
});

test('the custom-share tolerance is two CENTS, and the absorbed cents land on the largest share', async () => {
  // The same mutation run reported that widening this tolerance from 2 cents
  // to 2 dollars broke nothing in the suite. A $2 gap on a bill is not a
  // rounding remainder, it is a bill that does not add up, and the payer eats
  // it silently.
  const within = [
    { shares: [50, 49.99], expect: [50.01, 49.99] }, // 1 cent short
    { shares: [50, 49.98], expect: [50.02, 49.98] }, // 2 cents short, the edge
    { shares: [50, 50.02], expect: [50, 50] },       // 2 cents over
  ];
  for (const c of within) {
    scriptBillCreate(membersOf(3));
    const res = await call('POST', '/api/billing/42/create', {
      totalAmount: 100,
      splitType: 'custom',
      customShares: [{ userId: 1, amount: c.shares[0] }, { userId: 2, amount: c.shares[1] }],
    });
    assert.strictEqual(res.status, 201, res.text);
    assert.deepStrictEqual(res.body.bill.shares.map((s) => s.amount), c.expect);
  }

  for (const bad of [[50, 49.97], [50, 48], [50, 52]]) {
    scriptBillCreate(membersOf(3));
    const res = await call('POST', '/api/billing/42/create', {
      totalAmount: 100,
      splitType: 'custom',
      customShares: [{ userId: 1, amount: bad[0] }, { userId: 2, amount: bad[1] }],
    });
    assert.strictEqual(res.status, 400, `${bad} should not add up to $100.00`);
    assert.strictEqual(inserts('bill_splits').length, 0);
  }
});

// ===========================================================================
// PART 2 — buildCalibrationAdjustment
//
// No mocks here at all: this is the real exported function, called directly.
// ===========================================================================

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-08-14T20:00:00Z');

// A verified report row, shaped like the ones routes/crowd.js selects.
function report(level, { userId = null, ageDays = 0 } = {}) {
  const row = { crowd_level: level, predicted_score: 50 };
  if (userId != null) row.user_id = userId;
  if (ageDays != null) row.created_at = new Date(NOW - ageDays * DAY);
  return row;
}

// Distinct reporters, one report each.
function reporters(levels, opts = {}) {
  return levels.map((lvl, i) => report(lvl, { userId: 500 + i, ...opts }));
}

const cal = (rows, engineScore) => buildCalibrationAdjustment(rows, engineScore, { now: NOW });

test('the crowd route uses this exact function, not a copy of it', () => {
  assert.strictEqual(mlPredictor.buildCalibrationAdjustment, buildCalibrationAdjustment);
});

test('no feedback leaves the model answer untouched', () => {
  for (const rows of [[], null, undefined]) {
    const r = buildCalibrationAdjustment(rows, 63);
    assert.strictEqual(r.adjustedScore, 63);
    assert.strictEqual(r.feedbackUsed, false);
    assert.strictEqual(r.reportCount, 0);
  }
});

test('one report cannot move the public number, at any score or level', () => {
  // The headline of the audit: at weight 0.15 across a 0-100 range, a single
  // tap moved the published score by up to 12 points. Reverting the floor
  // fails this at almost every engine score.
  for (let engine = 0; engine <= 100; engine += 5) {
    for (const level of [1, 2, 3]) {
      const r = cal([report(level, { userId: 501 })], engine);
      assert.strictEqual(r.adjustedScore, engine, `engine ${engine}, level ${level}`);
      assert.strictEqual(r.feedbackUsed, false);
      assert.strictEqual(r.reportCount, 1);
    }
  }
});

test('the worst single-report swing the old code allowed is now zero', () => {
  // engine 0 + one "packed" report was 0 -> 12 exactly: a Quiet venue
  // published as Not Busy on the strength of one stranger.
  assert.strictEqual(cal([report(3, { userId: 501 })], 0).adjustedScore, 0);
  assert.strictEqual(cal([report(1, { userId: 501 })], 100).adjustedScore, 100);
});

test('two reporters are still below the floor; three are the floor', () => {
  assert.strictEqual(MIN_CALIBRATION_REPORTERS, 3);

  const two = cal(reporters([3, 3]), 20);
  assert.strictEqual(two.adjustedScore, 20);
  assert.strictEqual(two.feedbackUsed, false);
  assert.strictEqual(two.reportCount, 2);
  assert.strictEqual(two.minReports, 3);

  const three = cal(reporters([3, 3, 3]), 20);
  assert.strictEqual(three.feedbackUsed, true);
  assert.strictEqual(three.reportCount, 3);
  assert.ok(three.adjustedScore > 20, 'the floor is a floor, not a wall');
  // weight is capped at MAX_SINGLE_REPORT_LEVERAGE * n / span = 0.25 here,
  // so 20 blended a quarter of the way to 80.
  assert.strictEqual(three.adjustedScore, 35);
});

test('one account reporting six times is one reporter, not a crowd', () => {
  // Without dedupe this is six voices: it clears the floor by itself and
  // climbs the weight ladder, which is exactly how one determined account
  // steers a venue's public score.
  const spam = Array.from({ length: 6 }, () => report(3, { userId: 777 }));
  const r = cal(spam, 20);
  assert.strictEqual(r.reportCount, 1);
  assert.strictEqual(r.feedbackUsed, false);
  assert.strictEqual(r.adjustedScore, 20);

  // And it cannot pad a real crowd either: two genuine reporters plus five
  // rows from one account is three reporters, not seven.
  const padded = [...reporters([1, 1]), ...Array.from({ length: 5 }, () => report(3, { userId: 777 }))];
  const p = cal(padded, 20);
  assert.strictEqual(p.reportCount, 3);
  assert.strictEqual(p.feedbackWeight, 0.25, 'seven rows must not buy the seven-report weight');
});

test('an account that revises its report is counted at its newest one', () => {
  const rows = [
    report(1, { userId: 777, ageDays: 3 }),
    report(3, { userId: 777, ageDays: 10 }),
    ...reporters([1, 1]),
  ];
  const r = cal(rows, 50);
  assert.strictEqual(r.reportCount, 3);
  // Three level-1 opinions -> 20, not (20 + 20 + 80) / 3.
  assert.strictEqual(r.avgFeedbackScore, 20);
});

test('reports older than the recency window do not vote', () => {
  const stale = reporters([3, 3, 3], { ageDays: 40 });
  const r = cal(stale, 20);
  assert.strictEqual(r.reportCount, 0);
  assert.strictEqual(r.feedbackUsed, false);
  assert.strictEqual(r.adjustedScore, 20);

  // Just inside the window still counts.
  const days = Math.floor(CALIBRATION_MAX_AGE_MS / DAY) - 1;
  const fresh = cal(reporters([3, 3, 3], { ageDays: days }), 20);
  assert.strictEqual(fresh.feedbackUsed, true);

  // A single old holdout cannot be padded into a quorum by two fresh ones and
  // is simply dropped.
  const mixed = cal([
    report(3, { userId: 601, ageDays: 400 }),
    report(3, { userId: 602, ageDays: 1 }),
    report(3, { userId: 603, ageDays: 1 }),
  ], 20);
  assert.strictEqual(mixed.reportCount, 2);
  assert.strictEqual(mixed.feedbackUsed, false);
});

test('rows with no timestamp are still counted, so the SQL can stay as it is', () => {
  // routes/crowd.js does not select created_at today. The age filter must
  // degrade to "keep it" rather than switching calibration off in production.
  const rows = [1, 2, 3].map((i) => ({ crowd_level: 3, user_id: 600 + i }));
  const r = cal(rows, 20);
  assert.strictEqual(r.feedbackUsed, true);
  assert.strictEqual(r.reportCount, 3);
});

test('no single report can move the score by more than the coin-flip margin', () => {
  // The bound the weight cap exists to guarantee, checked by flipping one
  // reporter from the quietest reading to the busiest across the whole range
  // of crowd sizes. One point of slack for the final rounding.
  assert.strictEqual(MAX_SINGLE_REPORT_LEVERAGE, 5);

  for (let n = MIN_CALIBRATION_REPORTERS; n <= 40; n++) {
    for (let engine = 0; engine <= 100; engine += 10) {
      for (const rest of [1, 2, 3]) {
        const levels = Array.from({ length: n }, () => rest);
        const quiet = cal(reporters([1, ...levels.slice(1)]), engine);
        const busy = cal(reporters([3, ...levels.slice(1)]), engine);
        const delta = Math.abs(busy.adjustedScore - quiet.adjustedScore);
        assert.ok(
          delta <= MAX_SINGLE_REPORT_LEVERAGE + 1,
          `n=${n} engine=${engine} rest=${rest}: one report moved the score ${delta} points`
        );
      }
    }
  }
});

test('a real crowd still overrides the model', () => {
  // The floor must not have turned calibration into decoration: 25 verified
  // reporters saying "packed" against a model saying "quiet" wins decisively.
  const many = reporters(Array.from({ length: 25 }, () => 3));
  const r = cal(many, 20);
  assert.strictEqual(r.feedbackUsed, true);
  assert.strictEqual(r.reportCount, 25);
  assert.strictEqual(r.feedbackWeight, 0.75);
  assert.strictEqual(r.adjustedScore, 65);
  assert.strictEqual(r.predictionDrift, 60);
});

test('an unreadable crowd_level is dropped, not scored as Moderate', () => {
  // It used to fall back to 50, manufacturing an opinion nobody expressed and
  // then giving it a vote toward the floor.
  const junk = [null, 'nope', { crowd_level: 9, user_id: 1 }, { crowd_level: null, user_id: 2 }, { user_id: 3 }];
  const r = cal(junk, 80);
  assert.strictEqual(r.reportCount, 0);
  assert.strictEqual(r.adjustedScore, 80);

  // Mixed in with real reports, the junk neither votes nor pads the count.
  const mixed = cal([...junk, ...reporters([1, 1])], 80);
  assert.strictEqual(mixed.reportCount, 2);
  assert.strictEqual(mixed.feedbackUsed, false);
});

test('the adjusted score stays inside 0-100 and never goes NaN', () => {
  assert.ok(cal(reporters([1, 1, 1, 1]), 0).adjustedScore >= 0);
  assert.ok(cal(reporters([3, 3, 3, 3]), 100).adjustedScore <= 100);
  // A score that is not a number is handed straight back rather than blended
  // into NaN and published.
  // null and '' are the dangerous ones: Number() turns both into 0, so a
  // missing score would be blended as though the model had answered "empty".
  for (const bad of [undefined, null, NaN, '', ' ', 'busy', {}, true]) {
    const r = buildCalibrationAdjustment(reporters([3, 3, 3]), bad, { now: NOW });
    assert.strictEqual(r.feedbackUsed, false);
    // Handed back exactly as it came in — never blended, never turned into a
    // plausible-looking number the card would print.
    assert.ok(Object.is(r.adjustedScore, bad), `${String(bad)} was not passed through`);
  }
  // A numeric string still calibrates: 55 a quarter of the way to 80.
  assert.strictEqual(buildCalibrationAdjustment(reporters([3, 3, 3]), '55', { now: NOW }).adjustedScore, 61);
  assert.ok(!Number.isNaN(cal(reporters([3, 3, 3]), 50).adjustedScore));
});

test('the level-to-score map is the one the leverage bound is derived from', () => {
  // MAX_SINGLE_REPORT_LEVERAGE is enforced against a span of 60. Widening the
  // map without revisiting the cap would quietly widen what one report can do.
  assert.deepStrictEqual(CROWD_LEVEL_TO_SCORE, { 1: 20, 2: 50, 3: 80 });
});

// ===========================================================================
// PART 3 — the floor reaches the wire
//
// The number the client renders is `calibration.adjustedScore`, so the floor
// only matters if it survives the route. These drive the real crowd router;
// the model score is an input (stubbed), the calibration is the real thing.
// ===========================================================================

function scriptCrowd(feedbackRows) {
  handlers = [
    [/FROM venue_feedback/, () => ({ rows: feedbackRows })],
    [/[\s\S]*/, () => ({ rows: [] })],
  ];
}

test('one report does not move the score the crowd card publishes', async () => {
  ENGINE_SCORE = 20;
  scriptCrowd([report(3, { userId: 501 })]);

  const res = await call('GET', '/api/crowd/PLACE_ONE_REPORT?localHour=20&localDay=5');

  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(res.body.rawEngineScore, 20);
  assert.strictEqual(res.body.score, 20, 'one tap must not move the published number');
  assert.strictEqual(res.body.calibration.feedbackUsed, false);
  // And the confidence boost that rides on feedbackUsed does not fire either.
  assert.strictEqual(res.body.confidence, 60);
  assert.ok(!res.body.dataSourcesUsed.includes('user_feedback'));

  // The reports it read were the presence-verified ones. Everything above is
  // downstream of that filter.
  const fb = log.find((q) => /FROM venue_feedback/.test(q.sql));
  assert.match(fb.sql, /verified = true/);
});

test('three verified reporters do move it, by the capped amount', async () => {
  ENGINE_SCORE = 20;
  scriptCrowd(reporters([3, 3, 3]));

  const res = await call('GET', '/api/crowd/PLACE_THREE_REPORTS?localHour=20&localDay=5');

  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(res.body.rawEngineScore, 20);
  assert.strictEqual(res.body.score, 35);
  assert.strictEqual(res.body.calibration.feedbackUsed, true);
  assert.strictEqual(res.body.calibration.reportCount, 3);
  assert.ok(res.body.dataSourcesUsed.includes('user_feedback'));
  // The label the card prints follows the calibrated score, not the raw one.
  assert.strictEqual(res.body.label, crowdEngine.getLabel(35));
});

test('one account filing three times does not move the card', async () => {
  ENGINE_SCORE = 20;
  scriptCrowd([
    report(3, { userId: 777 }),
    report(3, { userId: 777 }),
    report(3, { userId: 777 }),
  ]);

  const res = await call('GET', '/api/crowd/PLACE_SYBIL?localHour=20&localDay=5');

  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(res.body.score, 20);
  assert.strictEqual(res.body.calibration.feedbackUsed, false);
  assert.strictEqual(res.body.calibration.reportCount, 1);
});
