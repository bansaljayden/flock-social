/**
 * THE VENUE SHEET STAYS CLEAR OF THE STATUS BAR (2026-11-06).
 *
 * On an iPhone a full-height venue sheet ran under the status bar: the photo
 * sat behind the clock and the battery and the close button just under the
 * battery icon. The backdrop covered the whole screen and the sheet was
 * centred in it at up to 92vh, and 4% of the screen is less than the status
 * bar and the Dynamic Island. The backdrop is now padded by the safe areas and
 * the sheet's height stops 16px short of the room between them.
 *
 * jsdom resolves no stylesheet and no env(), so the rule is read out of
 * index.css and the sheet is rendered to check it carries the class and pads
 * its backdrop.
 *
 * FRONTEND test (jest via react-scripts).
 */
import React from 'react';
import { render } from '@testing-library/react';
import VenueDetailSheet from '../components/overlays/VenueDetailSheet';

const fs = require('fs');
const path = require('path');
const postcss = require('postcss');

const CSS = fs.readFileSync(path.join(__dirname, '..', 'index.css'), 'utf8');
const SHEET_SRC = fs.readFileSync(path.join(__dirname, '..', 'components', 'overlays', 'VenueDetailSheet.js'), 'utf8').replace(/\r\n/g, '\n');

const noop = () => {};
const sheetProps = (over = {}) => ({
  DialogBehavior: () => null, SearchInputLocal: () => null, httpUrl: (u) => u || null, colors: { navy: '#0d2847', navyBg: '#0d2847', steel: '#2d5a87', red: '#b91c1c', amber: '#f59e0b', textSecondary: '#475569', textTertiary: '#64748b' },
  venueDetailModal: { place_id: 'p1', name: 'Copper Finch Cantina', formatted_address: '214 Main St', loading: false, rating: 4.3 },
  setVenueDetailModal: noop, venueDetailPhotoIdx: 0, setVenueDetailPhotoIdx: noop, venueDetailPlaceId: 'p1', venueDetailPromos: [], venueDetailEvents: [],
  venueDetailReviews: [], setVenueDetailReviews: noop, venueDetailReviewTotal: 0, setVenueDetailReviewTotal: noop, venueDetailReviewsError: '', loadVenueDetailReviews: noop,
  venueDetailReturnTo: null, setVenueDetailReturnTo: noop, setVenueDetailHistory: noop,
  showReviewForm: false, setShowReviewForm: noop, reviewRating: 0, setReviewRating: noop, reviewText: '', setReviewText: noop, reviewSubmitting: false, setReviewSubmitting: noop,
  pickingVenueForDm: false, setPickingVenueForDm: noop, pickingVenueForFlockId: null, setPickingVenueForFlockId: noop, setPickingVenueForCreate: noop, setSelectedVenueForCreate: noop,
  selectedDmId: null, setSelectedDmId: noop, setSelectedFlockId: noop, setCurrentTab: noop, setCurrentScreen: noop,
  flocks: [], flocksRef: { current: [] }, meRef: { current: null }, venueDetailCrowd: null, partySize: null, setPartySize: noop, setPaywallTrigger: noop, venueOwnerView: false,
  CROWD_FRESH_MS: 300000, HOUR_ORDERING_MIN_GAP: 10, crowdColorFor: () => '#22c55e', crowdInkFor: () => '#166534',
  confirmClick: noop, showToast: noop, setModerationTarget: noop, pinDmVenueNow: noop, updateFlockVenue: noop, updateFlockVotes: noop, shareVenueToChat: noop,
  ...over,
});

const declsOf = (selector, inAtRule) => {
  const out = {};
  postcss.parse(CSS).walkRules((rule) => {
    if (rule.selector !== selector) return;
    const at = rule.parent && rule.parent.type === 'atrule' ? `${rule.parent.name} ${rule.parent.params}` : null;
    if ((inAtRule || null) !== at) return;
    rule.walkDecls((d) => { out[d.prop] = d.value; });
  });
  return out;
};

test('the backdrop is padded by the safe areas', () => {
  // jsdom's style object drops a var() padding, so the backdrop's style is
  // read from the source and its box-sizing from the render.
  const { container } = render(<VenueDetailSheet {...sheetProps()} />);
  const backdrop = container.firstChild;
  expect(backdrop.style.position).toBe('fixed');
  expect(backdrop.style.boxSizing).toBe('border-box');
  const backdropStyle = SHEET_SRC.slice(SHEET_SRC.indexOf("backgroundColor: 'rgba(0,0,0,0.85)', zIndex: 9998"));
  expect(backdropStyle.slice(0, 400)).toMatch(/paddingTop: 'var\(--safe-top\)', paddingBottom: 'var\(--safe-bottom\)', boxSizing: 'border-box' \}\}/);
});

test('the sheet takes its height from .venue-sheet, not an inline 92vh', () => {
  const { container } = render(<VenueDetailSheet {...sheetProps()} />);
  const card = container.querySelector('.venue-sheet');
  expect(card).not.toBeNull();
  expect(card.style.maxHeight).toBe('');
});

test('.venue-sheet stops 16px short of the room between the safe areas, in dvh where the WebView has it', () => {
  const base = declsOf('.venue-sheet');
  expect(base['--venue-sheet-room']).toBe('calc(100vh - var(--safe-top) - var(--safe-bottom) - 16px)');
  expect(base['max-height']).toBe('var(--venue-sheet-room)');
  const dvh = declsOf('.venue-sheet', 'supports (height: 100dvh)');
  expect(dvh['--venue-sheet-room']).toBe('calc(100dvh - var(--safe-top) - var(--safe-bottom) - 16px)');
});
