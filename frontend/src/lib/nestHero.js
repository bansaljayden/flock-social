/**
 * WHAT THE NEST'S HERO CARD SAYS ABOUT ITS PLAN.
 *
 * The hero is tonight's plan, or the next one (lib/nestTime.js pickHero). It
 * carries four facts a person can hold at a glance (when, what, where, who)
 * and at most one button: the one thing that plan needs from the reader, if it
 * needs anything. Everything here is pure, so each rule is run by
 * src/__tests__/nestHero.test.js.
 */

const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || '';

/**
 * The names line under the faces, the reader always first as "You":
 * "Just you", "You and Jordan", "You, Jordan and 1 more".
 *
 * `previews` is GET /api/flocks's member_previews: up to four accepted
 * members, creator first, each with an id. `total` is the plan's head count
 * (accounts and link guests), so a reader who is not among the four, or
 * guests who never appear in it, are still counted.
 */
export function heroNames(previews, total, myId) {
  const list = Array.isArray(previews) ? previews.filter((p) => p && typeof p === 'object') : [];
  const isMe = (p) => myId != null && String(p.id) === String(myId);
  const others = list.filter((p) => !isMe(p));
  const count = Math.max(1, Number(total) || list.length || 1);
  const rest = count - 1; // everyone but the reader
  if (rest <= 0) return 'Just you';
  const named = others.map((p) => firstName(p.name)).find(Boolean);
  if (!named) return `You and ${rest} more`;
  if (rest === 1) return `You and ${named}`;
  return `You, ${named} and ${rest - 1} more`;
}

/**
 * The faces to draw, as { key, name, image }: the previews in their order
 * (creator first), except that the reader's own face, when they are among
 * the four, leads, as "You" leads the names line beside it. On Sam's plan
 * the faces read S, M while the line said "You and Sam".
 */
export function heroFaces(previews, myId) {
  const list = Array.isArray(previews) ? previews : [];
  const faces = list.map((m, i) => (typeof m === 'string'
    ? { key: `s${i}`, name: m, image: null, me: false }
    : { key: m.id ?? `i${i}`, name: m.name || '', image: m.profile_image_url || m.image || null, me: myId != null && m.id != null && String(m.id) === String(myId) }));
  const ordered = [...faces.filter((f) => f.me), ...faces.filter((f) => !f.me)];
  return ordered.map(({ me, ...face }) => face);
}

/**
 * The plan's status beside its time. Only two words: a plan is locked in,
 * or it is still being voted on.
 */
export function heroStatus(flock) {
  if (!flock) return null;
  if (flock.status === 'confirmed' || flock.status === 'locked') return { key: 'locked', label: 'Locked in' };
  if (flock.status === 'voting') return { key: 'voting', label: 'Still voting' };
  return null;
}

/**
 * The quiet note on a voting plan the reader has already voted on and does
 * not host: "You voted. Sam locks it in." True because only the creator can
 * change a plan's status (routes/flocks.js PUT /:id refuses anyone else).
 * Nothing when the host's name did not come through ('Unknown'), when the
 * reader is the host, or when the vote is not known to be cast.
 */
export function heroNote(flock, myId) {
  if (!flock || flock.status !== 'voting' || flock.timePassed) return null;
  if (flock.iVoted !== true) return null;
  if (myId != null && flock.creatorId != null && String(flock.creatorId) === String(myId)) return null;
  const host = firstName(flock.host);
  if (!host || flock.host === 'Unknown') return null;
  return `You voted. ${host} locks it in.`;
}

/**
 * The one button, or null: the first ask the plan has (lib/nestAsks.js, in
 * its order: owe, budget, vote).
 *
 *     owe     "Pay your share of the bill"
 *     budget  "Add your budget"
 *     vote    "Vote on a place"
 *
 * Never "How was {venue}?": a plan is the hero until the 4 AM after its
 * night, so the night is still on, and the Nest asks that the morning after,
 * as a Needs you row (lib/planNight.js nestAsksHowItWas). It asked from an
 * hour in, of a night the reader was most likely still at.
 *
 * `asks` is nestAsks()'s list for the whole Nest; only this plan's entries
 * count. Where each one goes is the caller's (the money ones open the chat's
 * money sheet, the vote opens the plan).
 */
export const HERO_ACTION_LABEL = {
  owe: 'Pay your share of the bill',
  budget: 'Add your budget',
  vote: 'Vote on a place',
};

export function heroAction(flock, asks) {
  if (!flock) return null;
  const mine = (Array.isArray(asks) ? asks : []).find((a) => a && a.flock && a.flock.id === flock.id);
  if (mine && HERO_ACTION_LABEL[mine.kind]) return { kind: mine.kind, label: HERO_ACTION_LABEL[mine.kind] };
  return null;
}

/** The place line: the venue, or "No place yet" for a plan still choosing. */
export const placeLine = (venue) => (venue && venue !== 'TBD' ? venue : 'No place yet');

/**
 * The chip on a plan row or card: the READER's state, not the plan's phase.
 * "Needs Votes" sat on a plan the reader had voted on an hour before; this
 * says "Voted". The first that applies:
 *
 *   timePassed                   "Time passed"       neutral
 *   an ask on this plan          owe "Needs your share", budget "Needs
 *                                your budget", vote "Needs your vote"
 *                                (accent)
 *   voting, the reader's vote    "Needs your vote"   accent
 *   voting, voted                "Voted"             neutral
 *   voting, not known            "Voting"            neutral
 *   a night over, unrated        "How was it?"       neutral, star
 *   locked in                    "Locked in"         neutral, check
 *
 * The asks carry a verb, the way the Needs you heading does. "Your vote" had
 * none and read as "here is your vote", which is what the guest page's own
 * "Your vote" tag means: the option the reader already picked.
 *
 * `needsVote` is App.js's needsMyVote(f) and `voted` its mirror: each is
 * true only when the plan's tally read this session, or the list read's own
 * i_voted, says so. Neither known, and the chip says only "Voting".
 */
export const ASK_CHIP = { owe: 'Needs your share', budget: 'Needs your budget', vote: 'Needs your vote' };

export function planChip(flock, { needsVote = false, voted = false, ask = null } = {}) {
  if (!flock) return null;
  if (flock.timePassed) return { label: 'Time passed', tone: 'neutral', icon: null };
  if (ask && ASK_CHIP[ask]) return { label: ASK_CHIP[ask], tone: 'accent', icon: null };
  if (flock.status === 'voting') {
    if (needsVote) return { label: ASK_CHIP.vote, tone: 'accent', icon: null };
    if (voted) return { label: 'Voted', tone: 'neutral', icon: null };
    return { label: 'Voting', tone: 'neutral', icon: null };
  }
  if (flock.askHowItWas) return { label: 'How was it?', tone: 'neutral', icon: 'star' };
  if (flock.status === 'confirmed' || flock.status === 'locked') return { label: 'Locked in', tone: 'neutral', icon: 'check' };
  return null;
}

/**
 * THE LOCK-IN MOMENT, once per plan per device.
 *
 * The first time this device shows a hero plan that is locked in, the card
 * gives it one designed moment (a buzz, the status fading in, the name
 * settling; components/nest/NestHero.js). Never twice: it is remembered under
 * nest.lockSeen.<id> in localStorage, read and written through lib/storage's
 * guards, and in memory for the session too, so a browser that refuses
 * storage still sees it once a session rather than on every render.
 *
 * Returns true exactly when the moment should play now, and records it.
 */
const lockSeenThisSession = new Set();

export const lockSeenKey = (id) => `nest.lockSeen.${id}`;

export function takeLockMoment(id, store) {
  if (id == null) return false;
  const k = String(id);
  if (lockSeenThisSession.has(k)) return false;
  lockSeenThisSession.add(k);
  if (store.get(lockSeenKey(k))) return false;
  store.set(lockSeenKey(k), '1');
  return true;
}
