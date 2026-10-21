// Run: node --test  (from backend/)
//
// DRINK DEALS GO ONLY TO PEOPLE WE KNOW ARE 21 (utils/over21.js, App Store
// Guideline 1.4.3).
//
// Flock's floor is 13 and the iPhone app asks for no date of birth, so a venue
// promotion or a Ticketmaster event about alcohol is served only to an account
// whose stored date of birth makes it 21 today. This file pins the word list
// word for word, the matcher's edges, the age rule, and every serving path:
// /public-promotions, /public-events (a venue's own events on its card), the
// three Ticketmaster event endpoints (whose answers are cached for everyone in
// a cell, so the filter has to run per viewer on the way out), the crowd card's
// event name, and the path that carries neither (Birdie). The owner's own
// lists are pinned to stay whole.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

process.env.JWT_SECRET = 'over21-test-secret';
process.env.TICKETMASTER_API_KEY = 'tm-test-key'; // routes/events.js reads this at load
delete process.env.VENUE_BILLING_ENABLED;

const over21 = require('../utils/over21');
const pool = require('../config/database');

let handlers = [];
let log = [];
function dispatch(sql, params) {
  const text = String(sql).replace(/\s+/g, ' ').trim();
  log.push({ sql: text, params });
  for (const [re, fn] of handlers) {
    if (re.test(text)) {
      try {
        const out = fn(params || [], text);
        return Promise.resolve(out === undefined ? { rows: [], rowCount: 0 } : out);
      } catch (err) {
        return Promise.reject(err);
      }
    }
  }
  return Promise.reject(new Error(`unscripted query: ${text.slice(0, 140)}`));
}
pool.query = (sql, params) => dispatch(sql, params);

// Patched BEFORE the routers load: both destructure `authenticate` at require
// time and mount it with router.use().
const authMod = require('../middleware/auth');
let CURRENT_USER = { id: 42, name: 'Reader', role: 'user' };
authMod.authenticate = (req, _res, next) => { req.user = CURRENT_USER; next(); };

const realFetch = global.fetch;
let tmImpl = null;
let tmCalls = 0;
global.fetch = (url, opts) => {
  const u = String(url);
  if (u.startsWith('https://app.ticketmaster.com/')) {
    tmCalls += 1;
    try {
      return Promise.resolve(tmImpl ? tmImpl(u) : { ok: true, status: 200, json: async () => ({ _embedded: { events: [] } }) });
    } catch (e) {
      return Promise.reject(e);
    }
  }
  return realFetch(url, opts);
};

const venueDashboardRouter = require('../routes/venueDashboard');
const eventsRouter = require('../routes/events');

const app = express();
app.use(express.json());
app.use('/api/venue-dashboard', venueDashboardRouter);
app.use('/api/events', eventsRouter);

let base;
const server = http.createServer(app);
test.before(() => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); });
}));
test.after(() => new Promise((resolve) => {
  global.fetch = realFetch;
  server.close(() => resolve());
  pool.end?.().catch(() => {});
}));

test.beforeEach(() => {
  handlers = [];
  log = [];
  tmImpl = null;
  tmCalls = 0;
  CURRENT_USER = { id: 42, name: 'Reader', role: 'user' };
  venueDashboardRouter.__test.recentPromotionViews.clear();
  eventsRouter.__test.reset();
});

async function get(pathname, user) {
  if (user) CURRENT_USER = user;
  const res = await realFetch(base + pathname);
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, body, text };
}

const ran = (re) => log.filter((q) => re.test(q.sql));
const DOB_SQL = /^SELECT date_of_birth FROM users WHERE id = \$1$/;

// Birthdays relative to the real clock, since the routes judge age on it.
const thisYear = new Date().getUTCFullYear();
const AGE_30 = `${thisYear - 30}-01-01`;
const AGE_20 = `${thisYear - 20}-12-31`; // 19 or 20 depending on the day, never 21
const viewerDob = (dob) => [DOB_SQL, () => ({ rows: dob === undefined ? [] : [{ date_of_birth: dob }] })];

// ===========================================================================
// 1. The list, word for word
// ===========================================================================

test('the drink words are exactly the reviewed list', () => {
  assert.deepStrictEqual([...over21.DRINK_WORDS], [
    'beer', 'beers', 'ale', 'ales', 'ipa', 'ipas', 'lager', 'lagers', 'pilsner', 'pilsners',
    'pint', 'pints', 'drafts', 'on draft', 'cask', 'casks', 'keg', 'kegs',
    'brewery', 'breweries', 'brewpub', 'brewpubs', 'taproom', 'taprooms', 'oktoberfest', 'octoberfest',
    'wine', 'wines', 'winery', 'wineries', 'champagne', 'prosecco', 'mimosa', 'mimosas', 'sangria', 'sangrias',
    'spirits', 'liquor', 'liquors', 'whiskey', 'whiskeys', 'whisky', 'whiskies', 'bourbon', 'bourbons',
    'tequila', 'tequilas', 'mezcal', 'vodka', 'vodkas', 'rum', 'rums', 'gin',
    'cocktail', 'cocktails', 'margarita', 'margaritas', 'shots', 'seltzer', 'seltzers',
    'alcohol', 'alcoholic', 'booze', 'boozy', 'happy hour', 'happy hours', 'bottomless',
    'drink special', 'drink specials', 'drink deal', 'drink deals',
    'pub crawl', 'pub crawls', 'bar crawl', 'bar crawls',
    '21+', '21 and over', '21 and up', '21 & over', '21 & up',
  ]);
});

test('the tobacco, vape and cannabis words are exactly the reviewed list', () => {
  assert.deepStrictEqual([...over21.SMOKE_WORDS], [
    'hookah', 'hookahs', 'shisha', 'cigar', 'cigars', 'cigarette', 'cigarettes', 'tobacco',
    'vape', 'vapes', 'vaping', 'nicotine', 'cannabis', 'marijuana', 'thc', 'dispensary', 'dispensaries',
  ]);
  assert.deepStrictEqual([...over21.OVER_21_WORDS], [...over21.DRINK_WORDS, ...over21.SMOKE_WORDS]);
  assert.ok(Object.isFrozen(over21.DRINK_WORDS) && Object.isFrozen(over21.SMOKE_WORDS));
  assert.strictEqual(over21.OVER_21_AGE, 21);
});

test('every word on the list is caught in a sentence, in any case', () => {
  for (const w of over21.OVER_21_WORDS) {
    assert.ok(over21.mentionsOver21(`Tonight ${w} on the patio`), w);
    assert.ok(over21.mentionsOver21(`TONIGHT: ${w.toUpperCase()}!`), `${w} in capitals`);
  }
});

test('a phrase matches with spaces, hyphens or nothing between its words', () => {
  for (const t of ['Happy-Hour wings', '#happyhour', 'happy   hour', 'Bottomless mimosas', 'Comedy (21 and over)', 'Trivia 21+']) {
    assert.ok(over21.mentionsOver21(t), t);
  }
});

test('whole words only, and the words left off the list stay off', () => {
  for (const t of [
    'NFL Draft watch party', // "draft" alone is the draft, not a drink
    'Holiday drinks are back', 'Kids drink free', // drinks are coffee too
    'Cold brew Monday', 'Spirit week', 'Apple cider donuts',
    'Kale salad', 'Engine room trivia', 'Rumble arcade night', 'Ipanema bossa nova',
    'Ginés Live', // an accented letter is a letter: no "gin" here
    'Half-price wings', '18+ dance night', 'Pinball league', '',
  ]) {
    assert.strictEqual(over21.mentionsOver21(t), false, t);
  }
  assert.strictEqual(over21.mentionsOver21(null, undefined, 42, {}), false);
});

test('drinks with a price on them are a drink deal, unless the same promotion names a soft drink', () => {
  // How a bar writes one. The first is the example in the owner's own deal form.
  for (const t of [
    '2-for-1 drinks until 8pm', 'Two for one drinks', '$5 drinks all night', 'Drinks $4.50 till 9',
    'Half-price drinks on the patio', 'BOGO drinks', 'Buy one, get one drinks', '20% off drinks', 'Cheap drinks Thursday',
  ]) {
    assert.ok(over21.mentionsOver21(t), t);
  }
  // A cafe's deal names what the drinks are.
  for (const t of ['2-for-1 drinks: lattes and teas', '$3 drinks, smoothies and juice', 'Half-price drinks for kids: lemonade and soda']) {
    assert.strictEqual(over21.mentionsOver21(t), false, t);
  }
  assert.strictEqual(over21.promotionIsOver21({ title: '2-for-1 drinks', description: 'Any iced latte or cold brew' }), false);
  // A drink on the list still wins over a soft drink beside it.
  assert.strictEqual(over21.promotionIsOver21({ title: '2-for-1 drinks', description: 'Wells and drafts only' }), true);
  assert.strictEqual(over21.promotionIsOver21({ title: '2-for-1 drinks', description: 'Margaritas and sodas' }), true);
});

test('a promotion is read by its title, its description, its time slot and its days', () => {
  assert.strictEqual(over21.promotionIsOver21({ title: 'Half-price wings', description: null, time_slot: 'All Day', days: 'Daily' }), false);
  assert.strictEqual(over21.promotionIsOver21({ title: '$5 drafts' }), true);
  assert.strictEqual(over21.promotionIsOver21({ title: 'Wings', description: 'Two-for-one pints with any basket' }), true);
  // Shown as "Happy Hour · Daily" on the venue card, so it counts.
  assert.strictEqual(over21.promotionIsOver21({ title: 'Wings', time_slot: 'Happy Hour' }), true);
  assert.strictEqual(over21.promotionIsOver21(null), false);
});

test('the owner\'s own words in the time slot or the days are read like the menu values', () => {
  // The editor's Custom choice saves whatever the owner types into either box.
  assert.strictEqual(over21.promotionIsOver21({ title: 'Wings', time_slot: '5 to 7, happy hour', days: 'Daily' }), true);
  assert.strictEqual(over21.promotionIsOver21({ title: 'Wings', time_slot: 'All Day', days: 'Happy hour, Tuesday to Thursday' }), true);
  assert.strictEqual(over21.promotionIsOver21({ title: 'Wings', time_slot: 'All Day', days: 'Weekday #happyhour' }), true);
  // Drinks with a price on them, typed into the days, count like the same
  // words in the title.
  assert.strictEqual(over21.promotionIsOver21({ title: 'Wings', time_slot: 'All Day', days: '2-for-1 drinks Tuesday' }), true);
  // A soft drink typed into the time slot or the days excuses nothing. Those
  // boxes hold a schedule, and the rule errs toward hiding.
  assert.strictEqual(over21.promotionIsOver21({ title: '$5 drinks', time_slot: 'All Day', days: 'Daily, sodas too' }), true);
  assert.strictEqual(over21.promotionIsOver21({ title: '2-for-1 drinks', time_slot: 'Coffee hour, 2 to 4', days: 'Daily' }), true);
  // The deal naming its own drinks still excuses them.
  assert.strictEqual(over21.promotionIsOver21({ title: '$5 drinks', description: 'Sodas, lemonade and iced tea', time_slot: 'All Day', days: 'Daily' }), false);
  // A food deal on a custom schedule stays a food deal.
  assert.strictEqual(over21.promotionIsOver21({ title: 'Half-price wings', time_slot: '5 to 7pm', days: 'Tuesday to Thursday' }), false);
});

test('an event is read by its name, headliners and genres, never by its logistics notes', () => {
  const base = { name: 'Family Concert', attraction_name: 'The Band', genre: 'Rock', subgenre: 'Pop' };
  assert.strictEqual(over21.eventIsOver21(base), false);
  assert.strictEqual(over21.eventIsOver21({ ...base, info: 'Beer and wine for sale with ID.', please_note: 'No outside alcohol.' }), false);
  assert.strictEqual(over21.eventIsOver21({ ...base, name: 'Craft Beer Festival' }), true);
  assert.strictEqual(over21.eventIsOver21({ ...base, attraction_name: 'Whiskey Myers' }), true);
  assert.strictEqual(over21.eventIsOver21({ ...base, subgenre: 'Wine Tasting' }), true);
  assert.strictEqual(over21.eventIsOver21({ ...base, attractions: [{ name: 'The Band' }, { name: 'Bourbon Tour' }] }), true);
  assert.strictEqual(over21.eventIsOver21(null), false);
});

// ===========================================================================
// 2. The age rule
// ===========================================================================

test('21 by the stored date of birth, on the birthday and not the day before', () => {
  const now = new Date('2026-10-18T12:00:00Z');
  assert.strictEqual(over21.knownOver21('2005-10-18', now), true);
  assert.strictEqual(over21.knownOver21('2005-10-19', now), false);
  // A year-only signup is stored as 31 December, the younger end.
  assert.strictEqual(over21.knownOver21('2005-12-31', now), false);
  assert.strictEqual(over21.knownOver21('2010-01-01', now), false);
  assert.strictEqual(over21.knownOver21(new Date(2000, 0, 1), now), true); // what node-postgres returns
});

test('no date of birth, or one that is not a date, is not a known age', () => {
  for (const dob of [null, undefined, '', 'yesterday', '2005', '2005-02-30', 0]) {
    assert.strictEqual(over21.knownOver21(dob), false, String(dob));
  }
});

test('the viewer is read from users.date_of_birth, and any failure is "not known"', async () => {
  const fakeDb = (rows) => ({ calls: [], query(sql, params) { this.calls.push({ sql, params }); return Promise.resolve({ rows }); } });
  const adult = fakeDb([{ date_of_birth: AGE_30 }]);
  assert.strictEqual(await over21.viewerKnownOver21(adult, 9), true);
  assert.deepStrictEqual(adult.calls[0].params, [9]);
  assert.match(adult.calls[0].sql, DOB_SQL);
  assert.strictEqual(await over21.viewerKnownOver21(fakeDb([{ date_of_birth: AGE_20 }]), 9), false);
  assert.strictEqual(await over21.viewerKnownOver21(fakeDb([{ date_of_birth: null }]), 9), false);
  assert.strictEqual(await over21.viewerKnownOver21(fakeDb([]), 9), false);
  const broken = { query: () => Promise.reject(new Error('connection reset')) };
  assert.strictEqual(await over21.viewerKnownOver21(broken, 9), false);
  const untouched = fakeDb([{ date_of_birth: AGE_30 }]);
  assert.strictEqual(await over21.viewerKnownOver21(untouched, null), false);
  assert.strictEqual(untouched.calls.length, 0);
});

// ===========================================================================
// 3. /public-promotions
// ===========================================================================

const WINGS = { id: 11, title: 'Half-price wings', description: null, time_slot: 'All Day', days: 'Daily' };
const DRAFTS = { id: 12, title: '$5 drafts', description: null, time_slot: 'Late Night', days: 'Fri-Sun' };
const HAPPY = { id: 13, title: 'Wings basket', description: null, time_slot: 'Happy Hour', days: 'Daily' };

function scriptPromotions(rows, ...extra) {
  handlers = [
    [/^SELECT p\.id, p\.title, p\.description, p\.time_slot, p\.days FROM venue_promotions p/, () => ({ rows })],
    [/^UPDATE venue_promotions SET views = views \+ 1/, (params) => ({ rows: [], rowCount: (params[0] || []).length })],
    ...extra,
  ];
}
const viewIds = () => (ran(/^UPDATE venue_promotions SET views/)[0] || { params: [[]] }).params[0];

test('an account with no date of birth gets no drink deal, and only what it got is counted', async () => {
  scriptPromotions([WINGS, DRAFTS, HAPPY], viewerDob(null));
  const res = await get('/api/venue-dashboard/public-promotions/PLACE_A');
  assert.strictEqual(res.status, 200, res.text);
  assert.deepStrictEqual(res.body.promotions.map((p) => p.id), [11]);
  assert.deepStrictEqual(viewIds(), [11]);
  assert.deepStrictEqual(ran(DOB_SQL)[0].params, [42]);
});

test('an account we know is 21 gets every deal', async () => {
  scriptPromotions([WINGS, DRAFTS, HAPPY], viewerDob(AGE_30));
  const res = await get('/api/venue-dashboard/public-promotions/PLACE_A');
  assert.deepStrictEqual(res.body.promotions.map((p) => p.id), [11, 12, 13]);
  assert.deepStrictEqual(viewIds(), [11, 12, 13]);
});

test('an account under 21 gets no drink deal', async () => {
  scriptPromotions([WINGS, DRAFTS, HAPPY], viewerDob(AGE_20));
  const res = await get('/api/venue-dashboard/public-promotions/PLACE_A');
  assert.deepStrictEqual(res.body.promotions.map((p) => p.id), [11]);
});

test('a birthday that cannot be read hides the drink deals and still answers', async () => {
  scriptPromotions([WINGS, DRAFTS], [DOB_SQL, () => { throw new Error('connection reset'); }]);
  const res = await get('/api/venue-dashboard/public-promotions/PLACE_A');
  assert.strictEqual(res.status, 200, res.text);
  assert.deepStrictEqual(res.body.promotions.map((p) => p.id), [11]);
});

test('a venue with no drink deal costs no birthday read', async () => {
  scriptPromotions([WINGS]);
  const res = await get('/api/venue-dashboard/public-promotions/PLACE_A');
  assert.deepStrictEqual(res.body.promotions.map((p) => p.id), [11]);
  assert.strictEqual(ran(DOB_SQL).length, 0);
});

test('an account with nothing but drink deals to see gets an empty list and counts nothing', async () => {
  scriptPromotions([DRAFTS], viewerDob(undefined));
  const res = await get('/api/venue-dashboard/public-promotions/PLACE_A');
  assert.deepStrictEqual(res.body.promotions, []);
  assert.strictEqual(ran(/^UPDATE venue_promotions SET views/).length, 0);
});

test('the owner\'s own list still carries every deal it wrote', async () => {
  handlers = [
    [/FROM venue_profiles WHERE user_id = \$1/, () => ({ rows: [{ id: 7, google_place_id: 'PLACE_A', verified: true }] })],
    [/^SELECT \* FROM venue_promotions WHERE venue_user_id = \$1/, () => ({ rows: [WINGS, DRAFTS, HAPPY] })],
  ];
  const res = await get('/api/venue-dashboard/promotions', { id: 1, name: 'Owner', role: 'venue_owner' });
  assert.strictEqual(res.status, 200, res.text);
  assert.deepStrictEqual(res.body.promotions.map((p) => p.id), [11, 12, 13]);
  assert.strictEqual(ran(DOB_SQL).length, 0);
});

// ===========================================================================
// 3b. /public-events (a venue's own events, on its card)
// ===========================================================================
//
// The rows below are what the SELECT hands back, so they have already passed
// the verified, banned, hidden, deleted, date and reported tests the SQL runs
// (venuePublicEventsRealDb.test.js runs that SQL on a real Postgres). What is
// left to the route, and pinned here, is the 21 rule on the way out.

const dayAhead = (n) => new Date(Date.now() + n * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
const QUIZ = { id: 21, title: 'Quiz night', event_date: dayAhead(3), event_time: '8 PM' };
const WINE = { id: 22, title: 'Wine tasting', event_date: dayAhead(5), event_time: '7 PM' };
// Nothing in the title, and the time box says it.
const AFTER = { id: 23, title: 'Open mic', event_date: dayAhead(6), event_time: 'happy hour first' };
const scriptEvents = (rows, ...extra) => {
  handlers = [[/^SELECT e\.id, e\.title, e\.event_date, e\.event_time FROM venue_events e/, () => ({ rows })], ...extra];
};
const eventIds = (res) => res.body.events.map((e) => e.id);

test('a venue event about drinks reaches only an account we know is 21', async () => {
  scriptEvents([QUIZ, WINE, AFTER], dobByUser);
  const unknown = await get('/api/venue-dashboard/public-events/PLACE_A', UNKNOWN);
  assert.strictEqual(unknown.status, 200, unknown.text);
  assert.deepStrictEqual(eventIds(unknown), [21]);
  const adult = await get('/api/venue-dashboard/public-events/PLACE_A', ADULT);
  assert.deepStrictEqual(eventIds(adult), [21, 22, 23]);
});

test('an event under 21 cannot see is left out for an account under 21 too', async () => {
  scriptEvents([QUIZ, WINE], viewerDob(AGE_20));
  const res = await get('/api/venue-dashboard/public-events/PLACE_A');
  assert.deepStrictEqual(eventIds(res), [21]);
});

test('a birthday that cannot be read hides the drink events and still answers', async () => {
  scriptEvents([QUIZ, WINE], [DOB_SQL, () => { throw new Error('connection reset'); }]);
  const res = await get('/api/venue-dashboard/public-events/PLACE_A');
  assert.strictEqual(res.status, 200, res.text);
  assert.deepStrictEqual(eventIds(res), [21]);
});

test('a venue with no drink event costs no birthday read', async () => {
  scriptEvents([QUIZ]);
  const res = await get('/api/venue-dashboard/public-events/PLACE_A');
  assert.deepStrictEqual(eventIds(res), [21]);
  assert.strictEqual(ran(DOB_SQL).length, 0);
});

test('every box a venue event card prints is read, and only the title can say the drinks are soft', () => {
  const ev = (title, event_time = null, event_date = '2026-11-20') => ({ title, event_date, event_time });
  assert.strictEqual(over21.venueEventIsOver21(ev('Trivia night', '8 PM')), false);
  assert.strictEqual(over21.venueEventIsOver21(ev('Craft beer flight night')), true);
  assert.strictEqual(over21.venueEventIsOver21(ev('Open mic', 'happy hour 5-7')), true);
  assert.strictEqual(over21.venueEventIsOver21(ev('Open mic', '9 PM', '21+ only, Nov 20')), true);
  assert.strictEqual(over21.venueEventIsOver21(ev('$5 drinks all night')), true);
  assert.strictEqual(over21.venueEventIsOver21(ev('$3 drinks: lemonade and iced tea')), false);
  // A soft drink typed into the time box does not excuse the priced drinks.
  assert.strictEqual(over21.venueEventIsOver21(ev('$5 drinks', 'sodas too')), true);
  assert.strictEqual(over21.venueEventIsOver21(null), false);
});

// ===========================================================================
// 4. The event endpoints
// ===========================================================================

const tmEvent = (id, name, extra = {}) => ({
  id,
  name,
  url: 'https://www.ticketmaster.com/x',
  dates: {
    start: { localDate: '2026-11-20', localTime: '19:00:00', dateTime: '2026-11-21T00:00:00Z' },
    status: { code: 'onsale' },
    timezone: 'America/New_York',
  },
  classifications: [{ segment: { name: 'Music' }, genre: { name: 'Rock' } }],
  _embedded: {
    venues: [{
      name: 'Hall', city: { name: 'Philadelphia' }, state: { stateCode: 'PA' },
      address: { line1: '1 Main St' }, location: { latitude: '39.95', longitude: '-75.16' },
    }],
  },
  ...extra,
});
const SHOW = tmEvent('evtShow1', 'Test Show');
const BEERFEST = tmEvent('evtBeer1', 'Craft Beer Festival');
// Logistics notes that mention alcohol do not make a family concert a drink event.
const FAMILY = tmEvent('evtFamily1', 'Family Concert', { pleaseNote: 'No outside alcohol.', info: 'Beer and wine for sale with ID.' });
const listOf = (...events) => () => ({ ok: true, status: 200, json: async () => ({ _embedded: { events } }) });

const UNKNOWN = { id: 42, name: 'Reader', role: 'user' };
const ADULT = { id: 43, name: 'Adult', role: 'user' };
// The birthday answer follows whoever is asking.
const dobByUser = [DOB_SQL, (params) => ({ rows: [{ date_of_birth: params[0] === ADULT.id ? AGE_30 : null }] })];

const names = (res) => res.body.events.map((e) => e.name);

test('event search leaves drink events out for an account we do not know is 21', async () => {
  handlers = [dobByUser];
  tmImpl = listOf(SHOW, BEERFEST, FAMILY);
  const res = await get('/api/events/search?location=39.95,-75.16', UNKNOWN);
  assert.strictEqual(res.status, 200, res.text);
  assert.deepStrictEqual(names(res), ['Test Show', 'Family Concert']);
  assert.strictEqual(res.body.total, 2);
});

test('the cell cache holds the whole list and each viewer is filtered on the way out', async () => {
  handlers = [dobByUser];
  tmImpl = listOf(SHOW, BEERFEST, FAMILY);
  const first = await get('/api/events/search?location=39.95,-75.16', UNKNOWN);
  const adult = await get('/api/events/search?location=39.95,-75.16', ADULT);
  const again = await get('/api/events/search?location=39.95,-75.16', UNKNOWN);
  assert.strictEqual(tmCalls, 1, 'the second and third answers came from the cache');
  assert.deepStrictEqual(names(first), ['Test Show', 'Family Concert']);
  assert.deepStrictEqual(names(adult), ['Test Show', 'Craft Beer Festival', 'Family Concert']);
  assert.strictEqual(adult.body.total, 3);
  assert.deepStrictEqual(names(again), ['Test Show', 'Family Concert']);
});

test('featured events are filtered the same way', async () => {
  handlers = [dobByUser];
  tmImpl = listOf(BEERFEST, SHOW);
  const res = await get('/api/events/featured?location=39.95,-75.16', UNKNOWN);
  assert.strictEqual(res.status, 200, res.text);
  assert.deepStrictEqual(names(res), ['Test Show']);
  const adult = await get('/api/events/featured?location=39.95,-75.16', ADULT);
  assert.deepStrictEqual(names(adult), ['Craft Beer Festival', 'Test Show']);
});

test('a drink event\'s own page is not found for an account we do not know is 21', async () => {
  handlers = [dobByUser];
  tmImpl = () => ({ ok: true, status: 200, json: async () => BEERFEST });
  const adult = await get('/api/events/details?id=evtBeer1', ADULT);
  assert.strictEqual(adult.status, 200, adult.text);
  assert.strictEqual(adult.body.event.name, 'Craft Beer Festival');
  const unknown = await get('/api/events/details?id=evtBeer1', UNKNOWN);
  assert.strictEqual(unknown.status, 404);
  assert.deepStrictEqual(unknown.body, { error: 'Event not found' });
});

test('a list with no drink event costs no birthday read', async () => {
  handlers = [dobByUser];
  tmImpl = listOf(SHOW, FAMILY);
  const res = await get('/api/events/search?location=39.95,-75.16', UNKNOWN);
  assert.deepStrictEqual(names(res), ['Test Show', 'Family Concert']);
  assert.strictEqual(ran(DOB_SQL).length, 0);
});

// ===========================================================================
// 5. The paths that are pinned by their source
// ===========================================================================

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

test('the crowd card drops a drink event\'s name for every viewer', () => {
  const src = read('routes/crowd.js');
  assert.match(src, /require\('\.\.\/utils\/over21'\)/);
  assert.match(src, /eventName: mentionsOver21\(crowdResult\.eventAlert\.eventName\) \? null : crowdResult\.eventAlert\.eventName,/);
});

test('Birdie is handed no promotion and no event, so it has none to repeat', () => {
  // Its tools and its context line were read for this: venues, crowd numbers
  // without the event alert, the user's own plans and friends, weather. If any
  // of these ever appears here, the 21 rule has to come with it.
  const src = read('routes/ai.js');
  assert.doesNotMatch(src, /venue_promotions|venue_events|eventAlert|nearestName|app\.ticketmaster\.com|\/api\/events/);
});

test('venue events reach their owner, admins, moderators, and the venue card through ONE gated read', () => {
  // Until 2026-10-20 this pinned "nobody but the owner, admins and moderators".
  // GET /public-events is the one change to that: a single read, gated the way
  // the promotions read is, with the 21 rule on its way out.
  const readers = fs.readdirSync(path.join(__dirname, '..', 'routes'))
    .filter((f) => f.endsWith('.js') && /venue_events/.test(read(`routes/${f}`)))
    .sort();
  assert.deepStrictEqual(readers, ['admin.js', 'moderation.js', 'venueDashboard.js']);
  const src = read('routes/venueDashboard.js').replace(/\r\n/g, '\n');
  // In the dashboard, every read of the table is scoped to the caller's own
  // rows, except that one.
  const reads = src.match(/FROM venue_events[^`']*/g) || [];
  assert.ok(reads.length > 1);
  const unscoped = reads.filter((r) => !/venue_user_id = \$/.test(r));
  assert.strictEqual(unscoped.length, 1, unscoped.join('\n---\n'));
  const at = src.indexOf("router.get('/public-events/:placeId'");
  assert.ok(at > 0, 'the public read lives in GET /public-events');
  const route = src.slice(at, src.indexOf('\n});', at));
  assert.ok(route.includes(unscoped[0].trim()), 'the one unscoped read is the public route');
  for (const gate of [
    /AND vp\.verified = true/,
    /JOIN users ou ON ou\.id = vp\.user_id AND ou\.is_banned IS NOT TRUE/,
    /COALESCE\(e\.is_hidden, false\) = false/,
    /e\.owner_deleted_at IS NULL/,
    /btrim\(e\.event_date\) >= \$2/,
    /cr\.content_type = 'venue_event' AND cr\.content_id = e\.id AND cr\.reporter_id = \$3/,
    /served\.some\(venueEventIsOver21\) && !\(await viewerKnownOver21\(pool, req\.user\.id\)\)/,
  ]) assert.match(route, gate);
});
