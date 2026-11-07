/**
 * NEEDS YOU: every other open loop on the Nest, one row each.
 *
 * An unfinished task pulls a person back to it, and a clear next step is what
 * lets them put it down, so each row says what to do ("Vote on Sam's
 * Birthday") and closes in one tap. Verb first, so the words that differ
 * between rows are the ones the eye lands on. Neutral facts only: no count of
 * what is "waiting on you", no word about anyone else.
 *
 * A vote's glyph is the place pin, never a ticked square: a check in a box
 * is a to-do list's sign for done, on a row that is still open, where a
 * list's checkbox would sit, so a tap on it read as ticking the row off. The
 * check is kept for what is settled (Locked in).
 *
 * The keyboard ring is drawn inside each row (index.css .nest-row-btn): the
 * fold's box and the group both clip, so the app's ring outside the button
 * never showed.
 *
 * Three rows show; a fourth or later waits behind "Show N more", which opens
 * in place and hands the keyboard and VoiceOver to the first row it revealed,
 * since the button itself goes (it used to drop focus to the top of the page,
 * on a button whose aria-expanded could only ever say false).
 *
 * When a loop closes while the Nest is on screen (a budget put in from the
 * money sheet over it, a bill settled on another device, an invite answered
 * from a push), its row folds away over 220 ms and goes, so the person sees
 * it leave the list; under Reduce Motion it goes at once. A vote is cast on
 * the plan screen, which the Nest is not drawn under, so that row is simply
 * gone when the person comes back.
 *
 * The rows, their words and their taps come from App.js (lib/nestAsks.js
 * nestRows). Nothing is drawn when nothing needs the reader.
 */
import React, { useEffect, useRef, useState } from 'react';
import Icons from '../ui/Icons';
import { NEST_ROWS_CAP } from '../../lib/nestAsks';
import { BAND_HEAD, BAND_GAP } from './nestBand';

// A vote on the Nest is a vote on a place ("Vote on a place" is the hero's
// words for it), so its row wears the place pin: Icons.vote is a ticked
// square, a to-do list's sign for done, on a row that is still open, and a
// ballot going into a box drew as a printer at 18px.
const ICON = { owe: 'dollar', budget: 'dollar', vote: 'mapPin', invite: 'mail', how: 'star' };
export const NEST_ROW_LEAVE_MS = 220;

const prefersReducedMotion = () => {
  try {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch (_) {
    return false;
  }
};

// The time, then the place with its dot: the dot travels with the place, so
// at 320 the line breaks before it ("Tomorrow 7:00 PM" / "· Juniper Bowl")
// and never leaves it hanging at the end of the first line.
function RowLine({ when, venue }) {
  if (!when && !venue) return null;
  return (
    <span style={{ display: 'block', marginTop: '2px', fontSize: 'var(--t-label)', fontWeight: '500', color: 'var(--text-secondary)' }}>
      {when && <span style={{ whiteSpace: 'nowrap' }}>{when}</span>}
      {when && venue && ' '}
      {venue && <span style={{ whiteSpace: 'nowrap' }}>{when ? '· ' : ''}{venue}</span>}
    </span>
  );
}

export default function NestRows({ rows = [] }) {
  const [expanded, setExpanded] = useState(false);
  // Rows that just left, still drawn while they fold. Each remembers where
  // it stood so the list does not jump while it goes.
  const [leaving, setLeaving] = useState([]);
  const prevRef = useRef(rows);
  const timers = useRef([]);
  // The row buttons by key, and the key that should take focus once drawn.
  const buttons = useRef(new Map());
  const focusKey = useRef(null);

  const keyList = rows.map((r) => r.key).join('|');
  useEffect(() => {
    const prev = prevRef.current;
    prevRef.current = rows;
    const now = new Set(rows.map((r) => r.key));
    const gone = prev.filter((r) => !now.has(r.key));
    if (gone.length === 0 || prefersReducedMotion()) return;
    setLeaving((l) => [
      ...l.filter((x) => !now.has(x.key)),
      ...gone.map((r) => ({ ...r, at: prev.indexOf(r) })),
    ]);
    const goneKeys = new Set(gone.map((r) => r.key));
    timers.current.push(setTimeout(() => {
      setLeaving((l) => l.filter((x) => !goneKeys.has(x.key)));
    }, NEST_ROW_LEAVE_MS + 20));
    // Keyed on the row keys, not the array: App.js hands a new array on every
    // render, and only a change in WHICH rows are open is news here.
  }, [keyList]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  // Show N more is gone once tapped; the first row it revealed takes focus.
  useEffect(() => {
    if (!expanded || focusKey.current == null) return;
    const el = buttons.current.get(focusKey.current);
    focusKey.current = null;
    if (el && typeof el.focus === 'function') el.focus({ preventScroll: true });
  }, [expanded]);

  const live = new Set(rows.map((r) => r.key));
  const stillLeaving = leaving.filter((r) => !live.has(r.key));
  if (rows.length === 0 && stillLeaving.length === 0) return null;

  const capped = expanded ? rows : rows.slice(0, NEST_ROWS_CAP);
  const hidden = rows.length - capped.length;
  // Put each leaving row back where it stood among the live ones.
  const drawn = capped.map((r) => ({ row: r, out: false }));
  stillLeaving
    .slice()
    .sort((a, b) => a.at - b.at)
    .forEach((r) => drawn.splice(Math.min(r.at, drawn.length), 0, { row: r, out: true }));

  const showMore = () => {
    focusKey.current = rows[NEST_ROWS_CAP] ? rows[NEST_ROWS_CAP].key : null;
    setExpanded(true);
  };

  return (
    <div data-nest-band="needs-you" style={{ marginBottom: BAND_GAP }}>
      <h2 style={BAND_HEAD}>Needs you</h2>
      <div style={{ backgroundColor: 'var(--bg-card-solid)', borderRadius: '12px', overflow: 'hidden' }}>
        {drawn.map(({ row, out }, i) => (
          <div
            key={row.key}
            data-nest-row={row.kind}
            aria-hidden={out ? 'true' : undefined}
            style={{
              display: 'grid',
              gridTemplateRows: out ? '0fr' : '1fr',
              opacity: out ? 0 : 1,
              transition: `grid-template-rows ${NEST_ROW_LEAVE_MS}ms var(--ease-out), opacity ${NEST_ROW_LEAVE_MS}ms var(--ease-out)`,
            }}
          >
            <div style={{ overflow: 'hidden', minHeight: 0 }}>
              <button
                type="button"
                className="nest-row-btn"
                ref={(el) => { if (el && !out) buttons.current.set(row.key, el); else buttons.current.delete(row.key); }}
                onClick={out ? undefined : row.onClick}
                tabIndex={out ? -1 : undefined}
                disabled={out}
                style={{
                  width: '100%',
                  minHeight: '60px',
                  padding: '11px 14px 11px 16px',
                  border: 'none',
                  background: 'none',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '12px',
                  textAlign: 'left',
                  cursor: 'pointer',
                  position: 'relative',
                  color: 'inherit',
                }}
              >
                {i > 0 && <span aria-hidden="true" style={{ position: 'absolute', top: 0, left: '46px', right: 0, height: '1px', backgroundColor: 'var(--divider)' }} />}
                <span aria-hidden="true" style={{ display: 'flex', flexShrink: 0 }}>{Icons[ICON[row.kind]]('var(--text-secondary)', 18)}</span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: 'block', fontSize: 'var(--t-body)', fontWeight: '600', color: 'var(--text-primary)', overflowWrap: 'anywhere' }}>{row.title}</span>
                  <RowLine when={row.when} venue={row.venue} />
                </span>
                <span aria-hidden="true" style={{ display: 'flex', flexShrink: 0 }}>{Icons.chevronRight('var(--text-tertiary)', 14)}</span>
              </button>
            </div>
          </div>
        ))}
        {hidden > 0 && (
          <button
            type="button"
            className="nest-row-btn"
            onClick={showMore}
            style={{
              width: '100%',
              minHeight: '44px',
              padding: '0 16px 0 46px',
              border: 'none',
              background: 'none',
              textAlign: 'left',
              fontSize: 'var(--t-label)',
              fontWeight: '600',
              color: 'var(--accent-purple-text)',
              cursor: 'pointer',
              position: 'relative',
            }}
          >
            <span aria-hidden="true" style={{ position: 'absolute', top: 0, left: '46px', right: 0, height: '1px', backgroundColor: 'var(--divider)' }} />
            Show {hidden} more
          </button>
        )}
      </div>
    </div>
  );
}
