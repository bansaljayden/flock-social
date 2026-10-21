import React from 'react';

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
   it. */
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

// Every leader and marker of one capture, in design units.
export function layoutNotes(layout, notes) {
  const x0 = phoneLeft(layout);
  const right = x0 + P + G;
  const toX = (p) => x0 + (p / 100) * P;
  const toY = (p) => (p / 100) * H;
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
    return { ...note, n: i + 1, d, ty, ly, ex, bend, outline, end, top: (ly / H) * 100 };
  });
}

export default function AnnotatedShot({ id, layout = 'center', shot, notes, caption, className = '' }) {
  const x0 = phoneLeft(layout);
  const W = stageWidth(layout);
  const right = x0 + P + G;
  const clip = `lp-anno-clip-${id}`;
  const rows = layoutNotes(layout, notes);
  const style = { '--anno-w': W, '--anno-x0': x0, '--anno-right': right };
  return (
    <figure className={`lp-plate lp-anno lp-anno-${layout}${className ? ` ${className}` : ''}`} style={style}>
      <div className="lp-anno-stage">
        <div className="lp-anno-phone">
          <img
            className="lp-shot"
            src={shot.src}
            srcSet={shot.srcSet}
            sizes="(min-width: 1100px) 312px, (min-width: 768px) 240px, min(260px, 70vw)"
            width="390" height="844"
            loading="lazy" decoding="async"
            alt={shot.alt}
          />
          {rows.map((r) => (
            <span key={r.n} className="lp-anno-dot" style={{ left: `${r.dot[0]}%`, top: `${r.dot[1]}%` }} aria-hidden="true">{r.n}</span>
          ))}
        </div>
        <svg className="lp-anno-lines" viewBox={`0 0 ${W} ${H.toFixed(2)}`} aria-hidden="true" focusable="false">
          <defs>
            <clipPath id={clip}>
              <rect x={x0} y="0" width={P} height={H.toFixed(2)} rx="20" />
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
