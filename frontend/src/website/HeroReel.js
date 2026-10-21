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

/* Each screen sits in a drawn device (his ask, 2026-10-21: "put the photos
   in phone like a mockup"): a phone's frame and black glass, with the
   status row and the island above the capture, since the web app's captures
   carry no status bar of their own. Behind the front, the phone's outline is
   drawn again in ten slices through its depth (.lp-reel-rim), so a tilted
   phone shows one solid rounded rim, corners, top and bottom included, where
   two flat side faces left gaps.

   The Flux screen sits in the sensor itself, a box of four photographs: the
   front, both sides and the top, each cut to the CAD's own size (fluxData.js
   BOX: 182.9 wide, 175.2 tall, 74.4 deep, in mm) and folded together in
   LandingPage.css. Drawn in CSS, the face read as a cartoon beside the
   phones' real screens. The photographs are generated from the CAD's
   straight-on renders of the assembled box, so every edge, the lens, the
   pill's light and the door counter's slot sit where the CAD has them, in
   printed navy plastic with its layer lines; the right side is the left one
   mirrored, its one light set where the CAD has it, and the Flock mark beside
   the wordmark is the logo file itself, laid over the badge. The sensor's
   screen is the capture above, set into the photo's glass, so the reel still
   shows the one reelShots.js names. */
const RIM = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const FLUX_FACE_SIZES = '(min-width: 1100px) 437px, (min-width: 600px) 380px, 320px';
const FLUX_DEPTH_SIZES = '(min-width: 1100px) 178px, (min-width: 600px) 155px, 130px';

function Device({ landscape, children }) {
  if (landscape) {
    return (
      <div className="lp-reel-device is-flux">
        <div className="lp-flux-face is-front">
          <img
            className="lp-flux-photo"
            src="/sensor/flux-real-front.webp"
            srcSet="/sensor/flux-real-front.webp 440w, /sensor/flux-real-front@2x.webp 880w"
            sizes={FLUX_FACE_SIZES}
            width="440" height="421"
            alt="" loading="lazy" decoding="async"
          />
          <div className="lp-flux-screen">{children}</div>
        </div>
        <img
          className="lp-flux-face is-right"
          src="/sensor/flux-real-right.webp"
          srcSet="/sensor/flux-real-right.webp 179w, /sensor/flux-real-right@2x.webp 358w"
          sizes={FLUX_DEPTH_SIZES}
          width="179" height="421"
          alt="" loading="lazy" decoding="async"
        />
        <img
          className="lp-flux-face is-left"
          src="/sensor/flux-real-left.webp"
          srcSet="/sensor/flux-real-left.webp 179w, /sensor/flux-real-left@2x.webp 358w"
          sizes={FLUX_DEPTH_SIZES}
          width="179" height="421"
          alt="" loading="lazy" decoding="async"
        />
        <img
          className="lp-flux-face is-top"
          src="/sensor/flux-real-top.webp"
          srcSet="/sensor/flux-real-top.webp 440w, /sensor/flux-real-top@2x.webp 880w"
          sizes={FLUX_FACE_SIZES}
          width="440" height="179"
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
      {/* The front (frame and glass) is a 3D layer of its own, a pixel in
          front of the rim: Safari otherwise painted the rim's slices over a
          front that sat flat at depth zero, and a tilted phone showed only a
          grey slab (found on the maintainer's iPad, 2026-10-21). */}
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

/* The devices are solid in 3D (his ask, 2026-10-21: "the phone mockups
   should be 3D when I go over them / click on them"). Under a mouse the one
   you are over tilts toward the pointer, showing its edge; a click or a tap
   turns it to its side, and another turns it back. The tilt is written as two
   custom properties on the card, so nothing re-renders as the pointer moves.
   "Reduce motion" keeps them flat (LandingPage.css). */
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
