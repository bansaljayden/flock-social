import React, { useState } from 'react';

/* The hero's reel: real screens of the web app (and the Flux sensor's own
   screen) drifting past under the headline, the way you would flick through
   them on a phone (the maintainer, 2026-10-21: "a carousel of like 10 different apps
   screenshots and then when i hover over one it pops out").

   It is one strip drawn twice and moved by exactly one strip's width, so the
   loop has no seam; the second copy is hidden from screen readers. Hovering
   the strip stops it and lifts the screen under the pointer. Moving content
   that starts on its own needs a way to stop it (WCAG 2.2.2), so the Pause
   button does that for a keyboard or a finger; with "reduce motion" on nothing
   moves at all and the strip simply scrolls sideways.

   The first screen is the home screen, from the same files the / preload
   names, so the browser that took the preload paints it from cache; every
   other screen loads lazily, at the 480px cut, which is 2x at the strip's
   widest card. */

export const HOME_ALT = 'The Flock home screen: tonight’s status, your flocks, and a plan that still needs votes.';

function Screen({ shot, first, copy }) {
  if (first) {
    return (
      <picture>
        <source type="image/avif" srcSet="/screenshots/home-reel.avif" />
        <source type="image/webp" srcSet="/screenshots/nest-dark@2x.webp" />
        <img
          className="lp-shot-hero"
          src="/screenshots/nest-dark@2x.png"
          width="390" height="844"
          alt={copy ? '' : HOME_ALT}
          {...(copy ? { loading: 'lazy', decoding: 'async' } : {})}
        />
      </picture>
    );
  }
  return (
    <img
      className="lp-reel-shot"
      src={shot.src}
      srcSet={shot.srcSet}
      sizes={shot.landscape ? '(min-width: 1100px) 362px, (min-width: 600px) 315px, 265px' : '(min-width: 1100px) 230px, 200px'}
      width={shot.width} height={shot.height}
      loading="lazy" decoding="async"
      alt={copy ? '' : shot.alt}
    />
  );
}

/* Each screen sits in a drawn device: a phone's frame and black glass, with
   the status row and the island above the capture, since the web app's
   captures carry no status bar of their own. Behind the front, the phone's
   outline is drawn again in ten slices through its depth (.lp-reel-rim), so a
   tilted phone shows one solid rounded rim, corners, top and bottom included,
   where two flat side faces left gaps.

   The Flux screen sits in the sensor itself, in two photographs of the box:
   straight on, and turned to show its right side and top. Both are generated
   from the CAD's own renders of the assembled box (fluxData.js BOX: 182.9
   wide, 175.2 tall, 74.4 deep, in mm), so every edge, the lens, the pill's
   light and the door counter's slot sit where the CAD has them, in printed
   navy plastic with its layer lines, and the turned one has the rounded
   corners and bottom edge a box folded from flat photographs could not.
   Straight on, the Flock mark beside the wordmark is the logo file itself,
   laid over the badge, and the screen is the capture reelShots.js names, set
   into the photo's glass; the turned photograph carries the same capture,
   set into its glass in perspective when it was made. */
const RIM = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const FLUX_SIZES = '(min-width: 1100px) 437px, (min-width: 600px) 380px, 320px';

function Device({ landscape, children }) {
  if (landscape) {
    return (
      <div className="lp-reel-device is-flux">
        <div className="lp-flux-view is-front">
          <img
            className="lp-flux-photo"
            src="/sensor/flux-real-front.webp"
            srcSet="/sensor/flux-real-front.webp 440w, /sensor/flux-real-front@2x.webp 880w"
            sizes={FLUX_SIZES}
            width="440" height="421"
            alt="" loading="lazy" decoding="async"
          />
          <div className="lp-flux-screen">{children}</div>
        </div>
        <img
          className="lp-flux-view is-turned"
          src="/sensor/flux-real-turned.webp"
          srcSet="/sensor/flux-real-turned.webp 440w, /sensor/flux-real-turned@2x.webp 880w"
          sizes={FLUX_SIZES}
          width="440" height="421"
          alt="" loading="lazy" decoding="async"
        />
      </div>
    );
  }
  return (
    <div className="lp-reel-device">
      <span className="lp-reel-rim" aria-hidden="true">
        {RIM.map((k) => <i key={k} style={{ '--k': k }} />)}
      </span>
      {/* The front (frame and glass) is a layer of its own, a pixel in front
          of the rim and after it in the page, so the rim stays behind the
          screen even where a browser draws the device flat and paints the
          rim's positioned slices over the glass. */}
      <div className="lp-reel-front">
        <div className="lp-reel-glass">
          <div className="lp-reel-status" aria-hidden="true">
            <span>7:15</span>
            <i className="lp-reel-island" />
            <i className="lp-reel-battery" />
          </div>
          {children}
        </div>
      </div>
    </div>
  );
}

/* The devices are solid in 3D. Under a mouse the phone you are over tilts
   toward the pointer, showing its edge; a click or a tap turns it to its
   side, and another turns it back. The tilt is written as two custom
   properties on the card, so nothing re-renders as the pointer moves. The
   Flux box turns to its second photograph instead (LandingPage.css).
   "Reduce motion" keeps the phones flat. */
const tilt = (e) => {
  if (e.pointerType !== 'mouse') return;
  const card = e.currentTarget;
  const r = card.getBoundingClientRect();
  const x = (e.clientX - r.left) / r.width - 0.5;
  const y = (e.clientY - r.top) / r.height - 0.5;
  card.style.setProperty('--ry', `${(x * 38).toFixed(1)}deg`);
  card.style.setProperty('--rx', `${(-y * 22).toFixed(1)}deg`);
};
const untilt = (e) => {
  e.currentTarget.style.removeProperty('--ry');
  e.currentTarget.style.removeProperty('--rx');
};
const turn = (e) => e.currentTarget.classList.toggle('is-turned');

export default function HeroReel({ shots }) {
  const [paused, setPaused] = useState(false);
  const strip = (copy) => shots.map((shot, i) => (
    <li
      key={`${copy ? 'b' : 'a'}-${shot.name}`}
      className={`lp-reel-item${shot.landscape ? ' is-wide' : ''}`}
      aria-hidden={copy ? 'true' : undefined}
      onPointerMove={tilt}
      onPointerLeave={untilt}
      onClick={turn}
    >
      <Device landscape={shot.landscape}>
        <Screen shot={shot} first={i === 0} copy={copy} />
      </Device>
    </li>
  ));
  return (
    <div className={`lp-reel${paused ? ' is-paused' : ''}`}>
      <ul className="lp-reel-track" aria-label="Screens from the app">
        {strip(false)}
        {strip(true)}
      </ul>
      <button
        type="button"
        className="lp-reel-pause"
        aria-pressed={paused}
        onClick={() => setPaused((p) => !p)}
      >
        {paused ? 'Play' : 'Pause'}
      </button>
    </div>
  );
}
