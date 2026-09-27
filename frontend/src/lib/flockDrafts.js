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

const keyFor = (accountId, flockId) => `${accountId}:${flockId}`;

/** What this account last left in this plan's box, or ''. */
export function readFlockDraft(accountId, flockId) {
  if (accountId == null || flockId == null) return '';
  return drafts.get(keyFor(accountId, flockId)) || '';
}

/** File a draft under its account and plan. An empty one removes the entry. */
export function keepFlockDraft(accountId, flockId, text) {
  if (accountId == null || flockId == null) return;
  if (text) drafts.set(keyFor(accountId, flockId), text);
  else drafts.delete(keyFor(accountId, flockId));
}

/** Every draft on the device, gone. Called by api.js clearLocalSession. */
export function clearFlockDrafts() {
  drafts.clear();
}
