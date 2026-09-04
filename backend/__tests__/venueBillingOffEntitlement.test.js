// With venue billing switched off there is nothing to be below. The gate
// already waves everyone through in that state and two other readers already
// answer 'pro'; the entitlement reader the dashboard builds its capability
// set from was the one that still answered 'free', which locked Roost for
// every real venue in production.
const test = require('node:test');
const assert = require('node:assert');

const pool = require('../config/database');
const original = pool.query;

test.afterEach(() => { pool.query = original; delete process.env.VENUE_BILLING_ENABLED; });

test('billing off: a venue with no grant row reads as pro, with no grant metadata', async () => {
  delete process.env.VENUE_BILLING_ENABLED;
  pool.query = async () => ({ rows: [{ tier: 'free', grant_tier: null, grant_status: null, grant_source: null, granted_reason: null, granted_at: null, expires_at: null }] });
  const { getVenueEntitlement } = require('../services/venueEntitlements');
  const ent = await getVenueEntitlement(7);
  assert.strictEqual(ent.tier, 'pro');
  assert.strictEqual(ent.hasGrant, false);
  assert.strictEqual(ent.expired, false);
});

test('billing on: the same venue reads the column, free', async () => {
  process.env.VENUE_BILLING_ENABLED = 'true';
  pool.query = async () => ({ rows: [{ tier: 'free', grant_tier: null, grant_status: null, grant_source: null, granted_reason: null, granted_at: null, expires_at: null }] });
  const { getVenueEntitlement } = require('../services/venueEntitlements');
  const ent = await getVenueEntitlement(7);
  assert.strictEqual(ent.tier, 'free');
});
