/**
 * TABLES: THE FLUX SENSOR'S TABLE ZONES, ON THE OWNER DASHBOARD.
 *
 * Rendered on the Analytics tab beside Live Sensor, behind the same Roost gate,
 * and only when the sensor reports at least one table. The data arrives as
 * props from App.js, which reads GET /api/sensors/:placeId/tables every 15
 * seconds while the dashboard is open and the hours once per open; the words
 * and the arithmetic are lib/venueTables.js.
 *
 * What a manager reads, top to bottom:
 *   - "3 of 8 free", or, once the sensor has gone quiet for 3 minutes, that it
 *     is offline and how old its last reading is. The tiles then keep that
 *     reading, dimmed, with their timers stopped where the sensor left them.
 *   - The tables that need someone, longest first.
 *   - The server's pick for the table likely to free up next.
 *   - One tile per table, in number order, with its state in words, so no
 *     state rests on colour alone: free is green, seated red, needs clearing a
 *     pale yellow with a dashed edge, and a party nobody has stopped by for is
 *     solid amber, the loudest thing on the panel.
 *   - Tables in use by hour over the last 7 days, on the viewer's own clock.
 *
 * One interval drives every clock on the panel, so the tiles tick together and
 * there is one timer to clear when the panel goes.
 */
import React, { useEffect, useState } from 'react';
import {
  TABLE_STATE_WORDS,
  busiestText,
  freeSummary,
  hourLabel,
  nextFreeText,
  peopleText,
  staleDetail,
  tableAlerts,
  tableHoursChart,
  tablesFrom,
  tileClockSpoken,
  tileTimeText,
  timeMs,
} from '../../lib/venueTables';

// The waiting tile is filled with the palette's amber (colors.amber), which is
// the same #F59E0B in both themes, so the type on it is one dark ink in both
// themes too: 6.81:1 on that fill. A theme token would turn cream after dark
// and sink into the amber.
const ON_AMBER_INK = '#1e293b';

// How far the live part of the panel fades while the sensor is offline.
const STALE_OPACITY = 0.55;

// The chart's bar well when the dashboard does not hand one down. It hands
// down HOUR_BAR_WELL_PX, the well "Today, Hour by Hour" uses, so the two
// hourly charts on the tab stand the same height.
const DEFAULT_WELL_PX = 50;

// At most this many hour labels under the chart, which keeps "12 PM" clear of
// its neighbours with 24 bars on a 320px screen.
const MAX_HOUR_LABELS = 5;

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

function TableHoursChart({ hours, colors, wellPx }) {
  const chart = tableHoursChart(hours);
  if (!chart) return null;
  const well = Number.isFinite(wellPx) && wellPx > 0 ? wellPx : DEFAULT_WELL_PX;
  // Heights run from zero to the venue's table count, so a full bar is every
  // table in use and no gap between two hours is drawn bigger than it is.
  const top = Math.max(chart.tables, chart.peak.avg) || 1;
  const count = chart.bars.length;
  const step = Math.max(1, Math.ceil(count / MAX_HOUR_LABELS));
  const busiest = busiestText(chart);
  return (
    <div style={{ marginTop: '14px', paddingTop: '12px', borderTop: '1px solid var(--border-light)' }}>
      <h4 style={{ fontSize: 'var(--t-label)', fontWeight: '600', color: colors.navy, margin: '0 0 8px' }}>Tables in use by hour</h4>
      {/* Built like "Today, Hour by Hour": each bar in a fixed well with its
          label under the well, in flow, so nothing has a height its contents
          can exceed, and minWidth 0 so a labelled column shrinks like the
          rest. The first label starts at its bar and the last ends at its
          bar, so neither hangs past the card. Hidden from screen readers:
          the two lines under it say what the bars show. */}
      <div aria-hidden="true" data-testid="tables-hours-chart" style={{ display: 'flex', gap: '2px', alignItems: 'flex-start' }}>
        {chart.bars.map((slot, i) => {
          const busy = chart.busy.has(slot.hour);
          const height = slot.avg === null
            ? 0
            : Math.min(well, Math.max(2, Math.round((slot.avg / top) * well)));
          const align = i === 0 ? 'flex-start' : i === count - 1 ? 'flex-end' : 'center';
          return (
            <div
              key={slot.hour}
              data-hour={slot.hour}
              data-busy={busy ? 'true' : undefined}
              style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', alignItems: align }}
            >
              <div style={{ width: '100%', height: `${well}px`, display: 'flex', alignItems: 'flex-end' }}>
                {slot.avg !== null && (
                  <div style={{ width: '100%', height: `${height}px`, borderRadius: '2px', backgroundColor: busy ? colors.steel : 'var(--text-tertiary)' }} />
                )}
              </div>
              {i % step === 0 && (
                <span style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', marginTop: '4px', whiteSpace: 'nowrap' }}>{hourLabel(slot.hour)}</span>
              )}
            </div>
          );
        })}
      </div>
      {busiest && (
        <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: '8px 0 0', lineHeight: 1.45 }}>{busiest}</p>
      )}
      <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)', margin: busiest ? '2px 0 0' : '8px 0 0', lineHeight: 1.45 }}>
        Averages for each hour of the day over the last 7 days.
      </p>
    </div>
  );
}

export default function VenueTablesPanel({ data, hours, colors, wellPx }) {
  const tables = tablesFrom(data);
  const hasTables = tables.length > 0;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!hasTables) return undefined;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [hasTables]);

  if (!hasTables) return null;

  const stale = data.stale === true;
  const updatedAtMs = timeMs(data.updated_at);
  // While the sensor is offline every clock on the tiles stops at its last
  // reading instead of running on as if it still saw the room. With no time
  // for that reading there is nothing to stop them at, so they are left off.
  const clockAt = stale ? updatedAtMs : now;
  const alerts = tableAlerts(tables, clockAt);
  const nextFree = nextFreeText(data, tables, clockAt);

  return (
    <div style={{ backgroundColor: 'var(--bg-card-solid)', borderRadius: '12px', padding: '14px', marginBottom: '12px', boxShadow: 'var(--card-shadow-sm)' }}>
      <h3 style={{ fontSize: 'var(--t-title)', fontWeight: '700', color: colors.navy, margin: '0 0 2px' }}>Tables</h3>
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
          <ul style={{ listStyle: 'none', margin: '0 0 10px', padding: 0 }}>
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

        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(112px, 1fr))', gap: '8px' }}>
          {tables.map((t, i) => {
            const look = tileLook(t.state, colors);
            const counting = t.state === 'seated' || t.state === 'waiting';
            const timeLine = tileTimeText(t, clockAt);
            const people = counting ? peopleText(t.people) : null;
            return (
              <li
                key={`${t.number}-${i}`}
                data-state={t.state}
                style={{ minWidth: 0, boxSizing: 'border-box', padding: '10px', borderRadius: '10px', backgroundColor: look.background, border: look.border, overflowWrap: 'anywhere' }}
              >
                <p style={{ fontSize: 'var(--t-label)', fontWeight: '600', color: look.ink, margin: 0 }}>Table {t.number}</p>
                <p style={{ fontSize: 'var(--t-meta)', fontWeight: '700', color: look.word, margin: '2px 0 0' }}>{TABLE_STATE_WORDS[t.state]}</p>
                {counting && timeLine && (
                  <p style={{ fontSize: 'var(--t-title)', fontWeight: '700', color: look.ink, margin: '4px 0 0', lineHeight: 1.1, fontVariantNumeric: 'tabular-nums' }}>
                    <span aria-hidden="true">{timeLine}</span>
                    <span className="sr-only">{tileClockSpoken(t, clockAt)}</span>
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
          })}
        </ul>
      </div>

      <TableHoursChart hours={hours} colors={colors} wellPx={wellPx} />
    </div>
  );
}
