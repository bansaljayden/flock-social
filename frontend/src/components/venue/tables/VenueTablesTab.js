/**
 * THE TABLES TAB ON THE VENUE DASHBOARD.
 *
 * In the tab bar only for a venue whose Flux sensor has reported at least one
 * table, this visit or on an earlier visit this device remembers, or whose
 * plan the server refused while saying it has tables (`ownerTablesSeen` in
 * App.js), so a venue without table zones never sees it. The server checks the
 * plan on both table routes; the dashboard draws the lock for its refusal and
 * repeats the Roost gate Live Sensor has, and this component renders only for
 * a plan that includes it. The data arrives as props from App.js: the tables
 * every 15 seconds while the dashboard is open, the hours once per open and
 * again while that read has failed; both undefined, drawn as skeletons, until
 * the visit's first read answers.
 *
 * The tab is a stack of sections, each its own card and its own component, in
 * the order a manager reads them: the live board first, then the week by hour.
 * A section added later is one more line at the end of the stack and changes
 * nothing above it. TablesSection is the card frame they share.
 */
import React from 'react';
import TablesBoard from './TablesBoard';
import TablesByHour from './TablesByHour';

export default function VenueTablesTab({ data, hours, colors, wellPx, timeZone }) {
  return (
    <>
      <TablesBoard data={data} colors={colors} />
      <TablesByHour hours={hours} colors={colors} wellPx={wellPx} timeZone={timeZone} />
    </>
  );
}
