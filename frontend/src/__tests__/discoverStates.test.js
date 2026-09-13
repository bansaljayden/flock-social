// Discover states that read as broken, from the map trace of 2026-09-04.
// Source contracts.
const fs = require('fs');
const path = require('path');

const app = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8');
// The full-screen results list moved to components/SearchResultsOverlay.js on
// 2026-09-13. The budget sentence below is drawn there now, so it is read from
// there: left pointed at App.js it would have gone green by looking at the
// wrong file rather than by the sentence still being said.
const searchResults = fs.readFileSync(path.join(__dirname, '..', 'components', 'SearchResultsOverlay.js'), 'utf8');
// The card a map pin opens moved to components/venue/ConsumerVenueCard.js on
// the same day, carrying the crowd forecast block. The two sentences under the
// bars are read from there: left pointed at App.js the first of them would have
// gone green on a comment that happens to quote it rather than on the card
// still saying it.
const card = fs.readFileSync(path.join(__dirname, '..', 'components', 'venue', 'ConsumerVenueCard.js'), 'utf8');
// And the map itself moved to components/map/MapLibreMapView.js on the same
// day, carrying the category predicate, the pins and the heat it drives. The
// filter contract below is read from there for the same reason as the two
// above: pointed at App.js it would go green on nothing at all.
const map = fs.readFileSync(path.join(__dirname, '..', 'components', 'map', 'MapLibreMapView.js'), 'utf8');
// And the Discover screen itself moved to screens/ExploreScreen.js on the same
// day, carrying the banners drawn above the map. The empty-map sentence and the
// quota-refusal retry are read from there for the reason the three above are:
// pointed at App.js they would go green on nothing at all.
const explore = fs.readFileSync(path.join(__dirname, '..', 'screens', 'ExploreScreen.js'), 'utf8');

test('a failed crowd read ends the skeleton and says so', () => {
  expect(app).toMatch(/const \[crowdFetchFailed, setCrowdFetchFailed\] = useState\(false\);/);
  expect(app).toMatch(/setCrowdFetchFailed\(crowdResult\.status !== 'fulfilled'\);/);
  expect(card).toMatch(/No crowd read for this spot right now\./);
});

test('a search that found nothing or failed clears the last city\'s pins', () => {
  const fn = app.slice(app.indexOf('const data = await searchVenues(enhanced, loc);'), app.indexOf('setVenueLoadError(err?.message || \'Search is not responding'));
  expect((fn.match(/setAllVenues\(\[\]\);/g) || []).length).toBe(2);
});

test('zero venues nearby is said, and the budget cap is named', () => {
  expect(explore).toMatch(/No venues on Flock's map right here yet\. Search a place by name, or move the map\./);
  expect(searchResults).toMatch(/spots here are above your group's budget, so none show\. The search worked\./);
});

test('the category filter drives pins, heat and an empty sentence from one predicate', () => {
  expect(map).toMatch(/^const venueMatchesCategory = \(v, filterCategory\) => \{/m);
  expect(map).toMatch(/applyCategoryFilter\(mapInstanceRef\.current, markersRef\.current, filterCategory, setFilterHidesAll\);/);
  expect(map).toMatch(/const shown = venueMatchesCategory\(v, filterCategoryRef\.current\);/);
  expect(map).toMatch(/if \(shown && typeof v\.crowd === 'number'\)/);
  expect(map).toMatch(/spots on this map\. Pick another filter or move the map\./);
});

test('a quota refusal that names its window does not offer a retry that cannot work', () => {
  expect(explore).toMatch(/\{!\/again in \\d\+\/i\.test\(venueLoadError \|\| ''\) && <button className="hit44" onClick=\{\(\) => \{ setLocationError\(''\); setVenueLoadError\(''\);/);
});

test('a category-shaped hourly curve says so under the bars', () => {
  expect(card).toMatch(/\{cd && !cd\.hourly && !crowdFetchFailed && \(/);
  expect(card).toMatch(/at these hours, not a read of this spot\./);
});
