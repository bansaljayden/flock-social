/**
 * SKELETON PARTS, AND THE FEW WHOLE SHAPES MORE THAN ONE SCREEN DRAWS.
 *
 * What a screen paints while the thing it is about to show is still on the
 * wire: grey shapes where the content will land, in the content's own sizes,
 * so the screen settles instead of appearing (DESIGN-STANDARD rule 10). The sweep,
 * its colour per theme and its reduced-motion rule are the global `.skeleton`
 * class in index.css; `.skeleton-dark` is the tone for shapes on a navy header
 * or the photo viewer's scrim.
 *
 * Three rules every caller keeps.
 *
 *   1. The shape comes from the real markup. Sizes, radii and gaps are read off
 *      the component the skeleton stands in for, so the swap moves nothing.
 *   2. No data. A skeleton draws where content goes, never what it says: no
 *      numbers, no names, no map pins, no counts.
 *   3. One spoken status per wait. Every shape here is aria-hidden; the words
 *      come from SkeletonStatus, or from a role="status" line the caller
 *      already has.
 *
 * NestSkeleton is the one whole screen in this file, because two places paint
 * it: index.js while the app's chunk is on the wire, and App.js while GET /me
 * answers on a cold start. They used to paint two different things, so a
 * light-mode launch went cream, then navy ("Flock / Loading..."), then cream.
 * FlockCardSkeleton is here because the Nest, that boot screen and Past flocks
 * all draw it; RosterSkeleton because the plan screen and the cold-start plan
 * opening in App.js both do.
 */
import React from 'react';
import { isNativeShell } from '../../lib/nativeShell';

const px = (v) => (typeof v === 'number' ? `${v}px` : v);

/** A bar: a line of text, a pill, a button. Every other part is one of these. */
export function SkeletonBar({ width = '100%', height = 12, radius = 4, dark = false, style }) {
  // A span drawn as a block, so a bar is valid inside a heading or a button as
  // well as inside a div.
  return (
    <span
      aria-hidden="true"
      className={dark ? 'skeleton skeleton-dark' : 'skeleton'}
      style={{
        display: 'block',
        boxSizing: 'border-box',
        flexShrink: 0,
        width: px(width),
        height: px(height),
        borderRadius: px(radius),
        ...style,
      }}
    />
  );
}

/** A face, or a round control. */
export function SkeletonCircle({ size = 40, dark = false, style }) {
  return <SkeletonBar width={size} height={size} radius="50%" dark={dark} style={style} />;
}

/** A card-sized area: a photo, a control strip, a whole button. */
export function SkeletonBlock({ width = '100%', height = 64, radius = 12, dark = false, style }) {
  return <SkeletonBar width={width} height={height} radius={radius} dark={dark} style={style} />;
}

/**
 * A list row: an optional thumbnail, its lines of text, optional pills at the
 * end. The default is the bordered card row ListSkeleton in App.js draws;
 * `bare` drops the border and the fill, for rows that sit straight on a sheet
 * or inside a card, and `divider` puts the hairline under the row that such
 * lists rule themselves with. The first line is a name (14px), the rest are
 * the smaller lines under it (11px).
 */
export function SkeletonRow({
  thumb = 44,
  round = false,
  thumbRadius = 10,
  lines = ['60%', '40%'],
  trailing = [],
  bare = false,
  divider = false,
  padding = bare ? '10px 8px' : '12px',
  gap = 12,
  radius = bare ? 12 : 14,
  marginBottom = bare ? 4 : 10,
  dark = false,
  style,
}) {
  return (
    <div
      aria-hidden="true"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: px(gap),
        padding,
        marginBottom: px(marginBottom),
        borderRadius: px(radius),
        boxSizing: 'border-box',
        ...(bare ? null : { border: '1px solid var(--border-subtle)', backgroundColor: 'var(--bg-card-solid)' }),
        ...(divider ? { borderBottom: '1px solid var(--border-light)' } : null),
        ...style,
      }}
    >
      {thumb ? <SkeletonBar width={thumb} height={thumb} radius={round ? '50%' : thumbRadius} dark={dark} /> : null}
      <div style={{ flex: 1, minWidth: 0 }}>
        {lines.map((width, i) => (
          <SkeletonBar key={i} width={width} height={i === 0 ? 14 : 11} dark={dark} style={i === 0 ? null : { marginTop: '7px' }} />
        ))}
      </div>
      {trailing.map((t, i) => (
        <SkeletonBar key={i} width={t.width} height={t.height ?? 28} radius={t.radius ?? 14} dark={dark} />
      ))}
    </div>
  );
}

/**
 * The spoken half of a skeleton. The shapes are aria-hidden, so this is the
 * one thing a screen reader hears while the region waits: a real sentence in
 * an sr-only line with role="status" (a status carrying nothing but an
 * aria-label is announced unevenly, which is why SearchResultsSkeleton in
 * App.js does the same), and aria-busy on the region itself. The line is
 * absolutely positioned, so it takes no room in a flex or grid parent.
 */
export function SkeletonStatus({ label = 'Loading', children, style }) {
  return (
    <div aria-busy="true" style={style}>
      <span className="sr-only" role="status">{label}</span>
      {children}
    </div>
  );
}

/**
 * One flock card on the Nest (App.js HomeScreen, the liveFlocks map), or with
 * `past` one row of Past flocks (screens/PastFlocksScreen.js). The card's 14px
 * by 16px padding, radius 14, border and shadow; the name line at --t-title and
 * the venue line under it; the status pill top right; three overlapping 24px
 * faces; and on the Nest the time pill, on Past flocks the date pill and the
 * Do it again button. Three faces is the shape of the stack, not a headcount:
 * a card shows one to four faces and a count, and three reads as neither.
 */
export function FlockCardSkeleton({ past = false }) {
  return (
    <div aria-hidden="true" style={{ padding: '14px 16px', borderRadius: '14px', border: '1px solid var(--border-default)', backgroundColor: 'var(--bg-card-solid)', boxShadow: 'var(--card-shadow-sm)', overflow: 'hidden', boxSizing: 'border-box' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '10px', marginBottom: '8px' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          {/* The name, a --t-title line (19px on 1.2). */}
          <SkeletonBar width="55%" height={18} radius={5} style={{ margin: '2px 0 3px' }} />
          {/* The venue, a --t-meta line 3px under it. */}
          <SkeletonBar width="40%" height={12} style={{ margin: '5px 0 2px' }} />
        </div>
        <SkeletonBar width={past ? 84 : 76} height={20} radius={10} />
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
          <div style={{ display: 'flex', flexShrink: 0 }}>
            {[0, 1, 2].map((j) => (
              <SkeletonCircle key={j} size={24} style={{ border: '2px solid var(--bg-card-solid)', marginLeft: j > 0 ? '-6px' : 0 }} />
            ))}
          </div>
          {past ? <SkeletonBar width={52} height={20} radius={10} /> : null}
        </div>
        {past ? <SkeletonBar width={92} height={32} radius={10} /> : <SkeletonBar width={64} height={20} radius={10} />}
      </div>
    </div>
  );
}

/** Flock cards in their list's own column, 10px apart, under one status. */
export function FlockListSkeleton({ count = 3, past = false, label }) {
  return (
    <SkeletonStatus label={label} style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      {Array.from({ length: count }, (_, i) => <FlockCardSkeleton key={i} past={past} />)}
    </SkeletonStatus>
  );
}

/**
 * The plan screen's Going row (screens/FlockDetail.js, the roster map): a
 * 44px face over a first name, 54px wide and 12px apart. Four, which is about
 * what a phone shows before the row scrolls sideways, and again the shape of
 * the row rather than a count of anybody.
 */
export function RosterSkeleton({ count = 4, label = 'Loading who is going' }) {
  return (
    <SkeletonStatus label={label} style={{ display: 'flex', gap: '12px', paddingBottom: '4px', overflow: 'hidden' }}>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} aria-hidden="true" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '5px', minWidth: '54px', flexShrink: 0 }}>
          <SkeletonCircle size={44} />
          <SkeletonBar width={36} height={10} radius={3} style={{ margin: '3px 0' }} />
        </div>
      ))}
    </SkeletonStatus>
  );
}

/**
 * One event on the Live Events list (screens/ExploreScreen.js, the
 * featuredEvents map): the 132px picture header, the name and the venue, the
 * line of time, genre and price, and the Start Flock and Details row.
 */
export function EventCardSkeleton() {
  return (
    <div aria-hidden="true" style={{ backgroundColor: 'var(--bg-card-solid)', borderRadius: '16px', border: '1px solid var(--border-default)', marginBottom: '10px', overflow: 'hidden', boxShadow: '0 2px 10px rgba(0,0,0,0.04)' }}>
      <SkeletonBlock height={132} radius={0} />
      <div style={{ padding: '12px 14px' }}>
        <SkeletonBar width="70%" height={18} radius={5} style={{ margin: '3px 0 7px' }} />
        <SkeletonBar width="45%" height={12} style={{ margin: '2px 0 8px' }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <SkeletonBar width={64} height={14} />
          <SkeletonBar width={56} height={18} radius={8} />
          <SkeletonBar width={44} height={14} />
        </div>
        <div style={{ display: 'flex', gap: '8px', marginTop: '10px' }}>
          <SkeletonBar width="auto" height={34} radius={10} style={{ flexGrow: 1 }} />
          <SkeletonBar width={84} height={34} radius={10} />
        </div>
      </div>
    </div>
  );
}

// The app's own answer to "is this a phone" (App.js isFullBleedNow): inside
// the native shell, or a window no wider than one. Anything else gets the
// desktop frame the app draws there.
const phoneSized = () => {
  try {
    if (isNativeShell()) return true;
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 500px)').matches;
  } catch {
    return true;
  }
};

const themeIsDark = () => {
  try { return document.documentElement.getAttribute('data-theme') === 'dark'; } catch { return false; }
};

/**
 * THE NEST, BEFORE ANYTHING IS KNOWN. HomeScreen's own layout (App.js, the
 * home-screen-container): the greeting and the "Hey, name" heading, the 36px
 * avatar, the stat line, the 56px Tonight control and its caption, the 52px
 * Start a flock button, the Your Flocks heading with its two small buttons,
 * three flock cards, and the five tabs. It follows the theme through the CSS
 * tokens, which index.js has written onto <html> before the first paint.
 *
 * On a phone or in the native shell it fills the screen, the safe areas
 * included. In a wider browser it draws inside the same 375px frame the app
 * itself draws there (App.js makeStyles, phoneContainer and notch with
 * fullBleed off), so the frame does not jump when the app arrives.
 */
export function NestSkeleton({ label = 'Loading Flock.' }) {
  const fullBleed = phoneSized();
  const screen = (
    <>
      {fullBleed ? (
        <div style={{ height: 'var(--safe-top)', backgroundColor: 'var(--bg-primary)', flexShrink: 0 }} />
      ) : (
        <div style={{ height: '28px', backgroundColor: '#1e293b', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          <div style={{ width: '120px', height: '24px', backgroundColor: 'black', borderRadius: '20px' }} />
        </div>
      )}
      <div aria-hidden="true" style={{ flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column', backgroundColor: 'var(--bg-primary)' }}>
        <div style={{ padding: '14px 16px 12px', flexShrink: 0 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px' }}>
            <div>
              {/* The cycling greeting's 12px line, then the heading at
                  --t-display on a 1.1 line, 4px under it. */}
              <SkeletonBar width={96} height={12} />
              <SkeletonBar width={150} height={26} radius={6} style={{ margin: '5px 0 2px' }} />
            </div>
            <SkeletonCircle size={36} />
          </div>
          {/* The flocks and friends line, 12px over the control. */}
          <SkeletonBar width={112} height={13} style={{ margin: '2px 0 14px' }} />
          <SkeletonBlock height={56} radius={14} />
          {/* "Friends see your answer until it clears at 4 AM.", right aligned. */}
          <SkeletonBar width={230} height={10} style={{ margin: '8px 4px 2px auto', maxWidth: '80%' }} />
        </div>
        <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', padding: '4px 16px 16px' }}>
          <SkeletonBlock height={52} radius={14} style={{ marginBottom: '18px' }} />
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '0 0 8px' }}>
            <SkeletonBar width={84} height={14} />
            <div style={{ display: 'flex', gap: '6px' }}>
              <SkeletonBar width={60} height={26} radius={8} />
              <SkeletonBar width={102} height={26} radius={8} />
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <FlockCardSkeleton />
            <FlockCardSkeleton />
            <FlockCardSkeleton />
          </div>
        </div>
      </div>
      {/* The tab bar: styles.bottomNav's padding and inset, and each tab's
          22px icon over its label. */}
      <div aria-hidden="true" style={{ display: 'flex', justifyContent: 'space-around', padding: '10px 8px calc(12px + var(--safe-bottom))', backgroundColor: 'var(--bg-nav)', borderTop: 'var(--nav-border)', boxShadow: 'var(--nav-shadow)', flexShrink: 0 }}>
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '8px 14px' }}>
            <SkeletonBar width={22} height={22} radius={6} />
            <SkeletonBar width={30} height={9} radius={3} style={{ margin: '6px 0 3px' }} />
          </div>
        ))}
      </div>
    </>
  );

  if (fullBleed) {
    return (
      <div aria-busy="true" data-nest-skeleton="phone" style={{ position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column', backgroundColor: 'var(--bg-primary)' }}>
        <p className="sr-only" role="status">{label}</p>
        {screen}
      </div>
    );
  }
  return (
    <div aria-busy="true" data-nest-skeleton="frame" style={{ position: 'fixed', inset: 0, overflow: 'auto', backgroundColor: '#1a1a2e', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px', boxSizing: 'border-box' }}>
      <p className="sr-only" role="status">{label}</p>
      <div style={{
        width: '375px',
        maxWidth: '375px',
        height: '100vh',
        maxHeight: '812px',
        margin: '20px auto',
        boxSizing: 'border-box',
        flexShrink: 0,
        borderRadius: '44px',
        border: '6px solid #1e293b',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: 'var(--bg-card-solid)',
        boxShadow: themeIsDark()
          ? '0 25px 80px -12px rgba(0,0,0,0.7), 0 10px 30px rgba(0,0,0,0.4)'
          : '0 25px 80px -12px rgba(0, 0, 0, 0.4), 0 10px 30px rgba(13,40,71,0.10), inset 0 1px 0 rgba(255,255,255,0.1)',
      }}>
        {screen}
      </div>
    </div>
  );
}
