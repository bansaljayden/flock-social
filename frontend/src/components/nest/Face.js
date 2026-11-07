/**
 * ONE FACE, EVERYWHERE THE NEST SHOWS A PERSON.
 *
 * The hero card, the Needs you rows, the Coming up cards and the friends who
 * are out tonight all draw people with this, so a person looks the same at
 * every size on the page: their own picture, cropped to the circle, or the
 * first letter of their name on a quiet disc when they have no picture.
 *
 * What it never draws: an online dot, a last-seen time or a place. A face on
 * the Nest says who is in a plan, nothing about where they are or when they
 * last opened the app.
 *
 * Faces that overlap (a row of them, `index` > 0) get a 2px ring in the colour
 * of the surface they sit on, so each one reads as its own circle; a face on
 * its own has no ring.
 */
import React from 'react';

export const FACE_SIZES = [28, 32, 36];

const initialOf = (name) => {
  const ch = String(name || '').trim().charAt(0);
  return ch ? ch.toUpperCase() : '?';
};

export default function Face({
  name,
  image = null,
  size = 28,
  index = 0,
  ring = 'var(--bg-card-solid)',
  bg = 'var(--face-bg)',
  ink = 'var(--text-primary)',
  overlap = 8,
}) {
  const px = FACE_SIZES.includes(size) ? size : 28;
  const stacked = index > 0;
  return (
    <span
      aria-hidden="true"
      style={{
        width: `${px}px`,
        height: `${px}px`,
        borderRadius: '999px',
        flexShrink: 0,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
        backgroundColor: bg,
        color: ink,
        fontSize: px >= 32 ? 'var(--t-label)' : 'var(--t-meta)',
        fontWeight: '600',
        lineHeight: 1,
        marginLeft: stacked ? `-${overlap}px` : 0,
        boxShadow: stacked || index === 0 ? `0 0 0 2px ${ring}` : 'none',
        position: 'relative',
      }}
    >
      {image
        ? <img src={image} alt="" draggable="false" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
        : initialOf(name)}
    </span>
  );
}

/**
 * A row of up to `max` faces, then "+N" for the rest. `people` are
 * { name, image } in the order to draw them; `total` is the real head count
 * (accounts and link guests), so the +N counts from it and not from the
 * four-face preview.
 */
export function FaceRow({ people = [], total = 0, size = 28, max = 4, ring, bg, ink }) {
  const shown = people.slice(0, max);
  const extra = Math.max(0, (Number(total) || shown.length) - shown.length);
  return (
    <span aria-hidden="true" style={{ display: 'inline-flex', alignItems: 'center', flexShrink: 0 }}>
      {shown.map((p, i) => (
        <Face key={p.key ?? i} name={p.name} image={p.image} size={size} index={shown.length > 1 || extra > 0 ? i : -1} ring={ring} bg={bg} ink={ink} />
      ))}
      {extra > 0 && (
        <span
          style={{
            minWidth: `${size}px`,
            height: `${size}px`,
            padding: '0 6px',
            boxSizing: 'border-box',
            borderRadius: '999px',
            marginLeft: shown.length ? '-8px' : 0,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: bg || 'var(--face-bg)',
            color: ink || 'var(--text-primary)',
            boxShadow: `0 0 0 2px ${ring || 'var(--bg-card-solid)'}`,
            fontSize: 'var(--t-meta)',
            fontWeight: '600',
            position: 'relative',
          }}
        >
          +{extra}
        </span>
      )}
    </span>
  );
}
