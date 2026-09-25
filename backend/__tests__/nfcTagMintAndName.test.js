// A tag can be minted, and a tap answers with the venue's name. From the
// NFC check-in trace of 2026-09-04. Source contracts.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const admin = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin.js'), 'utf8');
const checkin = fs.readFileSync(path.join(__dirname, '..', 'routes', 'checkin.js'), 'utf8').replace(/\r\n/g, '\n');

test('an admin route mints the tag URL from the same signature the verifier checks', () => {
  assert.match(admin, /router\.get\('\/venues\/tag-url', async \(req, res\) => \{/);
  assert.match(admin, /const \{ nfcTagSig \} = require\('\.\/checkin'\);/);
  assert.match(admin, /if \(!validPlaceId\(placeId\)\) return res\.status\(400\)/);
  assert.match(admin, /if \(!\(await isKnownVenue\(placeId\)\)\) return res\.status\(404\)/);
  assert.match(admin, /if \(!sig\) return res\.status\(503\)/);
  // A query parameter on purpose: every path id on the admin router is a
  // serial settled by serialId, and a place id is not one.
  assert.doesNotMatch(admin, /\/venues\/:placeId\/tag-url/);
  assert.match(checkin, /module\.exports\.nfcTagSig = \(placeId\) => \{[\s\S]*?createHmac\('sha256', secret\)\.update\(String\(placeId\)\)\.digest\('hex'\)\.slice\(0, 32\);/);
});

test('the signature the minter writes is the one the verifier expects', () => {
  const verifier = checkin.slice(checkin.indexOf('function nfcSigValid('), checkin.indexOf('function nfcSigValid(') + 500);
  assert.match(verifier, /createHmac\('sha256', secret\)\.update\(String\(placeId\)\)\.digest\('hex'\)\.slice\(0, 32\)/);
});

test('a tap answers with the venue name, best effort, on both the fresh and the deduped path', () => {
  // The whole function, to its closing brace, rather than a fixed window that
  // a longer comment would push the second answer out of.
  const start = checkin.indexOf('async function handleNfcTap(');
  const tap = checkin.slice(start, checkin.indexOf('\n}\n', start));
  // The name is the verified, unbanned owner's. Any claim used to do, so an
  // unverified or banned claimant's business name could headline the tap.
  assert.match(tap, /SELECT vp\.business_name FROM venue_profiles vp\s+JOIN users ou ON ou\.id = vp\.user_id AND ou\.is_banned IS NOT TRUE\s+WHERE vp\.google_place_id = \$1 AND vp\.verified = true LIMIT 1/);
  assert.doesNotMatch(tap, /SELECT business_name FROM venue_profiles WHERE google_place_id = \$1 LIMIT 1/);
  assert.match(tap, /SELECT name FROM ml_venues WHERE google_place_id = \$1 LIMIT 1/);
  assert.strictEqual((tap.match(/venue_name: venueName,/g) || []).length, 2);
  // A miss is a null, never a failed tap.
  assert.match(tap, /catch \(err\) \{\s*venueName = null;\s*\}/);
});
