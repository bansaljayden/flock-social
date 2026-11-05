import React from 'react';

/* Apple's "Download on the App Store" badge, linking to Flock's listing.
   Apple released Flock 1.0 for iPhone on 2026-11-04.

   THE ARTWORK IS APPLE'S, BYTE FOR BYTE. public/marks/download-on-the-app-store-black.svg
   is the black US-English badge exactly as Apple's badge service serves it
   (toolbox.marketingtools.apple.com/api/v2/badges/download-on-the-app-store/black/en-us,
   fetched 2026-11-05; tools.applemarketingtools.com, the old address, no
   longer resolves). Nothing here recolours, crops, outlines or redraws it, and
   there is no Apple logo anywhere on the site outside this file.

   APPLE'S BADGE RULES (App Store Marketing Guidelines), and where each lives:
     - The black badge is the preferred one, and its grey border is part of the
       artwork. Black is used on every ground, navy included.
     - At least 40px tall on screen. Each page's stylesheet sets 40 to 52px.
     - Clear space of a quarter of the badge's height on every side, with no
       text or graphics inside it. The page stylesheets hold the gaps.
     - Never modified, angled or animated. No hover lift, no press, and no
       arrival: every badge sits outside the hero's entrance animation, and
       marketingSiteAccessibility.test.js holds both.
     - Credit lines for Apple and the Apple logo, once, where the site gives its
       legal notices: SiteFooter.js.

   The accessible name is the badge's own words, so a speech-input user can say
   what they see (WCAG 2.5.3). The listing opens in a new tab, like the site's
   other links off the site, so the page stays where it was. */
export const APP_STORE_URL = 'https://apps.apple.com/app/id6781442127';
export const APP_STORE_BADGE = '/marks/download-on-the-app-store-black.svg';

export default function AppStoreBadge({ className, onClick }) {
  return (
    <a
      className={className}
      href={APP_STORE_URL}
      target="_blank"
      rel="noopener noreferrer"
      onClick={onClick}
    >
      {/* 120 x 40 is the artwork's own box (119.66 x 40), so the browser holds
          the right space before the file arrives; CSS sets the height. */}
      <img src={APP_STORE_BADGE} width="120" height="40" alt="Download on the App Store" decoding="async" />
    </a>
  );
}
