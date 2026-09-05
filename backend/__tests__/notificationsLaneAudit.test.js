/**
 * NOTIFICATIONS LANE (audit 2026-09-05): an attended device gets no banner,
 * a browser's sign-out cannot delete the phone's token, a quiet hold does not
 * keep the debounce, and a retry row that waits for morning becomes a quiet
 * row so the merge finds it.
 *
 * HOW TO RUN
 *   cd backend && node --test __tests__/notificationsLaneAudit.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

test('the attentive set is handed to the send and only unattended tokens are pushed', () => {
  const helper = read('services/pushHelper.js');
  const fb = read('services/firebaseService.js');
  assert.match(helper, /const skipTokens = opts\.io \? attentiveTokens\(opts\.io, userId\) : null;/);
  assert.match(helper, /sendPushToUser\(userId, title, body, payload, \{ skipTokens \}\)/);
  assert.match(helper, /return deliver\(userId, title, body, data, \{ io \}\);/);
  assert.match(helper, /const result = await deliver\(userId, title, body, data, \{ io \}\);/);
  assert.match(helper, /attendedOnly \? OUTCOME\.ONLINE : OUTCOME\.NO_DEVICE/);
  // pushAlways has no socket server and stays as it was.
  const always = helper.slice(helper.indexOf('async function pushAlways('));
  assert.match(always.slice(0, 400), /return deliver\(userId, title, body, data\);/);
  assert.match(fb, /async function sendToUserDevices\(userId, perToken, opts = \{\}\)/);
  assert.match(fb, /const rows = skip \? result\.rows\.filter\(\(row\) => !skip\.has\(row\.token\)\) : result\.rows;/);
  assert.match(fb, /if \(rows\.length === 0\) return \{ sent: 0, failed: 0, attended \};/);
  assert.match(fb, /return attended > 0 \? \{ sent, failed, attended \} : \{ sent, failed \};/);
});

test('unregister-all is scoped to the caller\'s kind of device when it says which', () => {
  const src = read('routes/notifications.js');
  assert.match(src, /const kind = \['web', 'ios', 'android'\]\.includes\(req\.query\.deviceType\) \? req\.query\.deviceType : null;/);
  assert.match(src, /'DELETE FROM device_tokens WHERE user_id = \$1 AND \(\$2::text IS NULL OR device_type = \$2\)'/);
});

test('a quiet hold releases the debounce, and a retry row that waits for morning becomes quiet', () => {
  const helper = read('services/pushHelper.js');
  assert.match(helper, /const nothingSent = !result \|\| result\.skipped \|\| \(result\.sent === 0\);/);
  assert.ok(!/result\.skipped && !held/.test(helper), 'the hold no longer keeps the claim');
  assert.match(helper, /SET next_attempt_at = \$2,\n\s+reason = 'quiet',/);
});
