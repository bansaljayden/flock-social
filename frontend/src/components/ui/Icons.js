/**
 * Flock icon system - Tier C.
 *
 * One geometry, obeyed 90-odd times:
 *   - butt caps, miter joins, zero corner radius
 *   - every straight segment at exactly 0 / 45 / 90 degrees
 *   - circular arcs only, never elliptical, and every radius is a whole unit
 *     or a half. Across the set: 1.5, 2, 2.5, 3, 3.5, 4, 5, 6, 7, 8, 9, 11.
 *     No arbitrary decimals.
 *   - EVERY CONTAINER IS DRAWN OPEN: any ring of r >= 7 is cut by a 30 degree
 *     gap centred on the upper-right diagonal; any rectangular container is
 *     missing its bottom edge. Rings under r=7 stay closed - the gap does not
 *     read at that radius and looks like damage.
 *   - stroke-width is derived from the render size and applied with
 *     vector-effect: non-scaling-stroke, so optical weight is comparable at
 *     10px and at 40px.
 *   - a solid mark carries the same stroke as an outlined one, so a filled
 *     glyph does not read half a stroke smaller than its neighbours and a
 *     star/starFilled swap does not visibly shrink. The two exceptions below
 *     and the `dot` helper are the only unstroked paint in the file.
 *
 * Stated exceptions, and only these two:
 *   1. `star` - five-fold symmetry cannot be built from 0/45/90.
 *   2. `birdie` - the punched eye is the only interior negative space here,
 *      it carries its own radii (6.5, 1.4), and it is the only glyph that
 *      stays unstroked, because a stroke would close the eye.
 *
 * Public API: Icons.name(color, size) returns JSX. `color` is honoured as a
 * CSS `color` on a wrapper and picked up through currentColor, so an icon also
 * inherits correctly when `color` is omitted.
 *
 * Accessibility: an icon is DECORATIVE by default (aria-hidden on both the
 * wrapper and the svg), which is correct wherever the icon sits next to a text
 * label. Where the icon is the only content of a control and the control has
 * no label of its own, pass a third argument:
 *
 *   Icons.trash(colors.red, 16, 'Delete message')
 *
 * which drops aria-hidden and exposes role="img" + aria-label instead. Both
 * modes are supported; neither is forced.
 */

import React from 'react';
import './icons.css';

/* ------------------------------------------------------------------ *
 * Shared helpers
 * ------------------------------------------------------------------ */

// Stroke weight per size band, in rendered CSS pixels. Deliberately heavier in
// relative terms at small sizes. The top bands exist because 24 and 40 sharing
// a 2px stroke left the large glyphs looking hairline next to the small ones.
const sw = (size) =>
  size <= 12 ? 1.25 :
  size <= 17 ? 1.5 :
  size <= 23 ? 1.75 :
  size <= 31 ? 2 :
  size <= 47 ? 2.5 : 3;

const r2 = (n) => Math.round(n * 100) / 100;

/**
 * The open ring. For radius r about (cx, cy) the arc runs from theta=60deg
 * counter-clockwise the long way round to theta=30deg, leaving a 30deg gap on
 * the upper-right diagonal.
 *   r=11 -> M17.5 2.47A11 11 0 1 0 21.53 6.5
 *   r=9  -> M16.5 4.21A9 9 0 1 0 19.79 7.5
 *   r=7  -> M15.5 5.94A7 7 0 1 0 18.06 8.5
 */
const ring = (cx, cy, r) =>
  `M${r2(cx + r * 0.5)} ${r2(cy - r * 0.866)}A${r} ${r} 0 1 0 ${r2(cx + r * 0.866)} ${r2(cy - r * 0.5)}`;

// A gull mark: the bird at distance. Two 45deg strokes meeting at a low peak.
// Capped at five glyphs across the whole set - it is a spice, not a theme.
const gull = (cx, cy, w) => `M${cx - w} ${cy + w / 2} ${cx} ${cy - w / 2} ${cx + w} ${cy + w / 2}`;

/**
 * Filled dot. Fill only, never stroked: Chrome renders a stroked circle whose
 * stroke-width exceeds its own diameter as an annulus with a hole punched in
 * the middle, so a "solid" dot built that way comes out as a donut at exactly
 * the small sizes that need it most.
 *
 * r=1.5 (was 1) because the stroke bands are roughly proportional to size, so
 * a fill-only dot tracks them: the rendered dot lands at 1.2-1.5x the stroke
 * width from 12px to 24px. At r=1 it was 0.8x, i.e. lighter than a hairline.
 * Any glyph carrying a row of dots must space them at least 5 units apart or
 * they close into a dash at 12px.
 */
const dot = (cx, cy, r = 1.5) => (
  <circle cx={cx} cy={cy} r={r} fill="currentColor" stroke="none" />
);

const svg = (size, children, style, label) => (
  <svg
    className="flock-icon"
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={sw(size)}
    strokeLinecap="butt"
    strokeLinejoin="miter"
    strokeMiterlimit="4"
    role={label ? 'img' : undefined}
    aria-label={label || undefined}
    aria-hidden={label ? undefined : true}
    focusable="false"
    style={style}
  >
    {children}
  </svg>
);

/**
 * Build one icon. `children` is created once at module scope and reused, which
 * is what lets React keep the same DOM nodes across a star -> starFilled swap
 * so the fill can transition rather than pop.
 */
const make = (children, opts = {}) => {
  const { color: defColor = 'currentColor', size: defSize = 18, style, className } = opts;
  const wrapClass = className ? `flock-icon-wrap ${className}` : 'flock-icon-wrap';
  return (color = defColor, size = defSize, label) => (
    <span
      className={wrapClass}
      style={{ color, display: 'inline-flex' }}
      aria-hidden={label ? undefined : true}
    >
      {svg(size, children, style, label)}
    </span>
  );
};

/* ------------------------------------------------------------------ *
 * Shapes shared by more than one name
 * ------------------------------------------------------------------ */

// star / starFilled - the one radially symmetric figure, exempt from the angle
// rule. Outer r=9, inner r=3.8 (ratio 0.42, sharper than the usual 0.5).
const STAR_D =
  'M12 3 14.23 8.93 20.56 9.22 15.61 13.17 17.29 19.28 12 15.8 6.71 19.28 8.39 13.17 3.44 9.22 9.77 8.93Z';

// pin / pinFilled - one closed contour including the needle, so the two names
// are one drawing and the fill can transition.
const PIN_D =
  'M8 4 16 4 16 12 20 16 13.5 16 13.5 21 10.5 21 10.5 16 4 16 8 12Z';

// chevron - one path at three angles.
const CHEVRON = <path d="M4 15 12 7 20 15" />;
const ROT = (deg) => ({ transform: `rotate(${deg}deg)` });

// birdie - the specimen's head alone: filled round head, square-cut wedge beak,
// and the punched eye cut with fill-rule evenodd so it needs no background token.
const BIRDIE_D =
  'M6.5 11A6.5 6.5 0 1 1 19.5 11A6.5 6.5 0 1 1 6.5 11Z' +
  'M6.5 11 2 13 6.5 15Z' +
  'M13.6 9A1.4 1.4 0 1 1 16.4 9A1.4 1.4 0 1 1 13.6 9Z';

// mug - beer and coffee are the same mark. The handle is 6 units tall, not 4,
// and the two steam ticks are gone: floating above the rim they read as
// antennae, and they made no sense on `beer` at all.
const MUG = (
  <>
    <path d="M5 20 5 8 17 8 17 20" />
    <path d="M17 10 21 10 21 16 17 16" />
  </>
);

// stemware - cocktail and wine are the same mark.
const STEM = (
  <>
    <path d="M4 6 20 6 12 14Z" />
    <path d="M12 14 12 20" />
    <path d="M8 20 16 20" />
  </>
);

// chat / messageSquare - an open-bottom container: the missing edge is the mouth.
const CHAT = (
  <>
    <path d="M4 18 4 6 20 6 20 18" />
    <path d="M8 18 8 22 12 18" />
  </>
);

// party / partyPopper
const PARTY = (
  <>
    <path d="M3 21 3 15 9 21Z" />
    <path d="M9 13 13 9M12 17 17 12M15 20 20 15" />
  </>
);

/* Aliases are single-sourced: one make() per drawing, two names pointing at it,
   so an alias can never drift away from its twin. */
const MUG_ICON = make(MUG);
const STEM_ICON = make(STEM, { color: '#1a3a5c' });
const CHAT_ICON = make(CHAT);
const PARTY_ICON = make(PARTY);
const BIRDIE_ICON = make(
  <path d={BIRDIE_D} fillRule="evenodd" fill="currentColor" stroke="none" />,
  { className: 'flock-icon--birdie' }
);

/* ------------------------------------------------------------------ *
 * The set
 * ------------------------------------------------------------------ */

const Icons = {
  /* --- the top ten by usage, drawn to the spec's own coordinates --- */

  // 1. mapPin. Refuses the teardrop-with-a-hole: a ring above a chevron whose
  // arms are the ring's own 45deg diagonals continued. The head is r=6, so per
  // the system's own rule it is CLOSED - it used to carry the 30deg gap, which
  // at the 10-14px this icon mostly renders at was ~1.5px of noise in the most
  // used glyph in the app.
  mapPin: make(
    <>
      <circle cx="12" cy="11" r="6" />
      <path d="M7.76 15.24 12 19.48 16.24 15.24" />
    </>
  ),

  // 2. x
  x: make(<path d="M6 6 18 18M18 6 6 18" />),

  // 3. search. The gap sits on the upper-right diagonal, the handle on the
  // lower-right, so neither eats the other.
  search: make(
    <>
      <path d={ring(10, 10, 7)} />
      <path d="M14.95 14.95 20 20" />
    </>
  ),

  // 4. users. One person with a second behind them. Two heads over a single
  // shared shoulder arc looked like an owl at every size: the arc's apex landed
  // in the gap between the heads and read as a beak. Staggering the pair fixes
  // it and is the only arrangement of five tested that read as two people.
  users: make(
    <>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M3 20A6 6 0 0 1 15 20" />
      <circle cx="17" cy="7" r="2.5" />
      <path d="M15 20 21 20A5 5 0 0 0 16 15" />
    </>
  ),

  // 5. arrowLeft
  arrowLeft: make(
    <>
      <path d="M20 12 4 12" />
      <path d="M10 6 4 12 10 18" />
    </>
  ),

  // 6. check. The long rising arm rhymes with the gull mark's right wing.
  check: make(<path d="M4 12.5 9.5 18 20 7.5" />, { size: 14 }),

  // 7. plus
  plus: make(<path d="M12 4 12 20M4 12 20 12" />),

  // 8. star / starFilled - one path, two renderings. Both are stroked, so the
  // filled state has the same silhouette and the swap does not shrink. The
  // empty state is fill="transparent", not fill="none": `none` is not a colour
  // and will not animate, so the fill-on-select transition needs a real one.
  star: make(<path d={STAR_D} fill="transparent" stroke="currentColor" />),
  starFilled: make(<path d={STAR_D} fill="currentColor" stroke="currentColor" />, {
    color: '#F59E0B',
  }),

  // 9. clock. Hands at exactly 90 and 0, so the glyph is 0/90 plus one arc.
  clock: make(
    <>
      <path d={ring(12, 12, 9)} />
      <path d="M12 6.5 12 12 17 12" />
    </>
  ),

  // 10. calendar. Refuses the box-with-a-grid; the open bottom echoes the wire.
  // The two hangers are the only thing separating a calendar from the six other
  // open-box glyphs in this set, and the box is now as tall as clock is round,
  // so a date and a time sitting side by side read at the same optical size.
  calendar: make(
    <>
      <path d="M4 20 4 7 20 7 20 20" />
      <path d="M8 7 8 4M16 7 16 4" />
      {dot(7, 13.5)}
      {dot(12, 13.5)}
      {dot(17, 13.5)}
    </>
  ),

  /* --- birdie, and the rest --- */

  // The specimen's head. The only Tier C glyph with interior negative space,
  // and the only one with character motion.
  birdie: BIRDIE_ICON,

  activity: make(
    <>
      <path d={gull(6, 15, 3)} />
      <path d={gull(12, 12, 3)} />
      <path d={gull(18, 15, 3)} />
    </>
  ),

  alertCircle: make(
    <>
      <path d={ring(12, 12, 9)} />
      <path d="M12 6.5 12 13" />
      {dot(12, 16.5)}
    </>
  ),

  arrowRight: make(
    <>
      <path d="M4 12 20 12" />
      <path d="M14 6 20 12 14 18" />
    </>
  ),

  // Ribbon starts at y=14, inside the disc, so the tails read as attached
  // rather than floating just below it.
  award: make(
    <>
      <path d={ring(12, 9, 7)} />
      <path d="M8 14 8 22 12 18 16 22 16 14" />
    </>
  ),

  barChart: make(<path d="M5 20 5 14M12 20 12 6M19 20 19 10" />),

  beer: MUG_ICON,

  // The flared rim is the whole difference between a bell and an arch. It is
  // drawn as two stubs so the mouth stays open per the system: the body ended
  // in mid-air with a floating dash and read as a headphone.
  bell: make(
    <>
      <path d="M6 17 6 11A6 6 0 0 1 18 11L18 17" />
      <path d="M3 17 6 17M18 17 21 17" />
      {dot(12, 20)}
    </>
  ),

  briefcase: make(
    <>
      <path d="M3 20 3 8 21 8 21 20" />
      <path d="M9 8 9 5 15 5 15 8" />
    </>
  ),

  // One floor rule, not two. Two rules plus a door put four horizontals inside
  // 16 units, which at 14px (its only size) closed into a solid block.
  building: make(
    <>
      <path d="M5 20 5 4 19 4 19 20" />
      <path d="M5 9 19 9" />
      <path d="M10 20 10 14 14 14 14 20" />
    </>
  ),

  camera: make(
    <>
      <path d="M3 20 3 7 21 7 21 20" />
      <circle cx="12" cy="13.5" r="5" />
      <path d="M8 7 11 4 13 4 16 7" />
    </>
  ),

  chat: CHAT_ICON,

  checkCircle: make(
    <>
      <path d={ring(12, 12, 9)} />
      <path d="M7.5 12.5 10.5 15.5 16.5 9.5" />
    </>
  ),

  checkDouble: make(
    <>
      <path d="M2 12.5 6.5 17 15 8.5" />
      <path d="M11 17 19.5 8.5" />
    </>,
    { size: 14 }
  ),

  chevronUp: make(CHEVRON, { style: ROT(0) }),
  chevronRight: make(CHEVRON, { style: ROT(90) }),
  chevronDown: make(CHEVRON, { style: ROT(180) }),

  cloud: make(<path d="M4 18 4 14A4 4 0 0 1 9 10A5 5 0 0 1 15 9A5 5 0 0 1 20 14L20 18" />, {
    color: '#9ca3af',
  }),

  cocktail: STEM_ICON,

  coffee: MUG_ICON,

  // A ring bisected by a full-width diagonal read as the "prohibited" slash.
  // It is a short NE needle with a square arrowhead instead: direction, not denial.
  compass: make(
    <>
      <path d={ring(12, 12, 9)} />
      <path d="M9 15 15 9" />
      <path d="M11 9 15 9 15 13" />
    </>
  ),

  // Box + one full-width stripe read as a table. The short second rule is what
  // makes it a card. Also pulled in from 2..22, which was the widest glyph here.
  creditCard: make(
    <>
      <path d="M3 19 3 6 21 6 21 19" />
      <path d="M3 10 21 10" />
      <path d="M6 15 12 15" />
    </>
  ),

  // Ring pulled in to r=7 so the arms clear it. Flush against an r=9 ring the
  // cross read as a divided pie rather than a sight.
  crosshair: make(
    <>
      <path d={ring(12, 12, 7)} />
      <path d="M12 3 12 21" />
      <path d="M3 12 21 12" />
    </>
  ),

  // The S is built from horizontals and verticals only - a geometric dollar.
  // Bars sit 5 units apart (was 4) and run 10 wide (was 8): at the 13-15px this
  // renders at, the old spacing put three strokes inside 2px and filled in.
  dollar: make(
    <>
      <path d="M17 7 7 7 7 12 17 12 17 17 7 17" />
      <path d="M12 4 12 20" />
    </>
  ),

  doorOpen: make(
    <>
      <path d="M4 20 4 4 16 4 16 20" />
      {dot(13, 12)}
    </>
  ),

  download: make(
    <>
      <path d="M12 5 12 20" />
      <path d="M7 15 12 20 17 15" />
    </>
  ),

  edit: make(
    <>
      <path d="M4 20 4 16 16 4 20 8 8 20Z" />
      <path d="M13 7 17 11" />
    </>
  ),

  // Recentred on 12,12. It used to live entirely in the top-right quadrant,
  // which made it read small and off-axis beside a label.
  externalLink: make(
    <>
      <path d="M7 17 17 7" />
      <path d="M10 7 17 7 17 14" />
    </>
  ),

  // Pupil is a solid disc, not a ring. The lens is only 4.7 units tall, so at
  // the 12-14px this renders at a stroked pupil merged with the lid.
  eye: make(
    <>
      <path d="M3 12A11 11 0 0 1 21 12A11 11 0 0 1 3 12Z" />
      <circle cx="12" cy="12" r="2" fill="currentColor" stroke="none" />
    </>
  ),

  fileText: make(
    <>
      <path d="M5 20 5 3 15 3 19 7 19 20" />
      <path d="M15 3 15 7 19 7" />
      <path d="M8 12 16 12" />
      <path d="M8 16 16 16" />
    </>
  ),

  filter: make(<path d="M3 5 21 5 14 12 14 20 10 20 10 12Z" />),

  flame: make(<path d="M12 2 5 9A7 7 0 0 0 19 9Z" fill="currentColor" stroke="currentColor" />, {
    color: '#F59E0B',
  }),

  gamepad: make(
    <>
      <path d="M3 18 3 7 21 7 21 18" />
      <path d="M7 11 7 15M5 13 9 13" />
      <circle cx="16.5" cy="13" r="1.5" />
    </>
  ),

  gift: make(
    <>
      <path d="M4 20 4 10 20 10 20 20" />
      <path d="M12 10 12 20" />
      <path d="M8 6 12 10 16 6" />
    </>
  ),

  // The meridian was an rx=5 ry=9 ellipse on an 18-unit chord, which is both
  // off-system and impossible: the UA silently scaled the radii to fit. Two
  // r=11 circular arcs give the same lens honestly.
  globe: make(
    <>
      <path d={ring(12, 12, 9)} />
      <path d="M3 12 21 12" />
      <path d="M12 3A11 11 0 0 1 12 21A11 11 0 0 1 12 3Z" />
    </>
  ),

  gripVertical: make(<path d="M8 8 16 8M8 12 16 12M8 16 16 16" />),

  heart: make(<path d="M12 20 4 12A5 5 0 0 1 12 7A5 5 0 0 1 20 12Z" />),

  home: make(
    <>
      <path d="M3 11 12 2 21 11" />
      <path d="M5 20 5 9M19 20 19 9" />
      <path d="M10 20 10 15 14 15 14 20" />
    </>
  ),

  image: make(
    <>
      <path d="M3 20 3 4 21 4 21 20" />
      <circle cx="8" cy="9" r="3" />
      <path d="M4 18 10 12 14 16 20 10" />
    </>
  ),

  laugh: make(
    <>
      <path d={ring(12, 12, 9)} />
      <path d="M8 14A5 5 0 0 0 16 14" />
      {dot(9, 10)}
      {dot(15, 10)}
    </>
  ),

  layers: make(
    <>
      <path d="M4 20 4 12 20 12 20 20" />
      <path d="M6 9 18 9" />
      <path d="M8 6 16 6" />
    </>
  ),

  lock: make(
    <>
      <path d="M5 20 5 11 19 11 19 20" />
      <path d="M8 11 8 7A4 4 0 0 1 16 7L16 11" />
    </>
  ),

  // The shaft starts on the door's own edge. Starting it inside the doorway put
  // a T-junction on the wall that filled in at 14px.
  logout: make(
    <>
      <path d="M4 20 4 4 12 4 12 20" />
      <path d="M12 12 21 12" />
      <path d="M16 7 21 12 16 17" />
    </>
  ),

  mail: make(
    <>
      <path d="M4 19 4 6 20 6 20 19" />
      <path d="M4 6 12 14 20 6" />
    </>
  ),

  map: make(
    <>
      <path d="M4 20 4 6 20 6 20 20" />
      <path d="M7 17 12 12 12 9 17 9" />
    </>
  ),

  messageSquare: CHAT_ICON,

  mic: make(
    <>
      <path d="M9 13 9 6A3 3 0 0 1 15 6L15 13A3 3 0 0 1 9 13Z" />
      <path d="M5 13A7 7 0 0 0 19 13" />
      <path d="M12 20 12 22" />
    </>
  ),

  minus: make(<path d="M4 12 20 12" />),

  // Solid. The crescent is 4.3 units at its widest, so as an outline its two
  // edges merged into a smudge at the 10px it is most often drawn at.
  moon: make(
    <path d="M16 3A9 9 0 1 0 16 21A11 11 0 0 1 16 3Z" fill="currentColor" stroke="currentColor" />
  ),

  moreVertical: make(
    <>
      {dot(12, 5)}
      {dot(12, 12)}
      {dot(12, 19)}
    </>
  ),

  music: make(
    <>
      <path d="M9 17 9 5 19 5 19 15" />
      <circle cx="6" cy="17" r="3" />
      <circle cx="16" cy="15" r="3" />
    </>,
    { color: '#2d5a87' }
  ),

  // Four wells, not three: three dots inside a ring read as a face.
  palette: make(
    <>
      <path d={ring(12, 12, 9)} />
      {dot(9, 9)}
      {dot(15, 9)}
      {dot(9, 15)}
      {dot(15, 15)}
    </>
  ),

  party: PARTY_ICON,
  partyPopper: PARTY_ICON,

  // Earpiece slot plus a button dot. Without the dot this is the same tall open
  // box as doorOpen and read as a doorway.
  phone: make(
    <>
      <path d="M7 20 7 3 17 3 17 20" />
      <path d="M10 6 14 6" />
      {dot(12, 17.5)}
    </>
  ),

  pieChart: make(
    <>
      <path d={ring(12, 12, 9)} />
      <path d="M12 12 12 3" />
      <path d="M12 12 18.36 18.36" />
    </>
  ),

  // pin / pinFilled - one path, two renderings, same silhouette.
  pin: make(<path d={PIN_D} fill="transparent" stroke="currentColor" />),
  pinFilled: make(<path d={PIN_D} fill="currentColor" stroke="currentColor" />),

  pizza: make(
    <>
      <path d="M12 3 4 11A11 11 0 0 0 20 11Z" />
      {dot(12, 8)}
      {dot(9.5, 12.5)}
      {dot(14.5, 12.5)}
    </>,
    { color: '#F97316' }
  ),

  // The ring's own gap is where the loop restarts; the arrowhead sits on it.
  repeat: make(
    <>
      <path d={ring(12, 12, 9)} />
      <path d="M16 4 19.5 7.5 16 11" />
    </>
  ),

  reply: make(
    <>
      <path d="M9 7 4 12 9 17" />
      <path d="M4 12 20 12 20 19" />
    </>,
    { size: 16 }
  ),

  // Birdie again, under the name the assistant surfaces are wired to.
  robot: BIRDIE_ICON,

  send: make(<path d="M6 4 14 12 6 20Z" fill="currentColor" stroke="currentColor" />),

  settings: make(
    <>
      <path d="M4 9 20 9M4 15 20 15" />
      <circle cx="9" cy="9" r="2" />
      <circle cx="15" cy="15" r="2" />
    </>
  ),

  // Tray walls run from y=13 so they read as a container the arrow leaves.
  share: make(
    <>
      <path d="M12 19 12 5" />
      <path d="M7 10 12 5 17 10" />
      <path d="M5 13 5 21M19 13 19 21" />
    </>
  ),

  shield: make(<path d="M4 4 20 4 20 13 12 21 4 13Z" />),

  // Report. This is the Apple 1.2 affordance a reviewer goes looking for, and
  // it was a bare Unicode U+2691 at four call sites - the same character that
  // once corrupted into mojibake in the moderation sheet. A drawn glyph cannot.
  // Open container per the system: the pennant carries no bottom edge, and its
  // left edge is the pole. The swallowtail notch is 45deg (it was 51.3deg).
  flag: make(
    <>
      <path d="M6 21 6 3" />
      <path d="M6 4 18 4 13 9 18 14 6 14" />
    </>
  ),

  sparkles: make(
    <>
      <path d={gull(12, 15, 5)} />
      <path d={gull(13, 8, 3)} />
    </>
  ),

  sports: make(
    <>
      <path d={ring(12, 12, 9)} />
      <path d="M4.5 8 19.5 8M4.5 16 19.5 16" />
    </>,
    { color: '#22C55E' }
  ),

  sun: make(
    <>
      <circle cx="12" cy="12" r="5" />
      <path d="M12 2 12 5M19 12 22 12M12 19 12 22M2 12 5 12" />
    </>,
    { color: '#F59E0B' }
  ),

  tag: make(
    <>
      <path d="M3 3 11 3 21 13 13 21 3 11Z" />
      <circle cx="7" cy="7" r="1.5" />
    </>
  ),

  // Rings at r=9 and r=5, not 9 and 7: two units apart they touched at 18px,
  // which is the only size this is drawn at.
  target: make(
    <>
      <path d={ring(12, 12, 9)} />
      <circle cx="12" cy="12" r="5" />
      {dot(12, 12)}
    </>
  ),

  thumbsUp: make(
    <>
      <path d="M7 20 7 10 18 10 18 20" />
      <path d="M7 10 7 6 11 2 11 10" />
    </>
  ),

  trash: make(
    <>
      <path d="M3 6 21 6" />
      <path d="M9 6 9 3 15 3 15 6" />
      <path d="M6 6 6 20M18 6 18 20" />
    </>
  ),

  trendingUp: make(
    <>
      <path d="M3 18 10 11 14 15 21 8" />
      <path d="M15 8 21 8 21 14" />
    </>
  ),

  upload: make(
    <>
      <path d="M12 20 12 5" />
      <path d="M7 10 12 5 17 10" />
    </>
  ),

  user: make(
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 20A8 8 0 0 1 20 20" />
    </>
  ),

  userPlus: make(
    <>
      <circle cx="9" cy="8" r="4" />
      <path d="M2 20A7 7 0 0 1 16 20" />
      <path d="M18 6 18 12M15 9 21 9" />
    </>
  ),

  // Ballot box, not a tray. At 9 units tall it stood barely a third the height
  // of its neighbours, and it is called at sizes 9 and 10.
  vote: make(
    <>
      <path d="M4 20 4 7 20 7 20 20" />
      <path d="M8 13 11 16 16 11" />
    </>
  ),

  // Two birds at two distances: a greeting from across the field.
  wave: make(
    <>
      <path d={gull(8, 13, 4)} />
      <path d={gull(17, 10, 3)} />
    </>
  ),

  wine: STEM_ICON,

  // A lightning bolt cannot be built from 0/45/90 without collapsing on
  // itself, so zap is the same idea drawn as one 45deg zigzag.
  zap: make(<path d="M18 3 9 12 15 12 6 21" />, { color: '#F59E0B' }),
};

export default Icons;
export { Icons, sw, ring, gull, dot };
