// Spacing + radius scales pulled from the most-used values in App.js.
// Use these everywhere instead of magic numbers.

export const spacing = {
  xxs: 2,
  xs: 4,
  sm: 6,
  md: 8,
  lg: 12,
  xl: 14,
  xxl: 16,
  xxxl: 20,
  huge: 24,
  massive: 32,
};

export const radius = {
  none: 0,
  xs: 4,
  sm: 6,
  md: 8,
  lg: 10,
  xl: 12,
  xxl: 14,    // flock card, sensor card
  xxxl: 16,   // larger cards
  pill: 999,  // fully rounded pills
  round: 50,  // % alternative for circles via View aspectRatio
};

// Screen-level padding the web app actually uses in different contexts
export const screenPadding = {
  default: 16,
  tight: 12,
  loose: 20,
};
