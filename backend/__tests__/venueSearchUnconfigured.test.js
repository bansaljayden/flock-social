// Run: node --test  (from backend/)
//
// ---------------------------------------------------------------------------
// WHAT VENUE SEARCH SAYS WHEN THE KEY IS GONE.
// ---------------------------------------------------------------------------
// This is the branch a browser pass on a real phone actually hit, and what it
// showed in the search dropdown was:
//
//     Google Places API key not configured
//
// verbatim, under a search box, to somebody typing the name of a bar. The
// contract that put it there is deliberate and correct: frontend/src/App.js
// doVenueSearch renders the server's message rather than printing "No venues
// found" over an outage. What was wrong is that this particular string was
// never written to be read by a person. It is unactionable for the user, and it
// narrates our deployment state to anybody with the app installed.
//
// It lives in its OWN suite because `API_KEY` is read into a module-level const
// at require time in routes/venueSearch.js, so the only way to exercise this
// branch is a process where the variable was never set. node --test gives each
// file its own process, which is exactly that.
//
// The other reason this file is separate: __tests__/venueSearchAnswers.test.js
// sets the key on its first line and therefore CANNOT reach any of these three
// branches. A whole class of user-visible copy was unreachable from the suite
// whose entire subject is user-visible copy.
//
// MUTATION-CHECKED 2026-08-26: putting 'Google Places API key not configured'
// back on any one of the three routes turns this file red on that route and on
// the sweep, and nothing else in the backend suite notices.
delete process.env.GOOGLE_PLACES_API_KEY;
process.env.JWT_SECRET = 'venue-search-unconfigured-test-secret';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

// Nothing here reaches Postgres: every case returns before the photo store or
// the places budget is consulted.
const pool = require('../config/database');
pool.query = () => Promise.resolve({ rows: [], rowCount: 0 });

const authMod = require('../middleware/auth');
authMod.authenticate = (req, _res, next) => { req.user = { id: 7, name: 'Ava' }; next(); };

// Nothing should reach Google with no key. If anything does, this counts it and
// the last case fails, which is the half a copy assertion cannot cover: a
// friendly sentence in front of a paid call that still went out is worse than
// an ugly one in front of a call that did not.
let googleCalls = 0;
const realFetch = global.fetch;
global.fetch = (url, opts) => {
  if (String(url).startsWith('https://places.googleapis.com/')) {
    googleCalls += 1;
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ places: [] }) });
  }
  return realFetch(url, opts);
};
test.after(() => { global.fetch = realFetch; });

const venueSearchRouter = require('../routes/venueSearch');

const app = express();
app.use(express.json());
app.use('/api/venues', venueSearchRouter);

let base;
const server = http.createServer(app);
test.before(() => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); });
}));
test.after(() => new Promise((resolve) => {
  server.close(() => resolve());
  pool.end?.().catch(() => {});
}));

async function get(pathname) {
  const res = await realFetch(`${base}${pathname}`);
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body, text };
}

// The words that must never appear in a body, in one list, because the point is
// the class and not any one string.
const INTERNAL = [
  'API key', 'api_key', 'not configured', 'GOOGLE_PLACES_API_KEY',
  'Google', 'googleapis', 'Places',
];

function assertHuman(res, where) {
  assert.strictEqual(typeof res.body?.error, 'string', `${where} answered no error string: ${res.text}`);
  const msg = res.body.error;
  // A sentence, not a token. The three originals were 21, 33 and 33 characters
  // of noun phrase with no verb in any of them.
  assert.ok(msg.length >= 30, `${where}: "${msg}" is too short to be a sentence`);
  assert.ok(/[.!]$/.test(msg.trim()), `${where}: "${msg}" does not end a sentence`);
  for (const leak of INTERNAL) {
    assert.ok(!msg.toLowerCase().includes(leak.toLowerCase()),
      `${where}: "${msg}" carries the internal string "${leak}"`);
  }
  // Em dashes are banned in every user-visible string in this product
  // (SLOP-AUDIT.md A2), and this copy is user-visible by contract.
  assert.ok(!msg.includes('\u2014'), `${where}: "${msg}" contains an em dash`);
}

test('venue search with no key answers a sentence, not the name of an environment variable', async () => {
  const res = await get('/api/venues/search?query=coffee');
  assertHuman(res, 'GET /search');
  // A missing key is not a blip. Telling somebody to try again in a moment
  // sends them back into the same wall for as long as the key is missing, so
  // the sentence has to say that retrying is not the answer.
  assert.match(res.body.error, /retrying will not help/i,
    'the copy invites a retry that cannot work');
  assert.strictEqual(res.status, 500,
    'the status must stay 500: services/api.js buildHttpError replaces the body message on 502, 503 and 504');
});

test('venue details with no key answers a sentence about venue pages', async () => {
  const res = await get('/api/venues/details?place_id=ChIJAAAAAAAAAAAAAAAAAAAAAA');
  assertHuman(res, 'GET /details');
  assert.strictEqual(res.status, 500);
});

test('the photo proxy with no key answers a sentence about photos', async () => {
  const res = await get('/api/venues/photo?ref=' + encodeURIComponent('places/AAA/photos/BBB'));
  assertHuman(res, 'GET /photo');
  assert.strictEqual(res.status, 500);
});

test('the three sentences are three different sentences, because they are three different screens', async () => {
  // One shared string would be the "Something happened" failure SLOP-AUDIT.md
  // section Q3 names: the user is on the search screen, the venue sheet or a
  // card with a blank image, and the sentence should say which of those is off.
  const search = (await get('/api/venues/search?query=coffee')).body.error;
  const details = (await get('/api/venues/details?place_id=ChIJAAAAAAAAAAAAAAAAAAAAAA')).body.error;
  const photo = (await get('/api/venues/photo?ref=' + encodeURIComponent('places/AAA/photos/BBB'))).body.error;
  assert.strictEqual(new Set([search, details, photo]).size, 3,
    'two of the three routes answer the same sentence for three different screens');
});

test('no route reached Google, so none of this cost anything', async () => {
  assert.strictEqual(googleCalls, 0,
    'a route with no API key still made an outbound Places call');
});
