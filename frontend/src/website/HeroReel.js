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
        <source type="image/avif" srcSet="/screenshots/nest-dark-reel.avif" />
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

export default function HeroReel({ shots }) {
  const [paused, setPaused] = useState(false);
  const strip = (copy) => shots.map((shot, i) => (
    <li
      key={`${copy ? 'b' : 'a'}-${shot.name}`}
      className={`lp-reel-item${shot.landscape ? ' is-wide' : ''}`}
      aria-hidden={copy ? 'true' : undefined}
    >
      <Screen shot={shot} first={i === 0} copy={copy} />
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
