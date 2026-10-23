// Run: node --test  (from backend/)
//
// THE MONDAY DIGEST'S "YOUR TABLES" SECTION (services/venueDigest.js
// buildDigestCards, services/tableInsights.js buildDigestTableFacts). Only a
// venue whose table unit recorded seatings in the week gets it, it renders
// through the same template as every other card with its source named, and a
// failed table read costs the section and never the email.
const test = require('node:test');
const assert = require('node:assert');

process.env.JWT_SECRET = 'digest-tables-test-secret';
delete process.env.VENUE_BILLING_ENABLED;

const pool = require('../config/database');
pool.query = async () => ({ rows: [], rowCount: 0 });

const lastNightVerdict = require('../services/lastNightVerdict');
lastNightVerdict.buildLastDayVerdict = async () => [];
const tableInsights = require('../services/tableInsights');
const realBuild = tableInsights.buildDigestTableFacts;
const advisorFacts = require('../services/advisorFacts');
const digest = require('../services/venueDigest');
const { renderDigestText, renderDigestHtml } = require('../templates/venueDigestEmail');

test.after(() => { tableInsights.buildDigestTableFacts = realBuild; });

const fakeEngine = {
  isRefusal: advisorFacts.isRefusal,
  getVenueContext: async () => ({ profile: { google_place_id: 'place-a', verified: true, user_id: 7 }, mlVenue: null }),
  buildWeekAhead: async () => [],
  buildAroundYou: async () => [],
  buildListingReadBack: async () => [],
  buildReadingsVsServed: async () => [],
};

const NOW = new Date('2026-10-19T13:00:00Z');

function tableFacts() {
  return [
    advisorFacts.makeFact({ id: 'tables_week_seatings', value: { seatings: 64, days: 7 }, source: 'table_sensor', asOf: '2026-10-19', label: 'Your tables had 64 seatings in the last 7 days.' }),
    advisorFacts.makeFact({ id: 'tables_turn_typical', value: { turnMinutes: 52 }, source: 'table_sensor', asOf: '2026-10-19', label: 'A typical party sat for about 52 minutes.' }),
  ];
}

test('a venue with seatings that week gets a Your tables card, rendered with its source', async () => {
  let asked = null;
  tableInsights.buildDigestTableFacts = async (placeId, now) => { asked = { placeId, now }; return tableFacts(); };
  const cards = await digest.buildDigestCards(fakeEngine, { userId: 7, tier: 'pro', now: NOW });
  const card = cards.find((c) => c.id === 'your_tables');
  assert.ok(card, 'the section is there');
  assert.strictEqual(card.title, 'Your tables');
  assert.strictEqual(card.status, 'ok');
  assert.deepStrictEqual(asked, { placeId: 'place-a', now: NOW });
  const input = { businessName: 'Test Bar', cards, tier: 'pro', optOutUrl: 'https://x/opt', weekLabel: 'Oct 12 to Oct 18' };
  const text = renderDigestText(input);
  assert.ok(text.includes('YOUR TABLES'));
  assert.ok(text.includes('A typical party sat for about 52 minutes. (your table sensor, Oct 19)'));
  assert.ok(renderDigestHtml(input).includes('Your tables'));
  assert.ok(!text.includes('—'));
});

test('a venue with no seatings that week gets no section at all', async () => {
  tableInsights.buildDigestTableFacts = async () => null;
  const cards = await digest.buildDigestCards(fakeEngine, { userId: 7, tier: 'pro', now: NOW });
  assert.ok(!cards.some((c) => c.id === 'your_tables'));
});

test('a failed table read drops the section and keeps the rest', async () => {
  tableInsights.buildDigestTableFacts = async () => { throw new Error('db down'); };
  const cards = await digest.buildDigestCards(fakeEngine, { userId: 7, tier: 'pro', now: NOW });
  assert.ok(cards.length > 0);
  assert.ok(!cards.some((c) => c.id === 'your_tables'));
});

test('a free venue gets no cards, tables included', async () => {
  tableInsights.buildDigestTableFacts = async () => tableFacts();
  const cards = await digest.buildDigestCards(fakeEngine, { userId: 7, tier: 'free', now: NOW });
  assert.deepStrictEqual(cards, []);
});

test('the section is declared Roost like every digest card', () => {
  const def = digest.DIGEST_CARDS.find((c) => c.id === 'your_tables');
  assert.ok(def && def.tier === 'pro');
});
