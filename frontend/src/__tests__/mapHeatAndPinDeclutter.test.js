/**
 * DISCOVER MAP: HEAT ON FIRST OPEN, AMBIENT COVERAGE, PIN DECLUTTER.
 *
 * Three defects reported from the shipping build, each fix pinned here:
 *
 *   1. FIRST-LOAD HEAT. The heatmap was empty when the map first opened,
 *      because (a) the initial nearby-venues load never requested crowd
 *      scores at all (only a manual search did), and (b) when a batch DID
 *      resolve, the scores landed in crowdPredictions only — nothing wrote
 *      them back into allVenues, which is what feeds the 'venue-heat'
 *      source. Fix: every venue list goes through requestCrowdScores, and a
 *      sync effect writes resolved scores back into the pin list.
 *
 *   2. AMBIENT COVERAGE, STILL TRUTHFUL. Radius and intensity now follow
 *      zoom so the heat reads as a continuous field at city zoom and
 *      localizes at street zoom. The WEIGHT stays the venue's real score
 *      (crowd/100), features exist only for venues with a real score, and a
 *      low score renders visibly cool instead of invisible. No heat is ever
 *      fabricated where there is no scored venue.
 *
 *   3. PIN DECLUTTER. Overlapping pins are displaced deterministically
 *      around their shared centroid (Vogel spiral, members sorted by
 *      place_id) instead of stacking, hiding, or shrinking. Recomputed on
 *      zoomend only — never per frame — and a pin alone in its group snaps
 *      back to the venue's true location.
 *
 * Source-scanning, like every other App.js suite here.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test --watchAll=false
 */

const fs = require('fs');
const path = require('path');

const APP = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8');

function codeOnly(src) {
  return src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');
}

function region(startMarker, endMarker) {
  const start = APP.indexOf(startMarker);
  const end = APP.indexOf(endMarker, start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return APP.slice(start, end);
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. Heat has data on the very first open
// ═══════════════════════════════════════════════════════════════════════════

describe('first-load heat', () => {
  const loadFn = region('const loadVenuesAtLocation = useCallback', 'const requestUserLocation');
  const loadCode = codeOnly(loadFn);

  it('the initial nearby load scores its venues on every path', () => {
    // Cache hit and fresh fetch, which are now the only two paths that produce
    // venues at all. There used to be a third: a failed search substituted
    // eight hardcoded Lehigh Valley bars and this line scored those too. The
    // fallback was deleted on 2026-08-25 (a failure now says it failed instead
    // of drawing invented pins), so the number is 2 because there are two ways
    // to have real venues, not because a path stopped being scored.
    const calls = loadCode.match(/requestCrowdScores\(/g) || [];
    expect(calls.length).toBe(2);
  });

  it('search paths go through the same scorer (cache hit included)', () => {
    const searchFn = codeOnly(region('const doVenueSearch = useCallback', 'const openVenueDetail'));
    const calls = searchFn.match(/requestCrowdScores\(/g) || [];
    expect(calls.length).toBe(2);
  });

  it('scoring is one batch call per list, never one call per pin', () => {
    const scorer = codeOnly(region('const requestCrowdScores = useCallback', '// Convert venues array to map pin format'));
    expect(scorer).toContain('getCrowdBatch(');
    expect(scorer).not.toContain('getCrowdPrediction(');
    // And it dedupes against scores already in hand instead of re-asking.
    expect(scorer).toContain('crowdPredictionsRef.current');
  });

  it('resolved scores are written back into the pin list the map reads', () => {
    // Without this effect the heatmap stayed empty until a SECOND search
    // rebuilt the list. Guarded against looping: unchanged returns prev.
    const sync = codeOnly(region('// Write freshly landed batch scores back into the pin list', '// Request user geolocation'));
    expect(sync).toContain('setAllVenues(prev');
    expect(sync).toContain('return changed ? next : prev;');
    expect(sync).toContain('}, [crowdPredictions]);');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Ambient coverage that stays honest
// ═══════════════════════════════════════════════════════════════════════════

describe('heat paint', () => {
  const paint = region('const VENUE_HEAT_PAINT = {', '\n};');
  const paintCode = codeOnly(paint);

  it('radius and intensity follow zoom (field at city zoom, local at street zoom)', () => {
    expect(paintCode).toContain("'heatmap-radius': ['interpolate', ['linear'], ['zoom']");
    expect(paintCode).toContain("'heatmap-intensity': ['interpolate', ['linear'], ['zoom']");
  });

  it('the radius shrinks as zoom grows, so hotspots localize', () => {
    const m = paintCode.match(/'heatmap-radius': \['interpolate', \['linear'\], \['zoom'\],([^\]]+)\]/);
    expect(m).not.toBeNull();
    const stops = m[1].split(',').map((s) => parseFloat(s.trim()));
    const radii = stops.filter((_, i) => i % 2 === 1);
    for (let i = 1; i < radii.length; i++) expect(radii[i]).toBeLessThan(radii[i - 1]);
  });

  it('weights stay the real crowd score', () => {
    expect(paintCode).toContain("'heatmap-weight': ['coalesce', ['get', 'weight'], 0.5]");
    // Features carry score/100 and exist ONLY for venues with a real score —
    // both places that build them gate on typeof crowd === 'number'.
    expect(APP).toContain('properties: { weight: v.crowd / 100 }');
    const gates = APP.match(/typeof v\.crowd === 'number'/g) || [];
    expect(gates.length).toBeGreaterThanOrEqual(2);
  });

  it('low scores render visibly cool instead of invisible', () => {
    // A color stop well below the old 0.1 floor keeps quiet venues on the map.
    const m = paintCode.match(/\['heatmap-density'\],\s*0,\s*'rgba\(0, 0, 0, 0\)',\s*([\d.]+),/);
    expect(m).not.toBeNull();
    expect(parseFloat(m[1])).toBeLessThan(0.1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Pin declutter
// ═══════════════════════════════════════════════════════════════════════════

describe('pin declutter', () => {
  const fn = region('function declutterMarkers(map, markerEntries)', '\nconst MapLibreMapView');
  const fnCode = codeOnly(fn);

  it('offsets are deterministic: members sorted by place_id, laid on a spiral', () => {
    expect(fnCode).toContain('.localeCompare(');
    expect(fnCode).toContain('GOLDEN_ANGLE');
    expect(fnCode).toContain('Math.sqrt(k)');
  });

  it('a pin alone in its group sits exactly on the venue', () => {
    expect(fnCode).toContain('marker.setLngLat([venue.location.longitude, venue.location.latitude])');
  });

  it('pin size is untouched: displacement, not shrinking or hiding', () => {
    expect(fnCode).not.toContain('display');
    expect(fnCode).not.toContain('width');
    // The marker builder still draws full size.
    expect(APP).toContain('const size = isActive ? 54 : 44;');
  });

  it('a spiral slot that lands on another pin is skipped, not taken', () => {
    // Within-group spacing was never the whole problem: a big group's outer
    // arm reaches 40·√k px from its centroid, and verified live on a real
    // 20-venue load it parked a pin 16px from a venue that was never in its
    // group. Every placement is checked against every pin already placed —
    // and singletons claim their spots FIRST, so an arm can never cover a
    // lone pin standing exactly on its venue.
    expect(fnCode).toContain('placedPts.some(');
    expect(fnCode).toContain('placedPts.push(pts[idxs[0]])');
    const singletonPass = fnCode.indexOf('placedPts.push(pts[idxs[0]])');
    const spiralPass = fnCode.indexOf('multiGroups.forEach');
    expect(singletonPass).toBeGreaterThan(-1);
    expect(spiralPass).toBeGreaterThan(singletonPass);
    // The slot cursor is shared across the group, so a slot skipped for a
    // foreign collision stays skipped — the layout stays deterministic.
    expect(fnCode).toMatch(/let k = 0;/);
  });

  it('runs when markers are (re)built and again when the zoom settles', () => {
    expect(codeOnly(APP)).toContain('declutterMarkers(map, markersRef.current)');
    expect(codeOnly(APP)).toContain("map.on('zoomend', () => declutterMarkers(map, markersRef.current))");
  });

  it('never runs per frame', () => {
    const appCode = codeOnly(APP);
    // The continuous events keep their existing single handlers; declutter is
    // not among them.
    expect(appCode).not.toMatch(/map\.on\('zoom',\s*\(\)\s*=>\s*declutterMarkers/);
    expect(appCode).not.toMatch(/map\.on\('move(?:end)?',[^\n]*declutterMarkers/);
  });
});
