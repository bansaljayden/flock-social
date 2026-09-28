// A socket reconnect means a gap during which events were lost for good:
// nothing replays a cancelled plan, a departed member, a new invite or a new
// DM. The open conversation already re-reads itself on reconnect (runCatchUp).
// The plans list and the DM list did not: the recovery effect only refetches a
// list in an error state, so a healthy list that missed events while the
// phone was in a pocket stayed wrong until the next remount. This pins the
// list catch-up: unconditional on the reconnect edge, deferred while hidden,
// flushed on the return, and held to the same minimum gap as the open
// conversation's catch-up so an app switch or a flapping socket does not read
// the pair over and over.
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
  const effect = block('if (reconnectTick) readListsForGap();', '[reconnectTick, readListsForGap]);');
  expect(effect).toMatch(/^if \(reconnectTick\) readListsForGap\(\);\s*\}, \[reconnectTick, readListsForGap\]\);$/);
  // no error gate anywhere in the reader the tick calls
  const reader = block('const readListsForGap = useCallback(', '[loadFlocks, loadDmConversations]);');
  expect(reader).not.toMatch(/flocksError|dmsError/);
  expect(reader).toMatch(/loadFlocks\(\);\s*loadDmConversations\(\);/);
});

test('a reconnect that lands while hidden is held and flushed on the return', () => {
  const reader = block('const readListsForGap = useCallback(', '[loadFlocks, loadDmConversations]);');
  expect(reader).toMatch(/visibilityState === 'hidden'\) \{\s*listsGapPendingRef\.current = true;\s*return;/);
  // The flush also runs on any return with the socket gone, which the return
  // itself is a gap for (foregroundCatchUp.test.js runs it).
  const flush = block("if (!getSocket()?.connected) readListsForGap({ force: true });", '[readListsForGap]);');
  expect(flush).toMatch(/else if \(listsGapPendingRef\.current\) readListsForGap\(\);/);
  expect(flush).toMatch(/addEventListener\('visibilitychange', onVisible\)/);
});

test('the list gap read keeps the conversation catch-up\'s minimum gap, deferred and never dropped', () => {
  // foregroundCatchUp.test.js runs this; here the shape is pinned so the
  // reader cannot quietly lose its throttle or its trailing read.
  const reader = block('const readListsForGap = useCallback(', '[loadFlocks, loadDmConversations]);');
  expect(reader).toMatch(/force \? 0 : CATCHUP_MIN_GAP_MS - \(Date\.now\(\) - listsGapReadAtRef\.current\)/);
  expect(reader).toMatch(/listsGapTimerRef\.current = setTimeout\(/);
  expect(reader).toMatch(/readListsForGapRef\.current\?\.\(\);/);
});

test('the error-recovery effect stays gated, so the two do not double-fetch a healthy list on online or the tick', () => {
  const recover = block('const recoverLists = () => {', '[reconnectTick, flocksError, dmsError, loadFlocks, loadDmConversations]);');
  expect(recover).toMatch(/if \(flocksError\) loadFlocks\(\);/);
  expect(recover).toMatch(/if \(dmsError\) loadDmConversations\(\);/);
});
