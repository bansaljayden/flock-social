import React from 'react';

/**
 * The settings-form primitives, and the two plan-time choice lists.
 *
 * WHY THESE LEFT App.js. All five were declared at App.js module scope and
 * then handed to CreateScreen and FlockDetail through their prop bags. Both
 * of those screens are React.lazy, so the code that RENDERS these lived in a
 * split chunk while the code that DEFINES them sat in the boot chunk, which
 * every visitor downloads before anything is on screen. Nothing in App.js
 * draws a FormGroup, a FormRow or a ChoiceChip: there is not one of those
 * tags in the file. Moving them here and importing them where they are drawn
 * puts the bytes in the chunk that needs them.
 *
 * They take props and read CSS custom properties, and they close over
 * nothing, which is what made this a move rather than a refactor.
 *
 * ---------------------------------------------------------------------------
 * WHAT FormGroup AND FormRow ENCODE, and why the shape is what it is.
 *
 * Written for the Create Flock rebuild. That screen was one undifferentiated
 * column of six controls stacked on the page background, which is the failure
 * SLOP-AUDIT section S names: every row carries identical weight, so the eye
 * has nowhere to rest and the reader has to take in all of it to find one
 * thing.
 *
 * The rules these two encode, straight out of section S:
 *
 *   3. Groups are separated by the PAGE BACKGROUND, rows inside a group by
 *      inset hairlines. Never one card per row, which is the rounded-bubble
 *      tile grid A14 bans.
 *   4. The group label sits OUTSIDE the container, small and grey. It is a
 *      signpost, so giving it card chrome of its own doubles its weight for
 *      nothing.
 *
 * Deliberately not a card grid, not an icon in a rounded square, and not a
 * section that animates in. A hairline and a grey word do the whole job.
 * ---------------------------------------------------------------------------
 */

export const FLOCK_DAY_CHOICES = ['Tonight', 'Tomorrow', 'This Weekend', 'Next Week'];
export const FLOCK_HOUR_CHOICES = ['7 PM', '8 PM', '9 PM', '10 PM', '11 PM'];

export const FormGroup = ({ label, children, style }) => (
  <section style={{ marginBottom: '18px', ...style }}>
    {label && (
      <p style={{ fontSize: 'var(--t-micro)', fontWeight: '700', color: 'var(--text-tertiary)', margin: '0 0 6px 4px', textTransform: 'uppercase', letterSpacing: '0.6px' }}>{label}</p>
    )}
    <div style={{ backgroundColor: 'var(--bg-card-solid)', border: '1px solid var(--border-default)', borderRadius: '14px', boxShadow: 'var(--card-shadow-sm)' }}>
      {children}
    </div>
  </section>
);

export const FormRow = ({ children, divided = false, style }) => (
  <div style={{ padding: '12px', borderTop: divided ? '1px solid var(--divider)' : 'none', ...style }}>{children}</div>
);

// A choice chip. One function for the day grid, the hour row and the budget
// context row, because they were three hand-rolled versions of the same
// control and two of them lit up GREEN with a coloured glow behind them on
// selection. Green is not in the palette (cream, navy, steel) and a glow is
// the ornament SLOP-AUDIT keeps cutting. Selected is a filled steel chip with
// white type: one channel of colour, one of weight, no shadow.
export const ChoiceChip = ({ selected, onClick, children, style, ...rest }) => (
  <button
    type="button"
    className="hit44"
    aria-pressed={selected}
    onClick={onClick}
    style={{
      padding: '9px 14px',
      borderRadius: '10px',
      border: selected ? '1.5px solid transparent' : '1.5px solid var(--border-default)',
      backgroundColor: selected ? '#2d5a87' : 'var(--bg-card-solid)',
      color: selected ? '#ffffff' : 'var(--text-primary)',
      fontWeight: '600',
      fontSize: 'var(--t-label)',
      cursor: 'pointer',
      transition: 'background-color 0.15s ease, color 0.15s ease',
      ...style,
    }}
    {...rest}
  >
    {children}
  </button>
);
