/**
 * The venue photo placeholder, and the swap that reaches it.
 *
 * WHY THIS FILE EXISTS. Both lived inside App.js, so a screen or a component
 * that wanted the app's own fallback had to be handed it. The chat module's
 * venue card could not be: it is presentational and cannot import App.js,
 * because App.js imports it. The result was the one venue photo in the whole
 * product that fell back to a map pin glyph instead of the bird, and a comment
 * in each chat screen explaining that the asset path was not reachable from
 * there. It is reachable from here.
 *
 * The file itself is `frontend/public/marks/venue-placeholder.webp`: a
 * painted fairywren on a twig over a steel-blue wash (generated with
 * Higgsfield, 2026-11-07, never a Places photo). The wash is a middle value,
 * so the picture sits on the cream and the navy themes alike, and the bird is
 * in the middle, where the map crops a venue photo to a circle. It replaced a
 * photoreal sparrow on cream that glared on the dark theme. 800 x 600, so a
 * full-width card has it at 2x. venue-placeholder.jpg is the same picture,
 * kept for anything that still asks for the old name.
 */

export const VENUE_PHOTO_PLACEHOLDER = '/marks/venue-placeholder.webp';

/* Guarded against a placeholder that itself 404s, which would otherwise loop:
   the swap clears its own handler and refuses to fire on the placeholder. */
export const onVenuePhotoError = (e) => {
  if (!e || !e.target || String(e.target.src || '').endsWith(VENUE_PHOTO_PLACEHOLDER)) return;
  e.target.onerror = null;
  e.target.src = VENUE_PHOTO_PLACEHOLDER;
};
