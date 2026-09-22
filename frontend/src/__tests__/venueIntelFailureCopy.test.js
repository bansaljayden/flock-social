/**
 * THE FORECAST CARD MUST NOT SEND AN OWNER TO THEIR ROUTER.
 *
 * The venue numbers sit behind a metered lookup. The refusal an owner actually
 * hits is a 429 whose body says so in a sentence and says when the numbers come
 * back. Both readers of that endpoint used to discard it and print one line
 * telling them to check their connection: a wrong instruction, on the screen
 * whose whole claim is that it names its sources, sending somebody to their
 * network over something that fixes itself in twenty minutes.
 *
 * The rule is the split, not the wording. A status means a server answered and
 * refused, and the api client has already turned that into either the server's
 * own sentence or one written for that status. No status means the request
 * never landed, which is the only thing the connection line describes.
 */

const fs = require('fs');
const path = require('path');

const APP = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8').replace(/\r\n/g, '\n');

/** The two helpers, as written. */
const source = (() => {
  const at = APP.indexOf('const servedReason = (err) => (');
  expect(at).toBeGreaterThan(-1);
  const end = APP.indexOf('});', APP.indexOf('const intelFailure = (err) => ({', at)) + 3;
  return APP.slice(at, end);
})();

/* Run the real source rather than a copy of it. Both are pure expressions over
   one argument, so they evaluate on their own, and a test that re-implements
   the branch it is checking proves nothing. */
// eslint-disable-next-line no-new-func
const { intelFailure, servedReason } = new Function(
  `${source} return { intelFailure, servedReason };`
)();

describe('a refusal the server wrote is what the owner reads', () => {
  test('the metered-lookup 429 is passed through word for word', () => {
    const err = Object.assign(
      new Error('This account has looked up 30 venues in the last hour, which is the limit. Your numbers come back in about 17 minutes.'),
      { status: 429, data: { retryAfterSeconds: 986 } }
    );
    const out = intelFailure(err);
    expect(out.reason).toBe(err.message);
    expect(out.available).toBe(false);
    expect(out.code).toBe('load_failed');
  });

  test('the shared daily Places refusal is passed through too', () => {
    const err = Object.assign(
      new Error('Flock has reached its shared Google Places limit for the day. Your dashboard numbers come back tomorrow. Nothing on your account caused this.'),
      { status: 429 }
    );
    expect(intelFailure(err).reason).toBe(err.message);
  });

  test('any other answered refusal keeps the line written for it', () => {
    for (const status of [403, 500, 503]) {
      const err = Object.assign(new Error('A sentence somebody wrote for this.'), { status });
      expect(intelFailure(err).reason).toBe('A sentence somebody wrote for this.');
    }
  });
});

describe('the connection line is kept for the case it describes', () => {
  const CONNECTION = 'The forecast request did not come back. Check your connection and try again.';

  test('a request that never reached a server gets it', () => {
    const offline = Object.assign(new Error('No connection.'), { isOffline: true });
    expect(intelFailure(offline).reason).toBe(CONNECTION);
    const timedOut = Object.assign(new Error('Timed out.'), { isTimeout: true });
    expect(intelFailure(timedOut).reason).toBe(CONNECTION);
  });

  test('a status with nothing to say gets it rather than an empty card', () => {
    expect(intelFailure(Object.assign(new Error('   '), { status: 502 })).reason).toBe(CONNECTION);
    expect(intelFailure(Object.assign(new Error(''), { status: 502 })).reason).toBe(CONNECTION);
  });

  test('nothing at all still produces a card', () => {
    expect(intelFailure(undefined).reason).toBe(CONNECTION);
    expect(intelFailure(null).reason).toBe(CONNECTION);
  });
});

describe('both readers go through it', () => {
  /* Two call sites load this endpoint: the tab effect and the Try again behind
     the failure card. The first version of this fix changed one of them, which
     leaves the wrong sentence one tap away from the right one. */
  test('neither writes the connection line inline any more', () => {
    const inline = APP.split('\n').filter(
      (l) => l.includes('The forecast request did not come back')
    );
    // Once, inside the helper. Anywhere else is a call site that skipped it.
    expect(inline).toHaveLength(1);
  });

  test('the map card on the next tab over goes through the same rule', () => {
    /* The Map tab loads through the same metered venue lookup and had the same
       line. Its card takes the served sentence when there is one, so the two
       tabs cannot drift into telling an owner different things about one
       refusal. */
    expect(APP).toMatch(/setVenueMapState\(\{ available: false, reason: 'load_failed', detail: servedReason\(e\) \}\)/);
    const dash = fs.readFileSync(
      path.join(__dirname, '..', 'screens', 'VenueDashboard.js'), 'utf8'
    ).replace(/\r\n/g, '\n');
    expect(dash).toMatch(/venueMapState\.detail\s*\n?\s*\|\| 'The venue lookup failed\./);
  });

  test('the effect and the retry both call it', () => {
    expect(APP).toMatch(/getVenueIntelligence\(\)\.then\(\(d\) => \{ if \(!cancelled\) setVenueIntel\(d\); \}\)\.catch\(\(e\) => \{ if \(!cancelled\) setVenueIntel\(intelFailure\(e\)\); \}\);/);
    const retry = APP.slice(APP.indexOf('const retryVenueIntel = () => {'));
    expect(retry.slice(0, retry.indexOf('};'))).toMatch(/\.catch\(\(e\) => setVenueIntel\(intelFailure\(e\)\)\)/);
  });
});
