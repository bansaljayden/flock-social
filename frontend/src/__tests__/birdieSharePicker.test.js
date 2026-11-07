/**
 * BIRDIE'S SHARE PICKER (S18, 2026-11-06).
 *
 * Share on a Birdie card opened "Send <venue> / Choose a flock" over the panel.
 * For an account with no flocks it drew the bird, "No flocks to send this to
 * yet" and "Start a flock here", and the button was cut in half by the panel's
 * bottom edge: the sheet was held to 60% of a panel that can be 380px tall.
 * It now sizes itself up to the panel less a 16px strip, its body scrolls, the
 * empty state is tighter, and the people this account already messages are
 * offered under it: a tap sends the venue's card into that DM and opens it.
 * The geometry itself is checked in a browser at 320 and 390 wide (the
 * screenshots of this change); jsdom lays nothing out, so this file pins the
 * rules and the behaviour.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npm test -- --watchAll=false --testPathPattern=birdieSharePicker
 */
const React = require('react');
const { render, screen, fireEvent, within } = require('@testing-library/react');

jest.mock('../services/api', () => ({
  __esModule: true,
  BASE_URL: 'http://test.invalid',
}));
jest.mock('../components/ui/BirdieBird', () => {
  const Stub = () => null;
  return { __esModule: true, default: Stub, BirdieStill: Stub, WARM_BIRD: {} };
});

const BirdiePanel = require('../components/birdie/BirdiePanel').default;

// The stand-in venue and people are invented.
const VENUE = { place_id: 'ChIJhearthBell', name: 'Hearth & Bell', address: '12 Mill Rd, Bethlehem, PA', rating: 4.7, price_level: 3 };
const DMS = [
  { userId: 501, name: 'Rae Okafor', messages: [], unread: 0 },
  { userId: 502, name: 'Theo Lindqvist', messages: [], unread: 1 },
];

function props(over = {}) {
  const fn = () => jest.fn();
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
    aiMessages: [{ role: 'assistant', text: 'Hearth & Bell.', venues: [] }],
    aiMsgCountRef: { current: 0 },
    aiRemaining: null,
    aiResetsAt: null,
    aiShareVenue: VENUE,
    aiSuggestedQuestions: [],
    aiTyping: false,
    answerBirdieConsent: jest.fn(() => Promise.resolve(true)),
    birdieActionBusy: false,
    birdieConsentBusy: false,
    birdieConsentError: '',
    birdieConsented: true,
    birdieCorner: 'bottom-right',
    canSendAi: true,
    closeAiChat: fn(),
    colors: { navy: '#0d2847', navyBg: '#0d2847', navyMidBg: '#1e3a5c', steel: '#2d5a87' },
    confirmBirdieDraft: fn(),
    confirmBirdieVoteStage: fn(),
    directMessages: [],
    entitlements: {},
    fabDockBottom: '90px',
    fillAiInput: fn(),
    flocks: [],
    formatEventTime: (t) => String(t),
    isAiFullscreen: false,
    isAiPanel: true,
    isDark: false,
    isPro: false,
    loadTrustedContacts: fn(),
    memberCountLabel: () => '4 people',
    openExternal: fn(),
    openVenueDetail: fn(),
    outOfChirps: false,
    sendAiMessage: fn(),
    setAiInputHasText: fn(),
    setAiShareVenue: fn(),
    setCurrentScreen: fn(),
    setCurrentTab: fn(),
    setPaywallTrigger: fn(),
    setProfileScreen: fn(),
    setSelectedDmId: fn(),
    setSelectedFlockId: fn(),
    setSelectedVenueForCreate: fn(),
    startNewAiChat: fn(),
    toggleAiFullscreen: fn(),
    transmitDm: fn(),
    transmitFlockMessage: fn(),
    ...over,
  };
}

test('no flocks: the sheet may take the panel less a strip, its body scrolls, and its button is there', () => {
  const { container } = render(<BirdiePanel {...props()} />);
  const sheet = container.querySelector('[data-share-sheet]');
  expect(sheet.style.maxHeight).toBe('calc(100% - 16px)');
  expect(sheet.style.maxHeight).not.toBe('60%');
  const body = sheet.children[1];
  expect(body.style.overflowY).toBe('auto');
  expect(['0', '0px']).toContain(body.style.minHeight);
  const empty = container.querySelector('[data-share-empty]');
  expect(within(empty).getByText('No flocks to send this to yet')).toBeTruthy();
  expect(within(empty).getByRole('button', { name: 'Start a flock here' })).toBeTruthy();
  // The tighter empty state: 14px over the bird where it was 24px.
  expect(empty.style.padding).toBe('14px 16px 12px');
  expect(container.querySelector('[data-share-friends]')).toBeNull();
});

test('Start a flock here still starts one with the venue', () => {
  const p = props();
  render(<BirdiePanel {...p} />);
  fireEvent.click(screen.getByRole('button', { name: 'Start a flock here' }));
  expect(p.setSelectedVenueForCreate).toHaveBeenCalledWith(expect.objectContaining({ name: 'Hearth & Bell', place_id: 'ChIJhearthBell' }));
  expect(p.setCurrentScreen).toHaveBeenCalledWith('create');
});

test('with people to message: offered under the empty state, and a tap sends the card into that DM and opens it', () => {
  const p = props({ directMessages: DMS });
  const { container } = render(<BirdiePanel {...p} />);
  const friends = container.querySelector('[data-share-friends]');
  expect(within(friends).getByText('Or send it to a friend')).toBeTruthy();
  const empty = container.querySelector('[data-share-empty]');
  expect(!!(empty.compareDocumentPosition(friends) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
  fireEvent.click(within(friends).getByRole('button', { name: /Theo Lindqvist/ }));
  expect(p.transmitDm).toHaveBeenCalledWith(502, {
    text: 'Check out Hearth & Bell!',
    message_type: 'venue_card',
    venue_data: { name: 'Hearth & Bell', addr: '12 Mill Rd, Bethlehem, PA', stars: 4.7, rating: 4.7, price_level: 3, place_id: 'ChIJhearthBell' },
    image_url: null,
    reply_to_id: null,
    reply_to: null,
  });
  expect(p.setAiShareVenue).toHaveBeenCalledWith(null);
  expect(p.closeAiChat).toHaveBeenCalled();
  expect(p.setSelectedDmId).toHaveBeenCalledWith(502);
  expect(p.setCurrentScreen).toHaveBeenCalledWith('dmDetail');
  expect(p.transmitFlockMessage).not.toHaveBeenCalled();
});

test('with flocks and people: the flocks first, then at most five people', () => {
  const many = Array.from({ length: 7 }, (_, i) => ({ userId: 600 + i, name: `Friend ${i}`, messages: [] }));
  const p = props({ flocks: [{ id: 9, name: 'Friday dinner', status: 'voting' }], directMessages: many });
  const { container } = render(<BirdiePanel {...p} />);
  expect(container.querySelector('[data-share-empty]')).toBeNull();
  expect(screen.getByRole('button', { name: /Friday dinner/ })).toBeTruthy();
  const friends = container.querySelector('[data-share-friends]');
  expect(within(friends).getAllByRole('button').length).toBe(5);
});
