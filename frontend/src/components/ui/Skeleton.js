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
 *      already has. aria-busy marks the shapes' wrapper only, and the line
 *      is beside it, never inside it (SkeletonStatus says why).
 *
 * The whole screens here (NestSkeleton, VenueBootSkeleton, and
 * SessionBootSkeleton, which picks between them) are here because two places
 * paint them: index.js while the app's chunk is on the wire, and App.js while
 * GET /me answers on a cold start. They used to paint two different things, so
 * a light-mode launch went cream, then navy ("Flock / Loading..."), then cream.
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
 * App.js does the same).
 *
 * aria-busy goes on the shapes' wrapper, and the line is that wrapper's
 * sibling, never inside it. Assistive tech may hold back what a live region
 * says while it sits in a busy subtree, and this subtree is unmounted when
 * the wait ends rather than turned not-busy, so a line inside it might never
 * be spoken at all. The line is absolutely positioned, so it takes no room in
 * a flex or grid parent, and `style` still lays out the shapes.
 */
export function SkeletonStatus({ label = 'Loading', children, style }) {
  return (
    <>
      <span className="sr-only" role="status">{label}</span>
      <div aria-busy="true" style={style}>{children}</div>
    </>
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
 * WHERE A COLD START'S FIRST SCREEN SITS, for NestSkeleton and
 * VenueBootSkeleton. On a phone or in the native shell it fills the screen,
 * the safe areas included, and the strip over the safe top is `top`, the
 * colour of the header under it, as the app paints its own spacer
 * (screenTopIsNavy in services/systemBars.js). In a wider browser it draws
 * inside the same 375px frame the app itself draws there (App.js makeStyles,
 * phoneContainer and notch with fullBleed off), so the frame does not jump
 * when the app arrives. The status line sits beside the busy screen, not
 * inside it, for the reason SkeletonStatus gives. `mark` names the screen on
 * the root (data-nest-skeleton, data-venue-skeleton), its value the layout.
 */
function BootFrame({ mark, label, top, children }) {
  const fullBleed = phoneSized();
  const named = { [`data-${mark}-skeleton`]: fullBleed ? 'phone' : 'frame' };
  if (fullBleed) {
    return (
      <div {...named} style={{ position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column', backgroundColor: 'var(--bg-primary)' }}>
        <p className="sr-only" role="status">{label}</p>
        {/* The screen's column, one level down so it can carry aria-busy
            without the line: it fills the root as the screen's parts did. */}
        <div aria-busy="true" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <div style={{ height: 'var(--safe-top)', backgroundColor: top, flexShrink: 0 }} />
          {children}
        </div>
      </div>
    );
  }
  return (
    <div {...named} style={{ position: 'fixed', inset: 0, overflow: 'auto', backgroundColor: '#1a1a2e', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px', boxSizing: 'border-box' }}>
      <p className="sr-only" role="status">{label}</p>
      <div aria-busy="true" style={{
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
        <div style={{ height: '28px', backgroundColor: '#1e293b', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          <div style={{ width: '120px', height: '24px', backgroundColor: 'black', borderRadius: '20px' }} />
        </div>
        {children}
      </div>
    </div>
  );
}

/**
 * THE NEST, BEFORE ANYTHING IS KNOWN. HomeScreen's own layout (App.js, the
 * home-screen-container): the greeting and the "Hey, name" heading, the 36px
 * avatar, the stat line, the 56px Tonight control and its caption, the 52px
 * Start a flock button, the Your Flocks heading with its two small buttons,
 * three flock cards, and the five tabs. It follows the theme through the CSS
 * tokens, which index.js has written onto <html> before the first paint. It
 * sits in BootFrame, which says how it fills a phone and a wide browser.
 */
export function NestSkeleton({ label = 'Loading Flock.' }) {
  return (
    <BootFrame mark="nest" label={label} top="var(--bg-primary)">
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
    </BootFrame>
  );
}

// The navy the venue dashboard's header paints, per theme: colorsLight.navyBg
// and colorsDark.navyBg in App.js (skeletonScreens.test.js holds the copies
// together). A cold start paints before the app's palette exists, so it reads
// the theme index.js has already written onto <html>.
const HEADER_NAVY = { light: '#1e293b', dark: '#1e3a5c' };
const headerNavy = () => (themeIsDark() ? HEADER_NAVY.dark : HEADER_NAVY.light);

/**
 * THE VENUE DASHBOARD'S SHAPES (screens/VenueDashboard.js): the navy header
 * with the back button and the plan badge, the logo and the two name lines,
 * the five-tab strip, and three cards, exactly where the dashboard puts them,
 * so the screen settles instead of appearing. No numbers, because it has
 * none. They lived in App.js, drawn only while the dashboard's chunk loaded;
 * a cold start into a saved venue mode draws them too (VenueBootSkeleton).
 */
function VenueDashboardShapes({ navyBg }) {
  return (
    <>
      <div aria-hidden="true" style={{ padding: '16px', background: navyBg, flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ width: '32px', height: '32px', borderRadius: '16px', backgroundColor: 'rgba(255,255,255,0.2)' }} />
          <div style={{ width: '96px', height: '24px', borderRadius: '12px', backgroundColor: 'rgba(255,255,255,0.2)' }} />
        </div>
        <div style={{ marginTop: '12px', display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div style={{ width: '48px', height: '48px', borderRadius: '12px', backgroundColor: 'rgba(255,255,255,0.2)', flexShrink: 0 }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ width: '60%', height: '16px', borderRadius: '4px', backgroundColor: 'rgba(255,255,255,0.2)', marginBottom: '8px' }} />
            <div style={{ width: '40%', height: '11px', borderRadius: '4px', backgroundColor: 'rgba(255,255,255,0.14)' }} />
          </div>
        </div>
      </div>
      <div aria-hidden="true" style={{ display: 'flex', gap: '8px', padding: '10px 16px', flexShrink: 0, borderBottom: '1px solid var(--border-default)' }}>
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="skeleton" style={{ flex: 1, height: '28px', borderRadius: '8px' }} />
        ))}
      </div>
      <div aria-hidden="true" style={{ flex: 1, minWidth: 0, overflow: 'hidden', padding: '16px' }}>
        {[0, 1, 2].map((i) => (
          <div key={i} className="skeleton" style={{ width: '100%', height: '104px', borderRadius: '16px', marginBottom: '12px' }} />
        ))}
      </div>
    </>
  );
}

/**
 * The venue dashboard while it is on its way inside the running app: App.js
 * draws it while the dashboard's chunk loads, and while a cold start's first
 * profile read decides between the dashboard and onboarding. `colors` is the
 * app's live palette, so the header follows the theme.
 */
export function VenueDashboardSkeleton({ colors, label = 'Loading your dashboard.' }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', backgroundColor: 'var(--bg-primary)' }}>
      <p className="sr-only" role="status">{label}</p>
      <div aria-busy="true" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <VenueDashboardShapes navyBg={(colors && colors.navyBg) || headerNavy()} />
      </div>
    </div>
  );
}

/**
 * THE VENUE DASHBOARD, BEFORE ANYTHING IS KNOWN: a cold start whose saved mode
 * is venue opens on the dashboard (or, for an owner with no venue yet, on its
 * onboarding, which is as dark), so that is what the wait paints rather than
 * the consumer Nest. In BootFrame like NestSkeleton, with the safe-top strip
 * in the header's navy, as the app paints it over the dashboard.
 */
export function VenueBootSkeleton({ label = 'Loading your dashboard.' }) {
  const navyBg = headerNavy();
  return (
    <BootFrame mark="venue" label={label} top={navyBg}>
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', backgroundColor: 'var(--bg-primary)' }}>
        <VenueDashboardShapes navyBg={navyBg} />
      </div>
    </BootFrame>
  );
}

/**
 * THE APP'S BARE GROUND, for a cold start whose first screen cannot be known
 * yet: the colour the app paints under every screen (App.js FlockAppInner's
 * outer container), --bg-primary on a phone and the dark surround a wide
 * browser draws around the app. No shapes, because none would be honest.
 */
export function BootGround({ label = 'Loading Flock.' }) {
  const fullBleed = phoneSized();
  return (
    <div data-boot-ground={fullBleed ? 'phone' : 'frame'} style={{ position: 'fixed', inset: 0, backgroundColor: fullBleed ? 'var(--bg-primary)' : '#1a1a2e' }}>
      <p className="sr-only" role="status">{label}</p>
    </div>
  );
}

/**
 * WHAT A COLD START WITH A STORED SESSION PAINTS, decided here once for its two
 * painters: index.js while the app's chunk is on the wire, and App.js while
 * GET /me answers. A wait that paints one screen and lands on another is the
 * flash these exist to prevent, so it paints the screen that is coming:
 *
 *   /checkin/<id>     NfcCheckinView, #0f172a edge to edge.
 *   ?admin=true       the admin console for an admin and the Nest for anyone
 *                     else, and nobody's role is known before GET /me answers,
 *                     so the bare ground (BootGround).
 *   a saved venue mode (flockUserMode 'venue')
 *                     the venue dashboard or its onboarding (VenueBootSkeleton),
 *                     and App.js keeps the dashboard's shapes up while its
 *                     first profile read decides which.
 *   anything else     the Nest. A saved admin mode is in this row: nothing
 *                     routes it at launch, so an admin opens on the Nest and
 *                     reaches the console from You or the ?admin=true link.
 */
export function SessionBootSkeleton({ pathname = '', search = '', savedMode = null }) {
  if (/^\/checkin\/[^/?#]+/.test(pathname)) {
    return (
      <div style={{ position: 'fixed', inset: 0, backgroundColor: '#0f172a' }}>
        <p className="sr-only" role="status">Loading Flock.</p>
      </div>
    );
  }
  let adminLink = false;
  try { adminLink = new URLSearchParams(search).get('admin') === 'true'; } catch { adminLink = false; }
  if (adminLink) return <BootGround label="Loading Flock." />;
  if (savedMode === 'venue') return <VenueBootSkeleton />;
  return <NestSkeleton label="Loading Flock." />;
}
