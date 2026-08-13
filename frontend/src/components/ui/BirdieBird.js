import React, { useEffect, useRef } from 'react';

// ---------------------------------------------------------------------------
// Birdie — a full character, not a sketch. Filled, layered SVG bird (round
// chickadee build: navy cap and back, cream face and belly, layered wing,
// fanned tail) with a complete animation set driven by one rAF loop:
//
//   • head + neck turn toward the cursor, pupil leads the turn
//   • irregular fast blinks (real birds blink a lot)
//   • breathing through the chest
//   • idle look-around and occasional hops (squash & stretch) when ignored
//   • when the cursor comes close he opens his beak and chirps a note
//
// Local SVG: works offline in the Capacitor WebView, costs a few KB, and stops
// completely under prefers-reduced-motion or when scrolled off screen.
// ---------------------------------------------------------------------------

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const lerp = (a, b, t) => a + (b - a) * t;

export default function BirdieBird({ size = 200, dark = false, style }) {
  const wrapRef = useRef(null);
  const rootRef = useRef(null);   // hop (translate/squash)
  const bodyRef = useRef(null);   // breathe
  const headRef = useRef(null);   // turn + nod
  const pupilRef = useRef(null);  // gaze
  const lidRef = useRef(null);    // blink
  const beakTopRef = useRef(null);
  const noteRef = useRef(null);
  const wingRef = useRef(null);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduced) return;

    const head = headRef.current, pupil = pupilRef.current, lid = lidRef.current;
    const body = bodyRef.current, root = rootRef.current, beakTop = beakTopRef.current;
    const note = noteRef.current, wing = wingRef.current;

    let targetX = 0, targetY = 0, curX = 0, curY = 0;
    let pointerSeen = false, lastMove = performance.now();
    let pointerDist = Infinity;
    let raf = 0, running = true;

    // schedules
    let blinkAt = performance.now() + 900 + Math.random() * 2200;
    let blinkUntil = 0;
    let hopAt = performance.now() + 4000 + Math.random() * 5000;
    let hopStart = 0;
    let chirpStart = 0, chirpCooldownUntil = 0;

    const onPointer = (e) => {
      const r = wrap.getBoundingClientRect();
      if (!r.width) return;
      const hx = r.left + r.width * 0.60;
      const hy = r.top + r.height * 0.34;
      const dx = e.clientX - hx, dy = e.clientY - hy;
      const reach = Math.max(r.width, 280);
      targetX = clamp(dx / reach, -1, 1);
      targetY = clamp(dy / reach, -1, 1);
      pointerDist = Math.hypot(dx, dy);
      pointerSeen = true;
      lastMove = performance.now();
    };

    const frame = (now) => {
      if (!running) return;

      // Idle gaze when the pointer is quiet
      if (!pointerSeen || now - lastMove > 2800) {
        const t = now / 1000;
        targetX = Math.sin(t * 0.45) * 0.55 + Math.sin(t * 0.19) * 0.2;
        targetY = Math.sin(t * 0.33 + 1.1) * 0.28;
        pointerDist = Infinity;
      }

      curX = lerp(curX, targetX, 0.085);
      curY = lerp(curY, targetY, 0.085);

      // Head: rotate around the neck joint, tiny counter-translate for weight
      const rot = clamp(curX * 14, -14, 14);
      const nod = clamp(curY * 8, -8, 8);
      head.setAttribute('transform', `rotate(${rot.toFixed(2)} 112 92) translate(${(curX * 2.5).toFixed(2)} ${nod.toFixed(2)})`);

      // Pupil leads the head
      pupil.setAttribute('transform', `translate(${(curX * 3.6).toFixed(2)} ${(curY * 2.8).toFixed(2)})`);

      // Breathe
      const breathe = 1 + Math.sin(now / 1400) * 0.013;
      body.setAttribute('transform', `translate(100 128) scale(1 ${breathe.toFixed(4)}) translate(-100 -128)`);

      // Wing settles with the breath, shrugs during a chirp
      const chirping = now - chirpStart < 700;
      const wingLift = chirping ? Math.sin(((now - chirpStart) / 700) * Math.PI) * -4 : Math.sin(now / 1400) * 0.8;
      wing.setAttribute('transform', `rotate(${wingLift.toFixed(2)} 84 118)`);

      // Blink
      if (now >= blinkAt && now >= blinkUntil) {
        blinkUntil = now + 130;
        blinkAt = now + 1500 + Math.random() * 3600;
        // double-blink sometimes — very bird
        if (Math.random() < 0.25) blinkAt = now + 380;
      }
      lid.style.opacity = now < blinkUntil ? '1' : '0';

      // Hop when ignored (never mid-chirp)
      if (!chirping && now >= hopAt) { hopStart = now; hopAt = now + 5000 + Math.random() * 7000; }
      const hp = (now - hopStart) / 420;
      if (hp >= 0 && hp <= 1) {
        const arc = Math.sin(hp * Math.PI);
        const squash = hp < 0.18 ? 1 - (hp / 0.18) * 0.06 : hp > 0.82 ? 1 - ((1 - hp) / 0.18) * 0.06 : 1 + arc * 0.03;
        root.setAttribute('transform', `translate(0 ${(-arc * 7).toFixed(2)}) translate(100 160) scale(${(2 - squash).toFixed(4)} ${squash.toFixed(4)}) translate(-100 -160)`);
      } else {
        root.setAttribute('transform', '');
      }

      // Chirp when the cursor comes to visit
      if (pointerDist < 95 && now >= chirpCooldownUntil) {
        chirpStart = now;
        chirpCooldownUntil = now + 4200;
      }
      const cp = (now - chirpStart) / 700;
      if (cp >= 0 && cp <= 1) {
        const open = Math.sin(Math.min(cp * 2.2, 1) * Math.PI);
        beakTop.setAttribute('transform', `rotate(${(-open * 14).toFixed(2)} 138 88)`);
        note.style.opacity = String(clamp(1.4 - cp * 1.6, 0, 1));
        note.setAttribute('transform', `translate(${(cp * 14).toFixed(1)} ${(-cp * 26).toFixed(1)}) rotate(${(cp * 12).toFixed(1)})`);
      } else {
        beakTopRef.current.setAttribute('transform', '');
        note.style.opacity = '0';
      }

      raf = requestAnimationFrame(frame);
    };

    const io = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting && !raf) { running = true; raf = requestAnimationFrame(frame); }
      else if (!entry.isIntersecting && raf) { cancelAnimationFrame(raf); raf = 0; running = false; }
    }, { threshold: 0.05 });
    io.observe(wrap);

    window.addEventListener('pointermove', onPointer, { passive: true });
    return () => {
      running = false;
      if (raf) cancelAnimationFrame(raf);
      io.disconnect();
      window.removeEventListener('pointermove', onPointer);
    };
  }, []);

  // Palette — full character colors, both themes stay on brand.
  const ink   = dark ? '#a8c4de' : '#1e3a5c';  // cap, back, wing, outlines
  const inkDeep = dark ? '#7fa3c6' : '#16283d'; // wing shadow, tail
  const belly = dark ? '#1e293b' : '#f4efe3';  // face + chest
  const beak  = dark ? '#d9b98a' : '#c9922e';  // small warm accent, like the app's amber
  const branch = dark ? '#54677d' : '#8a7f6a';

  return (
    <div ref={wrapRef} style={{ width: size, height: size, ...style }} aria-hidden="true">
      <svg viewBox="0 0 200 200" width="100%" height="100%">
        {/* branch */}
        <g stroke={branch} strokeWidth="5.5" strokeLinecap="round" fill="none">
          <path d="M26 168 C70 162 140 160 176 163" />
          <path d="M136 162 l14 -10" strokeWidth="4" />
        </g>

        <g ref={rootRef}>
          {/* tail — fanned, behind everything */}
          <g fill={inkDeep}>
            <path d="M64 132 L18 150 L26 158 L66 142 Z" />
            <path d="M64 138 L24 164 L34 169 L68 148 Z" />
          </g>

          {/* legs */}
          <g stroke={beak} strokeWidth="4" strokeLinecap="round" fill="none">
            <path d="M92 152 L88 165 M88 165 l-5 3 M88 165 l5 3" />
            <path d="M110 151 L112 165 M112 165 l-5 3 M112 165 l5 3" />
          </g>

          {/* body */}
          <g ref={bodyRef}>
            {/* chest + belly (cream) */}
            <path d="M60 122 C60 96 82 78 108 80 C136 82 148 102 146 122 C144 146 124 156 100 156 C76 156 60 144 60 122 Z" fill={belly} />
            {/* back + cap sweep (navy over the top) */}
            <path d="M60 122 C60 96 82 78 108 80 C130 82 143 95 146 110 C132 96 116 92 100 96 C78 101 66 112 60 126 Z" fill={ink} />
            {/* wing — layered, sits on the flank */}
            <g ref={wingRef}>
              <path d="M70 112 C88 102 116 104 128 118 C122 136 102 144 84 138 C72 134 66 124 70 112 Z" fill={ink} />
              <path d="M80 124 C92 118 110 118 120 126 M76 132 C88 126 104 126 114 132" stroke={inkDeep} strokeWidth="3.4" strokeLinecap="round" fill="none" />
            </g>
          </g>

          {/* head — pivots at the neck */}
          <g ref={headRef}>
            {/* face (cream) with navy cap */}
            <circle cx="118" cy="78" r="30" fill={belly} />
            <path d="M88 78 A30 30 0 0 1 148 78 C140 66 132 60 118 60 C104 60 94 68 88 78 Z" fill={ink} />
            <path d="M88 78 C96 74 104 72 112 74" stroke={ink} strokeWidth="3" strokeLinecap="round" fill="none" opacity="0.5" />
            {/* beak — two parts so the top can open when he chirps */}
            <path ref={beakTopRef} d="M144 84 L166 86 L145 92 Z" fill={beak} />
            <path d="M144 92 L162 92 L145 98 Z" fill={beak} opacity="0.85" />
            {/* eye: sclera, tracking pupil, glint, eyelid */}
            <circle cx="126" cy="76" r="7.2" fill="#ffffff" stroke={inkDeep} strokeWidth="1.6" />
            <g ref={pupilRef}>
              <circle cx="126" cy="76" r="3.6" fill={inkDeep} />
              <circle cx="127.4" cy="74.6" r="1.1" fill="#ffffff" />
            </g>
            <path ref={lidRef} d="M118.4 75.5 a7.6 7.6 0 0 1 15.2 0 l0 1 a7.6 7.6 0 0 1 -15.2 0 z" fill={ink}
                  style={{ opacity: 0, transition: 'opacity 50ms linear' }} />
          </g>

          {/* chirp note — pops out of the beak */}
          <g ref={noteRef} style={{ opacity: 0 }}>
            <g transform="translate(168 70)">
              <path d="M0 0 L0 -12 L7 -14 L7 -3" stroke={ink} strokeWidth="2.4" strokeLinecap="round" fill="none" />
              <circle cx="-1.5" cy="0" r="3" fill={ink} />
              <circle cx="5.5" cy="-3" r="3" fill={ink} />
            </g>
          </g>
        </g>
      </svg>
    </div>
  );
}
