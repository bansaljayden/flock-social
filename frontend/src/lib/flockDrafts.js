/**
 * HALF-WRITTEN FLOCK MESSAGES, ONE PER ACCOUNT AND PLAN, FOR ONE SESSION.
 *
 * The flock chat keeps a sentence somebody backed out of, so it is waiting in
 * the box when they open the same plan again. That store used to be a Map at
 * the top of screens/ChatDetail.js, keyed by plan alone, and nothing that ends
 * a session could reach it. Signing out is not a page load: App.js endSession
 * sets the account to null and api.js clearLocalSession sweeps storage, so the
 * chat screen's module and its Map stayed in memory. On a shared phone the next
 * account to open a plan both of them are in found the last account's sentence
 * in its composer with Send armed, one tap from going out under the wrong name.
 *
 * So the drafts live here, where clearLocalSession, the one answer to "what
 * does sign-out clear", empties them without pulling the chat screen's chunk
 * into the app's. And each is filed under the account that wrote it as well as
 * the plan, so a way of ending a session that somehow skipped the sweep still
 * could not hand one account's words to another.
 *
 * Memory only, never storage: a draft is worth a trip back to the same plan in
 * the same session, not worth writing a half-finished sentence to disk.
 */

const drafts = new Map();

// Moved on by every clear. The chat screen files what is in its box when it
// is taken away without its own exit (a notification tap into another plan,
// or the account going), and on a sign-out that happens AFTER the clear: Log
// out empties the store first and the screen goes with the account a render
// later. A draft filed by a screen that opened before the clear is refused,
// or the sweep would be undone the moment it ran.
let generation = 0;

const keyFor = (accountId, flockId) => `${accountId}:${flockId}`;

/** Which clear the store is on, for a screen to hold from when it opened. */
export function flockDraftGeneration() {
  return generation;
}

/** What this account last left in this plan's box, or ''. */
export function readFlockDraft(accountId, flockId) {
  if (accountId == null || flockId == null) return '';
  return drafts.get(keyFor(accountId, flockId)) || '';
}

/**
 * File a draft under its account and plan. An empty one removes the entry.
 * `since` is the generation the writer opened under; a draft from before the
 * last clear is not filed.
 */
export function keepFlockDraft(accountId, flockId, text, since = generation) {
  if (accountId == null || flockId == null || since !== generation) return;
  if (text) drafts.set(keyFor(accountId, flockId), text);
  else drafts.delete(keyFor(accountId, flockId));
}

/** Every draft on the device, gone. Called by api.js clearLocalSession. */
export function clearFlockDrafts() {
  drafts.clear();
  generation += 1;
}
