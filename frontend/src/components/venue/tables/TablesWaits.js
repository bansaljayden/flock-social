/**
 * WALK-IN WAITS: WHAT TO TELL A PARTY AT THE DOOR.
 *
 * The second section of the Tables tab, under the board. One line per party
 * size the server estimates for (2, 4, 6 and 8): a table is open now, or
 * about how long and which table comes up next, or nothing fits right now.
 * The minutes are the server's estimate from its turn history, so the line
 * says "about"; the words are waitText in lib/venueTables.js.
 *
 * Read on the tables' own 15-second loop while the tab is open (App.js), so
 * the waits and the board describe the same room. Handled like the board:
 * a skeleton while the first read is out; one line when a read failed with
 * nothing before it; while the server marks the readings stale, or the last
 * refresh failed and this is the answer before it (nextWaitsState in
 * lib/venueTablesReading.js), the rows dim under a line that says so, since
 * "a table is open now" is only as true as the reading it came from.
 */
import React from 'react';
import TablesSection, { STALE_OPACITY, SectionLine, SectionNotice, SectionSkeleton } from './TablesSection';
import { refreshLines, timeMs, waitRows, waitsStaleLines } from '../../../lib/venueTables';

export default function TablesWaits({ waits, colors, now }) {
  if (waits === undefined) return <SectionSkeleton height={150} testId="tables-waits-loading" />;
  if (waits === null) {
    return (
      <TablesSection title="Walk-in waits" colors={colors}>
        <SectionLine>Walk-in waits couldn't load.</SectionLine>
      </TablesSection>
    );
  }
  const rows = waitRows(waits);
  const stale = waits.stale === true;
  const unrefreshed = waits.unrefreshed === true && Number.isFinite(waits.readAt);
  const lines = unrefreshed ? refreshLines(waits.readAt, now) : stale ? waitsStaleLines(timeMs(waits.updated_at), now) : null;
  return (
    <TablesSection title="Walk-in waits" colors={colors}>
      {lines && <SectionNotice lines={lines} />}
      {rows.length > 0 ? (
        <ul aria-label="Walk-in waits" data-testid="tables-waits-live" style={{ listStyle: 'none', margin: 0, padding: 0, opacity: lines ? STALE_OPACITY : 1 }}>
          {rows.map((r, i) => (
            <li
              key={r.party}
              data-party={r.party}
              data-open={r.open ? 'true' : undefined}
              style={{ padding: '6px 0', borderTop: i === 0 ? 'none' : '1px solid var(--border-light)', fontSize: 'var(--t-meta)', fontWeight: r.open ? '700' : '500', color: 'var(--text-primary)', lineHeight: 1.45, minWidth: 0, overflowWrap: 'anywhere' }}
            >
              {r.text}
            </li>
          ))}
        </ul>
      ) : (
        <SectionLine>No wait estimates yet.</SectionLine>
      )}
    </TablesSection>
  );
}
