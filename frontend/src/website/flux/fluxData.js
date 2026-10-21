// The Flux case for /flux: how each part looks, the exploded layout, and the
// assembly the page's one slider scrubs through. Ported from
// flock-sensor/enclosure/viewer/index.html at 17344ee5, the viewer the
// sensor's own renders come from. No three.js in here, so the timeline can be
// tested on its own (fluxPages.test.js).
//
// Offsets are in the box's millimetres, as in flux_cad.py: X across, Y front
// to back (+y toward the back), Z up.

// The box: size, its 12 degree lean on the stand and how far the stand lifts it.
export const BOX = { w: 182.9, h: 175.2, d: 74.375, tilt: 12, lift: 20.46 };

// How each part looks, in sRGB as the repo viewer writes it. The three
// wall-arm parts are not in the web copy of the model (flux_assets.py).
export const LOOK = {
  'Body (printed, navy)': { color: 0x0f172a, rough: 0.78 },
  'Sensor pill (cream)': { color: 0xf4efe3, rough: 0.35 },
  'Flux wordmark (cream)': { color: 0xf4efe3, rough: 0.6 },
  'Back sheet (navy)': { color: 0x111a30, rough: 0.15, coat: 0.6 },
  'Back engraving': { color: 0xc9c3b4, rough: 0.9 },
  'USB port': { color: 0x9a9ca3, rough: 0.35, metal: 0.6 },
  'Ethernet port': { color: 0x9a9ca3, rough: 0.35, metal: 0.6 },
  '7 inch touchscreen': { color: 0x141b26, rough: 0.05, coat: 1 },
  'Anker A1336 battery': { color: 0x2a2c31, rough: 0.45 },
  'Raspberry Pi 5': { color: 0x1f7a45, rough: 0.55 },
  'Pi 5 ports': { color: 0xb9bbc2, rough: 0.3, metal: 0.8 },
  'Active Cooler': { color: 0x55575d, rough: 0.35, metal: 0.6 },
  'SIM7600G-H 4G HAT': { color: 0x1d4f9c, rough: 0.5 },
  'PureThermal 3 + Lepton 3.5': { color: 0x3a3d44, rough: 0.25, metal: 0.4 },
  'VL53L8CX door counter': { color: 0x2b2440, rough: 0.35 },
  'Decibel meter': { color: 0x157a7a, rough: 0.5 },
  'RPi5 PD Power board (52Pi)': { color: 0x17181b, rough: 0.45 },
  'CHARGE port': { color: 0xd8d8dc, rough: 0.3, metal: 0.7 },
  'LINK light': { color: 0x4fd67c, rough: 0.3, glow: 0x2fa85a },
  '1/4-20 mount nut': { color: 0xa9abb2, rough: 0.35, metal: 0.9 },
  'Stand (printed, cream)': { color: 0xf4efe3, rough: 0.8 },
  'Stand screw (1/4-20 x 5/8)': { color: 0xa9abb2, rough: 0.35, metal: 0.9 },
  '4G antenna strip': { color: 0x9ca3af, rough: 0.5 },
  'Brass M3 inserts (8)': { color: 0xc9a14a, rough: 0.35, metal: 0.95 },
};

// What a tapped part is called: the names on the labelled exploded picture.
export const LABELS = {
  'Body (printed, navy)': 'Body (printed, navy)',
  'Sensor pill (cream)': 'Sensor pill (cream)',
  'Flux wordmark (cream)': 'Flux wordmark',
  'Back sheet (navy)': 'Back sheet (navy acrylic)',
  'Back engraving': 'Back sheet (navy acrylic)',
  '7 inch touchscreen': '7 inch touchscreen',
  'Anker A1336 battery': 'Battery',
  'Raspberry Pi 5': 'Raspberry Pi 5',
  'Pi 5 ports': 'Raspberry Pi 5',
  'Active Cooler': 'Active Cooler',
  'SIM7600G-H 4G HAT': '4G board',
  'PureThermal 3 + Lepton 3.5': 'Thermal camera',
  'VL53L8CX door counter': 'Door counter',
  'Decibel meter': 'Sound meter',
  'RPi5 PD Power board (52Pi)': 'Power board',
  'CHARGE port': 'CHARGE port',
  'USB port': 'USB port',
  'Ethernet port': 'Ethernet port',
  'LINK light': 'Status light',
  '4G antenna strip': '4G antenna',
  '1/4-20 mount nut': 'Stand nut',
  'Stand (printed, cream)': 'Stand (printed, cream)',
  'Stand screw (1/4-20 x 5/8)': 'Stand screw',
  'Brass M3 inserts (8)': 'Brass inserts',
};
export const labelFor = (name) => LABELS[name] || (isCable(name) ? 'Cable' : name);

// Cables carry their colour in their name: power orange, the video ribbon
// gold, the Qwiic leads blue, the light's lead green, the antenna lead grey.
export function cableLook(name) {
  const n = name.toLowerCase();
  const color = /charge|battery|power|usb-c/.test(n) ? 0xe07a3f : /ribbon/.test(n) ? 0xc9a227
    : /qwiic/.test(n) ? 0x3b82f6 : /light/.test(n) ? 0x22c55e : /antenna/.test(n) ? 0x9ca3af : 0xd6d8dd;
  return { color, rough: 0.6 };
}

export function isCable(name) { return /^Cable: /.test(name); }
// Cables that leave from the back sheet's ports or run between two boards on
// it: they travel with the sheet, as in the repo viewer's last step.
const BACK_CABLES = /^Cable: (back |4G modem|PD board to Pi)/;

// The exploded layout: the repo viewer's "Exploded" view, which the labelled
// picture flux-exploded.png was rendered from. Front to back in the order the
// parts go together; anything not listed stays where it is.
export const EXPLODED = {
  'Sensor pill (cream)': [0, -70, 0], 'Flux wordmark (cream)': [0, -55, -6],
  '7 inch touchscreen': [0, 100, 0], 'Anker A1336 battery': [0, 165, 0],
  'Decibel meter': [45, 0, 0], '4G antenna strip': [28, 0, 0],
  'SIM7600G-H 4G HAT': [0, 205, 0], 'Active Cooler': [0, 230, 0],
  'Raspberry Pi 5': [0, 255, 0], 'Pi 5 ports': [0, 255, 0], 'RPi5 PD Power board (52Pi)': [0, 255, 0],
  'Back sheet (navy)': [0, 300, 0], 'Back engraving': [0, 300, 0],
  'CHARGE port': [0, 300, 0], 'USB port': [0, 300, 0], 'Ethernet port': [0, 300, 0],
  '1/4-20 mount nut': [0, 0, -25],
};
const SHEET = [0, 300, 0];
const BACK = ['Back sheet (navy)', 'Back engraving', 'CHARGE port', 'USB port', 'Ethernet port'];
const ONTO_BACK = ['SIM7600G-H 4G HAT', 'Active Cooler', 'Raspberry Pi 5', 'Pi 5 ports', 'RPi5 PD Power board (52Pi)'];
const STAND = { 'Stand (printed, cream)': [0, 0, -40], 'Stand screw (1/4-20 x 5/8)': [0, 0, -60] };

// The slider runs from 0 to STEPS.length - 1. Position 0 is the exploded
// layout; whole number k is the end of step k; the last is the box on its
// stand. `still` is the render the slider shows at that stop where the 3D
// does not run. The first stop covers the repo's steps 1 and 2: the
// exploded view already has the camera, door counter and light in the chin.
export const STEPS = [
  { title: 'Pulled apart', caption: 'Every part of the case, laid out front to back.', still: 'flux-exploded' },
  { title: 'The body', caption: 'Brass inserts melt into the printed body. The thermal camera, the door counter and the status light screw in from inside.', still: 'flux-step2' },
  { title: 'The screen', caption: 'The 7 inch touchscreen drops in from the back, glass first.', still: 'flux-step3' },
  { title: 'The front', caption: 'The cream sensor pill and the Flux wordmark go on the front.', still: 'flux-step4' },
  { title: 'The back sheet', caption: 'The Raspberry Pi 5, its cooler and the power board mount on the back sheet.', still: 'flux-step5' },
  { title: 'Battery and cables', caption: 'The battery and the sound meter go in, and every cable is plugged in.', still: 'flux-step6' },
  { title: 'Closed up', caption: 'The back sheet closes with four screws.', still: 'flux-step7' },
  { title: 'On its stand', caption: 'On a table it leans back 12 degrees on a cream stand.', still: 'flux-assembled' },
];
export const LAST = STEPS.length - 1;

// The step that moves or marks each part (index into STEPS).
const STEP_OF = {
  'Brass M3 inserts (8)': 1, '1/4-20 mount nut': 1,
  'PureThermal 3 + Lepton 3.5': 1, 'VL53L8CX door counter': 1, 'LINK light': 1,
  '7 inch touchscreen': 2,
  'Sensor pill (cream)': 3, 'Flux wordmark (cream)': 3,
  'Anker A1336 battery': 5, 'Decibel meter': 5, '4G antenna strip': 5,
};

const clamp01 = (x) => Math.min(1, Math.max(0, x));
// Eased in and out, so a part starts and settles gently as the bar moves.
const ease = (x) => { const t = clamp01(x); return t * t * (3 - 2 * t); };
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const ZERO = [0, 0, 0];

/** How far step k has got at slider position u: 0 before it starts, 1 once done. */
export function progress(u, k) { return ease(u - (k - 1)); }

const sheetAt = (u) => mix(SHEET, ZERO, progress(u, 6));

/** Where a part sits at slider position u, in millimetres from where it sits
 *  in the finished box, and whether it shows. A part the model gains later
 *  and this file does not know stays in place. */
export function partAt(name, u) {
  if (isCable(name)) {
    // The sheet's own cables appear once the boards are on it; the rest go
    // in with the battery, waiting for the sheet to close over them.
    if (BACK_CABLES.test(name)) return { visible: u >= 3.95, offset: sheetAt(u) };
    return { visible: u >= 4.5, offset: ZERO };
  }
  if (STAND[name]) return { visible: u > 6, offset: mix(STAND[name], ZERO, progress(u, 7)) };
  if (name === 'Brass M3 inserts (8)') return { visible: u >= 0.35, offset: ZERO };
  if (BACK.includes(name)) return { visible: true, offset: sheetAt(u) };
  if (ONTO_BACK.includes(name)) {
    // Onto the back sheet in step 4, then in with it in step 6.
    return { visible: true, offset: mix(mix(EXPLODED[name], SHEET, progress(u, 4)), ZERO, progress(u, 6)) };
  }
  const k = STEP_OF[name];
  const from = EXPLODED[name] || ZERO;
  return { visible: true, offset: k ? mix(from, ZERO, progress(u, k)) : from };
}

/** The box's lean at slider position u: flat on the floor until the last
 *  step, then up onto its stand. Degrees and millimetres. */
export function poseAt(u) {
  const t = progress(u, 7);
  return { tilt: BOX.tilt * t, lift: BOX.lift * t };
}

/** The step a slider position belongs to: the one under way, or the one just
 *  finished at a whole number. */
export function stepAt(u) {
  if (u <= 0) return 0;
  return Math.min(LAST, Math.ceil(u - 1e-6));
}

/** How strongly a part is marked as part of the step under way: rises and
 *  falls across the step, 0 at every stop. */
export function markAt(name, u) {
  const k = stepAt(u);
  if (k === 0 || u >= LAST || Number.isInteger(u)) return 0;
  const t = u - (k - 1);
  const ours = isCable(name) ? k === 5
    : ONTO_BACK.includes(name) ? k === 4 || k === 6
      : BACK.includes(name) ? k === 6
        : STAND[name] ? k === 7
          : STEP_OF[name] === k;
  return ours ? Math.sin(Math.PI * clamp01(t)) : 0;
}

/** Camera aim at slider position u: from the exploded picture's angle round
 *  to the finished box's three-quarter view, as directions in the box's
 *  frame, plus the field of view and the framing zoom. */
export const VIEW_APART = { dir: [1.0, -0.42, 0.42], fov: 26, zoom: 0.9 };
export const VIEW_DONE = { dir: [0.62, -1.0, 0.42], fov: 32, zoom: 1 };
export function viewAt(u) {
  const t = ease(u / LAST);
  return {
    dir: mix(VIEW_APART.dir, VIEW_DONE.dir, t),
    fov: VIEW_APART.fov + (VIEW_DONE.fov - VIEW_APART.fov) * t,
    zoom: VIEW_APART.zoom + (VIEW_DONE.zoom - VIEW_APART.zoom) * t,
  };
}
