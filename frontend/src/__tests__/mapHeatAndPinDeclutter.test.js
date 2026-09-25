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
 *   3. PIN OVERLAPS. A pin is drawn exactly on its venue at every zoom and
 *      is never displaced. Where two would overlap on screen the one that
 *      matters less fades out and the survivor carries a "+N"; the pass
 *      re-runs as the map moves, throttled, and every marker is positioned
 *      at subpixel precision. (This replaced a spiral that pushed pins off
 *      their venues and re-laid them a frame after every zoom.)
 *
 * Source-scanning, like every other App.js suite here.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test --watchAll=false
 */

const fs = require('fs');
const path = require('path');

const APP = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8');
// The map moved to components/map/MapLibreMapView.js on 2026-09-13 and is a
// fetched chunk now. Defect 1 below is App.js's: the venue list, the batch
// scorer and the write-back effect all still live there, because FlockAppInner
// owns that state. Defects 2 and 3 are the map's own drawing and moved with it.
// Both files are read, and each assertion points at the one that answers it, so
// nothing here can go green by looking at a file that no longer draws the thing.
const MAP = fs.readFileSync(path.join(__dirname, '..', 'components', 'map', 'MapLibreMapView.js'), 'utf8');
// Both at once, for the negatives only: a pin displacement scheme that came
// back is a regression wherever it is written.
const BOTH = `${APP}\n${MAP}`;

function codeOnly(src) {
  return src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');
}

// The source is a parameter now that the map is a second file. It still
// defaults to App.js, and it still fails loudly on a missing anchor rather than
// slicing an empty string every assertion would pass against.
function region(startMarker, endMarker, source = APP) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
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
  const paint = region('const VENUE_HEAT_PAINT = {', '\n};', MAP);
  const paintCode = codeOnly(paint);

  it('radius and intensity follow zoom', () => {
    expect(paintCode).toContain("'heatmap-radius': ['interpolate', ['exponential', 1.75], ['zoom']");
    expect(paintCode).toContain("'heatmap-intensity': ['interpolate', ['linear'], ['zoom']");
  });

  it('the pixel radius grows with zoom, so the field stays on the ground instead of collapsing into the pin', () => {
    const m = paintCode.match(/'heatmap-radius': \['interpolate', \['exponential', 1\.75\], \['zoom'\],([^\]]+)\]/);
    expect(m).not.toBeNull();
    const stops = m[1].split(',').map((s) => parseFloat(s.trim()));
    const radii = stops.filter((_, i) => i % 2 === 1);
    for (let i = 1; i < radii.length; i++) expect(radii[i]).toBeGreaterThan(radii[i - 1]);
  });

  it('the heat hands over to the pins at street zoom', () => {
    const m = paintCode.match(/'heatmap-opacity': \['interpolate', \['linear'\], \['zoom'\],([^\]]+)\]/);
    expect(m).not.toBeNull();
    const stops = m[1].split(',').map((s) => parseFloat(s.trim()));
    const opacities = stops.filter((_, i) => i % 2 === 1);
    expect(opacities[0]).toBeGreaterThan(0.5);
    expect(opacities[opacities.length - 1]).toBe(0);
    for (let i = 1; i < opacities.length; i++) expect(opacities[i]).toBeLessThan(opacities[i - 1]);
  });

  it('weights stay the real crowd score', () => {
    expect(paintCode).toContain("'heatmap-weight': ['coalesce', ['get', 'weight'], 0.5]");
    // Features carry score/100 and exist ONLY for venues with a real score —
    // both places that build them gate on typeof crowd === 'number'.
    expect(MAP).toContain('properties: { weight: v.crowd / 100 }');
    const gates = MAP.match(/typeof v\.crowd === 'number'/g) || [];
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

describe('pin overlaps', () => {
  const fn = codeOnly(region('function resolvePinOverlaps(', '\nfunction setPinHidden(', MAP));
  // The end anchor is the component below it. It used to be the comment above
  // NO_LOCATION_VIEW, which stayed in App.js when the map left: FlockAppInner
  // loads venues around the same point, so that constant has two readers and
  // only one declaration.
  const hide = codeOnly(region('function setPinHidden(', '\nconst MapLibreMapView = React.memo(', MAP));
  const mapCode = codeOnly(MAP);
  const bothCode = codeOnly(BOTH);

  it('a pin is never moved off its venue: the resolver reads positions and writes none', () => {
    expect(fn).toContain('map.project([venue.location.longitude, venue.location.latitude])');
    expect(fn).not.toContain('setLngLat');
    expect(fn).not.toContain('unproject');
    expect(bothCode).not.toContain('GOLDEN_ANGLE');
    expect(bothCode).not.toContain('declutterMarkers');
  });

  it('the active venue, then the owner, then the busier place keeps the spot', () => {
    const pri = codeOnly(region('function pinPriority(', '\nfunction resolvePinOverlaps(', MAP));
    const act = pri.indexOf('act(bv) - act(av)');
    const own = pri.indexOf('own(bv) - own(av)');
    const crowd = pri.indexOf('crowd(bv) - crowd(av)');
    expect(act).toBeGreaterThan(-1);
    expect(own).toBeGreaterThan(act);
    expect(crowd).toBeGreaterThan(own);
    expect(pri).toContain('.localeCompare(');
  });

  it('a covered pin fades through the marker, stops taking taps, and leaves the tree; the survivor counts it', () => {
    expect(hide).toContain("marker.setOpacity('0')");
    expect(hide).toContain("marker.setOpacity('1')");
    expect(hide).toContain("el.style.pointerEvents = 'none'");
    expect(hide).toContain("el.setAttribute('aria-hidden', 'true')");
    expect(hide).toContain("badge.className = 'mlb-cluster-badge'");
    expect(hide).toContain('const text = `+${behind}`;');
    expect(MAP).toContain('.mlb-cluster-badge {');
    expect(MAP).toContain('.mlb-venue-marker { user-select: none; -webkit-user-select: none; transition: opacity 0.16s ease; }');
  });

  it('runs after markers are built, throttled while the map moves, and once more when it settles', () => {
    expect(mapCode).toContain('if (overlapPassRef.current) overlapPassRef.current();');
    expect(mapCode).toContain("map.on('move', scheduleOverlapPass);");
    expect(mapCode).toContain("map.on('moveend', overlapPass);");
    expect(mapCode).toContain('window.requestAnimationFrame(overlapPass)');
    expect(mapCode).toContain('PIN_OVERLAP_MIN_INTERVAL_MS - (performance.now() - lastOverlapAt)');
  });

  it('every marker is positioned at subpixel precision, so pins glide instead of stepping', () => {
    const pinned = (MAP.match(/subpixelPositioning: true/g) || []).length;
    expect(pinned).toBeGreaterThanOrEqual(4);
    // The venue pin, the flock pin, the member pin and the viewer's own dot.
    expect(MAP).toContain("new ml.Marker({ element: el, anchor, subpixelPositioning: true })");
    expect(MAP).toContain("new mlMod.Marker({ element: el, anchor: 'center', subpixelPositioning: true })");
  });
});

describe('pin size and anchor', () => {
  it('size follows zoom continuously through one CSS variable, not three tiers on a transition', () => {
    const mapCode = codeOnly(MAP);
    expect(mapCode).toContain("container.style.setProperty('--pin-scale', scale.toFixed(3));");
    expect(MAP).toContain('.mlb-marker-inner { transform: scale(var(--pin-scale, 1)); }');
    expect(MAP).not.toContain('[data-zoom-tier="lo"] .mlb-marker-inner');
    expect(MAP).not.toContain('transition: transform 0.18s ease');
    // The curve: full size by 14.5, PIN_SCALE_MIN at 12 and below.
    expect(mapCode).toContain('const PIN_SCALE_MIN = 0.74;');
    expect(mapCode).toContain('const PIN_SCALE_FROM = 12;');
    expect(mapCode).toContain('const PIN_SCALE_TO = 14.5;');
  });

  it('scales about the point pinned to the coordinate', () => {
    expect(MAP).toContain("inner.style.transformOrigin = roundPin ? 'center center' : 'bottom center';");
    // The builder still draws full size; scale is a transform. One pair of
    // sizes serves the photo, the marker box and the active swap, and the
    // overlap test measures against the same body.
    const mapCode = codeOnly(MAP);
    expect(mapCode).toContain('const PIN_PX = 48;');
    expect(mapCode).toContain('const PIN_ACTIVE_PX = 58;');
    expect(mapCode).toContain('const PIN_OVERLAP_PX = PIN_PX + 2;');
    expect((mapCode.match(/const size = isActive \? PIN_ACTIVE_PX : PIN_PX;/g) || []).length).toBe(3);
    expect(mapCode).not.toContain('isActive ? 54 : 44');
  });

  it('the label and the owner chip sit outside the box MapLibre anchors', () => {
    const build = codeOnly(region('const buildMarkerEl = useCallback(', '\n  useEffect(() => {', MAP));
    expect(build).toContain("under.className = 'mlb-marker-under';");
    expect(build).toContain('under.appendChild(label);');
    expect(build).not.toContain('el.appendChild(label);');
    expect(MAP).toContain(".mlb-marker-under {");
    expect(MAP).toMatch(/\.mlb-marker-under \{\s*position: absolute;\s*top: 100%;/);
    expect(codeOnly(MAP)).toContain("(el.querySelector('.mlb-marker-under') || el).appendChild(chip);");
    // Sized to its content: an absolute box shrinks to its containing block,
    // and with the 44px pin as that block every venue name wrapped to two
    // letters ("Th.", "Mo.") on the first street-zoom capture.
    const under = MAP.slice(MAP.indexOf('.mlb-marker-under {'), MAP.indexOf('.mlb-marker-under {') + 700);
    expect(under).toContain('width: max-content;');
  });

  it('a photo pin waits behind a disc, not a teardrop, so nothing jumps when the photo lands', () => {
    const build = codeOnly(region('const buildMarkerEl = useCallback(', '\n  useEffect(() => {', MAP));
    const photoBranch = build.slice(build.indexOf('} else if (venue.photo_url) {'), build.indexOf('} else {', build.indexOf('} else if (venue.photo_url) {')));
    expect(photoBranch).toContain('buildDiscSvg(isActive, venue.category)');
    expect(photoBranch).not.toContain('buildPinSvg(');
  });
});
