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

/**
 * THE FRIENDS WHO ARE OUT TONIGHT, for the line under the Nest's Tonight
 * control (2026-11-06).
 *
 * Reads friendsPulses as App.js already holds it (loaded at mount, on return
 * to the app and by socket), so it costs no request. What it will and will
 * not say:
 *
 *   - Only answers still on (expires_at in the future), and only 'down' and
 *     'maybe'. A friend who said Not is never named: being shown as the one
 *     who is not coming is the hurt this line must not cause.
 *   - Never the note a friend wrote, never a place, never a time seen.
 *   - Quiet from midnight to 4 AM: null, so the Nest does not ask anyone to go
 *     out after midnight. (The control itself stays, so an answer can still
 *     be set or cleared.)
 *
 * Returns null, or { people, text, planLabel }: up to three people to draw
 * (down first, then maybe), the line ("Sam and Leo are down tonight, Priya
 * said maybe"), and the words on the button that starts a plan with all of
 * them ("Plan with Sam", or "Plan with them").
 */
const firstNameOf = (name) => String(name || '').trim().split(/\s+/)[0] || 'A friend';

const listNames = (names, verbOne, verbMany) => {
  if (names.length === 1) return `${names[0]} ${verbOne}`;
  if (names.length === 2) return `${names[0]} and ${names[1]} ${verbMany}`;
  return `${names[0]}, ${names[1]} and ${names.length - 2} more ${verbMany}`;
};

export function friendsDownLine(friendsPulses, now = new Date()) {
  const d = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(d.getTime())) return null;
  if (d.getHours() < 4) return null;
  const nowMs = d.getTime();
  const live = (Array.isArray(friendsPulses) ? friendsPulses : [])
    .filter((p) => p && p.id != null && livePulse(p, nowMs));
  const down = live.filter((p) => p.status === 'down');
  const maybe = live.filter((p) => p.status === 'maybe');
  if (down.length === 0 && maybe.length === 0) return null;
  const parts = [];
  if (down.length) parts.push(listNames(down.map((p) => firstNameOf(p.name)), 'is down tonight', 'are down tonight'));
  if (maybe.length) parts.push(listNames(maybe.map((p) => firstNameOf(p.name)), 'said maybe', 'said maybe'));
  const people = [...down, ...maybe].map((p) => ({ id: p.id, name: p.name || '', profile_image_url: p.profile_image_url || null }));
  return {
    people,
    text: parts.join(', '),
    planLabel: people.length === 1 ? `Plan with ${firstNameOf(people[0].name)}` : 'Plan with them',
  };
}

/**
 * The people a "Plan with them" tap adds to the plan being made: the ones
 * already picked first, never replaced, then these friends by id, up to the
 * create screen's 25.
 */
export function mergePlanFriends(prev, people, cap = 25) {
  const out = Array.isArray(prev) ? prev.slice() : [];
  const have = new Set(out.map((f) => String(f.id)));
  for (const p of Array.isArray(people) ? people : []) {
    if (out.length >= cap) break;
    if (p && p.id != null && !have.has(String(p.id))) {
      have.add(String(p.id));
      out.push({ id: p.id, name: p.name, profile_image_url: p.profile_image_url || null });
    }
  }
  return out;
}
