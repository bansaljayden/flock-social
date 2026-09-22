/**
 * THE DISCOVER MAP.
 *
 * The MapLibre GL view behind the Discover tab, and the same view the venue
 * owner dashboard draws in its Map tab: the vector basemap, the venue pins and
 * the photos on them, the overlap pass that stops them stacking, the crowd heat
 * field, the accuracy ring, the blue dot, the flock member markers and the
 * zoom / locate / satellite controls. It was 1,229 lines of App.js declared at
 * module scope as React.memo(...), and the basemap constants, the overlay layer
 * builders and the pin helpers above it came too, because nothing outside the
 * map ever read one of them.
 *
 * WHY IT MOVED
 *
 * App.js is the boot chunk and this was the single biggest block left in it.
 * Nothing on the first paint path can reach a map: the Nest is the landing
 * screen, and the map layer is not mounted until Discover is visible for the
 * first time (see exploreEverVisibleRef in App.js, and firstRunPath.test.js,
 * which is about the iOS location prompt that boot-time mount used to spend).
 * So every byte of this was downloaded and parsed by every user on every
 * launch, for a surface most sessions open once and many never open at all.
 *
 * It is a fetched chunk named "maplibre-view" now, warmed on idle in
 * warmScreenChunks so the first visit to Discover does not pay for the round
 * trip, and mounted behind a Suspense boundary in App.js. The ENGINE was
 * already fetched rather than bundled: the `import('maplibre-gl')` below, and
 * its stylesheet beside it, have been dynamic for a while. This is the view
 * code around it.
 *
 * WHAT THE MOVE WAS NOT ALLOWED TO CHANGE
 *
 * THE MAP LAYER IS MOUNTED PERMANENTLY AND ONLY HIDDEN. Switching tabs away
 * from Discover leaves this component mounted behind `visibility: hidden`,
 * because building a MapLibre instance is expensive and remounting it loses the
 * camera: the city the user panned to, the zoom they chose, the pin they had
 * open. A React.lazy binding is an element TYPE and rebuilding one remounts
 * everything under it, which is why the re-arm this chunk gets in App.js is the
 * only conditional one in that file: it rebuilds the lazy only when the chunk
 * actually failed to download, so a map that loaded is never pulled out from
 * under the person looking at it. The Suspense boundary suspends exactly once,
 * on the first mount, when there is no map on screen to flash over.
 *
 * The pin behaviour is untouched by the move: the overlap hiding, the
 * continuous zoom scale, the labels outside the anchor box and the
 * ground-anchored heat are the same lines they were, and
 * mapHeatAndPinDeclutter.test.js reads them here now.
 *
 * WHY FOUR THINGS ARRIVE AS PROPS
 *
 * The body below is the deleted lines, unchanged. It read four names off
 * App.js's module scope that have other readers there and so could not come
 * with it: the two palettes (colorsLight, colorsDark), resolveVenuePhoto, and
 * NO_LOCATION_VIEW. They arrive under the names they already had, which is what
 * lets the body stay a verbatim copy, and App.js's wrapper passes them so
 * neither call site has to carry props for declarations it does not use.
 * NO_LOCATION_VIEW in particular has to stay ONE declaration: FlockAppInner
 * loads venues around the same point this map opens on, and a second copy of it
 * is a second city.
 *
 * The one place the body is not character-identical is two dependency arrays.
 * resolveVenuePhoto was module scope and therefore not a dependency; as a prop
 * it is one, and react-hooks/exhaustive-deps is a build error here. Behaviour is
 * unchanged: it is the same module-scope const it always was, handed down by a
 * wrapper that never rebuilds it, so neither hook re-runs any more often than it
 * did inline.
 *
 * escapeHtml and mapEase came WITH the component. Both were declared in App.js,
 * and every reader either had was inside these lines, so leaving them behind
 * would have left boot weight for a surface that had gone.
 */
import React, { useState, useCallback, useEffect, useRef } from 'react';
import { useTheme } from '../../context/ThemeContext';
import { starSvgString } from '../ui/Icons';
import { lsGet } from '../../lib/storage';
import { queueSync } from '../../services/userSettings';
import { geolocationAvailable, getCurrentPosition, watchPosition, clearWatch } from '../../services/geolocation';

// HTML-escape a user-derived string before it is interpolated into any raw
// HTML sink (e.g. MapLibre Popup.setHTML, which assigns innerHTML). This must
// be safe on its own — do NOT rely on upstream stripHtml on the write path.
// Escapes the five characters that can break out of text or an attribute.
const escapeHtml = (s) =>
  String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

// Reduced motion, honored on the one animation CSS cannot reach: MapLibre's
// camera. The global stylesheet collapses every CSS animation when the user
// asks for stillness, but flyTo is a JS tween. jumpTo lands the same place
// with no flight.
const mapEase = (map, opts) => {
  const still = typeof window !== 'undefined' && window.matchMedia
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (still) map.jumpTo({ center: opts.center, zoom: opts.zoom });
  else map.flyTo(opts);
};

// =============================================================================
// MapLibre GL JS — Snap Map-style vector basemap (smooth GPU-rendered)
// Prefers MapTiler Streets v2 Dark when REACT_APP_MAPTILER_KEY is set
// (denser POIs, road hierarchies, neighborhood labels). Falls back to
// CARTO Dark Matter (free, no key) when the env var is missing.
// =============================================================================
const MAPTILER_KEY = process.env.REACT_APP_MAPTILER_KEY;
// basic-v2 instead of streets-v2 (2026-08-12): streets renders every POI,
// transit stop, and neighborhood label Google-style, which buried Flock's own
// venue markers in basemap noise. Basic keeps roads/water/districts legible
// and lets OUR pins be the loudest thing on the map.
const DARK_VECTOR_STYLE = MAPTILER_KEY
  ? `https://api.maptiler.com/maps/basic-v2-dark/style.json?key=${MAPTILER_KEY}`
  : 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';
// Light-mode basemap (2026-07 redesign): the always-dark map read as a "weird
// overlay" inside the cream app. Basic light in light mode; positron fallback.
const LIGHT_VECTOR_STYLE = MAPTILER_KEY
  ? `https://api.maptiler.com/maps/basic-v2/style.json?key=${MAPTILER_KEY}`
  : 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json';
const isAppDark = () => document.documentElement.getAttribute('data-theme') === 'dark';
// Pass `dark` explicitly when you have it from React state; omit it to read the
// live <html data-theme> (used at map construction, before any effect runs).
const ROADMAP_STYLE = (dark) => ((dark === undefined ? isAppDark() : dark) ? DARK_VECTOR_STYLE : LIGHT_VECTOR_STYLE);
// Satellite: MapTiler "hybrid" (imagery + roads + place labels overlaid), and
// ONLY that. Null when there is no key, which is what SATELLITE_AVAILABLE below
// reads to hide the toggle rather than offer a button that cannot answer.
//
// WHY THERE IS NO KEYLESS FALLBACK ANY MORE. This used to fall back to raster
// tiles from server.arcgisonline.com, requested with no API key and no Esri
// account. Esri's basemaps are not free for commercial use, so that was a
// licensing exposure before it was ever a billing one — and it was the only
// outbound host in the app with that shape (which is why it needed its own CSP
// allowlist entry). It was already dead in every build that ships: Vercel and
// Codemagic both set REACT_APP_MAPTILER_KEY, so the MapTiler branch always won
// and the Esri branch had not served a tile in production. What it did still do
// was ship unlicensed-request code in a repository, where anyone who clones
// Flock without a MapTiler key and taps the satellite toggle starts making them
// against Esri's servers under their own IP. Removing the branch costs
// production nothing and stops handing that to contributors.
//
// The roadmap basemap keeps its keyless CARTO fallback — CARTO's Dark Matter and
// Positron are openly licensed for this, which is exactly the property Esri's
// imagery lacks. There is no comparable free satellite source, so the honest
// keyless answer is "no satellite", not "someone else's imagery".
const SATELLITE_STYLE = MAPTILER_KEY
  ? `https://api.maptiler.com/maps/hybrid/style.json?key=${MAPTILER_KEY}`
  : null;
const SATELLITE_AVAILABLE = !!SATELLITE_STYLE;

// AI crowd heatmap paint — matches the old Google HeatmapLayer gradient/radius/opacity.
// MapLibre heatmap-intensity: 2 ≈ Google maxIntensity: 0.5 (1/0.5 = 2× per-point contribution).
const VENUE_HEAT_PAINT = {
  'heatmap-weight': ['coalesce', ['get', 'weight'], 0.5],
  /* Radius and intensity follow zoom so the heat reads as one continuous
     field over the area instead of isolated blobs. At city zoom the points
     are pushed wide enough to merge; street zoom pulls them back in so a hot
     venue localizes to its block. The WEIGHTS stay the real crowd scores
     (score/100, set where the features are built) — coverage comes from
     radius, never from inflating what a venue actually says. */
  'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 8, 5, 12, 4, 15, 3.2, 18, 2.6],
  /* The radius is in SCREEN pixels, and a pixel covers half as much ground
     with every zoom level. A radius that shrank in pixels as the zoom grew
     (120px at 8, 40px at 18) therefore shrank on the ground by a factor of
     several thousand across a zoom gesture: a kilometre of glow at city zoom
     collapsed into the pin itself at street zoom, which is the "the heat
     looks different every time" that was reported. The exponential curve
     grows the pixel radius with zoom so the field stays roughly the size of
     a block on the ground, and the opacity hands over to the pins past zoom
     15, where each pin already carries its own crowd number and a
     full-strength blob under a single pin said nothing the pin did not. */
  'heatmap-radius': ['interpolate', ['exponential', 1.75], ['zoom'], 10, 24, 13, 55, 16, 170],
  'heatmap-opacity': ['interpolate', ['linear'], ['zoom'], 13.5, 0.85, 15.5, 0.45, 17, 0],
  'heatmap-color': [
    'interpolate', ['linear'], ['heatmap-density'],
    0,    'rgba(0, 0, 0, 0)',
    /* A quiet venue used to vanish below the 0.1 stop; low scores now stay
       visibly cool instead of invisible. */
    0.03, 'rgba(34, 197, 94, 0.4)',
    0.1,  'rgba(34, 197, 94, 0.6)',
    0.2,  'rgba(34, 197, 94, 0.7)',
    0.3,  'rgba(160, 220, 40, 0.75)',
    0.4,  'rgba(250, 204, 21, 0.8)',
    0.5,  'rgba(251, 191, 36, 0.82)',
    0.6,  'rgba(245, 158, 11, 0.85)',
    0.7,  'rgba(249, 115, 22, 0.88)',
    0.8,  'rgba(239, 68, 68, 0.9)',
    0.9,  'rgba(220, 38, 38, 0.94)',
    1,    'rgba(185, 28, 28, 0.97)',
  ],
};

// Add accuracy ring + venue heatmap + 3D buildings.
// Inserts heat UNDER the first symbol layer so road/place labels stay readable
// on top of the heat. 3D building extrusion uses the basemap's existing
// building vector tiles (free, no extra fetch) — gives the map Snap-Map-style
// city depth when zoomed in.
function addOverlayLayers(map) {
  const layers = map.getStyle().layers || [];
  const firstSymbolId = layers.find(l => l.type === 'symbol')?.id;

  if (!map.getSource('user-accuracy')) {
    map.addSource('user-accuracy', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({ id: 'user-accuracy-fill', type: 'fill', source: 'user-accuracy', paint: { 'fill-color': '#3b82f6', 'fill-opacity': 0.1 } }, firstSymbolId);
    map.addLayer({ id: 'user-accuracy-line', type: 'line', source: 'user-accuracy', paint: { 'line-color': '#3b82f6', 'line-opacity': 0.3, 'line-width': 1 } }, firstSymbolId);
  }
  if (!map.getSource('venue-heat')) {
    map.addSource('venue-heat', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({ id: 'venue-heat', type: 'heatmap', source: 'venue-heat', paint: VENUE_HEAT_PAINT }, firstSymbolId);
  }

  // 3D building extrusion. Reuses whichever building source-layer the basemap
  // exposes (CARTO/OMT call it 'building'). Skipped when basemap doesn't ship
  // building geometry (e.g. raster satellite style).
  if (!map.getLayer('flock-3d-buildings')) {
    const buildingLayer = layers.find(l => l['source-layer'] === 'building' && (l.type === 'fill' || l.type === 'fill-extrusion'));
    if (buildingLayer) {
      try {
        map.addLayer({
          id: 'flock-3d-buildings',
          source: buildingLayer.source,
          'source-layer': 'building',
          type: 'fill-extrusion',
          minzoom: 14,
          paint: {
            'fill-extrusion-color': '#243651',
            'fill-extrusion-height': [
              'interpolate', ['linear'], ['zoom'],
              14, 0,
              16, ['coalesce', ['get', 'render_height'], ['get', 'height'], 8],
            ],
            'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], ['get', 'min_height'], 0],
            'fill-extrusion-opacity': 0.75,
          },
        }, firstSymbolId);
      } catch {}
    }
  }
}

// True-meters circle as a GeoJSON polygon for the user's accuracy ring
function metersCirclePolygon(lat, lng, radiusMeters, points = 64) {
  const coords = [];
  const earthR = 6378137;
  const latRad = (lat * Math.PI) / 180;
  for (let i = 0; i <= points; i++) {
    const angle = (i / points) * Math.PI * 2;
    const dLat = (radiusMeters * Math.cos(angle)) / earthR;
    const dLng = (radiusMeters * Math.sin(angle)) / (earthR * Math.cos(latRad));
    coords.push([lng + (dLng * 180) / Math.PI, lat + (dLat * 180) / Math.PI]);
  }
  return { type: 'Feature', geometry: { type: 'Polygon', coordinates: [coords] }, properties: {} };
}

/* PINS NEVER LEAVE THEIR VENUE.

   The old answer to two pins on one spot was to push them apart: overlapping
   pins were displaced onto a spiral around their shared centroid, up to
   40*sqrt(k) screen pixels from the venue, and the whole layout was recomputed
   on every zoomend. Two things followed that a person sees at once. Every zoom
   ended with pins jumping to freshly computed spots, a frame late, so the map
   looked like it was still settling after the finger had stopped. And a pin
   could stand on a venue that was not its own, which is the one thing a map
   pin must not do.

   Now a pin is drawn exactly on its venue at every zoom, and when two would
   overlap on screen the one that matters less fades out while the survivor
   wears a small "+N" for the pins behind it. Zooming in separates the true
   positions and the hidden ones fade back. That is collision handling, which
   is what every map people trust does with its labels and its pins, and it is
   what MapLibre's own symbol layers do for theirs. The pass projects to screen
   space, so it re-runs as the map moves, throttled to one pass per animation
   frame and no more than one every PIN_OVERLAP_MIN_INTERVAL_MS; it is O(n^2)
   over a few dozen venues, which is microseconds, and it never touches a
   coordinate. */
const PIN_OVERLAP_PX = 46; // pin body is 44px; closer than this and they stack
const PIN_OVERLAP_MIN_INTERVAL_MS = 90;

/* HOW PINS SCALE WITH ZOOM. One continuous factor from PIN_SCALE_MIN at
   PIN_SCALE_FROM to full size at PIN_SCALE_TO, written to a CSS variable on
   the map container on every zoom frame and applied as a transform on each
   pin. The old three tiers (lo/mid/hi) snapped the size at zoom 13 and 15
   through a 180ms CSS transition, so a zoom gesture crossing a tier showed
   every pin resizing on its own clock, out of step with the map underneath.
   A transform is composited, so this costs one style write per frame. */
const PIN_SCALE_MIN = 0.62;
const PIN_SCALE_FROM = 12;
const PIN_SCALE_TO = 14.5;
const pinScaleForZoom = (z) => Math.max(PIN_SCALE_MIN, Math.min(1,
  PIN_SCALE_MIN + (z - PIN_SCALE_FROM) * ((1 - PIN_SCALE_MIN) / (PIN_SCALE_TO - PIN_SCALE_FROM))));

const venueMatchesCategory = (v, filterCategory) => {
  const t = (v.types || []).join(' ').toLowerCase();
  const nm = (v.name || '').toLowerCase();
  let show = true;
  if (filterCategory && filterCategory !== 'All') {
    if (filterCategory === 'Food') {
      show = t.includes('restaurant') || t.includes('cafe') || t.includes('food') || t.includes('bakery') || t.includes('meal') || t.includes('pizza') || t.includes('diner') || t.includes('bar') || t.includes('juice') || t.includes('smoothie') || t.includes('brunch') || t.includes('breakfast') || v.category === 'Food';
    } else if (filterCategory === 'Nightlife') {
      show = t.includes('bar') || t.includes('night_club') || t.includes('club') || t.includes('liquor') || t.includes('lounge') || v.category === 'Nightlife';
    } else if (filterCategory === 'Live Music') {
      show = t.includes('music') || t.includes('concert') || t.includes('performing_arts') || nm.includes('music') || nm.includes('jazz') || v.category === 'Live Music';
    } else if (filterCategory === 'Sports') {
      show = t.includes('stadium') || t.includes('gym') || t.includes('sports') || t.includes('bowling') || t.includes('fitness') || nm.includes('sport') || v.category === 'Sports';
    }
  }
  return show;
};

const applyCategoryFilter = (map, markers, filterCategory, setFilterHidesAll) => {
  let visible = 0;
  const heatFeatures = [];
  markers.forEach(({ el, venue: v }) => {
    const show = venueMatchesCategory(v, filterCategory);
    el.style.display = show ? '' : 'none';
    if (!show) return;
    visible += 1;
    const loc = v.location;
    if (loc?.latitude && loc?.longitude && typeof v.crowd === 'number') {
      heatFeatures.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [loc.longitude, loc.latitude] }, properties: { weight: v.crowd / 100 } });
    }
  });
  const heatSrc = map && map.getSource ? map.getSource('venue-heat') : null;
  if (heatSrc) heatSrc.setData({ type: 'FeatureCollection', features: heatFeatures });
  setFilterHidesAll(markers.length > 0 && visible === 0);
};

/* WHICH PIN WINS A SPOT. The active venue always; then the owner's own pin on
   the dashboard map; then the busier place; then the better-rated one; then
   a stable name order, so two equal pins do not trade places between passes. */
function pinPriority(a, b, activeId, ownerPlaceId) {
  const av = a.venue;
  const bv = b.venue;
  const act = (v) => (activeId != null && v.id === activeId ? 1 : 0);
  const own = (v) => (ownerPlaceId && v.place_id === ownerPlaceId ? 1 : 0);
  const crowd = (v) => (Number.isFinite(v.crowd) ? v.crowd : -1);
  const stars = (v) => Number(v.rating || v.stars) || 0;
  return (act(bv) - act(av))
    || (own(bv) - own(av))
    || (crowd(bv) - crowd(av))
    || (stars(bv) - stars(av))
    || String(av.name || '').localeCompare(String(bv.name || ''));
}

function resolvePinOverlaps(map, markerEntries, { activeId = null, ownerPlaceId = null, scale = 1 } = {}) {
  const entries = markerEntries.filter(({ el, venue }) => (
    el.style.display !== 'none' && venue.location?.latitude && venue.location?.longitude
  ));
  if (entries.length === 0) return;
  let pts;
  try {
    pts = entries.map(({ venue }) => map.project([venue.location.longitude, venue.location.latitude]));
  } catch { return; } // container not measured yet; the next move re-runs
  const limit = PIN_OVERLAP_PX * scale;
  const order = entries.map((_, i) => i)
    .sort((i, j) => pinPriority(entries[i], entries[j], activeId, ownerPlaceId));
  const kept = [];
  const behind = new Map(); // kept index -> pins it stands for
  for (const i of order) {
    let coveredBy = -1;
    for (const k of kept) {
      const dx = pts[k].x - pts[i].x;
      const dy = pts[k].y - pts[i].y;
      if (dx * dx + dy * dy < limit * limit) { coveredBy = k; break; }
    }
    if (coveredBy === -1) {
      kept.push(i);
    } else {
      behind.set(coveredBy, (behind.get(coveredBy) || 0) + 1);
      setPinHidden(entries[i], true);
    }
  }
  for (const k of kept) setPinHidden(entries[k], false, behind.get(k) || 0);
}

/* A covered pin fades (the marker's own opacity, so MapLibre and this file
   never fight over one style), stops taking taps, and leaves the
   accessibility tree; a survivor with pins behind it carries their count. */
function setPinHidden(entry, hidden, behind = 0) {
  const { el, marker } = entry;
  const was = el.dataset.covered === '1';
  if (hidden) {
    if (!was) {
      el.dataset.covered = '1';
      el.setAttribute('aria-hidden', 'true');
      el.style.pointerEvents = 'none';
      marker.setOpacity('0');
    }
    return;
  }
  if (was) {
    delete el.dataset.covered;
    el.removeAttribute('aria-hidden');
    el.style.pointerEvents = '';
    marker.setOpacity('1');
  }
  let badge = el.querySelector('.mlb-cluster-badge');
  if (behind > 0) {
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'mlb-cluster-badge';
      badge.setAttribute('aria-hidden', 'true');
      el.appendChild(badge);
    }
    const text = `+${behind}`;
    if (badge.textContent !== text) badge.textContent = text;
  } else if (badge) {
    badge.remove();
  }
}

const MapLibreMapView = React.memo(({ venues, filterCategory, userLocation, activeVenue, setActiveVenue, getCategoryColor, pickingVenueForCreate, setPickingVenueForCreate, setSelectedVenueForCreate, setCurrentScreen, openVenueDetail, flockMemberLocations, calcDistance, colorsDark, colorsLight, resolveVenuePhoto, NO_LOCATION_VIEW, ownerPlaceId = null, initialCenter = null, followUser = true, locationAllowed = true, mapVisible = true }) => {
  const mapRef = useRef(null);
  const mapRootRef = useRef(null);   // outermost node — see the attribution note in init
  const mapInstanceRef = useRef(null);
  const markersRef = useRef([]);
  // Read by the overlap pass and the zoom handler, which live outside React's
  // render and must not go stale between renders.
  const overlapPassRef = useRef(null);
  const pinScaleRef = useRef(1);
  const activeVenueIdRef = useRef(null);
  const ownerPlaceIdRef = useRef(null);
  activeVenueIdRef.current = activeVenue?.id ?? null;
  ownerPlaceIdRef.current = ownerPlaceId; // [{ marker, el, venue }]
  const userMarkerRef = useRef(null);
  const userElRef = useRef(null);
  const memberMarkersRef = useRef({}); // userId -> { marker, popup }
  const photoCacheRef = useRef({}); // place_id -> dataURL
  const prevActiveRef = useRef(null);
  const watchIdRef = useRef(null);
  const mapLibreRef = useRef(null); // holds the maplibre-gl module after dynamic import
  const venuesRef = useRef([]);     // latest venues for non-React consumers (toggleMapType, etc.)
  const fittedKeyRef = useRef(null); // result set the viewport was last framed to
  const [mapReady, setMapReady] = useState(false);
  // A rejected tile key or a style that never loads used to be an endless
  // spinner (Explore audit, 2026-09-05).
  const [mapFailed, setMapFailed] = useState(false);
  const mapLoadedRef = useRef(false);
  // The category filter hid every pin on the map. Rendered as a sentence,
  // because an empty map reads as broken.
  const [filterHidesAll, setFilterHidesAll] = useState(false);
  const filterCategoryRef = useRef(filterCategory);
  // Same guard as the map constructor below: a stored 'hybrid' is only honoured
  // while there is a satellite style to honour it with.
  const [mapType, setMapType] = useState(() => (
    SATELLITE_AVAILABLE && lsGet('flock_map_type') === 'hybrid' ? 'hybrid' : 'roadmap'
  ));
  /* The basemap follows the app theme. It used to be chosen ONCE, at map
     construction, so flipping to dark mode left three quarters of Discover as a
     bright blue-and-cream rectangle under navy chrome. The style is now swapped
     whenever the theme changes, and every marker colour below is read from the
     matching palette instead of the module-level light-mode constant. */
  const { isDark: mapIsDark } = useTheme();
  const mapPalette = mapIsDark ? colorsDark : colorsLight;
  const appliedDarkRef = useRef(null);

  const DEFAULT_ZOOM = 12;

  // ---------- helpers ----------
  // Resolves null when we do not know where the user is, and null means null.
  // Both branches used to resolve a fixed point in Bethlehem, Pennsylvania, so
  // a phone that declined the permission opened a map centred confidently on a
  // town it had never been to. An unknown location now opens the wide view
  // below, and the map re-pans the moment permission is granted.
  const getUserLocation = () => new Promise((resolve) => {
    if (geolocationAvailable()) {
      getCurrentPosition(
        (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
        () => resolve(null),
        { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 },
      );
    } else {
      resolve(null);
    }
  });

  // Where the map opens when nothing knows where the user is.
  //
  // This was the whole United States at zoom 3.2, chosen so it could not read
  // as a claim about where you are standing. It succeeded at that and failed at
  // everything else: a continent with no venues on it is not a screen anybody
  // can use, and it is the first thing a new install shows.
  //
  // Philadelphia instead, at city zoom. What makes that safe is the thing the
  // old fixed point in Bethlehem got wrong, and it is worth being precise about
  // the difference, because the comments elsewhere in this file are right and
  // this is not a reversal of them:
  //
  //   - `located` stays NULL. No blue dot is drawn, so nothing says you are
  //     here.
  //   - Nothing is written to flock_user_lat/lng, so the guess cannot outlive
  //     the session or bias a later search. The Bethlehem bug was permanent.
  //   - No distance is computed from it. "1.2 km away" needs a real origin and
  //     still refuses without one.
  //   - The location banner stays up and says which city is on screen.
  //
  // So it opens somewhere real and searchable rather than nowhere, and it still
  // does not pretend to know where you are. Philadelphia because that is where
  // the crowd corpus actually has coverage, so the pins carry live scores
  // instead of the "Usually busy" hedge.
  const UNKNOWN_LOCATION_VIEW = NO_LOCATION_VIEW;

  // SVG fallback pin (no photo). Inverted on the dark basemap: a navy pin body
  // on dark tiles was a hole in the map.
  const buildPinSvg = useCallback((isActive, category) => {
    const body = mapIsDark
      ? (isActive ? '#6d9ac3' : '#f1ede0')
      : (isActive ? '#2d5a87' : '#1e293b');
    const edge = mapIsDark ? '#0b1220' : '#f1ede0';
    const disc = mapIsDark ? '#0f172a' : '#ffffff';
    const initialMap = { Food: 'F', Nightlife: 'N', 'Live Music': 'M', Sports: 'S' };
    // Own-property lookup only. `initialMap[category]` answers 'constructor'
    // and '__proto__' off Object.prototype with something truthy, and the
    // result is interpolated straight into the innerHTML string below, so a
    // venue whose category arrived as one of those names drew a pin labelled
    // with the source of a native function. Same rule, same reason as `own()`
    // in website/ModerationDashboard.js.
    const initial = (Object.prototype.hasOwnProperty.call(initialMap, category) && initialMap[category]) || 'P';
    return `<svg aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 42">` +
      `<defs><filter id="s" x="-20%" y="-10%" width="140%" height="140%"><feDropShadow dx="0" dy="2" stdDeviation="2" flood-opacity="0.35"/></filter></defs>` +
      `<path d="M16 0C7.16 0 0 7.16 0 16c0 12 16 26 16 26s16-14 16-26C32 7.16 24.84 0 16 0z" fill="${body}" stroke="${edge}" stroke-width="2" filter="url(#s)"/>` +
      `<circle cx="16" cy="14.5" r="9" fill="${disc}"/>` +
      `<text x="16" y="18.5" text-anchor="middle" font-size="13" font-weight="bold" font-family="Hanken Grotesk,sans-serif" fill="${body}">${initial}</text>` +
      `</svg>`;
  }, [mapIsDark]);

  // The same initial on a disc, for a venue whose photo is on its way. The
  // photo that replaces it is round and the marker's anchor is the circle's
  // centre; a teardrop drawn under that anchor sat with its tip below the
  // venue until the photo arrived, then jumped up to the circle.
  const buildDiscSvg = useCallback((isActive, category) => {
    const body = mapIsDark
      ? (isActive ? '#6d9ac3' : '#f1ede0')
      : (isActive ? '#2d5a87' : '#1e293b');
    const edge = mapIsDark ? '#0b1220' : '#f1ede0';
    const initialMap = { Food: 'F', Nightlife: 'N', 'Live Music': 'M', Sports: 'S' };
    const initial = (Object.prototype.hasOwnProperty.call(initialMap, category) && initialMap[category]) || 'P';
    return `<svg aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 44 44">` +
      `<defs><filter id="d" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="2" stdDeviation="2" flood-opacity="0.35"/></filter></defs>` +
      `<circle cx="22" cy="22" r="20" fill="${body}" stroke="${edge}" stroke-width="2.5" filter="url(#d)"/>` +
      `<text x="22" y="28" text-anchor="middle" font-size="17" font-weight="bold" font-family="Hanken Grotesk,sans-serif" fill="${edge}">${initial}</text>` +
      `</svg>`;
  }, [mapIsDark]);

  // Circular photo pin via canvas (same trick as the old impl, returns dataURL)
  const buildPhotoPin = useCallback((photoUrl, isActive) => {
    const size = isActive ? 54 : 44;
    const border = isActive ? 3.5 : 2.5;
    const borderColor = isActive ? (mapIsDark ? '#6d9ac3' : '#2d5a87') : '#f1ede0';
    return new Promise((resolve) => {
      const canvas = document.createElement('canvas');
      const dpr = 2;
      canvas.width = size * dpr;
      canvas.height = size * dpr;
      const ctx = canvas.getContext('2d');
      ctx.scale(dpr, dpr);
      const r = size / 2;
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        ctx.beginPath();
        ctx.arc(r, r, r - 0.5, 0, Math.PI * 2);
        ctx.fillStyle = borderColor;
        ctx.fill();
        ctx.beginPath();
        ctx.arc(r, r, r - border, 0, Math.PI * 2);
        ctx.clip();
        const aspect = img.width / img.height;
        let sx = 0, sy = 0, sw = img.width, sh = img.height;
        if (aspect > 1) { sx = (img.width - img.height) / 2; sw = img.height; }
        else { sy = (img.height - img.width) / 2; sh = img.width; }
        ctx.drawImage(img, sx, sy, sw, sh, border, border, size - border * 2, size - border * 2);
        resolve(canvas.toDataURL('image/png'));
      };
      img.onerror = () => resolve(null);
      img.src = photoUrl;
    });
  }, [mapIsDark]);

  // Category ring colour. This used to read the module-level `colors`, which is
  // the LIGHT palette regardless of theme — so on the dark basemap the rings
  // were navy on near-black and the pins lost their edge entirely.
  const categoryRingColor = useCallback((cat) => {
    switch (cat) {
      case 'Food': return mapPalette.food;
      case 'Nightlife': return mapPalette.nightlife;
      case 'Live Music': return mapPalette.music;
      case 'Sports': return mapPalette.sports;
      default: return mapPalette.steel;
    }
  }, [mapPalette]);

  // Build a marker DOM element (pin or photo). The OUTER el is owned by MapLibre
  // (it sets transform every frame), so all visual styling + transitions live on
  // an INNER div. Touching transform on the outer el causes pin lag / wrong position.
  const buildMarkerEl = useCallback((venue, isActive) => {
    const el = document.createElement('div');
    el.className = 'mlb-venue-marker';
    el.style.cursor = 'pointer';
    // A NAME, so the pin exists to anything that is not a pointer. Markers are
    // built by hand outside React and had no role and no label, which made
    // every pin invisible to VoiceOver: the whole map read as an empty region
    // with a list button in the corner. The name carries the crowd number when
    // there is one, because that number is what the pin is showing.
    //
    // ON THIS OUTER ELEMENT, NOT THE CIRCLE. One build moved the role onto the
    // inner circle so the accessible frame would be the pin alone, and the
    // tree then exposed no pin at all (build 50 of the demonstration
    // recording found nothing matching "<venue>, crowd <n>"). This element is
    // the one WebKit hands to the accessibility tree; its frame includes the
    // label laid out under the circle, which is a known imprecision, not an
    // absence.
    el.setAttribute('role', 'button');
    el.setAttribute('aria-label', Number.isFinite(venue.crowd)
      ? `${venue.name}, crowd ${Math.round(venue.crowd)}`
      : `${venue.name}`);
    el.style.display = 'flex';
    el.style.flexDirection = 'column';
    el.style.alignItems = 'center';
    // No transition / transform on the outer el — MapLibre owns it.

    const inner = document.createElement('div');
    inner.className = 'mlb-marker-inner';
    inner.style.transition = 'width 0.2s ease, height 0.2s ease, box-shadow 0.2s ease';
    inner.style.willChange = 'auto';
    const size = isActive ? 54 : 44;
    inner.style.width = size + 'px';
    inner.style.height = size + 'px';
    inner.style.display = 'block';
    // The zoom scale (see PIN_SCALE_MIN) is a transform on this inner box,
    // about the point MapLibre pins to the coordinate: the tip of a teardrop,
    // the centre of a photo disc. Scaling about any other point would walk
    // the pin off its venue as the zoom changed.
    const roundPin = !!(photoCacheRef.current[venue.place_id] || venue.photo_url);
    inner.style.transformOrigin = roundPin ? 'center center' : 'bottom center';

    const ring = categoryRingColor(venue.category);
    const applyPhotoStyle = () => {
      inner.style.backgroundSize = 'cover';
      inner.style.backgroundPosition = 'center';
      inner.style.borderRadius = '50%';
      inner.style.boxShadow = `0 0 0 3px ${ring}, 0 4px 14px rgba(0,0,0,0.35)`;
    };

    const cached = photoCacheRef.current[venue.place_id];
    if (cached) {
      inner.style.backgroundImage = `url("${cached}")`;
      applyPhotoStyle();
    } else if (venue.photo_url) {
      const svg = buildDiscSvg(isActive, venue.category);
      inner.innerHTML = svg;
      const svgEl = inner.querySelector('svg');
      if (svgEl) { svgEl.setAttribute('width', size); svgEl.setAttribute('height', size); }
      /* resolveVenuePhoto, NOT the raw field. `photo_url` arrives from the
         backend as the RELATIVE path "/api/venues/photo?ref=..." and the API
         is a different origin from the web app in every environment we run
         (flockcorp.com against Railway in production, :3410 against :5210 in
         the screenshot capture). Assigned raw to img.src it resolves against
         the WEB origin, 404s, fires onerror, and buildPhotoPin resolves null,
         so the marker keeps the lettered category fallback for ever. Every
         other consumer of photo_url in this file already goes through the
         resolver; these two map-pin calls were the only ones that did not,
         which is why venue photos showed on cards and never on pins. */
      buildPhotoPin(resolveVenuePhoto(venue.photo_url), isActive).then(dataUrl => {
        if (dataUrl) {
          photoCacheRef.current[venue.place_id] = dataUrl;
          inner.innerHTML = '';
          inner.style.backgroundImage = `url("${dataUrl}")`;
          applyPhotoStyle();
        }
      });
    } else {
      const svg = buildPinSvg(isActive, venue.category);
      inner.innerHTML = svg;
      const svgEl = inner.querySelector('svg');
      if (svgEl) { svgEl.setAttribute('width', size); svgEl.setAttribute('height', Math.round(size * 1.32)); }
    }
    el.appendChild(inner);

    // Name + rating label (Apple-Maps-style). Hidden by default; CSS shows it
    // when the map container reaches data-zoom-tier="hi".
    //
    // BOTH INTERPOLATED VALUES GO THROUGH escapeHtml, and neither used to.
    //
    // The name was `.replace(/[<>]/g, '')`. Stripping is not escaping: it
    // leaves `&`, `"` and `'` alone, so a venue whose name contains `&amp;` or
    // `&copy;` is DISPLAYED decoded (the innerHTML parser resolves the
    // reference), i.e. the label shows a character the business does not have
    // in its name. escapeHtml, defined near the top of this file, is what the
    // other two innerHTML sinks here use, and its comment says why: "This must
    // be safe on its own — do NOT rely on upstream stripHtml".
    //
    // The rating was worse, and it is the reason this is a change rather than
    // a tidy-up: the old ternary called `.toFixed(1)` only when the value HAD
    // a toFixed, and interpolated it VERBATIM when it did not. A rating that
    // arrives as a string rather than a number — which is what every non-Google
    // path in this app hands us, `venue.stars` included — was raw HTML in an
    // innerHTML sink with no filter of any kind in front of it. It is coerced
    // to a number here so the non-numeric branch cannot exist, and escaped
    // anyway.
    const label = document.createElement('div');
    label.className = 'mlb-marker-label';
    // The outer element already says the name; the label under the pin would
    // say it a second time.
    label.setAttribute('aria-hidden', 'true');
    // System star via starSvgString, not a raw glyph: the label is innerHTML
    // so JSX cannot reach it, but the geometry must still be the icon set's.
    const ratingValue = Number(venue.rating || venue.stars);
    const ratingHtml = Number.isFinite(ratingValue) && ratingValue > 0
      ? `<span class="mlb-label-rating">${starSvgString(12)} ${escapeHtml(ratingValue.toFixed(1))}</span>`
      : '';
    label.innerHTML = `<span class="mlb-label-name">${escapeHtml(venue.name || '')}</span>${ratingHtml}`;
    // OUT OF THE MARKER'S BOX. The label used to be laid out under the pin
    // inside the element MapLibre positions, so that element was pin plus
    // label tall, the anchor was measured on the taller box, and the pin sat
    // above its venue by the label's height whenever the label was in the
    // tree, then dropped onto it when the tier hid the label. Absolutely
    // positioned below the pin, the box is the pin alone and the anchor (the
    // teardrop's tip, the disc's centre) is on the coordinate at every zoom.
    const under = document.createElement('div');
    under.className = 'mlb-marker-under';
    under.appendChild(label);
    el.appendChild(under);

    return el;
  }, [buildPinSvg, buildDiscSvg, buildPhotoPin, categoryRingColor, resolveVenuePhoto]);

  // ---------- init map (once) ----------
  useEffect(() => {
    if (!mapRef.current || mapInstanceRef.current) return;
    let cancelled = false;
    let resizeObs = null;
    const init = async () => {
      // The stylesheet travels with the engine, not with App.js. Both requests
      // start together so the CSS costs no extra round trip, and the map is
      // only built once the styles have landed: maplibre draws its controls,
      // attribution and popups as bare DOM, so constructing it first would
      // paint an unstyled control stack for however long the sheet took.
      //
      // Its failure is swallowed on purpose. A chunk that will not load is a
      // reason to show a map with plain controls, never a reason to show no
      // map, and the attribution stays legible either way. Order relative to
      // index.css is unchanged by this: an async CSS chunk is appended to
      // <head> after the entry stylesheet whichever import fetched it, so the
      // two `.maplibregl-ctrl-attrib` overrides in index.css still resolve
      // exactly as they did.
      const styleSheetReady = import('maplibre-gl/dist/maplibre-gl.css').catch(() => {});
      const maplibregl = (await import('maplibre-gl')).default;
      await styleSheetReady;
      mapLibreRef.current = maplibregl;
      if (cancelled) return;
      // A caller that already knows where the map should open (the venue
      // dashboard passes the venue itself) skips the geolocation prompt.
      //
      // So does a person who turned Location services off in Settings. That
      // switch used to write a flag, print "Location is turned off" on its own
      // row, and change nothing: this effect asked anyway, and so did the
      // Discover tab. A switch that reports a state it does not enforce is
      // worse than no switch, because the person believes they have already
      // handled it. UNKNOWN_LOCATION_VIEW is the same fallback a denied prompt
      // gets, so the map opens rather than sitting blank.
      const located = (initialCenter || !locationAllowed)
        ? (initialCenter ? { lat: initialCenter.lat, lng: initialCenter.lng } : null)
        : await getUserLocation();
      const userLoc = located || UNKNOWN_LOCATION_VIEW;
      if (cancelled) return;
      // Same expression as the mapType useState above, and it has to stay the
      // same one: a stored 'hybrid' from a build that HAD a MapTiler key must
      // not construct the map with a null style in one that does not.
      // localStorage outlives the env var.
      const savedMapType = SATELLITE_AVAILABLE && localStorage.getItem('flock_map_type') === 'hybrid'
        ? 'hybrid' : 'roadmap';

      // A remote basemap style (bad/missing MapTiler key, network, 403) must
      // NOT take the whole app down. A synchronous failure constructing the map
      // is caught here; the async style/tile fetch failures are swallowed by the
      // 'error' listener below. Either way Discover degrades to an empty map
      // instead of throwing up to the root error boundary.
      let map;
      try {
        map = new maplibregl.Map({
          container: mapRef.current,
          style: savedMapType === 'roadmap' ? ROADMAP_STYLE() : SATELLITE_STYLE,
          center: [userLoc.lng, userLoc.lat],
          zoom: located ? DEFAULT_ZOOM : UNKNOWN_LOCATION_VIEW.zoom,
          minZoom: 3,
          maxZoom: 18,
          // Attribution added manually below at bottom-left (compact) so it
          // never collides with the View-All pill anchored bottom-right.
          attributionControl: false,
          // Snap-style smoothness
          fadeDuration: 200,
          antialias: true,
        });
      } catch (err) {
        console.warn('[Map] Failed to initialize basemap:', err?.message || err);
        return;
      }
      // Without a listener, MapLibre surfaces style/tile load errors (bad key,
      // network) rather than failing quietly. Swallow them so a broken basemap
      // leaves Discover usable.
      map.on('error', (e) => {
        console.warn('[Map]', e?.error?.message || e?.error || e);
        const status = Number(e?.error?.status);
        if (!mapLoadedRef.current && (status === 401 || status === 403)) setMapFailed(true);
      });
      setTimeout(() => { if (!mapLoadedRef.current) setMapFailed(true); }, 12000);
      map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-left');

      // KEYBOARD ORDER. MapLibre injects its control containers as the FIRST
      // children of the map element, and the map element is the first child of
      // this screen — so the attribution disclosure and its two credit links
      // were the first three tab stops a keyboard user hit, ahead of every
      // Flock control, every time the map was on screen. The credit still has
      // to be reachable (OSM's licence requires it), so it is moved rather than
      // removed: the container becomes the LAST child of the component root, so
      // it is the last tab stop instead of the first. It is absolutely
      // positioned bottom-left against a full-bleed parent either way, so it
      // does not move on screen. The compact disclosure toggle itself is
      // purely visual, so it drops out of the tab sequence (still clickable).
      try {
        const attrib = mapRef.current && mapRef.current.querySelector('.maplibregl-ctrl-bottom-left');
        if (attrib && mapRootRef.current) {
          mapRootRef.current.appendChild(attrib);
          const toggle = attrib.querySelector('.maplibregl-ctrl-attrib-button');
          if (toggle) toggle.setAttribute('tabindex', '-1');
        }
      } catch { /* attribution stays where MapLibre put it */ }
      mapInstanceRef.current = map;
      // RIG-ONLY INTROSPECTION. scripts/capture-screenshots.mjs sets this
      // flag before the page loads so it can project each venue's coordinate
      // and measure the pin standing on it, at rest and mid-zoom. Nothing in
      // production sets the flag, so nothing in production reaches this.
      if (typeof window !== 'undefined' && window.__FLOCK_MAP_DEBUG__) {
        window.__flockMapDebug = {
          getZoom: () => map.getZoom(),
          zoomTo: (z, duration) => map.zoomTo(z, { duration, essential: true }),
          project: (lng, lat) => { const p = map.project([lng, lat]); return { x: p.x, y: p.y }; },
          container: () => mapRef.current,
          markers: () => markersRef.current.map(({ venue, el }) => ({
            id: venue.place_id || venue.id,
            lng: venue.location.longitude,
            lat: venue.location.latitude,
            el,
          })),
        };
      }

      // Snappier scroll-wheel zoom — default 1/300 feels sluggish vs Snap Map.
      if (map.scrollZoom) {
        map.scrollZoom.setZoomRate(1 / 100);   // 3× faster per pixel
        map.scrollZoom.setWheelZoomRate(1 / 80); // 5× faster per wheel notch
      }

      // Track container size — MapLibre locks canvas dimensions at construction,
      // so if the parent flex layout settles AFTER init the canvas stays short
      // (leaves a navy gap below the map). ResizeObserver fixes that for good
      // and also handles orientation changes / window resize.
      if (typeof ResizeObserver !== 'undefined') {
        resizeObs = new ResizeObserver(() => { try { map.resize(); } catch {} });
        resizeObs.observe(mapRef.current);
      } else {
        // Fallback: nudge once after layout settles
        setTimeout(() => { try { map.resize(); } catch {} }, 0);
      }

      // Tier the map's container by zoom so CSS can scale + label markers
      // without re-rendering the React tree on every wheel notch.
      const applyZoomTier = () => {
        const z = map.getZoom();
        const container = mapRef.current;
        if (!container) return;
        // hi  → labels visible
        // mid / lo → no labels
        // Size is no longer a tier: it is the continuous --pin-scale below.
        const tier = z >= 15 ? 'hi' : z >= 13 ? 'mid' : 'lo';
        if (container.dataset.zoomTier !== tier) container.dataset.zoomTier = tier;
        const scale = pinScaleForZoom(z);
        if (Math.abs(scale - pinScaleRef.current) > 0.002) {
          pinScaleRef.current = scale;
          container.style.setProperty('--pin-scale', scale.toFixed(3));
        }
      };

      // Brighten native basemap POI labels (MapTiler's Streets v2 Dark dims them
      // hard, which is why the map feels emptier than Apple's). We bump opacity
      // and lower the minzoom so cafés/restaurants show earlier.
      const boostNativePoiLabels = () => {
        if (!isAppDark()) return; // pale-label boost is tuned for the dark basemap only
        const style = map.getStyle && map.getStyle();
        if (!style?.layers) return;
        for (const layer of style.layers) {
          if (layer.type !== 'symbol') continue;
          const id = layer.id || '';
          const sl = layer['source-layer'] || '';
          const looksPoi = /poi|place_label/i.test(id) || /poi|place/i.test(sl);
          if (!looksPoi) continue;
          try {
            map.setLayoutProperty(layer.id, 'visibility', 'visible');
            // Lower the zoom at which labels appear (default ~14 → 12.5)
            if (typeof layer.minzoom === 'number' && layer.minzoom > 12.5) {
              map.setLayerZoomRange(layer.id, 12.5, layer.maxzoom ?? 24);
            }
            map.setPaintProperty(layer.id, 'text-opacity', 0.95);
            map.setPaintProperty(layer.id, 'text-color', '#e2e8f0');
            map.setPaintProperty(layer.id, 'text-halo-color', 'rgba(15,23,42,0.85)');
            map.setPaintProperty(layer.id, 'text-halo-width', 1.4);
          } catch { /* layer may not support a property — ignore */ }
        }
      };

      map.on('load', () => {
        addOverlayLayers(map);
        applyZoomTier();
        boostNativePoiLabels();
        mapLoadedRef.current = true;
        setMapReady(true);
      });

      // Re-apply both on style swap (roadmap ↔ satellite)
      map.on('styledata', () => {
        applyZoomTier();
        boostNativePoiLabels();
      });

      map.on('zoom', applyZoomTier);

      // Which pins are visible where two share a spot, re-decided as the view
      // moves: at most one pass per animation frame and per
      // PIN_OVERLAP_MIN_INTERVAL_MS while the map is in motion, and one more
      // when it settles. Pins are never moved by this (see resolvePinOverlaps).
      let overlapTimer = 0;
      let lastOverlapAt = 0;
      const overlapPass = () => {
        overlapTimer = 0;
        lastOverlapAt = performance.now();
        resolvePinOverlaps(map, markersRef.current, {
          activeId: activeVenueIdRef.current,
          ownerPlaceId: ownerPlaceIdRef.current,
          scale: pinScaleRef.current,
        });
      };
      const scheduleOverlapPass = () => {
        if (overlapTimer) return;
        const wait = Math.max(0, PIN_OVERLAP_MIN_INTERVAL_MS - (performance.now() - lastOverlapAt));
        overlapTimer = window.setTimeout(() => window.requestAnimationFrame(overlapPass), wait);
      };
      overlapPassRef.current = overlapPass;
      map.on('move', scheduleOverlapPass);
      map.on('moveend', overlapPass);

      // Click on empty map — clear active venue
      map.on('click', (e) => {
        if (e.originalEvent?.target?.closest?.('.mlb-venue-marker')) return;
        setActiveVenue(null);
      });

      // Re-pan when geolocation permission flips to granted
      if (followUser && navigator.permissions) {
        navigator.permissions.query({ name: 'geolocation' }).then((perm) => {
          perm.addEventListener('change', () => {
            if (perm.state === 'granted') {
              getCurrentPosition(
                (pos) => mapEase(map, { center: [pos.coords.longitude, pos.coords.latitude], zoom: DEFAULT_ZOOM }),
                () => {},
                { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 },
              );
            }
          });
        }).catch(() => {});
      }
    };
    init();
    return () => { cancelled = true; if (resizeObs) resizeObs.disconnect(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /* setStyle throws away every source and layer the app added, so anything
     Flock owns has to go back on afterwards. Shared by the satellite toggle and
     the light/dark swap below. (HTML markers survive a style swap; sources and
     layers do not.) */
  const rehydrateAfterStyleSwap = useCallback((map) => {
    addOverlayLayers(map);
    // Re-feed accuracy data
    if (userLocation) {
      const src = map.getSource('user-accuracy');
      if (src) src.setData({ type: 'FeatureCollection', features: [metersCirclePolygon(userLocation.lat, userLocation.lng, userLocation.accuracy || 50)] });
    }
    // Re-feed heatmap data from current venues
    const heatSrc = map.getSource('venue-heat');
    if (heatSrc) {
      const features = (venuesRef.current || [])
        .filter(v => typeof v.crowd === 'number' && v.location?.latitude && v.location?.longitude)
        .map(v => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [v.location.longitude, v.location.latitude] }, properties: { weight: v.crowd / 100 } }));
      heatSrc.setData({ type: 'FeatureCollection', features });
    }
  }, [userLocation]);

  // ---------- map type toggle (vector dark <-> satellite) ----------
  const toggleMapType = useCallback(async () => {
    const map = mapInstanceRef.current;
    if (!map) return;
    // No satellite style, no swap. The button is hidden in this case, so this is
    // the belt to that braces.
    if (!SATELLITE_AVAILABLE) return;
    const newType = mapType === 'roadmap' ? 'hybrid' : 'roadmap';
    setMapType(newType);
    localStorage.setItem('flock_map_type', newType);
    queueSync({ mapType: newType });
    map.setStyle(newType === 'roadmap' ? ROADMAP_STYLE(mapIsDark) : SATELLITE_STYLE);
    map.once('styledata', () => rehydrateAfterStyleSwap(map));
  }, [mapType, mapIsDark, rehydrateAfterStyleSwap]);

  // ---------- basemap follows the app theme ----------
  useEffect(() => {
    const map = mapInstanceRef.current;
    if (!mapReady || !map) return;
    // First pass records the theme the map was constructed with; only a real
    // change after that costs a style fetch.
    if (appliedDarkRef.current === null) { appliedDarkRef.current = mapIsDark; return; }
    if (appliedDarkRef.current === mapIsDark) return;
    appliedDarkRef.current = mapIsDark;
    if (mapType !== 'roadmap') return; // satellite imagery has no light/dark twin
    map.setStyle(ROADMAP_STYLE(mapIsDark));
    map.once('styledata', () => rehydrateAfterStyleSwap(map));
  }, [mapIsDark, mapReady, mapType, rehydrateAfterStyleSwap]);

  // ---------- user blue dot + accuracy ring ----------
  useEffect(() => {
    const map = mapInstanceRef.current;
    if (!mapReady || !map) return;
    if (!userLocation) {
      // Location switched off: the dot and its ring go too, or the banner
      // says the map does not show where you are while it plainly does
      // (Explore audit, 2026-09-05).
      if (userMarkerRef.current) {
        userMarkerRef.current.remove();
        userMarkerRef.current = null;
        userElRef.current = null;
      }
      const ring = map.getSource('user-accuracy');
      if (ring) ring.setData({ type: 'FeatureCollection', features: [] });
      return;
    }
    const lng = userLocation.lng, lat = userLocation.lat;
    const acc = userLocation.accuracy || 50;

    // Blue dot — outer el is owned by MapLibre; pulse animations target the inner div.
    if (!userMarkerRef.current) {
      const el = document.createElement('div');
      el.style.width = '20px';
      el.style.height = '20px';
      const inner = document.createElement('div');
      inner.className = 'mlb-user-dot-inner';
      inner.style.width = '20px';
      inner.style.height = '20px';
      inner.style.borderRadius = '50%';
      inner.style.background = '#3b82f6';
      inner.style.border = '3px solid #fff';
      inner.style.boxShadow = '0 0 0 3px rgba(59,130,246,0.25)';
      inner.style.transition = 'box-shadow 0.4s ease';
      el.appendChild(inner);
      userElRef.current = inner; // pulse helper writes to the inner div
      const ml = mapLibreRef.current;
      if (!ml) return;
      userMarkerRef.current = new ml.Marker({ element: el, anchor: 'center', subpixelPositioning: true }).setLngLat([lng, lat]).addTo(map);
    } else {
      userMarkerRef.current.setLngLat([lng, lat]);
    }

    // Accuracy circle data
    const src = map.getSource('user-accuracy');
    if (src) {
      src.setData({ type: 'FeatureCollection', features: [metersCirclePolygon(lat, lng, acc)] });
    }
  }, [userLocation, mapReady]);

  // Live position tracking.
  //
  // THE THIRD DOOR INTO THE OS LOCATION PROMPT, and the one the Settings switch
  // did not close. watchPosition asks the device exactly as getCurrentPosition
  // does, so with "Location services" turned off this effect ran the moment the
  // map was ready and the prompt arrived anyway, over a map the person had
  // already told the app not to locate them on. The init effect above and the
  // Discover tab both check the switch; this one was written before it existed
  // and nothing pointed it at the flag.
  //
  // Same gate, same name, so the three doors are one rule rather than three
  // similar ones. followUser stays in the condition: it is the separate
  // question of whether THIS map is the one that follows you, and a venue
  // dashboard map answers no to it whatever the switch says.
  //
  // AND ON THE MAP BEING ON SCREEN, which it was not, and that cost battery
  // for the rest of the session. Discover is never unmounted once visited --
  // it is parked behind visibility:hidden so returning to it is instant -- so
  // this armed watchPosition with enableHighAccuracy on the first visit and
  // never released it. Every fix after that moved a marker and rebuilt a
  // 64-point accuracy polygon on a map nobody could see, and if the person was
  // also sharing their location there were two full-precision watches running
  // at once. The member-marker effect below is gated exactly this way and says
  // why; this one was written before that pass and was missed by it.
  //
  // Nothing is lost by stopping: no React state is written from here, the
  // app's own userLocation is fed independently, and coming back to Discover
  // re-arms and reconciles in one go.
  useEffect(() => {
    if (!mapVisible || !mapReady || !followUser || !locationAllowed || !geolocationAvailable()) return;
    if (watchIdRef.current !== null) clearWatch(watchIdRef.current);
    watchIdRef.current = watchPosition(
      (pos) => {
        const map = mapInstanceRef.current;
        if (!map) return;
        const lat = pos.coords.latitude, lng = pos.coords.longitude;
        if (userMarkerRef.current) userMarkerRef.current.setLngLat([lng, lat]);
        const src = map.getSource('user-accuracy');
        if (src) src.setData({ type: 'FeatureCollection', features: [metersCirclePolygon(lat, lng, pos.coords.accuracy || 50)] });
      },
      () => {},
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 10000 },
    );
    return () => { if (watchIdRef.current !== null) clearWatch(watchIdRef.current); };
  }, [mapVisible, mapReady, followUser, locationAllowed]);

  // ---------- venue markers ----------
  useEffect(() => {
    const map = mapInstanceRef.current;
    if (!mapReady || !map) return;

    const ml = mapLibreRef.current;
    if (!ml) return;
    venuesRef.current = venues;

    // Clear previous markers
    markersRef.current.forEach(({ marker }) => marker.remove());
    markersRef.current = [];

    const heatFeatures = [];
    venues.forEach(v => {
      const loc = v.location;
      if (!loc?.latitude || !loc?.longitude) return;
      const shown = venueMatchesCategory(v, filterCategoryRef.current);

      // Heatmap point — weighted by crowd score (0-100 → 0-1)
      if (shown && typeof v.crowd === 'number') {
        heatFeatures.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [loc.longitude, loc.latitude] },
          properties: { weight: v.crowd / 100 },
        });
      }

      const isActive = activeVenue?.id === v.id;
      const el = buildMarkerEl(v, isActive);
      if (ownerPlaceId && v.place_id === ownerPlaceId) {
        // The dashboard map marks the owner's own pin with a permanent chip
        // so they can spot themselves without zooming to the label tier.
        el.style.zIndex = '2';
        const chip = document.createElement('div');
        chip.className = 'mlb-owner-chip';
        chip.textContent = 'Your venue';
        chip.style.background = mapIsDark ? '#f1ede0' : '#1e293b';
        chip.style.color = mapIsDark ? '#1e293b' : '#f1ede0';
        (el.querySelector('.mlb-marker-under') || el).appendChild(chip);
      }
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        setActiveVenue(v);
        mapEase(map, { center: [loc.longitude, loc.latitude], zoom: Math.max(map.getZoom(), 15), duration: 600 });
      });
      const anchor = (photoCacheRef.current[v.place_id] || v.photo_url) ? 'center' : 'bottom';
      if (!shown) el.style.display = 'none';
      const marker = new ml.Marker({ element: el, anchor, subpixelPositioning: true }).setLngLat([loc.longitude, loc.latitude]).addTo(map);
      markersRef.current.push({ marker, el, venue: v });
    });
    setFilterHidesAll(venues.length > 0 && markersRef.current.every(({ el }) => el.style.display === 'none'));

    // Push heat data to the source
    const heatSrc = map.getSource('venue-heat');
    if (heatSrc) heatSrc.setData({ type: 'FeatureCollection', features: heatFeatures });

    // Settle which pins are visible where two share a spot. The map's own
    // move handler re-runs this as the view changes.
    if (overlapPassRef.current) overlapPassRef.current();

    /* FRAME THE RESULTS. The map opened centred on the user at a fixed zoom,
       so a search could return 20 venues and show none of them: the chip said
       "All 20 results" over what looked like an empty map. Fit the viewport to
       the pins whenever the RESULT SET changes (not on every render, or a
       pan would snap back under the user's finger). maxZoom keeps a single
       result from diving to street level. */
    const key = venues.map(v => v.place_id || v.id).join(',');
    if (key === fittedKeyRef.current) return;
    fittedKeyRef.current = key;

    const points = venues
      .filter(v => v.location?.latitude && v.location?.longitude)
      .map(v => [v.location.longitude, v.location.latitude]);
    if (points.length === 0) return;

    /* Places sometimes returns one result on the other side of the country
       (a search around Bethlehem PA came back with a shop in California).
       Fitting to the raw extent then zooms out to the whole continent, which
       is a worse empty map than the one this is fixing. So fit to the CLUSTER:
       take the median point and drop anything absurdly far from it. The
       outlier keeps its pin and its place in the list; it just does not get
       to decide the viewport. */
    const sortedLng = points.map(p => p[0]).slice().sort((a, b) => a - b);
    const sortedLat = points.map(p => p[1]).slice().sort((a, b) => a - b);
    const midLng = sortedLng[sortedLng.length >> 1];
    const midLat = sortedLat[sortedLat.length >> 1];
    const kmFromMid = ([lng, lat]) => Math.hypot(
      (lng - midLng) * 111 * Math.cos(midLat * Math.PI / 180),
      (lat - midLat) * 111,
    );
    const sortedDist = points.map(kmFromMid).sort((a, b) => a - b);
    const medianDist = sortedDist[sortedDist.length >> 1] || 0;
    const limitKm = Math.max(15, medianDist * 4);
    let core = points.filter(p => kmFromMid(p) <= limitKm);
    if (core.length < 2) core = points;

    const bounds = core.reduce(
      (b, p) => b.extend(p),
      new ml.LngLatBounds(core[0], core[0]),
    );
    try {
      map.fitBounds(bounds, {
        padding: { top: 90, bottom: 190, left: 40, right: 40 }, // search bar above, venue cards below
        maxZoom: 15,
        duration: 600,
      });
    } catch { /* container not measured yet — the next result set re-fits */ }
  }, [venues, mapReady, buildMarkerEl, ownerPlaceId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------- active venue highlight (only resize the 2 changed markers) ----------
  useEffect(() => {
    const prevId = prevActiveRef.current;
    const newId = activeVenue?.id;
    if (prevId === newId) return;
    prevActiveRef.current = newId;
    markersRef.current.forEach(({ el, venue }) => {
      if (venue.id !== prevId && venue.id !== newId) return;
      const isActive = venue.id === newId;
      const size = isActive ? 54 : 44;
      const inner = el.querySelector('.mlb-marker-inner') || el;
      inner.style.width = size + 'px';
      inner.style.height = size + 'px';
      // Tiny z-index range — the venue card overlay must always sit above markers.
      // (Active = 3, top rated = 2, normal = 1.)
      el.style.zIndex = isActive ? '3' : (venue.topRated ? '2' : '1');
      const svgEl = inner.querySelector('svg');
      if (svgEl) {
        svgEl.setAttribute('width', size);
        svgEl.setAttribute('height', Math.round(size * 1.32));
      } else if (photoCacheRef.current[venue.place_id] && isActive && venue.photo_url) {
        buildPhotoPin(resolveVenuePhoto(venue.photo_url), true).then(dataUrl => {
          if (dataUrl) {
            photoCacheRef.current[venue.place_id] = dataUrl;
            inner.style.backgroundImage = `url("${dataUrl}")`;
          }
        });
      }
    });
  }, [activeVenue, buildPhotoPin, resolveVenuePhoto]);

  // ---------- category filter (toggle visibility) ----------
  useEffect(() => {
    filterCategoryRef.current = filterCategory;
    applyCategoryFilter(mapInstanceRef.current, markersRef.current, filterCategory, setFilterHidesAll);
    if (overlapPassRef.current) overlapPassRef.current();
  }, [filterCategory]);

  // ---------- external imperative API ----------
  useEffect(() => {
    const map = mapInstanceRef.current;

    window.__flockOpenVenue = (placeId) => {
      const v = venues.find(venue => venue.place_id === placeId);
      if (v) openVenueDetail(placeId, { name: v.name, formatted_address: v.addr, place_id: placeId, rating: v.stars, photo_url: v.photo_url });
    };

    window.__flockPanToVenue = (target) => {
      if (!map) return;
      const placeId = typeof target === 'string' ? target : target?.place_id;
      const fLat = typeof target === 'object' ? parseFloat(target?.lat) : NaN;
      const fLng = typeof target === 'object' ? parseFloat(target?.lng) : NaN;

      const entry = placeId ? markersRef.current.find(e => e.venue.place_id === placeId) : null;
      if (entry) {
        const loc = entry.venue.location;
        mapEase(map, { center: [loc.longitude, loc.latitude], zoom: 17, duration: 700 });
        setActiveVenue(entry.venue);
        // Bounce — animate the INNER div's top offset (outer transform is MapLibre's)
        const inner = entry.el.querySelector('.mlb-marker-inner');
        if (inner) {
          inner.style.transition = 'top 0.4s cubic-bezier(0.34, 1.56, 0.64, 1)';
          inner.style.position = 'relative';
          inner.style.top = '-12px';
          setTimeout(() => { inner.style.top = '0px'; }, 250);
          setTimeout(() => { inner.style.transition = 'width 0.2s ease, height 0.2s ease, box-shadow 0.2s ease'; inner.style.position = ''; inner.style.top = ''; }, 700);
        }
      } else if (!isNaN(fLat) && !isNaN(fLng)) {
        mapEase(map, { center: [fLng, fLat], zoom: 17, duration: 700 });
        const nearby = markersRef.current.find(e => {
          const loc = e.venue.location;
          if (!loc) return false;
          const d = Math.sqrt(Math.pow(loc.latitude - fLat, 2) + Math.pow(loc.longitude - fLng, 2)) * 111000;
          return d < 100;
        });
        if (nearby) {
          setActiveVenue(nearby.venue);
        } else {
          // Drop a temp pin
          const venueName = target?.name || 'Venue';
          const venueAddr = target?.address || '';
          // A rating only exists if Google gave us one. It used to default to
          // 4.0, which renders next to a star as if it were measured.
          const venueRating = target?.rating ? parseFloat(target.rating) : null;
          const venuePhoto = target?.photo_url || null;
          // Crowd, price and "best time" were all derived from the first
          // character of the venue name plus its latitude. That is the third
          // instance of the invented-number pattern in this file; the other two
          // carry comments saying so. Nothing here is measured, so nothing here
          // gets a number. The real score arrives with the crowd fetch.
          const tempVenue = {
            id: 'temp_nav_' + Date.now(),
            place_id: placeId || null,
            name: venueName,
            addr: venueAddr,
            type: target?.types?.[0] ? target.types[0].replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : 'Place',
            category: (() => { const tt = (target?.types || []).join(' ').toLowerCase(); if (tt.includes('bar') || tt.includes('night_club')) return 'Nightlife'; if (tt.includes('restaurant') || tt.includes('cafe') || tt.includes('food') || tt.includes('diner') || tt.includes('juice')) return 'Food'; return 'Food'; })(),
            price: null,
            stars: venueRating,
            crowd: null,
            topRated: false,
            photo_url: venuePhoto,
            location: { latitude: fLat, longitude: fLng },
            types: [],
          };
          const ml = mapLibreRef.current;
          if (ml) {
            const el = buildMarkerEl(tempVenue, true);
            el.addEventListener('click', (e) => { e.stopPropagation(); setActiveVenue(tempVenue); mapEase(map, { center: [fLng, fLat], zoom: 17 }); });
            const anchor = venuePhoto ? 'center' : 'bottom';
            const marker = new ml.Marker({ element: el, anchor, subpixelPositioning: true }).setLngLat([fLng, fLat]).addTo(map);
            markersRef.current.push({ marker, el, venue: tempVenue });
          }
          setActiveVenue(tempVenue);
          if (placeId) openVenueDetail(placeId, { name: venueName, formatted_address: venueAddr, place_id: placeId, rating: venueRating, photo_url: venuePhoto });
        }
      }
    };

    window.__flockGoToMyLocation = () => {
      // READ THE REF AT CLICK TIME, not the `map` this effect closed over.
      // The map is built in a different, async effect (behind `await
      // import('maplibre-gl')`), so on first mount this one can run first and
      // capture null. A ref assignment does not re-run an effect, so the only
      // thing that heals it is one of this effect's own dependencies changing
      // identity afterwards -- normally `venues` arriving, which is why the
      // button usually works. Let the venue list settle before the maplibre
      // chunk resolves and nothing else changes, and the button is inert for
      // the rest of the session with no way to tell from the outside. Zoom in
      // and Zoom out, twenty lines below, already read the ref at click time;
      // this was the one control that did not.
      const liveMap = mapInstanceRef.current;
      if (!liveMap) return;
      if (userMarkerRef.current) {
        const ll = userMarkerRef.current.getLngLat();
        mapEase(liveMap, { center: [ll.lng, ll.lat], zoom: 15, duration: 600 });
        // Pulse the dot — box-shadow on the inner div only (transform is owned by MapLibre on the outer)
        if (userElRef.current) {
          userElRef.current.style.boxShadow = '0 0 0 12px rgba(59,130,246,0.35)';
          setTimeout(() => {
            if (userElRef.current) userElRef.current.style.boxShadow = '0 0 0 3px rgba(59,130,246,0.25)';
          }, 500);
        }
        return;
      }
      const center = liveMap.getCenter();
      if (center) mapEase(liveMap, { center: [center.lng, center.lat], zoom: 15 });
    };

    return () => { delete window.__flockOpenVenue; delete window.__flockPanToVenue; delete window.__flockGoToMyLocation; };
  }, [venues, openVenueDetail, setActiveVenue, buildMarkerEl]);

  // ---------- flock member live location markers ----------
  //
  // GATED ON THE MAP BEING ON SCREEN. Discover is never unmounted once it has
  // been visited -- it is parked behind visibility:hidden so returning to it is
  // instant -- which meant this effect went on doing real work for the rest of
  // the session. Every sharing member emits a position every ten seconds, and
  // each tick parsed an HTML string into a popup and moved a MapLibre marker,
  // on the main thread, behind a hidden layer, while the person was reading a
  // chat. That is exactly when people share location, so the cost landed at the
  // worst possible moment.
  //
  // `mapVisible` is in the dependency list, so nothing is lost: returning to
  // Discover re-runs this pass against the current data and reconciles in one
  // go, including removing anyone who stopped sharing while it was hidden.
  useEffect(() => {
    const map = mapInstanceRef.current;
    if (!mapVisible || !mapReady || !map || !flockMemberLocations) return;
    const ml = mapLibreRef.current;
    if (!ml) return;
    const run = (mlMod) => {
      const currentIds = new Set(Object.keys(flockMemberLocations));
      // Remove gone
      Object.keys(memberMarkersRef.current).forEach(uid => {
        if (!currentIds.has(uid)) {
          memberMarkersRef.current[uid].marker.remove();
          delete memberMarkersRef.current[uid];
        }
      });
      Object.entries(flockMemberLocations).forEach(([uid, loc]) => {
        const lng = loc.lng, lat = loc.lat;
        const initial = escapeHtml((loc.name || '?')[0].toUpperCase());
        const dist = userLocation ? calcDistance(userLocation.lat, userLocation.lng, loc.lat, loc.lng) : '';
        const age = Math.round((Date.now() - loc.timestamp) / 1000);
        const ageStr = age < 10 ? 'just now' : age < 60 ? `${age}s ago` : `${Math.round(age / 60)}m ago`;
        const popupHtml = `<div style="font-family:'Hanken Grotesk',-apple-system,system-ui,sans-serif;display:flex;align-items:center;gap:10px;padding:6px 4px;min-width:160px">
          <div style="width:36px;height:36px;border-radius:18px;background:linear-gradient(135deg,#1e293b,#1a3a5c);display:flex;align-items:center;justify-content:center;flex-shrink:0">
            <span style="color:white;font-size:15px;font-weight:700">${initial}</span>
          </div>
          <div style="flex:1;min-width:0">
            <div style="font-size:13px;font-weight:700;color:#1e293b;margin:0 0 2px">${escapeHtml(loc.name)}</div>
            <div style="display:flex;align-items:center;gap:4px">
              <span style="width:6px;height:6px;border-radius:3px;background:#22c55e;display:inline-block"></span>
              <span style="font-size: 12px;color:#4b5563;font-weight:500">${dist ? dist + ' away · ' + ageStr : 'Live'}</span>
            </div>
          </div>
        </div>`;

        if (memberMarkersRef.current[uid]) {
          memberMarkersRef.current[uid].marker.setLngLat([lng, lat]);
          if (memberMarkersRef.current[uid].popup) memberMarkersRef.current[uid].popup.setHTML(popupHtml);
        } else {
          const el = document.createElement('div');
          el.style.width = '40px';
          el.style.height = '40px';
          el.style.cursor = 'pointer';
          el.innerHTML = `<svg aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40">
            <circle cx="20" cy="20" r="18" fill="#1e293b" stroke="white" stroke-width="3"/>
            <circle cx="20" cy="20" r="18" fill="none" stroke="#22c55e" stroke-width="2" stroke-dasharray="4 4" opacity="0.6"/>
            <text x="20" y="26" text-anchor="middle" fill="white" font-size="16" font-weight="bold" font-family="Hanken Grotesk,sans-serif">${initial}</text>
          </svg>`;
          const popup = new mlMod.Popup({ offset: 25, closeButton: false }).setHTML(popupHtml);
          const marker = new mlMod.Marker({ element: el, anchor: 'center', subpixelPositioning: true }).setLngLat([lng, lat]).setPopup(popup).addTo(map);
          memberMarkersRef.current[uid] = { marker, popup };
        }
      });
    };
    run(ml);
  }, [mapVisible, mapReady, flockMemberLocations, userLocation, calcDistance]);

  // ---------- render ----------
  return (
    <div ref={mapRootRef} style={{ position: 'absolute', inset: 0 }}>
      {mapReady && filterHidesAll && filterCategory && filterCategory !== 'All' && (
        <p role="status" style={{ position: 'absolute', top: '10px', left: '50%', transform: 'translateX(-50%)', zIndex: 20, margin: 0, padding: '8px 12px', borderRadius: '10px', backgroundColor: 'var(--bg-card-solid)', border: '1px solid var(--border-default)', color: 'var(--text-secondary)', fontSize: 'var(--t-meta)', whiteSpace: 'nowrap' }}>No {filterCategory.toLowerCase()} spots on this map. Pick another filter or move the map.</p>
      )}
      {!mapReady && mapFailed && (
        <div style={{ position: 'absolute', inset: 0, zIndex: 10, backgroundColor: '#1a2a3a', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '24px', textAlign: 'center' }}>
          <p style={{ color: '#8ec3b9', fontSize: 'var(--t-label)', fontWeight: '500', margin: 0 }}>The map could not load. Search still works.</p>
        </div>
      )}
      {!mapReady && !mapFailed && (
        <div style={{ position: 'absolute', inset: 0, zIndex: 10, backgroundColor: '#1a2a3a', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '12px' }}>
          <div style={{ width: '32px', height: '32px', border: '3px solid rgba(255,255,255,0.15)', borderTopColor: '#6d9ac3', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
          <p style={{ color: '#8ec3b9', fontSize: 'var(--t-label)', fontWeight: '500', margin: 0 }}>Loading map...</p>
        </div>
      )}
      <style>{`
        /* opacity 0.4 on top of grey-on-white put the legally-required credit
           well under 4.5:1. Full opacity; MapLibre's own colours are readable. */
        .maplibregl-ctrl-attrib { font-size: 12px !important; opacity: 1; }
        .maplibregl-ctrl-attrib a { color: #33475e; }
        .maplibregl-ctrl-logo { display: none !important; }
        .mlb-venue-marker { user-select: none; -webkit-user-select: none; transition: opacity 0.16s ease; }
        /* The zoom scale, about the point pinned to the coordinate (set per
           pin: the teardrop's tip, the disc's centre). No transition: the map
           moves under the finger and the pin has to move with it, not 180ms
           behind it. */
        .mlb-marker-inner { transform: scale(var(--pin-scale, 1)); }
        /* Everything drawn under a pin lives outside the box MapLibre
           measures, so the anchor is the pin and nothing else. */
        .mlb-marker-under {
          position: absolute;
          top: 100%;
          left: 50%;
          transform: translateX(-50%);
          /* Sized to its content, not to the 44px pin it hangs from: an
             absolute box shrinks to fit its containing block, and with the
             pin as that block every name wrapped to two letters. */
          width: max-content;
          display: flex;
          flex-direction: column;
          align-items: center;
          pointer-events: none;
        }
        /* The pins a survivor stands for, when two shared one spot. */
        .mlb-cluster-badge {
          position: absolute;
          top: -4px;
          right: -8px;
          min-width: 18px;
          height: 18px;
          padding: 0 5px;
          border-radius: 9px;
          background: #f1ede0;
          color: #1e293b;
          font-family: 'Hanken Grotesk', system-ui, -apple-system, sans-serif;
          font-size: 11px;
          font-weight: 800;
          line-height: 18px;
          text-align: center;
          box-shadow: 0 1px 4px rgba(0,0,0,0.35);
          pointer-events: none;
        }
        /* Markers must never bleed above overlay UI (venue cards, sheets, etc.) */
        .maplibregl-marker { z-index: 1; }
        .maplibregl-canvas-container { z-index: 0; }

        /* ---- Apple-Maps-style name label under each pin ---- */
        .mlb-marker-label {
          margin-top: 4px;
          padding: 3px 7px;
          border-radius: 8px;
          background: rgba(15,23,42,0.78);
          backdrop-filter: blur(8px);
          -webkit-backdrop-filter: blur(8px);
          color: #f1f5f9;
          font-family: 'Hanken Grotesk', system-ui, -apple-system, sans-serif;
          font-size: 12px;
          font-weight: 700;
          letter-spacing: -0.1px;
          line-height: 1.15;
          box-shadow: 0 2px 8px rgba(0,0,0,0.35), 0 0 0 1px rgba(255,255,255,0.06);
          opacity: 0;
          transform: translateY(-4px) scale(0.85);
          transition: opacity 0.18s ease, transform 0.18s ease;
          pointer-events: none;
          max-width: 180px;
          display: flex;
          align-items: center;
          gap: 5px;
        }
        .mlb-label-name {
          /* Allow up to 2 lines on long names; ellipsize if it still overflows. */
          display: -webkit-box;
          -webkit-line-clamp: 2;
          -webkit-box-orient: vertical;
          overflow: hidden;
          text-overflow: ellipsis;
          word-break: break-word;
        }
        .mlb-label-rating {
          color: #fbbf24;
          font-weight: 800;
          font-size: 12px;
          letter-spacing: 0;
          display: inline-flex;
          align-items: center;
          gap: 3px;
        }

        /* The owner's own pin on the dashboard map: a chip that is never
           zoom-gated, because spotting yourself should not require zooming.
           Colours are set inline (theme-inverted, same rule as the pins). */
        .mlb-owner-chip {
          margin-top: 3px;
          padding: 2px 8px;
          border-radius: 8px;
          font-family: 'Hanken Grotesk', system-ui, -apple-system, sans-serif;
          font-size: 11px;
          font-weight: 700;
          letter-spacing: -0.1px;
          white-space: nowrap;
          box-shadow: 0 2px 8px rgba(0,0,0,0.35);
          pointer-events: none;
        }

        /* Show labels only when zoomed in enough to read them. */
        [data-zoom-tier="hi"] .mlb-marker-label {
          opacity: 1;
          transform: translateY(0) scale(1);
        }

        /* Pin size follows --pin-scale continuously (see PIN_SCALE_MIN); the
           tiers only decide whether labels show. */
      `}</style>
      <div ref={mapRef} style={{ width: '100%', height: '100%' }} />

      {/* My Location button. Hidden when the map is not following the
          viewer (venue dashboard): with no tracked position it could only
          ever re-center on nothing, and a button that cannot succeed does
          not render. */}
      {followUser && (
      <button aria-label="My Location" className="hit44"
        onClick={() => window.__flockGoToMyLocation && window.__flockGoToMyLocation()}
        style={{
          position: 'absolute', bottom: '80px', right: '12px',
          width: '44px', height: '44px', borderRadius: '22px',
          border: 'none', background: 'var(--bg-card-solid)', cursor: 'pointer',
          boxShadow: '0 2px 8px rgba(0,0,0,0.25)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          zIndex: 5, transition: 'transform 0.2s ease',
        }}
        onMouseEnter={(e) => { e.currentTarget.style.transform = 'scale(1.1)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.transform = 'scale(1)'; }}
        title="My Location"
      >
        <svg aria-hidden="true" focusable="false" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="4"/><line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/>
        </svg>
      </button>
      )}

      {/* Zoom controls */}
      <div style={{
        position: 'absolute', bottom: '184px', right: '12px',
        display: 'flex', flexDirection: 'column',
        borderRadius: '22px', overflow: 'hidden',
        boxShadow: '0 2px 8px rgba(0,0,0,0.25)', zIndex: 5,
      }}>
        <button aria-label="Zoom in" className="hit44"
          onClick={() => mapInstanceRef.current && mapInstanceRef.current.zoomIn({ duration: 150 })}
          style={{ width: '44px', height: '40px', border: 'none', background: 'var(--bg-card-solid)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          title="Zoom in"
        >
          <svg aria-hidden="true" focusable="false" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--text-primary)" strokeWidth="2.5" strokeLinecap="round">
            <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
          </svg>
        </button>
        <div style={{ height: '1px', background: 'var(--border-default)' }} />
        <button aria-label="Zoom out" className="hit44"
          onClick={() => mapInstanceRef.current && mapInstanceRef.current.zoomOut({ duration: 150 })}
          style={{ width: '44px', height: '40px', border: 'none', background: 'var(--bg-card-solid)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          title="Zoom out"
        >
          <svg aria-hidden="true" focusable="false" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--text-primary)" strokeWidth="2.5" strokeLinecap="round">
            <line x1="5" y1="12" x2="19" y2="12"/>
          </svg>
        </button>
      </div>

      {/* Map / Satellite toggle. Hidden outright when there is no MapTiler key,
          because MapTiler hybrid is now the only satellite imagery Flock is
          licensed to draw — a button that swaps to nothing is worse than no
          button. Every shipping build sets the key, so this renders in all of
          them. */}
      {SATELLITE_AVAILABLE && (
      <button className="hit44"
        aria-label={mapType === 'roadmap' ? 'Switch to satellite view' : 'Switch to map view'}
        onClick={toggleMapType}
        style={{
          position: 'absolute', bottom: '132px', right: '12px',
          width: '44px', height: '44px', borderRadius: '22px',
          border: 'none', background: 'var(--bg-card-solid)', cursor: 'pointer',
          boxShadow: '0 2px 8px rgba(0,0,0,0.25)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          zIndex: 5, transition: 'transform 0.2s ease',
        }}
        onMouseEnter={(e) => { e.currentTarget.style.transform = 'scale(1.1)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.transform = 'scale(1)'; }}
        title={mapType === 'roadmap' ? 'Switch to Satellite' : 'Switch to Map'}
      >
        {mapType === 'roadmap' ? (
          <svg aria-hidden="true" focusable="false" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--text-primary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>
          </svg>
        ) : (
          <svg aria-hidden="true" focusable="false" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--text-primary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/><line x1="8" y1="2" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="22"/>
          </svg>
        )}
      </button>
      )}
    </div>
  );
});

export default MapLibreMapView;
