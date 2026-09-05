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
  expect(app).toContain("if (data && !(typeof data.score === 'number' && data.score <= 39)) getCrowdAlternatives(pid)");
});

test('the dot and ring leave with Location', () => {
  const app = read('App.js');
  expect(app).toContain("    if (!userLocation) {\n      // Location switched off");
  expect(app).toContain("userMarkerRef.current.remove();\n        userMarkerRef.current = null;\n        userElRef.current = null;");
  expect(app).toContain("if (ring) ring.setData({ type: 'FeatureCollection', features: [] });");
});

test('scores carry fetchedAt and expire, and an owner reading is not printed past its expiry', () => {
  const app = read('App.js');
  expect(app).toContain('const CROWD_SCORE_TTL_MS = 30 * 60 * 1000;');
  expect(app).toContain("const stale = (e) => !e || !e.fetchedAt || Date.now() - e.fetchedAt > CROWD_SCORE_TTL_MS;");
  expect(app).toContain("map[p.placeId] = { ...p, fetchedAt };");
  expect((app.match(/fetchedAt: Date\.now\(\) \} \}\)\);/g) || []).length).toBe(3);
  expect((app.match(/ownerReportShown\(prediction\) \?/g) || []).length).toBe(2);
  expect(app).toContain("Date.parse(prediction.ownerReport.expiresAt) > Date.now()");
});

test('a failed crowd read, a map that cannot load, and a show that started are all said', () => {
  const app = read('App.js');
  expect(app).toContain("{crowdFetchFailed && !isClosed ? (");
  expect(app).toContain("The map could not load. Search still works.");
  expect(app).toContain("setTimeout(() => { if (!mapLoadedRef.current) setMapFailed(true); }, 12000);");
  expect(app).toContain("{!mapReady && !mapFailed && (");
  expect(app).toContain(".filter(event => !event.datetime_utc || Date.parse(event.datetime_utc) > Date.now()).map(event => {");
});
