// Run: node --test  (from backend/)
//
// GET /api/crowd/:placeId/alternatives — a list shaped by an owner's reading
// is never remembered, whether or not that reading made it onto the list.
//
// The payload is cached for ten minutes unless a row in it carries an owner's
// live reading, because the reading is perishable and retractable. The gate
// looked only at the rows that were published: a neighbour whose owner said
// "packed" was scored above the target and left OFF the list, so the list
// carried no reading, was cached, and kept that neighbour off it for up to ten
// minutes after the owner retracted the reading.
//
// Harness modelled on crowdBatchClock.test.js: pg, Google, weather and the
// predictor are faked and nothing leaves the process.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

process.env.JWT_SECRET = 'crowd-alternatives-owner-cache-secret';
process.env.GOOGLE_PLACES_API_KEY = 'test-places-key';
process.env.WEATHER_API_KEY = 'test-weather-key';
delete process.env.PAYWALL_ENABLED;

const MIN = 60e3;
const pool = require('../config/database');

let ownerLive = true;
pool.query = async (sql) => {
  const flat = String(sql).replace(/\s+/g, ' ');
  if (/DISTINCT ON \(r\.google_place_id\)/.test(flat)) {
    // The neighbour NEAR_PACKED's owner says 95; the model says 20.
    const at = new Date(Date.now() - 5 * MIN);
    return {
      rows: ownerLive ? [{
        id: 7, google_place_id: 'NEAR_PACKED', busy_percent: 95, created_at: at,
        diverged: false, profile_category: 'bar', assertion_since: at,
      }] : [],
    };
  }
  return { rows: [], rowCount: 0 };
};

const authMod = require('../middleware/auth');
authMod.authenticate = (req, _res, next) => { req.user = { id: 4, name: 'Ava', role: 'user' }; next(); };

const weatherService = require('../services/weatherService');
weatherService.getWeather = async () => null;
weatherService.getForecast = async () => [];

function place(id) {
  return {
    id, displayName: { text: id }, formattedAddress: '1 Main St', rating: 4.2, userRatingCount: 300,
    priceLevel: 'PRICE_LEVEL_MODERATE', types: ['bar'], location: { latitude: 39.74, longitude: -104.98 },
    currentOpeningHours: { openNow: true, periods: [] }, utcOffsetMinutes: null,
  };
}

const realFetch = global.fetch;
global.fetch = async (url, opts) => {
  const u = String(url);
  if (u.startsWith('http://127.0.0.1:')) return realFetch(url, opts);
  if (u.startsWith('https://places.googleapis.com/v1/places:searchText')) {
    const places = ['NEAR_PACKED', 'NEAR_AAA', 'NEAR_BBB', 'NEAR_CCC'].map(place);
    return { ok: true, status: 200, json: async () => ({ places }) };
  }
  if (u.startsWith('https://places.googleapis.com/v1/places/')) {
    const id = decodeURIComponent(u.split('/places/')[1] || '').split('?')[0];
    return { ok: true, status: 200, json: async () => place(id) };
  }
  throw new Error(`outbound call from a test: ${u}`);
};
test.after(() => { global.fetch = realFetch; });

const crowdEngine = require('../services/crowdEngine');
const mlPredictor = require('../services/mlPredictor');
// The model's numbers: NEAR_PACKED is the quietest place nearby.
const SCORES = { ALT_TARGET: 60, NEAR_PACKED: 20, NEAR_AAA: 30, NEAR_BBB: 35, NEAR_CCC: 40 };
mlPredictor.predictBusyness = async (v) => {
  const score = SCORES[v.place_id] ?? 50;
  return {
    score, label: crowdEngine.getLabel(score), confidence: 60, factors: {},
    dataSourcesUsed: ['ml_model'], predictionMethod: 'ml', modelVersion: 'test',
  };
};

const crowdRouter = require('../routes/crowd');
const app = express();
app.use(express.json());
app.use('/api/crowd', crowdRouter);
let base;
const server = http.createServer(app);
test.before(() => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); });
}));
test.after(() => new Promise((resolve) => {
  server.close(() => resolve());
  pool.end?.().catch(() => {});
}));

async function alternatives() {
  const res = await fetch(`${base}/api/crowd/ALT_TARGET/alternatives?localHour=20&localDay=5`);
  const body = await res.json();
  assert.strictEqual(res.status, 200, JSON.stringify(body));
  return body.alternatives.map((a) => a.placeId);
}

test('a neighbour an owner\'s reading kept off the list is back on it once the reading is retracted', async () => {
  crowdRouter.__test.clearCache();
  ownerLive = true;
  assert.deepStrictEqual(await alternatives(), ['NEAR_AAA', 'NEAR_BBB', 'NEAR_CCC'],
    'the owner\'s 95 puts NEAR_PACKED above the target');
  ownerLive = false; // DELETE /busy-now, or the 90 minutes run out
  assert.deepStrictEqual(await alternatives(), ['NEAR_PACKED', 'NEAR_AAA', 'NEAR_BBB'],
    'the retracted reading went on shaping a cached list');
});
