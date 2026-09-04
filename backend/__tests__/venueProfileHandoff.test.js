// The venue profile routes hand the client what its first run needs. From
// the venue owner trace of 2026-09-04. Source contracts.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const profile = fs.readFileSync(path.join(__dirname, '..', 'routes', 'venueProfile.js'), 'utf8');
const advisor = fs.readFileSync(path.join(__dirname, '..', 'routes', 'advisor.js'), 'utf8');

test('the POST answers with the role it just granted, without a downgrade', () => {
  assert.match(profile, /const role = saved\?\.google_place_id\s*\? \(req\.user\.role === 'admin' \? 'admin' : 'venue_owner'\)\s*: \(req\.user\.role \|\| 'user'\);/);
  assert.match(profile, /res\.status\(201\)\.json\(\{ \.\.\.profileView\(saved\), role \}\);/);
});

test('the GET says whether billing is on', () => {
  assert.match(profile, /const \{ getVenueEntitlement, venueBillingEnabled \} = require\('\.\.\/services\/venueEntitlements'\);/);
  assert.match(profile, /billing_enabled: venueBillingEnabled\(\),/);
});

test('a claim can be checked at step one, and the refusal names an address', () => {
  assert.match(profile, /router\.get\('\/claim', async \(req, res\) => \{/);
  assert.match(profile, /if \(!isPlaceIdShaped\(placeId\)\) return res\.status\(400\)/);
  assert.match(profile, /const taken = await claimedByAnother\(placeId, req\.user\.id\);/);
  assert.match(profile, /const CLAIMED_MSG = 'That business is already claimed by a verified owner\. If it is yours, email social@flockcorp\.com and we will sort it out\.';/);
});

test('Roost offers an unverified venue one reason, not thirteen refusing chips', () => {
  assert.match(advisor, /\} else if \(ctx && ctx\.profile\) \{[\s\S]{0,600}freeText: false,\s*lead: \[\],\s*groups: \[\],\s*reason: unverifiedReason\(ctx\.profile\),/);
});
