// FLOCK MAP PALETTE: the colours of "Flock Paper" (light) and "Flock Night"
// (dark), as data, so the style builder and its tests read the same numbers.
//
// The light land IS the app's paper (--bg-primary #f1ede0), so the map reads as
// part of the app and white cards float over it. Everything on the ground stays
// within about 1.6:1 of the land; pins and labels carry the contrast. The dark
// land sits one step BELOW the app's dark background (#0f172a) so the nav and
// the sheets read as layers above the map, and the labels use the app's cream
// ramp, so map and chrome are one material.
//
// Rules that bind every value here:
// - no purple anywhere (no hue between 260 and 300); the stock Tourism purple
//   becomes steel, the app's only accent;
// - greens stay grey enough that a park never reads as the crowd "Quiet" green;
// - every label colour clears 4.5:1 on the ground it prints on, and every POI
//   icon clears 3:1 (flockStyle.test.js measures both);
// - the crowd green, amber and red appear only on a building that holds a real
//   score (the crowdBand feature state), never as decoration.

// Ground, roads and labels. Keys are the roles the style builder asks for.
export const LIGHT = {
  land: '#f1ede0',
  residential: '#ebe5d4',
  commercial: '#e6e0d2', // commercial, retail and industrial ground
  pedestrian: '#f7f4ea', // plazas and walking streets, where nights happen
  park: '#e0e2cc', // grass, parks, pitches, stadium grounds
  wood: '#d9dcc3',
  scrub: '#e4e4cf', // meadow, scrub, wetland
  farmland: '#ece7d2',
  sand: '#eee5c9',
  ice: '#f7f5ee',
  cemetery: '#e2e0d3',
  hospital: '#efe3dc',
  school: '#e6e6dc',
  airport: '#e7e3d6',
  water: '#b4c6d3',
  waterIntermittent: '#c7d3db',
  ferry: '#7d9ab3',
  building: '#e3dbc8',
  buildingOutline: '#d8cfba',
  building3d: '#d9cfb8',
  building3dOpacity: 0.85,
  lightIntensity: 0.25,
  motorway: '#ffffff',
  motorwayCasing: '#c9bea5',
  major: '#ffffff', // trunk, primary
  majorCasing: '#d3c9b2',
  mid: '#fdfbf6', // secondary, tertiary
  midCasing: '#ddd4c0',
  minor: '#fbf9f3', // minor, service
  minorCasing: '#e2dacb',
  streetLift: null, // light roads already carry the contrast at every zoom
  path: '#cfc6b0',
  rail: '#c4bba6',
  bridge: '#f7f4ea',
  bridgeCasing: '#d3c9b2',
  pier: '#f7f4ea',
  border: '#b9b2a0',
  // Labels
  halo: '#f1ede0',
  haloWidth: 1.5,
  city: '#16283d',
  town: '#33475e',
  neighbourhood: '#586473',
  road: '#586473',
  roadHalo: '#fbf9f3', // the minor-road fill, so a name reads on and off the road
  roadHaloWidth: 1.2,
  waterLabel: '#1f4870',
  shield: '#ffffff',
  shieldText: '#33475e',
  shieldEdge: '#c9bea5',
};

export const DARK = {
  land: '#0b1220',
  residential: '#0e1627',
  commercial: '#101a2c',
  pedestrian: '#141f33',
  park: '#111f1e', // dark slate-teal, never green
  wood: '#10201d',
  scrub: '#121f20',
  farmland: '#121a24',
  sand: '#18202a',
  ice: '#1a2433',
  cemetery: '#131a24',
  hospital: '#181a26',
  school: '#121c2c',
  airport: '#121a2a',
  water: '#0f2740',
  waterIntermittent: '#12263b',
  ferry: '#2d5a87',
  building: '#152035',
  buildingOutline: '#1b2942',
  // One step under the minor-road fill (1.17:1 on land against the road's
  // 1.22:1). Seen from straight above a roof is most of a downtown, and at the
  // lighter #1b2942 the blocks out-shone the streets and the grid read inside
  // out. The crowd tints separate from it by more than they did (2.2-3.1:1).
  building3d: '#16213a',
  building3dOpacity: 0.9,
  lightIntensity: 0.1,
  motorway: '#33475e',
  // Dark maps read better without visible casings, but the layers exist in both
  // themes (identical ids keep a theme swap cheap), so the casing is the land
  // colour: it only separates a road from the one it crosses.
  motorwayCasing: '#0b1220',
  major: '#2a3c58',
  majorCasing: '#0b1220',
  mid: '#22314a',
  midCasing: '#0b1220',
  minor: '#1a2538',
  minorCasing: '#0b1220',
  // From street zoom the road fills climb one step of the navy ramp. Seen from
  // above, a downtown is mostly roof, and the streets have to stay the lighter
  // network between the blocks or the grid reads inside out.
  streetLift: { motorway: '#3a5069', major: '#33475e', mid: '#2a3c58', minor: '#22314a' },
  path: '#253249',
  rail: '#26324a',
  bridge: '#141f33',
  bridgeCasing: '#0b1220',
  pier: '#141f33',
  border: '#3a4658',
  halo: '#0b1220',
  haloWidth: 1.4,
  city: '#f1ede0',
  town: '#c8c3b2',
  neighbourhood: '#a9a594',
  road: '#98937f',
  // 3.61:1 bare on a primary road, 6.08:1 on land, so the halo stays at 1.2 or
  // more and always in the land colour.
  roadHalo: '#0b1220',
  roadHaloWidth: 1.3,
  waterLabel: '#6d9ac3',
  shield: '#22314a',
  shieldText: '#f1ede0',
  shieldEdge: '#33475e',
};

// POI categories. Icon colour = text colour per category. Every hue sits in the
// brand family: warm browns from the tan birds, steel from the accent, sage from
// the parks. No crowd green, amber or red, and no purple.
export const POI = {
  food: { light: '#8a4b2e', dark: '#e3ae90' },
  // Nightclubs and casinos print in the food colour: they are the same evening.
  nightlife: { light: '#8a4b2e', dark: '#e3ae90' },
  shopping: { light: '#6b5a48', dark: '#cdbba5' },
  culture: { light: '#3e5f80', dark: '#a9c7e4' },
  tourism: { light: '#3e5f80', dark: '#a9c7e4' },
  park: { light: '#4f5e3a', dark: '#9fb38f' },
  sport: { light: '#4f5e3a', dark: '#9fb38f' },
  education: { light: '#4c6669', dark: '#a3bfc1' },
  healthcare: { light: '#8c3f3f', dark: '#e3a7a7' },
  transport: { light: '#2d5a87', dark: '#8fb4d6' },
  station: { light: '#2d5a87', dark: '#8fb4d6' },
  public: { light: '#5f5d50', dark: '#b8b5a5' },
};

// Building tints for the crowd bands (feature state `crowdBand`). Light: the
// band's fill hue at 45% over the building colour. Dark: the band's BRIGHT hue
// at 45% over the dark building, because the fill hues muddy on navy. Same three
// bands and cut points as crowdBandFor; no state means the base colour.
export const CROWD_TINT = {
  light: { green: '#87ca90', amber: '#e6b96a', red: '#e39084' },
  dark: { green: '#307a5e', amber: '#806c34', red: '#7e4957' },
};

export const paletteFor = (dark) => (dark ? DARK : LIGHT);
export const poiColor = (category, dark) => POI[category][dark ? 'dark' : 'light'];
