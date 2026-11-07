/**
 * BIRDIE SAYS WHAT IT IS, LEGIBLY, WHEREVER IT OPENS (2026-11-06).
 *
 * Three things on Birdie's sheet told a person more than was so, or told the
 * one true thing too faintly to read:
 *
 *   1. The line under every turn, "Birdie AI · answers are generated and can
 *      be wrong", was drawn at 0.6 opacity in tertiary ink: 2.48:1 on white,
 *      2.64:1 in dark. The one sentence about trusting the answers was the
 *      faintest text on the sheet. It is now "Answers are generated and can
 *      be wrong." in secondary ink at 13px, 6.2:1 and 8.3:1.
 *   2. A green "online" dot sat on Birdie's avatar, and three bouncing dots
 *      showed while it worked. Both are a person's cues. Birdie is software.
 *   3. The subtitle said Birdie "knows what's good tonight", over answers
 *      about other days.
 *
 * The Gemini sentence on the empty state is NOT reworded: its comment says it
 * matches the Terms word for word and closed an App Review gap.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test birdieDisclosurePinned --watchAll=false
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import BirdiePanel from '../components/birdie/BirdiePanel';

jest.mock('../components/ui/BirdieBird', () => {
  const Stub = () => null;
  return { __esModule: true, default: Stub, BirdieStill: Stub, WARM_BIRD: {} };
});

// Every prop BirdiePanel takes, past the consent question, as FlockAppInner
// builds them (the same list birdieConsent.test.js keeps).
function birdiePanelProps(overrides = {}) {
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
    aiSuggestedQuestions: [{ text: 'Pick a spot for tonight', icon: () => null }],
    aiTyping: false,
    answerBirdieConsent: jest.fn(),
    birdieActionBusy: false,
    birdieConsentBusy: false,
    birdieConsentError: '',
    birdieConsented: true,
    birdieCorner: 'bottom-right',
    canSendAi: false,
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

const fs = require('fs');
const path = require('path');
const PANEL = fs.readFileSync(path.join(__dirname, '..', 'components', 'birdie', 'BirdiePanel.js'), 'utf8').replace(/\r\n/g, '\n');

const GEMINI = "Birdie is an assistant built on Google's Gemini. Its answers are generated and can be wrong.";
const UNDER = 'Answers are generated and can be wrong.';

// Every ancestor's inline opacity, multiplied: what the reader actually sees.
const seenOpacity = (el) => {
  let o = 1;
  for (let n = el; n && n.style; n = n.parentElement) {
    if (n.style.opacity !== '') o *= Number(n.style.opacity);
  }
  return o;
};

describe.each([
  ['the docked panel', { isAiPanel: true, isAiFullscreen: false }],
  ['full screen', { isAiPanel: false, isAiFullscreen: true }],
])('%s', (_, mode) => {
  test('the empty state names Gemini in the Terms\' own words, at full strength', () => {
    render(<BirdiePanel {...birdiePanelProps({ ...mode })} />);
    const line = screen.getByText(GEMINI);
    expect(seenOpacity(line)).toBe(1);
  });

  test('the line under the box says answers can be wrong, at full strength in secondary ink', () => {
    render(<BirdiePanel {...birdiePanelProps({ ...mode, aiMessages: [{ role: 'user', text: 'where to' }, { role: 'assistant', text: 'Larkspur Tap.' }] })} />);
    const line = screen.getByText(UNDER);
    expect(seenOpacity(line)).toBe(1);
    // jsdom keeps no var() colour, so the ink and size are read off the source.
    const span = PANEL.match(/<span data-birdie-disclosure="" style=\{\{([^}]*)\}\}>Answers are generated and can be wrong\.<\/span>/);
    expect(span).not.toBeNull();
    expect(span[1]).toContain("color: 'var(--text-secondary)'");
    expect(span[1]).toContain("fontSize: 'var(--t-label)'");
    expect(span[1]).not.toMatch(/opacity/);
  });

  test('the subtitle says what Birdie is for, not what it knows', () => {
    render(<BirdiePanel {...birdiePanelProps({ ...mode })} />);
    expect(screen.getByText('AI help with places and plans')).toBeInTheDocument();
    expect(screen.queryByText(/knows what's good tonight/)).toBeNull();
  });
});

test('no presence cues: no green online dot, no typing dots', () => {
  // The header, from its comment to the consent block under it. (The venue
  // cards' crowd bar further down is green for a quiet room, a different job.)
  const header = PANEL.slice(PANEL.indexOf('{/* Header.'), PANEL.indexOf('ASKED ONCE, BEFORE THE FIRST MESSAGE'));
  expect(header.length).toBeGreaterThan(500);
  expect(header).not.toMatch(/#22C55E/i);
  expect(PANEL).not.toMatch(/<animate /);
  expect(PANEL).toContain('Working on your answer');
});

test('the box says what to ask about, and the keyboard offers Send', () => {
  render(<BirdiePanel {...birdiePanelProps()} />);
  const box = screen.getByLabelText('Ask Birdie');
  expect(box).toHaveAttribute('placeholder', 'Ask about a place or a night out');
  expect(box).toHaveAttribute('enterkeyhint', 'send');
});

test('the empty state line is two things, not a list of three', () => {
  expect(PANEL).toContain("where's good tonight and how packed it gets. ask away.");
  expect(PANEL).not.toContain('what your flock is up to');
});
