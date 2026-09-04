// A tag can be minted, and a tap answers with the venue's name. From the
// NFC check-in trace of 2026-09-04. Source contracts.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const admin = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin.js'), 'utf8');
const checkin = fs.readFileSync(path.join(__dirname, '..', 'routes', 'checkin.js'), 'utf8');

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
  const tap = checkin.slice(checkin.indexOf('async function handleNfcTap('), checkin.indexOf('async function handleNfcTap(') + 3000);
  assert.match(tap, /SELECT business_name FROM venue_profiles WHERE google_place_id = \$1 LIMIT 1/);
  assert.match(tap, /SELECT name FROM ml_venues WHERE google_place_id = \$1 LIMIT 1/);
  assert.strictEqual((tap.match(/venue_name: venueName,/g) || []).length, 2);
  // A miss is a null, never a failed tap.
  assert.match(tap, /catch \(err\) \{\s*venueName = null;\s*\}/);
});
