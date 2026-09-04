// The bill-split preview and the bill the server creates one tap later have
// to agree, or "~$18.50 each" turns into "$24.67 each" the moment the bill
// exists.
//
// The server splits equally across flock_members WHERE status = 'accepted'
// (backend/routes/billing.js): accounts only, guests excluded, a blocked member
// still billed. The preview used to divide by flock.members.length, which
// refreshFlockRoster strips blocked members out of, falling back to
// memberCount, which is going_count and INCLUDES guests. Both are wrong in
// different directions. billableCount is the server's own member_count,
// carried through every loader and the roster refresh, and it is the only
// number the preview may divide by.
const fs = require('fs');
const path = require('path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

test('every flock loader carries the server member_count as billableCount', () => {
  const app = read('App.js');
  const loaders = app.match(/memberCount: f\.going_count \?\? f\.member_count \?\? 1,/g) || [];
  expect(loaders.length).toBe(3);
  const billable = app.match(/billableCount: f\.member_count \?\? null,/g) || [];
  expect(billable.length).toBe(3);
});

test('the roster refresh divides by the count the server divides by', () => {
  const app = read('App.js');
  // `accepted.length` was NOT the pre-strip count, which is what this test used
  // to assert and what the comment beside it claimed. GET /api/flocks/:id
  // returns `members: visibleMembers`, already block-filtered on the server, so
  // `accepted` is the POST-strip list: the preview was short by every blocked
  // member and quoted a share the server would not create.
  expect(app).toMatch(/billableCount: data\.flock\?\.member_count \?\? accepted\.length,/);
  expect(app).not.toMatch(/billableCount: accepted\.length,/);
  // The same mistake made `hidden` zero, so the headcount stopped coming down
  // with the faces. It is measured against the server's count now.
  expect(app).toMatch(/const hidden = Math\.max\(0, \(data\.flock\?\.member_count \?\? accepted\.length\) - members\.length\);/);
});

test('the bill-split preview divides by billableCount first', () => {
  const chat = read('screens/ChatDetail.js');
  expect(chat).toMatch(/Math\.max\(1, flock\.billableCount \?\? \(flock\.members\?\.length \|\| flock\.memberCount \|\| 1\)\)/);
  expect(chat).not.toMatch(/Math\.max\(1, flock\.members\?\.length \|\| flock\.memberCount \|\| 1\)/);
});
