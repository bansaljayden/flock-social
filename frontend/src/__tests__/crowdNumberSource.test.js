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
const { numberSourcePhrase } = require('../lib/crowd');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');

test('each value the server names has plain words, and anything else has none', () => {
  expect(numberSourcePhrase('venue_pattern_live')).toBe("this venue's usual pattern and its recent live readings");
  expect(numberSourcePhrase('venue_pattern')).toBe("this venue's usual pattern");
  expect(numberSourcePhrase('model_live')).toBe("the Flock crowd model and this venue's recent live readings");
  for (const v of [undefined, null, '', 'ml', 'model', 'curve_offset', 'toString', '__proto__']) {
    expect(numberSourcePhrase(v)).toBeNull();
  }
});

test('no phrase carries an em dash', () => {
  for (const v of ['venue_pattern_live', 'venue_pattern', 'model_live']) {
    expect(numberSourcePhrase(v)).not.toMatch(/—/);
  }
});

test('every surface that credits the crowd model reads the number source first', () => {
  const card = read('components/venue/ConsumerVenueCard.js');
  expect(card).toMatch(/const madeFrom = numberSourcePhrase\(cd\.numberSource\);/);
  // The model line and the reporters' line both defer to it; the old words
  // remain for a response without the key.
  expect(card).toMatch(/madeFrom \? `From \$\{madeFrom\}\.` : 'From the Flock crowd model\.'/);
  expect(card).toMatch(/madeFrom \? `From \$\{madeFrom\}, adjusted by people who are there\.` : 'From the crowd model, adjusted by people who are there\.'/);

  const insights = read('components/VenueInsightCards.js');
  expect(insights).toMatch(/numberSourcePhrase\(intel\.numberSource\)[\s\S]{0,200}Today hour by hour, our estimate from/);

  const dashboard = read('screens/VenueDashboard.js');
  expect(dashboard).toMatch(/numberSourcePhrase\(venueIntel\.numberSource\)[\s\S]{0,200}`Flock crowd model v\$\{venueIntel\.model\}`/);

  const demo = read('website/LiveDemo.js');
  expect(demo).toMatch(/numberSourcePhrase\(selected\.number_source\)[\s\S]{0,200}'Live from the model inside Flock'/);
});
