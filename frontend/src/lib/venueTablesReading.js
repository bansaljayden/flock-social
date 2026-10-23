// READING A VENUE'S TABLES WHILE ITS OWNER HAS THE DASHBOARD OPEN.
//
// GET /api/sensors/:placeId/tables answers the venue's verified owner with the
// Flux sensor's tables now; GET /api/sensors/:placeId/tables/hours with tables
// in use by hour over the last 7 days. App.js reads the first on a loop while
// the dashboard is open and the second once per open, again every few minutes
// while it has failed, and hands both to the dashboard's Tables tab
// (components/venue/tables/, whose words and arithmetic are
// lib/venueTables.js).
//
// This file is apart from lib/venueTables.js on purpose. App.js is in the
// bundle every user downloads and imports this; the tab's words and chart
// code are needed only by the dashboard's own lazily loaded chunk.

import { lsGet, lsRemove, lsSet } from './storage';

// How long after one answer the next read goes out.
export const TABLES_READ_EVERY_MS = 15 * 1000;

// THE PLACE WHOSE TABLES THIS DEVICE HAS SEEN.
//
// The Tables tab used to enter the bar only when a visit's first read came
// back with a table, so on every open the bar drew six tabs, then seven a
// round trip later, with Map through Settings each moving one slot right
// under the owner's thumb, and a dashboard reopened on Tables was sent back
// to Analytics every time. So the place is remembered here, and the next open
// shows the tab from the first paint with a skeleton under it until the read
// answers. One place, under a flock* key: the sign-out sweep in services/api.js
// removes it with the rest of the account, so it never reaches another
// account on the same phone. localStorage can be unavailable (Safari with
// cookies blocked, a full quota, a private window), and lib/storage.js turns
// every such failure into "not remembered", which is the old behaviour.
//
// Cosmetic only, like every gate on this side: the tab's body is still what
// the server answers, and the first answer corrects the memory. A read that
// says the venue has no tables now (an empty list, since the server drops a
// unit's tables after 10 minutes without them; a refusal) forgets the place.
const TABLES_SEEN_KEY = 'flock_venue_tables_place';

// Whether the tables of `placeId` have been seen on this device, or, before
// the dashboard knows its place (the profile read is still out on a cold
// launch), whether any place has: an owner has one venue, so the tab is drawn
// for it from the first paint and taken away only if the profile then names
// another place.
export const tablesRemembered = (placeId) => {
  const stored = lsGet(TABLES_SEEN_KEY);
  if (!stored) return false;
  return placeId === null || placeId === undefined || stored === String(placeId);
};

export const rememberTables = (placeId) => {
  if (placeId === null || placeId === undefined || placeId === '') return;
  lsSet(TABLES_SEEN_KEY, String(placeId));
};

// Forgets `placeId`, and leaves a memory of another place alone.
export const forgetTables = (placeId) => {
  const stored = lsGet(TABLES_SEEN_KEY);
  if (stored && (placeId === null || placeId === undefined || stored === String(placeId))) lsRemove(TABLES_SEEN_KEY);
};

// Answers that asking again cannot change: 401 once signed out, 403 for anyone
// but the verified owner or for a plan below Roost, 404 where the server has
// no tables for the place. One 403 is not on this list in effect: the one the
// server sends when it could not look the plan up (planCheckFailed below).
const TABLES_REFUSALS = [401, 403, 404];

// The plan refusal, for a venue that does have tables. Below Roost both table
// routes answer the requirePro 403, UPGRADE_REQUIRED, and add `has_tables`, so
// the dashboard can show such a venue the tab with its lock and show nothing to
// a venue without tables. api.js puts the code on err.code and the body on
// err.data.
export const planLockedWithTables = (err) => !!err
  && err.status === 403
  && err.code === 'UPGRADE_REQUIRED'
  && !!err.data
  && err.data.has_tables === true;

// The 403 that asking again can change. When the plan lookup itself fails the
// gate answers 403 with the same UPGRADE_REQUIRED code and adds
// reason ENTITLEMENT_UNAVAILABLE and retryable true (backend
// services/venueEntitlements.js, tierUnavailableRefusal), so a venue that is
// paying is never told it is not. That is a failure to ask again on the next
// turn, like a 500, not a refusal; loadIncomingFlocks in App.js and
// VenueAdvisorChat read it the same way.
export const planCheckFailed = (err) => !!err
  && err.status === 403
  && !!err.data
  && (err.data.reason === 'ENTITLEMENT_UNAVAILABLE' || err.data.retryable === true);

// Reads the tables now and again `everyMs` after each answer, until the
// function it returns is called. The next read is set only once the last one
// has answered, so two never overlap and a slow answer pushes the next read
// back instead of stacking requests behind it. Nothing is handed on after the
// stop. Each answer is handed on as (data, { planLocked, refused }): the
// data, or null for any failure; planLocked only for the plan refusal of a
// venue with tables; refused when no further read will come. A dropped
// connection, a server error or a plan check that could not run is asked
// again on the next turn, and a refusal ends the reading.
export function startTablesReading(read, onData, everyMs = TABLES_READ_EVERY_MS) {
  let stopped = false;
  let timer = null;
  const turn = () => {
    new Promise((resolve) => resolve(read()))
      .then(
        (data) => ({ data: data && Array.isArray(data.tables) ? data : null, refused: false, planLocked: false }),
        (err) => ({
          data: null,
          refused: TABLES_REFUSALS.includes(err && err.status) && !planCheckFailed(err),
          planLocked: planLockedWithTables(err),
        }),
      )
      .then(({ data, refused, planLocked }) => {
        if (stopped) return;
        onData(data, { planLocked, refused });
        if (!refused) timer = setTimeout(turn, everyMs);
      });
  };
  turn();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

// What the dashboard holds after each answer, from what it held before.
//
// A good answer is shown as it came, stamped with when it arrived (readAt),
// which is the moment every clock on the board describes. A failed read that
// will be asked again KEEPS the last good answer, marked unrefreshed: the
// board then dims it, freezes its clocks at readAt and says it could not
// refresh, instead of wiping every tile for the 15 seconds until the next
// turn, which on a host stand's patchy Wi-Fi was a board that flickered. The
// same rule the dashboard's lists follow: a failed refresh does not delete
// what the owner can already see. A refusal shows nothing, since no further
// read will come and what was shown would never update again. An empty list
// is a good answer and replaces the old tiles like any other.
export function nextTablesState(prev, data, refused, nowMs = Date.now()) {
  if (data) return { ...data, readAt: nowMs };
  if (refused || !prev || !Array.isArray(prev.tables)) return null;
  return prev.unrefreshed === true ? prev : { ...prev, unrefreshed: true };
}

// The hours list out of GET .../tables/hours, or null for anything else.
export const tableHoursFrom = (data) => (data && Array.isArray(data.hours) ? data.hours : null);

// How many tables answers go by before a failed hours read is asked again:
// 20 turns of 15 seconds, about five minutes.
export const TABLE_HOURS_RETRY_EVERY_TURNS = 20;

// Reads the hours once now and, for as long as the last hours read failed,
// again after every `everyTurns` tables answers (turn() is called on each
// good one), until one succeeds. One hours read is out at a time. Each
// answer is handed to onHours as the list, or null for a failure, which the
// tab says in its card instead of hiding the chart; a failure at open used to
// hide it for the rest of the visit with nothing asking again. stop() drops a
// late answer. Returns { turn, stop }.
export function startTableHoursReading(read, onHours, everyTurns = TABLE_HOURS_RETRY_EVERY_TURNS) {
  let stopped = false;
  let out = false;
  let failed = false;
  let turns = 0;
  const go = () => {
    out = true;
    turns = 0;
    new Promise((resolve) => resolve(read()))
      .then(tableHoursFrom, () => null)
      .then((hours) => {
        out = false;
        if (stopped) return;
        failed = hours === null;
        onHours(hours);
      });
  };
  go();
  return {
    turn: () => {
      turns += 1;
      if (failed && !out && turns >= everyTurns) go();
    },
    stop: () => { stopped = true; },
  };
}
