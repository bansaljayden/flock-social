/**
 * EVERYONE A PLAN ASKED, COUNTED ONE WAY WHICHEVER LOADER RAN LAST.
 *
 * The plan screen's Going row reads "Going (3 of 5)": three going, out of the
 * five people asked. Two App.js loaders fill flock.members, in two shapes. The
 * plan screen's own read keeps every status (invited, declined, accepted);
 * refreshFlockRoster keeps accepted members only, because the bill's payer
 * picker and the location-share guard read the same array. Counting the asked
 * off flock.members gave one plan "Going (3 of 5)", "Going (3)" or "Going (3
 * of 4)" by which of the two ran last. refreshFlockRoster runs while the plan
 * screen is open (a block from a face, the night-of window opening, a host
 * handoff, a read that beat the list), and it is the one that has filled the
 * roster when the plan is opened from its chat.
 *
 * So both loaders keep askedIds on the flock, from the same server answer: the
 * id of every member the server listed, whatever they answered, less anyone
 * this reader has blocked (the server already leaves those out of `members`,
 * and the client's own block list covers a block made since). The count is
 * that set joined with flock.members, so a member who joins live (the accept
 * event appends them) counts once whether or not the loader already had them,
 * plus every guest, in or out: a guest row exists only because somebody
 * answered the link.
 *
 * It lives in src/lib for the reason lib/billShares.js gives: App.js can
 * import it without pulling a screen into the boot chunk.
 */

// The ids a loader keeps, as strings, from GET /api/flocks/:id's `members`.
export const askedMemberIds = (serverMembers, blockedIds) => (Array.isArray(serverMembers) ? serverMembers : [])
  .filter((m) => m && typeof m === 'object' && m.id != null && !(blockedIds && blockedIds.has(String(m.id))))
  .map((m) => String(m.id));

// Everyone asked: askedIds and the roster on hand, each person once, and the
// guests. A flock neither loader has read yet has no askedIds, and counts the
// roster it has.
export const askedCount = (flock) => {
  if (!flock) return 0;
  const people = new Set(Array.isArray(flock.askedIds) ? flock.askedIds.map(String) : []);
  for (const m of flock.members || []) {
    if (m && typeof m === 'object' && m.id != null) people.add(String(m.id));
    // A legacy roster entry is a bare name, with no id to match on.
    else people.add(`name:${typeof m === 'object' ? m?.name : m}`);
  }
  return people.size + (Array.isArray(flock.guests) ? flock.guests.length : 0);
};
