/**
 * ADD FRIENDS: A FAILED READ IS NOT AN EMPTY LIST (friends audit, 2026-09-05).
 * Source pins for the two error states, their retry, and the withdrawn
 * request leaving the list on a 404.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test addFriendsErrors --watchAll=false
 */
const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

test('the two list reads keep their own error, cleared on a landed read', () => {
  const app = read('App.js');
  expect(app).toContain("const [pendingRequestsError, setPendingRequestsError] = useState('');");
  expect(app).toContain("const [friendSuggestionsError, setFriendSuggestionsError] = useState('');");
  expect(app).toContain("setPendingRequests(d.requests || []); setPendingRequestsError('');");
  expect(app).toContain("setFriendSuggestions(d.suggestions || []); setFriendSuggestionsError('');");
  expect(app).toMatch(/setPendingRequestsError\(e\?\.message \|\| 'Your friend requests are not loading right now\.'\)/);
  expect(app).toMatch(/setFriendSuggestionsError\(e\?\.message \|\| 'Quick Add is not loading right now\.'\)/);
});

test('the screen says the error, offers a retry, and suppresses the empty state while it stands', () => {
  const screen = read('screens/AddFriends.js');
  expect(screen).toContain('{pendingRequestsError && (');
  expect(screen).toContain('{friendSuggestionsError && (');
  expect(screen).toContain('{friendSuggestionsError ? null : friendSuggestions.length === 0 ? (');
  expect((screen.match(/onClick=\{\(\) => loadAddFriendsData\(\)\}/g) || []).length).toBe(2);
  // Plain text for an error; the warm bird stays on the true-empty state only.
  const errBlock = screen.slice(screen.indexOf('{friendSuggestionsError && ('), screen.indexOf('{friendSuggestionsError ? null'));
  expect(errBlock).not.toContain('BirdNote');
  expect(errBlock).not.toContain('\u2014');
});

test('a request the other person withdrew leaves the list on the 404 instead of re-toasting', () => {
  const app = read('App.js');
  const at = app.indexOf('const handleAcceptFriendRequest = useCallback(async (userId) => {');
  expect(at).toBeGreaterThan(-1);
  const handler = app.slice(at, at + 1400);
  expect(handler).toContain('if (err?.status === 404) {');
  expect(handler).toContain('setPendingRequests(prev => prev.filter(r => r.id !== userId));');
  expect(handler).toContain("showToast('That request was withdrawn.');");
});
