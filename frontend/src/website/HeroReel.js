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
      sizes={shot.landscape ? '(min-width: 1100px) 440px, 340px' : '(min-width: 1100px) 230px, 200px'}
      width={shot.width} height={shot.height}
      loading="lazy" decoding="async"
      alt={copy ? '' : shot.alt}
    />
  );
}

/* Each screen sits in a drawn device (his ask, 2026-10-21: "put the photos
   in phone like a mockup"): a phone's frame and black glass, with the
   status row and the island above the capture, since the web app's captures
   carry no status bar of their own. The Flux screen sits in the sensor as the
   CAD has it from the front ("make the flux screen actually what the cad
   looks like"): the navy face, 182.9 by 175.2 mm, with the 7 inch screen near
   the top, the cream pill holding the heat camera's lens and its light, the
   Flux wordmark, and the door counter's slot in the chin (fluxData.js BOX,
   and the /flux renders). Drawn in CSS, flat, no shadow. */
function Device({ landscape, children }) {
  if (landscape) {
    return (
      <div className="lp-reel-device is-flux">
        <div className="lp-flux-screen">{children}</div>
        <span className="lp-flux-pill" aria-hidden="true"><i className="lp-flux-lens" /><i className="lp-flux-led" /></span>
        <span className="lp-flux-mark" aria-hidden="true">Flux</span>
        <i className="lp-flux-slot" aria-hidden="true" />
      </div>
    );
  }
  return (
    <div className="lp-reel-device">
      <div className="lp-reel-glass">
        <div className="lp-reel-status" aria-hidden="true">
          <span>7:15</span>
          <i className="lp-reel-island" />
          <i className="lp-reel-battery" />
        </div>
        {children}
      </div>
    </div>
  );
}

export default function HeroReel({ shots }) {
  const [paused, setPaused] = useState(false);
  const strip = (copy) => shots.map((shot, i) => (
    <li
      key={`${copy ? 'b' : 'a'}-${shot.name}`}
      className={`lp-reel-item${shot.landscape ? ' is-wide' : ''}`}
      aria-hidden={copy ? 'true' : undefined}
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
