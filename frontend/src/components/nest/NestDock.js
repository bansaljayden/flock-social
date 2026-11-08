/**
 * THE STRIP ABOVE THE TABS, ON THE NEST (2026-11-06).
 *
 * Nothing floats over the Nest's list any more. Two discs used to rest on it,
 * Birdie's and SOS, and at 320, 390 and 430 they sat on plan names and times
 * at rest. Now the page's scroll ends at the top of this 72px strip
 * (FAB_DOCK_GAP 12 + FAB_SIZE 52 + 8), and the strip holds:
 *
 *   - SOS, exactly as on every other tab: SafetyButton() is unchanged, the
 *     same red disc at the same docked height, on whichever side the person
 *     dragged it to. It rests inside the strip now instead of over a card.
 *   - "Ask Birdie", on the side opposite SOS, shown while no part of the
 *     Birdie section is on screen. For a person with plans the section comes
 *     after them, at the end of the page, so at rest the pill is the way to
 *     Birdie from the top, and it goes the moment any of the section scrolls
 *     into view, so the section's own "Ask Birdie" heading and the pill are
 *     never on screen together. A tap focuses the field in the tap itself
 *     (iOS raises the keyboard only for a focus inside a user gesture) and
 *     brings the section into view; before the account has said yes to
 *     Gemini it asks for that instead, without touching the field.
 *
 * The strip is always there on the Nest, at one height, so nothing jumps. A
 * hairline along its top shows only while content is scrolled beneath it.
 */
import React, { useEffect, useState } from 'react';

export const NEST_DOCK_EXTRA = 8;
export const NEST_DOCK_FADE_MS = 160;

/**
 * Whether anything drawn runs under the strip: the bottom of the last thing
 * in the scroll box with a height, against the box's own bottom. Blank space
 * is not content: an empty Nest ends with its last section's margin and the
 * box's end padding about 13px past the strip at 390, and the line drew over
 * nothing once it could be seen (--nest-edge). App.js's scroll handler reads
 * the same rule.
 */
export function contentBelow(box) {
  if (!box || typeof box.getBoundingClientRect !== 'function') return false;
  let el = box.lastElementChild;
  while (el && !(el.getBoundingClientRect().height > 0)) el = el.previousElementSibling;
  if (!el) return false;
  return el.getBoundingClientRect().bottom > box.getBoundingClientRect().bottom + 1;
}

export default function NestDock({ height, sosSide, getScroller, inputRef, isDark, band, watchKey, lineRef, consented = true, onAskConsent }) {
  const [askShown, setAskShown] = useState(false);

  // Shown while no part of the Birdie section is on screen. Armed on the
  // section's own element, which App.js hands in through a callback ref, so
  // a section that is replaced (the page moves it, the Nest remounts) is
  // watched again at once: armed on a key, a section that changed in the
  // same commit as something else was never watched, and the pill never
  // came for it.
  useEffect(() => {
    const root = getScroller ? getScroller() : null;
    if (!root || !band || typeof IntersectionObserver === 'undefined') { setAskShown(false); return undefined; }
    // The LAST record decides: one callback can carry several records for
    // the section (its first look, then a move as the list lands), oldest
    // first. Reading only the first kept the pill hidden on a section the
    // list had pushed off screen, about one load in three on the rig.
    const io = new IntersectionObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (entry) setAskShown(!entry.isIntersecting);
    }, { root, threshold: 0 });
    io.observe(band);
    return () => io.disconnect();
  }, [band]); // eslint-disable-line react-hooks/exhaustive-deps

  // The hairline: drawn while there is content under the strip. The scroll
  // handler in App.js moves it as the page scrolls; this keeps it right when
  // the page changes height without a scroll (the list lands, a row folds, an
  // answer arrives), from a ResizeObserver on the box and on each band in it.
  // It used to run after every render of the app, reading the box's geometry
  // each time.
  useEffect(() => {
    const root = getScroller ? getScroller() : null;
    const line = lineRef && lineRef.current;
    if (!root || !line) return undefined;
    const update = () => { line.style.opacity = contentBelow(root) ? '1' : '0'; };
    update();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(update);
    const watch = () => {
      ro.disconnect();
      ro.observe(root);
      Array.from(root.children).forEach((child) => ro.observe(child));
    };
    watch();
    const mo = typeof MutationObserver !== 'undefined' ? new MutationObserver(watch) : null;
    if (mo) mo.observe(root, { childList: true });
    return () => { ro.disconnect(); if (mo) mo.disconnect(); };
  }, [watchKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const ask = () => {
    const root = getScroller ? getScroller() : null;
    const section = band || (root && root.querySelector('[data-nest-band="birdie"]'));
    if (consented) {
      // Focus first, inside the tap.
      const box = inputRef && inputRef.current;
      if (box && typeof box.focus === 'function') box.focus({ preventScroll: true });
    } else if (onAskConsent) {
      // The consent question takes the field's place; nothing is focused, so
      // no keyboard starts to rise over a field that is about to go.
      onAskConsent();
    }
    if (section && typeof section.scrollIntoView === 'function') {
      let still = false;
      try { still = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (_) { still = false; }
      section.scrollIntoView({ block: 'center', behavior: still ? 'auto' : 'smooth' });
    }
  };

  const left = sosSide !== 'left';
  return (
    <div data-nest-dock="" style={{ position: 'relative', flexShrink: 0, height: `${height}px`, backgroundColor: 'var(--bg-primary)' }}>
      <div ref={lineRef} aria-hidden="true" style={{ position: 'absolute', top: 0, left: 0, right: 0, height: '1px', backgroundColor: 'var(--nest-edge)', opacity: 0, transition: 'opacity 120ms ease' }} />
      <button
        type="button"
        onClick={ask}
        data-side={left ? 'left' : 'right'}
        aria-hidden={askShown ? undefined : 'true'}
        tabIndex={askShown ? undefined : -1}
        style={{
          position: 'absolute',
          // Level with SOS's disc: its centre sits 12 + 26px above the tabs.
          bottom: '16px',
          [left ? 'left' : 'right']: 'var(--nest-gutter)',
          height: '44px',
          padding: '0 16px 0 8px',
          border: 'none',
          borderRadius: 'var(--r-pill)',
          backgroundColor: 'var(--bg-inset)',
          color: 'var(--text-primary)',
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          fontSize: 'var(--t-body)',
          fontWeight: '600',
          cursor: 'pointer',
          opacity: askShown ? 1 : 0,
          pointerEvents: askShown ? 'auto' : 'none',
          transition: `opacity ${NEST_DOCK_FADE_MS}ms ease`,
        }}
      >
        <img src={isDark ? '/birdie-avatar.png' : '/birdie-avatar-light.png'} alt="" style={{ width: '28px', height: '28px', borderRadius: 'var(--r-pill)', objectFit: 'cover', background: isDark ? '#162046' : '#e8eaf0' }} />
        Ask Birdie
      </button>
    </div>
  );
}
