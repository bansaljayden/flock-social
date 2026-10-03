// A venue owner's reply to a review is reported on its own (migration 114).
// Before, the only flag on the card sat on the review and named the reviewer,
// so a complaint about the owner's words landed on the person they answered.
const fs = require('fs');
const path = require('path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const sheet = read('components/overlays/VenueDetailSheet.js');
const app = read('App.js');

test('the owner reply carries its own Report, which names no account', () => {
  const at = sheet.indexOf('aria-label="Report owner reply"');
  expect(at).toBeGreaterThan(-1);
  const button = sheet.slice(at, sheet.indexOf('</button>', at));
  expect(button).toMatch(/setModerationTarget\(\{ userName: 'this venue', contentType: 'venue_reply', contentId: r\.id \}\)/);
  // The server reads the author off the row; the card has no owner id to send.
  expect(button).not.toMatch(/userId:/);
  // It sits inside the reply block, under the review's own flag.
  expect(at).toBeGreaterThan(sheet.indexOf('{r.venue_reply && ('));
});

test('a takedown or restore marks the owner\'s own Reviews tab live', () => {
  expect(app).toMatch(/case 'venue_reply':\s+if \(hidden\) setVenueDetailReviews\(prev => dropReplyById\(prev, ev\.contentId\)\);\s+setVenueReviewsData\(prev => markReplyModeration\(prev, ev\.contentId, hidden\)\);/);
  const start = app.indexOf('const markReplyModeration = ');
  const body = app.slice(start, app.indexOf('\n};', start));
  expect(body).toMatch(/reply_hidden_by_moderation: hidden/);
});

test('a reported or taken-down reply leaves the card and the review stays', () => {
  expect(app).toMatch(/venue_reply: 'venueReviews',/);
  expect(app).toMatch(/case 'venue_reply':\s+if \(hidden\) setVenueDetailReviews\(prev => dropReplyById\(prev, ev\.contentId\)\);/);
  expect(app).toMatch(/if \(ev\.contentType === 'venue_reply'\) setVenueDetailReviews\(prev => dropReplyById\(prev, ev\.contentId\)\);/);
  const start = app.indexOf('const dropReplyById = ');
  const body = app.slice(start, app.indexOf('\n};', start));
  expect(body).toMatch(/return \{ \.\.\.r, venue_reply: null \};/);
  expect(body).not.toMatch(/filter\(/);
});
