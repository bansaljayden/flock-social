'use strict';
// ---------------------------------------------------------------------------
// NO LOG LINE IN THE ML COLLECTORS CAN CARRY THE BESTTIME KEY.
//
// The key rides in every request's query string. The paths that could carry
// it into a log, each pinned below: a JSON parse error quoting the body, a
// native fetch error whose cause holds the URL (or whose own message names
// it), a Postgres data error quoting a response value, a response field the
// account read passes on, and every collector line that used to print
// err.message or a whole error object. scripts/ml/logSafe.js holds the rule.
//
// HOW TO RUN
//   cd backend && node --test __tests__/mlLogSafe.test.js
// ---------------------------------------------------------------------------
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// Assembled at runtime, low entropy, so no key-shaped literal sits in the tree.
const KEY = ['pri', 'abcd'.repeat(8)].join('_');
process.env.BESTTIME_API_KEY = KEY;
const URL_WITH_KEY = `https://besttime.app/api/v1/forecasts?api_key_private=${KEY}&venue_name=x`;

const { labelFor, failureReason, describeError, describeDbError } = require('../scripts/ml/logSafe');
const { fetchWeeklyForecast, fetchLiveBusyness } = require('../scripts/ml/bestTimeService');
const { containsKeyMaterial } = require('../services/besttimeAccount');

const leaks = (text) => text.includes(KEY.slice(0, 8)) || text.includes('abcdabcd');

const realFetch = global.fetch;
test.afterEach(() => { global.fetch = realFetch; });

test('describeError: parse errors, fetch causes and URL-naming messages print nothing of the request', () => {
  let parseError;
  try { JSON.parse(`${KEY} trailing`); } catch (e) { parseError = e; }
  assert.ok(leaks(parseError.message), 'precondition: Node quotes the text it choked on');
  assert.strictEqual(describeError(parseError), 'the response was not valid JSON');

  const fetchFailed = new TypeError('fetch failed');
  fetchFailed.cause = Object.assign(new TypeError('Invalid URL'), { code: 'ERR_INVALID_URL', input: 'http://[', base: URL_WITH_KEY });
  assert.strictEqual(describeError(fetchFailed), 'fetch failed (ERR_INVALID_URL)');

  const namesUrl = new TypeError(`Failed to parse URL from ${URL_WITH_KEY}`);
  assert.ok(!leaks(describeError(namesUrl)), describeError(namesUrl));

  assert.strictEqual(describeError(new Error('BestTime 503 (weekly)')), 'BestTime 503 (weekly)');
  assert.strictEqual(describeError(null), 'unknown error');
});

test('describeDbError: a data exception is printed by code, anything else as before', () => {
  const bad = Object.assign(new Error(`invalid input syntax for type bigint: "${KEY}"`), { code: '22P02' });
  assert.strictEqual(describeDbError(bad), 'data exception 22P02: a value from the response did not fit its column');
  const range = Object.assign(new Error(`value "${KEY}" is out of range for type integer`), { code: '22003' });
  assert.ok(!leaks(describeDbError(range)));
  const other = Object.assign(new Error('deadlock detected'), { code: '40P01' });
  assert.strictEqual(describeDbError(other), 'deadlock detected (40P01)');
});

test('labels: only fixed strings come back, whatever the message holds', () => {
  assert.strictEqual(labelFor('Venue found, but could not forecast this venue.'), 'found, but BestTime has too little visitor data to forecast it');
  assert.strictEqual(labelFor(`denied ${URL_WITH_KEY}`), 'reason not recognised');
  assert.strictEqual(labelFor({ toString: null }), 'reason not recognised');
  assert.strictEqual(failureReason(JSON.stringify({ message: 'Could not find venue' })), 'BestTime could not match a venue to that name and address');
});

test('a parse error is never rethrown as a network error, whatever its text says', async (t) => {
  // "timeout" in the body used to satisfy NETWORK_ERR_RE, so the SyntaxError
  // was rethrown and the collector printed its message, body text and all.
  t.mock.method(console, 'error', () => {});
  global.fetch = async () => ({ ok: true, status: 200, json: async () => JSON.parse('timeout BODY_MARKER') });
  assert.strictEqual(await fetchWeeklyForecast('W', 'x', null), null);
  assert.strictEqual(await fetchLiveBusyness('bt-venue-1'), null);
});

test('epoch_analysis is a positive integer or nothing', async (t) => {
  t.mock.method(console, 'error', () => {});
  const answer = (epoch) => ({
    status: 'OK',
    epoch_analysis: epoch,
    venue_info: { venue_id: 'ven_1' },
    analysis: [{ day_info: { day_int: 0, day_text: 'Monday' }, day_raw: new Array(24).fill(10) }],
  });
  for (const [epoch, expected] of [[1790000000, 1790000000], ['1790000000', 1790000000], [KEY, null], [-5, null], [null, null], [1.5, null]]) {
    global.fetch = async () => ({ ok: true, status: 200, json: async () => answer(epoch) });
    const got = await fetchWeeklyForecast('V', 'x', 'ven_1');
    assert.strictEqual(got.epochAnalysis, expected, `epoch ${epoch}`);
  }
});

test('the account read withholds a key in any encoding or case', () => {
  const hex = 'abcd'.repeat(8);
  for (const shown of [
    `pri_${hex}`,
    `pri%5F${hex}`,
    `pri%5f${hex}`.toUpperCase(),
    encodeURIComponent(`pri_${hex}/x`).toLowerCase(),
    JSON.stringify(`pri_${hex}/x`).slice(1, -1).replace('/', '\\/'),
    `pub+${hex}`.replace('+', '_'),
  ]) {
    assert.strictEqual(containsKeyMaterial(shown, []), true, shown);
  }
  const custom = 'mykey/with space';
  assert.strictEqual(containsKeyMaterial(`plan: ${encodeURIComponent(custom)}`, [custom]), true);
  assert.strictEqual(containsKeyMaterial(`plan: ${custom.replace(' ', '+')}`, [custom]), true);
  assert.strictEqual(containsKeyMaterial('Max 100 Unique Venues / Month', [KEY]), false);
});

test('no collector line prints err.message, a whole error, or a response message', () => {
  const dir = path.join(__dirname, '..', 'scripts', 'ml');
  for (const file of ['bestTimeService.js', 'collectWeekly.js', 'collectRealtime.js', 'harvestVenueFilter.js',
    'probeUntestedCities.js', 'discoverBestTime.js']) {
    const src = fs.readFileSync(path.join(dir, file), 'utf8');
    const lines = src.split(/\r?\n/).filter((l) => /console\.(error|warn|log)\(/.test(l));
    for (const line of lines) {
      assert.doesNotMatch(line, /\berr\.message\b|,\s*err\)|(?<!labelFor\()data\.message\b|\$\{err\}/, `${file}: ${line.trim()}`);
    }
  }
  const harvest = fs.readFileSync(path.join(dir, 'harvestVenueFilter.js'), 'utf8');
  assert.match(harvest, /abortError\(`the venue filter answered without a venue list \(\$\{labelFor\(msg\)\}\)\.`\)/);
  assert.doesNotMatch(harvest, /answered status "\$\{String\(data\.status\)/);
});
