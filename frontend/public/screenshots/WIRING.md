# Where the shipped captures are used

Captured by `frontend/scripts/capture-screenshots.mjs` on 2026-10-21 against a
seeded local stack: Jayden Bansal's phone, Asad Ali (who pays the bill),
their friends Nick Ferraro, Kaitlyn Brennan and Tommy Walsh, and the
invented venues The Copper Finch, Juniper Bowl and Marigold Diner. The Nest
and SOS frames come from a default run; the rest from a run with
`SHOTS_SCENE=bill`, which leaves the camera account's dinner share unpaid.
The venue card was retaken later that day with The Copper Finch given four
drawn photos, as a listed venue has several: the dining room, a quiz
counter, a stage corner and a basket of wings, one behind each event.
Every venue picture is a drawing from `scripts/shot-art.mjs`. No Google Places
photo appears in any frame, and none may: `public/` is served from
flockcorp.com, copied into every Capacitor build and published.

Every capture the site shows is the dark theme, the hero's own, on the paper
bands and the navy ones alike (the maintainer, 2026-10-21). Each ships as the
780 x 1688 WebP plus a 480px WebP (`-480w`) for the plates, which paint at 200
to 240 CSS px. The hero keeps a PNG fallback.

## src/website/LandingPage.js

- Hero reel (HeroReel.js, since 2026-10-21): the home screen leads it as
  `nest-dark-reel.avif`, preloaded on `/` from vercel.json, cloudflare/_headers
  and functions/_middleware.js, with `nest-dark@2x.webp` and `nest-dark@2x.png`
  as fallbacks. The AVIF is the whole `nest-dark@2x.png`, 780 x 1688, saved by
  Pillow at quality 60 (28.5 KB). The other reel screens are the `-480w`
  and `@2x` WebPs listed in LandingPage.js REEL.
- Friday plan plates: `chat-dark`, `budget-dark`, `bill-split-dark`.
- Venues: `owner-dashboard-dark`.

## src/website/HowItWorksPage.js

- Steps: `create-dark`, `vote-dark`, `budget-dark`, `sos-dark`,
  `bill-split-dark`.
- Venues: `venue-card-events-dark`.

## public/manifest.json (PWA screenshots)

`nest-dark@2x.png`, `create-dark@2x.webp`, `chat-dark@2x.webp`,
`bill-split-dark@2x.webp`.

## Not shipped

The rest of the 2026-10-21 set (Discover, the crowd list and Birdie name real
Honolulu businesses from live Places results) stays out of the repo. Older
captures that carry no Places photo are kept, unshipped, in
`frontend/screenshots/`.
