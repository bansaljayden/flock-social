/**
 * RIGHT NOW: EVERY TABLE ON THE SENSOR, LIVE.
 *
 * The first section of the Tables tab. What a manager reads, top to bottom:
 *   - "3 of 8 free", or, once the sensor has gone quiet for 3 minutes, that it
 *     is offline and how old its last reading is. The board then keeps that
 *     reading, dimmed, with every clock stopped where the sensor left it.
 *   - The tables that need someone, longest first.
 *   - The server's pick for the table likely to free up next.
 *   - One tile per table, in number order, with its state in words, so no
 *     state rests on colour alone: free is green, seated red, needs clearing a
 *     pale yellow with a dashed edge, and a party nobody has stopped by for is
 *     solid amber, the loudest thing on the tab. A table whose seat count the
 *     sensor's setup knows says it ("4 seats").
 *
 * The tab only exists once a read this session has returned a table, so when
 * a later read fails or comes back empty the board says so in one line rather
 * than leaving the tab blank.
 *
 * One interval drives every clock on the board, so the tiles tick together and
 * there is one timer to clear when the board goes. The words and arithmetic
 * are lib/venueTables.js.
 */
import React, { useEffect, useState } from 'react';
import TablesSection from './TablesSection';
import {
  TABLE_STATE_WORDS,
  freeSummary,
  nextFreeText,
  peopleText,
  seatsText,
  staleDetail,
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

// How far the live part of the board fades while the sensor is offline.
const STALE_OPACITY = 0.55;

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

export default function TablesBoard({ data, colors }) {
  const tables = tablesFrom(data);
  const hasTables = tables.length > 0;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!hasTables) return undefined;
    // From the moment there are tables to time, not from when the board
    // mounted: it can mount on the unavailable line and get tables later.
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [hasTables]);

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
  // While the sensor is offline every clock on the tiles stops at its last
  // reading instead of running on as if it still saw the room. With no time
  // for that reading there is nothing to stop them at, so they are left off.
  const clockAt = stale ? updatedAtMs : now;
  const alerts = tableAlerts(tables, clockAt);
  const nextFree = nextFreeText(data, tables, clockAt);

  return (
    <TablesSection title="Right now" colors={colors}>
      {stale ? (
        <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: '0 0 10px', lineHeight: 1.45 }}>
          <span style={{ fontWeight: '700', color: 'var(--accent-red-text)' }}>Sensor offline.</span>
          {' '}{staleDetail(tables, updatedAtMs, now)}
        </p>
      ) : (
        <p style={{ fontSize: 'var(--t-label)', fontWeight: '600', color: 'var(--text-secondary)', margin: '0 0 10px' }}>{freeSummary(tables)}</p>
      )}

      <div data-testid="tables-live" style={{ opacity: stale ? STALE_OPACITY : 1 }}>
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
          <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: '0 0 10px', lineHeight: 1.45 }}>{nextFree}</p>
        )}

        <ul aria-label="All tables" style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(112px, 1fr))', gap: '8px' }}>
          {tables.map((t, i) => (
            <TableTile key={`${t.number}-${i}`} table={t} clockAt={clockAt} colors={colors} />
          ))}
        </ul>
      </div>
    </TablesSection>
  );
}
