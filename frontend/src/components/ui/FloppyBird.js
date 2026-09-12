import React from 'react';

/**
 * FLOPPY BIRD — the thing to do while an error page is on screen.
 *
 * WHY IT IS OPT-IN AND NOT AUTOPLAYING. This mounts on the 404 and on the
 * crash net, which are the two screens whose entire job is to tell somebody
 * what went wrong and where to go next. A game that starts by itself competes
 * with that message and, on the crash boundary, animates over the top of a
 * failure the person may need to report. So it ships collapsed behind one
 * button: the error is read first, and the game is there for whoever wants it.
 *
 * It also has to be honest, which for a game means it has to actually be a
 * game. A dead button, a "coming soon", or a bird that cannot lose would each
 * be the dead control DESIGN-STANDARD rule 5 bans. This one has gravity, collision,
 * a score, and a best score that persists.
 *
 * REDUCED MOTION. `prefers-reduced-motion: reduce` does not hide the game —
 * hiding it would take the choice away from the person who asked for it — but
 * the offer is not made unprompted, and nothing here moves until a tap.
 *
 * THE SPRITES ARE THE APP'S OWN BIRD. `/birdie/birdie-body-400.png` glides and
 * `/birdie/birdie-flap-400.png` is the upstroke, which is the same two-frame
 * pair BirdieBird.js uses for its flap animation. If either image fails to
 * load the game still runs and draws a filled circle instead, because an
 * error page is precisely where a second failure is most likely.
 */

const W = 300;
const H = 200;

// Physics, in pixels and pixels-per-second. Tuned so a round lasts long enough
// to be worth starting and short enough to retry without thinking about it.
const GRAVITY = 900;
const FLAP_V = -290;
const MAX_FALL = 420;
const SCROLL = 108;

const BIRD_X = 64;
const BIRD_R = 13;

const GAP = 74;        // vertical opening between pipes
const PIPE_W = 34;
const PIPE_EVERY = 1.55; // seconds

const BEST_KEY = 'flock.floppy.best';

function readBest() {
  // localStorage throws in private windows and in some embedded webviews, and
  // this runs on the crash net, so it must not be the thing that crashes.
  try {
    const v = parseInt(window.localStorage.getItem(BEST_KEY) || '0', 10);
    return Number.isFinite(v) && v > 0 ? v : 0;
  } catch {
    return 0;
  }
}

function writeBest(v) {
  try { window.localStorage.setItem(BEST_KEY, String(v)); } catch { /* fine */ }
}

export default function FloppyBird({ className }) {
  const [open, setOpen] = React.useState(false);
  const [score, setScore] = React.useState(0);
  const [best, setBest] = React.useState(0);
  const [phase, setPhase] = React.useState('ready'); // ready | flying | dead

  const canvasRef = React.useRef(null);
  const rafRef = React.useRef(0);
  const stateRef = React.useRef(null);
  const spritesRef = React.useRef({ body: null, flap: null });

  React.useEffect(() => { setBest(readBest()); }, []);

  // Load the two frames once the game is opened, not on every error page view.
  React.useEffect(() => {
    if (!open) return undefined;
    let alive = true;
    const load = (src) => new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null); // drawn as a circle instead
      img.src = src;
    });
    Promise.all([
      load('/birdie/birdie-body-400.png'),
      load('/birdie/birdie-flap-400.png'),
    ]).then(([body, flap]) => {
      if (alive) spritesRef.current = { body, flap };
    });
    return () => { alive = false; };
  }, [open]);

  const reset = React.useCallback(() => {
    stateRef.current = {
      y: H / 2,
      v: 0,
      pipes: [],
      since: 0,
      flapFor: 0,
      score: 0,
      dead: false,
    };
    setScore(0);
    setPhase('ready');
  }, []);

  const flap = React.useCallback(() => {
    const s = stateRef.current;
    if (!s) return;
    if (s.dead) { reset(); return; }
    s.v = FLAP_V;
    s.flapFor = 0.12;
    setPhase((p) => (p === 'ready' ? 'flying' : p));
  }, [reset]);

  // The loop. One rAF, torn down on close and on unmount.
  React.useEffect(() => {
    if (!open) return undefined;
    reset();

    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const ctx = canvas.getContext('2d');
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    ctx.scale(dpr, dpr);

    let last = 0;
    let running = true;

    const step = (t) => {
      if (!running) return;
      const s = stateRef.current;
      if (!s) return;
      // Clamp dt so a backgrounded tab does not teleport the bird into a pipe.
      const dt = last ? Math.min((t - last) / 1000, 0.05) : 0;
      last = t;

      const moving = !s.dead && s.v !== 0;

      if (moving) {
        s.v = Math.min(s.v + GRAVITY * dt, MAX_FALL);
        s.y += s.v * dt;
        s.flapFor = Math.max(0, s.flapFor - dt);

        s.since += dt;
        if (s.since >= PIPE_EVERY) {
          s.since = 0;
          const margin = 34;
          const top = margin + Math.random() * (H - GAP - margin * 2);
          s.pipes.push({ x: W + PIPE_W, top, scored: false });
        }
        for (const p of s.pipes) p.x -= SCROLL * dt;
        s.pipes = s.pipes.filter((p) => p.x + PIPE_W > -2);

        // Score when the bird's centre clears the pipe's trailing edge.
        for (const p of s.pipes) {
          if (!p.scored && p.x + PIPE_W < BIRD_X) {
            p.scored = true;
            s.score += 1;
            setScore(s.score);
          }
        }

        // Collisions: floor, ceiling, and either pipe body.
        if (s.y + BIRD_R >= H || s.y - BIRD_R <= 0) s.dead = true;
        for (const p of s.pipes) {
          const inX = BIRD_X + BIRD_R > p.x && BIRD_X - BIRD_R < p.x + PIPE_W;
          const inGap = s.y - BIRD_R > p.top && s.y + BIRD_R < p.top + GAP;
          if (inX && !inGap) s.dead = true;
        }

        if (s.dead) {
          s.y = Math.min(s.y, H - BIRD_R);
          setPhase('dead');
          setBest((b) => {
            const next = Math.max(b, s.score);
            if (next > b) writeBest(next);
            return next;
          });
        }
      }

      // ---- draw ----
      const dark = window.matchMedia
        && window.matchMedia('(prefers-color-scheme: dark)').matches;
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = dark ? '#0f172a' : '#e8ecf2';
      ctx.fillRect(0, 0, W, H);

      ctx.fillStyle = dark ? '#8fb4d6' : '#2d5a87';
      for (const p of s.pipes) {
        ctx.fillRect(p.x, 0, PIPE_W, p.top);
        ctx.fillRect(p.x, p.top + GAP, PIPE_W, H - p.top - GAP);
      }

      // Ground line, so falling reads as landing rather than vanishing.
      ctx.fillStyle = dark ? '#1d293d' : '#d6d0be';
      ctx.fillRect(0, H - 3, W, 3);

      const { body, flap: flapImg } = spritesRef.current;
      const img = (s.flapFor > 0 && flapImg) ? flapImg : body;
      const size = BIRD_R * 2.6;
      if (img) {
        ctx.save();
        ctx.translate(BIRD_X, s.y);
        // Tilt with velocity, bounded so it never reads as spinning.
        ctx.rotate(Math.max(-0.5, Math.min(0.9, s.v / 520)));
        ctx.drawImage(img, -size / 2, -size / 2, size, size);
        ctx.restore();
      } else {
        ctx.fillStyle = dark ? '#f4efe3' : '#16283d';
        ctx.beginPath();
        ctx.arc(BIRD_X, s.y, BIRD_R, 0, Math.PI * 2);
        ctx.fill();
      }

      rafRef.current = requestAnimationFrame(step);
    };

    rafRef.current = requestAnimationFrame(step);
    return () => {
      running = false;
      cancelAnimationFrame(rafRef.current);
    };
  }, [open, reset]);

  // Space and Enter fly, but only while the game is open, and never while the
  // person is typing into something else on the page.
  React.useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      const tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target?.isContentEditable) return;
      if (e.code === 'Space' || e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        flap();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, flap]);

  if (!open) {
    return (
      <div className={className}>
        {/* The button's rules live in the same sheet as the game's, and the
            sheet has to be on the page for the button to look like one. */}
        <style>{FLOPPY_CSS}</style>
        <button type="button" className="floppy-open" onClick={() => setOpen(true)}>
          Waiting? Fly the bird
        </button>
      </div>
    );
  }

  return (
    <div className={className}>
      <style>{FLOPPY_CSS}</style>
      <div className="floppy-wrap">
        <canvas
          ref={canvasRef}
          className="floppy-canvas"
          style={{ width: W, height: H }}
          role="img"
          aria-label={`Floppy bird. Score ${score}. Best ${best}.`}
          onPointerDown={(e) => { e.preventDefault(); flap(); }}
        />
        <div className="floppy-hud">
          <span>Score {score}</span>
          <span>Best {best}</span>
        </div>
        <p className="floppy-hint" aria-live="polite">
          {phase === 'ready' && 'Tap, click, or press space to fly.'}
          {phase === 'flying' && 'Mind the gaps.'}
          {phase === 'dead' && 'Down. Tap to go again.'}
        </p>
        <button type="button" className="floppy-close" onClick={() => setOpen(false)}>
          Close the game
        </button>
      </div>
    </div>
  );
}

const FLOPPY_CSS = `
.floppy-wrap {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  margin: 4px 0 0;
}
.floppy-canvas {
  border-radius: 10px;
  border: 1px solid var(--pe-rule, rgba(22,40,61,0.16));
  touch-action: manipulation;
  cursor: pointer;
  max-width: 100%;
}
.floppy-hud {
  display: flex;
  gap: 16px;
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  color: var(--pe-ink-3, #55637a);
}
.floppy-hint {
  margin: 0;
  font-size: 13px;
  color: var(--pe-ink-3, #55637a);
}
.floppy-open, .floppy-close {
  font: inherit;
  font-size: 14px;
  background: none;
  border: 0;
  padding: 6px 2px;
  color: var(--pe-accent, #2d5a87);
  text-decoration: underline;
  text-underline-offset: 3px;
  cursor: pointer;
}
.floppy-open:hover, .floppy-close:hover { opacity: 0.75; }
`;
