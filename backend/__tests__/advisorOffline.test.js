// Run: node --test __tests__/advisorOffline.test.js  (from backend/)
//
// ===========================================================================
// ROOST WITH THE MODEL OUT (2026-10-28).
//
// The day this was written, the Gemini key's prepaid credits ran out and
// every call answered 402. Chips fell back to their templates, but each tap
// still charged the venue's meters for a call that could only fail, and
// every typed question came back "we could not get to it", including the
// ones a keyword could have placed and the money questions the playbook
// answers. Pinned here, through the real routes:
//
//   1. A typed question that meets a dead key is still answered: by the
//      venue's own numbers (the template) or by the playbook.
//   2. The failure opens the breaker, so the NEXT question makes no model
//      call and charges no meter at all.
//   3. The class check the router's answer would have faced still applies,
//      and a question nothing can place keeps the sentence it had.
//   4. Both routes say what to ask next.
//   5. With the model up, the advice payload carries the playbook's moves.
// ===========================================================================

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const http = require('node:http');

process.env.JWT_SECRET = 'advisor-offline-test-secret';

const pool = require('../config/database');

let handlers = [];
let queryLog = [];
pool.query = (sql, params) => {
  const flat = String(sql).replace(/\s+/g, ' ').trim();
  queryLog.push({ sql: flat, params: params || [] });
  for (const [re, fn] of handlers) {
    if (re.test(flat)) return Promise.resolve(fn(params || [], flat) || { rows: [], rowCount: 0 });
  }
  return Promise.resolve({ rows: [], rowCount: 0 });
};

const authMod = require('../middleware/auth');
authMod.authenticate = (req, _res, next) => { req.user = { id: 7, name: 'Ava', role: 'venue_owner' }; next(); };

const advisorPhrasing = require('../services/advisorPhrasing');
const advisorFreeText = require('../services/advisorFreeText');
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

async function post(path, body) {
  const res = await fetch(`${base}/api/venue/advisor/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}
const ask = (question) => post('question', { question });
const chip = (intentId) => post('ask', { intentId });

let modelCalls = [];
let replies = [];
advisorPhrasing.__setGenAIForTests({
  models: {
    generateContent: async (args) => {
      modelCalls.push(args);
      const next = replies.shift();
      if (next === undefined) throw new Error('model called more times than the test scripted');
      if (next instanceof Error) throw next;
      return { text: next, usageMetadata: { totalTokenCount: 120 } };
    },
  },
});

const credits = () => Object.assign(
  new Error('{"error":{"code":402,"message":"Your prepayment credits are depleted."}}'),
  { status: 402 },
);

const PROFILE = {
  user_id: 7,
  google_place_id: 'place-x',
  verified: true,
  business_name: 'Test Room',
  updated_at: '2026-10-01T00:00:00Z',
  corpus_status: 'baselines',
  capacity: 60,
  service_style: 'seated_table',
  typical_spend_per_person: 35,
};

const WEEK = [
  { id: 'peak_2026-11-03', value: { weekday: 'Tuesday', peakHour: 18, peakScore: 38 }, source: 'model_holdout', asOf: '2026-10-27T22:00:00Z', label: 'Tuesday projects busiest around 6 PM, at 38 on our 0 to 100 index.' },
  { id: 'peak_2026-11-07', value: { weekday: 'Saturday', peakHour: 20, peakScore: 88 }, source: 'model_holdout', asOf: '2026-10-27T22:00:00Z', label: 'Saturday projects busiest around 8 PM, at 88 on our 0 to 100 index.' },
];

function charges() {
  return queryLog.filter((q) => /INSERT INTO advisor_(venue_)?spend/.test(q.sql)).length;
}

function resetAll() {
  handlers = [];
  queryLog = [];
  modelCalls = [];
  replies = [];
  advisorPhrasing.__resetAdvisorSpend();
  process.env.ADVISOR_PHRASING_ENABLED = 'true';
  process.env.ADVISOR_FREETEXT_ENABLED = 'true';
  delete process.env.VENUE_BILLING_ENABLED;
  handlers.push([/^SELECT roost_ai_consent_at FROM users WHERE id = \$1$/, () => ({ rows: [{ roost_ai_consent_at: '2026-10-18T12:00:00Z' }], rowCount: 1 })]);
  handlers.push([/INSERT INTO advisor_venue_spend/, () => ({ rows: [{ tokens: 1 }], rowCount: 1 })]);
  handlers.push([/INSERT INTO advisor_spend/, () => ({ rows: [{ tokens: 1 }], rowCount: 1 })]);
  handlers.push([/FROM venue_profiles WHERE user_id/, () => ({ rows: [PROFILE], rowCount: 1 })]);
  handlers.push([/FROM ml_venues WHERE google_place_id/, () => ({ rows: [{ name: 'Test Room', venue_category: 'restaurant', timezone: 'UTC' }], rowCount: 1 })]);
  advisorRouter.__setFactsForTests(async (_userId, intentId) => ({ intent: intentId, facts: WEEK.map((f) => ({ ...f })), refusals: [] }));
}

test('a money question that meets a dead key is answered from the playbook, in the venue\'s own money', async () => {
  resetAll();
  replies = [credits()];
  const r = await ask('how do I fill Tuesdays');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.mode, 'advice', r.body.text);
  assert.strictEqual(modelCalls.length, 1, 'one call met the dead key, and nothing called it again');
  assert.ok(r.body.sources.some((s) => s.source === 'roost_playbook'), 'the answer says it came from the playbook');
  assert.match(r.body.text, /^Tuesday projects as your quietest day this week\./, 'it leads with the venue\'s own forecast');
  assert.match(r.body.text, /At your \$35 a head/, 'and puts the move in the venue\'s own money');
  assert.ok(r.body.followUps.length > 0, 'and says what to ask next');
});

test('once the key is known dead, the next question makes no call and charges nothing', async () => {
  resetAll();
  replies = [credits()];
  await ask('how do I fill Tuesdays');
  const callsBefore = modelCalls.length;
  const chargesBefore = charges();

  const grounded = await ask('when are we busiest this week');
  assert.strictEqual(grounded.body.mode, 'template', 'the venue\'s own numbers, from the template');
  assert.strictEqual(grounded.body.intentId, 'peak_hours');
  assert.match(grounded.body.text, /^Your busiest day this week is Saturday, with its peak around 8 PM at 88/);
  // The twin ends on one move from the playbook, and says so in its sources.
  assert.strictEqual(grounded.body.text.split('\n').length, 3);
  assert.deepStrictEqual(grounded.body.sources.map((s) => s.source), ['model_holdout', 'model_holdout', 'roost_playbook']);

  const advice = await ask('what should my food cost be');
  assert.strictEqual(advice.body.mode, 'advice');

  const tapped = await chip('quiet_nights');
  assert.strictEqual(tapped.body.mode, 'template');

  assert.strictEqual(modelCalls.length, callsBefore, 'no call was made against a key known to be dead');
  assert.strictEqual(charges(), chargesBefore, 'and no meter was charged for one');
});

test('the class check still stands in front of the offline route, and an unplaceable question keeps its sentence', async () => {
  resetAll();
  advisorPhrasing.internals.noteModelFailure(credits());
  const legal = await ask('may I require a team member to remain after their rota ends?');
  assert.strictEqual(legal.body.mode, 'refusal');
  assert.match(legal.body.text, /law|qualified/i);

  const lost = await ask('what is the capital of france');
  assert.strictEqual(lost.body.mode, 'refusal');
  assert.strictEqual(lost.body.text, advisorFreeText.REFUSAL_BUSY);
  assert.deepStrictEqual(lost.body.followUps, undefined, 'a refusal offers nothing to tap');
  assert.strictEqual(modelCalls.length, 0);
});

test('a chip answer says what to ask next, and names the day it found', async () => {
  resetAll();
  replies = ['{"answer": "Tuesday is your quietest day this week.", "points": []}'];
  const r = await chip('quiet_nights');
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.body.followUps, [
    { kind: 'question', text: 'How do I fill Tuesdays?' },
    { kind: 'intent', id: 'peak_hours', label: 'When do we peak this week?' },
  ]);
});

test('with the model up, the advice payload carries the playbook\'s moves as data', async () => {
  resetAll();
  replies = [
    '{"mode":"advice","intentId":null}',
    '{"answer": "Start one recurring event on your slowest day.", "points": ["A discount mostly moves regulars who would have paid full price."]}',
  ];
  const r = await ask('how do I make Tuesdays better');
  assert.strictEqual(r.body.mode, 'advice');
  assert.match(r.body.text, /^Start one recurring event/);
  assert.ok(r.body.sources.some((s) => s.source === 'trade_practice'), 'a model answer is sourced as trade practice');
  const payload = modelCalls[1].contents[0].parts[0].text;
  assert.match(payload, /PLAYBOOK MOVES\. Proven moves from the trade/);
  assert.ok(!/"id":"slow_day/.test(payload), 'no tactic id rides to the model');
  assert.ok(r.body.followUps.some((f) => f.kind === 'question'), 'the playbook\'s next step is offered');
});
