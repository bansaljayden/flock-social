// ---------------------------------------------------------------------------
// Monday venue digest: the email rendering, and nothing else.
//
// This file turns the advisor card stack (services/advisorFacts.js, the same
// four cards the advisor cards route serves) into one plain email, HTML and
// text. It is deliberately a renderer with no opinions of its own: every
// figure in the output comes out of a fact object built by the fact engine,
// because the fabricated Pro Tips box deleted from this dashboard on
// 2026-08-14 is what a renderer that composes its own numbers turns into.
// __tests__/venueDigest.test.js pins that no digit appears in a rendered
// digest that is absent from the fact fixtures.
//
// Shape (the "night audit"): a recap of last week from the owner's own
// numbers, at most ONE anomaly block when a card's gate fired (hedged,
// benchmarked wording is the fact engine's job; this file only decides
// placement), then the next seven days (events, weather, projected peaks).
// Five-ish lines a section. A quiet week reads "quiet week". No urgency, no
// upsell, per the digest rules in ADVISOR-PRODUCT-SHAPE.md section 4.
//
// SLOP-AUDIT rules that bind here: no em dashes anywhere in the output, no
// class words, nothing claimed that a route does not serve, every number
// carries its source and date.
// ---------------------------------------------------------------------------
const { escapeHtml } = require('../services/emailService');

// Which card goes where in the audit. RECAP looks backward (the owner's own
// readings against what Flock published, the intake read-back), HEADS_UP looks
// forward (events and weather near the venue, projected peaks). A card id this
// file has never met renders in the recap, in the order the fact engine sent
// it, rather than being dropped on the floor. Ids are the ones
// routes/advisor.js serves and __tests__/advisorCards.test.js pins.
const HEADS_UP_CARD_IDS = ['around_you', 'week_ahead'];
const RECAP_CARD_IDS = ['last_night_verdict', 'readings_vs_estimates', 'listing_read_back'];

// The block that opens the email, whatever else is in the stack.
//
// This email used to open on whatever the fact engine sent first, which in
// practice was the week ahead: a forecast. Operator telemetry across 125,000+
// locations puts explicit forecasting at one percent of prompts and the daily
// recap at the top (ROOST-OWNER-INPUT.md), so the first thing an owner reads on
// a Monday morning is the verdict on the day that just closed, against their
// own numbers. Pinned here rather than left to arrival order, and excluded
// from the anomaly slot below so nothing can relocate it.
const LEAD_CARD_ID = 'last_night_verdict';

// Premium's digest is the events heads-up alone (PRO-VS-PREMIUM.md: Premium is
// presence, Pro is foresight; the event radar card is the one T0 card on the
// Premium row). Pro gets the full stack.
const PREMIUM_CARD_IDS = ['around_you'];

// An email renders only cards that carry something to read: 'locked' cards
// are dropped (an upsell row in a digest is the dark pattern the product
// shape bans), and 'refused' cards are dropped too. The dashboard is where a
// refusal-with-a-path earns its screen; a weekly email restating what Flock
// cannot say is nagware.
function cardsForTier(cards, tier) {
  const list = Array.isArray(cards)
    ? cards.filter((c) => c && Array.isArray(c.facts) && c.status !== 'locked' && c.status !== 'refused')
    : [];
  if (tier === 'pro') return list;
  if (tier === 'premium') return list.filter((c) => PREMIUM_CARD_IDS.includes(c.id));
  return [];
}

// The one anomaly slot. Two gates exist in the T0 fact set, both computed by
// the fact engine and shipped as structured values (never recomputed here):
// the projected peak landing at or after last orders (kitchen_vs_peak), and
// the owner's busy nights not lining up with the venue's own Google curve
// (busy_nights_agreement with no shared nights). The FIRST card carrying a
// firing gate moves into its own "Worth a look" block; every later one stays
// a plain line, because a digest with three alarms is a digest with none.
// The wording stays the fact engine's hedged label; only placement changes.
function factGateFires(fact) {
  if (!fact || fact.status === 'refused' || !fact.value || typeof fact.value !== 'object') return false;
  if (fact.id === 'kitchen_vs_peak') return fact.value.peakAtOrAfterLastOrder === true;
  if (fact.id === 'busy_nights_agreement') {
    return Array.isArray(fact.value.sharedNights) && fact.value.sharedNights.length === 0
      && Array.isArray(fact.value.curveSays) && fact.value.curveSays.length > 0;
  }
  return false;
}

function splitAnomaly(cards) {
  // The lead card is never the anomaly block: it is the email's opening
  // verdict, and a verdict moved into a "worth a look" box has stopped being
  // the first thing read.
  const idx = cards.findIndex((c) => c.id !== LEAD_CARD_ID
    && (c.status === 'anomaly' || c.facts.some(factGateFires)));
  if (idx === -1) return { anomaly: null, rest: cards };
  const anomaly = cards[idx];
  return { anomaly, rest: cards.filter((_, i) => i !== idx) };
}

function sortForAudit(cards) {
  const bucket = (c) => {
    if (c.id === LEAD_CARD_ID) return -1;
    return HEADS_UP_CARD_IDS.includes(c.id) ? 1 : 0;
  };
  // Stable: the verdict, then the rest of the recap, then heads-up, original
  // order inside each bucket.
  return cards
    .map((c, i) => [bucket(c), i, c])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1])
    .map((x) => x[2]);
}

// One line per fact: the sentence the fact engine wrote (label, plus its
// hedge note when one rides along), then the source and its as-of date. asOf
// can be an ISO timestamp or already-worded text ("owner-set 2026-08-18"); a
// date-like value is trimmed to its day, anything else is quoted as sent. No
// wording is invented around the value: the label IS the line, refused facts
// render nothing here, and a fact whose value is an object with no label
// renders nothing rather than "[object Object]".
function factAsOf(asOf) {
  if (typeof asOf !== 'string' || !asOf.trim()) return '';
  const m = asOf.match(/^(\d{4}-\d{2}-\d{2})T/);
  return m ? m[1] : asOf.trim();
}

// The fact engine's source vocabulary, worded for a person. An id this map
// has never met renders as itself rather than being dropped: a raw token is
// still a source, and a figure with no source is the thing this whole build
// forbids.
const SOURCE_WORDS = {
  owner_report: 'your reading',
  intake: 'from your intake',
  arithmetic: 'arithmetic on your numbers',
  model_holdout: 'forecast',
  model_unverified_axis: 'forecast',
  category_pattern: 'category pattern',
  user_reports: 'user reports',
  served_prediction: 'served estimates',
  google_baseline: 'your Google profile',
  votes: 'group votes',
  events: 'Ticketmaster',
  weather: 'weather service',
};

function sourceWord(source) {
  if (typeof source !== 'string' || !source.trim()) return '';
  return SOURCE_WORDS[source] || source;
}

function factLineText(fact) {
  if (!fact || fact.status === 'refused') return null;
  const worded = [fact.label, fact.note]
    .filter((s) => typeof s === 'string' && s.trim())
    .map((s) => s.trim())
    .join(' ');
  const sentence = worded
    || (typeof fact.text === 'string' && fact.text.trim() ? fact.text.trim() : '')
    || (fact.value == null || typeof fact.value === 'object' ? '' : String(fact.value));
  if (!sentence) return null;
  const chips = [sourceWord(fact.source), factAsOf(fact.asOf)].filter(Boolean).join(', ');
  return chips ? `${sentence} (${chips})` : sentence;
}

function sectionsFor(cards, tier) {
  const kept = cardsForTier(cards, tier);
  const { anomaly, rest } = splitAnomaly(kept);
  const ordered = sortForAudit(rest);
  const recap = ordered.filter((c) => !HEADS_UP_CARD_IDS.includes(c.id));
  const headsUp = ordered.filter((c) => HEADS_UP_CARD_IDS.includes(c.id));
  return { recap, anomaly, headsUp };
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------
// The advisor surface's product name (decided 2026-08-19). One constant, so a
// rename is one line; used only where the name helps a reader find the thing,
// never as decoration. The subject line stays plain on purpose.
const ADVISOR_FEATURE_NAME = 'Roost';

// Five-ish lines a section: a card with a long week of rows gets its first
// MAX_LINES_PER_CARD and a pointer to the full surface, with no invented
// count of what was trimmed (a count would be a digit from nowhere).
const MAX_LINES_PER_CARD = 6;
const MORE_LINE = `More in ${ADVISOR_FEATURE_NAME}, in your venue dashboard.`;

function cardLines(card) {
  const lines = card.facts.map(factLineText).filter(Boolean);
  if (lines.length > MAX_LINES_PER_CARD) {
    return lines.slice(0, MAX_LINES_PER_CARD).concat(MORE_LINE);
  }
  return lines;
}

function renderCardText(card) {
  const lines = cardLines(card);
  if (!lines.length) return null;
  const title = String(card.title || card.id || '').trim().toUpperCase();
  return [title, ...lines.map((l) => `  ${l}`)].join('\n');
}

function renderDigestText({ businessName, cards, tier, optOutUrl, weekLabel }) {
  const { recap, anomaly, headsUp } = sectionsFor(cards, tier);
  const parts = [];
  parts.push(`Your week at ${businessName}${weekLabel ? ` (${weekLabel})` : ''}`);

  const recapBlocks = recap.map(renderCardText).filter(Boolean);
  if (recapBlocks.length) parts.push(recapBlocks.join('\n\n'));

  if (anomaly) {
    const block = renderCardText({ ...anomaly, title: `Worth a look: ${anomaly.title || anomaly.id}` });
    if (block) parts.push(block);
  }

  const headsUpBlocks = headsUp.map(renderCardText).filter(Boolean);
  if (headsUpBlocks.length) parts.push(headsUpBlocks.join('\n\n'));

  if (!recapBlocks.length && !anomaly && !headsUpBlocks.length) {
    parts.push('Nothing to report this week. As readings, forecasts, and nearby events come in for your venue, this email fills in.');
  }

  parts.push(
    [
      `You are getting this because weekly reports are turned on for ${businessName} in your Flock venue dashboard.`,
      optOutUrl ? `Stop these emails: ${optOutUrl}` : null,
    ].filter(Boolean).join('\n')
  );

  return parts.join('\n\n');
}

// ---------------------------------------------------------------------------
// HTML. Same palette the other transactional mail uses; inline styles only,
// because venue owners read this in whatever mail client the bar office
// computer has.
// ---------------------------------------------------------------------------
function renderCardHtml(card, opts) {
  const headline = opts && opts.headline;
  const lines = cardLines(card);
  if (!lines.length) return null;
  const title = escapeHtml(headline || card.title || card.id || '');
  const items = lines
    .map((l) => `<li style="margin: 0 0 8px 0;">${escapeHtml(l)}</li>`)
    .join('\n');
  return [
    `<h2 style="font-size: 15px; letter-spacing: 0.04em; text-transform: uppercase; color: #1a2b4a; margin: 28px 0 10px;">${title}</h2>`,
    `<ul style="font-size: 15px; color: #4a5568; line-height: 1.6; margin: 0; padding-left: 20px;">${items}</ul>`,
  ].join('\n');
}

function renderDigestHtml({ businessName, cards, tier, optOutUrl, weekLabel }) {
  const { recap, anomaly, headsUp } = sectionsFor(cards, tier);
  const blocks = [];

  for (const card of recap) {
    const b = renderCardHtml(card);
    if (b) blocks.push(b);
  }
  if (anomaly) {
    const b = renderCardHtml(anomaly, { headline: `Worth a look: ${anomaly.title || anomaly.id}` });
    if (b) blocks.push(b);
  }
  for (const card of headsUp) {
    const b = renderCardHtml(card);
    if (b) blocks.push(b);
  }
  if (!blocks.length) {
    blocks.push(
      '<p style="font-size: 15px; color: #4a5568; line-height: 1.6;">Nothing to report this week. As readings, forecasts, and nearby events come in for your venue, this email fills in.</p>'
    );
  }

  const footer = [
    `<p style="font-size: 13px; color: #a0aec0; margin-top: 32px; line-height: 1.6;">You are getting this because weekly reports are turned on for ${escapeHtml(businessName)} in your Flock venue dashboard.`,
    optOutUrl
      ? ` <a href="${escapeHtml(optOutUrl)}" style="color: #a0aec0;">Stop these emails</a>.`
      : '',
    '</p>',
  ].join('');

  return [
    '<div style="max-width: 560px; margin: 0 auto; padding: 32px 24px; font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;">',
    `<h1 style="font-size: 20px; color: #1a2b4a; margin: 0 0 4px;">Your week at ${escapeHtml(businessName)}</h1>`,
    weekLabel ? `<p style="font-size: 13px; color: #a0aec0; margin: 0 0 8px;">${escapeHtml(weekLabel)}</p>` : '',
    blocks.join('\n'),
    footer,
    '</div>',
  ].filter(Boolean).join('\n');
}

function digestSubject(businessName, weekLabel) {
  return `Your week at ${businessName}${weekLabel ? `, ${weekLabel}` : ''}`;
}

module.exports = {
  renderDigestText,
  renderDigestHtml,
  digestSubject,
  cardsForTier,
  factGateFires,
  ADVISOR_FEATURE_NAME,
  PREMIUM_CARD_IDS,
  HEADS_UP_CARD_IDS,
  RECAP_CARD_IDS,
  LEAD_CARD_ID,
  sectionsFor,
};
