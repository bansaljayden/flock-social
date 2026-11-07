/* The notes on the home page's annotated captures (AnnotatedShot.js).

   Every box was measured on its 780 x 1688 capture as the capture was taken
   (scripts/capture-screenshots.mjs --story=site, 2026-11-07, its
   anchors-v3.json): a button, chip or field is its own box from the page, and
   text and icons are the box of their own pixels in the frame, in percent of
   the capture's width and height. A pixel re-measure of the shipped @2x files
   agrees with every box to within 0.34 of a point. A note marks its target
   from OUTSIDE it, so the marker never covers what it names:
     kind 'text'  the leader ends in a small dot just past the text's edge;
     kind 'box'   a whole button, chip, field or list gets a thin outline,
                  and the leader meets the outline's edge.
   On a phone the number sits at `dot`, beside the element, and must clear
   every box in `avoid` (the lines of text around it); annotatedShot.test.js
   holds both to that at the narrowest phone this page supports, and each
   `dot` was placed where it covers no line of text in the frame at all.
   `y` moves a note's label off its target's line when two labels on one side
   would otherwise sit too close; the leader then bends in the gap beside the
   phone, never across the screen.
   The three Friday beats keep every note on the phone's far side from their
   words, so the words and the notes never compete for one side; their
   layouts are one-sided and the sides follow the beat: words left, notes right
   on the vote; words right, notes left on the budget and the bill. */

export const ANNOTATIONS = {
  vote: {
    layout: 'right',
    shot: {
      src: '/screenshots/chat-dark-v3@2x.webp',
      srcSet: '/screenshots/chat-dark-v3-480w.webp 480w, /screenshots/chat-dark-v3@2x.webp 780w',
      alt: 'The Friday Night Crew chat: a vote on three places with The Copper Finch ahead, and four of five budgets in.',
    },
    // No caption: the beat's words already name it.
    notes: [
      // The pinned row ends in the app’s Google Maps credit, so the dot sits after it.
      {
        side: 'right', text: 'The Copper Finch, pinned', kind: 'text', box: [10.77, 7.82, 72.69, 9.54], y: 4.5,
        dot: [78, 8.68], avoid: [[10.77, 7.82, 72.69, 9.54], [54.62, 7.56, 72.78, 9.45], [59.95, 3.77, 68.33, 5.66]],
      },
      {
        side: 'right', text: '4 of 5 budgets in', kind: 'text', box: [8.46, 12.26, 60.26, 13.63], y: 16,
        dot: [65.5, 12.95], avoid: [[8.46, 11.82, 60.42, 13.72], [8.46, 12.26, 60.26, 13.63], [54.62, 7.56, 72.78, 9.45]],
      },
      // The leader’s Lock it in, the host’s to tap once the vote is decided.
      {
        side: 'right', text: 'the maintainer locks it in when it’s decided', kind: 'box', box: [71.11, 57.22, 88.72, 60.54],
        dot: [80, 54.4], avoid: [[38.05, 59, 78.1, 60.9], [73.67, 57.93, 86.15, 59.83]],
      },
      {
        side: 'right', text: '5 of 5 voted', kind: 'text', box: [8.46, 75.06, 24.87, 76.13],
        dot: [30, 75.59], avoid: [[8.46, 74.64, 24.96, 76.54], [8.46, 75.06, 24.87, 76.13], [11.79, 69.61, 33.01, 71.74]],
      },
    ],
  },
  budget: {
    layout: 'left',
    shot: {
      src: '/screenshots/budget-dark-v3@2x.webp',
      srcSet: '/screenshots/budget-dark-v3-480w.webp 480w, /screenshots/budget-dark-v3@2x.webp 780w',
      alt: 'The budget sheet: preset amounts, a custom $35, and a note that no one else sees the answer.',
    },
    caption: 'the maintainer’s budget sheet.',
    notes: [
      {
        side: 'left', text: 'Pick a preset or type your own', kind: 'box', box: [5.13, 52.07, 26.03, 57.82], y: 50,
        dot: [24.5, 49.6], avoid: [[5.13, 45.26, 54.09, 47.63], [10.6, 48.4, 19.38, 50.3], [12.34, 53.73, 14.5, 56.1], [14.5, 53.73, 18.81, 56.1]],
      },
      {
        side: 'left', text: 'Nobody else sees your $35', kind: 'box', box: [5.13, 62.09, 94.87, 68.72], y: 62,
        dot: [26, 65.4], avoid: [[5.13, 59.36, 41.33, 61.26], [8.21, 64.19, 10.36, 66.56]],
      },
      {
        side: 'left', text: 'One rounded number for the group', kind: 'text', box: [9.74, 70.91, 86.79, 72.22], y: 75,
        dot: [4.6, 77], avoid: [[9.74, 70.5, 86.83, 72.39], [9.74, 70.91, 86.79, 72.22], [9.74, 72.63, 92.65, 74.53], [9.74, 74.76, 93.99, 76.66], [9.74, 76.9, 89.7, 78.79], [9.74, 79.03, 91.14, 80.92], [9.74, 81.16, 39.32, 83.06]],
      },
      {
        side: 'left', text: 'Skip if any budget works', kind: 'box', box: [5.13, 92.24, 94.87, 97.63], y: 92,
        dot: [80, 95], avoid: [[32.56, 93.9, 67.44, 95.91]],
      },
    ],
  },
  bill: {
    layout: 'left',
    shot: {
      src: '/screenshots/bill-split-dark-v3@2x.webp',
      srcSet: '/screenshots/bill-split-dark-v3-480w.webp 480w, /screenshots/bill-split-dark-v3@2x.webp 780w',
      alt: 'Split the Bill: $142.60 with an 18% tip, paid by Asad Ali, $28.52 each for five people.',
    },
    caption: 'Split the Bill, after two paid back.',
    notes: [
      // The tip has no note of its own: "includes 18% tip" sits right of the total,
      // so a leader from the left would have crossed $142.60 to reach it.
      {
        side: 'left', text: '$142.60 with the tip, paid by Asad', kind: 'text', box: [8.72, 55.51, 30.51, 60.13], y: 56,
        dot: [35.8, 57.82], avoid: [[8.72, 55.15, 29.85, 57.17], [8.72, 55.51, 30.51, 60.13], [8.72, 58.41, 30.62, 60.31]],
      },
      {
        side: 'left', text: 'Who’s paid back, who still owes', kind: 'box', box: [8.72, 63.8, 91.28, 81.4], y: 70,
        dot: [50, 72.3], avoid: [[75.5, 71.5, 85.64, 73.52]],
      },
      {
        side: 'left', text: 'Pay by Venmo, Cash App or Zelle', kind: 'box', box: [5.13, 85.72, 94.87, 91.94], y: 86,
        dot: [22, 88.9], avoid: [[33.89, 87.62, 50.51, 89.99]],
      },
    ],
  },
  sos: {
    layout: 'left',
    shot: {
      src: '/screenshots/sos-dark-v3@2x.webp',
      srcSet: '/screenshots/sos-dark-v3-480w.webp 480w, /screenshots/sos-dark-v3@2x.webp 780w',
      alt: 'The SOS sheet: Call 911 first, then Alert Contacts for two trusted contacts, Share Location, and Cancel.',
    },
    caption: 'The second tap sends it.',
    notes: [
      {
        side: 'left', text: 'Call 911 comes first', kind: 'box', box: [5.13, 67.2, 94.87, 73.84], y: 66,
        dot: [22, 70.5], avoid: [[14.5, 74.79, 85.5, 76.68], [45.41, 69.19, 61.77, 71.8]],
      },
      {
        side: 'left', text: 'Alert Contacts emails your two contacts', kind: 'box', box: [5.13, 78.2, 94.87, 84.36], y: 80,
        dot: [22, 81.3], avoid: [[14.5, 74.79, 85.5, 76.68], [39.68, 80.02, 66.99, 82.51]],
      },
      {
        side: 'left', text: 'Share Location emails just where you are', kind: 'box', box: [5.13, 85.55, 94.87, 91.71], y: 94,
        dot: [22, 88.6], avoid: [[39.52, 87.37, 67.15, 89.86]],
      },
    ],
  },
  venue: {
    layout: 'right',
    shot: {
      src: '/screenshots/owner-dashboard-dark-v3@2x.webp',
      srcSet: '/screenshots/owner-dashboard-dark-v3-480w.webp 480w, /screenshots/owner-dashboard-dark-v3@2x.webp 780w',
      alt: 'The Copper Finch’s venue dashboard: the flocks with it in their vote, and the events showing on its verified card.',
    },
    // No caption: the section's heading already names it.
    notes: [
      {
        side: 'right', text: 'Add events, shown once verified', kind: 'box', box: [3.08, 25.24, 96.92, 31.46], y: 23,
        dot: [80, 28.35], avoid: [[42.04, 27.13, 64.62, 29.5]],
      },
      {
        side: 'right', text: 'Flocks with you in their vote', kind: 'text', box: [11.41, 34.89, 51.67, 35.96], y: 39,
        dot: [56.8, 35.1], avoid: [[6.15, 37.03, 88.19, 38.92], [11.28, 34.42, 51.73, 36.32], [11.41, 34.89, 51.67, 35.96]],
      },
      // The two status chips, Confirmed and Considering you, boxed together.
      {
        side: 'right', text: 'Confirmed, or still deciding', kind: 'box', box: [64.8, 44.46, 91.28, 55.78],
        dot: [59.6, 50.12], avoid: [[66.85, 53.29, 89.23, 55.18]],
      },
      // The pencil and the bin on the first event.
      {
        side: 'right', text: 'Edit or remove an event', kind: 'box', box: [78.33, 73.58, 89.49, 74.94],
        dot: [73.2, 74.26], avoid: [[6.15, 67.95, 86.57, 69.85]],
      },
    ],
  },
};
