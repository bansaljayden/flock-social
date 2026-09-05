/**
 * THE STREAM CARDS AND SYSTEM ROWS.
 *
 * WHAT IS UNDER TEST. The six components and one stylesheet in
 * `src/components/chat/cards/`, which replace the stack of banners that sits
 * today between the chat header and the first message. Every one of them is
 * presentational and takes its whole world as props, so unlike the App.js
 * suites in this folder these are real renders rather than source scans. The
 * source-scanning block at the bottom covers the four rules a render cannot
 * see: no em dashes, no hardcoded hex, every new token defined in both
 * themes, and no fetching hidden inside a card.
 *
 * THE THREE THINGS THIS SUITE EXISTS TO CATCH, in the order they are most
 * likely to come back:
 *
 *   1. A FIGURE THE PROPS DID NOT SUPPLY. routes/billing.js sends null for
 *      every money field on a shell bill whose flock has fallen under three
 *      non-skipped budget submissions, because a per-head figure derived from
 *      the budget ceiling IS the ceiling. A card that prints "$null", "$" or
 *      "$0.00" there has reopened a privacy door the server closed. The same
 *      rule covers a vote count nobody sent, a rating a venue does not have,
 *      a distance with no position behind it and a countdown with no end
 *      time. Each card is rendered with the figure withheld and the whole
 *      card is asserted free of digits.
 *
 *   2. A SETTLED CLAIM THAT COUNTS THE WRONG ARRAY. `bill.shares` is block
 *      filtered and `shareCount` / `settledCount` / `fullySettled` are not, so
 *      a card that counts its own array declares a three way split square
 *      while a third of it is owed. There is a test for exactly that shape.
 *
 *   3. THE COPY DRIFTING. "2 of 5 settled", "All settled up", "Waiting on 3",
 *      "You're settled", "Pre-committed", "Settle up", "Mark as paid",
 *      "Undo", "Lock it in", "Locked: Kome". These are the plan's words and
 *      they are asserted verbatim. "View" is asserted ABSENT as an action,
 *      because the whole card is the tap target and a View button teaches the
 *      reader that it is not.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test --watchAll=false chatCards
 */

import React from 'react';
import fs from 'fs';
import path from 'path';
import { render, screen, fireEvent, within, act } from '@testing-library/react';

import SystemRow, { formatMoney, CardShell, MemberAvatar } from '../components/chat/cards/SystemRow';
import NudgeRow from '../components/chat/cards/NudgeRow';
import BillCard, { billTally } from '../components/chat/cards/BillCard';
import PollCard from '../components/chat/cards/PollCard';
import VenueCardRow from '../components/chat/cards/VenueCardRow';
import LocationCard, { remainingLabel, distanceLabel } from '../components/chat/cards/LocationCard';
import WhoIsHereCard from '../components/chat/cards/WhoIsHereCard';

const CARDS_DIR = path.join(__dirname, '..', 'components', 'chat', 'cards');
const readCard = (file) => fs.readFileSync(path.join(CARDS_DIR, file), 'utf8');
const CARD_JS = fs.readdirSync(CARDS_DIR).filter((f) => f.endsWith('.js'));

// jsdom 16 has no PointerEvent, and @testing-library falls back to a bare
// Event when the constructor is missing, which drops clientX and makes a
// swipe test silently prove nothing. A MouseEvent carries clientX and takes
// any type name, and React reads clientX off the native event either way.
const pointer = (el, type, clientX) => {
  fireEvent(el, new window.MouseEvent(type, { bubbles: true, cancelable: true, clientX }));
};

const textOf = (el) => (el.textContent || '');

// ===========================================================================
// formatMoney
// ===========================================================================
describe('formatMoney', () => {
  test('prints cents when there are cents and drops a bare .00', () => {
    expect(formatMoney(84.5)).toBe('$84.50');
    expect(formatMoney(16.9)).toBe('$16.90');
    expect(formatMoney(40)).toBe('$40');
    expect(formatMoney(0)).toBe('$0');
  });

  test('a value that is not a finite number is not a figure', () => {
    expect(formatMoney(null)).toBeNull();
    expect(formatMoney(undefined)).toBeNull();
    expect(formatMoney(Number.NaN)).toBeNull();
    expect(formatMoney(Infinity)).toBeNull();
    // A numeric STRING is not a number. The server sends null, never "40",
    // and accepting a string here would let a parseFloat somewhere upstream
    // decide what the card prints.
    expect(formatMoney('40')).toBeNull();
  });

  test('a negative figure keeps its sign in front of the dollar', () => {
    expect(formatMoney(-12.5)).toBe('-$12.50');
  });
});

// ===========================================================================
// SystemRow
// ===========================================================================
describe('SystemRow', () => {
  test('draws the parts it was given and accents the value that changed', () => {
    const { container } = render(
      <SystemRow
        kind="venue_set"
        parts={[{ text: 'Maya set the venue: ' }, { text: 'Kome', accent: true }]}
      />
    );
    const row = container.querySelector('[data-system-kind="venue_set"]');
    expect(row).not.toBeNull();
    expect(textOf(row)).toBe('Maya set the venue: Kome');

    const accented = row.querySelectorAll('[data-accent="true"]');
    expect(accented).toHaveLength(1);
    expect(textOf(accented[0])).toBe('Kome');
  });

  test('the vocabulary the plan asks for, each as parts and not as prose', () => {
    const rows = [
      [{ text: 'Time moved to ' }, { text: '8:30', accent: true }],
      [{ text: 'Sam joined' }],
      [{ text: 'You unsent a message' }],
      [{ text: "Ava says they're OK" }],
    ];
    rows.forEach((parts) => {
      const { container, unmount } = render(<SystemRow kind="event" parts={parts} />);
      expect(textOf(container)).toBe(parts.map((p) => p.text).join(''));
      unmount();
    });
  });

  test('a money part is formatted here, never by the caller', () => {
    const { container } = render(
      <SystemRow kind="budget_locked" parts={[{ text: 'Budget locked at ' }, { money: 40, accent: true }]} />
    );
    expect(textOf(container)).toBe('Budget locked at $40');
  });

  test('a withheld money part is dropped, so no row prints a bare dollar sign', () => {
    const { container } = render(
      <SystemRow kind="budget_locked" parts={[{ text: 'Budget locked' }, { money: null, accent: true }]} />
    );
    expect(textOf(container)).toBe('Budget locked');
    expect(textOf(container)).not.toContain('$');
    expect(textOf(container)).not.toContain('null');
    expect(textOf(container)).not.toContain('undefined');
  });

  test('no parts means no row, not an empty grey line', () => {
    const { container: a } = render(<SystemRow kind="event" parts={[]} />);
    expect(a.firstChild).toBeNull();
    const { container: b } = render(<SystemRow kind="event" />);
    expect(b.firstChild).toBeNull();
    const { container: c } = render(<SystemRow kind="event" parts={[{ text: '' }]} />);
    expect(c.firstChild).toBeNull();
  });

  test('a tappable row is a real button with a label and a 44px hit box', () => {
    const onTap = jest.fn();
    render(
      <SystemRow
        kind="pin"
        parts={[{ text: 'Pinned: ' }, { text: 'Kome', accent: true }]}
        onTap={onTap}
        ariaLabel="Jump to the pinned message"
      />
    );
    const btn = screen.getByRole('button', { name: 'Jump to the pinned message' });
    expect(btn.className).toContain('hit44');
    // A REAL box, not only the overlay. .chat-system-row sets overflow:
    // hidden for its ellipsis, and index.css's own note on .hit44 says a host
    // that clips its overflow swallows the pseudo element and has to carry
    // the 44px itself. 12 + the 20 pitch + 12 is exactly 44.
    expect(btn.style.minHeight).toBe('44px');
    fireEvent.click(btn);
    expect(onTap).toHaveBeenCalledTimes(1);
  });

  test('a notice is drawn at the measured notice type, not at a size of its own', () => {
    // CHAT-REBUILD-PLAN.md, Measurements: "System notices centred, uppercase,
    // 10 pt ... 20 pt pitch". chat.css already holds those as
    // --chat-notice-size / --chat-notice-line / --chat-notice and
    // MessageGroup draws the plain system sentence from them, so an event
    // that arrives as message text and the same event drawn through this
    // component have to land on the same three values. The check is a source
    // read because jsdom drops a var() off an inline style.
    const src = readCard('SystemRow.js');
    [
      'var(--chat-notice-size)',
      'var(--chat-notice-line)',
      'var(--chat-notice)',
      "textTransform: 'uppercase'",
      "letterSpacing: '0.7px'",
    ].forEach((needle) => {
      expect({ needle, found: src.includes(needle) }).toEqual({ needle, found: true });
    });
    // The 12px it used to draw at is gone from the component altogether, so
    // it cannot come back on the tappable branch alone the way it had.
    expect({ twelve: src.includes("fontSize: '12px'") }).toEqual({ twelve: false });
  });
});

// ===========================================================================
// CardShell and MemberAvatar, the two primitives the cards share
// ===========================================================================
describe('CardShell and MemberAvatar', () => {
  test('a card with an onOpen is the whole tap target, by mouse and by keyboard', () => {
    const onOpen = jest.fn();
    render(<CardShell onOpen={onOpen} ariaLabel="Open the bill">body</CardShell>);
    const card = screen.getByRole('button', { name: 'Open the bill' });
    fireEvent.click(card);
    fireEvent.keyDown(card, { key: 'Enter' });
    fireEvent.keyDown(card, { key: ' ' });
    expect(onOpen).toHaveBeenCalledTimes(3);
  });

  test('a card with nothing to open is not announced as a button', () => {
    render(<CardShell>body</CardShell>);
    expect(screen.queryByRole('button')).toBeNull();
  });

  test('a key pressed on a control inside the card belongs to that control', () => {
    // Every card in this folder puts real buttons inside the shell, and their
    // keydown bubbles to it. The shell used to preventDefault on Enter and
    // Space for any of them, which cancels the focused button's own
    // activation, so Settle up, Commit, Vote, Pin, Stop and Lock it in were
    // all unreachable by keyboard on any card that was given an onOpen. The
    // cards' stop() helpers only cover click, which is why the mouse path
    // never showed it.
    const onOpen = jest.fn();
    render(
      <CardShell onOpen={onOpen} ariaLabel="Open the bill">
        <button type="button">Settle up</button>
      </CardShell>
    );
    const inner = screen.getByRole('button', { name: 'Settle up' });
    fireEvent.keyDown(inner, { key: 'Enter' });
    fireEvent.keyDown(inner, { key: ' ' });
    expect(onOpen).not.toHaveBeenCalled();

    // The shell itself still opens on both keys.
    fireEvent.keyDown(screen.getByRole('button', { name: 'Open the bill' }), { key: 'Enter' });
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  test('the SOS card gets a tone of its own, and an unknown tone still paints', () => {
    // The rebuild plan puts SOS in the stream as "a red system card", and
    // these six components are the whole set of stream cards, so the tone has
    // to exist here or the integration pass has nothing to post it with.
    const { container, unmount } = render(<CardShell tone="alert">Ava pressed SOS</CardShell>);
    expect(container.querySelector('[data-card-tone="alert"]')).not.toBeNull();
    unmount();

    const { container: b } = render(<CardShell tone="nonsense">body</CardShell>);
    expect(textOf(b)).toBe('body');
  });

  test('an avatar carries its badge in its name, not only in its colour', () => {
    render(
      <div>
        <MemberAvatar name="Maya" badge="settled" />
        <MemberAvatar name="Sam" badge="committed" />
        <MemberAvatar name="Ava" />
      </div>
    );
    expect(screen.getByRole('img', { name: 'Maya, settled' })).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Sam, pre-committed' })).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Ava' })).toBeTruthy();
  });
});

// ===========================================================================
// NudgeRow
// ===========================================================================
describe('NudgeRow', () => {
  const base = {
    text: 'Nobody has voted yet',
    actionLabel: 'Open the vote',
    onAction: () => {},
    onDismiss: () => {},
  };

  test('one line, one chip, and a dismiss that is always reachable', () => {
    const onAction = jest.fn();
    const onDismiss = jest.fn();
    render(<NudgeRow {...base} onAction={onAction} onDismiss={onDismiss} />);

    fireEvent.click(screen.getByRole('button', { name: 'Open the vote' }));
    expect(onAction).toHaveBeenCalledTimes(1);

    const x = screen.getByRole('button', { name: 'Dismiss' });
    expect(x.className).toContain('hit44');
    fireEvent.click(x);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  test('a label with no handler behind it draws no chip', () => {
    render(<NudgeRow text="Nobody has voted yet" actionLabel="Open the vote" onDismiss={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Open the vote' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeTruthy();
  });

  test('a swipe past the threshold dismisses it', () => {
    const onDismiss = jest.fn();
    const { container } = render(<NudgeRow {...base} onDismiss={onDismiss} />);
    const row = container.querySelector('[data-nudge-row="true"]');

    pointer(row, 'pointerdown', 200);
    pointer(row, 'pointermove', 120);
    pointer(row, 'pointerup', 120);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  test('a short drag settles back and dismisses nothing', () => {
    const onDismiss = jest.fn();
    const { container } = render(<NudgeRow {...base} onDismiss={onDismiss} />);
    const row = container.querySelector('[data-nudge-row="true"]');

    pointer(row, 'pointerdown', 200);
    pointer(row, 'pointermove', 182);
    pointer(row, 'pointerup', 182);
    expect(onDismiss).not.toHaveBeenCalled();
    expect(row.className).toContain('chat-nudge-settling');
  });

  test('a press that starts on a control never becomes a drag', () => {
    // The row takes pointer capture on every pointerdown, including ones that
    // start on the chip or the X. Capture retargets the compatibility mouse
    // events and the click that follows them to the capture element, so on
    // device the tap was dispatched at the row and the button never saw it.
    // jsdom has no setPointerCapture, so the capture never happens here and
    // this test proves the guard rather than the retarget: a press on a
    // control starts no drag and settles nothing.
    const onDismiss = jest.fn();
    const { container } = render(<NudgeRow {...base} onDismiss={onDismiss} />);
    const row = container.querySelector('[data-nudge-row="true"]');
    const chip = screen.getByRole('button', { name: 'Open the vote' });

    pointer(chip, 'pointerdown', 200);
    pointer(row, 'pointermove', 120);
    pointer(row, 'pointerup', 120);

    expect(onDismiss).not.toHaveBeenCalled();
    expect(row.className).not.toContain('chat-nudge-settling');
    expect(row.className).not.toContain('chat-nudge-leaving');
  });

  test('a dismissed row leaves the accessibility tree with the fade', () => {
    const { container } = render(<NudgeRow {...base} onDismiss={() => {}} />);
    const row = container.querySelector('[data-nudge-row="true"]');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(row.className).toContain('chat-nudge-leaving');
    expect(row.getAttribute('aria-hidden')).toBe('true');
  });

  test('the fading row takes both controls out of the tab order, and dismisses once', () => {
    // aria-hidden over content that can still be tabbed to is a flat WCAG
    // 4.1.2 failure: opacity and pointer-events remove nothing from the tab
    // order, so during the fade, and for as long as a parent leaves the row
    // mounted, a keyboard user could reach an invisible chip and an invisible
    // X. The X also still holds focus after the first press, so a second Enter
    // on it used to call the parent twice.
    const onDismiss = jest.fn();
    const { container } = render(<NudgeRow {...base} onDismiss={onDismiss} />);
    const row = container.querySelector('[data-nudge-row="true"]');
    const chip = screen.getByRole('button', { name: 'Open the vote' });
    const x = screen.getByRole('button', { name: 'Dismiss' });

    expect(chip.getAttribute('tabindex')).toBeNull();
    expect(x.getAttribute('tabindex')).toBeNull();

    fireEvent.click(x);
    expect(row.getAttribute('aria-hidden')).toBe('true');
    expect(chip.getAttribute('tabindex')).toBe('-1');
    expect(x.getAttribute('tabindex')).toBe('-1');

    fireEvent.click(x);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  test('a swipe on a row that is already leaving dismisses nothing more', () => {
    const onDismiss = jest.fn();
    const { container } = render(<NudgeRow {...base} onDismiss={onDismiss} />);
    const row = container.querySelector('[data-nudge-row="true"]');

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    pointer(row, 'pointerdown', 200);
    pointer(row, 'pointermove', 120);
    pointer(row, 'pointerup', 120);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  test('a row nobody is listening to offers no dismiss, and never fades in place', () => {
    // The fade keeps the box: cards.css animates opacity to 0 and holds it
    // there, so a row that entered the leaving state with no handler behind
    // it was an invisible strip in the stream still swallowing taps and still
    // holding focusable controls. Neither route is offered now.
    const { container } = render(
      <NudgeRow text="Nobody has voted yet" actionLabel="Open the vote" onAction={() => {}} />
    );
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull();

    const row = container.querySelector('[data-nudge-row="true"]');
    pointer(row, 'pointerdown', 200);
    pointer(row, 'pointermove', 120);
    pointer(row, 'pointerup', 120);
    expect(row.className).not.toContain('chat-nudge-leaving');
    expect(row.className).toContain('chat-nudge-settling');
    expect(row.getAttribute('aria-hidden')).toBeNull();
  });

  test('a nudge with nothing to say does not render', () => {
    const { container } = render(<NudgeRow text="   " actionLabel="Do it" onAction={() => {}} />);
    expect(container.firstChild).toBeNull();
  });
});

// ===========================================================================
// BillCard
// ===========================================================================
const realBill = (over = {}) => ({
  id: 7,
  flockId: 3,
  hasPayer: true,
  totalAmount: 84.5,
  tipPercent: 0,
  totalWithTip: 84.5,
  paidBy: { id: 1, name: 'Maya' },
  fullySettled: false,
  settledCount: 2,
  shareCount: 5,
  shares: [
    { userId: 1, name: 'Maya', amount: 16.9, paidAmount: 0, outstanding: 16.9, committed: true, settled: true },
    { userId: 2, name: 'Ben', amount: 16.9, paidAmount: 0, outstanding: 16.9, committed: true, settled: true },
    { userId: 3, name: 'Ava', amount: 16.9, paidAmount: 0, outstanding: 16.9, committed: false, settled: false },
    { userId: 4, name: 'Sam', amount: 16.9, paidAmount: 0, outstanding: 16.9, committed: true, settled: false },
    { userId: 5, name: 'Joy', amount: 16.9, paidAmount: 0, outstanding: 16.9, committed: false, settled: false },
  ],
  ...over,
});

describe('BillCard, the posted bill', () => {
  test('title, payer and the footer count', () => {
    const { container } = render(<BillCard bill={realBill()} viewerId={3} onSettle={() => {}} />);
    expect(screen.getByText('Bill $84.50')).toBeTruthy();
    expect(screen.getByText('Paid by Maya')).toBeTruthy();
    expect(screen.getByText('2 of 5 settled')).toBeTruthy();
    expect(container.querySelector('[data-card-tone="settled"]')).toBeNull();
  });

  test('the viewer who owes gets one action, at 44 and carrying the outstanding figure', () => {
    const onSettle = jest.fn();
    render(<BillCard bill={realBill()} viewerId={3} onSettle={onSettle} />);
    const btn = screen.getByRole('button', { name: 'Settle up $16.90' });
    expect(btn.style.minHeight).toBe('44px');
    fireEvent.click(btn);
    expect(onSettle).toHaveBeenCalledTimes(1);
  });

  test('with no payment route on file the only honest label is Mark as paid', () => {
    render(<BillCard bill={realBill()} viewerId={3} canPayOnline={false} onSettle={() => {}} />);
    expect(screen.getByRole('button', { name: 'Mark as paid' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Settle up/ })).toBeNull();
  });

  test('a settled viewer reads Paid and can take it back', () => {
    const onUndo = jest.fn();
    render(<BillCard bill={realBill()} viewerId={2} onSettle={() => {}} onUndo={onUndo} />);
    expect(screen.getByText('Paid')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(onUndo).toHaveBeenCalledTimes(1);
  });

  test('a share covered by credit says so and offers no Undo the route would refuse', () => {
    const bill = realBill();
    bill.shares[1] = { ...bill.shares[1], paidAmount: 30, amount: 16.9, outstanding: 0, settled: true };
    render(<BillCard bill={bill} viewerId={2} onSettle={() => {}} onUndo={() => {}} />);
    expect(screen.getByText("You're settled")).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
  });

  test('the payer has no action, only a count of who has not paid them back', () => {
    render(<BillCard bill={realBill()} viewerId={1} onSettle={() => {}} onUndo={() => {}} />);
    expect(screen.getByText('Waiting on 3')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Settle up/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Mark as paid' })).toBeNull();
  });

  test('everything settled turns the ground green and the footer to All settled up', () => {
    const bill = realBill({
      fullySettled: true,
      settledCount: 5,
      shares: realBill().shares.map((s) => ({ ...s, settled: true })),
    });
    const { container } = render(<BillCard bill={bill} viewerId={3} onSettle={() => {}} />);
    expect(screen.getByText('All settled up')).toBeTruthy();
    expect(container.querySelector('[data-card-tone="settled"]')).not.toBeNull();
    expect(screen.queryByText(/of 5 settled/)).toBeNull();
  });

  test('a blocked member is missing from the array and NOT from the count', () => {
    // Four visible rows, all settled. The server says there are five shares
    // and four settled, so a fifth person the viewer has blocked still owes.
    const bill = realBill({
      fullySettled: false,
      settledCount: 4,
      shareCount: 5,
      shares: realBill().shares.slice(0, 4).map((s) => ({ ...s, settled: true })),
    });
    render(<BillCard bill={bill} viewerId={3} onSettle={() => {}} />);
    expect(screen.getByText('4 of 5 settled')).toBeTruthy();
    expect(screen.queryByText('All settled up')).toBeNull();
    expect(billTally(bill)).toEqual({ settled: 4, total: 5, all: false });
  });

  test('an optimistic local settle is ahead of the server count and still shows', () => {
    const bill = realBill({ settledCount: 2, shareCount: 5 });
    bill.shares[2] = { ...bill.shares[2], settled: true };
    render(<BillCard bill={bill} viewerId={3} onSettle={() => {}} />);
    expect(screen.getByText('3 of 5 settled')).toBeTruthy();
  });

  test('a failed action says what happened and offers the way forward', () => {
    const onRetry = jest.fn();
    render(
      <BillCard
        bill={realBill()}
        viewerId={3}
        error="That did not go through. Nothing was recorded."
        onRetry={onRetry}
        onSettle={() => {}}
      />
    );
    const alert = screen.getByRole('alert');
    expect(textOf(alert)).toContain('That did not go through. Nothing was recorded.');
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

describe('BillCard, the ghost state before a payer exists', () => {
  const shell = (over = {}) => ({
    id: 9,
    hasPayer: false,
    totalAmount: 200,
    totalWithTip: 200,
    tipPercent: 0,
    paidBy: { id: null, name: null },
    fullySettled: false,
    settledCount: 0,
    shareCount: 1,
    shares: [],
    ...over,
  });

  test('the same component, reading Estimated share with a Commit', () => {
    const onCommit = jest.fn();
    const { container } = render(
      <BillCard bill={shell()} viewerId={3} estimatedShare={40} onCommit={onCommit} />
    );
    expect(container.querySelector('[data-bill-shell="true"]')).not.toBeNull();
    expect(screen.getByText('Estimated share $40')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Commit $40' }));
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  test('somebody who has already committed reads Pre-committed and gets no second chip', () => {
    const bill = shell({
      shares: [{ userId: 3, name: 'Ava', amount: 40, paidAmount: 0, outstanding: 40, committed: true, settled: false }],
    });
    render(<BillCard bill={bill} viewerId={3} onCommit={() => {}} />);
    expect(screen.getByText('Pre-committed')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Commit/ })).toBeNull();
  });

  test('a shell never offers a way to pay a payer who is not there', () => {
    render(
      <BillCard bill={shell()} viewerId={3} estimatedShare={40} onSettle={() => {}} onUndo={() => {}} onCommit={() => {}} />
    );
    expect(screen.queryByRole('button', { name: /Settle up/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Mark as paid' })).toBeNull();
  });

  test('WITHHELD FIGURES PRINT NOTHING, and no commit chip is offered over a number nobody can see', () => {
    // What routes/billing.js actually sends when the flock has fallen under
    // three non-skipped budget submissions: every money field is null.
    const bill = shell({ totalAmount: null, totalWithTip: null, shares: [] });
    const { container } = render(<BillCard bill={bill} viewerId={3} onCommit={() => {}} />);
    const all = textOf(container);
    expect(all).not.toMatch(/\$/);
    expect(all).not.toMatch(/\d/);
    expect(all).not.toContain('null');
    expect(all).not.toContain('undefined');
    expect(all).not.toContain('NaN');
    expect(screen.queryByRole('button', { name: /Commit/ })).toBeNull();
    expect(screen.getByText('Nobody has paid yet, and there is no group number to show.')).toBeTruthy();
  });

  test('a bill with a withheld total prints the word and not a broken figure', () => {
    const bill = realBill({ totalAmount: null, totalWithTip: null });
    const { container } = render(<BillCard bill={bill} viewerId={3} onSettle={() => {}} />);
    expect(screen.getByText('Bill')).toBeTruthy();
    expect(textOf(container)).not.toContain('$null');
    expect(textOf(container)).not.toContain('$undefined');
  });

  test('no bill at all renders nothing', () => {
    const { container } = render(<BillCard bill={null} viewerId={3} />);
    expect(container.firstChild).toBeNull();
  });
});

// ===========================================================================
// PollCard
// ===========================================================================
const pollOptions = () => ([
  { id: 'a', name: 'Kome', rating: 4.5, voteCount: 3, voted: false },
  { id: 'b', name: 'Bolete', rating: null, voteCount: 2, voted: false },
  { id: 'c', name: 'Tap House', rating: 4.1, voteCount: 0, voted: false },
]);

describe('PollCard', () => {
  test('open: a title, the rows, and the footer count', () => {
    const { container } = render(
      <PollCard title="Where are we going?" options={pollOptions()} votedCount={5} memberCount={8} />
    );
    expect(container.querySelector('[data-poll-state="open"]')).not.toBeNull();
    expect(screen.getByText('Where are we going?')).toBeTruthy();
    expect(screen.getByText('5 of 8 voted')).toBeTruthy();
    expect(screen.getByText('Kome')).toBeTruthy();
    expect(screen.getByText('4.5')).toBeTruthy();
  });

  test('a row without a rating draws no star figure', () => {
    render(<PollCard options={pollOptions()} votedCount={5} memberCount={8} />);
    const row = screen.getByText('Bolete').closest('[class*="chat-card-row"]');
    expect(textOf(row)).toBe('Bolete2');
  });

  test('tapping a row votes, and the row says whether it is yours', () => {
    const onVote = jest.fn();
    const opts = pollOptions();
    opts[0].voted = true;
    const { container } = render(<PollCard options={opts} votedCount={5} memberCount={8} onVote={onVote} />);
    expect(container.querySelector('[data-poll-state="voted"]')).not.toBeNull();

    const row = screen.getByText('Bolete').closest('[role="button"]');
    fireEvent.click(row);
    expect(onVote).toHaveBeenCalledWith(expect.objectContaining({ name: 'Bolete' }));

    const mine = screen.getByText('Kome').closest('[role="button"]');
    expect(mine.getAttribute('aria-pressed')).toBe('true');
  });

  test('a tie is called a tie, and the host can break it from either leader', () => {
    const onLock = jest.fn();
    const opts = pollOptions();
    opts[1].voteCount = 3;
    const { container } = render(
      <PollCard options={opts} votedCount={6} memberCount={8} isHost onLock={onLock} />
    );
    expect(container.querySelector('[data-poll-state="tie"]')).not.toBeNull();
    expect(screen.getAllByText('Tied')).toHaveLength(2);

    const locks = screen.getAllByRole('button', { name: 'Lock it in' });
    expect(locks).toHaveLength(2);
    fireEvent.click(locks[0]);
    expect(onLock).toHaveBeenCalledWith(expect.objectContaining({ name: 'Kome' }));
  });

  test('a member who is not the host is never offered Lock it in', () => {
    render(<PollCard options={pollOptions()} votedCount={5} memberCount={8} onLock={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Lock it in' })).toBeNull();
  });

  test('locked: the header says which place, and the rows stop taking votes', () => {
    const onVote = jest.fn();
    const { container } = render(
      <PollCard options={pollOptions()} votedCount={8} memberCount={8} lockedName="Kome" isHost onVote={onVote} onLock={() => {}} />
    );
    expect(container.querySelector('[data-poll-state="locked"]')).not.toBeNull();
    expect(screen.getByText('Locked: Kome')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Lock it in' })).toBeNull();

    fireEvent.click(screen.getByText('Bolete'));
    expect(onVote).not.toHaveBeenCalled();
  });

  test('the footer count is not invented from the rows', () => {
    const { container } = render(<PollCard options={pollOptions()} />);
    expect(textOf(container)).not.toMatch(/voted/);
  });

  test('a deadline draws only when there is a real one', () => {
    const soon = new Date(Date.now() + 90 * 60 * 1000).toISOString();
    render(<PollCard options={pollOptions()} votedCount={5} memberCount={8} deadlineAt={soon} />);
    expect(screen.getByText(/^Closes /)).toBeTruthy();

    const { container } = render(<PollCard options={pollOptions()} votedCount={5} memberCount={8} deadlineAt="not a date" />);
    expect(textOf(container)).not.toContain('Closes');
  });

  test('Enter on Lock it in never casts a vote for the row it sits in', () => {
    // The lock button is rendered inside the vote row, and the row's own
    // keydown handler ran for anything that bubbled into it: preventDefault
    // cancelled the button's activation and onVote fired instead, so a host
    // reaching for the lock with the keyboard voted and onLock was never
    // called. A tie is exactly when both controls share a row.
    const onVote = jest.fn();
    const onLock = jest.fn();
    render(
      <PollCard options={pollOptions()} votedCount={5} memberCount={8} isHost onVote={onVote} onLock={onLock} />
    );
    const lock = screen.getByRole('button', { name: 'Lock it in' });
    fireEvent.keyDown(lock, { key: 'Enter' });
    fireEvent.keyDown(lock, { key: ' ' });
    expect(onVote).not.toHaveBeenCalled();

    // The row itself still votes on both keys.
    fireEvent.keyDown(screen.getByText('Bolete').closest('[role="button"]'), { key: 'Enter' });
    expect(onVote).toHaveBeenCalledTimes(1);
  });

  test('a tally the parent has not loaded is not a tally', () => {
    // Number(null) is 0 and it is finite, so the old guard printed "0 of 8
    // voted" for a figure the server had not answered, under a live region
    // that reads it out loud.
    const { container, unmount } = render(
      <PollCard options={pollOptions()} votedCount={null} memberCount={8} />
    );
    expect(textOf(container)).not.toMatch(/voted/);
    unmount();

    const { container: b } = render(
      <PollCard options={pollOptions()} votedCount={5} memberCount={null} />
    );
    expect(textOf(b)).not.toMatch(/voted/);
  });

  test('once the deadline has passed the rows stop taking votes', () => {
    const onVote = jest.fn();
    const past = new Date(Date.now() - 60 * 1000).toISOString();
    render(
      <PollCard options={pollOptions()} votedCount={5} memberCount={8} deadlineAt={past} onVote={onVote} />
    );
    expect(screen.getByText('Voting closed')).toBeTruthy();

    const row = screen.getByText('Bolete').closest('[class*="chat-card-row"]');
    expect(row.getAttribute('role')).toBeNull();
    fireEvent.click(row);
    expect(onVote).not.toHaveBeenCalled();
  });

  test('a poll with nothing to vote on does not render', () => {
    const { container } = render(<PollCard title="Where?" options={[]} votedCount={0} memberCount={8} />);
    expect(container.firstChild).toBeNull();
  });
});

describe('PollCard, sitting on screen as its deadline passes', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  test('the card closes itself at the deadline, on one timeout and not a tick', () => {
    // The clock used to be read only during render, so a poll already on
    // screen kept printing "Closes 9:00" and kept a live vote handler under
    // role="button" until something unrelated re-rendered the stream.
    const onVote = jest.fn();
    const soon = new Date(Date.now() + 60 * 1000).toISOString();
    render(
      <PollCard options={pollOptions()} votedCount={5} memberCount={8} deadlineAt={soon} onVote={onVote} />
    );
    expect(screen.getByText(/^Closes /)).toBeTruthy();
    expect(screen.getByText('Bolete').closest('[class*="chat-card-row"]').getAttribute('role')).toBe('button');
    // One timer for the whole card, armed for the deadline itself.
    expect(jest.getTimerCount()).toBe(1);

    act(() => { jest.advanceTimersByTime(61 * 1000); });

    expect(screen.getByText('Voting closed')).toBeTruthy();
    const row = screen.getByText('Bolete').closest('[class*="chat-card-row"]');
    expect(row.getAttribute('role')).toBeNull();
    fireEvent.click(row);
    expect(onVote).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  test('the timeout is cleared when the card leaves the stream', () => {
    const later = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    const { unmount } = render(
      <PollCard options={pollOptions()} votedCount={5} memberCount={8} deadlineAt={later} onVote={() => {}} />
    );
    expect(jest.getTimerCount()).toBe(1);
    unmount();
    expect(jest.getTimerCount()).toBe(0);
  });

  test('a deadline that has already gone, or none at all, arms no timer', () => {
    const past = new Date(Date.now() - 60 * 1000).toISOString();
    const { unmount } = render(<PollCard options={pollOptions()} deadlineAt={past} onVote={() => {}} />);
    expect(jest.getTimerCount()).toBe(0);
    unmount();

    render(<PollCard options={pollOptions()} onVote={() => {}} />);
    expect(jest.getTimerCount()).toBe(0);
  });
});

// ===========================================================================
// VenueCardRow
// ===========================================================================
describe('VenueCardRow', () => {
  const venue = { name: 'Kome', addr: '17 W Broad St', photo_url: null, place_id: 'p1' };

  test('a flock gets Vote, a DM gets Pin, and neither gets View', () => {
    const { unmount } = render(<VenueCardRow venue={venue} surface="flock" onAction={() => {}} onOpen={() => {}} />);
    expect(screen.getByRole('button', { name: 'Vote' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^View/ })).toBeNull();
    unmount();

    render(<VenueCardRow venue={venue} surface="dm" onAction={() => {}} onOpen={() => {}} />);
    expect(screen.getByRole('button', { name: 'Pin' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^View/ })).toBeNull();
  });

  test('exactly one footer action, and the whole card opens the place', () => {
    const onOpen = jest.fn();
    const onAction = jest.fn();
    render(<VenueCardRow venue={venue} onOpen={onOpen} onAction={onAction} />);

    expect(screen.getAllByRole('button')).toHaveLength(2); // the card, and the one action
    fireEvent.click(screen.getByRole('button', { name: 'Kome. Open the place.' }));
    expect(onOpen).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Vote' }));
    expect(onAction).toHaveBeenCalledTimes(1);
    // The action does not also open the card underneath it.
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  test('an active action says what it already is', () => {
    render(<VenueCardRow venue={venue} surface="dm" actionActive onAction={() => {}} />);
    const btn = screen.getByRole('button', { name: 'Pinned' });
    expect(btn.getAttribute('aria-pressed')).toBe('true');
  });

  test('a count draws only when a count was supplied', () => {
    const { unmount } = render(<VenueCardRow venue={venue} onAction={() => {}} />);
    // Scoped to the action, not to the whole card. The shared fixture's
    // address is "17 W Broad St", so a digit assertion over the container was
    // reading a street number as an invented vote count and failing on it.
    // The rule is about the count on the action, and that is where it is now.
    expect(textOf(screen.getByRole('button', { name: 'Vote' }))).not.toMatch(/\d/);
    unmount();

    render(<VenueCardRow venue={venue} count={1} onAction={() => {}} />);
    expect(screen.getByRole('button', { name: 'Vote · 1' })).toBeTruthy();
  });

  test('the address is optional and a missing one leaves no empty line', () => {
    // The name and the one action, and nothing between them. This asserted
    // 'Vote' alone, which no card has ever rendered: the venue name is the
    // whole point of the row and it is always drawn.
    const { container } = render(<VenueCardRow venue={{ name: 'Kome' }} onAction={() => {}} />);
    expect(textOf(container)).toBe('KomeVote');
  });

  test('a venue with no name is not a card', () => {
    const { container } = render(<VenueCardRow venue={{ addr: '17 W Broad St' }} onAction={() => {}} />);
    expect(container.firstChild).toBeNull();
  });
});

// ===========================================================================
// LocationCard
// ===========================================================================
describe('LocationCard', () => {
  test('the countdown helper says minutes then hours', () => {
    const now = 1700000000000;
    expect(remainingLabel(new Date(now + 47 * 60000).toISOString(), now)).toBe('47 min left');
    expect(remainingLabel(new Date(now + 60 * 60000).toISOString(), now)).toBe('1 hr left');
    expect(remainingLabel(new Date(now + 72 * 60000).toISOString(), now)).toBe('1 hr 12 min left');
    expect(remainingLabel(new Date(now - 1000).toISOString(), now)).toBeNull();
    expect(remainingLabel(null, now)).toBeNull();
    expect(remainingLabel('not a date', now)).toBeNull();
  });

  test('the distance helper never rounds a real position away to zero', () => {
    expect(distanceLabel(0.4)).toBe('0.4 mi away');
    expect(distanceLabel(0.04)).toBe('less than 0.1 mi away');
    expect(distanceLabel(12.3)).toBe('12 mi away');
    expect(distanceLabel(null)).toBeNull();
    expect(distanceLabel(undefined)).toBeNull();
    // Number(null) and Number('') are both 0, which is finite and not
    // negative, so a guard that coerced first answered "less than 0.1 mi
    // away" for a peer the app has no position for. A numeric string is not a
    // number either, for the same reason formatMoney refuses one.
    expect(distanceLabel('')).toBeNull();
    expect(distanceLabel('0.4')).toBeNull();
    expect(distanceLabel(Number.NaN)).toBeNull();
  });

  test('own: the sentence, the countdown and one Stop', () => {
    const onStop = jest.fn();
    const endsAt = new Date(Date.now() + 47 * 60000 - 1000).toISOString();
    render(<LocationCard mode="own" endsAt={endsAt} onStop={onStop} />);

    expect(screen.getByText('Sharing live location')).toBeTruthy();
    expect(screen.getByText('47 min left')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  test('own with no end time carries no countdown at all', () => {
    const { container } = render(<LocationCard mode="own" onStop={() => {}} />);
    expect(screen.getByText('Sharing live location')).toBeTruthy();
    expect(textOf(container)).not.toMatch(/\d/);
  });

  test('peer: who is sharing, how far, and a tap into the map', () => {
    const onOpenMap = jest.fn();
    render(<LocationCard mode="peer" peerName="Ava" distanceMiles={0.4} onOpenMap={onOpenMap} />);
    expect(screen.getByText('Ava is sharing')).toBeTruthy();
    expect(screen.getByText('0.4 mi away')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Ava is sharing. Open the map.' }));
    expect(onOpenMap).toHaveBeenCalledTimes(1);
  });

  test('peer with no position carries no distance', () => {
    const { container } = render(<LocationCard mode="peer" peerName="Ava" />);
    expect(screen.getByText('Ava is sharing')).toBeTruthy();
    expect(textOf(container)).not.toMatch(/mi away/);
    expect(textOf(container)).not.toMatch(/\d/);
  });

  test('an expired countdown tells the parent instead of drawing an ended card', () => {
    const onExpire = jest.fn();
    const { container } = render(
      <LocationCard mode="own" endsAt={new Date(Date.now() - 60000).toISOString()} onStop={() => {}} onExpire={onExpire} />
    );
    expect(onExpire).toHaveBeenCalledTimes(1);
    expect(textOf(container)).not.toMatch(/left/);
    // It is still the live card until the parent swaps it for a system row.
    expect(screen.getByText('Sharing live location')).toBeTruthy();
  });

  test('a share that is extended gets its own expiry, not the first one', () => {
    // The latch that stops onExpire firing twice used to be set once and
    // never released, so a card whose endsAt moved (the sharer extends, or
    // the slot is reused for the next share) never told the parent the second
    // window had ended and sat in the stream claiming a live share.
    const onExpire = jest.fn();
    const { rerender } = render(
      <LocationCard mode="own" endsAt={new Date(Date.now() - 60000).toISOString()} onExpire={onExpire} />
    );
    expect(onExpire).toHaveBeenCalledTimes(1);

    rerender(
      <LocationCard mode="own" endsAt={new Date(Date.now() - 30000).toISOString()} onExpire={onExpire} />
    );
    expect(onExpire).toHaveBeenCalledTimes(2);
  });

  test('a peer card with nobody on it does not render', () => {
    const { container } = render(<LocationCard mode="peer" distanceMiles={0.4} />);
    expect(container.firstChild).toBeNull();
  });
});

// ===========================================================================
// WhoIsHereCard
// ===========================================================================
describe('WhoIsHereCard', () => {
  const members = [
    { id: 1, name: 'Maya', status: 'near' },
    { id: 2, name: 'Ben', status: 'near' },
    { id: 3, name: 'Ava', status: 'near' },
    { id: 4, name: 'Sam', status: 'onTheWay' },
    { id: 5, name: 'Joy', status: 'onTheWay' },
  ];

  test('the sentence is built from counts and the venue name', () => {
    render(<WhoIsHereCard venueName="Kome" nearCount={3} onTheWayCount={2} members={members} onOpenMap={() => {}} />);
    expect(screen.getByText('3 near Kome, 2 on the way')).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Maya, nearby' })).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Sam, on the way' })).toBeTruthy();
  });

  test('a zero clause is not drawn', () => {
    const { unmount } = render(<WhoIsHereCard venueName="Kome" nearCount={5} onTheWayCount={0} />);
    expect(screen.getByText('5 near Kome')).toBeTruthy();
    unmount();

    render(<WhoIsHereCard venueName="Kome" nearCount={0} onTheWayCount={2} />);
    expect(screen.getByText('2 on the way')).toBeTruthy();
  });

  test('no venue is picked yet, so nobody is near a name the group has not chosen', () => {
    render(<WhoIsHereCard nearCount={3} onTheWayCount={2} />);
    expect(screen.getByText('3 nearby, 2 on the way')).toBeTruthy();
  });

  test('nothing to report means no card', () => {
    const { container } = render(<WhoIsHereCard venueName="Kome" nearCount={0} onTheWayCount={0} members={[]} />);
    expect(container.firstChild).toBeNull();
  });

  test('the card opens the map, and it is the whole card that does it', () => {
    const onOpenMap = jest.fn();
    render(<WhoIsHereCard venueName="Kome" nearCount={3} onTheWayCount={2} onOpenMap={onOpenMap} />);
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]);
    expect(onOpenMap).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
// The rules a render cannot see
// ===========================================================================
describe('the folder as a whole', () => {
  test('the six components and the stylesheet are all there and nothing else is', () => {
    expect(fs.readdirSync(CARDS_DIR).sort()).toEqual([
      'BillCard.js',
      'LocationCard.js',
      'NudgeRow.js',
      'PollCard.js',
      'SystemRow.js',
      'VenueCardRow.js',
      'WhoIsHereCard.js',
      'cards.css',
    ]);
  });

  test('SLOP-AUDIT A2: not one em dash or en dash anywhere in the module', () => {
    ['cards.css', ...CARD_JS].forEach((file) => {
      const src = readCard(file);
      // Written as escapes so this file is itself clean, and so a reader does
      // not have to tell an em dash from an en dash by eye.
      expect({ file, emDash: src.includes('\u2014') }).toEqual({ file, emDash: false });
      expect({ file, enDash: src.includes('\u2013') }).toEqual({ file, enDash: false });
      expect({ file, curlyQuote: src.includes('\u2019') }).toEqual({ file, curlyQuote: false });
    });
  });

  test('colour comes from tokens, so no component hardcodes a hex', () => {
    CARD_JS.forEach((file) => {
      const hits = readCard(file).match(/['"`]#[0-9a-fA-F]{3,8}/g) || [];
      expect({ file, hits }).toEqual({ file, hits: [] });
    });
  });

  test('every new token is defined in BOTH themes', () => {
    const css = readCard('cards.css');
    const light = css.slice(css.indexOf(':root {'), css.indexOf('[data-theme="dark"]'));
    const dark = css.slice(css.indexOf('[data-theme="dark"]'));
    const tokens = [
      '--chat-card-bg',
      '--chat-card-border',
      '--chat-card-settled-bg',
      '--chat-card-settled-border',
      '--chat-card-alert-bg',
      '--chat-card-alert-border',
      '--chat-accent',
      '--chat-vote-track',
      '--chat-vote-fill',
      '--chat-on-fill',
    ];
    tokens.forEach((t) => {
      expect({ t, light: light.includes(`${t}:`) }).toEqual({ t, light: true });
      expect({ t, dark: dark.includes(`${t}:`) }).toEqual({ t, dark: true });
    });
  });

  test('every token the components read is one this file defines or index.css already had', () => {
    const css = readCard('cards.css');
    const known = new Set([
      ...(css.match(/--[a-z0-9-]+(?=:)/g) || []),
      '--text-primary', '--text-secondary', '--text-tertiary',
      '--bg-tertiary', '--focus-ring',
      // Declared on :root in the module's own chat.css, which is bundled with
      // every chat surface these cards render inside. SystemRow and NudgeRow
      // read them ON PURPOSE rather than restating 10 and 20 here, so the
      // notice a card draws and the notice MessageGroup draws cannot drift.
      '--chat-notice-size', '--chat-notice-line', '--chat-notice',
      '--accent-green-text', '--accent-amber-text', '--accent-red-text',
      '--t-body', '--t-label', '--t-meta', '--t-micro', '--t-title', '--t-display',
    ]);
    CARD_JS.forEach((file) => {
      const used = readCard(file).match(/var\((--[a-z0-9-]+)\)/g) || [];
      used.forEach((raw) => {
        const token = raw.slice(4, -1);
        expect({ file, token, known: known.has(token) }).toEqual({ file, token, known: true });
      });
    });
  });

  test('the leaving nudge gives up its pointer events, under either motion setting', () => {
    // The dismiss is a fade, and a fade leaves the box exactly where it was.
    // Without this the row was invisible and still interactive.
    const css = readCard('cards.css');
    const first = css.indexOf('.chat-nudge-leaving {');
    const second = css.indexOf('.chat-nudge-leaving {', first + 1);
    expect(first).toBeGreaterThan(-1);
    expect(second).toBeGreaterThan(first);
    expect(css.slice(first, css.indexOf('}', first))).toContain('pointer-events: none');
    expect(css.slice(second, css.indexOf('}', second))).toContain('pointer-events: none');
    // The second one is the reduced-motion override.
    expect(second).toBeGreaterThan(css.indexOf('@media (prefers-reduced-motion: reduce)'));
  });

  test('the cards are presentational: no fetch, no socket, no context, no storage', () => {
    CARD_JS.forEach((file) => {
      const src = readCard(file);
      [
        'services/api', 'services/socket', 'useContext', 'localStorage',
        'sessionStorage', 'fetch(', 'axios',
      ].forEach((banned) => {
        expect({ file, banned, found: src.includes(banned) }).toEqual({ file, banned, found: false });
      });
    });
  });

  test('every card opens with a comment saying what it is and what it replaces', () => {
    CARD_JS.forEach((file) => {
      const src = readCard(file);
      expect({ file, opensWithABlock: src.startsWith('/**') }).toEqual({ file, opensWithABlock: true });
      expect({ file, saysWhatItReplaces: /WHAT IT REPLACES|WHAT IT IS|WHAT THIS IS/.test(src.slice(0, 2000)) })
        .toEqual({ file, saysWhatItReplaces: true });
    });
  });

  test('money becomes a string in exactly one place', () => {
    // A dollar sign that is not part of a template interpolation is one
    // somebody typed into a string, which is how "$undefined", "$16.9" and a
    // bare "$" have each shipped in this app before. formatMoney in
    // SystemRow.js is the only place allowed to write one, and it is the only
    // file that has one.
    CARD_JS.forEach((file) => {
      const code = readCard(file)
        .split('\n')
        .filter((l) => {
          const t = l.trim();
          return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*');
        })
        .join('\n');
      const bare = (code.match(/\$(?!\{)/g) || []).length;
      expect({ file, bare }).toEqual({ file, bare: file === 'SystemRow.js' ? 1 : 0 });
    });
  });
});
