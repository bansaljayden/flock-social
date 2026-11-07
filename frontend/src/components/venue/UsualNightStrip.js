/**
 * THE USUAL NIGHT, IN ONE LINE (2026-11-06).
 *
 * A plan for another day has no crowd reading yet, and Birdie's card for it
 * used to have no crowd row at all. This is the row it gets instead: small bars
 * for the night's open hours, the busiest stretch drawn darker, and one line of
 * words, "Usually busiest 7-9 PM Fri" (lib/usualNight.js). Birdie's venue card
 * draws it when it has no number for now, and the venue sheet opened from that
 * card draws it over today's forecast.
 *
 * The bars carry no numbers and no scale: they are the shape of a usual night,
 * and the words are the claim. The whole row is one image to a screen reader,
 * named with the sentence in full.
 *
 * THE WORDS WRAP AND THE BARS KEEP ONE WIDTH (review, 2026-11-06). The line
 * was held to one row with an ellipsis, beside bars that took 4px per open
 * hour. Birdie's card leaves the row 159px at 320 wide and 209px at 390-430,
 * so "Usually busiest around 9 PM Sat" lost its day at 320, "Places like this:
 * busiest around 9 PM Sat" lost it at every width, and a venue open 16 to 24
 * hours spent 63-95px on bars, which cut even "Usually busiest 7-9 PM Fri".
 * The day and the hours are the claim, so the words now wrap to a second line
 * instead of being cut, and the bars are a sparkline of at most 48px: a short
 * night keeps 3px bars with 1px between them, a longer one draws the same
 * shape narrower.
 *
 * THE TWO COLOURS ARE TOKENS OF BOTH THEMES. The busiest bars read
 * --accent-steel, which index.css defines for light and dark; it was defined
 * nowhere, so they took their fallback #2d5a87, which is exactly what
 * --border-mid is in dark, and every bar came out the same steel blue there.
 */
import React from 'react';
import { usualNightText, usualNightSpoken, inBusiest, planDayLabel } from '../../lib/usualNight';

const BAR_MAX_PX = 14;
// One hour's slot on a short night: a 3px bar and a 1px gap.
const SLOT_PX = 4;
// The sparkline's widest: twelve hours at the slot above, and every longer
// night squeezed into the same width.
const SPARK_MAX_PX = 48;

export const USUAL_BUSIEST_FILL = 'var(--accent-steel)';
export const USUAL_OTHER_FILL = 'var(--border-mid)';

export default function UsualNightStrip({ usual, withDate = false, style }) {
  const dated = withDate ? planDayLabel(usual && usual.date) : null;
  const text = usualNightText(usual, { withDay: !dated });
  if (!text) return null;
  const hours = Array.isArray(usual.hours) ? usual.hours.filter((x) => x && Number.isInteger(x.h) && Number.isFinite(x.v)) : [];
  const top = Math.max(1, ...hours.map((x) => x.v));
  const n = hours.length;
  return (
    <div data-usual-night role="img" aria-label={`${usualNightSpoken(usual)}. Not a forecast for that night.`} style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0, ...style }}>
      {n > 1 && (
        <svg
          aria-hidden="true"
          data-usual-bars
          width={Math.min(SPARK_MAX_PX, n * SLOT_PX)}
          height={BAR_MAX_PX}
          viewBox={`0 0 ${n * SLOT_PX} ${BAR_MAX_PX}`}
          preserveAspectRatio="none"
          style={{ display: 'block', flexShrink: 0 }}
        >
          {hours.map((x, i) => {
            const h = Math.max(2, Math.round((x.v / top) * BAR_MAX_PX));
            const busiest = inBusiest(usual.busiest, x.h);
            return (
              <rect
                key={x.h}
                data-busiest={busiest ? '' : undefined}
                x={i * SLOT_PX}
                y={BAR_MAX_PX - h}
                width={SLOT_PX - 1}
                height={h}
                rx="1"
                style={{ fill: busiest ? USUAL_BUSIEST_FILL : USUAL_OTHER_FILL }}
              />
            );
          })}
        </svg>
      )}
      <span aria-hidden="true" style={{ flex: '1 1 auto', minWidth: 0, fontSize: 'var(--t-meta)', lineHeight: 1.3, color: 'var(--text-secondary)', fontWeight: '500', overflowWrap: 'anywhere' }}>
        {dated ? <span style={{ fontWeight: '700', color: 'var(--text-primary)' }}>{dated} · </span> : null}
        {text}
      </span>
    </div>
  );
}
