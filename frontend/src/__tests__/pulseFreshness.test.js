// A pulse that has ended is not "Available tonight", and the list is
// re-read when the sheet opens rather than trusted from mount.
const fs = require('fs');
const path = require('path');

const app = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8');

test('expired pulses are filtered out of the invite sheet', () => {
  const memo = app.slice(app.indexOf('const flockInvitePulses = useMemo(() => {'), app.indexOf('[friendsPulses, flockInviteMemberIds, flockInviteSelected]);'));
  expect(memo).toMatch(/\(!p\.expires_at \|\| new Date\(p\.expires_at\)\.getTime\(\) > nowMs\)/);
});

test('opening the invite sheet re-reads the pulses', () => {
  expect(app).toMatch(/loadFlockInviteFriends\(\);\s*[\s\S]{0,400}?refreshFriendsPulses\(\);/);
});
