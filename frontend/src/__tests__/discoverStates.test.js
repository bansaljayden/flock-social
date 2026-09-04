// Discover states that read as broken, from the map trace of 2026-09-04.
// Source contracts.
const fs = require('fs');
const path = require('path');

const app = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8');

test('a failed crowd read ends the skeleton and says so', () => {
  expect(app).toMatch(/const \[crowdFetchFailed, setCrowdFetchFailed\] = useState\(false\);/);
  expect(app).toMatch(/setCrowdFetchFailed\(crowdResult\.status !== 'fulfilled'\);/);
  expect(app).toMatch(/No crowd read for this spot right now\./);
});

test('a search that found nothing or failed clears the last city\'s pins', () => {
  const fn = app.slice(app.indexOf('const data = await searchVenues(enhanced, loc);'), app.indexOf('setVenueLoadError(err?.message || \'Search is not responding'));
  expect((fn.match(/setAllVenues\(\[\]\);/g) || []).length).toBe(2);
});

test('zero venues nearby is said, and the budget cap is named', () => {
  expect(app).toMatch(/No venues on Flock's map right here yet\. Search a place by name, or move the map\./);
  expect(app).toMatch(/spots here are above your group's budget, so none show\. The search worked\./);
});

test('the category filter drives pins, heat and an empty sentence from one predicate', () => {
  expect(app).toMatch(/^const venueMatchesCategory = \(v, filterCategory\) => \{/m);
  expect(app).toMatch(/applyCategoryFilter\(mapInstanceRef\.current, markersRef\.current, filterCategory, setFilterHidesAll\);/);
  expect(app).toMatch(/const shown = venueMatchesCategory\(v, filterCategoryRef\.current\);/);
  expect(app).toMatch(/if \(shown && typeof v\.crowd === 'number'\)/);
  expect(app).toMatch(/spots on this map\. Pick another filter or move the map\./);
});

test('a quota refusal that names its window does not offer a retry that cannot work', () => {
  expect(app).toMatch(/\{!\/again in \\d\+\/i\.test\(venueLoadError \|\| ''\) && <button className="hit44" onClick=\{\(\) => \{ setLocationError\(''\); setVenueLoadError\(''\);/);
});

test('a category-shaped hourly curve says so under the bars', () => {
  expect(app).toMatch(/\{cd && !cd\.hourly && !crowdFetchFailed && \(/);
  expect(app).toMatch(/at these hours, not a read of this spot\./);
});
