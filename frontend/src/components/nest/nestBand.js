/**
 * THE NEST'S BAND HEADINGS AND THE ROOM BETWEEN BANDS (2026-11-06).
 *
 * Below the hero every band heading (Needs you, Out tonight?, Coming up,
 * Still open, Ask Birdie) was 15px semibold in the primary ink: the same size
 * and weight as the row titles under it ("Vote on Sam's Birthday"), and every
 * band was the same unit, heading, 10px, a white card, 28px. The page below
 * the hero read as one flat settings list.
 *
 * Now a heading is a label in the type scale's own role for section labels
 * (--t-label, 13/600, index.css TYPE SCALE) in the secondary ink, with 8px to
 * what it labels, so it steps back and the things a person acts on lead: the
 * plan names in the display face, the row titles at 15/600. And the room
 * between bands is not one number: Needs you sits close under the hero (its
 * rows are the hero's own kind of thing, what needs you now), and the bands
 * after it open up, so the page reads as a few groups rather than a run of
 * equal ones.
 */

/** A band's heading: a section label, 13/600 in the secondary ink. */
export const BAND_HEAD = {
  margin: '0 0 8px',
  fontSize: 'var(--t-label)',
  fontWeight: '600',
  lineHeight: 1.3,
  color: 'var(--text-secondary)',
};

/**
 * A label inside a band, over a group of its cards (Coming up's This week,
 * Later). It sat in the band heading's own type, 13px in the secondary ink
 * 8px under it, so Coming up over This week read as two headings stacked,
 * and Later over Still open as two bands. It is quieter and of another kind:
 * the type scale's supporting-text role (--t-meta, 12/500) in the tertiary
 * ink, a hairline running on from it to the edge in --nest-edge (the line
 * the page already draws where it scrolls under its edges), and room above
 * it, 12px under the band's heading and 20px under the group before.
 */
export const BAND_LABEL = {
  display: 'flex',
  alignItems: 'center',
  gap: '10px',
  margin: '0 0 8px',
  fontSize: 'var(--t-meta)',
  fontWeight: '500',
  lineHeight: 1.3,
  color: 'var(--text-tertiary)',
};
/** The hairline after a band label, drawn for the eye only. */
export const BAND_LABEL_RULE = { flex: 1, minWidth: '24px', height: '1px', backgroundColor: 'var(--nest-edge)' };
/** Room above a band label: under the band's heading, then under the group before. */
export const LABEL_GAP_FIRST = '12px';
export const LABEL_GAP = '20px';

/** Under the hero, before Needs you. */
export const HERO_GAP = '20px';
/** After every other band. */
export const BAND_GAP = '32px';
