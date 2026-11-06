/**
 * THE LOGO PICKER: A TAP ANYWHERE ON A TILE PICKS IT (2026-11-06).
 *
 * Each tile is a Places photo from the owner's Google listing, drawn with its
 * photographer's credit (components/ui/GoogleCredit.js). The credit sat over
 * the tile's bottom left, and its maps link's 44px target (.hit44) covered
 * that corner of the 96px tile, so a tap there opened Google Maps instead of
 * picking. The credit now sits under the tile, outside its button, in a row
 * 44px tall, the height of the link's target.
 *
 * The harness is the shape venueDashboardPendingAndSkeletons.test.js uses.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npm test -- --watchAll=false --testPathPattern=venueLogoPickerCredit
 */
import fs from 'fs';
import path from 'path';
import React from 'react';
import { render, screen, fireEvent, within, act } from '@testing-library/react';

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

const PHOTO_A = 'https://api.test/api/venues/photo?ref=A&maxwidth=600';
const PHOTO_B = 'https://api.test/api/venues/photo?ref=B&maxwidth=600';
const CREDIT_A = { name: 'Dana Reyes', uri: 'https://maps.google.com/maps/contrib/111', maps_uri: 'https://www.google.com/maps/place//data=A' };

test('the harness hands the dashboard every prop it destructures', () => {
  expect(PARAMS.length).toBeGreaterThan(50);
  expect(PARAMS.filter((name) => !(name in dashboard().props))).toEqual([]);
});

test('each tile is all button, and its credit sits under it in a row as tall as the link\'s target', async () => {
  const { props } = dashboard({ venueLogoPicker: { photos: [PHOTO_A, PHOTO_B], credits: [CREDIT_A, null] } });
  await settle();
  const tileA = screen.getByRole('button', { name: 'Use listing photo 1 as your logo' });
  const tileB = screen.getByRole('button', { name: 'Use listing photo 2 as your logo' });
  expect(tileA.querySelector('img').getAttribute('src')).toBe(PHOTO_A);

  // One credit, for the one photo that has one, and nothing laid over a tile:
  // the credit's row is the next thing after the tile, outside its button.
  const credits = screen.getAllByTestId('photo-credit');
  expect(credits).toHaveLength(1);
  expect(credits[0].textContent).toMatch(/Dana Reyes/);
  expect(tileA.contains(credits[0])).toBe(false);
  expect(credits[0].style.position).toBe('');
  const row = credits[0].parentElement;
  expect(row.previousElementSibling).toBe(tileA);
  expect(row.style.height).toBe('44px');
  expect(row.style.alignItems).toBe('center');
  // The maps link keeps its 44px target, which that row holds.
  expect(within(credits[0]).getByRole('link', { name: 'See this photo on Google Maps' }).className).toBe('hit44');

  // A photo with no usable credit gets no row.
  expect(tileB.nextElementSibling).toBeNull();

  fireEvent.click(tileA);
  expect(props.handleVenueLogoPick).toHaveBeenCalledWith(PHOTO_A);
  fireEvent.click(tileB);
  expect(props.handleVenueLogoPick).toHaveBeenLastCalledWith(PHOTO_B);
});
