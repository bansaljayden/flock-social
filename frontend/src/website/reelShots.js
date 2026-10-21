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
   same file as the HeroReel.js component.)

   Since the same day's second pass none of these screens appears anywhere
   else on the site (the maintainer: "unique pictures like they aren't used anywhere
   else"): the still-in roster, Plans, the profile, Messages and Live Events
   replaced the chat, create, budget, bill and SOS captures, which the home
   page's beats and How it works still show. Live Events are invented, with
   drawn pictures, not Ticketmaster's. */
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
    name: 'still-in',
    src: '/screenshots/still-in-dark@2x.webp',
    srcSet: '/screenshots/still-in-dark-480w.webp 480w, /screenshots/still-in-dark@2x.webp 780w',
    width: 780,
    height: 1688,
    alt: 'Trivia Night on the night: locked in at The Copper Finch for 10 PM, with two of the three going already marked still in.',
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
    name: 'plans-tab',
    src: '/screenshots/plans-tab-dark@2x.webp',
    srcSet: '/screenshots/plans-tab-dark-480w.webp 480w, /screenshots/plans-tab-dark@2x.webp 780w',
    width: 780,
    height: 1688,
    alt: 'The Plans tab: October’s calendar with tonight’s Trivia Night, and the plans coming up after it.',
    landscape: false,
  },
  {
    name: 'profile',
    src: '/screenshots/profile-dark@2x.webp',
    srcSet: '/screenshots/profile-dark-480w.webp 480w, /screenshots/profile-dark@2x.webp 780w',
    width: 780,
    height: 1688,
    alt: 'the maintainer’s profile: four flocks, four friends and 92% reliable, with Add friends at the top.',
    landscape: false,
  },
  {
    name: 'messages',
    src: '/screenshots/messages-dark@2x.webp',
    srcSet: '/screenshots/messages-dark-480w.webp 480w, /screenshots/messages-dark@2x.webp 780w',
    width: 780,
    height: 1688,
    alt: 'The Messages tab: a direct message from Asad and four flock chats, two of them still voting.',
    landscape: false,
  },
  {
    name: 'events',
    src: '/screenshots/events-dark@2x.webp',
    srcSet: '/screenshots/events-dark-480w.webp 480w, /screenshots/events-dark@2x.webp 780w',
    width: 780,
    height: 1688,
    alt: 'Live Events this week nearby: an acoustic set, a night market and a sushi class, each with a Start Flock button.',
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
