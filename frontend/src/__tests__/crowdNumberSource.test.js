/**
 * A CROWD NUMBER IS ATTRIBUTED TO THE ARITHMETIC THAT MADE IT.
 *
 * The server keeps predictionMethod 'ml' for every number the model path
 * answered, including one a serving switch made from the venue's own weekly
 * pattern and its recent live readings with no model run at all. Those
 * responses carry `numberSource` (`number_source` on the public demo), and
 * every surface that says "the Flock crowd model" must read it first. With
 * both switches off the key is absent and each surface keeps the words it
 * already had.
 */
const fs = require('fs');
const path = require('path');
const { numberSourcePhrase, hourlySourcePhrase, isAdjustedSource } = require('../lib/crowd');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');

test('each value the server names has plain words, and anything else has none', () => {
  expect(numberSourcePhrase('venue_pattern_live')).toBe("this venue's usual pattern and its recent live readings");
  expect(numberSourcePhrase('venue_pattern')).toBe("this venue's usual pattern");
  expect(numberSourcePhrase('model_live')).toBe("the Flock crowd model and this venue's recent live readings");
  expect(numberSourcePhrase('model_alone')).toBe('the Flock crowd model alone');
  for (const v of [undefined, null, '', 'ml', 'model', 'curve_offset', 'toString', '__proto__',
    'live_reading', 'live_reading_0h', 'live_reading_13h', 'live_reading_1', 'xlive_reading_1h']) {
    expect(numberSourcePhrase(v)).toBeNull();
  }
});

test('a number that is a carried live reading says so, with its age', () => {
  expect(numberSourcePhrase('live_reading_1h')).toBe("this venue's live reading taken an hour ago");
  expect(numberSourcePhrase('live_reading_2h')).toBe("this venue's live reading taken 2 hours ago");
  expect(numberSourcePhrase('live_reading_12h')).toBe("this venue's live reading taken 12 hours ago");
});

test('a number people there adjusted is never worded as the reading itself', () => {
  // A reading of 20 blended to 35 by verified reporters.
  expect(numberSourcePhrase('live_reading_1h_adjusted'))
    .toBe("this venue's live reading taken an hour ago, adjusted by people who are there");
  expect(numberSourcePhrase('live_reading_3h_adjusted'))
    .toBe("this venue's live reading taken 3 hours ago, adjusted by people who are there");
  expect(numberSourcePhrase('venue_pattern_live_adjusted'))
    .toBe("this venue's usual pattern and its recent live readings, adjusted by people who are there");
  expect(numberSourcePhrase('venue_pattern_adjusted')).toBe("this venue's usual pattern, adjusted by people who are there");
  expect(numberSourcePhrase('model_live_adjusted'))
    .toBe("the Flock crowd model and this venue's recent live readings, adjusted by people who are there");
  // Not "alone" once people there moved it.
  expect(numberSourcePhrase('model_alone_adjusted')).toBe('the Flock crowd model, adjusted by people who are there');
  for (const v of ['_adjusted', 'ml_adjusted', 'live_reading_13h_adjusted', 'live_reading_1h_adjusted_adjusted', 'toString_adjusted']) {
    expect(numberSourcePhrase(v)).toBeNull();
  }
  expect(isAdjustedSource('live_reading_1h_adjusted')).toBe(true);
  expect(isAdjustedSource('venue_pattern_adjusted')).toBe(true);
  for (const v of ['live_reading_1h', 'venue_pattern', 'ml_adjusted', undefined, null, '']) {
    expect(isAdjustedSource(v)).toBe(false);
  }
});

const EM_DASH = new RegExp(String.fromCharCode(0x2014));
test('no phrase carries an em dash', () => {
  for (const v of ['venue_pattern_live', 'venue_pattern', 'model_live', 'model_alone', 'live_reading_1h', 'live_reading_3h',
    'live_reading_1h_adjusted', 'model_alone_adjusted', 'venue_pattern_live_adjusted']) {
    expect(numberSourcePhrase(v)).not.toMatch(EM_DASH);
  }
});

describe('the hourly chart caption comes from the bars drawn', () => {
  const ml = (numberSource) => (numberSource ? { predictionMethod: 'ml', numberSource } : { predictionMethod: 'ml' });
  const rule = { predictionMethod: 'rule_engine_no_baseline' };

  test('no bar with a source keeps the old caption (both switches off)', () => {
    expect(hourlySourcePhrase([ml(), ml(), rule])).toBeNull();
    expect(hourlySourcePhrase([])).toBeNull();
    expect(hourlySourcePhrase(null)).toBeNull();
    expect(hourlySourcePhrase([ml('something_new')])).toBeNull();
  });

  test('bars that all share one source take its words', () => {
    expect(hourlySourcePhrase([ml('venue_pattern_live'), ml('venue_pattern_live')])).toBe(numberSourcePhrase('venue_pattern_live'));
    expect(hourlySourcePhrase([ml('live_reading_1h')])).toBe("this venue's live reading taken an hour ago");
  });

  test('a rule-engine bar beside named bars is said to be typical, never credited to the pattern', () => {
    // curve_offset on: the current hour had no baseline and the rule engine
    // answered it, every later bar is the venue's pattern.
    expect(hourlySourcePhrase([rule, ml('venue_pattern'), ml('venue_pattern')]))
      .toBe("this venue's usual pattern, and in hours not measured here yet, what is typical for a venue like yours");
    expect(hourlySourcePhrase([rule, ml('venue_pattern_live'), ml('venue_pattern')]))
      .toBe("this venue's usual pattern, with this venue's recent live readings in some hours, and in hours not measured here yet, what is typical for a venue like yours");
  });

  test('live readings come from each bar\'s own yes or no, never from a missing source', () => {
    const on = (numberSource, liveReadings) => ({ predictionMethod: 'ml', ...(numberSource ? { numberSource } : {}), liveReadings });
    // The server names no source for an hour whose live offset landed on the
    // stored offset's score, and says yes to live readings for it. Read from
    // absence, this strip was "in some hours"; every bar used live readings.
    expect(hourlySourcePhrase([on(null, true), on(null, true), on('live_reading_1h', true)]))
      .toBe("the Flock crowd model and this venue's recent live readings");
    expect(hourlySourcePhrase([on('model_live', true), on(null, true)]))
      .toBe("the Flock crowd model and this venue's recent live readings");
    // A no is a no.
    expect(hourlySourcePhrase([on('model_live', true), on(null, false)]))
      .toBe("the Flock crowd model, with this venue's recent live readings in some hours");
    expect(hourlySourcePhrase([on('model_alone', false), on(null, false)])).toBe('the Flock crowd model');
    // A rule-engine hour is a no whatever it says.
    expect(hourlySourcePhrase([{ predictionMethod: 'rule_engine_fallback', liveReadings: false }, on('venue_pattern_live', true)]))
      .toBe("this venue's usual pattern and its recent live readings, and in hours not measured here yet, what is typical for a venue like yours");
  });

  test('live readings are named for every bar, some bars, or none, as the bars say', () => {
    // The current hour used a reading; the evening had none to use.
    expect(hourlySourcePhrase([ml('model_live'), ml(), ml()]))
      .toBe("the Flock crowd model, with this venue's recent live readings in some hours");
    expect(hourlySourcePhrase([ml('venue_pattern_live'), ml('venue_pattern')]))
      .toBe("this venue's usual pattern, with this venue's recent live readings in some hours");
    expect(hourlySourcePhrase([ml('live_reading_1h'), ml('model_live')]))
      .toBe("the Flock crowd model and this venue's recent live readings");
    expect(hourlySourcePhrase([ml('model_alone'), ml()])).toBe('the Flock crowd model');
    expect(hourlySourcePhrase([ml('live_reading_1h'), ml('live_reading_2h')])).toBe("this venue's live readings from earlier hours");
  });

  test('no caption carries an em dash', () => {
    const sets = [[ml('model_live'), ml()], [ml('venue_pattern_live'), ml('venue_pattern')], [ml('live_reading_1h'), ml('live_reading_2h')],
      [rule, ml('venue_pattern')]];
    for (const s of sets) expect(hourlySourcePhrase(s)).not.toMatch(EM_DASH);
  });
});

test('every surface that credits the crowd model reads the number source first', () => {
  const card = read('components/venue/ConsumerVenueCard.js');
  expect(card).toMatch(/const madeFrom = numberSourcePhrase\(cd\.numberSource\);/);
  // The model line and the reporters' line both defer to it; the old words
  // remain for a response without the key.
  expect(card).toMatch(/madeFrom \? `From \$\{madeFrom\}\.` : 'From the Flock crowd model\.'/);
  expect(card).toMatch(/madeFrom \? `From \$\{madeFrom\}, adjusted by people who are there\.` : 'From the crowd model, adjusted by people who are there\.'/);
  // A source that already says people adjusted it is not followed by the
  // same words twice.
  expect(card).toMatch(/const adjustedFrom = madeFrom && isAdjustedSource\(cd\.numberSource\) \? `From \$\{madeFrom\}\.` : null;/);
  expect(card).toMatch(/cd\.confidenceBasis === 'user_reports' \? \(adjustedFrom \|\|/);

  const insights = read('components/VenueInsightCards.js');
  // The hourly charts read the bars they draw FIRST, before the current
  // score's model version: a rule-engine current hour must not caption
  // pattern bars as the rule engine's.
  expect(insights).toMatch(/\{hourlySourcePhrase\(hourly\)\s*\? `Today hour by hour, our estimate from \$\{hourlySourcePhrase\(hourly\)\}\.`\s*: intel\?\.model/);
  expect(insights).not.toMatch(/intel\.numberSource/);

  const dashboard = read('screens/VenueDashboard.js');
  expect(dashboard).toMatch(/\{hourlySourcePhrase\(venueIntel\.todayHourly\)\s*\? `From \$\{hourlySourcePhrase\(venueIntel\.todayHourly\)\}\.`\s*: venueIntel\.model\s*\? `Flock crowd model v\$\{venueIntel\.model\}`\s*: 'Flock rule engine/);
  expect(dashboard).not.toMatch(/venueIntel\.numberSource/);

  const demo = read('website/LiveDemo.js');
  expect(demo).toMatch(/numberSourcePhrase\(selected\.number_source\)[\s\S]{0,200}'Live from the model inside Flock'/);
});
