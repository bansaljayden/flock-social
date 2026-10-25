// TABLE AVAILABILITY FOR THE PEOPLE CHOOSING A VENUE.
//
// A venue whose Flux sensor watches its tables answers two routes for any
// signed-in person (services/api.js getTableSummary and getTableSummaries):
//
//   GET  /api/sensors/:placeId/tables/summary?party=N
//   POST /api/sensors/tables/summaries { place_ids: [up to 50], party }
//
// Each place comes back as { open, total, party, fits_now, wait_minutes,
// busy_hours: [{ dow, hour }], timeZone, updated_at, stale }: fits_now is
// true, false, or null when tables are open and no open table's fit for the
// party is known; timeZone is the venue's IANA zone, or null when the server
// does not know it and the busy hours are UTC. That is the whole of what a
// group is told: whether a table for their number is open, roughly how long
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
//     POST's silence both mean "no data", are remembered for the same minute
//     under the place itself (the server decides absence before it looks at
//     the party, so a Group chip change asks nothing new), and render
//     nothing: most venues have no sensor, and that is not a failure to show.
//   * Nothing is kept past five minutes. An answer that old is not read, and
//     each batch of writes drops what has aged out, so the cache holds the
//     places seen lately and not every place a session ever showed.
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
// remembered "no data" answer. The stores are const and emptied in place,
// never swapped: the per-chunk closures in flush() read them, and a closure
// in a loop over a reassignable binding is the no-loop-func warning the build
// treats as an error.
const cache = new Map();
// placeId -> ms of the last "no data" answer for the place: the GET's 404 or
// the POST's silence. The server decides absence (no fresh floor, tables
// hidden) before it looks at the party, so one such answer stands for every
// party: the venue sheet cycling its Group chips over a venue with no sensor
// asks once, not once per chip. A real answer for the place clears it.
const noData = new Map();
// Keys with a request out, so a second ask for the same place joins it.
const inFlight = new Set();
// Place ids asked for this tick, per party, sent together on the next flush.
const pending = new Map();
let flushTimer = null;
let flushWaiters = [];
// fn -> the cache keys it watches. A write calls only the listeners watching
// a key it wrote, so a surface showing other places (a Discover tab parked
// behind the chat, say) is not rendered for an answer that was not about it.
const listeners = new Map();

const keyOf = (placeId, party) => `${party}|${placeId}`;

// services/api.js is mocked with explicit factories in many suites, and a
// factory that does not list these readers hands over undefined for them. A
// screen that merely shows a venue must not crash on that, and "cannot ask"
// is exactly what signed out already means here.
const canAsk = () => typeof isLoggedIn === 'function' && !!isLoggedIn()
  && typeof getTableSummaries === 'function' && typeof getTableSummary === 'function';

const now = () => Date.now();

// Tells the listeners watching any of `keys` (cache keys) that it was written.
function notify(keys) {
  const changed = keys instanceof Set ? keys : new Set(keys);
  if (changed.size === 0) return;
  listeners.forEach((watched, fn) => {
    const [few, many] = changed.size <= watched.size ? [changed, watched] : [watched, changed];
    for (const key of few) {
      if (many.has(key)) {
        try { fn(); } catch { /* a listener's own problem */ }
        break;
      }
    }
  });
}

function write(placeId, party, summary, at = now()) {
  const ok = usableSummary(summary);
  cache.set(keyOf(placeId, party), { summary: ok ? summary : null, at });
  if (ok) noData.delete(placeId);
  else noData.set(placeId, at);
}

// Entries past TABLE_SUMMARY_KEEP_MS are already unreadable; dropped, so an
// evening of panning a city does not keep every place id ever shown. Run once
// per batch of writes. Ids on a mounted surface are rewritten every minute,
// so nothing a surface is showing is ever swept.
function sweep() {
  const cutoff = now() - TABLE_SUMMARY_KEEP_MS;
  cache.forEach((entry, key) => { if (entry.at < cutoff) cache.delete(key); });
  noData.forEach((at, placeId) => { if (at < cutoff) noData.delete(placeId); });
}

// Whether the place was answered recently enough to skip asking again: its
// own party's answer, or a "no data" for the place under any party.
function isFresh(placeId, party, slackMs = 0) {
  const limit = TABLE_SUMMARY_FRESH_MS - slackMs;
  const none = noData.get(placeId);
  if (none !== undefined && now() - none < limit) return true;
  const entry = cache.get(keyOf(placeId, party));
  return !!entry && now() - entry.at < limit;
}

// Calls `fn` after a write to any of the places in `placeIds` under `party`.
// Returns the unsubscribe.
export function subscribeTableSummaries(fn, placeIds, party = TABLE_PARTY_DEFAULT) {
  const p = clampParty(party);
  listeners.set(fn, new Set(distinctPlaceIds(placeIds).map((id) => keyOf(id, p))));
  return () => { listeners.delete(fn); };
}

// The cached summary for a place: the object, null for a remembered "no
// data" (the place's own, under any party), undefined when nothing has been
// asked or the answer has aged out.
export function readTableSummary(placeId, party = TABLE_PARTY_DEFAULT) {
  const entry = cache.get(keyOf(placeId, clampParty(party)));
  if (entry && now() - entry.at <= TABLE_SUMMARY_KEEP_MS) return entry.summary;
  const none = noData.get(placeId);
  if (none !== undefined && now() - none <= TABLE_SUMMARY_KEEP_MS) return null;
  return undefined;
}

// Tests only: how many answers the cache is holding.
export function tableSummaryCacheSizeForTests() {
  return cache.size + noData.size;
}

// The summaries a list can draw now: { [placeId]: summary } for the places
// with one. Absent and unknown places are simply not keys.
export function readTableSummaries(placeIds, party = TABLE_PARTY_DEFAULT) {
  const entries = [];
  for (const id of distinctPlaceIds(placeIds)) {
    const s = readTableSummary(id, party);
    if (s) entries.push([id, s]);
  }
  return Object.fromEntries(entries);
}

// Sends everything queued, one POST per party per fifty ids. Resolves once
// every POST has settled; callers that only wanted the ask sent ignore it.
async function flush() {
  flushTimer = null;
  sweep();
  const batches = new Map(pending);
  pending.clear();
  const waiters = flushWaiters;
  flushWaiters = [];
  const sends = [];
  const written = new Set();
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
            chunk.forEach((id) => {
              write(id, party, Object.prototype.hasOwnProperty.call(got, id) ? got[id] : null, at);
              written.add(keyOf(id, party));
            });
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
  notify(written);
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
  sweep();
  return Promise.resolve()
    .then(() => getTableSummary(placeId, p))
    .then((data) => { write(placeId, p, data); notify([key]); })
    .catch((err) => {
      if (err && err.status === 404) { write(placeId, p, null); notify([key]); }
    })
    .finally(() => { inFlight.delete(key); });
}

// ---- the hooks ------------------------------------------------------------
//
// Both read through React.useSyncExternalStore, for two reasons:
//
//   * The snapshot is read again right after the subscription is made and
//     compared with the one the render used. The subscription is a passive
//     effect and a POST or GET from another surface can resolve between the
//     render and it; a listener attached by hand missed that write, found
//     its own ids fresh, sent nothing, and drew nothing for a minute.
//   * A snapshot that did not change is the same object, so React skips the
//     render and whatever hangs off the object (MapLibreMapView under
//     React.memo, its pass over every standing pin) stays put.
//
// A hook that is not `enabled` does not subscribe at all. A parked Discover
// tab keeps whatever it last drew; shown again, the subscribe function
// changes with `enabled`, React subscribes anew and reads the cache fresh.

const noop = () => {};

// Same lines: every place maps to the same summary object.
function sameEntries(a, b) {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && kb.every((k) => a[k] === b[k]);
}

// The summaries for a list of places, asked for as one POST now and again
// every minute while the caller is mounted and `enabled`. Returns
// { [placeId]: summary } for the places that have one, so a surface draws a
// line for a venue exactly when its id is a key. `enabled` false (a parked
// Discover tab, a signed out page) asks nothing and keeps whatever is cached.
export function useTableSummaries(placeIds, party = TABLE_PARTY_DEFAULT, enabled = true) {
  const p = clampParty(party);
  // The ids as one string, so a list that re-renders with the same places
  // does not restart the minute or resubscribe.
  const idsKey = distinctPlaceIds(placeIds).join('\n');
  const lastRef = React.useRef({});
  const getSnapshot = React.useCallback(() => {
    const next = readTableSummaries(idsKey ? idsKey.split('\n') : [], p);
    if (sameEntries(lastRef.current, next)) return lastRef.current;
    lastRef.current = next;
    return next;
  }, [idsKey, p]);
  const subscribe = React.useCallback((onChange) => {
    if (!enabled || !idsKey) return noop;
    return subscribeTableSummaries(onChange, idsKey.split('\n'), p);
  }, [idsKey, p, enabled]);
  const out = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  React.useEffect(() => {
    if (!enabled || !idsKey) return undefined;
    const ids = idsKey.split('\n');
    requestTableSummaries(ids, p);
    const timer = setInterval(() => {
      // Expiry must repaint even when a refresh fails or remains in flight.
      notify(ids.map((placeId) => keyOf(placeId, p)));
      requestTableSummaries(ids, p, { refresh: true });
    }, TABLE_SUMMARY_FRESH_MS);
    return () => clearInterval(timer);
  }, [idsKey, p, enabled]);
  return out;
}

// The summary for one place, by the GET, refreshed each minute while mounted.
// The summary object, or null when the venue has no table data or nothing
// has answered yet: either way the caller draws nothing.
export function useTableSummary(placeId, party = TABLE_PARTY_DEFAULT, enabled = true) {
  const p = clampParty(party);
  const id = usableId(placeId) ? placeId : null;
  const getSnapshot = React.useCallback(() => (id ? (readTableSummary(id, p) || null) : null), [id, p]);
  const subscribe = React.useCallback((onChange) => {
    if (!enabled || !id) return noop;
    return subscribeTableSummaries(onChange, [id], p);
  }, [id, p, enabled]);
  const out = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  React.useEffect(() => {
    if (!enabled || !id) return undefined;
    requestTableSummary(id, p);
    const timer = setInterval(() => {
      notify([keyOf(id, p)]);
      requestTableSummary(id, p, { refresh: true });
    }, TABLE_SUMMARY_FRESH_MS);
    return () => clearInterval(timer);
  }, [id, p, enabled]);
  return out;
}

// Tests only: an answer written straight into the cache, as a request's
// would be, so a test can land one at a chosen moment.
export function seedTableSummaryForTests(placeId, party, summary) {
  const p = clampParty(party);
  write(placeId, p, summary);
  notify([keyOf(placeId, p)]);
}

// Tests only: back to nothing known and nothing queued.
export function resetTableSummariesForTests() {
  cache.clear();
  noData.clear();
  inFlight.clear();
  pending.clear();
  if (flushTimer !== null) clearTimeout(flushTimer);
  flushTimer = null;
  flushWaiters = [];
  listeners.clear();
}
