// Run: node --test  (from backend/)
//
// SECURITY-AUDIT-injection-idor.md I-2 (round 2, LOW): routes/badge.js built
// the Google Place Details URL by interpolating `req.params.placeId` raw into
// the URL path. Round 1 found the same class in routes/ai.js and fixed it in
// fcb85f6 (__tests__/aiPlaceIdEncode.test.js pins that one); badge.js was the
// call site that got missed. Every other consumer of the same value —
// crowd.js, publicCrowd.js, venueSearch.js, venueDashboard.js — already
// encodes it.
//
// The id on this route reaches the fetch after an exact-match lookup against
// `venue_profiles.google_place_id WHERE verified = true`, and it is validated
// only as a 4-300 character string (never through isPlaceIdShaped), so the
// reachable population is grandfathered rows. The fix is one call and the test
// is a source scan, for the same reason ai.js's is: the fetch sits behind a
// paid Places budget gate and a Google API key, and the property being pinned
// is a property of the URL construction, not of a response.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const badgeSrc = fs.readFileSync(path.join(__dirname, '..', 'routes', 'badge.js'), 'utf8');

test('badge.js encodes placeId into the outbound Places Details URL', () => {
  assert.ok(
    badgeSrc.includes('https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}'),
    'badge.js no longer encodes placeId in the Places Details URL'
  );
});

test('no raw ${placeId}/${place_id} interpolation survives in a badge.js Places URL', () => {
  // Same shape as aiPlaceIdEncode.test.js: match every `.../v1/places/${...}`
  // template segment and require the encoder inside any that carries a place
  // id, so a regression that drops encodeURIComponent back out fails here even
  // if the call site moves.
  const urlSegments = badgeSrc.match(/v1\/places\/\$\{[^}]*\}/g) || [];
  assert.ok(urlSegments.length > 0, 'expected at least one Places path template in badge.js');
  for (const seg of urlSegments) {
    if (/place_?id/i.test(seg)) {
      assert.ok(
        seg.includes('encodeURIComponent'),
        `raw place id interpolated into a Places URL path: ${seg}`
      );
    }
  }
});

test('every route that builds a Places Details URL from a variable encodes it', () => {
  // The round-1 fix was applied file by file and missed one. This sweeps the
  // whole routes directory so the next call site cannot be missed the same way.
  const dir = path.join(__dirname, '..', 'routes');
  const offenders = [];
  // Comments are stripped first: routes/venueProfile.js QUOTES the URL from a
  // sibling route inside a long explanatory comment, and a scan that counted
  // prose as a call site would fail on a file that builds no URL at all.
  const codeOnly = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    const src = codeOnly(fs.readFileSync(path.join(dir, file), 'utf8'));
    for (const seg of src.match(/v1\/places\/\$\{[^}]*\}/g) || []) {
      if (!seg.includes('encodeURIComponent')) offenders.push(`${file}: ${seg}`);
    }
  }
  assert.deepStrictEqual(offenders, [], 'unencoded interpolation into a Places Details URL');
});
