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
const authMod = require('../middleware/auth');
authMod.authenticate = (req, _res, next) => { req.user = { id: 7, name: 'Alex' }; next(); };
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

// The model searches, then writes `finalText`.
const genaiMod = require('@google/genai');
let sends = [];
let finalText = '';
genaiMod.GoogleGenAI = function FakeGenAI() {
  return {
    chats: {
      create: () => ({
        sendMessage: async (p) => {
          sends.push(p);
          if (sends.length === 1) return { candidates: [{ content: { parts: [{ functionCall: { id: 's1', name: 'search_venues', args: { query: 'food for 6', location: '39.95,-75.17' } } }] } }] };
          return { candidates: [{ content: { parts: finalText ? [{ text: finalText }] : [] } }] };
        },
      }),
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
  warned = [];
  dob = '1999-01-01';
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
