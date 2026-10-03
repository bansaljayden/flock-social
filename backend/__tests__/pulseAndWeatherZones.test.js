// From the availability-pulse and calendar trace of 2026-09-04.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

test('a live pulse carries the face the client reads', () => {
  // Read through utils/ownAvatar: req.user never carries the photo (the auth
  // lookup does not select it), so `req.user.profile_image_url || null`, which
  // this line used to pin, was null on every pulse (backend audit 2026-10-03).
  assert.match(read('routes/availability.js'), /profile_image_url: await ownAvatar\(req\.user\.id\),/);
});

test('no route reads a photo off req.user, which never has one', () => {
  for (const f of ['routes/availability.js', 'routes/flocks.js', 'routes/guest.js']) {
    assert.doesNotMatch(read(f), /req\.user\.profile_image_url/, f);
  }
  assert.doesNotMatch(read('middleware/auth.js'), /SELECT id, email, name, role, email_verified, is_banned, token_version, profile_image_url/,
    'the per-request auth lookup must not carry a base64 photo');
  assert.match(read('utils/ownAvatar.js'), /CASE WHEN LENGTH\(profile_image_url\) > 12000 THEN NULL ELSE profile_image_url END AS url/);
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
