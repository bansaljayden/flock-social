/* The home page hero's reel: ten screens in the order a visitor should meet
   them, the crowd dial early because it is the one screen no other planning
   app has. HeroReel.js draws them.

   Every app screen is the web app's dark theme at 390 x 844, shipped at 2x
   (780 x 1688) with a 480px cut; the Flux screen is the sensor's own 1024 x
   600 panel, landscape, at 2x. The app screens are real interface on a seeded
   account in Old City, Philadelphia (2026-10-21): the five friends are made
   up, the places are real ones from Google Places, with their Google Maps
   photos, Birdie's answer is a live reply, and the crowd figures are the live
   model's. The venue-side screens elsewhere on the site keep the invented
   The Copper Finch, so no real business is shown with deals or reviews it
   never posted. The Flux readings are samples. `width` and `height` are the
   2x file's own.

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
    src: '/screenshots/nest-dark-v2@2x.webp',
    srcSet: '/screenshots/nest-dark-v2-480w.webp 480w, /screenshots/nest-dark-v2@2x.webp 780w',
    width: 780,
    height: 1688,
    alt: 'The Flock home screen: a tonight check-in, a Start a flock button, and the maintainer’s three plans, a cheesesteak run locked in at Sonny’s Famous Steaks and two still voting.',
    landscape: false,
  },
  {
    name: 'crowd-dial',
    src: '/screenshots/crowd-dial-dark-v2@2x.webp',
    srcSet: '/screenshots/crowd-dial-dark-v2-480w.webp 480w, /screenshots/crowd-dial-dark-v2@2x.webp 780w',
    width: 780,
    height: 1688,
    alt: 'Sonny’s Famous Steaks on Market Street: a crowd estimate of 78, usually busy, a five to ten minute wait, and the expected crowd by hour.',
    landscape: false,
  },
  {
    name: 'still-in',
    src: '/screenshots/still-in-dark-v2@2x.webp',
    srcSet: '/screenshots/still-in-dark-v2-480w.webp 480w, /screenshots/still-in-dark-v2@2x.webp 780w',
    width: 780,
    height: 1688,
    alt: 'The cheesesteak run on the night: locked in at Sonny’s Famous Steaks for 8 PM, with two of the three going already marked still in.',
    landscape: false,
  },
  {
    name: 'birdie-pick',
    src: '/screenshots/birdie-pick-dark-v2@2x.webp',
    srcSet: '/screenshots/birdie-pick-dark-v2-480w.webp 480w, /screenshots/birdie-pick-dark-v2@2x.webp 780w',
    width: 780,
    height: 1688,
    alt: 'Birdie asked for a cheap spot for five at about $15 each, answering with European Republic on Chestnut Street, open now.',
    landscape: false,
  },
  {
    name: 'map-crowd',
    src: '/screenshots/map-crowd-dark-v2@2x.webp',
    srcSet: '/screenshots/map-crowd-dark-v2-480w.webp 480w, /screenshots/map-crowd-dark-v2@2x.webp 780w',
    width: 780,
    height: 1688,
    alt: 'The Discover map over Old City, Philadelphia, with twenty places nearby and the crowd heat warmest over the busiest ones.',
    landscape: false,
  },
  {
    name: 'plans-tab',
    src: '/screenshots/plans-tab-dark-v2@2x.webp',
    srcSet: '/screenshots/plans-tab-dark-v2-480w.webp 480w, /screenshots/plans-tab-dark-v2@2x.webp 780w',
    width: 780,
    height: 1688,
    alt: 'The Plans tab: October’s calendar, tonight’s weather, and tonight’s cheesesteak run at Sonny’s Famous Steaks.',
    landscape: false,
  },
  {
    name: 'profile',
    src: '/screenshots/profile-dark-v2@2x.webp',
    srcSet: '/screenshots/profile-dark-v2-480w.webp 480w, /screenshots/profile-dark-v2@2x.webp 780w',
    width: 780,
    height: 1688,
    alt: 'the maintainer’s profile: four flocks, four friends and 92% reliable, with Add friends at the top.',
    landscape: false,
  },
  {
    name: 'messages',
    src: '/screenshots/messages-dark-v2@2x.webp',
    srcSet: '/screenshots/messages-dark-v2-480w.webp 480w, /screenshots/messages-dark-v2@2x.webp 780w',
    width: 780,
    height: 1688,
    alt: 'The Messages tab: a direct message from Asad and four flock chats, from tonight’s cheesesteak run to last Thursday’s dinner at Race Street Cafe.',
    landscape: false,
  },
  {
    name: 'bill-chat',
    src: '/screenshots/bill-chat-dark-v2@2x.webp',
    srcSet: '/screenshots/bill-chat-dark-v2-480w.webp 480w, /screenshots/bill-chat-dark-v2@2x.webp 780w',
    width: 780,
    height: 1688,
    alt: 'Thursday’s dinner chat at Race Street Cafe: Asad paid the $142.60 bill, three of five have settled up, and the rest owe $28.52 each.',
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
