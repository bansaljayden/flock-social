// Run: node --test  (from backend/)  — uses Node's built-in test runner, no deps.
//
// Proves the fail-CLOSED image path actually runs under the PRODUCTION config,
// so the safety behavior isn't only exercised in prod the first time it matters.
const test = require('node:test');
const assert = require('node:assert');

// Force the production posture BEFORE requiring the module (the provider-configured
// + required flags are read at require time).
process.env.IMAGE_MODERATION_REQUIRED = 'true';
process.env.OPENMODERATOR_API_KEY = 'test-key'; // marks an image provider as configured

const moderation = require('../utils/moderation');

test('text: clean text allowed, profanity blocked', () => {
  assert.strictEqual(moderation.moderateText('lets meet at 8pm').allowed, true);
  assert.strictEqual(moderation.moderateText('you piece of shit').allowed, false);
});

test('image: provider configured but ERRORS -> rejected (fail-closed)', async () => {
  // Simulate timeout / quota / network failure from the provider.
  moderation.filter.isImageNSFW = async () => { throw new Error('simulated provider error'); };
  const res = await moderation.moderateImage('https://example.com/x.jpg');
  assert.strictEqual(res.allowed, false, 'must REJECT the upload when the provider errors');
  assert.strictEqual(res.reason, 'moderation_error');
});

test('image: NSFW verdict -> rejected', async () => {
  moderation.filter.isImageNSFW = async () => ({ nsfw: true, type: ['Porn'] });
  const res = await moderation.moderateImage('https://example.com/x.jpg');
  assert.strictEqual(res.allowed, false);
  assert.strictEqual(res.reason, 'nsfw_image');
});

test('image: safe verdict -> allowed', async () => {
  moderation.filter.isImageNSFW = async () => ({ nsfw: false, type: [] });
  const res = await moderation.moderateImage('https://example.com/x.jpg');
  assert.strictEqual(res.allowed, true);
});
