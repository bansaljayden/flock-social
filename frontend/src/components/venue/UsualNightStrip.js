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
 */
import React from 'react';
import { usualNightText, usualNightSpoken, inBusiest, planDayLabel } from '../../lib/usualNight';

const BAR_MAX_PX = 14;

export default function UsualNightStrip({ usual, withDate = false, style }) {
  const dated = withDate ? planDayLabel(usual && usual.date) : null;
  const text = usualNightText(usual, { withDay: !dated });
  if (!text) return null;
  const hours = Array.isArray(usual.hours) ? usual.hours.filter((x) => x && Number.isInteger(x.h) && Number.isFinite(x.v)) : [];
  const top = Math.max(1, ...hours.map((x) => x.v));
  return (
    <div data-usual-night role="img" aria-label={`${usualNightSpoken(usual)}. Not a forecast for that night.`} style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0, ...style }}>
      {hours.length > 1 && (
        <span aria-hidden="true" style={{ display: 'inline-flex', alignItems: 'flex-end', gap: '1px', height: `${BAR_MAX_PX}px`, flexShrink: 0 }}>
          {hours.map((x) => (
            <span
              key={x.h}
              data-busiest={inBusiest(usual.busiest, x.h) ? '' : undefined}
              style={{
                width: '3px',
                height: `${Math.max(2, Math.round((x.v / top) * BAR_MAX_PX))}px`,
                borderRadius: '1px',
                background: inBusiest(usual.busiest, x.h) ? 'var(--accent-steel, #2d5a87)' : 'var(--border-mid, #c9ced6)',
              }}
            />
          ))}
        </span>
      )}
      <span aria-hidden="true" style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', fontWeight: '500', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>
        {dated ? <span style={{ fontWeight: '700', color: 'var(--text-primary)' }}>{dated} · </span> : null}
        {text}
      </span>
    </div>
  );
}
