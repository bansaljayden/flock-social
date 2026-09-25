// A guest answering live used to set memberCount to the server's raw going
// count, while both REST loaders subtract the members this person has
// blocked. One RSVP re-inflated the count by that many until the next load.
const fs = require('fs');
const path = require('path');

const app = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8');

test('the roster loader keeps the hidden count on the flock and the live guest count subtracts it', () => {
  expect(app).toMatch(/\{ \.\.\.f, members, guests, hiddenAccepted, memberCount: Math\.max\(0, \(data\.momentum\?\.accepted \?\? acceptedCount\) - hiddenAccepted\)/);
  expect(app).toMatch(/return \{ \.\.\.f, guests, memberCount: Math\.max\(0, Number\(data\.going\) - \(f\.hiddenAccepted \|\| 0\)\) \};/);
  expect(app).not.toMatch(/memberCount: data\.going \}/);
});

// The plan screen's loader took its hidden count from `members` twice over:
// GET /api/flocks/:id already strips blocked members from `members`, so the
// accepted count it subtracted the faces from was the post-strip list, the
// subtraction came to 0, and the plan heading said one more going than the
// chat's loader (refreshFlockRoster, which measures against the server's
// unfiltered member_count) put on the list card. Both now measure the same
// way, and both keep the result for the live guest count above.
test('the plan screen and the chat measure the hidden count against the server\'s member_count', () => {
  expect(app).toMatch(/const hiddenAccepted = Math\.max\(0, \(data\.flock\?\.member_count \?\? acceptedCount\) - members\.filter\(m => m\.status === 'accepted'\)\.length\);/);
  expect(app).toMatch(/const hidden = Math\.max\(0, \(data\.flock\?\.member_count \?\? accepted\.length\) - members\.length\);/);
  expect(app).toMatch(/hiddenAccepted: hidden,/);
});

test('given the same response, the two loaders put the same number on the card', () => {
  // What GET /api/flocks/:id sends a viewer who has blocked one of four
  // accepted members, on a plan one guest is also going to: the blocked
  // member is already gone from `members`, member_count still counts them,
  // and momentum.accepted is members plus guests.
  const data = {
    flock: { member_count: 4 },
    momentum: { accepted: 5 },
    members: [
      { id: 1, status: 'accepted' }, { id: 2, status: 'accepted' }, { id: 3, status: 'accepted' },
    ],
  };
  // Lifted from the source, so the arithmetic under test is the arithmetic
  // that ships.
  const detailHidden = app.match(/const hiddenAccepted = (Math\.max\(0, \(data\.flock\?\.member_count \?\? acceptedCount\) - members\.filter\(m => m\.status === 'accepted'\)\.length\));/)[1];
  const detailCount = app.match(/hiddenAccepted, memberCount: (Math\.max\(0, \(data\.momentum\?\.accepted \?\? acceptedCount\) - hiddenAccepted\))/)[1];
  const chatHidden = app.match(/const hidden = (Math\.max\(0, \(data\.flock\?\.member_count \?\? accepted\.length\) - members\.length\));/)[1];
  const chatCount = app.match(/memberCount: (Math\.max\(0, \(data\.momentum\?\.accepted \?\? accepted\.length\) - hidden\)),/)[1];

  const members = data.members;
  const acceptedCount = members.filter((m) => m.status === 'accepted').length;
  // eslint-disable-next-line no-new-func
  const hiddenAccepted = new Function('data', 'members', 'acceptedCount', `return ${detailHidden};`)(data, members, acceptedCount);
  // eslint-disable-next-line no-new-func
  const planHeading = new Function('data', 'acceptedCount', 'hiddenAccepted', `return ${detailCount};`)(data, acceptedCount, hiddenAccepted);
  // eslint-disable-next-line no-new-func
  const hidden = new Function('data', 'members', 'accepted', `return ${chatHidden};`)(data, members, members);
  // eslint-disable-next-line no-new-func
  const listCard = new Function('data', 'accepted', 'hidden', `return ${chatCount};`)(data, members, hidden);

  expect(hiddenAccepted).toBe(1);
  expect(hidden).toBe(1);
  expect(planHeading).toBe(4);
  expect(listCard).toBe(4);
});
