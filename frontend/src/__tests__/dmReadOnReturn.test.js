/**
 * A DM THAT LANDED WHILE THE TAB WAS HIDDEN IS READ WHEN THE THREAD IS SEEN.
 *
 * The live DM handler in App.js marks a message read only while its thread is
 * on screen and the document is visible; otherwise it counts it on the row.
 * A web tab hidden for a moment keeps its socket, so a DM landing then was
 * counted and left unread in the database, and coming back put neither right
 * (a socket that missed nothing gets no catch-up read). The Opened effect
 * does re-run on docVisible, so the sender was told it had been seen while
 * the reader's badge still counted it. The flock twin re-runs its read cursor
 * and badge zeroing on docVisible; this pins the DM one.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test dmReadOnReturn --watchAll=false
 */

const fs = require('fs');
const path = require('path');

const APP = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8').replace(/\r\n/g, '\n');

/** Every useEffect in App.js as { body, deps }. */
function effects() {
  return APP.split('useEffect(() => {').slice(1).map((chunk) => {
    const end = chunk.search(/\n {2}\}, \[[^\]]*\]\);/);
    if (end === -1) return null;
    const tail = chunk.slice(end).match(/\[([^\]]*)\]/);
    return { body: chunk.slice(0, end), deps: tail[1] };
  }).filter(Boolean);
}

test('the flock twin re-runs its read cursor and its badge zeroing when the page comes back', () => {
  const flock = effects().filter((e) => /\bdocVisible\b/.test(e.deps) && /\bselectedFlockId\b/.test(e.deps));
  expect(flock.some((e) => /markFlockRead\(/.test(e.body))).toBe(true);
  expect(flock.some((e) => /unread: 0/.test(e.body))).toBe(true);
});

test('an open DM thread does the same on the return: the row is zeroed and the newest from them is marked read', () => {
  const dm = effects().filter((e) => /\bdocVisible\b/.test(e.deps) && /\bselectedDmId\b/.test(e.deps));
  const read = dm.find((e) => /markDmRead\(/.test(e.body));
  expect(read).toBeTruthy();
  expect(read.body).toMatch(/currentScreen !== 'dmDetail'/);
  expect(read.body).toMatch(/unread: 0/);
  expect(read.body).toMatch(/markDmRead\(newestFromOthers\(|const newest = newestFromOthers\(selectedDm\?\.messages\)/);
});
