// Three things a share link got wrong for the people it exists for, found
// by tracing the guest path end to end on 2026-09-04.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'guest.js'), 'utf8');
const guest = require('../routes/guest');

test('a table on one wifi can all answer: the per-network identity budget is twelve an hour', () => {
  assert.strictEqual(guest.NEW_GUESTS_PER_IP_PER_FLOCK, 12);
});

test('the same name cannot answer twice on one plan, and the refusal says what to do', () => {
  assert.match(src, /async function nameInUse\(run, flockId, name\)/);
  const fn = src.slice(src.indexOf('async function nameInUse'), src.indexOf('async function nameInUse') + 600);
  assert.match(fn, /COALESCE\(is_hidden, false\) = false/);
  assert.match(fn, /lower\(regexp_replace\(btrim\(name\)/);
  assert.match(src, /const taken = !revoked && await nameInUse\(\(q, p\) => client\.query\(q, p\), link\.flock_id, name\);/);
  assert.match(src, /\} else if \(taken\) \{\s*nameTaken = true;\s*await client\.query\('ROLLBACK'\);/);
  assert.match(src, /error: 'Someone already answered as that name\. Open the link on the device you used, or add a last initial\.',\s*nameTaken: true,/);
});

test('a guest who becomes a member disappears from every open client, not only the database', () => {
  assert.match(src, /UPDATE guest_rsvps SET is_hidden = TRUE\s+WHERE flock_id = \$1 AND guest_token = \$2 AND COALESCE\(is_hidden, false\) = false\s+RETURNING id/);
  assert.match(src, /res\.locals\.hiddenGuestId = hid\.rows\.length \? hid\.rows\[0\]\.id : null;/);
  const emit = src.slice(src.indexOf("if (res.locals.hiddenGuestId != null) {"), src.indexOf("'flock_invite_responded'"));
  assert.match(emit, /emitToFlockMembers\(io, link\.flock_id, 'content_removed', \{\s*contentType: 'guest_rsvp',\s*contentId: res\.locals\.hiddenGuestId,\s*flockId: link\.flock_id,/);
});
