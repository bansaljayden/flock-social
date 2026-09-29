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

  // A key in a URL's path (no "?"), a bare key, and a key's body alone.
  for (const text of [
    `Failed to parse URL from https://besttime.app/api/v1/keys/${KEY}`,
    `unexpected ${KEY}`,
    `unexpected ${KEY.replace(/^pri_/, '')}`,
  ]) {
    assert.ok(!leaks(describeError(new Error(text))), describeError(new Error(text)));
  }
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

test('a 200 that is not JSON is a transient failure, never a venue miss, and its text goes nowhere', async (t) => {
  // Returned as null it marked the venue 404 and spent the lookup; with
  // "timeout" in the body it was rethrown as a network error and the collector
  // printed the parser's quote of the body.
  const lines = [];
  t.mock.method(console, 'error', (...args) => { lines.push(args.join(' ')); });
  global.fetch = async () => ({ ok: true, status: 200, json: async () => JSON.parse('timeout BODY_MARKER') });
  await assert.rejects(fetchWeeklyForecast('W', 'x', null), (e) => e.transient === true && e.notJson === true);
  await assert.rejects(fetchLiveBusyness('bt-venue-1'), (e) => e.transient === true);
  assert.ok(lines.length >= 2, lines.join('\n'));
  assert.ok(lines.every((l) => !l.includes('BODY_MARKER')), lines.join('\n'));
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
  // The second review's cases: a stray % voiding the whole decode, a double
  // encoding, the body alone, a prefix inside another word.
  for (const shown of [`100% used; pri%5F${hex}`, `pri%5F${hex}%`, `pri%255F${hex}`, hex, `ref_pub_${hex}`]) {
    assert.strictEqual(containsKeyMaterial(shown, []), true, shown);
  }
  assert.strictEqual(containsKeyMaterial('Max 100 Unique Venues / Month', [KEY]), false);
  assert.strictEqual(containsKeyMaterial('100% of 100 used', [KEY]), false);
});

test('the account read withholds a key split across fields, and screens status before cutting it', () => {
  const { readKeyStatus } = require('../services/besttimeAccount');
  const hex = 'abcd'.repeat(8);
  const split = readKeyStatus({
    status: 'OK', valid: true, active: true, plan_part_a: `pri_${hex.slice(0, 7)}`, plan_part_b: hex.slice(7),
  }, { secrets: [KEY] });
  assert.ok(split.reported.length === 2 && split.reported.every((f) => f.withheld && !('value' in f)), JSON.stringify(split.reported));
  // Three pieces of the key's body, each too short to look like a key alone.
  const body = KEY.replace(/^pri_/, '');
  const thirds = readKeyStatus({
    plan_a: body.slice(0, 11), plan_b: body.slice(11, 22), plan_c: body.slice(22), plan_name: 'Max 100',
  }, { secrets: [KEY] });
  assert.ok(thirds.reported.every((f) => f.withheld), JSON.stringify(thirds.reported));
  // Numbers run together are not a key.
  const quotas = readKeyStatus({ quota_venues: 100, quota_used: 1000000, quota_left: 99000000 }, { secrets: [KEY] });
  assert.ok(quotas.reported.every((f) => !f.withheld), JSON.stringify(quotas.reported));
  const cut = readKeyStatus({ status: `${'x'.repeat(33)}pri_${hex}` }, { secrets: [KEY] });
  assert.strictEqual(cut.status, '[withheld]');
  const fine = readKeyStatus({ status: 'OK', valid: true, active: true, plan_name: 'Max 100' }, { secrets: [KEY] });
  assert.deepStrictEqual(fine.reported, [{ name: 'plan_name', value: 'Max 100' }]);
});

// The sweep walks the parsed source, not lines: a line check missed a
// multi-line console call, any error variable not named `err`, a whole error
// passed as a second argument, and process.stderr.write. acorn arrives with
// @sentry/node, a production dependency; if it ever goes, this test fails
// loudly rather than skipping.
const acorn = require('acorn');
const SAFE_CALLS = new Set(['describeError', 'describeDbError', 'labelFor', 'failureReason']);
// `reason` is left out on purpose: in bestTimeService it is the fixed label.
const ERRORISH = /^(err|error|e|callError|cause|ex)$/;
const RESPONSEISH = /^(data|body|json|answer|response|parsed)$/;

function unsafeOutput(src) {
  const ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'script', allowHashBang: true, locations: true });
  const problems = [];
  const isOutputCall = (n) => {
    const c = n.callee;
    if (!c || c.type !== 'MemberExpression') return false;
    if (c.object.type === 'Identifier' && c.object.name === 'console') return true;
    return c.object.type === 'MemberExpression' && c.object.object.type === 'Identifier'
      && c.object.object.name === 'process' && ['stderr', 'stdout'].includes(c.object.property.name);
  };
  const flag = (n, what) => problems.push(`line ${n.loc.start.line}: ${what}`);
  // Everything an output call is handed, except what passes through a safe
  // describer first.
  const inspect = (n, direct) => {
    if (!n || typeof n.type !== 'string') return;
    if (n.type === 'CallExpression' && n.callee.type === 'Identifier' && SAFE_CALLS.has(n.callee.name)) return;
    if (n.type === 'MemberExpression' && !n.computed && ['message', 'stack'].includes(n.property.name)) {
      flag(n, `.${n.property.name}`);
    }
    if (n.type === 'Identifier' && direct && (ERRORISH.test(n.name) || RESPONSEISH.test(n.name))) {
      flag(n, `whole ${n.name}`);
    }
    if (n.type === 'CallExpression' && n.callee.type === 'Identifier' && n.callee.name === 'String') {
      n.arguments.forEach((a) => inspect(a, true));
      return;
    }
    if (n.type === 'CallExpression' && n.callee.type === 'MemberExpression' && n.callee.object.name === 'JSON') {
      n.arguments.forEach((a) => inspect(a, true));
      return;
    }
    if (n.type === 'TemplateLiteral') { n.expressions.forEach((x) => inspect(x, true)); return; }
    if (n.type === 'BinaryExpression') { inspect(n.left, true); inspect(n.right, true); return; }
    if (n.type === 'ConditionalExpression') { inspect(n.consequent, true); inspect(n.alternate, true); return; }
    for (const [k, v] of Object.entries(n)) {
      if (k === 'loc' || k === 'start' || k === 'end') continue;
      if (Array.isArray(v)) v.forEach((x) => inspect(x, false));
      else if (v && typeof v.type === 'string') inspect(v, false);
    }
  };
  const walk = (n) => {
    if (!n || typeof n.type !== 'string') return;
    if (n.type === 'CallExpression' && isOutputCall(n)) n.arguments.forEach((a) => inspect(a, true));
    for (const [k, v] of Object.entries(n)) {
      if (k === 'loc') continue;
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v.type === 'string') walk(v);
    }
  };
  walk(ast);
  return problems;
}

test('the sweep itself catches what the line check missed', () => {
  const caught = unsafeOutput([
    'console.error(`a ${callError.message}`);',
    'console.error("x",',
    '  err.message);',
    'console.error("x", err, "y");',
    'console.info(`${e.stack}`);',
    'process.stderr.write(String(error));',
    'console.log(JSON.stringify(data));',
    'console.error(`fine ${describeError(err)} ${labelFor(data.message)}`);',
  ].join('\n'));
  assert.deepStrictEqual(caught.map((p) => p.split(':')[0]), ['line 1', 'line 3', 'line 4', 'line 5', 'line 6', 'line 7']);
});

test('no collector output prints an error\'s message or stack, a whole error, or a response', () => {
  const ml = path.join(__dirname, '..', 'scripts', 'ml');
  const files = ['bestTimeService.js', 'collectWeekly.js', 'collectRealtime.js', 'harvestVenueFilter.js',
    'probeUntestedCities.js', 'discoverBestTime.js', 'besttimeAccountStatus.js']
    .map((f) => path.join(ml, f))
    .concat([path.join(__dirname, '..', 'services', 'besttimeAccount.js')]);
  for (const file of files) {
    const problems = unsafeOutput(fs.readFileSync(file, 'utf8'));
    assert.deepStrictEqual(problems, [], `${path.basename(file)}:\n  ${problems.join('\n  ')}`);
  }
  const harvest = fs.readFileSync(path.join(ml, 'harvestVenueFilter.js'), 'utf8');
  assert.match(harvest, /abortError\(`the venue filter answered without a venue list \(\$\{labelFor\(msg\)\}\)\.`\)/);
  assert.doesNotMatch(harvest, /answered status "\$\{String\(data\.status\)/);
});
