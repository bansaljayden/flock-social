// ---------------------------------------------------------------------------
// The acknowledgment a web buyer of Flock Pro gets once the checkout completes
// (services/proAcknowledgment.js). Rendering only.
//
// California's automatic renewal law asks for this in a form the buyer can
// keep: what renews, at what price and how often, how to cancel, and the
// refund window. The sentences say the same things as the text above Stripe's
// Pay button (services/proBilling.js submitText) and Terms 10.2, so the three
// cannot tell a buyer three different stories.
//
// DESIGN-STANDARD rules that bind here: no em dashes, no class words, no urgency,
// nothing claimed that the product does not do.
// ---------------------------------------------------------------------------
const { escapeHtml, baseWebUrl } = require('../services/emailService');

const CONTACT_EMAIL = 'social@flockcorp.com';
const SELLER = 'Flock Social LLC, 2610 Long Ridge Dr, Hellertown, PA 18055';

function lines({ name, plan, amount, every, tax, paidToday }) {
  const web = baseWebUrl().replace(/\/+$/, '');
  const who = name && String(name).trim() ? String(name).trim().split(/\s+/)[0] : '';
  const planWord = plan === 'yearly' ? 'yearly' : 'monthly';
  const plus = tax ? ' plus tax' : '';
  const paragraphs = [
    'You have Flock Pro. This email is your record of what you agreed to.',
    `Plan: Flock Pro, ${planWord}, ${amount}${plus} a ${every}.`,
  ];
  if (paidToday) paragraphs.push(`Paid today: ${paidToday}.`);
  paragraphs.push(
    `It renews every ${every} at ${amount}${plus} until you cancel, or at the lower price a code gives while it applies. There is no minimum term.`,
    `To cancel, sign in to Flock at ${web}/app, then You, then Flock Pro, then Cancel subscription. You keep Pro until the ${every} you paid for ends. You can also write to ${CONTACT_EMAIL} and we will cancel it for you.`,
    `Changed your mind? Write to ${CONTACT_EMAIL} within 14 days of your first payment for a full refund.`,
  );
  paragraphs.push(`Sold by ${SELLER}. The terms are at ${web}/terms.`);
  return { greeting: who ? `Hi ${who},` : 'Hi,', paragraphs, signoff: 'Flock Social LLC' };
}

function proPurchaseSubject() {
  return 'You have Flock Pro: your plan and how to cancel';
}

function renderProPurchaseText(input) {
  const l = lines(input);
  return [l.greeting, '', ...l.paragraphs.flatMap((p) => [p, '']), l.signoff].join('\n');
}

function renderProPurchaseHtml(input) {
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
  proPurchaseSubject,
  renderProPurchaseText,
  renderProPurchaseHtml,
};
