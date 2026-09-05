/**
 * FLOCK DIRECT MESSAGE SCREEN
 *
 * The one-to-one DM thread. It was 746 lines of `App.js`, declared as an arrow
 * function inside `FlockAppInner` and called rather than mounted. It moved out
 * for the same reason the venue owner dashboard, the flock chat detail and Add
 * Friends did, which is that a single file holding every screen in the product
 * is a file nobody can review. It is the fourth screen of that sweep, and the
 * one the flock chat extraction named when it deferred this move. That file's
 * header documents the deferral and the shared shape: this screen and the flock
 * chat share about half their behaviour, so moving both in one commit would
 * have made either verbatim diff unreadable, and that diff is the only thing
 * proving nothing changed on the way across.
 *
 * WHY THIS ONE IS A STATIC IMPORT
 *
 * The same call the flock chat and Add Friends made, for the same reason. The
 * venue dashboard is the paid product, gated behind a role and reachable by no
 * consumer, so its own chunk costs its audience nothing. A DM thread is the far
 * end of that scale: every user opens it, most open it more than once in a
 * session, and they do it on a bar network. React.lazy would move this screen
 * off the boot chunk and charge a round trip, plus an empty Suspense fallback
 * on a congested network, in front of a screen the person opened deliberately.
 * The flock chat header priced that exact trade with three production builds
 * and it came out negative for a screen users open immediately. This screen is
 * opened the same way, so it is imported normally and stays in the app chunk.
 * It was not re-measured in bytes here, because the reasoning, not a fresh
 * number, is what decides it, and inventing a number would be worse than
 * citing the sibling that measured one.
 *
 * WHY EVERYTHING ARRIVES AS A PROP
 *
 * The old arrow function closed over 101 names: 83 declared in `FlockAppInner`,
 * which is its state, setters, handlers and a couple of local constants, and
 * ten module-level helpers, constants and components that `App.js` shares with
 * screens other than this one. Those 93 are the parameters below. The remaining
 * eight are module imports `App.js` already pulls in from `../services/api`,
 * `../services/socket`, `../components/ui/Icons` and this screen's own sibling
 * `./ChatDetail`, so this file imports them straight from the source rather than
 * taking them as props. A context would have had to enumerate the same 93 names
 * into a provider value, so it buys nothing and hides the dependency surface
 * behind a hook. As parameters, the whole dependency surface of this file is its
 * parameter list plus its imports, and a name this component reads and does not
 * receive is an undefined identifier that `no-undef` fails the build on, rather
 * than a prop that is silently `undefined` at runtime and renders as nothing.
 *
 * The names were not read off the page. They came from a Babel scope walk of the
 * block, every `ReferencedIdentifier` whose binding resolves outside it, and the
 * parameter list below and the props object at the call site were both generated
 * from that one array, so they cannot drift apart.
 *
 * The state and the effects behind these props deliberately did NOT move. They
 * live in `FlockAppInner`, which does not unmount when the user leaves this
 * screen, so the DM socket wiring, the scrollback cursor, the message cache and
 * a half-typed message survive a trip elsewhere exactly as they did before.
 *
 * SHARED EXPLANATIONS. The flock chat header said this file holds the two
 * standing explanations it has no copy of: the one for a pair with no connection
 * yet and the one for a blocked pair. Both are here, in the body, where they
 * always were. Everywhere the two screens share a fix, the comment names
 * `screens/ChatDetail.js` and does not restate it: the collapsed feature rail,
 * the typing indicator's visibility toggle, the composer's flex rules and the
 * reaction grouping. Those cross-references moved across verbatim with the rest
 * of the body.
 *
 * The body below is the old block verbatim, including its original four-space
 * indentation, so it can be diffed against the deleted lines character for
 * character. Nothing was renamed, reformatted or improved on the way across, and
 * unlike the flock chat extraction no defect was fixed in transit: this is a
 * move. Anything found while moving it was logged to tools/e2e/FINDINGS.md as a
 * new row rather than changed here.
 */
import React from 'react';
import { sendFriendRequest, trackDmVenueVote, getDmMessageImage, addDmReaction, removeDmReaction } from '../services/api';
import { dmReact, dmRemoveReact, dmStopSharingLocation, dmVoteVenue, getSocket } from '../services/socket';
import { groupReactions } from './ChatDetail';
import { MessageList, StatusLine, TypingRow, VenueCardRow } from '../components/chat';
import { VENUE_PHOTO_PLACEHOLDER } from '../lib/venuePhoto';
import Icons from '../components/ui/Icons';
import { BirdieStill, BirdNote, WARM_BIRD } from '../components/ui/BirdieBird';

/* THE STREAM IS THE CHAT MODULE'S NOW, and this is the first screen wired to
   it. `components/chat` is imported as one door, never file by file, so the
   module's surface stays its index and this screen has one import line to
   read.

   WHAT LEFT THIS FILE with the swap, and it is worth being blunt about the
   first one because it was a real defect and not a tidy-up:

     - The scroll handler on the old list container. It blurred whatever input
       held focus on EVERY scroll event, which is why the keyboard shut itself
       the moment a message arrived and moved the list. It is not carried over
       in any form. MessageList's own comment says the same thing from the
       other side.
     - The day separator helpers (dayKeyOf, dayLabelOf, daySeparatorFor) and
       the backward scan every row made through them. groupRows inside the
       module decides where a day opens now, with the same vocabulary and the
       same "a row with no sentAt inherits the previous day" rule, so dividers
       land where they always did.
     - "Jump to latest", its 200/600px hysteresis state and the end-ref it
       scrolled to, plus the writes into the near-bottom flag that App.js's
       tail-follow effect read. Scroll position lives in one place now, and
       that place is the scroller.
     - The fixed 50px typing slot at the bottom of the stream. TypingRow above
       the composer replaces it and costs nothing when nobody is typing.

   Nothing else went. Search, scrollback, the skeleton, the empty and blocked
   states, every message shape, the failed row, reactions, the actions and the
   swipe-to-reply are all still here; several of them are further down this
   file rather than gone. */

// Same cadence the flock header samples at (ChatDetail SOCKET_SAMPLE_MS).
const DM_SOCKET_SAMPLE_MS = 2000;

/* One shared empty array, so a render before the thread's rows exist does not
   hand the list a fresh reference and reset its anchor. */
const NO_DM_ROWS = [];

/**
 * A search match, highlighted where it sits.
 *
 * The old text bubble did this inline. The row belongs to the module now and
 * MessageRow prints whatever `message.text` holds, so the highlight is built
 * here and handed over as that row's text: an array of strings and <mark>s
 * draws exactly what the one string drew. The regex escape and the
 * case-insensitive compare are the ones the bubble used, character for
 * character, so a query with a bracket in it still cannot throw.
 */
const highlightMatches = (text, query) => (
  String(text)
    .split(new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'))
    .map((part, pi) => (
      part.toLowerCase() === query.toLowerCase()
        ? <mark key={pi} style={{ background: 'var(--search-highlight)', color: 'inherit', borderRadius: '2px', padding: '0 1px' }}>{part}</mark>
        : part
    ))
);

/* FIVE PROPS BELOW ARE NO LONGER READ, and they are still in this list on
   purpose. `__tests__/extractionEquivalence.test.js` pins the parameter list
   against the object App.js spreads in, in BOTH directions, so dropping a name
   here without dropping it there is a red test rather than a tidy diff. They
   are marked "unused" where they sit, and each marker says what took over:

     VenueCard      the module's VenueCardRow draws a shared venue now
     colorsLight    bubble fill, and there are no bubbles
     isDark         the same bubble fill's dark variant
     profilePic     the 32px own-avatar beside every own message
     getRelativeTime  the per-message time stamp; the stream carries none

   `dmChatEndRef` and `dmNearBottomRef` were on that list and are gone from it,
   in both files at once. With no sentinel left to scroll to, the tail-follow
   effect in App.js could only ever call scrollIntoView on null, so the effect
   and the two refs it read went with it. */
export default function DmDetail({
  // Module-level helpers, constants and components that live in App.js and
  // are shared with screens other than this one, so they stay declared there
  // and arrive here.
  ChatSkeleton,
  DM_PAGE_SIZE,
  DialogBehavior,
  SearchInputLocal,
  VenueCard, // unused: VenueCardRow from components/chat draws venue messages
  colorsLight, // unused: the text bubble it tinted is gone
  messagePreview,
  oldestServerId,
  onVenuePhotoError,
  resolveVenuePhoto,
  // Everything else is declared in FlockAppInner and stays declared there.
  allVenues,
  authUser,
  chatInputHasText,
  colors,
  confirmClick,
  currentScreen,
  deletedDmUserIds,
  dmAtTop,
  dmBlocked,
  dmChatSearch,
  dmChatSearchRef,
  dmGalleryInputRef,
  dmIsTyping,
  dmMemberLocation,
  dmMessagesLoading,
  dmNavOpen,
  dmNotConnected,
  dmPendingImage,
  dmPinnedVenue,
  dmReactions,
  dmReplyingTo,
  dmRequestSending,
  dmSharingLocation,
  dmTypingUser,
  dmVenueVotes,
  dmVenueVotesError,
  getCategoryColor,
  getRelativeTime, // unused: no per-message time stamp in the new stream
  handleDmImageSelect,
  handleDmInputChange,
  isDark, // unused: the bubble fill it switched is gone
  loadDmVenueVotes,
  loadOlderDms,
  loadPopularVenues,
  olderLoading,
  openCameraViewfinder,
  openUserProfile,
  openVenueDetail,
  popularVenues,
  profilePic, // unused: runs carry a name and a coloured bar, not avatars
  retryFailedDm,
  discardFailedDm,
  selectedDm,
  selectedDmId,
  sendDmMessage,
  setChatInput,
  setCurrentScreen,
  setCurrentTab,
  setDeletedDmUserIds,
  setDirectMessages,
  setDmChatSearch,
  setDmMemberLocation,
  setDmNavOpen,
  setDmPendingImage,
  setDmReplyingTo,
  setDmRequestSending,
  setDmSharingLocation,
  startDmLocationSharing,
  setDmVenueVotes,
  setModerationTarget,
  setPickingVenueForCreate,
  setPickingVenueForDm,
  setShowDeleteDmConfirm,
  setShowDmChatSearch,
  setShowDmImagePreview,
  setShowDmMenu,
  setShowDmReactionPicker,
  setShowDmVenueSearch,
  setShowDmVotePanel,
  setVenueDetailReturnTo,
  showDeleteDmConfirm,
  showDmChatSearch,
  showDmImagePreview,
  showDmMenu,
  showDmReactionPicker,
  showDmVenueSearch,
  showDmVotePanel,
  showToast,
  // Added after the extraction, not part of the original 93. Both empty states
  // below have to tell a missing coordinate apart from a broken venue search,
  // and without this prop this screen structurally could not.
  userLocation,
  handleUnsendDm,
}) {
  // LEAVING THIS SCREEN, WRITTEN ONCE. The composer ref and its armed flag
  // are shared with the flock side (App.js chatInputRef), so a draft left
  // behind here rides into the NEXT thread anybody opens: the input remounts
  // visually empty, the Send button is still armed, and one tap sends the
  // abandoned draft, written for one person, to another. c7563c6 shut exactly
  // this class on the flock side with leaveChatScreen() and an AST guard that
  // counts every navigation against a call to the clear; this is the DM half,
  // which that commit never touched, pinned the same way by
  // __tests__/dmComposerLeave.test.js. Location sharing ends here too: the
  // back arrow used to be the only exit that stopped it, so leaving through
  // Map or a venue card kept the GPS emit loop running with no indicator
  // anywhere else in the app.
  const leaveDmScreen = () => {
    setChatInput('');
    setShowDmMenu(false);
    setShowDeleteDmConfirm(false);
    setShowDmChatSearch(false);
    setDmChatSearch('');
    setShowDmVotePanel(false);
    setShowDmVenueSearch(false);
    setDmReplyingTo(null);
    setDmNavOpen(false);
    // The actions menu is a full screen overlay now rather than a picker
    // pinned inside one row, so an exit that left it open would put a backdrop
    // over the next thread the moment it opened.
    setShowDmReactionPicker(null);
    if (dmSharingLocation) { dmStopSharingLocation(dmSharingLocation); setDmSharingLocation(null); }
  };

  // THE VOTE, WRITTEN ONCE. This screen has three vote buttons (the panel's
  // nearby list, the panel's un-vote, and Vote on a venue card in the thread)
  // and all three used to do the same thing: rewrite the tally optimistically,
  // then call dmVoteVenue and walk away.
  //
  // dmVoteVenue is a guarded emit. Over a dead socket it sent nothing, and it
  // returned nothing either, so the tile flipped, the count went up, the user's
  // own name landed in the voter list, and the server had no vote. The next
  // loadDmVenueVotes wiped it with no explanation, which is verbatim the "tile
  // quietly reverted on the next load" of silentWriteFailures incident 1, in a
  // direct message instead of a flock. The comment above the panel said it was
  // "identical to flock with optimistic local updates"; it stopped being
  // identical the day that incident was fixed on the flock side.
  //
  // A tunnel, a lock screen, or the second after a resume before the socket is
  // back are all ordinary. previousVotes is captured by the CALLER, before its
  // optimistic write, for the same reason updateFlockVotes captures its own.
  const commitDmVote = (venueName, venueId, previousVotes, lead) => {
    if (dmVoteVenue(selectedDmId, venueName, venueId)) return true;
    setDmVenueVotes(previousVotes);
    showToast(`${lead} You're not connected right now.`, 'error');
    return false;
  };

  // Three states, not two, with the same sampling and the same words as the
  // flock header. 9d87b73 fixed the hardcoded "online" in ChatDetail only;
  // this screen was extracted with the old literal frozen in, so a dead
  // socket kept a green dot and the word online over it.
  const readConnection = () => {
    if (getSocket()?.connected) return 'online';
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return 'offline';
    return 'reconnecting';
  };
  // Full-size photo viewer, the same shape ChatDetail carries: history rows
  // hold only the thumbnail, the original is one gated fetch away.
  //
  // "Jump to latest" and its 200/600px hysteresis used to live here. They are
  // MessageList's "N new messages" affordance now, which is the same idea told
  // honestly: it counts what arrived while you were reading rather than
  // offering a ride to a bottom that may not have moved.
  const [imageViewer, setImageViewer] = React.useState(null);
  const openImageViewer = (m) => {
    if (m.image_url) { setImageViewer({ src: m.image_url }); return; }
    setImageViewer({ loading: true });
    getDmMessageImage(m.id)
      .then((d) => setImageViewer((prev) => (prev && prev.loading ? { src: d.image } : prev)))
      .catch(() => setImageViewer((prev) => (prev && prev.loading ? { error: "Couldn't load the full photo. Try again." } : prev)));
  };

  const [connectionState, setConnectionState] = React.useState(readConnection);
  React.useEffect(() => {
    const sample = () => setConnectionState(readConnection());
    sample();
    const id = setInterval(sample, DM_SOCKET_SAMPLE_MS);
    window.addEventListener('online', sample);
    window.addEventListener('offline', sample);
    return () => {
      clearInterval(id);
      window.removeEventListener('online', sample);
      window.removeEventListener('offline', sample);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /* ── The rows the stream draws ───────────────────────────────────────────
     Two arrays, and the distinction between them is load bearing.

     `dmSourceRows` is what the app shell owns. Every handler that hands a
     message back to the shell (retry, remove, unsend, reply, report, the photo
     viewer) takes one of these, because a display copy's `text` can be an
     array of highlight nodes and `retryFailedDm` would put that array back on
     the wire as the message body.

     `dmRows` is the same list dressed for the stream: filtered by the search
     query, its quotes resolved through messagePreview so a quoted photo still
     says Photo and a quoted venue card still says Venue, and its matches
     wrapped in <mark>. Memoised because MessageList's scroll rules key off the
     identity of this array: a fresh one on every socket event would re-run the
     layout effect several times a second.

     Hooks sit above the `selectedDm` guard in the return below, so the source
     is read with optional chaining. A thread that is not there yet is an empty
     stream, not a crash. */
  const dmSearchQuery = showDmChatSearch && dmChatSearch.trim() ? dmChatSearch : '';
  const dmSourceRows = selectedDm?.messages || NO_DM_ROWS;
  const myDmId = authUser?.id;

  const dmRowsById = React.useMemo(() => {
    const byId = new Map();
    for (const m of dmSourceRows) byId.set(m.id, m);
    return byId;
  }, [dmSourceRows]);

  const originalDmRow = (m) => (m && dmRowsById.get(m.id)) || m;

  const dmRows = React.useMemo(() => {
    const q = dmSearchQuery.toLowerCase();
    const base = q
      ? dmSourceRows.filter(m => m.text?.toLowerCase().includes(q) || m.sender?.toLowerCase().includes(q))
      : dmSourceRows;
    return base.map((m) => {
      const quoted = m.reply_to
        ? { ...m, reply_to: { ...m.reply_to, text: messagePreview({ ...m.reply_to, hadContent: true }) } }
        : m;
      /* A venue card message carries a generated caption ("Check out Kome!")
         that the old stream never drew, because the card branch replaced the
         text branch outright. MessageRow draws a card AND its text, so the
         caption is dropped from the DISPLAY row rather than repeated under a
         card whose first line is the venue's name. The shell's own copy still
         has it, which is what the conversation list previews. */
      const isCard = quoted.message_type === 'venue_card' && quoted.venue_data;
      const carded = isCard ? { ...quoted, text: '' } : quoted;
      /* AND ON THE SEARCH PATH TOO. The highlight below rebuilds `text` from
         the shell's own copy, so a query the caption matched ("check out")
         put that caption straight back under the card the line above had
         just cleared, which is the duplicate the blanking exists to stop. A
         card is a card whether or not a search is running. */
      if (isCard || !q || typeof m.text !== 'string' || !m.text.toLowerCase().includes(q)) return carded;
      return { ...carded, text: highlightMatches(m.text, dmSearchQuery) };
    });
  }, [dmSourceRows, dmSearchQuery, messagePreview]);

  // The count line above the stream. Only drawn on a live query, and only when
  // something matched, exactly as it was.
  const dmMatchCount = dmSearchQuery ? dmRows.length : 0;

  /* Scrollback, condition unchanged: only offered when the thread is showing a
     full page, which is the only case where there can be anything behind it,
     and it retires itself the moment the server hands back a short page. A
     search is a filtered view of what is already loaded, so paging behind it
     would be paging into a list the reader cannot see. */
  const dmCanLoadOlder = !dmMessagesLoading && !(showDmChatSearch && dmChatSearch.trim()) && !dmAtTop[selectedDmId] && dmSourceRows.length >= DM_PAGE_SIZE;

  /* THE STATUS LINE, AND WHAT THIS SCREEN IS ENTITLED TO SAY. A DM row carries
     `pending` and `failed` and nothing else: there is no delivered and no
     opened on the wire yet, so the ladder stops at Sending and no word is
     invented to fill the gap.

     BOTH are asked of every row, not just the last one, and neither is a
     receipt. Send while offline so it fails, reconnect, send again, and both
     are yours on the same day, so they are one run with the failed row in the
     middle; asking only about the last row would leave that one dimmed with
     no Retry and no Remove. Sending is the same fact about a different row:
     two messages can be in flight at once, and each is the one that has not
     landed. Pinning it to "the last own row" also attached it to the wrong
     message during a search, because the row it found was the last own row
     that MATCHED the query rather than the one still on the wire.
     MessageGroup draws a non-last row's status under that row for exactly
     this. */
  const renderDmStatus = (m) => {
    if (!m) return null;
    if (m.failed) {
      return (
        <StatusLine
          status="failed"
          onRetry={() => retryFailedDm(selectedDmId, originalDmRow(m))}
          onRemove={() => discardFailedDm(selectedDmId, originalDmRow(m))}
        />
      );
    }
    if (m.pending) return <StatusLine status="sending" />;
    return null;
  };

  /* A shared venue, as a message. The module owns the card; this decides what
     the card's one action does, and here that is the vote it has always been.
     VenueCardRow's `surface` picks the WORD on that action, Vote in a flock
     and Pin in a DM, and the plan's DM pin is not reachable from this screen:
     no pin handler is among its props. Naming the button Pin while it writes a
     vote would be the lie, so the default stands and the button says Vote. The
     whole card opens the place, which is what View Details did. */
  const renderDmCard = (m) => {
    if (!(m.message_type === 'venue_card' && m.venue_data)) return null;
    const vd = m.venue_data;
    const tally = dmVenueVotes.find(v => v.venue_name === vd.name);
    const tallyCount = tally ? parseInt(tally.vote_count || 0) : 0;
    const iVoted = (tally?.voters || []).includes(authUser?.name);
    /* A long press fires at 350ms and the browser still dispatches a click on
       release, so a press held over this card would open the venue, or cast a
       vote, underneath the menu the press just asked for. MessageRow spends
       that click for the controls it owns (the photo, the quote, the reaction
       pills); the card is the parent's, so the parent spends it, and the test
       is simply whether this row's menu is the one now open. */
    const pressOpenedTheMenu = () => showDmReactionPicker === m.id;
    return (
      <VenueCardRow
        venue={vd}
        actionActive={iVoted}
        count={tallyCount}
        /* The card is presentational and has no BASE_URL, so the path resolver
           is handed in, the same way the flock side hands it in. A venue_data
           photo is routinely a relative /api/ path, and an unresolved one is a
           broken image rather than a picture. The placeholder goes with it, so
           a photo that dies lands on the app's own bird rather than the card's
           map pin. */
        resolvePhoto={resolveVenuePhoto}
        placeholder={VENUE_PHOTO_PLACEHOLDER}
        /* NOTHING TO OPEN MEANS NO CONTROL. This used to be given every time
           and check inside, so a card with no place_id announced itself as a
           button and answered the tap with nothing. */
        onOpen={vd.place_id ? () => {
          if (pressOpenedTheMenu()) return;
          leaveDmScreen();
          setVenueDetailReturnTo({ tab: 'chat', screen: 'dmDetail', dmId: selectedDmId });
          setCurrentTab('explore');
          setCurrentScreen('main');
          setTimeout(() => {
            openVenueDetail(vd.place_id, { name: vd.name, formatted_address: vd.addr, place_id: vd.place_id, rating: vd.stars || vd.rating, photo_url: vd.photo_url }, { panMap: true });
          }, 500);
        } : undefined}
        onAction={() => {
          if (pressOpenedTheMenu()) return;
          const vName = vd.name;
          const vId = vd.place_id;
          const mn = authUser?.name;
          // Same capture as the panel's own vote button: this card is the third
          // way into the same tally and it rolled back no further than the
          // other two did.
          const previousVotes = dmVenueVotes;
          const existing = dmVenueVotes.find(v => v.venue_name === vName);
          if (existing && (existing.voters || []).includes(mn)) return;
          if (existing) {
            setDmVenueVotes(prev => prev.map(v => ({ ...v, voters: v.venue_name === vName ? [...(v.voters || []), mn] : (v.voters || []).filter(x => x !== mn), vote_count: v.venue_name === vName ? parseInt(v.vote_count || 0) + 1 : (v.voters || []).includes(mn) ? parseInt(v.vote_count || 0) - 1 : parseInt(v.vote_count || 0) })).filter(v => parseInt(v.vote_count || 0) > 0 || v.venue_name === vName));
          } else {
            setDmVenueVotes(prev => [...prev.map(v => ({ ...v, voters: (v.voters || []).filter(x => x !== mn), vote_count: (v.voters || []).includes(mn) ? parseInt(v.vote_count || 0) - 1 : parseInt(v.vote_count || 0) })).filter(v => parseInt(v.vote_count || 0) > 0), { venue_name: vName, venue_id: vId, vote_count: 1, voters: [mn] }]);
          }
          if (commitDmVote(vName, vId, previousVotes, "Your vote didn't save.")) trackDmVenueVote();
        }}
      />
    );
  };

  /* MESSAGE ACTIONS. The trigger moved from a tap on the bubble to a long
     press, which MessageRow reports through onLongPress with the message and
     the row's own bounding rect. The open menu is still identified by the
     app shell's `showDmReactionPicker`, so leaving the screen and every other
     thing that already closed it still does; only the rect is local, because a
     screen coordinate is not app state and cannot be anything but stale by the
     time anyone else reads it. */
  const [dmActionRect, setDmActionRect] = React.useState(null);
  const openDmActions = (m, detail) => {
    setDmActionRect(detail && detail.rect ? { top: detail.rect.top, bottom: detail.rect.bottom } : null);
    setShowDmReactionPicker(m.id);
  };
  const closeDmActions = () => {
    setShowDmReactionPicker(null);
    setDmActionRect(null);
  };
  const dmActionMessage = showDmReactionPicker == null ? null : (dmRowsById.get(showDmReactionPicker) || null);

  /* Below the row if the sheet fits under it, above it if not, and centred
     when a press arrived without a rect (the keyboard door reports one, a
     synthetic event in a test may not). Menu height is the 44 target plus its
     padding, so 56 is the box it needs to clear. */
  const dmActionTop = (() => {
    const viewportH = typeof window !== 'undefined' ? window.innerHeight : 640;
    if (!dmActionRect) return Math.max(12, Math.round(viewportH / 2) - 28);
    const below = dmActionRect.bottom + 8;
    if (below + 56 <= viewportH) return below;
    return Math.max(12, dmActionRect.top - 64);
  })();

  // Swipe right to reply, and the tap on Reply in the menu, are the same act.
  // The row handed back is the shell's own, never the display copy.
  const startDmReply = (m) => {
    setDmReplyingTo(originalDmRow(m));
    closeDmActions();
  };

  /* A reaction pill, tapped. groupReactions, the same helper the flock side
     uses, so a DM reaction read back from history keeps the id of who left it
     and ownership is compared as a string: the REST history hands user_id back
     as a number while the live socket hands it back as a string, so strict
     equality answered false for your own reaction after a reload. */
  const toggleDmReaction = (emoji, m) => {
    const otherUser = selectedDmId;
    const g = groupReactions(m.reactions).find((r) => r.emoji === emoji) || { emoji, userIds: [] };
    const mine = g.userIds.some((id) => String(id) === String(authUser?.id));
    if (mine) {
      if (!dmRemoveReact(m.id, g.emoji, otherUser)) removeDmReaction(m.id, g.emoji).catch(() => showToast('Could not remove that reaction. Try again.', 'error'));
    } else if (!dmReact(m.id, g.emoji, otherUser)) { addDmReaction(m.id, g.emoji).catch(() => showToast('Could not react. Try again.', 'error')); }
  };

  return currentScreen === 'dmDetail' && selectedDm && (
    <div key="dm-detail-screen" style={{ display: 'flex', flexDirection: 'column', height: '100%', backgroundColor: 'var(--bg-card-solid)' }}>
      {/* Header */}
      <div style={{ padding: '6px 10px 5px 4px', background: colors.navyBg, flexShrink: 0, boxShadow: '0 2px 10px rgba(0,0,0,0.1)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <button aria-label="Back" className="hit44" onClick={() => { setCurrentScreen('main'); leaveDmScreen(); }} style={{ width: '34px', height: '34px', borderRadius: '17px', background: 'none', border: 'none', color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{Icons.arrowLeft('white', 20)}</button>
          {/* The avatar opens the person card. The overflow menu already carries
              report/block for this thread, but the face is where people reach
              first, and it is the same control the roster now has.
              No overflow:hidden on the button: it would clip .hit44's pseudo
              hit box, and at 34px the 44pt target is the whole point of the
              class. The <img> already rounds itself. */}
          <button
            className="hit44"
            aria-label={`About ${selectedDm.name}`}
            onClick={() => openUserProfile({ id: selectedDmId, name: selectedDm.name, image: selectedDm.image })}
            style={{ width: '34px', height: '34px', borderRadius: '17px', backgroundColor: 'rgba(255,255,255,0.2)', border: 'none', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 'var(--t-label)', fontWeight: '600', color: 'white', flexShrink: 0, cursor: 'pointer' }}
          >
            {selectedDm.image ? <img src={selectedDm.image} alt="" style={{ width: '34px', height: '34px', borderRadius: '17px', objectFit: 'cover' }} /> : (selectedDm.name?.[0]?.toUpperCase() || '?')}
          </button>
          <h2 style={{ flex: 1, fontFamily: 'var(--font-display)', letterSpacing: '-0.005em', fontWeight: '600', color: 'white', fontSize: 'var(--t-title)', margin: 0, lineHeight: '1.3', minWidth: 0 }}>{selectedDm.name}</h2>
          <div style={{ display: 'flex', alignItems: 'center', gap: '4px', flexShrink: 0 }}>
            {/* Collapsed means gone. See the same fix on the flock chat
                header in screens/ChatDetail.js: a zero max-width with hidden
                overflow paints nothing and leaves every button inside it
                focusable and readable. */}
            <div style={{ display: 'flex', gap: '4px', overflow: 'hidden', maxWidth: dmNavOpen ? '114px' : '0px', opacity: dmNavOpen ? 1 : 0, visibility: dmNavOpen ? undefined : 'hidden', transition: `max-width 0.3s ease, opacity 0.25s ease, visibility 0s linear ${dmNavOpen ? '0s' : '0.3s'}` }}>
              <button aria-label="Venue voting" className="hit44 glass-btn" onClick={() => { setDmNavOpen(false); setShowDmVotePanel(!showDmVotePanel); if (!showDmVotePanel) loadPopularVenues(); }} style={{ width: '34px', height: '34px', minWidth: '34px', borderRadius: '17px', border: 'none', backgroundColor: 'rgba(255,255,255,0.15)', color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Icons.vote('white', 16)}</button>
              <button aria-label="Search" className="hit44 glass-btn" onClick={() => { setDmNavOpen(false); setShowDmChatSearch(!showDmChatSearch); }} style={{ width: '34px', height: '34px', minWidth: '34px', borderRadius: '17px', border: 'none', backgroundColor: showDmChatSearch ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.15)', color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Icons.search('white', 16)}</button>
            </div>
            <button aria-label="Features" aria-expanded={dmNavOpen} className="hit44" onClick={() => setDmNavOpen(!dmNavOpen)} style={{ height: '34px', minWidth: dmNavOpen ? '34px' : 'auto', width: dmNavOpen ? '34px' : 'auto', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.18)', backgroundColor: dmNavOpen ? 'rgba(255,255,255,0.25)' : 'rgba(255,255,255,0.1)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)', color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px', padding: dmNavOpen ? '0' : '0 12px', fontSize: 'var(--t-meta)', fontWeight: '600', flexShrink: 0, transition: 'all 0.3s ease', boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.12)' }}>{dmNavOpen ? Icons.x('white', 16) : <span style={{ fontSize: 'var(--t-meta)', fontWeight: '500' }}>Features</span>}</button>
          </div>
          <div style={{ position: 'relative', flexShrink: 0 }}>
            <button aria-label="More options" className="hit44" onClick={() => setShowDmMenu(!showDmMenu)} style={{ width: '34px', height: '34px', borderRadius: '17px', border: 'none', backgroundColor: 'rgba(255,255,255,0.15)', color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Icons.moreVertical('white', 16)}</button>
            {showDmMenu && (
              <div style={{ position: 'absolute', top: '38px', right: 0, backgroundColor: 'var(--bg-card-solid)', borderRadius: '14px', boxShadow: '0 8px 24px rgba(0,0,0,0.12)', minWidth: '200px', zIndex: 60, overflow: 'hidden', border: '1px solid var(--border-subtle)' }}>
                <button className="hit44 glass-btn" onClick={() => { setShowDmMenu(false); setModerationTarget({ userId: selectedDmId, userName: selectedDm.name, contentType: 'profile' }); }} style={{ width: '100%', padding: '14px 16px', display: 'flex', alignItems: 'center', gap: '10px', border: 'none', borderBottom: '1px solid var(--border-subtle)', backgroundColor: 'var(--bg-card-solid)', cursor: 'pointer', fontSize: 'var(--t-body)', fontWeight: '600', color: 'var(--text-primary)' }}>
                  <span aria-hidden style={{ display: 'inline-flex' }}>{Icons.flag('currentColor', 15)}</span> Report or block {selectedDm.name}
                </button>
                <button className="hit44 glass-btn glass-danger" onClick={() => { setShowDmMenu(false); setShowDeleteDmConfirm(true); }} style={{ width: '100%', padding: '14px 16px', display: 'flex', alignItems: 'center', gap: '10px', border: 'none', backgroundColor: 'var(--bg-card-solid)', cursor: 'pointer', fontSize: 'var(--t-body)', fontWeight: '600', color: '#EF4444' }}>
                  {Icons.x('#EF4444', 16)} Delete Conversation
                </button>
              </div>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '5px', paddingLeft: '74px', marginTop: '2px' }}>
          {dmIsTyping ? <span style={{ fontSize: 'var(--t-meta)', color: '#86EFAC', fontWeight: '500' }}>{dmTypingUser || selectedDm.name} is typing...</span> : dmSharingLocation ? <span style={{ fontSize: 'var(--t-meta)', color: '#34d399', fontWeight: '500', display: 'inline-flex', alignItems: 'center', gap: '4px' }}>{Icons.mapPin('#34d399', 12)}sharing location</span> : <><span style={{ width: '5px', height: '5px', borderRadius: '3px', backgroundColor: connectionState === 'online' ? '#22c55e' : connectionState === 'offline' ? '#9CA3AF' : '#F59E0B', boxShadow: 'none' }} /><span style={{ fontSize: 'var(--t-meta)', color: 'rgba(255,255,255,0.55)', fontWeight: '500' }}>{connectionState === 'online' ? 'online' : connectionState === 'offline' ? 'offline' : 'reconnecting...'}</span></>}
        </div>
      </div>

      {/* Dismiss DM menu */}
      {showDmMenu && <div onClick={() => setShowDmMenu(false)} style={{ position: 'absolute', inset: 0, zIndex: 55 }} />}

      {/* Chat search bar */}
      {showDmChatSearch && (
        <div style={{ padding: '8px 12px', backgroundColor: 'var(--bg-card-solid)', borderBottom: '1px solid var(--divider)', display: 'flex', gap: '8px', alignItems: 'center', flexShrink: 0 }}>
          <SearchInputLocal aria-label="Search messages" inputRef={dmChatSearchRef} type="text" initialValue={dmChatSearch} onCommit={setDmChatSearch} placeholder="Search messages..." style={{ flex: 1, padding: '8px 12px', borderRadius: '20px', backgroundColor: 'var(--bg-hover)', color: 'var(--text-primary)', border: 'none', fontSize: 'var(--t-label)', outline: 'none' }} />
          {dmChatSearch && <button aria-label="Clear search" className="hit44" onClick={() => setDmChatSearch('')} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '4px' }}>{Icons.x(colors.textSecondary, 14)}</button>}
        </div>
      )}

      {/* The match count. It used to be the first thing inside the scroller,
          which meant it scrolled away from the field that produced it; the
          stream is the module's now, so it sits under the search bar where it
          answers the query it belongs to. Same condition as before: a live
          query, and something to count. */}
      {showDmChatSearch && dmChatSearch.trim() && dmMatchCount > 0 && (
        <div style={{ textAlign: 'center', padding: '8px 12px 0', backgroundColor: 'var(--bg-card-solid)', flexShrink: 0 }}>
          <span style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', backgroundColor: 'var(--bg-card)', padding: '4px 12px', borderRadius: '12px' }}>
            {dmMatchCount} matching messages
          </span>
        </div>
      )}

      {/* Location sharing indicator */}
      {dmSharingLocation && (
        <div style={{ padding: '8px 14px', background: 'linear-gradient(135deg, #059669, #047857)', flexShrink: 0, display: 'flex', alignItems: 'center', gap: '8px' }}>
          <div style={{ width: '8px', height: '8px', borderRadius: '4px', backgroundColor: '#34d399', animation: 'pulse 2s ease-in-out infinite', boxShadow: 'none' }} />
          <p style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: 'white', margin: 0, flex: 1 }}>Sharing live location with {selectedDm.name}</p>
          {dmMemberLocation && <span style={{ fontSize: 'var(--t-meta)', color: '#a7f3d0', fontWeight: '500' }}>{selectedDm.name} sharing too</span>}
          <button className="hit44" onClick={() => { dmStopSharingLocation(dmSharingLocation); setDmSharingLocation(null); }} style={{ padding: '4px 10px', borderRadius: '10px', border: '1px solid rgba(255,255,255,0.3)', background: 'rgba(255,255,255,0.15)', color: 'white', fontSize: 'var(--t-meta)', fontWeight: '600', cursor: 'pointer' }}>Stop</button>
        </div>
      )}

      {/* Pinned Venue Banner — top-voted or manually pinned venue */}
      {dmPinnedVenue ? (
        <div style={{ padding: '10px 14px', background: `linear-gradient(135deg, ${colors.navy}08, ${colors.steel}12)`, borderBottom: `1px solid ${colors.creamDark}`, flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            {dmPinnedVenue.photo_url ? (
              <img src={dmPinnedVenue.photo_url} alt="" style={{ width: '52px', height: '52px', borderRadius: '12px', objectFit: 'cover', flexShrink: 0, boxShadow: '0 2px 8px rgba(0,0,0,0.1)' }} onError={onVenuePhotoError} />
            ) : (
              <div style={{ width: '52px', height: '52px', borderRadius: '12px', background: colors.navyBg, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, boxShadow: '0 2px 8px rgba(13,40,71,0.10)' }}>
                {Icons.mapPin('white', 22)}
              </div>
            )}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <h4 style={{ fontSize: 'var(--t-label)', fontWeight: '600', color: colors.navy, margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{dmPinnedVenue.name}</h4>
                {dmPinnedVenue.rating && <span style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: '#F59E0B', display: 'flex', alignItems: 'center', gap: '2px', flexShrink: 0 }}>{Icons.starFilled('#F59E0B', 12)} {dmPinnedVenue.rating}</span>}
              </div>
              {dmPinnedVenue.addr && <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: '2px 0 0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{dmPinnedVenue.addr}</p>}
            </div>
            <div style={{ display: 'flex', gap: '4px', flexShrink: 0 }}>
              <button
                className="hit44 glass-btn glass-navy"
                onClick={() => {
                  leaveDmScreen();
                  setVenueDetailReturnTo({ tab: 'chat', screen: 'dmDetail', dmId: selectedDmId });
                  setCurrentTab('explore');
                  setCurrentScreen('main');
                  if (dmPinnedVenue.place_id) {
                    setTimeout(() => {
                      if (window.__flockPanToVenue) {
                        window.__flockPanToVenue({ place_id: dmPinnedVenue.place_id, name: dmPinnedVenue.name, address: dmPinnedVenue.addr, rating: dmPinnedVenue.rating, photo_url: dmPinnedVenue.photo_url });
                      }
                    }, 300);
                  }
                }}
                style={{ padding: '8px 10px', borderRadius: '10px', border: 'none', background: colors.steel, color: 'white', fontSize: 'var(--t-meta)', fontWeight: '600', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px', boxShadow: '0 1px 2px rgba(30,41,59,0.10)' }}
              >
                {Icons.mapPin('white', 12)} Map
              </button>
              <button className="hit44 glass-btn glass-secondary" onClick={() => { leaveDmScreen(); setPickingVenueForDm(true); setPickingVenueForCreate(true); setCurrentTab('explore'); setCurrentScreen('main'); }} style={{ padding: '8px 10px', borderRadius: '10px', border: `1px solid ${colors.creamDark}`, background: 'var(--bg-card-solid)', color: colors.navy, fontSize: 'var(--t-meta)', fontWeight: '600', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '3px' }}>
                Change
              </button>
            </div>
          </div>
        </div>
      ) : (
        <button className="hit44 glass-btn glass-secondary" onClick={() => { leaveDmScreen(); setPickingVenueForDm(true); setPickingVenueForCreate(true); setCurrentTab('explore'); setCurrentScreen('main'); }} style={{ margin: '0', padding: '10px 14px', background: `linear-gradient(135deg, var(--bg-primary), var(--bg-card-solid))`, borderBottom: `1px solid ${colors.creamDark}`, border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '10px', width: '100%', flexShrink: 0 }}>
          <div style={{ width: '40px', height: '40px', borderRadius: '12px', border: `2px dashed ${colors.steel}`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Icons.mapPin(colors.steel, 18)}</div>
          <div style={{ flex: 1, textAlign: 'left' }}>
            <p style={{ fontSize: 'var(--t-label)', fontWeight: '600', color: colors.navy, margin: 0 }}>Add a Venue</p>
            <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: '1px 0 0' }}>Pick a spot on the map</p>
          </div>
          <div style={{ color: colors.steel, fontWeight: '700', fontSize: 'var(--t-title)' }}>+</div>
        </button>
      )}

      {/* Vote panel. It is NOT identical to the flock's, which is what the
          sentence that stood here for months claimed, and that claim is how the
          missing rollback below hid: the flock votes over REST and reconciles
          against the response, this votes over a socket emit and reconciles
          against whether the emit went out. See commitDmVote. */}
      {showDmVotePanel && (() => {
        const myName = authUser?.name;
        const totalVoters = new Set(dmVenueVotes.flatMap(v => v.voters || [])).size;
        const myVote = dmVenueVotes.find(v => (v.voters || []).includes(myName))?.venue_name || null;
        const pinnedName = dmPinnedVenue?.name || null;

        const handleDmQuickVote = (venueName, venueId) => {
          // Captured before the optimistic rewrite below, so a send that never
          // left the device has something to put back. See commitDmVote.
          const previousVotes = dmVenueVotes;
          const existing = dmVenueVotes.find(v => v.venue_name === venueName);
          if (existing) {
            if ((existing.voters || []).includes(myName)) return; // already voted here
            // Switch vote: remove from old, add to new
            const newVotes = dmVenueVotes.map(v => ({
              ...v,
              voters: v.venue_name === venueName
                ? [...(v.voters || []), myName]
                : (v.voters || []).filter(x => x !== myName),
              vote_count: v.venue_name === venueName
                ? parseInt(v.vote_count || 0) + 1
                : (v.voters || []).includes(myName) ? parseInt(v.vote_count || 0) - 1 : parseInt(v.vote_count || 0),
            })).filter(v => parseInt(v.vote_count || 0) > 0 || v.venue_name === venueName);
            setDmVenueVotes(newVotes);
          } else {
            // New vote: remove from old venues, add new entry
            const newVotes = [
              ...dmVenueVotes.map(v => ({
                ...v,
                voters: (v.voters || []).filter(x => x !== myName),
                vote_count: (v.voters || []).includes(myName) ? parseInt(v.vote_count || 0) - 1 : parseInt(v.vote_count || 0),
              })).filter(v => parseInt(v.vote_count || 0) > 0),
              { venue_name: venueName, venue_id: venueId || null, vote_count: 1, voters: [myName] },
            ];
            setDmVenueVotes(newVotes);
          }
          if (commitDmVote(venueName, venueId, previousVotes, "Your vote didn't save.")) trackDmVenueVote();
        };

        const handleDmUnvote = () => {
          const previousVotes = dmVenueVotes;
          const newVotes = dmVenueVotes.map(v => ({
            ...v,
            voters: (v.voters || []).filter(x => x !== myName),
            vote_count: (v.voters || []).includes(myName) ? parseInt(v.vote_count || 0) - 1 : parseInt(v.vote_count || 0),
          })).filter(v => parseInt(v.vote_count || 0) > 0);
          setDmVenueVotes(newVotes);
          if (myVote) commitDmVote(myVote, dmVenueVotes.find(v => v.venue_name === myVote)?.venue_id, previousVotes, "Clearing your vote didn't save.");
        };

        const votesWithPinned = pinnedName && !dmVenueVotes.find(v => v.venue_name === pinnedName)
          ? [{ venue_name: pinnedName, venue_id: dmPinnedVenue?.place_id, vote_count: 0, voters: [], isPinned: true }, ...dmVenueVotes]
          : dmVenueVotes.map(v => ({ ...v, isPinned: v.venue_name === pinnedName }));
        const sortedVotes = [...votesWithPinned].sort((a, b) => {
          if (a.isPinned && !b.isPinned) return -1;
          if (b.isPinned && !a.isPinned) return 1;
          return parseInt(b.vote_count || 0) - parseInt(a.vote_count || 0);
        });
        const suggestedVenues = popularVenues.filter(v => !votesWithPinned.find(fv => fv.venue_name === v.name)).slice(0, 8);

        return (
          <div className="modal-backdrop" style={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'flex-end', zIndex: 50 }}>
            <DialogBehavior onClose={() => setShowDmVotePanel(false)} label="Vote on a venue" />
            <div className="modal-content" style={{ backgroundColor: 'var(--bg-card-solid)', borderRadius: '20px 20px 0 0', padding: '20px', width: '100%', maxHeight: '80%', overflowY: 'auto' }}>
              {/* Header */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                <div>
                  <h2 style={{ fontSize: 'var(--t-title)', fontWeight: '700', color: colors.navy, margin: 0, display: 'flex', alignItems: 'center', gap: '8px' }}>{Icons.vote(colors.navy, 20)} Vote for a Venue</h2>
                  {/* The tally is a count of other people, so it is only
                      printed when the read that produced it landed. */}
                  {!dmVenueVotesError && (
                    <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)', margin: '2px 0 0' }}>{totalVoters} vote{totalVoters !== 1 ? 's' : ''} cast{myVote ? ` • You voted for ${myVote}` : ''}</p>
                  )}
                </div>
                <button aria-label="Close" className="hit44" onClick={() => setShowDmVotePanel(false)} style={{ width: '32px', height: '32px', borderRadius: '16px', backgroundColor: 'var(--bg-hover)', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Icons.x(colors.textSecondary, 18)}</button>
              </div>

              {/* A failed read is said once, above the list, because the list
                  can be non empty on a failure: the pinned venue is added to
                  it locally and would otherwise sit there under a tally of
                  zero that nobody measured. */}
              {dmVenueVotesError && (
                <BirdNote
                  layout="row"
                  size={48}
                  role="alert"
                  body={dmVenueVotesError}
                  style={{ padding: '14px', backgroundColor: 'var(--bg-tertiary)', borderRadius: '14px', marginBottom: '12px' }}
                  action={<button className="hit44 glass-btn glass-navy" onClick={() => loadDmVenueVotes(selectedDmId)} style={{ padding: '8px 14px', borderRadius: '10px', border: 'none', background: colors.navyMidBg, color: 'white', fontWeight: '600', fontSize: 'var(--t-meta)', cursor: 'pointer' }}>Try again</button>}
                />
              )}

              {/* Current votes */}
              {sortedVotes.length > 0 ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '16px' }}>
                  {sortedVotes.map((v, idx) => {
                    const isMyVote = (v.voters || []).includes(myName);
                    const voteCount = parseInt(v.vote_count || 0);
                    const votePercent = totalVoters > 0 ? Math.round((voteCount / totalVoters) * 100) : 0;
                    const isLeading = !v.isPinned && idx === 0 && voteCount > 0;
                    const iconBg = v.isPinned
                      ? colors.navyBg
                      : isLeading ? colors.steel : `linear-gradient(135deg, ${colors.navy}15, ${colors.navy}25)`;
                    return (
                      <button key={v.venue_name} className="hit44 glass-btn glass-secondary" onClick={(e) => { confirmClick(e); isMyVote ? handleDmUnvote() : handleDmQuickVote(v.venue_name, v.venue_id); }} style={{ width: '100%', textAlign: 'left', padding: '12px 14px', borderRadius: '14px', border: v.isPinned ? `2px solid ${colors.navy}` : isMyVote ? `2px solid ${colors.navy}` : '1.5px solid var(--border-default)', backgroundColor: v.isPinned ? `${colors.navy}05` : isMyVote ? `${colors.navy}06` : 'var(--bg-card-solid)', cursor: 'pointer', position: 'relative', overflow: 'hidden', transition: 'opacity 0.2s' }}>
                        {/* Progress bar background */}
                        <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${votePercent}%`, backgroundColor: isMyVote ? `${colors.navy}10` : 'var(--bg-tertiary)', transition: 'width 0.4s ease', borderRadius: '14px' }} />
                        <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: '10px' }}>
                          <div style={{ width: '36px', height: '36px', borderRadius: '10px', background: iconBg, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                            {v.isPinned ? Icons.mapPin('white', 16) : isLeading ? Icons.flame('#fff', 18) : Icons.mapPin(colors.navy, 16)}
                          </div>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                              <h4 style={{ fontSize: 'var(--t-body)', fontWeight: '600', color: colors.navy, margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v.venue_name}</h4>
                              {v.isPinned && <span style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: 'white', backgroundColor: colors.navyBg, padding: '1px 6px', borderRadius: '6px', flexShrink: 0 }}>Pinned</span>}
                              {isLeading && <span style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: colors.steel, backgroundColor: `${colors.steel}15`, padding: '1px 6px', borderRadius: '6px', flexShrink: 0 }}>Leading</span>}
                            </div>
                            <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)', margin: '1px 0 0' }}>{(v.voters || []).length > 0 ? (v.voters || []).join(', ') : v.isPinned ? 'Current pinned venue. Tap to vote' : 'No votes yet'}</p>
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
                            {voteCount > 0 && <span style={{ fontSize: 'var(--t-body)', fontWeight: '600', color: isMyVote ? colors.navy : colors.textTertiary }}>{voteCount}</span>}
                            {isMyVote && <div style={{ width: '20px', height: '20px', borderRadius: '10px', backgroundColor: colors.navyBg, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Icons.check('white', 12)}</div>}
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              ) : !dmVenueVotesError && (
                /* Somebody else may well have voted. Saying nobody has, on the
                   strength of a request that never came back, is the version
                   of this panel that changes what the user does next. */
                <div style={{ padding: '20px', textAlign: 'center', backgroundColor: 'var(--bg-tertiary)', borderRadius: '14px', marginBottom: '16px' }}>
                  {userLocation ? (
                    <>
                      <BirdieStill bird={WARM_BIRD} size={64} style={{ margin: '0 auto 8px' }} />
                      <p style={{ fontSize: 'var(--t-label)', color: 'var(--text-tertiary)', margin: 0, fontWeight: '500' }}>{suggestedVenues.length > 0
                        ? 'No votes yet. Vote for a place below, or share one of your own.'
                        : 'No votes yet. Be the first to suggest a venue!'}</p>
                    </>
                  ) : (
                    /* The DM half of the fix ChatDetail already carries. With no
                       coordinate, suggestedVenues is location-fed and stays
                       empty, so this panel told a fresh account to "be the first
                       to suggest a venue" with nothing to suggest from, and the
                       only other door (Share a venue to chat) then claimed venue
                       search was down. Two screens in a row, both wrong about
                       the cause. Name the real one and open the door to it. */
                    <>
                      <BirdieStill bird={WARM_BIRD} size={64} style={{ margin: '0 auto 8px' }} />
                      <p style={{ fontSize: 'var(--t-label)', color: 'var(--text-tertiary)', margin: '0 0 12px', fontWeight: '500' }}>No votes yet. To see places to suggest, Flock needs your location.</p>
                      <button className="hit44 glass-btn glass-secondary" onClick={() => { leaveDmScreen(); setPickingVenueForDm(true); setPickingVenueForCreate(true); setCurrentTab('explore'); setCurrentScreen('main'); }} style={{ padding: '10px 18px', borderRadius: '12px', border: `1.5px solid ${colors.creamDark}`, backgroundColor: 'var(--bg-card-solid)', color: colors.navy, fontSize: 'var(--t-label)', fontWeight: '600', cursor: 'pointer' }}>Browse venues on Discover</button>
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
                      <button key={venue.id || venue.name} className="hit44 glass-btn glass-secondary" onClick={(e) => { confirmClick(e); handleDmQuickVote(venue.name, venue.place_id); }} style={{ width: '100%', textAlign: 'left', padding: '10px 12px', borderRadius: '12px', border: '1px solid var(--border-default)', backgroundColor: 'var(--bg-card-solid)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '10px', transition: 'opacity 0.2s', position: 'relative', overflow: 'hidden' }}>
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
              <button className="hit44 glass-btn glass-secondary" onClick={() => { setShowDmVotePanel(false); setShowDmVenueSearch(true); }} style={{ width: '100%', padding: '12px', borderRadius: '12px', border: `2px dashed ${colors.creamDark}`, backgroundColor: 'transparent', color: 'var(--text-tertiary)', fontSize: 'var(--t-label)', fontWeight: '600', cursor: 'pointer', marginTop: '12px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}>
                {Icons.plus(colors.textTertiary, 14)} Share a venue to chat
              </button>
            </div>
          </div>
        );
      })()}

      {/* Venue Share Modal — matches flock style exactly */}
      {showDmVenueSearch && (
        <div className="modal-backdrop" style={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'flex-end', zIndex: 50 }}>
            <DialogBehavior onClose={() => setShowDmVenueSearch(false)} label="Share a venue" />
          <div className="modal-content" style={{ backgroundColor: 'var(--bg-card-solid)', borderRadius: '20px 20px 0 0', padding: '20px', width: '100%', maxHeight: '70%', overflowY: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
              <h2 style={{ fontSize: 'var(--t-title)', fontWeight: '700', color: colors.navy, margin: 0, display: 'flex', alignItems: 'center', gap: '8px' }}>{Icons.mapPin(colors.navy, 20)} Share a Venue</h2>
              <button aria-label="Close" className="hit44" onClick={() => setShowDmVenueSearch(false)} style={{ width: '32px', height: '32px', borderRadius: '16px', backgroundColor: 'var(--bg-hover)', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Icons.x(colors.textSecondary, 18)}</button>
            </div>

            {/* Current pinned venue display */}
            {dmPinnedVenue ? (
              <div style={{ padding: '12px', borderRadius: '14px', background: `linear-gradient(135deg, ${colors.navy}08, ${colors.steel}15)`, border: `2px solid ${colors.steel}40`, marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '10px' }}>
                <div style={{ width: '40px', height: '40px', borderRadius: '10px', background: colors.steel, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  {Icons.mapPin('white', 18)}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <p style={{ fontSize: 'var(--t-micro)', fontWeight: '700', color: colors.steel, margin: '0 0 2px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Pinned Venue</p>
                  <p style={{ fontSize: 'var(--t-body)', fontWeight: '600', color: colors.navy, margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{dmPinnedVenue.name}</p>
                  {dmPinnedVenue.addr && <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: '2px 0 0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{dmPinnedVenue.addr}</p>}
                </div>
                <button className="hit44 glass-btn glass-primary" onClick={(e) => { confirmClick(e); sendDmMessage({ text: `Check out ${dmPinnedVenue.name}!`, message_type: 'venue_card', venue_data: { name: dmPinnedVenue.name, addr: dmPinnedVenue.addr, stars: dmPinnedVenue.rating, rating: dmPinnedVenue.rating, photo_url: dmPinnedVenue.photo_url, place_id: dmPinnedVenue.place_id }, noReply: true }); setShowDmVenueSearch(false); }} style={{ padding: '8px 12px', borderRadius: '10px', border: 'none', background: colors.steel, color: 'white', fontSize: 'var(--t-meta)', fontWeight: '600', cursor: 'pointer', whiteSpace: 'nowrap', position: 'relative', overflow: 'hidden' }}>Share This</button>
              </div>
            ) : (
              <div style={{ padding: '10px 12px', borderRadius: '12px', backgroundColor: 'var(--bg-tertiary)', border: '1px solid var(--border-default)', marginBottom: '16px' }}>
                <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: 0, fontStyle: 'italic' }}>No venue pinned. Pick one below:</p>
              </div>
            )}

            <p style={{ fontSize: 'var(--t-micro)', fontWeight: '700', color: 'var(--text-secondary)', marginBottom: '12px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Or select a different venue:</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {allVenues.length === 0 ? (
                /* Venue search down = an empty list under "Or select a
                   different venue", the blank dead end B3 fixed on the flock
                   sheet (ChatDetail). Same honesty here: say why, offer the
                   one real exit. */
                <div style={{ padding: '16px', borderRadius: '14px', backgroundColor: 'var(--bg-tertiary)', border: '1px solid var(--border-default)', textAlign: 'center' }}>
                  <BirdieStill size={64} style={{ margin: '0 auto 8px' }} />
                  <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: '0 0 12px', lineHeight: '1.5' }}>{userLocation
                    ? 'No venues to show here. Venue search is unavailable right now, so there is nothing to pick from yet.'
                    /* allVenues is only ever filled by loadVenuesAtLocation, so
                       with no coordinate it is empty because nothing was ever
                       asked, not because the ask failed. Blaming search told a
                       fresh account a working feature was broken, which is the
                       sentence ChatDetail's own comment says it fixed there. */
                    : "No venues to show yet, because Flock doesn't have your location. Turn it on from the Discover tab and this list fills in."}</p>
                  <button className="hit44 glass-btn glass-secondary" onClick={() => setShowDmVenueSearch(false)} style={{ padding: '10px 20px', borderRadius: '12px', border: `1.5px solid ${colors.creamDark}`, backgroundColor: 'var(--bg-card-solid)', color: colors.navy, fontSize: 'var(--t-label)', fontWeight: '600', cursor: 'pointer' }}>Close</button>
                </div>
              ) : allVenues.map(venue => (
                <button className="hit44"
                  key={venue.id}
                  onClick={(e) => {
                    confirmClick(e);
                    sendDmMessage({ text: `Check out ${venue.name}!`, message_type: 'venue_card', venue_data: { name: venue.name, addr: venue.addr, stars: venue.stars, rating: venue.rating || venue.stars, price: venue.price, price_level: venue.price_level, photo_url: venue.photo_url, place_id: venue.place_id, category: venue.category, type: venue.type, crowd: venue.crowd }, noReply: true });
                    setShowDmVenueSearch(false);
                  }}
                  style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '12px', borderRadius: '14px', border: '1px solid var(--border-default)', backgroundColor: 'var(--bg-card-solid)', cursor: 'pointer', textAlign: 'left', transition: 'opacity 0.2s ease' }}
                >
                  {/* The row is about to SEND this venue's photo_url to the
                      other person, and it was drawing a category gradient
                      instead of showing it. The "Popular Chains Nearby" rows
                      thirty lines up already render a 36px photo, so the
                      gradient here was the outlier, not the standard. The icon
                      tile stays as the fallback for a venue Google has no photo
                      of, which is the only reason to show none. */}
                  {venue.photo_url ? (
                    <img
                      src={resolveVenuePhoto(venue.photo_url)}
                      alt=""
                      style={{ width: '44px', height: '44px', borderRadius: '12px', objectFit: 'cover', flexShrink: 0 }}
                      onError={(e) => { e.target.onerror = null; e.target.src = '/marks/venue-placeholder.jpg'; }}
                    />
                  ) : (
                    <div style={{ width: '44px', height: '44px', borderRadius: '12px', background: `linear-gradient(135deg, ${getCategoryColor(venue.category)}, ${getCategoryColor(venue.category)}cc)`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      {venue.category === 'Food' ? Icons.pizza('white', 20) : venue.category === 'Nightlife' ? Icons.cocktail('white', 20) : venue.category === 'Live Music' ? Icons.music('white', 20) : Icons.sports('white', 20)}
                    </div>
                  )}
                  <div style={{ flex: 1 }}>
                    <p style={{ fontSize: 'var(--t-body)', fontWeight: '600', color: colors.navy, margin: 0 }}>{venue.name}</p>
                    <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: '2px 0 0' }}>{venue.type} {venue.price ? `\u2022 ${venue.price}` : ''}</p>
                  </div>
                  {typeof venue.crowd === 'number' && <div style={{ padding: '4px 10px', borderRadius: '12px', backgroundColor: venue.crowd > 84 ? '#FEE2E2' : venue.crowd > 39 ? '#FEF3C7' : '#D1FAE5', color: venue.crowd > 84 ? colors.red : venue.crowd > 39 ? colors.amber : colors.steel, fontSize: 'var(--t-meta)', fontWeight: '500' }}>
                    {venue.crowd}%
                  </div>}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Delete DM Confirmation Modal */}
      {showDeleteDmConfirm && (
        <div style={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 60, padding: '16px' }}>
            <DialogBehavior onClose={() => setShowDeleteDmConfirm(false)} label="Delete conversation" />
          <div style={{ backgroundColor: 'var(--bg-card-solid)', borderRadius: '24px', padding: '24px', width: '100%', maxWidth: '300px' }}>
            <div style={{ textAlign: 'center', marginBottom: '16px' }}>
              <div style={{ width: '48px', height: '48px', borderRadius: '24px', backgroundColor: 'var(--accent-red-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 12px' }}>{Icons.x('#EF4444', 24)}</div>
              <h3 style={{ fontSize: 'var(--t-title)', fontWeight: '700', color: colors.navy, margin: '0 0 8px' }}>Delete Conversation?</h3>
              <p style={{ fontSize: 'var(--t-label)', color: 'var(--text-secondary)', margin: 0, lineHeight: '1.4' }}>Delete this conversation with {selectedDm.name}? Messages will be removed from your view.</p>
            </div>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button className="hit44 glass-btn glass-secondary" onClick={() => setShowDeleteDmConfirm(false)} style={{ flex: 1, padding: '12px', borderRadius: '12px', border: `2px solid ${colors.creamDark}`, backgroundColor: 'var(--bg-card-solid)', color: colors.navy, fontWeight: '600', fontSize: 'var(--t-body)', cursor: 'pointer' }}>Cancel</button>
              <button className="hit44 glass-btn glass-danger" onClick={() => {
                const dmUserId = selectedDm.userId;
                setDirectMessages(prev => prev.filter(d => d.userId !== dmUserId));
                const updated = [...deletedDmUserIds, dmUserId];
                setDeletedDmUserIds(updated);
                try { localStorage.setItem('flock_deleted_dms', JSON.stringify(updated)); } catch {}
                leaveDmScreen();
                setCurrentScreen('main');
                             }} style={{ flex: 1, padding: '12px', borderRadius: '12px', border: 'none', backgroundColor: '#EF4444', color: 'white', fontWeight: '600', fontSize: 'var(--t-body)', cursor: 'pointer' }}>Delete</button>
            </div>
          </div>
        </div>
      )}

      {/* Image preview modal */}
      {showDmImagePreview && dmPendingImage && (
        <div style={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(0,0,0,0.9)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', zIndex: 50, padding: '20px' }}>
          <DialogBehavior onClose={() => { setShowDmImagePreview(false); setDmPendingImage(null); }} label="Send this photo" />
          <img src={dmPendingImage} alt="Preview" style={{ maxWidth: '100%', maxHeight: '60%', borderRadius: '12px', objectFit: 'contain' }} />
          <div style={{ display: 'flex', gap: '12px', marginTop: '20px' }}>
            <button className="hit44 glass-btn glass-secondary" onClick={() => { setShowDmImagePreview(false); setDmPendingImage(null); }} style={{ padding: '12px 24px', borderRadius: '24px', border: '2px solid var(--bg-card-solid)', backgroundColor: 'transparent', color: 'white', fontSize: 'var(--t-body)', fontWeight: '600', cursor: 'pointer' }}>Cancel</button>
            {/* An image-only message: text is '', not the word "Photo". The
                explicit '' also stops the composer's half-typed draft from
                being swept in as a caption. */}
            <button className="hit44 glass-btn glass-navy" onClick={() => { const img = dmPendingImage; setShowDmImagePreview(false); setDmPendingImage(null); sendDmMessage({ text: '', message_type: 'image', image_url: img, noReply: true }); }} style={{ padding: '12px 24px', borderRadius: '24px', border: 'none', background: colors.navyBg, color: 'white', fontSize: 'var(--t-body)', fontWeight: '600', cursor: 'pointer' }}>Send</button>
          </div>
        </div>
      )}

      {/* Messages area */}
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

      {/* THE STREAM. MessageList owns the scroll from here on: it lands on the
          newest message when the thread opens, follows the tail on your own
          send and never on somebody else's arrival, raises "N new messages"
          instead when one lands while you are reading back, and corrects the
          offset by the exact height that appeared when an older page goes in
          above you. The div that used to be here did none of that, and it
          blurred the focused field on every scroll event, which is why the
          keyboard shut itself whenever a message arrived and moved the list.
          That handler is not carried over in any form.

          Rows, not messages: dmRows is the search-filtered, quote-resolved,
          match-highlighted view of the thread. Everything a handler hands back
          to the app shell goes through originalDmRow first. */}
      <MessageList
        rows={dmRows}
        /* The other person's id. App.js mounts this screen with no key, so a
           jump straight from one conversation into another reuses the
           component; without this the second thread would inherit the first
           one's scroll position and its unread count. */
        threadKey={selectedDmId}
        myId={myDmId}
        ownName="You"
        /* A member's colour is a fact about a conversation, so it arrives as a
           prop rather than out of a stylesheet. Two people here: the viewer
           takes the module's accent and the other person the neutral fallback
           MessageList already defaults to. Tokens, never literals, so both
           themes are answered. --chat-accent is defined by the module's own
           cards.css, which VenueCardRow below pulls in; the second value keeps
           the name legible if that ever stops being true. */
        ownColour="var(--chat-accent, var(--accent-purple-text))"
        renderCard={renderDmCard}
        renderStatus={renderDmStatus}
        /* Scrollback. The button and its Loading state are the module's; the
           condition behind atTop is this screen's, unchanged. */
        onLoadOlder={() => loadOlderDms(selectedDmId, oldestServerId(dmSourceRows))}
        atTop={!dmCanLoadOlder}
        olderLoading={olderLoading}
        onLongPress={openDmActions}
        onSwipeReply={startDmReply}
        onOpenImage={(m) => openImageViewer(originalDmRow(m))}
        onReactionTap={toggleDmReaction}
        loadingState={dmMessagesLoading && selectedDm.messages.length === 0 ? (
          <ChatSkeleton label={`Loading your messages with ${selectedDm.name}`} />
        ) : null}
        emptyState={dmSearchQuery ? (
          <div style={{ textAlign: 'center', padding: '40px 20px' }}>
            <p style={{ fontSize: 'var(--t-body)', color: 'var(--text-tertiary)', fontWeight: '500' }}>No messages match "{dmChatSearch}"</p>
          </div>
        ) : (
          <div style={{ textAlign: 'center', padding: '40px 20px' }}>
            <div style={{ width: '60px', height: '60px', borderRadius: '30px', background: colors.navyBg, margin: '0 auto 12px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 'var(--t-display)', fontWeight: '600', color: 'white', overflow: 'hidden' }}>
              {selectedDm.image ? <img src={selectedDm.image} alt="" style={{ width: '60px', height: '60px', borderRadius: '30px', objectFit: 'cover' }} /> : (selectedDm.name?.[0]?.toUpperCase() || '?')}
            </div>
            <h3 style={{ fontSize: 'var(--t-title)', fontWeight: '700', color: colors.navy, margin: '0 0 4px' }}>{dmBlocked[String(selectedDmId)] ? selectedDm.name : `Chat with ${selectedDm.name}`}</h3>
            {/* A blocked pair is shown no messages at all, so this is where a
                conversation with months of history landed. It must not read as
                a fresh chat waiting for a hello. */}
            <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: 0 }}>{dmBlocked[String(selectedDmId)] ? 'These messages are not available.' : 'Say hi to start the conversation.'}</p>
            <BirdieStill bird={WARM_BIRD} size={64} style={{ margin: '16px auto 0' }} />
          </div>
        )}
      />

      {/* The server refused this conversation. Standing, not a toast: retrying
          will be refused identically, so the screen has to say what is wrong
          and offer the one action that changes the answer. The wording covers
          both halves of the server's single refusal, since the account may not
          exist at all, without telling the sender which one it was, which
          whole reason that refusal is one sentence. */}
      {/* Blocked, either direction. The composer below is replaced rather than
          disabled: a greyed-out text field with no explanation is the state
          this is fixing. */}
      {dmBlocked[String(selectedDmId)] && (
        <div style={{ padding: '14px 16px calc(14px + var(--safe-bottom))', borderTop: '1px solid var(--divider)', backgroundColor: 'var(--bg-tertiary)', flexShrink: 0 }}>
          <p style={{ fontSize: 'var(--t-label)', fontWeight: '600', color: 'var(--text-primary)', margin: '0 0 4px' }}>You can no longer message {selectedDm.name}</p>
          <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: 0, lineHeight: 1.5 }}>
            This conversation is closed on both sides. Anyone you have blocked yourself can be unblocked in Settings, under Blocked accounts.
          </p>
        </div>
      )}

      {!dmBlocked[String(selectedDmId)] && dmNotConnected[selectedDmId] && (
        <div style={{ padding: '12px 14px', borderTop: '1px solid var(--divider)', backgroundColor: 'var(--bg-tertiary)', flexShrink: 0 }}>
          <p style={{ fontSize: 'var(--t-label)', fontWeight: '600', color: 'var(--text-primary)', margin: '0 0 4px' }}>You are not connected to {selectedDm.name} yet</p>
          <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: '0 0 10px', lineHeight: 1.5 }}>
            Messages start going through once they accept your friend request. Until then nothing you send here is delivered.
          </p>
          <button
            className="hit44 glass-btn glass-secondary"
            disabled={dmRequestSending}
            onClick={async () => {
              setDmRequestSending(true);
              try {
                await sendFriendRequest(selectedDmId);
                showToast(`Friend request sent to ${selectedDm.name}.`);
              } catch (err) {
                showToast(err?.message || "That request didn't send. Try again.", 'error');
              } finally {
                setDmRequestSending(false);
              }
            }}
            style={{ padding: '10px 14px', borderRadius: '12px', border: `1.5px solid ${colors.creamDark}`, backgroundColor: 'var(--bg-card-solid)', color: colors.navy, fontSize: 'var(--t-label)', fontWeight: '600', cursor: dmRequestSending ? 'default' : 'pointer', opacity: dmRequestSending ? 0.6 : 1 }}
          >
            {dmRequestSending ? 'Sending request' : 'Send a friend request'}
          </button>
        </div>
      )}

      {/* TYPING, IN ONE STRIP ABOVE THE COMPOSER. This replaces the fixed 50px
          slot that used to sit at the bottom of the stream and cost that height
          all the time to say something true for a few seconds an hour. The
          strip collapses to nothing when nobody is typing, and the list above
          is bottom anchored, so it slides the stream up under itself rather
          than pushing the composer down.

          MOUNTED UNCONDITIONALLY, and that is not an oversight. TypingRow keeps
          a clipped live region alive whether or not anybody is here, because a
          screen reader only announces text arriving in a region that was
          already in the tree. Rendering it conditionally would put the region
          back to being created together with its first sentence, which
          VoiceOver routinely says nothing about.

          NO PRESENCE CLAIM. `present` is false because this screen has no
          presence data: the socket says who is typing and nothing more. The
          header's own dot is a connection reading about the viewer, not about
          the other person, and it is not repeated here. */}
      <TypingRow
        members={[{
          id: selectedDmId,
          name: dmTypingUser || selectedDm.name,
          colour: 'var(--chat-name-fallback)',
          avatarUrl: selectedDm.image,
          present: false,
          typing: !!dmIsTyping,
        }]}
      />

      {/* Reply bar */}
      {dmReplyingTo && (
        <div style={{ padding: '8px 12px', borderTop: '1px solid var(--divider)', backgroundColor: 'var(--bg-tertiary)', display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
          <div style={{ flex: 1, paddingLeft: '10px', borderRadius: '8px', backgroundColor: 'var(--bg-tertiary)', padding: '6px 10px' }}>
            <span style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: colors.navy }}>Replying to {dmReplyingTo.sender}</span>
            <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: '1px 0 0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{messagePreview(dmReplyingTo)}</p>
          </div>
          <button aria-label="Cancel reply" className="hit44" onClick={() => setDmReplyingTo(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '4px' }}>{Icons.x(colors.textSecondary, 14)}</button>
        </div>
      )}

      {/* Input bar — text + camera + venue search + send */}
      {/* DM composer. The DM conversation screen does not render the tab bar,
          so this row IS the bottom of the phone and carries the home-indicator
          inset itself (SAFE-AREA CONTRACT in index.css). It is not rendered at
          all for a blocked pair: the bar above has taken its place and its
          safe-area inset with it. */}
      {!dmBlocked[String(selectedDmId)] && (
      <div style={{ padding: '10px 12px calc(10px + var(--safe-bottom))', borderTop: '1px solid var(--divider)', backgroundColor: 'var(--bg-card-solid)' }}>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          {/* Camera and camera roll, both one tap (see the flock composer). */}
          <button aria-label="Take a photo" className="hit44" onClick={() => openCameraViewfinder('dm')} style={{ width: '36px', height: '36px', borderRadius: '18px', backgroundColor: 'var(--bg-hover)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0, border: 'none', position: 'relative' }}>
            {Icons.camera(colors.textSecondary, 16)}
          </button>
          <button aria-label="Choose a photo from your library" className="hit44" onClick={() => dmGalleryInputRef.current?.click()} style={{ width: '36px', height: '36px', borderRadius: '18px', backgroundColor: 'var(--bg-hover)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0, border: 'none' }}>
            {Icons.image(colors.textSecondary, 16)}
          </button>
          <input ref={dmGalleryInputRef} type="file" accept="image/*" onChange={handleDmImageSelect} style={{ display: 'none' }} />
          {/* Location share button */}
          <button aria-label="Share your location" className="hit44" onClick={() => { if (dmSharingLocation) { dmStopSharingLocation(dmSharingLocation); setDmSharingLocation(null); setDmMemberLocation(null); } else { startDmLocationSharing(selectedDmId); } }} style={{ width: '36px', height: '36px', borderRadius: '18px', backgroundColor: dmSharingLocation ? '#10b981' : 'var(--bg-hover)', border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0 }}>{Icons.mapPin(dmSharingLocation ? 'white' : colors.textSecondary, 16)}</button>
          {/* minWidth:0 / flexShrink:0 — same story as the flock composer. */}
          <input data-dm-input aria-label="Message" type="text" defaultValue="" onChange={handleDmInputChange} onKeyDown={(e) => e.key === 'Enter' && sendDmMessage()} placeholder={dmReplyingTo ? `Reply...` : `Message ${selectedDm.name}...`} style={{ flex: '1 1 0%', minWidth: 0, padding: '15px 18px', borderRadius: '24px', backgroundColor: 'var(--bg-hover)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)', fontSize: '16px', outline: 'none' }} autoComplete="off" />
          <button aria-label="Send" className="hit44 glass-btn glass-navy" onClick={() => sendDmMessage()} disabled={!chatInputHasText} style={{ width: '42px', height: '42px', minWidth: '42px', flexShrink: 0, borderRadius: '21px', border: 'none', background: chatInputHasText ? colors.navyBg : 'var(--pill-bg)', color: 'white', cursor: chatInputHasText ? 'pointer' : 'default', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Icons.send('white', 18)}</button>
        </div>
      </div>
      )}

      {/* MESSAGE ACTIONS, ON A LONG PRESS.
          Every action the tap-to-open picker carried is here and none of them
          changed: the quick emoji, View photo, Unsend, Reply, Report. Only the
          trigger moved. MessageRow reports a 350ms press through onLongPress
          with the message and the row's own rect and draws no menu itself, so
          the menu is the screen's, which is also why a card, a photo or a
          reaction pill inside the row keeps its own tap.

          Positioned against the row and centred across the phone: at 320px a
          menu anchored to the row's left edge runs off the screen the moment
          the row is a wide one. The backdrop is a real button rather than a
          div with an onClick, so dismissing it is reachable without a pointer,
          and DialogBehavior brings the same Escape and focus handling every
          other sheet on this screen already has. */}
      {dmActionMessage && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 300 }}>
          <DialogBehavior onClose={closeDmActions} label="Message actions" />
          <button
            aria-label="Close message actions"
            className="hit44"
            onClick={closeDmActions}
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', background: 'transparent', border: 'none', padding: 0, cursor: 'default' }}
          />
          <div
            role="group"
            aria-label="Message actions"
            style={{ position: 'absolute', top: `${dmActionTop}px`, left: '50%', transform: 'translateX(-50%)', maxWidth: 'calc(100% - 24px)', display: 'flex', flexWrap: 'wrap', justifyContent: 'center', alignItems: 'center', gap: '4px', backgroundColor: 'var(--bg-card-solid)', border: '1px solid var(--border-subtle)', borderRadius: '16px', padding: '4px 8px', boxShadow: 'var(--card-shadow)' }}
          >
            {dmReactions.map(emoji => (
              <button aria-label={`React with ${emoji}`} className="hit44" key={emoji} onClick={(e) => { e.stopPropagation(); const m = dmActionMessage; if (!dmReact(m.id, emoji, selectedDmId)) addDmReaction(m.id, emoji).catch(() => showToast('Could not react. Try again.', 'error')); setShowDmReactionPicker(null); }} style={{ fontSize: 'var(--t-title)', background: 'none', border: 'none', cursor: 'pointer', padding: '4px', borderRadius: '8px', transition: 'transform 0.15s' }}
                onMouseEnter={(e) => { e.currentTarget.style.transform = 'scale(1.3)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.transform = 'scale(1)'; }}
              >{emoji}</button>
            ))}
            {dmActionMessage.sender === 'You' && typeof dmActionMessage.id === 'number' && dmActionMessage.id <= 2147483647 && (
              <button aria-label="Unsend message" className="hit44" onClick={(e) => { e.stopPropagation(); const id = dmActionMessage.id; closeDmActions(); handleUnsendDm(id); }} style={{ fontSize: 'var(--t-meta)', background: 'none', border: 'none', cursor: 'pointer', padding: '4px 6px', borderRadius: '8px', color: 'var(--text-secondary)', fontWeight: '600' }} title="Unsend">Unsend</button>
            )}
            {dmActionMessage.message_type === 'image' && (dmActionMessage.image_url || dmActionMessage.thumb_url) && (
              <button aria-label="View photo full size" className="hit44" onClick={(e) => { e.stopPropagation(); const m = dmActionMessage; closeDmActions(); openImageViewer(m); }} style={{ fontSize: 'var(--t-body)', background: 'none', border: 'none', cursor: 'pointer', padding: '4px 6px', borderRadius: '8px', color: colors.navy, fontWeight: '600' }} title="View photo">{Icons.eye(colors.navy, 14)}</button>
            )}
            <button aria-label="Reply" className="hit44" onClick={(e) => { e.stopPropagation(); startDmReply(dmActionMessage); }} style={{ fontSize: 'var(--t-body)', background: 'none', border: 'none', cursor: 'pointer', padding: '4px 6px', borderRadius: '8px', color: colors.navy, fontWeight: '600' }} title="Reply">{Icons.reply(colors.navy, 14)}</button>
            {dmActionMessage.sender !== 'You' && (
              <button aria-label="Report" className="hit44" onClick={(e) => { e.stopPropagation(); const id = dmActionMessage.id; closeDmActions(); setModerationTarget({ userId: selectedDmId, userName: selectedDm.name, contentType: 'dm', contentId: id }); }} style={{ fontSize: 'var(--t-body)', background: 'none', border: 'none', cursor: 'pointer', padding: '4px 6px', borderRadius: '8px', color: '#EF4444', fontWeight: '600' }} title="Report">{Icons.flag('#EF4444', 15)}</button>
            )}
          </div>
        </div>
      )}

    </div>
  );
}