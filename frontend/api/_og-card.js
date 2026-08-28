// The per-flock share image's pure half: query clamping and the element tree
// invite-og.js hands to Satori. Plain CommonJS with zero imports so the jest
// suite can require it directly (src/__tests__/inviteShareCard.test.js) while
// the edge bundler interops it into the ESM function.
//
// WHAT MAY APPEAR IN THIS IMAGE, AND WHY IT IS SAFE. The URL that reaches this
// module carries exactly three display fields: the plan name, the when label,
// and a going count. All three are ALREADY public to anyone who scrapes the
// invite link, because og:title and og:description say them in text; the image
// widens nothing. The invite TOKEN must never reach this module or its URL
// (invite-preview.js rule 3: an og:image URL outlives the page in crawler
// caches), and the test suite pins that the built URL is assembled from the
// card fields alone.
//
// Palette matches the landing page's navy and cream so the card reads as the
// brand in an iMessage thread. Satori supports a subset of CSS; everything
// here stays inside it (flex, absolute sizes, rgba, letterSpacing).

const CARD_W = 1200;
const CARD_H = 630;

const NAVY = '#0d2847';
const CREAM = '#f7f3e8';
const CREAM_DIM = 'rgba(247, 243, 232, 0.72)';
const RULE = 'rgba(247, 243, 232, 0.28)';

function cleanText(value, max) {
  if (typeof value !== 'string') return '';
  // Control characters and newlines have no business in a one-line label, and
  // stripping them here means a hostile flock name cannot reshape the card.
  const flat = value.replace(/[\u0000-\u001F\u007F]+/g, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max - 1).trimEnd() + '…' : flat;
}

/** Query object -> the three clamped display fields. */
function cardParams(query) {
  const q = query || {};
  const going = parseInt(q.g, 10);
  return {
    name: cleanText(q.n, 60) || 'A night out',
    when: cleanText(q.w, 44) || 'Time not set yet',
    going: Number.isInteger(going) && going > 0 ? Math.min(going, 999) : 0,
  };
}

function text(content, style) {
  return { type: 'div', props: { style, children: content } };
}

/** The 1200x630 element tree. Pure data in, pure structure out. */
function cardTree(params) {
  const metaBits = [params.when];
  if (params.going > 0) metaBits.push(`${params.going} going`);
  return {
    type: 'div',
    props: {
      style: {
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        backgroundColor: NAVY,
        padding: '72px 80px',
        fontFamily: 'sans-serif',
      },
      children: [
        text('FLOCK', {
          display: 'flex',
          fontSize: 30,
          fontWeight: 800,
          letterSpacing: 10,
          color: CREAM_DIM,
        }),
        {
          type: 'div',
          props: {
            style: { display: 'flex', flexDirection: 'column' },
            children: [
              text(params.name, {
                display: 'flex',
                fontSize: 84,
                fontWeight: 800,
                lineHeight: 1.06,
                letterSpacing: -2,
                color: CREAM,
              }),
              text(metaBits.join(' · '), {
                display: 'flex',
                marginTop: 26,
                fontSize: 36,
                fontWeight: 500,
                color: CREAM_DIM,
              }),
            ],
          },
        },
        {
          type: 'div',
          props: {
            style: {
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              borderTop: `2px solid ${RULE}`,
              paddingTop: 34,
            },
            children: [
              text("You're invited. Vote on where it lands.", {
                display: 'flex',
                fontSize: 30,
                fontWeight: 600,
                color: CREAM,
              }),
              text('No app needed', {
                display: 'flex',
                fontSize: 26,
                fontWeight: 500,
                color: CREAM_DIM,
              }),
            ],
          },
        },
      ],
    },
  };
}

module.exports = { cardParams, cardTree, cleanText, CARD_W, CARD_H };
