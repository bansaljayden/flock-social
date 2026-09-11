/**
 * localStorage behind a guard.
 *
 * WHY THIS FILE EXISTS. Safari with "Block all cookies" throws on every
 * localStorage call, and a full quota throws on every write. A throw inside a
 * useState initializer happens before the error boundary mounts, so the whole
 * app is a blank screen; a throw inside an async success path (a venue claim,
 * a bill settle) leaves the server's change made and the screen's change not.
 * App.js already guards its failed-message store this way. These three cover
 * the boot path and the handful of writes that follow a server round trip.
 *
 * Failure is a value, never a throw: lsGet returns null, lsSet and lsRemove
 * return false. Callers that want a default apply it themselves, the same as
 * they would on a missing key.
 */

export const lsGet = (key) => {
  try { return localStorage.getItem(key); } catch { return null; }
};

export const lsSet = (key, value) => {
  try { localStorage.setItem(key, value); return true; } catch { return false; }
};

export const lsRemove = (key) => {
  try { localStorage.removeItem(key); return true; } catch { return false; }
};
