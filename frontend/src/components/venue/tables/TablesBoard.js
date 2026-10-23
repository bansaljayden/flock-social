/**
 * RIGHT NOW: EVERY TABLE ON THE SENSOR, LIVE.
 *
 * The first section of the Tables tab. What a manager reads, top to bottom:
 *   - "3 of 8 free", or, once no table reading has come for 3 minutes, how
 *     long that has been and what the last reading saw. The board then keeps
 *     that reading, dimmed, with every clock stopped where the readings left
 *     it. Not "offline": the server's stale flag also covers a box that is on
 *     and sending readings with no tables in them, and the Live Sensor card
 *     on Analytics may be calling the same box online.
 *   - The tables that need someone, longest first.
 *   - The table likely to free up next (nextFreePick in lib/venueTables.js),
 *     with the server's estimate of when ("likely free around 8:10 PM") when
 *     the table carries one, else how long its party has sat. The time is on
 *     the venue's clock when the dashboard has its zone, else this device's,
 *     and a line under the tiles says which whenever a time is printed.
 *   - One tile per table, in number order, with its state in words, so no
 *     state rests on colour alone: free is green, seated red, needs clearing a
 *     pale yellow with a dashed edge, and a party nobody has stopped by for is
 *     solid amber, the loudest thing on the tab. A table whose seat count the
 *     sensor's setup knows says it ("4 seats").
 *
 * The tab exists once a read has returned a table, this visit or on an earlier
 * one on this device (App.js remembers the place), so the board is a skeleton
 * while the visit's first read is out, and when a read fails or comes back
 * empty it says so in one line rather than leaving the tab blank. A failed
 * read that will be asked again arrives
 * as the reading before it, marked unrefreshed (nextTablesState in
 * lib/venueTablesReading.js): the board keeps it, dimmed, clocks stopped at
 * the moment it arrived, under "Couldn't refresh just now." An empty list is
 * a real answer (the server drops a unit's tables once it has stopped sending
 * them for 10 minutes), so it clears the board: no tile from an earlier
 * reading stays up as if live.
 *
 * One clock drives every running figure on the tab (`now`, from
 * useTablesClock in VenueTablesTab), so the tiles tick together and there is
 * one timer to clear when the tab goes. The words and arithmetic are
 * lib/venueTables.js.
 */
import React from 'react';
import TablesSection, { STALE_OPACITY } from './TablesSection';
import {
  TABLE_STATE_WORDS,
  clockIn,
  clockWords,
  freeSummary,
  nextFreeLine,
  peopleText,
  refreshLines,
  seatsText,
  staleLines,
  tableAlerts,
  tablesFrom,
  tileClockSpoken,
  tileTimeText,
  timeMs,
} from '../../../lib/venueTables';

// The waiting tile is filled with the palette's amber (colors.amber), which is
// the same #F59E0B in both themes, so the type on it is one dark ink in both
// themes too: 6.81:1 on that fill. A theme token would turn cream after dark
// and sink into the amber.
const ON_AMBER_INK = '#1e293b';

function tileLook(state, colors) {
  if (state === 'waiting') {
    return {
      background: colors.amber,
      border: '2px solid var(--accent-amber-text)',
      word: ON_AMBER_INK,
      ink: ON_AMBER_INK,
      sub: ON_AMBER_INK,
    };
  }
  if (state === 'needs_clearing') {
    return {
      background: 'var(--accent-amber-bg)',
      border: '2px dashed var(--accent-amber-text)',
      word: 'var(--accent-amber-text)',
      ink: 'var(--text-primary)',
      sub: 'var(--text-secondary)',
    };
  }
  if (state === 'seated') {
    return {
      background: 'var(--accent-red-bg)',
      border: '2px solid transparent',
      word: 'var(--accent-red-text)',
      ink: 'var(--text-primary)',
      sub: 'var(--text-secondary)',
    };
  }
  return {
    background: 'var(--accent-green-bg)',
    border: '2px solid transparent',
    word: 'var(--accent-green-text)',
    ink: 'var(--text-primary)',
    sub: 'var(--text-secondary)',
  };
}

// The small square before an alert, drawn like the tile it points at.
function alertMarker(state, colors) {
  const waiting = state === 'waiting';
  return {
    flexShrink: 0,
    width: '10px',
    height: '10px',
    marginTop: '3px',
    borderRadius: '2px',
    boxSizing: 'border-box',
    backgroundColor: waiting ? colors.amber : 'var(--accent-amber-bg)',
    border: `2px ${waiting ? 'solid' : 'dashed'} var(--accent-amber-text)`,
  };
}

function TableTile({ table, clockAt, colors }) {
  const look = tileLook(table.state, colors);
  const counting = table.state === 'seated' || table.state === 'waiting';
  const timeLine = tileTimeText(table, clockAt);
  const people = counting ? peopleText(table.people) : null;
  const seats = seatsText(table.seats);
  return (
    <li
      data-state={table.state}
      style={{ minWidth: 0, boxSizing: 'border-box', padding: '10px', borderRadius: '10px', backgroundColor: look.background, border: look.border, overflowWrap: 'anywhere' }}
    >
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', justifyContent: 'space-between', columnGap: '6px' }}>
        <p style={{ fontSize: 'var(--t-label)', fontWeight: '600', color: look.ink, margin: 0 }}>Table {table.number}</p>
        {seats && <p style={{ fontSize: 'var(--t-meta)', color: look.sub, margin: 0 }}>{seats}</p>}
      </div>
      <p data-testid="table-state" style={{ fontSize: 'var(--t-meta)', fontWeight: '700', color: look.word, margin: '2px 0 0' }}>{TABLE_STATE_WORDS[table.state]}</p>
      {counting && timeLine && (
        <p style={{ fontSize: 'var(--t-title)', fontWeight: '700', color: look.ink, margin: '4px 0 0', lineHeight: 1.1, fontVariantNumeric: 'tabular-nums' }}>
          <span aria-hidden="true">{timeLine}</span>
          <span className="sr-only">{tileClockSpoken(table, clockAt)}</span>
        </p>
      )}
      {people && (
        <p style={{ fontSize: 'var(--t-meta)', color: look.sub, margin: '2px 0 0' }}>{people}</p>
      )}
      {!counting && timeLine && (
        <p style={{ fontSize: 'var(--t-meta)', color: look.sub, margin: '4px 0 0', lineHeight: 1.4 }}>{timeLine}</p>
      )}
    </li>
  );
}

export default function TablesBoard({ data, colors, now, timeZone }) {
  const tables = tablesFrom(data);
  const hasTables = tables.length > 0;

  // `undefined` is the visit's first read still out: the tab is in the bar
  // from the first paint for a venue whose tables this device has seen
  // (App.js, tablesRemembered), so the board is the shape of itself in the
  // global shimmer until the read answers, never "couldn't load" about a read
  // that has not failed. Roughly the card's height with a small floor in it.
  if (data === undefined) {
    return <div aria-hidden="true" data-testid="tables-board-loading" className="skeleton" style={{ height: '220px', borderRadius: '12px', marginBottom: '12px' }} />;
  }

  if (!hasTables) {
    return (
      <TablesSection title="Right now" colors={colors}>
        <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: 0, lineHeight: 1.5 }}>
          {data && Array.isArray(data.tables)
            ? 'Your sensor is not reporting any tables right now.'
            : "Your tables couldn't load just now."}
        </p>
      </TablesSection>
    );
  }

  const stale = data.stale === true;
  const updatedAtMs = timeMs(data.updated_at);
  // The last read failed and this is the reading before it (nextTablesState
  // in lib/venueTablesReading.js), stamped with when it arrived.
  const unrefreshed = data.unrefreshed === true && Number.isFinite(data.readAt);
  // While the readings have stopped every clock on the tiles stops at the
  // last one instead of running on as if the box still saw the room; while
  // this side cannot refresh they stop at the moment the reading arrived,
  // which is the last moment it was true. With no time for a stopped reading
  // there is nothing to stop them at, so they are left off.
  const clockAt = stale ? updatedAtMs : unrefreshed ? data.readAt : now;
  const frozen = stale || unrefreshed;
  const alerts = tableAlerts(tables, clockAt);
  const clock = clockIn(timeZone);
  const nextFree = nextFreeLine(data, tables, clockAt, clock);
  // One line in place of the summary while the board is not live. A failed
  // refresh is this side's problem and says so first; the readings having
  // stopped is the box's, said when the refresh itself works.
  const lines = unrefreshed ? refreshLines(data.readAt, now) : stale ? staleLines(tables, updatedAtMs, now) : null;

  return (
    <TablesSection title="Right now" colors={colors}>
      {lines ? (
        <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: '0 0 10px', lineHeight: 1.45 }}>
          <span style={{ fontWeight: '700', color: 'var(--accent-amber-text)' }}>{lines.lead}</span>
          {' '}{lines.detail}
        </p>
      ) : (
        <p style={{ fontSize: 'var(--t-label)', fontWeight: '600', color: 'var(--text-secondary)', margin: '0 0 10px' }}>{freeSummary(tables)}</p>
      )}

      <div data-testid="tables-live" style={{ opacity: frozen ? STALE_OPACITY : 1 }}>
        {alerts.length > 0 && (
          <ul aria-label="Needs attention" style={{ listStyle: 'none', margin: '0 0 10px', padding: 0 }}>
            {alerts.map((a, i) => (
              <li
                key={`${a.number}-${a.state}-${i}`}
                data-state={a.state}
                style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', padding: '6px 0', borderTop: i === 0 ? 'none' : '1px solid var(--border-light)' }}
              >
                <span aria-hidden="true" style={alertMarker(a.state, colors)} />
                <span style={{ fontSize: 'var(--t-meta)', fontWeight: a.state === 'waiting' ? '700' : '600', color: 'var(--text-primary)', lineHeight: 1.45, minWidth: 0, overflowWrap: 'anywhere' }}>{a.text}</span>
              </li>
            ))}
          </ul>
        )}

        {nextFree && (
          <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: '0 0 10px', lineHeight: 1.45 }}>{nextFree.text}</p>
        )}

        <ul aria-label="All tables" style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(112px, 1fr))', gap: '8px' }}>
          {tables.map((t, i) => (
            <TableTile key={`${t.number}-${i}`} table={t} clockAt={clockAt} colors={colors} />
          ))}
        </ul>
      </div>
      {nextFree && nextFree.timed && (
        <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)', margin: '8px 0 0', lineHeight: 1.45 }}>{`Times on ${clockWords(clock.venue)}.`}</p>
      )}
    </TablesSection>
  );
}
