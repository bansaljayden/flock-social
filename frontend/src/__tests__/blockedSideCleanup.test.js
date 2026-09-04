// When A blocks B, the server tells B too (blocked_by), but the client only
// closed B's DM thread. B kept A's pending request (Accept answered "no
// pending request"), A's DM row, pulse and roster seat until a reload. The
// blocker's own cleanup runs for the blocked side now, and it also drops the
// two contact-discovery lists and the status pill it used to leave behind.
const fs = require('fs');
const path = require('path');

const app = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8');

test('the blocked side runs the same cleanup the blocker does', () => {
  const effect = app.slice(app.indexOf('return onBlockedBy(({ userId }) => {'), app.indexOf('}, [dmSharingLocation, handleUserBlocked]);'));
  expect(effect).toMatch(/handleUserBlocked\(userId\);/);
});

test('the cleanup covers contact rows and the status pill', () => {
  const fn = app.slice(app.indexOf('const handleUserBlocked = useCallback((blockedId) => {'), app.indexOf('const openUserProfile = useCallback'));
  expect(fn).toMatch(/setConnectResults\(prev => prev\.filter/);
  if (app.includes('setContactsUsers(')) expect(fn).toMatch(/setContactsUsers\(prev =>/);
  if (app.includes('setPhoneLookupUsers(')) expect(fn).toMatch(/setPhoneLookupUsers\(prev =>/);
  if (/const \[friendStatuses, setFriendStatuses\] = useState\(\{\}\)/.test(app)) expect(fn).toMatch(/setFriendStatuses\(prev =>/);
});
