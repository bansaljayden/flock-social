// The bill payload says whether it is settled over EVERY share, before the
// per-viewer visibility filter, so a viewer who has blocked a member cannot
// be told "All settled up" while that member still owes.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

test('the bill payload carries fullySettled, settledCount and shareCount over all shares', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'billing.js'), 'utf8');
  assert.match(src, /fullySettled: sharesResult\.rows\.length > 0 && sharesResult\.rows\.every\(\(s\) => !!s\.settled\),/);
  assert.match(src, /settledCount: sharesResult\.rows\.filter\(\(s\) => !!s\.settled\)\.length,/);
  assert.match(src, /shareCount: sharesResult\.rows\.length,/);
});
