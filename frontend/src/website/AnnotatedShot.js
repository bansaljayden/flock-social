import React from 'react';

/* A capture of the app with its parts named, the way a field guide labels a
   plate (2026-10-21: "put the screenshot in the middle and draw arrows to
   explain").

   From 768px the notes sit beside the phone and a hairline leads from each to
   the thing it names. Everything is laid out on one fixed grid of design
   units: notes N wide, a gap G for the leaders, the phone P wide and as tall
   as the capture's own 390:844. The stage keeps that aspect ratio as it
   scales, the phone and the notes are placed in percentages of it, and the SVG
   draws in the same units, so a leader lands on the same pixel of the capture
   at every width. Each target is measured on the 780 x 1688 capture and given
   as a percentage of it: `at: [x, y]`.

   Under 768px no line could cross the screen legibly, so the targets become
   numbered dots on the phone and the notes a numbered list under it.

   Inside the phone the leaders turn cream over a thin navy casing: the
   captures are the dark theme, where an ink line would vanish, and a few
   targets are light buttons, where a bare cream one would. The end is an open
   ring, cream on navy, so the word or number it marks stays readable inside
   it. Nothing here moves. */
const N = 230;
const G = 56;
const P = 240;
const H = (P * 844) / 390;

export default function AnnotatedShot({ id, layout = 'center', shot, notes, caption, className = '' }) {
  const x0 = layout === 'right' ? 0 : N + G;
  const W = layout === 'center' ? N + G + P + G + N : N + G + P;
  const right = x0 + P + G;
  const clip = `lp-anno-clip-${id}`;
  const rows = notes.map((n, i) => {
    const tx = x0 + (n.at[0] / 100) * P;
    const ty = (n.at[1] / 100) * H;
    const ly = ((n.y === undefined ? n.at[1] : n.y) / 100) * H;
    const d = n.side === 'left'
      ? `M ${N + 8} ${ly} H ${x0 - 14} L ${tx} ${ty}`
      : `M ${right - 8} ${ly} H ${x0 + P + 14} L ${tx} ${ty}`;
    return { ...n, n: i + 1, d, tx, ty, top: (ly / H) * 100 };
  });
  const style = { '--anno-w': W, '--anno-x0': x0, '--anno-right': right };
  return (
    <figure className={`lp-plate lp-anno lp-anno-${layout}${className ? ` ${className}` : ''}`} style={style}>
      <div className="lp-anno-stage">
        <div className="lp-anno-phone">
          <img
            className="lp-shot"
            src={shot.src}
            srcSet={shot.srcSet}
            sizes="(min-width: 768px) 240px, min(260px, 70vw)"
            width="390" height="844"
            loading="lazy" decoding="async"
            alt={shot.alt}
          />
          {rows.map((r) => (
            <span key={r.n} className="lp-anno-dot" style={{ left: `${r.at[0]}%`, top: `${r.at[1]}%` }} aria-hidden="true">{r.n}</span>
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
          {rows.map((r) => (
            <g key={r.n} className="lp-anno-end">
              <circle className="lp-anno-ring-case" cx={r.tx.toFixed(2)} cy={r.ty.toFixed(2)} r="6" />
              <circle className="lp-anno-ring" cx={r.tx.toFixed(2)} cy={r.ty.toFixed(2)} r="6" />
            </g>
          ))}
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
