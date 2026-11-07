// ---------------------------------------------------------------------------
// FLOCK'S FORECAST FOR PLACES LIKE THIS ONE (2026-11-03).
//
// A venue with no crowd history of its own still has a Week Ahead on its
// dashboard, and every number on it is what is typical for its kind of place
// (a category prior: the rule engine, or the category table). Roost answers
// its week questions from it when that is all there is
// (advisorFacts.buildWeekProjection), and says whose forecast it is:
//   * the template twin and the playbook's lead open on it, in these words
//     (advisorPhrasing shapeWeek and shapeMoneyMove, roostPlaybook.groundedLead);
//   * a phrased answer built on it must open on it too, and may not put
//     "you" or "your" beside a ranking of its days anywhere, or the answer
//     check serves the template instead (advisorPhrasing.checkAnswer);
//   * the advice model is not handed it at all (advisorFreeText.advise).
//
// WHY THE RULES ARE THIS BLUNT. The first version read drafts for every way
// a sentence can give the card as the venue's own, and two adversarial reviews
// on 2026-11-03 found a new wording each time: "Saturday is your busiest
// night" two points after the attribution, "for a bar like yours" as an
// opener that vouched for everything after it, the owner's own word for a day
// excusing the card's number for it. A reader of wordings can be talked past.
// An answer that opens on whose forecast it is and never says "your" beside a
// ranking cannot read as the venue's own, and the template it falls back to
// is the card's exact numbers in the right words, so a false alarm costs
// wording, never truth.
//
// The facts are marked by their source, 'category_pattern': the vocabulary's
// word for a category prior (crowdEngine.describePredictionSupport), and no
// other Roost fact carries it.
// ---------------------------------------------------------------------------

const KIND_FORECAST_SOURCE = 'category_pattern';

// What the owner reads, in those words, wherever Roost answers from it.
const KIND_FORECAST = "Flock's forecast for places like yours";

/** True for a fact that is Flock's forecast for places like this venue. */
function isKindForecast(fact) {
  return Boolean(fact) && fact.source === KIND_FORECAST_SOURCE;
}

/** True when a block's facts hold the card. */
function holdsCard(facts) {
  return (Array.isArray(facts) ? facts : []).some(isKindForecast);
}

const KIND_NOUN = '(?:places?|venues?|rooms?|spots?|bars?|pubs?|caf(?:e|\\u00e9)s?|coffee\\s+shops?|restaurants?|diners?|clubs?|nightclubs?|bakeries|bakery)';

// The words an answer built on the card opens with: the forecast, for places
// like this one. "Flock's forecast for places like yours", "the forecast for
// bars like yours", "what is typical for places like yours". A "like yours"
// that is not about the forecast ("for a bar like yours, a quiz is the
// classic fill") says nothing about whose numbers follow.
const OPENS_WHOSE = new RegExp(`\\b(?:forecasts?|typical)\\s+for\\s+(?:a\\s+|an\\s+)?${KIND_NOUN}\\s+like\\s+(?:yours|you|this\\s+one)\\b`, 'i');

/** True when the text says, in the forecast's own words, whose forecast it is. */
function saysWhose(text) {
  return OPENS_WHOSE.test(String(text === null || text === undefined ? '' : text));
}

// The phrases that name the kind of place ("places like yours", "bars similar
// to yours"), set aside before the next rule reads a sentence, so the opening
// words themselves are never read as "your".
const LIKE_YOURS = new RegExp(`\\b${KIND_NOUN}\\s+(?:like|similar\\s+to|such\\s+as)\\s+(?:yours|you|this\\s+one)\\b`, 'gi');
const SECOND_PERSON = /\b(?:you|your|yours|you're|you've|you'll|youre)\b/i;
// The words that rank a day against the week, or name a forecast. Not "the
// rush", "best" or "top" alone: "stagger your shifts as the rush builds" is
// staffing, not a reading of the card.
const RANKING = /\b(?:quiet(?:er|est)?|slow(?:er|est)?|dead(?:est)?|empt(?:y|ier|iest)|weak(?:er|est)|lowest|least\s+busy|busy|busi(?:er|est)|biggest|strong(?:er|est)|fullest|highest|peak(?:s|ed|ing)?|packed|lull|(?:best|worst|top|big)\s+(?:day|night|evening)s?|forecasts?|pattern|curve|history)\b/i;

/**
 * True when `sentence`, in an answer built on the card, could read as the
 * venue's own: "you" or "your" beside a ranking or a forecast word ("your
 * quietest night", "you peak on Saturday", "your forecast"), once the words
 * naming the kind of place are set aside.
 */
function ownsCard(sentence) {
  const s = String(sentence === null || sentence === undefined ? '' : sentence).replace(LIKE_YOURS, ' ');
  return SECOND_PERSON.test(s) && RANKING.test(s);
}

// ── The playbook's own copy, beside the card ────────────────────────────────
//
// The playbook writes its moves for the venue's own week: "Give your slowest
// day one recurring reason to visit". Under a line that names the card's quiet
// day, that reads as "Sunday is your slowest day", the one thing a forecast
// for places like this one must not say. Beside the card the move names the
// day the answer named: "Give Sunday one recurring reason to visit". Only the
// quiet days are renamed; "your busiest nights" is the owner's own knowledge
// of their room and stays (2026-11-03 review: renaming it put higher VIP
// minimums on the quiet day).
const QUIET_DAY_PHRASE = /\byour\s+(?:own\s+)?(?:quietest|slowest|quiet|slow|weakest|deadest|emptiest)\s+(day|night|evening)(s?)\b/gi;

/** The playbook's copy with its "your slowest day" naming `day` instead. */
function unownDays(text, day) {
  const s = String(text === null || text === undefined ? '' : text);
  if (typeof day !== 'string' || !day) return s;
  return s.replace(QUIET_DAY_PHRASE, (m, noun, plural) => (plural ? `${noun}s like ${day}` : day));
}

/** A playbook move as the payload carries it ({move, why, example, watch}), renamed the same way. */
function unownPlay(play, day) {
  if (!play || typeof play !== 'object') return play;
  return Object.fromEntries(Object.entries(play).map(([k, v]) => [k, typeof v === 'string' ? unownDays(v, day) : v]));
}

/** The weekday of the card's quietest day in `facts`, or null. */
function cardQuietDay(facts) {
  let low = null;
  for (const f of Array.isArray(facts) ? facts : []) {
    if (!isKindForecast(f) || !f.value || typeof f.value.weekday !== 'string') continue;
    // Today beside the week, away from its quiet end, is no quiet day
    // (besideWeek below).
    if (f.quietEnd === false) continue;
    const score = Number(f.value.peakScore);
    if (!Number.isFinite(score)) continue;
    if (!low || score < low.score) low = { score, weekday: f.value.weekday };
  }
  return low ? low.weekday : null;
}

/**
 * A playbook line as Roost shows it under an answer built on `facts`: in the
 * playbook's own words, or, when the facts hold the card, naming the card's
 * quiet day instead of "your slowest day". The chip's template
 * (routes/advisor.js) and the Monday email's money move
 * (advisorMoneyMove.digestCard) both show a move through this one function,
 * so the email says what the chip says.
 */
function besideCard(text, facts) {
  const day = cardQuietDay(facts);
  return day ? unownDays(text, day) : text;
}

// ── Today, beside the card's week (2026-11-06) ──────────────────────────────
//
// The card's week starts tomorrow and today is its own entry, so on a Monday
// "How do I fill a slow Monday?" found no Monday in a no-history venue's week
// and had no number to lead with. A question about today's weekday is now
// answered from today's entry (routes/advisor.js withNamedToday), handed over
// beside the week with this note and never ranked against it: "the busiest
// day this week" and "the quietest" stay the card's own days, the ones the
// money move and the dashboard's tiles name. The note says the same to the
// phrasing model. The weekend is the one answer that ranks today with the
// days after it, because today is part of the weekend it asks about.
const BESIDE_WEEK_NOTE = 'This is today. The other days are the week ahead, which starts tomorrow, so today is not ranked against them.';

/**
 * Today's entry on the card, as a block carries it beside the card's week.
 * `quietEnd` says whether today sits at the quiet end of that week, within the
 * ordering floor of its quietest day (routes/advisor.js withNamedToday): the
 * move under an answer about today fills it only then (roostPlaybook.moveFor,
 * review 2026-11-06). It is never a value, so no answer can say it.
 */
function besideWeek(fact, { quietEnd = null } = {}) {
  return {
    ...fact,
    note: [fact.note, BESIDE_WEEK_NOTE].filter(Boolean).join(' '),
    ...(typeof quietEnd === 'boolean' ? { quietEnd } : {}),
  };
}

// ── Tonight, the night still running, beside the calendar's week (2026-11-07)
//
// At 12:30 AM on a Saturday, with Friday night still running, a venue with its
// own curve answers "tonight" with that night, and the seven days the
// forecast covers are the calendar's, Saturday to next Friday. A question that
// sets tonight beside another day ("Will tonight be busier than Friday?") is
// answered from those seven days, with tonight beside them and never ranked
// in them, as a card's today is (routes/advisor.js bothAnswer). The same note
// tells the phrasing model, and every reader of besideWeek's mark reads this
// one too (isBesideWeek).
const BESIDE_NIGHT_NOTE = 'This is tonight, the night still running. The other days are the seven days from today, so tonight is not ranked against them.';

/** Tonight's entry, the night still running, as a block carries it beside the calendar's week. */
function besideNight(fact) {
  return { ...fact, note: [fact.note, BESIDE_NIGHT_NOTE].filter(Boolean).join(' ') };
}

/** True for the night still running handed over beside the calendar's week (besideNight). */
function isBesideNight(fact) {
  return Boolean(fact) && typeof fact.note === 'string' && fact.note.includes(BESIDE_NIGHT_NOTE);
}

/** True for today's entry handed over beside the card's week (besideWeek), or tonight beside the calendar's (besideNight). */
function isBesideWeek(fact) {
  return Boolean(fact) && typeof fact.note === 'string' && (fact.note.includes(BESIDE_WEEK_NOTE) || fact.note.includes(BESIDE_NIGHT_NOTE));
}

// A PHRASED ANSWER NEVER RANKS TODAY (review, 2026-11-06). The model is handed
// today alone for a question about today, and was once handed the week beside
// it and wrote "Flock's forecast for places like yours has Sunday as the
// quietest day this week" while the money move said Monday. So a draft built
// on today's entry goes to the template if any sentence ranks a DAY against
// other days. Blunt on purpose, like the rules above: a false alarm costs
// wording, and the template is today's true line.
//
// THE DAY, NOT THE NIGHT'S OWN HOURS (second review, 2026-11-06). The first
// version read any superlative or comparative in a sentence that named
// today, so ordinary answers about the night itself went to the template:
// "The busiest stretch tonight is the hour before that", "Put your best
// bartender on before 9 PM", "Most guests tonight will arrive after 8 PM",
// "Keep the menu to your top sellers tonight". A sentence ranks a day when it
//   * puts a ranking word on a day: "the quietest day", "the busiest night",
//     "a slower evening", "the peak night", "this week's quietest";
//   * puts a superlative over the week: "the slowest of the week", "the
//     busiest stretch this week";
//   * compares with other days: "busier than Friday", "lower than the
//     weekend", "quieter than usual";
//   * or lets a superlative stand for the day: "Monday is the quietest."
const SUPERLATIVE = '(?:quietest|slowest|busiest|biggest|smallest|lowest|highest|strongest|weakest|deadest|emptiest|fullest|best|worst)';
const COMPARATIVE = '(?:quieter|slower|busier|bigger|smaller|lower|higher|stronger|weaker|deader|emptier|fuller|better|worse)';
const RANK_WORD = `(?:${SUPERLATIVE}|${COMPARATIVE}|top|peak|(?:most|least)\\s+(?:busy|crowded|packed|quiet|full|popular))`;
const DAY_NOUN = '(?:day|night|evening|weekday|weeknight)s?';
const WEEKDAY_NAME = '(?:mon|tues|wednes|thurs|fri|satur|sun)days?';
const RANKED_DAY = new RegExp(`\\b${RANK_WORD}\\s+(?:[a-z']+\\s+){0,2}?${DAY_NOUN}\\b`, 'i');
const WEEKS_RANK = new RegExp(`\\bweek'?s\\s+(?:[a-z']+\\s+)?${RANK_WORD}\\b`, 'i');
const OVER_THE_WEEK = new RegExp(`\\b${SUPERLATIVE}\\b[^.!?]*?\\b(?:(?:of|in)\\s+the\\s+week|(?:this|all)\\s+week)\\b`, 'i');
const THAN_OTHER_DAYS = new RegExp(`\\b${COMPARATIVE}\\s+than\\s+(?:[a-z']+\\s+){0,3}?(?:${WEEKDAY_NAME}|${DAY_NOUN}|usual|normal|average|typical|rest|others?|most|any|week|weekend|yesterday|tomorrow|today|tonight)\\b`, 'i');
const STANDS_FOR_DAY = new RegExp(`\\bthe\\s+(?:[a-z']+\\s+)?${SUPERLATIVE}(?=\\s*(?:[.,;:!?)]|$))`, 'i');

/** True when `sentence` ranks a day against other days (above). */
function ranksToday(sentence) {
  const s = String(sentence === null || sentence === undefined ? '' : sentence);
  return [RANKED_DAY, WEEKS_RANK, OVER_THE_WEEK, THAN_OTHER_DAYS, STANDS_FOR_DAY].some((re) => re.test(s));
}

module.exports = {
  KIND_FORECAST_SOURCE,
  KIND_FORECAST,
  isKindForecast,
  holdsCard,
  saysWhose,
  ownsCard,
  unownDays,
  unownPlay,
  cardQuietDay,
  besideCard,
  BESIDE_WEEK_NOTE,
  besideWeek,
  isBesideWeek,
  BESIDE_NIGHT_NOTE,
  besideNight,
  isBesideNight,
  ranksToday,
};
