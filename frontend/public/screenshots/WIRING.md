# Where the shipped captures are used

Captured by `frontend/scripts/capture-screenshots.mjs` on 2026-10-21 in a
real-venue run against a seeded local stack: Jayden Bansal's phone, Asad Ali
(who pays the bill), and their friends Nick Ferraro, Kaitlyn Brennan and
Tommy Walsh, all invented, each with a drawn bird for a profile picture. The
places are real ones in Old City, Philadelphia, from Google Places, with their
Google Maps photos: Pizzeria Stella leads the Friday vote against Oh Brother
Philly and Silk City, the cheesesteak run is at Sonny's Famous Steaks, Nick's
birthday at The Franklin Fountain, and last Thursday's dinner at Race Street
Cafe. Birdie's answer is a live reply and the crowd figures are the live
model's. The venue-side screens (the owner dashboard and the venue card) keep
the invented The Copper Finch with drawn photos, so no real business is shown
with events, deals or reviews it never posted.

The photos are Google Maps contributors' and are credited in the site footer
("Venue photos in the app screenshots: Google Maps and its contributors").
Because they are not ours: these files are left out of the iPhone app (the
codemagic.yaml iOS workflows remove `build/screenshots` before `cap sync`; the
native shell never shows the marketing pages) and out of the public copy of
the repository.

Every capture the site shows is the dark theme. Each ships as the 780 x 1688
WebP plus a 480px WebP (`-480w`) for the plates, which paint at 200 to 240 CSS
px. Every name carries `-v2`: the site's CDN keeps a same-named file for a day.

## src/website/HeroReel.js and reelShots.js

- The reel: the home screen leads as `home-reel-v2.avif`, preloaded on `/` from
  vercel.json, cloudflare/_headers and functions/_middleware.js, with
  `nest-dark-v2@2x.webp` and `nest-dark-v2@2x.png` as fallbacks (the AVIF is the
  whole capture at Pillow quality 60). Then crowd-dial, still-in (the roster),
  birdie-pick, map-crowd, plans-tab, profile, messages, bill-chat and the Flux
  sensor's own screen (`flux-screen*`, not a capture of the app).

## src/website/landingAnnotations.js (the home page's annotated plates)

- The Friday plan: `chat-dark-v2`, `budget-dark-v2`, `bill-split-dark-v2`.
- Safety: `sos-dark-v2`. Venues: `owner-dashboard-dark-v2`.

## src/website/HowItWorksPage.js

- Steps: `create-dark-v2`, `vote-dark-v2`, `budget-dark-v2`, `sos-dark-v2`,
  `bill-split-dark-v2`. Venues: `venue-card-events-dark-v2`.

## public/manifest.json (PWA screenshots)

`nest-dark-v2@2x.png`, `create-dark-v2@2x.webp`, `chat-dark-v2@2x.webp`,
`bill-split-dark-v2@2x.webp`.

## Not shipped

The rest of the run (the pizza search list, whose live photos show people's
faces, and the venue analytics, deals and promotions screens) stays out of the
repo. Older captures that carry no Places photo are kept, unshipped, in
`frontend/screenshots/`.
