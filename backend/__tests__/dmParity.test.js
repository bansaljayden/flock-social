// Where the DM side silently lacked what the flock side had, found by a
// feature-by-feature comparison on 2026-09-04. Source contracts.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

test('both DM reaction routes tell both sides live, as the socket path does', () => {
  const src = read('routes/messages.js');
  const add = src.slice(src.indexOf("router.post('/dm/messages/:id/react'"), src.indexOf("router.delete('/dm/messages/:id/react/:emoji'"));
  assert.match(add, /io\.to\(`user:\$\{counterpart\}`\)\.emit\('dm_reaction_added', payload\);/);
  assert.match(add, /io\.to\(`user:\$\{req\.user\.id\}`\)\.emit\('dm_reaction_added', payload\);/);
  const del = src.slice(src.indexOf("router.delete('/dm/messages/:id/react/:emoji'"), src.indexOf("router.get('/dm/:userId/venue-votes'"));
  assert.match(del, /let counterpart = null;/);
  assert.match(del, /emit\('dm_reaction_removed', payload\)/);
});

test('opening a DM resyncs the app badge, as opening a flock chat does', () => {
  const src = read('routes/messages.js');
  const get = src.slice(src.indexOf("WHERE sender_id = $1 AND receiver_id = $2 AND read_status = FALSE"), src.indexOf("WHERE sender_id = $1 AND receiver_id = $2 AND read_status = FALSE") + 800);
  assert.match(get, /res\.json\(\{ messages: messages\.reverse\(\) \}\);\s*[\s\S]*?pushBadgeSync\(req\.user\.id\)\.catch\(\(\) => \{\}\);/);
});

test('the pinned-venue route tells both sides live', () => {
  const src = read('routes/messages.js');
  const put = src.slice(src.indexOf("router.put('/dm/:userId/pinned-venue'"), src.indexOf("router.put('/dm/:userId/pinned-venue'") + 4000);
  assert.match(put, /emit\('dm_venue_pinned', \{ userId: req\.user\.id, venue \}\)/);
});

test('a failed or unreplyable DM send says so over the socket', () => {
  const src = read('sockets/handlers.js');
  assert.match(src, /console\.error\('send_dm error:', err\);\s*[\s\S]*?socket\.emit\('error', \{ message: 'Failed to send message' \}\);/);
  assert.match(src, /socket\.emit\('error', \{ message: 'That message is no longer there to reply to\.' \}\);/);
});
