/**
 * THE TYPE SCALE REACHES THE SHEETS AND CARDS (2026-11-07).
 *
 * The audit counted raw pixel font sizes that bypassed the six --t-* roles:
 * PaywallSheet 16, ModerationSheet 12, PollCard 10, BillCard 10, and a tail
 * in the other chat cards. They read the roles now. What may stay literal:
 *   - 16px on a text field, the iOS focus-zoom floor (iosFocusZoomFontFloor);
 *   - 12px on the Google Maps credit, Google's own floor for its mark, which
 *     googlePhotoCredit and staticMapUrl read off the element;
 *   - the chat thread's measured 9 and 10px geometry (reaction count, time
 *     slot, a 22px avatar's initial) in MessageRow and TypingRow.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test typeScaleSheets --watchAll=false
 */
const fs = require('fs');
const path = require('path');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const raw = (src) => [...src.matchAll(/fontSize: *('[0-9.]+px'|\d+)/g)].map((m) => m[1]);

test.each([
  ['components', 'PaywallSheet.js'],
  ['components', 'chat', 'cards', 'PollCard.js'],
  ['components', 'chat', 'cards', 'BillCard.js'],
  ['components', 'chat', 'cards', 'LocationCard.js'],
  ['components', 'chat', 'cards', 'WhoIsHereCard.js'],
  ['components', 'chat', 'cards', 'VenueCardRow.js'],
  ['components', 'chat', 'cards', 'NudgeRow.js'],
  ['components', 'ErrorBoundary.js'],
])('%s/%s writes every size as a --t-* role', (...p) => {
  expect(raw(read(...p))).toEqual([]);
});

test('the report sheet keeps one literal, the 16px floor on its details box', () => {
  const src = read('components', 'ModerationSheet.js');
  expect(raw(src)).toEqual(["'16px'"]);
  expect(src).toMatch(/<textarea value=\{details\}.*fontSize: '16px'/);
});
