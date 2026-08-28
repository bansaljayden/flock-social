/**
 * FLOCK CHAT SCREEN
 *
 * This screen was 1,571 lines of `App.js`, declared as an arrow function
 * inside `FlockAppInner` and called rather than mounted. It moved out for the
 * same reason the venue owner dashboard and Add Friends did, which is that a
 * single file holding every screen in the product is a file nobody can review.
 * It is the third of that sweep and it was the hardest one, because it is the
 * most tangled screen in the file: the message list, the composer, image
 * sharing, the reply and reaction affordances, the report sheet, the typing
 * indicator, the pinned venue banner, the venue vote panel, the flock invite
 * sheet, the budget and bill-split flow and the live location banner all sit
 * in one tree.
 *
 * What it is NOT is every chat surface. The one-to-one DM thread is a separate
 * 707-line screen, `dmDetailScreen`, and it is still declared inside
 * `FlockAppInner`. It shares this screen's shape and about half of its
 * behaviour, including the two standing explanations this file has no copy of:
 * the one for a pair with no connection yet and the one for a blocked pair.
 * Moving both in one commit would have made the verbatim diff below
 * unreadable, and that diff is the only thing proving nothing changed on the
 * way across.
 *
 * WHY THIS ONE IS A STATIC IMPORT
 *
 * The dashboard is the paid venue product, gated behind a role, and no
 * consumer can reach it, so a chunk fetch costs its audience nothing. This
 * screen is the far end of that scale. It is where the product actually
 * happens, every user opens it, most of them open it more than once in a
 * session, and they do it on a bar network. Three production builds priced it,
 * gzipped at level 9. App chunk with the screen inside App.js: 190,177 bytes.
 * With it here and imported normally: 192,956. With it here and behind
 * React.lazy: 178,529, plus a 16,380 byte chunk fetched the first time anyone
 * opens a chat.
 *
 * Read those three numbers as one sum and the decision makes itself. A user
 * who opens a chat downloads 178,529 + 16,380 = 194,909 bytes under lazy,
 * against 192,956 with this static import and 190,177 before the extraction.
 * So lazy loading costs a chat user 1,953 more bytes than the file they are
 * reading now, and it charges a round trip on top, in front of the screen this
 * product exists to show. The 14.09 kB it takes off the boot chunk is only a
 * saving for somebody who never opens a chat, and that person is not a Flock
 * user. Add Friends was declined on a 4.33 kB saving for a screen a new
 * account opens once. This is the same call with a bigger number and less
 * doubt.
 *
 * The honest other half of that measurement: extracting at all cost 2,779
 * bytes, 2.71 kB, because 146 prop names appear twice in the output and a
 * property name is one of the few things a minifier cannot rename. That is the
 * price of the parameter list below, and it is worth paying for the reason in
 * the next paragraph.
 *
 * WHY EVERYTHING ARRIVES AS A PROP
 *
 * The old arrow function closed over 146 names: 129 declared in
 * `FlockAppInner`, which is state, setters and handlers, and seventeen
 * module-level helpers, constants and components that `App.js` shares with
 * screens other than this one. A context would have had to
 * enumerate exactly the same 146 names into a provider value, so it buys
 * nothing and hides the dependency surface behind a hook. They are parameters
 * instead, so the whole dependency surface of this file is its parameter list
 * plus its imports, and a name this component reads and does not receive is an
 * undefined identifier that `no-undef` fails the build on, rather than a prop
 * that is silently `undefined` at runtime and renders as nothing.
 *
 * The 146 names were not read off the page. They came from a Babel scope walk
 * of the block, every `ReferencedIdentifier` whose binding resolves outside
 * it, and the parameter list below and the props object at the call site were
 * both generated from that one array, so they cannot drift apart.
 *
 * The state and the effects behind these props deliberately did NOT move. They
 * live in `FlockAppInner`, which does not unmount when the user leaves this
 * screen, so the socket wiring, the caught-up cursor, the message cache and a
 * half-typed message survive a trip elsewhere exactly as they did before.
 * Moving them down would have reset all of it on every exit.
 *
 * The block arrived here reading no hooks of its own. It reads two now, both
 * added on 2026-08-26 and both explained where they are declared: one for
 * whether the composer holds anything but whitespace, and one for whether the
 * socket is actually up. Neither fact is visible from App.js, which is the
 * whole reason they are not props. It is a real component and App.js mounts it
 * as `<ChatDetail {...props} />`, so hooks are legal here; they sit above the
 * `!flock` early return, where they always run.
 *
 * The body below was the old block verbatim, including its original four-space
 * indentation, so it could be diffed against the deleted lines character for
 * character. What has changed since is three defects the browser suite proved
 * from the screen: the draft that followed the user into a private thread, the
 * Send button armed over whitespace, and the "online" literal wired to nothing.
 */
import React from 'react';
import { leaveFlock as apiLeaveFlock, BASE_URL, createBillSplit, createFlockInviteLink, getFlockMessageImage, getPaymentLinks, ghostCommit, lockBudget, sendBudgetReminder, settleShare, submitBudget, trackNotificationPermission, unsettleShare } from '../services/api';
import { getSocket, leaveFlock } from '../services/socket';
import { getNotificationStatus, requestNotificationPermission } from '../services/firebase';
import { BirdieStill, BirdNote, WARM_BIRD } from '../components/ui/BirdieBird';
import Icons from '../components/ui/Icons';

// Day separators. Long threads used to be one undifferentiated scroll where
// last Tuesday touched tonight with nothing between them. A row draws a
// divider when its calendar day differs from the previous row's; rows with no
// sentAt (old cached rows, failed sends) inherit the previous day so a
// missing timestamp can never invent a boundary. Mirrored in ChatDetail.js
// and DmDetail.js by design; the copy vocabulary is Today / Yesterday / the
// dated weekday.
const dayKeyOf = (iso) => {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
};
const dayLabelOf = (iso) => {
  const d = new Date(iso);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const that = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diffDays = Math.round((today - that) / 86400000);
  if (diffDays <= 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return d.toLocaleDateString([], { weekday: 'long' });
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
};
const daySeparatorFor = (rows, idx) => {
  const cur = dayKeyOf(rows[idx]?.sentAt);
  if (!cur) return null;
  for (let i = idx - 1; i >= 0; i--) {
    const prev = dayKeyOf(rows[i]?.sentAt);
    if (prev) return prev === cur ? null : dayLabelOf(rows[idx].sentAt);
  }
  // First dated row in the thread: label it so history opens with its day.
  return dayLabelOf(rows[idx].sentAt);
};


/* How often the header re-reads whether the socket is actually up. The same
 * 2000ms App.js's reconnect catch-up samples on, and for the same reason: a
 * drop shorter than one sample is never drawn, and a real reconnect takes
 * longer than one sample in every case that has been measured. */
const SOCKET_SAMPLE_MS = 2000;

/* One pill per emoji, not one per person.
 *
 * GET /api/flocks/:id/messages returns emoji_reactions as one ROW per person
 * ({ emoji, user_id, user_name }), and both socket handlers in App.js push
 * rows in the same shape. The list below used to map over those rows directly
 * and print a hardcoded "1" beside each, so four people sending the same heart
 * drew four identical pills that each claimed one reaction.
 *
 * Tolerant of a bare string on purpose. Reactions were local-only state until
 * the send was wired, and anything still holding the old shape (a message in
 * memory across the change, an older cached payload) degrades to a pill with
 * no owner rather than rendering an object, which React refuses outright. */
export function groupReactions(reactions) {
  const byEmoji = new Map();
  for (const r of reactions || []) {
    const emoji = typeof r === 'string' ? r : r?.emoji;
    if (!emoji) continue;
    if (!byEmoji.has(emoji)) byEmoji.set(emoji, { emoji, count: 0, userIds: [] });
    const g = byEmoji.get(emoji);
    g.count += 1;
    if (typeof r === 'object' && r?.user_id != null) g.userIds.push(r.user_id);
  }
  return [...byEmoji.values()];
}

export default function ChatDetail({
  // Module-level helpers, constants and components that live in App.js and
  // are shared with screens other than this one, so they stay declared there
  // and arrive here.
  ChatSkeleton,
  DM_PAGE_SIZE,
  DialogBehavior,
  ListSkeleton,
  MOMENTUM_STAGES,
  SearchInputLocal,
  VenueCard,
  colorsLight,
  crowdColorFor,
  memberCountLabel,
  messagePreview,
  momentumStageKey,
  oldestServerId,
  onVenuePhotoError,
  paymentRoutes,
  resolveVenuePhoto,
  voteTotal,
  // Everything else is declared in FlockAppInner and stays declared there.
  MissingFlockPanel,
  addReactionToMessage,
  allVenues,
  authUser,
  billPaidBy,
  billSplit,
  billTip,
  billTotal,
  budgetAmount,
  budgetCustom,
  budgetFilteredVenues,
  budgetStatus,
  budgetSubmitting,
  chatEndRef,
  chatGalleryInputRef,
  chatInputHasText,
  chatNavOpen,
  chatSearch,
  chatSearchRef,
  colors,
  confirmClick,
  confirmFlockPlan,
  copiedInviteUrl,
  crowdPredictions,
  eventCrowd,
  eventCrowdLabel,
  dismissNotifAsk,
  flockAtTop,
  flockInviteAllFriends,
  flockInviteCandidates,
  flockInviteFriendsError,
  flockInviteFriendsLoading,
  flockInvitePulses,
  flockInviteRest,
  flockInviteResults,
  flockInviteSearch,
  flockInviteSelected,
  flockInviteSending,
  flockMemberLocations,
  getCategoryColor,
  getMaxPriceLevel,
  getRelativeTime,
  getSelectedFlock,
  handleChatImageSelect,
  handleChatInputChange,
  handleFlockInviteSearch,
  handleSendFlockInvites,
  isDark,
  isLoading,
  isTyping,
  loadFlockInviteFriends,
  loadOlderFlockMessages,
  loadPopularVenues,
  locationBannerDismissed,
  messagesLoading,
  notifAskDismissed,
  notifStatus,
  olderLoading,
  openCameraViewfinder,
  openVenueDetail,
  pendingImage,
  popularVenues,
  profilePic,
  renderFlockInviteRow,
  retryFailedMessage,
  selectedFlockId,
  sendChatMessage,
  setBillPaidBy,
  setBillSplit,
  setBillTip,
  setBillTotal,
  setBudgetAmount,
  setBudgetCustom,
  setBudgetStatus,
  setBudgetSubmitting,
  setChatInput,
  setChatNavOpen,
  setChatSearch,
  setCopiedInviteUrl,
  setCurrentScreen,
  setCurrentTab,
  setFlockInviteSearch,
  setFlockInviteSelected,
  setFlocks,
  setIsLoading,
  setLocationBannerDismissed,
  setModerationTarget,
  setNotifStatus,
  setPaymentOptions,
  setPendingImage,
  setPickingVenueForCreate,
  setPickingVenueForFlockId,
  setShowChatPool,
  setShowChatSearch,
  setShowCreateBill,
  setShowFlockInviteModal,
  setShowFlockMenu,
  setShowImagePreview,
  setShowLeaveConfirm,
  setShowPaymentPicker,
  setShowReactionPicker,
  setShowVenueShareModal,
  setShowVotePanel,
  setVenueDetailReturnTo,
  shareImageToChat,
  shareVenueToChat,
  sharingLocationForFlock,
  sharingLocationRef,
  showChatPool,
  showChatSearch,
  showCreateBill,
  showFlockInviteModal,
  showFlockMenu,
  showImagePreview,
  showLeaveConfirm,
  showReactionPicker,
  showToast,
  showVenueShareModal,
  showVotePanel,
  startSharingLocation,
  stopLocationSharing,
  styles,
  typingUser,
  updateFlockVenue,
  updateFlockVotes,
  userLocation,
}) {
    // TWO PIECES OF STATE, AND WHY THEY ARE HERE RATHER THAN IN App.js.
    //
    // This screen arrived from App.js as a pure function of its props and the
    // header of this file says so. These two are the exceptions, and both are
    // here because what they hold is a fact about THIS screen's own DOM and
    // this screen's own connection, which App.js cannot see:
    //
    //   composerHasRealText. The composer is an uncontrolled input, so the
    //   only place the difference between "" and "   " is ever visible is its
    //   change event, below. App.js computes chatInputHasText as `!!value`
    //   while sendChatMessage guards on `.trim()`, so a box holding nothing
    //   but spaces lit the Send button up and then threw the tap away in
    //   silence. That is the dead control SLOP-AUDIT rule C1 bans, on the
    //   most-used button in the product.
    //
    //   connectionState. The header printed "online" beside a green dot as a
    //   hardcoded literal wired to nothing. It said online with the socket
    //   dead, on the one screen a person opens to work out why nothing is
    //   arriving.
    //
    // Both are declared above the `!flock` return below, because a hook after
    // a conditional return is a hook that does not always run.
    // Full-size photo viewer. A history row carries only the thumbnail, so
    // opening one fetches the original through the membership-gated endpoint;
    // a live row still holds the full image and opens instantly. Reached from
    // the message's reaction row, because the bubble's own tap is already the
    // accessibility door to react and report and may not be nested inside.

  // Jump-to-latest. Scrolled deep into history, the way back down was a long
  // manual drag and a live message arriving off-screen was invisible. The
  // pill appears once the reader is more than ~600px from the bottom and one
  // tap returns them to now. Sticky inside the scroll container, so it needs
  // no coordination with the composer's layout.
    const [showJumpPill, setShowJumpPill] = React.useState(false);
    const [imageViewer, setImageViewer] = React.useState(null);
    const openImageViewer = (m) => {
      if (m.image) { setImageViewer({ src: m.image }); return; }
      setImageViewer({ loading: true });
      getFlockMessageImage(flock.id, m.id)
        .then((d) => setImageViewer((prev) => (prev && prev.loading ? { src: d.image } : prev)))
        .catch(() => setImageViewer((prev) => (prev && prev.loading ? { error: "Couldn't load the full photo. Try again." } : prev)));
    };

    const [composerHasRealText, setComposerHasRealText] = React.useState(false);
    // Sampled rather than subscribed to, for the reason App.js's reconnect
    // catch-up gives at length: socket.io's 'connect' fires on the INSTANCE,
    // and services/socket.js replaces the instance on a token swap, a
    // fatal-auth teardown or a session expiry, so a listener welded to one
    // instance goes quiet for good. Reading `.connected` is instance-agnostic
    // and costs a boolean, and the timer only runs while a chat is open.
    // Three states, not two, and the middle one earns its word. Jayden's rule,
    // 2026-08-26: say "reconnecting" only while something really is trying, and
    // "offline" when the device already knows nothing can succeed.
    //   'online'        the socket is connected.
    //   'reconnecting'  the socket is down but the network is up, and
    //                   socket.io retries forever on a backoff, so trying is
    //                   exactly what is happening.
    //   'offline'       navigator.onLine is false: the DEVICE says there is no
    //                   network, retries cannot succeed, and printing
    //                   "reconnecting" over airplane mode would be the same
    //                   lie the hardcoded "online" was, wearing amber.
    const readConnection = () => {
      if (getSocket()?.connected) return 'online';
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return 'offline';
      return 'reconnecting';
    };
    const [connectionState, setConnectionState] = React.useState(readConnection);
    React.useEffect(() => {
      const sample = () => setConnectionState(readConnection());
      sample();
      const id = setInterval(sample, SOCKET_SAMPLE_MS);
      // The two events that change the answer between samples, so airplane
      // mode is named the moment it happens rather than up to two seconds late.
      window.addEventListener('online', sample);
      window.addEventListener('offline', sample);
      return () => {
        clearInterval(id);
        window.removeEventListener('online', sample);
        window.removeEventListener('offline', sample);
      };
    }, []);

    // LEAVING THIS SCREEN, WRITTEN ONCE.
    //
    // A half-written flock message used to follow the user out of here. The
    // composer is uncontrolled and its text lives in a ref in App.js that the
    // one-to-one DM composer reads too, and only the back arrow ever cleared
    // it. Every other exit on this screen left the sentence loaded, so opening
    // a private thread put a message written for a group of people one tap of
    // Send away from going to one of them.
    //
    // So there is one definition and every exit calls it, the back arrow
    // included. A new exit that forgets to is the only route back to that bug,
    // and __tests__/chatComposerAndInviteSheet.test.js counts the navigation
    // calls in this file against the calls to this function so that route
    // stays shut.
    const leaveChatScreen = () => {
      setChatInput('');
      setComposerHasRealText(false);
      setShowFlockMenu(false);
      setShowLeaveConfirm(false);
      setShowChatSearch(false);
      setChatSearch('');
      setShowVotePanel(false);
      setChatNavOpen(false);
    };

    const flock = getSelectedFlock();
    // Every line below reads off `flock` unguarded, starting with flock.name in
    // the header. An empty flock list here is a TypeError during render, which
    // React answers by unmounting the entire app.
    if (!flock) return <MissingFlockPanel />;
    // Hot-loop precomputation. The search filter used to run twice per render
    // (once for the count line, once for the list), and the avatar cell ran
    // flock.members.find up to four times per MESSAGE ROW per render, which at
    // a few pages of history times a full roster is thousands of string
    // comparisons on every app-level state change while the chat is open. One
    // filtered list, one name-to-image Map, both O(n) once.
    // The share-location banner belongs to the night itself. It used to
    // render from the second a plan was confirmed, so a Saturday plan
    // confirmed on Tuesday asked for live location for four days; and a
    // dismissal was stored as a flat true, silencing the flock forever,
    // including the rescheduled night where the ask is right again. The
    // window is three hours before the plan to six hours after, matching
    // when knowing where everyone is actually helps; a confirmed plan with
    // no time keeps the old always-ask, there being no night to gate by.
    // Dismissals store the eventTime they were for, so a new time re-asks
    // once (a legacy flat true from the old scheme re-asks once too, then
    // stores per-night from there on).
    const locBannerAsk = (() => {
      if (flock.status !== 'confirmed' || sharingLocationForFlock) return false;
      if (flock.eventTime) {
        const et = new Date(flock.eventTime).getTime();
        if (Number.isFinite(et)) {
          const now = Date.now();
          if (now < et - 3 * 3600 * 1000 || now > et + 6 * 3600 * 1000) return false;
        }
      }
      return locationBannerDismissed[flock.id] !== (flock.eventTime || true);
    })();

    const visibleMessages = showChatSearch && chatSearch.trim()
      ? flock.messages.filter(m => {
          const q = chatSearch.toLowerCase();
          return (m.text || '').toLowerCase().includes(q) || (m.sender || '').toLowerCase().includes(q);
        })
      : flock.messages;
    const memberImageByName = new Map(
      (flock.members || [])
        .filter(mb => mb && typeof mb === 'object' && mb.name && mb.image)
        .map(mb => [mb.name, mb.image])
    );
    const reactions = ['❤️', '👍', '😂', '🔥'];
    // PUT /api/flocks/:id is creator-only. The venue controls below are the
    // same route the vote panel's Confirm button already gates on this.
    const isCreator = String(flock.creatorId) === String(authUser?.id);
    // The composer's arming condition, read by the Send button and by the
    // Enter key so the two cannot disagree about what is sendable. It is an
    // AND of two facts owned by two places and it needs both. App.js's
    // chatInputHasText is the authority on whether the box was CLEARED: a
    // send, a photo caption going out and every exit above all clear through
    // it, and none of them is visible from in here. composerHasRealText is the
    // authority on whether what is in the box is more than whitespace, which
    // is only visible in here, because chatInputHasText is `!!value` and a
    // string of spaces is truthy.
    const canSendComposerText = chatInputHasText && composerHasRealText;

    return (
      <div key="chat-detail-screen-container" style={{ display: 'flex', flexDirection: 'column', height: '100%', backgroundColor: 'var(--bg-card-solid)' }}>
        <div style={{ padding: '10px 10px 8px 6px', background: colors.navyBg, flexShrink: 0, boxShadow: '0 2px 10px rgba(0,0,0,0.1)' }}>
          <div style={{ display: 'flex', alignItems: 'stretch', gap: '6px' }}>
            <button aria-label="Back" className="hit44" onClick={() => { leaveChatScreen(); setCurrentScreen('main'); }} style={{ width: '34px', borderRadius: '10px', background: 'none', border: 'none', color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{Icons.arrowLeft('white', 20)}</button>
            {!chatNavOpen && (
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', minWidth: 0 }}>
                <h2 style={{ fontFamily: 'var(--font-display)', letterSpacing: '-0.005em', fontWeight: '600', color: 'white', fontSize: 'var(--t-title)', margin: 0, lineHeight: '1.2', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{flock.name}</h2>
                <div style={{ display: 'flex', alignItems: 'center', gap: '5px', marginTop: '2px' }}>
                  <span style={{ fontSize: 'var(--t-meta)', color: 'rgba(255,255,255,0.55)', fontWeight: '500' }}>{memberCountLabel(flock)}</span>
                  <span style={{ fontSize: 'var(--t-meta)', color: 'rgba(255,255,255,0.3)' }}>•</span>
                  {/* Reads the live socket, not a literal. The dot and the
                      word both move, so the state is carried by more than a
                      tint, and "reconnecting..." is the truth while socket.io
                      is still retrying: history is already on screen over
                      HTTP, and what is missing is anything said since. A total
                      loss of network is a different thing and OfflineGate
                      covers the whole app for it. */}
                  {isTyping ? <span style={{ fontSize: 'var(--t-meta)', color: '#86EFAC', fontWeight: '500' }}>{typingUser} is typing...</span> : <><span style={{ width: '5px', height: '5px', borderRadius: '3px', backgroundColor: connectionState === 'online' ? '#22c55e' : connectionState === 'offline' ? '#9CA3AF' : '#F59E0B', boxShadow: 'none' }} /><span style={{ fontSize: 'var(--t-meta)', color: 'rgba(255,255,255,0.55)', fontWeight: '500' }}>{connectionState === 'online' ? 'online' : connectionState === 'offline' ? 'offline' : 'reconnecting...'}</span></>}
                </div>
              </div>
            )}
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flex: chatNavOpen ? 1 : 'none', justifyContent: chatNavOpen ? 'center' : 'flex-end', flexShrink: 0 }}>
              {/* COLLAPSED MEANS GONE, NOT NARROW. `maxWidth: 0` with
                  `overflow: hidden` paints nothing and leaves all four
                  buttons focusable, so Tab from the back arrow landed on
                  "Vote on a venue", "Invite friends", "Search messages" and
                  "Group cash pool" while the screen showed a "Features"
                  pill, and VoiceOver read four controls nobody could see.
                  `visibility: hidden` is what takes a subtree out of the
                  accessibility tree AND out of the tab order in one
                  property. The 0.3s delay on the way out is so the slide
                  still reads; on the way in it is 0s so the buttons are
                  focusable the instant they start moving.

                  THE OPEN STATE IS `undefined`, NOT `'visible'`, and that is
                  not a style choice. `visibility` inherits, and an explicit
                  `visible` on a child BEATS a `hidden` ancestor. The first
                  version of this fix wrote `'visible'`, and because the
                  whole Discover screen is held at `visibility: hidden` while
                  another tab is on screen, the same pattern over there put
                  three Discover buttons back into the tab order of every
                  other screen in the app. Leaving the property unset lets
                  the ancestor win. */}
              <div style={{ display: 'flex', gap: '6px', overflow: 'hidden', maxWidth: chatNavOpen ? '300px' : '0px', opacity: chatNavOpen ? 1 : 0, visibility: chatNavOpen ? undefined : 'hidden', transition: `max-width 0.3s ease, opacity 0.25s ease, visibility 0s linear ${chatNavOpen ? '0s' : '0.3s'}` }}>
                <button aria-label="Vote on a venue" className="hit44 glass-btn" onClick={() => { setChatNavOpen(false); setShowVotePanel(true); loadPopularVenues(); }} style={{ width: '36px', height: '36px', minWidth: '36px', borderRadius: '10px', border: '1px solid rgba(255,255,255,0.15)', backgroundColor: flock.status === 'voting' ? colors.steel : 'rgba(255,255,255,0.08)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)', color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Icons.vote('white', 15)}</button>
                <button aria-label="Invite friends" className="hit44 glass-btn" onClick={() => { setChatNavOpen(false); setShowFlockInviteModal(true); setCopiedInviteUrl(''); setFlockInviteSelected([]); setFlockInviteSearch(''); }} style={{ width: '36px', height: '36px', minWidth: '36px', borderRadius: '10px', border: '1px solid rgba(255,255,255,0.15)', backgroundColor: 'rgba(255,255,255,0.08)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)', color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Icons.userPlus('white', 15)}</button>
                <button aria-label="Search messages" className="hit44 glass-btn" onClick={() => { setChatNavOpen(false); setShowChatSearch(!showChatSearch); }} style={{ width: '36px', height: '36px', minWidth: '36px', borderRadius: '10px', border: '1px solid rgba(255,255,255,0.15)', backgroundColor: showChatSearch ? 'rgba(255,255,255,0.25)' : 'rgba(255,255,255,0.08)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)', color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Icons.search('white', 15)}</button>
                <button aria-label="Group cash pool" className="hit44 glass-btn" onClick={() => { setChatNavOpen(false); setShowChatPool(true); }} style={{ width: '36px', height: '36px', minWidth: '36px', borderRadius: '10px', border: '1px solid rgba(255,255,255,0.15)', backgroundColor: 'rgba(255,255,255,0.08)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)', color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Icons.dollar('white', 15)}</button>
              </div>
              <button aria-label="Features" aria-expanded={chatNavOpen} className="hit44" onClick={() => setChatNavOpen(!chatNavOpen)} style={{ height: '42px', minWidth: chatNavOpen ? '42px' : 'auto', width: chatNavOpen ? '42px' : 'auto', borderRadius: '14px', border: '1px solid rgba(255,255,255,0.18)', backgroundColor: chatNavOpen ? 'rgba(255,255,255,0.25)' : 'rgba(255,255,255,0.1)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)', color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px', padding: chatNavOpen ? '0' : '0 18px', fontSize: 'var(--t-body)', fontWeight: '600', flexShrink: 0, transition: 'all 0.3s ease', boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.12)' }}>{chatNavOpen ? Icons.x('white', 16) : <span style={{ fontSize: 'var(--t-body)', fontWeight: '600' }}>Features</span>}</button>
            </div>
            <div style={{ position: 'relative', flexShrink: 0 }}>
              <button aria-label="More options" className="hit44" onClick={() => setShowFlockMenu(!showFlockMenu)} style={{ width: '42px', height: '42px', borderRadius: '14px', border: '1px solid rgba(255,255,255,0.18)', backgroundColor: 'rgba(255,255,255,0.1)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)', color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.12)' }}>{Icons.moreVertical('white', 18)}</button>
              {showFlockMenu && (
                <div style={{ position: 'absolute', top: '38px', right: 0, backgroundColor: 'var(--bg-card-solid)', borderRadius: '14px', boxShadow: '0 8px 24px rgba(0,0,0,0.12)', minWidth: '180px', zIndex: 60, overflow: 'hidden', border: '1px solid var(--border-subtle)' }}>
                  <button className="hit44 glass-btn glass-danger" onClick={() => { setShowFlockMenu(false); setShowLeaveConfirm(true); }} style={{ width: '100%', padding: '14px 16px', display: 'flex', alignItems: 'center', gap: '10px', border: 'none', backgroundColor: 'var(--bg-card-solid)', cursor: 'pointer', fontSize: 'var(--t-body)', fontWeight: '600', color: '#EF4444' }}>
                    {Icons.doorOpen('#EF4444', 16)} Leave Flock
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Dismiss menu on outside tap */}
        {showFlockMenu && (
          <div onClick={() => setShowFlockMenu(false)} style={{ position: 'absolute', inset: 0, zIndex: 55 }} />
        )}

        {/* ── Momentum Meter (compact) ── */}
        {flock.momentum && flock.status !== 'completed' && (() => {
          const m = flock.momentum;
          const stages = MOMENTUM_STAGES;
          const activeIdx = stages.findIndex(s => s.key === momentumStageKey(m));
          const activeColor = stages[activeIdx]?.color || '#94a3b8';
          return (
            <div style={{ padding: '8px 14px 10px', background: 'var(--bg-card-solid)', borderBottom: '1px solid var(--border-subtle)', flexShrink: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' }}>
                <span style={{ fontSize: 'var(--t-micro)', fontWeight: '700', color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Momentum</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)' }}>
                    {m.accepted}/{m.totalMembers} RSVPs
                    {m.hasVenue ? ' · Venue set' : ''}
                    {m.hasTime ? ' · Time set' : ''}
                  </span>
                  <span style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: activeColor }}>{stages[activeIdx]?.label}</span>
                </div>
              </div>
              <div style={{ display: 'flex', gap: '3px', height: '4px' }}>
                {stages.map((s, i) => (
                  <div key={s.key} style={{ flex: 1, borderRadius: '2px', background: i <= activeIdx ? activeColor : 'var(--bg-tertiary)', transition: 'background 0.4s ease' }} />
                ))}
              </div>
            </div>
          );
        })()}

        {/* Chat message search bar */}
        {showChatSearch && (
          <div style={{ padding: '8px 12px', backgroundColor: 'var(--bg-card-solid)', borderBottom: '1px solid var(--border-default)', flexShrink: 0, animation: 'fadeIn 0.2s ease-out' }}>
            <div style={{ position: 'relative' }}>
              <SearchInputLocal aria-label="Search messages in this flock"
                inputRef={chatSearchRef}
                type="text"
                initialValue={chatSearch}
                onCommit={setChatSearch}
                placeholder="Search messages in this flock..."
                style={{ width: '100%', padding: '10px 36px 10px 36px', borderRadius: '20px', border: `2px solid ${chatSearch ? colors.navy : colors.borderDefault}`, fontSize: 'var(--t-label)', outline: 'none', boxSizing: 'border-box', backgroundColor: 'var(--bg-tertiary)', color: 'var(--text-primary)', fontWeight: '500', transition: 'border-color 0.2s' }}
                autoComplete="off"
              />
              <span style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)' }}>{Icons.search(chatSearch ? colors.navy : colors.textTertiary, 14)}</span>
              <button aria-label="Close search" className="hit44" onClick={() => { setShowChatSearch(false); setChatSearch(''); }} style={{ position: 'absolute', right: '8px', top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', padding: '4px' }}>{Icons.x(colors.textTertiary, 16)}</button>
            </div>
            {chatSearch.trim() && (
              <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: '6px 0 0 4px', fontWeight: '500' }}>
                {visibleMessages.length} messages found
              </p>
            )}
          </div>
        )}

        {/* Pinned Venue Banner — shows which venue this flock is at */}
        {flock.venue && flock.venue !== 'TBD' ? (
          <div style={{ padding: '10px 14px', background: `linear-gradient(135deg, ${colors.navy}08, ${colors.steel}12)`, borderBottom: `1px solid ${colors.creamDark}`, flexShrink: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              {flock.venuePhoto ? (
                <img src={flock.venuePhoto} alt="" style={{ width: '52px', height: '52px', borderRadius: '12px', objectFit: 'cover', flexShrink: 0, boxShadow: '0 2px 8px rgba(0,0,0,0.1)' }} onError={onVenuePhotoError} />
              ) : (
                <div style={{ width: '52px', height: '52px', borderRadius: '12px', background: colors.navyBg, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, boxShadow: '0 2px 8px rgba(13,40,71,0.10)' }}>
                  {Icons.mapPin('white', 22)}
                </div>
              )}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <h4 style={{ fontSize: 'var(--t-label)', fontWeight: '600', color: colors.navy, margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{flock.venue}</h4>
                  {flock.venueRating && (
                    <span style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: '#F59E0B', display: 'flex', alignItems: 'center', gap: '2px', flexShrink: 0 }}>
                      {Icons.starFilled('#F59E0B', 12)} {flock.venueRating}
                    </span>
                  )}
                </div>
                {flock.venueAddress && (
                  <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: '2px 0 0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{flock.venueAddress}</p>
                )}
              </div>
              <div style={{ display: 'flex', gap: '4px', flexShrink: 0 }}>
                <button
                  onClick={() => {
                    leaveChatScreen();
                    setVenueDetailReturnTo({ tab: 'chat', screen: 'chatDetail', flockId: selectedFlockId });
                    setCurrentTab('explore');
                    setCurrentScreen('main');
                    if (flock.venueId || flock.venueLat) {
                      setTimeout(() => {
                        if (window.__flockPanToVenue) {
                          window.__flockPanToVenue({ place_id: flock.venueId, lat: flock.venueLat, lng: flock.venueLng, name: flock.venue, address: flock.venueAddress, rating: flock.venueRating, photo_url: flock.venuePhoto });
                        }
                      }, 300);
                    }
                  }}
                  className="hit44 glass-btn glass-primary" style={{ padding: '8px 10px', borderRadius: '10px', border: 'none', background: colors.steel, color: 'white', fontSize: 'var(--t-meta)', fontWeight: '600', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px', boxShadow: '0 1px 2px rgba(30,41,59,0.10)' }}
                >
                  {Icons.mapPin('white', 12)} Map
                </button>
                {isCreator && (
                  <button
                    className="hit44 glass-btn glass-secondary"
                    onClick={() => { leaveChatScreen(); setPickingVenueForCreate(true); setPickingVenueForFlockId(flock.id); setCurrentTab('explore'); setCurrentScreen('main'); }}
                    style={{ padding: '8px 10px', borderRadius: '10px', border: `1px solid ${colors.creamDark}`, background: 'var(--bg-card-solid)', color: colors.navy, fontSize: 'var(--t-meta)', fontWeight: '600', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '3px' }}
                  >
                    Change
                  </button>
                )}
              </div>
            </div>
          </div>
        ) : isCreator ? (
          <button className="hit44"
            onClick={() => { leaveChatScreen(); setPickingVenueForCreate(true); setPickingVenueForFlockId(flock.id); setCurrentTab('explore'); setCurrentScreen('main'); }}
            style={{ margin: '0', padding: '10px 14px', background: `linear-gradient(135deg, var(--bg-primary), var(--bg-card-solid))`, borderBottom: `1px solid ${colors.creamDark}`, border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '10px', width: '100%', flexShrink: 0 }}
          >
            <div style={{ width: '40px', height: '40px', borderRadius: '12px', border: `2px dashed ${colors.steel}`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {Icons.mapPin(colors.steel, 18)}
            </div>
            <div style={{ flex: 1, textAlign: 'left' }}>
              <p style={{ fontSize: 'var(--t-label)', fontWeight: '600', color: colors.navy, margin: 0 }}>Add a Venue</p>
              <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: '1px 0 0' }}>Pick a spot for this flock</p>
            </div>
            <div style={{ color: colors.steel, fontWeight: '700', fontSize: 'var(--t-title)' }}>+</div>
          </button>
        ) : (
          // Everyone used to get "Add a Venue", but the route behind it is
          // creator-only, so for every other member the whole venue-picker flow
          // ended in a 403 that never reached the screen. Voting is the thing
          // they can actually do, so say that instead of offering a dead button.
          <div style={{ margin: '0', padding: '10px 14px', background: `linear-gradient(135deg, var(--bg-primary), var(--bg-card-solid))`, borderBottom: `1px solid ${colors.creamDark}`, display: 'flex', alignItems: 'center', gap: '10px', width: '100%', flexShrink: 0 }}>
            <div style={{ width: '40px', height: '40px', borderRadius: '12px', border: `2px dashed ${colors.steel}`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {Icons.mapPin(colors.steel, 18)}
            </div>
            <div style={{ flex: 1, textAlign: 'left' }}>
              <p style={{ fontSize: 'var(--t-label)', fontWeight: '600', color: colors.navy, margin: 0 }}>No venue yet</p>
              {/* flock.host falls back to the literal string 'Unknown' when the
                  list endpoint has no creator_name, so it is not safe to print
                  as a person's name. */}
              <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: '1px 0 0' }}>{flock.host && flock.host !== 'Unknown' ? `${flock.host} picks the spot. Vote to say where you want to go.` : 'The host picks the spot. Vote to say where you want to go.'}</p>
            </div>
          </div>
        )}

        {/* THE NOTIFICATION ASK, and the only one in the app besides the Enable
            button in Settings.

            It is here because this is the first screen in Flock where a
            notification has an obvious referent. The plan exists, other people
            are on it, and the thing you are waiting for is one of them saying
            yes or picking a bar. That sentence is on screen while the ask is
            made, which is exactly what the prompt fired at cold start did not
            have. iOS gives one prompt per install and a denial is permanent,
            so the OS is only reached from the button below: a "not now" here
            costs nothing and can be asked again, a "no" at the OS cannot.

            Conditions, in order: somebody else is on this plan (a flock of one
            has nothing to notify about), the OS has not already answered, and
            this row has not been dismissed before.

            The copy names only pushes this build actually sends to every
            member of a flock: flock_message from routes/messages.js and
            sockets/handlers.js, and flock_updated / flock_confirmed from
            routes/flocks.js. It does NOT say "when someone RSVPs", because
            flock_rsvp goes to the creator alone and most readers of this row
            are not the creator. */}
        {(flock.memberCount || 1) > 1 && notifStatus !== 'granted' && notifStatus !== 'denied'
          && notifStatus !== 'unsupported' && !notifAskDismissed && (
          <div style={{ padding: '10px 14px', background: 'var(--bg-primary)', borderBottom: `1px solid ${colors.creamDark}`, flexShrink: 0, display: 'flex', alignItems: 'center', gap: '10px' }}>
            <div style={{ width: '36px', height: '36px', borderRadius: '10px', backgroundColor: 'var(--icon-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              {Icons.bell(colors.navy, 18)}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <p style={{ fontSize: 'var(--t-label)', fontWeight: '600', color: colors.navy, margin: 0 }}>Know when they answer</p>
              <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: '1px 0 0' }}>Flock can tell you when someone replies here, or this plan changes.</p>
            </div>
            <button
              className="hit44 glass-btn glass-navy"
              onClick={(e) => {
                confirmClick(e);
                dismissNotifAsk();
                requestNotificationPermission().then((token) => {
                  trackNotificationPermission(token ? 'granted' : getNotificationStatus(), 'chat_banner');
                  if (token) { setNotifStatus('granted'); showToast('Notifications are on.'); }
                  else {
                    setNotifStatus(getNotificationStatus());
                    showToast("Notifications aren't on. Check your device settings.", 'error');
                  }
                }).catch(() => showToast("Notifications aren't on. Check your device settings.", 'error'));
              }}
              style={{ padding: '8px 14px', borderRadius: '12px', border: 'none', background: colors.navyBg, color: 'white', fontSize: 'var(--t-meta)', fontWeight: '600', cursor: 'pointer', flexShrink: 0, position: 'relative', overflow: 'hidden' }}
            >
              Turn on
            </button>
            <button aria-label="Not now" className="hit44" onClick={dismissNotifAsk} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '4px', flexShrink: 0 }}>{Icons.x(colors.textSecondary, 14)}</button>
          </div>
        )}

        {/* Live location sharing banner */}
        {imageViewer && (
          <div className="modal-backdrop" style={{ position: 'fixed', inset: 0, zIndex: 400, backgroundColor: 'rgba(6,16,31,0.92)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' }}>
          <DialogBehavior onClose={() => setImageViewer(null)} label="Photo" />
            <button aria-label="Close photo" className="hit44" onClick={() => setImageViewer(null)} style={{ position: 'absolute', top: 'calc(env(safe-area-inset-top, 0px) + 14px)', right: '14px', width: '40px', height: '40px', borderRadius: '20px', border: 'none', background: 'rgba(255,255,255,0.16)', color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1 }}>{Icons.x('white', 18)}</button>
            {imageViewer.src ? (
              <img src={imageViewer.src} alt="Full size" style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', borderRadius: '10px' }} />
            ) : (
              <p role="status" style={{ color: 'white', fontSize: 'var(--t-body)', textAlign: 'center' }}>{imageViewer.error || 'Loading the full photo\u2026'}</p>
            )}
          </div>
        )}

        {locBannerAsk && (
          <div style={{ padding: '10px 14px', background: 'linear-gradient(135deg, #ecfdf5, #d1fae5)', borderBottom: '1px solid #a7f3d0', flexShrink: 0, display: 'flex', alignItems: 'center', gap: '10px', animation: 'fadeIn 0.3s ease-out' }}>
            <div style={{ width: '36px', height: '36px', borderRadius: '18px', background: 'linear-gradient(135deg, #10b981, #059669)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, boxShadow: '0 2px 8px rgba(16,185,129,0.3)' }}>
              {Icons.mapPin('white', 18)}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <p style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: 'var(--accent-green-text)', margin: 0 }}>Share your location with the group?</p>
              <p style={{ fontSize: 'var(--t-meta)', color: 'var(--accent-green-text)', margin: '1px 0 0' }}>Members can see where everyone is on the map</p>
            </div>
            <button className="hit44 glass-btn glass-primary" onClick={(e) => { confirmClick(e); startSharingLocation(flock.id); }} style={{ padding: '6px 12px', borderRadius: '14px', border: 'none', background: '#10b981', color: 'white', fontSize: 'var(--t-meta)', fontWeight: '600', cursor: 'pointer', flexShrink: 0, position: 'relative', overflow: 'hidden' }}>Share</button>
            <button aria-label="Dismiss" className="hit44" onClick={() => { setLocationBannerDismissed(prev => { const next = { ...prev, [flock.id]: flock.eventTime || true }; localStorage.setItem('flock_loc_dismissed', JSON.stringify(next)); return next; }); }} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '4px', flexShrink: 0 }}>{Icons.x(colors.textSecondary, 14)}</button>
          </div>
        )}

        {/* Active location sharing indicator */}
        {sharingLocationForFlock === flock.id && (
          <div style={{ padding: '8px 14px', background: 'linear-gradient(135deg, #059669, #047857)', flexShrink: 0, display: 'flex', alignItems: 'center', gap: '8px' }}>
            <div style={{ width: '8px', height: '8px', borderRadius: '4px', backgroundColor: '#34d399', animation: 'pulse 2s ease-in-out infinite', boxShadow: 'none' }} />
            <p style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: 'white', margin: 0, flex: 1 }}>Sharing location with {flock.name}</p>
            {Object.keys(flockMemberLocations).length > 0 && (
              <span style={{ fontSize: 'var(--t-meta)', color: '#a7f3d0', fontWeight: '500' }}>{Object.keys(flockMemberLocations).length} sharing</span>
            )}
            <button className="hit44" onClick={stopLocationSharing} style={{ padding: '4px 10px', borderRadius: '10px', border: '1px solid rgba(255,255,255,0.3)', background: 'rgba(255,255,255,0.15)', color: 'white', fontSize: 'var(--t-meta)', fontWeight: '600', cursor: 'pointer' }}>Stop</button>
          </div>
        )}

        {/* Budget status bar */}
        {flock.budgetEnabled && budgetStatus && (
          <div role="button" tabIndex={0} aria-label="Open group cash pool" onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setShowChatPool(true); } }} onClick={() => setShowChatPool(true)} style={{ padding: '8px 14px', background: `linear-gradient(135deg, ${colors.steel}08, ${colors.steel}15)`, borderBottom: `1px solid ${colors.steel}25`, flexShrink: 0, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              {Icons.dollar(colors.steel, 13)}
              {budgetStatus.ceiling ? (
                /* A ceiling only exists here once the budget is settled, so
                   there is no "up to, for now" state left to describe. */
                <p style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: colors.navy, margin: 0 }}>
                  Group budget: up to
                  <span style={{ color: colors.steel, fontWeight: '700' }}> ${budgetStatus.ceiling}</span>
                  <span style={{ color: 'var(--text-secondary)', fontWeight: '500' }}> per person</span>
                </p>
              ) : (
                /* "Waiting for budgets, 2 of 2 submitted" told a two-person
                   flock it was waiting on itself. Three amounts is the floor,
                   and a flock that cannot reach it is not waiting. */
                <p style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: 'var(--text-secondary)', margin: 0 }}>
                  {(budgetStatus.totalMembers || 0) > 0 && (budgetStatus.totalMembers || 0) < 3
                    ? 'No group number in a flock this size'
                    : `Waiting on amounts · ${budgetStatus.submissionCount || 0} of ${budgetStatus.totalMembers || '?'} answered`}
                </p>
              )}
            </div>
            {/* Was arrowLeft at 10px: a LEFT-pointing arrow as the "opens a
                sheet" affordance on a forward-navigating row. chevronRight is
                the disclosure mark the rest of the app uses. */}
            <span style={{ fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)' }}>{Icons.chevronRight(colors.textTertiary, 12)}</span>
          </div>
        )}

        {/* Ghost Mode Card — after venue confirmed, before bill created */}
        {flock.status === 'confirmed' && flock.budgetEnabled && flock.ghostModeEnabled && budgetStatus?.ceiling && !billSplit && (
          <div style={{ padding: '10px 14px', background: `linear-gradient(135deg, ${colors.amber}08, ${colors.amber}15)`, borderBottom: `1px solid ${colors.amber}25`, flexShrink: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: colors.navy, margin: '0 0 2px' }}>Lock in your share?</p>
                <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: 0 }}>Pre-commit ${budgetStatus.ceiling} to tonight's plan</p>
              </div>
              <button className="hit44 glass-btn glass-navy" onClick={async () => {
                try {
                  await ghostCommit(selectedFlockId);
                  showToast('Committed');
                } catch (err) { showToast(err.message, 'error'); }
              }} style={{ padding: '6px 14px', borderRadius: '14px', border: 'none', background: colors.navyMidBg, color: 'white', fontSize: 'var(--t-meta)', fontWeight: '600', cursor: 'pointer', flexShrink: 0 }}>
                Commit ${budgetStatus.ceiling}
              </button>
            </div>
          </div>
        )}

        {/* Bill summary bar — shows when bill exists */}
        {billSplit && (
          <div role="button" tabIndex={0} aria-label="Open bill split details" onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setShowChatPool(true); } }} onClick={() => setShowChatPool(true)} style={{ padding: '8px 14px', background: billSplit.shares?.every(s => s.settled) ? 'linear-gradient(135deg, #ecfdf5, #d1fae5)' : `linear-gradient(135deg, ${colors.navy}06, ${colors.navy}12)`, borderBottom: '1px solid var(--divider)', flexShrink: 0, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              {Icons.dollar(billSplit.shares?.every(s => s.settled) ? '#22C55E' : colors.navy, 13)}
              <p style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: colors.navy, margin: 0 }}>
                {billSplit.shares?.every(s => s.settled)
                  ? 'All settled up'
                  : `Bill: $${billSplit.totalWithTip?.toFixed(2)} · ${billSplit.shares?.filter(s => s.settled).length}/${billSplit.shares?.length} settled`}
              </p>
            </div>
            <span style={{ fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)' }}>View</span>
          </div>
        )}

        <div onScroll={(e) => {
          const el = document.activeElement;
          if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) el.blur();
          const c = e.currentTarget;
          const fromBottom = c.scrollHeight - c.scrollTop - c.clientHeight;
          setShowJumpPill((prev) => (prev ? fromBottom > 200 : fromBottom > 600));
        }} style={{ flex: 1, padding: '16px', overflowY: 'auto', overflowX: 'hidden', background: `linear-gradient(180deg, ${colors.cream} 0%, ${colors.cream}cc 100%)`, scrollBehavior: 'smooth' }}>
          {showChatSearch && chatSearch.trim() && flock.messages.filter(m => {
            const q = chatSearch.toLowerCase();
            return (m.text || '').toLowerCase().includes(q) || (m.sender || '').toLowerCase().includes(q);
          }).length === 0 && (
            <div style={{ textAlign: 'center', padding: '40px 20px' }}>
              <BirdieStill bird={WARM_BIRD} size={72} style={{ margin: '0 auto 8px' }} />
              <p style={{ fontSize: 'var(--t-body)', color: 'var(--text-tertiary)', fontWeight: '500' }}>No messages match "{chatSearch}"</p>
            </div>
          )}

          {/* The history is on the wire. Bubbles in the shape of bubbles beat
              the blank rectangle this used to be, and the empty state below
              stays gated so it can never claim an empty chat during a fetch. */}
          {messagesLoading && flock.messages.length === 0 && <ChatSkeleton label={`Loading messages in ${flock.name}`} />}

          {/* Scrollback, same contract as the DM thread. */}
          {!messagesLoading && !(showChatSearch && chatSearch.trim()) && !flockAtTop[flock.id] && flock.messages.length >= DM_PAGE_SIZE && (
            <div style={{ textAlign: 'center', marginBottom: '14px' }}>
              <button
                className="hit44"
                disabled={olderLoading}
                onClick={() => loadOlderFlockMessages(flock.id, oldestServerId(flock.messages))}
                style={{ padding: '8px 14px', borderRadius: '14px', border: '1px solid var(--border-default)', backgroundColor: 'var(--bg-card-solid)', color: colors.navy, fontSize: 'var(--t-meta)', fontWeight: '600', cursor: olderLoading ? 'default' : 'pointer', opacity: olderLoading ? 0.6 : 1 }}
              >
                {olderLoading ? 'Loading' : 'Load earlier messages'}
              </button>
            </div>
          )}

          {/* A brand-new flock lands you here with nothing on screen at all,
              which is the first thing anyone sees after creating one. Say what
              this room is for and give the two openers. */}
          {!messagesLoading && flock.messages.length === 0 && !(showChatSearch && chatSearch.trim()) && (
            <div style={{ textAlign: 'center', padding: '40px 24px 48px' }}>
              {/* The warm bird, not cobalt: in this app cobalt Birdie IS the
                  AI, and his photo on a human chat's first screen would read
                  as "the assistant lives here". The cream bird is the brand
                  without that promise. Still image — this is a screen people
                  live in, and it also replaced an icon-in-rounded-square. */}
              <BirdieStill bird={WARM_BIRD} size={96} style={{ margin: '0 auto 10px' }} />
              <p style={{ fontSize: 'var(--t-body)', fontWeight: '600', color: colors.navy, margin: '0 0 4px' }}>Nothing here yet</p>
              <p style={{ fontSize: 'var(--t-label)', color: 'var(--text-secondary)', margin: '0 0 16px', lineHeight: '1.5' }}>
                This is where {flock.name} gets sorted out. Say hi, or put a place on the table for everyone to vote on.
              </p>
              <div style={{ display: 'flex', gap: '8px', justifyContent: 'center', flexWrap: 'wrap' }}>
                <button className="hit44 glass-btn glass-navy" onClick={() => { setShowFlockInviteModal(true); setCopiedInviteUrl(''); setFlockInviteSelected([]); setFlockInviteSearch(''); }} style={{ padding: '10px 16px', borderRadius: '12px', border: 'none', background: colors.navyMidBg, color: 'white', fontSize: 'var(--t-label)', fontWeight: '600', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px' }}>
                  {Icons.userPlus('white', 14)} Invite friends
                </button>
                <button className="hit44 glass-btn glass-secondary" onClick={() => { setShowVotePanel(true); loadPopularVenues(); }} style={{ padding: '10px 16px', borderRadius: '12px', border: `1.5px solid ${colors.creamDark}`, backgroundColor: 'var(--bg-card-solid)', color: colors.navy, fontSize: 'var(--t-label)', fontWeight: '600', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px' }}>
                  {Icons.mapPin(colors.navy, 14)} Suggest a place
                </button>
              </div>
            </div>
          )}
          {visibleMessages.map((m, idx) => {
            const separatorLabel = daySeparatorFor(visibleMessages, idx);
            return (
            <React.Fragment key={m.id}>
                {separatorLabel && (
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '4px 0 16px' }}>
                    <span style={{ fontSize: 'var(--t-meta)', fontWeight: '600', color: 'var(--text-tertiary)', background: 'var(--bg-hover)', padding: '3px 12px', borderRadius: '10px' }}>{separatorLabel}</span>
                  </div>
                )}
            <div
              style={{
                display: 'flex',
                gap: '10px',
                marginBottom: '16px',
                flexDirection: m.sender === 'You' ? 'row-reverse' : 'row',
                position: 'relative',
                animation: 'fadeIn 0.3s ease-out'
              }}
            >
              <div style={{ position: 'relative', flexShrink: 0 }}>
                <div style={{ width: '34px', height: '34px', borderRadius: '17px', background: m.sender === 'You' ? colors.navyBg : 'white', border: m.sender === 'You' ? 'none' : '2px solid rgba(13,40,71,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 'var(--t-meta)', fontWeight: '500', color: m.sender === 'You' ? 'white' : colors.navy, boxShadow: m.sender === 'You' ? '0 3px 10px rgba(13,40,71,0.10)' : '0 2px 6px rgba(0,0,0,0.06)', overflow: 'hidden' }}>
                  {(() => {
                    const raw = m.sender === 'You' ? profilePic : (m.senderImage || memberImageByName.get(m.sender) || null);
                    const imgUrl = raw ? (raw.startsWith('/uploads/') ? `${BASE_URL}${raw}` : raw) : null;
                    return imgUrl ? <img src={imgUrl} alt="" style={{ width: '34px', height: '34px', borderRadius: '17px', objectFit: 'cover' }} /> : m.sender[0];
                  })()}
                </div>
                {/* The green dot that sat here was painted on whichever
                    message happened to be first in the loaded page, wired to
                    no presence data at all. A fabricated online claim is the
                    header lie 9d87b73 removed, in miniature. */}
              </div>
              {/* Dimmed while in flight, same as the DM bubble. */}
              <div style={{ maxWidth: '72%', display: 'inline-flex', flexDirection: 'column', alignItems: m.sender === 'You' ? 'flex-end' : 'flex-start', opacity: m.pending ? 0.6 : 1, transition: 'opacity 0.2s ease' }}>
                {/* Sender name and timestamp */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px', padding: '0 4px' }}>
                  <span style={{ fontSize: 'var(--t-meta)', color: colors.navy, fontWeight: '500' }}>{m.sender}</span>
                  <span style={{ fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)' }}>•</span>
                  <span style={{ fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)', fontWeight: '500' }}>{m.pending ? 'Sending' : (m.time || getRelativeTime(m.time))}</span>
                </div>
                {m.failed && (
                  <div role="alert">
                    {/* role="alert" on a wrapper, not on the button: a button
                        that claims the alert role stops announcing as a
                        button. This text arrives on an eight second timeout
                        with no keypress behind it, so without a region a
                        screen reader user is left believing it sent. */}
                  <button className="hit44" onClick={() => retryFailedMessage(flock.id, m)} style={{ background: 'none', border: 'none', padding: '0 4px 4px', cursor: 'pointer', fontSize: 'var(--t-meta)', fontWeight: '600', color: 'var(--accent-red-text, #b91c1c)', display: 'flex', alignItems: 'center', gap: '4px' }}>
                    Didn't send. Tap to retry
                  </button>
                  </div>
                )}

                {/* Image message. Photos used to be cropped into a fixed
                    200x150 letterbox, so a portrait shot arrived with its top
                    and bottom cut off. They now run as large as the row allows
                    and keep their own shape. Tapping still opens the reaction
                    and report row, which is a 1.2 requirement. */}
                {(m.image || m.thumb) && (
                  /* A button, not a div-with-onClick: the tap opens the
                     reaction and report row (a 1.2 requirement), and a
                     pointer-only door locks VoiceOver and keyboard users out
                     of reacting to and reporting this exact message. The
                     button's accessible name is the img alt. */
                  <button
                    type="button"
                    onClick={() => setShowReactionPicker(showReactionPicker === m.id ? null : m.id)}
                    style={{ borderRadius: '18px', overflow: 'hidden', boxShadow: '0 4px 15px rgba(0,0,0,0.1)', marginBottom: '4px', cursor: 'pointer', lineHeight: 0, padding: 0, border: 'none', background: 'none', display: 'block' }}
                  >
                    {/* Thumb first: history ships only the thumbnail for new
                        rows (the full image would be re-downloaded at ~700KB
                        to paint a 260px box). Legacy rows still carry the
                        full image and render exactly as before. */}
                    <img src={m.thumb || m.image} alt={`From ${m.sender}`} loading="lazy" style={{ width: '100%', maxWidth: '260px', maxHeight: '340px', objectFit: 'cover', display: 'block' }} />
                  </button>
                )}

                {/* Venue Card message. Wrapped in the same tap target the text
                    bubbles and photos use, so a venue card posted into a chat
                    can be reported too. Its own buttons stop propagation. */}
                {m.message_type === 'venue_card' && m.venue_data && (
                  <div
                    onClick={() => setShowReactionPicker(showReactionPicker === m.id ? null : m.id)}
                    style={{ cursor: 'pointer' }}
                  >
                  <VenueCard
                    venue={m.venue_data}
                    colors={colors}
                    Icons={Icons}
                    getCategoryColor={getCategoryColor}
                    onViewDetails={() => {
                      const vc = m.venue_data;
                      const pid = vc.place_id;
                      if (pid) {
                        leaveChatScreen();
                        setVenueDetailReturnTo({ tab: 'chat', screen: 'chatDetail', flockId: selectedFlockId });
                        setCurrentTab('explore');
                        setCurrentScreen('main');
                        setTimeout(() => {
                          openVenueDetail(pid, { name: vc.name, formatted_address: vc.addr || vc.formatted_address, place_id: pid, rating: vc.stars || vc.rating, photo_url: vc.photo_url }, { panMap: true });
                        }, 500);
                      }
                    }}
                    onVote={() => {
                      const current = flock.votes || [];
                      const existingVote = current.find(v => v.venue === m.venue_data.name);
                      if (existingVote) {
                        const newVotes = current.map(v => ({
                          ...v,
                          voters: v.venue === m.venue_data.name
                            ? (v.voters.includes('You') ? v.voters : [...v.voters, 'You'])
                            : v.voters.filter(x => x !== 'You')
                        }));
                        updateFlockVotes(selectedFlockId, newVotes);
                      } else {
                        // Moving your vote here takes it off whatever you picked before
                        const newVotes = [
                          ...current.map(v => ({ ...v, voters: v.voters.filter(x => x !== 'You') })),
                          { venue: m.venue_data.name, type: m.venue_data.type, place_id: m.venue_data.place_id || null, voters: ['You'] },
                        ];
                        updateFlockVotes(selectedFlockId, newVotes);
                      }
                    }}
                  />
                  </div>
                )}

                {/* Regular text message */}
                {m.text && m.message_type !== 'venue_card' && (
                  /* Same conversion as the photo above: the reactions and the
                     per-message report live behind this tap. No aria-label on
                     purpose: a button's name is its content, and the content
                     is the message. */
                  <button
                    type="button"
                    onClick={() => setShowReactionPicker(showReactionPicker === m.id ? null : m.id)}
                    style={{
                      borderRadius: '18px',
                      padding: '8px 12px',
                      display: 'inline-block',
                      textAlign: 'left',
                      font: 'inherit',
                      background: m.sender === 'You' ? (isDark ? '#2d5a87' : colorsLight.navy) : 'var(--msg-received-bg)',
                      color: m.sender === 'You' ? 'white' : 'var(--msg-received-text)',
                      borderBottomRightRadius: m.sender === 'You' ? '4px' : '18px',
                      borderBottomLeftRadius: m.sender === 'You' ? '18px' : '4px',
                      boxShadow: m.sender === 'You' ? '0 3px 12px rgba(13,40,71,0.10)' : '0 2px 10px rgba(0,0,0,0.05)',
                      border: m.sender === 'You' ? 'none' : 'var(--card-border)',
                      cursor: 'pointer',
                      position: 'relative',
                      transition: 'transform 0.15s ease, box-shadow 0.15s ease'
                    }}
                  >
                    {/* overflowWrap: 'anywhere', same reason as the DM bubble:
                        a message with nowhere to break used to widen the row
                        past the phone and give the whole chat a horizontal
                        scrollbar. */}
                    <p style={{ fontSize: 'var(--t-body)', lineHeight: '1.45', margin: 0, fontWeight: '500', overflowWrap: 'anywhere' }}>{showChatSearch && chatSearch.trim() && m.text && m.text.toLowerCase().includes(chatSearch.toLowerCase()) ? (() => {
                      const q = chatSearch.toLowerCase();
                      const i = m.text.toLowerCase().indexOf(q);
                      return <>{m.text.slice(0, i)}<mark style={{ backgroundColor: 'var(--search-highlight)', color: 'inherit', borderRadius: '2px', padding: '0 1px' }}>{m.text.slice(i, i + chatSearch.length)}</mark>{m.text.slice(i + chatSearch.length)}</>;
                    })() : m.text}</p>
                    {/* The double-check receipt used to sit under every one of
                        your own bubbles and under every conversation preview.
                        It said the same thing on every row and cost a line of
                        height each time, so it is gone from all three places.
                        A send that fails still says so, once, in a toast. */}
                  </button>
                )}

                {/* Reaction picker */}
                {showReactionPicker === m.id && (
                  <div style={{
                    display: 'flex',
                    gap: '4px',
                    marginTop: '6px',
                    padding: '6px 10px',
                    backgroundColor: 'var(--bg-card-solid)',
                    borderRadius: '24px',
                    boxShadow: '0 2px 8px rgba(0,0,0,0.10)',
                    animation: 'reactionPop 0.25s ease-out'
                  }}>
                    {reactions.map(r => (
                      <button aria-label={`React with ${r}`} className="hit44"
                        key={r}
                        onClick={(e) => { e.stopPropagation(); addReactionToMessage(flock.id, m.id, r); }}
                        style={{
                          background: 'none',
                          border: 'none',
                          fontSize: 'var(--t-title)',
                          cursor: 'pointer',
                          padding: '6px',
                          borderRadius: '10px',
                          transition: 'transform 0.15s ease, background-color 0.15s ease'
                        }}
                      >{r}</button>
                    ))}
                    {(m.image || m.thumb) && (
                      <button aria-label="View photo full size" className="hit44" onClick={(e) => { e.stopPropagation(); setShowReactionPicker(null); openImageViewer(m); }} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '6px', display: 'flex', alignItems: 'center', borderRadius: '10px' }} title="View photo">{Icons.eye(colors.textSecondary, 15)}</button>
                    )}
                    {m.sender !== 'You' && (
                      <button aria-label="Report" className="hit44" onClick={(e) => { e.stopPropagation(); setShowReactionPicker(null); setModerationTarget({ userId: m.senderId, userName: m.sender, contentType: 'flock_message', contentId: m.id }); }} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '6px', display: 'flex', alignItems: 'center', borderRadius: '10px', fontSize: 'var(--t-body)', color: '#EF4444' }} title="Report">{Icons.flag('#EF4444', 15)}</button>
                    )}
                  </div>
                )}

                {/* Reactions display.
                    Grouped by emoji, because the server sends one ROW per
                    person ({ emoji, user_id, user_name }) and this used to map
                    straight over those rows: four people reacting with the same
                    heart drew four separate pills, each hardcoded to say "1".
                    The count is now the number of people, and the pill is a
                    button, so a reaction can be taken back by tapping it rather
                    than only through the picker. Yours is outlined. */}
                {m.reactions && m.reactions.length > 0 && (
                  <div style={{ display: 'flex', gap: '4px', marginTop: '6px', flexWrap: 'wrap' }}>
                    {groupReactions(m.reactions).map((g) => {
                      const mine = g.userIds.some((id) => String(id) === String(authUser?.id));
                      return (
                        <button
                          key={g.emoji}
                          type="button"
                          className="reaction-pop hit44"
                          aria-pressed={mine}
                          aria-label={`${g.emoji} ${g.count}${mine ? ', including you. Tap to remove your reaction' : '. Tap to react'}`}
                          onClick={(e) => { e.stopPropagation(); addReactionToMessage(flock.id, m.id, g.emoji); }}
                          style={{
                            fontSize: 'var(--t-body)',
                            backgroundColor: 'var(--bg-card-solid)',
                            borderRadius: '14px',
                            padding: '4px 8px',
                            boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
                            border: mine ? `1px solid ${colors.steel}` : '1px solid var(--border-subtle)',
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '4px',
                            cursor: 'pointer',
                            minHeight: 'auto',
                          }}
                        >
                          {g.emoji}
                          <span style={{ fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)', fontWeight: '500' }}>{g.count}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
            </React.Fragment>
            );
          })}

          {/* Enhanced typing indicator with user name — fixed height to prevent layout shift */}
          {/* `visibility` as well as opacity, because opacity 0 still leaves
              the name and the bubble in the accessibility tree: VoiceOver
              read a phantom "Someone" at the bottom of every quiet chat. The
              58px box stays reserved either way, so nothing shifts. */}
          <div style={{ height: '58px', overflow: 'hidden', opacity: isTyping ? 1 : 0, visibility: isTyping ? undefined : 'hidden', transition: `opacity 0.2s ease, visibility 0s linear ${isTyping ? '0s' : '0.2s'}`, pointerEvents: isTyping ? 'auto' : 'none' }}>
            <div style={{ display: 'flex', gap: '10px' }}>
              <div style={{ width: '34px', height: '34px', borderRadius: '17px', backgroundColor: 'var(--bg-card-solid)', border: '2px solid var(--border-subtle)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 'var(--t-meta)', fontWeight: '500', color: colors.navy }}>{typingUser?.[0] || 'A'}</div>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
                <span style={{ fontSize: 'var(--t-meta)', color: colors.navy, fontWeight: '500', marginBottom: '4px', paddingLeft: '4px' }}>{typingUser || 'Someone'}</span>
                <div style={{ padding: '12px 16px', backgroundColor: 'var(--bg-card-solid)', borderRadius: '18px', borderBottomLeftRadius: '4px', boxShadow: '0 2px 10px rgba(0,0,0,0.05)', display: 'flex', alignItems: 'center', gap: '3px' }}>
                  <div style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: colors.navyBg, animation: 'typingDot 1.4s ease-in-out infinite', opacity: 0.7 }} />
                  <div style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: colors.navyBg, animation: 'typingDot 1.4s ease-in-out 0.2s infinite', opacity: 0.7 }} />
                  <div style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: colors.navyBg, animation: 'typingDot 1.4s ease-in-out 0.4s infinite', opacity: 0.7 }} />
                </div>
              </div>
            </div>
          </div>
          {showJumpPill && (
            <div style={{ position: 'sticky', bottom: '8px', display: 'flex', justifyContent: 'center', zIndex: 5, pointerEvents: 'none' }}>
              <button className="hit44" onClick={() => chatEndRef?.current?.scrollIntoView({ behavior: 'smooth' })} style={{ pointerEvents: 'auto', display: 'flex', alignItems: 'center', gap: '6px', padding: '8px 14px', borderRadius: '18px', border: '1px solid var(--border-default)', background: 'var(--bg-card-solid)', color: colors.navy, fontSize: 'var(--t-meta)', fontWeight: '600', cursor: 'pointer', boxShadow: '0 4px 14px rgba(0,0,0,0.14)' }}>
                {Icons.chevronDown(colors.navy, 14)} Jump to latest
              </button>
            </div>
          )}
          <div ref={chatEndRef} />
        </div>

        {/* Reply bar */}
        {/* The "Replying to" bar sat here until 2026-08-27. It was the
            sender-facing half of a reply feature whose other half never
            existed on the flock side; see the removal note in App.js. */}

        {/* Image preview bar */}
        {showImagePreview && pendingImage && (
          <div style={{ padding: '12px 16px', backgroundColor: 'var(--bg-tertiary)', borderTop: '1px solid var(--border-subtle)', display: 'flex', alignItems: 'center', gap: '12px', animation: 'slideUp 0.2s ease-out' }}>
            <div style={{ position: 'relative' }}>
              <img src={pendingImage} alt="Preview" style={{ width: '60px', height: '60px', objectFit: 'cover', borderRadius: '12px', boxShadow: '0 2px 8px rgba(0,0,0,0.1)' }} />
              <button aria-label="Remove photo" className="hit44"
                onClick={() => { setPendingImage(null); setShowImagePreview(false); }}
                style={{ position: 'absolute', top: '-6px', right: '-6px', width: '22px', height: '22px', borderRadius: '11px', backgroundColor: colors.red, border: '2px solid var(--bg-card-solid)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
              >
                {Icons.x('white', 12)}
              </button>
            </div>
            <div style={{ flex: 1 }}>
              <p style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: colors.navy, margin: 0 }}>Ready to send</p>
              <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: '2px 0 0' }}>Type a caption below if you want one</p>
            </div>
            <button aria-label="Send photo" className="hit44"
              onClick={() => shareImageToChat(selectedFlockId)}
              style={{
                width: '44px',
                height: '44px',
                borderRadius: '22px',
                border: 'none',
                background: colors.navyBg,
                color: 'white',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                boxShadow: '0 3px 10px rgba(13,40,71,0.10)'
              }}
            >
              {Icons.send('white', 18)}
            </button>
          </div>
        )}

        {/* Input area */}
        {/* Flock chat composer. This screen has no tab bar, so the composer sits
            on the physical screen edge and carries the home-indicator inset. */}
        <div style={{ padding: '10px 12px calc(10px + var(--safe-bottom))', backgroundColor: 'var(--bg-nav)', backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)', borderTop: '1px solid var(--border-subtle)', display: 'flex', gap: '8px', alignItems: 'center', flexShrink: 0, boxShadow: 'var(--nav-shadow)' }}>
          {/* Two taps became one. The camera button used to open an "Add
              Photo" sheet whose only job was to ask camera or library; the
              library input was rendered but nothing outside that sheet ever
              opened it. Both routes now sit in the composer, and the camera
              screen itself carries a library button too. */}
          <button aria-label="Take a photo" className="hit44" onClick={() => openCameraViewfinder('flock')} style={{ width: '36px', height: '36px', borderRadius: '18px', border: 'none', backgroundColor: 'var(--bg-hover)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'opacity 0.2s ease', flexShrink: 0 }}>
            {Icons.camera(colors.textSecondary, 18)}
          </button>
          <button aria-label="Choose a photo from your library" className="hit44" onClick={() => chatGalleryInputRef.current?.click()} style={{ width: '36px', height: '36px', borderRadius: '18px', border: 'none', backgroundColor: 'var(--bg-hover)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'opacity 0.2s ease', flexShrink: 0 }}>
            {Icons.image(colors.textSecondary, 18)}
          </button>
          <input ref={chatGalleryInputRef} type="file" accept="image/*" onChange={handleChatImageSelect} style={{ display: 'none' }} />
          <button aria-label={sharingLocationForFlock === flock.id ? 'Stop sharing your location' : 'Share your location'} aria-pressed={sharingLocationForFlock === flock.id} className="hit44" onClick={() => { if (sharingLocationForFlock === flock.id) { stopLocationSharing(); } else { const otherMembers = (flock.members || []).filter(m => m.id !== authUser?.id).length; if (otherMembers === 0) { showToast('No one else in this flock to share with', 'error'); return; } startSharingLocation(flock.id); } }} style={{ width: '38px', height: '38px', borderRadius: '19px', border: 'none', backgroundColor: sharingLocationForFlock === flock.id ? '#10b981' : 'var(--bg-hover)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'opacity 0.2s ease', flexShrink: 0 }}>{Icons.mapPin(sharingLocationForFlock === flock.id ? 'white' : colors.textSecondary, 16)}</button>
          {/* minWidth:0 is load-bearing. A text input's `min-width: auto`
              resolves to its intrinsic ~20-character width (~215px), so at
              390px the row's min-content exceeded the viewport, the input
              refused to shrink, and the overflow was pushed onto the only
              flex item that could still shrink: the send button. It measured
              20px wide with its right edge 7px off-screen. */}
          <input key="chat-input" id="chat-input" aria-label="Message" type="text" defaultValue="" onChange={(e) => { setComposerHasRealText(e.target.value.trim().length > 0); handleChatInputChange(e); }} onKeyDown={(e) => { if (e.key === 'Enter' && canSendComposerText) sendChatMessage(); }} placeholder="Type a message..." style={{ flex: '1 1 0%', minWidth: 0, padding: '15px 18px', borderRadius: '24px', backgroundColor: 'var(--bg-hover)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)', fontSize: '16px', outline: 'none', fontWeight: '500', transition: 'opacity 0.2s ease' }} autoComplete="off" />
          {/* The mic button that lived here only toasted "coming soon" (dead
              button, SLOP-AUDIT.md C1). The send button now stays put and
              disables when there is nothing sendable in the input. Spaces are
              nothing: armed on a box holding only spaces, this button lit up
              and sendChatMessage's own `.trim()` guard then dropped the tap
              without a word. See canSendComposerText above. */}
          <button aria-label="Send message" className="hit44 glass-btn glass-navy" onClick={sendChatMessage} disabled={!canSendComposerText} style={{ width: '42px', height: '42px', minWidth: '42px', flexShrink: 0, borderRadius: '21px', border: 'none', background: colors.navyBg, color: 'white', cursor: canSendComposerText ? 'pointer' : 'default', opacity: canSendComposerText ? 1 : 0.45, display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 3px 10px rgba(13,40,71,0.10)', transition: 'opacity 0.2s ease' }}>{Icons.send('white', 18)}</button>
        </div>


        {/* Money Layer Modal — Budget Submit / Bill Split */}
        {showChatPool && (() => {
          const isCreator = flock.creatorId && String(flock.creatorId) === String(authUser?.id);
          const isConfirmedOrComplete = flock.status === 'confirmed' || flock.status === 'completed';
          const hasBudget = flock.budgetEnabled;
          const ctx = budgetStatus?.budgetContext || flock.budgetContext || 'dinner';
          const presets = ctx?.includes('movie') || ctx?.includes('film') ? [15, 25, 35, 50]
            : ctx?.includes('drink') || ctx?.includes('bar') ? [15, 30, 50, 75]
            : ctx?.includes('bowling') || ctx?.includes('activity') || ctx?.includes('arcade') ? [10, 20, 30, 50]
            : ctx?.includes('concert') ? [30, 50, 75, 100]
            : [20, 40, 60, 80];
          const userSubmitted = budgetStatus?.userSubmitted;
          const showBillCreate = isConfirmedOrComplete || billSplit;

          return (
            <div className="modal-backdrop" style={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'flex-end', zIndex: 50 }}>
            <DialogBehavior onClose={() => { setShowChatPool(false); setShowCreateBill(false); }} label="Cash pool" />
              <div className="modal-content" style={{ backgroundColor: 'var(--bg-card-solid)', borderRadius: '20px 20px 0 0', padding: '20px', width: '100%', maxHeight: '85%', overflowY: 'auto' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                  <h2 style={{ fontSize: 'var(--t-title)', fontWeight: '700', color: colors.navy, margin: 0 }}>{showBillCreate && !hasBudget ? 'Split the Bill' : hasBudget ? 'Group Budget' : 'Split the Bill'}</h2>
                  <button aria-label="Close" className="hit44" onClick={() => { setShowChatPool(false); setShowCreateBill(false); }} style={{ width: '32px', height: '32px', borderRadius: '16px', backgroundColor: 'var(--bg-hover)', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Icons.x(colors.textSecondary, 18)}</button>
                </div>

                {/* Budget Submission Section */}
                {hasBudget && !budgetStatus?.budgetLocked && !userSubmitted && !showCreateBill && (
                  <div>
                    <p style={{ fontSize: 'var(--t-body)', fontWeight: '600', color: colors.navy, margin: '0 0 4px' }}>What's your budget tonight?</p>
                    {ctx && <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: '0 0 14px' }}>For {ctx}</p>}
                    <div style={{ display: 'flex', gap: '8px', marginBottom: '12px' }}>
                      {presets.map(p => (
                        <button key={p} className="hit44 glass-btn glass-secondary" aria-pressed={budgetAmount === p} onClick={() => { setBudgetAmount(p); setBudgetCustom(''); }}
                          style={{ flex: 1, padding: '12px 4px', borderRadius: '12px', border: budgetAmount === p ? `2px solid ${colors.steel}` : '1.5px solid var(--border-color)', backgroundColor: budgetAmount === p ? `${colors.steel}12` : 'var(--bg-card-solid)', fontSize: 'var(--t-body)', fontWeight: '600', color: budgetAmount === p ? colors.steel : colors.navy, cursor: 'pointer' }}>
                          ${p}{p === presets[presets.length - 1] ? '+' : ''}
                        </button>
                      ))}
                    </div>
                    <div style={{ marginBottom: '14px' }}>
                      <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: '0 0 6px' }}>Or enter a custom amount</p>
                      <div style={{ position: 'relative' }}>
                        <span style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', fontSize: 'var(--t-body)', fontWeight: '600', color: colors.navy }}>$</span>
                        <SearchInputLocal aria-label="Amount" type="number" initialValue={budgetCustom} onCommit={(v) => { setBudgetCustom(v); setBudgetAmount(null); }} placeholder="0" style={{ ...styles.input, paddingLeft: '28px', fontSize: 'var(--t-body)', fontWeight: '600' }} />
                      </div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: '6px', marginBottom: '16px' }}>
                      <span style={{ flexShrink: 0, display: 'flex', paddingTop: '2px' }}>{Icons.lock(colors.textTertiary, 12)}</span>
                      {/* THE THREE-AMOUNT RULE, STATED BEFORE THE TAP. It is a
                          privacy floor: the group number is built from the
                          lowest amount, so publishing it over one or two
                          answers publishes somebody's budget. Until now the
                          only place in the whole product that said so was a
                          400 from POST /api/budget/:id/lock, reachable only by
                          pressing a button that looked ready. */}
                      <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)', margin: 0, lineHeight: 1.5 }}>
                        This is anonymous. No one sees your answer. One group number appears after everyone has answered, and only if at least three people shared an amount. It is rounded down to a range, and it does not change after that.
                      </p>
                    </div>
                    <button className="hit44 glass-btn glass-primary" disabled={budgetSubmitting} onClick={async () => {
                      const amt = budgetCustom ? parseFloat(budgetCustom) : budgetAmount;
                      if (!amt || amt <= 0) { showToast('Select or enter an amount', 'error'); return; }
                      setBudgetSubmitting(true);
                      try {
                        const data = await submitBudget(selectedFlockId, { amount: amt, skipped: false });
                        setBudgetStatus(prev => ({ ...prev, ...data, userSubmitted: true, userAmount: amt }));
                        if (data.ceiling) setFlocks(prev => prev.map(f => f.id === selectedFlockId ? { ...f, budgetCeiling: data.ceiling } : f));
                        showToast('Budget submitted');
                        setShowChatPool(false);
                      } catch (err) { showToast(err.message, 'error'); }
                      setBudgetSubmitting(false);
                    }} style={{ ...styles.gradientButton, padding: '14px', opacity: budgetSubmitting ? 0.5 : 1 }}>
                      {budgetSubmitting ? 'Submitting...' : 'Submit'}
                    </button>
                    <button onClick={async () => {
                      setBudgetSubmitting(true);
                      try {
                        const data = await submitBudget(selectedFlockId, { amount: 0, skipped: true });
                        setBudgetStatus(prev => ({ ...prev, ...data, userSubmitted: true, userSkipped: true }));
                        showToast('Budget submitted');
                        setShowChatPool(false);
                      } catch (err) { showToast(err.message, 'error'); }
                      setBudgetSubmitting(false);
                    }} className="hit44 glass-btn glass-secondary" style={{ width: '100%', padding: '12px', marginTop: '8px', border: 'none', backgroundColor: 'transparent', color: 'var(--text-secondary)', fontSize: 'var(--t-label)', fontWeight: '600', cursor: 'pointer' }}>
                      Skip, any budget works
                    </button>
                  </div>
                )}

                {/* Budget Status (already submitted or locked) */}
                {hasBudget && (userSubmitted || budgetStatus?.budgetLocked) && !showCreateBill && (
                  <div>
                    {budgetStatus?.ceiling ? (
                      <div style={{ padding: '14px', borderRadius: '12px', backgroundColor: `${colors.steel}10`, border: `1px solid ${colors.steel}30`, marginBottom: '14px' }}>
                        <p style={{ fontSize: 'var(--t-body)', fontWeight: '600', color: colors.steel, margin: 0 }}>
                          Group budget: up to ${budgetStatus.ceiling} per person
                        </p>
                        <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: '4px 0 0' }}>{budgetStatus.submissionCount} of {budgetStatus.totalMembers} answered. This number is set and does not change.</p>
                      </div>
                    ) : budgetStatus?.budgetLocked ? (
                      /* Settled, then the flock dropped below three people who
                         shared an amount, so the number is withheld again. Say
                         that, rather than leave a screen reading "waiting" when
                         nothing is being waited for and answers are closed. */
                      <div style={{ padding: '14px', borderRadius: '12px', backgroundColor: 'var(--bg-primary)', marginBottom: '14px' }}>
                        <p style={{ fontSize: 'var(--t-label)', fontWeight: '600', color: colors.navy, margin: 0 }}>The group number is not being shown</p>
                        <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: '4px 0 0', lineHeight: 1.5 }}>
                          It takes three people who shared an amount, and fewer than three of them are still in this flock. The budget is closed, so nobody can add an amount now.
                        </p>
                      </div>
                    ) : (
                      /* "Waiting for budgets, 2 of 2 submitted" was the single
                         most confusing line in the product: everybody had
                         answered and the screen still said it was waiting, with
                         no way to learn that three amounts are the floor. In a
                         flock too small to ever reach three, say that outright
                         rather than leave two people waiting on each other. */
                      <div style={{ padding: '14px', borderRadius: '12px', backgroundColor: 'var(--bg-primary)', marginBottom: '14px' }}>
                        {(budgetStatus?.totalMembers || 0) > 0 && (budgetStatus?.totalMembers || 0) < 3 ? (
                          <>
                            <p style={{ fontSize: 'var(--t-label)', fontWeight: '600', color: colors.navy, margin: 0 }}>No group number for a flock this size</p>
                            <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: '4px 0 0', lineHeight: 1.5 }}>
                              It takes three amounts before Flock can show one, because with fewer than that the number would give away what somebody answered. There {budgetStatus.totalMembers === 1 ? 'is' : 'are'} {budgetStatus.totalMembers} of you here. Invite one more person, or just talk about it.
                            </p>
                          </>
                        ) : (
                          <>
                            <p style={{ fontSize: 'var(--t-label)', fontWeight: '600', color: colors.navy, margin: 0 }}>Waiting on more answers</p>
                            <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: '4px 0 0', lineHeight: 1.5 }}>
                              {budgetStatus?.submissionCount || 0} of {budgetStatus?.totalMembers || '?'} have answered. Flock shows one group number once everyone has answered, and only if at least three people shared an amount. Skips do not count towards those three. Showing a number earlier would move it every time somebody answered, which is how you work out whose answer it was.
                            </p>
                          </>
                        )}
                      </div>
                    )}
                    {/* YOUR OWN ANSWER, AND THE WAY BACK TO IT. This rendered
                        only when userAmount was truthy, and a skip stores null,
                        so tapping "Skip, any budget works" removed the submit
                        form (which needs !userSubmitted) AND the Change link in
                        the same move: there was no way left to enter an amount,
                        ever. The server was always happy to take one, so this
                        was a dead end the UI built by itself. */}
                    {!budgetStatus?.budgetLocked && budgetStatus?.userAmount != null && (
                      <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', marginBottom: '12px' }}>Your budget: ${budgetStatus.userAmount} · <button className="hit44" onClick={() => { setBudgetAmount(budgetStatus.userAmount); setBudgetCustom(''); setBudgetStatus(prev => ({ ...prev, userSubmitted: false })); }} style={{ background: 'none', border: 'none', color: colors.steel, fontWeight: '600', cursor: 'pointer', padding: 0, fontSize: 'var(--t-meta)' }}>Change</button></p>
                    )}
                    {!budgetStatus?.budgetLocked && budgetStatus?.userAmount == null && budgetStatus?.userSubmitted && (
                      <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', marginBottom: '12px' }}>You skipped, so any budget works for you. · <button className="hit44" onClick={() => { setBudgetAmount(null); setBudgetCustom(''); setBudgetStatus(prev => ({ ...prev, userSubmitted: false })); }} style={{ background: 'none', border: 'none', color: colors.steel, fontWeight: '600', cursor: 'pointer', padding: 0, fontSize: 'var(--t-meta)' }}>Set an amount</button></p>
                    )}
                    {/* LOCK, ONLY WHEN LOCKING CAN WORK. isReady is exactly the
                        server's own condition for the lock route (three
                        non-skipped amounts), so gating on it is the same rule
                        rather than a second, drifting copy of it. The button
                        used to be offered whenever the creator was looking,
                        and answered "Budget locks once 3 people have shared an
                        amount" from a 400 after the tap. */}
                    {isCreator && !budgetStatus?.budgetLocked && budgetStatus?.isReady && (
                      /* Say what the button does before it is pressed. It
                         publishes the group number from the amounts shared so
                         far and closes the budget, so anyone who has not
                         answered yet no longer can. */
                      <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)', margin: '0 0 8px', lineHeight: 1.5 }}>
                        Locking now sets the group number from the amounts already shared and closes the budget. Anyone who has not answered will not be able to.
                      </p>
                    )}
                    {isCreator && !budgetStatus?.budgetLocked && (
                      <div style={{ display: 'flex', gap: '8px', marginBottom: '12px' }}>
                        {budgetStatus?.isReady && (
                          <button className="hit44 glass-btn glass-primary" onClick={async () => { try { const d = await lockBudget(selectedFlockId); setBudgetStatus(prev => ({ ...prev, budgetLocked: true, ceiling: d?.ceiling ?? prev?.ceiling })); showToast('Budget locked'); } catch (err) { showToast(err.message, 'error'); } }} style={{ flex: 1, padding: '10px', borderRadius: '10px', border: `1.5px solid ${colors.navy}`, backgroundColor: 'var(--bg-card-solid)', color: colors.navy, fontWeight: '600', fontSize: 'var(--t-meta)', cursor: 'pointer' }}>Lock Budget</button>
                        )}
                        <button className="hit44 glass-btn glass-secondary" onClick={async () => { try { const d = await sendBudgetReminder(selectedFlockId); showToast(`Reminded ${d.reminded} member${d.reminded !== 1 ? 's' : ''}`); } catch (err) { showToast(err.message, 'error'); } }} style={{ flex: 1, padding: '10px', borderRadius: '10px', border: `1.5px solid var(--border-color)`, backgroundColor: 'var(--bg-card-solid)', color: 'var(--text-secondary)', fontWeight: '600', fontSize: 'var(--t-meta)', cursor: 'pointer' }}>Send Reminder</button>
                      </div>
                    )}
                    {isConfirmedOrComplete && (
                      <button className="hit44 glass-btn glass-primary" onClick={() => setShowCreateBill(true)} style={{ ...styles.gradientButton, padding: '14px' }}>Split the Bill</button>
                    )}
                  </div>
                )}

                {/* Budget disabled — direct to bill split */}
                {!hasBudget && !showCreateBill && !billSplit && (
                  <div>
                    <p style={{ fontSize: 'var(--t-label)', color: 'var(--text-secondary)', marginBottom: '16px' }}>Create a bill split after your hangout</p>
                    <button className="hit44 glass-btn glass-primary" onClick={() => setShowCreateBill(true)} style={{ ...styles.gradientButton, padding: '14px' }}>Split the Bill</button>
                  </div>
                )}

                {/* Bill Split Creation Form */}
                {showCreateBill && !billSplit && (
                  <div>
                    <div style={{ marginBottom: '14px' }}>
                      <label style={{ display: 'block', fontSize: 'var(--t-label)', fontWeight: '600', color: colors.navy, marginBottom: '6px' }}>Who paid?</label>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                        {[{ id: authUser?.id, name: 'Me' }, ...(flock.members || []).filter(m => typeof m === 'object' && m.id && String(m.id) !== String(authUser?.id)).map(m => ({ id: m.id, name: m.name || m }))].map(m => (
                          <button key={m.id || m.name} className="hit44 glass-btn glass-secondary" aria-pressed={(billPaidBy || authUser?.id) === m.id} onClick={() => setBillPaidBy(m.id || authUser?.id)}
                            style={{ padding: '8px 14px', borderRadius: '20px', border: (billPaidBy || authUser?.id) === m.id ? `2px solid ${colors.steel}` : '1.5px solid var(--border-color)', backgroundColor: (billPaidBy || authUser?.id) === m.id ? `${colors.steel}12` : 'var(--bg-card-solid)', fontSize: 'var(--t-meta)', fontWeight: '600', color: (billPaidBy || authUser?.id) === m.id ? colors.steel : colors.navy, cursor: 'pointer' }}>
                            {m.name}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div style={{ marginBottom: '14px' }}>
                      <label style={{ display: 'block', fontSize: 'var(--t-label)', fontWeight: '600', color: colors.navy, marginBottom: '6px' }}>What was the total?</label>
                      <div style={{ position: 'relative' }}>
                        <span style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', fontSize: 'var(--t-body)', fontWeight: '600', color: colors.navy }}>$</span>
                        <SearchInputLocal aria-label="Bill total" type="number" initialValue={billTotal} onCommit={setBillTotal} placeholder="0.00" style={{ ...styles.input, paddingLeft: '28px', fontSize: '16px', fontWeight: '600' }} />
                      </div>
                    </div>
                    <div style={{ marginBottom: '14px' }}>
                      <label style={{ display: 'block', fontSize: 'var(--t-label)', fontWeight: '600', color: colors.navy, marginBottom: '6px' }}>Add tip?</label>
                      <div style={{ display: 'flex', gap: '6px' }}>
                        {[0, 15, 18, 20, 25].map(t => (
                          <button key={t} className="hit44 glass-btn glass-secondary" aria-pressed={billTip === t} onClick={() => setBillTip(t)}
                            style={{ flex: 1, padding: '8px 2px', borderRadius: '10px', border: billTip === t ? `2px solid ${colors.steel}` : '1.5px solid var(--border-color)', backgroundColor: billTip === t ? `${colors.steel}12` : 'var(--bg-card-solid)', fontSize: 'var(--t-meta)', fontWeight: '600', color: billTip === t ? colors.steel : colors.navy, cursor: 'pointer' }}>
                            {t === 0 ? 'None' : `${t}%`}
                          </button>
                        ))}
                      </div>
                    </div>
                    {billTotal && parseFloat(billTotal) > 0 && (
                      <div style={{ padding: '12px', borderRadius: '12px', backgroundColor: 'var(--bg-primary)', marginBottom: '14px' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                          <span style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)' }}>Subtotal</span>
                          <span style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: colors.navy }}>${parseFloat(billTotal).toFixed(2)}</span>
                        </div>
                        {billTip > 0 && <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                          <span style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)' }}>Tip ({billTip}%)</span>
                          <span style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: colors.navy }}>${(parseFloat(billTotal) * billTip / 100).toFixed(2)}</span>
                        </div>}
                        <div style={{ height: '1px', backgroundColor: 'var(--divider)', margin: '6px 0' }} />
                        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                          <span style={{ fontSize: 'var(--t-label)', fontWeight: '600', color: colors.navy }}>Total</span>
                          <span style={{ fontSize: 'var(--t-label)', fontWeight: '600', color: colors.steel }}>${(parseFloat(billTotal) * (1 + billTip / 100)).toFixed(2)}</span>
                        </div>
                        <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)', margin: '6px 0 0', textAlign: 'center' }}>Equal split · ~${(parseFloat(billTotal) * (1 + billTip / 100) / Math.max(1, flock.members?.length || flock.memberCount || 1)).toFixed(2)} each</p>
                      </div>
                    )}
                    <button className="hit44 glass-btn glass-primary" disabled={!billTotal || parseFloat(billTotal) <= 0} onClick={async () => {
                      try {
                        const data = await createBillSplit(selectedFlockId, {
                          totalAmount: parseFloat(billTotal),
                          tipPercent: billTip,
                          splitType: 'equal',
                          paidBy: billPaidBy || authUser?.id,
                        });
                        setBillSplit(data.bill);
                        setShowCreateBill(false);
                        showToast('Bill split created');
                      } catch (err) { showToast(err.message, 'error'); }
                    }} style={{ ...styles.gradientButton, padding: '14px', opacity: (!billTotal || parseFloat(billTotal) <= 0) ? 0.4 : 1 }}>
                      Create Split
                    </button>
                  </div>
                )}

                {/* Bill Summary */}
                {billSplit && (
                  <div>
                    <div style={{ padding: '14px', borderRadius: '12px', backgroundColor: 'var(--bg-primary)', marginBottom: '14px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                        <span style={{ fontSize: 'var(--t-label)', fontWeight: '600', color: colors.navy }}>Total: ${billSplit.totalWithTip?.toFixed(2)}</span>
                        {billSplit.tipPercent > 0 && <span style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)' }}>includes {billSplit.tipPercent}% tip</span>}
                      </div>
                      <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: '0 0 10px' }}>Paid by {billSplit.paidBy?.name || 'Unknown'}</p>
                      <div style={{ borderTop: '1px solid var(--divider)', paddingTop: '8px' }}>
                        {(billSplit.shares || []).map(s => (
                          <div key={s.userId} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 0' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                              <span style={{ fontSize: 'var(--t-label)', fontWeight: '600', color: colors.navy }}>{s.name}</span>
                              {s.committed && !s.settled && <span style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: colors.amberText, backgroundColor: `${colors.amber}20`, padding: '1px 6px', borderRadius: '4px' }}>Pre-committed</span>}
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                              <span style={{ fontSize: 'var(--t-label)', fontWeight: '600', color: colors.navy }}>${s.amount?.toFixed(2)}</span>
                              {s.settled ? (
                                <span style={{ color: '#22C55E', fontSize: 'var(--t-body)' }}>{Icons.check('#22C55E', 16)}<span className="sr-only">Paid</span></span>
                              ) : (
                                <span style={{ fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)' }}>Owes</span>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                    {/* Settle Up button for current user if they owe */}
                    {billSplit.shares?.find(s => String(s.userId) === String(authUser?.id) && !s.settled) && (
                      <button className="hit44 glass-btn glass-primary" onClick={async () => {
                        try {
                          const result = await getPaymentLinks(selectedFlockId);
                          // A method with no deep link, no web link and no
                          // instructions is a row that does nothing when it is
                          // tapped, so it is not offered and it does not count
                          // towards "is there anything to pay through".
                          const methods = (result.methods || []).filter((m) => paymentRoutes(m).actionable);
                          // ONE pay surface, whatever the payee saved. This
                          // used to branch three ways and two of them were
                          // wrong. With exactly one handle it launched the
                          // wallet with nothing on screen naming who or where.
                          // With none it called settleShare on the spot, so
                          // tapping "Settle Up" recorded the debt as PAID
                          // without anybody having paid anything, which is the
                          // same class of bug as auto-settling on a handoff
                          // (see startPaymentHandoff). Marking it paid is still
                          // one tap away, on the button directly below this
                          // one, where the payer chooses it deliberately.
                          setPaymentOptions({ ...result, methods });
                          setShowPaymentPicker(true);
                        } catch (err) {
                          // A failed payment-link lookup is NOT a payment —
                          // never mark the debt settled on an error path
                          showToast('Could not load payment links. Use "Mark as Paid" after paying.', 'error');
                        }
                      }} style={{ ...styles.gradientButton, padding: '14px', marginBottom: '8px' }}>
                        Settle Up · ${billSplit.shares.find(s => String(s.userId) === String(authUser?.id))?.amount?.toFixed(2)}
                      </button>
                    )}
                    {billSplit.shares?.find(s => String(s.userId) === String(authUser?.id) && !s.settled) && (
                      <button className="hit44 glass-btn glass-secondary" onClick={async () => {
                        try {
                          await settleShare(selectedFlockId);
                          setBillSplit(prev => ({
                            ...prev,
                            shares: prev.shares.map(s => String(s.userId) === String(authUser?.id) ? { ...s, settled: true } : s),
                          }));
                          showToast('Marked as settled');
                        } catch (err) { showToast(err.message, 'error'); }
                      }} style={{ width: '100%', padding: '10px', border: 'none', backgroundColor: 'transparent', color: 'var(--text-secondary)', fontSize: 'var(--t-meta)', fontWeight: '600', cursor: 'pointer' }}>
                        Mark as Paid (cash or other)
                      </button>
                    )}
                    {/* The way back out of "I paid".
                        Settling was a one-way door: the Mark as Paid button
                        disappears the moment it succeeds, and nothing called
                        the unsettle route, so a mis-tap left a debt recorded as
                        cleared and the only remedy was asking whoever paid to
                        remember it differently.

                        Hidden for the payer rather than shown and refused. The
                        server answers 409 reason:'payer' because there is
                        nothing of theirs to unmark, and a control that exists
                        only to be rejected is a dead button. */}
                    {billSplit.shares?.find(s => String(s.userId) === String(authUser?.id) && s.settled)
                      && String(billSplit.paidBy?.id ?? '') !== String(authUser?.id ?? '') && (
                      <button className="hit44 glass-btn glass-secondary" onClick={async () => {
                        try {
                          await unsettleShare(selectedFlockId);
                          setBillSplit(prev => ({
                            ...prev,
                            shares: prev.shares.map(s => String(s.userId) === String(authUser?.id) ? { ...s, settled: false, settledAt: null } : s),
                          }));
                          showToast('Your share is marked unpaid again');
                        } catch (err) { showToast(err.message, 'error'); }
                      }} style={{ width: '100%', padding: '10px', border: 'none', backgroundColor: 'transparent', color: 'var(--text-tertiary)', fontSize: 'var(--t-meta)', fontWeight: '600', cursor: 'pointer' }}>
                        That was a mistake, I have not paid
                      </button>
                    )}
                    {billSplit.shares?.every(s => s.settled) && (
                      <div style={{ textAlign: 'center', padding: '12px' }}>
                        <p style={{ fontSize: 'var(--t-body)', fontWeight: '600', color: '#22C55E', margin: 0 }}>All settled up</p>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })()}

        {/* Vote Panel */}
        {showVotePanel && (() => {
          const flockVotes = flock.votes || [];
          const myVote = flockVotes.find(v => v.voters.includes('You'))?.venue || null;
          // Guests vote from the invite link and stay anonymous, so they add to
          // the totals without adding a name.
          const totalVoters = new Set(flockVotes.flatMap(v => v.voters)).size
            + flockVotes.reduce((sum, v) => sum + (v.guestCount || 0), 0);
          const isCreator = flock.creatorId && String(flock.creatorId) === String(authUser?.id);
          // Already locked in, so there is nothing left to confirm. Before this
          // existed the Confirm button was hidden on the ASSIGNED row only,
          // which meant a host who had already picked a venue had no confirm
          // control anywhere and the plan could never leave planning.
          const planLocked = flock.status === 'confirmed' || flock.status === 'completed';

          const handleQuickVote = (venueName, venueType, venuePlaceId) => {
            const existingVote = flockVotes.find(v => v.venue === venueName);
            if (existingVote) {
              if (existingVote.voters.includes('You')) return; // already voted
              const newVotes = flockVotes.map(v => ({
                ...v,
                voters: v.venue === venueName
                  ? [...v.voters, 'You']
                  : v.voters.filter(x => x !== 'You')
              }));
              updateFlockVotes(selectedFlockId, newVotes);
            } else {
              const newVotes = [...flockVotes.map(v => ({ ...v, voters: v.voters.filter(x => x !== 'You') })), { venue: venueName, type: venueType || 'Venue', place_id: venuePlaceId || null, voters: ['You'] }];
              updateFlockVotes(selectedFlockId, newVotes);
            }
          };

          const handleUnvote = () => {
            const newVotes = flockVotes
              .map(v => ({ ...v, voters: v.voters.filter(x => x !== 'You') }))
              .filter(v => v.voters.length > 0 || (v.guestCount || 0) > 0);
            updateFlockVotes(selectedFlockId, newVotes);
          };

          // Confirm means confirm. This used to save the venue and nothing
          // else, so a host who tapped the button labelled Confirm got a
          // venue-assigned flock still reading "Still Planning", and the plan
          // could never move on. The venue write has to land first: locking a
          // plan onto a venue the server just refused would tell everyone it
          // is happening somewhere it is not.
          const handleConfirmVenue = (venueName) => {
            const venueObj = allVenues.find(v => v.name === venueName);
            setShowVotePanel(false);
            return updateFlockVenue(selectedFlockId, {
              name: venueName,
              addr: venueObj?.addr || venueObj?.formatted_address || '',
              place_id: venueObj?.place_id || null,
              lat: venueObj?.location?.latitude || null,
              lng: venueObj?.location?.longitude || null,
              photo_url: venueObj?.photo_url || null,
              rating: venueObj?.stars || venueObj?.rating || null,
            }).then((saved) => (saved ? confirmFlockPlan(selectedFlockId) : false));
          };

          // Ensure assigned venue is in votes list
          const assignedVenue = flock.venue && flock.venue !== 'TBD' ? flock.venue : null;
          const votesWithAssigned = assignedVenue && !flockVotes.find(v => v.venue === assignedVenue)
            ? [{ venue: assignedVenue, type: 'Assigned', voters: [], guestCount: 0 }, ...flockVotes]
            : flockVotes;

          // Sort: assigned venue always first, then by vote count
          const sortedVotes = [...votesWithAssigned].sort((a, b) => {
            if (a.venue === assignedVenue && b.venue !== assignedVenue) return -1;
            if (b.venue === assignedVenue && a.venue !== assignedVenue) return 1;
            return voteTotal(b) - voteTotal(a);
          });

          // Popular chains nearby that aren't already vote options
          // Filter by budget ceiling when available
          const budgetMaxPrice = budgetStatus?.isReady && budgetStatus?.ceiling ? getMaxPriceLevel(budgetStatus.ceiling) : 4;
          const suggestedVenues = popularVenues.filter(v => !votesWithAssigned.find(fv => fv.venue === v.name)).filter(v => !v.price_level || v.price_level <= budgetMaxPrice).slice(0, 8);

          return (
            <div className="modal-backdrop" style={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'flex-end', zIndex: 50 }}>
            <DialogBehavior onClose={() => setShowVotePanel(false)} label="Vote on a venue" />
              <div className="modal-content" style={{ backgroundColor: 'var(--bg-card-solid)', borderRadius: '20px 20px 0 0', padding: '20px', width: '100%', maxHeight: '80%', overflowY: 'auto' }}>
                {/* Header */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                  <div>
                    <h2 style={{ fontSize: 'var(--t-title)', fontWeight: '700', color: colors.navy, margin: 0, display: 'flex', alignItems: 'center', gap: '8px' }}>{Icons.vote(colors.navy, 20)} Vote for a Venue</h2>
                    <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)', margin: '2px 0 0' }}>{totalVoters} vote{totalVoters !== 1 ? 's' : ''} cast{myVote ? ` • You voted for ${myVote}` : ''}</p>
                  </div>
                  <button aria-label="Close" className="hit44" onClick={() => setShowVotePanel(false)} style={{ width: '32px', height: '32px', borderRadius: '16px', backgroundColor: 'var(--bg-hover)', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Icons.x(colors.textSecondary, 18)}</button>
                </div>

                {/* Current votes */}
                {sortedVotes.length > 0 ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '16px' }}>
                    {sortedVotes.map((v, idx) => {
                      const isAssigned = v.venue === assignedVenue;
                      const isMyVote = v.voters.includes('You');
                      const count = voteTotal(v);
                      const votePercent = totalVoters > 0 ? Math.round((count / totalVoters) * 100) : 0;
                      const isLeading = !isAssigned && idx === 0 && count > 0;
                      const iconBg = isAssigned
                        ? colors.navyBg
                        : isLeading ? colors.steel : `linear-gradient(135deg, ${colors.navy}15, ${colors.navy}25)`;
                      return (
                        <button key={v.venue} className="hit44 glass-btn glass-secondary" onClick={(e) => { confirmClick(e); isMyVote ? handleUnvote() : handleQuickVote(v.venue, v.type, v.place_id); }} style={{ width: '100%', textAlign: 'left', padding: '12px 14px', borderRadius: '14px', border: isAssigned ? `2px solid ${colors.navy}` : isMyVote ? `2px solid ${colors.navy}` : `1.5px solid var(--border-default)`, backgroundColor: isAssigned ? `${colors.navy}05` : isMyVote ? `${colors.navy}06` : 'var(--bg-card-solid)', cursor: 'pointer', position: 'relative', overflow: 'hidden', transition: 'opacity 0.2s' }}>
                          {/* Progress bar background */}
                          <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${votePercent}%`, backgroundColor: isMyVote ? `${colors.navy}10` : 'var(--bg-tertiary)', transition: 'width 0.4s ease', borderRadius: '14px' }} />
                          <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: '10px' }}>
                            <div style={{ width: '36px', height: '36px', borderRadius: '10px', background: iconBg, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                              {isAssigned ? Icons.mapPin('white', 16) : isLeading ? Icons.flame('#fff', 18) : Icons.mapPin(colors.navy, 16)}
                            </div>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                <h4 style={{ fontSize: 'var(--t-body)', fontWeight: '600', color: colors.navy, margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v.venue}</h4>
                                {isAssigned && <span style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: 'white', backgroundColor: colors.navyBg, padding: '1px 6px', borderRadius: '6px', flexShrink: 0 }}>Assigned</span>}
                                {isLeading && <span style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: colors.steel, backgroundColor: `${colors.steel}15`, padding: '1px 6px', borderRadius: '6px', flexShrink: 0 }}>Leading</span>}
                              </div>
                              <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)', margin: '1px 0 0' }}>{(() => {
                                const guests = v.guestCount || 0;
                                const names = v.voters.join(', ');
                                const guestLabel = guests > 0 ? `${guests} guest${guests !== 1 ? 's' : ''}` : '';
                                if (names && guestLabel) return `${names} and ${guestLabel}`;
                                if (names || guestLabel) return names || guestLabel;
                                return isAssigned ? 'Current flock venue. Tap to vote' : 'No votes yet';
                              })()}</p>
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
                              {count > 0 && <span style={{ fontSize: 'var(--t-body)', fontWeight: '600', color: isMyVote ? colors.navy : colors.textTertiary }}>{count}</span>}
                              {isMyVote && <div style={{ width: '20px', height: '20px', borderRadius: '10px', backgroundColor: colors.navyBg, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Icons.check('white', 12)}</div>}
                              {isCreator && !planLocked && (
                                <button className="hit44 glass-btn glass-primary" onClick={(e) => { e.stopPropagation(); confirmClick(e); handleConfirmVenue(v.venue); }} style={{ padding: '4px 8px', borderRadius: '8px', border: 'none', background: colors.steel, color: 'white', fontSize: 'var(--t-meta)', fontWeight: '600', cursor: 'pointer', position: 'relative', overflow: 'hidden' }}>{isAssigned ? 'Lock it in' : 'Confirm'}</button>
                              )}
                            </div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <div style={{ padding: '20px', textAlign: 'center', backgroundColor: 'var(--bg-tertiary)', borderRadius: '14px', marginBottom: '16px' }}>
                    {userLocation ? (
                      <p style={{ fontSize: 'var(--t-label)', color: 'var(--text-tertiary)', margin: 0, fontWeight: '500' }}>No votes yet. Be the first to suggest a venue!</p>
                    ) : (
                      /* The instruction used to have no way to be followed: a
                         fresh install with no location got "be the first to
                         suggest a venue" over an empty panel (the nearby list
                         is location-fed), and the only other door claimed
                         venue search was down. Name the actual next step and
                         open the door to it. */
                      <>
                        <p style={{ fontSize: 'var(--t-label)', color: 'var(--text-tertiary)', margin: '0 0 12px', fontWeight: '500' }}>No votes yet. To see places to suggest, Flock needs your location.</p>
                        <button className="hit44 glass-btn glass-secondary" onClick={() => { leaveChatScreen(); setShowVotePanel(false); setPickingVenueForCreate(true); setPickingVenueForFlockId(flock.id); setCurrentTab('explore'); setCurrentScreen('main'); }} style={{ padding: '10px 18px', borderRadius: '12px', border: `1.5px solid ${colors.creamDark}`, backgroundColor: 'var(--bg-card-solid)', color: colors.navy, fontSize: 'var(--t-label)', fontWeight: '600', cursor: 'pointer' }}>Browse venues on Discover</button>
                      </>
                    )}
                  </div>
                )}

                {/* Popular chains nearby */}
                {suggestedVenues.length > 0 && (
                  <>
                    <p style={{ fontSize: 'var(--t-micro)', fontWeight: '700', color: 'var(--text-tertiary)', marginBottom: '10px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Popular Chains Nearby</p>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                      {suggestedVenues.map(venue => (
                        <button key={venue.id || venue.name} className="hit44 glass-btn glass-secondary" onClick={(e) => { confirmClick(e); handleQuickVote(venue.name, venue.type || venue.category || 'Venue', venue.place_id); }} style={{ width: '100%', textAlign: 'left', padding: '10px 12px', borderRadius: '12px', border: '1px solid var(--border-default)', backgroundColor: 'var(--bg-card-solid)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '10px', transition: 'opacity 0.2s', position: 'relative', overflow: 'hidden' }}>
                          {venue.photo_url ? (
                            <img src={venue.photo_url} alt="" style={{ width: '36px', height: '36px', borderRadius: '8px', objectFit: 'cover', flexShrink: 0 }} onError={onVenuePhotoError} />
                          ) : (
                            <div style={{ width: '36px', height: '36px', borderRadius: '8px', background: `linear-gradient(135deg, ${getCategoryColor(venue.category)}, ${getCategoryColor(venue.category)}cc)`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                              {Icons.mapPin('white', 14)}
                            </div>
                          )}
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <p style={{ fontSize: 'var(--t-label)', fontWeight: '600', color: colors.navy, margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{venue.name}</p>
                            <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)', margin: '1px 0 0' }}>{venue.type || venue.category}{venue.stars ? <> • {venue.stars} {Icons.starFilled('currentColor', 12)}</> : ''}{venue.price ? ` • ${venue.price}` : ''}</p>
                          </div>
                          <div style={{ padding: '6px 12px', borderRadius: '10px', backgroundColor: `${colors.navy}08`, color: colors.navy, fontSize: 'var(--t-meta)', fontWeight: '500', flexShrink: 0 }}>
                            {Icons.vote(colors.navy, 12)} Vote
                          </div>
                        </button>
                      ))}
                    </div>
                  </>
                )}

                {/* Browse more button */}
                <button className="hit44 glass-btn glass-secondary" onClick={() => { setShowVotePanel(false); setShowVenueShareModal(true); }} style={{ width: '100%', padding: '12px', borderRadius: '12px', border: `2px dashed ${colors.creamDark}`, backgroundColor: 'transparent', color: 'var(--text-tertiary)', fontSize: 'var(--t-label)', fontWeight: '600', cursor: 'pointer', marginTop: '12px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}>
                  {Icons.plus(colors.textTertiary, 14)} Share a venue to chat
                </button>
              </div>
            </div>
          );
        })()}

        {/* Venue Share Modal */}
        {showVenueShareModal && (
          <div className="modal-backdrop" style={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'flex-end', zIndex: 50 }}>
            <DialogBehavior onClose={() => setShowVenueShareModal(false)} label="Share a venue" />
            <div className="modal-content" style={{ backgroundColor: 'var(--bg-card-solid)', borderRadius: '20px 20px 0 0', padding: '20px', width: '100%', maxHeight: '70%', overflowY: 'auto' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                <h2 style={{ fontSize: 'var(--t-title)', fontWeight: '700', color: colors.navy, margin: 0, display: 'flex', alignItems: 'center', gap: '8px' }}>{Icons.mapPin(colors.navy, 20)} Share a Venue</h2>
                <button aria-label="Close" className="hit44" onClick={() => setShowVenueShareModal(false)} style={{ width: '32px', height: '32px', borderRadius: '16px', backgroundColor: 'var(--bg-hover)', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Icons.x(colors.textSecondary, 18)}</button>
              </div>

              {/* Current venue display */}
              {flock.venue && flock.venue !== 'TBD' ? (
                <div style={{ padding: '12px', borderRadius: '14px', background: `linear-gradient(135deg, ${colors.navy}08, ${colors.steel}15)`, border: `2px solid ${colors.steel}40`, marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <div style={{ width: '40px', height: '40px', borderRadius: '10px', background: colors.steel, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                    {Icons.mapPin('white', 18)}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p style={{ fontSize: 'var(--t-micro)', fontWeight: '700', color: colors.steel, margin: '0 0 2px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Current Venue</p>
                    <p style={{ fontSize: 'var(--t-body)', fontWeight: '600', color: colors.navy, margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{flock.venue}</p>
                    {flock.venueAddress && <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: '2px 0 0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{flock.venueAddress}</p>}
                  </div>
                  <button className="hit44 glass-btn glass-primary" onClick={(e) => { confirmClick(e); shareVenueToChat(selectedFlockId, { name: flock.venue, addr: flock.venueAddress, place_id: flock.venueId, stars: flock.venueRating, photo_url: flock.venuePhoto, price_level: flock.venuePriceLevel || null, price: flock.venuePriceLevel ? '$'.repeat(flock.venuePriceLevel) : null, crowd: (typeof crowdPredictions[flock.venueId]?.score === 'number' ? crowdPredictions[flock.venueId].score : null) }); }} style={{ padding: '8px 12px', borderRadius: '10px', border: 'none', background: colors.steel, color: 'white', fontSize: 'var(--t-meta)', fontWeight: '600', cursor: 'pointer', whiteSpace: 'nowrap', position: 'relative', overflow: 'hidden' }}>Share This</button>
                </div>
              ) : (
                <div style={{ padding: '10px 12px', borderRadius: '12px', backgroundColor: 'var(--bg-tertiary)', border: '1px solid var(--border-default)', marginBottom: '16px' }}>
                  <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: 0, fontStyle: 'italic' }}>No venue selected. Pick one below:</p>
                </div>
              )}

              <p style={{ fontSize: 'var(--t-micro)', fontWeight: '700', color: 'var(--text-secondary)', marginBottom: '12px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Or select a different venue:</p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                {budgetFilteredVenues.length === 0 ? (
                  /* When venue search is down, budgetFilteredVenues (derived from
                     the nearby venue list) comes back empty and this list used to
                     render nothing under "Or select a different venue", which is
                     the blank dead end tools/e2e/venue.spec.js forbids: a sheet
                     that says "Pick one below" and lists nothing. Say why it is
                     empty and give a real exit. There is no prop here that
                     reloads the nearby list, so this does not fake a "Try again"
                     that could not refill it; the honest action is to close and
                     use the venue map instead. */
                  <div style={{ padding: '16px', borderRadius: '14px', backgroundColor: 'var(--bg-tertiary)', border: '1px solid var(--border-default)', textAlign: 'center' }}>
                    <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: '0 0 12px', lineHeight: '1.5' }}>{userLocation
                      ? 'No venues to show here. Venue search is unavailable right now, so there is nothing to pick from yet.'
                      /* Blaming search when the app simply never had a
                         coordinate told a fresh account a working feature was
                         broken. Say the true reason and the fix. */
                      : "No venues to show yet, because Flock doesn't have your location. Turn it on from the Discover tab and this list fills in."}</p>
                    <button className="hit44 glass-btn glass-secondary" onClick={() => setShowVenueShareModal(false)} style={{ padding: '10px 20px', borderRadius: '12px', border: `1.5px solid ${colors.creamDark}`, backgroundColor: 'var(--bg-card-solid)', color: colors.navy, fontSize: 'var(--t-label)', fontWeight: '600', cursor: 'pointer' }}>Close</button>
                  </div>
                ) : budgetFilteredVenues.map(venue => (
                  <button className="hit44"
                    key={venue.id}
                    onClick={(e) => { confirmClick(e); shareVenueToChat(selectedFlockId, venue); }}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '12px',
                      padding: '12px',
                      borderRadius: '14px',
                      border: '1px solid var(--border-default)',
                      backgroundColor: 'var(--bg-card-solid)',
                      cursor: 'pointer',
                      textAlign: 'left',
                      transition: 'opacity 0.2s ease',
                      position: 'relative',
                      overflow: 'hidden'
                    }}
                  >
                    {/* Same defect as the DM share list: shareVenueToChat sends
                        this venue's photo_url onward, and the row drew a
                        category gradient rather than the picture it was
                        holding. Icon tile kept as the no-photo fallback. */}
                    {venue.photo_url ? (
                      <img
                        src={resolveVenuePhoto(venue.photo_url)}
                        alt=""
                        style={{ width: '44px', height: '44px', borderRadius: '12px', objectFit: 'cover', flexShrink: 0 }}
                        onError={(e) => { e.target.onerror = null; e.target.src = '/marks/venue-placeholder.jpg'; }}
                      />
                    ) : (
                      <div style={{
                        width: '44px',
                        height: '44px',
                        borderRadius: '12px',
                        background: `linear-gradient(135deg, ${getCategoryColor(venue.category)}, ${getCategoryColor(venue.category)}cc)`,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center'
                      }}>
                        {venue.category === 'Food' ? Icons.pizza('white', 20) : venue.category === 'Nightlife' ? Icons.cocktail('white', 20) : venue.category === 'Live Music' ? Icons.music('white', 20) : Icons.sports('white', 20)}
                      </div>
                    )}
                    <div style={{ flex: 1 }}>
                      <p style={{ fontSize: 'var(--t-body)', fontWeight: '600', color: colors.navy, margin: 0 }}>{venue.name}</p>
                      {/* `price` is null for every venue Google gives no
                          price_level for, and the separator was printed
                          unconditionally — so most rows in this list read
                          "Bar • " with nothing after the bullet. Every other
                          venue row in the file already guards it this way. */}
                      <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: '2px 0 0' }}>{venue.type}{venue.price ? ` • ${venue.price}` : ''}</p>
                    </div>
                    {(() => {
                      /* The plan's own hour first. venue.crowd is the map's
                         "right now" number, and a vote for Saturday 9 PM was
                         being argued with Thursday afternoon's crowd. The
                         event-hour score arrives per flock (App.js
                         requestEventCrowdScores) and carries its hour, so the
                         number says which question it is answering. */
                      const ev = eventCrowd ? eventCrowd[venue.place_id] : undefined;
                      const score = typeof ev === 'number' ? ev : (typeof venue.crowd === 'number' ? venue.crowd : null);
                      if (score === null) return null;
                      return <div style={{
                        padding: '4px 10px',
                        borderRadius: '12px',
                        backgroundColor: score > 84 ? '#FEE2E2' : score > 39 ? '#FEF3C7' : '#D1FAE5',
                        color: crowdColorFor(score, colors),
                        fontSize: 'var(--t-meta)',
                        fontWeight: '500',
                        whiteSpace: 'nowrap'
                      }}>
                        {score}%{typeof ev === 'number' && eventCrowdLabel ? ` ${eventCrowdLabel}` : ''}
                      </div>;
                    })()}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Invite Friends Modal */}
        {showFlockInviteModal && (
          <div className="modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) setShowFlockInviteModal(false); }} style={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'flex-end', zIndex: 50 }}>
            <DialogBehavior onClose={() => setShowFlockInviteModal(false)} label="Invite friends" />
            <div className="modal-content" style={{ backgroundColor: 'var(--bg-card-solid)', borderRadius: '20px 20px 0 0', padding: '20px', width: '100%', maxHeight: '70%', overflowY: 'auto' }}>
              <div style={{ width: '40px', height: '4px', backgroundColor: 'var(--pill-bg)', borderRadius: '2px', margin: '0 auto 16px' }} />
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                <h3 style={{ fontSize: 'var(--t-title)', fontWeight: '700', color: colors.navy, margin: 0 }}>Invite Friends</h3>
                <button aria-label="Close" className="hit44" onClick={() => setShowFlockInviteModal(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '4px' }}>{Icons.x(colors.textTertiary, 20)}</button>
              </div>

              {/* Guest link — anyone with it can RSVP and vote, no account.
                  This is the growth surface: every plan reaches non-users. */}
              <button className="hit44"
                onClick={async () => {
                  let url;
                  try {
                    ({ url } = await createFlockInviteLink(selectedFlockId));
                  } catch (err) {
                    showToast(err?.message || "Couldn't make an invite link. Try again.", 'error');
                    return;
                  }
                  // Web Share works in mobile Safari and Chrome on Android,
                  // which is exactly where a texted invite gets shared from.
                  // This used to also require window.Capacitor.isNativePlatform,
                  // so every one of those browsers fell through to the
                  // clipboard. The AbortError branch below covers a decline and
                  // the clipboard covers a browser without it, so the feature
                  // check on its own is the whole gate.
                  if (typeof navigator.share === 'function') {
                    try {
                      await navigator.share({ title: 'Join my flock', url });
                      return;
                    } catch (e) {
                      if (e?.name === 'AbortError') return; // user backed out of the share sheet
                      // fall through to the clipboard
                    }
                  }
                  // Copying can fail on an insecure origin or a denied
                  // permission. Either way the link is shown below, so the
                  // user is never left with nothing.
                  try { await navigator.clipboard.writeText(url); showToast('Invite link copied'); }
                  catch { showToast('Link ready. Copy it below'); }
                  setCopiedInviteUrl(url);
                }}
                style={{ width: '100%', marginBottom: copiedInviteUrl ? '8px' : '14px', padding: '12px 14px', borderRadius: '12px', border: `1.5px dashed ${colors.steel}`, backgroundColor: 'transparent', color: colors.steel, fontWeight: '600', fontSize: 'var(--t-label)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}
              >
                {Icons.share ? Icons.share(colors.steel, 15) : null}
                Share invite link (no account needed)
              </button>
              {copiedInviteUrl && (
                <div role="status" style={{ marginBottom: '14px', padding: '10px 12px', borderRadius: '12px', backgroundColor: 'var(--accent-green-bg)', border: '1px solid var(--border-subtle)' }}>
                  <p style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: 'var(--accent-green-text)', margin: '0 0 4px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                    {Icons.check('var(--accent-green-text)', 13)} Copied. Anyone with this link can RSVP and vote.
                  </p>
                  <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: 0, wordBreak: 'break-all', fontFamily: 'monospace' }}>{copiedInviteUrl}</p>
                </div>
              )}

              {/* Selected friends chips */}
              {flockInviteSelected.length > 0 && (
                <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '12px' }}>
                  {flockInviteSelected.map(f => (
                    <div key={f.id} style={{ display: 'flex', alignItems: 'center', gap: '4px', padding: '4px 8px 4px 4px', borderRadius: '20px', backgroundColor: colors.navyBg, color: 'white' }}>
                      <div style={{ width: '22px', height: '22px', borderRadius: '11px', backgroundColor: 'rgba(255,255,255,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 'var(--t-meta)', fontWeight: '500', overflow: 'hidden' }}>
                        {f.profile_image_url ? <img src={f.profile_image_url} alt="" style={{ width: '22px', height: '22px', borderRadius: '11px', objectFit: 'cover' }} /> : f.name[0]?.toUpperCase()}
                      </div>
                      <span style={{ fontSize: 'var(--t-meta)', fontWeight: '500' }}>{f.name.split(' ')[0]}</span>
                      <button aria-label="Remove" className="hit44" onClick={() => setFlockInviteSelected(prev => prev.filter(x => x.id !== f.id))} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '0 2px', display: 'flex', alignItems: 'center' }}>{Icons.x('rgba(255,255,255,0.7)', 12)}</button>
                    </div>
                  ))}
                </div>
              )}

              {/* Search input */}
              <div style={{ position: 'relative', marginBottom: '12px' }}>
                <input aria-label="Search friends"
                  type="text"
                  value={flockInviteSearch}
                  onChange={(e) => handleFlockInviteSearch(e.target.value)}
                  placeholder="Search friends..."
                  style={{ width: '100%', padding: '10px 14px 10px 36px', borderRadius: '12px', border: `2px solid ${flockInviteSearch ? colors.navy : colors.borderDefault}`, fontSize: 'var(--t-label)', outline: 'none', boxSizing: 'border-box', backgroundColor: 'var(--bg-tertiary)', color: 'var(--text-primary)', fontWeight: '500', transition: 'border-color 0.2s' }}
                  autoComplete="off"
                />
                <span style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)' }}>{Icons.search(colors.textTertiary, 14)}</span>
                {flockInviteSearch && (
                  <button aria-label="Clear search" className="hit44" onClick={() => setFlockInviteSearch('')} style={{ position: 'absolute', right: '8px', top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', padding: '4px' }}>{Icons.x(colors.textTertiary, 14)}</button>
                )}
              </div>

              {/* Friends.
                  A failed load says so and offers a retry. It is never drawn
                  as an empty list, because "nobody by that name" and "the
                  request did not land" are two different things to be told,
                  and the catch here used to answer both with the first. */}
              {flockInviteFriendsLoading && !flockInviteAllFriends && (
                <ListSkeleton count={3} thumb={36} thumbRadius={18} label="Loading your friends" />
              )}

              {!flockInviteFriendsLoading && flockInviteFriendsError && (
                <BirdNote
                  layout="row"
                  size={48}
                  bird={WARM_BIRD}
                  role="alert"
                  title={flockInviteFriendsError}
                  body="Nobody has been lost. The share link above still works while this is down."
                  action={<button className="hit44 glass-btn glass-navy" onClick={loadFlockInviteFriends} style={{ padding: '10px 16px', borderRadius: '10px', border: 'none', background: colors.navyMidBg, color: 'white', fontWeight: '600', fontSize: 'var(--t-label)', cursor: 'pointer' }}>Try again</button>}
                  style={{ padding: '8px 0' }}
                />
              )}

              {/* Typing: matches out of the list already in hand. */}
              {!flockInviteFriendsError && flockInviteAllFriends && flockInviteSearch.trim().length > 0 && (
                flockInviteResults.length > 0 ? (
                  <div style={{ maxHeight: '240px', overflowY: 'auto', borderRadius: '10px', border: `1px solid ${colors.creamDark}`, backgroundColor: 'var(--bg-card-solid)' }}>
                    {flockInviteResults.map(renderFlockInviteRow)}
                  </div>
                ) : (
                  <BirdNote
                    layout="row"
                    size={48}
                    title="No friends by that name"
                    body="Try a shorter piece of the name."
                    style={{ padding: '8px 0' }}
                  />
                )
              )}

              {/* Empty box: the list, which is the whole point. Available
                  tonight stays its own group above it, because a friend who
                  has said they are down is a different piece of information
                  from a friend who is on your list. */}
              {!flockInviteFriendsError && flockInviteAllFriends && flockInviteSearch.trim().length === 0 && (
                <>
                  {flockInvitePulses.length > 0 && (
                    <div style={{ marginTop: '4px' }}>
                      <p style={{ fontSize: 'var(--t-micro)', fontWeight: '700', color: 'var(--text-secondary)', margin: '0 0 8px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Available tonight</p>
                      <div style={{ maxHeight: '240px', overflowY: 'auto', borderRadius: '10px', border: `1px solid ${colors.creamDark}`, backgroundColor: 'var(--bg-card-solid)' }}>
                        {flockInvitePulses.map(renderFlockInviteRow)}
                      </div>
                    </div>
                  )}

                  {flockInviteRest.length > 0 && (
                    <div style={{ marginTop: flockInvitePulses.length > 0 ? '14px' : '4px' }}>
                      <p style={{ fontSize: 'var(--t-micro)', fontWeight: '700', color: 'var(--text-secondary)', margin: '0 0 8px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Your friends</p>
                      <div style={{ maxHeight: '260px', overflowY: 'auto', borderRadius: '10px', border: `1px solid ${colors.creamDark}`, backgroundColor: 'var(--bg-card-solid)' }}>
                        {flockInviteRest.map(renderFlockInviteRow)}
                      </div>
                    </div>
                  )}

                  {/* Someone with no friends was being told to try a shorter
                      piece of the name. Point at the button directly above
                      instead, which is the thing that actually helps them. */}
                  {flockInviteAllFriends.length === 0 && (
                    <BirdNote
                      layout="row"
                      size={48}
                      bird={WARM_BIRD}
                      title="No friends on Flock yet"
                      body="Use the share link above. Anyone who opens it can RSVP and vote without making an account."
                      style={{ padding: '8px 0' }}
                    />
                  )}

                  {flockInviteAllFriends.length > 0 && flockInviteCandidates.length === 0 && (
                    <BirdNote
                      layout="row"
                      size={48}
                      title="Everyone is already here"
                      body="Every friend on your list is in this flock. The share link above reaches anyone who is not."
                      style={{ padding: '8px 0' }}
                    />
                  )}
                </>
              )}

              {/* Send button */}
              {flockInviteSelected.length > 0 && (
                <button
                  onClick={handleSendFlockInvites}
                  disabled={flockInviteSending}
                  className="hit44 glass-btn glass-navy" style={{ width: '100%', padding: '14px', borderRadius: '14px', border: 'none', background: colors.navyBg, color: 'white', fontSize: 'var(--t-body)', fontWeight: '600', cursor: 'pointer', marginTop: '12px', opacity: flockInviteSending ? 0.7 : 1 }}
                >
                  {flockInviteSending ? 'Sending...' : `Invite ${flockInviteSelected.length} Friend${flockInviteSelected.length > 1 ? 's' : ''}`}
                </button>
              )}
            </div>
          </div>
        )}

        {/* Leave Flock Confirmation Modal */}
        {showLeaveConfirm && (
          <div className="modal-backdrop" style={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50, padding: '16px' }}>
            <DialogBehavior onClose={() => setShowLeaveConfirm(false)} label="Leave flock" />
            <div className="modal-content" style={{ backgroundColor: 'var(--bg-card-solid)', borderRadius: '24px', padding: '24px', width: '100%', maxWidth: '300px' }}>
              <div style={{ textAlign: 'center', marginBottom: '16px' }}>
                <div style={{ width: '48px', height: '48px', borderRadius: '24px', backgroundColor: 'var(--accent-red-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 12px' }}>{Icons.doorOpen('#EF4444', 24)}</div>
                <h3 style={{ fontSize: 'var(--t-title)', fontWeight: '700', color: colors.navy, margin: '0 0 8px' }}>Leave Flock?</h3>
                <p style={{ fontSize: 'var(--t-label)', color: 'var(--text-secondary)', margin: 0, lineHeight: '1.4' }}>
                  {flock.creatorId && String(flock.creatorId) === String(authUser?.id)
                    ? `You're the creator. Leaving will delete "${flock.name}" for everyone.`
                    : `Are you sure you want to leave "${flock.name}"?`}
                </p>
              </div>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button className="hit44 glass-btn glass-secondary" onClick={() => setShowLeaveConfirm(false)} style={{ flex: 1, padding: '12px', borderRadius: '12px', border: `2px solid ${colors.creamDark}`, backgroundColor: 'var(--bg-card-solid)', color: colors.navy, fontWeight: '600', fontSize: 'var(--t-body)', cursor: 'pointer' }}>Cancel</button>
                <button disabled={isLoading} onClick={async () => {
                  try {
                    setIsLoading(true);
                    const flockId = flock.id;
                    await apiLeaveFlock(flockId);
                    // A live share into a flock you just left keeps a GPS fix
                    // going out every 10 seconds that the server now drops on
                    // the membership check — battery spent on nothing.
                    if (sharingLocationRef.current === flockId) stopLocationSharing();
                    setFlocks(prev => prev.filter(f => f.id !== flockId));
                    // Clears the composer along with the two sheets this used
                    // to close by hand. A draft written for a flock you have
                    // just left is the worst one to carry into a DM.
                    leaveChatScreen();
                    setCurrentScreen('main');
                    setCurrentTab('home');
                    // Notify other members via socket. Through the helper, not
                    // a raw emit on getSocket(): the helper also drops the room
                    // from the join registry, so a later reconnect does not try
                    // to re-enter a flock this person has actually left.
                    leaveFlock(flockId);
                  } catch (err) {
                    showToast(err.message || 'Failed to leave flock', 'error');
                  } finally {
                    setIsLoading(false);
                  }
                }} className="hit44 glass-btn glass-danger" style={{ flex: 1, padding: '12px', borderRadius: '12px', border: 'none', backgroundColor: '#EF4444', color: 'white', fontWeight: '600', fontSize: 'var(--t-body)', cursor: 'pointer' }}>
                  {isLoading ? 'Leaving...' : 'Leave'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
}
