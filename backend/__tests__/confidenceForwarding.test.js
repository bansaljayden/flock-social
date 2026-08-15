// Run: node --test  (from backend/)
//
// ===========================================================================
// THE CONFIDENCE INTEGER NEVER TRAVELS ALONE.
//
// services/mlPredictor.js publishes an honest confidence figure and attaches a
// `confidenceMeasurement` block saying what that figure IS. Commit f5ef329 built
// the block; nothing carried it to a client, because every route assembles its
// payload field by field. This file exists so that can never silently be true
// again.
//
// WHY IT MATTERS, in one comparison:
//
//   status 'measured'    33   the model's within-15 on `realtime_served`, the
//                             rows production is actually asked to score
//                             (scripts/ml/MODEL-METRICS.md section 2)
//   status 'unmeasured'  72   crowdEngine's input-completeness ladder, which
//                             counts how richly Google described the venue and
//                             has never observed how full the room gets
//
// THE UNMEASURED NUMBER IS THE LARGER ONE. So a client rendering the bare
// percentage does not merely lose context: it INVERTS the ranking. The artifact
// that measured itself and reported 33 looks worse than the one that measured
// nothing and reported 72, and the honest model is punished for being honest.
// That is the specific failure this file pins against, and it is why "the block
// is missing" and "the block is wrong" are the same severity here.
//
// FOUR SURFACES publish a confidence today, and they are pinned individually
// because they are assembled independently:
//
//   GET  /api/crowd/:placeId            the venue card          `confidenceMeasurement`
//   POST /api/crowd/batch               the list under it       `confidenceMeasurement`
//   POST /api/ai/chat -> crowd tool     Birdie                  `confidence_measurement`
//   GET  /api/public/demo/venue/:id     the marketing demo      `confidence_measurement`
//
// The field NAME follows each surface's own convention, the same rule
// routes/crowd.js already records for the forecast gate ("`bestTime` here,
// `best_time` in routes/publicCrowd.js and routes/ai.js"). The block's own keys
// do not: they are produced by one shared function and are byte-identical
// everywhere, which is what makes a single client parser correct on all four.
// ===========================================================================

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

process.env.JWT_SECRET = 'confidence-forwarding-test-secret';
// Captured at module load by crowd / publicCrowd / ai.
process.env.GOOGLE_PLACES_API_KEY = 'test-places-key';
process.env.WEATHER_API_KEY = 'test-weather-key';
process.env.GEMINI_API_KEY = 'test-gemini-key';
delete process.env.PAYWALL_ENABLED;

const BACKEND = path.join(__dirname, '..');

// --- pg fake ---------------------------------------------------------------
const pool = require('../config/database');
let FEEDBACK_ROWS = [];
pool.query = (sql) => {
  const flat = String(sql).replace(/\s+/g, ' ').trim();
  if (/FROM venue_feedback/.test(flat)) {
    return Promise.resolve({ rows: FEEDBACK_ROWS, rowCount: FEEDBACK_ROWS.length });
  }
  if (/is_premium/.test(flat)) return Promise.resolve({ rows: [{ is_premium: false }] });
  return Promise.resolve({ rows: [], rowCount: 0 });
};

const authMod = require('../middleware/auth');
let CURRENT_USER = { id: 1, name: 'Ava', role: 'user' };
authMod.authenticate = (req, _res, next) => { req.user = CURRENT_USER; next(); };

const weatherService = require('../services/weatherService');
weatherService.getWeather = async () => ({ temp: 60, conditions: 'Clear' });
weatherService.getForecast = async () => [];

const placesBudget = require('../utils/placesBudget');
placesBudget.allowPlacesSearch = () => true;
placesBudget.allowGlobalPlacesCall = () => true;

// --- Gemini, faked ----------------------------------------------------------
const genaiMod = require('@google/genai');
let sendCalls = [];
let sendImpl = null;
const fakeChat = {
  sendMessage: async (params) => {
    sendCalls.push(params);
    if (sendImpl) return sendImpl(params, sendCalls.length);
    return { candidates: [{ content: { parts: [{ text: 'busy-ish' }] } }] };
  },
};
genaiMod.GoogleGenAI = function FakeGenAI() {
  return { chats: { create: () => fakeChat } };
};

// --- Google Places, faked ---------------------------------------------------
function place(id) {
  return {
    id,
    displayName: { text: id },
    formattedAddress: '1 Main St',
    rating: 4.2,
    userRatingCount: 300,
    priceLevel: 'PRICE_LEVEL_MODERATE',
    types: ['bar'],
    location: { latitude: 39.74, longitude: -104.98 },
    currentOpeningHours: { openNow: true, periods: [] },
    utcOffsetMinutes: null,
  };
}
const realFetch = global.fetch;
global.fetch = (url, opts) => {
  const u = String(url);
  if (!u.startsWith('https://places.googleapis.com/')) return realFetch(url, opts);
  if (u.startsWith('https://places.googleapis.com/v1/places:search')) {
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ places: [] }) });
  }
  const id = decodeURIComponent(u.split('/places/')[1] || '').split('?')[0];
  return Promise.resolve({ ok: true, status: 200, json: async () => place(id || 'PLACE_X') });
};
test.after(() => { global.fetch = realFetch; });

// --- the predictor, faked in its three real states --------------------------
//
// These are not invented numbers. 33.3 is the served-population within-15 that
// scripts/ml/MODEL-METRICS.md section 2 records, and 72 is where crowdEngine's
// input-completeness ladder lands for a well-described venue. The point of
// using the real pair is that the assertions below about which is LARGER are
// assertions about the shipping system, not about a fixture.
const crowdEngine = require('../services/crowdEngine');
const mlPredictor = require('../services/mlPredictor');

const MEASURED_PERCENT = 33.3;
const MEASURED_CONFIDENCE = 33;    // Math.round(33.3), no weather penalty
const LADDER_CONFIDENCE = 72;      // and it is the BIGGER number. That is the bug.

const MEASURED_BLOCK = Object.freeze({
  status: 'measured',
  means: 'measured_accuracy',
  metric: 'within_15',
  population: 'realtime_served',
  populationRows: 369076,
  measuredPercent: MEASURED_PERCENT,
  weatherPenalty: 0,
});
const UNMEASURED_BLOCK = Object.freeze({
  status: 'unmeasured',
  means: 'input_completeness',
  metric: 'venue_metadata_completeness',
  population: null,
  populationRows: null,
  measuredPercent: null,
  weatherPenalty: 0,
});

// The third state is the one with no block at all: when the model throws, was
// never loaded, or was refused at the ship gate, predictBusyness returns
// crowdEngine.calculateCrowdScore's own result and attaches nothing.
// __tests__/confidenceHonesty.test.js pins that absence at the predictor.
const STATES = {
  measured: () => ({
    confidence: MEASURED_CONFIDENCE,
    predictionMethod: 'ml',
    modelVersion: 'test',
    confidenceMeasurement: { ...MEASURED_BLOCK },
  }),
  unmeasured: () => ({
    confidence: LADDER_CONFIDENCE,
    predictionMethod: 'ml',
    modelVersion: 'test',
    confidenceMeasurement: { ...UNMEASURED_BLOCK },
  }),
  rule_engine: () => ({
    confidence: LADDER_CONFIDENCE,
    predictionMethod: 'rule_engine_fallback',
    modelVersion: null,
  }),
};

let STATE = 'measured';
mlPredictor.predictBusyness = async () => ({
  score: 55,
  label: crowdEngine.getLabel(55),
  factors: {},
  dataSourcesUsed: ['ml_model'],
  ...STATES[STATE](),
});
mlPredictor.predictHourlyForecast = async (_v, _w, startHour, count) => (
  Array.from({ length: count || 12 }, (_, i) => {
    const h = ((startHour + i) % 24 + 24) % 24;
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return { hour: `${h12} ${h < 12 ? 'AM' : 'PM'}`, score: i === 0 ? 55 : 40 + i, label: 'Moderate' };
  })
);

const crowdRouter = require('../routes/crowd');
const publicCrowdRouter = require('../routes/publicCrowd');
const aiRouter = require('../routes/ai');

const app = express();
app.use(express.json());
app.use('/api/crowd', crowdRouter);
app.use('/api/public', publicCrowdRouter);
app.use('/api/ai', aiRouter);

let base;
const server = http.createServer(app);
test.before(() => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); });
}));
test.after(() => new Promise((resolve) => {
  server.close(() => resolve());
  pool.end?.().catch(() => {});
}));

let nextUser = 700000;
const freshUser = () => { CURRENT_USER = { id: ++nextUser, name: 'Ava', role: 'user' }; return CURRENT_USER.id; };

test.beforeEach(() => {
  FEEDBACK_ROWS = [];
  sendCalls = [];
  sendImpl = null;
  STATE = 'measured';
  freshUser();
});

async function call(method, path_, body) {
  const res = await realFetch(base + path_, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON body */ }
  return { status: res.status, body: json, text };
}

// Every surface caches by place id, so each read gets its own id. A cached
// payload would let a later state's assertion pass on an earlier state's block.
let idSeq = 0;
const freshId = (prefix) => `${prefix}_${Date.now().toString(36)}_${++idSeq}`;

// ---------------------------------------------------------------------------
// The four surfaces, each reduced to the same three facts: the payload, the
// confidence integer it published, and the block that explains it.
// ---------------------------------------------------------------------------
const crowdToolTurn = (placeId) => (_p, n) => (n === 1
  ? { candidates: [{ content: { parts: [{ functionCall: { id: 'c0', name: 'get_crowd_prediction', args: { place_id: placeId } } }] } }] }
  : { candidates: [{ content: { parts: [{ text: 'go later' }] } }] });

function birdieToolResults() {
  const out = [];
  for (const c of sendCalls) {
    if (!Array.isArray(c.message)) continue;
    for (const p of c.message) {
      if (p.functionResponse?.name === 'get_crowd_prediction') out.push(p.functionResponse.response);
    }
  }
  return out;
}

const SURFACES = [
  {
    name: 'GET /api/crowd/:placeId (venue card)',
    field: 'confidenceMeasurement',
    read: async () => {
      const res = await call('GET', `/api/crowd/${freshId('CARD')}?localHour=20&localDay=5`);
      assert.strictEqual(res.status, 200, res.text);
      return res.body;
    },
  },
  {
    name: 'POST /api/crowd/batch (the list under the card)',
    field: 'confidenceMeasurement',
    read: async () => {
      const id = freshId('BATCH');
      const res = await call('POST', '/api/crowd/batch', {
        venues: [{ place_id: id, name: id, types: ['bar'] }],
        localHour: 20,
        localDay: 5,
      });
      assert.strictEqual(res.status, 200, res.text);
      assert.strictEqual(res.body.predictions.length, 1, 'the batch dropped the only venue it was given');
      return res.body.predictions[0];
    },
  },
  {
    name: 'POST /api/ai/chat -> get_crowd_prediction (Birdie)',
    field: 'confidence_measurement',
    read: async () => {
      freshUser(); // Birdie meters per account per day
      sendImpl = crowdToolTurn(freshId('BIRDIE'));
      const res = await call('POST', '/api/ai/chat', { messages: [{ role: 'user', text: 'how busy is it' }] });
      assert.strictEqual(res.status, 200, res.text);
      const results = birdieToolResults();
      assert.strictEqual(results.length, 1, 'the crowd tool did not run');
      return results[0];
    },
  },
  {
    name: 'GET /api/public/demo/venue/:placeId (marketing demo)',
    field: 'confidence_measurement',
    read: async () => {
      const res = await call('GET', `/api/public/demo/venue/${freshId('DEMO')}?localHour=20&localDay=5`);
      assert.strictEqual(res.status, 200, res.text);
      return res.body;
    },
  },
];

const BLOCK_KEYS = [
  'means', 'measuredPercent', 'metric', 'population', 'populationRows',
  'publishedPercent', 'status', 'userReportBoost', 'weatherPenalty',
]; // sorted

// ===========================================================================
// SECTION 1 — every surface forwards the block, in every state
// ===========================================================================

for (const surface of SURFACES) {
  for (const state of ['measured', 'unmeasured', 'rule_engine']) {
    test(`${surface.name} publishes the measurement block [${state}]`, async () => {
      STATE = state;
      const payload = await surface.read();

      assert.strictEqual(typeof payload.confidence, 'number',
        `${surface.name} stopped publishing a confidence integer; if that is deliberate, delete this surface from the list rather than leaving the assertion to rot`);

      const block = payload[surface.field];
      assert.ok(block && typeof block === 'object' && !Array.isArray(block),
        `${surface.name} published confidence ${payload.confidence} with no \`${surface.field}\`. ` +
        'A bare percentage cannot say whether it is a measured hit rate or a metadata ladder, and the ladder is the BIGGER number.');

      assert.deepStrictEqual(Object.keys(block).sort(), BLOCK_KEYS,
        `${surface.name} [${state}]: the block's key set drifted. Every state on every surface ships the same keys so a client branches on \`status\`, never on a key being present.`);

      // The published integer is described by the block, always.
      assert.strictEqual(block.publishedPercent, payload.confidence,
        `${surface.name} [${state}]: publishedPercent ${block.publishedPercent} is not the \`confidence\` ${payload.confidence} the payload actually shipped`);

      if (state === 'measured') {
        assert.strictEqual(block.status, 'measured');
        assert.strictEqual(block.means, 'measured_accuracy');
        assert.strictEqual(block.metric, 'within_15');
        assert.strictEqual(block.population, 'realtime_served');
        assert.strictEqual(block.populationRows, MEASURED_BLOCK.populationRows);
        assert.strictEqual(block.measuredPercent, MEASURED_PERCENT);
      } else {
        assert.strictEqual(block.status, 'unmeasured',
          `${surface.name} [${state}]: a number nobody measured was published as \`measured\``);
        assert.strictEqual(block.means, 'input_completeness');
        assert.strictEqual(block.metric, 'venue_metadata_completeness');
        assert.strictEqual(block.population, null);
        assert.strictEqual(block.populationRows, null);
        assert.strictEqual(block.measuredPercent, null,
          `${surface.name} [${state}]: an unmeasured payload named a measured percentage`);
      }
    });
  }
}

// ===========================================================================
// SECTION 2 — the inversion, stated as a test
//
// If this test ever has to be edited because the measured figure overtook the
// ladder, good. Until then it is the reason none of the above is optional.
// ===========================================================================

test('the unmeasured number is the larger one, and only the block tells them apart', async () => {
  const surface = SURFACES[0];

  STATE = 'measured';
  const measured = await surface.read();
  STATE = 'unmeasured';
  const unmeasured = await surface.read();

  assert.ok(unmeasured.confidence > measured.confidence,
    'this test is built on the shipping numbers: the input-completeness ladder (72) outranks the measured accuracy (33). ' +
    'If that has changed, re-derive it rather than deleting the assertion.');

  // Two payloads, and the more ignorant one carries the higher number. The ONLY
  // thing separating them is the block, so a client that reads the integer and
  // skips the block reads them backwards.
  assert.notStrictEqual(measured.confidenceMeasurement.status, unmeasured.confidenceMeasurement.status);
  assert.notStrictEqual(measured.confidenceMeasurement.means, unmeasured.confidenceMeasurement.means);
  assert.strictEqual(unmeasured.confidenceMeasurement.measuredPercent, null,
    'the payload that measured nothing must not name a measured percentage');
});

// ===========================================================================
// SECTION 3 — the rule-engine path, which has no block to forward
// ===========================================================================

test('the rule-engine path publishes the unmeasured block rather than nothing', async () => {
  // The predictor attaches no block here, on purpose: no model measurement was
  // used. The route cannot pass that silence on, because an ABSENT field is
  // what a client falls back from into rendering the bare number as an
  // accuracy. What it publishes instead is not a placeholder — on this path
  // `confidence` IS crowdEngine's input-completeness ladder, the same quantity
  // the predictor's own unmeasured branch publishes, so the unmeasured block is
  // the accurate description of it.
  STATE = 'rule_engine';

  for (const surface of SURFACES) {
    const payload = await surface.read();
    const block = payload[surface.field];
    assert.ok(block, `${surface.name}: the rule-engine path published a naked confidence`);
    assert.strictEqual(block.status, 'unmeasured', surface.name);
    assert.strictEqual(block.means, 'input_completeness', surface.name);
    assert.strictEqual(block.measuredPercent, null, surface.name);
    assert.strictEqual(block.publishedPercent, payload.confidence, surface.name);
    assert.deepStrictEqual(Object.keys(block).sort(), BLOCK_KEYS,
      `${surface.name}: the synthesized block must have the SAME key set as the model's, or a client needs a second parser for it`);
  }
});

test('which engine answered is still published, and it is a different question from what the number means', async () => {
  // The block deliberately does not distinguish "the model ran and could not
  // state an accuracy" from "the rule engine answered": the number means the
  // same thing in both cases. The distinction that DOES exist is provenance of
  // the ANSWER, and the card already ships it in its own fields.
  STATE = 'rule_engine';
  const card = await SURFACES[0].read();
  assert.strictEqual(card.predictionMethod, 'rule_engine_fallback');
  assert.strictEqual(card.confidenceBasis, 'category_pattern');
});

// ===========================================================================
// SECTION 4 — the user-report boost: the published number is not the measured one
// ===========================================================================

const report = (userId) => ({
  venue_place_id: 'X',
  day_of_week: 5,
  hour: 20,
  crowd_level: 3, // CROWD_LEVEL_TO_SCORE only knows 1..3; anything else is dropped as unreadable
  predicted_score: 50,
  user_id: userId,
  created_at: new Date(),
});

test('a boosted confidence never reads as the measured percentage', async () => {
  STATE = 'measured';
  FEEDBACK_ROWS = [report(11), report(12), report(13)];

  const card = await SURFACES[0].read();
  const block = card.confidenceMeasurement;

  // crowdEngine.publishedConfidence added min(15, 3 * 3) for three verified
  // reporters, so the integer on the card is no longer the model's figure.
  assert.strictEqual(block.userReportBoost, 9, 'the boost that moved the number is not declared');
  assert.strictEqual(card.confidence, MEASURED_CONFIDENCE + 9);
  assert.strictEqual(block.publishedPercent, card.confidence);

  // The measured figure is still reported, unchanged and clearly separate — it
  // is a property of the MODEL, not of this payload's integer.
  assert.strictEqual(block.measuredPercent, MEASURED_PERCENT);
  assert.notStrictEqual(Math.round(block.measuredPercent), card.confidence,
    'if these two are ever equal by construction the payload stops being able to distinguish them');

  // And the arithmetic closes, so a reader never has to guess where the gap
  // came from: published = measured - weatherPenalty + boost.
  assert.strictEqual(
    card.confidence,
    Math.max(0, Math.min(100, Math.round(block.measuredPercent) - block.weatherPenalty + block.userReportBoost)),
    'the published integer cannot be reconstructed from the block, so the block does not explain it'
  );
});

test('with no reports the boost is declared as zero rather than left unstated', async () => {
  STATE = 'measured';
  const card = await SURFACES[0].read();
  assert.strictEqual(card.confidenceMeasurement.userReportBoost, 0);
  assert.strictEqual(card.confidence, MEASURED_CONFIDENCE);
});

// ===========================================================================
// SECTION 5 — the normalizer itself: it fails toward "unmeasured"
// ===========================================================================

const { confidenceMeasurementFor } = require('../routes/crowd');

test('anything that is not a complete measured block degrades to unmeasured', () => {
  const good = { ...MEASURED_BLOCK };
  const bad = [
    ['no prediction at all', undefined],
    ['no block on the prediction', {}],
    ['a null block', { confidenceMeasurement: null }],
    ['a block that is an array', { confidenceMeasurement: [] }],
    ['a block that is a string', { confidenceMeasurement: 'measured' }],
    ['an unknown status', { confidenceMeasurement: { ...good, status: 'probably' } }],
    ['measured status, input_completeness means', { confidenceMeasurement: { ...good, means: 'input_completeness' } }],
    ['measured status, no percent', { confidenceMeasurement: { ...good, measuredPercent: null } }],
    ['measured status, a percent that is a string', { confidenceMeasurement: { ...good, measuredPercent: '33.3' } }],
    ['measured status, NaN percent', { confidenceMeasurement: { ...good, measuredPercent: NaN } }],
  ];
  for (const [what, prediction] of bad) {
    const block = confidenceMeasurementFor(prediction, 72, 0);
    assert.strictEqual(block.status, 'unmeasured', `${what}: was published as a measurement`);
    assert.strictEqual(block.means, 'input_completeness', what);
    assert.strictEqual(block.measuredPercent, null, what);
    assert.deepStrictEqual(Object.keys(block).sort(), BLOCK_KEYS, what);
  }
});

test('a slice with no row count keeps a null row count instead of becoming zero', () => {
  // readServedAccuracy allows `rows: null` (the artifact reported the metric
  // without a population size) while a row count of ZERO is the malformed case
  // the load gate refuses. Coercing one into the other would publish a refused
  // shape as a served one.
  const block = confidenceMeasurementFor(
    { confidenceMeasurement: { ...MEASURED_BLOCK, populationRows: null } }, 33, 0);
  assert.strictEqual(block.status, 'measured');
  assert.strictEqual(block.populationRows, null);
});

test('an unreadable published number is reported as null, not as a substitute', () => {
  for (const junk of [undefined, null, NaN, 'high', {}]) {
    const block = confidenceMeasurementFor({ confidenceMeasurement: { ...MEASURED_BLOCK } }, junk, 0);
    assert.strictEqual(block.publishedPercent, null, `publishedPercent invented a value for ${String(junk)}`);
  }
  for (const junk of [undefined, null, NaN, 'lots']) {
    assert.strictEqual(confidenceMeasurementFor({}, 60, junk).userReportBoost, 0);
  }
});

test('the normalizer does not mutate the predictor\'s own block', () => {
  // The predictor's result is also read by __tests__/confidenceHonesty.test.js
  // and by anything else downstream; a normalizer that wrote its route-level
  // fields into that object would make the predictor appear to publish them.
  const prediction = { confidenceMeasurement: { ...MEASURED_BLOCK } };
  const block = confidenceMeasurementFor(prediction, 48, 15);
  assert.deepStrictEqual(prediction.confidenceMeasurement, { ...MEASURED_BLOCK });
  assert.notStrictEqual(block, prediction.confidenceMeasurement);
});

// ===========================================================================
// SECTION 6 — the source sweep: no fifth surface
//
// The behavioural tests above can only see the surfaces they know about. The
// failure this file exists for was a whole payload nobody remembered, so the
// last check is a sweep: ANY object literal in routes/ that publishes a
// `confidence` must publish the block that explains it, whether or not a test
// above drives it.
//
// WHAT THE SWEEP CANNOT SEE, stated rather than papered over: a confidence
// published under a different NAME (`crowd_confidence`, `certainty`, a score
// out of 5). Text matching cannot chase a rename. A fifth surface would have to
// invent a new name to escape both this and the behavioural tests above, and if
// one does, the fix is to add it to SURFACES rather than to widen this regex
// until it matches prose.
// ===========================================================================

const codeOf = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

// The innermost object literal containing `at`. Walks left to the unmatched
// `{`, then right to its partner.
function enclosingLiteral(src, at) {
  let depth = 0;
  let start = -1;
  for (let i = at; i >= 0; i--) {
    const c = src[i];
    if (c === '}') depth++;
    else if (c === '{') {
      if (depth === 0) { start = i; break; }
      depth--;
    }
  }
  if (start < 0) return null;
  depth = 0;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return null;
}

test('every payload in routes/ that publishes a confidence publishes the block with it', () => {
  const dir = path.join(BACKEND, 'routes');
  const offenders = [];
  let found = 0;
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    const src = codeOf(fs.readFileSync(path.join(dir, file), 'utf8'));
    const re = /(?<![A-Za-z0-9_$.])confidence\s*:/g;
    let m;
    while ((m = re.exec(src))) {
      found++;
      const literal = enclosingLiteral(src, m.index);
      const line = src.slice(0, m.index).split('\n').length;
      if (!literal) {
        offenders.push(`  ${file}:${line} — could not find the enclosing object literal; check this by hand`);
        continue;
      }
      if (!/\bconfidence(_m|M)easurement\s*:/.test(literal)) {
        offenders.push(`  ${file}:${line} — publishes \`confidence\` with no measurement block beside it`);
      }
    }
  }
  assert.ok(found >= 4,
    `only ${found} payload(s) in routes/ publish a confidence; this sweep has stopped looking at anything`);
  assert.deepStrictEqual(offenders, [],
    'a confidence integer is being published with nothing to say what it measures. ' +
    'The unmeasured ladder (72) outranks the measured accuracy (33), so a bare number is read backwards:\n' +
    offenders.join('\n'));
});

test('Birdie is told how to read the number, not just handed it', async () => {
  // Every other surface hands the block to code. This one hands it to a
  // language model, and a model given `confidence: 72` with no instruction will
  // narrate 72 as certainty — the exact inversion, in prose, where no client
  // code can intercept it. Forwarding the block without the rule would be a
  // footnote for a reader who does not read footnotes, so the two ship
  // together and are pinned together.
  STATE = 'unmeasured';
  freshUser();
  sendImpl = crowdToolTurn(freshId('PROMPT'));
  const res = await call('POST', '/api/ai/chat', { messages: [{ role: 'user', text: 'how packed is it' }] });
  assert.strictEqual(res.status, 200, res.text);

  const prompt = String(sendCalls[0].config.systemInstruction);
  assert.match(prompt, /confidence_measurement/,
    'the tool now returns confidence_measurement and the prompt never mentions it, so the model has no reason to read it');
  assert.match(prompt, /[Nn]ever quote the .?confidence.? number/,
    'nothing stops Birdie reciting the confidence integer as a certainty');
  assert.match(prompt, /unmeasured/,
    'the prompt does not name the state in which the number is not an accuracy');
  // The rule lives with the other hard rules, where the model treats it as one.
  assert.ok(prompt.indexOf('Hard rules:') < prompt.indexOf('confidence_measurement'),
    'the confidence rule drifted out of the hard-rules block');
});

test('the normalizer is defined once and imported, not copied', () => {
  // Same rule, and the same reason, as the forecast policy in routes/crowd.js:
  // a second private copy of "may this number be called an accuracy" is exactly
  // how one surface keeps publishing the old claim after the others stop.
  const crowdSrc = fs.readFileSync(path.join(BACKEND, 'routes', 'crowd.js'), 'utf8');
  assert.match(crowdSrc, /function confidenceMeasurementFor/,
    'the shared normalizer has left routes/crowd.js; the other two routes import it from there');
  assert.match(crowdSrc, /module\.exports\.confidenceMeasurementFor/,
    'routes/crowd.js no longer exports the normalizer');

  for (const file of ['ai.js', 'publicCrowd.js']) {
    const src = codeOf(fs.readFileSync(path.join(BACKEND, 'routes', file), 'utf8'));
    assert.match(src, /confidenceMeasurementFor\s*[,}]?[\s\S]{0,80}require\('\.\/crowd'\)/,
      `routes/${file} no longer imports confidenceMeasurementFor from routes/crowd.js`);
    assert.ok(!/function confidenceMeasurementFor/.test(src),
      `routes/${file} grew its own copy of the normalizer`);
  }
});
