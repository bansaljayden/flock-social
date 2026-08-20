// Run: node --test  (from backend/)
//
// ===========================================================================
// THE ADVISOR'S ONE-WAY VALVE, pinned.
//
// services/advisorPhrasing.js is Layer C of the venue advisor: an LLM that is
// allowed to touch wording and nothing else. These tests pin the properties
// that make that true STRUCTURALLY, so a prompt edit or a model swap cannot
// quietly re-open the fabricated-stats hole this dashboard already had once
// (the Pro Tips box deleted 2026-08-14):
//
//   1. The model writes {{fact:id}} placeholders; the server substitutes real
//      values AFTER generation. Any bare digit in raw model output rejects
//      the whole response to the deterministic template twin. So do em
//      dashes, causal verbs, unknown fact ids, and sentences citing nothing.
//   2. ADVISOR_PHRASING_ENABLED default OFF: the template twin serves and the
//      model is never constructed, so the surface works with zero LLM calls.
//   3. Chips only: /ask accepts an intentId from the closed registry and
//      nothing else. Free text is a 400 by SHAPE, before validation.
//   4. requireVenueTier('pro') guards every advisor endpoint.
//   5. Ceilings are charged BEFORE the call and fail closed to the template:
//      50 phrased answers per venue per day, and a Postgres-backed global
//      token wall (advisor_spend) that refuses when the database cannot count.
//   6. No em dash in any template string, chip, or the system prompt itself
//      (SLOP-AUDIT rule 1, enforced on the strings, not just requested).
// ===========================================================================

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

process.env.JWT_SECRET = 'advisor-phrasing-test-secret';

const pool = require('../config/database');

// pg fake: scripted per test; every statement logged.
let handlers = [];
let queryLog = [];
pool.query = (sql, params) => {
  const flat = String(sql).replace(/\s+/g, ' ').trim();
  queryLog.push({ sql: flat, params: params || [] });
  for (const [re, fn] of handlers) {
    if (re.test(flat)) {
      try {
        const out = fn(params || [], flat);
        return Promise.resolve(out === undefined ? { rows: [], rowCount: 0 } : out);
      } catch (err) {
        return Promise.reject(err);
      }
    }
  }
  return Promise.resolve({ rows: [], rowCount: 0 });
};

// authenticate must be patched BEFORE the router requires it.
const authMod = require('../middleware/auth');
let CURRENT_USER = { id: 7, name: 'Ava', role: 'venue_owner' };
authMod.authenticate = (req, _res, next) => { req.user = CURRENT_USER; next(); };

const advisorPhrasing = require('../services/advisorPhrasing');
const advisorRouter = require('../routes/advisor');

const app = express();
app.use(express.json());
app.use('/api/venue/advisor', advisorRouter);

let base;
const server = http.createServer(app);
test.before(() => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => {
    base = `http://127.0.0.1:${server.address().port}`;
    resolve();
  });
}));
test.after(() => new Promise((resolve) => server.close(resolve)));

async function post(pathname, body) {
  const res = await fetch(base + pathname, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}
async function get(pathname) {
  const res = await fetch(base + pathname);
  return { status: res.status, body: await res.json() };
}

// ── Fixtures ────────────────────────────────────────────────────────────────

const PEAK_BLOCK = () => ({
  intent: 'peak_hours',
  facts: [
    { id: 'peak_hour', value: 21, unit: 'hour', source: 'model_holdout', asOf: '2026-08-19T22:00:00Z', label: 'Projected peak tonight is 9 PM. An estimate, not a promise.' },
    { id: 'kitchen_last_order', value: '21:00', source: 'intake', asOf: 'owner-set 2026-08-18', label: 'You told us your kitchen takes its last order at 21:00.' },
  ],
  refusals: [],
});

const REFUSED_BLOCK = () => ({
  intent: 'peak_hours',
  facts: [],
  refusals: ['This venue is not in our measured corpus yet, so there is no forecast to stand on. Your own slider readings build history that does not depend on the corpus.'],
});

// A genAI fake whose next reply is scripted per test. Throws when a test
// declares the model must never be reached.
let modelCalls = [];
let nextModelReply = null; // string | Error | function(args)
const fakeGenAI = {
  models: {
    generateContent: async (args) => {
      modelCalls.push(args);
      if (nextModelReply instanceof Error) throw nextModelReply;
      const text = typeof nextModelReply === 'function' ? nextModelReply(args) : nextModelReply;
      if (text instanceof Error) throw text;
      return { text, usageMetadata: { totalTokenCount: 100 } };
    },
  },
};

function allowGlobalSpend() {
  handlers.push([/INSERT INTO advisor_spend/, () => ({ rows: [{ tokens: 1 }], rowCount: 1 })]);
}

// advisor_venue_spend (migration 037) stands in for the Map the per-venue
// meters used to live in, so the caps are still exercised now that Postgres
// holds them. This fake implements the migration's conditional upsert
// faithfully rather than always allowing: the answer and token caps are the
// point of the table, and a permissive stub would delete the test that proves
// a venue stops phrasing at its ceiling.
let venueLedger = new Map();
function installVenueLedger() {
  handlers.push([/INSERT INTO advisor_venue_spend/, (params) => {
    const [id, tokens, maxAnswers, maxTokens] = params;
    const row = venueLedger.get(id) || { answers: 0, tokens: 0 };
    if (row.answers + 1 > maxAnswers) return { rows: [], rowCount: 0 };
    if (row.tokens + Number(tokens) > maxTokens) return { rows: [], rowCount: 0 };
    row.answers += 1;
    row.tokens += Number(tokens);
    venueLedger.set(id, row);
    return { rows: [{ tokens: row.tokens }], rowCount: 1 };
  }]);
  // The settle true-up, which is deliberately uncapped: see settleTokens.
  handlers.push([/UPDATE advisor_venue_spend/, (params) => {
    const [delta, id] = params;
    const row = venueLedger.get(id);
    if (row) row.tokens += Number(delta);
    return { rows: [], rowCount: row ? 1 : 0 };
  }]);
}

function resetAll({ flag } = {}) {
  handlers = [];
  queryLog = [];
  modelCalls = [];
  nextModelReply = null;
  venueLedger = new Map();
  installVenueLedger();
  advisorPhrasing.__resetAdvisorSpend();
  advisorPhrasing.__setGenAIForTests(fakeGenAI);
  if (flag) process.env.ADVISOR_PHRASING_ENABLED = 'true';
  else delete process.env.ADVISOR_PHRASING_ENABLED;
  delete process.env.VENUE_BILLING_ENABLED;
  advisorRouter.__setFactsForTests(null);
}

// ── 1. The valve ────────────────────────────────────────────────────────────

test('a bare digit anywhere in raw model output rejects the whole response to the template twin', async () => {
  resetAll({ flag: true });
  allowGlobalSpend();
  nextModelReply = 'Expect around 45 people at {{fact:peak_hour}} tonight.';
  const out = await advisorPhrasing.phrase(PEAK_BLOCK(), { venueUserId: 7 });
  assert.strictEqual(out.mode, 'template');
  assert.ok(!out.text.includes('45'), 'the fabricated number must never reach the owner');
  assert.strictEqual(modelCalls.length, 1, 'rejection must not regenerate: a ceiling that retries itself is not a ceiling');
});

test('clean placeholder output is substituted server-side and returned as phrased', async () => {
  resetAll({ flag: true });
  allowGlobalSpend();
  nextModelReply = 'The forecast estimates your peak at {{fact:peak_hour}}. You told us the kitchen takes its last order at {{fact:kitchen_last_order}}. Worth a look: these two line up.';
  const out = await advisorPhrasing.phrase(PEAK_BLOCK(), { venueUserId: 7 });
  assert.strictEqual(out.mode, 'phrased');
  assert.ok(out.text.includes('9pm'), `hour fact substituted, got: ${out.text}`);
  assert.ok(out.text.includes('21:00'), 'intake fact substituted verbatim');
  assert.ok(!out.text.includes('{{'), 'no placeholder survives substitution');
  // The connective sentence cites no fact and must not render.
  assert.ok(!out.text.includes('Worth a look'), 'a sentence that cites nothing does not render');
  assert.deepStrictEqual(out.sources.map((s) => s.id).sort(), ['kitchen_last_order', 'peak_hour']);
});

test('an unknown {{fact:id}} rejects the whole response', async () => {
  resetAll({ flag: true });
  allowGlobalSpend();
  nextModelReply = 'Your peak is {{fact:peak_hour}} and revenue was {{fact:weekly_revenue}}.';
  const out = await advisorPhrasing.phrase(PEAK_BLOCK(), { venueUserId: 7 });
  assert.strictEqual(out.mode, 'template');
});

test('an em dash or a causal verb in model output rejects to the template', async () => {
  resetAll({ flag: true });
  allowGlobalSpend();
  nextModelReply = 'Your peak lands at {{fact:peak_hour}} — a strong slot.';
  let out = await advisorPhrasing.phrase(PEAK_BLOCK(), { venueUserId: 7 });
  assert.strictEqual(out.mode, 'template', 'em dash rejected');

  nextModelReply = 'Your peak sits at {{fact:peak_hour}} because your kitchen closes at {{fact:kitchen_last_order}}.';
  out = await advisorPhrasing.phrase(PEAK_BLOCK(), { venueUserId: 7 });
  assert.strictEqual(out.mode, 'template', 'causal verb rejected: covariation, never causation');
});

test('valve unit: digit-bearing fact ids are aliased away and object values flattened before the model sees them', () => {
  const conditioned = advisorPhrasing.aliasFacts(advisorPhrasing.flattenFacts([
    { id: 'served_2026-08-14', value: { serves: 3, medianScore: 41 }, source: 'served_prediction', asOf: '2026-08-14' },
  ]));
  assert.ok(conditioned.length === 2, 'one fact per scalar entry');
  for (const f of conditioned) {
    assert.ok(!/\d/.test(f.id), `placeholder id must be digit-free, got ${f.id}`);
    assert.strictEqual(f.sourceId, 'served_2026-08-14', 'original id preserved for the sources chip');
  }
});

// ── 1b. The template twin does not repeat itself ────────────────────────────
//
// "When do we peak this week" is seven facts that agree about everything except
// a weekday and a number, and the twin printed the hedge and the provenance
// chip on every one of them: seven near-identical paragraphs for one sentence
// of information. The sourcing rule is kept by moving it, not by dropping it.

const WEEK_BLOCK = () => ({
  intent: 'week_ahead',
  facts: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((day, i) => ({
    id: `peak_day_${i}`,
    value: 21,
    unit: 'hour',
    source: 'model_holdout',
    asOf: '2026-08-19T22:00:00Z',
    label: `${day} projects busiest around 9 PM. This is an estimate, not a promise of foot traffic.`,
  })),
  refusals: [],
});

test('one source and one date across a whole answer prints one footer, not one per line', () => {
  const out = advisorPhrasing.renderTemplate(WEEK_BLOCK());
  const lines = out.text.split('\n');
  assert.strictEqual(lines.length, 8, 'seven facts and one footer');
  // The hedge and the chip appear once each, at the foot, under the facts
  // they cover.
  assert.strictEqual(out.text.match(/not a promise of foot traffic/g).length, 1);
  assert.strictEqual(out.text.match(/as of Aug 19/g).length, 1);
  assert.match(lines[7], /^This is an estimate, not a promise of foot traffic\. \(.*as of Aug 19\.\)$/);
  // Every fact still says its own thing, in full.
  assert.strictEqual(lines[0], 'Sunday projects busiest around 9 PM.');
  assert.strictEqual(lines[6], 'Saturday projects busiest around 9 PM.');
  // And the answer still carries a source per fact for the chip.
  assert.strictEqual(out.sources.length, 7);
});

test('facts that disagree about their source keep their own chip on every line', () => {
  // PEAK_BLOCK mixes a model estimate with the owner's own testimony. A single
  // footer over those two would attribute one to the other.
  const out = advisorPhrasing.renderTemplate(PEAK_BLOCK());
  const lines = out.text.split('\n');
  assert.strictEqual(lines.length, 2, 'no footer line was added');
  assert.match(lines[0], /Model estimate, as of Aug 19\.\)$/);
  assert.match(lines[1], /You told us.*\)$/);
});

test('a single fact is unchanged: nothing to hoist, nothing to collapse', () => {
  const one = { intent: 'peak_hours', facts: [PEAK_BLOCK().facts[0]], refusals: [] };
  const out = advisorPhrasing.renderTemplate(one);
  assert.strictEqual(out.text.split('\n').length, 1);
  assert.match(out.text, /An estimate, not a promise\. \(Model estimate, as of Aug 19\.\)$/);
});

// ── 2. Flag off (the default) ───────────────────────────────────────────────

test('with ADVISOR_PHRASING_ENABLED unset the template twin serves and the model is never called', async () => {
  resetAll(); // flag not set
  nextModelReply = new Error('the model must never be reached with the flag off');
  const out = await advisorPhrasing.phrase(PEAK_BLOCK(), { venueUserId: 7 });
  assert.strictEqual(out.mode, 'template');
  assert.strictEqual(modelCalls.length, 0);
  assert.ok(out.text.includes('9 PM'), 'the template prints Layer B\'s own label sentence');
  assert.ok(/you told us/i.test(out.text), 'owner facts carry owner attribution');
});

test('a refusal block never reaches the model even with the flag on, and names the missing data', async () => {
  resetAll({ flag: true });
  nextModelReply = new Error('refusals are rendered by the server, not phrased');
  const out = await advisorPhrasing.phrase(REFUSED_BLOCK(), { venueUserId: 7 });
  assert.strictEqual(out.mode, 'refusal');
  assert.strictEqual(modelCalls.length, 0);
  assert.ok(out.text.includes('measured corpus'), 'the refusal says what is missing');
  assert.ok(!/upgrade/i.test(out.text), 'no upsell inside a refusal, ever');
});

// ── 3. Ceilings, charged before the call, failing closed to the template ───

test('the per-venue daily ceilings bite, degrade to the template twin, and stop calling the model', async () => {
  resetAll({ flag: true });
  allowGlobalSpend();
  nextModelReply = 'Your peak lands at {{fact:peak_hour}}.';

  // With the ten-page system prompt each call estimates at roughly seven to
  // eight thousand tokens, so the 150k per-venue token ledger binds first, at
  // around nineteen phrased answers, well before the 50-answer product cap.
  // The exact count floats with the prompt's length; what is pinned here is
  // the ORDER of behavior: a run of phrased answers, then templates forever,
  // with zero model calls past the ceiling.
  let phrased = 0;
  let firstRefusedAt = null;
  for (let i = 0; i < advisorPhrasing.PER_VENUE_DAILY_ANSWERS + 1; i++) {
    const out = await advisorPhrasing.phrase(PEAK_BLOCK(), { venueUserId: 7 });
    if (out.mode === 'phrased') {
      assert.strictEqual(firstRefusedAt, null, 'once a ceiling refuses, it stays refused for the day');
      phrased += 1;
    } else if (firstRefusedAt === null) {
      firstRefusedAt = i;
    }
  }
  assert.ok(phrased >= 10, `a real day's worth of answers phrases before the wall (got ${phrased})`);
  assert.ok(firstRefusedAt !== null, 'some ceiling must bite inside the answer cap');
  assert.ok(phrased <= advisorPhrasing.PER_VENUE_DAILY_ANSWERS, 'the answer cap is the outer bound');
  assert.strictEqual(modelCalls.length, phrased, 'past the ceiling, no call is made: charge-before-call');
});

test('the global Postgres token wall refuses BEFORE the call, and a dead database refuses too', async () => {
  resetAll({ flag: true });
  // Conditional upsert returns no row: the wall is reached.
  handlers.push([/INSERT INTO advisor_spend/, () => ({ rows: [], rowCount: 0 })]);
  nextModelReply = 'Your peak lands at {{fact:peak_hour}}.';
  let out = await advisorPhrasing.phrase(PEAK_BLOCK(), { venueUserId: 7 });
  assert.strictEqual(out.mode, 'template');
  assert.strictEqual(modelCalls.length, 0, 'charge-before-call: the wall refuses the call itself');

  // The venue ledger stays healthy so the GLOBAL one is what is on trial here.
  handlers = [];
  installVenueLedger();
  handlers.push([/INSERT INTO advisor_spend/, () => { throw new Error('connection refused'); }]);
  out = await advisorPhrasing.phrase(PEAK_BLOCK(), { venueUserId: 7 });
  assert.strictEqual(out.mode, 'template', 'a spend control that cannot count refuses');
  assert.strictEqual(modelCalls.length, 0);
});

test('a model name the API refuses falls back once to the known-good default', async () => {
  resetAll({ flag: true });
  allowGlobalSpend();
  const notFound = Object.assign(new Error('model not found'), { status: 404 });
  let first = true;
  nextModelReply = () => {
    if (first) { first = false; throw notFound; }
    return 'Your peak lands at {{fact:peak_hour}}.';
  };
  const out = await advisorPhrasing.phrase(PEAK_BLOCK(), { venueUserId: 7 });
  assert.strictEqual(out.mode, 'phrased');
  assert.strictEqual(modelCalls.length, 2);
  assert.strictEqual(modelCalls[1].model, advisorPhrasing.FALLBACK_ADVISOR_MODEL);
  assert.strictEqual(advisorPhrasing.advisorModel(), advisorPhrasing.FALLBACK_ADVISOR_MODEL);
});

// ── 4. The route: chips only, tier-gated, no write path ────────────────────

test('POST /ask validates intentId against the registry and rejects anything else', async () => {
  resetAll();
  advisorRouter.__setFactsForTests(async (userId, intentId) => PEAK_BLOCK());
  const ok = await post('/api/venue/advisor/ask', { intentId: 'peak_hours' });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.body.mode, 'template');

  const unknown = await post('/api/venue/advisor/ask', { intentId: 'tell_me_secrets' });
  assert.strictEqual(unknown.status, 400);

  const numeric = await post('/api/venue/advisor/ask', { intentId: 42 });
  assert.strictEqual(numeric.status, 400);
});

test('free text is rejected by shape with a clear message, before anything reads it', async () => {
  resetAll();
  advisorRouter.__setFactsForTests(async () => { throw new Error('the fact engine must never see a free-text request'); });
  const r = await post('/api/venue/advisor/ask', { intentId: 'peak_hours', text: 'why is the bar down the street busier than me?' });
  assert.strictEqual(r.status, 400);
  assert.ok(/suggested questions/i.test(r.body.error), `the refusal explains the contract, got: ${r.body.error}`);
});

test('requireVenueTier(pro) guards /ask: a free venue gets the 403 UPGRADE_REQUIRED contract when billing is on', async () => {
  resetAll();
  process.env.VENUE_BILLING_ENABLED = 'true';
  process.env.ADMIN_USER_IDS = '1';
  handlers.push([/FROM venue_profiles vp LEFT JOIN venue_subscriptions/, () => ({ rows: [{ tier: 'free' }], rowCount: 1 })]);
  advisorRouter.__setFactsForTests(async () => PEAK_BLOCK());
  const r = await post('/api/venue/advisor/ask', { intentId: 'peak_hours' });
  assert.strictEqual(r.status, 403);
  assert.strictEqual(r.body.code, 'UPGRADE_REQUIRED');
  assert.strictEqual(r.body.requiredTier, 'pro');
  delete process.env.VENUE_BILLING_ENABLED;
});

test('every advisor endpoint sits behind authenticate + a venue tier gate (source pin)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'advisor.js'), 'utf8');
  for (const m of src.matchAll(/router\.(get|post|put|delete|patch)\(\s*'([^']+)'\s*,\s*([^,]+),\s*(\w+)/g)) {
    const [, method, route, mw1, mw2] = m;
    assert.strictEqual(mw1.trim(), 'authenticate', `${method.toUpperCase()} ${route} authenticates first`);
    assert.ok(/^requirePro$|^requirePremium$/.test(mw2), `${method.toUpperCase()} ${route} is tier-gated, got ${mw2}`);
    assert.ok(method === 'get' || route === '/ask' || route === '/question',
      'the advisor has no write path: its two POSTs (/ask, /question) only read');
  }
});

// ── 5. Copy: no em dashes anywhere the owner can see (SLOP-AUDIT rule 1) ───

test('no em dash in any template string, chip, refusal frame, or the system prompt', () => {
  const strings = [...advisorPhrasing.__copyStrings(), advisorPhrasing.SYSTEM_PROMPT];
  for (const s of strings) {
    assert.ok(!s.includes('—'), `em dash found in: ${s.slice(0, 60)}`);
  }
  // And in rendered output, both modes, from representative blocks.
  const t = advisorPhrasing.renderTemplate(PEAK_BLOCK());
  const r = advisorPhrasing.renderRefusal(REFUSED_BLOCK());
  assert.ok(!t.text.includes('—'));
  assert.ok(!r.text.includes('—'));
});

test('registry ids are digit-free so every chip intent can survive the valve', () => {
  for (const id of Object.keys(advisorPhrasing.ADVISOR_INTENTS)) {
    assert.ok(!/\d/.test(id), `intent id ${id} contains a digit`);
  }
});

test('GET /questions serves four lead chips plus the rest grouped, every registry id exactly once', async () => {
  resetAll();
  const r = await get('/api/venue/advisor/questions');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.name, advisorPhrasing.ADVISOR_NAME);
  // Four visible, because the chips are whole sentences and a phone that shows
  // five shows a wall. The rest live behind the client's disclosure.
  assert.strictEqual(r.body.lead.length, 4, 'four lead chips, not the whole registry');
  // The lead is CHIP_PRIORITY's own head, in order. This pins the mechanism,
  // not the running order: which four an owner sees first is a product call
  // that belongs in the priority list, and a test that hard-coded one id would
  // turn every reordering into a test edit.
  assert.deepStrictEqual(
    r.body.lead.map((q) => q.id),
    advisorPhrasing.CHIP_PRIORITY.slice(0, 4),
    'the lead is the priority list head, in order'
  );
  const served = [...r.body.lead.map((q) => q.id), ...r.body.groups.flatMap((g) => g.questions.map((q) => q.id))];
  assert.deepStrictEqual(served.slice().sort(), Object.keys(advisorPhrasing.ADVISOR_INTENTS).sort(),
    'lead plus grouped is the registry: no chip the server refuses, no intent without a chip');
  assert.strictEqual(new Set(served).size, served.length, 'no chip appears twice');
  for (const g of r.body.groups) {
    assert.ok(g.label && g.questions.length > 0, `group ${g.id} is labeled and non-empty`);
  }
  // Events and weather are the prettiest card and the least asked question, so
  // they are last in the offer order, never in the lead.
  assert.ok(!r.body.lead.some((q) => q.id === 'around_you'), 'events and weather do not lead');
});

test('a venue outside the corpus is offered only the questions that can answer, not a menu of refusals', async () => {
  resetAll();
  handlers.push([/FROM venue_profiles WHERE user_id/, () => ({
    rows: [{
      user_id: 7, google_place_id: 'place-x', verified: true, business_name: 'Test',
      corpus_status: 'absent', corpus_baseline_rows: null, corpus_checked_at: null,
      capacity: null, kitchen_last_order: null, owner_busy_nights: null,
    }],
    rowCount: 1,
  })]);
  handlers.push([/FROM ml_venues WHERE google_place_id/, () => ({ rows: [], rowCount: 0 })]);
  // No readings and nothing served in the window either.
  handlers.push([/SELECT EXISTS/, () => ({ rows: [{ readings: false, served: false }], rowCount: 1 })]);

  const r = await get('/api/venue/advisor/questions');
  assert.strictEqual(r.status, 200);
  const served = [...r.body.lead.map((q) => q.id), ...r.body.groups.flatMap((g) => g.questions.map((q) => q.id))];
  // A dead button is never offered: nothing model backed survives the corpus
  // gate, and nothing history backed survives an empty window.
  for (const id of ['peak_hours', 'tonight_outlook', 'weekend_outlook', 'quiet_nights',
    'kitchen_vs_peak', 'capacity_math', 'busy_nights_check',
    'week_recap', 'slow_night', 'readings_vs_estimates', 'last_day_compare']) {
    assert.ok(!served.includes(id), `${id} is not offered to a venue that cannot be given it`);
  }
  // The two that need neither the corpus nor a reading are always there.
  assert.ok(served.includes('around_you') && served.includes('data_status'));
  assert.ok(served.length < Object.keys(advisorPhrasing.ADVISOR_INTENTS).length,
    'the offer is a subset, not the whole registry');
});
