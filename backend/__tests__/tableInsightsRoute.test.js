// Run: node --test  (from backend/)
//
// THE OWNER'S TABLE READ (routes/tableInsights.js, /api/venue/tables): last
// night at the tables and the free forecast. The verified owner only, then
// Roost; anyone else is told only that the route is for the owner. The
// forecast has no public twin.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

process.env.JWT_SECRET = 'table-insights-route-test-secret';
delete process.env.VENUE_BILLING_ENABLED;

const pool = require('../config/database');
let owns = true;
let queryLog = [];
pool.query = async (sql, params = []) => {
  const flat = String(sql).replace(/\s+/g, ' ').trim();
  queryLog.push({ sql: flat, params });
  if (/FROM venue_profiles WHERE user_id = \$1 AND google_place_id = \$2 AND verified = true/.test(flat)) {
    return { rows: owns ? [{ '?column?': 1 }] : [], rowCount: owns ? 1 : 0 };
  }
  return { rows: [], rowCount: 0 };
};

const authMod = require('../middleware/auth');
authMod.authenticate = (req, _res, next) => { req.user = { id: 7 }; next(); };

const tableInsights = require('../services/tableInsights');
let lastCall = null;
tableInsights.lastNightSummary = async (placeId) => {
  lastCall = { fn: 'lastNight', placeId };
  return { date: '2026-10-18', timeZone: null, seatings: 0, waited: 0, turn_minutes: null, full_hours: [], sentences: ['No seatings were recorded at your tables yesterday.'], text: 'No seatings were recorded at your tables yesterday.' };
};
tableInsights.freeForecast = async (placeId, dow, hour) => {
  lastCall = { fn: 'forecast', placeId, dow, hour };
  return { dow, hour, weeks: 8, free_weeks: 2, share: 0.25, timeZone: 'America/New_York' };
};

const app = express();
app.use('/api/venue/tables', require('../routes/tableInsights'));
let server;
let base;
test.before(async () => {
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

const get = async (p) => {
  const res = await fetch(base + p);
  return { status: res.status, body: await res.json() };
};

test('the verified owner reads last night at the tables', async () => {
  owns = true;
  const r = await get('/api/venue/tables/place-a/last-night');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.last_night.text, 'No seatings were recorded at your tables yesterday.');
  assert.deepStrictEqual(lastCall, { fn: 'lastNight', placeId: 'place-a' });
  const q = queryLog.find((x) => /venue_profiles/.test(x.sql));
  assert.deepStrictEqual(q.params, [7, 'place-a'], 'parameterized, caller and place');
});

test('anyone else is told only that the route is for the owner', async () => {
  owns = false;
  lastCall = null;
  const r = await get('/api/venue/tables/place-a/last-night');
  assert.strictEqual(r.status, 403);
  assert.deepStrictEqual(r.body, { error: 'Table monitoring is for the verified owner of this venue.' });
  assert.strictEqual(lastCall, null, 'nothing was read');
  const f = await get('/api/venue/tables/place-a/free-forecast?dow=5&hour=20');
  assert.strictEqual(f.status, 403);
});

test('the free forecast takes a weekday and an hour, validated', async () => {
  owns = true;
  const r = await get('/api/venue/tables/place-a/free-forecast?dow=5&hour=20');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.forecast.share, 0.25);
  assert.deepStrictEqual(lastCall, { fn: 'forecast', placeId: 'place-a', dow: 5, hour: 20 });
  assert.strictEqual((await get('/api/venue/tables/place-a/free-forecast?dow=7&hour=20')).status, 400);
  assert.strictEqual((await get('/api/venue/tables/place-a/free-forecast?dow=1&hour=24')).status, 400);
  assert.strictEqual((await get('/api/venue/tables/place-a/free-forecast?hour=2')).status, 400);
});

test('the forecast has no public route: the public summary code never mentions it', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const sensors = fs.readFileSync(path.join(__dirname, '..', 'routes', 'sensors.js'), 'utf8');
  assert.ok(!/freeForecast|free-forecast|tableInsights/.test(sensors));
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(server.includes("app.use('/api/venue/tables', apiLimiter, require('./routes/tableInsights'))"));
});

test('structured and repeated forecast parameters are rejected before any database read', async () => {
  owns = true;
  for (const query of ['dow[]=5&hour=20', 'dow=5&dow=6&hour=20', 'dow=5&hour[]=20', 'dow=5&hour=20&hour=21']) {
    queryLog = [];
    lastCall = null;
    const res = await get(`/api/venue/tables/place-a/free-forecast?${query}`);
    assert.strictEqual(res.status, 400, query);
    assert.strictEqual(queryLog.length, 0, query);
    assert.strictEqual(lastCall, null, query);
  }
});
