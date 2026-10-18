// WHICH BASEMAP PLACES OPEN AS VENUES WHEN TAPPED, AND FROM WHAT ZOOM.
//
// The Flock basemap draws places from OpenStreetMap as small glyphs once the
// map is at street level (flockStyle/buildFlockStyle.js, "THE POI POLICY"):
// food and drink from zoom 15, nightlife from 14, culture from 13. They exist in
// every city, not only where Flock collects crowd readings, but they are only
// pictures on the canvas, so a tap on one did nothing. From POI_TAP_MIN_ZOOM a
// tap on one of the places below is looked up on the server
// (GET /api/venues/resolve-poi, one free IDs-only Google lookup, cached) and
// opens in the same venue sheet as a search result.
//
// Only places a group would go to are offered. A bus stop, a pharmacy or a
// school is drawn but not opened, and casinos are drawn but not opened either:
// Flock's audience starts at 13.

export const POI_TAP_MIN_ZOOM = 15;

// A finger is wider than a 16px glyph, so the hit test is a box around the tap.
export const POI_TAP_RADIUS_PX = 12;

// Layer id -> which features in it open, by OpenMapTiles `class`/`subclass`.
// Ordered by preference when a tap box covers more than one.
export const TAPPABLE_POI_LAYERS = Object.freeze({
  'flock-poi-food': null, // every food and drink place the layer draws
  'flock-poi-nightlife': { subclass: ['nightclub', 'events_venue', 'dance', 'escape_game', 'amusement_arcade'] },
  'flock-poi-culture': { class: ['cinema', 'theatre', 'museum', 'gallery', 'arts_centre', 'exhibition_centre', 'planetarium'] },
  'flock-poi-tourism': { class: ['attraction', 'zoo', 'theme_park', 'aquarium'] },
});

export const TAPPABLE_POI_LAYER_IDS = Object.freeze(Object.keys(TAPPABLE_POI_LAYERS));

const opens = (layerId, props) => {
  if (!Object.prototype.hasOwnProperty.call(TAPPABLE_POI_LAYERS, layerId)) return false;
  const rule = TAPPABLE_POI_LAYERS[layerId];
  if (!rule) return true;
  if (rule.class) return rule.class.includes(props.class);
  if (rule.subclass) return rule.subclass.includes(props.subclass);
  return false;
};

/**
 * The place a tap opens, from the features the map reports under it, or null.
 * Pure: the map query happens in poiUnderTap.
 *
 * @param {Array} features  map.queryRenderedFeatures results
 * @param {number} zoom     the map's zoom when it was tapped
 * @returns {{name: string, lat: number, lng: number, layerId: string} | null}
 */
export function pickTappablePoi(features, zoom) {
  if (!(zoom >= POI_TAP_MIN_ZOOM) || !Array.isArray(features)) return null;
  for (const layerId of TAPPABLE_POI_LAYER_IDS) {
    for (const f of features) {
      if (!f || !f.layer || f.layer.id !== layerId) continue;
      const props = f.properties || {};
      if (!opens(layerId, props)) continue;
      const name = typeof props.name === 'string' ? props.name.trim() : '';
      const coords = f.geometry && f.geometry.type === 'Point' ? f.geometry.coordinates : null;
      if (!name || !Array.isArray(coords)) continue;
      const [lng, lat] = coords;
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      return { name, lat, lng, layerId };
    }
  }
  return null;
}

/**
 * Ask the map what is under a tap, at street zoom only, on the layers this
 * style actually has (asking MapLibre about a layer it does not have throws).
 */
export function poiUnderTap(map, point) {
  if (!map || !point) return null;
  const zoom = map.getZoom();
  if (!(zoom >= POI_TAP_MIN_ZOOM)) return null;
  const layers = TAPPABLE_POI_LAYER_IDS.filter((id) => map.getLayer(id));
  if (layers.length === 0) return null;
  const r = POI_TAP_RADIUS_PX;
  const features = map.queryRenderedFeatures([[point.x - r, point.y - r], [point.x + r, point.y + r]], { layers });
  return pickTappablePoi(features, zoom);
}
