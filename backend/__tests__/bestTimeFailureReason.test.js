'use strict';
// ---------------------------------------------------------------------------
// A FAILED BESTTIME LOOKUP SAYS WHY, AND NEVER PRINTS THE KEY.
//
// A by-name forecast spends one of the month's 100 admissions whether it finds
// the venue or not, and a bare "(404)" cannot tell "BestTime has no foot
// traffic for this place" from "no venue at that address", which a better
// address would fix. So the weekly lookup reads the failure body's message and
// logs it. Four rules hold that reading down, each pinned below:
//   * the key rides in the query string, so every form of it is cut out of the
//     whole text BEFORE anything shortens it (shortening first can split a key
//     and leave all but its last characters);
//   * at most REASON_MAX_BYTES are read, however large the body;
//   * a body that never finishes is given up on at REASON_MAX_MS, and the
//     status still classifies the call;
//   * only the weekly lookup reads a failure body at all. The live sweep and
//     the harvest never wait on one.
//
// HOW TO RUN
//   cd backend && node --test __tests__/bestTimeFailureReason.test.js
// ---------------------------------------------------------------------------
const test = require('node:test');
const assert = require('node:assert');

// Assembled at runtime, like every fake key in these suites, so no key-shaped
// literal sits in the tree for a secret scanner to stop on.
const KEY = ['pri', 'test', 'key', 'abcd'.repeat(4)].join('_');
const PUBLIC_KEY = ['pub', 'te=st', 'key/', 'abab'.repeat(3)].join('_');
process.env.BESTTIME_API_KEY = KEY;
process.env.BESTTIME_API_KEY_PUBLIC = PUBLIC_KEY;
const {
  fetchWeeklyForecast, fetchLiveBusyness, fetchJsonWithTimeout, redactKey,
} = require('../scripts/ml/bestTimeService');

const realFetch = global.fetch;
test.afterEach(() => { global.fetch = realFetch; });

// A web-stream body that hands out `chunks` one read at a time and records how
// much of it was read and whether it was cancelled.
function streamOf(chunks) {
  const seen = { reads: 0, cancelled: false, getReader: 0 };
  const body = {
    getReader() {
      seen.getReader++;
      let i = 0;
      return {
        read: async () => {
          seen.reads++;
          if (i >= chunks.length) return { done: true, value: undefined };
          return { done: false, value: Buffer.from(chunks[i++]) };
        },
        cancel: async () => { seen.cancelled = true; },
      };
    },
  };
  return { body, seen };
}

function failWith(status, chunks) {
  const { body, seen } = streamOf(chunks);
  global.fetch = async () => ({ ok: false, status, body });
  return seen;
}

function captureErrors(t) {
  const lines = [];
  t.mock.method(console, 'error', (...args) => { lines.push(args.join(' ')); });
  return lines;
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('a 404 logs BestTime\'s own reason and is still a venue-level miss', async (t) => {
  failWith(404, [JSON.stringify({ status: 'Error', message: 'Venue found, but could not forecast this venue.' })]);
  const lines = captureErrors(t);
  const result = await fetchWeeklyForecast('Wendy\'s', '123 Main St, Whitehall, PA', null);
  assert.strictEqual(result, null, 'a 404 must stay a miss the caller marks, not a throw');
  assert.ok(
    lines.some((l) => l.includes('Weekly forecast failed (404) for Wendy\'s: Venue found, but could not forecast this venue.')),
    lines.join('\n')
  );
});

test('an echoed key is cut out, raw or percent-encoded, private or public', async (t) => {
  failWith(404, [JSON.stringify({
    message: `api_key_private=${KEY} api_key_public=${encodeURIComponent(PUBLIC_KEY)} raw=${PUBLIC_KEY}`,
  })]);
  const lines = captureErrors(t);
  await fetchWeeklyForecast('X', 'Y', null);
  const all = lines.join('\n');
  for (const secret of [KEY, PUBLIC_KEY, encodeURIComponent(PUBLIC_KEY)]) {
    assert.ok(!all.includes(secret.slice(0, 8)), `key material leaked: ${all}`);
  }
  assert.match(all, /api_key_private=\[key\] api_key_public=\[key\] raw=\[key\]/);
});

test('a key that straddles the length cap is cut before the cap, never after', () => {
  // The first version shortened to 300 characters and then looked for the whole
  // key, so a key starting at 290 survived as its first ten characters.
  for (const at of [280, 290, 295, 299]) {
    const out = redactKey(`${'x'.repeat(at)}${KEY} and more`);
    assert.ok(!out.includes(KEY.slice(0, 5)), `offset ${at}: ${out.slice(at - 5)}`);
    assert.ok(out.length <= 300);
  }
  // Pinned exactly: redacting first keeps the text after the key. Shortening
  // first ends the text inside the key, where only the tail rule below can
  // catch it, and that rule stops at four characters.
  assert.strictEqual(redactKey(`${'x'.repeat(290)}${KEY} and more`), `${'x'.repeat(290)}[key] and `);
  assert.ok(!redactKey(`${'x'.repeat(297)}${KEY}`).includes(KEY.slice(0, 3)));
});

test('a text that ends partway through a key loses that tail', () => {
  assert.strictEqual(redactKey(`denied for api_key_private=${KEY.slice(0, 12)}`), 'denied for api_key_private=[key]');
  assert.strictEqual(redactKey('Venue not found'), 'Venue not found');
  assert.strictEqual(redactKey(null), null);
  assert.strictEqual(redactKey(''), '');
});

test('at most 4 KB of a failure body is read, and the rest is cancelled', async () => {
  const mib = 'y'.repeat(1024 * 1024);
  const seen = failWith(500, [mib, mib, mib, mib]);
  const { response, reason } = await fetchJsonWithTimeout('https://example.invalid', {}, 1000, { withReason: true });
  assert.strictEqual(response.status, 500);
  assert.strictEqual(seen.reads, 1, 'kept reading past the limit');
  assert.strictEqual(seen.cancelled, true, 'left the rest of the body open');
  assert.ok(reason.length <= 300);
});

test('without withReason a failure body is never touched (live sweep, harvest)', async (t) => {
  const seen = failWith(404, ['{"message":"x"}']);
  t.mock.method(console, 'error', () => {});
  const plain = await fetchJsonWithTimeout('https://example.invalid', {}, 1000);
  assert.deepStrictEqual(Object.keys(plain).sort(), ['data', 'response']);
  await fetchLiveBusyness('bt-venue-1');
  assert.strictEqual(seen.getReader, 0, 'a caller that never uses the reason waited on the body');
});

test('a failure body that never finishes is given up on at five seconds, and the status still classifies', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(console, 'error', () => {});
  for (const [status, expectThrow] of [[404, false], [503, true]]) {
    global.fetch = async (url, options = {}) => ({
      ok: false,
      status,
      body: {
        getReader: () => ({
          read: () => new Promise((resolve, reject) => {
            const { signal } = options;
            if (signal.aborted) { reject(signal.reason); return; }
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          }),
          cancel: async () => {},
        }),
      },
    });
    let settled = false;
    let value;
    let error;
    fetchWeeklyForecast('Stalled', '1 Main St', null).then(
      (v) => { settled = true; value = v; },
      (e) => { settled = true; error = e; }
    );
    await flush();
    t.mock.timers.tick(4999);
    await flush();
    assert.strictEqual(settled, false, `${status}: gave up before five seconds`);
    t.mock.timers.tick(1);
    await flush();
    await flush();
    assert.strictEqual(settled, true, `${status}: the stalled failure body held the lookup past five seconds`);
    if (expectThrow) {
      assert.ok(error && error.transient, `${status} must still throw as a transient outage`);
    } else {
      assert.ifError(error);
      assert.strictEqual(value, null, '404 must still be a venue-level miss');
    }
  }
});
