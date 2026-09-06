/**
 * Flock icon system - Tier C.
 *
 * One geometry, obeyed 90-odd times:
 *   - round caps, round joins. (Butt caps + miter joins + zero radius were the
 *     set's 2015 tell. Retired 2026-08: the caps live on the shared <svg>
 *     props, so most glyphs kept their paths and simply re-capped.)
 *   - straight segments default to 0 / 45 / 90 degrees. Gentle curves are
 *     allowed where a glyph's IDENTITY needs them - a dollar sign's bowls, a
 *     bell's skirt, a bow's loops, a mug's handle - and only there. A curve is
 *     always a circular arc, never elliptical, and every radius is a whole
 *     unit or a half. No arbitrary decimals.
 *   - CONTAINERS ARE CLOSED. The old signature cut every ring of r >= 7 with
 *     a 30 degree gap and deleted every rectangular container's bottom edge.
 *     That signature is retired - the brand-identity job moved to the bird
 *     mascots - and an open box now reads as unfinished, not as a voice. A
 *     gap survives only where the gap IS the glyph's meaning: doorOpen's
 *     doorway, the doors on home and building, share's open top and logout's
 *     open side (the arrow leaves through them), repeat's arc break (the loop
 *     restarts there), and the mug's rim.
 *   - stroke-width is derived from the render size and applied with
 *     vector-effect: non-scaling-stroke. The exact contract, with the
 *     measurements behind it, is documented on sw() below - the short form is
 *     one size:stroke ratio (10.5:1) held across every size the app draws,
 *     with a 1px floor and a 4.5px ceiling that does not engage until 47px.
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

/**
 * Stroke weight in rendered CSS pixels.
 *
 * This used to be five hard bands (1.25 / 1.5 / 1.75 / 2 / 2.5 / 3) and the
 * header above claimed the result was "optically comparable at 10px and at
 * 40px". It measurably was not. Size-to-stroke ratio under the old bands:
 *
 *     12px -> 9.6:1   14px -> 9.3:1   16px -> 10.7:1
 *     18px -> 10.3:1  24px -> 12.0:1  32px -> 12.8:1
 *
 * a 38% spread, and non-monotonic: 14px came out HEAVIER than 12px because
 * both sat in bands whose width did not match the sizes actually called. On
 * screen that reads as the small icons looking chunky and the 24-32px ones
 * looking hairline - which is exactly what a header icon next to a 14px
 * section heading looks like in the venue dashboard.
 *
 * One ratio, held everywhere: 10.5:1. That is heavier than Lucide/Feather
 * (12:1) on purpose - this set is thin-walled, and it needs the weight - but
 * it no longer drifts. The floor exists because below ~1px a stroke stops
 * being antialiased into a visible line on a 1x display; the ceiling stops a
 * 96px marketing render from turning into a blob. The ceiling sits at 4.5,
 * i.e. it does not engage until 47px - deliberately clear of 40, the largest
 * size any call site in App.js asks for, so the ratio genuinely holds
 * everywhere the app draws an icon rather than everywhere but the top.
 *
 * Old -> new at the sizes actually used: 10 -> 1.25/1.00, 12 -> 1.25/1.14,
 * 14 -> 1.5/1.33, 16 -> 1.5/1.52, 18 -> 1.75/1.71, 24 -> 2/2.29,
 * 32 -> 2.5/3.05. Small sizes get very slightly lighter, large ones
 * noticeably heavier. That is the correction, not a side effect.
 */
const SIZE_TO_STROKE = 10.5;
const sw = (size) =>
  Math.round(Math.min(4.5, Math.max(1, size / SIZE_TO_STROKE)) * 100) / 100;

const r2 = (n) => Math.round(n * 100) / 100;

/**
 * The open ring - the ONE survivor of the old open-container signature, kept
 * because `repeat` needs it: the 30 degree gap on the upper-right diagonal is
 * where the loop restarts and the arrowhead sits on it, so there the gap is
 * meaning, not style. Every other ring in the set is a closed <circle>.
 * For radius r about (cx, cy) the arc runs from theta=60deg counter-clockwise
 * the long way round to theta=30deg.
 *   r=9  -> M16.5 4.21A9 9 0 1 0 19.79 7.5
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
    strokeLinecap="round"
    strokeLinejoin="round"
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

/**
 * The filled star as a plain HTML string, for DOM-string contexts where JSX
 * cannot reach (the MapLibre marker label in App.js is built with innerHTML).
 * Same STAR_D geometry, size-derived stroke, and round caps/joins as
 * Icons.starFilled, so a label star can never drift from the system star.
 */
const starSvgString = (size = 12) =>
  `<svg class="flock-icon" width="${size}" height="${size}" viewBox="0 0 24 24" ` +
  `fill="none" stroke="currentColor" stroke-width="${sw(size)}" ` +
  `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">` +
  `<path d="${STAR_D}" fill="currentColor" stroke="currentColor"/></svg>`;

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

// mug - beer and coffee are the same mark. Closed at the bottom (with r=2
// corner arcs so it sits like crockery, not like a box), open at the rim -
// the rim is where the drink is, so that gap is meaning. The handle is a full
// semicircular loop, which is the single detail that says "mug" at 12px.
const MUG = (
  <>
    <path d="M5 8 5 18A2 2 0 0 0 7 20L15 20A2 2 0 0 0 17 18L17 8" />
    <path d="M17 10A3 3 0 0 1 17 16" />
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

// chat / messageSquare - a closed bubble with the tail drawn as part of the
// outline. The old version was an open-bottom box with a floating tail; the
// closed contour is the universal speech-bubble silhouette.
const CHAT = <path d="M4 6 20 6 20 18 12 18 9 21 9 18 4 18Z" />;

// party / partyPopper - a popper cone with a burst actually leaving it: three
// straight rays fanning up / diagonal / out from the mouth, two confetti dots
// in the spaces between. The old three parallel 45deg dashes read as motion
// lines, not a party; arc streamers were tried and read as scattered noise.
const PARTY = (
  <>
    <path d="M3 21 3 13 11 21Z" />
    <path d="M7.5 10 7.5 4" />
    <path d="M11 12.5 16 7.5" />
    <path d="M13.5 16 20 16" />
    {dot(13, 4)}
    {dot(20, 10.5)}
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
  // arms are the ring's own 45deg diagonals continued. Closed head - at the
  // 10-14px this icon mostly renders at, any gap is noise in the most used
  // glyph in the app.
  mapPin: make(
    <>
      <circle cx="12" cy="11" r="6" />
      <path d="M7.76 15.24 12 19.48 16.24 15.24" />
    </>
  ),

  // 2. x
  x: make(<path d="M6 6 18 18M18 6 6 18" />),

  // 3. search. Closed lens; the handle starts on the ring's own lower-right
  // diagonal.
  search: make(
    <>
      <circle cx="10" cy="10" r="7" />
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

  // 9. clock. Hands at exactly 90 and 0, so the glyph is 0/90 plus one circle.
  clock: make(
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 6.5 12 12 17 12" />
    </>
  ),

  // 10. calendar. Closed box, header rule, hangers. The header rule is not
  // decoration - it is the one line that stops this being a chat bubble. The
  // old drawing was an open box carrying THREE dots on a single row at y=13.5,
  // which at the 14 and 18px the venue dashboard calls it at is an ellipsis
  // inside a rounded container: the universal typing indicator, and a direct
  // collision with `chat`. Two dots instead of three (an ellipsis needs three)
  // on the lower row, 8 units apart, well clear of the 5-unit minimum.
  calendar: make(
    <>
      <path d="M4 7 20 7 20 20 4 20Z" />
      <path d="M8 7 8 4M16 7 16 4" />
      <path d="M4 11 20 11" />
      {dot(8, 15.5)}
      {dot(16, 15.5)}
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
      <circle cx="12" cy="12" r="9" />
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
      <circle cx="12" cy="9" r="7" />
      <path d="M8 14 8 22 12 18 16 22 16 14" />
    </>
  ),

  // Block. Added because there was no honest way to draw "this person cannot
  // reach you" out of the existing set: shield is the SOS mark, lock reads as
  // private, x reads as close, and minus reads as remove. The moderation sheet
  // (components/ModerationSheet.js) and the Blocked accounts screen in App.js
  // had each hand-rolled the same round-capped circle-and-slash instead, which
  // is the one screen an App Review reviewer opens to check Guideline 1.2.
  //
  // The ring is CLOSED: a full circle struck by a bar is the international
  // prohibition sign, and the old 30deg gap existed only to serve the retired
  // open-container signature. The slash is a 45deg chord whose two ends land
  // exactly on the r=9 ring (6.36 * sqrt(2) = 9.0), running upper-left to
  // lower-right - the orientation of the real prohibition mark.
  ban: make(
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M5.64 5.64 18.36 18.36" />
    </>
  ),

  // Three bars standing on a baseline. Without the baseline they are three
  // floating tally marks and the glyph reads as a signal-strength meter, which
  // is what it looked like sitting in the venue dashboard's Analytics tab.
  barChart: make(
    <>
      <path d="M5 20 5 14M12 20 12 6M19 20 19 10" />
      <path d="M3 20 21 20" />
    </>
  ),

  beer: MUG_ICON,

  // A real bell: dome, flared skirt closing on its own bottom rule, clapper
  // tucked just under it. The old drawing ended the body in mid-air with two
  // floating rim stubs and read as a headphone band.
  bell: make(
    <>
      <path d="M4 18 6 16 6 10A6 6 0 0 1 18 10L18 16 20 18Z" />
      {dot(12, 20.5)}
    </>
  ),

  briefcase: make(
    <>
      <path d="M3 8 21 8 21 20 3 20Z" />
      <path d="M9 8 9 5 15 5 15 8" />
    </>
  ),

  // One floor rule, not two. Two rules plus a door put four horizontals inside
  // 16 units, which at 14px (its only size) closed into a solid block. The
  // shell closes; the door keeps its open bottom - it is a doorway on the
  // ground line, which is a gap with meaning.
  building: make(
    <>
      <path d="M5 4 19 4 19 20 5 20Z" />
      <path d="M5 9 19 9" />
      <path d="M10 20 10 14 14 14 14 20" />
    </>
  ),

  camera: make(
    <>
      <path d="M3 7 21 7 21 20 3 20Z" />
      <circle cx="12" cy="13.5" r="5" />
      <path d="M8 7 11 4 13 4 16 7" />
    </>
  ),

  chat: CHAT_ICON,

  checkCircle: make(
    <>
      <circle cx="12" cy="12" r="9" />
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

  // A plain closed ring: the "not yet" mark. Exists so a checklist can pair
  // it with `check` and carry met/unmet on shape as well as colour - the
  // flock detail momentum signals are the first caller. Deliberately empty
  // inside; a dot would make it a target, a slash would make it a ban.
  circle: make(<circle cx="12" cy="12" r="9" />),

  cloud: make(<path d="M4 18 4 14A4 4 0 0 1 9 10A5 5 0 0 1 15 9A5 5 0 0 1 20 14L20 18Z" />, {
    color: '#9ca3af',
  }),

  cocktail: STEM_ICON,

  coffee: MUG_ICON,

  // A ring bisected by a full-width diagonal read as the "prohibited" slash.
  // It is a short NE needle with a square arrowhead instead: direction, not denial.
  compass: make(
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M9 15 15 9" />
      <path d="M11 9 15 9 15 13" />
    </>
  ),

  // Box + one full-width stripe read as a table. The short second rule is what
  // makes it a card. 18 x 11 (1.64:1, against a real card's 1.586), and the
  // two interior rules are spaced so nothing sits closer than 4 units to its
  // neighbour.
  creditCard: make(
    <>
      <path d="M3 7 21 7 21 18 3 18Z" />
      <path d="M3 11 21 11" />
      <path d="M6 15 12 15" />
    </>
  ),

  // Ring pulled in to r=7 so the arms clear it. Flush against an r=9 ring the
  // cross read as a divided pie rather than a sight.
  crosshair: make(
    <>
      <circle cx="12" cy="12" r="7" />
      <path d="M12 3 12 21" />
      <path d="M3 12 21 12" />
    </>
  ),

  // A real dollar sign. The old one was an S built from horizontals and
  // verticals only, and its own comment admitted the honest limit: "a $ that
  // reads instantly at 12px needs the curved bowls of a real S". The curve
  // allowance exists for exactly this glyph. Two r=3.5 semicircular bowls -
  // upper bowl opening right, lower bowl opening left, the S-motion - crossed
  // by the full-height riser.
  dollar: make(
    <>
      <path d="M17 5 9.5 5A3.5 3.5 0 0 0 9.5 12L14.5 12A3.5 3.5 0 0 1 14.5 19L7 19" />
      <path d="M12 3 12 21" />
    </>
  ),

  // The one open-bottom rectangle left in the set, because here the missing
  // edge IS the glyph: a doorway you can walk through.
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

  // The eye, struck: "the password is visible, press to hide it". Same
  // outline as `eye` so the show/hide toggle swaps without a shift; the
  // strike is one 45 degree segment. The pupil stays so the two states share
  // their DOM nodes.
  eyeOff: make(
    <>
      <path d="M3 12A11 11 0 0 1 21 12A11 11 0 0 1 3 12Z" />
      <circle cx="12" cy="12" r="2" fill="currentColor" stroke="none" />
      <path d="M5 19 19 5" />
    </>
  ),

  fileText: make(
    <>
      <path d="M5 3 15 3 19 7 19 20 5 20Z" />
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
      <path d="M3 7 21 7 21 18 3 18Z" />
      <path d="M7 11 7 15M5 13 9 13" />
      <circle cx="16.5" cy="13" r="1.5" />
    </>
  ),

  // A wrapped present: closed box, ribbon, and a bow whose two loops are real
  // loops - a 3/4 arc closed by its own chord. The old open-V bow read as a
  // tote bag's handles; a loop that closes cannot be mistaken for a handle.
  gift: make(
    <>
      <path d="M4 10 20 10 20 20 4 20Z" />
      <path d="M12 10 12 20" />
      <path d="M12 10A2.5 2.5 0 1 1 9.5 7.5L12 10Z" />
      <path d="M12 10A2.5 2.5 0 1 0 14.5 7.5L12 10Z" />
    </>
  ),

  // The meridian was an rx=5 ry=9 ellipse on an 18-unit chord, which is
  // off-system and impossible: the UA silently scaled the radii to fit. Two
  // r=11 circular arcs give the same lens honestly.
  globe: make(
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12 21 12" />
      <path d="M12 3A11 11 0 0 1 12 21A11 11 0 0 1 12 3Z" />
    </>
  ),

  gripVertical: make(<path d="M8 8 16 8M8 12 16 12M8 16 16 16" />),

  heart: make(<path d="M12 20 4 12A5 5 0 0 1 12 7A5 5 0 0 1 20 12Z" />),

  // Walls, floor and door are one contour: the floor runs wall-to-door on each
  // side, so the house is grounded and the doorway stays a real gap.
  home: make(
    <>
      <path d="M3 11 12 2 21 11" />
      <path d="M5 9 5 20 10 20 10 15 14 15 14 20 19 20 19 9" />
    </>
  ),

  image: make(
    <>
      <path d="M3 4 21 4 21 20 3 20Z" />
      <circle cx="8" cy="9" r="3" />
      <path d="M4 18 10 12 14 16 20 10" />
    </>
  ),

  laugh: make(
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M8 14A5 5 0 0 0 16 14" />
      {dot(9, 10)}
      {dot(15, 10)}
    </>
  ),

  layers: make(
    <>
      <path d="M4 12 20 12 20 20 4 20Z" />
      <path d="M6 9 18 9" />
      <path d="M8 6 16 6" />
    </>
  ),

  lock: make(
    <>
      <path d="M5 11 19 11 19 20 5 20Z" />
      <path d="M8 11 8 7A4 4 0 0 1 16 7L16 11" />
    </>
  ),

  // The frame is open on the RIGHT, where the arrow leaves - a gap with
  // meaning, per the container rule. The shaft starts on the frame's own edge:
  // starting it inside the doorway put a T-junction on the wall that filled in
  // at 14px.
  logout: make(
    <>
      <path d="M12 4 4 4 4 20 12 20" />
      <path d="M12 12 21 12" />
      <path d="M16 7 21 12 16 17" />
    </>
  ),

  mail: make(
    <>
      <path d="M4 6 20 6 20 19 4 19Z" />
      <path d="M4 6 12 14 20 6" />
    </>
  ),

  // A folded tri-panel map - the universal map silhouette. The old drawing was
  // a generic box with a route line inside it, which read as "screenshot".
  map: make(
    <>
      <path d="M9 4 3 6 3 20 9 18 15 20 21 18 21 4 15 6Z" />
      <path d="M9 4 9 18" />
      <path d="M15 6 15 20" />
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

  // A real palette: the disc carries a thumb notch bitten deep into its
  // lower-right edge (theta -20..-70 on the r=9 ring, indented by an r=4 arc,
  // 2.75 units at its deepest), and four paint wells arc along the upper-left,
  // every neighbouring pair 5+ units apart. The old ring-plus-four-symmetric-
  // dots read as a die face; a small bottom-centre notch was tried and read as
  // a 9-ball. The deep asymmetric bite is the identity.
  palette: make(
    <>
      <path d="M20.46 15.08A9 9 0 1 0 15.08 20.46A4 4 0 0 0 20.46 15.08Z" />
      {dot(7, 13.5)}
      {dot(9, 8.5)}
      {dot(14, 6.5)}
      {dot(18, 10)}
    </>
  ),

  party: PARTY_ICON,
  partyPopper: PARTY_ICON,

  // A handset-era slab reads as a doorway; a rounded slab with an earpiece
  // slot and a home dot reads as the phone in your hand. The r=2 corner arcs
  // are identity, not decoration.
  phone: make(
    <>
      <path d="M9 3 15 3A2 2 0 0 1 17 5L17 18A2 2 0 0 1 15 20L9 20A2 2 0 0 1 7 18L7 5A2 2 0 0 1 9 3Z" />
      <path d="M10 6 14 6" />
      {dot(12, 17)}
    </>
  ),

  pieChart: make(
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 12 12 3" />
      <path d="M12 12 18.36 18.36" />
    </>
  ),

  // pin / pinFilled - one path, two renderings, same silhouette.
  pin: make(<path d={PIN_D} fill="transparent" stroke="currentColor" />),
  pinFilled: make(<path d={PIN_D} fill="currentColor" stroke="currentColor" />),

  // A slice held tip-down: crust arc across the top, wedge to a point, two
  // pepperoni. The old tip-up wedge with the arc at its base read as a
  // protractor.
  pizza: make(
    <>
      <path d="M12 21 5.5 6A12 12 0 0 1 18.5 6Z" />
      {dot(9.5, 9)}
      {dot(14.5, 11)}
    </>,
    { color: '#F97316' }
  ),

  // The ring's own gap is where the loop restarts; the arrowhead sits on it.
  // This is the one glyph that keeps the open ring - here the gap is meaning.
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

  // A paper plane, not a play button. The solid right-pointing triangle this
  // replaces is the universal "play" mark and said nothing about sending.
  // Outline plus the fold line from tip to keel, both stroked-only.
  send: make(
    <>
      <path d="M21 3 3.5 9.5 10.5 13.5 14.5 20.5Z" />
      <path d="M21 3 10.5 13.5" />
    </>
  ),

  settings: make(
    <>
      <path d="M4 9 20 9M4 15 20 15" />
      <circle cx="9" cy="9" r="2" />
      <circle cx="15" cy="15" r="2" />
    </>
  ),

  // The tray closes across its bottom; the top stays open because the arrow
  // leaves through it - a gap with meaning.
  share: make(
    <>
      <path d="M12 19 12 5" />
      <path d="M7 10 12 5 17 10" />
      <path d="M5 13 5 21 19 21 19 13" />
    </>
  ),

  /* SAFETY. Two birds lifting a shield, with the tick knocked clean out of it.
     Chosen by the maintainer 2026-09-05 to replace the plain stroked shield on the SOS
     control: the old glyph was a generic security mark that said nothing about
     this product, and the birds are the one piece of Flock's language that
     appears on every other surface.

     THREE THINGS THIS ICON DOES DIFFERENTLY FROM EVERY OTHER ENTRY HERE.

     It is FILLED, not stroked, so it cannot go through make(): that helper
     hands back a 24x24 stroke-on-currentColor svg and this mark is solid
     shapes at 2048. Its own viewBox is the artwork's, cropped square around
     the content, so the drawing is untouched and only the window moved.

     The tick is a MASK, not a second fill. Painting it in the button's red
     would look identical on the SOS control and then fail the moment this icon
     is used anywhere else, because the "tick" would be a red shape sitting on
     whatever colour was actually behind it. As a hole it is correct on red, on
     navy, on cream, on a photo.

     It keeps the stroke API of its neighbours, (color, size), so call sites do
     not have to know any of the above. */
  safetyBirds: (color = 'currentColor', size = 24, label) => (
    <span className="flock-icon-wrap" style={{ color, display: 'inline-flex' }} aria-hidden={label ? undefined : true}>
      <svg
        className="flock-icon"
        width={size}
        height={size}
        viewBox="329 328 1392 1392"
        fill="currentColor"
        role={label ? 'img' : undefined}
        aria-label={label || undefined}
        aria-hidden={label ? undefined : true}
        focusable="false"
      >
        <mask id="flock-safety-tick" maskUnits="userSpaceOnUse" x="329" y="328" width="1392" height="1392">
          <rect x="329" y="328" width="1392" height="1392" fill="#fff" />
          <path d="M 1154.97 1057.16 C 1164.53 1056.78 1172.47 1058.71 1179.77 1065.35 C 1186.1 1071.07 1189.72 1079.21 1189.72 1087.74 C 1189.74 1097.41 1186.55 1104.48 1179.84 1111.11 C 1165.18 1125.62 1150.46 1140.13 1135.87 1154.71 L 1060.79 1229.84 C 1048.2 1242.26 1035.73 1254.85 1023.13 1267.24 C 1013.74 1276.47 1008.43 1282.28 994.402 1282.09 C 979.08 1281.88 965.416 1264.47 954.99 1254.15 L 916.383 1215.84 C 904.155 1203.84 884.696 1188.67 883.664 1171.45 C 883.136 1162.7 886.319 1154.14 892.433 1147.87 C 898.017 1142.14 905.442 1138.81 913.47 1138.81 C 919.337 1138.85 925.072 1140.56 930.011 1143.72 C 938.227 1148.93 948.507 1160.32 955.725 1167.56 C 969.254 1181.06 982.66 1194.68 995.94 1208.43 C 1004.61 1200.84 1017.93 1186.54 1026.72 1177.78 L 1104.7 1098.84 C 1117.03 1086.45 1138.57 1060.71 1154.97 1057.16 z" fill="#000" />
        </mask>
        <g mask="url(#flock-safety-tick)">
          <path d="M 1024.75 831.766 C 1108.08 910.009 1216.88 955.512 1331.1 959.898 C 1331.3 974.711 1329.18 995.725 1327.85 1010.6 C 1323.15 1067.99 1313.31 1124.85 1298.45 1180.48 C 1264.84 1304.78 1200.53 1407.25 1096.26 1484.09 C 1073.49 1500.87 1048.92 1515.26 1024.42 1529.34 C 1013.25 1521.83 997.212 1513.43 985.041 1505.76 C 958.399 1488.75 933.127 1469.69 909.456 1448.74 C 769.107 1322.38 727.129 1141.37 717.899 959.963 C 840.07 956.708 932.939 909.809 1024.75 831.766 z" />
        </g>
        <path d="M 378.966 519.796 C 457.408 528.335 538.154 543.229 608.253 583.086 C 669.871 618.121 737.429 677.796 755.414 749.294 C 757.676 758.288 757.89 768.006 760.474 777.268 C 762.974 779.063 761.533 778.601 765.111 778.047 C 769.592 773.05 766.771 764.741 765.739 758.603 C 761.395 732.758 750.224 709.043 736.992 686.646 C 744.872 660.867 767.742 629.327 792.124 616.552 C 811.184 606.513 833.473 604.531 854.006 611.047 C 880.47 619.415 893.281 636.016 905.421 659.456 C 923.121 665.163 933.107 671.498 948.401 681.297 C 816.123 715.516 901.544 838.235 774.942 889.321 C 733.351 902.805 695.78 898.119 652.946 897.218 C 652.752 948.248 653.771 988.601 658.332 1039.78 C 653.893 1039.96 649.452 1040.11 645.011 1040.22 C 562.617 1042.24 501.714 1005.81 444.463 951.27 C 471.148 948.744 494.759 943.944 519.206 933.038 C 559.393 915.111 590.345 884.74 613.615 847.805 C 619.646 838.232 625.909 828.982 629.958 818.269 C 609.602 815.909 587.3 809.732 571.062 796.391 C 563.616 790.274 562.44 790.948 552.911 787.657 C 534.988 781.468 526.54 774.283 514.743 760.042 L 524.406 756.402 C 492.352 743.951 462.701 721.416 444.835 691.716 L 458.761 686.374 C 456.856 685.441 454.968 684.475 453.096 683.477 C 427.022 669.506 410.076 642.019 401.647 614.396 C 407.136 614.09 411.341 613.538 416.726 612.786 C 389.117 590.001 378.573 554.731 378.966 519.796 z" />
        <path d="M 1669.2 520.488 L 1670.33 521.301 C 1670.83 523.411 1670.94 524.167 1670.85 526.345 C 1669.21 563.23 1658.73 588.299 1632.96 613.735 L 1647.9 615.303 C 1647.26 617.053 1646.62 618.798 1645.96 620.538 C 1635.03 649.351 1618.06 673.901 1589.2 686.832 C 1595.03 688.221 1598.51 689.432 1604.11 691.438 C 1590.31 720.045 1553.76 744.35 1525.25 755.943 L 1534.4 760.422 C 1521.74 776.375 1507.96 787.502 1486.83 790.091 C 1468.27 808.466 1445.1 814.243 1420.2 818.66 C 1461.35 901.135 1513 939.288 1604.15 951.2 C 1600.81 954.941 1594.82 960.953 1591.07 964.435 C 1548.09 1004.44 1494.86 1033.27 1435.79 1039.24 C 1420.63 1040.77 1406.91 1040.26 1391.85 1039.87 C 1392.82 1021.52 1394.76 1002.81 1395.74 984.189 C 1397.18 955.174 1397.67 926.12 1397.23 897.072 C 1350.75 898.105 1320.44 901.832 1275.22 889.2 C 1155.79 844.356 1227.09 723.849 1113.11 684.733 C 1109.16 683.376 1104.6 682.213 1100.55 681.054 C 1117.86 670.872 1125.91 665.647 1144.88 659.439 C 1155.39 637.62 1168 622.089 1191.32 612.769 C 1210.76 605.118 1232.43 605.441 1251.63 613.669 C 1280.42 626.248 1301.89 657.449 1313.18 685.684 C 1310.77 689.854 1308.42 694.051 1306.11 698.276 C 1297.69 713.793 1277.66 760.971 1282.63 777.734 C 1285.44 779.703 1283.84 779.119 1287.76 778.911 C 1291.21 770.65 1293.6 751.487 1296.79 741.321 C 1306.14 711.555 1324.24 684.271 1344.48 661.019 C 1424.61 568.96 1550.88 528.83 1669.2 520.488 z" />
      </svg>
    </span>
  ),

  shield: make(<path d="M4 4 20 4 20 13 12 21 4 13Z" />),

  // Report. This is the Apple 1.2 affordance a reviewer goes looking for, and
  // it was a bare Unicode U+2691 at four call sites - the same character that
  // once corrupted into mojibake in the moderation sheet. A drawn glyph cannot.
  // The pennant closes back onto its own pole; the swallowtail notch is 45deg.
  flag: make(
    <>
      <path d="M6 21 6 3" />
      <path d="M6 4 18 4 13 9 18 14 6 14Z" />
    </>
  ),

  // Siren — promoted from the SOS EmergencySheet's local glyph (2026-08-14),
  // where it sits beside the "Emergency" title. Dome: two verticals joined by
  // an r=5 circular arc, closed across its own bottom (container rule); a base
  // plinth; three light rays, one vertical and two at 45 degrees.
  siren: make(
    <>
      <path d="M7 19 7 13A5 5 0 0 1 17 13L17 19Z" />
      <path d="M4 19 20 19" />
      <path d="M12 2 12 4.5" />
      <path d="M5 5 6.75 6.75" />
      <path d="M19 5 17.25 6.75" />
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
      <circle cx="12" cy="12" r="9" />
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
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="5" />
      {dot(12, 12)}
    </>
  ),

  thumbsUp: make(
    <>
      <path d="M7 10 18 10 18 20 7 20Z" />
      <path d="M7 10 7 6 11 2 11 10" />
    </>
  ),

  // Lid, handle, and a can that stands on its own base - r=2 corner arcs so
  // the base reads as a can, not a crate.
  trash: make(
    <>
      <path d="M3 6 21 6" />
      <path d="M9 6 9 3 15 3 15 6" />
      <path d="M6 6 6 18A2 2 0 0 0 8 20L16 20A2 2 0 0 0 18 18L18 6" />
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
      <path d="M4 7 20 7 20 20 4 20Z" />
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
export { Icons, sw, ring, gull, dot, starSvgString };
