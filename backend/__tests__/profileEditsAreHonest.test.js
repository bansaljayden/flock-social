// From the account-settings trace of 2026-09-04. Source contracts.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'users.js'), 'utf8');

test('a wrong current password is a wrong password, not a dead session', () => {
  assert.match(src, /res\.status\(401\)\.json\(\{ error: 'Current password is incorrect', reauthRequired: 'password' \}\)/);
});

test('an explicit null clears the phone, its digest and the discovery switch together', () => {
  assert.match(src, /const clearPhone = req\.body\.phone === null && Boolean\(user\.phone\);/);
  assert.match(src, /'UPDATE users SET phone = NULL, phone_hash = NULL, phone_discoverable = FALSE, updated_at = NOW\(\) WHERE id = \$1'/);
  // and the profile UPDATE's own text is untouched, because two fixtures
  // interpret it clause by clause
  assert.match(src, /phone = COALESCE\(\$3, phone\),/);
});

test('the one support address the app names is the one every page names', () => {
  assert.ok(!/hello@flockcorp\.com/.test(src), 'routes/users.js still names hello@');
});
