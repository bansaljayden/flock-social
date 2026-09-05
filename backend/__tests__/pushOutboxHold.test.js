// From the push-lifecycle trace of 2026-09-04. Source contracts on the
// outbox and the revoke path.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

test('a quiet-hour hold is one row per conversation, with the newest words', () => {
  const src = read('services/pushHelper.js');
  const enq = src.slice(src.indexOf('async function enqueue('), src.indexOf('startOutboxSweep();', src.indexOf('async function enqueue(')));
  assert.match(enq, /if \(reason === 'quiet'\) \{/);
  assert.match(enq, /UPDATE push_outbox\s+SET title = \$3, body = \$4, data = \$5::jsonb,\s+expires_at = GREATEST\(expires_at, \$6\)/);
  assert.match(enq, /WHERE user_id = \$1 AND reason = 'quiet'/);
  assert.match(enq, /if \(merged && merged\.rowCount > 0\) return true;/);
});

test('a retry that meets the night is moved to morning, not expired inside it', () => {
  const src = read('services/pushHelper.js');
  assert.match(src, /return \{ skipped: true, reason: OUTCOME\.QUIET_HELD, requeue: true, releaseAt: quietWindowEnd\(zone\) \|\| null \};/);
  assert.match(src, /SET next_attempt_at = \$2,\s+reason = 'quiet',\s+expires_at = GREATEST\(expires_at, \$2 \+ INTERVAL '1 hour'\)/);
});

test('revoking sessions also revokes the device rows', () => {
  const src = read('middleware/auth.js');
  const fn = src.slice(src.indexOf('function revokeUserSessions(io, userId) {'), src.indexOf('function revokeUserSessions(io, userId) {') + 1200);
  assert.match(fn, /pool\.query\('DELETE FROM device_tokens WHERE user_id = \$1', \[userId\]\)/);
  // still a socket cut, still fire-and-forget on the delete
  assert.match(fn, /disconnectSockets\(true\)/);
});
