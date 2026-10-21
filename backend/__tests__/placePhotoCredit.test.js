// Run: node --test  (from backend/)
//
// GOOGLE'S CREDIT FOR A PLACES PHOTO TRAVELS WITH THE PHOTO.
//
// Google's Places policies require the author's name and profile link beside
// every photo shown, and a way to see the photo on Google Maps. The app was
// sent the proxied photo URL and nothing else, so it could not draw either.
// utils/placePhotoCredit.js turns a Places (New) Photo object into
// { name, uri, maps_uri }, and routes/venueSearch.js sends it: one
// `photo_attribution` beside each search result's photo_url, and a
// `photo_attributions` list index-aligned with the details `photos`.
//
// The fake Google below honours the field mask, so these tests also prove the
// credit rides on the `photos` field the masks already ask for: no new field,
// no new SKU.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

process.env.JWT_SECRET = 'place-photo-credit-test-secret';
process.env.GOOGLE_PLACES_API_KEY = 'test-places-key';
delete process.env.PAYWALL_ENABLED;

const { pinClock } = require('./helpers/pinnedClock');
const pinnedClock = pinClock(Date.UTC(2026, 6, 15, 12, 0, 0));
test.after(() => pinnedClock.restore());

const { photoCredit, cleanName, googleHttpsUrl, MAX_NAME_CHARS } = require('../utils/placePhotoCredit');
const { __resetPlacesBudget } = require('../utils/placesBudget');

// --- the helper on its own ---------------------------------------------------

test('a Photo object becomes the name, the profile link and the photo page', () => {
  const credit = photoCredit({
    name: 'places/P/photos/R',
    authorAttributions: [{
      displayName: 'Dana Reyes',
      uri: 'https://maps.google.com/maps/contrib/1234',
      photoUri: 'https://lh3.googleusercontent.com/a/avatar',
    }],
    googleMapsUri: 'https://www.google.com/maps/place//data=!3m4!1e2',
  });
  assert.deepStrictEqual(credit, {
    name: 'Dana Reyes',
    uri: 'https://maps.google.com/maps/contrib/1234',
    maps_uri: 'https://www.google.com/maps/place//data=!3m4!1e2',
  });
});

test('protocol-relative Google links become https, as Google documents them', () => {
  const credit = photoCredit({
    authorAttributions: [{ displayName: 'Lee', uri: '//maps.google.com/maps/contrib/99' }],
    googleMapsUri: '//www.google.com/maps/photo',
  });
  assert.strictEqual(credit.uri, 'https://maps.google.com/maps/contrib/99');
  assert.strictEqual(credit.maps_uri, 'https://www.google.com/maps/photo');
});

test('links that are not https on a Google host are dropped, not repaired', () => {
  for (const bad of [
    'http://maps.google.com/maps/contrib/1',
    'javascript:alert(1)',
    'https://evil.example/maps/contrib/1',
    'https://google.com.evil.example/x',
    'https://user:pass@maps.google.com/x',
    'data:text/html,hi',
    '',
    42,
    null,
  ]) {
    assert.strictEqual(googleHttpsUrl(bad), null, String(bad));
  }
  assert.strictEqual(googleHttpsUrl('https://goo.gl/maps/abc'), 'https://goo.gl/maps/abc');
});

test('a display name is plain text: controls and bidi overrides go, length is capped', () => {
  assert.strictEqual(cleanName('  Ana‮ Ruiz\u0007  '), 'Ana Ruiz');
  assert.strictEqual(cleanName('​⁦'), null);
  assert.strictEqual(cleanName(17), null);
  const long = cleanName('x'.repeat(500));
  assert.strictEqual(long.length, MAX_NAME_CHARS);
  assert.ok(long.endsWith('…'));
});

test('nothing usable is null, and a profile link never stands without a name', () => {
  assert.strictEqual(photoCredit(null), null);
  assert.strictEqual(photoCredit({ name: 'places/P/photos/R' }), null);
  assert.strictEqual(photoCredit({ authorAttributions: [{ displayName: '  ' }] }), null);
  const mapsOnly = photoCredit({
    authorAttributions: [{ displayName: '', uri: 'https://maps.google.com/maps/contrib/5' }],
    googleMapsUri: 'https://www.google.com/maps/photo',
  });
  assert.deepStrictEqual(mapsOnly, { name: null, uri: null, maps_uri: 'https://www.google.com/maps/photo' });
});

test('the first author with a usable name is the one credited', () => {
  const credit = photoCredit({
    authorAttributions: [{ displayName: '‮' }, { displayName: 'Sam Okafor', uri: 'https://maps.google.com/maps/contrib/7' }],
  });
  assert.strictEqual(credit.name, 'Sam Okafor');
  assert.strictEqual(credit.uri, 'https://maps.google.com/maps/contrib/7');
});

// --- the routes send it -------------------------------------------------------

const pool = require('../config/database');
pool.query = (sql) => {
  const s = String(sql && sql.text ? sql.text : sql);
  if (/FROM places_photo_spend/i.test(s)) return Promise.resolve({ rows: [{ month_used: 0, day_used: 0 }], rowCount: 1 });
  return Promise.resolve({ rows: [], rowCount: 0 });
};

const authMod = require('../middleware/auth');
authMod.authenticate = (req, _res, next) => { req.user = { id: 7, name: 'Ava' }; next(); };

const PHOTO_A = {
  name: 'places/PLACE_C/photos/REF_A',
  authorAttributions: [{ displayName: 'Dana Reyes', uri: '//maps.google.com/maps/contrib/111', photoUri: '//lh3.googleusercontent.com/a/x' }],
  googleMapsUri: 'https://www.google.com/maps/place//data=!3m4!1e2!3m2!1sA',
  flagContentUri: 'https://www.google.com/local/review/rap/report?postId=A',
};
// A photo Google sends with no author at all: its slot must be null, so the
// list stays aligned with `photos`.
const PHOTO_B = { name: 'places/PLACE_C/photos/REF_B' };
const PHOTO_C = {
  name: 'places/PLACE_C/photos/REF_C',
  authorAttributions: [{ displayName: 'The Copper Finch', uri: 'https://maps.google.com/maps/contrib/333' }],
  googleMapsUri: 'https://www.google.com/maps/place//data=!3m4!1e2!3m2!1sC',
};

const PLACE = {
  id: 'PLACE_C',
  displayName: { text: 'The Copper Finch' },
  formattedAddress: '214 Main St',
  rating: 4.6,
  userRatingCount: 88,
  priceLevel: 'PRICE_LEVEL_MODERATE',
  types: ['cafe'],
  photos: [PHOTO_A, PHOTO_B, PHOTO_C],
  location: { latitude: 21.28, longitude: -157.83 },
  currentOpeningHours: { openNow: true, periods: [] },
  googleMapsUri: 'https://maps.google.com/?cid=1',
  utcOffsetMinutes: -600,
  timeZone: { id: 'Pacific/Honolulu' },
};

function project(obj, fields) {
  const out = {};
  for (const f of fields) {
    if (Object.prototype.hasOwnProperty.call(obj, f)) out[f] = obj[f];
  }
  return out;
}

let googleCalls = [];
const realFetch = global.fetch;
global.fetch = (url, opts) => {
  const u = String(url);
  if (u.startsWith('https://places.googleapis.com/')) {
    const raw = (opts && opts.headers && opts.headers['X-Goog-FieldMask']) || '';
    const mask = raw.split(',').map((s) => s.trim()).filter(Boolean);
    googleCalls.push({ url: u, mask });
    if (u.includes(':searchText')) {
      const fields = mask.filter((m) => m.startsWith('places.')).map((m) => m.slice('places.'.length));
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ places: [project(PLACE, fields)] }) });
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => project(PLACE, mask) });
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
test.beforeEach(() => { __resetPlacesBudget(); googleCalls = []; });

async function get(pathname) {
  const res = await realFetch(`${base}${pathname}`);
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body, text };
}

test('a search result carries the credit for its photo_url', async () => {
  const res = await get(`/api/venues/search?query=cafes credit${Date.now()}&location=21.28,-157.83`);
  assert.strictEqual(res.status, 200, res.text);
  const [venue] = res.body.venues;
  assert.match(venue.photo_url, /ref=places%2FPLACE_C%2Fphotos%2FREF_A/);
  assert.deepStrictEqual(venue.photo_attribution, {
    name: 'Dana Reyes',
    uri: 'https://maps.google.com/maps/contrib/111',
    maps_uri: 'https://www.google.com/maps/place//data=!3m4!1e2!3m2!1sA',
  });
  // Nothing past the three fields: no avatar URL, no report link, no raw object.
  assert.deepStrictEqual(Object.keys(venue.photo_attribution).sort(), ['maps_uri', 'name', 'uri']);
  const call = googleCalls.find((c) => c.url.includes(':searchText'));
  assert.ok(call.mask.includes('places.photos'), 'the credit rides on the photos field already asked for');
  assert.ok(!call.mask.some((m) => /attribution/i.test(m)), 'no new field in the search mask');
});

test('details send one credit per photo, aligned with photos, null where Google sent none', async () => {
  const res = await get('/api/venues/details?place_id=PLACE_C');
  assert.strictEqual(res.status, 200, res.text);
  const { venue } = res.body;
  assert.strictEqual(venue.photos.length, 3);
  assert.strictEqual(venue.photo_attributions.length, venue.photos.length);
  assert.strictEqual(venue.photo_attributions[0].name, 'Dana Reyes');
  assert.strictEqual(venue.photo_attributions[1], null);
  assert.strictEqual(venue.photo_attributions[2].name, 'The Copper Finch');
  assert.strictEqual(venue.photo_attributions[2].maps_uri, 'https://www.google.com/maps/place//data=!3m4!1e2!3m2!1sC');
  // photo_url is photos[0], so its credit is photo_attributions[0].
  assert.strictEqual(venue.photo_url, venue.photos[0]);
  assert.deepStrictEqual(venue.photo_attribution, venue.photo_attributions[0]);
});
