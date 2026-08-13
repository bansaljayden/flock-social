// Run: node --test  (from backend/)  — uses Node's built-in test runner, no deps.
//
// Proves the fail-CLOSED image path actually runs under the PRODUCTION config,
// so the safety behavior isn't only exercised in prod the first time it matters.
const test = require('node:test');
const assert = require('node:assert');

// Force the production posture BEFORE requiring the module (the provider-configured
// + required flags are read at require time).
process.env.IMAGE_MODERATION_REQUIRED = 'true';
process.env.VISION_API_KEY = 'test-key'; // marks an image provider as configured

const moderation = require('../utils/moderation');

// A real 1x1 PNG so moderateImage's data-URL → Blob conversion runs for real
// (an https:// URL would be fetched for bytes before the stubbed provider).
const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test('text: clean text allowed, profanity blocked', () => {
  assert.strictEqual(moderation.moderateText('lets meet at 8pm').allowed, true);
  assert.strictEqual(moderation.moderateText('you piece of shit').allowed, false);
});

// The provider is Cloud Vision SafeSearch, reached over fetch, so the stub
// point is fetch itself. Each test installs one and restores it after.
const realFetch = global.fetch;
function stubVision(handler) {
  global.fetch = async () => handler();
}
function safeSearch(annotation) {
  return {
    ok: true,
    json: async () => ({ responses: [{ safeSearchAnnotation: annotation }] }),
  };
}
const CLEAN = { adult: 'VERY_UNLIKELY', racy: 'UNLIKELY', violence: 'VERY_UNLIKELY', medical: 'VERY_UNLIKELY' };

test.afterEach(() => { global.fetch = realFetch; });

test('image: provider configured but ERRORS -> rejected (fail-closed)', async () => {
  // Simulate timeout / quota / network failure from the provider.
  stubVision(() => { throw new Error('simulated provider error'); });
  const res = await moderation.moderateImage(TINY_PNG);
  assert.strictEqual(res.allowed, false, 'must REJECT the upload when the provider errors');
  assert.strictEqual(res.reason, 'moderation_error');
});

test('image: non-200 from provider -> rejected (fail-closed)', async () => {
  stubVision(() => ({ ok: false, status: 403, json: async () => ({}) }));
  const res = await moderation.moderateImage(TINY_PNG);
  assert.strictEqual(res.allowed, false);
  assert.strictEqual(res.reason, 'moderation_error');
});

test('image: 200 with no annotation -> rejected (learned nothing)', async () => {
  stubVision(() => ({ ok: true, json: async () => ({ responses: [{}] }) }));
  const res = await moderation.moderateImage(TINY_PNG);
  assert.strictEqual(res.allowed, false);
  assert.strictEqual(res.reason, 'moderation_error');
});

test('image: adult verdict -> rejected', async () => {
  stubVision(() => safeSearch({ ...CLEAN, adult: 'LIKELY' }));
  const res = await moderation.moderateImage(TINY_PNG);
  assert.strictEqual(res.allowed, false);
  assert.strictEqual(res.reason, 'unsafe_adult');
});

test('image: POSSIBLE racy -> rejected (strict category on a teen app)', async () => {
  stubVision(() => safeSearch({ ...CLEAN, racy: 'POSSIBLE' }));
  const res = await moderation.moderateImage(TINY_PNG);
  assert.strictEqual(res.allowed, false);
  assert.strictEqual(res.reason, 'unsafe_racy');
});

test('image: POSSIBLE violence -> allowed (softer category, avoids eating normal photos)', async () => {
  stubVision(() => safeSearch({ ...CLEAN, violence: 'POSSIBLE' }));
  const res = await moderation.moderateImage(TINY_PNG);
  assert.strictEqual(res.allowed, true);
});

test('image: safe verdict -> allowed', async () => {
  stubVision(() => safeSearch(CLEAN));
  const res = await moderation.moderateImage(TINY_PNG);
  assert.strictEqual(res.allowed, true);
});
