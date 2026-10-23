// TABLE AVAILABILITY FOR THE PEOPLE CHOOSING A VENUE.
//
// A venue whose Flux sensor watches its tables answers two routes for any
// signed-in person (services/api.js getTableSummary and getTableSummaries):
//
//   GET  /api/sensors/:placeId/tables/summary?party=N
//   POST /api/sensors/tables/summaries { place_ids: [up to 50], party }
//
// Each place comes back as { open, total, party, fits_now, wait_minutes,
// busy_hours: [{ dow, hour }], updated_at, stale }. That is the whole of what
// a group is told: whether a table for their number is open, roughly how long
// one takes, and when the room is usually full. Never a table's own state;
// the owner's dashboard has that (lib/venueTablesReading.js) and nobody else.
//
// WHAT THIS FILE DOES. Every surface that shows a venue (a vote row, a venue
// card in the chat, a search result, a map pin, the venue sheet, the plan) asks
// here and nowhere else, so that:
//
//   * A list is ONE request. Each list hands over the place ids it is
//     showing; ids asked for in the same tick, from any number of lists, are
//     merged, deduplicated and sent as one POST (split at the route's cap of
//     fifty), not one request per row.
//   * An answer is kept for a minute. A second surface showing the same
//     venue reads the answer the first one fetched, and a surface mounted for
//     longer asks again each minute, so the line is never more than about a
//     minute behind the sensor and never costs more than one request a minute
//     per venue.
//   * A venue with no table data costs nothing twice. The GET's 404 and the
//     POST's silence both mean "no data", are remembered for the same minute,
//     and render nothing: most venues have no sensor, and that is not a
//     failure to show.
//   * Nothing goes out signed out. Both routes need a session, and a signed
//     out view of a venue (the shared invite page's map, say) has no line.
//
// The sentences the summary becomes are components/venue/TableAvailability.js.

import React from 'react';
import { getTableSummaries, getTableSummary, isLoggedIn } from '../services/api';

// How long an answer counts as fresh, which is also how often a mounted
// surface asks again.
export const TABLE_SUMMARY_FRESH_MS = 60 * 1000;
// A tick fires at TABLE_SUMMARY_FRESH_MS and the answer it refreshes landed a
// little after the tick before it, so at the tick that answer is a little
// UNDER a minute old. Without this allowance every other tick would find the
// entry fresh, skip it, and the line would refresh every two minutes.
const DUE_SLACK_MS = 2 * 1000;
// An answer older than this is not shown even when a newer one has not come:
// the sensor's own `stale` flag covers a quiet sensor, this covers a quiet
// server.
export const TABLE_SUMMARY_KEEP_MS = 5 * 60 * 1000;
// The POST accepts up to fifty place ids; longer lists go as several.
export const TABLE_SUMMARY_BATCH_MAX = 50;

// The party a line is written for when nothing says otherwise: two people,
// because a venue looked at outside any flock is being looked at by one
// person who is not going alone. The server accepts 1 to 30.
export const TABLE_PARTY_DEFAULT = 2;
export const TABLE_PARTY_MIN = 1;
export const TABLE_PARTY_MAX = 30;

// A party the server accepts, or the default when the number is not one.
export function clampParty(n) {
  const v = typeof n === 'string' && n.trim() !== '' ? Number(n) : n;
  if (typeof v !== 'number' || !Number.isFinite(v)) return TABLE_PARTY_DEFAULT;
  return Math.min(TABLE_PARTY_MAX, Math.max(TABLE_PARTY_MIN, Math.round(v)));
}

// The party for a flock: everyone who said they are going (memberCount is the
// server's going count, accounts and guests), or the default while the flock
// has no count yet. A count below two is "not yet": the host is accepted the
// moment the flock exists and the invites are still out, and a line written
// for a table for one would be about a group that does not exist. Two is the
// floor here and only here; Discover's own Group chip may still ask for one.
export function tablePartyFor(flock) {
  const count = flock ? Number(flock.memberCount) : NaN;
  if (!Number.isFinite(count) || count < TABLE_PARTY_DEFAULT) return TABLE_PARTY_DEFAULT;
  return clampParty(count);
}

// The party for Discover and the venue sheet: the flock a venue is being
// picked for when there is one (the chat's "Browse venues on Discover" sets
// it), else the default.
export function tablePartyForFlockId(flocks, flockId) {
  if (flockId === null || flockId === undefined || !Array.isArray(flocks)) return TABLE_PARTY_DEFAULT;
  const flock = flocks.find((f) => f && String(f.id) === String(flockId));
  return flock ? tablePartyFor(flock) : TABLE_PARTY_DEFAULT;
}

// A place id worth asking about: a non-empty string (Google place ids are
// strings; a numeric local id is not a place).
const usableId = (id) => typeof id === 'string' && id.length > 0;

// The places a flock is weighing: the venues in its vote tally and the venue
// cards in its stream. The flock chat asks for all of them as one request.
export function flockTablePlaceIds(flock) {
  if (!flock) return [];
  const fromVotes = (Array.isArray(flock.votes) ? flock.votes : []).map((v) => v && v.place_id);
  const fromCards = (Array.isArray(flock.messages) ? flock.messages : [])
    .filter((m) => m && m.message_type === 'venue_card' && m.venue_data)
    .map((m) => m.venue_data.place_id);
  return distinctPlaceIds([...fromVotes, ...fromCards]);
}

// Distinct usable ids, in first-seen order.
export function distinctPlaceIds(ids) {
  const out = [];
  const seen = new Set();
  for (const id of Array.isArray(ids) ? ids : []) {
    if (!usableId(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

// A summary the sentences can be written from: an object with a party and at
// least one of the figures. Anything else is treated as no data.
export function usableSummary(s) {
  return !!s && typeof s === 'object' && !Array.isArray(s)
    && (typeof s.fits_now === 'boolean' || typeof s.open === 'number' || Array.isArray(s.busy_hours));
}

// ---- the cache ------------------------------------------------------------

// `${party}|${placeId}` -> { summary: object | null, at: ms }. null is a
// remembered "no data" answer. The three stores are const and emptied in
// place, never swapped: the per-chunk closures in flush() read them, and a
// closure in a loop over a reassignable binding is the no-loop-func warning
// the build treats as an error.
const cache = new Map();
// Keys with a request out, so a second ask for the same place joins it.
const inFlight = new Set();
// Place ids asked for this tick, per party, sent together on the next flush.
const pending = new Map();
let flushTimer = null;
let flushWaiters = [];
// Bumped on every cache write; the hooks render off it.
let version = 0;
const listeners = new Set();

const keyOf = (placeId, party) => `${party}|${placeId}`;

// services/api.js is mocked with explicit factories in many suites, and a
// factory that does not list these readers hands over undefined for them. A
// screen that merely shows a venue must not crash on that, and "cannot ask"
// is exactly what signed out already means here.
const canAsk = () => typeof isLoggedIn === 'function' && !!isLoggedIn()
  && typeof getTableSummaries === 'function' && typeof getTableSummary === 'function';

const now = () => Date.now();

function notify() {
  version += 1;
  listeners.forEach((fn) => { try { fn(version); } catch { /* a listener's own problem */ } });
}

function write(placeId, party, summary, at = now()) {
  cache.set(keyOf(placeId, party), { summary: usableSummary(summary) ? summary : null, at });
}

// Whether the cached answer for a place is young enough to skip asking again.
function isFresh(placeId, party, slackMs = 0) {
  const entry = cache.get(keyOf(placeId, party));
  return !!entry && now() - entry.at < TABLE_SUMMARY_FRESH_MS - slackMs;
}

export function subscribeTableSummaries(fn) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

// The cached summary for a place: the object, null for a remembered "no
// data", undefined when nothing has been asked or the answer has aged out.
export function readTableSummary(placeId, party = TABLE_PARTY_DEFAULT) {
  const entry = cache.get(keyOf(placeId, clampParty(party)));
  if (!entry) return undefined;
  if (now() - entry.at > TABLE_SUMMARY_KEEP_MS) return undefined;
  return entry.summary;
}

// The summaries a list can draw now: { [placeId]: summary } for the places
// with one. Absent and unknown places are simply not keys.
export function readTableSummaries(placeIds, party = TABLE_PARTY_DEFAULT) {
  const out = {};
  for (const id of distinctPlaceIds(placeIds)) {
    const s = readTableSummary(id, party);
    if (s) out[id] = s;
  }
  return out;
}

// Sends everything queued, one POST per party per fifty ids. Resolves once
// every POST has settled; callers that only wanted the ask sent ignore it.
async function flush() {
  flushTimer = null;
  const batches = new Map(pending);
  pending.clear();
  const waiters = flushWaiters;
  flushWaiters = [];
  const sends = [];
  batches.forEach((ids, party) => {
    const list = Array.from(ids);
    for (let i = 0; i < list.length; i += TABLE_SUMMARY_BATCH_MAX) {
      const chunk = list.slice(i, i + TABLE_SUMMARY_BATCH_MAX);
      chunk.forEach((id) => inFlight.add(keyOf(id, party)));
      sends.push(
        Promise.resolve()
          .then(() => getTableSummaries(chunk, party))
          .then((data) => {
            const got = data && typeof data === 'object' && data.summaries && typeof data.summaries === 'object' ? data.summaries : {};
            const at = now();
            // Every id asked for gets an entry: the ones the server named with
            // their summary, the rest as a remembered "no data".
            chunk.forEach((id) => write(id, party, Object.prototype.hasOwnProperty.call(got, id) ? got[id] : null, at));
          })
          // A failed read leaves what was known in place (readTableSummary
          // ages it out) and is asked again at the next tick. A line that
          // comes and goes with the network would be worse than one a minute
          // behind.
          .catch(() => {})
          .finally(() => { chunk.forEach((id) => inFlight.delete(keyOf(id, party))); }),
      );
    }
  });
  await Promise.all(sends);
  if (sends.length > 0) notify();
  waiters.forEach((resolve) => resolve());
}

function scheduleFlush() {
  if (flushTimer !== null) return;
  flushTimer = setTimeout(() => { flush(); }, 0);
}

// Asks for the places a list is showing. Ids answered within the minute and
// ids already on their way are left out; the rest join this tick's POST.
// `refresh` marks the ask as a timed one, which treats an answer about to
// turn a minute old as due (DUE_SLACK_MS says why). Resolves when the POST
// this ask joined has settled, or at once when nothing needed sending.
export function requestTableSummaries(placeIds, party = TABLE_PARTY_DEFAULT, { refresh = false } = {}) {
  if (!canAsk()) return Promise.resolve();
  const p = clampParty(party);
  const due = distinctPlaceIds(placeIds).filter((id) => !inFlight.has(keyOf(id, p)) && !isFresh(id, p, refresh ? DUE_SLACK_MS : 0));
  if (due.length === 0) return Promise.resolve();
  if (!pending.has(p)) pending.set(p, new Set());
  const set = pending.get(p);
  due.forEach((id) => set.add(id));
  scheduleFlush();
  return new Promise((resolve) => { flushWaiters.push(resolve); });
}

// Asks for one place by the GET, for a surface that shows one venue (the
// venue sheet, the plan). Same cache, same minute, and its 404 is the
// remembered "no data" the POST's silence is.
export function requestTableSummary(placeId, party = TABLE_PARTY_DEFAULT, { refresh = false } = {}) {
  if (!canAsk() || !usableId(placeId)) return Promise.resolve();
  const p = clampParty(party);
  const key = keyOf(placeId, p);
  if (inFlight.has(key) || isFresh(placeId, p, refresh ? DUE_SLACK_MS : 0)) return Promise.resolve();
  inFlight.add(key);
  return Promise.resolve()
    .then(() => getTableSummary(placeId, p))
    .then((data) => { write(placeId, p, data); notify(); })
    .catch((err) => {
      if (err && err.status === 404) { write(placeId, p, null); notify(); }
    })
    .finally(() => { inFlight.delete(key); });
}

// ---- the hooks ------------------------------------------------------------

// Re-renders the caller whenever the cache changes, and nothing else.
function useCacheVersion() {
  const [, setSeen] = React.useState(version);
  React.useEffect(() => subscribeTableSummaries((v) => setSeen(v)), []);
  return version;
}

// The summaries for a list of places, asked for as one POST now and again
// every minute while the caller is mounted and `enabled`. Returns
// { [placeId]: summary } for the places that have one, so a surface draws a
// line for a venue exactly when its id is a key. `enabled` false (a parked
// Discover tab, a signed out page) asks nothing and keeps whatever is cached.
export function useTableSummaries(placeIds, party = TABLE_PARTY_DEFAULT, enabled = true) {
  const p = clampParty(party);
  const ids = distinctPlaceIds(placeIds);
  // The ids as one string, so a list that re-renders with the same places
  // does not restart the minute.
  const idsKey = ids.join('\n');
  const v = useCacheVersion();
  React.useEffect(() => {
    if (!enabled || ids.length === 0) return undefined;
    requestTableSummaries(ids, p);
    const timer = setInterval(() => { requestTableSummaries(ids, p, { refresh: true }); }, TABLE_SUMMARY_FRESH_MS);
    return () => clearInterval(timer);
    // ids is derived from idsKey, which is the dependency that stands for it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey, p, enabled]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return React.useMemo(() => readTableSummaries(ids, p), [idsKey, p, v]);
}

// The summary for one place, by the GET, refreshed each minute while mounted.
// The summary object, or null when the venue has no table data or nothing
// has answered yet: either way the caller draws nothing.
export function useTableSummary(placeId, party = TABLE_PARTY_DEFAULT, enabled = true) {
  const p = clampParty(party);
  const id = usableId(placeId) ? placeId : null;
  useCacheVersion();
  React.useEffect(() => {
    if (!enabled || !id) return undefined;
    requestTableSummary(id, p);
    const timer = setInterval(() => { requestTableSummary(id, p, { refresh: true }); }, TABLE_SUMMARY_FRESH_MS);
    return () => clearInterval(timer);
  }, [id, p, enabled]);
  return id ? (readTableSummary(id, p) || null) : null;
}

// Tests only: back to nothing known and nothing queued.
export function resetTableSummariesForTests() {
  cache.clear();
  inFlight.clear();
  pending.clear();
  if (flushTimer !== null) clearTimeout(flushTimer);
  flushTimer = null;
  flushWaiters = [];
  listeners.clear();
}
