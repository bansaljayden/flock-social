/* The home page hero's reel (2026-10-21): ten screens in the order a visitor
   should meet them, the crowd dial early because it is the one screen no
   other planning app has. HeroReel.js draws them.

   Every app screen is the web app's dark theme at 390 x 844, shipped at 2x
   (780 x 1688) with a 480px cut; the Flux screen is the sensor's own 1024 x
   600 panel, landscape, at 2x. All of it is real interface over invented
   data: the five friends, The Copper Finch and its neighbours are made up,
   every venue picture is a drawing (scripts/shot-art.mjs), Birdie's answer
   and the map's crowd scores are written into the capture rig rather than
   asked of Gemini or Google, and the Flux readings are samples.
   `width` and `height` are the 2x file's own.

   Every path is written out in full: publicScreenshotsShipped.test.js and the
   capture rig decide what ships by finding these names literally in source.
   (This file is reelShots.js, not heroReel.js: on Windows that would be the
   same file as the HeroReel.js component.) */
export const REEL = [
  {
    name: 'nest',
    src: '/screenshots/nest-dark@2x.webp',
    srcSet: '/screenshots/nest-dark-480w.webp 480w, /screenshots/nest-dark@2x.webp 780w',
    width: 780,
    height: 1688,
    alt: 'The Flock home screen: a tonight check-in, a Start a flock button, and the maintainer’s three plans, with Trivia Night locked in and two still voting.',
    landscape: false,
  },
  {
    name: 'crowd-dial',
    src: '/screenshots/crowd-dial-dark@2x.webp',
    srcSet: '/screenshots/crowd-dial-dark-480w.webp 480w, /screenshots/crowd-dial-dark@2x.webp 780w',
    width: 780,
    height: 1688,
    alt: 'The Copper Finch’s card: a crowd dial reading 63, Steady, and the expected crowd by hour rising to an 8 PM peak.',
    landscape: false,
  },
  {
    name: 'chat',
    src: '/screenshots/chat-dark@2x.webp',
    srcSet: '/screenshots/chat-dark-480w.webp 480w, /screenshots/chat-dark@2x.webp 780w',
    width: 780,
    height: 1688,
    alt: 'The Friday Night Crew chat: The Copper Finch is pinned and leads the vote, and four of five budgets are in.',
    landscape: false,
  },
  {
    name: 'birdie-pick',
    src: '/screenshots/birdie-pick-dark@2x.webp',
    srcSet: '/screenshots/birdie-pick-dark-480w.webp 480w, /screenshots/birdie-pick-dark@2x.webp 780w',
    width: 780,
    height: 1688,
    alt: 'Birdie asked for somewhere cheaper than The Copper Finch for five, answering with Marigold Diner, which is not busy right now.',
    landscape: false,
  },
  {
    name: 'map-crowd',
    src: '/screenshots/map-crowd-dark@2x.webp',
    srcSet: '/screenshots/map-crowd-dark-480w.webp 480w, /screenshots/map-crowd-dark@2x.webp 780w',
    width: 780,
    height: 1688,
    alt: 'The Discover map with eleven places nearby, the crowd heat warmest over the busiest ones.',
    landscape: false,
  },
  {
    name: 'create',
    src: '/screenshots/create-dark@2x.webp',
    srcSet: '/screenshots/create-dark-480w.webp 480w, /screenshots/create-dark@2x.webp 780w',
    width: 780,
    height: 1688,
    alt: 'Starting a flock for tomorrow at 8 PM, with Asad, Nick and Kaitlyn invited.',
    landscape: false,
  },
  {
    name: 'budget',
    src: '/screenshots/budget-dark@2x.webp',
    srcSet: '/screenshots/budget-dark-480w.webp 480w, /screenshots/budget-dark@2x.webp 780w',
    width: 780,
    height: 1688,
    alt: 'The private budget sheet: pick an amount or type your own, and nobody else sees the answer.',
    landscape: false,
  },
  {
    name: 'bill-split',
    src: '/screenshots/bill-split-dark@2x.webp',
    srcSet: '/screenshots/bill-split-dark-480w.webp 480w, /screenshots/bill-split-dark@2x.webp 780w',
    width: 780,
    height: 1688,
    alt: 'Split the Bill: $142.60 with the tip, paid by Asad, comes to $28.52 each, with who has paid back.',
    landscape: false,
  },
  {
    name: 'sos',
    src: '/screenshots/sos-dark@2x.webp',
    srcSet: '/screenshots/sos-dark-480w.webp 480w, /screenshots/sos-dark@2x.webp 780w',
    width: 780,
    height: 1688,
    alt: 'The SOS sheet: Call 911 comes first, then alerting two trusted contacts or sharing your location.',
    landscape: false,
  },
  {
    name: 'flux-screen',
    src: '/screenshots/flux-screen@2x.webp',
    srcSet: '/screenshots/flux-screen-800w.webp 800w, /screenshots/flux-screen@2x.webp 2048w',
    width: 2048,
    height: 1200,
    alt: 'The Flux sensor’s own screen with sample readings: 7 people through the door, 23 in view of the heat camera, and a moderate noise level.',
    landscape: true,
  },
];
