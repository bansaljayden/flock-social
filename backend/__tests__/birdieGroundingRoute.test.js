// Run: node --test  (from backend/)
//
// WHAT BIRDIE MAY SAY ABOUT A VENUE, through the real route (routes/ai.js,
// utils/birdieGrounding.js). The check itself is pinned rule by rule in
// __tests__/birdieGrounding.test.js; this pins that the route runs it on the
// model's words with the facts its own tools returned, leaves the cards and
// the server's own lines alone, and logs fixed words only.
//
// Driven through the real route with Gemini and Places faked.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

process.env.JWT_SECRET = 'birdie-grounding-route-test-secret';
process.env.GEMINI_API_KEY = 'test-gemini-key';
process.env.GOOGLE_PLACES_API_KEY = 'test-places-key';
delete process.env.PAYWALL_ENABLED;
delete process.env.NODE_ENV;
delete process.env.POSTHOG_API_KEY;

let dob = '1999-01-01';
const pool = require('../config/database');
pool.query = (text) => {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  if (/FROM users WHERE id/.test(flat)) return Promise.resolve({ rows: [{ name: 'Alex', date_of_birth: dob }], rowCount: 1 });
  return Promise.resolve({ rows: [], rowCount: 0 });
};
// A fresh account per request, so Birdie's per-account minute meter never
// answers in place of the route (the other Birdie suites do the same).
let nextUserId = 62000;
const authMod = require('../middleware/auth');
authMod.authenticate = (req, _res, next) => { req.user = { id: ++nextUserId, name: 'Alex' }; next(); };
const weatherService = require('../services/weatherService');
weatherService.getWeather = async () => null;

// The demo's two venues, as the local Places stub answered a text search.
const place = (id, name, addr, types, rating, ratings) => ({
  id, displayName: { text: name }, formattedAddress: addr, rating, userRatingCount: ratings,
  priceLevel: 'PRICE_LEVEL_MODERATE', types, location: { latitude: 39.95, longitude: -75.16 }, currentOpeningHours: { openNow: true },
});
const THISTLE = place('demo-thistle-crust', 'Thistle & Crust', 'Chestnut St, Philadelphia', ['pizza_restaurant', 'restaurant'], 4.6, 301);
const LARKSPUR = place('demo-larkspur-tap', 'Larkspur Tap', 'Sansom St, Philadelphia', ['bar'], 4.5, 212);
const realFetch = global.fetch;
global.fetch = (url, opts) => {
  const u = String(url);
  if (u.startsWith('http://127.0.0.1')) return realFetch(url, opts);
  if (u.startsWith('https://places.googleapis.com/') && u.includes(':searchText')) {
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ places: [THISTLE, LARKSPUR] }) });
  }
  return Promise.resolve({ ok: false, status: 500, json: async () => ({}) });
};
test.after(() => { global.fetch = realFetch; });

// The model searches (unless a follow-up it answers with no tool), then writes
// `finalText`. Every chat it opens is kept, for what the model is handed.
const genaiMod = require('@google/genai');
let sends = [];
let creates = [];
let finalText = '';
let searchFirst = true;
genaiMod.GoogleGenAI = function FakeGenAI() {
  return {
    chats: {
      create: (opts) => {
        creates.push(opts);
        return {
          sendMessage: async (p) => {
            sends.push(p);
            if (searchFirst && sends.length === 1) return { candidates: [{ content: { parts: [{ functionCall: { id: 's1', name: 'search_venues', args: { query: 'food for 6', location: '39.95,-75.17' } } }] } }] };
            return { candidates: [{ content: { parts: finalText ? [{ text: finalText }] : [] } }] };
          },
        };
      },
    },
  };
};

const aiRouter = require('../routes/ai');
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
let warned = [];
const realWarn = console.warn;
test.beforeEach(() => {
  aiRouter.__clearBirdieSearchCache();
  sends = [];
  creates = [];
  warned = [];
  dob = '1999-01-01';
  searchFirst = true;
  console.warn = (...a) => { warned.push(a.join(' ')); };
});
test.afterEach(() => { console.warn = realWarn; });

async function ask(text, reply) {
  finalText = reply;
  const res = await fetch(`${base}/api/ai/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', text }], location: { lat: 39.95, lng: -75.17 } }),
  });
  assert.strictEqual(res.status, 200);
  return res.json();
}

const DEMO = 'Thistle & Crust. The booths in the back fit six easily and the wood-fired pies are the whole reason to go.';

test('the demo answer reaches the app without the details no tool returned, and its cards are unchanged', async () => {
  const body = await ask("Where's good tonight for 6 of us?", DEMO);
  assert.strictEqual(body.text, 'Thistle & Crust.');
  assert.deepStrictEqual(body.venues.map((v) => v.name), ['Thistle & Crust', 'Larkspur Tap']);
  const line = warned.find((w) => w.includes('Birdie grounding'));
  assert.ok(line, 'nothing logged for a removal');
  assert.match(line, /removed 4 unsupported venue detail\(s\) \(seating, room, capacity, preparation\)/);
  assert.ok(!/booth|wood|pies|Thistle/i.test(line), `the log carries the reply's words: ${line}`);
});

test('an answer that stands on its tools reaches the app word for word', async () => {
  const said = 'Thistle & Crust. Pizza place, rated 4.6, and Larkspur Tap is the bar pick if you want drinks.';
  const body = await ask("Where's good tonight for 6 of us?", said);
  assert.strictEqual(body.text, said);
  assert.ok(!warned.some((w) => w.includes('Birdie grounding')));
});

// THE CARDS ALREADY SHOWN: a follow-up the model answers with no tool, sent
// the way the app sends it, with the venues its last carded answer showed.
const THISTLE_CARD = { place_id: 'demo-thistle-crust', name: 'Thistle & Crust', types: ['pizza_restaurant', 'restaurant'], price_level: 2, rating: 4.6 };
const HISTORY = [
  { role: 'user', text: "Where's good tonight for 6 of us?" },
  { role: 'assistant', text: 'Thistle & Crust. It is rated 4.6.\n[Venues shown: Thistle & Crust (crowd unknown, open), Larkspur Tap (crowd unknown, open)]' },
];
async function followUp(text, reply, currentContext) {
  searchFirst = false;
  finalText = reply;
  const res = await fetch(`${base}/api/ai/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [...HISTORY, { role: 'user', text }], location: { lat: 39.95, lng: -75.17 }, currentContext }),
  });
  return { status: res.status, body: await res.json() };
}
const FOLLOW_UP = 'Thistle & Crust is a pizza place, rated 4.6. The booths in the back fit six and the wood-fired pies are the move.';

test('a follow-up no tool answers keeps "pizza" for the carded pizza place, and still removes the wood-fired pies and the booths in the back', async () => {
  const r = await followUp('why that one?', FOLLOW_UP, { screen: 'main', tab: 'home', carded: [THISTLE_CARD] });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.text, 'Thistle & Crust is a pizza place, rated 4.6.');
  assert.deepStrictEqual(r.body.venues, [], 'a carded venue became a card');
  assert.match(warned.find((w) => w.includes('Birdie grounding')) || '', /\(seating, room, capacity, preparation\)/);
});

test('the false alarm it fixes: the venue on screen, with no tool and no card, lost its "pizza"; its card keeps it', async () => {
  const onScreen = { screen: 'main', tab: 'explore', venue: { name: 'Thistle & Crust', place_id: 'demo-thistle-crust' } };
  const said = 'Thistle & Crust is a pizza place, rated 4.6.';
  const without = await followUp('is it any good?', said, onScreen);
  assert.notStrictEqual(without.body.text, said, 'precondition: with nothing behind it, "pizza" is removed');
  const withCard = await followUp('is it any good?', said, { ...onScreen, carded: [THISTLE_CARD] });
  assert.strictEqual(withCard.body.text, said);
});

test('a claim about a venue that was never carded is still removed', async () => {
  const ctx = { screen: 'main', tab: 'explore', venue: { name: 'Larkspur Tap', place_id: 'demo-larkspur-tap' }, carded: [THISTLE_CARD] };
  const r = await followUp('and the other one?', 'Thistle & Crust is a pizza place. Larkspur Tap has a big patio.', ctx);
  assert.strictEqual(r.body.text, 'Thistle & Crust is a pizza place.');
  // A card stands behind its own venue only: Thistle & Crust's types say
  // nothing for Larkspur Tap.
  const pies = await followUp('pizza there?', 'Larkspur Tap has wood-fired pies.', ctx);
  assert.strictEqual(pies.body.text, 'Larkspur Tap.');
});

test('a carded venue\'s deal stands behind a claim about that deal', async () => {
  const wings = { name: 'Rally House Wings', place_id: 'p-wings', types: ['chicken_wings_restaurant', 'restaurant'], deal: { title: 'Half-price wings 9–11 PM', time_slot: 'Late Night', days: 'Fri-Sun' } };
  const said = 'Rally House Wings. Half-price wings run 9 to 11 tonight.';
  assert.strictEqual((await followUp('any deals?', said, { screen: 'main', tab: 'home', carded: [wings] })).body.text, said);
  const { deal, ...noDeal } = wings;
  assert.ok(deal);
  assert.strictEqual((await followUp('any deals?', said, { screen: 'main', tab: 'home', carded: [noDeal] })).body.text, 'Rally House Wings.');
});

test('the list the app sends back is bounded and shaped like the rest of its context, and refused before anything is spent', async () => {
  const card = (over = {}) => ({ ...THISTLE_CARD, ...over });
  const refused = [
    ['five venues', Array.from({ length: 5 }, (_, i) => card({ name: `Venue ${i}` }))],
    ['a field the card does not carry', [card({ address: 'Chestnut St' })]],
    ['a name past 120', [card({ name: 'n'.repeat(121) })]],
    ['no name', [card({ name: '' })]],
    ['six types', [card({ types: ['a', 'b', 'c', 'd', 'e', 'f'] })]],
    ['a type past 60', [card({ types: ['t'.repeat(61)] })]],
    ['a type that is not a string', [card({ types: [{ evil: true }] })]],
    ['a price level past 4', [card({ price_level: 5 })]],
    ['a rating past 5', [card({ rating: 5.5 })]],
    ['a place id past 200', [card({ place_id: 'p'.repeat(201) })]],
    ['a deal field the deal does not carry', [card({ deal: { title: 'Wings', url: 'x' } })]],
    ['a deal title past 80', [card({ deal: { title: 'd'.repeat(81) } })]],
    ['not a list', { name: 'Thistle & Crust' }],
  ];
  for (const [why, carded] of refused) {
    sends = [];
    const r = await followUp('why that one?', FOLLOW_UP, { screen: 'main', tab: 'home', carded });
    assert.strictEqual(r.status, 400, `${why} was accepted`);
    assert.strictEqual(sends.length, 0, `${why} reached the model`);
  }
  // At the bounds, and with nothing at all, the turn goes.
  const full = Array.from({ length: 4 }, (_, i) => card({
    name: `${'n'.repeat(118)}${i}`, types: ['a', 'b', 'c', 'd', 't'.repeat(60)], price_level: 4, rating: 5,
    deal: { title: 'd'.repeat(80), time_slot: 's'.repeat(60), days: null },
  }));
  for (const carded of [full, null, undefined]) {
    const r = await followUp('why that one?', FOLLOW_UP, { screen: 'main', tab: 'home', ...(carded === undefined ? {} : { carded }) });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  }
});

test('the list never reaches the model and never puts a venue or a card in the reply', async () => {
  const sentinel = { name: 'Zz Sentinel Hall', place_id: 'p-sentinel', types: ['restaurant'], deal: { title: 'SENTINEL-DEAL-42', time_slot: null, days: null } };
  const r = await followUp('why that one?', 'Thistle & Crust is a pizza place.', { screen: 'main', tab: 'home', carded: [THISTLE_CARD, sentinel] });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.text, 'Thistle & Crust is a pizza place.');
  assert.deepStrictEqual(r.body.venues, []);
  const handed = JSON.stringify({ creates: creates.map((c) => c.config.systemInstruction), sends: sends.map((s) => s.message) });
  // What was searched holds the system prompt and the turn, so the absence below means something.
  assert.match(handed, /Your reasons for a spot come from what the tools returned/);
  assert.match(handed, /why that one\?/);
  assert.ok(!/SENTINEL|Zz Sentinel/.test(handed), 'the carded list reached the model');
});

test('the server\'s own lines are not checked, and the plain no still reads the model\'s own words', async () => {
  // An empty reply gets the server's line, as before.
  const empty = await ask('hmm', '');
  assert.strictEqual(empty.text, 'say that one more time?');
  // Carding talk the check would have cut is still carding talk: the plain no
  // decides on what the model wrote, not on what the check left.
  dob = '2010-05-02';
  const minor = await ask('where can we get drinks without getting carded', 'Thistle & Crust. They never card in the back room, and it is at 40.');
  assert.strictEqual(minor.text, "can't help with drinking under 21. want a spot that fits the night without it? tell me what you're into");
});
