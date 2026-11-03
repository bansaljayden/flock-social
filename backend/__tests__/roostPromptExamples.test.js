// Run: node --test __tests__/roostPromptExamples.test.js  (from backend/)
//
// ===========================================================================
// EVERY ID A ROOST PROMPT WRITES IS ONE A REAL PAYLOAD CARRIES (2026-11-03).
//
// The model copies the contracts' worked examples, ids and all. In the third
// round of the 2026-11-03 live eval a restaurant's "how do I fill Tuesdays"
// draft wrote {{fact:spend}}, the advice example's spelling, beside two ids
// it had read correctly off its own block. The block carried the spend per
// head as intake_typical_spend_per_person, the unknown id voided the draft,
// and the playbook answered instead. Round one had found the same thing with
// {{fact:peak_score}}. So every id in the prompts is the one the real
// builders hand the model, and this file proves it against payloads the real
// routes build for made-up venues, with only the database, the forecast
// model, the weather and the table sensor stubbed:
//
//   1. Every placeholder in the prompts is well formed, and every id in one is
//      listed by the PLACEHOLDER IDS line of a real payload. The one exception
//      is the grammar's own {{fact:id}}, which no payload carries.
//   2. Every worked example is drawn from one real payload, named in
//      EXAMPLE_PAYLOADS below: its ids are all on that payload's line, the
//      facts they name are the ones its setup line says, and sent back as the
//      model's reply to that payload it passes the real answer check with
//      nothing dropped. An example added without an entry fails here.
//   3. The router's worked examples route only to intents and reasons its own
//      closed lists hold, and those lists hold only what the code accepts.
// ===========================================================================

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const http = require('node:http');

process.env.JWT_SECRET = 'roost-prompt-examples-test-secret';
process.env.ADVISOR_PHRASING_ENABLED = 'true';
process.env.ADVISOR_FREETEXT_ENABLED = 'true';
delete process.env.VENUE_BILLING_ENABLED;
delete process.env.ROOST_PLAYBOOK_FIRST;

// ── The made-up venues ──────────────────────────────────────────────────────

const TZ = 'America/New_York';
const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

// `days` is each weekday's strength, Sunday first (Date#getDay), and the
// forecast stub below peaks it at `peakHour`. The bar's Tuesday is its
// quietest day and the restaurant is the one with a table sensor.
const VENUES = {
  cafe: {
    profile: { capacity: 28, service_style: 'counter_order', typical_spend_per_person: 11, kitchen_last_order: '14:30', owner_busy_nights: ['saturday', 'sunday'] },
    category: 'cafe', hours: range(7, 14), peakHour: 9, days: [84, 62, 44, 51, 49, 66, 91],
  },
  restaurant: {
    profile: { capacity: 70, service_style: 'seated_table', reservation_policy: 'reservations_accepted', typical_spend_per_person: 35, kitchen_last_order: '21:30', owner_busy_nights: ['friday', 'saturday'] },
    category: 'restaurant', hours: range(11, 21), peakHour: 19, days: [61, 41, 38, 47, 55, 82, 88], tables: true,
  },
  bar: {
    profile: { capacity: 120, service_style: 'bar_standing', typical_spend_per_person: 35, last_call: '23:30', event_nights: ['thursday'], owner_busy_nights: ['friday', 'saturday'] },
    category: 'bar', hours: range(17, 23), peakHour: 22, days: [40, 30, 24, 36, 64, 90, 94],
  },
};
let venue = null; // the venue the next request is about

function profileRow(name) {
  return {
    user_id: 7, google_place_id: `place-${name}`, verified: true, business_name: `Test ${name}`,
    updated_at: '2026-10-01T00:00:00Z', corpus_status: 'baselines', corpus_baseline_rows: 168, corpus_checked_at: '2026-10-01',
    ...VENUES[name].profile,
  };
}
function mlRow(name) {
  const v = VENUES[name];
  return {
    name: `Test ${name}`, latitude: 40.7128, longitude: -74.006, venue_category: v.category,
    google_types: [v.category], price_level: 2, rating: 4.4, review_count: 120, timezone: TZ,
  };
}
function curveRows(name) {
  const v = VENUES[name];
  const rows = [];
  for (let day = 0; day <= 6; day++) {
    for (const hour of v.hours) rows.push({ day_of_week: day, hour, baseline: Math.max(1, v.days[day] - Math.abs(v.peakHour - hour) * 4), source: 'google', updated_at: '2026-05-18' });
  }
  return rows;
}

// The venue's own yesterday, worked out the way services/lastNightVerdict.js
// works it out, so the stubbed readings land on the day it grades.
const DAY_MS = 86400000;
function venueYesterday(now = new Date()) {
  const offset = require('../services/advisorFacts').tzOffsetMinutes(TZ, now);
  const shifted = new Date(now.getTime() + (offset === null ? 0 : offset) * 60000);
  return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate() - 1)).toISOString().slice(0, 10);
}
const daysBefore = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) - n * DAY_MS).toISOString().slice(0, 10);
// Yesterday well under the four same weekdays before it: a below verdict.
function readingRows() {
  const y = venueYesterday();
  return [
    { day: y, peak_reading: 37, readings: 3, diverged: false },
    ...[[7, 55], [14, 57], [21, 53], [28, 56]].map(([n, peak]) => ({ day: daysBefore(y, n), peak_reading: peak, readings: 2, diverged: false })),
  ];
}

function tableStats(days) {
  if (!VENUES[venue].tables) {
    return { days, seatings: 0, turn_minutes: { median: null, by_hour: [] }, waited_share: null, clear_minutes_median: null, full_hours: [], timeZone: TZ };
  }
  return {
    days,
    seatings: days === 7 ? 64 : 240,
    turn_minutes: { median: 52.4, by_hour: [] },
    waited_share: 0.184,
    clear_minutes_median: 4.2,
    full_hours: [{ dow: 5, hour: 19, share: 0.8 }, { dow: 5, hour: 20, share: 0.9 }, { dow: 6, hour: 20, share: 0.6 }],
    timeZone: TZ,
  };
}

// ── The stubs: the database, the forecast model, the weather, the tables ────

const pool = require('../config/database');

const rows = (list) => ({ rows: list, rowCount: list.length });
const forTables = (list) => rows(VENUES[venue].tables ? list : []);
const HANDLERS = [
  [/roost_ai_consent_at FROM users/, () => rows([{ roost_ai_consent_at: '2026-10-18T12:00:00.000Z' }])],
  [/INSERT INTO advisor_(?:venue_)?spend/, () => rows([{ tokens: 1 }])],
  [/FROM venue_profiles WHERE user_id/, () => rows([profileRow(venue)])],
  [/FROM ml_venues WHERE google_place_id/, () => rows([mlRow(venue)])],
  [/FROM ml_venue_baselines/, () => rows(curveRows(venue))],
  [/FROM venue_owner_reports/, () => rows(readingRows())],
  [/FROM night_context_runs/, () => rows([{ watched: true }])],
  [/FROM night_context nc/, () => rows(range(18, 22).map((hour) => ({ hour, temp: 52, conditions: 'light rain', is_raining: true })))],
  [/FROM sensor_table_seatings s .*::date = /, () => forTables([{ seatings: 42, waited: 6, turn_median: 55.4, day: venueYesterday() }])],
  [/FROM venue_sensor_data v .*GROUP BY 1$/, () => forTables([{ hour: 19, readings: 60, full_readings: 50 }, { hour: 20, readings: 60, full_readings: 40 }])],
  [/EXTRACT\(DOW FROM \(s\.seated_at/, () => forTables([
    { dow: 2, seatings: 30, turn_median: 48.2, waited_share: 0.04 },
    { dow: 5, seatings: 64, turn_median: 61.2, waited_share: 0.22 },
  ])],
  [/GROUP BY s\.table_no/, () => forTables([{ table_no: 7, seatings: 25, waited: 10 }, { table_no: 3, seatings: 30, waited: 3 }])],
  [/GROUP BY d\.dow, d\.hour/, () => forTables([{ dow: 5, hour: 20, weeks: 8, free_weeks: 2 }, { dow: 6, hour: 20, weeks: 8, free_weeks: 7 }])],
];
pool.query = async (sql) => {
  const flat = String(sql).replace(/\s+/g, ' ').trim();
  for (const [re, fn] of HANDLERS) if (re.test(flat)) return fn();
  return rows([]);
};

// Before the router is required: it takes the middleware at load.
const authMod = require('../middleware/auth');
authMod.authenticate = (req, _res, next) => { req.user = { id: 7, name: 'Ava', role: 'venue_owner' }; next(); };

const mlPredictor = require('../services/mlPredictor');
const weatherService = require('../services/weatherService');
const tableHistory = require('../services/tableHistory');

mlPredictor.predictBusyness = async (v, _weather, ts) => {
  const spec = VENUES[String(v.place_id).replace(/^place-/, '')];
  const t = new Date(ts);
  return {
    score: Math.max(1, spec.days[t.getDay()] - Math.abs(spec.peakHour - t.getHours()) * 4),
    label: 'Busy',
    predictionMethod: 'ml',
    modelVersion: 'v2.6.0-starling',
  };
};
mlPredictor._internals.getNearbyEvents = async () => ({ hasEvent: false, observed: true, nearestDistance: 0, nearestName: null, nearestType: null });
weatherService.getWeather = async () => ({ temp: 61, conditions: 'clear sky', isRaining: false });
weatherService.getForecast = async () => [];
tableHistory.venueTimeZone = async () => TZ;
tableHistory.tableStats = async (_placeId, days) => tableStats(days);

const advisorPhrasing = require('../services/advisorPhrasing');
const advisorFreeText = require('../services/advisorFreeText');
const prompts = require('../services/advisorPrompt');
const advisorRouter = require('../routes/advisor');

// The model: a scripted queue, and every request it was sent.
let modelCalls = [];
let replies = [];
advisorPhrasing.__setGenAIForTests({
  models: {
    generateContent: async (req) => {
      modelCalls.push(req);
      const next = replies.shift();
      if (next === undefined) throw new Error('the model was called more times than this test scripted');
      return { text: next, usageMetadata: { totalTokenCount: 100 } };
    },
  },
});

const app = express();
app.use(express.json());
app.use('/api/venue/advisor', advisorRouter);
const server = http.createServer(app);
let base;
test.before(() => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); });
}));
test.after(() => new Promise((resolve) => server.close(resolve)));

async function post(route, body) {
  const res = await fetch(`${base}/api/venue/advisor/${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

// ── Reading the prompts ─────────────────────────────────────────────────────

const PLACEHOLDER = /\{\{fact:([^}]*)\}\}/g;
// The grammar's own name for "an id", in the rule that defines the grammar.
const GRAMMAR_ID = 'id';
const idsIn = (text) => [...String(text).matchAll(PLACEHOLDER)].map((m) => m[1]);
const ANSWER_CONTRACTS = { SYSTEM_PROMPT: prompts.SYSTEM_PROMPT, ADVICE_SYSTEM_PROMPT: prompts.ADVICE_SYSTEM_PROMPT };

// Each worked example: the setup line before it, the question it asks, the
// JSON the model is shown, and the ids that JSON writes.
function examplesOf(prompt) {
  const lines = prompt.slice(prompt.indexOf('\nEXAMPLES\n')).split('\n');
  const out = [];
  lines.forEach((line, i) => {
    if (!/^\{"answer": /.test(line)) return;
    const asked = String(lines[i - 1] || '').match(/ asks "([^"]+)"/);
    out.push({ setup: lines[i - 1], question: asked ? asked[1] : null, json: line, ids: idsIn(line) });
  });
  return out;
}

// ── The payload each worked example is drawn from ───────────────────────────
//
// `chip` asks POST /ask; `route` is the router's reply to the example's own
// question on POST /question, the way the router prompt routes it. `holds`
// checks that the ids name the facts the setup line says they do. null is an
// example no payload is built for, and it may write no id.
const EXAMPLE_PAYLOADS = {
  SYSTEM_PROMPT: {
    'When do we peak this week?': {
      venue: 'cafe',
      chip: 'peak_hours',
      // "each day after today has its own letter ... the fifth day ... _d"
      holds: ({ ids }) => {
        const days = ids.filter((id) => /^peak_weekday(?:_[a-z])?$/.test(id));
        assert.strictEqual(days.length, 7, 'a forecast peak for each of the next seven days');
        assert.strictEqual(days[0], 'peak_weekday', 'today first, its ids bare');
        assert.strictEqual(days[4], 'peak_weekday_d', 'the fifth day\'s ids end in _d');
      },
    },
    'How did we do yesterday?': {
      venue: 'bar',
      chip: 'last_night_verdict',
      // "yesterday's reading, the usual reading for that weekday, the gap"
      holds: ({ byId }) => {
        assert.ok(byId.owner_reading_peakReading.value < byId.owner_weekday_baseline_middleReading.value, 'yesterday came in under the usual');
        assert.ok(byId.last_day_verdict_pointsBelow, 'and the gap rides with them');
      },
    },
    'What does a busy reading mean in people?': {
      venue: 'restaurant',
      chip: 'capacity_math',
      holds: ({ byId }) => {
        assert.strictEqual(byId.intake_capacity.source, 'intake', 'the owner\'s own capacity');
        assert.strictEqual(byId.capacity_at_projected_peak_approxPeople.source, 'arithmetic', 'the people the peak works out to');
      },
    },
  },
  ADVICE_SYSTEM_PROMPT: {
    'How do I make Tuesdays better?': {
      venue: 'bar',
      route: { mode: 'advice', intentId: 'quiet_nights' },
      // "the week's two quietest days, the quietest first, and Tuesday is the
      // quietest": the bare peak ids are the quietest day's.
      holds: ({ facts, byId }) => {
        assert.strictEqual(byId.peak_weekday.value, 'Tuesday');
        const scores = facts.filter((f) => /^peak_score(?:_[a-z])?$/.test(f.id)).map((f) => f.value);
        assert.strictEqual(scores.length, 2, 'the two quietest days');
        assert.strictEqual(byId.peak_score.value, Math.min(...scores), 'the quietest first');
        assert.strictEqual(byId.intake_typical_spend_per_person.unit, 'usd', 'the owner\'s spend per head');
      },
    },
    'What should my food cost be?': { venue: 'cafe', route: { mode: 'advice', intentId: null } },
    'What should I charge for a lunch special?': {
      venue: 'restaurant',
      route: { mode: 'advice', intentId: null },
      holds: ({ byId }) => assert.strictEqual(byId.intake_typical_spend_per_person.unit, 'usd'),
    },
    'Should I add a server on Fridays?': {
      venue: 'restaurant',
      route: { mode: 'advice', intentId: 'tables_service' },
      holds: ({ byId }) => {
        assert.strictEqual(byId.tables_turn_friday_weekday.value, 'Friday', 'its own table sensor\'s Fridays');
        assert.strictEqual(byId.tables_turn_friday_waitedPercent.source, 'table_sensor');
      },
    },
    // The advice contract's own refusal shape. The routes decline this before
    // any payload is built, so it is checked on its own and writes no id.
    'Can I make the door staff stay unpaid after close?': null,
  },
};

const FACT_BLOCK_AFTER = /^(?:THE FACT BLOCK:|FACTS ABOUT THIS VENUE\. .*)$/;
const IDS_LINE = /^PLACEHOLDER IDS\. The only ones that exist; copy one exactly or write none: (.*)$/m;

// Ask the way an owner (or a chip) would, answer with `reply`, and read back
// the payload the model was sent and what the owner was shown.
async function ask(scenario, question, reply) {
  venue = scenario.venue;
  modelCalls = [];
  advisorPhrasing.__resetAdvisorSpend();
  replies = scenario.chip ? [reply] : [JSON.stringify(scenario.route), reply];
  const res = scenario.chip
    ? await post('ask', { intentId: scenario.chip })
    : await post('question', { question });
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  const call = modelCalls.find((c) => c.config.systemInstruction !== prompts.CLASSIFIER_PROMPT);
  assert.ok(call, `no answer call was made for "${question}"`);
  assert.strictEqual(call.config.systemInstruction, scenario.chip ? prompts.SYSTEM_PROMPT : prompts.ADVICE_SYSTEM_PROMPT,
    `"${question}" was answered under the other contract`);
  const payload = call.contents[0].parts[0].text;
  const lines = payload.split('\n');
  const at = lines.findIndex((l) => FACT_BLOCK_AFTER.test(l));
  const facts = at >= 0 ? JSON.parse(lines[at + 1]).facts : [];
  const line = payload.match(IDS_LINE);
  const ids = line ? line[1].split(', ') : [];
  assert.deepStrictEqual(ids, facts.map((f) => f.id), 'the PLACEHOLDER IDS line names the block\'s facts, in order');
  return { res, payload, facts, ids, byId: Object.fromEntries(facts.map((f) => [f.id, f])) };
}

// Every example with a payload, answered once; the tests below read the
// results.
let ran = null;
function runExamples() {
  ran = ran || (async () => {
    const out = [];
    for (const [name, prompt] of Object.entries(ANSWER_CONTRACTS)) {
      for (const example of examplesOf(prompt)) {
        const scenario = (EXAMPLE_PAYLOADS[name] || {})[example.question];
        if (!scenario) continue;
        out.push({ name, example, scenario, ...await ask(scenario, example.question, example.json) });
      }
    }
    return out;
  })();
  return ran;
}

// ── 1. Every placeholder is well formed and real ────────────────────────────

test('every placeholder in the three prompts is well formed: every {{ opens one and every id is letters and underscores', () => {
  for (const [name, prompt] of Object.entries(prompts)) {
    if (typeof prompt !== 'string') continue;
    const ids = idsIn(prompt);
    assert.strictEqual((prompt.match(/\{\{/g) || []).length, ids.length, `${name}: a {{ that is not a {{fact:id}} placeholder`);
    assert.strictEqual((prompt.match(/\}\}/g) || []).length, ids.length, `${name}: a }} that closes no placeholder`);
    for (const id of ids) assert.match(id, /^[A-Za-z_]+$/, `${name}: {{fact:${id}}} is not an id the placeholder grammar can carry`);
  }
  // The grammar's own name sits in the rule that defines it, once per contract.
  for (const [name, prompt] of Object.entries(ANSWER_CONTRACTS)) {
    assert.strictEqual(idsIn(prompt).filter((id) => id === GRAMMAR_ID).length, 1, `${name}: {{fact:${GRAMMAR_ID}}} is the grammar, not an example`);
  }
  assert.strictEqual(idsIn(prompts.CLASSIFIER_PROMPT).length, 0, 'the router reads no facts and writes no placeholder');
});

test('every id the prompts write, worked examples and the rules\' own quoted ones, is on the PLACEHOLDER IDS line of a payload the real routes build', async () => {
  const results = await runExamples();
  const real = new Set(results.flatMap((r) => r.ids));
  assert.ok(!real.has(GRAMMAR_ID), `no payload carries {{fact:${GRAMMAR_ID}}}, so the grammar's name can never be copied into a real one`);
  for (const [name, prompt] of Object.entries(ANSWER_CONTRACTS)) {
    for (const id of new Set(idsIn(prompt))) {
      if (id === GRAMMAR_ID) continue;
      assert.ok(real.has(id), `${name} writes {{fact:${id}}}, and no payload the real builders made lists it`);
    }
  }
  // And none of the spellings the live evals caught the model copying.
  for (const made of ['spend', 'quiet_day', 'peak_day', 'people_at_peak', 'waited_share', 'kitchen_last_order', 'service_style', 'capacity', 'reading', 'usual', 'readings']) {
    assert.ok(!real.has(made), `${made} is not a real id`);
    for (const [name, prompt] of Object.entries(ANSWER_CONTRACTS)) {
      assert.ok(!idsIn(prompt).includes(made), `${name} writes {{fact:${made}}} again`);
    }
  }
});

// ── 2. Each worked example is one real payload's ────────────────────────────

test('every worked example names the payload it is drawn from, and writes only ids that payload lists', async () => {
  for (const [name, prompt] of Object.entries(ANSWER_CONTRACTS)) {
    const examples = examplesOf(prompt);
    assert.ok(examples.length >= 3, `${name}: the examples were found`);
    for (const example of examples) {
      assert.ok(example.question, `${name}: an example whose setup line names no question: ${example.setup}`);
      assert.ok(Object.prototype.hasOwnProperty.call(EXAMPLE_PAYLOADS[name], example.question),
        `${name}: "${example.question}" is a new example. Name the payload it is drawn from in EXAMPLE_PAYLOADS.`);
      if (EXAMPLE_PAYLOADS[name][example.question] === null) {
        assert.deepStrictEqual(example.ids, [], `${name}: "${example.question}" has no payload, so it may write no id`);
      }
    }
    for (const question of Object.keys(EXAMPLE_PAYLOADS[name])) {
      assert.ok(examples.some((e) => e.question === question), `${name}: EXAMPLE_PAYLOADS names "${question}", which is no longer an example`);
    }
  }
  const results = await runExamples();
  for (const r of results) {
    for (const id of r.example.ids) {
      assert.ok(r.ids.includes(id), `${r.name}: "${r.example.question}" writes {{fact:${id}}}, which its own payload does not list (${r.ids.join(', ')})`);
    }
    if (r.scenario.holds) r.scenario.holds(r);
  }
});

test('every worked example, sent back as the model\'s reply to its own payload, passes the real answer check with nothing dropped', async () => {
  const results = await runExamples();
  assert.strictEqual(results.length, 7, 'seven examples carry a payload');
  for (const r of results) {
    const points = JSON.parse(r.example.json).points.length;
    const label = `${r.name}: "${r.example.question}"`;
    assert.strictEqual(r.res.body.mode, r.scenario.chip ? 'phrased' : 'advice', `${label} was not served as written: ${r.res.body.text}`);
    assert.ok(!(r.res.body.sources || []).some((s) => s.source === 'roost_playbook'), `${label} was thrown out and the playbook answered`);
    assert.strictEqual(r.res.body.text.split('\n').length, points + 1, `${label} lost a line to the check: ${r.res.body.text}`);
    assert.ok(!/\{\{|\}\}/.test(r.res.body.text), `${label} reached the owner with a placeholder in it`);
  }
  // The one with no payload passes the advice check on its own.
  const [refusal] = examplesOf(prompts.ADVICE_SYSTEM_PROMPT).filter((e) => EXAMPLE_PAYLOADS.ADVICE_SYSTEM_PROMPT[e.question] === null);
  const out = advisorFreeText.applyAdviceValve(refusal.json, []);
  assert.ok(out, refusal.json);
  assert.strictEqual(out.text.split('\n').length, JSON.parse(refusal.json).points.length + 1);
});

// ── 3. The router's examples route only where its lists go ──────────────────

test('the router\'s worked examples route only to intents and reasons its closed lists hold, and those lists hold only what the code accepts', () => {
  const p = prompts.CLASSIFIER_PROMPT;
  const between = (from, to) => p.slice(p.indexOf(from), p.indexOf(to));
  const listed = (text) => (text.match(/^ {2}([a-z_]+)\s/gm) || []).map((s) => s.trim());
  const intents = listed(between('THE INTENT IDS', 'FRUSTRATION IS NOT A ROUTE'));
  const reasons = listed(between('THE REFUSAL REASONS', 'MODE "refused"'));
  assert.ok(intents.length >= 15 && reasons.length >= 5, 'both lists were found');
  for (const id of intents) assert.ok(advisorPhrasing.isKnownIntent(id), `the router lists ${id}, which is no intent`);
  for (const why of reasons) assert.ok(advisorFreeText.REFUSAL_REASONS.includes(why), `the router lists ${why}, which is no refusal reason`);

  const examples = (between('WORKED EXAMPLES', 'THE FENCE').match(/^ {2}\{.*\}$/gm) || []).map((s) => s.trim());
  assert.ok(examples.length >= 20, 'the worked examples were found');
  for (const raw of examples) {
    const route = advisorFreeText.parseRoute(raw);
    assert.ok(route, `the router's own example does not parse: ${raw}`);
    if (route.intentId) assert.ok(intents.includes(route.intentId), `${raw} routes to an intent the list does not name`);
    if (route.mode === 'refused') assert.ok(reasons.includes(route.why), `${raw} refuses for a reason the list does not name`);
  }
});
