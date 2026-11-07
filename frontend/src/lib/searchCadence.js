// HOW LONG THE VENUE SEARCH WAITS AFTER A KEYSTROKE.
//
// The Discover search used to wait a flat 800 ms after the last key before it
// asked the server, and every search it sends is a paid Google Places text
// search. A flat 300 ms would answer sooner, but measured on typed sequences
// (scratch simulation, ten venue names typed 200 times each with realistic
// jitter and an occasional mid-word hesitation) it sent 3.3x the searches for
// someone typing at 260 ms a key and 6x for someone at 420 ms: every pause
// longer than 300 ms mid-word became a search nobody wanted.
//
// So the wait follows the person's own rhythm: three times the median of
// their last six gaps between keys, never under 300 ms and never over the old
// 800. Somebody typing at 100 ms a key gets the 300 ms floor; somebody at
// 260 ms a key gets close to the old wait, because for them a 300 ms pause is
// not the end of a word. Gaps over 1.5 s are not typing rhythm (the person
// stopped to look), so they are left out. With no rhythm yet (a paste, or the
// first key after a pause) the floor applies: there is nothing to wait for.
//
// The Return key does not wait at all (ExploreScreen onSearchKeyDown), and a
// search that is no longer wanted is aborted (App.js doVenueSearch).

export const SEARCH_WAIT_MIN_MS = 300;
export const SEARCH_WAIT_MAX_MS = 800;
const RHYTHM_GAPS = 6;
const NOT_RHYTHM_MS = 1500;
const RHYTHM_FACTOR = 3;

// The gaps to keep after a key at `now`, given the previous key's time.
export const nextKeyGaps = (gaps, lastKeyAt, now) => {
  const kept = Array.isArray(gaps) ? gaps.slice() : [];
  if (typeof lastKeyAt === 'number' && typeof now === 'number') {
    const gap = now - lastKeyAt;
    if (gap >= 0 && gap < NOT_RHYTHM_MS) kept.push(gap);
  }
  return kept.slice(-RHYTHM_GAPS);
};

export const searchWaitMs = (gaps) => {
  const recent = (Array.isArray(gaps) ? gaps : []).filter((g) => typeof g === 'number' && g >= 0 && g < NOT_RHYTHM_MS).slice(-RHYTHM_GAPS);
  if (recent.length === 0) return SEARCH_WAIT_MIN_MS;
  const sorted = recent.slice().sort((a, b) => a - b);
  const median = sorted[sorted.length >> 1];
  return Math.round(Math.max(SEARCH_WAIT_MIN_MS, Math.min(SEARCH_WAIT_MAX_MS, RHYTHM_FACTOR * median)));
};
