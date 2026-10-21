/* The notes on the home page's annotated captures (AnnotatedShot.js).

   Every box was measured on its 780 x 1688 capture (2026-10-21): the pixels
   that differ from the element's own background, boxed, in percent of the
   capture's width and height. A note marks its target from OUTSIDE it, so the
   marker never covers what it names:
     kind 'text'  the leader ends in a small dot just past the text's edge;
     kind 'box'   a whole button, chip, field or list gets a thin outline,
                  and the leader meets the outline's edge.
   On a phone the number sits at `dot`, beside the element, and must clear
   every box in `avoid` (the characters around it); annotatedShot.test.js
   holds both to that at the narrowest phone this page supports.
   `y` moves a note's label off its target's line when two labels on one side
   would otherwise sit too close; the leader then bends in the gap beside the
   phone, never across the screen. */

export const ANNOTATIONS = {
  vote: {
    layout: 'center',
    shot: {
      src: '/screenshots/chat-dark@2x.webp',
      srcSet: '/screenshots/chat-dark-480w.webp 480w, /screenshots/chat-dark@2x.webp 780w',
      alt: 'The Friday Night Crew chat: a vote on three places with The Copper Finch ahead, and four of five budgets in.',
    },
    caption: 'The Friday Night Crew chat.',
    notes: [
      { side: 'right', text: 'The Copper Finch, pinned', kind: 'text', box: [43.97, 8.0, 52.95, 9.06], dot: [58, 8.53] },
      { side: 'left', text: '4 of 5 budgets in', kind: 'text', box: [4.23, 12.09, 60.26, 13.63], dot: [65.3, 12.86] },
      { side: 'right', text: 'Votes, counted live', kind: 'text', box: [86.92, 61.43, 88.72, 62.56], dot: [81.9, 62] },
      { side: 'left', text: '5 of 5 voted', kind: 'text', box: [8.46, 78.14, 24.87, 79.21], dot: [29.9, 78.68] },
    ],
  },
  budget: {
    layout: 'center',
    shot: {
      src: '/screenshots/budget-dark@2x.webp',
      srcSet: '/screenshots/budget-dark-480w.webp 480w, /screenshots/budget-dark@2x.webp 780w',
      alt: 'The budget sheet: preset amounts, a custom $35, and a note that no one else sees the answer.',
    },
    caption: 'the maintainer’s budget sheet.',
    notes: [
      {
        side: 'left', text: 'Pick a preset or type your own', kind: 'box', box: [5.13, 52.13, 26.15, 57.88], y: 52,
        dot: [24.5, 49.6], avoid: [[12.31, 54.09, 18.72, 55.81], [5.26, 48.87, 19.36, 49.94]],
      },
      {
        side: 'left', text: 'Nobody else sees your $35', kind: 'box', box: [5.13, 62.09, 94.87, 68.72], y: 67,
        dot: [26, 65.4], avoid: [[8.21, 64.51, 17.44, 66.23]],
      },
      {
        side: 'right', text: 'One rounded number for the group', kind: 'text', box: [9.74, 70.91, 93.97, 72.3],
        dot: [4.6, 77], avoid: [[9.74, 70.91, 93.97, 82.88], [5.64, 70.73, 7.82, 71.92]],
      },
      {
        side: 'right', text: 'Skip if any budget works', kind: 'box', box: [5.13, 92.3, 94.87, 97.69], y: 92,
        dot: [80, 95], avoid: [[32.56, 94.37, 67.44, 95.85]],
      },
    ],
  },
  bill: {
    layout: 'center',
    shot: {
      src: '/screenshots/bill-split-dark@2x.webp',
      srcSet: '/screenshots/bill-split-dark-480w.webp 480w, /screenshots/bill-split-dark@2x.webp 780w',
      alt: 'Split the Bill: $142.60 with an 18% tip, paid by Asad Ali, $28.52 each for five people.',
    },
    caption: 'Split the Bill, after two paid back.',
    notes: [
      {
        side: 'left', text: 'Total: $142.60, paid by Asad', kind: 'text', box: [8.72, 55.51, 30.51, 60.13],
        dot: [35.5, 55.9], avoid: [[8.72, 55.51, 29.87, 56.93], [8.72, 58.4, 30.51, 60.13]],
      },
      { side: 'right', text: 'Tip included', kind: 'text', box: [69.1, 55.63, 91.28, 56.93], dot: [64.1, 56.28] },
      {
        side: 'right', text: 'Who’s paid back, who still owes', kind: 'box', box: [5.13, 63.3, 94.87, 81.8],
        dot: [50, 72.3], avoid: [[8.85, 71.98, 27.56, 73.16], [75.51, 71.68, 90.77, 73.28]],
      },
      {
        side: 'left', text: 'Pay by Venmo, Cash App or Zelle', kind: 'box', box: [5.13, 85.78, 94.87, 91.94],
        dot: [22, 88.9], avoid: [[33.97, 88.03, 65.9, 89.81]],
      },
    ],
  },
  sos: {
    layout: 'left',
    shot: {
      src: '/screenshots/sos-dark@2x.webp',
      srcSet: '/screenshots/sos-dark-480w.webp 480w, /screenshots/sos-dark@2x.webp 780w',
      alt: 'The SOS sheet: Call 911 first, then Alert Contacts for two trusted contacts, Share Location, and Cancel.',
    },
    caption: 'The second tap sends it.',
    notes: [
      {
        side: 'left', text: 'Call 911 comes first', kind: 'box', box: [5.13, 67.12, 95.0, 73.87], y: 66,
        dot: [22, 70.5], avoid: [[39.36, 69.43, 61.28, 71.45]],
      },
      {
        side: 'left', text: 'Alert Contacts emails your two contacts', kind: 'box', box: [5.13, 78.2, 94.87, 84.36], y: 80,
        dot: [22, 81.3], avoid: [[33.59, 80.45, 66.92, 82.17]],
      },
      {
        side: 'left', text: 'Share Location emails just where you are', kind: 'box', box: [5.13, 85.55, 95.0, 91.71], y: 94,
        dot: [22, 88.6], avoid: [[33.72, 87.86, 67.05, 89.4]],
      },
    ],
  },
  venue: {
    layout: 'right',
    shot: {
      src: '/screenshots/owner-dashboard-dark@2x.webp',
      srcSet: '/screenshots/owner-dashboard-dark-480w.webp 480w, /screenshots/owner-dashboard-dark@2x.webp 780w',
      alt: 'The Copper Finch’s venue dashboard: the flocks with it in their vote, and the events showing on its verified card.',
    },
    caption: 'A venue owner’s dashboard.',
    notes: [
      {
        side: 'right', text: 'Add events, shown once verified', kind: 'box', box: [3.08, 23.1, 96.92, 29.38], y: 21,
        dot: [80, 26.2], avoid: [[35.9, 25.36, 64.62, 27.01]],
      },
      { side: 'right', text: 'Flocks with you in their vote', kind: 'text', box: [6.41, 32.7, 51.67, 33.95], y: 37, dot: [57, 33.33] },
    ],
  },
};
