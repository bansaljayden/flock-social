'use strict';
// ---------------------------------------------------------------------------
// A FAILED BESTTIME LOOKUP SAYS WHAT IT MEANT, AND NEVER WHAT IT SAID.
//
// A by-name forecast spends one of the month's 100 admissions whether it finds
// the venue or not, and a bare "(404)" cannot tell "BestTime has no foot
// traffic for this place" from "no venue at that name and address". So the
// weekly lookup reads the failure body and logs what it meant. The rules, each
// pinned below:
//   * no body text is ever logged, only one of the fixed labels. The key rides
//     in the query string, and the first two versions of this, which redacted
//     free text, leaked it through a cut, an encoding and an overlap;
//   * at most REASON_MAX_BYTES are read, and nothing past that is copied;
//   * a body that never finishes is given up on at five seconds, and the
//     status still classifies the call, whatever the body holds;
//   * only the weekly lookup reads a failure body. Everyone else's is
//     cancelled unread, so its connection goes back to the pool.
//
// HOW TO RUN
//   cd backend && node --test __tests__/bestTimeFailureReason.test.js
// ---------------------------------------------------------------------------
const test = require('node:test');
const assert = require('node:assert');

// Assembled at runtime, like every fake key in these suites, so no key-shaped
// literal sits in the tree for a secret scanner to stop on.
const KEY = ['pri', 'test', 'key', 'abcd'.repeat(4)].join('_');
process.env.BESTTIME_API_KEY = KEY;
const {
  fetchWeeklyForecast, fetchLiveBusyness, fetchJsonWithTimeout,
  failureReason, readBoundedText, REASON_MAX_BYTES,
} = require('../scripts/ml/bestTimeService');

const realFetch = global.fetch;
test.afterEach(() => { global.fetch = realFetch; });

// A web-stream body that hands out `chunks` one read at a time and records how
// it was used.
function streamOf(chunks) {
  const seen = { reads: 0, readerCancelled: false, bodyCancelled: false, getReader: 0 };
  const body = {
    getReader() {
      seen.getReader++;
      let i = 0;
      return {
        read: async () => {
          seen.reads++;
          if (i >= chunks.length) return { done: true, value: undefined };
          return { done: false, value: new Uint8Array(Buffer.from(chunks[i++])) };
        },
        cancel: async () => { seen.readerCancelled = true; },
      };
    },
    cancel: async () => { seen.bodyCancelled = true; },
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

test('BestTime\'s two known answers come back as their labels', async (t) => {
  failWith(404, [JSON.stringify({ status: 'Error', message: 'Error: Venue found, but could not forecast this venue. Potential issues: ...' })]);
  let lines = captureErrors(t);
  assert.strictEqual(await fetchWeeklyForecast('Wendy\'s', '123 Main St, Whitehall, PA', null), null,
    'a 404 must stay a miss the caller marks, not a throw');
  assert.ok(lines.some((l) => l.endsWith('Weekly forecast failed (404) for Wendy\'s: found, but BestTime has too little visitor data to forecast it')),
    lines.join('\n'));

  failWith(404, [JSON.stringify({ message: 'Could not find the venue' })]);
  lines = captureErrors(t);
  await fetchWeeklyForecast('Nowhere', 'x', null);
  assert.ok(lines.some((l) => l.endsWith(': BestTime could not match a venue to that name and address')), lines.join('\n'));
});

test('no text from the body reaches the log, however the key is encoded or cut', async (t) => {
  const forms = [
    KEY,
    encodeURIComponent(`${KEY}/x`),
    encodeURIComponent(`${KEY}/x`).toLowerCase(),
    `${KEY} x`.replace(' ', '+'),
    JSON.stringify(`${KEY}/x`).slice(1, -1).replace('/', '\\/'),
  ];
  for (const form of forms) {
    // Both whole and cut at the read limit, which breaks the JSON.
    for (const body of [
      JSON.stringify({ message: `denied for api_key_private=${form}` }),
      `{"message":"${'z'.repeat(REASON_MAX_BYTES - 40)}${form}${'z'.repeat(200)}"}`,
    ]) {
      failWith(404, [body]);
      const lines = captureErrors(t);
      await fetchWeeklyForecast('X', 'Y', null);
      const all = lines.join('\n');
      assert.ok(!all.includes(KEY.slice(0, 6)) && !all.includes('abcdabcd'), `key material leaked: ${all}`);
      assert.ok(all.endsWith(': reason not recognised'), all);
    }
  }
});

test('a message that is not a string cannot knock the status out of its class', async (t) => {
  // the review's case: {"message":{"toString":null}} made String() throw, the throw
  // was swallowed, and a 503 came back as a venue miss.
  failWith(503, ['{"message":{"toString":null}}']);
  t.mock.method(console, 'error', () => {});
  await assert.rejects(fetchWeeklyForecast('Down', 'x', null), (err) => err.transient === true);
  assert.strictEqual(failureReason('{"message":{"toString":null}}'), 'reason not recognised');
  assert.strictEqual(failureReason(null), null);
  assert.strictEqual(failureReason(''), null);
});

test('at most 4 KB is read and copied, and the rest is cancelled', async () => {
  const mib = 'y'.repeat(1024 * 1024);
  const { body, seen } = streamOf([mib, mib, mib, mib]);
  const text = await readBoundedText({ body });
  assert.strictEqual(Buffer.byteLength(text), REASON_MAX_BYTES, 'copied past the allowance');
  assert.strictEqual(seen.reads, 1, 'kept reading past the limit');
  await flush();
  assert.strictEqual(seen.readerCancelled, true, 'left the rest of the body open');

  const small = streamOf(['a'.repeat(1000), 'b'.repeat(1000)]);
  assert.strictEqual(await readBoundedText({ body: small.body }), 'a'.repeat(1000) + 'b'.repeat(1000));
});

test('without withReason a failure body is cancelled unread (live sweep, harvest)', async (t) => {
  let seen = failWith(404, ['{"message":"x"}']);
  const plain = await fetchJsonWithTimeout('https://example.invalid', {}, 1000);
  assert.deepStrictEqual(Object.keys(plain).sort(), ['data', 'response']);
  await flush();
  assert.strictEqual(seen.getReader, 0, 'a caller that never uses the reason read the body');
  assert.strictEqual(seen.bodyCancelled, true, 'an unread failure body was left holding its connection');

  seen = failWith(404, ['{"message":"x"}']);
  t.mock.method(console, 'error', () => {});
  await fetchLiveBusyness('bt-venue-1');
  await flush();
  assert.strictEqual(seen.getReader, 0);
  assert.strictEqual(seen.bodyCancelled, true);
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
