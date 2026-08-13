import React, { useEffect, useRef } from 'react';

// ---------------------------------------------------------------------------
// Birdie — the photoreal mascot, in two stacked cutouts on one canvas:
//
//   /birdie/birdie-body-400.png   the whole bird (1x, 631x800 as 2x)
//   /birdie/birdie-head-400.png   just the head, feathered at the neck, on an
//                                 identical canvas, so the two line up exactly
//                                 at rest with no offset math
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
// nothing painted on top of the photo. The loop stops when he scrolls out of
// view and never starts at all under prefers-reduced-motion, where the two
// layers simply stack into the original bird and stand still.
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

// Where the head meets the shoulders, in the head layer's own box. The head
// sits right of centre on the canvas, so the pivot does too.
const NECK = '66% 37%';

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
};

// `dark` is accepted so existing call sites keep working. The photo carries
// its own light and reads on both surfaces, so no per-theme treatment.
export default function BirdieBird({ size = 200, dark = false, style }) {
  const wrapRef = useRef(null);
  const bodyRef = useRef(null);
  const carrierRef = useRef(null);
  const headRef = useRef(null);
  const flapRef = useRef(null);

  useEffect(() => {
    const wrap = wrapRef.current;
    const body = bodyRef.current;
    const carrier = carrierRef.current;
    const head = headRef.current;
    const flap = flapRef.current;
    if (!wrap || !body || !carrier || !head || !flap) return;

    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduced) return;

    // --- pointer state -----------------------------------------------------
    let ptrX = 0, ptrY = 0;
    let pointerSeen = false;
    let lastMove = -Infinity;

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

    let last = 0, raf = 0, running = false;
    let lastBody = '', lastHead = '', lastFlap = '';

    const onPointer = (e) => {
      ptrX = e.clientX;
      ptrY = e.clientY;
      pointerSeen = true;
      lastMove = performance.now();
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
      if (!running) return;

      const dt = Math.min(now - last, 64) || 16;
      last = now;

      const r = wrap.getBoundingClientRect();
      const w = r.width || size;
      const h = r.height || size;

      // His head sits right of centre on the canvas, near the top.
      const hx = r.left + w * 0.66;
      const hy = r.top + h * 0.21;

      const live = pointerSeen && now - lastMove < IDLE_AFTER;

      let aimX, aimY, tau;

      if (live) {
        idleReady = false;
        // Map most of the window onto his range so he keeps turning instead of
        // pinning at full deflection the moment the cursor leaves his column.
        const reachX = Math.max(w * 2.5, window.innerWidth * 0.42);
        const reachY = Math.max(h * 2.0, window.innerHeight * 0.38);
        const nx = clamp((ptrX - hx) / reachX, -1, 1);
        const ny = clamp((ptrY - hy) / reachY, -1, 1);
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
        const d = Math.hypot(ptrX - hx, ptrY - hy);
        rawProx = clamp(1 - d / radius, 0, 1);
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

      const bodyT =
        `translate3d(0px, ${bodyY.toFixed(1)}px, 0) ` +
        `scale(${(base * hopSX).toFixed(3)}, ${(base * hopSY).toFixed(3)})`;

      // --- head: the part that actually watches you ------------------------
      const turn = clamp(curX * MAX_TURN, -MAX_TURN, MAX_TURN);
      const headX = curX * w * HEAD_SLIDE;
      const headY = curY * h * 0.018 + perk * h * -0.012;

      const headT =
        `translate3d(${headX.toFixed(1)}px, ${headY.toFixed(1)}px, 0) ` +
        `rotate(${turn.toFixed(2)}deg)`;

      if (bodyT !== lastBody) {
        lastBody = bodyT;
        body.style.transform = bodyT;
        carrier.style.transform = bodyT;
        // The flap frame is a whole bird, so it rides the same transform. It
        // carries its own head, so the head layer hides while it is up.
        flap.style.transform = bodyT;
      }
      if (headT !== lastHead) {
        lastHead = headT;
        head.style.transform = headT;
      }
      const flapS = flapA.toFixed(3);
      if (flapS !== lastFlap) {
        lastFlap = flapS;
        flap.style.opacity = flapS;
        // Fade the perched body out underneath so folded wings do not show
        // through the spread ones, and drop the turning head with it.
        const under = (1 - flapA).toFixed(3);
        body.style.opacity = under;
        carrier.style.opacity = under;
      }

      raf = requestAnimationFrame(frame);
    };

    const io = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting && !raf) {
        running = true;
        last = performance.now();
        raf = requestAnimationFrame(frame);
      } else if (!entry.isIntersecting && raf) {
        running = false;
        cancelAnimationFrame(raf);
        raf = 0;
      }
    }, { threshold: 0.05 });
    io.observe(wrap);

    // Listeners are attached imperatively rather than as JSX props so the
    // wrapper stays a plain decorative div (out of the a11y tree, not a
    // control) while still being tappable.
    window.addEventListener('pointermove', onPointer, { passive: true });
    window.addEventListener('pointerdown', onPointer, { passive: true });
    wrap.addEventListener('pointerdown', onHop, { passive: true });

    return () => {
      running = false;
      if (raf) cancelAnimationFrame(raf);
      io.disconnect();
      window.removeEventListener('pointermove', onPointer);
      window.removeEventListener('pointerdown', onPointer);
      wrap.removeEventListener('pointerdown', onHop);
    };
  }, [size]);

  return (
    <div
      ref={wrapRef}
      style={{ width: size, height: size, position: 'relative', touchAction: 'manipulation', ...style }}
      aria-hidden="true"
    >
      <img
        ref={bodyRef}
        src="/birdie/birdie-body-400.png"
        srcSet="/birdie/birdie-body-400.png 1x, /birdie/birdie-body.png 2x"
        alt=""
        draggable={false}
        decoding="async"
        style={{ ...layer, transformOrigin: '50% 88%', willChange: 'transform' }}
      />
      {/* Carries the body's transform so the head rides the hop and the
          breath, then the head turns about the neck inside it. */}
      <div
        ref={carrierRef}
        style={{ position: 'absolute', left: 0, top: 0, width: '100%', height: '100%', transformOrigin: '50% 88%', willChange: 'transform' }}
      >
        <img
          ref={headRef}
          src="/birdie/birdie-head-400.png"
          srcSet="/birdie/birdie-head-400.png 1x, /birdie/birdie-head.png 2x"
          alt=""
          draggable={false}
          decoding="async"
          style={{ ...layer, transformOrigin: NECK, willChange: 'transform' }}
        />
      </div>
      {/* Wings-spread frame. Bigger than the box and offset negatively so the
          wingspan is not clipped; hidden until he hops. */}
      <img
        ref={flapRef}
        src="/birdie/birdie-flap-400.png"
        srcSet="/birdie/birdie-flap-400.png 1x, /birdie/birdie-flap.png 2x"
        alt=""
        draggable={false}
        decoding="async"
        loading="lazy"
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
          willChange: 'transform, opacity',
        }}
      />
    </div>
  );
}
