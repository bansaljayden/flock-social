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
 * backend/services/crowdEngine.js describeServedArithmetic; every other
 * response has no such key, and this returns null so each surface keeps the
 * words it already had.
 */
const NUMBER_SOURCE_PHRASES = {
  venue_pattern_live: "this venue's usual pattern and its recent live readings",
  venue_pattern: "this venue's usual pattern",
  model_live: "the Flock crowd model and this venue's recent live readings",
  model_alone: 'the Flock crowd model alone',
};

// 'live_reading_1h', 'live_reading_2h', ...: the number IS the venue's live
// reading from that many hours ago, carried forward at full weight. The
// server's nowcast never reaches past 12 hours.
const LIVE_READING_SOURCE = /^live_reading_([1-9]|1[0-2])h$/;
const liveReadingHours = (source) => {
  const m = typeof source === 'string' ? LIVE_READING_SOURCE.exec(source) : null;
  return m ? Number(m[1]) : null;
};

export const numberSourcePhrase = (source) => {
  const hours = liveReadingHours(source);
  if (hours !== null) {
    return `this venue's live reading taken ${hours === 1 ? 'an hour' : `${hours} hours`} ago`;
  }
  return typeof source === 'string' && Object.prototype.hasOwnProperty.call(NUMBER_SOURCE_PHRASES, source)
    ? NUMBER_SOURCE_PHRASES[source]
    : null;
};

// What each source is made of: the base it starts from (null when a carried
// reading replaced it) and whether a live reading reached the number.
const SOURCE_PARTS = {
  venue_pattern_live: { base: 'pattern', live: true },
  venue_pattern: { base: 'pattern', live: false },
  model_live: { base: 'model', live: true },
  model_alone: { base: 'model', live: false },
};
const BASE_PHRASES = {
  pattern: "this venue's usual pattern",
  model: 'the Flock crowd model',
  both: "the Flock crowd model or this venue's usual pattern",
};

/**
 * The words for an hourly chart, from the bars actually drawn.
 *
 * Each forecast hour carries its own `numberSource`, because a serving switch
 * can change one hour's arithmetic and not the next (the nowcast has a reading
 * for the next hour and none for an evening eight hours out). The current
 * score's attribution is not the chart's. Null when no drawn bar carries a
 * source, so the chart keeps the caption it already had. A bar the model
 * answered without a source counts as the model's own number, which is what
 * the old caption already calls it; a rule-engine bar is not counted, as
 * before.
 */
export const hourlySourcePhrase = (bars) => {
  if (!Array.isArray(bars)) return null;
  const counted = bars.filter((b) => b && (b.predictionMethod === 'ml' || numberSourcePhrase(b.numberSource)));
  const sourceOf = (b) => (numberSourcePhrase(b.numberSource) ? b.numberSource : null);
  if (!counted.some(sourceOf)) return null;
  const distinct = new Set(counted.map(sourceOf));
  if (distinct.size === 1) return numberSourcePhrase([...distinct][0]);

  const parts = counted.map((b) => {
    const s = sourceOf(b);
    if (s && SOURCE_PARTS[s]) return SOURCE_PARTS[s];
    if (liveReadingHours(s) !== null) return { base: null, live: true };
    return { base: 'model', live: false };
  });
  const bases = new Set(parts.map((p) => p.base).filter(Boolean));
  const live = parts.filter((p) => p.live).length;
  if (bases.size === 0) return "this venue's live readings from earlier hours";
  const base = bases.size > 1 ? BASE_PHRASES.both : BASE_PHRASES[[...bases][0]];
  if (live === parts.length) return `${base} and this venue's recent live readings`;
  if (live > 0) return `${base}, with this venue's recent live readings in some hours`;
  return base;
};
