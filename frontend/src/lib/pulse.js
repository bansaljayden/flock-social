/**
 * The Tonight pulse: whether the status this device holds is still on.
 *
 * WHY THIS FILE EXISTS. App.js reads the viewer's own pulse once, when the app
 * mounts, and every pulse carries an expires_at (4 AM by default). Nothing
 * compared the two. An app left open across that hour, a web tab or a phone
 * that kept the app alive in the background, went on lighting "Down" the next
 * evening while friends saw nothing, because the server stops showing a pulse
 * the moment it expires. Tapping Down to make sure then CLEARED it, since the
 * toggle took the lit button to mean "tap again to unset", so the tap that was
 * meant to set the status did the opposite.
 *
 * Pure, so the rule is tested without mounting the app.
 */

/**
 * When `pulse` ends, in epoch milliseconds, or null for no pulse or one with
 * no readable end (an older row), which is treated as still on, the same as
 * the friends' list does.
 */
export function pulseEndsAt(pulse) {
  if (!pulse || pulse.expires_at == null) return null;
  const ms = new Date(pulse.expires_at).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/** The pulse if it is still on at `nowMs`, otherwise null. */
export function livePulse(pulse, nowMs = Date.now()) {
  if (!pulse || !pulse.status) return null;
  const end = pulseEndsAt(pulse);
  return end == null || end > nowMs ? pulse : null;
}

/**
 * What a tap on `status` should do given the pulse held now: 'clear' only
 * when that same status is still on, otherwise 'set'.
 */
export function pulseTapAction(pulse, status, nowMs = Date.now()) {
  const live = livePulse(pulse, nowMs);
  return live && live.status === status ? 'clear' : 'set';
}
