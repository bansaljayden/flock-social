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
//   * a phrased or advice answer, at or before the first sentence that uses
//     the card, and with no sentence calling the card's days the venue's own,
//     or the answer check sends the draft to the template or the playbook
//     (advisorPhrasing.checkAnswer, with the readers below).
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

// ── Saying whose forecast it is ──────────────────────────────────────────────
//
// "places like yours", "a bar like yours", "places like your bar", "spots
// like this one", "places such as yours", "venues similar to yours", "this
// kind of place", "venues of your type", "similar bars", "comparable venues",
// "a typical bar", "bars in your category", "the category forecast".
const KIND_NOUN = '(?:places?|venues?|rooms?|spots?|bars?|pubs?|caf(?:e|\\u00e9)s?|coffee\\s+shops?|restaurants?|diners?|clubs?|nightclubs?|bakeries|bakery|businesses|business)';
const SAYS_WHOSE = new RegExp([
  `\\b${KIND_NOUN}\\s+(?:like|similar\\s+to|such\\s+as)\\s+(?:yours|you|this(?:\\s+one)?|it|your\\s+(?:own\\s+)?[a-z]+)\\b`,
  `\\b(?:this|your|that)\\s+(?:kind|type|sort)\\s+of\\s+${KIND_NOUN}`,
  `\\b${KIND_NOUN}\\s+of\\s+(?:your|this|that)\\s+(?:kind|type|sort)\\b`,
  `\\b(?:similar|comparable)\\s+${KIND_NOUN}`,
  `\\b(?:a|an|the)\\s+typical\\s+${KIND_NOUN}`,
  `\\b${KIND_NOUN}\\s+in\\s+your\\s+category\\b`,
  '\\bcategory\\s+(?:forecast|pattern|typical|average)\\b',
].join('|'), 'i');

/** True when the text says the forecast is for places like this one. */
function saysWhose(text) {
  return SAYS_WHOSE.test(String(text === null || text === undefined ? '' : text));
}

// ── Reading an answer for the card ──────────────────────────────────────────
//
// THE CARD CAN REACH AN ANSWER WITHOUT ITS PLACEHOLDER, AND "YOUR" CAN FOLLOW
// IT IN (2026-11-03 review). Advice needs no source, so "Sunday is your
// quietest day this week, at 45, so run a weekly quiz" passed with none, and
// one "for a bar like yours" anywhere in a draft vouched for "Saturday is your
// busiest night" two points later. So, in a block that holds the card:
//   * a sentence USES the card when it writes one of the card's index numbers
//     with its day or with an index word, or names one of the card's days
//     beside a word that sets a day against the week ("quietest", "slow",
//     "busy", "peaks"), in that sentence or across the sentence after it;
//   * a sentence OWNS the card when it calls a day or night the venue's own
//     ("your slowest day", "your busy nights", "your forecast shows").
// What the owner said is theirs: a number they typed, a day they named in
// their question or their settings, and their own word for a day ("how do I
// fill a slow Monday") are never read as the card. A sentence about the trade
// at large ("for most bars, Saturday is the busiest night") is not about this
// venue at all.

const WEEKDAY_WORD = /\b(mon|tues|wednes|thurs|fri|satur|sun)days?\b/gi;
function daysIn(text) {
  return [...String(text).matchAll(WEEKDAY_WORD)].map((m) => `${m[1].toLowerCase()}day`);
}

// Words that set a day against the rest of the week. Not "best", "big",
// "full", "top" or "most" on their own: "the best night to try a quiz", "a big
// game on Sunday" and "a full menu on Saturday" are advice, not readings.
const RANK_WORD = /\b(?:quiet(?:er|est)?|slow(?:er|est)?|dead(?:est)?|empt(?:y|ier|iest)|weak(?:er|est)|lowest|least\s+busy|busy|busi(?:er|est)|biggest|strong(?:er|est)|fullest|highest|packed|peak(?:s|ed|ing)?|lull|bottoms?\s+out)\b/i;
// The two kinds of word, so the owner's own word for a day is recognised.
const QUIET_FAMILY = /^(?:quiet(?:er|est)?|slow(?:er|est)?|dead(?:est)?|empt(?:y|ier|iest)|weak(?:er|est)?|low(?:er|est)?|least|lull|bottoms?|worst)$/;
const BUSY_FAMILY = /^(?:busy|busi(?:er|est)|big(?:ger|gest)?|strong(?:er|est)?|full(?:er|est)?|high(?:er|est)?|packed|peak(?:s|ed|ing)?|top|best|most)$/;
function familyOf(word) {
  const w = String(word || '').toLowerCase();
  if (QUIET_FAMILY.test(w)) return 'quiet';
  if (BUSY_FAMILY.test(w)) return 'busy';
  return null;
}

const INDEX_WORD = /\b(?:index|forecasts?|projects?|projected|projection|peaks?|peaking|score|scores)\b/i;
const GENERIC = /\b(?:most|many|lots\s+of|plenty\s+of|other)\s+(?:bars|venues|places|rooms|restaurants|cafes|cafés|clubs|nightclubs|operators|owners|spots|pubs|diners|bakeries)\b|\bin\s+general\b|\bacross\s+the\s+(?:trade|industry)\b|\bindustry[-\s]wide\b/i;
const PRONOUN_START = /^\s*(?:it|that|this|they|those|these)\b/i;

// A plain number: not money, not a clock, not part of a hyphenated unit
// ("45-minute"), not the start of a range ("25 to 30%"), and not a count of
// something else (covers, regulars, minutes, percent, "45 more covers").
const PLAIN_NUMBER = /(?<![$\d.,:\-–])\b(\d{1,3})\b(?![.,:]\d)(?!-[a-z])(?!\s*(?:to|-|–|and|or|of)\s*\$?\d)(?!\s*(?:%|percent\b|per\s+cent\b|[ap]\.?\s?m\b|(?:a|per)\s+head\b|each\b|apiece\b|minutes?\b|mins?\b|hours?\b|hrs?\b|seconds?\b|dollars?\b|bucks\b|covers?\b|people\b|guests?\b|customers?\b|regulars?\b|visitors?\b|diners?\b|patrons?\b|members?\b|seats?\b|tables?\b|staff\b|servers?\b|days?\b|weeks?\b|months?\b|times?\b|reviews?\b|drinks?\b|items?\b|plates?\b|dishes\b|orders?\b|more\b|extra\b|fewer\b|additional\b|new\b|most\b))/gi;
const ANY_NUMBER = /\d+(?:\.\d+)?/g;

const OWNER_SOURCES = new Set(['intake', 'owner_report']);
// A word that names a day or a part of one, for the owner's own words above.
const DAY_WORD = /^(?:(?:mon|tues|wednes|thurs|fri|satur|sun)days?|days?|nights?|evenings?|weekends?|weeknights?|weekdays?|mornings?|afternoons?|shifts?|lunch(?:es)?|dinners?|brunch(?:es)?)$/;

function weekdayWords(value, into) {
  const values = Array.isArray(value) ? value : [value];
  for (const v of values) {
    if (typeof v !== 'string') continue;
    for (const d of daysIn(v)) into.add(d);
  }
}

/**
 * What an answer is read against: the card's index numbers and days, and
 * what the owner said themselves. `facts` is the block the answer was written
 * from; `texts` is the owner's own words (their question, their settings
 * text). Null when the block holds no card.
 */
function cardContext(facts, texts = []) {
  const scores = new Set();
  const days = new Set();
  const ownerNumbers = new Set();
  const ownerDays = new Set();
  const ownerFamilies = new Set();
  for (const f of Array.isArray(facts) ? facts : []) {
    if (!f) continue;
    const v = f.value;
    if (isKindForecast(f)) {
      // The fact engine's facts carry the day whole; the payload's carry it
      // split into parts (typical_peak_score, typical_peak_weekday_a).
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        if (Number.isFinite(Number(v.peakScore))) scores.add(Number(v.peakScore));
        if (typeof v.weekday === 'string') days.add(v.weekday.toLowerCase());
      } else if (typeof v === 'number' && /(?:^|_)score(?:_[a-z]+)?$/.test(String(f.id))) {
        scores.add(v);
      } else if (typeof v === 'string' && /(?:^|_)weekday(?:_[a-z]+)?$/.test(String(f.id))) {
        days.add(v.toLowerCase());
      }
      continue;
    }
    if (!OWNER_SOURCES.has(f.source)) continue;
    // What the owner told us or posted: their numbers, the days they named,
    // and, for the busy nights they told us, their word for them.
    if (typeof v === 'number') ownerNumbers.add(v);
    else if (typeof v === 'string' && /^\d+(?:\.\d+)?$/.test(v.trim())) ownerNumbers.add(Number(v));
    else if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const x of Object.values(v)) if (typeof x === 'number') ownerNumbers.add(x);
    }
    weekdayWords(v, ownerDays);
    if (/busy/.test(String(f.id))) ownerFamilies.add('busy');
  }
  for (const t of Array.isArray(texts) ? texts : []) {
    if (typeof t !== 'string') continue;
    for (const m of t.matchAll(ANY_NUMBER)) ownerNumbers.add(Number(m[0]));
    for (const d of daysIn(t)) ownerDays.add(d);
    // Their word for a day, said beside one: "a slow Monday", "our quiet
    // nights", "busy Fridays". "Our best money move this week" calls no day
    // anything.
    const words = t.toLowerCase().match(/[a-z]+/g) || [];
    words.forEach((w, i) => {
      const family = familyOf(w);
      if (family && words.slice(Math.max(0, i - 2), i + 3).some((x) => DAY_WORD.test(x))) ownerFamilies.add(family);
    });
  }
  if (!scores.size && !days.size) return null;
  return { scores, days, ownerNumbers, ownerDays, ownerFamilies };
}

// The card's days a sentence names that the owner did not name themselves.
function cardDaysIn(sentence, ctx) {
  return daysIn(sentence).filter((d) => ctx.days.has(d) && !ctx.ownerDays.has(d));
}

/**
 * True when `sentence` uses the card without its placeholder. `previous` is
 * the sentence before it, for a day and its ranking split across two
 * ("Look at Sunday. It is the quietest night.").
 */
function readsAsCard(sentence, ctx, previous = '') {
  if (!ctx) return false;
  const s = String(sentence === null || sentence === undefined ? '' : sentence);
  if (GENERIC.test(s)) return false;
  const days = cardDaysIn(s, ctx);
  for (const m of s.matchAll(PLAIN_NUMBER)) {
    const n = Number(m[1]);
    if (ctx.scores.has(n) && !ctx.ownerNumbers.has(n) && (days.length || INDEX_WORD.test(s))) return true;
  }
  const ranks = RANK_WORD.test(s);
  if (days.length && ranks) return true;
  const before = String(previous || '');
  if (before && !GENERIC.test(before)) {
    if (ranks && PRONOUN_START.test(s) && cardDaysIn(before, ctx).length) return true;
    if (days.length && s.trim().split(/\s+/).length <= 3 && RANK_WORD.test(before)) return true;
  }
  return false;
}

/**
 * True when a sentence speaks of the card at all: names one of its days the
 * owner did not name, or its index. A number the answer check credits to the
 * card ("at 48 a head" beside a card day scored 48) is the card only then.
 */
function speaksOfCard(sentence, ctx) {
  if (!ctx) return false;
  const s = String(sentence === null || sentence === undefined ? '' : sentence);
  if (GENERIC.test(s)) return false;
  return cardDaysIn(s, ctx).length > 0 || INDEX_WORD.test(s);
}

// "your slowest day", "your quietest", "your busy nights", "your peak night",
// "your best night": a day or night called the venue's own, in a ranking.
const OWN_SUPERLATIVE = /\byour\s+(?:own\s+)?(quietest|slowest|deadest|emptiest|weakest|lowest|busiest|biggest|strongest|fullest|highest)\b/gi;
const OWN_RANKED = /\byour\s+(?:own\s+)?(quiet(?:er)?|slow(?:er)?|dead|weak(?:er)?|low(?:er)?|busy|busier|big(?:ger)?|strong(?:er)?|full|high(?:er)?|peak|top|packed|best|worst)\s+(?:days?|nights?|evenings?|stretch(?:es)?|weekdays?|weeknights?)\b/gi;
// "your forecast shows", "your week bottoms out", "your own pattern puts".
// Not "your readings": the owner's own posted readings are theirs to be told
// about, and the attribution rule above holds the card to its words.
const OWN_FORECAST = /\byour\s+(?:own\s+)?(?:forecast|pattern|curve|history|week|weeks|crowd|index|scores?)\s+(?:shows?|showed|has|have|had|puts?|says?|said|is|are|was|were|peaks?|bottoms?|runs?|ranks?|reads?|sits?|lands?)\b/i;

/** True when `sentence` calls the card's week the venue's own. */
function ownsCard(sentence, ctx) {
  if (!ctx) return false;
  const s = String(sentence === null || sentence === undefined ? '' : sentence);
  for (const re of [OWN_SUPERLATIVE, OWN_RANKED]) {
    for (const m of s.matchAll(re)) {
      // The owner's own word for their day is theirs to have said back.
      if (!ctx.ownerFamilies.has(familyOf(m[1]))) return true;
    }
  }
  return OWN_FORECAST.test(s);
}

// ── The playbook's own copy, beside the card ────────────────────────────────
//
// The playbook writes its moves for the venue's own week: "Give your slowest
// day one recurring reason to visit". Under a line that names the card's
// quiet day, that reads as "Sunday is your slowest day", the one thing a
// forecast for places like this one must not say (2026-11-03 review). Beside
// the card the move points at the day the answer named instead: "Give that
// day one recurring reason to visit". Only the day words change.
const OWN_DAY_PHRASE = /\b(your)\s+(?:own\s+)?(?:quietest|slowest|busiest|quiet|slow|busy|weakest|deadest|emptiest)\s+(day|night|evening)(s?)\b/gi;

/** The playbook's copy with its "your slowest day" pointed at the day named. */
function unownDays(text) {
  return String(text === null || text === undefined ? '' : text).replace(OWN_DAY_PHRASE, (m, your, noun, plural) => {
    const word = plural ? `those ${noun}s` : `that ${noun}`;
    return your.charAt(0) === 'Y' ? `${word.charAt(0).toUpperCase()}${word.slice(1)}` : word;
  });
}

/** A playbook move as the payloads carry it ({move, why, example, watch}), reworded the same way. */
function unownPlay(play) {
  if (!play || typeof play !== 'object') return play;
  return Object.fromEntries(Object.entries(play).map(([k, v]) => [k, typeof v === 'string' ? unownDays(v) : v]));
}

/** True when a block's facts hold the card. */
function holdsCard(facts) {
  return (Array.isArray(facts) ? facts : []).some(isKindForecast);
}

module.exports = {
  KIND_FORECAST_SOURCE,
  KIND_FORECAST,
  isKindForecast,
  holdsCard,
  saysWhose,
  cardContext,
  readsAsCard,
  speaksOfCard,
  ownsCard,
  unownDays,
  unownPlay,
};
