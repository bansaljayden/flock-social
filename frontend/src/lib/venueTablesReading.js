// READING A VENUE'S TABLES WHILE ITS OWNER HAS THE DASHBOARD OPEN.
//
// GET /api/sensors/:placeId/tables answers the venue's verified owner with the
// Flux sensor's tables now; GET /api/sensors/:placeId/tables/hours with tables
// in use by hour over the last 7 days. App.js reads the first on a loop while
// the dashboard is open and the second once per open, and hands both to the
// Tables panel (components/venue/VenueTablesPanel.js, whose words and
// arithmetic are lib/venueTables.js).
//
// This file is apart from lib/venueTables.js on purpose. App.js is in the
// bundle every user downloads and imports this; the panel's words and chart
// code are needed only by the dashboard's own lazily loaded chunk.

// How long after one answer the next read goes out.
export const TABLES_READ_EVERY_MS = 15 * 1000;

// Answers that asking again cannot change: 401 once signed out, 403 for anyone
// but the verified owner, 404 where the server has no tables for the place.
const TABLES_REFUSALS = [401, 403, 404];

// Reads the tables now and again `everyMs` after each answer, until the
// function it returns is called. The next read is set only once the last one
// has answered, so two never overlap and a slow answer pushes the next read
// back instead of stacking requests behind it. Nothing is handed on after the
// stop. Any failure is handed on as null, which the panel draws as nothing; a
// dropped connection or a server error is asked again on the next turn, and a
// refusal ends the reading.
export function startTablesReading(read, onData, everyMs = TABLES_READ_EVERY_MS) {
  let stopped = false;
  let timer = null;
  const turn = () => {
    new Promise((resolve) => resolve(read()))
      .then(
        (data) => ({ data: data && Array.isArray(data.tables) ? data : null, refused: false }),
        (err) => ({ data: null, refused: TABLES_REFUSALS.includes(err && err.status) }),
      )
      .then(({ data, refused }) => {
        if (stopped) return;
        onData(data);
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
