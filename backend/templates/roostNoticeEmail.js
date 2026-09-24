// ---------------------------------------------------------------------------
// The Roost notice: the one email a venue account from before Roost had a
// price gets, 30 days before anything can change for it (Terms 9.6,
// services/roostNotice.js). Rendering only.
//
// Every date in it is the one argument it is handed, `chargeNotBefore`, which
// is the same value services/roostNotice.js stores in
// venue_roost_notices.charge_not_before and the checkout enforces as the
// earliest first charge. So the date an owner reads is the date the product
// keeps. The prices are the ones Terms 9.6 publishes;
// __tests__/roostNotice.test.js pins that the two agree.
//
// DESIGN-STANDARD rules that bind here: no em dashes, no class words, no urgency,
// nothing claimed that the product does not do.
// ---------------------------------------------------------------------------
const { escapeHtml, baseWebUrl } = require('../services/emailService');

// Terms 9.6. Changing a price here without changing the Terms, and the 30
// days' notice the Terms promise, is how this email starts lying.
const ROOST_MONTHLY_USD = 99;
const ROOST_YEARLY_USD = 990;
const ROOST_TRIAL_DAYS = 14;

// "October 25, 2026", on the clock of the markets Flock runs in.
function longDate(value) {
  const d = value instanceof Date ? value : new Date(value);
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', month: 'long', day: 'numeric', year: 'numeric',
  }).format(d);
}

function lines({ businessName, chargeNotBefore }) {
  const date = longDate(chargeNotBefore);
  const name = businessName && String(businessName).trim() ? String(businessName).trim() : 'there';
  const web = baseWebUrl().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  return {
    date,
    greeting: `Hi ${name},`,
    paragraphs: [
      `From ${date}, Roost becomes a paid plan: $${ROOST_MONTHLY_USD} a month or $${ROOST_YEARLY_USD} a year per location, with a ${ROOST_TRIAL_DAYS}-day free trial. Roost is the forecast for your venue, the Roost cards and answers, the week view and the Monday digest.`,
      `Until ${date}, your venue keeps everything it has today and nothing is charged.`,
      'What stays free: your venue account, your listing, replying to reviews and the 0 to 100 busyness report.',
      `Nothing is charged unless you subscribe yourself on ${web}, and you can cancel there at any time. If you subscribe before ${date}, the first charge is no earlier than ${date}. The full terms are in section 9.6 at ${web}/terms.`,
      'Questions: reply to this email.',
    ],
    signoff: 'Flock Social LLC',
  };
}

function roostNoticeSubject({ chargeNotBefore }) {
  return `Roost, Flock's venue plan, starts on ${longDate(chargeNotBefore)}`;
}

function renderRoostNoticeText(input) {
  const l = lines(input);
  return [l.greeting, '', ...l.paragraphs.flatMap((p) => [p, '']), l.signoff].join('\n');
}

function renderRoostNoticeHtml(input) {
  const l = lines(input);
  const p = (text) => `<p style="font-size: 15px; color: #1a2b4a; line-height: 1.6; margin: 0 0 14px;">${escapeHtml(text)}</p>`;
  return [
    '<div style="max-width: 560px; margin: 0 auto; padding: 32px 24px; font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;">',
    p(l.greeting),
    ...l.paragraphs.map(p),
    p(l.signoff),
    '</div>',
  ].join('\n');
}

module.exports = {
  roostNoticeSubject,
  renderRoostNoticeText,
  renderRoostNoticeHtml,
  longDate,
  ROOST_MONTHLY_USD,
  ROOST_YEARLY_USD,
  ROOST_TRIAL_DAYS,
};
