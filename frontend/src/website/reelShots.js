/* The home page hero's reel: ten screens in the order a visitor should meet
   them, the crowd forecast early because it is the one screen no other
   planning app has. HeroReel.js draws them.

   Every app screen is the web app's dark theme at 390 x 844, shipped at 2x
   (780 x 1688) with a 480px cut; the Flux screen is the sensor's own 1024 x
   600 panel, landscape, at 2x. The app screens are the real interface on a
   seeded account, taken by scripts/capture-screenshots.mjs --story=site
   (2026-11-07): the five friends are seeded accounts with painted birds for
   pictures (two of the names, Jayden Bansal and Asad Ali, are the people who
   make Flock), and every place is invented, with a drawing for its picture,
   so no frame holds a Google Maps photo or a real business. The crowd figures
   and Birdie's answer were written for the capture and given to the app in
   the shapes its server answers with; the crowd forecast says what such a
   figure is, "An estimate from typical patterns for this kind of place." (see
   public/screenshots/WIRING.md). The Flux readings are samples. `width` and
   `height` are the 2x file's own.

   Every path is written out in full: publicScreenshotsShipped.test.js and the
   capture rig decide what ships by finding these names literally in source.
   (This file is reelShots.js, not heroReel.js: on Windows that would be the
   same file as the HeroReel.js component.)

   None of these screens appears anywhere else on the site: the chat, create,
   budget, bill and SOS captures belong to the home page's beats and How it
   works. */
export const REEL = [
  {
    name: 'nest',
    src: '/screenshots/nest-dark-v3@2x.webp',
    srcSet: '/screenshots/nest-dark-v3-480w.webp 480w, /screenshots/nest-dark-v3@2x.webp 780w',
    width: 780,
    height: 1688,
    alt: 'The Flock home screen: tonight’s trivia night at The Copper Finch, locked in for 9 PM, a budget and a vote that still need an answer, and two friends down for tonight.',
    landscape: false,
  },
  {
    name: 'crowd-dial',
    src: '/screenshots/crowd-dial-dark-v3@2x.webp',
    srcSet: '/screenshots/crowd-dial-dark-v3-480w.webp 480w, /screenshots/crowd-dial-dark-v3@2x.webp 780w',
    width: 780,
    height: 1688,
    alt: 'The Copper Finch’s card: usually busy at this hour, 78 on Flock’s crowd scale, a 20 to 35 minute wait, and the expected crowd for the next hours.',
    landscape: false,
  },
  {
    name: 'still-in',
    src: '/screenshots/still-in-dark-v3@2x.webp',
    srcSet: '/screenshots/still-in-dark-v3-480w.webp 480w, /screenshots/still-in-dark-v3@2x.webp 780w',
    width: 780,
    height: 1688,
    alt: 'Trivia Night on the night: locked in at The Copper Finch for 9 PM, with two of the three going already marked still in.',
    landscape: false,
  },
  {
    name: 'birdie-pick',
    src: '/screenshots/birdie-pick-dark-v3@2x.webp',
    srcSet: '/screenshots/birdie-pick-dark-v3-480w.webp 480w, /screenshots/birdie-pick-dark-v3@2x.webp 780w',
    width: 780,
    height: 1688,
    alt: 'Birdie, asked for somewhere cheaper than The Copper Finch for five, answering with Bluewing Diner, open now and usually not busy.',
    landscape: false,
  },
  {
    name: 'crowd-list',
    src: '/screenshots/crowd-list-dark-v3@2x.webp',
    srcSet: '/screenshots/crowd-list-dark-v3-480w.webp 480w, /screenshots/crowd-list-dark-v3@2x.webp 780w',
    width: 780,
    height: 1688,
    alt: 'Discover, searched for dinner: places nearby with their ratings, how far each is, and how busy each usually is at this hour.',
    landscape: false,
  },
  {
    name: 'plans-tab',
    src: '/screenshots/plans-tab-dark-v3@2x.webp',
    srcSet: '/screenshots/plans-tab-dark-v3-480w.webp 480w, /screenshots/plans-tab-dark-v3@2x.webp 780w',
    width: 780,
    height: 1688,
    alt: 'The Plans tab: November’s calendar, tonight’s weather, and Trivia Night at The Copper Finch at 9 PM.',
    landscape: false,
  },
  {
    name: 'profile',
    src: '/screenshots/profile-dark-v3@2x.webp',
    srcSet: '/screenshots/profile-dark-v3-480w.webp 480w, /screenshots/profile-dark-v3@2x.webp 780w',
    width: 780,
    height: 1688,
    alt: 'the maintainer’s profile: four flocks, four friends and 92% reliable, with Add friends at the top.',
    landscape: false,
  },
  {
    name: 'messages',
    src: '/screenshots/messages-dark-v3@2x.webp',
    srcSet: '/screenshots/messages-dark-v3-480w.webp 480w, /screenshots/messages-dark-v3@2x.webp 780w',
    width: 780,
    height: 1688,
    alt: 'The Messages tab: a direct message from Asad and four flock chats, from the Friday Night Crew vote to last Thursday’s dinner at Kestrel Pizza Co.',
    landscape: false,
  },
  {
    name: 'bill-chat',
    src: '/screenshots/bill-chat-dark-v3@2x.webp',
    srcSet: '/screenshots/bill-chat-dark-v3-480w.webp 480w, /screenshots/bill-chat-dark-v3@2x.webp 780w',
    width: 780,
    height: 1688,
    alt: 'Thursday’s dinner chat at Kestrel Pizza Co.: Asad paid the $142.60 bill, three of five have settled up, and the rest owe $28.52 each.',
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
