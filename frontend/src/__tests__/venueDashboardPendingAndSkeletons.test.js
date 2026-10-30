/**
 * THE VENUE DASHBOARD ANSWERS EVERY TAP, AND LOADS IN THE SHAPE OF ITS LISTS.
 *
 *   - Save Hours, the Venue Information Save, a review reply and the trash on
 *     a deal or an event had no pending state: each sat looking untouched
 *     until the server answered and took a second tap meanwhile. Each is a
 *     BusyButton now, held and labelled from the tap until the save settles.
 *   - The deals, events and flocks lists and the Reviews tab said "Loading
 *     your ..." in a line of text; the logo picker showed a spinner. Each
 *     draws grey shapes of what is coming now, with no figure in them.
 *
 * The switches that moved only once their save came back are in
 * venueTablesPanel.test.js and venueTablesPhase2.test.js, and the plan
 * button that opens Stripe's billing page is in roostNotSoldInApp.test.js.
 */
import fs from 'fs';
import path from 'path';
import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';

jest.mock('../services/api', () => ({
  getVenueBillingStatus: jest.fn(() => Promise.resolve(null)),
  startVenueCheckout: jest.fn(),
  openVenuePortal: jest.fn(),
  deleteVenuePromotion: jest.fn(),
  deleteVenueEvent: jest.fn(),
  replyToReview: jest.fn(),
  updateVenueProfile: jest.fn(),
  updateSensorTableSettings: jest.fn(),
  userMessage: jest.requireActual('../services/api').userMessage,
}));
jest.mock('../components/ui/BirdieBird', () => {
  const R = require('react');
  const Stub = () => null;
  const BirdNote = ({ body, action }) => R.createElement('div', null, body, action || null);
  return { __esModule: true, default: Stub, BirdieStill: Stub, BirdNote, WARM_BIRD: {}, BIRDIE: {} };
});
jest.mock('../components/VenueInsightCards', () => ({ __esModule: true, default: () => null, clearAdvisorCards: () => {} }));
jest.mock('../components/VenueAdvisorChat', () => ({ __esModule: true, default: () => null }));

// eslint-disable-next-line import/first
import VenueDashboard from '../screens/VenueDashboard';
// eslint-disable-next-line import/first
import * as api from '../services/api';

const DASH = fs.readFileSync(path.join(__dirname, '..', 'screens', 'VenueDashboard.js'), 'utf8').replace(/\r\n/g, '\n');
const PARAMS = (() => {
  const s = DASH.indexOf('export default function VenueDashboard({');
  const block = DASH.slice(s, DASH.indexOf('}) {', s));
  return [...block.matchAll(/^\s+([A-Za-z_]\w*),/gm)].map((m) => m[1]);
})();
const STUB_COMPONENTS = new Set(['DialogBehavior', 'EventModal', 'MapLibreMapView', 'ModerationHiddenNotice', 'PromoModal', 'SearchInputLocal']);
const FUNCTIONS = /^(set|handle|load|open|render|retry|cancel|switch|calc|get|crowd|is|member)[A-Za-z]/;

const BASE = {
  colors: new Proxy({}, { get: () => '#2d5a87' }),
  HOUR_BAR_WELL_PX: 50,
  venueTab: 'promotions',
  venueTier: 'pro',
  venueTierKnown: true,
  venueBillingOn: true,
  venueProfile: { business_name: 'Hoppers', verification_status: 'verified', google_place_id: 'place_1' },
  venueInfo: { name: 'Hoppers', address: '', phone: '' },
  venueOnboardingData: {},
  venueListErrors: {},
  venueListLoaded: { promotions: true, events: true, incomingFlocks: true },
  venueReviewsData: { reviews: [], stats: null, loaded: true },
  realIncomingFlocks: [],
  promotions: [],
  venueEventsList: [],
  operatingHours: [],
  dealDescription: '',
  dealTimeSlot: 'Happy Hour',
  dealCustomTime: '',
  ownerSensorHistory: [],
  showUpgradeModal: false,
  venuePlanPriceLabel: () => null,
  venueProfileToIntake: jest.fn(),
  ownerTablesSeen: false,
};

function dashboard(overrides = {}) {
  const props = {};
  for (const name of PARAMS) {
    if (STUB_COMPONENTS.has(name)) props[name] = () => null;
    else if (FUNCTIONS.test(name)) props[name] = jest.fn();
    else props[name] = undefined;
  }
  const all = { ...props, showToast: jest.fn(), onLogout: jest.fn(), ...BASE, ...overrides };
  return { ...render(<VenueDashboard {...all} />), props: all };
}
const settle = () => act(async () => {});
const skeletons = (container) => [...container.querySelectorAll('.skeleton')];
// The spoken line sits beside the busy rows, never inside them: a line in a
// busy subtree may be held back, and these are unmounted rather than turned
// not-busy (components/ui/Skeleton.js SkeletonStatus says why).
const expectLineBesideBusy = (text) => {
  const line = screen.getAllByRole('status').find((s) => s.textContent === text);
  expect(line).toBeDefined();
  expect(line.closest('[aria-busy="true"]')).toBeNull();
  const busy = line.nextElementSibling;
  expect(busy.getAttribute('aria-busy')).toBe('true');
  expect(busy.querySelector('.skeleton')).not.toBeNull();
};

describe('a list whose first read is out draws its rows, not a sentence', () => {
  test('deals: two rows in the deal\'s shape, and no claim either way', async () => {
    const { container } = dashboard({ venueListLoaded: {} });
    await settle();
    expect(screen.getByRole('status').textContent).toBe('Loading your deals.');
    expect(container.textContent).not.toMatch(/Loading your deals…|No promotions yet/);
    // Two rows, each a title, a time line, Edit, Delete and the views count.
    expect(skeletons(container).length).toBe(10);
    expectLineBesideBusy('Loading your deals.');
  });

  test('events and the flocks voting on the venue: two rows each', async () => {
    const { container } = dashboard({ venueTab: 'events', venueListLoaded: {} });
    await settle();
    const statuses = screen.getAllByRole('status').map((s) => s.textContent);
    expect(statuses).toEqual(expect.arrayContaining(['Loading the flocks voting on you.', 'Loading your events.']));
    expect(container.textContent).not.toMatch(/No events yet|No flock has you in its vote yet/);
    // Flock rows: name, when and the status pill. Event rows: title, when,
    // the status line, Edit and Delete.
    expect(skeletons(container).length).toBe(2 * 3 + 2 * 5);
    expectLineBesideBusy('Loading the flocks voting on you.');
    expectLineBesideBusy('Loading your events.');
  });

  test('reviews: the score block and five 6px bars, with no number in them', async () => {
    const { container } = dashboard({ venueTab: 'reviews', venueReviewsData: { reviews: [], stats: null, loaded: false } });
    await settle();
    expect(screen.getByRole('status').textContent).toBe('Loading your reviews.');
    expect(container.textContent).not.toMatch(/No reviews yet|\d(\.\d)? out of 5/);
    const bars = skeletons(container).filter((el) => el.style.height === '6px');
    expect(bars).toHaveLength(5);
    expectLineBesideBusy('Loading your reviews.');
    // The card's own row layout stays on the busy part.
    const card = screen.getByText('Loading your reviews.').nextElementSibling;
    expect(card.style.display).toBe('flex');
    expect(card.style.gap).toBe('16px');
  });

  test('the logo picker: four tiles at the tiles\' own size, not a spinner', async () => {
    const { container } = dashboard({ venueLogoPicker: 'loading' });
    await settle();
    expect(screen.getByRole('status').textContent).toBe('Loading photos');
    const tiles = skeletons(container).filter((el) => el.style.height === '96px');
    expect(tiles).toHaveLength(4);
    expectLineBesideBusy('Loading photos');
    expect(screen.getByText('Loading photos').nextElementSibling.style.display).toBe('grid');
    const loading = DASH.slice(DASH.indexOf("{venueLogoPicker === 'loading' && ("), DASH.indexOf("{venueLogoPicker === 'error' && ("));
    expect(loading.length).toBeGreaterThan(0);
    expect(loading).not.toMatch(/animation: 'spin/);
  });
});

describe('a save holds its button from the tap until the server answers', () => {
  const realConfirm = window.confirm;
  afterEach(() => { window.confirm = realConfirm; });

  test('a deal\'s trash asks first, and a cancel holds nothing and sends nothing', async () => {
    window.confirm = jest.fn(() => false);
    dashboard({ promotions: [{ id: 4, title: 'Two-for-one', time_slot: 'Happy Hour', days: 'Daily' }] });
    await settle();
    const trash = screen.getByRole('button', { name: 'Delete Two-for-one' });
    fireEvent.click(trash);
    expect(window.confirm).toHaveBeenCalledWith('Delete "Two-for-one"? Groups looking at your venue will stop seeing it.');
    expect(api.deleteVenuePromotion).not.toHaveBeenCalled();
    expect(trash.disabled).toBe(false);
  });

  test('a confirmed delete is held, one request however fast the taps, then the row goes', async () => {
    window.confirm = jest.fn(() => true);
    let answer;
    api.deleteVenuePromotion.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    const { props } = dashboard({ promotions: [{ id: 4, title: 'Two-for-one', time_slot: 'Happy Hour', days: 'Daily' }] });
    await settle();
    const trash = screen.getByRole('button', { name: 'Delete Two-for-one' });
    fireEvent.click(trash);
    fireEvent.click(trash);
    expect(api.deleteVenuePromotion).toHaveBeenCalledTimes(1);
    expect(window.confirm).toHaveBeenCalledTimes(1);
    expect(trash.disabled).toBe(true);
    expect(trash.getAttribute('aria-busy')).toBe('true');
    await act(async () => { answer({}); });
    expect(props.showToast).toHaveBeenCalledWith('Deal deleted');
    const drop = props.setPromotions.mock.calls[0][0];
    expect(drop([{ id: 4 }, { id: 5 }])).toEqual([{ id: 5 }]);
  });

  test('an event\'s trash works the same way', async () => {
    window.confirm = jest.fn(() => true);
    api.deleteVenueEvent.mockRejectedValueOnce(Object.assign(new Error('This event was taken down. Delete it and create a new one.'), { status: 409, userFacing: true }));
    const { props } = dashboard({ venueTab: 'events', venueEventsList: [{ id: 8, title: 'Quiz night', date: null, time: null }] });
    await settle();
    const trash = screen.getByRole('button', { name: 'Delete Quiz night' });
    fireEvent.click(trash);
    expect(window.confirm).toHaveBeenCalledWith('Delete "Quiz night"? Groups looking at your venue will stop seeing it.');
    await settle();
    // The server's own sentence, which says what to do next, and the button
    // is free again for that.
    expect(props.showToast).toHaveBeenCalledWith('This event was taken down. Delete it and create a new one.', 'error');
    expect(trash.disabled).toBe(false);
  });

  test('Save Hours says Saving and takes one tap', async () => {
    let answer;
    api.updateVenueProfile.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    const { props } = dashboard({ showHoursModal: true, operatingHours: [{ days: 'Mon-Fri', open: '5 PM', close: '1 AM' }] });
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Save Hours' }));
    const saving = screen.getByRole('button', { name: 'Saving' });
    fireEvent.click(saving);
    expect(api.updateVenueProfile).toHaveBeenCalledTimes(1);
    expect(saving.disabled).toBe(true);
    await act(async () => { answer({}); });
    expect(props.setShowHoursModal).toHaveBeenCalledWith(false);
  });

  test('Save Hours that failed frees the button and says so in plain words', async () => {
    api.updateVenueProfile.mockRejectedValueOnce(new TypeError("Cannot read properties of undefined (reading 'rows')"));
    const { props } = dashboard({ showHoursModal: true, operatingHours: [{ days: 'Mon-Fri', open: '5 PM', close: '1 AM' }] });
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Save Hours' }));
    await settle();
    expect(props.showToast).toHaveBeenCalledWith("Those hours didn't save. Try again.", 'error');
    expect(screen.getByRole('button', { name: 'Save Hours' }).disabled).toBe(false);
    expect(props.setShowHoursModal).not.toHaveBeenCalled();
  });

  test('a review reply says Sending while it posts', async () => {
    let answer;
    api.replyToReview.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    const { props } = dashboard({
      venueTab: 'reviews',
      venueReviewsData: { reviews: [{ id: 3, name: 'Ana', rating: 4, text: 'Good', created_at: '2026-10-01T20:00:00Z' }], stats: { total: 1, average: 4, distribution: [0, 0, 0, 1, 0] }, loaded: true },
      replyingToReview: 3,
      replyText: 'Thank you',
    });
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(screen.getByRole('button', { name: 'Sending' }).disabled).toBe(true);
    expect(api.replyToReview).toHaveBeenCalledWith(3, 'Thank you');
    await act(async () => { answer({ venue_reply: 'Thank you', venue_replied_at: '2026-10-02T10:00:00Z' }); });
    expect(props.setReplyingToReview).toHaveBeenCalledWith(null);
  });

  test('the Venue Information Save says Saving while it saves', async () => {
    let answer;
    api.updateVenueProfile.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    const { props } = dashboard({ venueTab: 'settings', editingVenueInfo: true });
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByRole('button', { name: 'Saving' }).disabled).toBe(true);
    await act(async () => { answer({ business_name: 'Hoppers' }); });
    expect(props.setEditingVenueInfo).toHaveBeenCalledWith(false);
  });
});
