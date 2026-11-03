// ---------------------------------------------------------------------------
// HOW AN HOUR IS SAID TO AN OWNER (2026-11-03).
//
// "Your busiest point this week is Saturday around 12 AM" read oddly to a bar
// owner in the 2026-11-03 live eval: people say midnight, and noon. Roost
// wrote its hours in six places (the fact labels the cards and the Monday
// email print, the phrased answer's placeholders, the template twin, the
// playbook's lead line, the verdict's weather line and the cohort labels),
// each with its own copy of the same three lines, so the words live here now.
//
// Still the 12-hour clock: "9 PM", "2:30 PM", "12:30 AM". Only the hour on the
// dot at 0 and at 12 is a word. The answer check reads both words back as the
// hours they name (advisorAnswer.numbersIn), so a claim written with one is
// checked like any other.
//
// The forecast's own hour labels ("12 AM" in crowdEngine's hourly strips) are
// data other code parses back, and the strips draw them as narrow axis ticks,
// so they are not this module's business. The owner dashboard's two peak
// tiles turn them into these words where they sit in a sentence
// (frontend/src/screens/VenueDashboard.js spokenHourLabel).
// ---------------------------------------------------------------------------

/**
 * An hour of the day the way an owner says it.
 * @param {number} hour    0 to 23 (other integers wrap)
 * @param {number|string} [minutes]
 * @returns {string} "midnight", "noon", "9 PM", "2:30 PM", "12:30 AM"
 */
function spokenClock(hour, minutes = 0) {
  const n = ((Math.trunc(Number(hour)) % 24) + 24) % 24;
  const mm = Number(minutes) || 0;
  if (mm === 0 && n === 0) return 'midnight';
  if (mm === 0 && n === 12) return 'noon';
  const twelve = n % 12 === 0 ? 12 : n % 12;
  return `${twelve}${mm ? `:${String(mm).padStart(2, '0')}` : ''} ${n < 12 ? 'AM' : 'PM'}`;
}

module.exports = { spokenClock };
