/**
 * THE FIRST SESSION, as a reviewer walks it (audit 2026-09-05). Source pins
 * for the four client-side fixes; the venue-name screening is pinned on the
 * backend (moderation.test.js, flockSanitize.test.js).
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test firstSessionPath --watchAll=false
 */
const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

test('the confirm-your-email screen has a forward door, and the hero does not promise entry it then denies', () => {
  const src = read('components/auth/SignupScreen.js');
  expect(src).toContain('const [pendingUser, setPendingUser] = useState(null);');
  expect(src).toContain('setPendingUser(data.user || null);');
  expect(src).toContain('onClick={() => onSignupSuccess(pendingUser)}');
  expect(src).toContain('Continue for now, confirm later');
  expect(src).not.toContain("Four fields and you're in.");
  expect(src).toContain('Four fields, then one link in your inbox.');
  // The confirm screen's own heading is what tests wait on; the hero must not
  // pre-empt it.
  expect(src).not.toMatch(/<p className="auth-sub">[^<]*confirm your email/i);
});

test('the plan name field stops at the limit the server enforces', () => {
  const src = read('screens/CreateScreen.js');
  expect(src).toContain('id="flock-name-input" maxLength={255}');
});

test('the invite-link sentence says the expiry the server sets', () => {
  // routes/flocks.js: expires_at = GREATEST(NOW() + 14 days, event_time + 7 days).
  const src = read('screens/ChatDetail.js');
  expect(src).not.toContain('It stops working in two weeks.');
  expect(src).toContain('It stops working two weeks from now or a week after the plan, whichever is later.');
});

test('the time editor refuses an instant that has already passed', () => {
  const src = read('screens/FlockDetail.js');
  expect(src).toContain("if (chosen.getTime() < Date.now()) {");
  expect(src).toContain("showToast('That time has already passed. Pick a later one.', 'error');");
  expect(src).toContain('await saveFlockEventTime(flock.id, chosen.toISOString());');
});
