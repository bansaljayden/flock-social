import React from 'react';
import { APP_STORE_URL } from './AppStoreBadge';

/* Flock's listing on the App Store, as a picture: the top of Apple's own page
   for the app, linked to it. It sits in the home page's #get band beside
   Apple's badge, and /about's November 4, 2026 milestone links here (#listing).

   THE PICTURE IS APPLE'S PAGE, CROPPED, NOT REDRAWN. scripts/capture-app-store-listing.mjs
   takes it from apps.apple.com, signed out, at a desktop width and a phone
   width, and this serves each layout where it reads: Apple's phone layout
   under 600px, its desktop layout from there up. The crop is the listing's
   header band: Flock's icon, the name, the subtitle and Apple's two lines
   under them. Three things on that page stay out of it, by where the crop
   stops, never by covering anything:
     - the chip row under the band, whose developer chip names the account
       holder until Apple moves the account to Flock Social LLC;
     - the screenshot carousel, which shows Google Maps photos of real venues;
     - Apple's navigation and its App Store mark.
   The script refuses a crop that paints any other text, and
   appStoreLive.test.js pins the crop sizes and these words.

   Not Apple's badge, so none of the badge's rules are needed here, and it
   never stands in for the badge: the badge comes first in #get. Nothing moves:
   a hover only lightens the edge. Below the fold, so it loads lazily and
   never competes with the hero for the first paint. */
export const LISTING_ALT = 'Flock Social App on the App Store';
// The day the picture was taken. The listing changes (ratings, the developer
// once the account moves), so the caption dates what it shows.
export const LISTING_TAKEN = '2026-11-05';
export const LISTING_ID = 'listing';

export default function AppStoreListing() {
  return (
    <figure className="lp-listing" id={LISTING_ID}>
      <a className="lp-listing-link" href={APP_STORE_URL} target="_blank" rel="noopener noreferrer">
        {/* width and height on every source: the two layouts have different
            shapes, so each holds its own box before its file arrives. */}
        <picture>
          <source
            media="(max-width: 599px)"
            type="image/webp"
            srcSet="/marks/app-store-listing-phone-390.webp 390w, /marks/app-store-listing-phone-780.webp 780w"
            sizes="calc(100vw - 40px)"
            width="390" height="195"
          />
          <source media="(max-width: 599px)" srcSet="/marks/app-store-listing-phone-780.png 2x" width="390" height="195" />
          <source
            type="image/webp"
            srcSet="/marks/app-store-listing-desktop-613.webp 613w, /marks/app-store-listing-desktop-1226.webp 1226w"
            sizes="(min-width: 1100px) 33rem, min(613px, 90vw)"
            width="613" height="284"
          />
          <img
            src="/marks/app-store-listing-desktop-1226.png"
            width="613" height="284"
            alt={LISTING_ALT}
            loading="lazy" decoding="async"
          />
        </picture>
      </a>
      <figcaption className="lp-fig-cap">
        Flock’s App Store listing, as of <time dateTime={LISTING_TAKEN}>November 5, 2026</time>.
      </figcaption>
    </figure>
  );
}
