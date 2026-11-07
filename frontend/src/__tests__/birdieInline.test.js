/**
 * BIRDIE AS PART OF THE NEST'S PAGE (components/birdie/BirdiePanel.js with
 * presentation 'inline', components/nest/NestBirdieSection.js; 2026-11-06).
 *
 * Asad's S21: on a new account the docked panel covered everything under the
 * painted birds, Start a flock and Add friends included, and left about 230px
 * for the answer. Inline, Birdie is a section of the page: no backdrop, no
 * sheet, no header bar, no dialog. It shows the consent question word for
 * word, then the latest question and its answer with the venue cards, a line
 * under the answer that says it can be wrong, a follow-up box, and two ways
 * on (the full chat, Done). Older turns are one tap away. A question just
 * asked lands 12px under the top of the Nest's own scroll, never past the
 * Start a flock button of an empty Nest.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test birdieInline --watchAll=false
 */
import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import BirdiePanel from '../components/birdie/BirdiePanel';
import NestBirdieSection, { BIRDIE_STANDFIRST } from '../components/nest/NestBirdieSection';

jest.mock('../components/ui/BirdieBird', () => {
  const Bird = () => <span data-animated-bird="" />;
  const Still = () => <span data-still-bird="" />;
  return { __esModule: true, default: Bird, BirdieStill: Still, WARM_BIRD: {} };
});

function panelProps(overrides = {}) {
  return {
    AI_CHAT_MAX_MESSAGES: 24,
    AI_CHAT_MAX_MESSAGE_CHARS: 4000,
    DialogBehavior: () => <span data-dialog="" />,
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
    getPageScroller: () => null,
    isAiFullscreen: false,
    isAiPanel: false,
    isDark: false,
    isPro: false,
    loadTrustedContacts: jest.fn(),
    memberCountLabel: () => '',
    openExternal: jest.fn(),
    openVenueDetail: jest.fn(),
    outOfChirps: false,
    presentation: 'inline',
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

const card = (name) => ({ name, place_id: `p-${name}`, address: '214 Main St, Bethlehem', rating: 4.6, price_level: 2, is_open: true, crowd: null });
const THREAD = [
  { role: 'user', text: 'where to?' },
  { role: 'assistant', text: 'Juniper Bowl.' },
  { role: 'user', text: 'Pick a spot for tonight' },
  { role: 'assistant', text: 'The Copper Finch is the move tonight.', venues: [card('The Copper Finch')] },
];

describe('the inline presentation', () => {
  test('no backdrop, no sheet, no header bar and no dialog', () => {
    const { container } = render(<BirdiePanel {...panelProps({ aiMessages: THREAD })} />);
    const root = container.firstChild;
    expect(root.hasAttribute('data-birdie-inline')).toBe(true);
    expect(root.getAttribute('style')).toBeNull();
    expect(container.querySelector('[data-dialog]')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Toggle full screen' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
    expect(screen.queryByText('AI help with places and plans')).toBeNull();
  });

  test('the latest question and its answer, with its cards; older turns behind a tap that opens the full chat', () => {
    const props = panelProps({ aiMessages: THREAD });
    render(<BirdiePanel {...props} />);
    expect(screen.getByText('Pick a spot for tonight')).toBeInTheDocument();
    expect(screen.getByText('The Copper Finch is the move tonight.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'The Copper Finch' })).toBeInTheDocument();
    expect(screen.queryByText('where to?')).toBeNull();
    expect(screen.queryByText('Juniper Bowl.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Earlier in this chat (2)' }));
    expect(props.toggleAiFullscreen).toHaveBeenCalledTimes(1);
  });

  test('under the answer, one line says it can be wrong; the box asks for a follow-up; the full chat and Done', () => {
    const props = panelProps({ aiMessages: THREAD });
    const { container } = render(<BirdiePanel {...props} />);
    const line = container.querySelector('[data-birdie-disclosure-inline]');
    expect(line.textContent).toBe('Answers are generated and can be wrong.');
    expect(line.style.opacity).toBe('');
    expect(screen.getByLabelText('Ask Birdie')).toHaveAttribute('placeholder', 'Ask a follow-up');
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(props.closeAiChat).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Open the full chat' }));
    expect(props.toggleAiFullscreen).toHaveBeenCalledTimes(1);
    // No shortcut row and no mid-thread chips inline.
    expect(screen.queryByRole('button', { name: 'Search' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Pick a spot for tonight/ })).toBeNull();
  });

  test('while the answer is on its way: the still bird and the words, never the animated one', () => {
    const { container } = render(<BirdiePanel {...panelProps({ aiMessages: [{ role: 'user', text: 'where to?' }], aiTyping: true })} />);
    expect(container.querySelector('[data-birdie-working]').textContent).toBe('Working on your answer');
    expect(container.querySelector('[data-still-bird]')).not.toBeNull();
    expect(container.querySelector('[data-animated-bird]')).toBeNull();
    // No "can be wrong" line under an answer that is not there yet.
    expect(container.querySelector('[data-birdie-disclosure-inline]')).toBeNull();
  });

  test('before consent: the same question, word for word, with Not now and Allow at 44px', () => {
    const props = panelProps({ birdieConsented: false });
    render(<BirdiePanel {...props} />);
    expect(screen.getByRole('group', { name: 'Before Birdie answers' })).toBeInTheDocument();
    expect(screen.getByText(/Birdie runs on Google's Gemini\. To answer you, it sends Google your messages to Birdie/)).toBeInTheDocument();
    const notNow = screen.getByRole('button', { name: 'Not now' });
    const allow = screen.getByRole('button', { name: 'Allow' });
    expect(notNow.style.minHeight).toBe('44px');
    expect(allow.style.minHeight).toBe('44px');
    fireEvent.click(notNow);
    expect(props.closeAiChat).toHaveBeenCalledTimes(1);
    expect(screen.queryByLabelText('Ask Birdie')).toBeNull();
  });

  test('a share picked from a card is one sheet over the whole page, never cut off', () => {
    const { container } = render(<BirdiePanel {...panelProps({ aiMessages: THREAD, aiShareVenue: card('The Copper Finch') })} />);
    const sheet = container.querySelector('.sheet-rise');
    expect(sheet).not.toBeNull();
    expect(sheet.style.maxHeight).toBe('calc(100% - var(--safe-top) - 24px)');
    expect(screen.getByText('Start a flock here')).toBeInTheDocument();
  });
});

describe('where a question lands: the Nest\'s own scroll', () => {
  let frames = [];
  beforeEach(() => {
    frames = [];
    jest.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => { frames.push(cb); return frames.length; });
  });
  afterEach(() => { window.requestAnimationFrame.mockRestore(); delete window.matchMedia; });
  const flush = () => act(() => { const run = frames; frames = []; run.forEach((cb) => cb(0)); });

  const page = () => {
    const box = document.createElement('div');
    document.body.appendChild(box);
    box.scrollTop = 300;
    box.getBoundingClientRect = () => ({ top: 50, bottom: 650, height: 600 });
    box.scrollTo = jest.fn(({ top }) => { box.scrollTop = top; });
    return box;
  };

  test('the question\'s top comes to 12px under the top of the page, smoothly', () => {
    window.matchMedia = () => ({ matches: false });
    const box = page();
    const props = panelProps({ aiMessages: [], getPageScroller: () => box });
    const { rerender } = render(<BirdiePanel {...props} />, { container: box });
    rerender(<BirdiePanel {...props} aiMessages={[{ role: 'user', text: 'where to?' }]} aiTyping />);
    const turn = box.querySelector('[data-birdie-turn="0"]');
    turn.getBoundingClientRect = () => ({ top: 450, bottom: 490 });
    flush();
    // 300 + (450 - 50) - 12
    expect(box.scrollTo).toHaveBeenCalledWith({ top: 688, behavior: 'smooth' });
  });

  test('with no plans, it stops where Start a flock is still on screen, and under Reduce Motion it jumps', () => {
    window.matchMedia = () => ({ matches: true });
    const box = page();
    const props = panelProps({ aiMessages: [], getPageScroller: () => box });
    const { rerender } = render(<BirdiePanel {...props} />, { container: box });
    // The empty Nest's Start a flock, 260px down the screen.
    const keep = document.createElement('button');
    keep.setAttribute('data-nest-keep', '');
    keep.getBoundingClientRect = () => ({ top: 260, bottom: 308 });
    box.appendChild(keep);
    rerender(<BirdiePanel {...props} aiMessages={[{ role: 'user', text: 'where to?' }]} aiTyping />);
    box.querySelector('[data-birdie-turn="0"]').getBoundingClientRect = () => ({ top: 450, bottom: 490 });
    flush();
    // Kept: 300 + (260 - 50) - 12 = 498, under the 688 the question wanted.
    expect(box.scrollTo).toHaveBeenCalledWith({ top: 498, behavior: 'auto' });
  });

  test('an answer arriving moves nothing: it lands under the question already in view', () => {
    const box = page();
    const props = panelProps({ aiMessages: [{ role: 'user', text: 'where to?' }], aiMsgCountRef: { current: 1 }, getPageScroller: () => box });
    const { rerender } = render(<BirdiePanel {...props} />);
    rerender(<BirdiePanel {...props} aiMessages={[...props.aiMessages, { role: 'assistant', text: 'The Copper Finch.' }]} />);
    flush();
    expect(box.scrollTo).not.toHaveBeenCalled();
  });

  test('inline never raises the keyboard by itself', () => {
    jest.useFakeTimers();
    const props = panelProps({ aiMessages: THREAD });
    render(<BirdiePanel {...props} />);
    const box = screen.getByLabelText('Ask Birdie');
    act(() => { jest.advanceTimersByTime(400); });
    expect(document.activeElement).not.toBe(box);
    jest.useRealTimers();
  });
});

describe('the section at rest (NestBirdieSection)', () => {
  const sectionProps = (over = {}) => ({
    isDark: false,
    inline: null,
    hasThread: false,
    showLastAnswer: false,
    onShowLastAnswer: jest.fn(),
    onNewChat: jest.fn(),
    newChatDisabled: false,
    chips: ['Pick a spot for tonight'],
    onChip: jest.fn(),
    inputRef: React.createRef(),
    inputValueRef: { current: '' },
    inputHasText: false,
    inputHasTextRef: { current: false },
    setInputHasText: jest.fn(),
    maxChars: 4000,
    onFocusField: jest.fn(),
    onSend: jest.fn(),
    canSend: false,
    ...over,
  });

  test('says what Birdie is before anyone types, in the Terms\' words, at full strength', () => {
    const { container } = render(<NestBirdieSection {...sectionProps()} />);
    expect(screen.getByRole('heading', { name: 'Ask Birdie' })).toBeInTheDocument();
    const standfirst = container.querySelector('[data-birdie-standfirst]');
    expect(standfirst.textContent).toBe(BIRDIE_STANDFIRST);
    expect(standfirst.style.opacity).toBe('');
    // jsdom keeps no var() colour, so the ink is read off the source.
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'components', 'nest', 'NestBirdieSection.js'), 'utf8');
    expect(src).toMatch(/<p data-birdie-standfirst="" style=\{\{[^}]*fontSize: 'var\(--t-label\)', fontWeight: '500'[^}]*color: 'var\(--text-secondary\)' \}\}>\{inline \? BIRDIE_GEMINI_LINE : BIRDIE_STANDFIRST\}<\/p>/);
  });

  test('the field: Ask Birdie, what to ask about, Send on the keyboard; focus and Enter go to App.js', () => {
    const props = sectionProps();
    render(<NestBirdieSection {...props} />);
    const box = screen.getByRole('textbox', { name: 'Ask Birdie' });
    expect(box).toHaveAttribute('placeholder', 'Ask about a place or a night out');
    expect(box).toHaveAttribute('enterkeyhint', 'send');
    fireEvent.focus(box);
    expect(props.onFocusField).toHaveBeenCalledTimes(1);
    fireEvent.input(box, { target: { value: 'where to?' } });
    expect(props.inputValueRef.current).toBe('where to?');
    expect(props.setInputHasText).toHaveBeenCalledWith(true);
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(props.onSend).toHaveBeenCalledTimes(1);
  });

  test('a suggestion is a row that asks it', () => {
    const props = sectionProps();
    render(<NestBirdieSection {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Pick a spot for tonight' }));
    expect(props.onChip).toHaveBeenCalledWith('Pick a spot for tonight');
  });

  test('a thread in the page takes the field\'s place; Done keeps it behind Show the last answer; New chat while one exists', () => {
    const props = sectionProps({ inline: <div data-thread="" />, hasThread: true });
    const { rerender, container } = render(<NestBirdieSection {...props} />);
    expect(container.querySelector('[data-thread]')).not.toBeNull();
    expect(container.querySelector('[data-nest-birdie-field]')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
    expect(props.onNewChat).toHaveBeenCalledTimes(1);
    rerender(<NestBirdieSection {...props} inline={null} showLastAnswer />);
    fireEvent.click(screen.getByRole('button', { name: 'Show the last answer' }));
    expect(props.onShowLastAnswer).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-nest-birdie-field]')).not.toBeNull();
  });

  test('before the yes to Gemini the field never takes focus: a tap, Enter or Space asks instead', () => {
    // Focusing it set the mode that unmounts it under the consent question:
    // on iOS the keyboard started to rise and dropped, and a keyboard user's
    // focus fell to the top of the page.
    const onAskConsent = jest.fn();
    const props = sectionProps({ consented: false, onAskConsent });
    render(<NestBirdieSection {...props} />);
    const box = screen.getByRole('textbox', { name: 'Ask Birdie' });
    expect(box).toHaveAttribute('readonly');
    const down = new MouseEvent('pointerdown', { bubbles: true, cancelable: true });
    box.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    expect(onAskConsent).toHaveBeenCalledTimes(1);
    fireEvent.focus(box);
    expect(props.onFocusField).not.toHaveBeenCalled();
    expect(onAskConsent).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(box, { key: 'Enter' });
    fireEvent.keyDown(box, { key: ' ' });
    expect(onAskConsent).toHaveBeenCalledTimes(3);
    expect(props.onSend).not.toHaveBeenCalled();
  });

  test('the consent question takes focus when it took the place of what had it', () => {
    const { container } = render(<BirdiePanel {...panelProps({ presentation: 'inline', isAiPanel: false, getPageScroller: () => null, birdieConsented: false })} />);
    const group = container.querySelector('[role="group"][aria-labelledby="birdie-consent-title"]');
    expect(document.activeElement).toBe(group);
    expect(group).toHaveAttribute('tabindex', '-1');
  });

  test('spent for the day, the field is off and says when the messages come back, with Pro where it is sold', () => {
    // The field took a question and sent nothing, with no thread open to say so.
    const onGetPro = jest.fn();
    render(<NestBirdieSection {...sectionProps({ outOfChirps: true, chips: [], dailyLimit: 10, resetsAt: null, onGetPro })} />);
    const box = screen.getByRole('textbox', { name: 'Ask Birdie' });
    expect(box).toBeDisabled();
    const line = screen.getByRole('status');
    expect(line.textContent).toMatch(/^You've used today's 10 messages\. They come back .+\.Get Flock Pro$/);
    expect(box).toHaveAttribute('aria-describedby', 'nest-birdie-spent');
    fireEvent.click(screen.getByRole('button', { name: 'Get Flock Pro' }));
    expect(onGetPro).toHaveBeenCalledTimes(1);
    // Where nothing is sold, the line alone.
    const { container } = render(<NestBirdieSection {...sectionProps({ outOfChirps: true, chips: [], onGetPro: null })} />);
    expect(container.textContent).not.toMatch(/Get Flock Pro/);
  });

  test('an answer that lands after Done does not pull the page back to Birdie', () => {
    // Done before the answer put the mode at rest, where aiInputRef is the
    // Nest's own field, and the send's finally focused it: the page jumped
    // back to the section from wherever the person had scrolled.
    const APP = require('fs').readFileSync(require('path').join(__dirname, '..', 'App.js'), 'utf8');
    expect(APP).toContain("if (aiInputRef.current && (modeNow === 'panel' || modeNow === 'fullscreen')) aiInputRef.current.focus();");
    expect(APP).not.toContain("aiChatModeRef.current !== 'inline') aiInputRef.current.focus()");
    // And a send from the resting field while the day is spent goes nowhere.
    const send = APP.slice(APP.indexOf('const nestBirdieSend = () => {'), APP.indexOf('const nestBirdieChip'));
    expect(send).toMatch(/if \(outOfChirps\) return;/);
    expect(send.indexOf('if (outOfChirps) return;')).toBeLessThan(send.indexOf("setAiChatMode('inline')"));
  });

  test('it does not pull the panel into the Nest\'s first paint', () => {
    const raw = require('fs').readFileSync(require('path').join(__dirname, '..', 'components', 'nest', 'NestBirdieSection.js'), 'utf8');
    const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(src).not.toMatch(/import [^;]*BirdiePanel/);
    expect(src).not.toMatch(/BirdieBird/);
  });
});
