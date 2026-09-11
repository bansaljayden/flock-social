/**
 * A position belongs to a flock, and a flock's chat counts only its own.
 *
 * The client keeps one map of member positions for the whole session (the
 * Discover map draws everyone sharing with you, which is the point of it),
 * and location_update carried no flock, so a member of two flocks saw the
 * people sharing in one of them counted as "here" and "sharing" in the
 * other's chat. The server now names the flock on every position, the
 * client keeps it on the entry, ChatDetail filters on it, and a stop in one
 * flock cannot clear a position that belongs to another.
 */
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..', '..');
const read = (...p) => fs.readFileSync(path.join(REPO, ...p), 'utf8');

const handlers = read('backend', 'sockets', 'handlers.js');
const app = read('frontend', 'src', 'App.js');
const chat = read('frontend', 'src', 'screens', 'ChatDetail.js');

test('the server names the flock on every position it fans out', () => {
  expect(handlers).toMatch(/const payload = \{ userId: user\.id, name: user\.name, lat, lng, flockId, timestamp: Date\.now\(\) \};/);
});

test('the client keeps the flock on the entry and a stop clears only its own flock', () => {
  const listener = app.slice(app.indexOf('const unsubLocation = onLocationUpdate('), app.indexOf('return () => { unsubLocation(); unsubStopped(); };'));
  expect(listener).toMatch(/timestamp: data\.timestamp, flockId: data\.flockId \}/);
  expect(listener).toMatch(/String\(current\.flockId\) !== String\(data\.flockId\)\) return prev;/);
});

test('the chat counts this flock only, in the card and on the sharing bar', () => {
  const card = chat.slice(chat.indexOf('const whoIsHere = (() => {'), chat.indexOf('const pinnedForBar'));
  expect(card).toMatch(/if \(loc\.flockId != null && String\(loc\.flockId\) !== String\(flock\.id\)\) continue;/);
  expect(card).toMatch(/const sharingHere = Object\.entries\(flockMemberLocations \|\| \{\}\)\.filter/);
  expect(card).toMatch(/String\(uid\) !== String\(authUser\?\.id\)/);
  expect(chat).toMatch(/\{sharingHere > 0 && \(/);
  expect(chat).toMatch(/\{sharingHere\} sharing<\/span>/);
  // The old, unscoped figure is gone from the bar.
  expect(chat).not.toMatch(/Object\.keys\(flockMemberLocations\)\.length\} sharing/);
});
