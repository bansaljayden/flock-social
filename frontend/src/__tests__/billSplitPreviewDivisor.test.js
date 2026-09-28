// The bill-split preview and the bill the server creates one tap later have
// to agree, or "~$18.50 each" turns into "$24.67 each" the moment the bill
// exists.
//
// The server splits equally across the accepted members whose account is not
// banned (POST /create in backend/routes/billing.js): accounts only, guests
// excluded, a banned member left out, a blocked member still billed. The
// preview used to divide by flock.members.length, which refreshFlockRoster
// strips blocked members out of, falling back to memberCount, which is
// going_count and INCLUDES guests. Both are wrong in different directions.
// Then it divided by member_count, the headcount, which still counts a banned
// member, so a four-member flock with one banned previewed "~$30.00 each" on a
// $120 bill posted at $40.00. billableCount is the server's billable_count,
// /create's roster counted, carried through every loader and the roster
// refresh, and it is the only number the preview may divide by.
// backend/__tests__/budgetBillIntegrity.test.js posts the bill and checks the
// two agree on a real database.
const fs = require('fs');
const path = require('path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const backend = (p) => fs.readFileSync(path.join(__dirname, '..', '..', '..', 'backend', p), 'utf8');

test('every flock loader carries the server billable_count as billableCount', () => {
  const app = read('App.js');
  const loaders = app.match(/memberCount: f\.going_count \?\? f\.member_count \?\? 1,/g) || [];
  expect(loaders.length).toBe(3);
  const billable = app.match(/billableCount: f\.billable_count \?\? f\.member_count \?\? null,/g) || [];
  expect(billable.length).toBe(3);
  // member_count first would put the banned member back in the divisor.
  expect(app).not.toMatch(/billableCount: f\.member_count \?\?/);
});

test('the roster refresh divides by the count the server divides by', () => {
  const app = read('App.js');
  // `accepted.length` was NOT the pre-strip count, which is what this test used
  // to assert and what the comment beside it claimed. GET /api/flocks/:id
  // returns `members: visibleMembers`, already block-filtered on the server, so
  // `accepted` is the POST-strip list: the preview was short by every blocked
  // member and quoted a share the server would not create.
  expect(app).toMatch(/billableCount: data\.flock\?\.billable_count \?\? data\.flock\?\.member_count \?\? accepted\.length,/);
  expect(app).not.toMatch(/billableCount: accepted\.length,/);
  expect(app).not.toMatch(/billableCount: data\.flock\?\.member_count \?\?/);
  // The same mistake made `hidden` zero, so the headcount stopped coming down
  // with the faces. It is measured against the server's headcount, which is
  // member_count and not the divisor.
  expect(app).toMatch(/const hidden = Math\.max\(0, \(data\.flock\?\.member_count \?\? accepted\.length\) - members\.length\);/);
});

test('both reads send billable_count, counted on the roster /create splits across', () => {
  const flocks = backend('routes/flocks.js');
  const billing = backend('routes/billing.js');
  // /create's roster: accepted, and the account not banned.
  expect(billing).toMatch(/SELECT u\.id, u\.name FROM flock_members fm\s+JOIN users u ON u\.id = fm\.user_id AND u\.is_banned IS NOT TRUE\s+WHERE fm\.flock_id = \$1 AND fm\.status = 'accepted'/);
  // The count the reads send, with the same two conditions and no block
  // predicate, since a blocked member is still billed.
  const count = flocks.match(/const billableCountOf = \(flockIdCol\) => `([\s\S]*?)`;/);
  expect(count).not.toBeNull();
  expect(count[1]).toMatch(/JOIN users bu ON bu\.id = bfm\.user_id AND bu\.is_banned IS NOT TRUE/);
  expect(count[1]).toMatch(/bfm\.status = 'accepted'/);
  expect(count[1]).not.toMatch(/user_blocks/);
  // On the list (inside its lateral, read out as c.billable_count) and on the
  // plan read.
  expect(flocks).toMatch(/\$\{billableCountOf\('f\.id'\)\} AS billable_count\s*\) c ON TRUE/);
  expect(flocks).toMatch(/c\.billable_count,/);
  expect(flocks).toMatch(/\$\{billableCountOf\('f\.id'\)\} AS billable_count\s+FROM flocks f\s+JOIN users u ON u\.id = f\.creator_id\s+WHERE f\.id = \$1`/);
});

test('the bill-split preview divides by billableCount first', () => {
  const chat = read('screens/ChatDetail.js');
  expect(chat).toMatch(/Math\.max\(1, flock\.billableCount \?\? \(flock\.members\?\.length \|\| flock\.memberCount \|\| 1\)\)/);
  expect(chat).not.toMatch(/Math\.max\(1, flock\.members\?\.length \|\| flock\.memberCount \|\| 1\)/);
});
