import React, { useEffect, useRef } from 'react';

// ---------------------------------------------------------------------------
// Birdie — the photoreal mascot. A cutout PNG (transparent background, 1x/2x)
// kept alive by one rAF loop that moves the whole bird:
//
//   • he leans toward the cursor (a few degrees, no more — this is a photo)
//   • a small parallax slide follows the lean, so the turn has weight
//   • the chest breathes and he drifts on a slow vertical cycle
//   • with no cursor around (touch, or an idle desktop) he looks around on
//     his own so he never freezes mid-pose
//
// Everything is one composited transform on the <img>. Nothing is layered on
// top of the photo: no fake pupil, no clipped head, no drawn shadow. Faking
// those on a photograph reads as a mistake, not a character.
//
// The loop stops when he scrolls out of view and never starts at all under
// prefers-reduced-motion, where he simply stands still.
// ---------------------------------------------------------------------------

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const lerp = (a, b, t) => a + (b - a) * t;

const MAX_LEAN = 4.2;   // degrees. Past ~5 a photographed bird looks broken.

// `dark` is accepted so existing call sites keep working. The photo carries
// its own light and reads on both surfaces, so no per-theme treatment.
export default function BirdieBird({ size = 200, dark = false, style }) {
  const wrapRef = useRef(null);
  const birdRef = useRef(null);

  useEffect(() => {
    const wrap = wrapRef.current;
    const bird = birdRef.current;
    if (!wrap || !bird) return;

    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduced) return;

    let targetX = 0, targetY = 0, curX = 0, curY = 0;
    let pointerSeen = false;
    let lastMove = performance.now();
    let raf = 0, running = false;

    const onPointer = (e) => {
      const r = wrap.getBoundingClientRect();
      if (!r.width) return;
      // Aim at his head, roughly a third down the frame.
      const hx = r.left + r.width * 0.5;
      const hy = r.top + r.height * 0.3;
      const reach = Math.max(r.width, 280);
      targetX = clamp((e.clientX - hx) / reach, -1, 1);
      targetY = clamp((e.clientY - hy) / reach, -1, 1);
      pointerSeen = true;
      lastMove = performance.now();
    };

    const frame = (now) => {
      if (!running) return;

      // No pointer, or it went quiet: look around on his own.
      if (!pointerSeen || now - lastMove > 2600) {
        const t = now / 1000;
        targetX = Math.sin(t * 0.42) * 0.5 + Math.sin(t * 0.17) * 0.18;
        targetY = Math.sin(t * 0.31 + 1.1) * 0.24;
      }

      curX = lerp(curX, targetX, 0.06);
      curY = lerp(curY, targetY, 0.06);

      const lean = clamp(curX * MAX_LEAN, -MAX_LEAN, MAX_LEAN);
      const slideX = curX * size * 0.022;
      const slideY = curY * size * 0.012;
      const breathe = 1 + Math.sin(now / 1500) * 0.007;
      const drift = Math.sin(now / 2600) * size * 0.004;

      bird.style.transform =
        `translate3d(${slideX.toFixed(2)}px, ${(slideY + drift).toFixed(2)}px, 0) ` +
        `rotate(${lean.toFixed(2)}deg) scale(${breathe.toFixed(4)})`;

      raf = requestAnimationFrame(frame);
    };

    const io = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting && !raf) {
        running = true;
        raf = requestAnimationFrame(frame);
      } else if (!entry.isIntersecting && raf) {
        running = false;
        cancelAnimationFrame(raf);
        raf = 0;
      }
    }, { threshold: 0.05 });
    io.observe(wrap);

    window.addEventListener('pointermove', onPointer, { passive: true });
    return () => {
      running = false;
      if (raf) cancelAnimationFrame(raf);
      io.disconnect();
      window.removeEventListener('pointermove', onPointer);
    };
  }, [size]);

  return (
    <div
      ref={wrapRef}
      style={{ width: size, height: size, display: 'flex', alignItems: 'flex-end', justifyContent: 'center', ...style }}
      aria-hidden="true"
    >
      <img
        ref={birdRef}
        src="/birdie/birdie-400.png"
        srcSet="/birdie/birdie-400.png 1x, /birdie/birdie-800.png 2x"
        alt=""
        draggable={false}
        decoding="async"
        style={{
          width: '100%',
          height: '100%',
          objectFit: 'contain',
          objectPosition: 'center bottom',
          // Pivot near his feet so the lean reads as a body turn, not a spin.
          transformOrigin: '50% 88%',
          willChange: 'transform',
          userSelect: 'none',
          WebkitUserSelect: 'none',
        }}
      />
    </div>
  );
}
