import React, { useCallback, useEffect, useRef, useState } from 'react';
import { LAST, STEPS, stepAt } from './fluxData';
import { MODEL_MB, MODEL_URL, fetchModel } from './fluxModel';

/* The Flux case on /flux: one bar that runs from every part pulled apart,
   through each assembly step, to the box on its stand. Dragging the bar or
   pressing the arrow keys moves it; dragging the picture turns the box. The
   page itself never moves on scroll.

   It starts as the sensor work's own renders, one per stop of the bar, which
   is all a visitor gets without WebGL, and what someone who asks for reduced
   motion or Save-Data gets until they press the button for the 3D model. For
   everyone else the model loads once the viewer is near the screen and the
   page has finished loading: three.js is its own chunk (fluxScene.js) and the
   model comes gzipped (fluxModel.js), so the page's first load carries
   neither. Nothing here touches window during render, so the prerendered
   HTML is the renders, and it matches the first client render. */

const STILLS = STEPS.map((s) => {
  const wide = s.still === 'flux-exploded';
  const [one, two] = wide ? [1100, 2200] : [700, 1400];
  const base = `/sensor/${s.still}`;
  return {
    avif: `${base}.avif ${one}w, ${base}@2x.avif ${two}w`,
    webp: `${base}.webp ${one}w, ${base}@2x.webp ${two}w`,
    src: `${base}.webp`,
    width: wide ? 1100 : 700,
    height: wide ? 733 : 525,
  };
});
const SIZES = '(min-width: 1160px) 1080px, calc(100vw - 40px)';

const stepLine = (k) => (k === 0 ? '' : `Step ${k} of ${LAST}`);
const spoken = (k) => `${k === 0 ? '' : `${stepLine(k)}, `}${STEPS[k].title}. ${STEPS[k].caption}`;

// Whether this device should get the 3D model: a WebGL context, the gzip
// stream the model needs, and the two observers the scene uses; then
// whether the visitor has asked for less (reduced motion, Save-Data).
function capability() {
  let gl = null;
  try {
    const probe = document.createElement('canvas');
    gl = probe.getContext('webgl2') || probe.getContext('webgl');
    const lose = gl && gl.getExtension('WEBGL_lose_context');
    if (lose) lose.loseContext();
  } catch (err) {
    gl = null;
  }
  if (!gl || typeof window.DecompressionStream !== 'function' || typeof window.ResizeObserver !== 'function') return 'none';
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const save = navigator.connection && navigator.connection.saveData;
  return reduce || save ? 'ask' : 'auto';
}

const reducedMotion = () => Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

export default function FluxViewer() {
  const [pos, setPos] = useState(0);
  // still: the renders; loading: the model is on its way; ready: the 3D is up.
  const [mode, setMode] = useState('still');
  const [offer, setOffer] = useState(false);
  const [pct, setPct] = useState(null);
  const [tag, setTag] = useState(null);
  const [turned, setTurned] = useState(false);
  const [allStills, setAllStills] = useState(false);

  const stageRef = useRef(null);
  const canvasRef = useRef(null);
  const sceneRef = useRef(null);
  const posRef = useRef(0);
  const glideRef = useRef(0);
  const abortRef = useRef(null);
  const startedRef = useRef(false);

  const move = useCallback((u) => {
    posRef.current = u;
    setPos(u);
    if (sceneRef.current) sceneRef.current.setPosition(u);
  }, []);

  const stopGlide = useCallback(() => {
    if (glideRef.current) cancelAnimationFrame(glideRef.current);
    glideRef.current = 0;
  }, []);

  // Keyboard steps glide to the next stop rather than jump, unless the
  // visitor asked for reduced motion.
  const glide = useCallback((to) => {
    stopGlide();
    const from = posRef.current;
    if (from === to) return;
    if (reducedMotion()) { move(to); return; }
    const ms = Math.min(1200, 550 * Math.abs(to - from));
    const t0 = performance.now();
    const tick = (now) => {
      const t = Math.min(1, (now - t0) / ms);
      const e = t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2;
      move(from + (to - from) * e);
      glideRef.current = t < 1 ? requestAnimationFrame(tick) : 0;
    };
    glideRef.current = requestAnimationFrame(tick);
  }, [move, stopGlide]);

  const start = useCallback(async () => {
    if (startedRef.current) return;
    startedRef.current = true;
    setOffer(false);
    setMode('loading');
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const [mod, buffer] = await Promise.all([
        import(/* webpackChunkName: "flux-scene" */ './fluxScene'),
        fetchModel(MODEL_URL, { signal: controller.signal, onProgress: (p) => setPct(Math.round(p * 100)) }),
      ]);
      if (controller.signal.aborted || !canvasRef.current) return;
      const scene = mod.createFluxScene(canvasRef.current, { onPick: setTag, onTurn: setTurned });
      sceneRef.current = scene;
      await scene.load(buffer);
      if (controller.signal.aborted) return;
      scene.setPosition(posRef.current);
      setMode('ready');
    } catch (err) {
      if (controller.signal.aborted) return;
      // The renders stay, and so does the bar.
      if (sceneRef.current) sceneRef.current.dispose();
      sceneRef.current = null;
      setMode('still');
      setPct(null);
    }
  }, []);

  // Decide once the viewer is near the screen: a WebGL check costs a
  // context, so it waits until it matters. The model then waits for the
  // page's load event and an idle moment.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || typeof window.IntersectionObserver !== 'function') return undefined;
    let idle = 0;
    let cancelled = false;
    const go = () => { if (!cancelled) start(); };
    const whenIdle = () => {
      if (cancelled) return;
      idle = window.requestIdleCallback ? window.requestIdleCallback(go, { timeout: 2500 }) : window.setTimeout(go, 300);
    };
    const near = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      near.disconnect();
      const can = capability();
      if (can === 'none') return;
      if (can === 'ask') { setOffer(true); return; }
      if (document.readyState === 'complete') whenIdle();
      else window.addEventListener('load', whenIdle, { once: true });
    }, { rootMargin: '600px 0px' });
    near.observe(stage);
    return () => {
      cancelled = true;
      near.disconnect();
      window.removeEventListener('load', whenIdle);
      if (idle) (window.cancelIdleCallback || window.clearTimeout)(idle);
    };
  }, [start]);

  useEffect(() => () => {
    stopGlide();
    if (abortRef.current) abortRef.current.abort();
    if (sceneRef.current) sceneRef.current.dispose();
    sceneRef.current = null;
  }, [stopGlide]);

  const onKeyDown = (e) => {
    const here = posRef.current;
    let to = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'PageUp') to = Math.min(LAST, Math.floor(here + 1e-6) + 1);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown' || e.key === 'PageDown') to = Math.max(0, Math.ceil(here - 1e-6) - 1);
    else if (e.key === 'Home') to = 0;
    else if (e.key === 'End') to = LAST;
    if (to === null) return;
    e.preventDefault();
    setAllStills(true);
    glide(to);
  };

  const k = stepAt(pos);
  const stop = Math.round(pos);
  const ready = mode === 'ready';

  return (
    <div className="fx-viewer">
      <div ref={stageRef} className={`fx-stage${ready ? ' is-3d' : ''}`}>
        {/* The renders, one per stop. Until someone moves the bar only the
            first is in the page; after that all eight, stacked, so the next
            one is already there. Hidden behind the model once it is up. */}
        {!ready && STILLS.map((s, i) => ((allStills || i === 0 || i === stop) ? (
          <picture key={STEPS[i].still} className={`fx-still${i === stop ? ' is-on' : ''}`}>
            <source type="image/avif" srcSet={s.avif} sizes={SIZES} />
            <source type="image/webp" srcSet={s.webp} sizes={SIZES} />
            <img
              src={s.src}
              width={s.width} height={s.height}
              loading="lazy" decoding="async"
              alt={i === stop ? `${STEPS[i].title}: ${STEPS[i].caption}` : ''}
            />
          </picture>
        ) : null))}
        <canvas
          ref={canvasRef}
          className="fx-canvas"
          role="img"
          aria-label={`A 3D model of the Flux case. ${STEPS[k].title}: ${STEPS[k].caption}`}
          aria-hidden={ready ? undefined : true}
        />
        {mode === 'loading' ? (
          <p className="fx-status" role="status">
            Loading the 3D model{pct !== null ? `, ${pct}%` : ''}
          </p>
        ) : null}
        {offer ? (
          <button type="button" className="fx-chip fx-load" onClick={start}>
            Load the 3D model ({MODEL_MB})
          </button>
        ) : null}
        {ready && tag ? <p className="fx-chip fx-tag" aria-live="polite">{tag}</p> : null}
        {ready && turned ? (
          <button type="button" className="fx-chip fx-reset" onClick={() => sceneRef.current && sceneRef.current.resetView()}>
            Reset view
          </button>
        ) : null}
      </div>

      {/* The words sit under the bar, in a box tall enough for the longest
          step, so the bar never moves under a finger that is dragging it. */}
      <div className="fx-scrub">
        <div className="fx-bar">
          <input
            className="fx-range"
            type="range"
            min="0"
            max={LAST}
            step="any"
            value={pos}
            aria-label="Assembly, from every part apart to the finished box"
            aria-valuetext={spoken(k)}
            onChange={(e) => { stopGlide(); move(Number(e.target.value)); }}
            onPointerDown={() => { stopGlide(); setAllStills(true); }}
            onKeyDown={onKeyDown}
          />
          <div className="fx-ticks" aria-hidden="true">
            {STEPS.map((s, i) => (
              <span key={s.still} className={i <= pos + 1e-6 ? 'is-past' : undefined} style={{ left: `${(i / LAST) * 100}%` }} />
            ))}
          </div>
        </div>
        <p className="fx-ends" aria-hidden="true"><span>Apart</span><span>On its stand</span></p>
        <div className="fx-words">
          <p className="fx-step-head">
            {k > 0 ? <span className="fx-step-num">{stepLine(k)}</span> : null}
            <span className="fx-step-title">{STEPS[k].title}</span>
          </p>
          <p className="fx-step-cap">{STEPS[k].caption}</p>
        </div>
        <p className="fx-hint">
          {ready ? 'Drag the box to turn it, and tap a part to see its name.' : 'Drag the bar to build it.'}
        </p>
      </div>
    </div>
  );
}
