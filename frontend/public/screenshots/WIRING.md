# Where the shipped captures are used

Captured by `frontend/scripts/capture-screenshots.mjs` on 2026-10-21 against a
seeded local stack: Maya Chen's phone, her friends Jordan, Sam, Priya and Leo,
and the invented venues The Copper Finch, Juniper Bowl and Marigold Diner.
Every venue picture is a drawing from `scripts/shot-art.mjs`. No Google Places
photo appears in any frame, and none may: `public/` is served from
flockcorp.com, copied into every Capacitor build and published.

Every capture the site shows is the dark theme, the hero's own, on the paper
bands and the navy ones alike (the maintainer, 2026-10-21). Each ships as the
780 x 1688 WebP plus a 480px WebP (`-480w`) for the plates, which paint at 200
to 240 CSS px. The hero keeps a PNG fallback.

## src/website/LandingPage.js

- Hero: `nest-dark@2x.webp` (PNG fallback `nest-dark@2x.png`), preloaded on `/`
  from vercel.json and cloudflare/_headers.
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
