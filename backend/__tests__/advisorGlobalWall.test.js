/**
 * THE GLOBAL ROOST WALL SAYS WHEN IT LIFTS (chat audit, 2026-09-05). It used
 * to share REFUSAL_BUSY with a failed call and promise "another go shortly"
 * for a wall that lifts at the database's next day.
 *
 * HOW TO RUN
 *   cd backend && node --test __tests__/advisorGlobalWall.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ft = require('../services/advisorFreeText');

test('the wall has its own sentinel and its own sentence, and both call sites use them', () => {
  assert.strictEqual(typeof ft.GLOBAL_WALL, 'symbol');
  const text = ft.refusalGlobalWall('in about 6 hours');
  assert.match(text, /^Roost is busy across Flock today\. It comes back in about 6 hours, and the questions above still work in the meantime\.$/);
  assert.ok(!text.includes('\u2014'));
  assert.notStrictEqual(text, ft.REFUSAL_BUSY);
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'advisorFreeText.js'), 'utf8');
  assert.match(src, /if \(!\(await allowGlobalTokens\(estimate\)\)\) \{\n\s+releaseVenueReservation\(userId, \{ tokens: estimate, \.\.\.counterFor\(charge\) \}\);\n\s+return GLOBAL_WALL;/);
  assert.match(src, /if \(raw === GLOBAL_WALL\) \{\n\s+return \{ mode: 'refused', intentId: null, refusal: refusalGlobalWall\(await ceilingResetPhrase\(\)\) \};/);
  assert.match(src, /if \(out === GLOBAL_WALL\) \{\n\s+return \{ mode: 'refusal', text: refusalGlobalWall\(await ceilingResetPhrase\(\)\), sources: \[\] \};/);
  assert.ok(ft.__copyStrings().some((s) => /Roost is busy across Flock today/.test(s)), 'the copy walk sees the wall sentence');
});
