// Starling's holiday calendar lookups — the layer between holidays.json and
// both collection stamping and live inference. These mirror the manual spot
// checks from the 2026-08-12 encode session.
const { test } = require('node:test');
const assert = require('node:assert');
const { specialNightFor, isHolidayEve, specialNightContext } = require('../scripts/ml/specialNights');

test('Thanksgiving Eve is a high-confidence boost in NYC', () => {
  const hit = specialNightFor('nyc', '2026-11-25');
  assert.equal(hit.name, 'thanksgiving_eve');
  assert.equal(hit.effect, 'boost');
  assert.equal(hit.conf, 'high');
  assert.equal(isHolidayEve('nyc', '2026-11-25'), true);
});

test('Mardi Gras 2027 peak hits New Orleans (city scope)', () => {
  assert.equal(specialNightFor('nola', '2027-02-09').name, 'mardi_gras_peak');
});

test('Indian Independence Day is a legal suppress (dry day)', () => {
  const hit = specialNightFor('delhi', '2026-08-15');
  assert.equal(hit.name, 'dry_day_independence');
  assert.equal(hit.effect, 'suppress');
});

test('city layer beats country layer (Mumbai Holi dry day over IN mixed)', () => {
  assert.equal(specialNightFor('mumbai', '2026-03-04').name, 'holi_dry_day');
  assert.equal(specialNightFor('mumbai', '2026-03-04').effect, 'suppress');
});

test('named nights win date collisions with December Friday loops (Seoul)', () => {
  assert.equal(specialNightFor('seoul', '2026-12-25').name, 'christmas_day_couples');
  assert.equal(specialNightFor('seoul', '2026-12-18').name, 'hoesik_friday');
});

test('unknown city returns null / false, never throws', () => {
  assert.equal(specialNightFor('atlantis', '2026-12-31'), null);
  assert.equal(isHolidayEve('atlantis', '2026-12-31'), false);
});

test('inference context: venue near a training city gets full context', () => {
  const ctx = specialNightContext(40.71, -74.0, '2026-11-25'); // NYC venue, Thanksgiving Eve
  assert.equal(ctx.is_special_night, 1);
  assert.equal(ctx.special_boost, 1);
  assert.equal(ctx.is_holiday_eve, 1);
});

test('inference context: continental-US venue far from training cities falls back to US layer', () => {
  const nye = specialNightContext(39.10, -84.51, '2026-12-31'); // Cincinnati
  assert.equal(nye.is_special_night, 1);
  const tuesday = specialNightContext(39.10, -84.51, '2026-08-11');
  assert.equal(tuesday.is_special_night, 0);
});

test('inference context: outside coverage returns zeros', () => {
  const ctx = specialNightContext(-30.0, 145.0, '2026-12-31'); // rural Australia
  assert.deepEqual(ctx, { is_special_night: 0, special_boost: 0, special_suppress: 0, is_holiday_eve: 0 });
});
