'use strict';
// ---------------------------------------------------------------------------
// THE PHOTO PROXY TELLS THE PLACES ALARM WHAT HAPPENED, ON ITS OWN LEG.
// ---------------------------------------------------------------------------
// Place Photos runs on its own per-day Google quota, so photos can be refused
// while every search works. The photo proxy used to record nothing, and even
// if it had, working search calls between its failures would have reset one
// shared streak. Now it records to a 'photos' leg of utils/placesHealth.js,
// the money watch alerts on that leg under its own ledger key, and a refusal
// Google does not bill (429, 403) hands the photo budget its charge back.
//
// Driven through the real route over HTTP, with Google and Postgres stood in
// for, because which outcome counts as healthy is decided inside the route.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

process.env.GOOGLE_PLACES_API_KEY = 'test-key-never-sent-anywhere';

const pool = require('../config/database');

const db = { charges: 0, refunds: [] };
const TODAY = new Date().toISOString().slice(0, 10);
pool.query = (text, params = []) => {
  const sql = String(text);
  if (/INTO places_photo_spend/i.test(sql)) {
    db.charges += 1;
    return Promise.resolve({ rows: [{ fetches: db.charges, day: TODAY }], rowCount: 1 });
  }
  if (/UPDATE places_photo_spend/i.test(sql)) {
    db.refunds.push(params[0]);
    return Promise.resolve({ rows: [{ fetches: 0 }], rowCount: 1 });
  }
  return Promise.resolve({ rows: [], rowCount: 0 });
};

// Google, scripted per test.
let media = () => ({ ok: true, status: 200, json: async () => ({ photoUri: 'https://cdn.example/p.jpg' }) });
let cdn = () => ({
  ok: true,
  status: 200,
  headers: { get: () => 'image/jpeg' },
  arrayBuffer: async () => new ArrayBuffer(8),
});
global.fetch = async (url) => (String(url).includes('/media') ? media() : cdn());

const { recordPlacesResult, placesHealthStatus, __resetPlacesHealth, FAILURE_STREAK_ALARM } = require('../utils/placesHealth');
const venueSearch = require('../routes/venueSearch');
const { clearPhotoCache, resetPhotoBudget } = venueSearch.__test;

const app = express();
app.use('/api/venues', venueSearch);
const server = http.createServer(app);
let base;
test.before(() => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); });
}));
test.after(() => new Promise((resolve) => server.close(() => resolve())));

const realError = console.error;
test.before(() => { console.error = () => {}; });
test.after(() => { console.error = realError; });

test.beforeEach(() => {
  clearPhotoCache();
  resetPhotoBudget();
  __resetPlacesHealth();
  db.charges = 0;
  db.refunds = [];
  media = () => ({ ok: true, status: 200, json: async () => ({ photoUri: 'https://cdn.example/p.jpg' }) });
  cdn = () => ({ ok: true, status: 200, headers: { get: () => 'image/jpeg' }, arrayBuffer: async () => new ArrayBuffer(8) });
});

let n = 0;
const freshRef = () => `places/PLACE_HEALTH/photos/Photo${++n}${'z'.repeat(40)}`;
function get(ref) {
  return new Promise((resolve, reject) => {
    http.get(`${base}/api/venues/photo?ref=${encodeURIComponent(ref)}&maxwidth=400`, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    }).on('error', reject);
  });
}

const refused = (status, text = '{"error":{"status":"RESOURCE_EXHAUSTED","message":"Quota exceeded"}}') =>
  () => ({ ok: false, status, text: async () => text, json: async () => ({}) });

test('photo refusals arm the photos leg, and leave the search leg alone', async () => {
  media = refused(429);
  for (let i = 0; i < FAILURE_STREAK_ALARM; i += 1) assert.equal(await get(freshRef()), 502);
  const h = placesHealthStatus();
  assert.equal(h.photos.unhealthy, true);
  assert.equal(h.photos.consecutiveFailures, FAILURE_STREAK_ALARM);
  assert.deepEqual(h.photos.reasons, ['HTTP 429']);
  assert.equal(h.unhealthy, false, 'the search leg saw nothing');
  assert.equal(h.consecutiveFailures, 0);
});

test('working searches in between no longer hide a photos outage', async () => {
  // The reason for a second leg. On one shared streak, each successful search
  // reset the count, so a photos-only outage never reached the threshold.
  media = refused(429);
  for (let i = 0; i < FAILURE_STREAK_ALARM; i += 1) {
    await get(freshRef());
    recordPlacesResult(true); // a search somewhere else in the app succeeded
  }
  assert.equal(placesHealthStatus().photos.unhealthy, true);
});

test('a 429 or a 403 hands the charge back to the day it was taken from; other failures keep it', async () => {
  media = refused(429);
  await get(freshRef());
  media = refused(403, '{"error":{"status":"PERMISSION_DENIED","message":"Billing not enabled"}}');
  await get(freshRef());
  assert.deepEqual(db.refunds, [TODAY, TODAY]);

  // A 500 is not a documented no-bill answer, and a timeout is unknown, so
  // both stay charged.
  media = refused(500, 'internal');
  await get(freshRef());
  media = () => { throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }); };
  await get(freshRef());
  assert.equal(db.refunds.length, 2);
  assert.equal(db.charges, 4);
  assert.deepEqual(placesHealthStatus().photos.reasons, ['unreachable', 'HTTP 500', 'HTTP 403', 'HTTP 429']);
});

test('a name Google says is bad is Google working, and clears the streak', async () => {
  media = refused(429);
  await get(freshRef());
  await get(freshRef());
  media = refused(404, '{"error":{"status":"NOT_FOUND","message":"Photo resource not found"}}');
  await get(freshRef());
  const p = placesHealthStatus().photos;
  assert.equal(p.consecutiveFailures, 0);
  assert.equal(p.unhealthy, false);
  assert.equal(db.refunds.length, 2, 'the two 429s were handed back, the bad name was not');
});

test('a photo that arrives is a success; a CDN that fails is a failure', async () => {
  assert.equal(await get(freshRef()), 200);
  assert.equal(placesHealthStatus().photos.totalOk, 1);
  cdn = () => ({ ok: false, status: 503, headers: { get: () => null } });
  for (let i = 0; i < FAILURE_STREAK_ALARM; i += 1) await get(freshRef());
  const p = placesHealthStatus().photos;
  assert.equal(p.unhealthy, true, 'a metadata success followed by a CDN failure is still a blank photo');
  assert.deepEqual(p.reasons, ['photo CDN HTTP 503']);
});

// ---------------------------------------------------------------------------
// The alert for the leg
// ---------------------------------------------------------------------------
test('the photos alert goes out under its own key and names the quota to check', async () => {
  const opsAlertModule = require('../services/opsAlert');
  const saved = opsAlertModule.opsAlert;
  const sent = [];
  opsAlertModule.opsAlert = async (a) => { sent.push(a); return { sent: true, legs: ['email'] }; };
  // Loaded after the stub, since it takes opsAlert at require time.
  delete require.cache[require.resolve('../services/placesOutageAlert')];
  const { runPlacesPhotoOutageAlert, PHOTOS_ALERT_KEY, ALERT_KEY } = require('../services/placesOutageAlert');
  try {
    assert.deepEqual(await runPlacesPhotoOutageAlert({ unhealthy: false }), { skipped: 'healthy' });
    const out = await runPlacesPhotoOutageAlert({
      unhealthy: true, consecutiveFailures: 9, failingForMs: 3 * 60 * 60 * 1000, reasons: ['HTTP 429'],
    });
    assert.deepEqual(out, { sent: true, legs: ['email'] });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].key, PHOTOS_ALERT_KEY);
    assert.notEqual(PHOTOS_ALERT_KEY, ALERT_KEY, 'a photos outage and a search outage can both be told on one day');
    assert.match(sent[0].text, /GetPhotoMediaRequestPerDayPerProject/);
    assert.match(sent[0].text, /9 times in a row/);
    assert.match(sent[0].text, /3 hours/);
    assert.match(sent[0].text, /HTTP 429/);
    assert.match(sent[0].push.body, /9 photo lookups in a row over 3 hours/);
    assert.doesNotMatch(`${sent[0].subject}\n${sent[0].text}`, /—/);
  } finally {
    opsAlertModule.opsAlert = saved;
    delete require.cache[require.resolve('../services/placesOutageAlert')];
  }
});

test('the money watch reads the photos leg and sends its alert', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8').replace(/\r\n/g, '\n');
  const watch = /async function runMoneyWatch\(\) \{([\s\S]*?)\n\}/.exec(src)[1];
  assert.match(watch, /const p = h\.photos;/);
  assert.match(watch, /runPlacesPhotoOutageAlert\(p\)/);
});
