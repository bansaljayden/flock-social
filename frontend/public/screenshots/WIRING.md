# Where the shipped captures are used

Captured on 2026-11-07 by `frontend/scripts/capture-screenshots.mjs
--story=site --suffix=-v3` against a seeded local stack. The rig blanks every
paid service's key, answers every venue search, venue detail, crowd figure,
weather reading and Birdie answer inside the browser, in the shapes the server
returns, and refuses a request for any other host. Nothing in the frames comes
from Google.

In the frames: Jayden Bansal's phone, Asad Ali (who pays the bill), and their
friends Nick Ferraro, Kaitlyn Brennan and Tommy Walsh, seeded accounts, each
with a painted bird for a profile picture (`frontend/scripts/shot-avatars/`),
never a face. Two of the names are real: Jayden Bansal and Asad Ali are the
people who make Flock.

Every place is invented: The Copper Finch (burgers and wings, the venue whose
own dashboard and card are shown), Juniper Bowl, Bluewing Diner, Kestrel Pizza
Co., Saltmarsh Tacos, Snow Bunting Creamery, Plover Sushi, Wren & Rye Bakery
and Fernway Greens, each a name no business in Philadelphia uses, placed on Old
City's streets with addresses on a Main St that has no such numbers. Every
venue picture is a drawing from `frontend/scripts/shot-art.mjs`. The app's own
"Google Maps" labels appear where the app draws them on venue data; here they
sit on invented places. No frame shows the map: the run had no map key, so
Discover is its search list.

The plans: Trivia Night tonight at The Copper Finch, locked in (the home
screen's first card and the roster); Friday Night Crew on Friday, where The
Copper Finch leads the vote three to one to one and four budgets of five are in
(the fifth is the $35 sheet); Nick's Birthday at Snow Bunting Creamery; and
last Thursday's dinner at Kestrel Pizza Co., $120.85 and an 18% tip, $142.60,
$28.52 each, which Asad paid.

The crowd figures and Birdie's answer were written for the capture. The crowd
card says what such a figure is, "An estimate from typical patterns for this
kind of place.", and its label is hedged ("Usually busy"); no frame carries a
LIVE or ESTIMATED badge. What the card says about the figures is not written:
its quietest hour and its busiest hours are the ones the server's crowd engine
names for them (the rig calls the same functions). The frames are shot at 7 PM
local: the browser's time zone is moved to where it is 7 PM, its clock is not.

Every capture the site shows is the dark theme. Each ships as the 780 x 1688
WebP plus a 480px WebP (`-480w`) for the plates, which paint at about 186 to
312 CSS px (How it works 186 to 242, the reel 200 to 230, the home page's
annotated phones 224 to 312). The home screen also ships as
`home-reel-v3.avif` (under 40,000 bytes) and `nest-dark-v3@2x.png` (full
colour, not a palette). Every name carries `-v3`: the site's CDN keeps a
same-named file for a day.

## src/website/HeroReel.js and reelShots.js

- The reel: the home screen leads as `home-reel-v3.avif`, preloaded on `/` from
  vercel.json, cloudflare/_headers and functions/_middleware.js, with
  `nest-dark-v3@2x.webp` and `nest-dark-v3@2x.png` as fallbacks. Then
  crowd-dial, still-in (the roster), birdie-pick, crowd-list, plans-tab,
  profile, messages, bill-chat and the Flux sensor's own screen
  (`flux-screen*`, the sensor's panel with sample readings, not a capture of
  the app).

## src/website/landingAnnotations.js (the home page's annotated plates)

- The Friday plan: `chat-dark-v3`, `budget-dark-v3`, `bill-split-dark-v3`.
- Safety: `sos-dark-v3`. Venues: `owner-dashboard-dark-v3`.
- Their callout boxes were measured as the frames were taken (the rig's
  anchors-v3.json).

## src/website/HowItWorksPage.js

- Steps: `create-dark-v3`, `vote-dark-v3`, `budget-dark-v3`, `sos-dark-v3`,
  `bill-split-dark-v3`. Venues: `venue-card-events-dark-v3`.
- Not one of these captures: the poster of the app's video at the top of the
  page (`public/how/video-poster-*`), a frame of the video. It and the video
  show the app's older screens on Google Maps photos of real places, so that
  page's footer credits them ("Venue photos in the video: Google Maps and its
  contributors."). The footer the other pages share carries no photo credit.

## public/manifest.json (PWA screenshots)

`nest-dark-v3@2x.png`, `create-dark-v3@2x.webp`, `chat-dark-v3@2x.webp`,
`bill-split-dark-v3@2x.webp`.

## Kept out

These files are left out of the iPhone app (the codemagic.yaml iOS workflows
remove `build/screenshots` before `cap sync`; the native shell never shows the
marketing pages) and out of the public copy of the repository, whose history
still holds the earlier captures that carried Google Maps photos.

## Not shipped

The rest of a run stays in the rig's scratch folder. Older captures that carry
no Places photo are kept, unshipped, in `frontend/screenshots/`.
