// Run: node --test __tests__/advisorMoneyMove.test.js  (from backend/)
//
// THE MONEY MOVE, in the chat and in the Monday email (2026-10-28). One
// service picks the day, the move and the money (services/advisorMoneyMove.js)
// and both surfaces read it, so the email says exactly what the chip says.

const test = require('node:test');
const assert = require('node:assert');

// No database: every builder that queries one gets nothing back.
const pool = require('../config/database');

pool.query = async () => ({ rows: [], rowCount: 0 });

const advisorMoneyMove = require('../services/advisorMoneyMove');
const venueDigest = require('../services/venueDigest');
const { renderDigestText, renderDigestHtml } = require('../templates/venueDigestEmail');

const isRefusal = (e) => Boolean(e && e.refusal === true);
const DAY = (weekday, peakHour, peakScore, i) => ({
  id: `peak_2026-11-0${i}`,
  value: { date: `2026-11-0${i}`, weekday, peakHour, peakScore },
  source: 'model_holdout',
  asOf: '2026-10-27T22:00:00Z',
  label: `${weekday} projects busiest.`,
});
const WEEK = [DAY('Monday', 18, 41, 2), DAY('Tuesday', 18, 38, 3), DAY('Friday', 20, 82, 6), DAY('Saturday', 20, 88, 7)];
const CTX = (spend) => ({
  profile: { google_place_id: 'p', verified: true, typical_spend_per_person: spend, updated_at: '2026-10-01T00:00:00Z' },
  mlVenue: { venue_category: 'restaurant' },
});

test('the pick is the quietest day with the busiest beside it, noted, and a level week says so', () => {
  const [low, top] = advisorMoneyMove.pickFacts(WEEK, isRefusal);
  assert.strictEqual(low.value.weekday, 'Tuesday');
  assert.strictEqual(top.value.weekday, 'Saturday');
  assert.ok(low.note.includes(advisorMoneyMove.LOWEST_NOTE));
  assert.ok(top.note.includes(advisorMoneyMove.HIGHEST_NOTE));
  const level = advisorMoneyMove.pickFacts(WEEK.map((f) => ({ ...f, value: { ...f.value, peakScore: 80 + (f.value.peakScore % 5) } })), isRefusal);
  assert.ok(level[0].note.includes(advisorMoneyMove.LEVEL_NOTE));
  // Nothing scored: the refusals speak.
  const refusals = [{ id: 'refuse_no_baseline', refusal: true }];
  assert.strictEqual(advisorMoneyMove.pickFacts(refusals, isRefusal), refusals);
});

test('the Monday email carries the money move second, in the chip\'s own words', async () => {
  const advisorFacts = {
    isRefusal,
    getVenueContext: async () => CTX(38),
    buildWeekAhead: async () => WEEK.map((f) => ({ ...f })),
    buildAroundYou: async () => [],
    buildListingReadBack: async () => [],
    buildReadingsVsServed: async () => [],
  };
  const cards = await venueDigest.buildDigestCards(advisorFacts, { userId: 7, tier: 'pro', now: new Date('2026-11-02T13:00:00Z') });
  const ids = cards.map((c) => c.id);
  const money = cards.find((c) => c.id === 'money_move');
  assert.ok(money, `no money move in ${ids.join(', ')}`);
  assert.ok(ids.indexOf('money_move') < ids.indexOf('week_ahead'), 'the move sits above the forecast');
  if (ids.includes('last_night_verdict')) assert.strictEqual(ids[0], 'last_night_verdict', 'and below the verdict');
  assert.deepStrictEqual(money.facts.map((f) => f.label), [
    'Fill Tuesday. It is your quietest day this week, with its peak around 6 PM at 38 on our 0 to 100 index, against 88 on Saturday.',
    money.facts[1].label,
    'At your $38 a head, every 10 extra covers on Tuesday is $380 a week, about $19,760 a year.',
  ]);
  assert.strictEqual(money.facts[1].source, 'roost_playbook');

  const text = renderDigestText({ businessName: 'Test Room', cards, tier: 'pro', optOutUrl: null, weekLabel: 'Oct 26 to Nov 1' });
  assert.match(text, /THIS WEEK'S MONEY MOVE\n {2}Fill Tuesday\./);
  assert.match(text, /\(Roost playbook\)/);
  assert.ok(text.indexOf("THIS WEEK'S MONEY MOVE") < text.indexOf('WEEK AHEAD'), 'above the forecast in the email too');
  const html = renderDigestHtml({ businessName: 'Test Room', cards, tier: 'pro', optOutUrl: null, weekLabel: null });
  assert.match(html, /This week&#39;s money move|This week's money move/);
});

test('with no spend on file the email still names the day and the move, and states no dollar figure', () => {
  const card = advisorMoneyMove.digestCard({
    weekFacts: WEEK,
    ctx: CTX(null),
    isRefusal,
    renderLead: () => 'Fill Tuesday.',
  });
  assert.strictEqual(card.facts.length, 2);
  assert.ok(!card.facts.some((f) => /\$/.test(f.label)));
});

test('a week with nothing scored has no money move section', () => {
  assert.strictEqual(advisorMoneyMove.digestCard({
    weekFacts: [{ id: 'refuse_no_baseline', refusal: true }],
    ctx: CTX(38),
    isRefusal,
    renderLead: () => 'x',
  }), null);
});
