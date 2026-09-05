/**
 * AN UNBLOCK IS HEARD LIVE (UGC-loop audit, 2026-09-05). The server emits
 * unblocked_by to both sides; the client clears the thread's block flag and
 * re-reads an open thread with that person.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test unblockLive --watchAll=false
 */
const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

test('the socket module registers the reverse of blocked_by', () => {
  const src = read('services/socket.js');
  expect(src).toMatch(/export function onUnblockedBy\(callback\) \{\s*return register\('unblocked_by', callback\);/);
});

test('App.js clears the block flag and re-reads an open thread on unblocked_by', () => {
  const src = read('App.js');
  expect(src).toMatch(/onBlockedBy, onUnblockedBy, onContentRemoved/);
  const at = src.indexOf('return onUnblockedBy(({ userId }) => {');
  expect(at).toBeGreaterThan(-1);
  const handler = src.slice(at, at + 700);
  expect(handler).toContain('setDmBlocked(prev => {');
  expect(handler).toContain('delete next[String(userId)];');
  expect(handler).toContain('if (String(selectedDmId) === String(userId)) loadDmMessages(userId);');
});
