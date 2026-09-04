// When A blocks B, the server tells B too (blocked_by), but the client only
// closed B's DM thread. B kept A's pending request (Accept answered "no
// pending request"), A's DM row, pulse and roster seat until a reload. The
// blocker's own cleanup runs for the blocked side now, and it also drops the
// two contact-discovery lists and the status pill it used to leave behind.
//
// With one difference, which is the third test here. The cleanup deletes the
// DM row and pushes you to the home screen, which is what somebody who just
// tapped Block wants and the opposite of what the person on the other end
// needs: their open conversation vanished and no screen said why. The blocked
// side keeps the row, emptied, so the standing "You can no longer message"
// panel has something to render against.
const fs = require('fs');
const path = require('path');

const app = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8');

test('the blocked side runs the same cleanup the blocker does', () => {
  const effect = app.slice(app.indexOf('return onBlockedBy(({ userId }) => {'), app.indexOf('}, [dmSharingLocation, handleUserBlocked]);'));
  expect(effect).toMatch(/handleUserBlocked\(userId, \{ keepDmOpen: true \}\);/);
});

test('the cleanup covers contact rows and the status pill', () => {
  const fn = app.slice(app.indexOf('const handleUserBlocked = useCallback((blockedId, { keepDmOpen = false } = {}) => {'), app.indexOf('const openUserProfile = useCallback'));
  expect(fn).toMatch(/setConnectResults\(prev => prev\.filter/);
  if (app.includes('setContactsUsers(')) expect(fn).toMatch(/setContactsUsers\(prev =>/);
  if (app.includes('setPhoneLookupUsers(')) expect(fn).toMatch(/setPhoneLookupUsers\(prev =>/);
  if (/const \[friendStatuses, setFriendStatuses\] = useState\(\{\}\)/.test(app)) expect(fn).toMatch(/setFriendStatuses\(prev =>/);
});

test('being blocked keeps the open thread on screen instead of emptying the app around it', () => {
  const fn = app.slice(app.indexOf('const handleUserBlocked = useCallback((blockedId, { keepDmOpen = false } = {}) => {'), app.indexOf('const openUserProfile = useCallback'));
  // The kept row is emptied the way the HTTP read empties it, so a live block
  // and a reopened thread show the same screen.
  expect(fn).toMatch(/if \(keepDmOpen && String\(selectedDmId\) === id\) \{/);
  expect(fn).toMatch(/\{ \.\.\.d, messages: \[\], unread: 0 \}/);
  // And the blocker still leaves, because they asked to.
  expect(fn).toMatch(/setDirectMessages\(prev => prev\.filter\(d => String\(d\.userId\) !== id\)\);/);
  expect(fn).toMatch(/setSelectedDmId\(null\);/);
});
