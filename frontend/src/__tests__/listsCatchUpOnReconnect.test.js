// A socket reconnect means a gap during which events were lost for good:
// nothing replays a cancelled plan, a departed member, a new invite or a new
// DM. The open conversation already re-reads itself on reconnect (runCatchUp).
// The plans list and the DM list did not: the recovery effect only refetches a
// list in an error state, so a healthy list that missed events while the
// phone was in a pocket stayed wrong until the next remount. This pins the
// list catch-up: unconditional on the reconnect edge, deferred while hidden,
// flushed on the return.
const fs = require('fs');
const path = require('path');

const app = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8');

function block(startMarker, endMarker) {
  const i = app.indexOf(startMarker);
  expect(i).toBeGreaterThan(-1);
  const j = app.indexOf(endMarker, i);
  expect(j).toBeGreaterThan(i);
  return app.slice(i, j + endMarker.length);
}

test('the lists refetch on every reconnect, not only when they are in error', () => {
  const effect = block('const listsGapPendingRef = useRef(false);', '[reconnectTick, loadFlocks, loadDmConversations]);');
  expect(effect).toMatch(/if \(!reconnectTick\) return;/);
  // no error gate anywhere in this effect
  expect(effect).not.toMatch(/flocksError|dmsError/);
  expect(effect).toMatch(/loadFlocks\(\);\s*loadDmConversations\(\);/);
});

test('a reconnect that lands while hidden is held and flushed on the return', () => {
  const effect = block('const listsGapPendingRef = useRef(false);', '[reconnectTick, loadFlocks, loadDmConversations]);');
  expect(effect).toMatch(/visibilityState === 'hidden'\) \{\s*listsGapPendingRef\.current = true;\s*return;/);
  const flush = block("if (document.visibilityState !== 'visible' || !listsGapPendingRef.current) return;", '[loadFlocks, loadDmConversations]);');
  expect(flush).toMatch(/listsGapPendingRef\.current = false;\s*loadFlocks\(\);\s*loadDmConversations\(\);/);
  expect(flush).toMatch(/addEventListener\('visibilitychange', onVisible\)/);
});

test('the error-recovery effect stays gated, so the two do not double-fetch a healthy list on online or the tick', () => {
  const recover = block('const recoverLists = () => {', '[reconnectTick, flocksError, dmsError, loadFlocks, loadDmConversations]);');
  expect(recover).toMatch(/if \(flocksError\) loadFlocks\(\);/);
  expect(recover).toMatch(/if \(dmsError\) loadDmConversations\(\);/);
});
