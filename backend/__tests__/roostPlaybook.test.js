// Run: node --test __tests__/roostPlaybook.test.js  (from backend/)
//
// ===========================================================================
// THE ROOST PLAYBOOK, PINNED (2026-10-28).
//
// services/roostPlaybook.js answers money questions with no model call, and
// hands the advice model vetted moves to build on when it is up. What has to
// hold, as something a machine checks:
//
//   1. THE CONTENT IS CLEAN. Every tactic loads against the closed lists, and
//      every sentence an owner can read from it survives the same answer check
//      a model's answer faces, whole: no fabricated study, no unsupported
//      number about the venue, no dash, no law or pay instruction, no upsell.
//   2. RETRIEVAL IS PREDICTABLE. A question gets the tactic its words point
//      at, a routed question leans to its topic, a venue that does not pour is
//      never handed a drinks move unless it asked about drinks, and a question
//      the playbook has nothing for gets nothing.
//   3. THE ANSWER HAS ROOST'S SHAPE. A short line, up to four points, the
//      money in the venue's own spend per head with the working shown, and
//      sources that say it came from the playbook.
//   4. FOLLOW-UPS AND THE OFFLINE ROUTE say where a question goes next, and
//      where a typed question goes when the router cannot be asked.
//   5. THE BREAKER opens on a failure that says the key is unusable and on
//      nothing else.
// ===========================================================================

const test = require('node:test');
const assert = require('node:assert');

const pb = require('../services/roostPlaybook');
const advisorAnswer = require('../services/advisorAnswer');
const advisorPhrasing = require('../services/advisorPhrasing');
const advisorFreeText = require('../services/advisorFreeText');
const { followUpsFor, NEXT, TOPIC_INTENT, __copyStrings: followUpCopy } = require('../services/advisorFollowUps');

const { checkAnswer, hasNumberWords, outageKindOf, noteModelFailure, modelAvailable, OUTAGE_BACKOFF_MS } = advisorPhrasing.internals;

const MARKETING = /\b(seamless|effortless|elevate|empower|supercharge|unlock|leverage|actionable|game[\s-]?changer)\b/i;

// ── 1. The content ──────────────────────────────────────────────────────────

test('the shipped playbook loads, and every tactic sits inside the closed lists', () => {
  assert.ok(pb.tactics.length >= 10, `only ${pb.tactics.length} tactics shipped`);
  const ids = new Set();
  for (const t of pb.tactics) {
    assert.doesNotThrow(() => pb.validateTactic(t), t.id);
    assert.ok(!ids.has(t.id), `${t.id} is listed twice`);
    ids.add(t.id);
  }
});

test('every sentence an owner can read from the playbook survives the answer check whole', () => {
  for (const t of pb.tactics) {
    const points = [t.why, t.example, t.watch].filter(Boolean);
    const raw = JSON.stringify({ answer: t.move, points });
    const out = checkAnswer(raw, [], {
      mode: 'advice',
      reject: (why) => { throw new Error(`${t.id} was voided by the check: ${why}`); },
    });
    assert.strictEqual(
      out.text,
      advisorAnswer.assemble({ structured: true, answer: [t.move], points }),
      `${t.id} lost a sentence to the check`,
    );
  }
});

test('the playbook is written to the house style: digits, no dashes, no exclamations, no marketing words', () => {
  for (const s of pb.__copyStrings()) {
    assert.ok(!/[‒-―]/.test(s), `a dash: ${s}`);
    assert.ok(!s.includes('!'), `an exclamation: ${s}`);
    assert.ok(!s.includes(';'), `a semicolon: ${s}`);
    assert.ok(!MARKETING.test(s), `a marketing word: ${s}`);
    assert.ok(!hasNumberWords(s), `a number written as a word: ${s}`);
    assert.ok(s.split(/\s+/).length <= 40, `too long for a point on a phone: ${s}`);
  }
});

// ── 2. Retrieval ────────────────────────────────────────────────────────────

const topicOf = (q, opts) => {
  const [first] = pb.find(q, opts);
  return first ? first.topic : null;
};

test('a question gets the tactic its words point at', () => {
  assert.strictEqual(topicOf('how do I make Tuesdays better, they are dead'), 'fill_slow_days');
  assert.strictEqual(topicOf('we keep getting no-shows on big bookings'), 'reservations');
  assert.strictEqual(topicOf('what should my food cost be'), 'food_cost');
  assert.strictEqual(topicOf('how do I get my tables to turn faster'), 'turn_tables');
  assert.strictEqual(topicOf('how do I get people to spend more, upsell'), 'check_average');
});

test('a question the playbook has nothing for gets nothing, not the nearest guess', () => {
  assert.deepStrictEqual(pb.find('what is the capital of france'), []);
  assert.deepStrictEqual(pb.find('asdkjhasd'), []);
  assert.strictEqual(pb.answer({ question: 'what is the capital of france' }), null);
});

test('a routed question leans to its topic even when no word in it matches a cue', () => {
  assert.strictEqual(topicOf('what now', { intentId: 'quiet_nights' }), 'fill_slow_days');
  assert.strictEqual(topicOf('what now', { intentId: 'peak_hours' }), 'handle_the_rush');
  assert.strictEqual(topicOf('what now', { intentId: 'tables_service' }), 'turn_tables');
});

const FIXTURE = [
  {
    id: 'bar_happy_hour', topic: 'beverage', venues: ['bar', 'club', 'full_service'], alcohol: true,
    cues: ['slow', 'early evening', 'happy hour'], move: 'Run a short happy hour on your slowest early stretch.',
    why: 'It brings people in before the room fills.', watch: 'End it on time.', money: 'covers',
  },
  {
    id: 'cafe_pastry_pairing', topic: 'check_average', venues: ['cafe', 'bakery'], alcohol: false,
    cues: ['spend more', 'pastry', 'mornings'], move: 'Offer a pastry with every coffee order.',
    why: 'It lifts the check at no extra labour.', watch: 'Count how many take it.', money: 'check',
  },
  {
    id: 'any_slow_event', topic: 'fill_slow_days', venues: ['all'], alcohol: false,
    cues: ['slow', 'quiet'], move: 'Hold a recurring event on your slowest day.',
    why: 'It gives people a reason to come.', watch: 'Run it 6 weeks.', money: 'covers',
  },
];

test('a venue that does not pour never gets a drinks move unless it asks about drinks', () => {
  const book = pb.createPlaybook(FIXTURE);
  const cafe = { kind: 'cafe', alcohol: false };
  const bar = { kind: 'bar', alcohol: true };
  assert.ok(!book.find('how do I fill slow evenings', { venue: cafe }).some((t) => t.alcohol), 'a cafe got a drinks move');
  assert.ok(book.find('how do I fill slow evenings', { venue: bar }).some((t) => t.id === 'bar_happy_hour'), 'a bar did not');
  // An unknown venue is never assumed to pour either.
  assert.ok(!book.find('slow evenings', { venue: { kind: null, alcohol: false } }).some((t) => t.alcohol));
  // A restaurant that asks about a happy hour has said it pours.
  assert.ok(book.find('should we run a happy hour', { venue: { kind: 'full_service', alcohol: false } })
    .some((t) => t.id === 'bar_happy_hour'));
});

test('a tactic written for some venues is not offered to the others', () => {
  const book = pb.createPlaybook(FIXTURE);
  assert.ok(book.find('how do I get people to spend more in the mornings', { venue: { kind: 'cafe', alcohol: false } })
    .some((t) => t.id === 'cafe_pastry_pairing'));
  assert.ok(!book.find('how do I get people to spend more in the mornings', { venue: { kind: 'club', alcohol: true } })
    .some((t) => t.id === 'cafe_pastry_pairing'));
});

test('a bad tactic fails at load, never in front of an owner', () => {
  const bad = (patch) => () => pb.createPlaybook([{ ...FIXTURE[2], ...patch }]);
  assert.throws(bad({ id: 'has_digit_9' }), /lowercase letters/);
  assert.throws(bad({ topic: 'vibes' }), /unknown topic/);
  assert.throws(bad({ venues: ['spaceport'] }), /closed list/);
  assert.throws(bad({ money: 'lots' }), /money kind/);
  assert.throws(bad({ follow_up: 'not a question' }), /not a question/);
  assert.throws(() => pb.createPlaybook([FIXTURE[2], FIXTURE[2]]), /listed twice/);
});

test('the venue is read from its category and its own settings, and pouring is never assumed', () => {
  assert.deepStrictEqual(pb.venueOf({ mlVenue: { venue_category: 'cafe' }, profile: {} }), { kind: 'cafe', alcohol: false });
  assert.deepStrictEqual(pb.venueOf({ mlVenue: { venue_category: 'nightclub' }, profile: {} }), { kind: 'club', alcohol: true });
  assert.deepStrictEqual(pb.venueOf({ mlVenue: { venue_category: 'restaurant' }, profile: {} }), { kind: 'full_service', alcohol: false });
  assert.deepStrictEqual(pb.venueOf({ mlVenue: { venue_category: 'restaurant' }, profile: { service_style: 'counter_order' } }),
    { kind: 'quick_service', alcohol: false });
  assert.strictEqual(pb.venueOf({ mlVenue: { venue_category: 'restaurant' }, profile: { last_call: '23:30' } }).alcohol, true,
    'a venue with a last call pours');
  assert.deepStrictEqual(pb.venueOf(null), { kind: null, alcohol: false });
});

test('stemming sends the forms of a word to one key', () => {
  for (const [a, b] of [['prices', 'pricing'], ['tables', 'table'], ['staffing', 'staff'], ['filled', 'fills'], ['scheduling', 'schedule'], ['running', 'run']]) {
    assert.strictEqual(pb.stem(a), pb.stem(b), `${a} vs ${b}`);
  }
});

// ── 3. The answer ───────────────────────────────────────────────────────────

const CTX = (spend) => ({
  profile: { typical_spend_per_person: spend, updated_at: '2026-10-01T00:00:00Z' },
  mlVenue: { venue_category: 'restaurant' },
});

test('the money line is the owner\'s own spend per head, with the working in the sentence', () => {
  assert.strictEqual(pb.moneyLine({ money: 'covers' }, 35),
    'At your $35 a head, every 10 extra covers a week is $350, about $18,200 a year.');
  assert.strictEqual(pb.moneyLine({ money: 'check' }, 35),
    'At your $35 a head, $2 more on each check is about 6% more from every cover you already serve.');
  // The bump scales with the check, so a cafe is not told $2 is nothing.
  assert.match(pb.moneyLine({ money: 'check' }, 9), /\$1 more on each check is about 11% more/);
  assert.match(pb.moneyLine({ money: 'check' }, 60), /\$5 more on each check is about 8% more/);
  assert.strictEqual(pb.moneyLine({ money: 'covers' }, null), null);
  assert.strictEqual(pb.moneyLine({ money: 'cost' }, 35), null, 'a cost saving is not a per-head sum');
});

test('the calculator reads covers, guests or tables of a size out of a question, and never guesses a party size', () => {
  assert.deepStrictEqual(pb.coversIn('how much will 10 more covers a week make me'), { covers: 10, per: 'week' });
  assert.deepStrictEqual(pb.coversIn('what are 20 extra guests a night worth'), { covers: 20, per: 'night' });
  assert.deepStrictEqual(pb.coversIn('3 more tables of 4 every month'), { covers: 12, per: 'month' });
  assert.strictEqual(pb.coversIn('3 more tables a night'), null, 'a table with no party size is not a number of covers');
  assert.strictEqual(pb.coversIn('how do I get more covers'), null);
});

test('"how much would N more covers make me" is answered in dollars from the owner\'s own spend, with no model', () => {
  const a = pb.answer({ question: 'how much will 10 more covers a week make me', ctx: CTX(38) });
  const lines = a.text.split('\n');
  assert.strictEqual(lines[0], 'At your $38 a head, 10 more covers a week is $380, about $19,760 a year.');
  assert.strictEqual(lines[1], `${advisorAnswer.BULLET}At a typical food cost near 30%, about $266 of that $380 is left after food.`);
  assert.ok(lines.length <= 1 + advisorAnswer.MAX_POINTS);
  assert.deepStrictEqual(a.sources.map((s) => s.source), ['roost_playbook', 'intake']);
  // Per night: no year, because a venue that does not open every night has no
  // honest yearly figure.
  assert.match(pb.answer({ question: 'what are 20 extra guests a night worth', ctx: CTX(38) }).text, /^At your \$38 a head, 20 more covers a night is \$760\.\n/);
  // No spend on file: it says what it needs, and how to give it.
  const bare = pb.answer({ question: 'how much will 10 more covers a week make me', ctx: CTX(null) });
  assert.match(bare.text, /^Add your typical spend per person in your venue settings and Roost will price 10 more covers a week in dollars\./);
  assert.deepStrictEqual(bare.sources.map((s) => s.source), ['roost_playbook']);
  // And whatever it says passes the check a model's answer faces.
  const raw = JSON.stringify({ answer: lines[0], points: lines.slice(1).map((l) => l.replace(advisorAnswer.BULLET, '')) });
  assert.ok(checkAnswer(raw, [], { mode: 'advice', texts: ['how much will 10 more covers a week make me', '38'], reject: () => null }));
});

test('a playbook answer has Roost\'s shape: one line, at most four points, sourced as the playbook', () => {
  const a = pb.answer({ question: 'how do I make Tuesdays better', ctx: CTX(35) });
  assert.ok(a, 'the slow-day question got an answer');
  assert.strictEqual(a.mode, 'advice');
  const lines = a.text.split('\n');
  assert.ok(!lines[0].startsWith(advisorAnswer.BULLET), 'the answer comes first, not a point');
  const points = lines.slice(1);
  assert.ok(points.length >= 2 && points.length <= advisorAnswer.MAX_POINTS, `${points.length} points`);
  for (const p of points) {
    assert.ok(p.startsWith(advisorAnswer.BULLET), p);
    assert.ok(p.length <= advisorAnswer.MAX_POINT_CHARS + advisorAnswer.BULLET.length, p);
  }
  assert.ok(a.text.includes('At your $35 a head'), 'the money is in the venue\'s own spend');
  assert.deepStrictEqual(a.sources.map((s) => s.source), ['roost_playbook', 'intake']);
  assert.strictEqual(a.topic, 'fill_slow_days');
});

test('with no spend per head on file, the answer works the example instead and says how to get the dollar figure', () => {
  const a = pb.answer({ question: 'how do I make Tuesdays better', ctx: CTX(null) });
  assert.ok(!a.text.includes('At your'), 'no spend, no per-head line');
  assert.deepStrictEqual(a.sources.map((s) => s.source), ['roost_playbook']);
  const withNudge = pb.answerFrom(pb.createPlaybook([FIXTURE[2]]), { question: 'slow', ctx: CTX(null) });
  assert.ok(withNudge.text.includes(pb.SPEND_NUDGE), 'the settings nudge fills the room the money line left');
});

test('a question routed to a day leads with the venue\'s own forecast for it, and cites it', () => {
  const facts = [
    { id: 'peak_2026-11-03', value: { weekday: 'Tuesday', peakHour: 18, peakScore: 38 }, source: 'model_holdout', asOf: '2026-10-27T22:00:00Z' },
    { id: 'peak_2026-11-02', value: { weekday: 'Monday', peakHour: 18, peakScore: 41 }, source: 'model_holdout', asOf: '2026-10-27T22:00:00Z' },
  ];
  const quiet = pb.answer({ question: 'how do I fill the quiet days', intentId: 'quiet_nights', ctx: CTX(35), groundedFacts: facts });
  assert.ok(quiet.text.startsWith('Tuesday projects as your quietest day this week. '), quiet.text);
  assert.ok(quiet.sources.some((s) => s.source === 'model_holdout' && s.id === 'peak_2026-11-03'));
  const busy = pb.answer({ question: 'how do I handle the rush', intentId: 'peak_hours', ctx: CTX(35), groundedFacts: facts });
  assert.ok(busy.text.startsWith('Monday projects as your busiest day this week. '), busy.text);
  // No day facts, no lead.
  const bare = pb.answer({ question: 'how do I fill the quiet days', intentId: 'quiet_nights', ctx: CTX(35), groundedFacts: [] });
  assert.ok(!/projects as/.test(bare.text));
});

test('the payload copy hands the model moves to build on, never ids or sources to cite', () => {
  const payload = pb.forPayload(pb.find('how do I make Tuesdays better'));
  assert.ok(payload.length > 0);
  for (const p of payload) {
    assert.deepStrictEqual(Object.keys(p).filter((k) => !['move', 'why', 'example', 'watch'].includes(k)), []);
  }
});

// ── 4. Follow-ups and the offline route ─────────────────────────────────────

test('after a reading, the next money question and the next reading are offered', () => {
  const block = { facts: [{ id: 'peak_2026-11-03', value: { weekday: 'Tuesday', peakScore: 38 } }] };
  assert.deepStrictEqual(followUpsFor({ intentId: 'quiet_nights', block }), [
    { kind: 'question', text: 'How do I fill Tuesdays?' },
    { kind: 'intent', id: 'peak_hours', label: 'When do we peak this week?' },
  ]);
  assert.deepStrictEqual(followUpsFor({ intentId: 'quiet_nights', block: { facts: [] } })[0],
    { kind: 'question', text: 'How do I fill a quiet day?' });
  // The question just asked is never offered back.
  assert.ok(!followUpsFor({ intentId: 'tables_service', question: 'how do I turn tables faster' })
    .some((f) => f.kind === 'question'));
});

test('after advice, the playbook\'s next step and the venue\'s own numbers on the topic are offered', () => {
  assert.deepStrictEqual(followUpsFor({ mode: 'advice', topic: 'fill_slow_days', followUp: 'What event would suit my room?' }), [
    { kind: 'question', text: 'What event would suit my room?' },
    { kind: 'intent', id: 'quiet_nights', label: 'Which days look quiet?' },
  ]);
  // Routed advice offers the chip it was routed on.
  const routed = followUpsFor({ mode: 'advice', intentId: 'tables_service', topic: 'turn_tables' });
  assert.deepStrictEqual(routed, [{ kind: 'intent', id: 'tables_service', label: 'How are our tables running?' }]);
  assert.deepStrictEqual(followUpsFor({ mode: 'advice' }), [], 'nothing to go on, nothing offered');
});

test('every follow-up points at a chip that exists, in copy that passes the house style', () => {
  for (const [from, n] of Object.entries(NEXT)) {
    assert.ok(advisorPhrasing.isKnownIntent(from), from);
    assert.ok(advisorPhrasing.isKnownIntent(n.intent), `${from} -> ${n.intent}`);
    assert.notStrictEqual(n.intent, from, `${from} offers itself`);
  }
  for (const id of Object.values(TOPIC_INTENT)) assert.ok(advisorPhrasing.isKnownIntent(id), id);
  for (const k of Object.keys(TOPIC_INTENT)) assert.ok(pb.TOPICS.includes(k), k);
  for (const s of followUpCopy()) {
    assert.ok(/\?$/.test(s), s);
    assert.ok(!/[‒-―]/.test(s), s);
  }
});

test('with no router, a typed question is still placed by what it says', () => {
  const cases = [
    ['when are we busiest this week', { mode: 'grounded', intentId: 'peak_hours' }],
    ['hello, is Friday busier than Saturday?', { mode: 'grounded', intentId: 'peak_hours' }],
    ['how did we do yesterday', { mode: 'grounded', intentId: 'last_night_verdict' }],
    ['how are our tables running', { mode: 'grounded', intentId: 'tables_service' }],
    ['when is a table usually free', { mode: 'grounded', intentId: 'tables_free' }],
    ['why was thursday so dead', { mode: 'grounded', intentId: 'slow_night' }],
    ['is the whole street slow or is it just us', { mode: 'grounded', intentId: 'cohort_same_night' }],
    ['what is happening around us this week', { mode: 'grounded', intentId: 'around_you' }],
    ['how does today look', { mode: 'grounded', intentId: 'tonight_outlook' }],
    ['how do I fill Tuesdays', { mode: 'advice', intentId: 'quiet_nights' }],
    ['what should I charge for brunch', { mode: 'advice', intentId: null }],
    ['how many servers do I need on friday', { mode: 'advice', intentId: 'tables_service' }],
    ['should I run a happy hour', { mode: 'advice', intentId: null }],
  ];
  for (const [q, want] of cases) assert.deepStrictEqual(advisorFreeText.offlineRoute(q), want, q);
  for (const q of ['asdkjhasd', 'what is the capital of france', '']) {
    assert.strictEqual(advisorFreeText.offlineRoute(q), null, q);
  }
});

// ── 5. The breaker ──────────────────────────────────────────────────────────

test('the breaker opens on a failure that says the key is unusable, and on nothing else', () => {
  const err = (status, message = '') => Object.assign(new Error(message), { status });
  assert.strictEqual(outageKindOf(err(402, 'Your prepayment credits are depleted.')), 'billing');
  assert.strictEqual(outageKindOf(err(403, 'PERMISSION_DENIED')), 'billing');
  assert.strictEqual(outageKindOf(err(400, 'API key not valid. Please pass a valid API key.')), 'billing');
  assert.strictEqual(outageKindOf(err(429, 'RESOURCE_EXHAUSTED')), 'quota');
  assert.strictEqual(outageKindOf(err(503, 'The model is overloaded.')), 'overloaded');
  assert.strictEqual(outageKindOf(err(500, 'internal')), null, 'one bad response is one call\'s problem');
  assert.strictEqual(outageKindOf(new Error('This operation was aborted')), null, 'nor is a timeout');
  assert.strictEqual(outageKindOf(err(400, 'Invalid JSON payload')), null);

  advisorPhrasing.__resetAdvisorSpend();
  const now = Date.now();
  assert.strictEqual(modelAvailable(now), true);
  assert.strictEqual(noteModelFailure(err(500, 'internal'), now), false);
  assert.strictEqual(modelAvailable(now), true);
  assert.strictEqual(noteModelFailure(err(402, 'Your prepayment credits are depleted.'), now), true);
  assert.strictEqual(modelAvailable(now + 1000), false);
  assert.strictEqual(modelAvailable(now + OUTAGE_BACKOFF_MS.billing), true, 'and it closes on its own');
  // A shorter outage never cuts a longer one short.
  noteModelFailure(err(402, 'credits'), now);
  noteModelFailure(err(503, 'overloaded'), now);
  assert.strictEqual(modelAvailable(now + OUTAGE_BACKOFF_MS.overloaded + 1), false);
  advisorPhrasing.__resetAdvisorSpend();
  assert.strictEqual(modelAvailable(), true);
});

test('while the breaker is open a chip is answered from its template with no call and no charge', async () => {
  advisorPhrasing.__resetAdvisorSpend();
  let calls = 0;
  advisorPhrasing.__setGenAIForTests({ models: { generateContent: async () => { calls += 1; throw new Error('unreachable'); } } });
  const pool = require('../config/database');
  const realQuery = pool.query;
  const charged = [];
  pool.query = async (sql) => { charged.push(String(sql)); return { rows: [], rowCount: 0 }; };
  try {
    noteModelFailure(Object.assign(new Error('credits'), { status: 402 }));
    const out = await advisorPhrasing.phrase({
      intent: 'peak_hours',
      facts: [{ id: 'peak_hour', value: 21, unit: 'hour', source: 'model_holdout', asOf: '2026-10-27', label: 'Projected peak is 9 PM.' }],
      refusals: [],
    }, { venueUserId: 7, question: 'When do we peak this week?' });
    assert.strictEqual(out.mode, 'template');
    assert.strictEqual(calls, 0, 'no call was made');
    assert.ok(!charged.some((s) => /advisor_venue_spend|advisor_spend/.test(s)), 'and no meter was charged');
  } finally {
    pool.query = realQuery;
    advisorPhrasing.__resetAdvisorSpend();
    advisorPhrasing.__setGenAIForTests(null);
  }
});
