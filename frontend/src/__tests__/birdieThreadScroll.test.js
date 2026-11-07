/**
 * WHERE BIRDIE'S THREAD LANDS WHEN AN ANSWER ARRIVES (2026-11-03).
 *
 * Filming the LionCage demo, Birdie answered with four venue cards and the
 * panel, which pinned its thread to the end on every change, showed the last
 * card and none of the answer: the words it had just said were scrolled out of
 * view as they arrived. components/birdie/BirdiePanel.js now lands an answer
 * taller than the thread with its first line at the top, still pins a short
 * one to the end, pins the reader's own question to the end, and never moves
 * for an answer when the reader scrolled away on purpose.
 *
 * jsdom lays nothing out, so each test gives the thread a viewport, a content
 * height and a top for every row (layout below), and runs the panel's
 * requestAnimationFrame callbacks by hand once that layout is in place.
 */
import React from 'react';
import { render, fireEvent, act } from '@testing-library/react';
import BirdiePanel from '../components/birdie/BirdiePanel';

jest.mock('../components/ui/BirdieBird', () => {
  const Stub = () => null;
  return { __esModule: true, default: Stub, BirdieStill: Stub, WARM_BIRD: {} };
});

// Every prop BirdiePanel takes, past the consent question, as FlockAppInner
// builds them (the same list __tests__/birdieConsent.test.js keeps).
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
    colors: { navy: '#0d2847', navyBg: '#0d2847', navyMidBg: '#1e3a5c' },
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

const card = (name) => ({ name, place_id: `p-${name}`, address: 'Chestnut St, Philadelphia', rating: 4.6, price_level: 2, is_open: true, crowd: null });
const QUESTION = { role: 'user', text: "Where's good tonight for 6 of us?" };
const TALL_ANSWER = {
  role: 'assistant',
  text: 'Larkspur Tap. It is leading your vote with 3 of 5, and it is at 42 right now.',
  venues: [card('Larkspur Tap'), card('Wren & Barrel'), card("Fennick's"), card('Thistle & Crust')],
};
const SHORT_ANSWER = { role: 'assistant', text: 'Larkspur Tap is at 42 right now.', venues: [] };

// requestAnimationFrame, run by hand once the layout is in place.
let frames = [];
const flush = () => act(() => {
  const run = frames;
  frames = [];
  run.forEach((cb) => cb(0));
});

const thread = (container) => container.querySelector('[data-birdie-thread]');

// A fake layout: the thread's box at viewport top 100, `viewport` tall, with
// `scrollHeight` of content; `rows[i]` is where message i's row starts in that
// content. Rows report their position relative to the current scroll, the
// way a browser would.
function layout(box, { viewport, scrollHeight, rows }) {
  Object.defineProperty(box, 'clientHeight', { configurable: true, value: viewport });
  Object.defineProperty(box, 'scrollHeight', { configurable: true, value: scrollHeight });
  box.getBoundingClientRect = () => ({ top: 100, bottom: 100 + viewport, height: viewport, left: 0, right: 360, width: 360, x: 0, y: 100 });
  rows.forEach((top, i) => {
    const row = box.querySelector(`[data-birdie-turn="${i}"]`);
    if (!row) throw new Error(`no row ${i} on screen`);
    row.getBoundingClientRect = () => ({ top: 100 + top - box.scrollTop, bottom: 100 + top - box.scrollTop + 40, height: 40, left: 0, right: 360, width: 360, x: 0, y: 100 + top - box.scrollTop });
  });
}

const realScrollIntoView = Element.prototype.scrollIntoView;
let pinned;
beforeEach(() => {
  frames = [];
  jest.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => { frames.push(cb); return frames.length; });
  pinned = jest.fn();
  // jsdom has no scrollIntoView; the panel pins to its end with it.
  Element.prototype.scrollIntoView = pinned;
});
afterEach(() => {
  window.requestAnimationFrame.mockRestore();
  Element.prototype.scrollIntoView = realScrollIntoView;
});

// The reader asks, Birdie is typing: the question is pinned to the end.
function asked(extra = {}) {
  const props = panelProps({ aiMessages: [QUESTION], aiTyping: true, ...extra });
  const utils = render(<BirdiePanel {...props} />);
  const box = thread(utils.container);
  layout(box, { viewport: 400, scrollHeight: 140, rows: [12] });
  flush();
  return { ...utils, props, box };
}

test('the reader\'s question pins the thread to its end, the working line and all', () => {
  const { props, container } = asked();
  expect(pinned).toHaveBeenCalledTimes(1);
  expect(pinned.mock.instances[0]).toBe(props.aiChatEndRef.current);
  // What shows while the answer is on its way says so in words, once, to a
  // screen reader too. The three bouncing dots (SMIL, a person typing) are gone.
  const working = container.querySelector('[data-birdie-working]');
  expect(working).not.toBeNull();
  expect(working.getAttribute('role')).toBe('status');
  expect(working.getAttribute('aria-live')).toBe('polite');
  expect(working.textContent).toBe('Working on your answer');
  expect(container.querySelector('animate')).toBeNull();
});

test('an answer taller than the thread lands with its first line at the top, not its last card', () => {
  const { props, rerender, box } = asked();
  pinned.mockClear();
  rerender(<BirdiePanel {...props} aiMessages={[QUESTION, TALL_ANSWER]} aiTyping={false} />);
  layout(box, { viewport: 400, scrollHeight: 1100, rows: [12, 90] });
  flush();
  // The answer's row starts at 90; the thread keeps its own 12 px above it,
  // so the end of the question may show just above the answer.
  expect(box.scrollTop).toBe(78);
  expect(pinned).not.toHaveBeenCalled();
});

test('an answer that fits still pins to the end, short thread or long', () => {
  const { props, rerender, box } = asked();
  pinned.mockClear();
  rerender(<BirdiePanel {...props} aiMessages={[QUESTION, SHORT_ANSWER]} aiTyping={false} />);
  layout(box, { viewport: 400, scrollHeight: 380, rows: [12, 90] });
  flush();
  expect(pinned).toHaveBeenCalledTimes(1);
  expect(box.scrollTop).toBe(0);

  // A long thread whose newest answer fits under the fold: the end, as before.
  pinned.mockClear();
  const history = [QUESTION, TALL_ANSWER, { role: 'user', text: 'how busy is it' }, SHORT_ANSWER];
  rerender(<BirdiePanel {...props} aiMessages={history.slice(0, 3)} aiTyping />);
  layout(box, { viewport: 400, scrollHeight: 760, rows: [12, 90, 600] });
  flush();
  pinned.mockClear();
  rerender(<BirdiePanel {...props} aiMessages={history} aiTyping={false} />);
  layout(box, { viewport: 400, scrollHeight: 900, rows: [12, 90, 600, 680] });
  flush();
  expect(pinned).toHaveBeenCalledTimes(1);
});

test('the view never moves for an answer once the reader has scrolled away on purpose', () => {
  const { props, rerender, box } = asked();
  // While Birdie types, the reader scrolls up to read something.
  layout(box, { viewport: 400, scrollHeight: 700, rows: [12] });
  box.scrollTop = 0;
  fireEvent.scroll(box);
  pinned.mockClear();
  rerender(<BirdiePanel {...props} aiMessages={[QUESTION, TALL_ANSWER]} aiTyping={false} />);
  layout(box, { viewport: 400, scrollHeight: 1100, rows: [12, 90] });
  flush();
  expect(box.scrollTop).toBe(0);
  expect(pinned).not.toHaveBeenCalled();

  // Their next question brings them back down.
  rerender(<BirdiePanel {...props} aiMessages={[QUESTION, TALL_ANSWER, { role: 'user', text: 'why that one?' }]} aiTyping />);
  layout(box, { viewport: 400, scrollHeight: 1180, rows: [12, 90, 1100] });
  flush();
  expect(pinned).toHaveBeenCalledTimes(1);
});

test('the panel\'s own scroll is not the reader\'s: switching to full screen lands on the answer again', () => {
  const { props, rerender, box } = asked();
  rerender(<BirdiePanel {...props} aiMessages={[QUESTION, TALL_ANSWER]} aiTyping={false} />);
  layout(box, { viewport: 400, scrollHeight: 1100, rows: [12, 90] });
  flush();
  expect(box.scrollTop).toBe(78);
  // The browser reports the scroll the panel just made.
  fireEvent.scroll(box);
  pinned.mockClear();
  rerender(<BirdiePanel {...props} aiMessages={[QUESTION, TALL_ANSWER]} aiTyping={false} isAiFullscreen isAiPanel={false} />);
  layout(box, { viewport: 700, scrollHeight: 1100, rows: [12, 150] });
  flush();
  expect(box.scrollTop).toBe(138);
  expect(pinned).not.toHaveBeenCalled();
});

test('a reader who scrolled into the cards keeps their place when the panel goes full screen', () => {
  const { props, rerender, box } = asked();
  rerender(<BirdiePanel {...props} aiMessages={[QUESTION, TALL_ANSWER]} aiTyping={false} />);
  layout(box, { viewport: 400, scrollHeight: 1100, rows: [12, 90] });
  flush();
  box.scrollTop = 300;
  fireEvent.scroll(box);
  pinned.mockClear();
  rerender(<BirdiePanel {...props} aiMessages={[QUESTION, TALL_ANSWER]} aiTyping={false} isAiFullscreen isAiPanel={false} />);
  layout(box, { viewport: 700, scrollHeight: 1100, rows: [12, 90] });
  flush();
  expect(box.scrollTop).toBe(300);
  expect(pinned).not.toHaveBeenCalled();
});

test('a card changing state on a turn already read moves nothing', () => {
  const draftAnswer = { role: 'assistant', text: "your plan's below. tap Start this flock when it looks right", flockDraft: { name: 'Friday night', event_time: null, venue: null } };
  const { props, rerender, box } = asked();
  rerender(<BirdiePanel {...props} aiMessages={[QUESTION, draftAnswer]} aiTyping={false} />);
  layout(box, { viewport: 400, scrollHeight: 380, rows: [12, 90] });
  flush();
  pinned.mockClear();
  box.scrollTop = 0;
  const started = { ...draftAnswer, flockDraft: { ...draftAnswer.flockDraft, startedFlockId: 412 } };
  rerender(<BirdiePanel {...props} aiMessages={[QUESTION, started]} aiTyping={false} />);
  flush();
  expect(pinned).not.toHaveBeenCalled();
  expect(box.scrollTop).toBe(0);
});

test('reopening Birdie on a thread whose last answer is tall lands on that answer\'s first line', () => {
  // aiMsgCountRef is FlockAppInner's and survives the panel closing, so a
  // reopen sees no new message: it lands the way the answer did.
  const props = panelProps({ aiMessages: [QUESTION, TALL_ANSWER], aiMsgCountRef: { current: 2 } });
  const { container } = render(<BirdiePanel {...props} />);
  const box = thread(container);
  layout(box, { viewport: 400, scrollHeight: 1100, rows: [12, 90] });
  flush();
  expect(box.scrollTop).toBe(78);
  expect(pinned).not.toHaveBeenCalled();
});
