// The two venue-owner doors were single-gated (requireVerified in the route
// only); every other gated door also sits on the middleware deny list, the
// backstop for a refactor that drops the route's own gate.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'middleware', 'auth.js'), 'utf8');

test('the venue claim and the verification request are on the unverified deny list', () => {
  assert.match(src, /\{ method: 'POST', pattern: \/\^\\\/api\\\/venue-profile\$\/ \},/);
  assert.match(src, /\{ method: 'POST', pattern: \/\^\\\/api\\\/venue-profile\\\/request-verification\$\/ \},/);
});
