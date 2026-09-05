/**
 * THE CHAT FEATURE HOMES: the two sheets and the two strips that replace the
 * header "Features" drawer.
 *
 *   src/components/chat/sheets/FlockProfileSheet.js
 *   src/components/chat/sheets/ComposerPlusSheet.js
 *   src/components/chat/sheets/PinStrip.js
 *   src/components/chat/sheets/PinnedMessageBar.js
 *   src/components/chat/sheets/sheets.css
 *
 * WHAT THIS FILE HOLDS SHUT, AND WHY EACH ONE IS HERE
 *
 *   1. SECTION ORDER. Plan, People, Money, Pins, Media and search, Settings.
 *      That order is a product decision (it runs from what the chat is about
 *      out to housekeeping) and it is invisible to a reviewer reading a diff,
 *      because JSX reorders cleanly. Asserted from data-chat-section in DOM
 *      order, so the headings stay free to be reworded.
 *
 *   2. A DM IS NOT A SMALL FLOCK. The two surfaces differ in four places and
 *      each difference exists for a reason: a DM has no plan, nobody to
 *      invite, "Suggest a place" rather than a vote, and "Request cash"
 *      rather than a bill split. Every one of those is a one-line ternary
 *      that a later edit can flatten by accident.
 *
 *   3. EXACTLY ONE STRIP. The stack this replaced could show a venue banner
 *      over a vote banner over a plan bar, all three at once. PinStrip takes
 *      one already-decided model, and the assertion is a count of rendered
 *      strips, which is the only form of that guarantee a test can express.
 *
 *   4. THE ACCESSIBILITY FLOOR. Every icon-only control carries an aria-label
 *      and the hit44 class; the sheets are dialogs, trap focus, close on
 *      Escape and drop the keyboard on the way in; the switch reports its
 *      state; motion is collapsed under prefers-reduced-motion; and no
 *      surface in this folder renders a text input, which is what keeps the
 *      iOS 16px zoom floor out of the question here.
 *
 *   4b. THE THINGS A SYNTHETIC CLICK CANNOT SEE. Three of the defects in this
 *      folder were invisible to a fireEvent.click and needed the real gesture
 *      spelled out: the pinned bar's swipe also fired the tap underneath it,
 *      the pin strip's options button opened a menu it could never close
 *      (the press closed it and the click reopened it), and closing that menu
 *      dropped focus on <body> with the way back in clipped to 1x1. They are
 *      driven here with MouseEvents named pointerdown and pointerup, because
 *      jsdom has no PointerEvent and the fallback drops clientX.
 *
 *   4c. THE STACK. This sheet binds its trap on WINDOW in the capture phase,
 *      which runs before the document listeners ModerationSheet and
 *      PaywallSheet use, and Report opens from a member row here. A key that
 *      came from an element outside this sheet is not this sheet's to take.
 *      The same section covers the integrated path, where App.js's
 *      DialogBehavior replaces the local trap: the ARIA has to land on the
 *      sheet rather than the backdrop, and the keyboard dismissal has to
 *      survive, because that helper does not blur.
 *
 *   5. NO FAKE STATES. A money section with no pool and no bill does not
 *      render. A media count renders only when somebody counted. A presence
 *      dot renders only for a presence string the caller supplied. Each of
 *      those is one line of the component and each was once shipped the other
 *      way somewhere in this app.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test --watchAll=false
 * This is a FRONTEND test (jest via react-scripts), not a `node --test` one.
 */

import React from 'react';
import { act, render, fireEvent, within } from '@testing-library/react';
import FlockProfileSheet from '../components/chat/sheets/FlockProfileSheet';
import ComposerPlusSheet from '../components/chat/sheets/ComposerPlusSheet';
import PinStrip from '../components/chat/sheets/PinStrip';
import PinnedMessageBar from '../components/chat/sheets/PinnedMessageBar';

const fs = require('fs');
const path = require('path');

const SHEET_DIR = path.join(__dirname, '..', 'components', 'chat', 'sheets');
const read = (f) => fs.readFileSync(path.join(SHEET_DIR, f), 'utf8');

const CSS = read('sheets.css');
const FILES = ['FlockProfileSheet.js', 'ComposerPlusSheet.js', 'PinStrip.js', 'PinnedMessageBar.js', 'sheets.css'];

/* Shared fixtures. Shapes match what App.js already holds: members carry the
   colour the message stream draws their bar in, invited rows carry an
   availability pulse the shell has already expired-checked, money lines
   arrive pre-formatted because only the shell knows whether a budget has
   settled. */
const MEMBERS = [
  { id: 1, name: 'Maya', color: '#2d5a87', presence: 'in_chat' },
  { id: 2, name: 'Sam', color: '#F59E0B', presence: 'online' },
  // No presence key at all: the server did not say, so nothing is drawn.
  { id: 3, name: 'Ava', color: '#22C55E' },
];

const flockProps = (over = {}) => ({
  open: true,
  onClose: jest.fn(),
  isDm: false,
  title: 'Friday at Kome',
  subtitle: 'Fri 7pm, still voting',
  plan: { timeLabel: 'Fri 7:00 PM', venueLabel: 'Kome', statusLabel: 'Still voting' },
  onOpenPlan: jest.fn(),
  members: MEMBERS,
  onOpenMember: jest.fn(),
  onAddMembers: jest.fn(),
  invited: [{ id: 9, name: 'Noor', pulseLabel: 'Free tonight' }],
  pool: { line: 'Cash pool', valueLabel: '4 of 5 in' },
  onOpenPool: jest.fn(),
  bill: { line: 'The bill', valueLabel: '$84.50, 2 of 5 settled' },
  onOpenBill: jest.fn(),
  pins: [{ id: 'p1', preview: 'Venmo @maya $12' }],
  onJumpToPin: jest.fn(),
  onUnpinMessage: jest.fn(),
  onSearchInChat: jest.fn(),
  onOpenMedia: jest.fn(),
  mediaCount: 12,
  notificationsLabel: 'On',
  onOpenNotifications: jest.fn(),
  muted: false,
  onToggleMute: jest.fn(),
  onLeave: jest.fn(),
  ...over,
});

const dmProps = (over = {}) => flockProps({
  isDm: true,
  title: 'Maya',
  subtitle: null,
  plan: null,
  members: [MEMBERS[0]],
  invited: [],
  onAddMembers: undefined,
  ...over,
});

const composerProps = (over = {}) => ({
  open: true,
  onClose: jest.fn(),
  isDm: false,
  chatName: 'Friday at Kome',
  onPickPhoto: jest.fn(),
  onTakePhoto: jest.fn(),
  onSuggestPlace: jest.fn(),
  onOpenVote: jest.fn(),
  onShareLocation: jest.fn(),
  onRequestCash: jest.fn(),
  onSplitBill: jest.fn(),
  onAskBirdie: jest.fn(),
  onCheckIn: jest.fn(),
  ...over,
});

/* jsdom has no PointerEvent, and testing-library falls back to a bare Event
   when the constructor is missing, which drops clientX and makes every drag
   read as zero pixels. A MouseEvent carries the coordinate and React dispatches
   on the event NAME, so onPointerDown and onPointerUp still receive it. */
const pointer = (el, type, clientX) => {
  fireEvent(el, new MouseEvent(type, { bubbles: true, cancelable: true, clientX }));
};

/* A stand-in for App.js's DialogBehavior, which is declared at module scope
   there and never exported, which is why the components in this folder take it
   as a prop. It does to the DOM what the real one does: it resolves its target
   as its own marker's parentElement and stamps the dialog ARIA onto it. What
   it does NOT do is blur anything, and that is the point of two of the tests
   below: the keyboard dismissal cannot live inside the local focus trap,
   because the trap stands aside on exactly this path. */
function FakeDialogBehavior({ label }) {
  const markerRef = React.useRef(null);
  React.useEffect(() => {
    const node = markerRef.current && markerRef.current.parentElement;
    if (!node) return undefined;
    node.setAttribute('role', 'dialog');
    node.setAttribute('aria-modal', 'true');
    if (label) node.setAttribute('aria-label', label);
    return () => {
      node.removeAttribute('role');
      node.removeAttribute('aria-modal');
      node.removeAttribute('aria-label');
    };
  }, [label]);
  return <span ref={markerRef} hidden />;
}

const sectionsOf = (container) =>
  Array.from(container.querySelectorAll('[data-chat-section]')).map((el) => el.getAttribute('data-chat-section'));

const labelOf = (btn) => (btn.getAttribute('aria-label') || btn.textContent || '').trim();
const buttonLabels = (container) => Array.from(container.querySelectorAll('button')).map(labelOf);

/* ══════════════════════════════════════════════════════════════════════
   1. SECTION ORDER
   ══════════════════════════════════════════════════════════════════════ */
describe('FlockProfileSheet section order', () => {
  test('a flock sheet runs Plan, People, Money, Pins, Media and search, Settings', () => {
    const { container } = render(<FlockProfileSheet {...flockProps()} />);
    expect(sectionsOf(container)).toEqual(['plan', 'people', 'money', 'pins', 'media', 'settings']);
  });

  test('the visible headings are in the same order as the section keys', () => {
    const { container } = render(<FlockProfileSheet {...flockProps()} />);
    const headings = Array.from(container.querySelectorAll('.cs-group-label')).map((h) => h.textContent.trim());
    // Invited is a sub-heading inside People, not a seventh section.
    expect(headings).toEqual(['Plan', 'People', 'Invited', 'Money', 'Pins', 'Media and search', 'Settings']);
  });

  test('Add members is the first row of People, not a ninth member below the roster', () => {
    const { container } = render(<FlockProfileSheet {...flockProps()} />);
    const people = container.querySelector('[data-chat-section="people"]');
    const rows = Array.from(people.querySelectorAll('.cs-rows > button')).map(labelOf);
    expect(rows[0]).toBe('Add members');
    expect(rows).toContain('Maya, In the chat');
  });

  test('Invited sits inside the People section, not beside it', () => {
    const { container } = render(<FlockProfileSheet {...flockProps()} />);
    const people = container.querySelector('[data-chat-section="people"]');
    expect(people.querySelector('[data-chat-subsection="invited"]')).not.toBeNull();
    expect(within(people).getByText('Noor')).toBeInTheDocument();
    expect(within(people).getByText('Free tonight')).toBeInTheDocument();
  });

  test('nothing renders when the sheet is closed', () => {
    const { container } = render(<FlockProfileSheet {...flockProps({ open: false })} />);
    expect(container.querySelectorAll('[data-chat-section]')).toHaveLength(0);
  });
});

/* ══════════════════════════════════════════════════════════════════════
   2. A DM IS NOT A SMALL FLOCK
   ══════════════════════════════════════════════════════════════════════ */
describe('the DM sheet and the flock sheet differ in the right rows', () => {
  test('a DM has no Plan section, because a DM has no plan', () => {
    const { container } = render(<FlockProfileSheet {...dmProps()} />);
    expect(sectionsOf(container)).toEqual(['people', 'money', 'pins', 'media', 'settings']);
    expect(container.querySelector('[data-chat-section="plan"]')).toBeNull();
  });

  test('Add members is a flock row and never a DM row', () => {
    const flock = render(<FlockProfileSheet {...flockProps()} />);
    expect(buttonLabels(flock.container)).toContain('Add members');
    flock.unmount();

    const dm = render(<FlockProfileSheet {...dmProps()} />);
    expect(buttonLabels(dm.container)).not.toContain('Add members');
  });

  test('the exit row leaves a flock and deletes a conversation', () => {
    const flock = render(<FlockProfileSheet {...flockProps()} />);
    expect(buttonLabels(flock.container)).toContain('Leave this flock');
    flock.unmount();

    const dm = render(<FlockProfileSheet {...dmProps()} />);
    const labels = buttonLabels(dm.container);
    expect(labels).toContain('Delete this conversation');
    expect(labels).not.toContain('Leave this flock');
  });

  test('the People heading is singular on a DM', () => {
    const { container } = render(<FlockProfileSheet {...dmProps()} />);
    const people = container.querySelector('[data-chat-section="people"]');
    expect(people.querySelector('.cs-group-label').textContent.trim()).toBe('Person');
  });

  test('the "+" sheet votes in a flock and suggests in a DM', () => {
    const flock = render(<ComposerPlusSheet {...composerProps()} />);
    const flockLabels = buttonLabels(flock.container);
    expect(flockLabels).toContain('Vote on a venue');
    expect(flockLabels).toContain('Split the bill');
    expect(flockLabels).not.toContain('Suggest a place');
    expect(flockLabels).not.toContain('Request cash');
    flock.unmount();

    const dm = render(<ComposerPlusSheet {...composerProps({ isDm: true })} />);
    const dmLabels = buttonLabels(dm.container);
    expect(dmLabels).toContain('Suggest a place');
    expect(dmLabels).toContain('Request cash');
    expect(dmLabels).not.toContain('Vote on a venue');
    expect(dmLabels).not.toContain('Split the bill');
  });

  test('the "+" sheet holds only things you send, on both surfaces', () => {
    const send = ['Photo', 'Take a photo', 'Share location', 'Ask Birdie', 'Check in'];
    const notSend = ['Search in chat', 'Add members', 'Mute this chat', 'Leave this flock', 'Notifications'];
    for (const isDm of [false, true]) {
      const { container, unmount } = render(<ComposerPlusSheet {...composerProps({ isDm })} />);
      const labels = buttonLabels(container);
      send.forEach((s) => expect(labels).toContain(s));
      notSend.forEach((s) => expect(labels).not.toContain(s));
      unmount();
    }
  });

  test('a tile with no handler is absent, not a dead button', () => {
    const { container } = render(<ComposerPlusSheet {...composerProps({ onCheckIn: undefined, onAskBirdie: undefined })} />);
    const labels = buttonLabels(container);
    expect(labels).not.toContain('Check in');
    expect(labels).not.toContain('Ask Birdie');
    expect(labels).toContain('Photo');
    // And nothing is left disabled instead.
    expect(container.querySelectorAll('button[disabled]')).toHaveLength(0);
  });
});

/* ══════════════════════════════════════════════════════════════════════
   3. EXACTLY ONE STRIP
   ══════════════════════════════════════════════════════════════════════ */
describe('PinStrip renders exactly one model', () => {
  test('no model renders nothing at all', () => {
    const { container } = render(<PinStrip model={null} onOpen={jest.fn()} />);
    expect(container.querySelectorAll('[data-chat-strip]')).toHaveLength(0);
    expect(container.textContent).toBe('');
  });

  test('a venue model renders one strip with the name and the word Pinned', () => {
    const { container, getByText } = render(
      <PinStrip model={{ kind: 'venue', name: 'Kome', thumbUrl: null }} onOpen={jest.fn()} />
    );
    const strips = container.querySelectorAll('[data-chat-strip]');
    expect(strips).toHaveLength(1);
    expect(strips[0].getAttribute('data-chat-strip')).toBe('venue');
    expect(getByText('Kome')).toBeInTheDocument();
    expect(getByText('Pinned')).toBeInTheDocument();
  });

  test('a vote model renders one strip reading "Vote open, 5 of 8"', () => {
    const { container, getByText } = render(
      <PinStrip model={{ kind: 'vote', votedCount: 5, memberCount: 8 }} onOpen={jest.fn()} />
    );
    const strips = container.querySelectorAll('[data-chat-strip]');
    expect(strips).toHaveLength(1);
    expect(strips[0].getAttribute('data-chat-strip')).toBe('vote');
    const caption = getByText('Vote open, 5 of 8');
    expect(caption).toBeInTheDocument();
    // A running count changes under the user, so it is announced.
    expect(caption.getAttribute('aria-live')).toBe('polite');
  });

  test('an unknown model kind renders nothing rather than a blank strip', () => {
    const { container } = render(<PinStrip model={{ kind: 'something-new' }} />);
    expect(container.querySelectorAll('[data-chat-strip]')).toHaveLength(0);
  });

  test('tapping the strip calls onOpen with the model it was given', () => {
    const onOpen = jest.fn();
    const model = { kind: 'venue', name: 'Kome' };
    const { container } = render(<PinStrip model={model} onOpen={onOpen} />);
    fireEvent.click(container.querySelector('[data-chat-strip]'));
    expect(onOpen).toHaveBeenCalledWith(model);
  });

  test('Change place and Unpin are reachable without a long press', () => {
    const onChangePlace = jest.fn();
    const onUnpin = jest.fn();
    const { container, getByRole, getByText } = render(
      <PinStrip model={{ kind: 'venue', name: 'Kome' }} onChangePlace={onChangePlace} onUnpin={onUnpin} />
    );
    const more = getByRole('button', { name: 'Options for Kome' });
    expect(more.className).toContain('hit44');
    expect(more.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(more);
    expect(container.querySelector('[role="menu"]')).not.toBeNull();
    fireEvent.click(getByText('Change place'));
    expect(onChangePlace).toHaveBeenCalledTimes(1);
  });

  test('the options button closes the menu it opened', () => {
    const { container, getByRole } = render(
      <PinStrip model={{ kind: 'venue', name: 'Kome' }} onChangePlace={jest.fn()} onUnpin={jest.fn()} />
    );
    const more = getByRole('button', { name: 'Options for Kome' });
    // The real gesture, which a bare fireEvent.click does not reproduce: a
    // press lands before the click, and the press-outside-the-menu handler
    // used to see the trigger itself as "outside" and close the menu, so the
    // click that followed reopened it and the button could never shut it.
    pointer(more, 'pointerdown', 0);
    fireEvent.click(more);
    expect(container.querySelector('[role="menu"]')).not.toBeNull();
    expect(more.getAttribute('aria-expanded')).toBe('true');

    pointer(more, 'pointerdown', 0);
    fireEvent.click(more);
    expect(container.querySelector('[role="menu"]')).toBeNull();
    expect(more.getAttribute('aria-expanded')).toBe('false');
  });

  test('closing the menu puts focus back on the control that opened it', () => {
    const { container, getByRole, getByText } = render(
      <PinStrip model={{ kind: 'venue', name: 'Kome' }} onChangePlace={jest.fn()} onUnpin={jest.fn()} />
    );
    const more = getByRole('button', { name: 'Options for Kome' });
    more.focus();
    fireEvent.click(more);
    // Focus lands on the first item one tick late in the browser; put it there
    // now so the close has something to orphan.
    getByText('Change place').focus();
    expect(document.activeElement).not.toBe(more);

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(container.querySelector('[role="menu"]')).toBeNull();
    // Not <body>. The strip's options button is clipped to 1x1 unless it holds
    // focus, so dropping the user here would also hide the way back in.
    expect(document.activeElement).toBe(more);
  });

  test('the options control is absent when neither handler was supplied', () => {
    const { queryByRole } = render(<PinStrip model={{ kind: 'venue', name: 'Kome' }} onOpen={jest.fn()} />);
    expect(queryByRole('button', { name: 'Options for Kome' })).toBeNull();
  });

  test('a vote strip has no place menu, because there is no place yet', () => {
    const { queryByRole } = render(
      <PinStrip model={{ kind: 'vote', votedCount: 1, memberCount: 4 }} onChangePlace={jest.fn()} onUnpin={jest.fn()} />
    );
    expect(queryByRole('button', { name: /Options for/ })).toBeNull();
  });

  /* The release order on a device with no hover: pointerup, then pointerout,
     then the compatibility click. React synthesizes onPointerLeave from that
     pointerout, so a handler there that clears the suppression runs BEFORE the
     click and the strip navigates to the venue under the menu the same hold
     just opened. That shipped once. */
  test('a touch long press opens the menu and does not also fire the tap', () => {
    jest.useFakeTimers();
    try {
      const onOpen = jest.fn();
      const model = { kind: 'venue', name: 'Kome' };
      const { container } = render(
        <PinStrip model={model} onOpen={onOpen} onChangePlace={jest.fn()} onUnpin={jest.fn()} />
      );
      const strip = container.querySelector('[data-chat-strip]');

      pointer(strip, 'pointerdown', 0);
      act(() => { jest.advanceTimersByTime(500); });
      expect(container.querySelector('[role="menu"]')).not.toBeNull();

      pointer(strip, 'pointerup', 0);
      // pointerOut, not pointerLeave. React 19 registers no listener for the
      // native pointerleave event: it synthesizes onPointerLeave from
      // pointerout, so firing pointerleave here reaches nothing and the test
      // would pass just as happily with the regression in place. relatedTarget
      // null is what a real release outside the element carries.
      fireEvent.pointerOut(strip, { relatedTarget: null });
      fireEvent.click(strip);

      expect(onOpen).not.toHaveBeenCalled();
      expect(container.querySelector('[role="menu"]')).not.toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  test('an outside tap that closes a long-press menu does not move focus onto the options button', () => {
    jest.useFakeTimers();
    try {
      const { container, getByRole } = render(
        <PinStrip model={{ kind: 'venue', name: 'Kome' }} onChangePlace={jest.fn()} onUnpin={jest.fn()} />
      );
      const more = getByRole('button', { name: 'Options for Kome' });
      const strip = container.querySelector('[data-chat-strip]');

      pointer(strip, 'pointerdown', 0);
      act(() => { jest.advanceTimersByTime(500); });
      act(() => { jest.advanceTimersByTime(0); });
      expect(container.querySelector('[role="menu"]')).not.toBeNull();

      // Nobody touched the options button on this route, and sending focus
      // there flips it from clipped 1x1 to a 32 square button that reflows the
      // 36pt strip around it.
      pointer(document.body, 'pointerdown', 0);
      expect(container.querySelector('[role="menu"]')).toBeNull();
      expect(document.activeElement).not.toBe(more);
    } finally {
      jest.useRealTimers();
    }
  });

  test('a vote strip with no tally yet announces no figure it cannot back', () => {
    const { container, getByText } = render(
      <PinStrip model={{ kind: 'vote', memberCount: 8 }} onOpen={jest.fn()} />
    );
    expect(container.textContent).not.toMatch(/undefined|NaN/);
    expect(getByText('Vote open').getAttribute('aria-live')).toBe('polite');
  });

  test('a venue whose name has not arrived still labels its options control', () => {
    const { getByRole } = render(
      <PinStrip model={{ kind: 'venue' }} onChangePlace={jest.fn()} onUnpin={jest.fn()} />
    );
    const more = getByRole('button', { name: 'Options for this place' });
    fireEvent.click(more);
    expect(getByRole('menu').getAttribute('aria-label')).toBe('Options for this place');
  });
});

/* ══════════════════════════════════════════════════════════════════════
   3b. THE PINNED MESSAGE BAR
   ══════════════════════════════════════════════════════════════════════ */
describe('PinnedMessageBar', () => {
  const PINS = [
    { id: 'a', preview: 'Venmo @maya $12' },
    { id: 'b', preview: 'Doors at 9' },
    { id: 'c', preview: 'Bring the cooler' },
  ];

  test('renders nothing when nothing is pinned', () => {
    const { container } = render(<PinnedMessageBar pins={[]} activeIndex={0} />);
    expect(container.textContent).toBe('');
  });

  test('reads "Pinned: <message>" and jumps on tap', () => {
    const onJump = jest.fn();
    const { getByText, getByRole } = render(
      <PinnedMessageBar pins={PINS} activeIndex={0} onJump={onJump} onActiveIndexChange={jest.fn()} />
    );
    expect(getByText('Pinned:')).toBeInTheDocument();
    expect(getByText('Venmo @maya $12')).toBeInTheDocument();
    fireEvent.click(getByRole('button', { name: 'Go to pinned message 1 of 3: Venmo @maya $12' }));
    expect(onJump).toHaveBeenCalledWith(PINS[0]);
  });

  test('the next control and the arrow keys both move one pin', () => {
    const onActiveIndexChange = jest.fn();
    const { getByRole, container } = render(
      <PinnedMessageBar pins={PINS} activeIndex={0} onActiveIndexChange={onActiveIndexChange} />
    );
    fireEvent.click(getByRole('button', { name: 'Next pinned message' }));
    expect(onActiveIndexChange).toHaveBeenLastCalledWith(1);
    fireEvent.keyDown(container.querySelector('[data-chat-pinbar]'), { key: 'ArrowLeft' });
    expect(onActiveIndexChange).toHaveBeenLastCalledWith(2);
  });

  test('a swipe moves one pin and does not also jump to the one it left', () => {
    const onJump = jest.fn();
    const onActiveIndexChange = jest.fn();
    const { getByRole } = render(
      <PinnedMessageBar pins={PINS} activeIndex={0} onJump={onJump} onActiveIndexChange={onActiveIndexChange} />
    );
    const main = getByRole('button', { name: /^Go to pinned message 1 of 3/ });
    pointer(main, 'pointerdown', 200);
    pointer(main, 'pointerup', 120);
    expect(onActiveIndexChange).toHaveBeenLastCalledWith(1);
    // The browser fires a real click after a drag that starts and ends on the
    // same button, and touch-action: pan-y means it is never cancelled.
    fireEvent.click(main);
    expect(onJump).not.toHaveBeenCalled();
    // And the flag is spent, so the next honest tap is not swallowed.
    fireEvent.click(main);
    expect(onJump).toHaveBeenCalledTimes(1);
  });

  test('a press that travels less than the threshold is a tap, not a swipe', () => {
    const onJump = jest.fn();
    const onActiveIndexChange = jest.fn();
    const { getByRole } = render(
      <PinnedMessageBar pins={PINS} activeIndex={0} onJump={onJump} onActiveIndexChange={onActiveIndexChange} />
    );
    const main = getByRole('button', { name: /^Go to pinned message 1 of 3/ });
    pointer(main, 'pointerdown', 200);
    pointer(main, 'pointerup', 188);
    expect(onActiveIndexChange).not.toHaveBeenCalled();
    fireEvent.click(main);
    expect(onJump).toHaveBeenCalledWith(PINS[0]);
  });

  test('an out of range index is clamped rather than blanking the bar', () => {
    // The shell can be one render behind a pin somebody else removed.
    const { getByText } = render(<PinnedMessageBar pins={PINS.slice(0, 2)} activeIndex={7} />);
    expect(getByText('Doors at 9')).toBeInTheDocument();
  });

  test('at most three pins are offered', () => {
    const four = [...PINS, { id: 'd', preview: 'Fourth' }];
    const { container } = render(<PinnedMessageBar pins={four} activeIndex={0} onActiveIndexChange={jest.fn()} />);
    expect(container.querySelectorAll('.cs-pinbar-dot')).toHaveLength(3);
  });

  test('the position dots are decoration, not three overlapping targets', () => {
    const { container } = render(<PinnedMessageBar pins={PINS} activeIndex={0} onActiveIndexChange={jest.fn()} />);
    expect(container.querySelector('.cs-pinbar-dots').getAttribute('aria-hidden')).toBe('true');
    expect(container.querySelectorAll('.cs-pinbar-dot button')).toHaveLength(0);
  });

  test('there is no unpin control when no unpin handler was supplied', () => {
    const { queryByRole } = render(<PinnedMessageBar pins={PINS} activeIndex={0} />);
    expect(queryByRole('button', { name: /^Unpin/ })).toBeNull();
  });
});

/* ══════════════════════════════════════════════════════════════════════
   4. THE ACCESSIBILITY FLOOR
   ══════════════════════════════════════════════════════════════════════ */
describe('accessibility floor', () => {
  const surfaces = () => [
    ['flock profile sheet', render(<FlockProfileSheet {...flockProps()} />)],
    ['DM profile sheet', render(<FlockProfileSheet {...dmProps()} />)],
    ['flock "+" sheet', render(<ComposerPlusSheet {...composerProps()} />)],
    ['DM "+" sheet', render(<ComposerPlusSheet {...composerProps({ isDm: true })} />)],
    ['pin strip', render(<PinStrip model={{ kind: 'venue', name: 'Kome' }} onChangePlace={jest.fn()} onUnpin={jest.fn()} onOpen={jest.fn()} />)],
    ['pinned message bar', render(
      <PinnedMessageBar
        pins={[{ id: 'a', preview: 'Venmo @maya $12' }, { id: 'b', preview: 'Doors at 9' }]}
        activeIndex={0}
        onActiveIndexChange={jest.fn()}
        onJump={jest.fn()}
        onUnpin={jest.fn()}
      />
    )],
  ];

  test('every control has an accessible name', () => {
    const nameless = [];
    for (const [surface, view] of surfaces()) {
      Array.from(view.container.querySelectorAll('button')).forEach((btn) => {
        if (labelOf(btn).length === 0) nameless.push(`${surface}: ${btn.className}`);
      });
      view.unmount();
    }
    // Reported as a list rather than one failed assertion, so a regression
    // names every control it broke instead of the first.
    expect(nameless).toEqual([]);
  });

  test('every icon-only control carries an aria-label and the hit44 class', () => {
    for (const [, view] of surfaces()) {
      Array.from(view.container.querySelectorAll('button')).forEach((btn) => {
        const visibleText = (btn.textContent || '').trim();
        if (visibleText.length > 0) return; // labelled by its own text
        expect(btn.getAttribute('aria-label')).toBeTruthy();
        expect(btn.className).toContain('hit44');
      });
      view.unmount();
    }
  });

  // Focus landing on the sheet is deferred one tick (the sheet animates in and
  // some rows settle late), so it is not asserted here: a fake-timer flush
  // would test the timer rather than the behaviour. What is asserted is the
  // part a keyboard user cannot work around, which is the way out.
  test('a sheet is a dialog and closes on Escape', () => {
    const onClose = jest.fn();
    const { getByRole, unmount } = render(<FlockProfileSheet {...flockProps({ onClose })} />);
    const dialog = getByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-label')).toBe('About Friday at Kome');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    unmount();
  });

  test('a dialog stacked above this sheet keeps its own Escape and its own Tab', () => {
    // Report and Block open from a member row here and land at z-index 200, on
    // top of this sheet. ModerationSheet binds its keydown on DOCUMENT in the
    // capture phase; this sheet binds on WINDOW, which runs first. Without a
    // target check the covered sheet ate the visible modal's Escape and cycled
    // Tab through controls nobody could see.
    const onClose = jest.fn();
    const above = document.createElement('button');
    document.body.appendChild(above);
    const { unmount } = render(<FlockProfileSheet {...flockProps({ onClose })} />);

    fireEvent.keyDown(above, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    above.focus();
    fireEvent.keyDown(above, { key: 'Tab' });
    expect(document.activeElement).toBe(above);

    // A key with no element behind it still belongs to the top-most trap.
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);

    unmount();
    document.body.removeChild(above);
  });

  test('the injected DialogBehavior lands on the sheet, not on the backdrop', () => {
    const { container, getByRole } = render(
      <FlockProfileSheet {...flockProps({ DialogBehavior: FakeDialogBehavior })} />
    );
    const dialog = getByRole('dialog');
    expect(dialog.className).toContain('cs-sheet');
    expect(dialog.getAttribute('aria-label')).toBe('About Friday at Kome');
    // The backdrop is a full-viewport overlay that dismisses on click. It is
    // not the thing a screen reader should announce as the dialog.
    const backdrop = container.querySelector('.cs-backdrop');
    expect(backdrop.getAttribute('role')).toBeNull();
    expect(backdrop.getAttribute('aria-modal')).toBeNull();
  });

  test('opening a sheet drops the keyboard on the injected path too', () => {
    const field = document.createElement('input');
    document.body.appendChild(field);
    field.focus();

    const { unmount } = render(
      <ComposerPlusSheet {...composerProps({ DialogBehavior: FakeDialogBehavior })} />
    );
    // The helper App.js hands down traps focus and sets ARIA. It does not
    // blur, so a dismissal that lived inside the local trap would vanish on
    // the one path that ships and the sheet would rise into an open keyboard.
    expect(document.activeElement).not.toBe(field);

    unmount();
    document.body.removeChild(field);
  });

  test('a member row carries the role in its accessible name, not only on screen', () => {
    const withHost = [{ id: 1, name: 'Maya', color: '#2d5a87', presence: 'in_chat', roleLabel: 'Host' }];
    const { getByRole, getByText } = render(<FlockProfileSheet {...flockProps({ members: withHost })} />);
    expect(getByText('Host')).toBeInTheDocument();
    // WCAG 2.5.3: the visible word has to be in the name, and an aria-label
    // replaces the row's content rather than adding to it.
    expect(getByRole('button', { name: 'Maya, Host, In the chat' })).toBeInTheDocument();
  });

  test('opening a sheet drops the keyboard by blurring the message field', () => {
    const field = document.createElement('input');
    document.body.appendChild(field);
    field.focus();
    expect(document.activeElement).toBe(field);

    const { unmount } = render(<ComposerPlusSheet {...composerProps()} />);
    // Synchronous on mount: the sheet must not rise into a keyboard.
    expect(document.activeElement).not.toBe(field);

    unmount();
    document.body.removeChild(field);
  });

  test('Tab is trapped inside the sheet', () => {
    const { container, unmount } = render(<ComposerPlusSheet {...composerProps()} />);
    const buttons = Array.from(container.querySelectorAll('button'));
    const last = buttons[buttons.length - 1];
    last.focus();
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(container.contains(document.activeElement)).toBe(true);
    unmount();
  });

  test('the mute row reports its state as a switch', () => {
    const onToggleMute = jest.fn();
    const { getByRole } = render(<FlockProfileSheet {...flockProps({ muted: true, onToggleMute })} />);
    const sw = getByRole('switch', { name: /Mute this chat/ });
    expect(sw.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(sw);
    expect(onToggleMute).toHaveBeenCalledWith(false);
  });

  test('no surface in this folder renders a text input, so the iOS 16px floor is not at risk', () => {
    for (const [, view] of surfaces()) {
      expect(view.container.querySelectorAll('input, textarea, select')).toHaveLength(0);
      view.unmount();
    }
    // And the source agrees, so a later edit cannot slip one in unnoticed.
    ['FlockProfileSheet.js', 'ComposerPlusSheet.js', 'PinStrip.js', 'PinnedMessageBar.js'].forEach((f) => {
      expect(read(f)).not.toMatch(/<input|<textarea|<select/);
    });
  });

  test('motion is collapsed under prefers-reduced-motion, in this folder\'s own stylesheet', () => {
    expect(CSS).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    const block = CSS.slice(CSS.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(block).toContain('.cs-backdrop');
    expect(block).toContain('.cs-sheet');
    expect(block).toContain('.cs-strip-menu');
  });
});

/* ══════════════════════════════════════════════════════════════════════
   5. NO FAKE STATES, AND THE COPY RULES
   ══════════════════════════════════════════════════════════════════════ */
describe('no fake states', () => {
  test('the Money section is absent when there is neither a pool nor a bill', () => {
    const { container } = render(<FlockProfileSheet {...flockProps({ pool: null, bill: null })} />);
    expect(sectionsOf(container)).toEqual(['plan', 'people', 'pins', 'media', 'settings']);
  });

  test('a media count renders only when somebody counted', () => {
    const counted = render(<FlockProfileSheet {...flockProps({ mediaCount: 12 })} />);
    expect(counted.getByRole('button', { name: /Photos in this chat/ }).textContent).toContain('12');
    counted.unmount();

    const uncounted = render(<FlockProfileSheet {...flockProps({ mediaCount: null })} />);
    const row = uncounted.getByRole('button', { name: /Photos in this chat/ });
    expect(row.textContent.trim()).toBe('Photos in this chat');
  });

  test('a presence dot renders only for a presence the caller supplied', () => {
    const { getByRole, container } = render(<FlockProfileSheet {...flockProps()} />);
    expect(getByRole('button', { name: 'Maya, In the chat' })).toBeInTheDocument();
    expect(getByRole('button', { name: 'Sam, Online' })).toBeInTheDocument();
    // Ava has no presence key, so her row says nothing about where she is.
    const ava = getByRole('button', { name: 'Ava' });
    expect(ava.querySelector('.cs-presence')).toBeNull();
    expect(container.querySelectorAll('.cs-dot')).toHaveLength(2);
  });

  test('an empty plan says what is missing instead of printing a blank', () => {
    const { getByText } = render(<FlockProfileSheet {...flockProps({ plan: null })} />);
    expect(getByText('No time set')).toBeInTheDocument();
    expect(getByText('No place yet')).toBeInTheDocument();
  });

  test('an empty pin list offers the way to make one', () => {
    const { getByText } = render(<FlockProfileSheet {...flockProps({ pins: [] })} />);
    expect(getByText('Nothing pinned yet. Press and hold a message to pin it.')).toBeInTheDocument();
  });

  test('an unread notification status is left blank rather than guessed', () => {
    const { getByRole } = render(<FlockProfileSheet {...flockProps({ notificationsLabel: null })} />);
    expect(getByRole('button', { name: /Notifications/ }).textContent.trim()).toBe('Notifications');
  });

  test('no em dashes anywhere in the folder', () => {
    FILES.forEach((f) => {
      const src = read(f);
      const at = src.indexOf('—');
      expect(`${f}:${at === -1 ? 'clean' : src.slice(Math.max(0, at - 40), at + 40)}`).toBe(`${f}:clean`);
    });
  });

  test('every colour comes from a token, never a literal hex, except the two new ones', () => {
    // The only hex literals allowed in this folder are the four values of the
    // two new colour tokens, which have to be written out somewhere, plus the
    // rgba shadows and the backdrop.
    const declarations = CSS.split('\n').filter((l) => /#[0-9a-fA-F]{3,8}\b/.test(l));
    declarations.forEach((line) => {
      expect(line).toMatch(/--chat-strip-bg|--chat-presence/);
    });
    ['FlockProfileSheet.js', 'ComposerPlusSheet.js', 'PinStrip.js', 'PinnedMessageBar.js'].forEach((f) => {
      expect(read(f)).not.toMatch(/#[0-9a-fA-F]{6}\b/);
    });
  });

  test('the new tokens are declared for both themes', () => {
    const light = CSS.slice(CSS.indexOf(':root {'), CSS.indexOf('[data-theme="dark"]'));
    const dark = CSS.slice(CSS.indexOf('[data-theme="dark"]'));
    ['--chat-strip-bg', '--chat-presence'].forEach((t) => {
      expect(light).toContain(`${t}:`);
      expect(dark).toContain(`${t}:`);
    });
    // Measurements have no dark variant by design, so they appear once.
    ['--chat-strip-h', '--chat-pinbar-h', '--chat-row-min'].forEach((t) => {
      expect(light).toContain(`${t}:`);
    });
  });

  test('the measured geometry is in the stylesheet, not scattered as literals', () => {
    expect(CSS).toContain('--chat-strip-h: 36px');
    expect(CSS).toContain('--chat-pinbar-h: 32px');
    expect(CSS).toContain('--chat-row-min: 44px');
    // Strip name at 15 semibold, caption at the meta role (12).
    expect(CSS).toMatch(/\.cs-strip-name\s*\{[^}]*font-size:\s*15px/);
    expect(CSS).toMatch(/\.cs-strip-caption\s*\{[^}]*font-size:\s*var\(--t-meta\)/);
    // Thumbnail 20 square.
    expect(CSS).toMatch(/\.cs-strip-thumb\s*\{[^}]*width:\s*20px/);
  });

  test('a split row hands its inset to its child instead of doubling it', () => {
    // .cs-row-split also carries .cs-row, whose 10px 16px would otherwise
    // stand: the pin glyph started at 32px and the row measured 64 tall
    // against every other row's 44, with the inset hairline no longer lining
    // up with its own content.
    expect(CSS).toMatch(/\.cs-row-split\s*\{[^}]*padding:\s*0 6px 0 0/);
    expect(CSS).not.toMatch(/\.cs-row-split\s*\{[^}]*padding-right:\s*6px/);
  });

  test('the two pinned-bar controls have a real 44px box and overlays that stay inside the bar', () => {
    // At 28 square with .hit44 their invisible 44px overlays overlapped by
    // 16px and the destructive one, being later in the DOM, won the hit test:
    // a tap on the right of Next unpinned a message everyone can see.
    expect(CSS).toMatch(/\.cs-pinbar-next,\s*\.cs-pinbar-unpin\s*\{[^}]*width:\s*44px/);
    expect(CSS).not.toMatch(/\.cs-pinbar-next[^{]*\{[^}]*width:\s*28px/);
    // The bar is 32 by measurement, so the overlay's vertical half is held to
    // the bar rather than spilling 6px into the strip above and the stream
    // below and taking their taps.
    expect(CSS).toMatch(/\.cs-pinbar \.cs-pinbar-next::after,\s*\.cs-pinbar \.cs-pinbar-unpin::after\s*\{[^}]*height:\s*100%/);
  });
});
