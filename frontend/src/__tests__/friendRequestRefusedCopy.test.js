/**
 * A REFUSED FRIEND REQUEST DOES NOT SAY "USER NOT FOUND" ABOUT SOMEBODY ON SCREEN.
 *
 * routes/friends.js answers a spent probe budget (twenty requests to strangers
 * an hour), a blocked pair, a banned account and a missing one with one 404,
 * "User not found", on purpose: telling them apart is the enumeration the
 * budget closes. The app printed that sentence. The click-through crawl of
 * 2026-11-11 started new chats with people from New message, each of which
 * sends a friend request, and past the budget the toast read "Your message is
 * here, but the friend request didn't send. User not found." about the person
 * whose chat was open. The Add buttons said "User not found" the same way.
 *
 * services/api.js sendFriendRequest now turns a 404 into a sentence that is
 * true in every one of those cases and tells nobody which, and marks it not
 * user-facing so the callers' own sentences show.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test friendRequestRefusedCopy --watchAll=false
 */
const fs = require('fs');
const path = require('path');

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

let warn;
beforeEach(() => { warn = jest.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { warn.mockRestore(); });

test('a 404 becomes the neutral sentence, and the caller\'s own words show', async () => {
  respondWith(404, { error: 'User not found' });
  const err = await api.sendFriendRequest(41).then(() => null, (e) => e);
  expect(err).toBeTruthy();
  expect(err.status).toBe(404);
  expect(err.message).toBe(api.FRIEND_REQUEST_REFUSED);
  expect(err.message).not.toMatch(/not found/i);
  expect(api.userMessage(err, "That friend request didn't send.")).toBe("That friend request didn't send.");
});

test('the sentence names no reason, so it gives none of the four away', () => {
  expect(api.FRIEND_REQUEST_REFUSED).toBe("That friend request didn't send. Try again later.");
  expect(api.FRIEND_REQUEST_REFUSED).not.toMatch(/block|ban|exist|not found|limit|too many/i);
});

test('other refusals keep the server\'s words', async () => {
  respondWith(403, { error: 'You can no longer connect with this user.' });
  const err = await api.sendFriendRequest(41).then(() => null, (e) => e);
  expect(err.status).toBe(403);
  expect(err.message).toBe('You can no longer connect with this user.');
  expect(api.userMessage(err, 'fallback')).toBe('You can no longer connect with this user.');
});

test('a sent request still answers as before', async () => {
  respondWith(200, { message: 'Friend request sent', status: 'pending' });
  await expect(api.sendFriendRequest(41)).resolves.toEqual({ message: 'Friend request sent', status: 'pending' });
});

test('the three callers read the error the way this relies on', () => {
  const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
  const app = read('App.js');
  // Add, from search: its own fallback.
  expect(app).toMatch(/showToast\(userMessage\(err, "That friend request didn't send\."\), 'error'\);/);
  // A new chat with a stranger: its lead and its own fallback.
  expect(app).toMatch(/showToast\(`\$\{lead\} \$\{userMessage\(err, 'You can add them from their profile\.'\)\}`, 'error'\);/);
  // The not-connected strip in a DM reads err.message, which is the sentence.
  expect(read('screens', 'DmDetail.js')).toMatch(/await sendFriendRequest\(selectedDmId\);[\s\S]{0,200}showToast\(err\?\.message \|\| "That request didn't send\. Try again\.", 'error'\);/);
});
