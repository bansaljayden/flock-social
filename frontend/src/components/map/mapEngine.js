/**
 * WHICH ENGINE THE APP'S MAP RUNS ON.
 *
 * With a MapTiler key the Discover map and the venue dashboard's Map tab run
 * on @maptiler/sdk. Without one (contributors, the e2e stack) they run on
 * plain maplibre-gl against the keyless CARTO styles, exactly as before.
 *
 * WHY THE SDK AND NOT PLAIN MAPLIBRE. MapTiler bills a map built with plain
 * maplibre-gl per tile request, and says switching such an app to session
 * billing "is not technically possible". Only maps built with their SDK are
 * counted in sessions: one per page load that constructs a map, with every
 * tile, theme swap, satellite toggle and remount inside it free. A Discover
 * open loads 40 to 150 tiles, and a session costs about what 17 tiles do, so
 * the same traffic draws on a pool several times larger. The spending cap
 * turns every key off when it is reached, which is the outage this avoids.
 *
 * The SDK's Map class extends MapLibre's, and the package pins maplibre-gl
 * 5.24, the minor this app already uses. package.json pins maplibre-gl to
 * ~5.24.0 so npm keeps ONE copy of the engine for the SDK, this file's keyless
 * path and the landing page demo. A drift to 5.25 would bundle two.
 *
 * WHY A SEPARATE MODULE. It is the one place a test has to mock. The SDK is
 * published as ES modules only, and Jest under react-scripts does not
 * transform node_modules, so a test that mounted the map against the real
 * package would fail to parse it. It is a plain module, not a hook: nothing
 * here runs during render.
 *
 * WHAT THE SDK IS NOT ALLOWED TO DO HERE
 *
 * - Add controls. It adds its own zoom and locate buttons unless told not to;
 *   Flock draws its own, and gates them on the room the surface has
 *   (mapControlsFitTheSurface.test.js). Its locate button would also be a
 *   fourth door into the OS location prompt the Settings switch has to close.
 * - Fetch the right-to-left text plugin. It loads it from cdn.maptiler.com on
 *   every style load, a host the app's CSP does not allow, so the result would
 *   be a console error per load and no plugin.
 * - Replace a style that failed with MapTiler Streets. When a style cannot be
 *   loaded (most likely the spending cap: every key answers 403) it loads
 *   Streets instead, which answers 403 too, and its error handler then tries
 *   again. The map's own failure panel is the right answer to a dead key.
 * - Rewrite labels. It switches label languages to the browser's unless the
 *   language is STYLE. Labels stay as the style has them.
 * - Send telemetry. The privacy policy names MapTiler as the tile host; it
 *   does not describe a metrics beacon carrying the key and session id.
 * - Print its version banner to the console on every map.
 *
 * Its tile and font cache (the Cache API, up to 1,000 entries, sessions only)
 * stays on: MapTiler's terms allow a personal device cache, and it is what
 * makes a later launch open faster.
 */

// The SDK's constructor options, merged over the view's own. Every control is
// named, including the ones that default to off, so a default that flips in a
// later SDK release cannot add one.
export const SDK_MAP_OPTIONS = Object.freeze({
  navigationControl: false,
  geolocateControl: false,
  terrainControl: false,
  scaleControl: false,
  fullscreenControl: false,
  projectionControl: false,
  // The logo is not required on a paid plan. The text credit is, and the view
  // adds its own compact attribution control for it.
  maptilerLogo: false,
  forceNoAttributionControl: true,
  // The globe's space backdrop and halo, both off: Discover is a flat city map.
  space: false,
  halo: false,
  projection: 'mercator',
  terrain: false,
  geolocate: false,
  rtlTextPlugin: false,
  logSDKVersion: false,
});

// The SDK's own fallback is `setStyle(MapStyle.STREETS)`, a catalogue style
// object rather than a URL or a style document. Flock never asks for a
// catalogue style, so a request for one can only be that fallback.
function isCatalogueStyle(sdk, style) {
  return (sdk.MapStyleVariant && style instanceof sdk.MapStyleVariant)
    || (sdk.ReferenceMapStyle && style instanceof sdk.ReferenceMapStyle);
}

function flockMapClass(sdk) {
  // MapLibre's own Map, the class the SDK's Map extends.
  const base = Object.getPrototypeOf(sdk.Map.prototype);
  return class FlockMap extends sdk.Map {
    setStyle(style, options) {
      if (isCatalogueStyle(sdk, style)) return this;
      // remove() clears the style with setStyle(null) to release sources,
      // cancel requests and free workers. The SDK reads null as an invalid
      // style and keeps the current one, so every unmounted map held on to
      // all of it. A null goes straight to MapLibre instead.
      if (style === null && base && typeof base.setStyle === 'function') return base.setStyle.call(this, null, options);
      return super.setStyle(style, options);
    }

    // A full reload, every source fetched again, for after a refused key
    // works again. The SDK always diffs a style object, and a diff keeps the
    // sources that failed (and their missing TileJSON) exactly as they were.
    reloadStyle(style) {
      if (base && typeof base.setStyle === 'function') return base.setStyle.call(this, style, { diff: false });
      return this;
    }
  };
}

/* WHERE THE CONNECTION SAYS THE DEVICE IS, for a map that has no location.
   MapTiler's IP geolocation: one request, city level. The answer is kept in
   this module's memory for the rest of the launch, so a remount does not ask
   again, and it is never written to storage or sent anywhere else. MapTiler
   already sees the IP through every tile it serves. A failure is not kept, so
   one bad network moment does not decide the whole launch. */
let ipViewPromise = null;

function locateByIp(sdk, key) {
  if (!ipViewPromise) {
    ipViewPromise = Promise.resolve()
      .then(() => sdk.geolocation.info({ apiKey: key }))
      .then((r) => (
        r && Number.isFinite(r.latitude) && Number.isFinite(r.longitude)
          ? { lat: r.latitude, lng: r.longitude }
          : null
      ))
      .catch(() => null)
      .then((view) => {
        if (!view) ipViewPromise = null;
        return view;
      });
  }
  return ipViewPromise;
}

/**
 * Resolves the engine the view builds its map with:
 *   kind        'sdk' or 'maplibre'
 *   lib         Marker, Popup, LngLatBounds and AttributionControl live here
 *   Map         the class to construct
 *   options     constructor options this engine adds to the view's own
 *   locateByIp  () => Promise<{ lat, lng } | null>, or null on the keyless path
 */
export async function loadMapEngine({ key } = {}) {
  if (!key) {
    const lib = (await import('maplibre-gl')).default;
    return { kind: 'maplibre', lib, Map: lib.Map, options: {}, locateByIp: null };
  }
  const sdk = await import('@maptiler/sdk');
  // All of this is read when a Map is constructed, so it is set first.
  // `config` is the SDK's global singleton; the landing page demo does not
  // load the SDK, so nothing else writes it.
  sdk.config.apiKey = key;
  sdk.config.session = true;
  sdk.config.caching = true;
  sdk.config.telemetry = false;
  sdk.config.primaryLanguage = sdk.Language.STYLE;
  return {
    kind: 'sdk',
    lib: sdk,
    Map: flockMapClass(sdk),
    options: SDK_MAP_OPTIONS,
    locateByIp: () => locateByIp(sdk, key),
  };
}
