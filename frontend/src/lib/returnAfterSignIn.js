// Where to go back to after signing in, for the one page that sends people to
// sign in and expects them back: /pro. Its "Log in to continue" used to drop a
// buyer on /app with no way back to the plan they were reading.
//
// Kept to a fixed list of paths on purpose. A return address read from a query
// string or stored free-form is an open redirect waiting for someone to link
// it; here the page stores a path from this list and App.js only ever assigns
// a path from this list. Session storage, so it does not outlive the tab, and
// it expires after half an hour so an abandoned sign-in does not bounce the
// next one somewhere unexpected.

const KEY = 'flock_return_after_sign_in';
const ALLOWED = new Set(['/pro']);
const TTL_MS = 30 * 60 * 1000;

export function rememberReturnAfterSignIn(path) {
  if (!ALLOWED.has(path)) return;
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify({ path, at: Date.now() }));
  } catch { /* storage refused: the sign-in still works, it just lands on /app */ }
}

// Read once, then forget. Anything unexpected answers null.
export function takeReturnAfterSignIn() {
  try {
    const raw = window.sessionStorage.getItem(KEY);
    if (!raw) return null;
    window.sessionStorage.removeItem(KEY);
    const v = JSON.parse(raw);
    if (!v || !ALLOWED.has(v.path)) return null;
    const age = Date.now() - Number(v.at);
    return age >= 0 && age < TTL_MS ? v.path : null;
  } catch {
    return null;
  }
}
