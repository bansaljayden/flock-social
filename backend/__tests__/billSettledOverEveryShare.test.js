// The bill payload says whether it is settled over EVERY share, before the
// per-viewer visibility filter, so a viewer who has blocked a member cannot
// be told "All settled up" while that member still owes. Every share but a
// banned account's: a bill posted before the ban keeps that row as the record
// of what is owed, and a banned account can never sign in to settle it, so
// counting it meant the bill could never read as settled at all.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

test('the bill payload carries fullySettled, settledCount and shareCount over all shares a person can settle', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'billing.js'), 'utf8');
  // Taken from every row the read returned, not from the rows this viewer may see.
  assert.match(src, /const settleable = sharesResult\.rows\.filter\(\(s\) => s\.holder_banned !== true\);/);
  assert.match(src, /\(u\.is_banned IS TRUE\) AS holder_banned FROM bill_split_shares bss/);
  assert.match(src, /fullySettled: settleable\.length > 0 && settleable\.every\(\(s\) => !!s\.settled\),/);
  assert.match(src, /settledCount: settleable\.filter\(\(s\) => !!s\.settled\)\.length,/);
  assert.match(src, /shareCount: settleable\.length,/);
  assert.doesNotMatch(src, /settleable = visibleRows/);
});
