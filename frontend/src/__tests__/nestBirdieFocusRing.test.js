/**
 * WHERE THE KEYBOARD IS IN BIRDIE'S PART OF THE NEST (2026-11-07).
 *
 * The resting Ask Birdie card (components/nest/NestBirdieSection.js) is a
 * card with overflow: hidden holding the field and one or two suggestion
 * rows, each as wide as the card. The app's ring (index.css :focus-visible)
 * is drawn 2px outside whatever has focus, so on a suggestion row the card
 * cut its left and right sides, and the last row's bottom too: in dark mode
 * the last row showed one line across its top. The field sets outline: none
 * and has no border, so its one sign of focus was App.js's input:focus
 * shadow, 4px of navy at 10%, about 1.2:1 on the light card and nothing on
 * the dark one, with its top cut by the card.
 *
 * Now the rows draw the ring 3px inside themselves (.nest-row-btn, as the
 * Needs you rows do, nestRows.test.js) and the field's row draws it the same
 * way (.nest-birdie-field) while the field has keyboard focus, and the faint
 * shadow goes. Under an answer, Birdie's own composer box ("Ask a follow-up",
 * components/birdie/BirdiePanel.js) had the same field and the same faint
 * shadow: the box rings its own edge from inside (.birdie-compose-box).
 *
 * jsdom applies the real stylesheet here, :has() and :focus-visible
 * included, so the rules are checked on the elements they are for, not only
 * as text.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test nestBirdieFocusRing --watchAll=false
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import NestBirdieSection from '../components/nest/NestBirdieSection';
import BirdiePanel from '../components/birdie/BirdiePanel';

const fs = require('fs');
const path = require('path');

jest.mock('../components/ui/BirdieBird', () => {
  const Bird = () => <span data-animated-bird="" />;
  const Still = () => <span data-still-bird="" />;
  return { __esModule: true, default: Bird, BirdieStill: Still, WARM_BIRD: {} };
});

const CSS = fs.readFileSync(path.join(__dirname, '..', 'index.css'), 'utf8').replace(/\r\n/g, '\n');

const sectionProps = (over = {}) => ({
  isDark: false,
  inline: null,
  hasThread: false,
  showLastAnswer: false,
  onShowLastAnswer: jest.fn(),
  onNewChat: jest.fn(),
  newChatDisabled: false,
  chips: ['How busy is The Copper Finch tonight?', 'Pick a spot for Game Night'],
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
    aiMessages: [{ role: 'user', text: 'where to?' }, { role: 'assistant', text: 'Juniper Bowl.' }],
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

// The real index.css, applied for one test.
function withIndexCss(fn) {
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);
  try { return fn(); } finally { style.remove(); }
}

const clippers = (el) => {
  let n = 0;
  for (let a = el.parentElement; a; a = a.parentElement) if (a.style && a.style.overflow === 'hidden') n += 1;
  return n;
};

describe('the stylesheet', () => {
  test('a row draws the ring 3px inside itself; the field\'s row does the same while the field has keyboard focus', () => {
    expect(CSS).toMatch(/\n:focus-visible \{\n  outline: 2px solid var\(--focus-ring\);\n  outline-offset: 2px;/);
    expect(CSS).toMatch(/\n\.nest-row-btn:focus-visible \{\n  outline-offset: -3px;\n  border-radius: 10px;\n\}/);
    expect(CSS).toMatch(/\n\.nest-birdie-field:has\(\.nest-birdie-input:focus-visible\) \{\n  outline: 2px solid var\(--focus-ring\);\n  outline-offset: -3px;\n  border-radius: 10px;\n\}/);
  });

  test('the composer box rings its own edge from inside, and neither field keeps the faint input:focus shadow', () => {
    expect(CSS).toMatch(/\n\.birdie-compose-box:has\(input:focus-visible\) \{\n  box-shadow: inset 0 0 0 2px var\(--focus-ring\);\n\}/);
    expect(CSS).toMatch(/\n\.nest-birdie-input:focus \{\n  box-shadow: none !important;\n\}/);
    expect(CSS).toMatch(/\n\.birdie-compose-box input:focus \{\n  box-shadow: none !important;\n\}/);
    // The shadow they give up: 4px of navy at 10%, with !important, so only
    // an !important rule of more weight can take it off.
    const APP = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8');
    expect(APP).toMatch(/input:focus, textarea:focus, select:focus \{\s*border-color: var\(--focus-ring\) !important;\s*box-shadow: 0 0 0 4px rgba\(13,40,71,0\.1\)/);
  });

  test('the ring is the focus-ring token in both themes, which the note on :focus-visible measures at 3:1 or better on a card', () => {
    expect(CSS).toMatch(/--focus-ring: rgba\(45,90,135,0\.9\);/);
    expect(CSS).toMatch(/--focus-ring: rgba\(241,237,224,0\.9\);/);
  });
});

describe('the resting card', () => {
  test('every suggestion row takes the inside ring, and the card it sits in clips', () => {
    render(<NestBirdieSection {...sectionProps()} />);
    const rows = [screen.getByRole('button', { name: 'How busy is The Copper Finch tonight?' }), screen.getByRole('button', { name: 'Pick a spot for Game Night' })];
    for (const b of rows) {
      expect(b).toHaveClass('nest-row-btn');
      // Why it has to be inside: the card between the row and the page clips.
      expect(clippers(b)).toBeGreaterThan(0);
    }
  });

  test('the field\'s row carries the ring for the field, which sets no outline of its own', () => {
    const { container } = render(<NestBirdieSection {...sectionProps()} />);
    const field = screen.getByRole('textbox', { name: 'Ask Birdie' });
    expect(field).toHaveClass('nest-birdie-input');
    expect(field.style.outline).toBe('none');
    const row = container.querySelector('[data-nest-birdie-field]');
    expect(row).toHaveClass('nest-birdie-field');
    expect(row.contains(field)).toBe(true);
    expect(clippers(row)).toBeGreaterThan(0);
  });

  test('through the real cascade: the row is ringed while the field has keyboard focus, and only then', () => {
    withIndexCss(() => {
      const { container } = render(<NestBirdieSection {...sectionProps()} />);
      const field = screen.getByRole('textbox', { name: 'Ask Birdie' });
      const row = container.querySelector('[data-nest-birdie-field]');
      // jsdom keeps the outline shorthand as written and fills no longhands.
      expect(getComputedStyle(row).outline).toBe('');
      field.focus();
      expect(document.activeElement).toBe(field);
      expect(field.matches(':focus-visible')).toBe(true);
      const cs = getComputedStyle(row);
      expect(cs.outline).toBe('2px solid var(--focus-ring)');
      expect(cs.outlineOffset).toBe('-3px');
      expect(cs.borderRadius).toBe('10px');
      field.blur();
      expect(getComputedStyle(row).outline).toBe('');
    });
  });

  test('through the real cascade: a focused suggestion row draws the ring inside itself', () => {
    withIndexCss(() => {
      render(<NestBirdieSection {...sectionProps()} />);
      const last = screen.getByRole('button', { name: 'Pick a spot for Game Night' });
      last.focus();
      expect(last.matches(':focus-visible')).toBe(true);
      const cs = getComputedStyle(last);
      expect(cs.outline).toBe('2px solid var(--focus-ring)');
      expect(cs.outlineOffset).toBe('-3px');
      expect(cs.borderRadius).toBe('10px');
    });
  });
});

describe('Birdie\'s composer box', () => {
  test('under an answer in the Nest ("Ask a follow-up") and in the sheet, the field sits in the box that rings', () => {
    for (const presentation of ['inline', 'panel']) {
      const { unmount } = render(<BirdiePanel {...panelProps({ presentation, isAiPanel: presentation === 'panel' })} />);
      const field = screen.getByRole('textbox', { name: 'Ask Birdie' });
      expect(field.style.outline).toBe('none');
      const box = field.closest('.birdie-compose-box');
      expect(box).not.toBeNull();
      expect(box.style.borderRadius).toBe(presentation === 'inline' ? 'var(--r-md)' : 'var(--r-xl)');
      unmount();
    }
  });

  test('through the real cascade: the box is ringed inside its own edge while the field has keyboard focus', () => {
    withIndexCss(() => {
      render(<BirdiePanel {...panelProps()} />);
      const field = screen.getByRole('textbox', { name: 'Ask Birdie' });
      expect(field.getAttribute('placeholder')).toBe('Ask a follow-up');
      const box = field.closest('.birdie-compose-box');
      expect(getComputedStyle(box).boxShadow).toBe('');
      field.focus();
      expect(field.matches(':focus-visible')).toBe(true);
      expect(getComputedStyle(box).boxShadow).toBe('inset 0 0 0 2px var(--focus-ring)');
    });
  });
});
