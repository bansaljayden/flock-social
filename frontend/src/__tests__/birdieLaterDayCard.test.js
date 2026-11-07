/**
 * BIRDIE'S CARD FOR A LATER DAY (2026-11-06).
 *
 * Asked for a place "on the 13th", Birdie's cards came back with no crowd row
 * (the crowd tool could only speak about the next twelve hours). The server
 * now looks the place up for that day and the card carries how busy it usually
 * is then (`usual`, backend routes/ai.js A LATER DAY). The card draws it as one
 * line with small bars, "Usually busiest 7-9 PM Fri", when it has no number for
 * now; a live number keeps its row.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npm test -- --watchAll=false --testPathPattern=birdieLaterDayCard
 */
const React = require('react');
const { render, screen, fireEvent, within } = require('@testing-library/react');

jest.mock('../services/api', () => ({
  __esModule: true,
  BASE_URL: 'http://test.invalid',
}));
// BirdieBird runs a rAF loop behind an IntersectionObserver, which jsdom does
// not have. What he looks like is not what this file is about.
jest.mock('../components/ui/BirdieBird', () => {
  const Stub = () => null;
  return { __esModule: true, default: Stub, BirdieStill: Stub, WARM_BIRD: {} };
});

const BirdiePanel = require('../components/birdie/BirdiePanel').default;
const {
  busiestWords, planDayLabel, usualNightText, usualNightSpoken, isLaterDay, inBusiest, localDayIso,
} = require('../lib/usualNight');

function panelProps(overrides = {}) {
  return {
    AI_CHAT_MAX_MESSAGES: 24,
    AI_CHAT_MAX_MESSAGE_CHARS: 4000,
    DialogBehavior: () => null,
    aiChatEndRef: React.createRef(),
    aiInputHasText: false,
    aiInputHasTextRef: { current: false },
    aiInputRef: React.createRef(),
    aiInputValueRef: { current: '' },
    aiMemoryCut: 0,
    aiMessages: [],
    aiMsgCountRef: { current: 0 },
    aiRemaining: null,
    aiResetsAt: null,
    aiShareVenue: null,
    aiSuggestedQuestions: [],
    aiTyping: false,
    answerBirdieConsent: jest.fn(() => Promise.resolve(true)),
    birdieActionBusy: false,
    birdieConsentBusy: false,
    birdieConsentError: '',
    birdieConsented: true,
    birdieCorner: 'bottom-right',
    canSendAi: true,
    closeAiChat: jest.fn(),
    colors: { navy: '#0d2847', navyBg: '#0d2847', navyMidBg: '#1e3a5c', steel: '#2d5a87' },
    confirmBirdieDraft: jest.fn(),
    confirmBirdieVoteStage: jest.fn(),
    entitlements: {},
    fabDockBottom: '90px',
    fillAiInput: jest.fn(),
    flocks: [],
    formatEventTime: (t) => String(t),
    isAiFullscreen: false,
    isAiPanel: true,
    isDark: false,
    isPro: false,
    loadTrustedContacts: jest.fn(),
    memberCountLabel: () => '',
    openExternal: jest.fn(),
    openVenueDetail: jest.fn(),
    outOfChirps: false,
    sendAiMessage: jest.fn(),
    setAiInputHasText: jest.fn(),
    setAiShareVenue: jest.fn(),
    setCurrentScreen: jest.fn(),
    setCurrentTab: jest.fn(),
    setPaywallTrigger: jest.fn(),
    setProfileScreen: jest.fn(),
    setSelectedFlockId: jest.fn(),
    setSelectedVenueForCreate: jest.fn(),
    startNewAiChat: jest.fn(),
    toggleAiFullscreen: jest.fn(),
    transmitFlockMessage: jest.fn(),
    ...overrides,
  };
}

// A stand-in venue; the name and the numbers are invented.
const USUAL = {
  date: '2026-11-13', weekday: 5, source: 'venue_pattern', busiest: { start: 19, end: 21 },
  hours: [{ h: 17, v: 44 }, { h: 18, v: 61 }, { h: 19, v: 75 }, { h: 20, v: 75 }, { h: 21, v: 60 }],
};
const venue = (over) => ({
  place_id: 'ChIJhearthBell', name: 'Hearth & Bell', address: '12 Mill Rd, Bethlehem, PA', rating: 4.7, reviews: 940,
  price_level: 3, types: ['american_restaurant'], is_open: false, lat: 40.59, lng: -75.37, photo_url: null, crowd: null, crowd_label: null,
  ...over,
});
const answer = (venues) => ({ aiMessages: [{ role: 'assistant', text: "Hearth & Bell. I can't see that night's crowd yet. Fridays there usually peak around 7.", venues }] });

describe('the words', () => {
  test('a stretch, one hour, and a stretch across noon', () => {
    expect(busiestWords({ start: 19, end: 21 })).toBe('7-9 PM');
    expect(busiestWords({ start: 21, end: 22 })).toBe('around 9 PM');
    expect(busiestWords({ start: 11, end: 14 })).toBe('11 AM-2 PM');
    expect(busiestWords({ start: 22, end: 0 })).toBe('10 PM-12 AM');
    expect(busiestWords(null)).toBeNull();
  });

  test('the line, its day, and the category table said as places like it', () => {
    expect(usualNightText(USUAL)).toBe('Usually busiest 7-9 PM Fri');
    expect(usualNightText(USUAL, { withDay: false })).toBe('Usually busiest 7-9 PM');
    expect(usualNightText({ ...USUAL, source: 'category_typical' })).toBe('Places like this: busiest 7-9 PM Fri');
    expect(usualNightSpoken(USUAL)).toBe('Usually busiest 7-9 PM on Fridays');
    expect(usualNightText({ ...USUAL, busiest: null })).toBeNull();
    expect(planDayLabel('2026-11-13')).toBe('Fri 13');
    expect(planDayLabel('2026-02-30')).toBeNull();
  });

  test('a later day is a day after today on this device', () => {
    const now = new Date(2026, 10, 5, 15, 44);
    expect(localDayIso(now)).toBe('2026-11-05');
    expect(isLaterDay('2026-11-13', now)).toBe(true);
    expect(isLaterDay('2026-11-05', now)).toBe(false);
    expect(isLaterDay('2026-11-04', now)).toBe(false);
    expect(isLaterDay(null, now)).toBe(false);
  });

  test('which hours are the busiest stretch', () => {
    expect([17, 18, 19, 20, 21].filter((h) => inBusiest(USUAL.busiest, h))).toEqual([19, 20]);
    expect([22, 23, 0, 1].filter((h) => inBusiest({ start: 23, end: 1 }, h))).toEqual([23, 0]);
  });
});

describe('the card', () => {
  test('no number for now, a usual night: one line with its bars, the busiest stretch drawn darker', () => {
    const { container } = render(<BirdiePanel {...panelProps(answer([venue({ usual: USUAL })]))} />);
    const strip = container.querySelector('[data-usual-night]');
    expect(strip).toBeTruthy();
    expect(strip.textContent).toBe('Usually busiest 7-9 PM Fri');
    expect(screen.getByRole('img', { name: 'Usually busiest 7-9 PM on Fridays. Not a forecast for that night.' })).toBe(strip);
    const bars = strip.querySelectorAll('span[aria-hidden="true"] > span');
    expect(bars.length).toBe(5);
    expect(strip.querySelectorAll('[data-busiest]').length).toBe(2);
    // No live row, and no number anywhere on the card.
    const card = strip.closest('div[style*="border-radius"]');
    expect(card.textContent).not.toMatch(/\d+%/);
  });

  test('a live number keeps its row, and no usual line is drawn beside it', () => {
    const { container } = render(<BirdiePanel {...panelProps(answer([venue({ crowd: 62, crowd_label: 'Steady', usual: USUAL })]))} />);
    expect(container.querySelector('[data-usual-night]')).toBeNull();
    expect(screen.getByText('62%')).toBeTruthy();
  });

  test('a card about now, with no usual night, is the card it was', () => {
    const { container } = render(<BirdiePanel {...panelProps(answer([venue()]))} />);
    expect(container.querySelector('[data-usual-night]')).toBeNull();
  });

  test('Details hands the sheet the day the answer is about', () => {
    const openVenueDetail = jest.fn();
    const { container } = render(<BirdiePanel {...panelProps({ ...answer([venue({ usual: USUAL })]), openVenueDetail })} />);
    const card = container.querySelector('[data-usual-night]').closest('div[style*="border-radius"]');
    fireEvent.click(within(card).getByRole('button', { name: /Details/ }));
    expect(openVenueDetail).toHaveBeenCalledWith('ChIJhearthBell', expect.objectContaining({
      name: 'Hearth & Bell', planDay: { date: '2026-11-13', usual: USUAL },
    }));
  });
});
