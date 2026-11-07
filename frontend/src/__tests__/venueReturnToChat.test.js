/**
 * "BACK TO CHAT" LASTS AS LONG AS THE TRIP TO DISCOVER (2026-11-06).
 *
 * A chat or DM venue card sets venueDetailReturnTo and goes to Discover, where
 * the venue sheet's footer and the map card offer "Back to Chat" until it is
 * used. Nothing else cleared it. A screen recording of the iPhone app shows
 * Birdie's Details, opened on the Nest after an earlier trip, with "Back to
 * Chat" where "Add to Flock" belongs; the button led to that earlier thread,
 * not back to Birdie. Reproduced on the local stack: a flock's venue strip,
 * the sheet's X, the Nest tab, Birdie's Details, and the footer read "Back to
 * Chat".
 *
 * The trip ends when Discover is left or a new search is typed there. The
 * sheet's own X does not end it: closing the sheet leaves the map card for the
 * same place, whose "Back to Chat" is the way back that trip was for.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npm test -- --watchAll=false --testPathPattern=venueReturnToChat
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import VenueDetailSheet from '../components/overlays/VenueDetailSheet';

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(SRC, ...p), 'utf8').replace(/\r\n/g, '\n');
const APP = read('App.js');
const SHEET = read('components', 'overlays', 'VenueDetailSheet.js');
const CHAT = read('screens', 'ChatDetail.js');
const DM = read('screens', 'DmDetail.js');

const PARAMS = (() => {
  const start = SHEET.indexOf('const VenueDetailSheet = ({');
  const end = SHEET.indexOf('}) => {', start);
  return SHEET.slice(start, end).split('\n').map((l) => l.trim()).filter((l) => /^[A-Za-z_]\w*,$/.test(l)).map((l) => l.slice(0, -1));
})();

function sheetProps(over = {}) {
  const p = {};
  for (const name of PARAMS) p[name] = jest.fn();
  return Object.assign(p, {
    DialogBehavior: () => null,
    SearchInputLocal: () => null,
    httpUrl: (u) => (typeof u === 'string' && /^https?:/.test(u) ? u : null),
    colors: { navy: '#0d2847', navyBg: '#0d2847', steel: '#2d5a87', amber: '#F59E0B', red: '#EF4444', redText: '#b91c1c', textSecondary: '#556274', textTertiary: '#586376', disabled: '#e5e7eb' },
    venueDetailModal: { place_id: 'ChIJcopperFinch01', name: 'The Copper Finch', loading: false },
    venueDetailPhotoIdx: 0,
    venueDetailPromos: [],
    venueDetailEvents: [],
    venueDetailReviews: [],
    venueDetailReviewsError: null,
    venueDetailReturnTo: null,
    pickingVenueForDm: null,
    pickingVenueForFlockId: null,
    showReviewForm: false,
    flocks: [],
    flocksRef: { current: [] },
    meRef: { current: null },
    venueDetailCrowd: null,
    venueOwnerView: false,
    partySize: null,
  }, over);
}

describe('the sheet\'s primary button follows the way back it is handed', () => {
  test('with none, the sheet offers Add to Flock', () => {
    render(<VenueDetailSheet {...sheetProps()} />);
    expect(screen.getByRole('button', { name: /Add to Flock/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Back to chat/ })).toBeNull();
  });

  test('with one, Back to chat', () => {
    render(<VenueDetailSheet {...sheetProps({ venueDetailReturnTo: { tab: 'chat', screen: 'chatDetail', flockId: 7 } })} />);
    expect(screen.getByRole('button', { name: /Back to chat/ })).toBeTruthy();
  });
});

describe('the way back ends with the trip', () => {
  test('leaving Discover clears it', () => {
    expect(APP).toMatch(/useEffect\(\(\) => \{\s*if \(currentTab !== 'explore'\) setVenueDetailReturnTo\(null\);\s*\}, \[currentTab\]\);/);
  });

  test('a search typed on Discover clears it, and an emptied box does not', () => {
    const handler = APP.slice(APP.indexOf('const handleVenueQueryChange = useCallback'), APP.indexOf('}, [doVenueSearch, showSearchResults]);'));
    expect(handler).toContain("if (typeof val === 'string' && val.trim()) setVenueDetailReturnTo(null);");
  });

  test('every chat and DM door that sets it goes to Discover in the same tap, so the tab rule never clears it on the way in', () => {
    const doors = [];
    for (const [name, src] of [['ChatDetail', CHAT], ['DmDetail', DM]]) {
      let at = src.indexOf('setVenueDetailReturnTo({');
      while (at !== -1) {
        doors.push({ name, next: src.slice(at, src.indexOf('\n', at) + 1) + src.slice(src.indexOf('\n', at) + 1).split('\n').slice(0, 2).join('\n') });
        at = src.indexOf('setVenueDetailReturnTo({', at + 1);
      }
    }
    expect(doors.length).toBeGreaterThanOrEqual(7);
    doors.forEach((d) => expect({ door: d.name, goesToDiscover: d.next.includes("setCurrentTab('explore');") }).toEqual({ door: d.name, goesToDiscover: true }));
  });

  test('the sheet\'s X keeps it, for the map card\'s own Back to chat under the sheet', () => {
    expect(SHEET).toContain('const closeVenueDetail = () => { setVenueDetailModal(null); };');
  });
});
