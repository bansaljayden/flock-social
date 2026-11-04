// Run: node --test  (from backend/)
//
// ===========================================================================
// A DEAL CAN RUN ON ONE DAY OF THE WEEK (2026-11-03).
//
// The promotion editor's Days Active menu gained Mondays through Sundays
// beside Daily, Weekdays, Weekends and Fri-Sun (frontend App.js PROMO_DAYS;
// frontend __tests__/promoSingleDays.test.js), so a Monday quiz night can say
// Mondays instead of posting as Weekdays. This is the server's half:
//
//   1. POST and PUT /api/venue-dashboard/promotions take every one of them
//      through the real route chain (shape check, markup strip, 60-character
//      cap, profanity screen) and bind it as written. Days are free text there
//      and nothing on the server keeps a list of allowed values; this pins
//      that none of the seven trips a check on the way.
//   2. Birdie's readers of a deal's days take them too: the carded-deal check
//      and the prompt both cap the words at 60 characters (routes/ai.js), and
//      the longest day, "Wednesdays", is 10.
//   3. The drink-deal rule (utils/over21.js promotionIsOver21, which reads the
//      title, description, time slot and days) gives a deal on any one day the
//      answer it gives the same deal on Daily: a day's name is never a drink
//      word, never a soft drink, and never a price.
// The database is faked; what Postgres makes of the statements is
// __tests__/sqlParameterTypes.test.js's job.
// ===========================================================================

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const express = require('express');

process.env.JWT_SECRET = 'promotion-single-days-test-secret';
delete process.env.VENUE_BILLING_ENABLED;
delete process.env.GOOGLE_PLACES_API_KEY;

const SINGLE_DAYS = ['Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays', 'Sundays'];

const pool = require('../config/database');

// Every statement, flattened, with its parameters.
let log = [];
pool.query = async (sql, params) => {
  const flat = String(sql).replace(/\s+/g, ' ').trim();
  log.push({ sql: flat, params: params || [] });
  if (/^INSERT INTO venue_promotions/.test(flat)) {
    const [venueUserId, placeId, title, description, timeSlot, days] = params;
    return { rows: [{ id: 41, venue_user_id: venueUserId, google_place_id: placeId, title, description, time_slot: timeSlot, days }], rowCount: 1 };
  }
  if (/^WITH target AS/.test(flat) && /UPDATE venue_promotions SET/.test(flat)) {
    return { rows: [{ target_hidden: false, id: 2, title: params[0], time_slot: params[2], days: params[3] }], rowCount: 1 };
  }
  if (/FROM venue_profiles WHERE user_id = \$1/.test(flat)) {
    return { rows: [{ id: 1, google_place_id: 'PLACE_A', verified: true }], rowCount: 1 };
  }
  return { rows: [], rowCount: 0 };
};
pool.connect = async () => ({ query: pool.query, release: () => {} });

const authMod = require('../middleware/auth');
authMod.authenticate = (req, _res, next) => { req.user = { id: 7, name: 'Owner', role: 'venue_owner' }; next(); };

const venueDashboardRouter = require('../routes/venueDashboard');
const { promotionIsOver21 } = require('../utils/over21');

const app = express();
app.use(express.json());
app.set('io', null);
app.use('/api/venue-dashboard', venueDashboardRouter);

let base;
const server = http.createServer(app);
test.before(() => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); });
}));
test.after(() => new Promise((resolve) => {
  server.close(() => resolve());
  pool.end?.().catch(() => {});
}));

async function send(method, url, body) {
  log = [];
  const res = await fetch(`${base}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

test('a new deal on any one day of the week is created with that day, as written', async () => {
  for (const day of SINGLE_DAYS) {
    // eslint-disable-next-line no-await-in-loop
    const res = await send('POST', '/api/venue-dashboard/promotions', { title: 'Quiz night', description: 'Teams of up to six', timeSlot: 'All Day', days: day });
    assert.strictEqual(res.status, 201, `${day}: ${JSON.stringify(res.body)}`);
    const insert = log.find((q) => /^INSERT INTO venue_promotions/.test(q.sql));
    assert.ok(insert, `${day}: the deal never reached the database`);
    assert.strictEqual(insert.params[5], day);
    assert.strictEqual(res.body.days, day);
  }
});

test('an edit to any one day of the week saves that day, as written', async () => {
  for (const day of SINGLE_DAYS) {
    // eslint-disable-next-line no-await-in-loop
    const res = await send('PUT', '/api/venue-dashboard/promotions/2', { title: 'Quiz night', timeSlot: 'Late Night', days: day });
    assert.strictEqual(res.status, 200, `${day}: ${JSON.stringify(res.body)}`);
    const update = log.find((q) => /UPDATE venue_promotions SET/.test(q.sql));
    assert.ok(update, `${day}: the edit never reached the database`);
    assert.strictEqual(update.params[3], day);
  }
});

test('Birdie\'s readers of a deal\'s days hold the longest day with room to spare', () => {
  const ai = fs.readFileSync(path.join(__dirname, '..', 'routes', 'ai.js'), 'utf8');
  const longest = Math.max(...SINGLE_DAYS.map((d) => d.length));
  for (const name of ['CARDED_DEAL_WHEN_CHARS', 'MAX_DEAL_WHEN_CHARS']) {
    const m = new RegExp(`const ${name} = (\\d+);`).exec(ai);
    assert.ok(m, `${name} is no longer a number in routes/ai.js`);
    assert.ok(Number(m[1]) >= longest, `${name} (${m[1]}) cuts "${SINGLE_DAYS.find((d) => d.length === longest)}"`);
  }
});

test('the drink-deal rule answers a deal on one day exactly as it answers the same deal on Daily', () => {
  const deals = [
    { title: 'Monday quiz night', description: 'Teams of up to six', time_slot: 'All Day' },
    { title: 'Half-price wings', description: null, time_slot: 'Late Night' },
    { title: 'Wings', description: null, time_slot: 'Happy Hour' },
    { title: '$5 drafts', description: null, time_slot: 'Late Night' },
    { title: '$5 drinks', description: null, time_slot: 'All Day' },
    { title: '2-for-1 drinks', description: 'Any iced latte or cold brew', time_slot: 'Mornings' },
    { title: 'Trivia', description: 'Two-for-one pints with any basket', time_slot: 'All Day' },
  ];
  for (const deal of deals) {
    const onDaily = promotionIsOver21({ ...deal, days: 'Daily' });
    for (const day of SINGLE_DAYS) {
      assert.strictEqual(promotionIsOver21({ ...deal, days: day }), onDaily, `${deal.title} on ${day}`);
    }
  }
  // The answers themselves, so the comparison above cannot pass by every
  // deal reading false.
  assert.strictEqual(promotionIsOver21({ title: 'Monday quiz night', time_slot: 'All Day', days: 'Mondays' }), false);
  assert.strictEqual(promotionIsOver21({ title: 'Wings', time_slot: 'Happy Hour', days: 'Thursdays' }), true);
  assert.strictEqual(promotionIsOver21({ title: '$5 drinks', time_slot: 'All Day', days: 'Fridays' }), true);
  assert.strictEqual(promotionIsOver21({ title: '2-for-1 drinks', description: 'Any iced latte or cold brew', time_slot: 'Mornings', days: 'Sundays' }), false);
});
