// Run: node --test __tests__/advisorFollowOn.test.js  (from backend/)
//
// ===========================================================================
// FOLLOW-ONS, PINNED (2026-10-28).
//
// "What else?" after a move the owner did not like, and "what about
// Wednesdays?" after a Tuesday answer, used to arrive alone and get "we could
// not get to that one". The chat now sends the last answer's context back as
// `previous`, and services/advisorFollowOn.js reads the new question against
// it. What has to hold:
//
//   1. `previous` IS CLIENT INPUT. Every part of it is checked against a
//      closed list (the router's intents, the playbook's move ids, the same
//      question sanitiser), and anything malformed is refused.
//   2. ONLY TWO SHAPES USE IT. A bare request for another idea, and a swap of
//      the day or the part of the day. A question that stands on its own is
//      answered as written, context or not.
//   3. THE QUESTION THAT RESULTS IS STILL A QUESTION THE OWNER ASKED. "What
//      else" goes to the router with the earlier question beside it, so the
//      screens see both; the route tests in advisorFreeText.test.js pin that.
// ===========================================================================

const test = require('node:test');
const assert = require('node:assert');

const { readPrevious, followOn, MAX_PREVIOUS_TACTICS } = require('../services/advisorFollowOn');
const advisorFreeText = require('../services/advisorFreeText');
const advisorPhrasing = require('../services/advisorPhrasing');

const CHECKS = { sanitize: advisorFreeText.sanitizeQuestion, isIntent: (id) => advisorPhrasing.isKnownIntent(id) };
const LIMITS = { maxChars: advisorFreeText.FREE_TEXT_MAX_CHARS };
const TUESDAYS = { question: 'how do i fill tuesdays', intentId: 'quiet_nights', tactics: ['slow_day_recurring_reason'] };

// ── 1. `previous` is client input ───────────────────────────────────────────

test('a well-formed previous is read, and an absent one is no context at all', () => {
  assert.deepStrictEqual(readPrevious(undefined, CHECKS), { ok: true, previous: null });
  assert.deepStrictEqual(readPrevious(TUESDAYS, CHECKS), { ok: true, previous: TUESDAYS });
  assert.deepStrictEqual(readPrevious({ question: 'how do i fill tuesdays' }, CHECKS),
    { ok: true, previous: { question: 'how do i fill tuesdays', intentId: null, tactics: [] } });
  assert.deepStrictEqual(readPrevious({ ...TUESDAYS, intentId: null }, CHECKS).previous.intentId, null);
  // A repeated move id is one move.
  assert.deepStrictEqual(
    readPrevious({ ...TUESDAYS, tactics: ['slow_day_recurring_reason', 'slow_day_recurring_reason'] }, CHECKS).previous.tactics,
    ['slow_day_recurring_reason'],
  );
});

test('anything malformed in previous is refused, whole', () => {
  for (const bad of [
    null, 'how do i fill tuesdays', ['how do i fill tuesdays'], 42, {},
    { question: 42 }, { question: '   ' }, { question: 'a'.repeat(advisorFreeText.FREE_TEXT_MAX_CHARS + 1) },
    { ...TUESDAYS, extra: true },
    { ...TUESDAYS, intentId: 'not_an_intent' }, { ...TUESDAYS, intentId: 7 },
    { ...TUESDAYS, tactics: 'slow_day_recurring_reason' }, { ...TUESDAYS, tactics: ['made_up_move'] },
    { ...TUESDAYS, tactics: [7] }, { ...TUESDAYS, tactics: Array(MAX_PREVIOUS_TACTICS + 1).fill('slow_day_recurring_reason') },
  ]) {
    assert.deepStrictEqual(readPrevious(bad, CHECKS), { ok: false }, JSON.stringify(bad).slice(0, 80));
  }
});

// ── 2. Only two shapes use it ───────────────────────────────────────────────

test('a bare request for another idea is the last question with its moves set aside', () => {
  for (const said of ['what else?', 'What else can we do', 'ok what else', 'thanks, any other ideas?', 'another idea',
    'something else', 'more ideas', 'give me another one', 'we already tried that', 'that won\'t work for us',
    'hmm, what else could we try?']) {
    const out = followOn(said, TUESDAYS, LIMITS);
    assert.strictEqual(out.kind, 'else', said);
    assert.strictEqual(out.question, `how do i fill tuesdays ${said}`, said);
    assert.deepStrictEqual(out.exclude, ['slow_day_recurring_reason'], said);
  }
});

test('a question that stands on its own is answered as written, context or not', () => {
  for (const said of ['what else should i do to fill wednesdays', 'should we add delivery', 'when are we busiest',
    'what about adding a happy hour', 'how do i get more reviews']) {
    const out = followOn(said, TUESDAYS, LIMITS);
    assert.deepStrictEqual(out, { question: said, kind: null, exclude: [], previous: null }, said);
  }
  assert.deepStrictEqual(followOn('what else?', null, LIMITS), { question: 'what else?', kind: null, exclude: [], previous: null });
});

test('a swapped day or part of the day goes into the last question', () => {
  const swap = (said, question) => followOn(said, { question, intentId: null, tactics: [] }, LIMITS);
  assert.deepStrictEqual(
    [swap('what about wednesdays?', 'how do i fill tuesdays').question, swap('what about wednesdays?', 'how do i fill tuesdays').kind],
    ['how do i fill wednesdays', 'swap'],
  );
  assert.strictEqual(swap('and fridays?', 'How busy are we on Saturdays?').question, 'how busy are we on fridays?');
  assert.strictEqual(swap('what about lunch', 'when are we busiest?').question, 'when are we busiest at lunch');
  assert.strictEqual(swap('how about the weekend', 'how do i get more customers').question, 'how do i get more customers on weekend');
  assert.strictEqual(swap('same for tonight', 'how many servers do i need').question, 'how many servers do i need tonight');
  assert.strictEqual(swap('what about lunch?', 'how do i get more people in for dinner on tuesdays').question,
    'how do i get more people in for lunch on tuesdays');
  // A swap with nothing to swap into is just the question as written.
  assert.strictEqual(swap('what about wednesdays', 'how do i fill tuesdays').exclude.length, 0);
});

test('a follow-on that would run past the length cap falls back without breaking it', () => {
  const long = { question: 'a'.repeat(advisorFreeText.FREE_TEXT_MAX_CHARS - 5), intentId: null, tactics: [] };
  const out = followOn('what else?', long, LIMITS);
  assert.strictEqual(out.kind, 'else');
  assert.ok(out.question.length <= advisorFreeText.FREE_TEXT_MAX_CHARS);
  assert.strictEqual(out.question, long.question);
});

test('the suggestion a playbook answer offers is itself a follow-on the playbook can answer', () => {
  const { ANOTHER_MOVE } = require('../services/advisorFollowUps');
  const out = followOn(ANOTHER_MOVE, TUESDAYS, LIMITS);
  assert.strictEqual(out.kind, 'else');
  assert.deepStrictEqual(out.exclude, ['slow_day_recurring_reason']);
});
