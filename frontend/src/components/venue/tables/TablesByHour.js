/**
 * TABLES IN USE BY HOUR, OVER THE LAST 7 DAYS.
 *
 * A section of the Tables tab, for staffing: the average number of tables in
 * use at each hour of the day, on the viewer's own clock, with the stretch near
 * the busiest hour drawn in the accent and the peak named in words under it.
 * A skeleton while the hours read is out; one line while that read has failed
 * (App.js asks again every few minutes); then the chart, drawn only when the
 * week brought something to draw. The averaging is lib/venueTables.js.
 */
import React from 'react';
import TablesSection from './TablesSection';
import { busiestText, hourLabel, tableHoursChart } from '../../../lib/venueTables';

// The bar well when the dashboard does not hand one down. It hands down
// HOUR_BAR_WELL_PX, the well "Today, Hour by Hour" uses on Analytics, so the
// two hourly charts stand the same height.
const DEFAULT_WELL_PX = 50;

// At most this many hour labels under the chart, which keeps "12 PM" clear of
// its neighbours with 24 bars on a 320px screen.
const MAX_HOUR_LABELS = 5;

// Roughly the card's own height with a week in it at 320px, so the chart
// arriving in its place barely moves the page.
const LOADING_HEIGHT_PX = 170;

export default function TablesByHour({ hours, colors, wellPx }) {
  // `undefined` is a read that has not answered yet: the shape of the card
  // in the global shimmer (DESIGN-STANDARD rule 10, skeletons for page loads).
  // Null is a read that failed, said in the card rather than hidden, because
  // a chart that is simply absent reads as "no data" when the truth is "not
  // loaded", and the owner would never know a retry was coming. An empty
  // week or nothing usable draws nothing: there is nothing to say.
  if (hours === undefined) {
    return <div aria-hidden="true" data-testid="tables-hours-loading" className="skeleton" style={{ height: `${LOADING_HEIGHT_PX}px`, borderRadius: '12px', marginBottom: '12px' }} />;
  }
  if (hours === null) {
    return (
      <TablesSection title="Tables in use by hour" colors={colors}>
        <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: 0, lineHeight: 1.5 }}>Tables by hour couldn't load.</p>
      </TablesSection>
    );
  }
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
    <TablesSection title="Tables in use by hour" colors={colors}>
      {/* Built like "Today, Hour by Hour": each bar in a fixed well with its
          label under the well, in flow, so nothing has a height its contents
          can exceed, and minWidth 0 so a labelled column shrinks like the
          rest. The first label starts at its bar and the last ends at its
          bar, so neither hangs past the card. Hidden from screen readers:
          the two lines under it say what the bars show. */}
      <div aria-hidden="true" data-testid="tables-hours-chart" style={{ display: 'flex', gap: '2px', alignItems: 'flex-start', marginTop: '8px' }}>
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
    </TablesSection>
  );
}
