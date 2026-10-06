/**
 * The crowd ladder's words, in one place.
 *
 * WHY THIS FILE EXISTS. `crowdLabelFor` lived inside App.js, so anything
 * outside App.js that wanted to say how busy a place is had to write the cuts
 * out again. The chat module is one of those: it is presentational and cannot
 * import App.js, because App.js imports it. A third copy of a five-rung ladder
 * is how two surfaces end up disagreeing about what "Busy" means, and the
 * ladder has already been re-cut once (2026-08-28, when it gained "Packed").
 *
 * THE CANONICAL COPY IS THE SERVER'S: `getLabel` in
 * `backend/services/crowdEngine.js`. This mirrors it word for word and cut for
 * cut. If the server's ladder moves, move this with it, or the app will label
 * a score differently from the prediction that produced it.
 */

export const crowdLabelFor = (score) => {
  if (!Number.isFinite(score)) return null;
  if (score <= 20) return 'Quiet';
  if (score <= 39) return 'Not Busy';
  if (score <= 69) return 'Steady';
  if (score <= 84) return 'Busy';
  return 'Packed';
};

export default crowdLabelFor;

/**
 * The colour the crowd dial's arc takes, read off the word above rather than
 * cut again.
 *
 * It used to carry its own numbers and turned red at 70, so a Busy 75 drew a
 * red arc in a chat card while every other surface (App.js crowdBandFor, the
 * site, the colour bands in backend/services/crowdEngine.js) draws Busy in
 * amber and keeps red for Packed at 85 and up. Deriving the colour from
 * crowdLabelFor means the arc can only change colour where the word changes,
 * and a re-cut of the ladder moves both at once: Quiet and Not Busy are green,
 * Steady and Busy amber, Packed red.
 *
 * These are the bright ends of the app's crowd palette rather than the ones the
 * cards use on cream, because the dial sits on a dark scrim over a photograph
 * and the on-cream greens and ambers disappear there.
 */
export const crowdArcFor = (score) => {
  const word = crowdLabelFor(score);
  if (!word) return null;
  if (word === 'Packed') return '#F87171';
  if (word === 'Steady' || word === 'Busy') return '#FBBF24';
  return '#4ADE80';
};

/**
 * What made a crowd number, in words, when the server says a serving switch
 * changed the arithmetic.
 *
 * The server keeps predictionMethod 'ml' for every number the model path
 * answered, including one made from the venue's own weekly pattern plus its
 * recent live readings with no model run at all. Those responses carry
 * `numberSource` (`number_source` on the public demo), named by
 * backend/services/crowdEngine.js describePublishedArithmetic; every other
 * response has no such key, and this returns null so each surface keeps the
 * words it already had.
 *
 * A source ending in '_adjusted' is that arithmetic with verified visitor
 * reports blended in afterwards. Its words say so, and a carried reading is
 * then never worded as the number itself.
 *
 * One source is not the venue's at all. 'category_typical' is the server's
 * no-curve fallback (predictionMethod 'category_curve_no_baseline', behind
 * the switch CROWD_NO_CURVE_FALLBACK): for a venue with no crowd curve of its
 * own, what is typical for its kind of place at that hour of the week. Its
 * words say exactly that, and never this venue's pattern, the model or live.
 */
const NUMBER_SOURCE_PHRASES = {
  venue_pattern_live: "this venue's usual pattern and its recent live readings",
  venue_pattern: "this venue's usual pattern",
  model_live: "the Flock crowd model and this venue's recent live readings",
  model_alone: 'the Flock crowd model alone',
  category_typical: 'what is typical for this kind of place at this hour of the week',
};
// The predictionMethod that number carries, the server's
// crowdEngine.NO_CURVE_FALLBACK_METHOD.
export const NO_CURVE_FALLBACK_METHOD = 'category_curve_no_baseline';
// The same sources once visitor reports adjusted the number. "Alone" goes:
// the model's number is not alone any more.
const ADJUSTED_BASE_PHRASES = {
  ...NUMBER_SOURCE_PHRASES,
  model_alone: 'the Flock crowd model',
};
const ADJUSTED_SUFFIX = '_adjusted';
// WHAT THE ADJUSTMENT IS, AND NO MORE. The blend
// (crowdEngine.buildCalibrationAdjustment) reads verified reports filed for
// the same hour of the week, give or take an hour, from the last 28 days
// (routes/crowd.js feedbackWindow and its SELECT). Three "busy" reports from
// last Friday move tonight's number, and nothing requires any reporter to be
// in the room now, so the words say when the reports are from and never that
// people who are there made the number.
export const REPORTS_ADJUSTED_WORDS = 'adjusted by visitor reports from this time of week over the last four weeks';

// 'live_reading_1h', 'live_reading_2h', ...: the number IS the venue's live
// reading from that many hours ago, carried forward at full weight. The
// server's nowcast never reaches past 12 hours.
const LIVE_READING_SOURCE = /^live_reading_([1-9]|1[0-2])h$/;
const liveReadingHours = (source) => {
  const m = typeof source === 'string' ? LIVE_READING_SOURCE.exec(source) : null;
  return m ? Number(m[1]) : null;
};
const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

// { base, adjusted } for a source the server can name, or null.
const parseSource = (source) => {
  if (typeof source !== 'string') return null;
  const adjusted = source.endsWith(ADJUSTED_SUFFIX);
  const base = adjusted ? source.slice(0, -ADJUSTED_SUFFIX.length) : source;
  if (liveReadingHours(base) === null && !hasOwn(NUMBER_SOURCE_PHRASES, base)) return null;
  return { base, adjusted };
};

const readingPhrase = (hours) => `this venue's live reading taken ${hours === 1 ? 'an hour' : `${hours} hours`} ago`;

export const numberSourcePhrase = (source) => {
  const parsed = parseSource(source);
  if (!parsed) return null;
  const hours = liveReadingHours(parsed.base);
  if (!parsed.adjusted) {
    return hours !== null ? readingPhrase(hours) : NUMBER_SOURCE_PHRASES[parsed.base];
  }
  const base = hours !== null ? readingPhrase(hours) : ADJUSTED_BASE_PHRASES[parsed.base];
  return `${base}, ${REPORTS_ADJUSTED_WORDS}`;
};

// True when the named source already says visitor reports adjusted the
// number, so a line that adds those words itself does not say them twice.
export const isAdjustedSource = (source) => {
  const parsed = parseSource(source);
  return Boolean(parsed && parsed.adjusted);
};

// True when the number is the typical level for this kind of place (the
// no-curve fallback), adjusted or not: not a reading of this venue, so not
// live by any reading of the word.
export const isCategoryTypicalSource = (source) => {
  const parsed = parseSource(source);
  return Boolean(parsed && parsed.base === 'category_typical');
};

/**
 * The venue card's line under the dial: where the number came from.
 *
 * Every published figure carries confidenceBasis, and a number a serving
 * switch made carries numberSource too. The reporters' line has to say what
 * the reports adjusted, and that is not always the model: a venue with no ML
 * baseline is scored by the rule engine (predictionMethod 'rule_engine...'),
 * and three verified reports blend into that number exactly as they blend
 * into a model's. So the fallback reads predictionMethod before it names a
 * base, and a rule-engine number is called what it is: typical for a venue
 * like this one. Only 'ml' is the model; a missing method is not assumed to
 * be. A named source is only ever sent while a serving switch is on, and it
 * already carries the reports words when reports adjusted it, so they are
 * not said twice. The one named source that is not the model path's,
 * 'category_typical', names itself the same way: what is typical for this
 * kind of place at this hour of the week.
 */
export const RULE_ENGINE_WORDS = 'what is typical for a venue like this';
export const cardSourceLine = (cd) => {
  if (!cd) return null;
  if (cd.confidenceBasis === 'owner_report') return `From the ${cd.ownerReport?.noun || 'venue'} itself, not a Flock estimate.`;
  const madeFrom = numberSourcePhrase(cd.numberSource);
  const model = cd.predictionMethod === 'ml';
  if (cd.confidenceBasis === 'user_reports') {
    if (madeFrom && isAdjustedSource(cd.numberSource)) return `From ${madeFrom}.`;
    if (madeFrom) return `From ${madeFrom}, ${REPORTS_ADJUSTED_WORDS}.`;
    return model ? `From the crowd model, ${REPORTS_ADJUSTED_WORDS}.` : `From ${RULE_ENGINE_WORDS}, ${REPORTS_ADJUSTED_WORDS}.`;
  }
  if (isCategoryTypicalSource(cd.numberSource)) return `From ${madeFrom}.`;
  if (model) return madeFrom ? `From ${madeFrom}.` : 'From the Flock crowd model.';
  return 'An estimate from typical patterns for this kind of place.';
};

// True when the number is the venue's weekly pattern with no live reading
// and no model run in it (curve_offset with neither an offset nor a reading),
// adjusted or not. Such a number is not live by any reading of the word.
export const isPatternOnlySource = (source) => {
  const parsed = parseSource(source);
  return Boolean(parsed && parsed.base === 'venue_pattern');
};

// What each source is made of: the base it starts from (null when a carried
// reading replaced it) and whether a live reading reached the number.
const SOURCE_PARTS = {
  venue_pattern_live: { base: 'pattern', live: true },
  venue_pattern: { base: 'pattern', live: false },
  model_live: { base: 'model', live: true },
  model_alone: { base: 'model', live: false },
  // Not measured at this venue at all, like a rule-engine bar.
  category_typical: { base: 'category', live: false },
};
// The chart's words when every bar drawn is typical for this kind of place and
// at least one is the category table's: true of every bar, whatever the reader.
const CATEGORY_HOURS_WORDS = 'what is typical for this kind of place at each hour of the week';
const BASE_PHRASES = {
  pattern: "this venue's usual pattern",
  model: 'the Flock crowd model',
  both: "the Flock crowd model or this venue's usual pattern",
};
const RULE_HOURS_WORDS = 'and in hours not measured here yet, what is typical for a venue like yours';
// The same words for a reader who is not the venue (the public demo): "like
// yours" would address a visitor as the owner.
const RULE_HOURS_WORDS_VISITOR = 'and in hours not measured there yet, what is typical for a venue like this one';

/**
 * The words for an hourly chart, from the bars actually drawn.
 *
 * Each forecast hour carries its own `numberSource`, because a serving switch
 * can change one hour's arithmetic and not the next (the nowcast has a reading
 * for the next hour and none for an evening eight hours out). The current
 * score's attribution is not the chart's, and a caption must not be chosen
 * off the current score either: with the venue's pattern served, the current
 * hour can be a rule-engine hour while every later bar is the pattern's.
 *
 * Whether live readings reached a bar comes from the bar's own `liveReadings`
 * yes or no, which the server sends on every hour while a switch is on. It is
 * never inferred from a missing source: the server names no source for a
 * model hour whose live offset happened to land on the stored offset's score,
 * and that hour still used live readings.
 *
 * Null when no drawn bar carries a source, so the chart keeps the caption it
 * already had. A model bar without a source counts as the model's number; a
 * rule-engine bar beside named ones is said to be typical for a venue like
 * this one. `reader: 'visitor'` words that for someone who is not the venue.
 * A bar the category table made ('category_typical') is not measured here
 * either: beside measured bars it joins the rule-engine words, and when no
 * bar is measured the chart says every bar is typical for this kind of place.
 */
export const hourlySourcePhrase = (bars, { reader = 'owner' } = {}) => {
  const ruleWords = reader === 'visitor' ? RULE_HOURS_WORDS_VISITOR : RULE_HOURS_WORDS;
  if (!Array.isArray(bars)) return null;
  const drawn = bars.filter(Boolean);
  const sourceOf = (b) => (parseSource(b.numberSource) ? b.numberSource : null);
  if (!drawn.some(sourceOf)) return null;

  const parts = drawn.map((b) => {
    const s = sourceOf(b);
    const flag = typeof b.liveReadings === 'boolean' ? b.liveReadings : null;
    if (s) {
      const known = SOURCE_PARTS[parseSource(s).base] || { base: null, live: true };
      return { source: s, base: known.base, live: flag === null ? known.live : flag };
    }
    if (b.predictionMethod === 'ml') return { source: null, base: 'model', live: flag === true };
    return { source: null, base: 'rule', live: false };
  });
  const measured = parts.filter((p) => p.base !== 'rule' && p.base !== 'category');
  if (measured.length === 0) return CATEGORY_HOURS_WORDS;
  const ruleHours = measured.length < parts.length;
  const withRule = (phrase) => (ruleHours ? `${phrase}, ${ruleWords}` : phrase);

  const distinct = new Set(measured.map((p) => p.source));
  if (distinct.size === 1 && measured[0].source) return withRule(numberSourcePhrase(measured[0].source));

  const bases = new Set(measured.map((p) => p.base).filter(Boolean));
  const live = measured.filter((p) => p.live).length;
  if (bases.size === 0) return withRule("this venue's live readings from earlier hours");
  const base = bases.size > 1 ? BASE_PHRASES.both : BASE_PHRASES[[...bases][0]];
  if (live === measured.length) return withRule(`${base} and this venue's recent live readings`);
  if (live > 0) return withRule(`${base}, with this venue's recent live readings in some hours`);
  return withRule(base);
};

// True when hourlySourcePhrase says every bar drawn is typical for this kind
// of place: no bar is this venue's own data or a live reading, so a caption
// over those bars must not call them live.
export const hourlyTypicalOnly = (bars) => hourlySourcePhrase(bars) === CATEGORY_HOURS_WORDS;

/**
 * The words for a row of OTHER venues' numbers, one bar per venue (the venue
 * dashboard's strip of evening peaks nearby).
 *
 * Same inputs as hourlySourcePhrase, one { predictionMethod, numberSource,
 * liveReadings } per bar, but the bars are several venues rather than one
 * venue's hours, so "this venue's" would be false. A rule-engine bar is
 * labelled "typical for its category" beside itself (stripRowMethod), and the
 * caption says so too: with every peak a rule-engine one, a caption naming
 * the crowd model would credit a model that made none of them. Null when no
 * bar carries a source and none is the rule engine's, so the caption keeps
 * the words it had with both switches off (no bar is passed then) and with
 * every peak the model's own.
 */
const CATEGORY_WORDS = "what is typical for each venue's category";
const CATEGORY_SOME_WORDS = 'or what is typical for the category where a row says so';
export const peersSourcePhrase = (bars) => {
  if (!Array.isArray(bars)) return null;
  const drawn = bars.filter((b) => b && b.predictionMethod === 'ml');
  const ruleRows = bars.some((b) => b && typeof b.predictionMethod === 'string' && b.predictionMethod !== 'ml');
  if (!drawn.some((b) => parseSource(b.numberSource))) {
    if (!ruleRows) return null;
    if (drawn.length === 0) return CATEGORY_WORDS;
  }
  const phrase = modelPeersPhrase(drawn);
  return ruleRows ? `${phrase}, ${CATEGORY_SOME_WORDS}` : phrase;
};

// The words for the model-path bars alone (at least one).
const modelPeersPhrase = (drawn) => {
  const bases = new Set();
  let readings = 0;
  let measured = 0;
  let live = 0;
  for (const b of drawn) {
    const parsed = parseSource(b.numberSource);
    if (parsed && liveReadingHours(parsed.base) !== null) { readings += 1; continue; }
    const known = parsed ? SOURCE_PARTS[parsed.base] : { base: 'model', live: false };
    const flag = typeof b.liveReadings === 'boolean' ? b.liveReadings : known.live;
    bases.add(known.base);
    measured += 1;
    if (flag) live += 1;
  }

  const words = [];
  if (bases.has('pattern')) words.push("each venue's usual pattern");
  if (bases.has('model')) words.push('the Flock crowd model');
  let phrase = words.join(' or ');
  if (measured > 0 && live === measured) phrase += ' and recent live readings';
  else if (live > 0) phrase += ', with recent live readings for some venues';
  if (readings > 0) {
    phrase = phrase ? `${phrase}, or a live reading from an earlier hour` : 'live readings from earlier hours';
  }
  return phrase;
};

/**
 * What made the number a strip row draws, for its "typical for its category"
 * label. The bar is the evening's peak, not the current hour, and while a
 * serving switch is on the two can differ: a row whose current hour is the
 * model's can draw a peak the rule engine made for want of a pattern hour.
 * The server sends the peak's method exactly while a switch is on (gated on
 * peakLiveReadings), and it decides then. With both switches off the row has
 * only its current method, which decides exactly as before.
 */
export const stripRowMethod = (row) => {
  if (!row) return null;
  if (typeof row.peakLiveReadings === 'boolean') return row.peakMethod || null;
  return row.method || null;
};

// The strip's rows as bars for peersSourcePhrase: only rows that say what
// made their peak, which is every row while a switch is on and none with both
// off.
export const stripPeakBars = (rows) => (Array.isArray(rows) ? rows : [])
  .filter((v) => v && typeof v.peakLiveReadings === 'boolean')
  .map((v) => ({ predictionMethod: v.peakMethod, numberSource: v.peakNumberSource, liveReadings: v.peakLiveReadings }));
