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

module.exports = {
  KIND_FORECAST_SOURCE,
  KIND_FORECAST,
  isKindForecast,
  saysWhose,
};
