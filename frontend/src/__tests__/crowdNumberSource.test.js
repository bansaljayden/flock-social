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
const { numberSourcePhrase, hourlySourcePhrase } = require('../lib/crowd');

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

const EM_DASH = new RegExp(String.fromCharCode(0x2014));
test('no phrase carries an em dash', () => {
  for (const v of ['venue_pattern_live', 'venue_pattern', 'model_live', 'model_alone', 'live_reading_1h', 'live_reading_3h']) {
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
    expect(hourlySourcePhrase([ml('venue_pattern_live'), ml('venue_pattern_live'), rule])).toBe(numberSourcePhrase('venue_pattern_live'));
    expect(hourlySourcePhrase([ml('live_reading_1h')])).toBe("this venue's live reading taken an hour ago");
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
    const sets = [[ml('model_live'), ml()], [ml('venue_pattern_live'), ml('venue_pattern')], [ml('live_reading_1h'), ml('live_reading_2h')]];
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

  const insights = read('components/VenueInsightCards.js');
  // The hourly charts read the bars they draw, never the current score's source.
  expect(insights).toMatch(/hourlySourcePhrase\(hourly\)[\s\S]{0,200}Today hour by hour, our estimate from/);
  expect(insights).not.toMatch(/intel\.numberSource/);

  const dashboard = read('screens/VenueDashboard.js');
  expect(dashboard).toMatch(/hourlySourcePhrase\(venueIntel\.todayHourly\)[\s\S]{0,200}`Flock crowd model v\$\{venueIntel\.model\}`/);
  expect(dashboard).not.toMatch(/venueIntel\.numberSource/);

  const demo = read('website/LiveDemo.js');
  expect(demo).toMatch(/numberSourcePhrase\(selected\.number_source\)[\s\S]{0,200}'Live from the model inside Flock'/);
});
