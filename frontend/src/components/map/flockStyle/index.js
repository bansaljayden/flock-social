// The Flock basemap: "Flock Paper" (light) and "Flock Night" (dark) on MapTiler
// Planet v4, plus the satellite twin for each theme. Callers code against this
// file only; buildFlockStyle.js and palette.js are its internals.
export {
  buildFlockStyle,
  satelliteStyleUrl,
  FLOCK_LAYER_IDS,
  FLOCK_BUILDINGS,
  FLOCK_STYLE_VERSION,
  FLOCK_ATTRIBUTION,
  FLOCK_FONTS,
  HIDDEN_POI_SUBCLASSES,
} from './buildFlockStyle.js';
export { LIGHT, DARK, POI, CROWD_TINT } from './palette.js';
