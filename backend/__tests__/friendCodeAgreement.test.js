// Run: node --test  (from backend/)
//
// THE FRIEND CODE IS DERIVED TWICE, IN TWO REPOSITORIES' WORTH OF CODE, AND
// NOTHING MADE THE TWO AGREE.
//
// There is no friend_code column. The code is computed from the user's id:
//
//   backend  routes/friends.js       GET /api/friends/my-code
//   frontend App.js                  the profile screen, client-side
//
// The frontend does NOT call the route. It derives the same string itself,
// which is why GET /api/friends/my-code has no caller anywhere in the app.
// That is a reasonable choice on its own (the value is a pure function of an
// id the client already holds, so a round trip buys nothing), but it leaves
// two copies of one algorithm with no relationship between them.
//
// WHAT BREAKS IF THEY DRIFT, and why it is quiet. The code somebody reads off
// their own profile is the frontend's. The code POST /api/friends/add-by-code
// resolves is parsed by the backend. Change the padding, the base, or the
// prefix on one side and every code shared from then on is refused as "not
// found" by the other, while both halves look correct in isolation and both
// test suites stay green. Nobody would suspect the string itself.
//
// This is the same shape as the haversine that existed only as a formatter:
// one piece of arithmetic, two callers, and no single place that owns it.
// Extracting it into shared code is not possible across the two runtimes here,
// so the next best thing is a test that fails the moment they disagree.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8').replace(/\r\n/g, '\n');

const backendSrc = read('routes', 'friends.js');
const frontendSrc = read('..', 'frontend', 'src', 'App.js');

/**
 * Pull the derivation out of a file and normalise the ONE thing that is
 * legitimately different between them: what the user id is called.
 */
function derivation(src, idExpression) {
  const re = new RegExp(
    `'FLOCK-' \\+ ${idExpression.replace(/[.*+?^$()|[\]\\]/g, '\\$&')}((?:\\.[a-zA-Z]+\\([^)]*\\))+)`
  );
  const m = src.match(re);
  return m ? m[1] : null;
}

test('both halves of the app build a friend code the same way', () => {
  const backend = derivation(backendSrc, 'req.user.id');
  const frontend = derivation(frontendSrc, 'authUser.id');

  assert.ok(backend, 'the backend derivation moved; find it and repoint this test');
  assert.ok(frontend, 'the frontend derivation moved; find it and repoint this test');

  assert.strictEqual(
    frontend,
    backend,
    'the friend code is derived differently on the two sides. Every code shared from '
    + 'now on would be refused by add-by-code, and both halves would look correct on '
    + 'their own. Change BOTH or neither.'
  );
});

test('the derivation is the one add-by-code can actually resolve', () => {
  /* Evaluated rather than only compared, so this catches the case where both
     sides are changed together to something that no longer round-trips: the
     prefix has to be exactly what the lookup strips, and the body has to be a
     base36 id the lookup can parse back. */
  const backend = derivation(backendSrc, 'req.user.id');
  // eslint-disable-next-line no-new-func
  const build = new Function('id', `return 'FLOCK-' + id${backend};`);

  for (const id of [1, 7, 42, 1295, 99999, 2147483647]) {
    const code = build(id);
    assert.match(code, /^FLOCK-[0-9A-Z]+$/, `${code} is not the shape add-by-code parses`);
    const body = code.slice('FLOCK-'.length);
    assert.strictEqual(parseInt(body, 36), id, `${code} does not resolve back to ${id}`);
  }
});

test('add-by-code strips the same prefix the derivation adds', () => {
  // A prefix changed on both sides but not in the lookup is the third way this
  // can break, and it is the one neither test above would see.
  const lookup = backendSrc.slice(
    backendSrc.indexOf("router.post('/add-by-code'"),
    backendSrc.indexOf("router.post('/add-by-code'") + 4000
  );
  assert.match(lookup, /FLOCK-/, 'the lookup no longer mentions the prefix the code carries');
});
