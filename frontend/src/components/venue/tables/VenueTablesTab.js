/**
 * THE TABLES TAB ON THE VENUE DASHBOARD.
 *
 * In the tab bar only for a venue whose Flux sensor has reported at least one
 * table since the dashboard opened (`ownerTablesSeen` in App.js), so a venue
 * without table zones never sees it. Inside it, the same Roost gate as Live
 * Sensor: VenueDashboard.js draws the lock, and this component only for a plan
 * that includes it. The data arrives as props from App.js: the tables every 15
 * seconds while the dashboard is open, the hours once per open.
 *
 * The tab is a stack of sections, each its own card and its own component, in
 * the order a manager reads them: the live board first, then the week by hour.
 * A section added later is one more line at the end of the stack and changes
 * nothing above it. TablesSection is the card frame they share.
 */
import React from 'react';
import TablesBoard from './TablesBoard';
import TablesByHour from './TablesByHour';

export default function VenueTablesTab({ data, hours, colors, wellPx }) {
  return (
    <>
      <TablesBoard data={data} colors={colors} />
      <TablesByHour hours={hours} colors={colors} wellPx={wellPx} />
    </>
  );
}
