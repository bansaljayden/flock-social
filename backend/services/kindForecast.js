// ---------------------------------------------------------------------------
// FLOCK'S FORECAST FOR PLACES LIKE THIS ONE (2026-11-03).
//
// A venue with no crowd history of its own still has a Week Ahead on its
// dashboard, and every number on it is what is typical for its kind of place
// (a category prior: the rule engine, or the category table). Roost answers
// from it when that is all there is (advisorFacts.buildWeekProjection), and
// says whose forecast it is every time:
//   * the template twin and the playbook's lead, in their first words
//     (advisorPhrasing shapeWeek and shapeMoneyMove, roostPlaybook.groundedLead);
//   * a phrased answer, somewhere in the answer, or the answer check sends the
//     draft to the template (advisorPhrasing.checkAnswer, saysWhose below).
//
// The facts are marked by their source, 'category_pattern': the vocabulary's
// word for a category prior (crowdEngine.describePredictionSupport), and no
// other Roost fact carries it. One source word and one phrase, here, so the
// places that write or check that sentence cannot drift apart.
// ---------------------------------------------------------------------------

const KIND_FORECAST_SOURCE = 'category_pattern';

// What the owner reads, in those words, wherever Roost answers from it.
const KIND_FORECAST = "Flock's forecast for places like yours";

/** True for a fact that is Flock's forecast for places like this venue. */
function isKindForecast(fact) {
  return Boolean(fact) && fact.source === KIND_FORECAST_SOURCE;
}

// An answer that says whose forecast it is: "places like yours", "a bar like
// yours", "venues similar to yours", "spots like this one", "this kind of
// place", "your type of venue".
const KIND_NOUN = '(?:places?|venues?|rooms?|spots?|bars?|pubs?|caf(?:e|\\u00e9)s?|coffee\\s+shops?|restaurants?|diners?|clubs?|nightclubs?|bakeries|bakery|businesses|business)';
const SAYS_WHOSE = new RegExp([
  `\\b${KIND_NOUN}\\s+(?:like|similar\\s+to)\\s+(?:yours|you|this\\s+one|it)\\b`,
  `\\b(?:this|your|that)\\s+(?:kind|type|sort)\\s+of\\s+${KIND_NOUN}`,
].join('|'), 'i');

/** True when the text says the forecast is for places like this one. */
function saysWhose(text) {
  return SAYS_WHOSE.test(String(text === null || text === undefined ? '' : text));
}

// THE CARD CAN REACH AN ANSWER WITHOUT ITS PLACEHOLDER. A model that writes
// the card's number as digits in a shape the answer check does not read as a
// claim ("Sunday is your quietest day this week, at 45, so run a weekly
// quiz"), or names the card's quietest or busiest day as the venue's own
// ("Sunday is your slowest day"), passed the check with no source at all,
// and an advice answer needs none (2026-11-03). Both read as the venue's own
// forecast. So an answer whose block holds the card uses it when it writes
// one of the card's index numbers as a plain number, or names one of the
// card's days beside a quietest or busiest word, and is held to the same
// words as one that wrote the placeholder.

// The words that rank a day against the week. Not "best" or "worst": "the
// best night to try a quiz" is advice, not a reading of the card.
const SUPERLATIVE = /\b(?:quietest|slowest|deadest|emptiest|weakest|busiest|biggest|strongest|fullest)\b/i;
const WEEKDAY_WORD = /\b(mon|tues|wednes|thurs|fri|satur|sun)days?\b/gi;
// A plain number: not money, not a clock, not a decimal or a range's other
// end, not a count of something else (covers, minutes, percent), and not a
// count to add ("aim for 45 more covers").
const PLAIN_NUMBER = /(?<![$\d.,:])\b(\d{1,3})\b(?![.,:]\d)(?!\s*(?:%|percent\b|per\s+cent\b|[ap]\.?\s?m\b|minutes?\b|mins?\b|hours?\b|hrs?\b|seconds?\b|dollars?\b|bucks\b|covers?\b|people\b|guests?\b|customers?\b|seats?\b|tables?\b|staff\b|servers?\b|days?\b|weeks?\b|more\b|extra\b|fewer\b|additional\b|new\b))/gi;

function cardOf(facts) {
  const scores = new Set();
  const days = new Set();
  for (const f of Array.isArray(facts) ? facts : []) {
    if (!isKindForecast(f)) continue;
    const v = f.value;
    // The fact engine's facts carry the day whole; the payload's carry it
    // split into parts (typical_peak_score, typical_peak_weekday_a).
    if (v && typeof v === 'object') {
      if (Number.isFinite(Number(v.peakScore))) scores.add(Number(v.peakScore));
      if (typeof v.weekday === 'string') days.add(v.weekday.toLowerCase());
    } else if (typeof v === 'number' && /(?:^|_)score(?:_[a-z]+)?$/.test(String(f.id))) {
      scores.add(v);
    } else if (typeof v === 'string' && /(?:^|_)weekday(?:_[a-z]+)?$/.test(String(f.id))) {
      days.add(v.toLowerCase());
    }
  }
  return { scores, days };
}

/** True when the text uses the card in `facts` without its placeholder. */
function readsAsCard(text, facts) {
  const { scores, days } = cardOf(facts);
  if (!scores.size && !days.size) return false;
  const s = String(text === null || text === undefined ? '' : text);
  for (const sentence of s.split(/(?<=[.!?])\s+|\n+/)) {
    for (const m of sentence.matchAll(PLAIN_NUMBER)) {
      if (scores.has(Number(m[1]))) return true;
    }
    if (SUPERLATIVE.test(sentence)) {
      for (const m of sentence.matchAll(WEEKDAY_WORD)) {
        if (days.has(`${m[1].toLowerCase()}day`)) return true;
      }
    }
  }
  return false;
}

module.exports = {
  KIND_FORECAST_SOURCE,
  KIND_FORECAST,
  isKindForecast,
  saysWhose,
  readsAsCard,
};
