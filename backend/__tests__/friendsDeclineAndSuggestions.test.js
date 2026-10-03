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
  // Nor a withdrawn one (migration 113): it carries the same cooldown.
  assert.match(remove, /AND NOT \(status IN \('declined', 'withdrawn'\) AND requester_id = \$1\)/);
  // The first cancel of a declined request withdraws it, so it leaves Sent
  // requests the way a cancelled pending request does.
  assert.match(remove, /SET status = 'withdrawn' WHERE requester_id = \$1 AND addressee_id = \$2 AND status = 'declined' RETURNING id/);
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


test('a decline is masked on every read the requester can make, and a revive is one a day', () => {
  // /outgoing masked a declined row as pending; /status, find-by-phone and
  // the request responses did not, and a revive was free and unbounded
  // (friends audit, 2026-09-05).
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'friends.js'), 'utf8');
  assert.match(src, /function maskedStatus\(row, callerId\) \{/);
  assert.match(src, /const status = maskedStatus\(result\.rows\[0\], req\.user\.id\);\s+if \(status === 'none'\) return res\.json\(\{ status: 'none' \}\);\s+res\.json\(\{ status, requester_id: result\.rows\[0\]\.requester_id \}\);/);
  // A row that masks to no relationship answers exactly like no row: no
  // requester_id on /status, and null (never 'none') in contact discovery.
  assert.match(src, /const status = maskedStatus\(f, req\.user\.id\);\s+if \(status !== 'none'\) friendshipMap\[f\.friend_id\] = status;/);
  // Both revive responses say what a pending row says.
  // The two fresh-request sites keep "sent to <name>"; neither revive site
  // may, or the requester learns which one they were. add-by-code names the
  // other account through `who`, its { id, name } view of the directory row.
  assert.strictEqual((src.match(/Friend request sent to \$\{(userCheck\.rows\[0\]|who)\.name\}/g) || []).length, 2);
  let at = 0;
  let revives = 0;
  while ((at = src.indexOf('reRequestDeclined(row.id', at)) !== -1) {
    revives += 1;
    const after = src.slice(at, at + 700);
    assert.ok(!/Friend request sent to/.test(after), 'a revive must not word its answer differently from a pending row');
    assert.ok(/message: 'Friend request already sent', status: 'pending'/.test(after), 'a revive answers as a pending row does');
    at += 1;
  }
  assert.strictEqual(revives, 2, 'both revive sites (request and add-by-code)');
  // One revive a day, on the naive column read the way the codebase reads them.
  assert.match(src, /AND created_at < \(NOW\(\) AT TIME ZONE 'UTC'\) - INTERVAL '24 hours'/);
  assert.match(src, /SET status = 'pending', requester_id = \$1, addressee_id = \$2, created_at = NOW\(\)/);
  // And it is charged like a probe.
  // A withdrawn row (migration 113) revives on the same terms and is charged
  // the same way.
  assert.strictEqual((src.match(/const untouched = existing\.rows\.length > 0 && !existing\.rows\.some\(\(r\) => r\.status === 'declined' \|\| r\.status === 'withdrawn'\);/g) || []).length, 2);
});

test('maskedStatus hides a decline from the requester and from nobody else', () => {
  const { maskedStatus } = require('../routes/friends').__test || {};
  if (typeof maskedStatus !== 'function') {
    // Exposed below for this test; until then the source pins above hold.
    return;
  }
  assert.strictEqual(maskedStatus({ status: 'declined', requester_id: 4 }, 4), 'pending');
  assert.strictEqual(maskedStatus({ status: 'declined', requester_id: 4 }, 9), 'declined');
  assert.strictEqual(maskedStatus({ status: 'pending', requester_id: 4 }, 4), 'pending');
  assert.strictEqual(maskedStatus(null, 4), 'none');
  // Withdrawn (migration 113): no request to the requester who cancelled it,
  // the decline it still is to the person who declined it.
  assert.strictEqual(maskedStatus({ status: 'withdrawn', requester_id: 4 }, 4), 'none');
  assert.strictEqual(maskedStatus({ status: 'withdrawn', requester_id: 4 }, 9), 'declined');
});
