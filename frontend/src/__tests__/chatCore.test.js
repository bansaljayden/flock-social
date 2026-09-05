/**
 * THE NEW CHAT STREAM: the run grouping, and the components that draw it.
 *
 * The stream is being rebuilt with no bubbles. A run of one person's messages
 * carries their name once and a thin bar in their colour, and everything that
 * used to hang off each individual message (an avatar, a name, a bullet, a
 * time) is gone. Two behaviours in that design are easy to get wrong in a way
 * nobody notices until it is on a phone, so they are pinned here:
 *
 *   1. WHERE A RUN BREAKS. Sender change or day boundary. Never a timer. A
 *      five minute rule, or an hour rule, reads as two strangers talking when
 *      it is one person picking their sentence back up, and every chat client
 *      that has one is tuned for a different product than this. The hour-apart
 *      case below is the one that would go green under a timer rule and must
 *      not.
 *   2. THE LIST DOES NOT MOVE UNDER A READER. A message arriving while you are
 *      scrolled up raises a pill and touches nothing; your own send always
 *      follows the tail. Both are asserted against a real scroll offset, not
 *      against a prop.
 *
 * WHAT IS RENDERED HERE vs SOURCE-SCANNED. Everything about behaviour is
 * rendered with @testing-library/react and driven with real events. The only
 * source scan is the em dash sweep at the end, which is a copy rule and cannot
 * be observed from a render.
 *
 * WHAT IS NOT COVERED, on purpose: the exact pixel rhythm (7 / 4 / 16 / 11 and
 * the rest). jsdom has no layout, so a test asserting them would be asserting
 * the string it just wrote. Those are device work, and the arithmetic behind
 * each number is written out in MessageGroup.js where it can be checked by
 * reading. What IS asserted about layout is the one invariant jsdom can see:
 * the reaction strip is out of flow, which is what makes a first reaction cost
 * nothing.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test chatCore --watchAll=false
 */

import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';

import {
  groupRows,
  dayKeyOf,
  dayLabelOf,
  isSystemRow,
} from '../components/chat/groupRows';
import MessageGroup from '../components/chat/MessageGroup';
import MessageList from '../components/chat/MessageList';
import MessageRow, { groupReactions, imageOf, aspectOf } from '../components/chat/MessageRow';
import StatusLine from '../components/chat/StatusLine';
import TypingRow from '../components/chat/TypingRow';
import DayDivider from '../components/chat/DayDivider';

const fs = require('fs');
const path = require('path');

/* Local time strings on purpose. A 'Z' would put the boundary cases on the
   wrong side of midnight in half the world's timezones and the suite would
   pass or fail by where it ran. */
const AVA = { id: 2, name: 'Ava' };
const BO = { id: 3, name: 'Bo' };

const row = (over = {}) => ({
  id: over.id || Math.random().toString(36).slice(2),
  sender: 'Ava',
  senderId: AVA.id,
  text: 'hi',
  sentAt: '2026-09-05T20:00:00',
  message_type: 'text',
  reactions: [],
  ...over,
});

const NOW = new Date('2026-09-05T21:30:00');

/* ═══════════════════════════════════════════════════════════════════════
   1. groupRows
   ═══════════════════════════════════════════════════════════════════════ */

describe('groupRows: what a run is', () => {
  it('takes nothing and returns nothing', () => {
    expect(groupRows([])).toEqual([]);
    expect(groupRows(undefined)).toEqual([]);
    expect(groupRows(null)).toEqual([]);
    expect(groupRows('not an array')).toEqual([]);
  });

  it('skips holes in the array rather than crashing on them', () => {
    const runs = groupRows([null, row({ id: 'a' }), undefined], { now: NOW });
    expect(runs).toHaveLength(1);
    expect(runs[0].messages).toHaveLength(1);
  });

  it('one message is one run, and it opens its own day', () => {
    const runs = groupRows([row({ id: 'a' })], { now: NOW });
    expect(runs).toHaveLength(1);
    expect(runs[0].senderName).toBe('Ava');
    expect(runs[0].senderId).toBe(AVA.id);
    expect(runs[0].isMine).toBe(false);
    expect(runs[0].isSystem).toBe(false);
    expect(runs[0].firstOfDay).toBe(true);
    expect(runs[0].dayLabel).toBe('Today');
    expect(runs[0].messages).toHaveLength(1);
  });

  it('keeps one sender in one run across an hour, because the rule is sender or day and nothing else', () => {
    const runs = groupRows([
      row({ id: 'a', sentAt: '2026-09-05T20:00:00' }),
      row({ id: 'b', sentAt: '2026-09-05T21:00:00' }),
    ], { now: NOW });
    expect(runs).toHaveLength(1);
    expect(runs[0].messages.map((m) => m.id)).toEqual(['a', 'b']);
  });

  it('breaks on a sender change', () => {
    const runs = groupRows([
      row({ id: 'a' }),
      row({ id: 'b', sender: 'Bo', senderId: BO.id }),
      row({ id: 'c' }),
    ], { now: NOW });
    expect(runs.map((r) => r.senderName)).toEqual(['Ava', 'Bo', 'Ava']);
    expect(runs.map((r) => r.messages.length)).toEqual([1, 1, 1]);
  });

  it('breaks a run in half at a day boundary, and labels the second half', () => {
    const runs = groupRows([
      row({ id: 'a', sentAt: '2026-09-04T23:50:00' }),
      row({ id: 'b', sentAt: '2026-09-05T00:10:00' }),
      row({ id: 'c', sentAt: '2026-09-05T00:11:00' }),
    ], { now: NOW });
    expect(runs).toHaveLength(2);
    expect(runs[0].messages.map((m) => m.id)).toEqual(['a']);
    expect(runs[0].dayLabel).toBe('Yesterday');
    expect(runs[1].messages.map((m) => m.id)).toEqual(['b', 'c']);
    expect(runs[1].firstOfDay).toBe(true);
    expect(runs[1].dayLabel).toBe('Today');
  });

  it('a row with no timestamp inherits the day, so a failed send never invents a divider', () => {
    const runs = groupRows([
      row({ id: 'a', sentAt: '2026-09-05T20:00:00' }),
      row({ id: 'b', sentAt: null, failed: true }),
      row({ id: 'c', sentAt: '2026-09-05T20:05:00' }),
    ], { now: NOW });
    expect(runs).toHaveLength(1);
    expect(runs[0].messages.map((m) => m.id)).toEqual(['a', 'b', 'c']);
  });

  it('a pending own row stays in the same run as the settled ones around it', () => {
    const runs = groupRows([
      row({ id: 'a', sender: 'You', senderId: 1 }),
      row({ id: 'temp-1', sender: 'You', senderId: null, sentAt: null, pending: true }),
    ], { myId: 1, now: NOW });
    expect(runs).toHaveLength(1);
    expect(runs[0].isMine).toBe(true);
    expect(runs[0].messages).toHaveLength(2);
  });

  it('keeps the viewer in one run when the server answers with their real name and id', () => {
    /* The settled row comes back as 'Jay' with id 1 and the one still in
       flight is 'You' with no id at all. Keyed on identity those are two
       different people, which is how the viewer's own name and a second
       coloured bar end up drawn in the middle of their own paragraph. */
    const runs = groupRows([
      row({ id: 'm1', sender: 'Jay', senderId: 1 }),
      row({ id: 'temp-1', sender: 'You', senderId: null, sentAt: null, pending: true }),
    ], { myId: 1, now: NOW });
    expect(runs).toHaveLength(1);
    expect(runs[0].isMine).toBe(true);
    expect(runs[0].senderName).toBe('You');
    expect(runs[0].messages.map((m) => m.id)).toEqual(['m1', 'temp-1']);
  });

  it('an unparseable timestamp is treated as no timestamp', () => {
    expect(dayKeyOf('what time is it')).toBeNull();
    expect(dayKeyOf(null)).toBeNull();
    const runs = groupRows([
      row({ id: 'a' }),
      row({ id: 'b', sentAt: 'what time is it' }),
    ], { now: NOW });
    expect(runs).toHaveLength(1);
  });

  it('identifies the viewer by id, and by the You the two mappers already write', () => {
    const byId = groupRows([row({ id: 'a', sender: 'Ava', senderId: 7 })], { myId: 7, now: NOW });
    expect(byId[0].isMine).toBe(true);
    expect(byId[0].senderName).toBe('You');

    const byName = groupRows([row({ id: 'a', sender: 'You', senderId: null })], { now: NOW });
    expect(byName[0].isMine).toBe(true);

    const neither = groupRows([row({ id: 'a' })], { myId: 7, now: NOW });
    expect(neither[0].isMine).toBe(false);
  });

  it('groups on the sender id, so a rename mid thread does not split a run', () => {
    const runs = groupRows([
      row({ id: 'a', sender: 'Ava', senderId: 2 }),
      row({ id: 'b', sender: 'Ava R', senderId: 2 }),
    ], { now: NOW });
    expect(runs).toHaveLength(1);
    expect(runs[0].senderName).toBe('Ava');
  });

  it('falls back to the name when there is no sender id at all', () => {
    const runs = groupRows([
      row({ id: 'a', senderId: null, sender: 'Ava' }),
      row({ id: 'b', senderId: null, sender: 'Bo' }),
    ], { now: NOW });
    expect(runs).toHaveLength(2);
  });

  it('puts system rows in their own run, never under a person name', () => {
    expect(isSystemRow({ message_type: 'system' })).toBe(true);
    expect(isSystemRow({ message_type: 'text' })).toBe(false);
    const runs = groupRows([
      row({ id: 'a' }),
      row({ id: 's1', message_type: 'system', text: 'Maya set the venue: Kome', sender: 'Maya', senderId: 9 }),
      row({ id: 's2', message_type: 'system', text: 'Sam joined', sender: 'Sam', senderId: 8 }),
      row({ id: 'b' }),
    ], { now: NOW });
    expect(runs.map((r) => r.isSystem)).toEqual([false, true, false]);
    expect(runs[1].senderName).toBeNull();
    expect(runs[1].senderId).toBeNull();
    expect(runs[1].isMine).toBe(false);
    expect(runs[1].messages).toHaveLength(2);
  });

  it('speaks the day the way the two screens already do', () => {
    expect(dayLabelOf('2026-09-05T09:00:00', NOW)).toBe('Today');
    expect(dayLabelOf('2026-09-04T09:00:00', NOW)).toBe('Yesterday');
    expect(dayLabelOf('2026-09-02T09:00:00', NOW)).toBe('Wednesday');
    expect(dayLabelOf('2026-08-20T09:00:00', NOW)).toBe(
      new Date('2026-08-20T09:00:00').toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
    );
    expect(dayLabelOf(null, NOW)).toBeNull();
  });
});

/* ═══════════════════════════════════════════════════════════════════════
   2. MessageGroup
   ═══════════════════════════════════════════════════════════════════════ */

const RUN_COLOUR = 'rgb(60, 178, 226)';

const runOf = (messages, over = {}) => ({
  key: 'id:2',
  senderId: AVA.id,
  senderName: 'Ava',
  isMine: false,
  isSystem: false,
  firstOfDay: false,
  dayLabel: null,
  messages,
  ...over,
});

describe('MessageGroup: the name once, the bar down the run', () => {
  it('names the sender exactly once for a run of three', () => {
    render(
      <MessageGroup
        run={runOf([row({ id: 'a', text: 'one' }), row({ id: 'b', text: 'two' }), row({ id: 'c', text: 'three' })])}
        colour={RUN_COLOUR}
      />
    );
    expect(screen.getAllByText('Ava')).toHaveLength(1);
    expect(screen.getByText('one')).toBeInTheDocument();
    expect(screen.getByText('two')).toBeInTheDocument();
    expect(screen.getByText('three')).toBeInTheDocument();
  });

  it('draws one bar, in the colour it was handed, and hides it from screen readers', () => {
    const { container } = render(
      <MessageGroup run={runOf([row({ id: 'a' }), row({ id: 'b' })])} colour={RUN_COLOUR} />
    );
    const bars = container.querySelectorAll('span[aria-hidden="true"]');
    expect(bars).toHaveLength(1);
    expect(bars[0].style.background).toContain('rgb(60, 178, 226)');
    expect(bars[0].style.position).toBe('absolute');
  });

  it('never hardcodes a colour: with no colour prop it falls back to a token', () => {
    const { container } = render(<MessageGroup run={runOf([row({ id: 'a' })])} />);
    const bar = container.querySelector('span[aria-hidden="true"]');
    expect(bar.getAttribute('style') || '').not.toMatch(/#[0-9a-f]{3,8}/i);
  });

  it('can be told to draw no name, and still identifies by the bar', () => {
    const { container } = render(
      <MessageGroup run={runOf([row({ id: 'a' })])} colour={RUN_COLOUR} showName={false} />
    );
    expect(screen.queryByText('Ava')).toBeNull();
    expect(container.querySelector('span[aria-hidden="true"]')).toBeTruthy();
  });

  it('renders the status under the one row the parent asks for, and nowhere else', () => {
    render(
      <MessageGroup
        run={runOf([row({ id: 'a', text: 'one' }), row({ id: 'b', text: 'two' })])}
        colour={RUN_COLOUR}
        renderStatus={(m) => (m.id === 'b' ? <StatusLine status="delivered" /> : null)}
      />
    );
    expect(screen.getAllByText('Delivered')).toHaveLength(1);
  });

  it('keeps a failed send reachable when it is not the last row of the run', () => {
    /* Send while offline so it fails, reconnect, send again: both rows are
       yours on the same day, so they are one run and the failed one is in the
       middle. Asking the parent about the last row alone would leave it with
       no retry and no way to drop it, on every reopen of the chat. */
    const onRetry = jest.fn();
    render(
      <MessageGroup
        run={runOf(
          [row({ id: 'a', text: 'hey', failed: true }), row({ id: 'b', text: 'you there' })],
          { isMine: true, senderName: 'You' }
        )}
        colour={RUN_COLOUR}
        renderStatus={(m) => {
          if (m.failed) return <StatusLine status="failed" onRetry={onRetry} onRemove={() => {}} />;
          return m.id === 'b' ? <StatusLine status="sent" /> : null;
        }}
      />
    );
    expect(screen.getByText("Didn't send")).toBeInTheDocument();
    expect(screen.getByText('Sent')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Retry'));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('Remove this message that did not send')).toBeInTheDocument();
  });

  it('draws a system run centred, with no name and no bar', () => {
    const { container } = render(
      <MessageGroup
        run={runOf(
          [row({ id: 's1', message_type: 'system', text: 'Sam joined' })],
          { isSystem: true, senderName: null, senderId: null }
        )}
        colour={RUN_COLOUR}
      />
    );
    expect(screen.getByText('Sam joined')).toBeInTheDocument();
    expect(screen.queryByText('Ava')).toBeNull();
    expect(container.querySelector('span[aria-hidden="true"]')).toBeNull();
  });

  it('renders nothing for a run with no messages', () => {
    const { container } = render(<MessageGroup run={runOf([])} colour={RUN_COLOUR} />);
    expect(container.firstChild).toBeNull();
  });

  it('hands each row the card the parent renders, and does not draw the card itself', () => {
    render(
      <MessageGroup
        run={runOf([row({ id: 'a', text: null, message_type: 'venue_card', venue_data: { name: 'Kome' } })])}
        colour={RUN_COLOUR}
        renderCard={(m) => (m.message_type === 'venue_card' ? <div>Card for {m.venue_data.name}</div> : null)}
      />
    );
    expect(screen.getByText(/Card for Kome/)).toBeInTheDocument();
  });
});

/* ═══════════════════════════════════════════════════════════════════════
   3. MessageRow
   ═══════════════════════════════════════════════════════════════════════ */

describe('MessageRow: reactions, photos, quotes', () => {
  it('counts one pill per emoji and tolerates the old bare string shape', () => {
    expect(groupReactions([
      { emoji: '❤️', user_id: 1 },
      { emoji: '❤️', user_id: 2 },
      { emoji: '🔥', user_id: 3 },
    ])).toEqual([
      { emoji: '❤️', count: 2, userIds: [1, 2] },
      { emoji: '🔥', count: 1, userIds: [3] },
    ]);
    expect(groupReactions(['🔥'])).toEqual([{ emoji: '🔥', count: 1, userIds: [] }]);
    expect(groupReactions(null)).toEqual([]);
    expect(groupReactions([{}, null])).toEqual([]);
  });

  it('keeps the reaction strip out of flow, which is why a first reaction moves nothing', () => {
    const { container } = render(
      <MessageRow message={row({ id: 'a', reactions: [{ emoji: '🔥', user_id: 4 }] })} />
    );
    const strip = container.querySelector('div[style*="absolute"]');
    expect(strip).toBeTruthy();
    expect(strip.style.position).toBe('absolute');
    expect(strip.style.bottom).toBe('0px');
  });

  it('gives every reaction pill a name that says what it is', () => {
    render(<MessageRow message={row({ id: 'a', reactions: [{ emoji: '🔥', user_id: 4 }] })} />);
    expect(screen.getByLabelText('🔥 1 reaction')).toBeInTheDocument();
  });

  it('gives a pill its own target rather than an overlay that covers the pill beside it', () => {
    /* index.css's `.hit44` lays a 44 WIDE pseudo-element over a button that is
       about 27 wide here, sitting 3px from its neighbour, with no
       pointer-events:none. Two pills, and the later one's overlay covers most
       of the first, so a tap on the first reaction toggled the second. The
       target is the button itself now, and flex gives each one its own
       column. */
    render(
      <MessageRow
        message={row({
          id: 'a',
          reactions: [{ emoji: '🔥', user_id: 4 }, { emoji: '❤️', user_id: 5 }],
        })}
      />
    );
    for (const label of ['🔥 1 reaction', '❤️ 1 reaction']) {
      const pill = screen.getByLabelText(label);
      expect({ label, hit44: pill.className.includes('hit44') })
        .toEqual({ label, hit44: false });
      expect(pill.style.height).toBe('44px');
    }
  });

  it('leaves the Save Image callout to the stylesheet instead of declaring it twice', () => {
    /* The row root turns the WebView callout off for everything inside it and
       the property inherits, so the photo needs no inline copy of it. The
       comment beside the media box used to claim the opposite. */
    const dir = path.join(__dirname, '..', 'components', 'chat');
    const css = fs.readFileSync(path.join(dir, 'chat.css'), 'utf8');
    const js = fs.readFileSync(path.join(dir, 'MessageRow.js'), 'utf8');
    expect(css).toMatch(/\.chat-swipe\s*\{[^}]*-webkit-touch-callout:\s*none/);
    expect(js).not.toMatch(/WebkitTouchCallout/);
  });

  it('reads a photo out of whichever field it arrived in', () => {
    expect(imageOf({ thumb: 'a.jpg', image: 'b.jpg' })).toBe('a.jpg');
    expect(imageOf({ image: 'b.jpg' })).toBe('b.jpg');
    expect(imageOf({ thumb_url: 'c.jpg' })).toBe('c.jpg');
    expect(imageOf({ image_url: 'd.jpg' })).toBe('d.jpg');
    expect(imageOf({})).toBeNull();
    expect(imageOf(null)).toBeNull();
  });

  it('only knows an aspect ratio it was told, and never guesses one', () => {
    expect(aspectOf({ image_width: 3, image_height: 2 })).toBe(1.5);
    expect(aspectOf({ image_aspect: 0.8 })).toBe(0.8);
    expect(aspectOf({ image_width: 0, image_height: 0 })).toBeNull();
    expect(aspectOf({})).toBeNull();
  });

  it('gives a photo an accessible door and does not describe it twice', () => {
    const onOpenImage = jest.fn();
    const { container } = render(
      <MessageRow message={row({ id: 'a', text: null, image: 'x.jpg', sender: 'Ava' })} onOpenImage={onOpenImage} />
    );
    const button = screen.getByLabelText('Open the photo from Ava');
    fireEvent.click(button);
    expect(onOpenImage).toHaveBeenCalledTimes(1);
    // The button carries the name, so the img inside it stays silent.
    expect(container.querySelector('img').getAttribute('alt')).toBe('');
  });

  it('draws a photo as plain markup when there is no viewer to open', () => {
    const { container } = render(
      <MessageRow message={row({ id: 'a', text: null, image: 'x.jpg', sender: 'Ava' })} />
    );
    expect(screen.queryByLabelText('Open the photo from Ava')).toBeNull();
    expect(container.querySelector('button')).toBeNull();
    // No button name to carry it, so the image describes itself.
    expect(container.querySelector('img').getAttribute('alt')).toBe('Photo from Ava');
  });

  it('draws the reply quote and reports a tap on it', () => {
    const onQuoteTap = jest.fn();
    render(
      <MessageRow
        message={row({ id: 'a', reply_to: { id: 'z', sender: 'Bo', text: 'where are we going' } })}
        onQuoteTap={onQuoteTap}
      />
    );
    fireEvent.click(screen.getByLabelText('Replying to Bo'));
    expect(onQuoteTap).toHaveBeenCalledWith({ id: 'z', sender: 'Bo', text: 'where are we going' });
  });

  it('draws the reply quote as plain markup when nothing can jump to it', () => {
    const { container } = render(
      <MessageRow message={row({ id: 'a', reply_to: { id: 'z', sender: 'Bo', text: 'where are we going' } })} />
    );
    expect(screen.queryByLabelText('Replying to Bo')).toBeNull();
    expect(container.querySelector('button')).toBeNull();
    expect(screen.getByText('Bo')).toBeInTheDocument();
    expect(screen.getByText('where are we going')).toBeInTheDocument();
  });

  it('says which reaction is the viewer\'s own, and claims nothing when it cannot tell', () => {
    const { rerender } = render(
      <MessageRow
        message={row({ id: 'a', reactions: [{ emoji: '🔥', user_id: 4 }, { emoji: '❤️', user_id: 7 }] })}
        myId={7}
        onReactionTap={() => {}}
      />
    );
    const theirs = screen.getByLabelText('🔥 1 reaction. Tap to react');
    const yours = screen.getByLabelText('❤️ 1 reaction, including you. Tap to remove your reaction');
    expect(theirs.getAttribute('aria-pressed')).toBe('false');
    expect(yours.getAttribute('aria-pressed')).toBe('true');

    // The old cached shape carries no owners, so there is nothing to press.
    rerender(
      <MessageRow message={row({ id: 'a', reactions: ['🔥'] })} myId={7} onReactionTap={() => {}} />
    );
    expect(screen.getByLabelText('🔥 1 reaction').getAttribute('aria-pressed')).toBeNull();
  });

  it('offers the keyboard a way into the actions a long press opens', () => {
    const onLongPress = jest.fn();
    render(<MessageRow message={row({ id: 'a', sender: 'Ava' })} onLongPress={onLongPress} />);
    fireEvent.click(screen.getByText("Actions for Ava's message"));
    expect(onLongPress).toHaveBeenCalledTimes(1);
    expect(onLongPress.mock.calls[0][1].source).toBe('keyboard');
  });

  it('draws no actions door when the parent passes no handler', () => {
    render(<MessageRow message={row({ id: 'a', sender: 'Ava' })} />);
    expect(screen.queryByText("Actions for Ava's message")).toBeNull();
  });
});

describe('MessageRow gestures: 350ms and 48px, reported and not handled', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  const rowNode = (container) => container.querySelector('.chat-swipe');

  it('reports a long press after 350ms and not before', () => {
    const onLongPress = jest.fn();
    const { container } = render(
      <MessageRow message={row({ id: 'a' })} onLongPress={onLongPress} />
    );
    fireEvent.mouseDown(rowNode(container), { clientX: 10, clientY: 10 });
    act(() => { jest.advanceTimersByTime(340); });
    expect(onLongPress).not.toHaveBeenCalled();
    act(() => { jest.advanceTimersByTime(20); });
    expect(onLongPress).toHaveBeenCalledTimes(1);
    expect(onLongPress.mock.calls[0][0].id).toBe('a');
  });

  it('a press that turns into a scroll is not a long press', () => {
    const onLongPress = jest.fn();
    const { container } = render(
      <MessageRow message={row({ id: 'a' })} onLongPress={onLongPress} />
    );
    const node = rowNode(container);
    fireEvent.touchStart(node, { touches: [{ clientX: 10, clientY: 100 }] });
    fireEvent.touchMove(node, { touches: [{ clientX: 10, clientY: 160 }] });
    act(() => { jest.advanceTimersByTime(500); });
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('reports a reply on a swipe past 48, and stays quiet under it', () => {
    const onSwipeReply = jest.fn();
    const { container } = render(
      <MessageRow message={row({ id: 'a' })} onSwipeReply={onSwipeReply} />
    );
    const node = rowNode(container);

    fireEvent.touchStart(node, { touches: [{ clientX: 10, clientY: 100 }] });
    fireEvent.touchMove(node, { touches: [{ clientX: 30, clientY: 102 }] });
    fireEvent.touchEnd(node, { changedTouches: [{ clientX: 30, clientY: 102 }] });
    expect(onSwipeReply).not.toHaveBeenCalled();

    fireEvent.touchStart(node, { touches: [{ clientX: 10, clientY: 100 }] });
    fireEvent.touchMove(node, { touches: [{ clientX: 75, clientY: 104 }] });
    fireEvent.touchEnd(node, { changedTouches: [{ clientX: 75, clientY: 104 }] });
    expect(onSwipeReply).toHaveBeenCalledTimes(1);
    expect(onSwipeReply.mock.calls[0][0].id).toBe('a');
  });

  it('a long press over a photo does not also open the viewer behind the menu', () => {
    const onLongPress = jest.fn();
    const onOpenImage = jest.fn();
    const { container } = render(
      <MessageRow
        message={row({ id: 'a', text: null, image: 'x.jpg', sender: 'Ava' })}
        onLongPress={onLongPress}
        onOpenImage={onOpenImage}
      />
    );
    const node = rowNode(container);
    const photo = screen.getByLabelText('Open the photo from Ava');

    fireEvent.touchStart(node, { touches: [{ clientX: 10, clientY: 100 }] });
    act(() => { jest.advanceTimersByTime(360); });
    expect(onLongPress).toHaveBeenCalledTimes(1);
    fireEvent.touchEnd(node, { changedTouches: [{ clientX: 10, clientY: 100 }] });
    // The click the browser dispatches on release is spent by the press.
    fireEvent.click(photo);
    expect(onOpenImage).not.toHaveBeenCalled();

    // And the next real tap is not swallowed with it.
    fireEvent.touchStart(node, { touches: [{ clientX: 10, clientY: 100 }] });
    fireEvent.touchEnd(node, { changedTouches: [{ clientX: 10, clientY: 100 }] });
    fireEvent.click(photo);
    expect(onOpenImage).toHaveBeenCalledTimes(1);
  });

  it('a slow tap on Remove drops the message and does not also open the actions menu', () => {
    /* The status the parent hands a non-last row is rendered inside this row,
       and Retry and Remove do not spend the click a long press leaves behind
       the way the photo and the pills do. Held for 350ms, Remove used to open
       the menu and drop the message on the one release. */
    const onLongPress = jest.fn();
    const onRemove = jest.fn();
    render(
      <MessageRow
        message={row({ id: 'a', text: 'hey' })}
        onLongPress={onLongPress}
        status={<StatusLine status="failed" onRetry={() => {}} onRemove={onRemove} />}
      />
    );
    const remove = screen.getByLabelText('Remove this message that did not send');
    fireEvent.touchStart(remove, { touches: [{ clientX: 10, clientY: 100 }] });
    act(() => { jest.advanceTimersByTime(500); });
    expect(onLongPress).not.toHaveBeenCalled();
    fireEvent.touchEnd(remove, { changedTouches: [{ clientX: 10, clientY: 100 }] });
    fireEvent.click(remove);
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it('a drag begun on the failed line does not quote a message that never sent', () => {
    const onSwipeReply = jest.fn();
    render(
      <MessageRow
        message={row({ id: 'a', text: 'hey' })}
        onSwipeReply={onSwipeReply}
        status={<StatusLine status="failed" onRetry={() => {}} onRemove={() => {}} />}
      />
    );
    const line = screen.getByText("Didn't send");
    fireEvent.touchStart(line, { touches: [{ clientX: 10, clientY: 100 }] });
    fireEvent.touchMove(line, { touches: [{ clientX: 90, clientY: 104 }] });
    fireEvent.touchEnd(line, { changedTouches: [{ clientX: 90, clientY: 104 }] });
    expect(onSwipeReply).not.toHaveBeenCalled();
  });

  it('a vertical drag is a scroll, not a reply, however far right it wanders', () => {
    const onSwipeReply = jest.fn();
    const { container } = render(
      <MessageRow message={row({ id: 'a' })} onSwipeReply={onSwipeReply} />
    );
    const node = rowNode(container);
    fireEvent.touchStart(node, { touches: [{ clientX: 10, clientY: 100 }] });
    fireEvent.touchMove(node, { touches: [{ clientX: 90, clientY: 190 }] });
    fireEvent.touchEnd(node, { changedTouches: [{ clientX: 90, clientY: 190 }] });
    expect(onSwipeReply).not.toHaveBeenCalled();
  });
});

/* ═══════════════════════════════════════════════════════════════════════
   4. StatusLine
   ═══════════════════════════════════════════════════════════════════════ */

describe('StatusLine: a receipt, or nothing at all', () => {
  it('draws no word for a status the server never sent, and keeps the region it will speak into', () => {
    /* The region is mounted empty on purpose. A screen reader only notices
       text arriving inside a region that was already in the accessibility
       tree, so the ladder's first word has to land in a region that outlived
       the silence before it. Nothing is drawn: no word, no padding, no
       receipt. */
    const { container, rerender } = render(<StatusLine status={undefined} />);
    const region = container.querySelector('[aria-live="polite"]');
    expect(region).toBeTruthy();
    expect(container.textContent).toBe('');

    rerender(<StatusLine status="read-ish" />);
    expect(container.textContent).toBe('');

    rerender(<StatusLine status="delivered" />);
    expect(container.querySelector('[aria-live="polite"]')).toBe(region);
    expect(screen.getByText('Delivered')).toBeInTheDocument();
  });

  it('says the four words it is allowed to say', () => {
    const cases = [['sending', 'Sending'], ['sent', 'Sent'], ['delivered', 'Delivered'], ['opened', 'Opened']];
    for (const [status, word] of cases) {
      const { unmount } = render(<StatusLine status={status} />);
      expect(screen.getByText(word)).toBeInTheDocument();
      unmount();
    }
  });

  it('announces politely, so a receipt does not interrupt', () => {
    const { container } = render(<StatusLine status="delivered" />);
    expect(container.querySelector('[aria-live="polite"]')).toBeTruthy();
  });

  it('counts the readers in a group and expands to their names on tap', () => {
    const onExpand = jest.fn();
    render(<StatusLine status="opened" openedBy={['Ava', 'Bo', 'Cal']} onExpand={onExpand} />);
    const control = screen.getByText('Opened by 3');
    expect(control.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(control);
    expect(onExpand).toHaveBeenCalledWith(true);
    expect(screen.getByText('Opened by Ava, Bo and Cal')).toBeInTheDocument();
    expect(screen.getByText('Opened by Ava, Bo and Cal').getAttribute('aria-expanded')).toBe('true');
  });

  it('says the plain word rather than counting zero people', () => {
    render(<StatusLine status="opened" openedBy={[]} />);
    expect(screen.getByText('Opened')).toBeInTheDocument();
    expect(screen.queryByText(/Opened by/)).toBeNull();
  });

  it('a failed send says so in a live region and offers both ways out', () => {
    const onRetry = jest.fn();
    const onRemove = jest.fn();
    render(<StatusLine status="failed" onRetry={onRetry} onRemove={onRemove} />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText(/Didn.t send/)).toBeInTheDocument();
    fireEvent.click(screen.getByText('Retry'));
    fireEvent.click(screen.getByLabelText('Remove this message that did not send'));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it('offers no button it cannot honour', () => {
    render(<StatusLine status="failed" />);
    expect(screen.queryByText('Retry')).toBeNull();
    expect(screen.queryByText('Remove')).toBeNull();
  });
});

/* ═══════════════════════════════════════════════════════════════════════
   5. TypingRow
   ═══════════════════════════════════════════════════════════════════════ */

describe('TypingRow: presence and typing, or an empty strip', () => {
  it('draws no pill when nobody is here and nobody is typing, and still holds the region it speaks into', () => {
    /* Same rule as the status line, and it matters more here: this strip is
       the only place a non-sighted reader is told somebody is typing, so the
       region cannot be created by the announcement it is supposed to carry.
       The visible strip still collapses to nothing, which is what the pill
       count asserts. */
    const { container, rerender } = render(
      <TypingRow members={[{ id: 1, name: 'Ava', colour: RUN_COLOUR, present: false, typing: false }]} />
    );
    const region = container.querySelector('[aria-live="polite"]');
    expect(region).toBeTruthy();
    expect(region.className).toContain('chat-sr-only');
    expect(container.textContent).toBe('');
    expect(container.querySelector('span[aria-hidden="true"]')).toBeNull();

    const none = render(<TypingRow members={[]} />);
    expect(none.container.textContent).toBe('');

    rerender(<TypingRow members={[{ id: 1, name: 'Ava', colour: RUN_COLOUR, typing: true }]} />);
    expect(container.querySelector('[aria-live="polite"]')).toBe(region);
    expect(region.textContent).toBe('Ava is typing');
  });

  it('draws a pill per member and says in words what the pills show', () => {
    render(
      <TypingRow
        members={[
          { id: 1, name: 'Maya Chen', colour: RUN_COLOUR, present: true, typing: true },
          { id: 2, name: 'Ava', colour: 'rgb(255, 181, 60)', present: true, typing: false },
          { id: 3, name: 'Cal', colour: 'rgb(29, 179, 141)', present: false, typing: false },
        ]}
      />
    );
    expect(screen.getByText('Maya')).toBeInTheDocument();
    expect(screen.getByText('Ava')).toBeInTheDocument();
    expect(screen.queryByText('Cal')).toBeNull();
    expect(screen.getByText('Maya is typing. Ava is in the chat')).toBeInTheDocument();
  });

  it('announces politely', () => {
    const { container } = render(
      <TypingRow members={[{ id: 1, name: 'Ava', colour: RUN_COLOUR, typing: true }]} />
    );
    expect(container.querySelector('[aria-live="polite"]')).toBeTruthy();
  });
});

/* ═══════════════════════════════════════════════════════════════════════
   6. DayDivider
   ═══════════════════════════════════════════════════════════════════════ */

describe('DayDivider', () => {
  it('is a separator that reads as a sentence', () => {
    render(<DayDivider label="Yesterday" />);
    const sep = screen.getByRole('separator');
    expect(sep.getAttribute('aria-label')).toBe('Messages from Yesterday');
    // The shouting is CSS, so a screen reader says the word.
    expect(screen.getByText('Yesterday')).toBeInTheDocument();
  });

  it('draws nothing without a label', () => {
    const { container } = render(<DayDivider label={null} />);
    expect(container.firstChild).toBeNull();
  });
});

/* ═══════════════════════════════════════════════════════════════════════
   7. MessageList
   ═══════════════════════════════════════════════════════════════════════ */

/** jsdom has no layout, so the scroll box has to be described to it. */
function makeScrollable(el, { scrollHeight = 1000, clientHeight = 300, scrollTop = 0 } = {}) {
  let top = scrollTop;
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => scrollHeight });
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => clientHeight });
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => top,
    set: (v) => { top = v; },
  });
  return () => top;
}

const listProps = {
  myId: 1,
  ownColour: 'rgb(224, 76, 90)',
  colours: { 2: RUN_COLOUR, 3: 'rgb(255, 181, 60)' },
  now: NOW,
};

describe('MessageList: the scroller', () => {
  it('draws a day divider once per day, above the run that opens it', () => {
    render(
      <MessageList
        {...listProps}
        rows={[
          row({ id: 'a', sentAt: '2026-09-04T20:00:00' }),
          row({ id: 'b', sentAt: '2026-09-05T20:00:00' }),
          row({ id: 'c', sentAt: '2026-09-05T20:01:00' }),
        ]}
      />
    );
    expect(screen.getByLabelText('Messages from Yesterday')).toBeInTheDocument();
    expect(screen.getByLabelText('Messages from Today')).toBeInTheDocument();
    expect(screen.getAllByRole('separator')).toHaveLength(2);
  });

  it('gives the viewer their own colour and everyone else theirs', () => {
    const { container } = render(
      <MessageList
        {...listProps}
        rows={[
          row({ id: 'a', sender: 'You', senderId: 1 }),
          row({ id: 'b' }),
        ]}
      />
    );
    const bars = [...container.querySelectorAll('span[aria-hidden="true"]')];
    expect(bars).toHaveLength(2);
    expect(bars[0].style.background).toContain('rgb(224, 76, 90)');
    expect(bars[1].style.background).toContain('rgb(60, 178, 226)');
  });

  it('shows the empty state only when there is nothing at all', () => {
    const { rerender } = render(
      <MessageList {...listProps} rows={[]} emptyState={<p>Nothing here yet</p>} />
    );
    expect(screen.getByText('Nothing here yet')).toBeInTheDocument();
    rerender(<MessageList {...listProps} rows={[row({ id: 'a' })]} emptyState={<p>Nothing here yet</p>} />);
    expect(screen.queryByText('Nothing here yet')).toBeNull();
  });

  it('never says a thread is empty while its first page is still on the wire', () => {
    const { rerender } = render(
      <MessageList
        {...listProps}
        rows={[]}
        loadingState={<p>Loading messages</p>}
        emptyState={<p>Nothing here yet</p>}
      />
    );
    expect(screen.getByText('Loading messages')).toBeInTheDocument();
    expect(screen.queryByText('Nothing here yet')).toBeNull();

    // The load answered with nothing. NOW the thread is empty.
    rerender(<MessageList {...listProps} rows={[]} emptyState={<p>Nothing here yet</p>} />);
    expect(screen.getByText('Nothing here yet')).toBeInTheDocument();
  });

  it('offers the scrollback control until the thread is fully loaded', () => {
    const onLoadOlder = jest.fn();
    const { rerender } = render(
      <MessageList {...listProps} rows={[row({ id: 'a' })]} onLoadOlder={onLoadOlder} atTop={false} />
    );
    fireEvent.click(screen.getByText('Earlier messages'));
    expect(onLoadOlder).toHaveBeenCalledTimes(1);

    rerender(<MessageList {...listProps} rows={[row({ id: 'a' })]} onLoadOlder={onLoadOlder} atTop />);
    expect(screen.queryByText('Earlier messages')).toBeNull();
  });

  it('says it is loading a page rather than pretending the button is idle', () => {
    render(
      <MessageList {...listProps} rows={[row({ id: 'a' })]} onLoadOlder={jest.fn()} olderLoading />
    );
    const button = screen.getByText('Loading');
    expect(button).toBeDisabled();
  });

  it('does not move the page when a message arrives while the reader is scrolled up', () => {
    const rows = [row({ id: 'a' })];
    const { container, rerender } = render(<MessageList {...listProps} rows={rows} />);
    const scroller = container.querySelector('.chat-scroller');
    const readTop = makeScrollable(scroller, { scrollTop: 120 });
    fireEvent.scroll(scroller);
    expect(readTop()).toBe(120);

    rerender(<MessageList {...listProps} rows={[...rows, row({ id: 'b', text: 'and another' })]} />);

    expect(readTop()).toBe(120);
    expect(screen.getByText('1 new message')).toBeInTheDocument();
  });

  it('opens a thread at the newest message when the first page lands', () => {
    const { container, rerender } = render(<MessageList {...listProps} rows={[]} />);
    const scroller = container.querySelector('.chat-scroller');
    const readTop = makeScrollable(scroller, { scrollTop: 0 });

    rerender(<MessageList {...listProps} rows={[row({ id: 'a' }), row({ id: 'b' })]} />);

    // History arrives after the first paint. Landing at the bottom is the
    // thread opening, not fifty messages arriving, so there is no pill.
    expect(readTop()).toBe(1000);
    expect(screen.queryByText(/new message/)).toBeNull();
  });

  it('counts them, and clears the count when the reader takes it', () => {
    const rows = [row({ id: 'a' })];
    const { container, rerender } = render(<MessageList {...listProps} rows={rows} />);
    const scroller = container.querySelector('.chat-scroller');
    const readTop = makeScrollable(scroller, { scrollTop: 120 });
    fireEvent.scroll(scroller);

    rerender(<MessageList {...listProps} rows={[...rows, row({ id: 'b' }), row({ id: 'c' })]} />);
    expect(screen.getByText('2 new messages')).toBeInTheDocument();

    fireEvent.click(screen.getByText('2 new messages'));
    expect(screen.queryByText(/new message/)).toBeNull();
    expect(readTop()).toBe(1000);
  });

  it('follows the tail on your own send, whatever the reader was doing', () => {
    const rows = [row({ id: 'a' })];
    const { container, rerender } = render(<MessageList {...listProps} rows={rows} />);
    const scroller = container.querySelector('.chat-scroller');
    const readTop = makeScrollable(scroller, { scrollTop: 120 });
    fireEvent.scroll(scroller);

    rerender(
      <MessageList
        {...listProps}
        rows={[...rows, row({ id: 'temp-1', sender: 'You', senderId: 1, pending: true, sentAt: null })]}
      />
    );
    expect(readTop()).toBe(1000);
    expect(screen.queryByText(/new message/)).toBeNull();
  });

  it('does not call an optimistic row settling into its real id a new message', () => {
    const pending = row({ id: 'temp-1', sender: 'Ava', senderId: 2, pending: true });
    const { container, rerender } = render(
      <MessageList {...listProps} rows={[row({ id: 'a' }), pending]} />
    );
    const scroller = container.querySelector('.chat-scroller');
    makeScrollable(scroller, { scrollTop: 120 });
    fireEvent.scroll(scroller);

    rerender(
      <MessageList {...listProps} rows={[row({ id: 'a' }), { ...pending, id: 55, pending: false }]} />
    );
    expect(screen.queryByText(/new message/)).toBeNull();
  });

  it('keeps the reader in place when an older page lands above them', () => {
    const first = [row({ id: 'b' }), row({ id: 'c' })];
    const { container, rerender } = render(<MessageList {...listProps} rows={first} />);
    const scroller = container.querySelector('.chat-scroller');
    // The mount pass stored a height of 0, and the page that just landed
    // makes the box 1000 tall, so the correction is the whole 1000.
    const readTop = makeScrollable(scroller, { scrollTop: 40 });
    rerender(<MessageList {...listProps} rows={[row({ id: 'a' }), ...first]} />);
    expect(readTop()).toBe(1040);
    expect(screen.queryByText(/new message/)).toBeNull();
  });

  it('opens a second thread at its own newest message, not where the last one was', () => {
    /* App.js mounts the chat screen with no key, so a jump from one chat into
       another reuses this component. Without the reset the mount branch is
       skipped, the reader lands on the old offset, and a longer thread raises
       a "new messages" pill for a conversation they have only just opened. */
    const { container, rerender } = render(
      <MessageList {...listProps} threadKey="flock-1" rows={[row({ id: 'a' })]} />
    );
    const scroller = container.querySelector('.chat-scroller');
    const readTop = makeScrollable(scroller, { scrollTop: 120 });
    fireEvent.scroll(scroller);
    expect(readTop()).toBe(120);

    rerender(
      <MessageList
        {...listProps}
        threadKey="flock-2"
        rows={[row({ id: 'x' }), row({ id: 'y' }), row({ id: 'z' })]}
      />
    );
    expect(readTop()).toBe(1000);
    expect(screen.queryByText(/new message/)).toBeNull();
  });

  it('passes the long press and the swipe straight through to the parent', () => {
    const onLongPress = jest.fn();
    render(
      <MessageList {...listProps} rows={[row({ id: 'a', sender: 'Ava' })]} onLongPress={onLongPress} />
    );
    fireEvent.click(screen.getByText("Actions for Ava's message"));
    expect(onLongPress).toHaveBeenCalledTimes(1);
  });
});

/* ═══════════════════════════════════════════════════════════════════════
   8. Copy and colour rules, scanned
   ═══════════════════════════════════════════════════════════════════════ */

describe('the module obeys the standing rules', () => {
  const DIR = path.join(__dirname, '..', 'components', 'chat');

  /* Named, not listed off the directory. `components/chat/` is shared with the
     composer, the sheets and the stream cards, which are other workstreams
     landing in parallel, and a test that asserts on a directory listing goes
     red the moment one of them writes a file. These are the stream's own. */
  const files = [
    'DayDivider.js',
    'MessageGroup.js',
    'MessageList.js',
    'MessageRow.js',
    'StatusLine.js',
    'TypingRow.js',
    'chat.css',
    'groupRows.js',
    'index.js',
  ];

  it('reads the files it thinks it is reading', () => {
    for (const f of files) {
      expect({ file: f, exists: fs.existsSync(path.join(DIR, f)) })
        .toEqual({ file: f, exists: true });
    }
  });

  it('has no em dash anywhere in it, copy or comment', () => {
    for (const f of files) {
      const source = fs.readFileSync(path.join(DIR, f), 'utf8');
      // Escaped, not typed: a literal one in here is an em dash in src/.
      expect({ file: f, hasEmDash: source.includes('\u2014') }).toEqual({ file: f, hasEmDash: false });
    }
  });

  it('hardcodes no colour outside the stylesheet, because every colour is a token or a prop', () => {
    for (const f of files.filter((n) => n.endsWith('.js'))) {
      const source = fs.readFileSync(path.join(DIR, f), 'utf8');
      const hex = source.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
      expect({ file: f, hex }).toEqual({ file: f, hex: [] });
    }
  });

  it('keeps the one fallback hex it does own inside chat.css, in both themes', () => {
    const css = fs.readFileSync(path.join(DIR, 'chat.css'), 'utf8');
    expect(css).toMatch(/:root\s*\{/);
    expect(css).toMatch(/\[data-theme="dark"\]\s*\{/);
    for (const token of ['--chat-quote-bg', '--chat-pill-bg', '--chat-pill-ink', '--chat-pill-shadow']) {
      const dark = css.slice(css.indexOf('[data-theme="dark"]'));
      expect(dark).toContain(token);
    }
  });

  it('respects reduce motion in its own stylesheet, not only the app-wide one', () => {
    const css = fs.readFileSync(path.join(DIR, 'chat.css'), 'utf8');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
  });
});
