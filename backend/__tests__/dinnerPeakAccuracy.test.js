// Run: node --test  (from backend/)
//
// "Kome showed roughly 20% at 6 PM." A well-known restaurant, at the single
// hour everybody knows it is full. Crowd forecasting is the product's
// differentiator, so a number that visibly wrong on a venue the user knows does
// not cost one card — it costs the feature.
//
// This file is the investigation, kept as tests so the conclusions cannot rot.
// Four things are pinned, in the order they were found:
//
//   PART 1  The rule engine cannot produce ~20 at 6 PM for a venue like this.
//           Whatever the user saw, it was not the category curve answering at
//           the venue's dinner hour. This bounds the search.
//
//   PART 2  The clock is not the culprit on the paths the app actually uses.
//           A 6 PM Atlanta request scores hour 18 on the card and in the batch,
//           with or without Google's utcOffsetMinutes, on a UTC server. What
//           IS still open is the last-resort fallback, and this part pins
//           exactly how far it can be wrong and what the payload says about it.
//
//   PART 3  THE CAUSE, AND ITS END. The ML corpus's `hour` column held
//           BestTime's day_raw ARRAY INDEX, and BestTime's day starts at
//           06:00 — so stored slot 18 held the venue's MIDNIGHT.
//           ml_venue_baselines inherited it verbatim, and this is a delta
//           model, so that baseline IS the answer: a 6 PM request read the
//           venue's overnight number. Migration 023 (2026-08-15) moved the
//           corpus onto the venue clock; the retrain that exported
//           v2.6.0-swift (2026-08-18) moved the ARTIFACT, so
//           model_metadata.json's category_baselines are venue-local too.
//           PART 3 was inverted on that date: it now pins that the stored
//           peaks are already evening peaks, and that adding the old six
//           hours makes them worse. Same arithmetic on the artifact itself,
//           read in the other direction.
//
//   PART 4  THE HONESTY FIX THAT SHIPPED FIRST. The model-side fix is a
//           retrain (the data fix has since shipped; see the note above
//           getBaseline in services/mlPredictor.js). This is the honesty half:
//           for a venue with no baseline and no verified reports — which is
//           nearly every venue a real user searches, since the corpus is 34
//           seed cities — the answer is a hand-written CATEGORY curve, and the
//           card must say so rather than publish it as a measurement.
//
// NOTHING IN crowdEngine's SCORING WAS RETUNED. No threshold moved, no category
// curve changed, and Kome does not read higher than it did. The scores below
// are the same scores the engine produced before this change; what changed is
// what the payload is allowed to claim about them.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');
const path = require('node:path');

process.env.TZ = 'UTC'; // Railway. The whole point of the venue-clock work.
process.env.JWT_SECRET = 'dinner-peak-accuracy-secret';
process.env.GOOGLE_PLACES_API_KEY = 'test-places-key';
process.env.WEATHER_API_KEY = 'test-weather-key';
delete process.env.PAYWALL_ENABLED;

const crowdEngine = require('../services/crowdEngine');
const { calculateCrowdScore, describePredictionSupport, publishedConfidence,
  publishedLabel, hedgeLabel, getLabel, TIME_ONLY_CONFIDENCE } = crowdEngine;

// ===========================================================================
// PART 1 — the rule engine's 6 PM floor
// ===========================================================================

// A Kome-shaped venue: a well-reviewed, mid-priced Japanese/sushi restaurant.
// Google's real type array for such a place, tail types included.
const KOME_TYPES = ['japanese_restaurant', 'sushi_restaurant', 'restaurant',
  'food', 'point_of_interest', 'establishment'];
const KOME = {
  place_id: 'ChIJkome_test',
  name: 'Kome',
  types: KOME_TYPES,
  rating: 4.5,
  user_ratings_total: 1500,
  price_level: 2,
  location: { latitude: 33.9, longitude: -84.3 }, // Atlanta
};
const CLEAR_EVENING = { temp: 78, humidity: 55, windSpeed: 5, isRaining: false, conditionId: 800 };

// 2026-08-09 is a Sunday, so +day lands on weekday `day`.
function at(day, hour) {
  const d = new Date(2026, 7, 9 + day);
  d.setHours(hour, 0, 0, 0);
  assert.equal(d.getDay(), day, 'fixture clock built the wrong weekday');
  return d;
}

test('a dinner venue at 6 PM cannot score like a dead hour, on any day', () => {
  // The reported number was ~20. If the category curve could produce that at
  // 18:00 the bug would be in the curve; it cannot, which is what sent the
  // investigation to the clock and then to the corpus.
  for (let day = 0; day < 7; day++) {
    const score = calculateCrowdScore(KOME, CLEAR_EVENING, at(day, 18)).score;
    assert.ok(score >= 60,
      `day ${day} 18:00 scored ${score}; a well-reviewed restaurant at dinner must not read like a dead hour`);
  }
  // And Friday dinner specifically is a peak, not a shoulder.
  assert.ok(calculateCrowdScore(KOME, CLEAR_EVENING, at(5, 18)).score >= 80);
});

test('the scores near 20 all live in the small hours — which is where a 6 PM reading of 20 came from', () => {
  const byHour = [];
  for (let h = 0; h < 24; h++) byHour.push(calculateCrowdScore(KOME, CLEAR_EVENING, at(5, h)).score);
  const quiet = byHour.map((s, h) => [h, s]).filter(([, s]) => s <= 35).map(([h]) => h);
  assert.ok(quiet.length > 0, 'this venue has no quiet hours at all — fixture is wrong');
  for (const h of quiet) {
    assert.ok(h <= 11,
      `hour ${h} scored ${byHour[h]}; the curve should only go that quiet before noon`);
  }
  // The specific arithmetic behind PART 3: 18:00 is a peak, and the slot the
  // corpus actually stores under key 18 is the venue's midnight.
  assert.ok(byHour[18] - byHour[0] >= 50,
    'dinner and midnight must be far apart, or reading the wrong slot would not show');
});

test('no restaurant-ish category reads like the small hours at 6 PM', () => {
  // Ruling out the third hypothesis: a sushi place landing in a non-dinner
  // curve. Google can type a restaurant several ways at once and the ladder
  // dispatches on the whole array, so this sweeps the plausible landings.
  const landings = {
    sushi: ['sushi_restaurant', 'japanese_restaurant', 'restaurant'],
    japanese_only: ['japanese_restaurant'],
    generic: ['restaurant'],
    with_bar: ['japanese_restaurant', 'bar', 'restaurant'],
    with_cafe: ['cafe', 'restaurant'],
    with_bakery: ['bakery', 'restaurant'],
    with_takeaway: ['restaurant', 'meal_takeaway'],
    barbecue: ['barbecue_restaurant', 'restaurant'],
    fine: ['japanese_restaurant', 'restaurant'],
    untyped: [],
  };
  for (const [name, types] of Object.entries(landings)) {
    const score = calculateCrowdScore({ ...KOME, types }, CLEAR_EVENING, at(5, 18)).score;
    assert.ok(score >= 50,
      `${name} scored ${score} at Friday 6 PM; no landing for a popular restaurant should read that low at dinner`);
  }
});

// ===========================================================================
// PART 2 — the clock, end to end, through the real routes
// ===========================================================================

const pool = require('../config/database');
let FEEDBACK_ROWS = [];
pool.query = async (sql) => {
  if (!/FROM venue_feedback/.test(String(sql))) return { rows: [], rowCount: 0 };
  return { rows: FEEDBACK_ROWS, rowCount: FEEDBACK_ROWS.length };
};

require('../middleware/auth').authenticate = (req, _res, next) => {
  req.user = { id: 7, name: 'Ava', role: 'user' };
  next();
};

const weatherService = require('../services/weatherService');
weatherService.getWeather = async () => CLEAR_EVENING;
weatherService.getForecast = async () => [];

// Friday 2026-08-14 22:00Z is 6:00 PM in Atlanta (UTC-4). Frozen, because the
// whole question is which hour got scored.
const FROZEN = Date.parse('2026-08-14T22:00:00Z');
const RealDate = Date;
class FrozenDate extends RealDate {
  constructor(...args) { if (args.length === 0) super(FROZEN); else super(...args); }
  static now() { return FROZEN; }
}

let GOOGLE_OFFSET = -240; // Atlanta, EDT. `null` = Google gave us none.
const realFetch = global.fetch;
global.fetch = async (url, opts) => {
  const u = String(url);
  if (u.startsWith('https://places.googleapis.com/')) {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        id: 'ChIJkome_test',
        displayName: { text: 'Kome' },
        formattedAddress: '3980 Buford Hwy NE, Atlanta, GA',
        rating: 4.5,
        userRatingCount: 1500,
        priceLevel: 'PRICE_LEVEL_MODERATE',
        types: KOME_TYPES,
        location: { latitude: 33.9, longitude: -84.3 },
        currentOpeningHours: {
          openNow: true,
          periods: [0, 1, 2, 3, 4, 5, 6].map((d) => ({
            open: { day: d, hour: 11, minute: 30 },
            close: { day: d, hour: 22, minute: 0 },
          })),
        },
        ...(GOOGLE_OFFSET === null ? {} : { utcOffsetMinutes: GOOGLE_OFFSET }),
      }),
    };
  }
  if (u.includes('ticketmaster')) return { ok: true, status: 200, json: async () => ({}) };
  return realFetch(url, opts);
};

const crowdRouter = require('../routes/crowd');
const app = express();
app.use(express.json());
app.use('/api/crowd', crowdRouter);

let base;
const server = http.createServer(app);
test.before(() => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); });
}));
test.after(() => new Promise((resolve) => {
  global.fetch = realFetch;
  global.Date = RealDate;
  server.close(() => resolve());
  pool.end?.().catch(() => {});
}));
test.beforeEach(() => { FEEDBACK_ROWS = []; GOOGLE_OFFSET = -240; global.Date = FrozenDate; });
test.afterEach(() => { global.Date = RealDate; });

// Cache-busting ids: routes/crowd.js memoises per (placeId, caller hour, day)
// for ten minutes and the clock is frozen, so every case needs its own id.
let idSeq = 0;
const freshId = (tag) => `ChIJkome${tag}${idSeq++}`;

async function card(query = 'localHour=18&localDay=5', tag = 'card') {
  const res = await realFetch(`${base}/api/crowd/${freshId(tag)}${query ? `?${query}` : ''}`);
  return { status: res.status, body: await res.json() };
}

function batchVenue(extra = {}) {
  return {
    place_id: freshId('batch'),
    name: 'Kome',
    rating: 4.5,
    user_ratings_total: 1500,
    price_level: 2,
    types: KOME_TYPES,
    location: { latitude: 33.9, longitude: -84.3 },
    ...extra,
  };
}

async function batch(venues, body = {}) {
  const res = await realFetch(`${base}/api/crowd/batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ venues, ...body }),
  });
  return { status: res.status, body: await res.json() };
}

test('6 PM in Atlanta is scored as hour 18 on the card, on a UTC server', () => {
  // 22:00Z. Score the server's own hour and this venue reads its late-evening
  // number at dinner; that is the shape of the reported bug and it is NOT what
  // happens here.
  return card('localHour=18&localDay=5').then(({ body }) => {
    assert.equal(body.venueClock.hour, 18);
    assert.equal(body.venueClock.day, 5);
    assert.equal(body.venueClock.local, true);
    assert.equal(body.hourly[0].hour, '6 PM');
    assert.ok(body.score >= 80, `6 PM Friday scored ${body.score}`);
  });
});

test('the batch list scores 6 PM too, and agrees with the card it sits under', async () => {
  const { body } = await batch([batchVenue({ utcOffsetMinutes: -240 })]);
  const row = body.predictions[0];
  assert.equal(row.venueClock.hour, 18);
  assert.equal(row.venueClock.local, true);
  const c = await card('localHour=18&localDay=5');
  assert.equal(row.score, c.body.score, 'the list row and the card must be one answer');
  assert.equal(row.label, c.body.label);
});

test('with no offset from Google the caller\'s asserted hour still lands on 18', async () => {
  GOOGLE_OFFSET = null;
  const { body } = await card('localHour=18&localDay=5');
  assert.equal(body.venueClock.hour, 18);
  assert.equal(body.venueClock.local, false, 'no offset must be admitted, not papered over');
  assert.ok(body.score >= 80);
});

test('no offset AND no asserted hour is the server\'s UTC clock — and the payload admits it', async () => {
  // The one surviving hour hazard. Nothing the shipping client does reaches it
  // (services/api.js always sends localHour), but a deep link, a future client
  // or a replayed request would, and then a 6 PM venue is scored at 22:00.
  GOOGLE_OFFSET = null;
  const { body } = await card('', 'noclock');
  assert.equal(body.venueClock.hour, 22, 'this is the UTC fallback; if it changes, so did the contract');
  assert.equal(body.venueClock.local, false);
  // It must never be dressed up as a measured answer.
  assert.equal(body.supported, false);
  assert.equal(body.confidenceBasis, 'category_pattern');
});

test('other zones and other peak hours land on their own wall clock, not the server\'s', async () => {
  // Adversarial sweep: at the frozen instant (22:00Z) each offset puts the
  // venue at a different hour, and each must be the hour scored.
  const zones = [
    { name: 'Los Angeles', offset: -420, hour: 15 },
    { name: 'Atlanta', offset: -240, hour: 18 },
    { name: 'UTC', offset: 0, hour: 22 },
    { name: 'Berlin', offset: 120, hour: 0 },
    { name: 'Mumbai', offset: 330, hour: 3 },
    { name: 'Tokyo', offset: 540, hour: 7 },
  ];
  for (const z of zones) {
    const { body } = await batch([batchVenue({ utcOffsetMinutes: z.offset })]);
    const row = body.predictions[0];
    assert.equal(row.venueClock.hour, z.hour, `${z.name} scored at ${row.venueClock.hour}, expected ${z.hour}`);
    assert.equal(row.venueClock.local, true);
  }
  // A venue with no timezone record at all falls back and says so.
  const { body } = await batch([batchVenue()], { localHour: 20, localDay: 5 });
  assert.equal(body.predictions[0].venueClock.local, false);
  assert.equal(body.predictions[0].venueClock.hour, 20);
});

// ===========================================================================
// PART 3 — THE CAUSE, AND THE PROOF IT IS GONE. The hour axis was six hours
// off. Migration 023 fixed the CORPUS on 2026-08-15; the ARTIFACT was fixed by
// the retrain that exported v2.6.0-swift on 2026-08-18 from the corrected
// corpus. Every assertion below was INVERTED on that date — see the note on
// each one for what it used to say and why the flip is the pass condition.
// ===========================================================================

// Pre-fix, collectWeekly.js wrote BestTime's day_raw ARRAY INDEX as the hour;
// day_raw runs 06:00-05:59, so the index was not the hour. (It now writes
// (index + 6) % 24 and declares hour_axis = 'venue_local'.) The constant is
// kept because the *disproof* still needs it: the way to show the artifact is
// no longer on the bucket axis is to add six and watch the peaks get WORSE.
const BESTTIME_DAY_STARTS_AT = 6;

function metadata() {
  return require(path.join(__dirname, '..', 'scripts', 'ml', 'models', 'model_metadata.json'));
}

function peakSlotFor(cb, cat, day) {
  let slot = null;
  let val = -1;
  for (let h = 0; h < 24; h++) {
    const v = cb[`${cat}_${day}_${h}`];
    if (v != null && v > val) { val = v; slot = h; }
  }
  return slot;
}

test('the shipped artifact is on the venue-local clock — the retrain reached the weights', () => {
  // WAS: 'the shipped artifact is on a BestTime bucket axis'. It asserted that
  // the stored peaks only made sense once you ADDED six hours, because
  // model_metadata.json's category_baselines were derived from the pre-023
  // corpus. v2.6.0-swift was exported from the corrected corpus, so the stored
  // slots ARE venue-local hours and the shift is no longer needed. Read
  // literally the old curves said restaurants peak at lunchtime and nightclubs
  // at 5 PM; they now say restaurants peak at 19:00 and nightclubs at 23:00.
  const cb = metadata().category_baselines || {};
  assert.ok(Object.keys(cb).length > 0, 'no category_baselines in metadata — this proof needs them');

  const categories = [...new Set(Object.keys(cb).map((k) => k.replace(/_\d+_\d+$/, '')))];
  let daytimeAsStored = 0;
  let daytimeAfterShift = 0;
  let total = 0;

  for (const cat of categories) {
    for (let day = 0; day < 7; day++) {
      const peakSlot = peakSlotFor(cb, cat, day);
      if (peakSlot == null) continue;
      total++;
      if (peakSlot >= 12 && peakSlot <= 23) daytimeAsStored++;
      const shifted = (peakSlot + BESTTIME_DAY_STARTS_AT) % 24;
      if (shifted >= 12 && shifted <= 23) daytimeAfterShift++;
    }
  }

  assert.ok(total >= 80, `only ${total} (category, day) curves to test`);
  // The direction that used to hold, now inverted: the slots are already the
  // venue's afternoon and evening with NO correction applied.
  assert.ok(daytimeAsStored / total > 0.9,
    `only ${daytimeAsStored}/${total} peaks land in local 12:00-23:00 as stored; `
    + 'if this has dropped, the artifact was exported from an uncorrected corpus again — '
    + 'check ml_training_data.hour_axis and migration 023 before trusting any prediction');
  // And the disproof: adding six now makes it worse, not better. On the bucket
  // axis this ratio was above 0.9; a corrected artifact must fail it.
  assert.ok(daytimeAfterShift / total < daytimeAsStored / total,
    `adding ${BESTTIME_DAY_STARTS_AT}h still improves the peaks `
    + `(${daytimeAfterShift}/${total} shifted vs ${daytimeAsStored}/${total} stored) — `
    + 'that is the signature of the pre-fix bucket axis, so the artifact is stale');
});

test('the night categories peak in the evening as stored, and the old shift would ruin it', () => {
  // WAS: 'the night categories peak in the evening ONLY AFTER the shift'. It
  // required the stored Friday peak to be < 18 and to land in 18-23 once six
  // hours were added. Both halves now flip: the stored slot IS the evening.
  const cb = metadata().category_baselines || {};
  // Friday. A bar, a brewery and a nightclub cannot peak before dark.
  for (const cat of ['bar', 'brewery', 'nightclub', 'restaurant']) {
    const slot = peakSlotFor(cb, cat, 5);
    if (slot == null) continue;
    assert.ok(slot >= 18 && slot <= 23,
      `${cat} peaks at stored slot ${slot}; on the venue-local axis a Friday night `
      + 'category must peak between 18:00 and 23:00. A peak around midday is the '
      + 'pre-fix BestTime bucket axis coming back.');
    // The pre-fix reading of the same number is now nonsense, which is the point.
    const shifted = (slot + BESTTIME_DAY_STARTS_AT) % 24;
    assert.ok(shifted < 18,
      `${cat}: adding ${BESTTIME_DAY_STARTS_AT}h gives local ${shifted}, still an evening hour — `
      + 'the artifact may not have been rebuilt from the corrected corpus');
  }
});

test("a 6 PM lookup now reads the venue's 6 PM slot, not its midnight", () => {
  // WAS: 'a 6 PM lookup on that axis reads the venue late-evening slot',
  // asserting cb['restaurant_5_18'] < cb['restaurant_5_12'] because slot 18
  // held midnight (18 + 6 = 24) while slot 12 held the true 6 PM. Both sides
  // of that inequality swap on the corrected axis: slot 18 IS 18:00 and is the
  // busy one; slot 12 is lunchtime and is quieter. This model is still
  // `label_type: 'delta'`, so score = baseline + clamp(delta, +/-30) and the
  // baseline IS the answer — which is why this arithmetic is worth pinning.
  const meta = metadata();
  assert.equal(meta.label_type, 'delta',
    'the model is no longer a delta model — re-derive how much the baseline slot matters before trusting this test');

  const cb = meta.category_baselines || {};
  const at6pm = cb['restaurant_5_18'];   // slot 18 = 18:00 on the venue clock
  const atNoon = cb['restaurant_5_12'];  // slot 12 = 12:00, the lunch shoulder
  const atMidnight = cb['restaurant_5_0'];
  assert.ok(Number.isFinite(at6pm) && Number.isFinite(atNoon));
  assert.ok(at6pm > atNoon,
    `slot 18 (${at6pm}) should be busier than the lunch slot (${atNoon}) for a Friday restaurant`);
  if (Number.isFinite(atMidnight)) {
    assert.ok(at6pm > atMidnight,
      `slot 18 (${at6pm}) should be busier than midnight (${atMidnight}); if it is not, `
      + 'slot 18 is still holding the overnight number and the axis is bent');
  }
});

// ===========================================================================
// PART 4 — what shipped: an unobserved number is not published as a measurement
// ===========================================================================

test('the corpus covers 34 seed cities, so a real user\'s venue has no baseline', () => {
  const { CITIES } = require('../scripts/ml/config');
  const names = Object.values(CITIES).map((c) => c.name.toLowerCase());
  assert.ok(names.length >= 30, 'city list shrank unexpectedly');
  assert.ok(!names.includes('atlanta'),
    'Atlanta is in the corpus now — re-check whether Kome has a baseline row before trusting the fallback story');
  // ml_venue_baselines is written only from that corpus
  // (scripts/ml/buildBaselines.js, scripts/ml/collectRealtime.js) and no route
  // supplies popular_times (pinned in __tests__/predictorCorrectness.test.js),
  // so an off-corpus venue reaches the delta guard with baseline 0 every time.
});

test('a venue with no baseline is served the category curve, and the payload says so', async () => {
  const { body } = await card('localHour=18&localDay=5', 'unsupported');
  assert.equal(body.predictionMethod, 'rule_engine_no_baseline',
    'the trained model must not be claimed for a venue it refused to score');
  assert.equal(body.confidenceBasis, 'category_pattern');
  assert.equal(body.supported, false);
  assert.equal(body.modelVersion, null);
});

test('an unobserved answer is hedged, not asserted', async () => {
  const { body } = await card('localHour=18&localDay=5', 'hedge');
  // The band is still the band — nothing was retuned — but it is stated as what
  // it is: what this kind of venue is usually like at this hour.
  assert.equal(body.label, hedgeLabel(getLabel(body.score)));
  assert.match(body.label, /^Usually /);
  assert.notEqual(body.label, getLabel(body.score));
});

test('an unobserved answer does not pass its confidence off as an accuracy', async () => {
  const { body } = await card('localHour=18&localDay=5', 'conf');
  // This card publishes 76 for a venue nobody has ever counted heads in:
  // twenty for "we know what time it is" plus fifty-six for how richly GOOGLE
  // describes the place — review count, rating precision, type count, price
  // level, weather. Not one of those is an observation of how full the room is,
  // so the field is completeness, not accuracy, and now says so.
  assert.equal(body.confidenceMeans, 'input_completeness');
  assert.notEqual(body.confidenceMeans, 'measured_accuracy');
  assert.ok(body.confidence > TIME_ONLY_CONFIDENCE,
    'the number itself is deliberately untouched — capping it would invent a second unmeasured figure');
  // And the raw engine number is still there for anything that wants it.
  assert.equal(typeof body.rawEngineScore, 'number');
});

test('the score itself was not touched — this is an honesty fix, not a retune', async () => {
  const { body } = await card('localHour=18&localDay=5', 'score');
  const direct = calculateCrowdScore(
    { ...KOME, place_id: body.placeId },
    CLEAR_EVENING,
    at(5, 18)
  ).score;
  assert.equal(body.score, direct,
    'the published score must still be exactly what the engine computed; nothing here nudges a venue upward');
});

test('verified reporters are evidence, and lift the hedge', () => {
  // Three distinct verified reporters in this venue's own weekly bucket is a
  // real observation of this building, so the answer stops being a bare prior.
  const none = describePredictionSupport('rule_engine_no_baseline', 0);
  assert.equal(none.basis, 'category_pattern');
  assert.equal(none.supported, false);

  const two = describePredictionSupport('rule_engine_no_baseline', 2);
  assert.equal(two.supported, false, 'below the floor, reports have no influence and so are no evidence');

  const three = describePredictionSupport('rule_engine_no_baseline', crowdEngine.MIN_CALIBRATION_REPORTERS);
  assert.equal(three.basis, 'user_reports');
  assert.equal(three.supported, true);
  assert.equal(publishedLabel(85, three), 'Very Busy', 'an observed venue states its band');
  // Reports still do not turn the confidence ladder into an accuracy figure.
  assert.equal(three.confidenceMeans, 'input_completeness');
  assert.ok(publishedConfidence(60, three, 9) > publishedConfidence(60, three, 0),
    'the boost real reporters earn reaches the wire');
});

test('real reporters outrank a model whose weights predate the axis fix', () => {
  // Ordering pin. Checking the model first silently downgraded exactly the
  // venues that DO have verified reports — the one part of this system that
  // works end to end — because the unverified-axis branch swallowed them.
  const observed = describePredictionSupport('ml', crowdEngine.MIN_CALIBRATION_REPORTERS);
  assert.equal(observed.basis, 'user_reports');
  assert.equal(observed.supported, true);
  assert.equal(publishedLabel(35, observed), getLabel(35));

  const unobserved = describePredictionSupport('ml', 2);
  assert.equal(unobserved.supported, crowdEngine.ML_BASELINE_AXIS_VERIFIED);
});

test('the model does not claim a measurement while its weights predate the axis fix', () => {
  // Lehigh Valley and Miami ARE corpus cities, so this is not hypothetical:
  // real venues near real users take the ML path. The baselines anchoring it
  // were fixed by migration 023, but the served weights and their measured
  // training_metrics still come from the pre-fix corpus, so an ML answer's
  // confidence is still not a measurement of what is served, and it says so.
  const ml = describePredictionSupport('ml', 0);
  if (crowdEngine.ML_BASELINE_AXIS_VERIFIED) {
    // The retrain landed. The model's holdout figure describes what it serves.
    assert.equal(ml.basis, 'model_holdout');
    assert.equal(ml.supported, true);
    assert.equal(ml.confidenceMeans, 'measured_accuracy');
    assert.equal(publishedLabel(85, ml), 'Very Busy');
  } else {
    assert.equal(ml.basis, 'model_unverified_axis');
    assert.equal(ml.supported, false);
    assert.equal(ml.confidenceMeans, 'input_completeness',
      'within_15 was measured on the pre-fix mixed-axis corpus, so it does not describe what is served');
    assert.equal(publishedLabel(85, ml), 'Usually very busy');
  }
  // Either way the number stays inside its contract.
  assert.equal(publishedConfidence(84, ml, 0), 84);
});

test('the axis flag is on, and turning it off is the whole rollback', () => {
  // Flipped 2026-08-18 with v2.6.0-swift, the first artifact trained on the
  // corrected corpus. PART 3 above proves the peaks land in the evening as
  // stored, without the six-hour shift, so the weights are on the venue clock.
  // If this ever reads false again, the served model was rolled back to a
  // pre-fix artifact and the payload correctly stops calling its confidence a
  // measurement.
  assert.equal(typeof crowdEngine.ML_BASELINE_AXIS_VERIFIED, 'boolean');
  assert.equal(crowdEngine.ML_BASELINE_AXIS_VERIFIED, true,
    'the flag is false — either the artifact was rolled back to a pre-2026-08-18 '
    + 'model, or someone flipped it without shipping one. Re-run PART 3: if those '
    + 'peaks need the six-hour shift to land in the evening, the rollback is real.');
});

test('every honest refusal in mlPredictor is treated as a refusal here', () => {
  // services/mlPredictor.js has five ways of declining to use the model. Every
  // one of them must land in the unsupported bucket, or a future refusal added
  // there silently starts shipping as a measurement.
  for (const method of ['rule_engine', 'rule_engine_no_baseline',
    'rule_engine_no_weather_norm', 'rule_engine_fallback', undefined, null, 'ML', 'mlx']) {
    const s = describePredictionSupport(method, 0);
    assert.equal(s.supported, false, `predictionMethod ${String(method)} must not claim support`);
    assert.equal(s.confidenceMeans, 'input_completeness');
    assert.match(publishedLabel(90, s), /^Usually /);
  }
});

test('the hedge never invents a band, and survives garbage', () => {
  for (const score of [0, 20, 21, 40, 41, 60, 61, 80, 81, 100]) {
    const band = getLabel(score);
    assert.equal(hedgeLabel(band), `Usually ${band.toLowerCase()}`);
    assert.ok(hedgeLabel(band).toLowerCase().includes(band.toLowerCase()));
  }
  for (const junk of [null, undefined, '', 0, {}, []]) {
    assert.doesNotThrow(() => hedgeLabel(junk));
  }
  const uncapped = { basis: 'model_holdout', supported: true, confidenceCeiling: null };
  for (const support of [uncapped, describePredictionSupport('ml', 0), describePredictionSupport('rule_engine', 0)]) {
    for (const junk of [null, undefined, NaN, 'abc', {}, -50, 1e9]) {
      const c = publishedConfidence(junk, support, 0);
      assert.ok(Number.isInteger(c) && c >= 0 && c <= 100,
        `confidence ${c} out of contract for ${String(junk)} on ${support.basis}`);
    }
    assert.ok(publishedConfidence(200, support, 500) <= 100, 'confidence stays bounded above');
    assert.ok(publishedConfidence(-200, support, -500) >= 0, 'confidence stays bounded below');
  }
  assert.equal(publishedConfidence(200, uncapped, 50), 100, 'an uncapped basis still clamps at 100');
});

test('the list, the card and the alternatives strip qualify the same venue the same way', async () => {
  // Three surfaces, one venue, one story. A confident row above a hedged card
  // is the same disagreement rounds 13-15 spent themselves closing.
  const c = await card('localHour=18&localDay=5', 'parity');
  const b = await batch([batchVenue({ utcOffsetMinutes: -240 })]);
  const row = b.body.predictions[0];
  assert.equal(row.supported, c.body.supported);
  assert.equal(row.confidenceBasis, c.body.confidenceBasis);
  assert.equal(row.predictionMethod, c.body.predictionMethod);
  assert.equal(row.label, c.body.label);
  assert.equal(row.confidence, c.body.confidence);

  // "Less crowded nearby" compares its own number against the card's, so it
  // has to qualify it the same way or a hedged card sits above a list of
  // confident alternatives that are exactly as unobserved as it is.
  const altRes = await realFetch(`${base}/api/crowd/${freshId('alt')}/alternatives?localHour=18&localDay=5`);
  const alt = await altRes.json();
  assert.equal(altRes.status, 200);
  assert.equal(alt.currentVenue.supported, c.body.supported);
  assert.equal(alt.currentVenue.confidenceBasis, c.body.confidenceBasis);
  assert.equal(alt.currentVenue.predictionMethod, c.body.predictionMethod);
  assert.equal(alt.currentVenue.score, c.body.score);
});

test('other categories at their own peak hours are hedged the same way', async () => {
  // Not a restaurant problem: a bar at 10 PM and a cafe at 8 AM are just as
  // unobserved, and must not read as measured either.
  const cases = [
    { types: ['bar', 'cocktail_bar'], offset: -240, hour: 18 },
    { types: ['cafe', 'coffee_shop'], offset: 540, hour: 7 },
    { types: ['gym', 'fitness_center'], offset: -240, hour: 18 },
    { types: ['night_club'], offset: 60, hour: 23 },
  ];
  for (const cse of cases) {
    const { body } = await batch([batchVenue({ types: cse.types, utcOffsetMinutes: cse.offset })]);
    const row = body.predictions[0];
    assert.equal(row.venueClock.hour, cse.hour, `${cse.types[0]} scored at the wrong hour`);
    assert.equal(row.supported, false, `${cse.types[0]} claimed support it does not have`);
    assert.match(row.label, /^Usually /);
    assert.equal(row.confidenceMeans, 'input_completeness');
  }
});
