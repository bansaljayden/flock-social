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
 *   - "Ask Birdie", on the side opposite SOS, shown only once the whole Birdie
 *     section has scrolled above the page, so at rest the strip holds SOS
 *     alone and the section's heading is never doubled by the pill. A tap
 *     focuses the field in the tap itself (iOS raises the keyboard only for a
 *     focus inside a user gesture) and brings the section into view.
 *
 * The strip is always there on the Nest, at one height, so nothing jumps. A
 * hairline along its top shows only while content is scrolled beneath it.
 */
import React, { useEffect, useState } from 'react';

export const NEST_DOCK_EXTRA = 8;
export const NEST_DOCK_FADE_MS = 160;

export default function NestDock({ height, sosSide, getScroller, inputRef, isDark, watchKey, lineRef }) {
  const [askShown, setAskShown] = useState(false);

  // Shown only once the whole Birdie section has scrolled above the page: a
  // way back up for someone who went past it. It used to show while the
  // section's field was under half on screen, which at rest, with the section
  // just below the fold, put the section's own "Ask Birdie" heading about
  // 50px over this pill. Re-armed when the section might be a different
  // element: watchKey says when.
  useEffect(() => {
    const root = getScroller ? getScroller() : null;
    const band = root && root.querySelector('[data-nest-band="birdie"]');
    if (!root || !band || typeof IntersectionObserver === 'undefined') { setAskShown(false); return undefined; }
    const io = new IntersectionObserver(([entry]) => {
      const above = !entry.isIntersecting && !!entry.rootBounds && entry.boundingClientRect.bottom <= entry.rootBounds.top;
      setAskShown(above);
    }, { root, threshold: 0 });
    io.observe(band);
    return () => io.disconnect();
  }, [watchKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // The hairline: drawn while there is page left under the strip.
  useEffect(() => {
    const root = getScroller ? getScroller() : null;
    const line = lineRef && lineRef.current;
    if (!root || !line) return;
    const under = root.scrollTop + root.clientHeight < root.scrollHeight - 1;
    line.style.opacity = under ? '1' : '0';
  });

  const ask = () => {
    // Focus first, inside the tap.
    const box = inputRef && inputRef.current;
    if (box && typeof box.focus === 'function') box.focus({ preventScroll: true });
    const root = getScroller ? getScroller() : null;
    const section = root && root.querySelector('[data-nest-band="birdie"]');
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
          borderRadius: '999px',
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
        <img src={isDark ? '/birdie-avatar.png' : '/birdie-avatar-light.png'} alt="" style={{ width: '28px', height: '28px', borderRadius: '999px', objectFit: 'cover', background: isDark ? '#162046' : '#e8eaf0' }} />
        Ask Birdie
      </button>
    </div>
  );
}
