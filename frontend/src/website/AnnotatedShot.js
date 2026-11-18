import React from 'react';
import { PhoneStatus } from './PhoneDevice';

/* A capture of the app with its parts named, the way a field guide labels a
   plate (2026-10-21: "put the screenshot in the middle and draw arrows to
   explain").

   From 768px the notes sit beside the phone and a hairline leads from each to
   the thing it names. Everything is laid out on one fixed grid of design
   units: notes N wide, a gap G for the leaders, the phone P wide and as tall
   as the capture's own 390:844. The stage keeps that ratio as it scales (and
   from 1100px is drawn 1.3 times larger, so the screen reads), the phone and
   the notes are placed in percentages of it, and the SVG draws in the same
   units, so a leader lands on the same pixel of the capture at every width.

   A marker never covers what it names (landingAnnotations.js has the measured
   boxes): text gets a small dot just past its edge, a button, field or list a
   thin outline around it. A leader runs level from its note; where a note had
   to move off its target's line it bends once, in the gap beside the phone.
   Inside the phone the line is cream over a thin navy casing, which reads on
   the dark capture and on its light buttons. Nothing moves.

   Under 768px no line could cross the screen legibly: each note's number sits
   beside its element on the phone, and the notes are a numbered list under
   it.

   A capture whose subject is a sheet over the app (the budget, the bill) is
   cut down to the sheet: `shot.crop` is the share of the capture's height,
   in percent, taken off its top, and the cut files start there. The notes
   keep the boxes measured on the whole 780 x 1688 capture and cropNotes maps
   each y into the cut. The phone is then drawn cut straight across at the
   sheet's top edge: no top frame and no status row, so it reads as the lower
   part of a phone rather than a shorter one. */
export const N = 230;
export const G = 56;
export const P = 240;
export const H = (P * 844) / 390;
const GAP = 3.6;
const R = 3;
const PAD_X = 2.9;
const PAD_Y = 3.1;

export function stageWidth(layout) {
  return layout === 'center' ? N + G + P + G + N : N + G + P;
}

export function phoneLeft(layout) {
  return layout === 'right' ? 0 : N + G;
}

// The phone's height in design units once `crop` percent is cut off the top.
export function phoneHeight(crop = 0) {
  return (H * (100 - crop)) / 100;
}

// The notes with every y (box, label, number and the boxes it must clear)
// moved from the whole capture's percent into the cut's.
export function cropNotes(notes, crop = 0) {
  if (!crop) return notes;
  const y = (v) => ((v - crop) / (100 - crop)) * 100;
  const box = ([x1, y1, x2, y2]) => [x1, y(y1), x2, y(y2)];
  return notes.map((n) => ({
    ...n,
    box: box(n.box),
    ...(n.y === undefined ? {} : { y: y(n.y) }),
    ...(n.dot ? { dot: [n.dot[0], y(n.dot[1])] } : {}),
    ...(n.avoid ? { avoid: n.avoid.map(box) } : {}),
  }));
}

// Every leader and marker of one capture, in design units. `h` is the phone's
// height, shorter than H for a cut capture.
export function layoutNotes(layout, notes, h = H) {
  const x0 = phoneLeft(layout);
  const right = x0 + P + G;
  const toX = (p) => x0 + (p / 100) * P;
  const toY = (p) => (p / 100) * h;
  return notes.map((note, i) => {
    const [bx1, by1, bx2, by2] = note.box;
    const ty = toY((by1 + by2) / 2);
    const ly = note.y === undefined ? ty : toY(note.y);
    const left = note.side === 'left';
    let ex;
    let outline = null;
    let end = null;
    if (note.kind === 'box') {
      outline = { x: toX(bx1) - PAD_X, y: toY(by1) - PAD_Y, w: toX(bx2) - toX(bx1) + 2 * PAD_X, h: toY(by2) - toY(by1) + 2 * PAD_Y };
      ex = left ? outline.x : outline.x + outline.w;
    } else {
      ex = left ? toX(bx1) - GAP - R : toX(bx2) + GAP + R;
      end = { x: ex, y: ty, r: R };
    }
    const lx = left ? N + 8 : right - 8;
    const bend = left ? N + G / 2 : x0 + P + G / 2;
    const d = Math.abs(ly - ty) < 0.01
      ? `M ${lx.toFixed(2)} ${ly.toFixed(2)} H ${ex.toFixed(2)}`
      : `M ${lx.toFixed(2)} ${ly.toFixed(2)} H ${bend.toFixed(2)} V ${ty.toFixed(2)} H ${ex.toFixed(2)}`;
    return { ...note, n: i + 1, d, ty, ly, ex, bend, outline, end, top: (ly / h) * 100 };
  });
}

export default function AnnotatedShot({ id, layout = 'center', shot, notes, caption, className = '' }) {
  const x0 = phoneLeft(layout);
  const W = stageWidth(layout);
  const right = x0 + P + G;
  const clip = `lp-anno-clip-${id}`;
  const crop = shot.crop || 0;
  const h = phoneHeight(crop);
  const rows = layoutNotes(layout, cropNotes(notes, crop), h);
  const style = { '--anno-w': W, '--anno-h': Number(h.toFixed(2)), '--anno-x0': x0, '--anno-right': right };
  return (
    <figure className={`lp-plate lp-anno lp-anno-${layout}${crop ? ' is-cropped' : ''}${className ? ` ${className}` : ''}`} style={style}>
      <div className="lp-anno-stage">
        <div className="lp-anno-phone">
          {/* The site's drawn phone (PhoneDevice.js): its frame, glass and
              status row sit outside the capture's box, so the capture keeps
              the exact box every leader and number is measured on. A cut
              capture has no top to its phone, so no status row either. */}
          <div className="lp-anno-device" aria-hidden="true">
            <div className="lp-anno-glass">{crop ? null : <PhoneStatus />}</div>
          </div>
          <img
            className="lp-shot"
            src={shot.src}
            srcSet={shot.srcSet}
            sizes="(min-width: 1100px) 312px, (min-width: 768px) 240px, min(260px, 70vw)"
            width="390" height={Math.round((844 * (100 - crop)) / 100)}
            loading="lazy" decoding="async"
            alt={shot.alt}
          />
          {rows.map((r) => (
            <span key={r.n} className="lp-anno-dot" style={{ left: `${r.dot[0]}%`, top: `${r.dot[1]}%` }} aria-hidden="true">{r.n}</span>
          ))}
        </div>
        <svg className="lp-anno-lines" viewBox={`0 0 ${W} ${h.toFixed(2)}`} aria-hidden="true" focusable="false">
          <defs>
            <clipPath id={clip}>
              {/* A cut phone has square top corners: the rounded ones are
                  drawn above the stage, out of sight. */}
              <rect x={x0} y={crop ? -20 : 0} width={P} height={(h + (crop ? 20 : 0)).toFixed(2)} rx="20" />
            </clipPath>
          </defs>
          {rows.map((r) => <path key={r.n} className="lp-anno-line" d={r.d} />)}
          <g clipPath={`url(#${clip})`}>
            {rows.map((r) => <path key={r.n} className="lp-anno-case" d={r.d} />)}
            {rows.map((r) => <path key={r.n} className="lp-anno-line-in" d={r.d} />)}
          </g>
          {rows.map((r) => (r.outline ? (
            <g key={r.n} className="lp-anno-mark">
              <rect className="lp-anno-outline-case" x={r.outline.x.toFixed(2)} y={r.outline.y.toFixed(2)} width={r.outline.w.toFixed(2)} height={r.outline.h.toFixed(2)} rx="8" />
              <rect className="lp-anno-outline" x={r.outline.x.toFixed(2)} y={r.outline.y.toFixed(2)} width={r.outline.w.toFixed(2)} height={r.outline.h.toFixed(2)} rx="8" />
            </g>
          ) : (
            <circle key={r.n} className="lp-anno-end" cx={r.end.x.toFixed(2)} cy={r.end.y.toFixed(2)} r={R} />
          )))}
        </svg>
        <ol className="lp-anno-notes">
          {rows.map((r) => (
            <li key={r.n} className={`lp-anno-note is-${r.side}`} style={{ top: `${r.top.toFixed(2)}%` }}>
              <span className="lp-anno-num" aria-hidden="true">{r.n}</span>
              <span>{r.text}</span>
            </li>
          ))}
        </ol>
      </div>
      {caption ? <figcaption className="lp-fig-cap">{caption}</figcaption> : null}
    </figure>
  );
}
