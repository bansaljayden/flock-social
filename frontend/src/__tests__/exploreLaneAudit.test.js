/**
 * EXPLORE (audit 2026-09-05): source pins for the seven fixes.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test exploreLaneAudit --watchAll=false
 */
const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8').replace(/\r\n/g, '\n');

test('the venue sheet is sequence-guarded, reads included', () => {
  const app = read('App.js');
  expect(app).toContain('const venueDetailSeqRef = useRef(0);');
  expect(app).toContain('const seq = ++venueDetailSeqRef.current;');
  expect(app).toContain("      ]);\n      if (!current()) return;\n");
  expect(app).toContain(".then(res => { if (current()) setCrowdAlternatives(res.alternatives || []); })");
  expect(app).toContain("    } finally {\n      if (current()) {\n        setVenueDetailLoading(false);\n        setCrowdLoading(false);\n      }");
  expect(app).toContain("if (venueDetailReviewsForRef.current !== String(placeId)) return;");
});

test('a calm venue asks for no alternatives, on both paths', () => {
  const app = read('App.js');
  expect(app).toContain("if (crowd && !(typeof crowd.score === 'number' && crowd.score <= 39)) {");
  // A card whose crowd level is covered (the month's venues are spent) asks
  // for none either: the server would answer an empty list anyway.
  expect(app).toContain("if (data && !data.forecastAccess?.locked && !(typeof data.score === 'number' && data.score <= 39)) getCrowdAlternatives(pid)");
});

test('the dot and ring leave with Location', () => {
  /* The blue dot, the accuracy ring and the effect that tears both down are
     the map component's, and the map is components/map/MapLibreMapView.js
     since 2026-09-13, so this reads the file that draws them rather than
     silently finding nothing in App.js. */
  const map = read('components/map/MapLibreMapView.js');
  expect(map).toContain("    if (!userLocation) {\n      // Location switched off");
  expect(map).toContain("userMarkerRef.current.remove();\n        userMarkerRef.current = null;\n        userElRef.current = null;");
  expect(map).toContain("if (ring) ring.setData({ type: 'FeatureCollection', features: [] });");
});

test('scores carry fetchedAt and expire, and an owner reading is not printed past its expiry', () => {
  const app = read('App.js');
  /* All three labelled sites are the full-screen results list's, and that list
     is components/SearchResultsOverlay.js since 2026-09-13, so the count reads
     the file that draws them rather than silently falling to zero in App.js.
     The TTL, the staleness test and the expiry check stay here: ownerReportShown
     is defined in App.js and travels to the list as a prop. */
  const searchResults = read('components/SearchResultsOverlay.js');
  expect(app).toContain('const CROWD_SCORE_TTL_MS = 30 * 60 * 1000;');
  expect(app).toContain("const stale = (e) => !e || !e.fetchedAt || Date.now() - e.fetchedAt > CROWD_SCORE_TTL_MS;");
  expect(app).toContain("map[p.placeId] = { ...p, fetchedAt };");
  expect((app.match(/fetchedAt: Date\.now\(\) \} \}\)\);/g) || []).length).toBe(3);
  /* THREE now, not two. The third is the list card's crowd label, which used
     to print a bare "Busy" with no framing while the venue DETAIL sheet
     carried an ESTIMATED chip and a four-way attribution line. An app was
     rejected by App Review for showing model output it could not source, and
     a crowd forecast is that shape, so the browse surface now says (est.)
     unless the reading is the venue's own word. The count is a crude proxy
     for the real property — wherever a crowd number is shown, an owner
     reading is labelled as the venue's — but it does catch a new site added
     without the owner branch, which is what it is here to do. */
  expect((searchResults.match(/ownerReportShown\(prediction\) \?/g) || []).length).toBe(3);
  expect(app).toContain("Date.parse(prediction.ownerReport.expiresAt) > Date.now()");
});

test('a failed crowd read, a map that cannot load, and a show that started are all said', () => {
  const app = read('App.js');
  // noEstimate is crowdFetchFailed plus a read that carried no finite score.
  // It is drawn on the card a map pin opens, which has had its own file since
  // 2026-09-13, so that sentence is read there and the map ones stay here.
  const card = read('components/venue/ConsumerVenueCard.js');
  // And the three map sentences are read in components/map/MapLibreMapView.js,
  // which is where the map has been drawn since 2026-09-13.
  const map = read('components/map/MapLibreMapView.js');
  expect(card).toContain("{noEstimate && !isClosed ? (");
  expect(map).toContain("The map could not load. Search still works.");
  expect(map).toContain("setTimeout(() => { if (!mapLoadedRef.current) setMapFailed(true); }, 12000);");
  expect(map).toContain("{!mapReady && !mapFailed && (");
  /* And the Live Events list is the Discover screen's, and Discover is
     screens/ExploreScreen.js since 2026-09-13, so the show-has-started filter
     is read there rather than silently finding nothing in App.js. */
  const explore = read('screens/ExploreScreen.js');
  expect(explore).toContain(".filter(event => !event.datetime_utc || Date.parse(event.datetime_utc) > Date.now()).map(event => {");
});
