/**
 * BIRDIE, THE ASSISTANT PANEL
 *
 * The whole Birdie surface: the backdrop, the panel and fullscreen sheets, the
 * header with its new-chat, expand and close controls, the empty state with
 * the AI disclosure, the transcript with its memory-window line, the venue,
 * draft-flock and vote cards a turn can carry, the typing indicator, the
 * suggestion chips, the composer, and the venue share picker nested inside it.
 * It was 460 lines of App.js, declared inside FlockAppInner as a const holding
 * JSX and rendered once at the root as {aiAssistantModal}.
 *
 * WHY IT MOVED
 *
 * App.js contributes 515,117 of the 605,663 raw bytes in the boot chunk, 85%
 * of it, and FlockAppInner is a single 16,300-line component. Every line of
 * this panel was parsed, compiled and shipped to every visitor on first paint,
 * including the ones who never open Birdie at all.
 *
 * WHY IT CAN BE LAZY, WHICH MOST OF THESE CANNOT
 *
 * aiChatMode starts at 'bubble' and nothing reads a stored value or a URL into
 * it, so the only ways to 'panel' or 'fullscreen' are the Nest's own Birdie
 * section (which shows a thread inline, in 'inline', and opens the full chat), the
 * chat composer's Ask Birdie tile, and the fullscreen toggle once it is already
 * open. There is no first-paint path into this subtree, which makes it a real
 * React.lazy candidate rather than a file split. The guard that decides whether
 * it renders at all stays in App.js, so the chunk is not even requested until
 * somebody asks for Birdie.
 *
 * WHY EVERYTHING ARRIVES AS A PROP
 *
 * The block read 52 names from outside itself. Seven are module imports App.js
 * already pulls from 'react', '../ui/Icons', '../ui/BirdieBird',
 * '../../services/api' and '../../lib/venuePhoto', so this file imports them
 * straight from the source instead of taking them as props. The other 45 are
 * declared in FlockAppInner or at App.js module scope without being exported,
 * and they are the parameter list below. Date is the only other free name the
 * scope walk finds, and it is the global.
 *
 * No parameter carries a default value: a default
 * turns a prop that went missing into a plausible looking wrong value, which
 * is worse than a crash. The names came from a scope walk of the block rather
 * than a read of the page, and the parameter list here and the props object at
 * the call site are the same set, which extractionEquivalence.test.js checks.
 *
 * Thirty of those 45 are the ai* and birdie* state this panel is the sole
 * consumer of. That state deliberately did NOT move. It lives in FlockAppInner,
 * which does not unmount when the panel closes, so a thread in progress, a
 * half-typed question and the free-tier counter all survive closing and
 * reopening Birdie exactly as they did before. sendAiMessage, startNewAiChat,
 * fillAiInput, confirmBirdieDraft and confirmBirdieVoteStage stay there too,
 * because each of them is also reachable from somewhere that is not this panel.
 *
 * AI_CHAT_MAX_MESSAGES and AI_CHAT_MAX_MESSAGE_CHARS arrive as props rather
 * than as a second copy declared here. The backend sizes that route's JSON body
 * parser from the same two numbers, so there must be exactly one place in the
 * client that states them, and App.js is already it.
 *
 * DialogBehavior, formatEventTime and memberCountLabel are props for a duller
 * reason: all three sit at App.js module scope and none of them is exported.
 * colors is a prop for a sharper one. There are two bindings of that name in
 * App.js, a static fallback at module scope for the loading screen and the
 * theme-reactive useMemo inside FlockAppInner that shadows it, and this block
 * read the shadowing one. Importing a colors from anywhere would have taken
 * the wrong one and frozen the panel in light mode.
 *
 * WHAT ELSE CAME WITH THE JSX
 *
 * Two effects, and with the refs the second one keeps they are the only hooks
 * in this file. Both reach into this panel's own DOM through the refs above,
 * and both used to sit in FlockAppInner beside the rest of the Birdie state:
 * one focuses the box when there is already a thread to continue, the other
 * decides where the transcript lands when it changes (WHERE THE THREAD LANDS,
 * below; it pinned to the newest message until 2026-11-03). Neither could stay
 * up there once the panel became lazy. The
 * commit that flips aiChatMode does not contain this subtree on a first open,
 * warm chunk or cold, because React.lazy suspends on the first render of a
 * fresh lazy element even for a module already in the webpack cache, and React
 * flushes the fallback commit's effects before it retries. Both effects guard
 * on a ref that is still null at that moment, so left in FlockAppInner they
 * would have run once, done nothing, and never run again: reopening a live
 * thread would have landed at the top of it with no keyboard. Down here they
 * run on the commit that actually has the input and the end marker in it.
 *
 * aiMsgCountRef is the one name in the parameter list that the JSX itself does
 * not read. It belongs to the scroll effect, and it stays FlockAppInner's ref
 * rather than becoming a local one, so the seen-count survives closing and
 * reopening Birdie exactly as it did when the effect lived up there.
 *
 * The JSX below is a character-for-character copy of the deleted lines,
 * original indentation included, so a diff against the removed block is empty.
 *
 * THREE PRESENTATIONS (2026-11-06). `presentation` is 'panel' (docked over the
 * screen), 'fullscreen' (the sheet) or 'inline': a section of the Nest's own
 * page (components/nest/NestBirdieSection.js), where the answer gets the page
 * instead of the 230px a docked panel left it. Inline draws the consent block,
 * the latest exchange with its cards, a line under the answer saying it can be
 * wrong, and the composer, with no backdrop, sheet, header bar or
 * DialogBehavior; older turns sit behind "Earlier in this chat", which opens
 * the full screen. The venue cards are the same JSX in every presentation.
 */
import { liftNestField, dropNestField } from '../../lib/nestKeyboard';
import React, { useEffect, useRef } from 'react';
import Icons from '../ui/Icons';
import BirdieBird, { BirdieStill, WARM_BIRD } from '../ui/BirdieBird';
import { BASE_URL } from '../../services/api';
import { onVenuePhotoError } from '../../lib/venuePhoto';
import { GoogleMapsMark } from '../ui/GoogleCredit';
import { birdieBackText } from '../../lib/meterResets';
import { venuesByMention } from '../../lib/birdieCardOrder';
import { landingTop, awayFromEnd } from '../../lib/threadLanding';
// A venue's deal on its card, the line a vote option draws too.
import VenueDealLine from '../venue/VenueDealLine';
// How busy a place usually is on the later day an answer is about.
import UsualNightStrip from '../venue/UsualNightStrip';
// What the card's open pill says: right now, later today, or that day.
import { cardOpenPill } from '../../lib/cardOpenPill';
import { isLaterDay } from '../../lib/usualNight';

// The consent question's two answers, drawn the same: neither is the
// filled one (the consent block, below, says why). The warm tertiary well,
// which shows on the card in both themes (1.31:1 light, 1.26:1 dark, where
// --bg-inset is 1.03:1 on a dark card), with ink at 11.2:1 and 9.9:1.
const consentChoice = {
  flex: 1,
  minHeight: '44px',
  padding: '10px',
  borderRadius: '10px',
  border: 'none',
  background: 'var(--bg-tertiary)',
  color: 'var(--text-primary)',
  fontSize: 'var(--t-meta)',
  fontWeight: '600',
};

// When today's free messages come back, in the reader's own clock
// (lib/meterResets.js, shared with the Pro sheet so the two never disagree).
function chirpsBackText(aiResetsAt) {
  return birdieBackText(aiResetsAt);
}

// The thread's own top padding: an answer that lands at the top keeps the gap
// the first message has.
const THREAD_TOP_GAP_PX = 12;

// Where the thread scrolls to put the newest answer's first line at its top,
// or null when that answer is a question, is missing, or fits pinned to the
// end (pinned there, its first line would still be in view). Read off the
// laid-out rows, so the answer's venue cards count toward its height. The
// geometry is lib/threadLanding.js, shared with Roost's chat on the venue
// dashboard, which lands its answers the same way.
function answerTopOf(box, last, index) {
  if (!last || last.role === 'user') return null;
  return landingTop(box, box.querySelector(`[data-birdie-turn="${index}"]`), THREAD_TOP_GAP_PX);
}

export default function BirdiePanel({
  AI_CHAT_MAX_MESSAGES,
  AI_CHAT_MAX_MESSAGE_CHARS,
  DialogBehavior,
  aiChatEndRef,
  aiInputHasText,
  aiInputHasTextRef,
  aiInputRef,
  aiInputValueRef,
  aiMemoryCut,
  aiMessages,
  aiMsgCountRef,
  aiRemaining,
  aiResetsAt,
  aiShareVenue,
  aiSuggestedQuestions,
  aiTyping,
  answerBirdieConsent,
  birdieActionBusy,
  birdieConsentBusy,
  birdieConsentError,
  birdieConsented,
  birdieCorner,
  canSendAi,
  closeAiChat,
  colors,
  confirmBirdieDraft,
  confirmBirdieVoteStage,
  directMessages,
  dmBlocked,
  dmNotConnected,
  entitlements,
  fabDockBottom,
  fillAiInput,
  flocks,
  formatEventTime,
  getPageScroller,
  isAiFullscreen,
  isAiPanel,
  isDark,
  isPro,
  loadTrustedContacts,
  memberCountLabel,
  openExternal,
  openVenueDetail,
  outOfChirps,
  presentation,
  sendAiMessage,
  setAiInputHasText,
  setAiShareVenue,
  setCurrentScreen,
  setCurrentTab,
  setPaywallTrigger,
  setProfileScreen,
  setSelectedDmId,
  setSelectedFlockId,
  setSelectedVenueForCreate,
  startNewAiChat,
  toggleAiFullscreen,
  transmitDm,
  transmitFlockMessage,
}) {
  // Inline is a section of the Nest's page, not a sheet over it.
  const isInline = presentation === 'inline';
  // How wide a venue card may run. In a chat bubble's column, 280px. In the
  // page, the column's own width: 278px cards in a 350px column, aligned
  // left with a ragged right edge, read as unfinished. Only the width of the
  // set is decided here; what is inside a card is the venue card's own.
  const venueCardMax = isInline ? 'none' : '280px';
  // And in the page they are flat, the Nest's own card: no border, no
  // shadow, its 12px radius. In the chat's panel and full screen they keep
  // the sheet's raised card.
  const venueCardSurface = isInline ? { borderRadius: '12px', border: 'none', boxShadow: 'none' } : null;
  // Inline shows the latest exchange: the reader's last question and what
  // came after it. Older turns are a tap away in the full screen.
  let inlineFrom = 0;
  for (let k = aiMessages.length - 1; k >= 0; k -= 1) {
    if (aiMessages[k].role === 'user') { inlineFrom = k; break; }
  }
  // The thread's scroll box, and what the landing effect below knows about
  // it: whether the reader scrolled away from the end on purpose, where it
  // last put the thread itself, and the mode it last landed in.
  const threadRef = useRef(null);
  const readerAwayRef = useRef(false);
  const threadAutoTopRef = useRef(null);
  const threadModeRef = useRef(null);
  // The consent question, inline. When it replaces what had focus (the
  // Nest's field asked by Enter, a suggestion, the strip's pill), focus would
  // fall to the top of the page; it lands on the question instead, without a
  // scroll and without a keyboard (a group, not a field).
  const consentRef = useRef(null);
  useEffect(() => {
    if (!isInline || birdieConsented) return;
    const el = consentRef.current;
    if (!el || typeof document === 'undefined') return;
    const active = document.activeElement;
    if (!active || active === document.body || active.isConnected === false) el.focus({ preventScroll: true });
  }, [isInline, birdieConsented]);

  // Focus the input only when there is already a conversation to continue.
  //
  // ON A REAL DEVICE THIS EFFECT WAS THE WHOLE "BIRDIE DOES NOT OPEN RIGHT"
  // BUG (TestFlight, 2026-09-08). It focused unconditionally 200 ms after the
  // panel appeared, so tapping Birdie raised the keyboard immediately, iOS
  // shifted and scaled the viewport to keep the caret in view, and the panel
  // read as "zooming in" the instant it was tapped.
  //
  // What the keyboard covered is the point: the empty state IS the greeting
  // (see aiMessages, "Birdie himself + prompt chips"). Opening Birdie for the
  // first time showed a keyboard over the one screen that explains what he can
  // do, which is why it looked like it had not popped out properly.
  //
  // Coming back to an existing thread is the opposite case: the greeting is
  // long gone, the person is there to type, and the keyboard is what they
  // want. Hence the length check rather than removing the focus outright.
  //
  // The aiChatMode test the original carried is not dropped, it is the mount:
  // this component renders only while the mode is panel or fullscreen. The two
  // flags stay in the dependency list because expanding the panel to
  // fullscreen is the other thing that used to re-run this, and that happens
  // without a remount.
  //
  // Never inline: on the Nest the box is part of the page, and a keyboard
  // rising by itself after a send would cover the answer it is waiting for.
  useEffect(() => {
    if (!isInline && aiMessages.length > 0
        && aiInputRef.current) {
      setTimeout(() => aiInputRef.current?.focus(), 200);
    }
  }, [isAiPanel, isAiFullscreen]); // eslint-disable-line react-hooks/exhaustive-deps

  // WHERE THE THREAD LANDS WHEN IT CHANGES (2026-11-03).
  //
  // It used to pin to its end on every change. Filming the LionCage demo, an
  // answer came with four venue cards, and pinned to the end the panel showed
  // the last card and nothing of the answer above it: the words Birdie had
  // just said were scrolled out of view as they arrived.
  //
  // Now: your own question pins to the end, with Birdie's typing dots under
  // it. An answer that lands and fits pins to the end too, as before. One that
  // is taller than the thread, words and cards together, lands with its first
  // line at the top (answerTopOf), so it is read from the start, the question
  // just above it and the cards below. And the view never moves for an answer if
  // you scrolled away to read something on purpose (onThreadScroll): it waits
  // where you are, and your next question brings you back down.
  //
  // Opening the panel on a thread, or switching to full screen and back, lands
  // the same way an answer does. A change that adds nothing (a card on an
  // older turn changing state) moves nothing.
  //
  // aiMsgCountRef is still FlockAppInner's ref, so what the reader has
  // already seen survives closing and reopening Birdie. Both refs are named in
  // the dependency list below rather than silenced with a disable. They arrive
  // as props, so the rule cannot know they are stable objects, and naming them
  // costs nothing: a ref identity does not change for the life of
  // FlockAppInner, so this effect still runs exactly when the transcript, the
  // typing indicator or the mode changes.
  //
  // INLINE, THE PAGE IS THE THREAD. A question just asked is scrolled to
  // 12px under the top of the Nest's own scroll box, so the answer arrives in
  // the room below it, never under the strip or the tab bar; the answer itself
  // moves nothing. With no plans on the page, the scroll stops where Start a
  // flock is still on screen (the box's data-nest-keep marker). Under Reduce
  // Motion the move is a jump.
  useEffect(() => {
    if (!isInline) return;
    const seen = aiMsgCountRef.current;
    const count = aiMessages.length;
    aiMsgCountRef.current = count;
    const last = count > 0 ? aiMessages[count - 1] : null;
    if (!(count > seen && last?.role === 'user')) return;
    requestAnimationFrame(() => {
      const box = getPageScroller ? getPageScroller() : null;
      const turn = box && box.querySelector(`[data-birdie-turn="${count - 1}"]`);
      if (!box || !turn) return;
      const boxTop = box.getBoundingClientRect().top;
      let top = box.scrollTop + (turn.getBoundingClientRect().top - boxTop) - 12;
      const keep = box.querySelector('[data-nest-keep]');
      if (keep) top = Math.min(top, box.scrollTop + (keep.getBoundingClientRect().top - boxTop) - 12);
      let still = false;
      try { still = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (_) { still = false; }
      const to = Math.max(0, top);
      if (typeof box.scrollTo === 'function') box.scrollTo({ top: to, behavior: still ? 'auto' : 'smooth' });
      else box.scrollTop = to;
    });
  }, [aiMessages, isInline]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (isInline || !aiChatEndRef.current) return;
    const seen = aiMsgCountRef.current;
    const count = aiMessages.length;
    aiMsgCountRef.current = count;
    const mode = isAiFullscreen ? 'fullscreen' : 'panel';
    const reopened = threadModeRef.current !== mode;
    threadModeRef.current = mode;
    const last = count > 0 ? aiMessages[count - 1] : null;
    const asked = count > seen && last?.role === 'user';
    const answered = count > seen && !!last && last.role !== 'user';
    if (asked) readerAwayRef.current = false;
    if (!asked && !answered && !reopened && !aiTyping && count >= seen) return;
    requestAnimationFrame(() => {
      const box = threadRef.current;
      const end = aiChatEndRef.current;
      if (!box || !end) return;
      if (!asked && readerAwayRef.current) return;
      const top = asked || aiTyping ? null : answerTopOf(box, last, count - 1);
      if (top != null) {
        threadAutoTopRef.current = top;
        box.scrollTop = top;
      } else {
        threadAutoTopRef.current = null;
        end.scrollIntoView({ behavior: 'auto' });
      }
    });
  }, [aiMessages, aiTyping, isAiPanel, isAiFullscreen, isInline, aiChatEndRef, aiMsgCountRef]);

  // The reader's own scrolling: away from the end on purpose, or back at it. A
  // scroll the effect above made lands where it was put and says nothing about
  // the reader, and neither does arriving at the end it pinned to.
  const onThreadScroll = (e) => {
    const box = e.currentTarget;
    const auto = threadAutoTopRef.current;
    if (auto != null && Math.abs(box.scrollTop - auto) <= 2) return;
    threadAutoTopRef.current = null;
    readerAwayRef.current = awayFromEnd(box);
  };

  return (
      <div data-birdie-inline={isInline ? '' : undefined} onClick={isInline ? undefined : (e) => { if (e.target === e.currentTarget) closeAiChat(); }} style={isInline ? undefined : {
        /* Birdie used to follow you across every tab, sitting over 55% of the
           screen with no keyboard way out. It now closes when you navigate
           (see the effect next to aiChatMode) and DialogBehavior below adds
           Escape. The panel keeps pointerEvents 'none' on the backdrop so the
           screen underneath is still usable while it is open. */
        position: 'absolute',
        inset: 0,
        backgroundColor: isAiFullscreen ? 'rgba(0,0,0,0.8)' : 'transparent',
        display: 'flex',
        alignItems: isAiFullscreen ? 'flex-end' : 'flex-end',
        justifyContent: isAiPanel ? 'flex-start' : 'stretch',
        zIndex: 50,
        pointerEvents: isAiPanel ? 'none' : 'auto',
        /* THE KEYBOARD. The WebView does not resize for it (capacitor.config.ts,
           `resize: 'none'`), so Birdie's box was under the keys in both modes.
           Full screen, the sheet is a flex-end child of this backdrop, and
           padding the backdrop by --kb-inset (index.css, written from the
           plugin by hooks/useKeyboardInset.js) raises it and shrinks its 85%
           with it; the input row below adds var(--safe-bottom), which
           --kb-inset has already taken off. The same curve as `.kb-lift`,
           written out because this element has its own transition. */
        paddingBottom: isAiFullscreen ? 'var(--kb-inset, 0px)' : undefined,
        transition: 'background-color 0.3s ease, padding-bottom 250ms cubic-bezier(0.38, 0.7, 0.125, 1)',
      }}>
        <div style={isInline ? undefined : {
          backgroundColor: 'var(--bg-card-solid)',
          borderRadius: isAiFullscreen ? '24px 24px 0 0' : '20px',
          width: isAiFullscreen ? '100%' : 'calc(100% - 24px)',
          maxWidth: isAiPanel ? '360px' : '100%',
          height: isAiFullscreen ? '85%' : '55%',
          /* The docked panel is absolutely positioned, which a backdrop's
             padding cannot move, so it takes the keyboard directly. Its bottom
             edge clears the full --kb-height plus the same 12px gap it keeps
             over the tab bar, because the panel carries no home indicator
             padding of its own. Its height gives way so the top stays on the
             screen: the 72px is the 60px top dock plus that gap. With the
             keyboard down both min() terms resolve to the old 380 and 520 on
             any phone taller than 592px. */
          minHeight: isAiPanel ? 'min(380px, calc(100% - var(--kb-height, 0px) - 72px))' : undefined,
          maxHeight: isAiPanel ? 'min(520px, calc(100% - var(--kb-height, 0px) - 72px))' : undefined,
          display: 'flex',
          flexDirection: 'column',
          position: isAiPanel ? 'absolute' : 'relative',
          bottom: isAiPanel ? (birdieCorner.startsWith('bottom') ? `max(${fabDockBottom}, calc(var(--kb-height, 0px) + 12px))` : undefined) : 0,
          top: isAiPanel ? (birdieCorner.startsWith('top') ? '60px' : undefined) : undefined,
          left: isAiPanel ? (birdieCorner.includes('left') ? '12px' : undefined) : undefined,
          right: isAiPanel ? (birdieCorner.includes('right') ? '12px' : undefined) : undefined,
          boxShadow: isAiPanel ? '0 12px 48px rgba(0,0,0,0.25), 0 4px 16px rgba(0,0,0,0.12)' : 'none',
          border: isAiPanel ? '1px solid var(--border-subtle)' : 'none',
          pointerEvents: 'auto',
          /* Size and place only, on the keyboard's own curve (.kb-lift in
             index.css), so the docked panel rides the keys and a switch to
             full screen moves with them. It was `all` on an overshooting
             spring: the sheet grew past full size and came back. */
          transition: 'width 0.25s cubic-bezier(0.38, 0.7, 0.125, 1), height 0.25s cubic-bezier(0.38, 0.7, 0.125, 1), border-radius 0.25s cubic-bezier(0.38, 0.7, 0.125, 1), bottom 0.25s cubic-bezier(0.38, 0.7, 0.125, 1)',
          animation: 'birdieExpand 0.25s var(--ease-out)',
          overflow: 'hidden',
        }}>
          {!isInline && <DialogBehavior modal={isAiFullscreen} onClose={closeAiChat} label="Birdie" />}
          {/* Header. On the card's own surface with a hairline under it, where
              it was a navy bar: the panel is one sheet, and a coloured band
              across its top made it read as a chat widget bolted onto the
              page. The controls are painted at 32px, 8px apart, so their 44px
              hit boxes (.hit44) no longer overlap one another. Not drawn
              inline: the Nest's section carries its own heading. */}
          {!isInline && (
          <div style={{ padding: isAiPanel ? '10px 12px' : '12px', borderBottom: '1px solid var(--divider)', background: 'var(--bg-card-solid)', borderRadius: isAiFullscreen ? '24px 24px 0 0' : '20px 20px 0 0', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', flexShrink: 0 }}>
            {/* minWidth 0 and a one-line subtitle. The header gained a third
                button, and without these the title block refuses to shrink: at
                320px the tagline wrapped to three lines and pushed the header
                down into a panel that is only 55% of the screen tall. */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0, flex: 1 }}>
              {/* No green "online" dot: Birdie is software, always there, and
                  a presence light is a person's cue. */}
              <div style={{ width: isAiPanel ? '34px' : '40px', height: isAiPanel ? '34px' : '40px', borderRadius: '50%', background: isDark ? '#162046' : '#e8eaf0', overflow: 'hidden', flexShrink: 0 }}>
                <img src={isDark ? "/birdie-avatar.png" : "/birdie-avatar-light.png"} alt="Birdie" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              </div>
              <div style={{ minWidth: 0 }}>
                <h2 style={{ fontFamily: 'var(--font-display)', letterSpacing: '-0.01em', fontSize: 'var(--t-title)', fontWeight: '600', color: 'var(--text-primary)', margin: 0, lineHeight: 1.2 }}>Birdie</h2>
                {/* What Birdie is for, not a promise about tonight: it said
                    "knows what's good tonight" over answers about other days,
                    and it knows nothing for certain (the line under the box
                    says so). */}
                <p style={{ fontSize: 'var(--t-label)', fontWeight: '500', color: 'var(--text-secondary)', margin: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>AI help with places and plans</p>
              </div>
            </div>
            <div style={{ display: 'flex', gap: '8px', flexShrink: 0 }}>
              {/* New chat. The way out of a thread the server will not take,
                  and the only reset there was ever a way to ask for. Shown
                  once there is something to clear, and held closed while a
                  turn is in flight so an outstanding answer cannot land in a
                  thread that no longer has its question. */}
              {aiMessages.length > 0 && (
                <button
                  className="hit44"
                  aria-label="Start a new chat"
                  title="New chat"
                  onClick={startNewAiChat}
                  disabled={aiTyping}
                  style={{ width: '32px', height: '32px', borderRadius: '16px', backgroundColor: 'var(--bg-inset)', border: 'none', color: 'var(--text-primary)', cursor: aiTyping ? 'default' : 'pointer', opacity: aiTyping ? 0.45 : 1, display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'opacity 0.2s ease' }}
                >
                  {Icons.plus('var(--text-primary)', 14)}
                </button>
              )}
              {/* Expand/Collapse toggle */}
              <button aria-label="Toggle full screen" className="hit44" onClick={toggleAiFullscreen} style={{ width: '32px', height: '32px', borderRadius: '16px', backgroundColor: 'var(--bg-inset)', border: 'none', color: 'var(--text-primary)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                {isAiFullscreen ? (
                  <svg aria-hidden="true" focusable="false" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polyline points="4 14 10 14 10 20" /><polyline points="20 10 14 10 14 4" /><line x1="14" y1="10" x2="21" y2="3" /><line x1="3" y1="21" x2="10" y2="14" /></svg>
                ) : (
                  <svg aria-hidden="true" focusable="false" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polyline points="15 3 21 3 21 9" /><polyline points="9 21 3 21 3 15" /><line x1="21" y1="3" x2="14" y2="10" /><line x1="3" y1="21" x2="10" y2="14" /></svg>
                )}
              </button>
              {/* Close */}
              <button aria-label="Close" className="hit44" onClick={closeAiChat} style={{ width: '32px', height: '32px', borderRadius: '16px', backgroundColor: 'var(--bg-inset)', border: 'none', color: 'var(--text-primary)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Icons.x('var(--text-primary)', 14)}</button>
            </div>
          </div>
          )}

          {/* ASKED ONCE, BEFORE THE FIRST MESSAGE. App Store Guideline
              5.1.2(i): personal data goes to a third-party AI only with the
              person's explicit permission, and the line under the bird in the
              empty state told them the assistant is built on Gemini without
              asking. This names the provider and every kind of data a turn can
              carry, in the privacy policy's own terms (its #ai section), and
              nothing reaches Gemini until Allow has landed on the server. The
              thread, the chips, the box and the action row are not mounted
              while it shows (the words in the box survive in aiInputValueRef,
              which the box seeds from when it comes back), sendAiMessage
              returns early, and POST /api/ai/chat refuses on its own. Not now
              closes Birdie and touches nothing else in the app; the question
              comes back the next time Birdie opens. */}
          {!birdieConsented ? (
            <div className={isInline ? undefined : 'birdie-bg'} style={isInline ? { backgroundColor: 'var(--bg-card-solid)', borderRadius: '12px', padding: '16px' } : { flex: 1, padding: '12px', overflowY: 'auto', position: 'relative' }}>
              {/* Inline, the question reads like the page around it: left
                  aligned, where ten centred lines of body text were the
                  centred-stack template. The sheets keep their centred card. */}
              <div ref={consentRef} tabIndex={-1} role="group" aria-labelledby="birdie-consent-title" style={{ position: 'relative', zIndex: 2, display: 'flex', flexDirection: 'column', alignItems: isInline ? 'flex-start' : 'center', gap: '10px', maxWidth: isInline ? 'none' : '320px', margin: '0 auto', padding: '4px 4px 8px', textAlign: isInline ? 'left' : 'center', outline: 'none' }}>
                {/* The still image, not the animated bird: a question is not
                    the place for a rAF loop, and birdBrandMoments.test.js keeps
                    the animated one to the two mounts that greet a chat. */}
                <BirdieStill size={isAiPanel || isInline ? 64 : 96} eager />
                <p id="birdie-consent-title" style={{ fontSize: isAiPanel ? 'var(--t-label)' : 'var(--t-body)', fontWeight: '600', color: 'var(--text-primary)', margin: 0 }}>Before Birdie answers</p>
                <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: 0, lineHeight: 1.5 }}>Birdie runs on Google's Gemini. To answer you, it sends Google your messages to Birdie, your first name, your age range if your account has one, your time zone with the date and time it is there, and what you have open in Flock. If location is on, your area goes too, rounded to about a kilometer. If you ask about your plans or friends, your plans and your friends' names go as well.</p>
                <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: 0, lineHeight: 1.5 }}>Your email, your exact location and your chats with friends are not sent. Answers are generated and can be wrong.</p>
                <button type="button" className="hit44" onClick={() => openExternal('https://www.flockcorp.com/privacy#ai')} style={{ background: 'none', border: 'none', padding: isInline ? '2px 0' : '2px 4px', color: colors.navy, fontSize: 'var(--t-meta)', fontWeight: '600', textDecoration: 'underline', cursor: 'pointer' }}>What Birdie sends, in full</button>
                {birdieConsentError && (
                  <p role="alert" style={{ fontSize: 'var(--t-meta)', color: 'var(--accent-red-text)', fontWeight: '600', margin: 0, lineHeight: 1.4 }}>{birdieConsentError}</p>
                )}
                {/* EQUAL WEIGHT. Allow was the filled navy button and Not now
                    an outline, which leans a person toward sending data to a
                    third-party AI (interface interference, Gray et al. 2018;
                    the ICO Children's Code, standard 13, bars that nudge, and
                    this now renders in the Nest's own page, built to the
                    under-18 standard). Both are the same quiet button, the
                    same size, side by side; the words did not change. */}
                <div style={{ display: 'flex', gap: '8px', width: '100%' }}>
                  <button type="button" className="hit44" onClick={closeAiChat} disabled={birdieConsentBusy} style={{ ...consentChoice, cursor: birdieConsentBusy ? 'default' : 'pointer' }}>Not now</button>
                  <button type="button" className="hit44" onClick={() => answerBirdieConsent(true)} disabled={birdieConsentBusy} style={{ ...consentChoice, cursor: birdieConsentBusy ? 'wait' : 'pointer', opacity: birdieConsentBusy ? 0.6 : 1 }}>{birdieConsentBusy ? 'Saving…' : 'Allow'}</button>
                </div>
                <p style={{ fontSize: 'var(--t-micro)', color: 'var(--text-tertiary)', margin: 0, lineHeight: 1.45 }}>You can turn this off later in You, under Safety and privacy.</p>
              </div>
            </div>
          ) : (<>
          {/* Messages */}
          <div ref={threadRef} onScroll={isInline ? undefined : onThreadScroll} data-birdie-thread="" className={isInline ? undefined : 'birdie-bg'} style={isInline ? undefined : { flex: 1, padding: '12px', overflowY: 'auto', position: 'relative' }}>
            {/* Inline, older turns are one tap away in the full screen. */}
            {isInline && inlineFrom > 0 && (
              <button type="button" onClick={toggleAiFullscreen} style={{ display: 'block', minHeight: '44px', padding: 0, margin: '-8px 0 4px', border: 'none', background: 'none', color: 'var(--accent-purple-text)', fontSize: 'var(--t-label)', fontWeight: '600', cursor: 'pointer' }}>
                Earlier in this chat ({inlineFrom})
              </button>
            )}
            {/* Once the chat starts he steps aside: a whisper behind the
                thread rather than a second thing to read. */}
            {!isInline && aiMessages.length > 0 && (
              <div style={{ position: 'absolute', inset: 0, zIndex: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: isDark ? 0.12 : 0.07, pointerEvents: 'none' }}>
                <BirdieBird size={isAiPanel ? 148 : 200} dark={isDark} />
              </div>
            )}

            {/* Empty state: Birdie, then the greeting, then the chips — one
                stack in normal flow so nothing overlaps him. The greeting is
                in the app's own sentence case and says what to ask about in
                one plain line; it was "hey, it's Birdie." over "where's
                good tonight and how packed it gets. ask away.", lower case on
                a page that is not, ending on a chatbot's sign-off. */}
            {!isInline && aiMessages.length === 0 && (
              <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '10px', padding: '0 16px 12px', pointerEvents: 'none', zIndex: 1 }}>
                <BirdieBird size={isAiPanel ? 120 : 168} dark={isDark} style={{ marginBottom: '2px' }} />
                <p style={{ fontSize: isAiPanel ? 'var(--t-label)' : 'var(--t-body)', fontWeight: '600', color: 'var(--text-primary)', margin: 0, textAlign: 'center' }}>Hi, I'm Birdie.</p>
                <p style={{ fontSize: isAiPanel ? 'var(--t-micro)' : 'var(--t-meta)', color: 'var(--text-secondary)', margin: 0, textAlign: 'center', maxWidth: '260px', lineHeight: 1.5 }}>Ask where to go and how busy it gets.</p>
                {/* THE AI DISCLOSURE, IN THE PRODUCT.
                    Terms sec.7 and the privacy policy both name Google's Gemini
                    and say Birdie's answers are generated and can be wrong, but
                    neither reaches a user who never opens a legal page. An app
                    was rejected by App Review for exactly that gap. This is the
                    one screen a first-time user reads before typing, so it says
                    it here, in the same words as the Terms so the two cannot
                    drift. */}
                <p style={{ fontSize: 'var(--t-micro)', color: 'var(--text-tertiary)', margin: 0, textAlign: 'center', maxWidth: '280px', lineHeight: 1.45 }}>Birdie is an assistant built on Google's Gemini. Its answers are generated and can be wrong.</p>
                {/* No chips while the day's messages are spent: each one sends,
                    and a send that cannot go through is a dead button. */}
                {!outOfChirps && (
                <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', justifyContent: 'center', pointerEvents: 'auto' }}>
                  {aiSuggestedQuestions.slice(0, isAiPanel ? 2 : 4).map((q, i) => (
                    <button className="hit44" key={i} onClick={() => fillAiInput(q.text, { send: true })} style={{ padding: '7px 12px', borderRadius: '16px', border: '1px solid var(--border-subtle)', backgroundColor: 'var(--bg-card-solid)', cursor: 'pointer', fontSize: 'var(--t-meta)', color: colors.navy, fontWeight: '600', display: 'flex', alignItems: 'center', gap: '5px' }}>
                      {q.icon(colors.navy, 12)}
                      {q.text}
                    </button>
                  ))}
                </div>
                )}
              </div>
            )}

            {aiMessages.map((msg, i) => (isInline && i < inlineFrom ? null : (
              <React.Fragment key={i}>
              {/* Where Birdie's memory starts. The server takes the last 24
                  messages and this client sends exactly that, so past 24 the
                  oldest of the thread stop being read. Losing the start of a
                  long conversation without a word is the kind of quiet
                  dishonesty that makes an assistant feel broken instead of
                  bounded, so the boundary is drawn where it actually falls and
                  the transcript above it is still there to scroll. */}
              {/* FUTURE TENSE, DELIBERATELY. aiMemoryCutIndex marks the oldest
                  message that survives the NEXT send, so at exactly 24 messages
                  the line appears while all 24 are still being read. "is out of
                  view" would be false at that moment and true one message
                  later; "drops out on your next question" is true at every
                  length, and it warns before the loss instead of reporting it
                  afterwards. */}
              {aiMemoryCut > 0 && i === aiMemoryCut && (
                <div style={{ position: 'relative', zIndex: 2, margin: '2px 0 12px', paddingTop: '8px', borderTop: '1px solid var(--divider)' }}>
                  <p style={{ margin: 0, fontSize: 'var(--t-micro)', color: 'var(--text-tertiary)', textAlign: 'center', lineHeight: 1.45 }}>
                    Birdie reads the last {AI_CHAT_MAX_MESSAGES} messages. Everything above this line drops out of view on your next question.
                  </p>
                </div>
              )}
              <div data-birdie-turn={i} style={{ display: 'flex', gap: isInline ? '6px' : '8px', marginBottom: isInline ? '14px' : '12px', flexDirection: msg.role === 'user' ? 'row-reverse' : (isInline ? 'column' : 'row'), position: 'relative', zIndex: 2 }}>
                {isInline && msg.role !== 'user' && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <img src={isDark ? "/birdie-avatar.png" : "/birdie-avatar-light.png"} alt="" style={{ width: '22px', height: '22px', borderRadius: '999px', objectFit: 'cover', background: isDark ? '#162046' : '#e8eaf0' }} />
                    <span style={{ fontSize: 'var(--t-label)', fontWeight: '600', color: 'var(--text-primary)' }}>Birdie</span>
                  </div>
                )}
                {!isInline && (
                <div style={{ width: '30px', height: '30px', borderRadius: '15px', background: msg.role === 'user' ? colors.navyBg : isDark ? '#162046' : '#e8eaf0', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, boxShadow: '0 2px 8px rgba(0,0,0,0.1)', overflow: 'hidden', border: msg.role === 'user' ? 'none' : '1.5px solid rgba(45,90,135,0.4)' }}>
                  {msg.role === 'user' ? Icons.user('white', 14) : <img src={isDark ? "/birdie-avatar.png" : "/birdie-avatar-light.png"} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />}
                </div>
                )}
                <div style={{ maxWidth: isInline ? (msg.role === 'user' ? '85%' : '100%') : '78%' }}>
                  <div className="selectable" style={isInline ? (msg.role === 'user'
                    ? { borderRadius: '16px 16px 4px 16px', padding: '10px 14px', fontSize: 'var(--t-body)', lineHeight: '22px', backgroundColor: isDark ? '#1e3a5c' : '#1e293b', color: isDark ? '#f1ede0' : '#ffffff', whiteSpace: 'pre-wrap' }
                    : { fontSize: 'var(--t-body)', fontWeight: '400', lineHeight: '22px', color: 'var(--text-primary)', whiteSpace: 'pre-wrap' })
                    : { borderRadius: '16px', padding: '10px 12px', fontSize: 'var(--t-label)', backgroundColor: msg.role === 'user' ? colors.navyBg : 'var(--bg-tertiary)', color: msg.role === 'user' ? 'white' : colors.navy, borderTopRightRadius: msg.role === 'user' ? '4px' : '16px', borderTopLeftRadius: msg.role === 'user' ? '16px' : '4px', whiteSpace: 'pre-wrap' }}>
                    {msg.text}
                  </div>
                  {/* In the page, the caveat sits right under the answer's
                      words, above its cards: the question lands at the top of
                      the scroll, so the Gemini line over the section is out
                      of view, and the answer is set in the page's own body
                      text. After the cards it was about 700px below the claim
                      it qualifies at 390 with two cards. */}
                  {isInline && msg.role !== 'user' && i === aiMessages.length - 1 && (
                    <p data-birdie-disclosure-inline="" style={{ margin: '6px 0 0', fontSize: 'var(--t-label)', fontWeight: '500', color: 'var(--text-secondary)' }}>Answers are generated and can be wrong.</p>
                  )}
                  {/* Venue Cards from AI */}
                  {/* Navigation button from AI */}
                  {msg.navigate && (
                    <button className="hit44" onClick={() => {
                      const nav = msg.navigate;
                      // 'profile' is the SAME CLASS OF DRIFT as the 'chats'
                      // clamp below, and the server allowlist still admits it
                      // (routes/ai.js pick(toolInput.screen, [...'profile'])).
                      // The You tab is a TAB; there is no 'profile' screen, so
                      // setting it drops the app on a screen renderScreen does
                      // not match, and on Discover that paints a blank content
                      // area because the map is gated on currentScreen 'main'.
                      // Translate it to the tab it means rather than trusting
                      // the model to have sent `tab` as well, which its own
                      // schema says is optional.
                      if (nav.screen === 'profile') {
                        setCurrentTab('profile');
                        setCurrentScreen('main');
                      } else if (nav.screen) setCurrentScreen(nav.screen);
                      else setCurrentScreen('main');
                      // 'chats' was the tab id Birdie's tool contract taught
                      // and no such tab exists (the real id is 'chat'), so
                      // "take me to Messages" landed on the Nest with nothing
                      // selected. The server strings are fixed; this clamp
                      // keeps an already-cached model answer working too.
                      if (nav.tab) setCurrentTab(nav.tab === 'chats' ? 'chat' : nav.tab);
                      if (nav.profile_section === 'safety') { setProfileScreen('safety'); loadTrustedContacts(); }
                      else if (nav.profile_section === 'payment') setProfileScreen('payment');
                      else if (nav.profile_section === 'edit') setProfileScreen('edit');
                      closeAiChat();
                    }} style={{ marginTop: '8px', padding: '10px 16px', borderRadius: '12px', border: 'none', background: '#1e293b', color: 'white', fontSize: 'var(--t-meta)', fontWeight: '600', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px', boxShadow: '0 2px 8px rgba(30,58,92,0.25)' }}>
                      {Icons.arrowRight ? Icons.arrowRight('white', 14) : '→'} Take me there
                    </button>
                  )}
                  {msg.flockDraft && (
                    <div style={{ marginTop: '8px', borderRadius: '14px', border: '1px solid var(--border-default)', background: 'var(--bg-card-solid)', padding: '12px 14px' }}>
                      <p style={{ margin: 0, fontSize: 'var(--t-label)', fontWeight: '700', color: colors.navy }}>{msg.flockDraft.name}</p>
                      <p style={{ margin: '3px 0 0', fontSize: 'var(--t-meta)', color: 'var(--text-secondary)' }}>
                        {msg.flockDraft.event_time ? formatEventTime(msg.flockDraft.event_time) : 'Time still open'}
                        {msg.flockDraft.venue ? ` \u00b7 ${msg.flockDraft.venue.name}` : ''}
                      </p>
                      {/* Nothing exists until this tap: the model only staged
                          the card (routes/ai.js draft_flock, validation only),
                          and this button calls the same create route the
                          create screen calls. */}
                      {/* Once it has started its plan the card opens that plan.
                          It used to stay "Start this flock", and a second tap
                          after reopening Birdie made a second plan. */}
                      {msg.flockDraft.startedFlockId ? (
                        <button className="hit44" onClick={() => { setSelectedFlockId(msg.flockDraft.startedFlockId); setCurrentScreen('chatDetail'); closeAiChat(); }} style={{ marginTop: '10px', width: '100%', padding: '10px', borderRadius: '10px', border: '1px solid var(--border-default)', background: 'transparent', color: colors.navy, fontSize: 'var(--t-meta)', fontWeight: '600', cursor: 'pointer' }}>
                          Started. Open it
                        </button>
                      ) : (
                        <button className="hit44" disabled={birdieActionBusy} onClick={() => confirmBirdieDraft(msg.flockDraft)} style={{ marginTop: '10px', width: '100%', padding: '10px', borderRadius: '10px', border: 'none', background: '#1e293b', color: 'white', fontSize: 'var(--t-meta)', fontWeight: '600', cursor: birdieActionBusy ? 'wait' : 'pointer', opacity: birdieActionBusy ? 0.6 : 1 }}>
                          {birdieActionBusy ? 'Starting\u2026' : 'Start this flock'}
                        </button>
                      )}
                    </div>
                  )}
                  {msg.voteStage && (
                    <div style={{ marginTop: '8px', borderRadius: '14px', border: '1px solid var(--border-default)', background: 'var(--bg-card-solid)', padding: '12px 14px' }}>
                      <p style={{ margin: 0, fontSize: 'var(--t-label)', fontWeight: '700', color: colors.navy }}>{msg.voteStage.venue.name}</p>
                      <p style={{ margin: '3px 0 0', fontSize: 'var(--t-meta)', color: 'var(--text-secondary)' }}>Your vote in {msg.voteStage.flock_name} goes to this spot. One vote each, so it replaces any vote you already cast there.</p>
                      <button className="hit44" disabled={birdieActionBusy} onClick={() => confirmBirdieVoteStage(msg.voteStage)} style={{ marginTop: '10px', width: '100%', padding: '10px', borderRadius: '10px', border: 'none', background: '#1e293b', color: 'white', fontSize: 'var(--t-meta)', fontWeight: '600', cursor: birdieActionBusy ? 'wait' : 'pointer', opacity: birdieActionBusy ? 0.6 : 1 }}>
                        {birdieActionBusy ? 'Voting\u2026' : 'Vote for it'}
                      </button>
                    </div>
                  )}
                  {msg.venues && msg.venues.length > 0 && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginTop: '8px' }}>
                      {venuesByMention(msg.venues, msg.text).map((v, vi) => {
                        // Real crowd data only. When Birdie hasn't checked this
                        // venue, the card simply has no crowd row; a number
                        // derived from the venue's name is a lie, not a design.
                        const crowd = typeof v.crowd === 'number' ? v.crowd : null;
                        const crowdColor = crowd == null ? null : crowd > 84 ? 'var(--accent-red-text)' : crowd > 39 ? '#B45309' : 'var(--accent-green-text)';
                        const crowdBar = crowd == null ? null : crowd > 84 ? '#EF4444' : crowd > 39 ? '#F59E0B' : '#22C55E';
                        // photo_url is a proxy ref path from the backend — the
                        // old place-id URL never resolved (proxy takes ?ref=).
                        const photoUrl = v.photo_url ? `${BASE_URL}${v.photo_url}` : null;
                        // "Open", "Opens 5 PM", "Closed", nothing about now
                        // on a card about another day (lib/cardOpenPill.js).
                        const pill = cardOpenPill(v);
                        const pillBg = pill && (pill.tone === 'open' ? 'var(--accent-green-bg)' : pill.tone === 'later' ? 'var(--accent-amber-bg)' : 'var(--accent-red-bg)');
                        const pillInk = pill && (pill.tone === 'open' ? 'var(--accent-green-text)' : pill.tone === 'later' ? 'var(--accent-amber-text)' : 'var(--accent-red-text)');
                        return (
                        <div key={vi} style={{ borderRadius: '14px', border: '1px solid var(--border-default)', backgroundColor: 'var(--bg-card-solid)', overflow: 'hidden', boxShadow: 'var(--card-shadow-sm, 0 1px 3px rgba(0,0,0,0.05))', maxWidth: venueCardMax, animation: `fadeSlideIn 0.35s ease-out ${vi * 0.08}s both`, ...venueCardSurface }}>
                          {photoUrl && (
                            <img src={photoUrl} alt="" loading="lazy" style={{ width: '100%', height: '120px', objectFit: 'cover', display: 'block' }} onError={onVenuePhotoError} />
                          )}

                          <div style={{ padding: '12px' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '8px' }}>
                              <h4 style={{ fontSize: 'var(--t-body)', fontWeight: '600', color: 'var(--text-primary)', margin: 0, lineHeight: 1.25 }}>{v.name}</h4>
                              {pill && (
                                <span data-open-pill={pill.tone} style={{ fontSize: 'var(--t-meta)', fontWeight: '500', padding: '2px 7px', borderRadius: '999px', backgroundColor: pillBg, color: pillInk, flexShrink: 0, whiteSpace: 'nowrap' }}>{pill.text}</span>
                              )}
                            </div>

                            {/* One meta line: price · rating · street */}
                            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '4px', minWidth: 0 }}>
                              {v.price_level > 0 && <span style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', fontWeight: '500', flexShrink: 0 }}>{'$'.repeat(v.price_level)}</span>}
                              {v.rating && (
                                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '3px', fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', fontWeight: '500', flexShrink: 0 }}>
                                  {Icons.starFilled('#d97706', 12)}{v.rating}
                                </span>
                              )}
                              {v.address && (
                                <span style={{ fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v.address.split(',')[0]}</span>
                              )}
                            </div>

                            {/* The venue's deal, the one its page leads with for
                                this person (the server's choice, per person),
                                drawn the way a vote option draws it. */}
                            {v.deal && <VenueDealLine deal={v.deal} iconColor={colors.steel} style={{ marginTop: '6px' }} />}

                            {/* A LATER DAY (backend routes/ai.js): asked about
                                another day, the card has no number for now and
                                carries how busy the place usually is that
                                weekday instead, as one line with its bars. A
                                live number, when there is one, keeps its row. */}
                            {crowd == null && v.usual && <UsualNightStrip usual={v.usual} style={{ marginTop: '10px' }} />}

                            {/* Crowd row — only when Birdie actually checked */}
                            {crowd != null && (
                              <div style={{ marginTop: '10px' }}>
                                <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: '4px' }}>
                                  {/* Whose hour the number is, on a card about another
                                      day (the server sends none there, THE CARDS OF A
                                      LATER DAY): "Steady" under an answer about the
                                      13th would read as the 13th's crowd. */}
                                  <span style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', fontWeight: '500' }}>{isLaterDay(v.for_date) ? (v.crowd_label ? `Right now · ${v.crowd_label}` : 'Crowd right now') : (v.crowd_label || 'Crowd right now')}</span>
                                  <span style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: crowdColor }}>{crowd}%</span>
                                </div>
                                <div style={{ width: '100%', height: '4px', backgroundColor: 'var(--bg-tertiary)', borderRadius: '2px', overflow: 'hidden' }}>
                                  <div style={{ height: '100%', width: `${crowd}%`, backgroundColor: crowdBar, borderRadius: '2px', transition: 'width 0.5s cubic-bezier(0.22,1,0.36,1)' }} />
                                </div>
                              </div>
                            )}

                            <div style={{ display: 'flex', gap: '6px', marginTop: '12px' }}>
                              {v.place_id && (
                                <button className="hit44 fab-press" onClick={() => {
                                  // The day the answer is about rides along, so
                                  // the sheet titles its bars Today and draws
                                  // that day's usual night over them.
                                  openVenueDetail(v.place_id, { name: v.name, formatted_address: v.address, place_id: v.place_id, rating: v.rating, ...(v.usual ? { planDay: { date: v.usual.date, usual: v.usual } } : {}) });
                                }} style={{ flex: 1, padding: '9px', borderRadius: '10px', border: '1px solid var(--border-default)', backgroundColor: 'transparent', color: 'var(--text-primary)', fontSize: 'var(--t-meta)', fontWeight: '600', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '5px' }}>
                                  Details
                                </button>
                              )}
                              <button className="hit44 fab-press" onClick={() => setAiShareVenue(v)} style={{ flex: 1, padding: '9px', borderRadius: '10px', border: 'none', background: colors.navyBg, color: 'white', fontSize: 'var(--t-meta)', fontWeight: '600', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '5px' }}>
                                {Icons.send('white', 12)} Share
                              </button>
                            </div>
                          </div>
                        </div>
                        );
                      })}
                      {/* These cards are Google Maps data, so the set ends on
                          Google's attribution (components/ui/GoogleCredit.js).
                          No per-photo credit: the cards' photos are thumbnails
                          and Details opens the venue sheet, which credits its
                          photo in full. The credit is also kept out of what
                          Birdie's model reads, since a display name is anybody's
                          text. */}
                      <div style={{ display: 'flex', justifyContent: 'flex-end', maxWidth: venueCardMax }}>
                        <GoogleMapsMark />
                      </div>
                    </div>
                  )}
                </div>
              </div>
              </React.Fragment>
            )))}

            {/* WHILE AN ANSWER IS ON ITS WAY: the still bird and what is
                happening, in words. Three bouncing dots were a person typing,
                and Birdie is not a person: a human-presence cue raises what
                people expect of a bot and costs more when it is wrong. The
                line is true for as long as it shows, and a screen reader
                hears it once. */}
            {aiTyping && (
              <div data-birdie-working="" role="status" aria-live="polite" style={{ display: 'flex', alignItems: 'center', gap: '8px', position: 'relative', zIndex: 1 }}>
                <BirdieStill size={40} eager />
                <span style={{ fontSize: 'var(--t-label)', fontWeight: '500', color: 'var(--text-secondary)' }}>Working on your answer</span>
              </div>
            )}
            <div ref={aiChatEndRef} />
          </div>

          {/* Suggested Questions — mid-conversation only; the empty state
              carries its own chips under the bird */}
          {!isInline && !aiTyping && aiMessages.length > 0 && !outOfChirps && (
            <div style={{ padding: isAiPanel ? '6px 10px' : '8px 12px', borderTop: '1px solid var(--divider)', backgroundColor: 'var(--bg-tertiary)', flexShrink: 0 }}>
              {isAiFullscreen && <p style={{ fontSize: 'var(--t-label)', fontWeight: '600', color: 'var(--text-secondary)', margin: '0 0 6px' }}>Try asking</p>}
              <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                {(isAiPanel ? aiSuggestedQuestions.slice(0, 2) : aiSuggestedQuestions).map((q, i) => (
                  <button className="hit44" key={i} onClick={() => fillAiInput(q.text, { send: true })} style={{ padding: isAiPanel ? '5px 8px' : '6px 10px', borderRadius: '16px', border: '1px solid var(--border-subtle)', backgroundColor: 'var(--bg-card-solid)', cursor: 'pointer', fontSize: isAiPanel ? 'var(--t-micro)' : 'var(--t-micro)', color: colors.navy, fontWeight: '500', display: 'flex', alignItems: 'center', gap: '4px' }}>
                    {q.icon(colors.navy, isAiPanel ? 10 : 12)}
                    {q.text}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Input. Full screen, this row is the bottom of a sheet that runs to
              the bottom of the phone, so it carries the home indicator strip
              (SAFE-AREA rule 1); the docked panel floats above the tab bar and
              does not touch it. In the sheets the box is one warm tint, the
              way the bubbles are, with no border and no shadow: it carried
              all three, in a cool grey, under a shadow that grew as you typed,
              off the flat warm cards the Nest one tap back is made of. */}
          <div data-nest-birdie-field={isInline ? '' : undefined} style={isInline ? { marginTop: '10px' } : { padding: isAiFullscreen ? '8px 12px calc(10px + var(--safe-bottom))' : '8px 12px 10px', backgroundColor: 'var(--bg-card-solid)' }}>
            <div style={isInline ? { borderRadius: '12px', backgroundColor: 'var(--bg-card-solid)', padding: '4px 4px 4px 6px' } : { borderRadius: '20px', backgroundColor: 'var(--bg-tertiary)', padding: '6px' }}>
              {/* Text input row */}
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: '0', padding: '0 2px 0 10px' }}>
                {/* maxLength is the server's own per-message ceiling. Without
                    it a pasted essay 400'd as "Message too long", stayed in the
                    transcript, and then failed EVERY later send in the thread,
                    because the cap applies to the history too. */}
                {/* defaultValue off the ref, not a literal empty string. This
                    box is uncontrolled and aiInputValueRef holds the typed
                    text of record, so a mount that hard-coded "" would blank
                    the visible box while sendAiMessage still held the words
                    and the send button stayed lit over it. That desync is the
                    one the ref pair exists to prevent, and the panel now has
                    two ways to be mounted a second time with words still in
                    the ref: reopening after closing without sending, and a
                    re-armed chunk while it is open. Seeding off the ref reads
                    "" in every other case, because both senders clear it. */}
                <input aria-label="Ask Birdie" enterKeyHint="send" ref={aiInputRef} onFocus={isInline ? liftNestField : undefined} onBlur={isInline ? dropNestField : undefined} type="text" defaultValue={aiInputValueRef.current || ''} maxLength={AI_CHAT_MAX_MESSAGE_CHARS} onInput={(e) => { aiInputValueRef.current = e.target.value; const has = !!e.target.value; if (has !== aiInputHasTextRef.current) { aiInputHasTextRef.current = has; setAiInputHasText(has); } }} onKeyDown={(e) => e.key === 'Enter' && sendAiMessage()} placeholder={isInline ? 'Ask a follow-up' : 'Ask about a place or a night out'} style={{ flex: 1, padding: '11px 0', backgroundColor: 'transparent', color: 'var(--text-primary)', border: 'none', fontSize: 'var(--t-body)', outline: 'none', fontWeight: '500', lineHeight: '1.4' }} autoComplete="off" />
                {/* `!aiInputHasText && !aiTyping` left this ENABLED for the
                    whole time Birdie was answering, including over an empty
                    box, where pressing it did nothing; and it was drawn at 0.4
                    opacity the entire time, so it looked disabled and was not.
                    One value now drives both the look and the behaviour. */}
                <button aria-label="Send" className="hit44" onClick={sendAiMessage} disabled={!canSendAi} style={{ width: '34px', height: '34px', minWidth: '34px', borderRadius: '17px', border: 'none', background: canSendAi ? '#1e293b' : 'transparent', color: 'white', cursor: canSendAi ? 'pointer' : 'default', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'background-color 0.15s ease, opacity 0.15s ease', opacity: canSendAi ? 1 : 0.4 }}>
                  <svg aria-hidden="true" focusable="false" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="12" y1="19" x2="12" y2="5" /><polyline points="5 12 12 5 19 12" />
                  </svg>
                </button>
              </div>
              {/* OUT OF CHIRPS: say so, say when they come back, and offer the
                  one thing that lifts it. The three shortcuts below each fill
                  and send, so they give way while nothing can be sent. */}
              {outOfChirps ? (
                <div role="status" style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 4px 2px 10px', borderTop: '1px solid var(--border-subtle)', marginTop: '4px' }}>
                  <p style={{ flex: 1, minWidth: 0, margin: 0, fontSize: 'var(--t-meta)', fontWeight: '500', color: 'var(--text-secondary)', lineHeight: 1.4 }}>
                    {Number.isFinite(entitlements?.birdie?.limit) ? `You've used today's ${entitlements.birdie.limit} messages.` : "You've used today's messages."} They come back {chirpsBackText(aiResetsAt)}.
                  </p>
                  {(process.env.REACT_APP_PURCHASES !== 'off') && <button type="button" className="hit44 glass-btn glass-primary" onClick={() => setPaywallTrigger('birdie')} style={{ padding: '8px 12px', borderRadius: '12px', fontSize: 'var(--t-meta)', fontWeight: '700', whiteSpace: 'nowrap', flexShrink: 0 }}>
                    Get Flock Pro
                  </button>}
                </div>
              ) : isInline ? null : (
              /* Action buttons row. Labels never wrap ("My Flocks" broke onto
                 two lines at 390px), and the line on the right drops to its
                 own row under the buttons instead of squeezing beside them. */
              <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '2px', padding: '2px 4px 0', borderTop: '1px solid var(--border-subtle)', marginTop: '4px', paddingTop: '6px' }}>
                {[
                  { icon: Icons.search, label: 'Search', prefix: 'Find me ', color: 'var(--accent-steel, #2d5a87)' },
                  { icon: Icons.mapPin, label: 'Crowds', prefix: 'How busy is ', color: 'var(--accent-steel, #2d5a87)' },
                  { icon: Icons.users, label: 'My Flocks', prefix: 'What are my upcoming plans?', color: 'var(--accent-steel, #2d5a87)' },
                ].map((action, i) => (
                  <button key={i} className="hit44 fab-press" onClick={() => fillAiInput(action.prefix, { send: action.prefix.endsWith('?') })} style={{ display: 'flex', alignItems: 'center', gap: '4px', padding: '4px 10px', borderRadius: '12px', border: 'none', backgroundColor: 'transparent', cursor: 'pointer', transition: 'all 0.25s ease', fontSize: 'var(--t-meta)', fontWeight: '600', color: 'var(--text-tertiary)', whiteSpace: 'nowrap' }}
                  onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'rgba(45,90,135,0.08)'; e.currentTarget.style.color = action.color; }}
                  onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; e.currentTarget.style.color = 'var(--text-tertiary)'; }}
                  >
                    {action.icon('currentColor', 13)}
                    <span>{action.label}</span>
                  </button>
                ))}
                <div style={{ flex: 1 }} />
                {/* Free-tier meter surfaces only when it's about to matter.
                    The else branch is the AI disclosure: "Birdie AI" alone is a
                    label, not a disclosure, and this is the only line rendered
                    under EVERY turn, so it carries the generated-output caveat
                    for anyone who scrolled past the empty state. At full
                    strength: it sat at 0.6 opacity in tertiary ink, 2.48:1 on
                    white, the one sentence about trusting the answers drawn
                    as the faintest text on the sheet. Secondary ink at 13px
                    reads 6.2:1 in light and 8.3:1 in dark. */}
                {entitlements?.paywallEnabled && !isPro && aiRemaining != null && aiRemaining <= 5 ? (
                  <span style={{ flexBasis: '100%', padding: '2px 10px 0', fontSize: 'var(--t-meta)', color: aiRemaining === 0 ? 'var(--accent-red-text)' : 'var(--text-tertiary)', fontWeight: '500' }}>
                    {aiRemaining === 0 ? (aiResetsAt ? `Out of chirps until ${new Date(aiResetsAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : 'Out of chirps today') : `${aiRemaining} chirp${aiRemaining === 1 ? '' : 's'} left today`}
                  </span>
                ) : aiMessages.length > 0 ? (
                  /* Once there is an answer. Before one, the empty state's
                     own sentence says it in the Terms' words, and this line
                     under it said it a second time on one screen. */
                  <span data-birdie-disclosure="" style={{ flexBasis: '100%', padding: '2px 10px 0', fontSize: 'var(--t-label)', color: 'var(--text-secondary)', fontWeight: '500' }}>Answers are generated and can be wrong.</span>
                ) : null}
              </div>
              )}
            </div>
          </div>
          {isInline && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '20px', marginTop: '4px' }}>
              <button type="button" className="hit44" onClick={toggleAiFullscreen} style={{ minHeight: '44px', padding: 0, border: 'none', background: 'none', color: 'var(--accent-purple-text)', fontSize: 'var(--t-label)', fontWeight: '600', cursor: 'pointer' }}>Open the full chat</button>
              <button type="button" className="hit44" onClick={closeAiChat} style={{ minHeight: '44px', padding: 0, border: 'none', background: 'none', color: 'var(--accent-purple-text)', fontSize: 'var(--t-label)', fontWeight: '600', cursor: 'pointer' }}>Done</button>
            </div>
          )}
          </>)}

          {/* Venue Share Picker.
              IT SIZES ITSELF (S18, 2026-11-06). It was held to 60% of the
              panel, and at the panel's smallest (380px) that left about 180px
              for an empty state that needs about 230: "Start a flock here",
              its one way forward, was cut in half by the panel's edge. It may
              now take the panel's height less a strip of the dimmed answer
              above it, and its body scrolls when a long list needs more.
              INLINE, in the Nest's page, it is one sheet over the whole page
              (the nearest positioned box is the screen), rising from the
              bottom with a grabber, and never taller than the screen under
              the status bar, so Start a flock here is never cut off.
              SENT TO A FRIEND. Below the flocks (or the empty state), the
              people this account already has a conversation with: a tap sends
              the venue's card into that DM over the same reconciled path the
              DM screen sends on (transmitDm: the optimistic bubble, the
              socket or REST, a failed state with tap-to-retry) and opens it. */}
          {aiShareVenue && (() => {
            // The people this account already messages, newest first as the
            // Messages tab lists them, at most five. Not a pair the server
            // refuses to carry (a block either way, or two accounts that are
            // not connected): a tap there sent the card into a thread that
            // could only come back refused.
            const refused = (map, id) => Boolean(map && (map[String(id)] || map[id]));
            const shareFriends = aiShareVenue._shareToDm ? [] : (Array.isArray(directMessages) ? directMessages : [])
              .filter((d) => d && d.userId != null && typeof d.name === 'string' && d.name.trim())
              .filter((d) => !refused(dmBlocked, d.userId) && !refused(dmNotConnected, d.userId))
              .slice(0, 5);
            return (
            <div onClick={(e) => { if (e.target === e.currentTarget) setAiShareVenue(null); }} style={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'flex-end', zIndex: 60, borderRadius: isInline ? 0 : '24px 24px 0 0' }}>
              <DialogBehavior onClose={() => setAiShareVenue(null)} label="Share this venue" />
              <div data-share-sheet className={isInline ? 'sheet-rise' : undefined} style={{ backgroundColor: 'var(--bg-card-solid)', borderRadius: '20px 20px 0 0', width: '100%', maxHeight: isInline ? 'calc(100% - var(--safe-top) - 24px)' : 'calc(100% - 16px)', minHeight: 0, display: 'flex', flexDirection: 'column', paddingBottom: isInline ? 'var(--safe-bottom)' : undefined }}>
                {isInline && <div aria-hidden="true" style={{ width: '36px', height: '5px', borderRadius: '999px', backgroundColor: 'var(--border-mid)', margin: '8px auto 0', flexShrink: 0 }} />}
                <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--divider)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <h3 style={{ fontSize: 'var(--t-title)', fontWeight: '700', color: 'var(--text-primary)', margin: 0 }}>
                      Send {aiShareVenue.name}
                    </h3>
                    <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: '2px 0 0' }}>
                      {aiShareVenue._shareToDm ? 'Choose a friend' : shareFriends.length ? 'Choose a flock or a friend' : 'Choose a flock'}
                    </p>
                  </div>
                  <button aria-label="Close" className="hit44" onClick={() => setAiShareVenue(null)} style={{ width: '28px', height: '28px', borderRadius: '14px', backgroundColor: 'var(--bg-hover)', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Icons.x('var(--text-secondary)', 14)}</button>
                </div>
                <div style={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto', padding: '8px' }}>
                  {aiShareVenue._shareToDm ? (
                    /* DM — navigate to DM tab with venue in clipboard */
                    <div style={{ padding: '20px', textAlign: 'center' }}>
                      <p style={{ fontSize: 'var(--t-label)', color: 'var(--text-secondary)', marginBottom: '12px' }}>Open your DMs to share <strong>{aiShareVenue.name}</strong></p>
                      <button className="hit44" onClick={() => {
                        setAiShareVenue(null);
                        closeAiChat();
                        setCurrentTab('chat');
                        setCurrentScreen('main');
                      }} style={{ padding: '10px 24px', borderRadius: '12px', border: 'none', background: '#1e293b', color: 'white', fontWeight: '600', fontSize: 'var(--t-label)', cursor: 'pointer' }}>
                        Go to DMs
                      </button>
                    </div>
                  ) : (
                    /* Flocks list. This filtered on status 'active', which the
                       client never produces (getFlocks maps the server's
                       'planning' to 'voting'), so the sheet was always empty. */
                    (() => {
                      const shareable = flocks.filter(f => f.status !== 'completed' && f.status !== 'cancelled');
                      // Birdie's venue-card sender, the third one in the file.
                      // It used to post straight to apiSendMessage inside
                      // `try { } catch {}`, so a refusal (rate limit,
                      // moderation, no signal) was swallowed whole and the user
                      // was walked into a chat with no card in it and nothing
                      // said. It takes the same reconciled path the in-chat
                      // share does now, which gives it the optimistic bubble,
                      // the socket transport, and a failed state with
                      // tap-to-retry.
                      return shareable.length > 0 ? shareable.map(f => (
                      <button className="hit44" key={f.id} onClick={() => {
                        const venueData = { name: aiShareVenue.name, addr: aiShareVenue.address, stars: aiShareVenue.rating, rating: aiShareVenue.rating, price_level: aiShareVenue.price_level, place_id: aiShareVenue.place_id };
                        transmitFlockMessage(f.id, `Check out ${aiShareVenue.name}!`, { message_type: 'venue_card', venue_data: venueData });
                        setAiShareVenue(null);
                        closeAiChat();
                        setSelectedFlockId(f.id);
                        setCurrentScreen('chatDetail');
                      }} style={{ width: '100%', padding: '10px 12px', borderRadius: '10px', border: 'none', backgroundColor: 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '10px', textAlign: 'left' }}>
                        <div style={{ width: '36px', height: '36px', borderRadius: '10px', backgroundColor: colors.navyBg, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                          {Icons.users('white', 16)}
                        </div>
                        <div style={{ minWidth: 0 }}>
                          <span style={{ fontSize: 'var(--t-label)', fontWeight: '600', color: 'var(--text-primary)', display: 'block' }}>{f.title || f.name}</span>
                          <span style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)' }}>{memberCountLabel(f)}{f.time && f.time !== 'TBD' ? ` · ${f.time}` : ''}</span>
                        </div>
                      </button>
                      )) : (
                        <div data-share-empty style={{ padding: '14px 16px 12px', textAlign: 'center' }}>
                          <BirdieStill bird={WARM_BIRD} size={56} style={{ margin: '0 auto 8px' }} />
                          <p style={{ fontSize: 'var(--t-label)', fontWeight: '600', color: 'var(--text-primary)', margin: '0 0 4px' }}>No flocks to send this to yet</p>
                          <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: '0 0 12px' }}>Start a flock and this venue can go straight into the chat.</p>
                          <button className="hit44" onClick={() => { setAiShareVenue(null); closeAiChat(); setSelectedVenueForCreate({ name: aiShareVenue.name, addr: aiShareVenue.address, rating: aiShareVenue.rating, price_level: aiShareVenue.price_level, place_id: aiShareVenue.place_id }); setCurrentScreen('create'); }} style={{ padding: '10px 20px', borderRadius: '12px', border: 'none', background: colors.navyMidBg, color: 'white', fontWeight: '600', fontSize: 'var(--t-label)', cursor: 'pointer' }}>
                            Start a flock here
                          </button>
                        </div>
                      );
                    })()
                  )}
                  {!aiShareVenue._shareToDm && (() => {
                    const friends = shareFriends;
                    if (!friends.length) return null;
                    return (
                      <div data-share-friends style={{ borderTop: '1px solid var(--divider)', marginTop: '4px', paddingTop: '6px' }}>
                        <p style={{ fontSize: 'var(--t-meta)', fontWeight: '600', color: 'var(--text-secondary)', margin: '4px 12px 2px' }}>Or send it to a friend</p>
                        {friends.map((d) => (
                          <button className="hit44" key={`dm-${d.userId}`} onClick={() => {
                            const venueData = { name: aiShareVenue.name, addr: aiShareVenue.address, stars: aiShareVenue.rating, rating: aiShareVenue.rating, price_level: aiShareVenue.price_level, place_id: aiShareVenue.place_id };
                            transmitDm(d.userId, { text: `Check out ${aiShareVenue.name}!`, message_type: 'venue_card', venue_data: venueData, image_url: null, reply_to_id: null, reply_to: null });
                            setAiShareVenue(null);
                            closeAiChat();
                            setSelectedDmId(d.userId);
                            setCurrentScreen('dmDetail');
                          }} style={{ width: '100%', padding: '8px 12px', borderRadius: '10px', border: 'none', backgroundColor: 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '10px', textAlign: 'left' }}>
                            {/* Their photo, as the Messages tab draws it, over
                                the initial, which shows when there is none or
                                it will not load. */}
                            <div aria-hidden="true" style={{ position: 'relative', width: '32px', height: '32px', borderRadius: '16px', overflow: 'hidden', backgroundColor: 'var(--bg-hover)', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 'var(--t-label)', fontWeight: '700', flexShrink: 0 }}>
                              {d.name.trim().charAt(0).toUpperCase()}
                              {typeof d.image === 'string' && d.image && (
                                <img data-share-friend-photo src={d.image} alt="" loading="lazy" onError={(e) => { e.currentTarget.style.display = 'none'; }} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} />
                              )}
                            </div>
                            <span style={{ flex: 1, minWidth: 0, fontSize: 'var(--t-label)', fontWeight: '600', color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.name}</span>
                            {Icons.send('var(--text-tertiary)', 14)}
                          </button>
                        ))}
                      </div>
                    );
                  })()}
                </div>
              </div>
            </div>
            );
          })()}
        </div>
      </div>
  );
}
