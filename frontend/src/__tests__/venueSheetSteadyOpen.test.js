/**
 * THE VENUE SHEET OPENS AT ITS FULL HEIGHT AND KEEPS ITS PICTURE (2026-11-06).
 *
 * A tester's recording: the sheet opened at half height over the loading
 * shapes, jumped to full height when Place Details answered, and its header
 * photo blanked to beige for a moment before coming back. From Birdie's
 * Details it opened on a dark empty header. Two changes:
 *
 *   - .venue-sheet has one height from the first frame (the room between the
 *     safe areas, to 860px), so nothing jumps when the details land.
 *   - The header photo on screen stays, with its own credit, until the next
 *     photo has decoded; a photo that fails to load never replaces it. With
 *     no photo yet, the header map holds the place.
 *
 * FRONTEND test (jest via react-scripts).
 */
import React from 'react';
import { render, act } from '@testing-library/react';
import VenueDetailSheet from '../components/overlays/VenueDetailSheet';

const fs = require('fs');
const path = require('path');
const postcss = require('postcss');

const CSS = fs.readFileSync(path.join(__dirname, '..', 'index.css'), 'utf8');

const noop = () => {};
const sheetProps = (modal) => ({
  DialogBehavior: () => null, SearchInputLocal: () => null, httpUrl: (u) => u || null, colors: { navy: '#0d2847', navyBg: '#0d2847', steel: '#2d5a87', red: '#b91c1c', amber: '#f59e0b', textSecondary: '#475569', textTertiary: '#64748b' },
  venueDetailModal: modal,
  setVenueDetailModal: noop, venueDetailPhotoIdx: 0, setVenueDetailPhotoIdx: noop, venueDetailPlaceId: modal.place_id, venueDetailPromos: [], venueDetailEvents: [],
  venueDetailReviews: [], setVenueDetailReviews: noop, venueDetailReviewTotal: 0, setVenueDetailReviewTotal: noop, venueDetailReviewsError: '', loadVenueDetailReviews: noop,
  venueDetailReturnTo: null, setVenueDetailReturnTo: noop, setVenueDetailHistory: noop,
  showReviewForm: false, setShowReviewForm: noop, reviewRating: 0, setReviewRating: noop, reviewText: '', setReviewText: noop, reviewSubmitting: false, setReviewSubmitting: noop,
  pickingVenueForDm: false, setPickingVenueForDm: noop, pickingVenueForFlockId: null, setPickingVenueForFlockId: noop, setPickingVenueForCreate: noop, setSelectedVenueForCreate: noop,
  selectedDmId: null, setSelectedDmId: noop, setSelectedFlockId: noop, setCurrentTab: noop, setCurrentScreen: noop,
  flocks: [], flocksRef: { current: [] }, meRef: { current: null }, venueDetailCrowd: null, partySize: null, setPartySize: noop, setPaywallTrigger: noop, venueOwnerView: false,
  CROWD_FRESH_MS: 300000, HOUR_ORDERING_MIN_GAP: 10, crowdColorFor: () => '#22c55e', crowdInkFor: () => '#166534',
  confirmClick: noop, showToast: noop, setModerationTarget: noop, pinDmVenueNow: noop, updateFlockVenue: noop, updateFlockVotes: noop, shareVenueToChat: noop,
});

const SEED = { place_id: 'p1', name: 'Copper Finch Cantina', formatted_address: '214 Main St', photo_url: 'https://x.test/seed.jpg', photo_attribution: { name: 'A. Seed' }, loading: true };
const DETAILS = { ...SEED, loading: false, rating: 4.3, photos: ['https://x.test/details-0.jpg', 'https://x.test/details-1.jpg'], photo_attributions: [{ name: 'B. Details' }, { name: 'C. Details' }] };

// Each new Image's decode() is held until the test settles it.
let decodes;
const realDecode = HTMLImageElement.prototype.decode;
beforeEach(() => {
  decodes = [];
  HTMLImageElement.prototype.decode = function decode() {
    const img = this;
    return new Promise((resolve, reject) => { decodes.push({ src: img.src, resolve, reject }); });
  };
});
afterEach(() => { HTMLImageElement.prototype.decode = realDecode; });

const headerImg = (container) => container.querySelector('.venue-sheet img');
const settle = async (src, ok = true) => {
  const d = decodes.find((x) => x.src === src);
  expect(d).toBeTruthy();
  await act(async () => { if (ok) d.resolve(); else d.reject(new Error('EncodingError')); });
};

test('the seed photo stays until the details photo has decoded, then they swap', async () => {
  const { container, rerender } = render(<VenueDetailSheet {...sheetProps(SEED)} />);
  expect(headerImg(container).getAttribute('src')).toBe(SEED.photo_url);
  rerender(<VenueDetailSheet {...sheetProps(DETAILS)} />);
  // The answer landed: the header still draws the seed, with the seed's credit.
  expect(headerImg(container).getAttribute('src')).toBe(SEED.photo_url);
  expect(container.textContent).toMatch(/A\. Seed/);
  expect(container.textContent).not.toMatch(/B\. Details/);
  await settle(DETAILS.photos[0]);
  expect(headerImg(container).getAttribute('src')).toBe(DETAILS.photos[0]);
  expect(container.textContent).toMatch(/B\. Details/);
});

test('a details photo that will not decode never replaces the seed', async () => {
  const { container, rerender } = render(<VenueDetailSheet {...sheetProps(SEED)} />);
  rerender(<VenueDetailSheet {...sheetProps(DETAILS)} />);
  await settle(DETAILS.photos[0], false);
  expect(headerImg(container).getAttribute('src')).toBe(SEED.photo_url);
});

test('with no seed photo the header map holds the place until the first photo can be drawn', async () => {
  const noSeed = { place_id: 'p1', name: 'Copper Finch Cantina', loading: true, location: { latitude: 40.6, longitude: -75.3 } };
  const { container, rerender } = render(<VenueDetailSheet {...sheetProps(noSeed)} />);
  const before = headerImg(container) && headerImg(container).getAttribute('src');
  expect(before).not.toBe(DETAILS.photos[0]);
  rerender(<VenueDetailSheet {...sheetProps({ ...DETAILS, photo_url: null, photo_attribution: null, location: noSeed.location })} />);
  expect(headerImg(container) && headerImg(container).getAttribute('src')).not.toBe(DETAILS.photos[0]);
  await settle(DETAILS.photos[0]);
  expect(headerImg(container).getAttribute('src')).toBe(DETAILS.photos[0]);
});

test('the sheet has one height from the first frame', () => {
  let decl = null;
  postcss.parse(CSS).walkRules('.venue-sheet', (rule) => {
    if (rule.parent && rule.parent.type === 'atrule') return;
    rule.walkDecls('height', (d) => { decl = d.value; });
  });
  expect(decl).toBe('min(860px, var(--venue-sheet-room))');
  const { container } = render(<VenueDetailSheet {...sheetProps(SEED)} />);
  // No inline height or maxHeight on the card fights the class.
  const card = container.querySelector('.venue-sheet');
  expect(card.style.height).toBe('');
  expect(card.style.maxHeight).toBe('');
});
