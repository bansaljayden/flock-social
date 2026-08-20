// Run: node --test  (from backend/)
//
// ===========================================================================
// THE LAST DAY VERDICT SAYS ONE OF FOUR THINGS, AND NEVER SAYS WHY.
//
// services/lastNightVerdict.js is the answer to the single most asked question
// in the operator category ("how did we just do") and the first Roost surface
// that returns a judgement rather than a table. That makes it the surface with
// the most ways to lie, so the invariants are pinned here:
//
//   1. THE VERDICT. above / below / ordinary, decided against the venue's own
//      same-weekday history, with the pooled trailing typical as the fallback
//      when there are not enough of those and as a second look beside them when
//      there are, and an honest "not enough of your history yet" when neither
//      clears its gate.
//   2. THE NOISE THRESHOLD. max(15 points, the comparison days' own median
//      absolute deviation), strictly exceeded before anything is called. A
//      three point wobble is an ordinary day and the copy says so.
//   3. THE REFUSAL. No reading for the day means the refusal is the WHOLE
//      output, never a weather-and-events paragraph about a day nobody
//      measured (ADVISOR-WHY-LAYER section 2, composition rule), and it names
//      the one tap that fixes it.
//   4. TRUSTED SERVE ROWS ONLY. `source = 'detail'` is an allowlist (migration
//      038): batch rows and pre-038 NULLs are client-chosen inputs and can
//      never become "what Flock told people".
//   5. CONTEXT WITHOUT CAUSATION. Conditions are stated. The banned verbs are
//      unconstructible, and the fence itself is tested so it cannot rot into a
//      no-op.
//   6. PLACEMENT. The verdict is card zero and lead chip; the Monday digest
//      opens on it rather than on the forecast.
// ===========================================================================

const test = require('node:test');
const assert = require('node:assert');

process.env.JWT_SECRET = 'last-night-verdict-test-secret';

// ── pg fake ─────────────────────────────────────────────────────────────────
const pool = require('../config/database');
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
  return Promise.reject(new Error(`unscripted query: ${flat.slice(0, 160)}`));
};

const verdict = require('../services/lastNightVerdict');
const advisorPhrasing = require('../services/advisorPhrasing');
const digestEmail = require('../templates/venueDigestEmail');

// ── Fixtures ────────────────────────────────────────────────────────────────
//
// NOW is a Saturday 10am in New York, so the venue's "yesterday" is Friday
// 2026-08-14 and the same-weekday history is the Fridays before it.
const NOW = new Date('2026-08-15T14:00:00Z');
const LAST_DAY = '2026-08-14';
const PLACE_ID = 'ChIJverdicttest00000000000000';

const CTX = {
  profile: { user_id: 7, google_place_id: PLACE_ID, verified: true, business_name: 'Test Bar' },
  mlVenue: { timezone: 'America/New_York', latitude: 40.6084, longitude: -75.4902 },
};

// Four prior Fridays reading 55, 58, 60, 62 (middle 59, MAD 2.5 -> 3, so the
// 15 point floor is what binds), plus a Wednesday and a Thursday so the pooled
// window has something in it that is not a Friday.
const FRIDAYS = [
  { date: '2026-08-07', peak: 62 },
  { date: '2026-07-31', peak: 55 },
  { date: '2026-07-24', peak: 60 },
  { date: '2026-07-17', peak: 58 },
];

function readingRows(todayPeak, { fridays = FRIDAYS, extra = [], readings = 2, diverged = false } = {}) {
  const rows = [];
  if (todayPeak !== null) {
    rows.push({ day: LAST_DAY, peak_reading: todayPeak, readings, diverged });
  }
  for (const f of fridays) rows.push({ day: f.date, peak_reading: f.peak, readings: 1, diverged: false });
  for (const e of extra) rows.push({ day: e.date, peak_reading: e.peak, readings: 1, diverged: false });
  return rows;
}

function script({
  readings = readingRows(58),
  served = [{ day: LAST_DAY, serves: 12, median_score: 48 }],
  weather = [],
  watched = false,
  events = [],
} = {}) {
  handlers = [
    [/FROM venue_owner_reports/, () => ({ rows: readings })],
    [/FROM served_predictions/, (params, sql) => {
      // The allowlist is the point of this handler: a served row only exists
      // for the reader if the SQL asked for the trusted door.
      assert.match(sql, /source = 'detail'/, 'served rows are read through the allowlist');
      return { rows: served };
    }],
    [/FROM night_context nc/, () => ({ rows: weather })],
    [/FROM night_context_runs/, () => ({ rows: [{ watched }] })],
    [/FROM ml_events/, () => ({ rows: events })],
  ];
}

const build = () => verdict.buildLastDayVerdict(CTX, { now: NOW });
const byId = (entries, prefix) => entries.find((e) => e.id && e.id.startsWith(prefix)) || null;

test.beforeEach(() => { handlers = []; queryLog = []; });

// ── 1. The verdict ──────────────────────────────────────────────────────────

test('a day far under the venue\'s own weekday middle is called below, in its own words', async () => {
  script({ readings: readingRows(20) });
  const out = await build();
  const v = byId(out, 'last_day_verdict_');
  assert.ok(v, 'a verdict was constructed');
  assert.strictEqual(v.value.verdict, 'below');
  assert.strictEqual(v.value.baseline, 59, 'middle of 55, 58, 60, 62');
  assert.strictEqual(v.value.baselineKind, 'same_weekday');
  assert.strictEqual(v.value.comparisonDays, 4);
  assert.strictEqual(v.value.delta, -39);
  assert.strictEqual(v.source, 'arithmetic');
  assert.deepStrictEqual(v.from, [`owner_reading_${LAST_DAY}`, `owner_weekday_baseline_${LAST_DAY}`],
    'the verdict names the facts it was computed from');
  assert.match(v.label, /Friday came in 39 points below your own Fridays/);
  assert.match(v.label, /quieter Friday than usual/);
});

test('a day far over the middle is called above', async () => {
  script({ readings: readingRows(92) });
  const v = byId(await build(), 'last_day_verdict_');
  assert.strictEqual(v.value.verdict, 'above');
  assert.strictEqual(v.value.delta, 33);
  assert.match(v.label, /busier Friday than usual/);
});

test('the ordinary day is a real answer, phrased as one', async () => {
  script({ readings: readingRows(62) });
  const v = byId(await build(), 'last_day_verdict_');
  assert.strictEqual(v.value.verdict, 'ordinary');
  assert.strictEqual(v.value.delta, 3);
  assert.match(v.label, /came in 3 points above your own Fridays/, 'the direction is still stated');
  assert.match(v.label, /We call a day unusual only past 15 points/);
  assert.match(v.label, /reads as an ordinary Friday/);
  assert.doesNotMatch(v.label, /busier|quieter/, 'an ordinary day is not sold as a near miss');
});

test('a day level with the middle reads as level, not as a zero', async () => {
  script({ readings: readingRows(59) });
  const v = byId(await build(), 'last_day_verdict_');
  assert.strictEqual(v.value.verdict, 'ordinary');
  assert.match(v.label, /landed level with your own Fridays/);
});

test('under three same-weekday days the pooled trailing typical carries it, and says it is rougher', async () => {
  script({
    readings: readingRows(20, {
      fridays: [{ date: '2026-08-07', peak: 60 }],
      extra: [
        { date: '2026-08-13', peak: 58 }, { date: '2026-08-12', peak: 61 },
        { date: '2026-08-11', peak: 57 }, { date: '2026-08-10', peak: 59 },
      ],
    }),
  });
  const out = await build();
  const v = byId(out, 'last_day_verdict_');
  assert.strictEqual(v.value.baselineKind, 'trailing_typical');
  assert.strictEqual(v.value.comparisonDays, 5);
  assert.strictEqual(v.value.verdict, 'below');
  assert.match(byId(out, 'owner_trailing_baseline_').label, /rougher yardstick/);
});

test('too little history refuses the verdict instead of grading against one day', async () => {
  script({ readings: readingRows(20, { fridays: [{ date: '2026-08-07', peak: 60 }], extra: [] }) });
  const out = await build();
  assert.strictEqual(byId(out, 'last_day_verdict_'), null, 'no verdict was invented');
  const refusal = byId(out, 'refuse_no_baseline_');
  assert.strictEqual(refusal.status, 'refused');
  assert.match(refusal.reason, /not enough of your own history/);
  assert.match(refusal.whatWouldUnlock, /no shortcut through our corpus/);
  // The reading itself still renders: what was measured is never withheld
  // because the comparison is missing.
  assert.ok(byId(out, `owner_reading_${LAST_DAY}`));
});

// ── 2. The noise threshold ──────────────────────────────────────────────────

test('the threshold is the wider of the 15 point floor and the venue\'s own spread', () => {
  // A steady venue: MAD is 1, so the floor binds and nothing under 15 is called.
  const steady = [50, 51, 50, 49];
  assert.strictEqual(verdict.callTheDay(63, steady).threshold, 15);
  assert.strictEqual(verdict.callTheDay(63, steady).verdict, 'ordinary', '13 points is a wobble');
  assert.strictEqual(verdict.callTheDay(65, steady).verdict, 'ordinary', 'exactly 15 is not "past 15"');
  assert.strictEqual(verdict.callTheDay(66, steady).verdict, 'above', 'sixteen clears it');

  // A swingy venue: its own spread is wider than the floor, so it is graded on
  // its own swing and a 17 point move is still an ordinary day for THIS room.
  const swingy = [20, 50, 60, 90]; // middle 55, own spread 20
  const call = verdict.callTheDay(72, swingy);
  assert.ok(call.threshold > 15, 'the venue\'s own spread widened the line');
  assert.strictEqual(call.threshold, 20);
  assert.strictEqual(call.verdict, 'ordinary', '17 points is inside this room\'s own swing');
  assert.strictEqual(verdict.callTheDay(80, swingy).verdict, 'above', '25 points clears it');
});

test('the floor is the why-layer\'s published D1 gate, not a number invented here', () => {
  assert.strictEqual(verdict.VERDICT_FLOOR_POINTS, 15);
  assert.strictEqual(verdict.MIN_WEEKDAY_DAYS, 3);
  assert.strictEqual(verdict.MIN_TRAILING_DAYS, 5);
});

test('a three point wobble is never a bad day, at any baseline', () => {
  for (const base of [10, 30, 55, 80]) {
    const call = verdict.callTheDay(base + 3, [base, base, base, base]);
    assert.strictEqual(call.verdict, 'ordinary', `${base} + 3 must read ordinary`);
  }
});

test('the median absolute deviation is robust to one wild day', () => {
  assert.strictEqual(verdict.median([55, 58, 60, 62]), 59);
  assert.strictEqual(verdict.medianAbsoluteDeviation([50, 51, 52, 100]), 1,
    'one outlier moves a MAD barely at all, where it would treble a standard deviation');
});

// ── 3. The refusal path ─────────────────────────────────────────────────────

test('no reading for the day: the refusal is the WHOLE answer, and it names the slider', async () => {
  script({ readings: readingRows(null) });
  const out = await build();
  assert.strictEqual(out.length, 1,
    'a conditions report about a day nobody measured is the shape the why-layer bans');
  const r = out[0];
  assert.strictEqual(r.status, 'refused');
  assert.strictEqual(r.id, `refuse_no_reading_${LAST_DAY}`);
  assert.match(r.reason, /You did not post a reading on Friday 2026-08-14/);
  assert.match(r.reason, /no measurement of your room that day for us to grade/);
  assert.match(r.whatWouldUnlock, /One move of the busy slider at your busiest hour/);
  assert.match(r.whatWouldUnlock, /your own recent Fridays/);
  // No weather, no events, no serve line rode along.
  assert.ok(!queryLog.some((q) => /night_context|ml_events/.test(q.sql)),
    'a refused day costs no context queries either');
});

test('a venue that has never posted gets the first-reading version of the unlock', async () => {
  script({ readings: [] });
  const out = await build();
  assert.strictEqual(out.length, 1);
  assert.match(out[0].whatWouldUnlock, /The first reading gets compared against what Flock published/);
  assert.match(out[0].whatWouldUnlock, /After three more Fridays/);
});

test('the refusal never upsells and never nags', async () => {
  script({ readings: readingRows(null) });
  const r = (await build())[0];
  const text = `${r.reason} ${r.whatWouldUnlock}`.toLowerCase();
  for (const banned of ['upgrade', 'pro plan', 'streak', 'don\'t forget', 'remember to', 'you should']) {
    assert.ok(!text.includes(banned), `the refusal must not say "${banned}"`);
  }
});

// ── 4. Trusted serve rows only ──────────────────────────────────────────────

test('what Flock published is read through the migration 038 allowlist', async () => {
  script({ readings: readingRows(20) });
  const out = await build();
  const servedSql = queryLog.find((q) => /FROM served_predictions/.test(q.sql));
  assert.ok(servedSql, 'the serve log was read');
  assert.match(servedSql.sql, /source = 'detail'/);
  assert.doesNotMatch(servedSql.sql, /source IN|<> 'batch'|!= 'batch'/,
    'an allowlist, never a blocklist: NULL and batch are refused by construction');
  const served = byId(out, 'served_trusted_');
  assert.strictEqual(served.source, 'served_prediction');
  assert.strictEqual(served.value.medianScore, 48);
  assert.match(served.note, /not a measurement of your room/);
  const gap = byId(out, 'served_vs_reading_');
  assert.strictEqual(gap.source, 'arithmetic');
  assert.strictEqual(gap.value.gap, 28);
  assert.match(gap.label, /28 points above your own highest reading/);
  assert.match(gap.label, /says nothing on its own about which of the two the room agreed with/);
});

test('no trusted serves that day refuses the comparison rather than reaching for untrusted rows', async () => {
  script({ readings: readingRows(20), served: [] });
  const out = await build();
  assert.strictEqual(byId(out, 'served_trusted_'), null);
  assert.match(byId(out, 'refuse_no_served_').reason, /published no estimate/);
});

// ── 5. Context stated, causation banned ─────────────────────────────────────

test('conditions are stated as conditions, and never as the reason for the day', async () => {
  script({
    readings: readingRows(20),
    weather: [
      { hour: 18, temp: 66, conditions: 'clear sky', is_raining: false },
      { hour: 20, temp: 61, conditions: 'light rain', is_raining: true },
      { hour: 22, temp: 58, conditions: 'light rain', is_raining: true },
    ],
    watched: true,
    events: [],
  });
  const out = await build();
  const w = byId(out, 'weather_recorded_');
  assert.match(w.label, /It rained in your city from 8 PM to 11 PM that day\./);
  assert.match(w.label, /Temperatures ran 58 F to 66 F\./);
  assert.match(w.note, /Weather is never offered as the explanation of a number/);
  const none = byId(out, 'no_listed_events_');
  assert.match(none.label, /No ticketed events were listed within about a kilometer/);
  assert.match(none.label, /Ticketmaster listings only/);

  // The whole card, end to end, contains no causal claim.
  for (const e of out) {
    for (const s of [e.label, e.note, e.reason, e.whatWouldUnlock]) {
      if (typeof s === 'string') verdict.assertNoCausation(s, 'rendered card');
    }
  }
});

test('the causation fence bites, so it cannot rot into a no-op', () => {
  assert.throws(() => verdict.assertNoCausation('You were slow because it rained.', 'x'), /claims a cause/);
  assert.throws(() => verdict.assertNoCausation('That is why Friday was quiet.', 'x'), /claims a cause/);
  assert.throws(() => verdict.assertNoCausation('The rain caused the drop.', 'x'), /claims a cause/);
  assert.throws(() => verdict.assertNoCausation('Slow due to the weather.', 'x'), /claims a cause/);
  assert.throws(() => verdict.assertNoCausation('The event explains your Friday.', 'x'), /claims a cause/);
  assert.doesNotThrow(() => verdict.assertNoCausation('It rained from 8 PM to 11 PM that day.', 'x'));
  assert.ok(verdict.CAUSAL_PHRASES.length >= 10);
});

test('a night nobody snapshotted says so, rather than reading as a quiet street', async () => {
  script({ readings: readingRows(20), watched: false });
  const out = await build();
  assert.strictEqual(byId(out, 'no_listed_events_'), null);
  const r = byId(out, 'refuse_no_event_snapshot_');
  assert.match(r.reason, /not snapshotting event listings/);
  assert.match(r.whatWouldUnlock, /Ticketmaster drops past events/);
  assert.match(byId(out, 'refuse_no_weather_').reason, /not recording city weather/);
});

test('a listed event nearby is presence only, with no headcount and no sign', async () => {
  script({
    readings: readingRows(20),
    watched: true,
    events: [{ name: 'Arena Show', event_type: 'concert', venue_lat: 40.6100, venue_lng: -75.4902 }],
  });
  const e = byId(await build(), 'event_recorded_');
  assert.match(e.label, /One ticketed event was listed within about a kilometer of you that day, Arena Show/);
  assert.ok(!/attend|crowd of|people/i.test(e.label), 'attendance is a vendor heuristic and never surfaces');
  assert.match(e.note, /not something we can measure yet/);
});

test('the owner\'s own reading is attributed and never wears a measurement source', async () => {
  script({ readings: readingRows(20, { readings: 3, diverged: true }) });
  const out = await build();
  const r = byId(out, `owner_reading_${LAST_DAY}`);
  assert.strictEqual(r.source, 'owner_report');
  assert.strictEqual(r.attribution, 'owner_asserted');
  assert.match(r.label, /Your highest reading on Friday 2026-08-14 was 20, from 3 readings\./);
  assert.match(r.note, /flagged as diverging/);
});

// ── 6. Placement ────────────────────────────────────────────────────────────

test('the verdict is the lead chip and the registry offers four', () => {
  assert.strictEqual(advisorPhrasing.CHIP_PRIORITY[0], 'last_night_verdict',
    'the habit prompt leads, not the forecast');
  assert.strictEqual(advisorPhrasing.CHIP_PRIORITY[1], 'tonight_outlook');
  assert.ok(advisorPhrasing.isKnownIntent('last_night_verdict'));
  assert.ok(!advisorPhrasing.isKnownIntent('last_day_compare'),
    'one question, one chip: the composition-only version it replaced is gone');
  assert.strictEqual(advisorPhrasing.ADVISOR_INTENTS.last_night_verdict.chip, 'How did we do yesterday?');
  assert.strictEqual(advisorPhrasing.ADVISOR_INTENTS.last_night_verdict.group, 'looking_back');
});

test('the Monday digest opens on the verdict, not on the forecast', () => {
  const card = (id, status = 'ok') => ({
    id, title: id, status,
    facts: [{ id: `${id}_f`, value: 1, source: 'owner_report', asOf: '2026-08-14', label: `line for ${id}` }],
  });
  const stack = [
    card('last_night_verdict'), card('week_ahead'), card('around_you'),
    card('listing_read_back'), card('readings_vs_estimates'),
  ];
  const { recap, anomaly, headsUp } = digestEmail.sectionsFor(stack, 'pro');
  assert.strictEqual(recap[0].id, 'last_night_verdict', 'the verdict is the first block read');
  assert.strictEqual(anomaly, null);
  assert.deepStrictEqual(headsUp.map((c) => c.id), ['week_ahead', 'around_you'],
    'the forecast sits in the heads-up block at the bottom, where it belongs');

  // Even when the stack arrives out of order, and even when a later card is
  // carrying a firing gate, the verdict stays first.
  const gated = card('listing_read_back');
  gated.facts = [{
    id: 'kitchen_vs_peak', source: 'arithmetic', asOf: '2026-08-14', label: 'kitchen line',
    value: { peakAtOrAfterLastOrder: true },
  }];
  const shuffled = [card('week_ahead'), gated, card('last_night_verdict')];
  const s2 = digestEmail.sectionsFor(shuffled, 'pro');
  assert.strictEqual(s2.recap[0].id, 'last_night_verdict');
  assert.strictEqual(s2.anomaly.id, 'listing_read_back', 'the anomaly slot still works around it');
});

test('a refused verdict is dropped from the email rather than nagging weekly', () => {
  const refused = { id: 'last_night_verdict', title: 'v', status: 'refused', facts: [] };
  const kept = digestEmail.cardsForTier([refused], 'pro');
  assert.strictEqual(kept.length, 0);
});

// ---------------------------------------------------------------------------
// BOTH YARDSTICKS. The verdict is decided on the same weekday, and the pooled
// trailing typical rides along as a second look when there is enough of it.
// One day never gets two verdicts.
// ---------------------------------------------------------------------------
test('the pooled trailing typical rides along as context, never as a rival verdict', async () => {
  script({
    readings: readingRows(20, {
      extra: [
        { date: '2026-08-13', peak: 40 }, { date: '2026-08-12', peak: 44 },
        { date: '2026-08-11', peak: 38 }, { date: '2026-08-10', peak: 42 },
      ],
    }),
  });
  const out = await build();
  assert.strictEqual(out.filter((e) => e.id && e.id.startsWith('last_day_verdict_')).length, 1,
    'exactly one verdict');
  const v = byId(out, 'last_day_verdict_');
  assert.strictEqual(v.value.baselineKind, 'same_weekday', 'the weekday comparison decides it');
  const pooled = byId(out, 'owner_trailing_baseline_');
  assert.ok(pooled, 'the pooled typical is stated too');
  assert.strictEqual(pooled.source, 'owner_report');
  assert.match(pooled.label, /not just Fridays/);
  assert.match(pooled.label, /a second look rather than a second verdict/);
  assert.ok(!pooled.value.verdict, 'the second yardstick carries no verdict of its own');
});
