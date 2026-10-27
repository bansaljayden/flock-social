/**
 * THE TABLES TAB ON THE VENUE DASHBOARD.
 *
 * In the tab bar only for a venue whose Flux sensor has reported at least one
 * table, this visit or on an earlier visit this device remembers, or whose
 * plan the server refused while saying it has tables (`ownerTablesSeen` in
 * App.js), so a venue without table zones never sees it. The server checks the
 * plan on every table route; the dashboard draws the lock for its refusal and
 * repeats the Roost gate Live Sensor has, and this component renders only for
 * a plan that includes it. The data arrives as props from App.js: the tables
 * every 15 seconds while the dashboard is open, the hours once per open and
 * again while that read has failed; and, while this tab is on screen with
 * tables on the board, the walk-in waits on the tables' loop, the incoming
 * flocks once a minute, the turn-time stats once per visit and the camera's
 * looks today each time the tab opens. Each is
 * undefined, drawn as a skeleton, until the visit's first read answers.
 *
 * The tab is a stack of sections, each its own card and its own component, in
 * the order a manager reads them: tonight first (the live board, the waits at
 * the door, who is coming), then the week (tables in use by hour, turn
 * times). A section added later is one more line in the stack and changes
 * nothing above it. TablesSection is the card frame they share, and
 * useTablesClock the one clock every running figure reads.
 *
 * The four sections that only mean something with tables on the board (the
 * waits, the incoming flocks, the turn times, the camera's looks today) are drawn while the board has
 * tables, and while the visit's first read is still out, when the board is a
 * skeleton and so are they. After a read that failed or came back empty the
 * board says so alone: App.js reads none of the three without tables, so a
 * skeleton for them would wait for nothing.
 */
import React from 'react';
import TablesBoard from './TablesBoard';
import TablesByHour from './TablesByHour';
import TablesCameraLooks from './TablesCameraLooks';
import TablesIncoming from './TablesIncoming';
import TablesTurnTimes from './TablesTurnTimes';
import TablesWaits from './TablesWaits';
import useTablesClock from './useTablesClock';
import { tablesFrom } from '../../../lib/venueTables';

export default function VenueTablesTab({ data, hours, waits, incoming, stats, cameraLooks, colors, wellPx, timeZone }) {
  const live = tablesFrom(data).length > 0;
  const pending = data === undefined;
  const now = useTablesClock(live);
  return (
    <>
      <TablesBoard data={data} colors={colors} now={now} timeZone={timeZone} />
      {(live || pending) && <TablesWaits waits={pending ? undefined : waits} colors={colors} now={now} />}
      {live && <TablesIncoming incoming={incoming} colors={colors} now={now} timeZone={timeZone} />}
      <TablesByHour hours={hours} colors={colors} wellPx={wellPx} timeZone={timeZone} />
      {(live || pending) && <TablesTurnTimes stats={pending ? undefined : stats} colors={colors} />}
      {(live || pending) && <TablesCameraLooks looks={pending ? undefined : cameraLooks} colors={colors} timeZone={timeZone} />}
    </>
  );
}
