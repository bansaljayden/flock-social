/**
 * useBottomAnchor - who decides when the thread scrolls.
 *
 * WHAT THIS IS
 * The scroll half of the chat rebuild's keyboard lane. It owns four things and
 * nothing else: whether the list is at the bottom, how many messages have
 * arrived since it stopped being at the bottom, the jump back down, and the
 * reset when the reader opens a different thread.
 *
 * WHAT IT REPLACES
 * The `onScroll` handler that both `ChatDetail.js` and `DmDetail.js` declare
 * inline, and the tail-follow effect in `App.js` that reads their
 * `chatNearBottomRef` / `dmNearBottomRef`.
 *
 * THE ONE LINE THAT IS DELIBERATELY NOT REPRODUCED
 * Both old handlers open with this:
 *
 *     const el = document.activeElement;
 *     if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) el.blur();
 *
 * It blurs the composer on EVERY scroll event, and a message arriving while
 * the reader is at the bottom scrolls the list, so in practice the keyboard
 * closes itself whenever anyone says anything. That is the single worst thing
 * the current chat does and it is the reason this hook exists. Nothing here
 * touches focus. The only keyboard dismissal in the module is the deliberate
 * downward drag in `useKeyboardComposer`.
 *
 * THE RULE, STATED ONCE
 *   A message you sent always follows: the list goes to the bottom no matter
 *   where the reader was, because you just acted and expect to see the result.
 *   A message someone else sent follows only if the reader is already at the
 *   bottom. Otherwise it counts toward `unseenCount` and the shell shows the
 *   pill. Nothing ever yanks a reader out of scrollback.
 *
 * WHY THE TAIL IS TRACKED BY ID AND NOT BY LENGTH
 * "Load earlier messages" PREPENDS a page, so the array grows by fifty without
 * a single new message at the bottom. A length comparison reads that as fifty
 * arrivals and lights the pill on scrollback the reader asked for. The last
 * row's id is looked up in the new array instead: everything after it is new,
 * and if it is gone entirely (a merge, a moderator hiding a row, or a thread
 * whose new rows land a render after its key) nothing is counted, because a
 * disappearance is not an arrival. A reader who was already at the bottom is
 * put back on the bottom in that case, and a reader in scrollback is not moved.
 *
 * WHAT COUNTS AS YOURS
 * `mapDmRow` and `mapFlockRow` in App.js both set `sender: 'You'` for the
 * viewer's own rows, which is what the default predicate reads. Pass `isOwn`
 * if a surface ever stores it differently.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

/* Inside this many pixels of the end, the reader is reading the newest
   message. Loose enough to survive a half-rendered image resizing the last
   row, tight enough that one screenful of scrollback is not "at the bottom". */
export const AT_BOTTOM_PX = 48;

const defaultIsOwn = (m) => !!m && (m.sender === 'You' || m.isOwn === true);

const prefersReducedMotion = () => {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch (err) {
    return false;
  }
};

export default function useBottomAnchor({
  messages,
  threadKey,
  isOwn = defaultIsOwn,
  atBottomPx = AT_BOTTOM_PX,
} = {}) {
  const [atBottom, setAtBottom] = useState(true);
  const [unseenCount, setUnseenCount] = useState(0);

  const listRef = useRef(null);
  const atBottomRef = useRef(true);
  const unseenRef = useRef(0);
  const lastIdRef = useRef(null);
  const threadRef = useRef(threadKey);

  const rows = Array.isArray(messages) ? messages : [];

  const setAtBottomBoth = useCallback((next) => {
    if (atBottomRef.current === next) return;
    atBottomRef.current = next;
    setAtBottom(next);
  }, []);

  const setUnseenBoth = useCallback((next) => {
    if (unseenRef.current === next) return;
    unseenRef.current = next;
    setUnseenCount(next);
  }, []);

  const scrollToBottom = useCallback((behavior) => {
    const list = listRef.current;
    if (!list) return;
    const smooth = behavior === 'smooth' && !prefersReducedMotion();
    if (smooth && typeof list.scrollTo === 'function') {
      list.scrollTo({ top: list.scrollHeight, behavior: 'smooth' });
    } else {
      list.scrollTop = list.scrollHeight;
    }
  }, []);

  const jumpToBottom = useCallback(() => {
    scrollToBottom('smooth');
    setUnseenBoth(0);
    setAtBottomBoth(true);
  }, [scrollToBottom, setAtBottomBoth, setUnseenBoth]);

  const registerList = useCallback((el) => {
    listRef.current = el || null;
  }, []);

  /**
   * The scroll handler. Note what is missing: nothing here reads or changes
   * `document.activeElement`. See the header.
   */
  const onScroll = useCallback((event) => {
    const list = (event && event.currentTarget) || listRef.current;
    if (!list) return;
    const fromBottom = list.scrollHeight - list.scrollTop - list.clientHeight;
    const next = fromBottom <= atBottomPx;
    setAtBottomBoth(next);
    if (next) setUnseenBoth(0);
  }, [atBottomPx, setAtBottomBoth, setUnseenBoth]);

  /* Thread change. Everything about the previous conversation goes, including
     the unread count, which belonged to a thread the reader has left.

     The tail anchor goes to null and is NOT seeded from `rows`. The parent
     normally flips `threadKey` one render before the new thread's messages
     land, so the array in props here is still the previous conversation's, and
     seeding from it wrote a foreign id: when the real first page arrived the
     arrivals effect could not find that id, took the re-anchor branch, and
     returned without scrolling, so the reader opened the conversation parked at
     the top of the loaded page. Null means the next batch is a first load. */
  useLayoutEffect(() => {
    if (threadRef.current === threadKey) return;
    threadRef.current = threadKey;
    lastIdRef.current = null;
    unseenRef.current = 0;
    atBottomRef.current = true;
    setUnseenCount(0);
    setAtBottom(true);
    scrollToBottom();
  }, [threadKey, scrollToBottom]);

  /* Arrivals. Runs as a layout effect so the scroll lands in the same frame
     the new row is painted, which is what stops the flash of the list sitting
     one row short of the bottom. */
  useLayoutEffect(() => {
    if (threadRef.current !== threadKey) return;

    const previousId = lastIdRef.current;
    const lastRow = rows.length ? rows[rows.length - 1] : null;
    const nextId = lastRow ? lastRow.id : null;

    if (previousId === nextId) {
      lastIdRef.current = nextId;
      return;
    }

    let appended = [];
    let replaced = false;
    if (previousId == null) {
      appended = rows;
    } else {
      const at = rows.findIndex((m) => m && m.id === previousId);
      /* Not found means the array was replaced or a row was removed, not that
         fifty messages arrived. Nothing is counted, because a disappearance is
         not an arrival. */
      if (at === -1) replaced = true;
      else appended = rows.slice(at + 1);
    }
    lastIdRef.current = nextId;

    if (replaced) {
      /* A reader who was at the bottom stays at the bottom. A wholesale
         replacement is what a thread handed over a render late looks like from
         in here, and the alternative is opening a conversation halfway up it.
         A reader in scrollback is left exactly where they are. */
      if (atBottomRef.current) scrollToBottom();
      return;
    }
    if (appended.length === 0) return;

    const mine = isOwn(appended[appended.length - 1]);
    if (mine || atBottomRef.current) {
      scrollToBottom();
      setUnseenBoth(0);
      setAtBottomBoth(true);
      return;
    }

    const fromOthers = appended.filter((m) => !isOwn(m)).length;
    if (fromOthers > 0) setUnseenBoth(unseenRef.current + fromOthers);
  }, [rows, threadKey, isOwn, scrollToBottom, setAtBottomBoth, setUnseenBoth]);

  /* First paint of a thread that mounted with rows already in hand. */
  useEffect(() => {
    scrollToBottom();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    atBottom,
    atBottomRef,
    unseenCount,
    jumpToBottom,
    scrollToBottom,
    registerList,
    onScroll,
  };
}
