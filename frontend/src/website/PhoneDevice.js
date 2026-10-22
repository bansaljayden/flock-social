import React from 'react';

/* The drawn phone every capture on the site sits in: a graphite frame, black
   glass, and the status row (the time, the island, the battery) above the
   capture, since the web app's captures carry no status bar of their own.
   The hero's reel draws it with `rim`, the ten slices that give a tilted
   phone its solid edge (HeroReel.js); How it works draws it flat. Its sizes
   are shares of --reel-w, the phone's width (LandingPage.css). The annotated
   captures on the home page draw the same frame around the outside of the
   capture instead (AnnotatedShot.js), so their leaders keep the capture's
   measured box. */
const RIM = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

export function PhoneStatus() {
  return (
    <div className="lp-reel-status" aria-hidden="true">
      <span>7:15</span>
      <i className="lp-reel-island" />
      <i className="lp-reel-battery" />
    </div>
  );
}

export default function PhoneDevice({ rim = false, children }) {
  return (
    <div className="lp-reel-device">
      {rim ? (
        <span className="lp-reel-rim" aria-hidden="true">
          {RIM.map((k) => <i key={k} style={{ '--k': k }} />)}
        </span>
      ) : null}
      {/* The front (frame and glass) is a layer of its own, a pixel in front
          of the rim and after it in the page, so the rim stays behind the
          screen even where a browser draws the device flat and paints the
          rim's positioned slices over the glass. */}
      <div className="lp-reel-front">
        <div className="lp-reel-glass">
          <PhoneStatus />
          {children}
        </div>
      </div>
    </div>
  );
}
