// ---------------------------------------------------------------------------
// ERRORS ARE EXPLAINED, NEVER SHOWN (2026-10-30, from a UX review of app basics:
// "if I press a button and get a pop-up with a 404 error code, I'm
// uninstalling"). services/api.js keeps the server's internal wording off the
// screen and tags the sentences that were written for people; userMessage()
// shows only those, and otherwise the caller's own copy.
// ---------------------------------------------------------------------------
const api = require('../services/api');

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (h) => (h.toLowerCase() === 'content-type' ? 'application/json' : null) },
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  };
}
const respondWith = (status, body) => {
  global.fetch = jest.fn(() => Promise.resolve(jsonResponse(status, body)));
};
async function failureOf(run) {
  try { await run(); } catch (err) { return err; }
  throw new Error('the call did not fail');
}

let realWarn;
beforeEach(() => {
  window.localStorage.clear();
  realWarn = console.warn;
  console.warn = () => {};
});
afterEach(() => { console.warn = realWarn; });

test('a 5xx "Failed to ..." or "Internal server error" never reaches the screen, and the caller\'s copy wins', async () => {
  for (const internal of ['Failed to get flocks', 'Internal server error', 'Server error']) {
    respondWith(500, { error: internal });
    const err = await failureOf(() => api.voteForVenue(7, 'Bar'));
    expect(err.message).not.toContain(internal);
    expect(err.userFacing).toBe(false);
    expect(api.userMessage(err, 'Your vote did not go through.')).toBe('Your vote did not go through.');
  }
});

test('a route an older build still calls reads as an update, not a 404', async () => {
  respondWith(404, { error: 'Route not found' });
  const err = await failureOf(() => api.voteForVenue(7, 'Bar'));
  expect(err.message).toBe('This part of Flock needs an update. Update the app and try again.');
  expect(api.userMessage(err, 'fallback')).toBe(err.message);
});

test("express-validator's bare default is replaced, and a caller's copy beats it", async () => {
  respondWith(400, { errors: [{ msg: 'Invalid value' }] });
  const err = await failureOf(() => api.voteForVenue(7, 'Bar'));
  expect(err.message).toBe("That didn't look right. Check it and try again.");
  expect(api.userMessage(err, 'That venue name is too long.')).toBe('That venue name is too long.');
});

test('a sentence the server wrote for people is kept', async () => {
  respondWith(409, { error: 'Voting has closed for this plan.' });
  const err = await failureOf(() => api.voteForVenue(7, 'Bar'));
  expect(err.userFacing).toBe(true);
  expect(api.userMessage(err, 'fallback')).toBe('Voting has closed for this plan.');
});

test('a TypeError or a native plugin message is kept off the screen', () => {
  expect(api.userMessage(new TypeError("undefined is not an object (evaluating 'a.b')"), 'Try again.')).toBe('Try again.');
  expect(api.userMessage(new Error('The operation couldn\u2019t be completed. (AuthorizationError error 1000.)'), 'Apple sign-in did not finish.'))
    .toBe('Apple sign-in did not finish.');
  expect(api.userMessage(null, 'Try again.')).toBe('Try again.');
});

test("the client's own network sentences are display copy", async () => {
  global.fetch = jest.fn(() => Promise.reject(new TypeError('Failed to fetch')));
  const err = await failureOf(() => api.voteForVenue(7, 'Bar'));
  expect(err.isNetworkError).toBe(true);
  expect(api.userMessage(err, 'fallback')).toBe(err.message);
  expect(err.message).not.toMatch(/Failed to fetch/);
});
