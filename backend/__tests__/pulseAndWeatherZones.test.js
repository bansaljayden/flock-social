// From the availability-pulse and calendar trace of 2026-09-04.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

test('a live pulse carries the face the client reads', () => {
  assert.match(read('routes/availability.js'), /profile_image_url: req\.user\.profile_image_url \|\| null,/);
});

test('an online recipient does not spend their pulse window on a push that never went', () => {
  const src = read('routes/availability.js');
  assert.match(src, /const nothingSent = !result \|\| result\.skipped \|\| result\.sent === 0;\s*if \(nothingSent && lastPulsePushByRecipient\.get\(id\) === now\) lastPulsePushByRecipient\.delete\(id\);/);
});

test('the forecast strip keys days and midday on the city zone, not UTC', () => {
  const src = read('services/weatherService.js');
  assert.match(src, /const tzOffsetSec = Number\.isFinite\(data\.city\?\.timezone\) \? data\.city\.timezone : 0;/);
  assert.match(src, /const local = new Date\(\(entry2\.dt \+ tzOffsetSec\) \* 1000\);/);
  assert.match(src, /hour = local\.getUTCHours\(\);/);
});
