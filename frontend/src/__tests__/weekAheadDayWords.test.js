/**
 * THE ANALYTICS TAB SAYS "EVENING", "NIGHT" AND "TONIGHT" ONLY OF EVENINGS.
 *
 * GET /api/venue-dashboard/intelligence scanned 5 PM to midnight for every
 * venue until 2026-11-04, and this tab said so four times: "Tonight's Peak"
 * (the strongest of today's last eight bars), "Biggest Night Ahead", "Week
 * Ahead (projected evening peak)" and the six bars under it. A cafe open 7 to
 * 3 read a 6 PM peak on each. The server now reads each day on the venue's own
 * listed hours, or the window for its kind (backend routes/venueDashboard.js
 * dayScanHours, pinned in backend/__tests__/weekAheadWindow.test.js), and says
 * which words fit: `peakWindow` for the week and `today.window` for today.
 *
 * Pinned here, on the rendered screen: a cafe's tiles and card say "Today's
 * Peak", "Biggest Day Ahead" and "Week Ahead (projected peak)" with its own
 * morning numbers; a bar's say what they always did; a day the listing has
 * the venue closed says why it has no number and is never the biggest; today
 * closed says so; and an answer from before the server sent `today` keeps the
 * old reading of the last eight bars.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test --watchAll=false --testPathPattern weekAheadDayWords
 */
import fs from 'fs';
import path from 'path';
import React from 'react';
import { render, screen, act } from '@testing-library/react';

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
  WEEK_BAR_WELL_PX: 55,
  WEEK_BAR_WEIGHT_MIN: 0.55,
  venueTab: 'analytics',
  venueTier: 'pro',
  venueTierKnown: true,
  venueBillingOn: true,
  venueProfile: { business_name: 'Corner Cup', verification_status: 'verified', verified: true, google_place_id: 'place_1' },
  venueInfo: { name: 'Corner Cup', address: '', phone: '' },
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

function dashboard(venueIntel) {
  const props = {};
  for (const name of PARAMS) {
    if (STUB_COMPONENTS.has(name)) props[name] = () => null;
    else if (FUNCTIONS.test(name)) props[name] = jest.fn();
    else props[name] = undefined;
  }
  return render(<VenueDashboard {...props} showToast={jest.fn()} onLogout={jest.fn()} {...BASE} venueIntel={venueIntel} />);
}
const settle = () => act(async () => {});
// A tile is its label, its number and the line under it.
const tile = (label) => screen.getByText(label).parentElement.textContent;
const card = (heading) => screen.getByText(heading).parentElement.textContent;

const label = (h) => (h === 0 ? '12 AM' : h < 12 ? `${h} AM` : h === 12 ? '12 PM' : `${h - 12} PM`);
// Today's bars, 6 AM to 11 PM, loudest at 6 PM: the hour the old reading of
// the last eight bars always picked.
const TODAY_BARS = Array.from({ length: 18 }, (_, i) => {
  const h = 6 + i;
  return { hour: label(h), score: h === 18 ? 90 : h === 8 ? 60 : 30, label: 'Moderate', predictionMethod: 'rule_engine_no_baseline' };
});
const day = (weekday, date, peakScore, peakHour, extra = {}) => ({ date, weekday, peakScore, peakHour, method: 'rule_engine_no_baseline', ...extra });

function intel(extra) {
  return {
    available: true,
    venue: { name: 'Corner Cup', placeId: 'place_1' },
    now: { score: 35, label: 'Not Busy', method: 'rule_engine_no_baseline' },
    todayHourly: TODAY_BARS,
    model: null,
    generatedAt: '2026-11-04T15:00:00.000Z',
    ...extra,
  };
}

const CAFE = intel({
  week: [
    day('Thu', '2026-11-05', 50, '7 AM'), day('Fri', '2026-11-06', 48, '8 AM'), day('Sat', '2026-11-07', 48, '8 AM'),
    day('Sun', '2026-11-08', 50, '10 AM'), day('Mon', '2026-11-09', 45, '7 AM'), day('Tue', '2026-11-10', 45, '7 AM'),
  ],
  today: { date: '2026-11-04', weekday: 'Wed', peakScore: 60, peakHour: '8 AM', method: 'rule_engine_no_baseline', window: 'day' },
  peakWindow: 'day',
  scanFrom: 'hours',
});

const BAR = intel({
  week: [
    day('Thu', '2026-11-05', 64, '9 PM'), day('Fri', '2026-11-06', 74, '10 PM'), day('Sat', '2026-11-07', 74, '10 PM'),
    day('Sun', '2026-11-08', 45, '6 PM'), day('Mon', '2026-11-09', 48, '6 PM'), day('Tue', '2026-11-10', 48, '6 PM'),
  ],
  today: { date: '2026-11-04', weekday: 'Wed', peakScore: 90, peakHour: '6 PM', method: 'rule_engine_no_baseline', window: 'evening' },
  peakWindow: 'evening',
  scanFrom: 'kind',
});

describe('a cafe read by day', () => {
  test('its tiles and its card say today and day, with its own morning numbers', async () => {
    dashboard(CAFE);
    await settle();
    expect(tile("Today's peak")).toBe("Today's peak60around 8 AM");
    expect(tile('Biggest day ahead')).toBe('Biggest day aheadThuprojected 50 at 7 AM');
    expect(card('Week Ahead (projected peak)')).toMatch(/^Week Ahead \(projected peak\)Thu50Fri48Sat48Sun50Mon45Tue45/);
    expect(screen.queryByText("Tonight's peak")).toBeNull();
    expect(screen.queryByText('Biggest night ahead')).toBeNull();
    expect(screen.queryByText('Week Ahead (projected evening peak)')).toBeNull();
  });
});

describe('a bar read on the evening', () => {
  test('its tiles and its card read as they always did', async () => {
    dashboard(BAR);
    await settle();
    expect(tile("Tonight's peak")).toBe("Tonight's peak90around 6 PM");
    expect(tile('Biggest night ahead')).toBe('Biggest night aheadFriprojected 74 at 10 PM');
    expect(card('Week Ahead (projected evening peak)')).toMatch(/^Week Ahead \(projected evening peak\)Thu64Fri74/);
    expect(screen.queryByText("Today's peak")).toBeNull();
    expect(screen.queryByText('Biggest day ahead')).toBeNull();
  });

  test('a small-hours peak still belongs to its night', async () => {
    dashboard({ ...BAR, week: BAR.week.map((d) => (d.weekday === 'Sat' ? { ...d, peakScore: 96, peakHour: '1 AM', afterMidnight: true } : d)) });
    await settle();
    expect(tile('Biggest night ahead')).toBe('Biggest night aheadSatprojected 96 at 1 AM that night');
  });
});

describe('closed days', () => {
  test('a day the listing has the venue closed shows a dash, says why, and is never the biggest', async () => {
    const closed = { peakScore: null, peakHour: null, method: null, closed: true };
    dashboard({ ...CAFE, week: CAFE.week.map((d) => (d.weekday === 'Mon' || d.weekday === 'Tue' ? { ...d, ...closed } : d)) });
    await settle();
    const text = card('Week Ahead (projected peak)');
    expect(text).toMatch(/Mon–Tue–/);
    expect(text).toMatch(/A dash marks a day your Google listing shows you closed\.$/);
    expect(tile('Biggest day ahead')).toBe('Biggest day aheadThuprojected 50 at 7 AM');
  });

  test('a week closed every day names no biggest day and no number', async () => {
    dashboard({ ...CAFE, week: CAFE.week.map((d) => ({ ...d, peakScore: null, peakHour: null, method: null, closed: true })) });
    await settle();
    expect(tile('Biggest day ahead')).toBe('Biggest day ahead–');
  });

  test('closed today says so in place of a peak', async () => {
    dashboard({ ...CAFE, today: { date: '2026-11-04', weekday: 'Wed', peakScore: null, peakHour: null, method: null, closed: true } });
    await settle();
    // With no hours read today, the tile takes the week's word.
    expect(tile("Today's peak")).toBe("Today's peak–Closed today");
  });
});

describe('an answer from before the server read each day on its own hours', () => {
  test('keeps the old words and the old reading of the last eight bars', async () => {
    const { today, peakWindow, scanFrom, ...old } = BAR;
    dashboard(old);
    await settle();
    // The strongest of the last eight bars, 4 PM to 11 PM.
    expect(tile("Tonight's peak")).toBe("Tonight's peak90around 6 PM");
    expect(screen.getByText('Biggest night ahead')).toBeTruthy();
    expect(screen.getByText('Week Ahead (projected evening peak)')).toBeTruthy();
  });
});
