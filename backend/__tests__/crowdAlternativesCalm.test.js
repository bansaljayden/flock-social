/**
 * A QUIET VENUE BUYS NO ALTERNATIVES SEARCH (Explore audit, 2026-09-05).
 *
 * HOW TO RUN
 *   cd backend && node --test __tests__/crowdAlternativesCalm.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

test('the calm early return sits after the target prediction and before the paid search', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'crowd.js'), 'utf8').replace(/\r\n/g, '\n');
  const target = src.indexOf('const targetResult = await mlPredictor.predictBusyness(target, weather, clientTime');
  const early = src.indexOf("if (Number.isFinite(shown) && shown <= 39) {\n          if (searchUnitReserved) refundPlacesSearch(req.user.id, 1);\n          return res.json({ alternatives: [] });");
  const search = src.indexOf("https://places.googleapis.com/v1/places:searchText", target);
  assert.ok(target > -1 && early > -1 && search > -1);
  assert.ok(target < early && early < search, 'the early return must precede the Text Search');
  assert.match(src.slice(target, early), /ownerReports\.getLiveOwnerReports\(\[placeId\]\)\.catch\(\(\) => \(\{\}\)\)/);
});
