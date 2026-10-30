/**
 * WHICH SOCKET REFUSALS A PERSON IS SHOWN.
 *
 * The server's generic socket 'error' channel carries two kinds of text. Some
 * of it is a sentence written for the person who tapped ("Slow down a
 * moment.", "That doesn't fit our community guidelines. Rephrase and try
 * again."), and some is a line written for a log ("Failed to vote", "Not a
 * member of this flock", "Invalid venue id"). App.js toasted all of it, and an
 * error toast stays until it is closed (showToast), so a log line sat on the
 * screen until somebody dismissed it. join_flock was the worst of it: App.js
 * sends it again on every reconnect, so a refused join came back as a fresh
 * toast every time the socket dropped.
 *
 * So only the sentences below are shown, exactly as the server writes them
 * (backend/sockets/handlers.js and the modules it takes them from), and the
 * rest is logged. __tests__/socketRefusals.test.js reads the backend source
 * and fails when one of these stops being something the server says, and
 * when join_flock gains a refusal this file does not know about.
 */

// Matched whole, never by phrase: a log line that happens to contain a word
// from one of these is still a log line.
export const SOCKET_REFUSALS_FOR_PEOPLE = new Set([
  // Rate limits (handlers.js).
  'Slow down a moment.',
  // send_message.
  'That flock could not be found.',
  'Message too long (max 5000 characters)',
  'That message is no longer there to reply to.',
  'Message saved, but live delivery is delayed.',
  // Moderation (utils/moderation.js, handlers.js).
  "That doesn't fit our community guidelines. Rephrase and try again.",
  "We couldn't verify that image is safe to share, so it wasn't posted.",
  "Animated images can't be posted here. Try a still photo instead.",
  'That photo is too large to send. Try a smaller one.',
  "That venue card couldn't be shared.",
  "That venue's name or address can't be shown here. Pick a different spot.",
  // DMs (handlers.js, utils/relationships.js).
  'You can no longer message this user.',
  "You can only do that with people you're connected with.",
  // Votes and the venue (handlers.js, routes/venues.js votingClosedReason).
  'The plan changed while your vote was being saved. Try again.',
  'This plan was cancelled, so its venue vote is closed',
  'This plan is finished, so its venue vote is closed',
  'This plan is finished and cannot be reopened',
  'Only the flock creator can select a venue',
  // A venue owner's live crowd update.
  'Only the verified owner can update crowd levels',
  // A send, vote or invite in a plan this account has left (on another device,
  // say). join_flock keeps its own refusal below, never shown.
  "You're no longer in this plan.",
]);

// What a refused join_flock says. Never shown, whatever the list above ever
// comes to hold: the join is sent again on every reconnect, so a toast for it
// would come back each time the connection does.
export const JOIN_FLOCK_REFUSALS = new Set([
  'Not a member of this flock',
  'Failed to join flock room',
]);

/** The sentence to show for a socket 'error' message, or null to log it instead. */
export function socketRefusalToShow(message) {
  const text = typeof message === 'string' ? message.trim() : '';
  if (!text || JOIN_FLOCK_REFUSALS.has(text)) return null;
  return SOCKET_REFUSALS_FOR_PEOPLE.has(text) ? text : null;
}
