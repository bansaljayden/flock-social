/* WHOSE VOTE IS WHOSE IN A DM'S VENUE VOTE (2026-11-17).

   Each option in a DM tally lists who voted for it, and the screen found your
   own vote by looking for your display name in that list. A name is not an
   account: with somebody who shares your name, their vote was drawn as yours,
   the two of you counted as one voter, and a tap on their option was taken for
   an un-vote of your own. The server now sends `voter_ids` beside `voters`, in
   the same order (backend sockets/handlers.js DM_VOTE_TALLY_SQL), so the i-th
   id is the i-th name's account, and a vote is matched on the id.

   An option that carries no `voter_ids` (an answer from a server before then)
   is matched on the name, as it always was, and is rewritten by name, so no id
   the server never sent is invented for it. `voters` stays the display list
   either way.

   `me` is { id, name }: the signed-in account. */

const sameAccount = (a, b) => a != null && b != null && String(a) === String(b);
const carriesIds = (option) => Array.isArray(option?.voter_ids);

/** Whether `me` voted for this option. */
export function votedFor(option, me) {
  if (!option || !me) return false;
  if (carriesIds(option)) return option.voter_ids.some((id) => sameAccount(id, me.id));
  return me.name != null && Array.isArray(option.voters) && option.voters.includes(me.name);
}

/** The option with my vote taken off its voters (the count is the caller's). */
export function withoutMyVote(option, me) {
  const voters = Array.isArray(option.voters) ? option.voters : [];
  if (carriesIds(option)) {
    const keep = option.voter_ids.map((id) => !sameAccount(id, me.id));
    return {
      ...option,
      voters: voters.filter((_, i) => keep[i] !== false),
      voter_ids: option.voter_ids.filter((_, i) => keep[i]),
    };
  }
  return { ...option, voters: voters.filter((name) => name !== me.name) };
}

/** The option with my vote added to its voters (the count is the caller's). */
export function withMyVote(option, me) {
  const voters = [...(Array.isArray(option.voters) ? option.voters : []), me.name];
  if (carriesIds(option)) return { ...option, voters, voter_ids: [...option.voter_ids, me.id] };
  return { ...option, voters };
}

/** A new option holding my vote alone, by id as well as by name. */
export function myNewOption(venueName, venueId, me) {
  return { venue_name: venueName, venue_id: venueId || null, vote_count: 1, voters: [me.name], voter_ids: [me.id] };
}

const countOf = (option) => parseInt(option.vote_count || 0, 10) || 0;

/**
 * The tally after my vote moves to `venueName`, optimistically, until the next
 * tally answers: mine comes off whichever option held it, an option left with
 * no votes goes, and the one I picked gains mine, made new if nobody had voted
 * for it. Every count comes back a number.
 */
export function moveMyVote(options, venueName, venueId, me) {
  const moved = (options || []).map((o) => {
    if (o.venue_name === venueName) return { ...withMyVote(o, me), vote_count: countOf(o) + 1 };
    if (votedFor(o, me)) return { ...withoutMyVote(o, me), vote_count: countOf(o) - 1 };
    return { ...o, vote_count: countOf(o) };
  }).filter((o) => o.vote_count > 0 || o.venue_name === venueName);
  return moved.some((o) => o.venue_name === venueName) ? moved : [...moved, myNewOption(venueName, venueId, me)];
}

/** The tally after I take my vote back: mine comes off, and an option left with none goes. */
export function takeBackMyVote(options, me) {
  return (options || [])
    .map((o) => (votedFor(o, me) ? { ...withoutMyVote(o, me), vote_count: countOf(o) - 1 } : { ...o, vote_count: countOf(o) }))
    .filter((o) => o.vote_count > 0);
}

/** How many people voted across the options: accounts where ids are carried, names where not. */
export function votersCounted(options) {
  const seen = new Set();
  for (const option of options || []) {
    if (carriesIds(option)) option.voter_ids.forEach((id) => seen.add(`id:${id}`));
    else (option.voters || []).forEach((name) => seen.add(`name:${name}`));
  }
  return seen.size;
}
