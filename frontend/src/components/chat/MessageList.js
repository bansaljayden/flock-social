import React, { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import DayDivider from './DayDivider';
import MessageGroup from './MessageGroup';
import { groupRows } from './groupRows';
import './chat.css';

/**
 * MessageList: the scroller. Bottom anchored, and it never moves the page
 * under a reader who is looking at something else.
 *
 * WHAT THIS REPLACES. The `<div onScroll=...>` in `screens/ChatDetail.js` and
 * its twin in `screens/DmDetail.js`, together with the "Jump to latest" pill
 * they both carry and the `daySeparatorFor` call they both make per row.
 *
 * THE THREE SCROLL RULES, which are the whole reason this is a component and
 * not a div.
 *
 *   1. A message arriving while you are scrolled up does NOT move the page.
 *      It raises a "3 new messages" pill instead. The old screens kept a
 *      hysteresis band in App.js for the same reason and the tail-follow
 *      effect read it; that knowledge moves in here, where the scroll
 *      position actually lives.
 *   2. Your own send always follows the tail, whatever the reader was doing.
 *      Pressing send is a statement that you want to be at the bottom.
 *   3. Loading an older page keeps the reader on the message they were
 *      reading. The rows go on above them and the scroll offset is corrected
 *      by exactly the height that appeared, in a layout effect, before the
 *      browser paints. Without that, "Load earlier messages" throws the reader
 *      to a random point in last Tuesday.
 *
 * IT DOES NOT BLUR THE FIELD ON SCROLL. Both old screens call `blur()` on the
 * focused input inside their scroll handler, which is what makes the keyboard
 * close whenever a message arrives and the list moves. W3 owns the keyboard,
 * and its plan deletes that behaviour. Doing it here would fight it.
 *
 * NOT VIRTUALISED, on purpose, for now. No dependency may be added, and
 * react-virtuoso is the follow-up the plan names if a long thread ever janks.
 * This is written so that swap is a drop-in: rows are grouped by a pure
 * function, every run is a self-contained component that reads only its own
 * props, the scroller owns no per-row state and no per-row refs, and nothing
 * measures a row. Replacing the map below with a Virtuoso `itemContent` is the
 * whole change. Until a real thread on a real phone stutters, a plain
 * container is fewer moving parts and one less thing in the bundle.
 *
 * ONE INSTANCE PER THREAD, and it is told when the thread changes. Everything
 * the scroll rules stand on (have we mounted, what was the first and last id,
 * how tall was the box, how many rows were there) is per conversation, and
 * `App.js` mounts the chat screen with no `key`, so a jump from one chat
 * straight into another reuses this component. Without `threadKey` the second
 * thread inherits the first one's tail: the mount branch is skipped, so the
 * reader lands wherever the old offset put them, and a longer thread raises a
 * "N new messages" pill for a conversation they just opened. The integration
 * pass passes the flock id or the DM id.
 *
 * PROPS
 *   rows          the flat message array, oldest first
 *   threadKey     the flock id or DM id. Changing it resets the scroll state
 *   myId          the viewer's id, for deciding whose run is whose
 *   ownName       what the viewer's own runs are called. Default 'You'
 *   ownColour     the viewer's colour
 *   colours       { [senderId]: colour }, or a Map. Members' colours. A Map's
 *                 keys have to be the same type as the rows' senderId, which
 *                 is a SERIAL integer on both message tables; a plain object
 *                 is forgiving about that and a Map is not
 *   colourFor     (run) => colour. Overrides the two above when given
 *   showNames     draw the name label above each run. Default true
 *   renderCard    (message) => node, for anything this module does not own
 *   renderStatus  (message) => node or null. The parent returns the StatusLine
 *                 for the viewer's last own message and null everywhere else
 *   onLoadOlder   () => void. Absent, no scrollback control is drawn
 *   atTop         the whole thread is loaded, so no scrollback control
 *   olderLoading  a page is on the wire
 *   bottomInset   space under the last row, for the composer and the keyboard
 *   emptyState    node, drawn when there are no rows at all AND nothing is on
 *                 the wire. A thread still loading is not an empty thread
 *   loadingState  node, drawn while the first page is on the wire. Passing it
 *                 suppresses the empty state, so the two can never stack
 *   onLongPress, onSwipeReply, onOpenImage, onQuoteTap, onReactionTap pass
 *   straight through to the rows
 *   now           what "today" means, for the day dividers. Testing seam
 *
 * THE PARENT'S CALLBACKS SHOULD BE STABLE. The runs are memoised and the rows
 * under them are pure, so a socket event that changes nothing visible costs
 * one shallow compare per run instead of a rebuild of the whole thread. That
 * holds only while `renderCard`, `renderStatus` and the five gesture handlers
 * keep their identity between renders, which means `useCallback` in the
 * screen. A handler rebuilt every render re-renders every row in the thread,
 * and typing alone fires several events a second.
 */

const NEAR_BOTTOM_PX = 48;

/* One shared empty array, so a screen that renders before its rows exist does
   not hand the layout effect a new reference on every render. */
const NO_ROWS = [];

function prefersReducedMotion() {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch (err) {
    return false;
  }
}

function scrollToBottom(el, smooth) {
  if (!el) return;
  if (smooth && !prefersReducedMotion() && typeof el.scrollTo === 'function') {
    try {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
      return;
    } catch (err) {
      // Some engines have the method and refuse the options object. Fall
      // through to the assignment, which every one of them honours.
    }
  }
  el.scrollTop = el.scrollHeight;
}

export default function MessageList({
  rows,
  threadKey,
  myId = null,
  ownName = 'You',
  ownColour = 'var(--chat-name-fallback)',
  colours,
  colourFor,
  showNames = true,
  renderCard,
  renderStatus,
  onLoadOlder,
  atTop = false,
  olderLoading = false,
  bottomInset = 0,
  emptyState = null,
  loadingState = null,
  onLongPress,
  onSwipeReply,
  onOpenImage,
  onQuoteTap,
  onReactionTap,
  now,
}) {
  const list = Array.isArray(rows) ? rows : NO_ROWS;
  const scrollerRef = useRef(null);
  const nearBottomRef = useRef(true);
  const mountedRef = useRef(false);
  const prevRef = useRef({ firstId: null, lastId: null, height: 0, count: 0 });
  const [newCount, setNewCount] = useState(0);

  const isMineRow = useCallback((m) => (
    !!m && (m.sender === ownName || (myId != null && m.senderId != null && String(m.senderId) === String(myId)))
  ), [myId, ownName]);

  /* Declared BEFORE the effect below on purpose: layout effects run in
     declaration order, so on the commit that changes the thread this one has
     already wiped the old conversation's tail by the time the scroll rules
     read it. The next pass then takes the mount branch and opens the new
     thread at its newest message. */
  useLayoutEffect(() => {
    mountedRef.current = false;
    prevRef.current = { firstId: null, lastId: null, height: 0, count: 0 };
    nearBottomRef.current = true;
    setNewCount(0);
  }, [threadKey]);

  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const prev = prevRef.current;
    const firstId = list.length ? list[0].id : null;
    const lastRow = list.length ? list[list.length - 1] : null;
    const lastId = lastRow ? lastRow.id : null;

    if (!mountedRef.current) {
      // Opening a thread lands at the newest message with no animation. A
      // chat that scrolls itself down in front of you on entry is a thing
      // nobody asked for.
      mountedRef.current = true;
      scrollToBottom(el, false);
    } else if (list.length > 0) {
      const prepended = prev.firstId != null
        && firstId !== prev.firstId
        && list.some((m) => m.id === prev.firstId);

      if (prev.count === 0) {
        /* The first page landing on an empty list is the thread OPENING, not
           messages arriving. It gets the same instant jump the mount pass
           gets: history is fetched after the first paint, so without this the
           reader watches fifty messages scroll past on entry. */
        scrollToBottom(el, false);
      } else if (prepended) {
        // Rule 3. Correct by the exact height that appeared above.
        const grew = el.scrollHeight - prev.height;
        if (grew > 0) el.scrollTop = el.scrollTop + grew;
      } else if (lastId !== prev.lastId && list.length > prev.count) {
        /* A row landed at the end. Length has to have grown as well as the id
           changed: an optimistic row swapping its temporary id for the
           server's is not a new message, and treating it as one would raise
           a "1 new message" pill for a message the reader wrote. */
        if (isMineRow(lastRow) || nearBottomRef.current) {
          scrollToBottom(el, true);
          /* Following the tail IS catching up, so the pill has nothing left
             to count. Clearing it here rather than waiting for the scroll
             event matters: a programmatic scroll does not always raise one,
             and a pill left behind at the bottom of the thread is a control
             that does nothing. */
          setNewCount(0);
        } else {
          const at = list.findIndex((m) => m.id === prev.lastId);
          const arrived = at >= 0 ? (list.length - 1 - at) : 1;
          setNewCount((c) => c + arrived);
        }
      }
    }

    prevRef.current = { firstId, lastId, height: el.scrollHeight, count: list.length };
  }, [list, isMineRow]);

  const onScroll = (e) => {
    const c = e.currentTarget;
    const fromBottom = c.scrollHeight - c.scrollTop - c.clientHeight;
    const near = fromBottom <= NEAR_BOTTOM_PX;
    nearBottomRef.current = near;
    // Reaching the bottom IS reading them, so the pill has nothing left to say.
    if (near && newCount !== 0) setNewCount(0);
  };

  /* Memoised because the parent re-renders on every socket event the chat
     screen holds state for, and each of those would otherwise rebuild every
     run object in the thread. */
  const runs = useMemo(() => groupRows(list, { myId, ownName, now }), [list, myId, ownName, now]);

  const colourOf = (run) => {
    if (colourFor) return colourFor(run);
    if (run.isMine) return ownColour;
    if (colours) {
      const key = run.senderId;
      const found = typeof colours.get === 'function' ? colours.get(key) : colours[key];
      if (found) return found;
    }
    return 'var(--chat-name-fallback)';
  };

  return (
    <div
      ref={scrollerRef}
      className="chat-scroller"
      onScroll={onScroll}
      style={{
        flex: 1,
        minHeight: 0,
        overflowY: 'auto',
        overflowX: 'hidden',
        background: 'var(--chat-ground)',
        paddingTop: '8px',
        paddingBottom: typeof bottomInset === 'number' ? `${bottomInset}px` : bottomInset,
        overscrollBehaviorY: 'contain',
        WebkitOverflowScrolling: 'touch',
      }}
    >
      {loadingState}

      {onLoadOlder && !atTop && list.length > 0 && (
        <div style={{ textAlign: 'center', padding: '2px 0 10px' }}>
          <button
            type="button"
            className="hit44"
            disabled={olderLoading}
            onClick={() => onLoadOlder()}
            style={{
              padding: '6px 12px',
              borderRadius: '13px',
              border: '1px solid var(--chat-reaction-border)',
              background: 'var(--chat-reaction-bg)',
              color: 'var(--chat-meta)',
              fontSize: 'var(--chat-notice-size)',
              fontWeight: 700,
              letterSpacing: '0.7px',
              textTransform: 'uppercase',
              cursor: olderLoading ? 'default' : 'pointer',
              opacity: olderLoading ? 0.6 : 1,
            }}
          >
            {olderLoading ? 'Loading' : 'Earlier messages'}
          </button>
        </div>
      )}

      {/* A thread still on the wire is not an empty thread. The loading state
          wins outright, so "no messages yet" is never printed over a fetch
          that has not answered. */}
      {list.length === 0 && !loadingState && emptyState}

      {runs.map((run) => (
        <React.Fragment key={`${run.messages[0].id}:${run.key}`}>
          {run.firstOfDay && <DayDivider label={run.dayLabel} />}
          <MessageGroup
            run={run}
            myId={myId}
            colour={colourOf(run)}
            showName={showNames}
            renderCard={renderCard}
            renderStatus={renderStatus}
            onLongPress={onLongPress}
            onSwipeReply={onSwipeReply}
            onOpenImage={onOpenImage}
            onQuoteTap={onQuoteTap}
            onReactionTap={onReactionTap}
          />
        </React.Fragment>
      ))}

      {newCount > 0 && (
        /* Sticky, so it rides the bottom of the viewport without leaving the
           scroller and without a fixed element to position against the
           keyboard. It fades in over 120ms and does nothing else. */
        <div
          className="chat-pill-in"
          style={{
            position: 'sticky',
            bottom: '8px',
            display: 'flex',
            justifyContent: 'center',
            pointerEvents: 'none',
            zIndex: 5,
          }}
        >
          <button
            type="button"
            className="hit44"
            onClick={() => {
              setNewCount(0);
              nearBottomRef.current = true;
              scrollToBottom(scrollerRef.current, true);
            }}
            style={{
              pointerEvents: 'auto',
              padding: '7px 14px',
              borderRadius: '16px',
              border: 'none',
              background: 'var(--chat-pill-bg)',
              color: 'var(--chat-pill-ink)',
              boxShadow: 'var(--chat-pill-shadow)',
              fontSize: '11px',
              fontWeight: 700,
              letterSpacing: '0.4px',
              cursor: 'pointer',
            }}
          >
            {newCount === 1 ? '1 new message' : `${newCount} new messages`}
          </button>
        </div>
      )}
    </div>
  );
}
