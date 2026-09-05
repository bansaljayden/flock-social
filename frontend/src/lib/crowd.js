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
 * The colour the crowd dial's arc takes, cut on the same ladder as the word.
 *
 * These are the bright ends of the app's crowd palette rather than the ones the
 * cards use on cream, because the dial sits on a dark scrim over a photograph
 * and the on-cream greens and ambers disappear there.
 */
export const crowdArcFor = (score) => {
  if (!Number.isFinite(score)) return null;
  if (score <= 39) return '#4ADE80';
  if (score <= 69) return '#FBBF24';
  return '#F87171';
};
