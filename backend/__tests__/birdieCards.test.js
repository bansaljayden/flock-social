// Run: node --test  (from backend/)
//
// THE CARDS THE REPLY NAMES (routes/ai.js). A reply goes out with up to four
// venue cards, and they were the first four the turn's searches returned, so a
// reply that named the seventh result had no card for it: "anything still
// open? we're starving" got Night Owl Diner in words and four shut
// restaurants as cards. The four are chosen the way the app orders them
// (frontend/src/lib/birdieCardOrder.js): the places the reply names, in the
// order it names them, then the rest in the search's order. Pinned here:
//   1. the app's own cases, answered the same way;
//   2. the name rules are the app's, so the two cannot drift;
//   3. through the route, a named seventh result gets a card, and the cards
//      go out in the search's order, which the app sorts by the reply.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const express = require('express');

process.env.JWT_SECRET = 'birdie-cards-test-secret';
process.env.GEMINI_API_KEY = 'test-gemini-key';
process.env.GOOGLE_PLACES_API_KEY = 'test-places-key';
delete process.env.PAYWALL_ENABLED;
delete process.env.NODE_ENV;
delete process.env.POSTHOG_API_KEY;

const pool = require('../config/database');
pool.query = (text) => {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  if (/FROM users WHERE id/.test(flat)) return Promise.resolve({ rows: [{ name: 'Marcus Webb', date_of_birth: '2000-01-01' }], rowCount: 1 });
  return Promise.resolve({ rows: [], rowCount: 0 });
};
const authMod = require('../middleware/auth');
authMod.authenticate = (req, _res, next) => { req.user = { id: 51, name: 'Marcus' }; next(); };
const weatherService = require('../services/weatherService');
weatherService.getWeather = async () => null;

const NAMES = ['Mango Street Tacos', 'Ritual Ramen', 'Thistle & Crust', 'Saffron Room', 'Fishtown Night Market', 'Rally House Wings', 'Night Owl Diner'];
const place = (name, i) => ({
  id: `PLACE_CARD_${i}`, displayName: { text: name }, formattedAddress: `${i} Broad St, Philadelphia, PA`, rating: 4.2, userRatingCount: 200,
  priceLevel: 'PRICE_LEVEL_INEXPENSIVE', types: ['restaurant', 'food'], location: { latitude: 39.95, longitude: -75.16 },
  currentOpeningHours: { openNow: i === NAMES.length - 1 },
});
const realFetch = global.fetch;
global.fetch = (url, opts) => {
  const u = String(url);
  if (u.startsWith('http://127.0.0.1')) return realFetch(url, opts);
  if (u.startsWith('https://places.googleapis.com/v1/places:searchText')) {
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ places: NAMES.map(place) }) });
  }
  return Promise.resolve({ ok: false, status: 500, json: async () => ({}) });
};
test.after(() => { global.fetch = realFetch; });

let reply = '';
const genaiMod = require('@google/genai');
genaiMod.GoogleGenAI = function FakeGenAI() {
  return {
    chats: {
      // A count per chat, which is one per request.
      create: () => {
        let calls = 0;
        return {
          sendMessage: async () => {
            calls += 1;
            if (calls === 1) return { candidates: [{ content: { parts: [{ functionCall: { id: 's1', name: 'search_venues', args: { query: 'food open now', location: '39.95,-75.17' } } }] } }] };
            return { candidates: [{ content: { parts: [{ text: reply }] } }] };
          },
        };
      },
    },
  };
};

const aiRouter = require('../routes/ai');
const { venuesByMention } = aiRouter.__testables;
const app = express();
app.use(express.json());
app.use('/api/ai', aiRouter);
const server = http.createServer(app);
let base;
test.before(() => new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
  base = `http://127.0.0.1:${server.address().port}`;
  resolve();
})));
test.after(() => new Promise((resolve) => server.close(resolve)));
test.beforeEach(() => aiRouter.__clearBirdieSearchCache());

const v = (name) => ({ name });
const names = (list) => list.map((x) => x.name);

test("the app's own cases, answered the same way", () => {
  assert.deepStrictEqual(names(venuesByMention([v('TACODELPHIA'), v('Taqueria La Prima'), v('Blue Corn')], 'Taqueria La Prima. Dirt cheap.')),
    ['Taqueria La Prima', 'TACODELPHIA', 'Blue Corn']);
  assert.deepStrictEqual(names(venuesByMention([v('Silk City'), v('Pizzeria Stella'), v('Oh Brother Philly')], 'Try Oh Brother first, or Silk City if it is packed.')),
    ['Oh Brother Philly', 'Silk City', 'Pizzeria Stella']);
  assert.deepStrictEqual(names(venuesByMention([v('Race Street Cafe'), v('The Franklin Fountain')], 'Franklin Fountain for dessert.')),
    ['The Franklin Fountain', 'Race Street Cafe']);
  assert.deepStrictEqual(names(venuesByMention([v('Cafe Ole'), v('Café Lùcia')], 'cafe lucia is the move')), ['Café Lùcia', 'Cafe Ole']);
  assert.deepStrictEqual(names(venuesByMention([v('Bar One'), v('Stella')], 'Stellar Pies has room tonight.')), ['Bar One', 'Stella']);
  assert.deepStrictEqual(names(venuesByMention([v('A Place'), v('B Place'), v('C Place')], 'Any of these work for five.')), ['A Place', 'B Place', 'C Place']);
  assert.deepStrictEqual(venuesByMention([], 'x'), []);
  const one = [v('Solo')];
  assert.strictEqual(venuesByMention(one, 'Solo'), one);
});

test("the name rules are the app's, word for word", () => {
  const app = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'src', 'lib', 'birdieCardOrder.js'), 'utf8');
  const route = fs.readFileSync(path.join(__dirname, '..', 'routes', 'ai.js'), 'utf8');
  const trailing = '/ (philly|philadelphia|restaurant|pizzeria|cafe|bar|grill|kitchen|bistro|tavern|co|inc|llc)(?= $)/';
  const leading = '/^ the(?= )/';
  assert.ok(app.includes(`const TRAILING = ${trailing};`) && route.includes(`const CARD_NAME_TRAILING = ${trailing};`));
  assert.ok(app.includes(`const LEADING = ${leading};`) && route.includes(`const CARD_NAME_LEADING = ${leading};`));
});

async function cardsFor(text) {
  reply = text;
  const res = await fetch(`${base}/api/ai/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', text: "anything still open around here? we're starving" }], location: { lat: 39.9511, lng: -75.166 } }),
  });
  assert.strictEqual(res.status, 200);
  return (await res.json()).venues.map((c) => c.name);
}

test('a reply that names the seventh result gets a card for it', async () => {
  assert.deepStrictEqual(await cardsFor("Night Owl Diner on South Broad. It's cheap and the only spot open right now."),
    ['Mango Street Tacos', 'Ritual Ramen', 'Thistle & Crust', 'Night Owl Diner']);
});

test('a reply that names nothing keeps the search order', async () => {
  assert.deepStrictEqual(await cardsFor('Where are you guys headed after?'),
    ['Mango Street Tacos', 'Ritual Ramen', 'Thistle & Crust', 'Saffron Room']);
});
