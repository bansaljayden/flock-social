// Where friend requests, blocks and discovery disagreed with each other,
// found by a trace on 2026-09-04. Source contracts.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

test('a blocked pair answers a request like a miss on both doors', () => {
  const src = read('routes/friends.js');
  assert.match(src, /if \(await isBlockedBetween\(req\.user\.id, user_id\)\) \{\s*return miss\(\);/);
  assert.match(src, /if \(await isBlockedBetween\(req\.user\.id, targetUserId\)\) \{\s*return miss\(\);/);
});

test('add-by-code pushes the same request the /request door pushes', () => {
  const src = read('routes/friends.js');
  const n = (src.match(/\{ type: 'friend_request', fromUserId: String\(req\.user\.id\) \}/g) || []).length;
  assert.ok(n >= 2, `expected the push on both doors, found ${n}`);
});

test('a request that accepted itself pushes like an explicit accept', () => {
  const src = read('routes/friends.js');
  const n = (src.match(/\{ type: 'friend_accepted', fromUserId: String\(req\.user\.id\) \}/g) || []).length;
  assert.strictEqual(n, 5, `explicit accept plus four auto-accept sites, found ${n}`);
});

test('an unverified account cannot resolve an address book', () => {
  const src = read('middleware/auth.js');
  assert.match(src, /\{ method: 'POST', pattern: \/\^\\\/api\\\/friends\\\/find-by-phone\$\/ \},/);
});
