// Run: node --test  (from backend/)
//
// A DEV MACHINE IS NOT A USER, SERVER SIDE EITHER.
//
// backend/.env holds a live POSTHOG_API_KEY. Before this rule existed,
// routes/ai.js refused to build the PostHog client only under `node --test`,
// so every `npm run dev` Birdie turn published a real $ai_generation into the
// production project. The frontend had already measured what that does to a
// dataset: 1,526 of 1,794 pageviews in the whole history of the project came
// from a dev server, which made the headline number and every ratio built on
// it a record of somebody restarting a bundler. The backend's version was
// worse in one specific way, because the only thing it reports is token counts
// and latency, which is exactly the number nobody can sanity-check by eye.
//
// This file pins the RULE, not the paragraph above it. routes/ai.js is a
// 1,600-line file whose comments say the word "production" many times; a test
// that grepped it would pass on the prose. analyticsEnvAllowed is exported so
// the decision can be called with an env and asserted on.
const test = require('node:test');
const assert = require('node:assert');

const { analyticsEnvAllowed } = require('../routes/ai').__testables;

test('only production reports, and the suite never does', () => {
  assert.strictEqual(analyticsEnvAllowed({ NODE_ENV: 'production' }), true);

  // The three ways a developer's shell actually looks. `npm run dev` is
  // nodemon with nothing set, so an UNSET NODE_ENV is the common case and the
  // one an === 'development' check would have missed entirely.
  assert.strictEqual(analyticsEnvAllowed({}), false);
  assert.strictEqual(analyticsEnvAllowed({ NODE_ENV: 'development' }), false);
  assert.strictEqual(analyticsEnvAllowed({ NODE_ENV: 'staging' }), false);

  // node --test, which additionally must never open the client's background
  // flush timer: it holds the event loop and the run never ends.
  assert.strictEqual(analyticsEnvAllowed({ NODE_ENV: 'test' }), false);
});

test('the local opt-in works, and cannot be switched on by the test suite', () => {
  assert.strictEqual(analyticsEnvAllowed({ POSTHOG_ALLOW_LOCAL: 'true' }), true);
  assert.strictEqual(
    analyticsEnvAllowed({ NODE_ENV: 'development', POSTHOG_ALLOW_LOCAL: 'true' }),
    true,
  );

  // 'test' wins over the opt-in on purpose. Reason 1 in the route's comment is
  // that the client hangs `node --test` forever, so this is not a privacy
  // preference that a stray export can override, it is what keeps the suite
  // terminating.
  assert.strictEqual(
    analyticsEnvAllowed({ NODE_ENV: 'test', POSTHOG_ALLOW_LOCAL: 'true' }),
    false,
  );

  // The string, not the truthiness. `POSTHOG_ALLOW_LOCAL=false` in a .env is a
  // non-empty string and would arm the opt-in under any looser test.
  assert.strictEqual(analyticsEnvAllowed({ POSTHOG_ALLOW_LOCAL: 'false' }), false);
  assert.strictEqual(analyticsEnvAllowed({ POSTHOG_ALLOW_LOCAL: '1' }), false);
  assert.strictEqual(analyticsEnvAllowed({ POSTHOG_ALLOW_LOCAL: 'TRUE' }), false);
});

test('the default argument reads the real process env, so the route needs no argument', () => {
  // The route calls analyticsEnvAllowed() bare. If the default ever stopped
  // being process.env, every caller would silently start deciding on an empty
  // object, which happens to be "false" today and would be a real outage the
  // day the allowlist gains an entry.
  const before = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = 'production';
    assert.strictEqual(analyticsEnvAllowed(), true);
    process.env.NODE_ENV = 'development';
    assert.strictEqual(analyticsEnvAllowed(), false);
  } finally {
    if (before === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = before;
  }
});
