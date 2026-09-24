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
 * it, so the only ways to 'panel' or 'fullscreen' are the home-tab bubble, the
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
 * Two effects, and they are the only hooks in this file. Both reach into this
 * panel's own DOM through the refs above, and both used to sit in
 * FlockAppInner beside the rest of the Birdie state: one focuses the box when
 * there is already a thread to continue, the other pins the transcript to its
 * newest message. Neither could stay up there once the panel became lazy. The
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
 */
import React, { useEffect } from 'react';
import Icons from '../ui/Icons';
import BirdieBird, { BirdieStill, WARM_BIRD } from '../ui/BirdieBird';
import { BASE_URL } from '../../services/api';
import { onVenuePhotoError } from '../../lib/venuePhoto';
import { birdieBackText } from '../../lib/meterResets';

// When today's free messages come back, in the reader's own clock
// (lib/meterResets.js, shared with the Pro sheet so the two never disagree).
function chirpsBackText(aiResetsAt) {
  return birdieBackText(aiResetsAt);
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
  birdieActionBusy,
  birdieCorner,
  canSendAi,
  closeAiChat,
  colors,
  confirmBirdieDraft,
  confirmBirdieVoteStage,
  entitlements,
  fabDockBottom,
  fillAiInput,
  flocks,
  formatEventTime,
  isAiFullscreen,
  isAiPanel,
  isDark,
  isPro,
  loadTrustedContacts,
  memberCountLabel,
  openVenueDetail,
  outOfChirps,
  sendAiMessage,
  setAiInputHasText,
  setAiShareVenue,
  setCurrentScreen,
  setCurrentTab,
  setPaywallTrigger,
  setProfileScreen,
  setSelectedFlockId,
  setSelectedVenueForCreate,
  startNewAiChat,
  toggleAiFullscreen,
  transmitFlockMessage,
}) {
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
  useEffect(() => {
    if (aiMessages.length > 0
        && aiInputRef.current) {
      setTimeout(() => aiInputRef.current?.focus(), 200);
    }
  }, [isAiPanel, isAiFullscreen]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-scroll AI chat to bottom when messages change
  useEffect(() => {
    if (aiChatEndRef.current) {
      const isNew = aiMessages.length !== aiMsgCountRef.current;
      aiMsgCountRef.current = aiMessages.length;
      requestAnimationFrame(() => aiChatEndRef.current?.scrollIntoView({ behavior: isNew ? 'auto' : 'auto' }));
    }
    // Both refs are named in the dependency list below rather than silenced
    // with a disable. They arrive as props, so the rule cannot know they are
    // stable objects, and naming them costs nothing: a ref identity does not
    // change for the life of FlockAppInner, so this effect still runs exactly
    // when the transcript, the typing indicator or the mode changes.
  }, [aiMessages, aiTyping, isAiPanel, isAiFullscreen, aiChatEndRef, aiMsgCountRef]);

  return (
      <div onClick={(e) => { if (e.target === e.currentTarget) closeAiChat(); }} style={{
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
        transition: 'background-color 0.3s ease',
      }}>
        <div style={{
          backgroundColor: 'var(--bg-card-solid)',
          borderRadius: isAiFullscreen ? '24px 24px 0 0' : '20px',
          width: isAiFullscreen ? '100%' : 'calc(100% - 24px)',
          maxWidth: isAiPanel ? '360px' : '100%',
          height: isAiFullscreen ? '85%' : '55%',
          minHeight: isAiPanel ? '380px' : undefined,
          maxHeight: isAiPanel ? '520px' : undefined,
          display: 'flex',
          flexDirection: 'column',
          position: isAiPanel ? 'absolute' : 'relative',
          bottom: isAiPanel ? (birdieCorner.startsWith('bottom') ? fabDockBottom : undefined) : 0,
          top: isAiPanel ? (birdieCorner.startsWith('top') ? '60px' : undefined) : undefined,
          left: isAiPanel ? (birdieCorner.includes('left') ? '12px' : undefined) : undefined,
          right: isAiPanel ? (birdieCorner.includes('right') ? '12px' : undefined) : undefined,
          boxShadow: isAiPanel ? '0 12px 48px rgba(0,0,0,0.25), 0 4px 16px rgba(0,0,0,0.12)' : 'none',
          border: isAiPanel ? '1px solid var(--border-subtle)' : 'none',
          pointerEvents: 'auto',
          transition: 'all 0.35s cubic-bezier(0.34, 1.56, 0.64, 1)',
          animation: 'birdieExpand 0.35s cubic-bezier(0.34, 1.56, 0.64, 1)',
          overflow: 'hidden',
        }}>
          <DialogBehavior modal={isAiFullscreen} onClose={closeAiChat} label="Birdie" />
          {/* Header */}
          <div style={{ padding: isAiPanel ? '10px 12px' : '12px', borderBottom: '1px solid var(--divider)', background: colors.navyMidBg, borderRadius: isAiFullscreen ? '24px 24px 0 0' : '20px 20px 0 0', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
            {/* minWidth 0 and a one-line subtitle. The header gained a third
                button, and without these the title block refuses to shrink: at
                320px the tagline wrapped to three lines and pushed the header
                down into a panel that is only 55% of the screen tall. */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0, flex: 1 }}>
              <div style={{ position: 'relative', flexShrink: 0 }}>
                <div style={{ width: isAiPanel ? '34px' : '40px', height: isAiPanel ? '34px' : '40px', borderRadius: '50%', background: isDark ? '#162046' : '#e8eaf0', overflow: 'hidden', boxShadow: '0 4px 12px rgba(30,58,92,0.35)', border: '2px solid rgba(45,90,135,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <img src={isDark ? "/birdie-avatar.png" : "/birdie-avatar-light.png"} alt="Birdie" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                </div>
                <div style={{ position: 'absolute', bottom: '-2px', right: '-2px', width: '12px', height: '12px', borderRadius: '6px', backgroundColor: '#22C55E', border: '2px solid var(--bg-card-solid)' }} />
              </div>
              <div style={{ minWidth: 0 }}>
                <h2 style={{ fontFamily: 'var(--font-display)', letterSpacing: '-0.005em', fontSize: 'var(--t-title)', fontWeight: '600', color: 'white', margin: 0 }}>Birdie</h2>
                <p style={{ fontSize: 'var(--t-meta)', color: 'rgba(255,255,255,0.7)', margin: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>knows what's good tonight</p>
              </div>
            </div>
            <div style={{ display: 'flex', gap: '6px', flexShrink: 0 }}>
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
                  style={{ width: '28px', height: '28px', borderRadius: '14px', backgroundColor: 'rgba(255,255,255,0.15)', border: 'none', color: 'white', cursor: aiTyping ? 'default' : 'pointer', opacity: aiTyping ? 0.45 : 1, display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'background-color 0.2s ease, opacity 0.2s ease' }}
                >
                  {Icons.plus('white', 14)}
                </button>
              )}
              {/* Expand/Collapse toggle */}
              <button aria-label="Toggle full screen" className="hit44" onClick={toggleAiFullscreen} style={{ width: '28px', height: '28px', borderRadius: '14px', backgroundColor: 'rgba(255,255,255,0.15)', border: 'none', color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'background-color 0.2s ease' }}
                onMouseEnter={e => e.currentTarget.style.backgroundColor = 'rgba(255,255,255,0.25)'}
                onMouseLeave={e => e.currentTarget.style.backgroundColor = 'rgba(255,255,255,0.15)'}
              >
                {isAiFullscreen ? (
                  <svg aria-hidden="true" focusable="false" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round"><polyline points="4 14 10 14 10 20" /><polyline points="20 10 14 10 14 4" /><line x1="14" y1="10" x2="21" y2="3" /><line x1="3" y1="21" x2="10" y2="14" /></svg>
                ) : (
                  <svg aria-hidden="true" focusable="false" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round"><polyline points="15 3 21 3 21 9" /><polyline points="9 21 3 21 3 15" /><line x1="21" y1="3" x2="14" y2="10" /><line x1="3" y1="21" x2="10" y2="14" /></svg>
                )}
              </button>
              {/* Close */}
              <button aria-label="Close" className="hit44" onClick={closeAiChat} style={{ width: '28px', height: '28px', borderRadius: '14px', backgroundColor: 'rgba(255,255,255,0.15)', border: 'none', color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'background-color 0.2s ease' }}
                onMouseEnter={e => e.currentTarget.style.backgroundColor = 'rgba(255,255,255,0.25)'}
                onMouseLeave={e => e.currentTarget.style.backgroundColor = 'rgba(255,255,255,0.15)'}
              >{Icons.x('white', 14)}</button>
            </div>
          </div>

          {/* Messages */}
          <div className="birdie-bg" style={{ flex: 1, padding: '12px', overflowY: 'auto', position: 'relative' }}>
            {/* Once the chat starts he steps aside: a whisper behind the
                thread rather than a second thing to read. */}
            {aiMessages.length > 0 && (
              <div style={{ position: 'absolute', inset: 0, zIndex: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: isDark ? 0.12 : 0.07, pointerEvents: 'none' }}>
                <BirdieBird size={isAiPanel ? 148 : 200} dark={isDark} />
              </div>
            )}

            {/* Empty state: Birdie, then the greeting, then the chips — one
                stack in normal flow so nothing overlaps him. */}
            {aiMessages.length === 0 && (
              <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '10px', padding: '0 16px 12px', pointerEvents: 'none', zIndex: 1 }}>
                <BirdieBird size={isAiPanel ? 120 : 168} dark={isDark} style={{ marginBottom: '2px' }} />
                <p style={{ fontSize: isAiPanel ? 'var(--t-label)' : 'var(--t-body)', fontWeight: '600', color: 'var(--text-primary)', margin: 0, textAlign: 'center' }}>hey, it's Birdie.</p>
                <p style={{ fontSize: isAiPanel ? 'var(--t-micro)' : 'var(--t-meta)', color: 'var(--text-secondary)', margin: 0, textAlign: 'center', maxWidth: '260px', lineHeight: 1.5 }}>where's good tonight, how packed it is, what your flock is up to. ask away.</p>
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

            {aiMessages.map((msg, i) => (
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
              <div style={{ display: 'flex', gap: '8px', marginBottom: '12px', flexDirection: msg.role === 'user' ? 'row-reverse' : 'row', position: 'relative', zIndex: 2 }}>
                <div style={{ width: '30px', height: '30px', borderRadius: '15px', background: msg.role === 'user' ? colors.navyBg : isDark ? '#162046' : '#e8eaf0', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, boxShadow: '0 2px 8px rgba(0,0,0,0.1)', overflow: 'hidden', border: msg.role === 'user' ? 'none' : '1.5px solid rgba(45,90,135,0.4)' }}>
                  {msg.role === 'user' ? Icons.user('white', 14) : <img src={isDark ? "/birdie-avatar.png" : "/birdie-avatar-light.png"} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />}
                </div>
                <div style={{ maxWidth: '78%' }}>
                  <div style={{ borderRadius: '16px', padding: '10px 12px', fontSize: 'var(--t-label)', backgroundColor: msg.role === 'user' ? colors.navyBg : 'var(--bg-hover)', color: msg.role === 'user' ? 'white' : colors.navy, borderTopRightRadius: msg.role === 'user' ? '4px' : '16px', borderTopLeftRadius: msg.role === 'user' ? '16px' : '4px', boxShadow: msg.role === 'user' ? '0 2px 8px rgba(13,40,71,0.10)' : '0 1px 3px rgba(0,0,0,0.05)', whiteSpace: 'pre-wrap' }}>
                    {msg.text}
                  </div>
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
                      <button className="hit44" disabled={birdieActionBusy} onClick={() => confirmBirdieDraft(msg.flockDraft)} style={{ marginTop: '10px', width: '100%', padding: '10px', borderRadius: '10px', border: 'none', background: '#1e293b', color: 'white', fontSize: 'var(--t-meta)', fontWeight: '600', cursor: birdieActionBusy ? 'wait' : 'pointer', opacity: birdieActionBusy ? 0.6 : 1 }}>
                        {birdieActionBusy ? 'Starting\u2026' : 'Start this flock'}
                      </button>
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
                      {msg.venues.map((v, vi) => {
                        // Real crowd data only. When Birdie hasn't checked this
                        // venue, the card simply has no crowd row; a number
                        // derived from the venue's name is a lie, not a design.
                        const crowd = typeof v.crowd === 'number' ? v.crowd : null;
                        const crowdColor = crowd == null ? null : crowd > 84 ? 'var(--accent-red-text)' : crowd > 39 ? '#B45309' : 'var(--accent-green-text)';
                        const crowdBar = crowd == null ? null : crowd > 84 ? '#EF4444' : crowd > 39 ? '#F59E0B' : '#22C55E';
                        // photo_url is a proxy ref path from the backend — the
                        // old place-id URL never resolved (proxy takes ?ref=).
                        const photoUrl = v.photo_url ? `${BASE_URL}${v.photo_url}` : null;
                        return (
                        <div key={vi} style={{ borderRadius: '14px', border: '1px solid var(--border-default)', backgroundColor: 'var(--bg-card-solid)', overflow: 'hidden', boxShadow: 'var(--card-shadow-sm, 0 1px 3px rgba(0,0,0,0.05))', maxWidth: '280px', animation: `fadeSlideIn 0.35s ease-out ${vi * 0.08}s both` }}>
                          {photoUrl && (
                            <img src={photoUrl} alt="" loading="lazy" style={{ width: '100%', height: '120px', objectFit: 'cover', display: 'block' }} onError={onVenuePhotoError} />
                          )}

                          <div style={{ padding: '12px' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '8px' }}>
                              <h4 style={{ fontSize: 'var(--t-body)', fontWeight: '600', color: 'var(--text-primary)', margin: 0, lineHeight: 1.25 }}>{v.name}</h4>
                              {v.is_open != null && (
                                <span style={{ fontSize: 'var(--t-meta)', fontWeight: '500', padding: '2px 7px', borderRadius: '999px', backgroundColor: v.is_open ? 'var(--accent-green-bg)' : 'var(--accent-red-bg)', color: v.is_open ? 'var(--accent-green-text)' : 'var(--accent-red-text)', flexShrink: 0 }}>{v.is_open ? 'Open' : 'Closed'}</span>
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

                            {/* Crowd row — only when Birdie actually checked */}
                            {crowd != null && (
                              <div style={{ marginTop: '10px' }}>
                                <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: '4px' }}>
                                  <span style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', fontWeight: '500' }}>{v.crowd_label || 'Crowd right now'}</span>
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
                                  openVenueDetail(v.place_id, { name: v.name, formatted_address: v.address, place_id: v.place_id, rating: v.rating });
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
                    </div>
                  )}
                </div>
              </div>
              </React.Fragment>
            ))}

            {aiTyping && (
              <div style={{ display: 'flex', gap: '8px', position: 'relative', zIndex: 1, animation: 'fadeSlideIn 0.3s ease-out' }}>
                <div style={{ width: '30px', height: '30px', borderRadius: '15px', background: isDark ? '#162046' : '#e8eaf0', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', border: '1.5px solid rgba(45,90,135,0.4)' }}>
                  <img src={isDark ? "/birdie-avatar.png" : "/birdie-avatar-light.png"} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                </div>
                <div style={{ backgroundColor: 'var(--bg-hover)', borderRadius: '16px', borderTopLeftRadius: '4px', padding: '10px 16px', display: 'flex', alignItems: 'center', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
                  <svg aria-hidden="true" focusable="false" width="32" height="24" viewBox="0 0 32 24" xmlns="http://www.w3.org/2000/svg">
                    <circle cx="6" cy="12" r="3" fill={isDark ? '#e8e4df' : '#9a958f'} opacity="0.9">
                      <animate id="b1" begin="0;b3.end+0.2s" attributeName="cy" calcMode="spline" dur="0.6s" values="12;6;12" keySplines=".33,.66,.66,1;.33,0,.66,.33" />
                      <animate begin="0;b3.end+0.2s" attributeName="opacity" dur="0.6s" values="0.35;1;0.35" />
                    </circle>
                    <circle cx="16" cy="12" r="3" fill={isDark ? '#d5d0c9' : '#8a857f'} opacity="0.9">
                      <animate begin="b1.begin+0.1s" attributeName="cy" calcMode="spline" dur="0.6s" values="12;6;12" keySplines=".33,.66,.66,1;.33,0,.66,.33" />
                      <animate begin="b1.begin+0.1s" attributeName="opacity" dur="0.6s" values="0.35;1;0.35" />
                    </circle>
                    <circle cx="26" cy="12" r="3" fill={isDark ? '#c2bdb6' : '#7a756f'} opacity="0.9">
                      <animate id="b3" begin="b1.begin+0.2s" attributeName="cy" calcMode="spline" dur="0.6s" values="12;6;12" keySplines=".33,.66,.66,1;.33,0,.66,.33" />
                      <animate begin="b1.begin+0.2s" attributeName="opacity" dur="0.6s" values="0.35;1;0.35" />
                    </circle>
                  </svg>
                </div>
              </div>
            )}
            <div ref={aiChatEndRef} />
          </div>

          {/* Suggested Questions — mid-conversation only; the empty state
              carries its own chips under the bird */}
          {!aiTyping && aiMessages.length > 0 && !outOfChirps && (
            <div style={{ padding: isAiPanel ? '6px 10px' : '8px 12px', borderTop: '1px solid var(--divider)', backgroundColor: 'var(--bg-tertiary)', flexShrink: 0 }}>
              {isAiFullscreen && <p style={{ fontSize: 'var(--t-micro)', fontWeight: '700', color: 'var(--text-secondary)', marginBottom: '6px', textTransform: 'uppercase' }}>Try asking</p>}
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

          {/* Input */}
          <div style={{ padding: '8px 12px 10px', backgroundColor: 'var(--bg-card-solid)' }}>
            <div style={{ borderRadius: '20px', backgroundColor: 'var(--bg-hover)', border: '1.5px solid var(--border-subtle)', padding: '6px', transition: 'border-color 0.3s ease, box-shadow 0.3s ease', boxShadow: aiInputHasText ? '0 0 0 1px rgba(45,90,135,0.15), 0 4px 16px rgba(0,0,0,0.08)' : '0 2px 8px rgba(0,0,0,0.04)', borderColor: aiInputHasText ? 'rgba(30,58,92,0.25)' : 'var(--border-subtle)' }}>
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
                <input aria-label="Ask me anything" ref={aiInputRef} type="text" defaultValue={aiInputValueRef.current || ''} maxLength={AI_CHAT_MAX_MESSAGE_CHARS} onInput={(e) => { aiInputValueRef.current = e.target.value; const has = !!e.target.value; if (has !== aiInputHasTextRef.current) { aiInputHasTextRef.current = has; setAiInputHasText(has); } }} onKeyDown={(e) => e.key === 'Enter' && sendAiMessage()} placeholder="Ask me anything..." style={{ flex: 1, padding: '11px 0', backgroundColor: 'transparent', color: 'var(--text-primary)', border: 'none', fontSize: 'var(--t-body)', outline: 'none', fontWeight: '500', lineHeight: '1.4' }} autoComplete="off" />
                {/* `!aiInputHasText && !aiTyping` left this ENABLED for the
                    whole time Birdie was answering, including over an empty
                    box, where pressing it did nothing; and it was drawn at 0.4
                    opacity the entire time, so it looked disabled and was not.
                    One value now drives both the look and the behaviour. */}
                <button aria-label="Send" className="hit44 fab-press" onClick={sendAiMessage} disabled={!canSendAi} style={{ width: '34px', height: '34px', minWidth: '34px', borderRadius: '17px', border: 'none', background: canSendAi ? '#1e293b' : 'transparent', color: 'white', cursor: canSendAi ? 'pointer' : 'default', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'all 0.3s cubic-bezier(0.34, 1.56, 0.64, 1)', transform: canSendAi ? 'scale(1)' : 'scale(0.85)', opacity: canSendAi ? 1 : 0.4, boxShadow: canSendAi ? '0 4px 12px rgba(30,58,92,0.30)' : 'none' }}>
                  <svg aria-hidden="true" focusable="false" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ transition: 'transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1)', transform: canSendAi ? 'translateY(-1px)' : 'translateY(0)' }}>
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
                  <button type="button" className="hit44 glass-btn glass-primary" onClick={() => setPaywallTrigger('birdie')} style={{ padding: '8px 12px', borderRadius: '12px', fontSize: 'var(--t-meta)', fontWeight: '700', whiteSpace: 'nowrap', flexShrink: 0 }}>
                    Get Flock Pro
                  </button>
                </div>
              ) : (
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
                    for anyone who scrolled past the empty state. */}
                {entitlements?.paywallEnabled && !isPro && aiRemaining != null && aiRemaining <= 5 ? (
                  <span style={{ flexBasis: '100%', padding: '2px 10px 0', fontSize: 'var(--t-meta)', color: aiRemaining === 0 ? 'var(--accent-red-text)' : 'var(--text-tertiary)', fontWeight: '500' }}>
                    {aiRemaining === 0 ? (aiResetsAt ? `Out of chirps until ${new Date(aiResetsAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : 'Out of chirps today') : `${aiRemaining} chirp${aiRemaining === 1 ? '' : 's'} left today`}
                  </span>
                ) : (
                  <span style={{ flexBasis: '100%', padding: '2px 10px 0', fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)', fontWeight: '500', opacity: 0.6 }}>Birdie AI &middot; answers are generated and can be wrong</span>
                )}
              </div>
              )}
            </div>
          </div>

          {/* Venue Share Picker */}
          {aiShareVenue && (
            <div onClick={(e) => { if (e.target === e.currentTarget) setAiShareVenue(null); }} style={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'flex-end', zIndex: 60, borderRadius: '24px 24px 0 0' }}>
              <DialogBehavior onClose={() => setAiShareVenue(null)} label="Share this venue" />
              <div style={{ backgroundColor: 'var(--bg-card-solid)', borderRadius: '20px 20px 0 0', width: '100%', maxHeight: '60%', display: 'flex', flexDirection: 'column' }}>
                <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--divider)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <h3 style={{ fontSize: 'var(--t-title)', fontWeight: '700', color: 'var(--text-primary)', margin: 0 }}>
                      Send {aiShareVenue.name}
                    </h3>
                    <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: '2px 0 0' }}>
                      {aiShareVenue._shareToDm ? 'Choose a friend' : 'Choose a flock'}
                    </p>
                  </div>
                  <button aria-label="Close" className="hit44" onClick={() => setAiShareVenue(null)} style={{ width: '28px', height: '28px', borderRadius: '14px', backgroundColor: 'var(--bg-hover)', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Icons.x('var(--text-secondary)', 14)}</button>
                </div>
                <div style={{ flex: 1, overflowY: 'auto', padding: '8px' }}>
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
                        <div style={{ padding: '24px 20px', textAlign: 'center' }}>
                          <BirdieStill bird={WARM_BIRD} size={80} style={{ margin: '0 auto 10px' }} />
                          <p style={{ fontSize: 'var(--t-label)', fontWeight: '600', color: 'var(--text-primary)', margin: '0 0 4px' }}>No flocks to send this to yet</p>
                          <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: '0 0 14px' }}>Start a flock and this venue can go straight into the chat.</p>
                          <button className="hit44" onClick={() => { setAiShareVenue(null); closeAiChat(); setSelectedVenueForCreate({ name: aiShareVenue.name, addr: aiShareVenue.address, rating: aiShareVenue.rating, price_level: aiShareVenue.price_level, place_id: aiShareVenue.place_id }); setCurrentScreen('create'); }} style={{ padding: '10px 20px', borderRadius: '12px', border: 'none', background: colors.navyMidBg, color: 'white', fontWeight: '600', fontSize: 'var(--t-label)', cursor: 'pointer' }}>
                            Start a flock here
                          </button>
                        </div>
                      );
                    })()
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
  );
}
