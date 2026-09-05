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

test('the pinned-venue route tells both sides live, IN A SHAPE THE CLIENT READS', () => {
  /* THIS TEST USED TO PIN THE BUG. It asserted the emit was
     `{ userId: req.user.id, venue }`, which told both sides and reached
     neither: sockets/handlers.js emits the fields FLAT beside `withUserId`,
     and App.js's listener gates on `data.withUserId` and then reads
     `data.venue_name`. Against the nested payload that gate saw undefined,
     returned early, and dropped the update. So the route announced into the
     void, on the transport that exists precisely for when the socket is down.

     "Tells both sides live" was the property the test meant to hold, and the
     shape is what makes it true, so the shape is what is asserted now. The
     per-recipient `withUserId` is checked in both directions because one
     shared payload would send each person their own id and both gates would
     miss. __tests__/dmUnpinVenue.test.js drives the routes and asserts the
     same thing on the emitted objects rather than on the source. */
  const src = read('routes/messages.js');
  const put = src.slice(src.indexOf("router.put('/dm/:userId/pinned-venue'"), src.indexOf("router.put('/dm/:userId/pinned-venue'") + 4000);
  assert.match(put, /emit\('dm_venue_pinned', \{ \.\.\.venue, withUserId: req\.user\.id \}\)/);
  assert.match(put, /emit\('dm_venue_pinned', \{ \.\.\.venue, withUserId: otherUserId \}\)/);
  assert.ok(!/\{ userId: req\.user\.id, venue \}/.test(put),
    'the nested shape is what nothing parsed');
});

test('a pinned venue can be UNPINNED, and the clear rides the same event', () => {
  /* dm_pinned_venues UPSERTS on the pair, so a pin could be replaced forever
     and never cleared. DmDetail withheld PinStrip's Unpin callback for exactly
     the right reason, that "there is no unpin anywhere in this product", which
     described a one-way door rather than a decision about pins. */
  const src = read('routes/messages.js');
  const del = src.slice(src.indexOf("router.delete('/dm/:userId/pinned-venue'"));
  assert.ok(del.length > 0, 'the unpin route exists');
  assert.match(del, /DELETE FROM dm_pinned_venues WHERE user1_id = \$1 AND user2_id = \$2/);
  assert.ok(!/pinned_by/.test(del.slice(0, del.indexOf('res.json'))),
    'anyone in the pair may unpin, not only whoever pinned it');
  // The same event with a null name, so the listener needs one branch rather
  // than a second event name every consumer has to learn.
  assert.match(del, /emit\('dm_venue_pinned', \{ venue_name: null, withUserId: req\.user\.id \}\)/);
  assert.match(del, /emit\('dm_venue_pinned', \{ venue_name: null, withUserId: otherUserId \}\)/);
});

test('a failed or unreplyable DM send says so over the socket', () => {
  const src = read('sockets/handlers.js');
  assert.match(src, /console\.error\('send_dm error:', err\);\s*[\s\S]*?socket\.emit\('error', \{ message: 'Failed to send message' \}\);/);
  assert.match(src, /socket\.emit\('error', \{ message: 'That message is no longer there to reply to\.' \}\);/);
});
