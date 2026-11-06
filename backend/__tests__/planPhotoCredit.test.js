// Run: node --test  (from backend/)
//
// ---------------------------------------------------------------------------
// THE PLAN'S PHOTO IS DRAWN WITH GOOGLE'S CREDIT, worked out when it opens.
// ---------------------------------------------------------------------------
// The plan screen draws its venue's photo at about 362 by 170, and a Places
// photo drawn at that size carries the photographer's name. The plan row keeps
// only the photo's URL (flocks.venue_photo_url); a credit is Places content and
// is not stored. So GET /api/flocks/:id/venue-photo works the credit out when a
// plan opens (routes/venueSearch.js currentPhotoCredit) and answers the photo to
// draw beside it. What this file pins:
//
//   1. which photo: the stored one while Google lists it, else the photo the
//      proxy's heal serves for an expired name, and the two are one photograph;
//   2. the credit is that photo's own, or nothing is drawn;
//   3. the door: members only, the stored name must be the plan's own place;
//   4. the money: free when a venue card is warm, else one photos-only request
//      on the free SKU, charged as the photo proxy charges, and coalesced;
//   5. nothing is kept, and no list asks.
//
// Driven over HTTP through the real routes and the real Places ledger. Google
// and Postgres are stood in for, as in __tests__/photoHeal.test.js: nothing
// leaves the process, and the "photo" bytes are short strings made up here.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

// Captured at load by routes/venueSearch.js; the details cache reads it per call.
process.env.GOOGLE_PLACES_API_KEY = 'test-places-key-never-sent';
process.env.JWT_SECRET = 'plan-photo-credit-test-secret';

// The Places ledger keys its counters on the UTC day.
const { pinClock } = require('./helpers/pinnedClock');
const pinnedClock = pinClock(Date.UTC(2026, 6, 15, 12, 0, 0));
test.after(() => pinnedClock.restore());

// --- Postgres: two plans, their rosters, and the photo proxy's two tables ----
const pool = require('../config/database');
const db = { photos: new Map(), charges: 0, flocks: new Map(), members: new Map() };
const unknown = [];
pool.query = (text, params = []) => {
  const sql = String(text && text.text ? text.text : text).replace(/\s+/g, ' ').trim();
  if (sql === 'SELECT status FROM flock_members WHERE flock_id = $1 AND user_id = $2') {
    const status = (db.members.get(Number(params[0])) || {})[Number(params[1])];
    return Promise.resolve(status ? { rows: [{ status }], rowCount: 1 } : { rows: [], rowCount: 0 });
  }
  if (sql === 'SELECT venue_id, venue_photo_url FROM flocks WHERE id = $1') {
    const f = db.flocks.get(Number(params[0]));
    return Promise.resolve(f ? { rows: [{ ...f }], rowCount: 1 } : { rows: [], rowCount: 0 });
  }
  if (/DELETE FROM places_photo_cache/i.test(sql)) return Promise.resolve({ rows: [], rowCount: 0 });
  if (/FROM places_photo_cache/i.test(sql)) {
    const row = db.photos.get(params[0]);
    if (!row) return Promise.resolve({ rows: [], rowCount: 0 });
    return Promise.resolve({
      rows: [{ content_type: row.contentType, bytes: row.bytes, fetched_at: new Date(row.at) }],
      rowCount: 1,
    });
  }
  if (/INTO places_photo_cache/i.test(sql)) {
    db.photos.set(params[0], { contentType: params[1], bytes: params[2], at: Date.now() });
    return Promise.resolve({ rows: [], rowCount: 1 });
  }
  if (/INTO places_photo_spend/i.test(sql)) {
    db.charges += 1;
    return Promise.resolve({ rows: [{ fetches: db.charges, day: '2026-07-15' }], rowCount: 1 });
  }
  if (/UPDATE places_photo_spend/i.test(sql)) return Promise.resolve({ rows: [{ fetches: 0 }], rowCount: 1 });
  if (/FROM places_photo_spend/i.test(sql)) {
    return Promise.resolve({ rows: [{ month_used: db.charges, day_used: db.charges }], rowCount: 1 });
  }
  unknown.push(sql);
  return Promise.resolve({ rows: [], rowCount: 0 });
};

// --- who is asking: x-test-user names the account ------------------------------
const authMod = require('../middleware/auth');
authMod.authenticate = (req, res, next) => {
  const id = Number(req.headers['x-test-user']);
  if (!id) return res.status(401).json({ error: 'Sign in' });
  req.user = { id, name: `User ${id}` };
  return next();
};

// --- Google ----------------------------------------------------------------------
const V1 = 'https://places.googleapis.com/v1/';
const DETAILS = `${V1}places/`;
const CDN = 'https://cdn.example/';
const calls = [];
const expired = new Set(); // names the /media leg answers 400 INVALID_ARGUMENT
const places = new Map(); // placeId -> Places (New) payload
let holdDetails = null;

const INVALID_NAME = JSON.stringify({
  error: {
    code: 400,
    message: 'The photo resource in the request is invalid. Please retrieve it from Places API endpoints.',
    status: 'INVALID_ARGUMENT',
  },
});

const realFetch = global.fetch;
global.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.startsWith(V1) && u.includes('/media?')) {
    const name = u.slice(V1.length, u.indexOf('/media?'));
    calls.push({ kind: 'media', name });
    if (expired.has(name)) return { ok: false, status: 400, text: async () => INVALID_NAME };
    return { ok: true, status: 200, json: async () => ({ photoUri: CDN + encodeURIComponent(name) }) };
  }
  if (u.startsWith(DETAILS)) {
    const placeId = decodeURIComponent(u.slice(DETAILS.length));
    const mask = (opts.headers && opts.headers['X-Goog-FieldMask']) || '';
    calls.push({ kind: 'details', placeId, mask });
    if (holdDetails) await holdDetails;
    const place = places.get(placeId);
    if (!place) {
      return { ok: false, status: 404, json: async () => ({ error: { code: 404, message: 'Requested entity was not found.', status: 'NOT_FOUND' } }) };
    }
    // Answers what the mask asks for, the way Google does.
    const fields = mask.split(',').map((s) => s.trim());
    const body = {};
    for (const f of fields) if (Object.prototype.hasOwnProperty.call(place, f)) body[f] = place[f];
    return { ok: true, status: 200, json: async () => body };
  }
  if (u.startsWith(CDN)) {
    const name = decodeURIComponent(u.slice(CDN.length));
    calls.push({ kind: 'cdn', name });
    const bytes = Buffer.from(`pixels of ${name}`);
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'image/jpeg' },
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
    };
  }
  throw new Error(`a test reached for the network: ${u}`);
};
test.after(() => { global.fetch = realFetch; });

// Made-up place and photo names in Google's shapes.
const P = 'ChIJplanPhotoPlace01';
const OTHER = 'ChIJsomeOtherPlace01';
const FIRST = `places/${P}/photos/AU_current_first_photo`;
const SECOND = `places/${P}/photos/AU_current_second_photo`;
const EXPIRED = `places/${P}/photos/AU_name_the_plan_kept_that_google_expired`;

const author = (name, n) => ({
  authorAttributions: [{ displayName: name, uri: `//maps.google.com/maps/contrib/${n}`, photoUri: `//lh3.googleusercontent.com/a/${n}` }],
  googleMapsUri: `https://www.google.com/maps/place//data=!3m4!1e2!3m2!1s${n}`,
});
const PHOTO_FIRST = { name: FIRST, widthPx: 1200, heightPx: 800, ...author('Dana Reyes', 111) };
const PHOTO_SECOND = { name: SECOND, widthPx: 1200, heightPx: 800, ...author('Lee Park', 222) };
const CREDIT_FIRST = { name: 'Dana Reyes', uri: 'https://maps.google.com/maps/contrib/111', maps_uri: 'https://www.google.com/maps/place//data=!3m4!1e2!3m2!1s111' };
const CREDIT_SECOND = { name: 'Lee Park', uri: 'https://maps.google.com/maps/contrib/222', maps_uri: 'https://www.google.com/maps/place//data=!3m4!1e2!3m2!1s222' };

const proxyUrl = (name, width = 400) => `/api/venues/photo?ref=${encodeURIComponent(name)}&maxwidth=${width}`;

// A place as Google answers it: `photos` for the photos-only mask, the rest for
// a venue card's full mask.
function placeWithPhotos(placeId, photos) {
  places.set(placeId, {
    id: placeId,
    displayName: { text: 'The Copper Finch' },
    formattedAddress: '214 Main St',
    rating: 4.6,
    userRatingCount: 88,
    photos,
  });
}

// Plan 1 at P: Ava (7) is in it, Cole (8) was invited, Mo (9) is a stranger.
function planWithPhoto(storedUrl, placeId = P) {
  db.flocks.set(1, { venue_id: placeId, venue_photo_url: storedUrl });
  db.members.set(1, { 7: 'accepted', 8: 'invited' });
}

// --- the real routes and the real ledger ----------------------------------------
const venueSearch = require('../routes/venueSearch');
const vs = venueSearch.__test;
const flocksRouter = require('../routes/flocks');
const placeDetailsCache = require('../services/placeDetailsCache');
const { placesBudgetStatus, allowGlobalPlacesCall, __resetPlacesBudget } = require('../utils/placesBudget');

const app = express();
app.use('/api/venues', venueSearch);
app.use('/api/flocks', flocksRouter);
const server = http.createServer(app);
let base;
test.before(() => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); });
}));
test.after(() => new Promise((resolve) => server.close(() => resolve())));

// The proxy logs every refusal; some tests make them on purpose.
const realError = console.error;
test.before(() => { console.error = () => {}; });
test.after(() => { console.error = realError; });

test.beforeEach(() => {
  vs.clearPhotoCache();
  vs.resetPhotoBudget();
  vs.deadPhotoRefs.clear();
  vs.healedPlaces.clear();
  placeDetailsCache.__test.reset();
  __resetPlacesBudget();
  db.photos.clear();
  db.charges = 0;
  db.flocks.clear();
  db.members.clear();
  calls.length = 0;
  expired.clear();
  places.clear();
  holdDetails = null;
  unknown.length = 0;
});

function request(pathname, userId) {
  return new Promise((resolve, reject) => {
    http.get(`${base}${pathname}`, { headers: userId ? { 'x-test-user': String(userId) } : {} }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let body = null;
        try { body = JSON.parse(text); } catch { body = null; }
        resolve({ status: res.statusCode, headers: res.headers, text, body });
      });
    }).on('error', reject);
  });
}

const askCredit = (userId = 7) => request('/api/flocks/1/venue-photo', userId);
const photo = (url) => request(url);
const lookups = () => calls.filter((c) => c.kind === 'details');
const NOTHING = { photo_url: null, photo_attribution: null };

// =============================================================================
// 1. Which photo
// =============================================================================

test('the rule: the stored photo while Google lists it, else the heal\'s pick', () => {
  const { currentPhotoFor } = venueSearch;
  // Listed, and not first: the plan keeps its own photograph.
  assert.equal(currentPhotoFor([PHOTO_FIRST, PHOTO_SECOND], SECOND), PHOTO_SECOND);
  // Not listed: the first current photo, which is what healDeadPhoto serves.
  assert.equal(currentPhotoFor([PHOTO_FIRST, PHOTO_SECOND], EXPIRED), PHOTO_FIRST);
  // Malformed names and holes are stepped over, as the heal steps over them.
  assert.equal(currentPhotoFor([null, { name: 'not a photo name' }, PHOTO_SECOND], EXPIRED), PHOTO_SECOND);
  assert.equal(currentPhotoFor([], EXPIRED), null);
  assert.equal(currentPhotoFor(undefined, EXPIRED), null);
  // A name Google refused today is never the pick, listed or not.
  vs.rememberDeadPhotoRef(FIRST);
  assert.equal(currentPhotoFor([PHOTO_FIRST, PHOTO_SECOND], FIRST), PHOTO_SECOND);
  assert.equal(currentPhotoFor([PHOTO_FIRST, PHOTO_SECOND], EXPIRED), PHOTO_SECOND);
});

test('a plan whose photo Google still lists is handed that photo and its own credit', async () => {
  placeWithPhotos(P, [PHOTO_FIRST, PHOTO_SECOND]);
  planWithPhoto(proxyUrl(SECOND, 600));

  const res = await askCredit();
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(res.body, { photo_url: proxyUrl(SECOND), photo_attribution: CREDIT_SECOND });
  // One photos-only request, on the free SKU's fields.
  assert.deepEqual(lookups().map((c) => c.mask), ['id,photos']);
  assert.match(res.headers['cache-control'], /no-store/);
  assert.deepEqual(unknown, []);
});

test('an expired name: the credit names the photo the proxy heals it to, byte for byte', async () => {
  placeWithPhotos(P, [PHOTO_FIRST, PHOTO_SECOND]);
  expired.add(EXPIRED);
  planWithPhoto(proxyUrl(EXPIRED));

  const credit = await askCredit();
  assert.deepEqual(credit.body, { photo_url: proxyUrl(FIRST), photo_attribution: CREDIT_FIRST });

  // The chat list's tile asks for the stored URL and gets the heal; the plan
  // draws the URL it was handed. One photograph, and the credit is its own.
  const healed = await photo(proxyUrl(EXPIRED));
  const drawn = await photo(credit.body.photo_url);
  assert.equal(healed.status, 200);
  assert.equal(drawn.status, 200);
  assert.equal(healed.text, `pixels of ${FIRST}`);
  assert.equal(drawn.text, healed.text);
});

test('Google refused the first current photo too: the credit and the heal both pass it over', async () => {
  placeWithPhotos(P, [PHOTO_FIRST, PHOTO_SECOND]);
  expired.add(EXPIRED);
  expired.add(FIRST);
  planWithPhoto(proxyUrl(EXPIRED));
  // FIRST is asked for, refused and remembered dead, the way a tile learns it
  // (and healed to SECOND on the way, which is the rule under test).
  assert.equal((await photo(proxyUrl(FIRST))).text, `pixels of ${SECOND}`);
  assert.equal(vs.deadPhotoRefs.size, 1);

  const credit = await askCredit();
  assert.deepEqual(credit.body, { photo_url: proxyUrl(SECOND), photo_attribution: CREDIT_SECOND });
  const healed = await photo(proxyUrl(EXPIRED));
  assert.equal(healed.text, `pixels of ${SECOND}`);
  assert.equal((await photo(credit.body.photo_url)).text, healed.text);
});

// =============================================================================
// 2. The credit is the photo's own, or nothing is drawn
// =============================================================================

test('a place with no photos answers two nulls, and the plan draws its map', async () => {
  placeWithPhotos(P, []);
  planWithPhoto(proxyUrl(EXPIRED));
  const res = await askCredit();
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, NOTHING);
});

test('a photo Google sent no credit for is not handed over to be drawn without one', async () => {
  placeWithPhotos(P, [{ name: FIRST }, PHOTO_SECOND]);
  planWithPhoto(proxyUrl(FIRST));
  assert.deepEqual((await askCredit()).body, NOTHING);
});

test('a place Google no longer knows answers two nulls', async () => {
  planWithPhoto(proxyUrl(EXPIRED));
  assert.deepEqual((await askCredit()).body, NOTHING);
  assert.equal(lookups().length, 1);
});

// =============================================================================
// 3. The door
// =============================================================================

test('only an accepted member is answered, and nobody else costs a Google call', async () => {
  placeWithPhotos(P, [PHOTO_FIRST]);
  planWithPhoto(proxyUrl(FIRST));
  for (const who of [8, 9]) {
    const res = await askCredit(who);
    assert.equal(res.status, 404, `user ${who} was answered`);
    assert.ok(!res.text.includes('AU_current'), `user ${who} was handed a photo name`);
  }
  assert.equal((await request('/api/flocks/2/venue-photo', 7)).status, 404, 'a plan that does not exist');
  assert.equal((await askCredit(null)).status, 401);
  assert.equal(calls.length, 0);
});

test('a stored photo of some other place answers nothing, and no Google call is made about either', async () => {
  placeWithPhotos(P, [PHOTO_FIRST]);
  placeWithPhotos(OTHER, [{ ...PHOTO_FIRST, name: `places/${OTHER}/photos/AU_x` }]);
  planWithPhoto(proxyUrl(`places/${OTHER}/photos/AU_x`));
  assert.deepEqual((await askCredit()).body, NOTHING);
  assert.equal(calls.length, 0);
});

test('a plan with no venue id, no photo, or a URL that is not ours answers nothing for nothing', async () => {
  placeWithPhotos(P, [PHOTO_FIRST]);
  for (const [venueId, url] of [
    [null, proxyUrl(FIRST)],
    [P, null],
    [P, 'https://evil.example/pixel.gif'],
    [P, '/api/venues/photo?maxwidth=400'],
    [P, `/api/venues/photo?ref=${encodeURIComponent('places/../photos/x')}`],
  ]) {
    db.flocks.set(1, { venue_id: venueId, venue_photo_url: url });
    db.members.set(1, { 7: 'accepted' });
    const res = await askCredit();
    assert.equal(res.status, 200, String(url));
    assert.deepEqual(res.body, NOTHING, String(url));
  }
  assert.equal(calls.length, 0);
});

// =============================================================================
// 4. The money
// =============================================================================

test('the lookup is one unit of the shared day, marked as the photo proxy\'s', async () => {
  placeWithPhotos(P, [PHOTO_FIRST]);
  planWithPhoto(proxyUrl(FIRST));
  await askCredit();
  const after = placesBudgetStatus();
  assert.equal(after.globalUsed, 1);
  assert.equal(after.unauthUsed, 1);
  assert.equal(after.photoUsed, 1, 'priced as the free photos-only SKU, not as Enterprise Details');
  assert.equal(db.charges, 0, 'no photo was bought to answer a credit');
});

test('a venue card opened in the last ten minutes answers for nothing', async () => {
  placeWithPhotos(P, [PHOTO_FIRST, PHOTO_SECOND]);
  planWithPhoto(proxyUrl(SECOND));
  // The sheet's Place Details read, which the details cache keeps.
  const warm = await placeDetailsCache.fetchPlaceDetails(P);
  assert.equal(warm.ok, true);
  calls.length = 0;
  __resetPlacesBudget();

  const res = await askCredit();
  assert.deepEqual(res.body, { photo_url: proxyUrl(SECOND), photo_attribution: CREDIT_SECOND });
  assert.equal(calls.length, 0, 'a warm card is a free answer');
  assert.equal(placesBudgetStatus().globalUsed, 0, 'and a free answer is not charged');
});

test('two opens at once ride one request', async () => {
  placeWithPhotos(P, [PHOTO_FIRST]);
  planWithPhoto(proxyUrl(FIRST));
  let release;
  holdDetails = new Promise((r) => { release = r; });
  const both = Promise.all([askCredit(), askCredit()]);
  const start = Date.now();
  while (lookups().length === 0) {
    if (Date.now() - start > 15000) throw new Error('the lookup never reached Google');
    await new Promise((r) => setTimeout(r, 5));
  }
  release();
  const [a, b] = await both;
  assert.deepEqual(a.body, { photo_url: proxyUrl(FIRST), photo_attribution: CREDIT_FIRST });
  assert.deepEqual(b.body, a.body);
  assert.equal(lookups().length, 1);
  assert.equal(placesBudgetStatus().globalUsed, 1, 'the follower rode for nothing');
});

test('a refused budget answers nothing, and nothing reaches Google', async () => {
  placeWithPhotos(P, [PHOTO_FIRST]);
  planWithPhoto(proxyUrl(FIRST));
  // Spend the day's share for doors with no account, which the photo proxy draws on.
  while (allowGlobalPlacesCall(1, { photo: true })) { /* spend */ }
  assert.deepEqual((await askCredit()).body, NOTHING);
  assert.equal(calls.length, 0);
});

// =============================================================================
// 5. Nothing is kept, and no list asks
// =============================================================================

test('the answer is the photo and its credit, and nothing about it stays in memory', async () => {
  placeWithPhotos(P, [PHOTO_FIRST]);
  planWithPhoto(proxyUrl(EXPIRED));
  const res = await askCredit();
  assert.deepEqual(Object.keys(res.body).sort(), ['photo_attribution', 'photo_url']);
  assert.deepEqual(Object.keys(res.body.photo_attribution).sort(), ['maps_uri', 'name', 'uri']);
  // A photos-only answer never reaches the cache the crowd model reads, the
  // flight is gone, and the heal's memory is the heal's alone.
  assert.equal(placeDetailsCache.__test.size(), 0);
  assert.equal(placeDetailsCache.__test.photosInflightSize(), 0);
  assert.equal(vs.healedPlaces.size, 0);
  assert.equal(vs.deadPhotoRefs.size, 0);
});

test('only the plan screen\'s route asks, and no list route in flocks.js does', () => {
  const routesDir = path.join(__dirname, '..', 'routes');
  const callers = fs.readdirSync(routesDir)
    .filter((f) => f.endsWith('.js'))
    .filter((f) => /currentPhotoCredit\(/.test(fs.readFileSync(path.join(routesDir, f), 'utf8')));
  assert.deepEqual(callers.sort(), ['flocks.js', 'venueSearch.js']);
  const flocks = fs.readFileSync(path.join(routesDir, 'flocks.js'), 'utf8');
  const at = flocks.indexOf('currentPhotoCredit(');
  const handler = flocks.lastIndexOf("router.get('", at);
  assert.equal(flocks.slice(handler, flocks.indexOf(',', handler)), "router.get('/:id/venue-photo'");
  assert.equal(flocks.indexOf('currentPhotoCredit(', at + 1), -1, 'one call site');
});
