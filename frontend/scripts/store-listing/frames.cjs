// The listing, in order. Crops are [x, y, w, h] in the 1290 x 2796 masters.
// Backgrounds alternate cream and navy, the website's rule that no two
// neighbours share one: a dark screen on cream, a light screen on navy.
// The phone's top edge sits at y 860; each bird scene perches on it.
module.exports = [
  {
    id: '01-nest', theme: 'cream', screen: 'nest-dark',
    h1: 'Get your friends out <mark>tonight</mark>',
    sub: "See who's free and make the plan together.",
    art: [{ src: 'step-go-960', x: 470, y: 505, w: 720 }],
    callouts: [{ crop: [60, 222, 1172, 484], scale: 0.93, dy: -14 }],
  },
  {
    id: '02-crowd', theme: 'navy', screen: 'crowd-dial-light',
    h1: 'Know how busy it is before you go',
    sub: 'See the quiet hours before you pick a place.',
    art: [{ src: 'crowd-busy-960', x: 380, y: 615, w: 820 }],
    callouts: [{ crop: [62, 1125, 1168, 300], scale: 0.95 }],
  },
  {
    id: '03-vote', theme: 'cream', screen: 'chat-dark',
    h1: 'Vote on where to go',
    sub: 'The group picks, and one tap locks it in.',
    art: [{ src: 'step-vote-480', x: 780, y: 627, w: 420 }],
    callouts: [{ crop: [58, 1350, 1180, 640], scale: 0.92 }],
  },
  {
    id: '04-birdie', theme: 'navy', screen: 'birdie-pick-light',
    h1: 'Ask Birdie for a spot',
    sub: 'Birdie suggests places that fit your group.',
    art: [{ src: 'spot-wren-perch-480', x: 890, y: 566, w: 300 }],
    callouts: [{ crop: [40, 250, 1210, 290], scale: 0.92 }],
  },
  {
    id: '05-create', theme: 'cream', screen: 'create-dark',
    h1: 'Start a plan in a minute',
    sub: 'Pick a night and invite your friends.',
    art: [{ src: 'step-start-480', x: 760, y: 657, w: 460 }],
    callouts: [{ crop: [40, 1265, 1210, 330], scale: 0.92 }],
  },
  {
    id: '06-still-in', theme: 'navy', screen: 'still-in-light',
    h1: "See who's <mark>still in</mark>",
    sub: "Know who's coming before you head out.",
    art: [{ src: 'events-960', x: 400, y: 510, w: 820 }],
    callouts: [{ crop: [40, 1430, 1210, 555], scale: 0.92 }],
  },
  {
    id: '07-budget', theme: 'cream', screen: 'chat-dark',
    h1: 'Budgets stay private',
    sub: 'The group sees one range. Nobody sees yours.',
    art: [{ src: 'step-budget-480', x: 780, y: 654, w: 440 }],
    callouts: [{ screen: 'budget-dark', crop: [40, 1325, 1210, 720], scale: 0.9, at: [100, 1640] }],
  },
  {
    id: '08-bill', theme: 'navy', screen: 'bill-chat-light',
    h1: 'Split the bill in seconds',
    sub: 'Everyone sees what they owe.',
    art: [{ src: 'spot-hop-480', x: 890, y: 612, w: 300 }],
    callouts: [{ screen: 'bill-split-light', crop: [40, 1440, 1210, 1175], scale: 0.82, at: [149, 1450] }],
  },
  {
    id: '09-safety', theme: 'cream', screen: 'plans-tab-dark',
    h1: 'Help is one tap away',
    sub: 'Alert your trusted contacts with your location.',
    art: [{ src: 'safety-720', x: 700, y: 483, w: 520 }],
    callouts: [{ screen: 'sos-dark', crop: [40, 1570, 1210, 660], scale: 0.9, at: [100, 1760] }],
  },
  {
    id: '10-venues', theme: 'navy', screen: 'owner-dashboard-light',
    h1: "Run a venue? See who's coming",
    sub: 'Flocks that have you in their vote show up on your dashboard.',
    art: [{ src: 'venues-720', x: 760, y: 542, w: 470 }],
    callouts: [{ crop: [40, 850, 1210, 650], scale: 0.9 }],
  },
];
