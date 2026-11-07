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
const { cardOpenPill, opensLaterToday } = require('../lib/cardOpenPill');
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
    const bars = strip.querySelectorAll('svg[data-usual-bars] rect');
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
    expect(screen.getByText('Steady')).toBeTruthy();
  });

  // The server sends a card about another day with no number for now (THE
  // CARDS OF A LATER DAY, backend). Should one ever carry it, the row says
  // whose hour the number is, so under an answer about the 13th "Steady 62%"
  // cannot read as the 13th's crowd.
  test('a number for now on a card about another day says it is right now', () => {
    jest.useFakeTimers().setSystemTime(new Date(2026, 10, 5, 15, 44));
    try {
      render(<BirdiePanel {...panelProps(answer([venue({ is_open: null, for_date: '2026-11-13', crowd: 62, crowd_label: 'Steady' })]))} />);
      expect(screen.getByText('Right now · Steady')).toBeTruthy();
      expect(screen.getByText('62%')).toBeTruthy();
    } finally {
      jest.useRealTimers();
    }
  });

  // At 320 wide the card leaves the row 159px, and at 390-430 it leaves 209px
  // (measured in a browser, review 2026-11-06). The words wrap instead of
  // losing the day or the hours to an ellipsis, and the bars hold one width
  // however long the venue is open.
  test('the words wrap and are never cut; the bars are a sparkline of at most 48px', () => {
    const allNight = {
      ...USUAL, source: 'category_typical', busiest: { start: 21, end: 22 },
      hours: Array.from({ length: 24 }, (_, i) => ({ h: (6 + i) % 24, v: 10 + i })),
    };
    const { container } = render(<BirdiePanel {...panelProps(answer([venue({ usual: allNight })]))} />);
    const strip = container.querySelector('[data-usual-night]');
    expect(strip.textContent).toBe('Places like this: busiest around 9 PM Fri');
    const words = strip.querySelector(':scope > span');
    expect(words.style.whiteSpace).not.toBe('nowrap');
    expect(words.style.textOverflow).not.toBe('ellipsis');
    expect(words.style.overflow).not.toBe('hidden');
    const svg = strip.querySelector('svg[data-usual-bars]');
    expect(Number(svg.getAttribute('width'))).toBe(48);
    expect(svg.querySelectorAll('rect').length).toBe(24);
    // A short night keeps 3px bars and 1px gaps: five hours, 20px.
    const short = render(<BirdiePanel {...panelProps(answer([venue({ usual: USUAL })]))} />);
    expect(Number(short.container.querySelector('svg[data-usual-bars]').getAttribute('width'))).toBe(20);
  });

  // jsdom resolves no var() and reads no stylesheet, so the two fills are read
  // off the card and resolved against index.css's own light and dark blocks.
  // The busiest bars took --accent-steel's fallback #2d5a87, which is what
  // --border-mid (the other bars) is in dark: every bar was the same blue.
  test('the busiest bars and the rest are different colours in light and in dark', () => {
    const fs = require('fs');
    const path = require('path');
    const css = fs.readFileSync(path.join(__dirname, '..', 'index.css'), 'utf8');
    const tokens = (selector) => {
      const out = {};
      let at = css.indexOf(`${selector} {`);
      while (at !== -1) {
        const body = css.slice(at, css.indexOf('}', at));
        for (const m of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
        at = css.indexOf(`${selector} {`, at + 1);
      }
      return out;
    };
    const light = tokens(':root');
    const dark = { ...light, ...tokens('[data-theme="dark"]') };
    const { container } = render(<BirdiePanel {...panelProps(answer([venue({ usual: USUAL })]))} />);
    const fills = [...container.querySelectorAll('svg[data-usual-bars] rect')]
      .map((r) => ({ busiest: r.hasAttribute('data-busiest'), fill: r.style.fill }));
    const busiest = fills.find((f) => f.busiest).fill;
    const other = fills.find((f) => !f.busiest).fill;
    const resolve = (value, theme) => {
      const m = /^var\((--[a-z0-9-]+)\)$/.exec(value);
      expect(m).toBeTruthy();
      expect(theme[m[1]]).toBeTruthy();
      return theme[m[1]].toLowerCase();
    };
    for (const theme of [light, dark]) {
      expect(resolve(busiest, theme)).not.toBe(resolve(other, theme));
    }
    expect(resolve(busiest, dark)).toBe('#a9c7e4');
    expect(resolve(other, dark)).toBe('#2d5a87');
    expect(resolve(busiest, light)).toBe('#2d5a87');
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

// S19: the card's open pill. At 3:44 PM on a Thursday a card read "Closed" for
// a place opening at 5, under an answer about a plan on the 13th.
describe('the open pill', () => {
  // Thursday, November 5, 2026, 3:44 PM on this device.
  const now = new Date(2026, 10, 5, 15, 44);
  const fivePm = new Date(2026, 10, 5, 17, 0).toISOString();

  test('closed now and opening later today: "Opens 5 PM"', () => {
    expect(opensLaterToday(fivePm, now)).toBe('5 PM');
    expect(opensLaterToday(new Date(2026, 10, 5, 17, 30).toISOString(), now)).toBe('5:30 PM');
    expect(cardOpenPill({ is_open: false, opens_at: fivePm }, now)).toEqual({ text: 'Opens 5 PM', tone: 'later' });
  });

  test('closed now and opening tomorrow, or with no opening time, is Closed; open is Open', () => {
    const tomorrow = new Date(2026, 10, 6, 11, 0).toISOString();
    expect(opensLaterToday(tomorrow, now)).toBeNull();
    expect(cardOpenPill({ is_open: false, opens_at: tomorrow }, now)).toEqual({ text: 'Closed', tone: 'closed' });
    expect(cardOpenPill({ is_open: false }, now)).toEqual({ text: 'Closed', tone: 'closed' });
    expect(cardOpenPill({ is_open: false, opens_at: new Date(2026, 10, 5, 15, 0).toISOString() }, now)).toEqual({ text: 'Closed', tone: 'closed' });
    expect(cardOpenPill({ is_open: true }, now)).toEqual({ text: 'Open', tone: 'open' });
    expect(cardOpenPill({ is_open: null }, now)).toBeNull();
  });

  test('a card about another day says nothing about now, unless that day it is shut', () => {
    expect(cardOpenPill({ is_open: null, for_date: '2026-11-13', hours_that_day: '5 PM to 10 PM' }, now)).toBeNull();
    // A card from a build-era answer that still carries is_open: the day wins.
    expect(cardOpenPill({ is_open: false, opens_at: fivePm, for_date: '2026-11-13' }, now)).toBeNull();
    expect(cardOpenPill({ is_open: null, for_date: '2026-11-09', hours_that_day: 'closed' }, now)).toEqual({ text: 'Closed Mon', tone: 'closed' });
  });

  test('the card draws it', () => {
    jest.useFakeTimers().setSystemTime(now);
    try {
      const { container, unmount } = render(<BirdiePanel {...panelProps(answer([venue({ is_open: false, opens_at: fivePm })]))} />);
      expect(container.querySelector('[data-open-pill]').textContent).toBe('Opens 5 PM');
      expect(container.querySelector('[data-open-pill]').getAttribute('data-open-pill')).toBe('later');
      unmount();
      const later = render(<BirdiePanel {...panelProps(answer([venue({ is_open: null, for_date: '2026-11-13', hours_that_day: '5 PM to 10 PM', usual: USUAL })]))} />);
      expect(later.container.querySelector('[data-open-pill]')).toBeNull();
      expect(later.container.textContent).not.toMatch(/\bClosed\b/);
    } finally {
      jest.useRealTimers();
    }
  });
});
