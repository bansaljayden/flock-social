// The paywall's startup warnings. services/entitlements.js cannot refuse an
// operator's PAYWALL_ENABLED=true, so it has to say loudly when the switch is
// on without the webhook pieces behind it. Its own file, because the warnings
// fire once per process and any other suite may already have spent them.
const { test } = require('node:test');
const assert = require('node:assert');

process.env.REVENUECAT_WEBHOOK_SECRET = 'rc-webhook-' + 'x'.repeat(24);
process.env.PAYWALL_ENABLED = 'true';

const { paywallEnabled } = require('../services/entitlements');

function warningsDuring(fn) {
  const seen = [];
  const prev = console.warn;
  console.warn = (m) => { seen.push(String(m)); };
  try { fn(); } finally { console.warn = prev; }
  return seen;
}

test('with RevenueCat API key set, the paywall starts quietly', () => {
  process.env.REVENUECAT_SECRET_API_KEY = 'rc-secret-' + 'x'.repeat(24);
  const seen = warningsDuring(() => { assert.strictEqual(paywallEnabled(), true); });
  assert.deepStrictEqual(seen.filter((m) => m.includes('REVENUECAT_SECRET_API_KEY')), []);
});

test('without it, the arrival-order fallback is announced, once', () => {
  delete process.env.REVENUECAT_SECRET_API_KEY;
  const seen = warningsDuring(() => {
    assert.strictEqual(paywallEnabled(), true);
    paywallEnabled();
    paywallEnabled(14);
  });
  const hits = seen.filter((m) => m.includes('REVENUECAT_SECRET_API_KEY is unset'));
  assert.strictEqual(hits.length, 1, JSON.stringify(seen));
  assert.match(hits[0], /arrival order/);
});
