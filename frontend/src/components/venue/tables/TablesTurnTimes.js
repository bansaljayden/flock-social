/**
 * TURN TIMES: HOW LONG A PARTY KEEPS A TABLE, OVER THE LAST 28 DAYS.
 *
 * The last section of the Tables tab, for planning rather than for tonight.
 * From GET .../tables/stats: the median turn said in plain words, a
 * day-by-hour grid of median turn minutes with the busiest cells (the most
 * seatings) marked, how many seatings waited for a server, how long clearing
 * takes, and the hours the room is usually full. Every part is drawn only
 * when the server sent it; with nothing sent, one line says there are not
 * enough seatings yet. The arithmetic and the words are lib/venueTables.js.
 *
 * THE GRID. Seven rows from Monday, one column per hour the venue has
 * seatings in (the closed hours left off, the trim the hours chart uses), a
 * cell's blue its median against the longest in the grid, and the busiest
 * cells ringed in amber. A key under it says what the two marks mean, since
 * one card up the hours chart's strong colour means busy and here it means
 * long; the key is for the eye only. Each measured cell carries its words
 * ("Fri 8 PM: typical turn 1 h 5 min, most seatings") as its label and its
 * hover title, so a screen reader hears the grid cell by cell and nothing
 * rests on the shading or the ring alone; a cell with no median is hidden
 * from it, since it says nothing. The "Busiest" and "Longest turns" lines
 * are read from the measured cells only (turnGrid): the server sends a
 * seating count for every cell, two seatings included, and neither line is
 * printed from less than the server will put a median on. On a phone the
 * columns shrink with the card down to a floor of 10px, and past that the
 * grid scrolls sideways inside its card rather than squeezing the cells to
 * nothing or pushing the page wider than the screen.
 *
 * The server folds the hours in the venue's zone when the listing has one
 * and in UTC when it does not; a grid of day-by-hour cells cannot be
 * refolded here, so the line under it says which clock the hours are on,
 * and UTC is never called the venue's clock.
 */
import React from 'react';
import TablesSection, { SectionLine, SectionSkeleton } from './TablesSection';
import { TURN_GRID_KEY, clearedText, hourLabel, longestTurnText, medianTurnText, turnCellLabel, turnTimes, turnTimesFooter, waitedShareText } from '../../../lib/venueTables';

// At most this many hour labels under the grid, the hours chart's rule.
const MAX_HOUR_LABELS = 5;

// The day label's column, and the narrowest a cell goes before the grid
// scrolls instead.
const DAY_LABEL_PX = 28;
const CELL_MIN_PX = 10;
const CELL_GAP_PX = 2;

const lineStyle = { fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: '6px 0 0', lineHeight: 1.45, overflowWrap: 'anywhere' };

export default function TablesTurnTimes({ stats, colors }) {
  if (stats === undefined) return <SectionSkeleton height={200} testId="tables-turns-loading" />;
  if (stats === null) {
    return (
      <TablesSection title="Turn times" colors={colors}>
        <SectionLine>Turn times couldn't load.</SectionLine>
      </TablesSection>
    );
  }
  const t = turnTimes(stats);
  if (!t || !t.any) {
    return (
      <TablesSection title="Turn times" colors={colors}>
        <SectionLine>Not enough seatings yet to say.</SectionLine>
      </TablesSection>
    );
  }
  const grid = t.grid;
  const step = grid ? Math.max(1, Math.ceil(grid.hours.length / MAX_HOUR_LABELS)) : 1;
  const cellStyle = { flex: '1 1 0', minWidth: `${CELL_MIN_PX}px` };
  return (
    <TablesSection title="Turn times" colors={colors}>
      {t.median !== null && (
        <p style={{ fontSize: 'var(--t-label)', fontWeight: '600', color: 'var(--text-secondary)', margin: '0 0 4px', lineHeight: 1.4 }}>{medianTurnText(t.median)}</p>
      )}
      {grid && (
        <div role="group" aria-label="Typical turn by day and hour" data-testid="turn-grid" style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch', marginTop: '8px', paddingBottom: '2px' }}>
          <div style={{ minWidth: `${DAY_LABEL_PX + CELL_GAP_PX + grid.hours.length * (CELL_MIN_PX + CELL_GAP_PX)}px` }}>
            {grid.rows.map((row) => (
              <div key={row.dow} data-dow={row.dow} style={{ display: 'flex', alignItems: 'center', gap: `${CELL_GAP_PX}px`, marginBottom: `${CELL_GAP_PX}px` }}>
                <span aria-hidden="true" style={{ width: `${DAY_LABEL_PX}px`, flexShrink: 0, fontSize: 'var(--t-micro)', color: 'var(--text-secondary)' }}>{row.label}</span>
                {row.cells.map((cell, i) => {
                  const label = turnCellLabel(row.label, cell);
                  const measured = label !== null;
                  return (
                    <div
                      key={grid.hours[i]}
                      role={measured ? 'img' : undefined}
                      aria-label={measured ? label : undefined}
                      aria-hidden={measured ? undefined : 'true'}
                      title={measured ? label : undefined}
                      data-hour={grid.hours[i]}
                      data-median={measured ? cell.median : undefined}
                      data-busy={cell && cell.busy ? 'true' : undefined}
                      style={{
                        ...cellStyle,
                        height: '14px',
                        borderRadius: '2px',
                        boxSizing: 'border-box',
                        backgroundColor: measured ? colors.steel : 'var(--bg-tertiary)',
                        opacity: measured ? 0.25 + 0.75 * cell.shade : 1,
                        border: `2px solid ${cell && cell.busy ? 'var(--accent-amber-text)' : 'transparent'}`,
                      }}
                    />
                  );
                })}
              </div>
            ))}
            <div aria-hidden="true" style={{ display: 'flex', gap: `${CELL_GAP_PX}px` }}>
              <span style={{ width: `${DAY_LABEL_PX}px`, flexShrink: 0 }} />
              {grid.hours.map((h, i) => (
                <span key={h} style={{ ...cellStyle, fontSize: 'var(--t-micro)', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>{i % step === 0 ? hourLabel(h) : ''}</span>
              ))}
            </div>
          </div>
        </div>
      )}
      {grid && <p aria-hidden="true" data-testid="turn-grid-key" style={{ ...lineStyle, color: 'var(--text-tertiary)' }}>{TURN_GRID_KEY}</p>}
      {t.busiest && <p style={lineStyle}>{`Busiest (most seatings): ${t.busiest}`}</p>}
      {t.longest && <p style={lineStyle}>{longestTurnText(grid)}</p>}
      {t.waited !== null && <p style={lineStyle}>{waitedShareText(t.waited)}</p>}
      {t.cleared !== null && <p style={lineStyle}>{clearedText(t.cleared)}</p>}
      {t.full && <p style={lineStyle}>{`Usually full: ${t.full}`}</p>}
      <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)', margin: '8px 0 0', lineHeight: 1.45 }}>{turnTimesFooter(t.days, t.timeZone)}</p>
    </TablesSection>
  );
}
