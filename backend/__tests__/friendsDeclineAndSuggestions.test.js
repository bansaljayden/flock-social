// Two more from the friends trace of 2026-09-04. Source contracts.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'friends.js'), 'utf8');

test('a decline keeps its row, so the next request cannot insert fresh and push again', () => {
  const decline = src.slice(src.indexOf("router.post('/decline'"), src.indexOf("router.delete('/:userId'"));
  assert.match(decline, /UPDATE friendships SET status = 'declined'\s+WHERE requester_id = \$1 AND addressee_id = \$2 AND status = 'pending'/);
  assert.doesNotMatch(decline, /DELETE FROM friendships/);
});

test('the declined requester cannot remove the record to start over', () => {
  const remove = src.slice(src.indexOf("router.delete('/:userId'"), src.indexOf("router.get('/outgoing'"));
  assert.match(remove, /AND NOT \(status = 'declined' AND requester_id = \$1\)/);
});

test('reviving a declined request never pushes', () => {
  const request = src.slice(src.indexOf("router.post('/request'"), src.indexOf("router.post('/accept'"));
  const revive = request.slice(request.indexOf('const revived = await reRequestDeclined('), request.indexOf('ON CONFLICT DO NOTHING, because'));
  assert.doesNotMatch(revive, /pushIfOffline/);
  assert.match(revive, /emit\('friend_request_received'/);
});

test('suggestions walk both directions of a friend\'s friendships', () => {
  const sug = src.slice(src.indexOf("router.get('/suggestions'"), src.indexOf("router.get('/my-code'"));
  assert.match(sug, /f2\.requester_id = m\.friend_id OR f2\.addressee_id = m\.friend_id/);
  assert.match(sug, /AND u\.id != \$1/);
});
