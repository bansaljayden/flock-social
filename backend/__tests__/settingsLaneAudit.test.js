/**
 * SETTINGS LANE (audit 2026-09-05): a photo can be taken down, and an export
 * slot spent on a failure is handed back.
 *
 * HOW TO RUN
 *   cd backend && node --test __tests__/settingsLaneAudit.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'users.js'), 'utf8');

test('DELETE /profile-image nulls the column and nothing else', () => {
  const at = src.indexOf("router.delete('/profile-image'");
  assert.ok(at > -1, 'no remove route');
  const body = src.slice(at, at + 700);
  assert.match(body, /UPDATE users SET profile_image_url = NULL, updated_at = NOW\(\) WHERE id = \$1/);
  assert.match(body, /\[req\.user\.id\]/);
  assert.match(body, /res\.json\(\{ profile_image_url: null \}\)/);
});

test('an export slot spent before the queries is refunded when the export fails', () => {
  const { exportRequests } = require('../routes/users').__testing;
  assert.strictEqual(typeof exportRequests.forgive, 'function');
  const key = 'settings-lane-' + Date.now();
  for (let i = 0; i < 5; i += 1) exportRequests.record(key);
  assert.ok(exportRequests.lockedFor(key) > 0, 'five records should lock');
  exportRequests.forgive(key);
  assert.strictEqual(exportRequests.lockedFor(key), 0, 'one refund reopens the window');
  exportRequests.clear(key);
  // Forgiving a key that was never recorded is a no-op, not a negative count.
  exportRequests.forgive(key + '-never');
  assert.strictEqual(exportRequests.lockedFor(key + '-never'), 0);
  // And the route only refunds when it had metered.
  assert.match(src, /res\.locals\.exportMetered = true;/);
  assert.match(src, /if \(res\.locals\.exportMetered\) exportRequests\.forgive\(req\.user\.id\);/);
});
