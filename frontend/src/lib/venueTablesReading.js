// READING A VENUE'S TABLES WHILE ITS OWNER HAS THE DASHBOARD OPEN.
//
// GET /api/sensors/:placeId/tables answers the venue's verified owner with the
// Flux sensor's tables now; GET /api/sensors/:placeId/tables/hours with tables
// in use by hour over the last 7 days. App.js reads the first on a loop while
// the dashboard is open and the second once per open, and hands both to the
// dashboard's Tables tab (components/venue/tables/, whose words and arithmetic
// are lib/venueTables.js).
//
// This file is apart from lib/venueTables.js on purpose. App.js is in the
// bundle every user downloads and imports this; the tab's words and chart
// code are needed only by the dashboard's own lazily loaded chunk.

// How long after one answer the next read goes out.
export const TABLES_READ_EVERY_MS = 15 * 1000;

// Answers that asking again cannot change: 401 once signed out, 403 for anyone
// but the verified owner or for a plan below Roost, 404 where the server has
// no tables for the place.
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

// Reads the tables now and again `everyMs` after each answer, until the
// function it returns is called. The next read is set only once the last one
// has answered, so two never overlap and a slow answer pushes the next read
// back instead of stacking requests behind it. Nothing is handed on after the
// stop. Each answer is handed on as (data, { planLocked }): the data, or null
// for any failure; planLocked only for the plan refusal of a venue with
// tables. A dropped connection or a server error is asked again on the next
// turn, and a refusal of any kind ends the reading.
export function startTablesReading(read, onData, everyMs = TABLES_READ_EVERY_MS) {
  let stopped = false;
  let timer = null;
  const turn = () => {
    new Promise((resolve) => resolve(read()))
      .then(
        (data) => ({ data: data && Array.isArray(data.tables) ? data : null, refused: false, planLocked: false }),
        (err) => ({ data: null, refused: TABLES_REFUSALS.includes(err && err.status), planLocked: planLockedWithTables(err) }),
      )
      .then(({ data, refused, planLocked }) => {
        if (stopped) return;
        onData(data, { planLocked });
        if (!refused) timer = setTimeout(turn, everyMs);
      });
  };
  turn();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

// The hours list out of GET .../tables/hours, or null for anything else.
export const tableHoursFrom = (data) => (data && Array.isArray(data.hours) ? data.hours : null);
