// ---------------------------------------------------------------------------
// WHAT TO ASK NEXT, offered under an answer.
//
// An answer that ends leaves the owner holding a number and no next step.
// "Tuesday projects as your quietest day" begs "so how do I fill it", and the
// owner who would most benefit from asking is the one least likely to type
// it. So every answer comes back with up to two suggestions: a money question
// (typed, answered as advice) and one of the venue's own chips. Both are
// written here, by us, never by a model, and never with anything the owner
// typed in them.
//
// The client draws them only when it can take them: a chip suggestion only
// if that chip is on the venue's own list (the server offers each venue the
// chips its data can answer, routes/advisor.js availableIntents), and a
// typed suggestion only when typed questions are on and the owner has said
// yes to them. Anything else would be a button that declines.
// ---------------------------------------------------------------------------

const { ADVISOR_INTENTS, isKnownIntent } = require('./advisorPhrasing');

// The money question each chip's answer leads to, and the chip that pairs
// with it. Questions are owner voice, short enough for a chip on a phone.
const NEXT = Object.freeze({
  // The money move's question depends on the week's shape (moneyMoveQuestion).
  money_move: { intent: 'peak_hours', question: null },
  last_night_verdict: { intent: 'cohort_same_night', question: 'How do I fill a slow day?' },
  tonight_outlook: { intent: 'peak_hours', question: 'How should I staff today?' },
  peak_hours: { intent: 'quiet_nights', question: 'How do I handle the rush without losing covers?' },
  weekend_outlook: { intent: 'around_you', question: 'How do I get more out of a busy weekend?' },
  quiet_nights: { intent: 'peak_hours', question: null },
  week_recap: { intent: 'quiet_nights', question: 'What should I change next week?' },
  slow_night: { intent: 'cohort_same_night', question: 'How do I fill a slow day?' },
  readings_vs_estimates: { intent: 'week_recap', question: null },
  kitchen_vs_peak: { intent: 'peak_hours', question: 'Should I keep the kitchen open later?' },
  capacity_math: { intent: 'tables_service', question: 'How do I fit more covers into the rush?' },
  busy_nights_check: { intent: 'quiet_nights', question: 'How do I staff to the days I actually have?' },
  around_you: { intent: 'weekend_outlook', question: 'How do I bring in people from nearby events?' },
  data_status: { intent: 'last_night_verdict', question: null },
  cohort_typical: { intent: 'cohort_same_night', question: 'How do I get more people walking past to come in?' },
  cohort_same_night: { intent: 'week_recap', question: 'How do I fill a slow day?' },
  tables_service: { intent: 'tables_free', question: 'How do I turn tables faster?' },
  tables_free: { intent: 'tables_service', question: 'How do I fill the hours tables sit empty?' },
});

// An advice answer with no chip behind it still has a chip worth offering:
// the venue's own numbers on the thing the advice was about.
const TOPIC_INTENT = Object.freeze({
  fill_slow_days: 'quiet_nights',
  handle_the_rush: 'peak_hours',
  turn_tables: 'tables_service',
  labor: 'peak_hours',
  staff: 'peak_hours',
  waitlist: 'tables_free',
  reservations: 'peak_hours',
  events: 'around_you',
  weather_season: 'around_you',
  regulars: 'last_night_verdict',
  marketing: 'cohort_typical',
  reviews: 'cohort_typical',
  dayparts: 'peak_hours',
});

const WEEKDAY = /^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)$/;

// The quiet-days answer names the day, so the question can too.
function quietDayQuestion(block) {
  const facts = block && Array.isArray(block.facts) ? block.facts : [];
  const day = facts.map((f) => f && f.value && f.value.weekday).find((d) => typeof d === 'string' && WEEKDAY.test(d));
  return day ? `How do I fill ${day}s?` : 'How do I fill a quiet day?';
}

// After the money move: fill the quiet day it named, or, in a level week,
// lift the check.
const LEVEL_WEEK_QUESTION = 'How do I get people to spend more per visit?';
function moneyMoveQuestion(block) {
  const facts = block && Array.isArray(block.facts) ? block.facts : [];
  if (facts.some((f) => /projects level/.test(String((f && f.note) || '')))) return LEVEL_WEEK_QUESTION;
  return quietDayQuestion(block);
}

function same(a, b) {
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return norm(a) === norm(b);
}

/**
 * Up to two suggestions, money question first.
 *
 * After a reading of the venue's numbers (mode 'grounded', the default) the
 * question is the money move those numbers raise and the chip is the next
 * reading. After advice it is the other way round: the question is the
 * playbook's natural next step, and the chip is the venue's own numbers on
 * what the advice was about.
 *
 * @param {{mode?: 'grounded'|'advice', intentId?: string|null, block?: object, question?: string, followUp?: string|null, topic?: string|null}} opts
 * @returns {Array<{kind: 'question', text: string}|{kind: 'intent', id: string, label: string}>}
 */
function followUpsFor({ mode = 'grounded', intentId = null, block = null, question = '', followUp = null, topic = null } = {}) {
  const out = [];
  const advice = mode === 'advice';
  const next = intentId ? NEXT[intentId] : null;

  let ask = followUp;
  if (!ask && !advice && next) {
    if (intentId === 'quiet_nights') ask = quietDayQuestion(block);
    else if (intentId === 'money_move') ask = moneyMoveQuestion(block);
    else ask = next.question;
  }
  if (ask && !same(ask, question)) out.push({ kind: 'question', text: ask });

  const chip = advice
    ? intentId || (topic && TOPIC_INTENT[topic]) || null
    : (next && next.intent) || null;
  if (chip && (advice || chip !== intentId) && isKnownIntent(chip)) {
    out.push({ kind: 'intent', id: chip, label: ADVISOR_INTENTS[chip].chip });
  }
  return out;
}

// Every user-visible string this module can emit, for the standing design review.
function __copyStrings() {
  const out = ['How do I fill a quiet day?', 'How do I fill Tuesdays?', LEVEL_WEEK_QUESTION];
  for (const n of Object.values(NEXT)) if (n.question) out.push(n.question);
  return out;
}

module.exports = { followUpsFor, NEXT, TOPIC_INTENT, __copyStrings };
