/**
 * NO CHIP OVER A CARRIED READING (2026-11-06).
 *
 * A tester's crowd card read a green, pulsing LIVE over "From this venue's
 * live reading taken an hour ago." The number was the model path's ('ml'),
 * built seconds earlier, so it passed every LIVE test, while the number itself
 * was a reading carried forward from an hour before. The first fix swapped
 * the chip's word for the reading's age ("1 HR AGO"); the same evening every
 * LIVE label and status dot left the product (noLiveDotLabel.test.js), so the
 * panel draws no chip at all and the line under the dial gives the age in
 * words without calling the reading live. This pins the tester's case and the
 * adjusted, older one against the chip coming back in either form.
 *
 * FRONTEND test (jest via react-scripts).
 */
import React from 'react';
import { render } from '@testing-library/react';
import { CrowdForecastPanel } from '../components/venue/ConsumerVenueCard';
import { REPORTS_ADJUSTED_WORDS } from '../lib/crowd';

const PLACE = 'ChIJcopperFinch01';
const colors = {
  navy: '#0d2847', navyBg: '#0d2847', steel: '#2d5a87', amber: '#F59E0B', amberText: '#b45309',
  red: '#EF4444', redText: '#b91c1c', textSecondary: '#556274', textTertiary: '#586376', disabled: '#e5e7eb',
};
const crowdBand = (s) => (!Number.isFinite(s) ? null : s > 84 ? 'red' : s > 39 ? 'amber' : 'green');
const crowdColorFor = (s) => ({ red: '#EF4444', amber: '#F59E0B', green: '#22C55E' })[crowdBand(s)] || null;
const crowdInkFor = (s) => ({ red: 'var(--accent-red-text)', amber: 'var(--accent-amber-text)', green: 'var(--accent-green-text)' })[crowdBand(s)] || null;
const HOURS = ['3 PM', '4 PM', '5 PM', '6 PM', '7 PM', '8 PM', '9 PM', '10 PM', '11 PM', '12 AM', '1 AM', '2 AM'];
const hourly = HOURS.map((hour, i) => ({ hour, score: 30 + (i % 4) * 5, open: i < 7 }));
const read = (over = {}) => ({
  forPlaceId: PLACE, score: 30, label: 'Not Busy', predictionMethod: 'ml', lastUpdated: new Date().toISOString(), hourly,
  bestTime: 'Now is good', bestIsNow: true, peak: '7 PM', isOpen: true,
  venueClock: { hour: new Date().getHours(), day: new Date().getDay(), local: true }, confidenceBasis: 'venue_baseline', ...over,
});
const panel = (crowdData) => (
  <CrowdForecastPanel venue={{ place_id: PLACE, name: 'The Copper Finch', opening_hours: { openNow: true } }} HOUR_ORDERING_MIN_GAP={10}
    crowdColorFor={crowdColorFor} crowdInkFor={crowdInkFor} colors={colors} crowdData={crowdData} crowdFetchFailed={false} crowdLoading={false}
    partySize={null} setPartySize={jest.fn()} setPaywallTrigger={jest.fn()} />
);

let getContext;
beforeEach(() => {
  getContext = jest.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ({ clearRect() {}, drawImage() {}, beginPath() {}, arc() {}, stroke() {} }));
});
afterEach(() => getContext.mockRestore());

const noChip = (container) => {
  expect(container.textContent).not.toMatch(/\bLIVE\b|ESTIMATED|\bHRS? AGO\b/);
  const pulsing = Array.from(container.querySelectorAll('[style]')).filter((el) => /(?<![\w-])pulse(?![\w-])/.test(el.getAttribute('style')));
  expect(pulsing).toHaveLength(0);
};

test('the tester\'s case: a reading carried from an hour ago draws no chip, and the line gives its age without "live"', () => {
  const { container, getByText } = render(panel(read({ numberSource: 'live_reading_1h' })));
  const line = getByText("From this venue's reading taken an hour ago.");
  expect(line.textContent).not.toMatch(/\blive\b/i);
  noChip(container);
});

test('three hours old and adjusted by reports: no chip, and the line says both', () => {
  const { container, getByText } = render(panel(read({ numberSource: 'live_reading_3h_adjusted', confidenceBasis: 'user_reports' })));
  const line = getByText(`From this venue's reading taken 3 hours ago, ${REPORTS_ADJUSTED_WORDS}.`);
  expect(line.textContent).not.toMatch(/\blive\b/i);
  noChip(container);
});
