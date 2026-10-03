import { useEffect } from 'react';

// LANDING ON A SECTION LINK. Every site page is a lazy chunk (index.js), so
// when a visitor opens /#pricing or /privacy#ai the browser looks for the id
// while #root is still empty, finds nothing, and leaves the page at the top:
// 1,900-8,500px above the pricing section, 17,000px above Privacy's AI section
// (the app's "What Birdie sends, in full" link opens that one). Six of the
// seven menu links on /research go through it.
//
// Rendered after the page inside its Suspense boundary, so its effect runs
// once the page's sections exist. It scrolls the target into view, then keeps
// it there while the page settles: the live demo, fonts and images can still
// grow above the target after the first scroll, and a section link that lands
// 300px short is the same failure as one that never moved. The watch ends the
// moment the visitor scrolls, taps or types, and after SETTLE_MS regardless.
//
// A back/forward or reload visit is left alone: the browser restores where
// the visitor was, and jumping to the hash would undo that.
const SETTLE_MS = 4000;
const USER_INPUT = ['wheel', 'touchstart', 'keydown', 'pointerdown'];

function targetFor(hash, doc) {
  if (!hash || hash.length < 2) return null;
  let id;
  try { id = decodeURIComponent(hash.slice(1)); } catch { return null; }
  return doc.getElementById(id);
}

function navigationType(win) {
  try {
    const nav = win.performance?.getEntriesByType?.('navigation')?.[0];
    return nav?.type || 'navigate';
  } catch {
    return 'navigate';
  }
}

// Holds the target in view until the page settles. Returns a stop function.
export function holdHashInView(win = window, { alignNow = true } = {}) {
  const doc = win.document;
  const root = doc.documentElement;
  let stopped = false;
  let frame = 0;

  const align = () => {
    frame = 0;
    if (stopped) return;
    const el = targetFor(win.location.hash, doc);
    if (!el) return;
    // Instant. The landing page smooths in-page scrolling, and a correction
    // for a layout shift that glides reads as the page drifting on its own.
    const prev = root.style.scrollBehavior;
    root.style.scrollBehavior = 'auto';
    el.scrollIntoView({ block: 'start' });
    root.style.scrollBehavior = prev;
  };
  const schedule = () => {
    if (!stopped && !frame) frame = win.requestAnimationFrame(align);
  };

  let observer = null;
  let timer = 0;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (frame) win.cancelAnimationFrame(frame);
    if (observer) observer.disconnect();
    win.clearTimeout(timer);
    for (const type of USER_INPUT) win.removeEventListener(type, stop, true);
  };

  for (const type of USER_INPUT) win.addEventListener(type, stop, { capture: true, passive: true });
  timer = win.setTimeout(stop, SETTLE_MS);
  if (typeof win.ResizeObserver === 'function' && doc.body) {
    // observe() reports the current size once straight away. That first
    // report is not a shift, so it moves nothing: for an in-page link it
    // would cut the native smooth scroll short with a jump.
    let lastHeight = null;
    observer = new win.ResizeObserver((entries) => {
      const height = entries[entries.length - 1].contentRect.height;
      const first = lastHeight === null;
      const moved = height !== lastHeight;
      lastHeight = height;
      if (!first && moved) schedule();
    });
    observer.observe(doc.body);
  }
  if (alignNow) align();
  return stop;
}

export default function HashLanding() {
  useEffect(() => {
    let stop = null;
    if (window.location.hash && navigationType(window) === 'navigate') {
      stop = holdHashInView(window);
    }
    // An in-page section link scrolls natively (and smoothly, on the landing
    // page). Only the correction is needed there, so nothing jumps first.
    const onHashChange = () => {
      if (stop) stop();
      stop = holdHashInView(window, { alignNow: false });
    };
    window.addEventListener('hashchange', onHashChange);
    return () => {
      window.removeEventListener('hashchange', onHashChange);
      if (stop) stop();
    };
  }, []);
  return null;
}
