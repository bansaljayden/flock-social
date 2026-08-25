import React, { useEffect, useRef } from 'react';

// ---------------------------------------------------------------------------
// Birdie — the photoreal mascot, in two stacked cutouts on one canvas:
//
//   /birdie/birdie-body-400.png   the whole bird (1x, 631x800 as 2x)
//   /birdie/birdie-head-400.png   just the head, feathered at the neck, on an
//                                 identical canvas, so the two line up exactly
//                                 at rest with no offset math
//
// Every one of those files now has a .webp sibling, served through <picture>
// with the PNG left in place as the fallback for an engine that cannot decode
// WebP. The saving is not a web nicety here: this is a Capacitor app, so the
// photographs are bytes in the download. Retina was the expensive case, because
// the 2x entry of every srcSet was an uncompressed master. Per bird at 2x:
// body 176KB -> 74KB, head 68KB -> 48KB, wings 304KB -> 104KB.
//
// The body deliberately keeps its own head underneath. As the head layer
// swings away, what shows through is more bird rather than a hole.
//
// He watches you with his HEAD, not his whole body. The head turns around a
// neck pivot; the body stays planted and only breathes, rises, and hops. One
// rAF loop drives all of it:
//
//   • the head turns toward the cursor anywhere in the window, far enough to
//     read as "he is looking at me"
//   • when the cursor comes close he perks up: a quick rise, then a settle
//   • tap or click him and he hops, with squash on the crouch and the landing
//   • with no pointer around (touch, or an idle desktop) he holds still and
//     then makes one deliberate look every few seconds. He never wobbles.
//   • a slow breath underneath all of it, ~4s a cycle
//
// Three elements: the body, a head carrier that copies the body transform
// exactly (so the head rides the hop and the breath), and the head itself,
// which rotates about the neck inside that carrier. Copying the body
// transform onto the carrier is what keeps the neck seam closed — if the head
// rotated about the neck AND scaled about the feet in one transform list, the
// two layers would drift apart.
//
// No CSS filters (they re-rasterize every frame in the Capacitor WebView) and
// nothing painted on top of the photo.
//
// Everything this component costs is scoped to "on screen, awake, and allowed
// to move". The loop, the window listeners, the compositor layers and the
// wings-spread image all appear when he scrolls into view and all go away
// again when he leaves, when the tab or the app goes to the background, or
// when prefers-reduced-motion is on, where the two layers simply stack into
// the original bird and stand still.
// ---------------------------------------------------------------------------

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const lerp = (a, b, t) => a + (b - a) * t;
// Ease-out only. A photographed bird that overshoots looks like a glitch.
const easeOut = (t) => (t >= 1 ? 1 : 1 - Math.pow(2, -9 * t));
const easeOutCubic = (t) => 1 - Math.pow(1 - clamp(t, 0, 1), 3);

// Wing flap. A separate photographed frame of the same bird with its wings
// spread, scaled and aligned so the torso and the feet land exactly where the
// perched bird's are, then padded out so the wingspan is not clipped. The pad
// is why this layer is bigger than its box and offset negatively: those four
// numbers come straight from the alignment pass and must not be nudged by eye.
const FLAP = { width: '159.43%', height: '113.38%', left: '-19.02%', top: '-13.38%' };
const FLAP_IN = 90;    // ms to open the wings
const FLAP_HOLD = 190; // ms spread
const FLAP_OUT = 190;  // ms to fold them back

const MAX_TURN = 12;       // degrees of head turn. Past ~15 the neck breaks.
// Head travel with the turn, as a fraction of his width. Kept small: the body
// underneath still has its own head, and sliding the head layer far off it
// uncovers that second beak.
const HEAD_SLIDE = 0.014;
const HOP_HEIGHT = 0.26;   // hop apex, fraction of his width
const HOP_MS = 700;
const PERK_MS = 1100;
const IDLE_AFTER = 2600;   // ms of pointer silence before he entertains himself

// Frame budget, in ms between rendered frames. Nothing here needs 120Hz: on a
// ProMotion iPhone an uncapped rAF loop writes twice the styles for motion no
// eye resolves. 14 caps him at 60 while he is reacting to something; 28 caps
// him at 30 while the only thing moving is a 4-second breath at 0.8% scale.
// Both sit just under a real frame interval so a 60Hz panel never beats
// against the gate and drops to half rate by accident.
const STEP_BUSY = 14;
const STEP_CALM = 28;
// How long a cached rect is trusted before it is re-read anyway. Scroll,
// resize and element-resize all invalidate it immediately; this only catches
// layout that moved for a reason nothing told us about: a lazy image above him
// arriving, a font swapping, or the AI panel transitioning its own `bottom`
// and carrying him with it. Four reads a second against sixty.
const REMEASURE_MS = 250;

// Where the head meets the shoulders, in the head layer's own box. The head
// sits right of centre on the canvas, so the pivot does too.
const NECK = '66% 37%';

// The two photographed birds. Same loop drives both: each supplies a body, a
// head feathered at its own neck line on an identical canvas, and the pivot
// that neck sits on. Birdie also has a wings-spread frame; the warm bird does
// not, so the flap layer is optional and the hop simply runs without it.
//
// Each path below is a STEM, and every stem needs four files on disk:
// `-400.png`, `.png`, `-400.webp`, `.webp`. <picture> falls back to the <img>
// when the browser cannot decode the source's TYPE, never when the chosen URL
// 404s, so a missing .webp is a broken bird rather than a quiet downgrade to
// the PNG.
//
// These are module constants on purpose — the effect keys off the flap path,
// but the render reads the whole object every time.
export const BIRDIE = {
  body: '/birdie/birdie-body',
  head: '/birdie/birdie-head',
  flap: '/birdie/birdie-flap',
  neck: NECK,
};
export const WARM_BIRD = {
  body: '/birdie/warm-bird',
  head: '/birdie/warm-bird-head',
  flap: null,
  neck: '62% 32%',
};

// --- shared pointer --------------------------------------------------------
// One set of window listeners for the whole page however many birds are on it.
// The pricing section alone renders two, and a per-instance pointermove
// handler is work charged to the same thread that is running the animation.
const pointer = { x: 0, y: 0, seen: false, at: -Infinity };
let pointerRefs = 0;

const onWindowPointer = (e) => {
  // Touch has no hover. A finger dragging the page is not a cursor to follow,
  // and tracking it would turn every scroll into head motion. Taps still make
  // him hop; that listener is separate and lives on the bird itself.
  if (e.pointerType === 'touch') return;
  pointer.x = e.clientX;
  pointer.y = e.clientY;
  pointer.seen = true;
  pointer.at = performance.now();
};

// Cursor left the window, or the window lost focus. Either way there is no
// longer anything to look at, so he goes idle now instead of staring at the
// edge the cursor left through for another two and a half seconds.
const onWindowPointerGone = (e) => {
  if (e && e.type === 'pointerout' && e.relatedTarget) return;
  pointer.at = -Infinity;
};

const retainPointer = () => {
  if (pointerRefs++ > 0) return;
  window.addEventListener('pointermove', onWindowPointer, { passive: true });
  window.addEventListener('pointerdown', onWindowPointer, { passive: true });
  window.addEventListener('pointerout', onWindowPointerGone, { passive: true });
  window.addEventListener('blur', onWindowPointerGone);
};

const releasePointer = () => {
  if (--pointerRefs > 0) return;
  pointerRefs = 0;
  window.removeEventListener('pointermove', onWindowPointer);
  window.removeEventListener('pointerdown', onWindowPointer);
  window.removeEventListener('pointerout', onWindowPointerGone);
  window.removeEventListener('blur', onWindowPointerGone);
};

// requestIdleCallback landed in Safari 16.4; older WebViews get a plain delay.
const idleIn = (fn) =>
  window.requestIdleCallback ? window.requestIdleCallback(fn, { timeout: 1500 }) : window.setTimeout(fn, 400);
const idleCancel = (h) =>
  window.requestIdleCallback ? window.cancelIdleCallback(h) : window.clearTimeout(h);

// The <picture> elements are pure transport for the WebP <source>: they must
// not exist as far as layout is concerned, or the absolutely positioned layers
// below would resolve against a new inline box instead of the wrapper.
const PICTURE = { display: 'contents' };

const layer = {
  position: 'absolute',
  left: 0,
  top: 0,
  width: '100%',
  height: '100%',
  objectFit: 'contain',
  objectPosition: 'center bottom',
  userSelect: 'none',
  WebkitUserSelect: 'none',
  // Promotion is applied by the loop and taken back when it stops, so an
  // off-screen or reduced-motion bird holds no compositor texture.
  willChange: 'auto',
};

// ---------------------------------------------------------------------------
// BirdieStill — the same photographed bird, standing still.
//
// For the dashboards and other work surfaces: they get the mark, not the
// machinery. No rAF loop, no window listeners, no IntersectionObserver, no
// compositor promotion — two <img> layers at rest, which is pixel-identical
// to what BirdieBird renders between moves.
//
// It still composites body + head, and that is not optional. The body file's
// own head is deliberately soft (the sharp turning head normally sits over
// it, and what shows through mid-turn should be more bird rather than a
// hole), so the bare body image reads as a blurry face at ANY size. If you
// want the bird without the head layer, you want a different asset.
//
// The wrapper carries explicit width/height, so the box is reserved before
// either photo arrives and nothing below it shifts when they do. WebP through
// <picture> with the PNG fallback, same as everything else here.
// ---------------------------------------------------------------------------
export function BirdieStill({ size = 96, bird = BIRDIE, style, eager = false }) {
  const loading = eager ? 'eager' : 'lazy';
  return (
    <div style={{ width: size, height: size, position: 'relative', ...style }} aria-hidden="true">
      <picture style={PICTURE}>
        <source type="image/webp" srcSet={`${bird.body}-400.webp 1x, ${bird.body}.webp 2x`} />
        <img
          src={`${bird.body}-400.png`}
          srcSet={`${bird.body}-400.png 1x, ${bird.body}.png 2x`}
          alt=""
          draggable={false}
          decoding="async"
          loading={loading}
          style={layer}
        />
      </picture>
      <picture style={PICTURE}>
        <source type="image/webp" srcSet={`${bird.head}-400.webp 1x, ${bird.head}.webp 2x`} />
        <img
          src={`${bird.head}-400.png`}
          srcSet={`${bird.head}-400.png 1x, ${bird.head}.png 2x`}
          alt=""
          draggable={false}
          decoding="async"
          loading={loading}
          style={layer}
        />
      </picture>
    </div>
  );
}

// ---------------------------------------------------------------------------
// BirdNote — the one shape every bird-carrying empty and error state shares.
//
// Jayden, reviewing build 26 (2026-08-21): "Any error page or no-content page
// needs a bird. We have five birds, and we can add multiple of them." This is
// the reusable form of that instruction, so the sweep is one component reused
// rather than twenty pasted <img> stacks.
//
// Two layouts, chosen by what the state is:
//
//   stack   a centered column — bird, then the words. For states that own
//           their card or page (a true-empty inbox, a body with nothing in
//           it). The bird gets room here, 64px and up.
//   row     the bird beside the words, feet level with the text block. For
//           error banners and notice cards, where a full-height centered
//           stack would shout about a failure the copy states quietly.
//
// The honesty rule survives the sweep: the bird DECORATES a state, it never
// relabels one. Error copy still says the load failed; the bird beside it is
// company, not a claim that the list is empty. (The old rule — birds only on
// genuine-empty — was superseded by the instruction quoted above, and
// birdBrandMoments.test.js records the handover.)
//
// `title`/`body` are plain strings styled off the app tokens; `action` is a
// ready ReactNode (usually the Try again button the call site already had).
// ---------------------------------------------------------------------------
export function BirdNote({
  bird = BIRDIE,
  size = 64,
  layout = 'stack',
  title,
  body,
  action,
  eager = false,
  style,
}) {
  const words = (
    <>
      {title && (
        <p style={{ fontSize: 'var(--t-label)', fontWeight: '600', color: 'var(--text-primary)', margin: '0 0 4px' }}>{title}</p>
      )}
      {body && (
        <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: 0, lineHeight: 1.5 }}>{body}</p>
      )}
      {action && <div style={{ marginTop: '10px' }}>{action}</div>}
    </>
  );
  if (layout === 'row') {
    return (
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: '12px', ...style }}>
        <BirdieStill bird={bird} size={Math.max(48, size)} eager={eager} style={{ flexShrink: 0 }} />
        <div style={{ flex: 1, minWidth: 0, paddingBottom: '2px' }}>{words}</div>
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', padding: '14px 0 6px', ...style }}>
      <BirdieStill bird={bird} size={size} eager={eager} />
      <div style={{ marginTop: '10px', maxWidth: '300px' }}>{words}</div>
    </div>
  );
}

// `dark` is accepted so existing call sites keep working. The photo carries
// its own light and reads on both surfaces, so no per-theme treatment.
//
// `eager` is the escape hatch for a call site that puts him above the fold.
// Every current one is below it (the landing page's Birdie and pricing
// sections, and the AI panel, which does not exist until you open it), so the
// default defers ~122KB of WebP at 2x per bird (245KB before the conversion)
// until he is actually scrolled to.
export default function BirdieBird({ size = 200, dark = false, style, bird = BIRDIE, eager = false }) {
  const wrapRef = useRef(null);
  const bodyRef = useRef(null);
  const carrierRef = useRef(null);
  const headRef = useRef(null);
  const flapRef = useRef(null);
  // The flap's WebP <source>. The flap is armed imperatively (see armFlap), and
  // a <source> is only consulted if it HAS a srcset attribute, so this one is
  // rendered bare and filled in at the same moment as the <img> beneath it.
  const flapWebpRef = useRef(null);

  // Read through a ref inside the loop rather than closed over, so resizing
  // him (the AI panel does, on expand) does not tear the loop down and rebuild
  // every listener.
  const sizeRef = useRef(size);
  sizeRef.current = size;

  const flapSrc = bird.flap;

  useEffect(() => {
    const wrap = wrapRef.current;
    const body = bodyRef.current;
    const carrier = carrierRef.current;
    const head = headRef.current;
    const flap = flapRef.current;
    const flapWebp = flapWebpRef.current;
    // flap is optional — only Birdie has a wings-spread frame.
    if (!wrap || !body || !carrier || !head) return undefined;

    const mq = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
    let reduced = !!(mq && mq.matches);

    // --- pose state --------------------------------------------------------
    let curX = 0, curY = 0;   // smoothed aim, -1..1
    let prox = 0;             // smoothed proximity, 0..1
    let nearLatch = false;

    // --- idle state machine ------------------------------------------------
    let idleReady = false, idleMoving = false;
    let idleFromX = 0, idleFromY = 0, idleToX = 0, idleToY = 0;
    let idleT0 = 0, idleDur = 700, idleNext = 0;

    // --- one-shot impulses -------------------------------------------------
    let perkT0 = -Infinity;
    let hopT0 = -Infinity;

    let last = 0, raf = 0, running = false, inView = false, holding = false;

    // Last pose actually written, quantised to what survives the trip to the
    // screen. A frame that rounds to the same pose writes no style and builds
    // no string, so the calm 30Hz loop mostly allocates nothing at all.
    let qBY = NaN, qBX = NaN, qBSY = NaN;
    let qHX = NaN, qHY = NaN, qHR = NaN;
    let qFA = NaN;

    // --- cached geometry ---------------------------------------------------
    // getBoundingClientRect in the frame callback forces a synchronous layout
    // every frame, per bird, right after that same frame wrote transforms.
    // Cache it and re-read only when something could have moved him.
    let mx = 0, my = 0, mw = 0, mh = 0;
    let measuredAt = -Infinity;
    let stale = true;
    const invalidate = () => { stale = true; };

    const measure = (now) => {
      const r = wrap.getBoundingClientRect();
      mw = r.width || sizeRef.current;
      mh = r.height || sizeRef.current;
      // His head sits right of centre on the canvas, near the top.
      mx = r.left + mw * 0.66;
      my = r.top + mh * 0.21;
      measuredAt = now;
      stale = false;
    };

    const onHop = () => {
      const now = performance.now();
      // Ignore a re-tap mid-hop so it can't stutter. No perk on top of it
      // either: the hop is already the whole reaction.
      if (now - hopT0 < HOP_MS) return;
      hopT0 = now;
    };

    const startIdleMove = (now, fromX, fromY) => {
      idleFromX = fromX;
      idleFromY = fromY;
      // Mostly look the other way; a third of the time just resettle in place.
      const settle = Math.random() < 0.32;
      const dir = fromX > 0.12 ? -1 : fromX < -0.12 ? 1 : (Math.random() < 0.5 ? -1 : 1);
      const mag = settle ? 0.08 + Math.random() * 0.16 : 0.34 + Math.random() * 0.5;
      idleToX = clamp(dir * mag, -0.85, 0.85);
      idleToY = (Math.random() * 2 - 1) * 0.3;
      idleDur = settle ? 420 + Math.random() * 220 : 480 + Math.random() * 420;
      idleT0 = now;
      idleMoving = true;
    };

    const frame = (now) => {
      if (!running) { raf = 0; return; }
      raf = requestAnimationFrame(frame);

      const live = pointer.seen && now - pointer.at < IDLE_AFTER;
      // Anything with a deadline runs at full rate. A bird that is only
      // breathing does not.
      const busy = live || idleMoving || prox > 0.002 ||
        now - hopT0 < HOP_MS || now - perkT0 < PERK_MS;
      const step = now - last;
      if (step < (busy ? STEP_BUSY : STEP_CALM)) return;

      // rAF timestamps are taken at the top of the frame and can read slightly
      // earlier than a performance.now() called just before scheduling, so the
      // first step of a run can be negative. Clamped at both ends: a negative
      // dt would drive the smoothing backwards, a huge one would teleport him.
      const dt = clamp(step, 0, 64);
      last = now;

      if (stale || now - measuredAt > REMEASURE_MS) measure(now);
      const w = mw, h = mh, hx = mx, hy = my;

      let aimX, aimY, tau;

      if (live) {
        idleReady = false;
        // Map most of the window onto his range so he keeps turning instead of
        // pinning at full deflection the moment the cursor leaves his column.
        const reachX = Math.max(w * 2.5, window.innerWidth * 0.42);
        const reachY = Math.max(h * 2.0, window.innerHeight * 0.38);
        const nx = clamp((pointer.x - hx) / reachX, -1, 1);
        const ny = clamp((pointer.y - hy) / reachY, -1, 1);
        // Slight expansion so small nearby moves are still legible.
        aimX = Math.sign(nx) * Math.pow(Math.abs(nx), 0.8);
        aimY = Math.sign(ny) * Math.pow(Math.abs(ny), 0.85);
        tau = 140;
      } else {
        // Hold still, then one considered look, then hold again.
        if (!idleReady) {
          idleReady = true;
          idleMoving = false;
          idleToX = curX;
          idleToY = curY;
          idleNext = now + 500 + Math.random() * 900;
        }
        if (idleMoving) {
          const p = (now - idleT0) / idleDur;
          if (p >= 1) {
            idleMoving = false;
            idleNext = now + 1600 + Math.random() * 2800;
            aimX = idleToX;
            aimY = idleToY;
          } else {
            const e = easeOut(p);
            aimX = lerp(idleFromX, idleToX, e);
            aimY = lerp(idleFromY, idleToY, e);
          }
        } else {
          aimX = idleToX;
          aimY = idleToY;
          if (now >= idleNext) startIdleMove(now, idleToX, idleToY);
        }
        // The idle curve is already eased, so barely smooth it again.
        tau = 70;
      }

      // Frame-rate independent smoothing.
      const k = 1 - Math.exp(-dt / tau);
      curX = lerp(curX, aimX, k);
      curY = lerp(curY, aimY, k);

      // --- proximity -------------------------------------------------------
      let rawProx = 0;
      if (live) {
        const radius = Math.max(w * 2.6, 300);
        // Not Math.hypot: it does overflow-safe scaling nobody needs for two
        // screen coordinates, and it is several times slower for it.
        const dx = pointer.x - hx, dy = pointer.y - hy;
        rawProx = clamp(1 - Math.sqrt(dx * dx + dy * dy) / radius, 0, 1);
      }
      prox = lerp(prox, rawProx, 1 - Math.exp(-dt / 180));

      // Perk up on approach, with hysteresis so it fires once per visit.
      if (rawProx > 0.55 && !nearLatch) {
        nearLatch = true;
        if (now - perkT0 > PERK_MS * 0.6) perkT0 = now;
      } else if (rawProx < 0.32) {
        nearLatch = false;
      }

      // --- impulses --------------------------------------------------------
      let perk = 0;
      const pt = (now - perkT0) / PERK_MS;
      if (pt >= 0 && pt < 1) {
        perk = pt < 0.16
          ? easeOutCubic(pt / 0.16)                 // snap to attention
          : 1 - easeOutCubic((pt - 0.16) / 0.84);   // and settle back down
      }

      let hopY = 0, hopSX = 1, hopSY = 1;
      const ht = (now - hopT0) / HOP_MS;
      if (ht >= 0 && ht < 1) {
        if (ht < 0.14) {
          // Crouch.
          const u = easeOutCubic(ht / 0.14);
          hopSY = 1 - 0.05 * u;
          hopSX = 1 + 0.05 * u;
        } else if (ht < 0.76) {
          // Airborne: stretched off the ground and into the landing, neutral
          // at the apex.
          const p = (ht - 0.14) / 0.62;
          const arc = 4 * p * (1 - p);
          const vel = Math.abs(1 - 2 * p);
          hopY = -HOP_HEIGHT * w * arc;
          hopSY = 1 + 0.04 * vel;
          hopSX = 1 - 0.04 * vel;
        } else {
          // Land, absorb, recover.
          const u = 1 - easeOutCubic((ht - 0.76) / 0.24);
          hopSY = 1 - 0.06 * u;
          hopSX = 1 + 0.06 * u;
        }
      }

      // --- wings: spread on the way up, folded by the landing --------------
      // Cross-faded rather than cut, so the swap reads as motion blur instead
      // of a jump between two photographs.
      let flapA = 0;
      const fe = now - hopT0;
      if (fe >= 0 && fe < FLAP_IN + FLAP_HOLD + FLAP_OUT) {
        flapA = fe < FLAP_IN
          ? easeOutCubic(fe / FLAP_IN)
          : fe < FLAP_IN + FLAP_HOLD
            ? 1
            : 1 - easeOutCubic((fe - FLAP_IN - FLAP_HOLD) / FLAP_OUT);
      }

      // --- body: planted. Breath, rise, hop. No lean, no follow. -----------
      const breathPhase = (now / 4200) * Math.PI * 2;
      const breathe = 1 + Math.sin(breathPhase) * 0.008;
      const breathY = Math.sin(breathPhase) * h * -0.005;

      const bodyY =
        breathY +
        prox * h * -0.018 +   // stands a little taller while you're near
        perk * h * -0.06 +    // the perk itself
        hopY;

      const base = breathe * (1 + prox * 0.035) * (1 + perk * 0.015);

      // --- head: the part that actually watches you ------------------------
      const turn = clamp(curX * MAX_TURN, -MAX_TURN, MAX_TURN);
      const headX = curX * w * HEAD_SLIDE;
      const headY = curY * h * 0.018 + perk * h * -0.012;

      // --- write, and only what changed ------------------------------------
      const nBY = Math.round(bodyY * 10);
      const nBX = Math.round(base * hopSX * 1000);
      const nBSY = Math.round(base * hopSY * 1000);
      if (nBY !== qBY || nBX !== qBX || nBSY !== qBSY) {
        qBY = nBY; qBX = nBX; qBSY = nBSY;
        const t = `translate(0px, ${nBY / 10}px) scale(${nBX / 1000}, ${nBSY / 1000})`;
        body.style.transform = t;
        carrier.style.transform = t;
        // The flap frame is a whole bird, so it rides the same transform. It
        // carries its own head, so the head layer hides while it is up.
        if (flap) flap.style.transform = t;
      }

      const nHX = Math.round(headX * 10);
      const nHY = Math.round(headY * 10);
      const nHR = Math.round(turn * 100);
      if (nHX !== qHX || nHY !== qHY || nHR !== qHR) {
        qHX = nHX; qHY = nHY; qHR = nHR;
        head.style.transform =
          `translate(${nHX / 10}px, ${nHY / 10}px) rotate(${nHR / 100}deg)`;
      }

      if (flap) {
        const nFA = Math.round(flapA * 1000);
        if (nFA !== qFA) {
          qFA = nFA;
          flap.style.opacity = nFA / 1000;
          // Fade the perched body out underneath so folded wings do not show
          // through the spread ones, and drop the turning head with it.
          const under = (1000 - nFA) / 1000;
          body.style.opacity = under;
          carrier.style.opacity = under;
        }
      }
    };

    // --- promotion ---------------------------------------------------------
    // will-change costs a compositor texture for as long as it is set: at 3x
    // on a phone each of these layers is a megabyte or so, and the landing
    // page mounts three birds. So it is set for exactly as long as the loop is
    // running and taken straight back when it stops.
    //
    // This is also why the transforms above are 2D translate() and not the
    // usual translate3d() hack: translate3d pins a layer whatever will-change
    // says, so turning promotion off would have freed nothing. will-change is
    // what promotes here, which means dropping it genuinely hands the texture
    // back for an off-screen, backgrounded or reduced-motion bird.
    const promote = (on) => {
      const v = on ? 'transform' : 'auto';
      body.style.willChange = v;
      carrier.style.willChange = v;
      head.style.willChange = v;
      if (flap) flap.style.willChange = on ? 'transform, opacity' : 'auto';
    };

    // Fold the wings back down and bring the perched bird back to full. Called
    // whenever the loop stops, so he can never be parked mid-flap.
    const clearFlap = () => {
      if (!flap || qFA === 0) return;
      qFA = 0;
      flap.style.opacity = '0';
      body.style.opacity = '';
      carrier.style.opacity = '';
    };

    // Back to the photographed rest pose: the two layers stack into the
    // original bird, nothing half-faded, nothing promoted.
    const rest = () => {
      qBY = qBX = qBSY = qHX = qHY = qHR = NaN;
      body.style.transform = '';
      carrier.style.transform = '';
      head.style.transform = '';
      // The flap rides the body transform, so it has to come home too. It is
      // transparent at rest, but leaving it a fraction of a pixel off the
      // body is exactly the kind of thing that shows up later.
      if (flap) flap.style.transform = '';
      clearFlap();
    };

    // --- the wings-spread frame, deferred ----------------------------------
    // 104KB at 2x as WebP (it was 303KB as PNG) for a photograph that only
    // appears if you tap him, which most visitors never do. It is not on the
    // path to seeing the bird at all, so it is requested only once he is on
    // screen and only when the main thread has nothing better to do. React
    // never sets src/srcSet on either element here, so it will not fight these
    // writes on a re-render.
    let flapArmed = false;
    let idleHandle = 0;
    const armFlap = () => {
      if (flapArmed || !flap || !flapSrc) return;
      flapArmed = true;
      idleHandle = idleIn(() => {
        idleHandle = 0;
        // The <source> first, then the <img>. Selection re-runs when either
        // changes, but writing the source first means the very first pass
        // already sees the WebP and no browser is given the chance to commit
        // to the PNG and then throw it away.
        if (flapWebp) flapWebp.srcset = `${flapSrc}-400.webp 1x, ${flapSrc}.webp 2x`;
        flap.srcset = `${flapSrc}-400.png 1x, ${flapSrc}.png 2x`;
        flap.src = `${flapSrc}-400.png`;
      });
    };

    // --- run control -------------------------------------------------------
    const start = () => {
      if (running || reduced || !inView || document.hidden) return;
      running = true;
      // Behind the gate by a frame so the very first callback renders rather
      // than being skipped.
      last = performance.now() - STEP_BUSY - 1;
      stale = true;
      promote(true);
      if (!holding) { retainPointer(); holding = true; }
      wrap.addEventListener('pointerdown', onHop, { passive: true });
      window.addEventListener('scroll', invalidate, { passive: true, capture: true });
      window.addEventListener('resize', invalidate, { passive: true });
      armFlap();
      raf = requestAnimationFrame(frame);
    };

    const stop = () => {
      if (!running) return;
      running = false;
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      if (holding) { releasePointer(); holding = false; }
      wrap.removeEventListener('pointerdown', onHop);
      window.removeEventListener('scroll', invalidate, true);
      window.removeEventListener('resize', invalidate);
      promote(false);
      // Never leave him parked mid-flap with the perched body faded out.
      clearFlap();
    };

    const io = new IntersectionObserver((entries) => {
      inView = entries[entries.length - 1].isIntersecting;
      stale = true;
      if (inView) start(); else stop();
    }, { threshold: 0.05 });
    io.observe(wrap);

    // A rAF loop behind a hidden tab or a backgrounded Capacitor app is pure
    // battery. Browsers throttle rAF there, they do not all stop it.
    const onVisibility = () => { if (document.hidden) stop(); else start(); };
    document.addEventListener('visibilitychange', onVisibility);

    // Reduced motion is a live setting, not a mount-time one. Turning it on
    // has to stop a bird that is already moving.
    const onReduced = () => {
      reduced = !!(mq && mq.matches);
      if (reduced) { stop(); rest(); } else start();
    };
    if (mq) {
      if (mq.addEventListener) mq.addEventListener('change', onReduced);
      else if (mq.addListener) mq.addListener(onReduced);
    }

    // Catches him being resized by his own container (the AI panel expands),
    // which no window event reports.
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(invalidate) : null;
    if (ro) ro.observe(wrap);

    return () => {
      stop();
      io.disconnect();
      if (ro) ro.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      if (mq) {
        if (mq.removeEventListener) mq.removeEventListener('change', onReduced);
        else if (mq.removeListener) mq.removeListener(onReduced);
      }
      if (idleHandle) { idleCancel(idleHandle); idleHandle = 0; }
    };
  }, [flapSrc]);

  const loading = eager ? 'eager' : 'lazy';

  return (
    <div
      ref={wrapRef}
      style={{ width: size, height: size, position: 'relative', touchAction: 'manipulation', ...style }}
      aria-hidden="true"
    >
      {/* display:contents on every <picture> here is deliberate. These images
          are absolutely positioned inside the wrapper and the loop writes
          transforms straight onto them, so the WebP wrapper must add no box of
          its own. An engine too old for display:contents is also too old for
          <picture>, and gets the plain PNG <img> it always got. */}
      <picture style={PICTURE}>
        <source type="image/webp" srcSet={`${bird.body}-400.webp 1x, ${bird.body}.webp 2x`} />
        <img
          ref={bodyRef}
          src={`${bird.body}-400.png`}
          srcSet={`${bird.body}-400.png 1x, ${bird.body}.png 2x`}
          alt=""
          draggable={false}
          decoding="async"
          loading={loading}
          style={{ ...layer, transformOrigin: '50% 88%' }}
        />
      </picture>
      {/* Carries the body's transform so the head rides the hop and the
          breath, then the head turns about the neck inside it. */}
      <div
        ref={carrierRef}
        style={{ position: 'absolute', left: 0, top: 0, width: '100%', height: '100%', transformOrigin: '50% 88%', willChange: 'auto' }}
      >
        <picture style={PICTURE}>
          <source type="image/webp" srcSet={`${bird.head}-400.webp 1x, ${bird.head}.webp 2x`} />
          <img
            ref={headRef}
            src={`${bird.head}-400.png`}
            srcSet={`${bird.head}-400.png 1x, ${bird.head}.png 2x`}
            alt=""
            draggable={false}
            decoding="async"
            loading={loading}
            style={{ ...layer, transformOrigin: bird.neck }}
          />
        </picture>
      </div>
      {/* Wings-spread frame. Bigger than the box and offset negatively so the
          wingspan is not clipped; hidden until he hops, and deliberately
          rendered with no src AND a bare <source> — the effect fills both in
          once he is on screen and the thread is idle. A <source> carrying no
          srcset is skipped by the picture algorithm, so until then this is
          exactly the empty <img> it has always been. */}
      {bird.flap && <picture style={PICTURE}>
        <source ref={flapWebpRef} type="image/webp" />
        <img
          ref={flapRef}
          alt=""
          draggable={false}
          decoding="async"
          fetchPriority="low"
          style={{
            position: 'absolute',
            left: FLAP.left,
            top: FLAP.top,
            width: FLAP.width,
            height: FLAP.height,
            objectFit: 'contain',
            objectPosition: 'center bottom',
            opacity: 0,
            pointerEvents: 'none',
            userSelect: 'none',
            WebkitUserSelect: 'none',
            transformOrigin: '50% 88%',
            willChange: 'auto',
          }}
        />
      </picture>}
    </div>
  );
}
