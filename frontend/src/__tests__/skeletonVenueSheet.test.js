/**
 * THE VENUE CARD WAITS IN ITS OWN SHAPES.
 *
 * While Place Details answered, the card drew a ring and "Loading details..."
 * where the stat tiles, Hours, Contact, View Menu and the tags go, and
 * "Loading reviews..." where the reviews go; opened with no venue in hand (a
 * notification tap, the forecast's way back) it printed "Loading..." as the
 * venue's name. Rendered here with the real component.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test --watchAll=false skeletonVenueSheet
 */
import React from 'react';
import fs from 'fs';
import path from 'path';
import { render, screen } from '@testing-library/react';
import VenueDetailSheet from '../components/overlays/VenueDetailSheet';

const SRC = path.join(__dirname, '..');
const SHEET_SRC = fs.readFileSync(path.join(SRC, 'components', 'overlays', 'VenueDetailSheet.js'), 'utf8');
const APP_SRC = fs.readFileSync(path.join(SRC, 'App.js'), 'utf8');

/** The sheet's parameter names, read off its signature. */
const PARAMS = (() => {
  const start = SHEET_SRC.indexOf('const VenueDetailSheet = ({');
  const end = SHEET_SRC.indexOf('}) => {', start);
  return SHEET_SRC.slice(start, end).split('\n').map((l) => l.trim()).filter((l) => /^[A-Za-z_]\w*,$/.test(l)).map((l) => l.slice(0, -1));
})();

const props = (over = {}) => {
  const p = {};
  for (const name of PARAMS) p[name] = jest.fn();
  return Object.assign(p, {
    DialogBehavior: () => null,
    SearchInputLocal: () => null,
    httpUrl: (u) => (typeof u === 'string' && /^https?:/.test(u) ? u : null),
    colors: {},
    venueDetailModal: { place_id: 'ChIJcopperFinch01', name: 'The Copper Finch', loading: true },
    venueDetailPhotoIdx: 0,
    venueDetailPlaceId: 'ChIJcopperFinch01',
    venueDetailPromos: [],
    venueDetailEvents: [],
    venueDetailReviews: [],
    venueDetailReviewTotal: 0,
    venueDetailReviewsError: null,
    venueDetailReturnTo: null,
    pickingVenueForDm: null,
    pickingVenueForFlockId: null,
    showReviewForm: false,
    reviewRating: 0,
    reviewText: '',
    reviewSubmitting: false,
    flocks: [],
    flocksRef: { current: [] },
    meRef: { current: null },
    crowdData: null,
  }, over);
};

const sizes = (container) => Array.from(container.querySelectorAll('.skeleton')).map((b) => `${b.style.width}x${b.style.height}`);

function expectNoSpinnerOrLoadingText(container) {
  const spinning = Array.from(container.querySelectorAll('*')).filter((el) => /spin\b/.test(el.style.animation || ''));
  expect(spinning).toEqual([]);
  expect(container.textContent).not.toMatch(/Loading\.\.\.|Loading details\.\.\.|Loading reviews\.\.\./);
}

test('the parameter list was read', () => {
  expect(PARAMS).toContain('venueDetailModal');
  expect(PARAMS).toContain('venueDetailReviews');
});

test('while the details load: three stat tiles, Hours, Contact\'s two rows, View Menu and three tags, no ring', () => {
  const { container } = render(<VenueDetailSheet {...props()} />);
  expect(screen.getByText('Loading details')).toBeTruthy();
  const tiles = Array.from(container.querySelectorAll('div')).filter((d) => d.style.height === '62px' && d.style.borderRadius === '12px');
  expect(tiles).toHaveLength(3);
  const s = sizes(container);
  // Contact's phone and website rows.
  expect(s.filter((x) => x === '100%x32px')).toHaveLength(2);
  // A line a day under Hours.
  expect(s.filter((x) => /%x11px$/.test(x))).toHaveLength(7);
  // The three type tags.
  expect(s).toEqual(expect.arrayContaining(['64pxx24px', '88pxx24px', '56pxx24px']));
  // No invented figures: nothing that reads as a rating or a price.
  expect(container.textContent).not.toMatch(/\$|★|\d\.\d/);
  expectNoSpinnerOrLoadingText(container);
});

test('the name the card was opened with stays in its header while the rest loads', () => {
  render(<VenueDetailSheet {...props()} />);
  expect(screen.getByRole('heading', { name: 'The Copper Finch' })).toBeTruthy();
});

test('opened with no venue in hand, the header draws the name\'s line in the dark tone, not "Loading..."', () => {
  const { container } = render(<VenueDetailSheet {...props({ venueDetailModal: { name: '', loading: true } })} />);
  const heading = container.querySelector('h2');
  const bar = heading.querySelector('.skeleton');
  expect(bar).not.toBeNull();
  expect(bar.className).toBe('skeleton skeleton-dark');
  expect(heading.textContent).toBe('');
  expectNoSpinnerOrLoadingText(container);
});

test('App.js opens that card with an empty name, not the word Loading', () => {
  expect(APP_SRC).toContain("setVenueDetailModal(fallbackData ? { ...fallbackData, loading: true } : { name: '', loading: true });");
  expect(APP_SRC).not.toContain("{ name: 'Loading...', loading: true }");
});

test('while the reviews load: two review rows, the face, the name, the stars and a line, no rating', () => {
  const { container } = render(<VenueDetailSheet {...props({ venueDetailModal: { place_id: 'ChIJcopperFinch01', name: 'The Copper Finch', loading: false }, venueDetailReviews: null })} />);
  expect(screen.getByText('Loading reviews')).toBeTruthy();
  const faces = Array.from(container.querySelectorAll('.skeleton')).filter((b) => b.style.width === '24px' && b.style.borderRadius === '50%');
  expect(faces).toHaveLength(2);
  expect(sizes(container).filter((x) => x === '64pxx12px')).toHaveLength(2);
  expect(screen.queryByText('No reviews yet. Be the first!')).toBeNull();
  expect(screen.queryByRole('img', { name: /out of 5 stars/ })).toBeNull();
  expectNoSpinnerOrLoadingText(container);
});

test('once both have answered there is no skeleton left on the card', () => {
  const { container } = render(<VenueDetailSheet {...props({ venueDetailModal: { place_id: 'ChIJcopperFinch01', name: 'The Copper Finch', loading: false }, venueDetailReviews: [] })} />);
  expect(container.querySelectorAll('.skeleton')).toHaveLength(0);
  expect(screen.getByText('No reviews yet. Be the first!')).toBeTruthy();
});
