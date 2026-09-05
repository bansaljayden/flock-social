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
 *
 * WHAT THE CHAT REBUILD TOOK OUT OF THIS FILE (2026-09-05)
 *
 * Three things, and nothing else. The message stream, the composer and the
 * typing indicator are `components/chat` now, imported through that module's
 * one index and nowhere deeper. The header, the Features rail, the plan bar,
 * the pinned venue banner, the bill bar, the ghost commit card, the momentum
 * meter and every sheet below are untouched and stay exactly where they are;
 * re-homing those is a later pass and doing it here would have made this diff
 * unreadable, which is the same reason the DM thread moved out separately.
 *
 * The deletions are the point of the swap, so they are named here as well as
 * where they happened. The `<div onScroll>` is gone, and with it the blur()
 * it ran on the focused input on every scroll event, which is what closed the
 * keyboard whenever a message arrived. The "Jump to latest" pill, the writes
 * to chatNearBottomRef and the end-ref sentinel went with it. The per-message
 * avatar, name, bullet, timestamp and bubble are gone: a run carries its
 * sender's name once, in that person's colour, with a bar down its left. The
 * fixed 58px typing slot is gone. The always-present Send button at 45%
 * opacity is gone.
 *
 * FIVE PROPS ARE NOW UNREAD and stay in the parameter list on purpose:
 * VenueCard, getRelativeTime, profilePic, isDark and colorsLight. It was seven
 * until the two scroll refs went: chatEndRef and chatNearBottomRef existed only
 * to feed a tail-follow effect in App.js, and MessageList does that work now,
 * so App.js no longer computes them and there is nothing left to keep in step. `__tests__/extractionEquivalence.test.js` pins this
 * list against what App.js passes, so dropping a name here would fail there
 * and would also hide the fact that App.js still computes them.
 *
 * REPLIES ARE STILL NOT WIRED. MessageRow reports a right swipe and
 * ChatInputBar can draw a quote bar, and neither is connected on this surface
 * because `messages` has no reply column. See the note at the composer.
 */
import React from 'react';
import { leaveFlock as apiLeaveFlock, createBillSplit, createFlockInviteLink, getFlockMessageImage, getPaymentLinks, ghostCommit, lockBudget, sendBudgetReminder, settleShare, submitBudget, trackNotificationPermission, unsettleShare, getBillSplit } from '../services/api';
import { getSocket, leaveFlock } from '../services/socket';
import { getNotificationStatus, requestNotificationPermission } from '../services/firebase';
import { BirdieStill, BirdNote, WARM_BIRD } from '../components/ui/BirdieBird';
import Icons from '../components/ui/Icons';


/* THE CHAT MODULE'S ONE DOOR. The stream, the composer and the typing strip
   are `components/chat` now, and this screen imports from that index and from
   no file inside it, so the module's surface is one line to keep in step with
   rather than a dozen paths spread through a 2,400 line screen. */
import {
  ChatInputBar,
  ComposerPlusSheet,
  MessageList,
  StatusLine,
  TypingRow,
  VenueCardRow,
} from '../components/chat';
import { VENUE_PHOTO_PLACEHOLDER } from '../lib/venuePhoto';

/* THE DAY SEPARATORS LEFT THIS FILE. `dayKeyOf`, `dayLabelOf` and
   `daySeparatorFor` were declared here and mirrored verbatim in DmDetail.js:
   two copies of the one rule that decides where history is cut. They live in
   `components/chat/groupRows.js` now, which MessageList calls for both
   surfaces, so a divider cannot move on one and stay put on the other. The
   vocabulary is unchanged, deliberately: Today, Yesterday, the weekday, the
   dated weekday, and a row with no sentAt still inherits the previous dated
   row's day rather than inventing a boundary of its own. */



/**
 * A search term marked inside a message body.
 *
 * The stream draws `message.text`, whatever that is, so a highlighted row
 * carries an ARRAY of nodes rather than a string. That is the one thing the
 * chat module deliberately leaves to the caller, because a highlight belongs
 * to whoever owns the search box.
 *
 * DUPLICATED IN DmDetail.js, and it should not be. The two screens run the
 * same rule over the same shape and the module is where a rule like that
 * stops being two things that can drift, but `components/chat` is not this
 * pass's to edit. It wants an export next to `groupRows`.
 *
 * The term is escaped before it becomes a pattern: a person searching for
 * "$5 (each)" is not writing a regular expression, and an unescaped one throws
 * inside render, which React answers by unmounting the app.
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

/**
 * How much of a bill is settled, RIGHT NOW.
 *
 * `GET /api/billing/:flockId` sends `fullySettled`, `settledCount` and
 * `shareCount`, and the sheet read them with `??`, which only falls back on
 * null or undefined. So after the first read those three were frozen: every
 * settle path afterwards rewrites `shares` and touches none of them, local
 * settle and unsettle included, and both socket handlers included. A three
 * person bill therefore read "1/3 settled" while the row turned green and the
 * "Everyone's settled up" toast arrived, and the All settled up panel never
 * rendered until the chat was left and re-entered. The same row contradicted
 * itself, too: the icon colour beside it used the raw `shares` test with no
 * `??` and was right while the sentence beside it was wrong.
 *
 * `shares` is the array every one of those paths updates, so it is the answer.
 * The server counts stay as the fallback for a body that carried no shares.
 */
const billTally = (bill) => {
  const shares = Array.isArray(bill?.shares) ? bill.shares : [];
  const visibleSettled = shares.filter((sh) => sh.settled).length;
  // THE ARRAY IS BLOCK-FILTERED; THE COUNTS ARE NOT. billing.js computes
  // fullySettled/settledCount/shareCount over every row and then sends
  // `shares` with anyone you have blocked removed. Counting the array alone
  // therefore forgot those people entirely: block one member of a three-way
  // split, settle the other two, and the header and the green panel both
  // declared the bill square while a third of it was still owed. The person
  // is hidden from the list; their share is not hidden from the total.
  //
  // WHO KEEPS THE COUNTS CURRENT. The server sends the three on GET, on
  // bill_created, on the settle and unsettle responses, and as a bill_tally
  // event to every member after any settlement moves, blocked or not, because
  // the tally names nobody. share_settled and share_unsettled name the actor,
  // are block-filtered, and touch only the array. So for the rows you cannot
  // see the server's settled count is the truth (round 2 of the adversarial
  // audit: the settled figure used to be the visible array's own count, which
  // undercounted a hidden settled row from the first render), and the array
  // covers the one thing the server has not confirmed yet: an optimistic
  // local change. The square claim is the array's when nothing is hidden and
  // the server's when something is.
  //
  // (Deliberately phrased without the two button/banner strings: the source
  // contract in __tests__/billUnsettle.test.js slices the panel between
  // them, and repeating either up here moves its anchor.)
  const total = Math.max(shares.length, Number(bill?.shareCount) || 0);
  const hidden = total - shares.length;
  const settled = Math.min(total, Math.max(visibleSettled, Number(bill?.settledCount) || 0));
  return {
    settled,
    total,
    all: total > 0 && (hidden === 0 ? visibleSettled === shares.length : !!bill?.fullySettled),
  };
};

// The three tallies off a settle or unsettle response, when it carried them.
// An older server answers `{ settled }` alone, and nothing is overwritten by
// undefined.
const tallyOf = (r) => (r && Number.isFinite(Number(r.shareCount))
  ? { shareCount: Number(r.shareCount), settledCount: Number(r.settledCount) || 0, fullySettled: !!r.fullySettled }
  : {});

/**
 * The money words on one share row, and the figure Settle Up asks for.
 *
 * Since migration 061 a share carries `paidAmount`, the credit brought across
 * from an earlier version of the bill, beside `amount`, and the two disagree
 * in both directions. Ben paid $30, the bill was raised, his share is now
 * $100: he is asked for $70, not $100. A share revised below a payment keeps
 * the payment on the row as the record of what he is owed back. The payment
 * picker already asked for the outstanding figure while this row printed the
 * whole share beside it, so one sheet named two different debts for one
 * person.
 *
 * A figure the server withholds (a shell whose flock has fallen under three
 * present sharers) arrives as null, and `null?.toFixed(2)` is undefined,
 * which a template prints as "$undefined" or a bare "$". So a figure that is
 * not a number is not printed; the row and the total say what the budget
 * pill says for the same state.
 */
const HIDDEN_FIGURE = 'no group number to show';
const shareFigure = (s) => {
  if (typeof s?.amount !== 'number') return HIDDEN_FIGURE;
  const paid = Number(s.paidAmount);
  if (!s.settled && paid > 0) {
    const left = typeof s.outstanding === 'number'
      ? s.outstanding
      : Math.max(0, Math.round((s.amount - paid) * 100)) / 100;
    return `$${left.toFixed(2)} left of $${s.amount.toFixed(2)}`;
  }
  if (s.settled && paid > s.amount) {
    return `paid $${paid.toFixed(2)}, owed back $${(Math.round((paid - s.amount) * 100) / 100).toFixed(2)}`;
  }
  return `$${s.amount.toFixed(2)}`;
};
// What /payment-links will ask for: the outstanding figure, or the share on
// a body from before the credit column existed.
const settleUpFigure = (bill, userId) => {
  const mine = (bill?.shares || []).find((s) => String(s.userId) === String(userId));
  const figure = mine?.outstanding ?? mine?.amount;
  return typeof figure === 'number' ? ` · $${figure.toFixed(2)}` : '';
};
// Settled by credit rather than by a tap: what this person paid on an earlier
// version of the bill already covers the share, so POST /unsettle answers 409
// reason 'credit', and a button that exists only to be refused is a dead one.
// The same comparison the route makes.
const coveredByCredit = (s) => Number(s?.paidAmount) >= Number(s?.amount);
// What a share owes once its settlement is taken back: the share less the
// credit carried on it, never below zero. GET serves every settled row with
// outstanding 0, and the reducers that flipped the flag alone left that zero
// in place, so a $100 share taken back read "Settle Up · $0.00" (adversarial
// audit round 2, 2026-09-05). Exported for the socket reducers in App.js.
export const owedOn = (s) => {
  if (typeof s?.amount !== 'number') return s?.outstanding;
  const paid = Number(s.paidAmount) > 0 ? Number(s.paidAmount) : 0;
  return Math.max(0, Math.round((s.amount - paid) * 100)) / 100;
};

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
  VenueCard, // unused: VenueCardRow from components/chat draws venue messages
  colorsLight, // unused: the text bubble it tinted is gone
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
  getRelativeTime, // unused: the per-message time stamp; the stream carries none
  getSelectedFlock,
  handleChatImageSelect,
  handleChatInputChange,
  handleUnsendFlockMessage,
  handleFlockInviteSearch,
  handleSendFlockInvites,
  isDark, // unused: the same bubble fill's dark variant
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
  loadFlockVotes,
  openBirdie,
  votesError,
  pendingImage,
  popularVenues,
  profilePic, // unused: the 34px own-avatar beside every own message
  renderFlockInviteRow,
  retryFailedMessage,
  discardFailedMessage,
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
    // THE STATE THAT LIVES HERE, AND WHY NONE OF IT IS IN App.js.
    //
    // This screen arrived from App.js as a pure function of its props and the
    // header of this file says so. The exceptions below are all one kind of
    // thing: a fact about THIS screen's own DOM, its own connection or its own
    // sheets, which App.js cannot see and no other screen wants.
    //
    //   composerHasRealText. The composer's change event is the only place the
    //   difference between "" and "   " was ever visible. App.js computed
    //   chatInputHasText as `!!value` while sendChatMessage guards on
    //   `.trim()`, so a box holding nothing but spaces lit the Send button up
    //   and then threw the tap away in silence. That is the dead control
    //   SLOP-AUDIT rule C1 bans, on the most-used button in the product.
    //
    //   connectionState. The header printed "online" beside a green dot as a
    //   hardcoded literal wired to nothing. It said online with the socket
    //   dead, on the one screen a person opens to work out why nothing is
    //   arriving.
    //
    //   draft, actionsRect and plusOpen came in with the chat module and each
    //   is explained where it is declared: a mirror of App.js's draft so the
    //   module's controlled field has something to render, the rectangle a
    //   long press was raised over, and whether the "+" sheet is open.
    //
    // All of them are declared above the `!flock` return below, because a hook
    // after a conditional return is a hook that does not always run.
    // Full-size photo viewer. A history row carries only the thumbnail, so
    // opening one fetches the original through the membership-gated endpoint;
    // a live row still holds the full image and opens instantly. It has two
    // doors now and both are real: the photo itself, which MessageRow makes a
    // button whenever `onOpenImage` is passed, and View photo in the
    // long-press menu. It used to have only the second, because the whole
    // bubble was the tap target for the reaction row and a button may not be
    // nested inside a button. Nothing nests any more.

    // THE JUMP-TO-LATEST PILL WENT WITH THE SCROLL HANDLER, and so did the
    // handler. It was a `<div onScroll>` doing four things: raising this pill,
    // writing the hysteresis band into chatNearBottomRef for App.js's
    // tail-follow effect, holding the end-ref sentinel to scroll back to, and,
    // first in the function, calling blur() on whatever input was focused.
    // That last one is why the keyboard closed every time a message arrived:
    // an arriving message moves the list, moving the list is a scroll event,
    // and a scroll event blurred the field somebody was typing in. None of it
    // is carried over in any form. MessageList owns the scroll now: it anchors
    // to the bottom, follows the tail on the viewer's own send, holds still
    // for somebody else's arrival and raises its own "N new messages", and it
    // corrects the offset when an older page is prepended.

    // THE COMPOSER'S TEXT, MIRRORED, and App.js is still the authority. The
    // draft lives in its `chatInputRef`, every keystroke below goes through
    // `handleChatInputChange`, and `chatInputHasText` remains the only thing
    // that knows the box was cleared from outside this screen. ChatInputBar's
    // field is controlled, so it needs a value to render, and this is that
    // value and nothing else.
    //
    // CLEARED ON THE FALLING EDGE, not whenever the flag is false. A box
    // holding only spaces is honestly "no text" to App.js, so a level check
    // would rub out the space somebody typed before a venue name. The edge is
    // what a send, a photo caption going out and every exit on this screen all
    // produce, and it is the only thing that should empty the field.
    const [draft, setDraft] = React.useState('');
    const hadTextRef = React.useRef(false);
    React.useEffect(() => {
      if (hadTextRef.current && !chatInputHasText) setDraft('');
      hadTextRef.current = chatInputHasText;
    }, [chatInputHasText]);

    // Where a long press was raised, so the actions menu can be drawn over the
    // row it belongs to. WHICH message is open is still App.js's
    // `showReactionPicker`, so every existing close of that prop still closes
    // this menu; only the rectangle is local, because a DOM measurement is not
    // App.js's to hold and it has nothing to do with any other screen.
    const [actionsRect, setActionsRect] = React.useState(null);
    // The "+" at the right of the input bar. New UI with nothing behind it in
    // App.js, so there is nothing to move down here: it holds the composer
    // controls that have no slot of their own in the new bar.
    const [plusOpen, setPlusOpen] = React.useState(false);

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
    // Three states, not two, and the middle one earns its word. the maintainer's rule,
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
      /* The field is controlled now, so the box on screen is `draft`.
         setChatInput above clears App.js and the falling edge of
         chatInputHasText usually clears this with it, but a box holding
         only spaces never armed that flag and so produces no edge, and
         leaving spaces behind for the next visit is the small half of
         the draft leak this function exists to close. */
      setDraft('');
      setPlusOpen(false);
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
    // Hot-loop precomputation. The search filter used to run twice per render,
    // once for the count line and once for the list, so it runs once here and
    // both read the result.
    //
    // The name-to-image Map that sat beside it went with the stream. It
    // existed because the avatar cell ran flock.members.find up to four times
    // per MESSAGE ROW per render; the new stream draws no per-message avatar
    // at all, so there is nothing left to look a member's photo up for.
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
    // The four quick emoji the long-press menu offers.
    const reactions = ['❤️', '👍', '😂', '🔥'];
    // PUT /api/flocks/:id is creator-only. The venue controls below are the
    // same route the vote panel's Confirm button already gates on this.
    const isCreator = String(flock.creatorId) === String(authUser?.id);
    // Read once here so the header bar and the sheet below cannot disagree.
    const billBar = billTally(billSplit);
    // A ghost commit creates a REAL bill_splits row with paid_by NULL, so it is
    // not "no bill yet": it is a shell holding estimates from the group budget,
    // and the server marks it hasPayer: false.
    const billSplitIsShell = !!billSplit && billSplit.hasPayer === false;
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

    // ── WHAT THE STREAM IS HANDED ───────────────────────────────────────────
    //
    // Plain functions, not useCallback, and that is a decision rather than an
    // oversight. MessageList asks for stable callbacks so its memoised runs
    // can skip a rebuild, and a hook cannot be declared down here: everything
    // below the `!flock` return above is conditional, and a hook after a
    // conditional return is a hook that does not always run. The alternative
    // is lifting this screen's props into state it owns, which is the one
    // thing this pass was told not to do. So the runs re-render with the
    // screen, exactly as every row did before the swap.

    const searchActive = showChatSearch && !!chatSearch.trim();

    // TWO ARRAYS, AND THE DIFFERENCE BETWEEN THEM MATTERS.
    //
    // `flock.messages` is what App.js owns, and every handler that hands a
    // message back to it takes one of those rows: retry, remove, unsend,
    // report and the photo viewer all read fields off the row they are given,
    // and `retryFailedMessage` puts `text` back on the wire. `listRows` is the
    // same list dressed for the stream, and a dressed row's `text` can be an
    // array of highlight nodes, which is not a thing to send to a server. So
    // anything travelling outward is resolved back through `originalRow`
    // first, by id.
    //
    // WHAT THE DRESSING IS. Search matches wrapped in <mark>, which is the
    // highlighting this screen has always drawn and the one thing the module
    // deliberately leaves to the caller. And a venue card's caption dropped:
    // the old stream drew EITHER the card OR the text and a shared venue
    // always carried a generated sentence ("Check out Kome!") that nobody ever
    // saw, while MessageRow draws a card AND its text, so leaving it on would
    // print that sentence under a card whose first line is the venue's name.
    // App.js's copy keeps it, which is what the flock list previews.
    //
    // AND THE ARRAY IS THE SAME OBJECT WHEN THERE IS NOTHING TO DRESS.
    // MessageList's scroll rules key off the identity of the row array, and
    // this screen re-renders on every socket event App.js holds state for, so
    // a fresh array on each of those would re-run its layout effect several
    // times a second for nothing. The map runs only when a search is open or a
    // venue card is carrying a caption; otherwise `flock.messages` is handed
    // over as it arrived. It cannot be memoised, for the reason at the top of
    // this section: hooks cannot be declared below a conditional return.
    const sourceRowById = new Map((flock.messages || []).map((m) => [m.id, m]));
    const originalRow = (m) => (m && sourceRowById.get(m.id)) || m;
    const needsDressing = searchActive
      || visibleMessages.some((m) => m.message_type === 'venue_card' && m.venue_data && m.text);
    const listRows = needsDressing ? visibleMessages.map((m) => {
      const isCard = m.message_type === 'venue_card' && m.venue_data;
      const carded = isCard ? { ...m, text: '' } : m;
      /* AND ON THE SEARCH PATH TOO. The highlight below rebuilds `text` from
         the row's own copy, so a query the caption matched ("check out") put
         that caption straight back under the card the line above had just
         cleared, which is the duplicate the blanking exists to stop. A card is
         a card whether or not a search is running. Fixed on the DM side
         already; this is the flock half of the same line. */
      if (isCard || !searchActive || typeof m.text !== 'string' || !m.text.toLowerCase().includes(chatSearch.toLowerCase())) return carded;
      return { ...carded, text: highlightMatches(m.text, chatSearch) };
    }) : visibleMessages;

    // A venue card is the one message shape the module does not own, so the
    // screen draws it and the module calls back for it. Same vote arithmetic
    // as the card this replaces, same exit through leaveChatScreen, and the
    // count is the real tally or nothing at all.
    const renderCard = (m) => {
      if (m.message_type === 'venue_card' && m.venue_data) {
        const vc = m.venue_data;
        const existingVote = (flock.votes || []).find(v => v.venue === vc.name);
        const voted = !!existingVote && (existingVote.voters || []).includes('You');
        return (
          <VenueCardRow
            venue={vc}
            surface="flock"
            actionActive={voted}
            count={existingVote ? voteTotal(existingVote) : null}
            /* The card is presentational and has no BASE_URL, so the path
               resolver is handed in, and so is the placeholder the rest of the
               app swaps to on an error. Both used to be withheld here on the
               grounds that the asset path was not reachable from this screen.
               It is: it moved to lib/venuePhoto.js for exactly this reason, so
               a shared venue whose photo dies now falls back to the same bird
               as every other venue photo in the product. */
            resolvePhoto={resolveVenuePhoto}
            placeholder={VENUE_PHOTO_PLACEHOLDER}
            onOpen={vc.place_id ? () => {
              leaveChatScreen();
              setVenueDetailReturnTo({ tab: 'chat', screen: 'chatDetail', flockId: selectedFlockId });
              setCurrentTab('explore');
              setCurrentScreen('main');
              setTimeout(() => {
                openVenueDetail(vc.place_id, { name: vc.name, formatted_address: vc.addr || vc.formatted_address, place_id: vc.place_id, rating: vc.stars || vc.rating, photo_url: vc.photo_url }, { panMap: true });
              }, 500);
            } : undefined}
            onAction={() => {
              const current = flock.votes || [];
              const mine = current.find(v => v.venue === vc.name);
              // Already yours: the tap takes the vote back, the way the vote
              // panel's row does.
              if (mine && (mine.voters || []).includes('You')) {
                updateFlockVotes(selectedFlockId, current
                  .map(v => ({ ...v, voters: v.voters.filter(x => x !== 'You') }))
                  .filter(v => v.voters.length > 0 || (v.guestCount || 0) > 0));
                return;
              }
              if (mine) {
                updateFlockVotes(selectedFlockId, current.map(v => ({
                  ...v,
                  voters: v.venue === vc.name
                    ? (v.voters.includes('You') ? v.voters : [...v.voters, 'You'])
                    : v.voters.filter(x => x !== 'You')
                })));
                return;
              }
              // Moving your vote here takes it off whatever you picked before.
              updateFlockVotes(selectedFlockId, [
                ...current.map(v => ({ ...v, voters: v.voters.filter(x => x !== 'You') })),
                { venue: vc.name, type: vc.type, place_id: vc.place_id || null, voters: ['You'] },
              ]);
            }}
          />
        );
      }
      return null;
    };

    // THE RECEIPT, AND ONLY WHAT THE ROW CAN BACK. There is no delivered and
    // no opened on the flock side: no column, no event, nothing to read. So
    // the two states a row really carries are the two that appear, a send in
    // flight and a send that failed, and StatusLine refuses to invent the
    // rest. "Sending" sits under the last own message only, which is where the
    // stream puts a receipt. The failed line, with its Retry and its Remove,
    // sits under the message that did not send, wherever in the run that is.
    const renderStatus = (m) => {
      if (!m || m.sender !== 'You') return null;
      if (m.failed) {
        /* originalRow, not the row the stream is holding. A failed message
           that matches an open search travels with an array of highlight
           nodes where its text was, and retryFailedMessage puts that text
           back on the wire. */
        return (
          <StatusLine
            status="failed"
            onRetry={() => retryFailedMessage(flock.id, originalRow(m))}
            onRemove={() => discardFailedMessage(flock.id, originalRow(m))}
          />
        );
      }
      /* EVERY row still on the wire says so, not just the last one. Two
         messages can be in flight at once and each is one that has not landed,
         so the old "last own row" test hid the first one's receipt entirely.
         It also attached the receipt to the WRONG message during a search,
         because the row it found was the last own row that MATCHED the query
         rather than the one still sending. MessageGroup draws a non-last
         row's status under that row for exactly this. Same fix the DM side
         already carries. */
      if (m.pending) return <StatusLine status="sending" />;
      return null;
    };

    // Scrollback, the same three-part condition the old control carried, said
    // in the module's words: there is nothing further back while a first page
    // is on the wire, once the paging reader has hit the top, or when the
    // whole thread is shorter than one page. That last clause is the one
    // flockAtTop alone gets wrong, because only the paging reader sets it.
    const scrollbackExhausted = messagesLoading || !!flockAtTop[flock.id] || flock.messages.length < DM_PAGE_SIZE;
    const loadOlderHere = () => loadOlderFlockMessages(flock.id, oldestServerId(flock.messages));

    // The two empty states, and neither can be drawn over a fetch: MessageList
    // takes a loading node and an empty node, and the loading one wins.
    const emptyState = searchActive ? (
      <div style={{ textAlign: 'center', padding: '40px 20px' }}>
        {/* The scrollback control, ABOVE the sentence that points at it. With
            no matching rows MessageList draws no control of its own, there
            being nothing to put it above, and the sentence would then name a
            button that is not on the screen. */}
        {!flockAtTop[flock.id] && flock.messages.length >= DM_PAGE_SIZE && (
          <div style={{ marginBottom: '14px' }}>
            <button
              className="hit44"
              disabled={olderLoading}
              onClick={loadOlderHere}
              style={{ padding: '8px 14px', borderRadius: '14px', border: '1px solid var(--border-default)', backgroundColor: 'var(--bg-card-solid)', color: colors.navy, fontSize: 'var(--t-meta)', fontWeight: '600', cursor: olderLoading ? 'default' : 'pointer', opacity: olderLoading ? 0.6 : 1 }}
            >
              {olderLoading ? 'Loading' : 'Load earlier messages'}
            </button>
          </div>
        )}
        <BirdieStill bird={WARM_BIRD} size={72} style={{ margin: '0 auto 8px' }} />
        {/* "No messages match" is a claim about the whole flock and this only
            read the rows that are loaded. Say which. */}
        <p style={{ fontSize: 'var(--t-body)', color: 'var(--text-tertiary)', fontWeight: '500' }}>
          {/* Everything is on screen when the reader has hit the top OR when
              the whole thread is shorter than one page, which is the common
              case and the one flockAtTop alone gets wrong. */}
          {(flockAtTop[flock.id] || flock.messages.length < DM_PAGE_SIZE)
            ? `No messages match "${chatSearch}"`
            : `Nothing loaded so far matches "${chatSearch}"`}
        </p>
        {!flockAtTop[flock.id] && flock.messages.length >= DM_PAGE_SIZE && (
          <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)', margin: '6px 0 0' }}>
            Load earlier messages above to search further back.
          </p>
        )}
      </div>
    ) : (!messagesLoading && flock.messages.length === 0 ? (
      /* A brand-new flock lands you here with nothing on screen at all, which
         is the first thing anyone sees after creating one. Say what this room
         is for and give the two openers. */
      <div style={{ textAlign: 'center', padding: '40px 24px 48px' }}>
        {/* The warm bird, not cobalt: in this app cobalt Birdie IS the AI, and
            his photo on a human chat's first screen would read as "the
            assistant lives here". The cream bird is the brand without that
            promise. */}
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
    ) : null);

    // THE MESSAGE ACTIONS ARE A LONG PRESS NOW, and the trigger is the only
    // thing about them that changed. A tap used to open this row, which meant
    // a tap on a photo could not open the photo and a tap on a reaction pill
    // could not take the reaction back. Every action is still here: the four
    // emoji, View photo, Unsend and Report, on the same conditions as before.
    const openMessageActions = (m, detail) => {
      setActionsRect(detail && detail.rect ? detail.rect : null);
      setShowReactionPicker(showReactionPicker === m.id ? null : m.id);
    };
    const closeMessageActions = () => { setShowReactionPicker(null); setActionsRect(null); };
    /* Read off App.js's own rows, not the dressed ones: Report sends the
       message id and the sender to the moderation sheet and Unsend sends the
       id, and neither wants a display copy. */
    const actionsMessage = showReactionPicker != null
      ? (sourceRowById.get(showReactionPicker) || null)
      : null;
    /* Anchored over the row the press was held on, clamped to the screen. With
       no rectangle (a keyboard activation, or App.js closing and reopening the
       picker itself) it sits above the composer, which is where a thumb
       already is. */
    const actionsAnchor = actionsRect
      ? {
        top: `${Math.max(8, actionsRect.top - 54)}px`,
        left: `${Math.max(8, Math.min(actionsRect.left, (typeof window !== 'undefined' ? window.innerWidth : 390) - 268))}px`,
      }
      : { bottom: 'calc(96px + var(--safe-bottom))', left: '12px' };


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
                {/* Birdie, present in the chat: the same panel as Home, opened over
                    this chat, and the model is told which flock this is. */}
                <button aria-label="Ask Birdie" className="hit44 glass-btn" onClick={() => { setChatNavOpen(false); openBirdie(); }} style={{ width: '36px', height: '36px', minWidth: '36px', borderRadius: '10px', border: '1px solid rgba(255,255,255,0.15)', backgroundColor: 'rgba(255,255,255,0.08)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)', color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Icons.birdie('white', 15)}</button>
                <button aria-label="Vote on a venue" className="hit44 glass-btn" onClick={() => { setChatNavOpen(false); setShowVotePanel(true); loadPopularVenues(); }} style={{ width: '36px', height: '36px', minWidth: '36px', borderRadius: '10px', border: '1px solid rgba(255,255,255,0.15)', backgroundColor: flock.status === 'voting' ? colors.steel : 'rgba(255,255,255,0.08)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)', color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Icons.vote('white', 17)}</button>
                <button aria-label="Invite friends" className="hit44 glass-btn" onClick={() => { setChatNavOpen(false); setShowFlockInviteModal(true); setCopiedInviteUrl(''); setFlockInviteSelected([]); setFlockInviteSearch(''); }} style={{ width: '36px', height: '36px', minWidth: '36px', borderRadius: '10px', border: '1px solid rgba(255,255,255,0.15)', backgroundColor: 'rgba(255,255,255,0.08)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)', color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Icons.userPlus('white', 17)}</button>
                <button aria-label="Search messages" className="hit44 glass-btn" onClick={() => { setChatNavOpen(false); setShowChatSearch(!showChatSearch); }} style={{ width: '36px', height: '36px', minWidth: '36px', borderRadius: '10px', border: '1px solid rgba(255,255,255,0.15)', backgroundColor: showChatSearch ? 'rgba(255,255,255,0.25)' : 'rgba(255,255,255,0.08)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)', color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Icons.search('white', 17)}</button>
                <button aria-label="Group cash pool" className="hit44 glass-btn" onClick={() => { setChatNavOpen(false); setShowChatPool(true); }} style={{ width: '36px', height: '36px', minWidth: '36px', borderRadius: '10px', border: '1px solid rgba(255,255,255,0.15)', backgroundColor: 'rgba(255,255,255,0.08)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)', color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Icons.dollar('white', 15)}</button>
              </div>
              <button aria-label="Features" aria-expanded={chatNavOpen} className="hit44" onClick={() => setChatNavOpen(!chatNavOpen)} style={{ height: '42px', minWidth: chatNavOpen ? '42px' : 'auto', width: chatNavOpen ? '42px' : 'auto', borderRadius: '14px', border: '1px solid rgba(255,255,255,0.18)', backgroundColor: chatNavOpen ? 'rgba(255,255,255,0.25)' : 'rgba(255,255,255,0.1)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)', color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px', padding: chatNavOpen ? '0' : '0 18px', fontSize: 'var(--t-body)', fontWeight: '600', flexShrink: 0, transition: 'all 0.3s ease', boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.12)' }}>{chatNavOpen ? Icons.x('white', 17) : <span style={{ fontSize: 'var(--t-body)', fontWeight: '600' }}>Features</span>}</button>
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
                {visibleMessages.length} {visibleMessages.length === 1 ? 'message' : 'messages'} found
              </p>
            )}
          </div>
        )}

        {/* The plan, in one line, and the way to it. The chat never showed
            the time or the status: a member in here when the host locked the
            plan or moved it saw nothing change, and the only way to the plan
            screen was Home, then the card. */}
        <button
          className="hit44"
          aria-label="Open the plan"
          onClick={() => { leaveChatScreen(); setCurrentScreen('detail'); }}
          style={{ width: '100%', minHeight: '40px', padding: '8px 14px', border: 'none', borderBottom: `1px solid ${colors.creamDark}`, background: 'var(--bg-card-solid)', color: 'var(--text-secondary)', fontSize: 'var(--t-meta)', fontWeight: '500', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', cursor: 'pointer', flexShrink: 0, textAlign: 'left' }}
        >
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {flock.time && flock.time !== 'TBD' ? flock.time : 'Time still open'} · {flock.status === 'confirmed' ? 'Locked in' : flock.status === 'completed' ? 'Done' : flock.status === 'cancelled' ? 'Called off' : 'Still voting'}
          </span>
          <span style={{ flexShrink: 0, color: colors.navy, fontWeight: '600' }}>Plan</span>
        </button>
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
            <BirdieStill bird={WARM_BIRD} size={48} style={{ flexShrink: 0 }} />
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
                  {budgetStatus.budgetLocked
                    /* Closed with no number to show (fewer than three sharers
                       still here). "Waiting on amounts" here told a member the
                       group was waiting when answers were closed. */
                    ? 'Budget closed · no group number to show'
                    : (budgetStatus.totalMembers || 0) > 0 && (budgetStatus.totalMembers || 0) < 3
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
                  // The commit changed the bill the card below reads; without
                  // this the card stayed as it was until the screen was left.
                  try { const d = await getBillSplit(selectedFlockId); setBillSplit(d.bill); } catch (_) { /* the socket event covers it */ }
                  showToast('Committed');
                } catch (err) { showToast(err.message, 'error'); }
              }} style={{ padding: '6px 14px', borderRadius: '14px', border: 'none', background: colors.navyMidBg, color: 'white', fontSize: 'var(--t-meta)', fontWeight: '600', cursor: 'pointer', flexShrink: 0 }}>
                Commit ${budgetStatus.ceiling}
              </button>
            </div>
          </div>
        )}

        {/* Bill summary bar, shown when a bill exists. The green ground reads
            the same tally as the icon and the sentence beside it: it used to
            test the block-filtered array on its own, and turned green for a
            viewer who had blocked a sharer while the sentence said 2/3. */}
        {billSplit && (
          <div role="button" tabIndex={0} aria-label="Open bill split details" onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setShowChatPool(true); } }} onClick={() => setShowChatPool(true)} style={{ padding: '8px 14px', background: billBar.all ? 'linear-gradient(135deg, #ecfdf5, #d1fae5)' : `linear-gradient(135deg, ${colors.navy}06, ${colors.navy}12)`, borderBottom: '1px solid var(--divider)', flexShrink: 0, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              {Icons.dollar(billBar.all ? '#22C55E' : colors.navy, 13)}
              <p style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: colors.navy, margin: 0 }}>
                {billBar.all
                  ? 'All settled up'
                  /* The amount is withheld on a shell whose flock has fallen
                     under three present sharers (billing.js sends null), and
                     `null?.toFixed(2)` is undefined, which a template literal
                     prints. Every remaining member's header read
                     "Bill: $undefined". Drop the figure rather than print it. */
                  : `Bill: ${typeof billSplit.totalWithTip === 'number' ? `$${billSplit.totalWithTip.toFixed(2)} · ` : ''}${billBar.settled}/${billBar.total} settled`}
              </p>
            </div>
            <span style={{ fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)' }}>View</span>
          </div>
        )}

        {/* THE STREAM.
            What was here was a `<div onScroll>` holding a map over the rows,
            and each row drew a 34px avatar, a name, a bullet, a timestamp and
            a rounded bubble with a shadow. All of it is MessageList's now, and
            four things went with the scroll handler and are not carried over
            in any form: the blur() on the focused input, which is what closed
            the keyboard whenever a message arrived; the "Jump to latest" pill;
            the writes to chatNearBottomRef; and the end-ref sentinel.
            MessageList does the bottom anchoring, the tail follow on the
            viewer's own send, the "N new messages" affordance for somebody
            else's arrival, and the offset correction when an older page is
            prepended above the reader.

            EVERYTHING THIS SCREEN STILL OWNS IT HANDS OVER. The rows, the
            venue card, the receipt, the scrollback, the two empty states, the
            skeleton, the photo viewer and the reaction tap are all props
            computed above. onSwipeReply is deliberately absent: see the note
            at the composer. */}
        <MessageList
          rows={listRows}
          threadKey={flock.id}
          myId={authUser?.id}
          ownName="You"
          ownColour="var(--chat-accent)"
          renderCard={renderCard}
          renderStatus={renderStatus}
          onLoadOlder={loadOlderHere}
          atTop={scrollbackExhausted}
          olderLoading={olderLoading}
          onLongPress={openMessageActions}
          onOpenImage={(m) => openImageViewer(originalRow(m))}
          onReactionTap={(emoji, m) => addReactionToMessage(flock.id, m.id, emoji)}
          loadingState={messagesLoading && flock.messages.length === 0
            ? <ChatSkeleton label={`Loading messages in ${flock.name}`} />
            : null}
          emptyState={emptyState}
        />

        {/* The actions a long press raises. Same four emoji, same View photo,
            same Unsend on your own server-side row, same Report on somebody
            else's, and the same one-tap close on every one of them. It is
            fixed rather than inline now because the row it belongs to lives
            inside a scroller this screen no longer controls, and a menu drawn
            inside a run would move the run. */}
        {actionsMessage && (
          <>
            {/* Tap anywhere else to put it away. Decorative to a screen
                reader: the menu's own controls are the way out for anyone not
                using a pointer, and Escape is handled by nothing here because
                nothing here traps focus. */}
            <div aria-hidden="true" onClick={closeMessageActions} style={{ position: 'fixed', inset: 0, zIndex: 70 }} />
            <div
              role="group"
              aria-label="Message actions"
              style={{
                position: 'fixed',
                ...actionsAnchor,
                zIndex: 71,
                display: 'flex',
                gap: '4px',
                padding: '6px 10px',
                backgroundColor: 'var(--bg-card-solid)',
                borderRadius: '24px',
                boxShadow: '0 2px 8px rgba(0,0,0,0.10)',
                animation: 'reactionPop 0.25s ease-out',
              }}
            >
              {reactions.map(r => (
                <button aria-label={`React with ${r}`} className="hit44"
                  key={r}
                  onClick={() => { closeMessageActions(); addReactionToMessage(flock.id, actionsMessage.id, r); }}
                  style={{ background: 'none', border: 'none', fontSize: 'var(--t-title)', cursor: 'pointer', padding: '6px', borderRadius: '10px', transition: 'transform 0.15s ease, background-color 0.15s ease' }}
                >{r}</button>
              ))}
              {(actionsMessage.image || actionsMessage.thumb) && (
                <button aria-label="View photo full size" className="hit44" onClick={() => { closeMessageActions(); openImageViewer(actionsMessage); }} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '6px', display: 'flex', alignItems: 'center', borderRadius: '10px' }} title="View photo">{Icons.eye(colors.textSecondary, 15)}</button>
              )}
              {actionsMessage.sender === 'You' && typeof actionsMessage.id === 'number' && actionsMessage.id <= 2147483647 && (
                <button aria-label="Unsend message" className="hit44" onClick={() => { closeMessageActions(); handleUnsendFlockMessage(flock.id, actionsMessage.id); }} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '6px', display: 'flex', alignItems: 'center', borderRadius: '10px', fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', fontWeight: '600' }} title="Unsend">Unsend</button>
              )}
              {actionsMessage.sender !== 'You' && (
                /* The token, not the literal this line carried across from the
                   old picker. index.css defines --accent-red-text in BOTH
                   themes and the dark value was picked to clear 4.5:1; a fixed
                   #EF4444 is a light mode red shipped into dark mode. */
                <button aria-label="Report" className="hit44" onClick={() => { closeMessageActions(); setModerationTarget({ userId: actionsMessage.senderId, userName: actionsMessage.sender, contentType: 'flock_message', contentId: actionsMessage.id }); }} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '6px', display: 'flex', alignItems: 'center', borderRadius: '10px', fontSize: 'var(--t-body)', color: 'var(--accent-red-text)' }} title="Report">{Icons.flag('var(--accent-red-text)', 15)}</button>
              )}
            </div>
          </>
        )}



        {/* Reply bar */}
        {/* The "Replying to" bar sat here until 2026-08-27. It was the
            sender-facing half of a reply feature whose other half never
            existed on the flock side; see the removal note in App.js.

            AND IT STAYS GONE THROUGH THIS REBUILD. MessageRow reports a right
            swipe through `onSwipeReply` and ChatInputBar draws a quote bar
            from `replyTo`, and neither is wired here on purpose: `messages`
            has no reply column, nothing on the flock side sends one and no row
            ever arrives carrying one, so a swipe would open a quote bar over a
            send path that drops it. The DM thread's reply is real and keeps
            its own wiring. */}

        {/* Image preview bar */}
        {/* It is ChatInputBar's now. The photo waiting to go, its caption
            prompt and its remove button are the bar's own pending-image row,
            drawn above the field, so the composer is one stack instead of two
            elements with two hairlines between them. */}

        {/* TYPING, ABOVE THE FIELD, AND THE FIXED 58px SLOT IS GONE. That slot
            was reserved inside the message list at all times so that a bubble
            appearing for a few seconds an hour did not shift the layout: 58px
            of a phone screen, permanently, for something almost always
            absent. TypingRow collapses to nothing instead. The list above it
            is bottom anchored, so the stream slides up under the strip as it
            appears and the composer does not move.

            MOUNTED ACROSS THE EMPTY STATE, not rendered conditionally. Its
            live region has to already be in the accessibility tree for a
            screen reader to hear the sentence arrive, which is the same rule
            the status line and the composer notice follow.

            ONE MEMBER, AND ONLY WHAT THE SOCKET SAID. App.js hands this screen
            a boolean and a name, so that is all the strip draws. Nothing is
            marked `present`: this surface has no presence data, and an avatar
            peeking over a pill would be claiming some. */}
        <TypingRow members={isTyping && typingUser ? [{ id: 'typing', name: typingUser, typing: true }] : []} />

        {/* Input area */}
        {/* THE COMPOSER IS THE MODULE'S NOW. What was here was three icon
            buttons crowded to the left of a single-line input, plus a send
            button that stayed on screen at 45% opacity whenever there was
            nothing to send. ChatInputBar is the measured shape: camera at the
            far left, the field in a pill that grows to five lines with the
            library icon inside its right edge, and one slot at the right that
            is a "+" until you type and the send button after that.

            WHAT THE SCREEN STILL DECIDES, because the bar cannot know it: that
            a tap on send is `shareImageToChat` when a photo is waiting and
            `sendChatMessage` otherwise, since those are two different calls in
            App.js. And that the field is armed by an AND of two facts owned by
            two places, which is `canSendComposerText` above.

            THE HIDDEN FILE INPUT STAYS HERE. It is the library button's
            target, it is what `handleChatImageSelect` reads, and the bar has
            no business owning a DOM node App.js holds a ref to. */}
        <ChatInputBar
          variant="flock"
          ownColor="var(--chat-accent)"
          value={draft}
          onChange={(next) => {
            setDraft(next);
            setComposerHasRealText(next.trim().length > 0);
            /* App.js's handler is written against a change event and owns the
               draft ref, the typing emit and chatInputHasText. The bar reports
               a string, so the event is rebuilt around it rather than the
               handler being reached around. */
            handleChatInputChange({ target: { value: next } });
          }}
          onSend={() => {
            if (showImagePreview && pendingImage) { shareImageToChat(selectedFlockId); return; }
            if (canSendComposerText) sendChatMessage();
          }}
          onCamera={() => openCameraViewfinder('flock')}
          onLibrary={() => chatGalleryInputRef.current?.click()}
          onPlus={() => setPlusOpen(true)}
          pendingImage={showImagePreview ? pendingImage : null}
          onRemoveImage={() => { setPendingImage(null); setShowImagePreview(false); }}
          sharingLocation={sharingLocationForFlock === flock.id}
          locationLabel="Sharing your location"
          onStopSharingLocation={stopLocationSharing}
        />
        <input ref={chatGalleryInputRef} type="file" accept="image/*" onChange={handleChatImageSelect} style={{ display: 'none' }} />

        {/* The "+" sheet. Six tiles, and each one is a thing you SEND into the
            stream: the two photo routes, which the bar also carries because
            that is what the "+" is opened for most; a live location share,
            which is the one control in the old composer row with no slot in
            the new bar; and the venue vote, the bill split and Birdie, which
            post a poll card, a bill card and an answer.

            Check in is the seventh and is absent, because this screen has no
            handler for it. A tile with no handler does not render at all, so
            the sheet grows when the handler arrives and never shows a greyed
            control promising something that is not wired.

            SHARE LOCATION DISAPPEARS WHILE IT IS RUNNING, because the control
            for a share that is already on is the Stop beside the chip above
            the field, and two doors that mean different things do not both
            get to say "Share location". */}
        <ComposerPlusSheet
          open={plusOpen}
          onClose={() => setPlusOpen(false)}
          chatName={flock.name}
          DialogBehavior={DialogBehavior}
          onPickPhoto={() => { setPlusOpen(false); chatGalleryInputRef.current?.click(); }}
          onTakePhoto={() => { setPlusOpen(false); openCameraViewfinder('flock'); }}
          onShareLocation={sharingLocationForFlock === flock.id ? undefined : () => {
            setPlusOpen(false);
            const otherMembers = (flock.members || []).filter(m => m.id !== authUser?.id).length;
            if (otherMembers === 0) { showToast('No one else in this flock to share with', 'error'); return; }
            startSharingLocation(flock.id);
          }}
          /* The other three this screen can honour. Each posts something into
             the stream, which is the rule for what belongs in this sheet: a
             poll card, a bill card, and Birdie's answer. They were reachable
             only from the Features rail in the header, so the composer, which
             is where a person goes to send something, offered none of them.

             Check in is not here because this screen has no handler for it.
             The sheet drops a tile with no handler rather than greying one
             out, so nothing below promises a feature that is not wired. */
          onOpenVote={() => { setPlusOpen(false); setShowVotePanel(true); loadPopularVenues(); }}
          onSplitBill={() => { setPlusOpen(false); setShowCreateBill(true); }}
          onAskBirdie={() => { setPlusOpen(false); openBirdie(); }}
        />



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
                        showToast('Skipped. You will not count toward the group number.');
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
                        <button className="hit44 glass-btn glass-secondary" onClick={async () => { try { const d = await sendBudgetReminder(selectedFlockId); showToast(d.reminded > 0 ? `Reminded ${d.reminded} member${d.reminded !== 1 ? 's' : ''}` : 'Nobody left to remind'); } catch (err) { showToast(err.message, 'error'); } }} style={{ flex: 1, padding: '10px', borderRadius: '10px', border: `1.5px solid var(--border-color)`, backgroundColor: 'var(--bg-card-solid)', color: 'var(--text-secondary)', fontWeight: '600', fontSize: 'var(--t-meta)', cursor: 'pointer' }}>Send Reminder</button>
                      </div>
                    )}
                    {isConfirmedOrComplete && (
                      <button className="hit44 glass-btn glass-primary" onClick={() => setShowCreateBill(true)} style={{ ...styles.gradientButton, padding: '14px' }}>Split the Bill</button>
                    )}
                  </div>
                )}

                {/* Budget disabled — direct to bill split */}
                {!hasBudget && !showCreateBill && (!billSplit || billSplitIsShell) && (
                  <div>
                    <p style={{ fontSize: 'var(--t-label)', color: 'var(--text-secondary)', marginBottom: '16px' }}>Create a bill split after your hangout</p>
                    <button className="hit44 glass-btn glass-primary" onClick={() => setShowCreateBill(true)} style={{ ...styles.gradientButton, padding: '14px' }}>Split the Bill</button>
                  </div>
                )}

                {/* Bill Split Creation Form.
                    `!billSplit` alone used to gate this, and a ghost commit
                    creates a real row, so billSplit was non-null from the first
                    commit onwards and this form could never open again. Ghost
                    mode defaults ON for any budget flock. So: the budget settles
                    at $40, somebody taps "Commit $40" on the ghost card, that
                    person then pays $180 at the restaurant and opens the cash
                    pool. It told them "Whoever pays can post the real bill" over
                    the old estimate, and the Split the Bill button hid the
                    estimate and showed nothing. No total field, no payer picker,
                    no Settle Up (those gate on hasPayer), and no control
                    anywhere in the app that posts the bill the screen was asking
                    for. The server's own 409 says "Add the bill again with who
                    paid", which was the one thing the client could not do.

                    A payerless shell is exactly the state this form is for. */}
                {showCreateBill && (!billSplit || billSplitIsShell) && (
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
                        <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)', margin: '6px 0 0', textAlign: 'center' }}>Equal split · ~${(parseFloat(billTotal) * (1 + billTip / 100) / Math.max(1, flock.billableCount ?? (flock.members?.length || flock.memberCount || 1))).toFixed(2)} each</p>
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
                      } catch (err) {
                        // A refusal can follow a handoff that DID commit (the
                        // first response was lost, so the retry is judged
                        // against the new payer). The bill is re-read so the
                        // sheet never sits on stale payer state (hardening review round 3,
                        // 2026-09-05).
                        if (err?.status === 403) {
                          try {
                            const fresh = await getBillSplit(selectedFlockId);
                            if (fresh?.bill) { setBillSplit(fresh.bill); setShowCreateBill(false); }
                          } catch { /* the toast below still says what the server said */ }
                        }
                        showToast(err.message, 'error');
                      }
                    }} style={{ ...styles.gradientButton, padding: '14px', opacity: (!billTotal || parseFloat(billTotal) <= 0) ? 0.4 : 1 }}>
                      Create Split
                    </button>
                  </div>
                )}

                {/* Bill Summary */}
                {/* Not while the form above is open over the same shell, or
                    the sheet shows an estimate and the real total at once. */}
                {billSplit && !(showCreateBill && billSplitIsShell) && (
                  <div>
                    <div style={{ padding: '14px', borderRadius: '12px', backgroundColor: 'var(--bg-primary)', marginBottom: '14px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                        <span style={{ fontSize: 'var(--t-label)', fontWeight: '600', color: colors.navy }}>{typeof billSplit.totalWithTip === 'number' ? `Total: $${billSplit.totalWithTip.toFixed(2)}` : `Total · ${HIDDEN_FIGURE}`}</span>
                        {billSplit.tipPercent > 0 && <span style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)' }}>includes {billSplit.tipPercent}% tip</span>}
                      </div>
                      <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: '0 0 10px' }}>
                        {billSplit.hasPayer === false
                          ? 'Nobody has paid yet. These are estimates from the group budget. Whoever pays can post the real bill.'
                          : `Paid by ${billSplit.paidBy?.name || 'a member'}`}
                      </p>
                      <div style={{ borderTop: '1px solid var(--divider)', paddingTop: '8px' }}>
                        {(billSplit.shares || []).map(s => (
                          <div key={s.userId} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 0' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                              <span style={{ fontSize: 'var(--t-label)', fontWeight: '600', color: colors.navy }}>{s.name}</span>
                              {s.committed && !s.settled && <span style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: colors.amberText, backgroundColor: `${colors.amber}20`, padding: '1px 6px', borderRadius: '4px' }}>Pre-committed</span>}
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                              <span style={{ fontSize: 'var(--t-label)', fontWeight: '600', color: colors.navy }}>{shareFigure(s)}</span>
                              {s.settled ? (
                                <span style={{ color: '#22C55E', fontSize: 'var(--t-body)' }}>{Icons.check('#22C55E', 16)}<span className="sr-only">Paid</span></span>
                              ) : (
                                /* "left of" already says it for a part-paid row,
                                   and a withheld figure is not a debt to label. */
                                typeof s.amount === 'number' && !(Number(s.paidAmount) > 0) && (
                                  <span style={{ fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)' }}>Owes</span>
                                )
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                    {/* Settle Up button for current user if they owe */}
                    {billSplit.hasPayer !== false && billSplit.shares?.find(s => String(s.userId) === String(authUser?.id) && !s.settled) && (
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
                          showToast(err?.message || 'Could not load payment links. Use "Mark as Paid" after paying.', 'error');
                        }
                      }} style={{ ...styles.gradientButton, padding: '14px', marginBottom: '8px' }}>
                        Settle Up{settleUpFigure(billSplit, authUser?.id)}
                      </button>
                    )}
                    {billSplit.hasPayer !== false && billSplit.shares?.find(s => String(s.userId) === String(authUser?.id) && !s.settled) && (
                      <button className="hit44 glass-btn glass-secondary" onClick={async () => {
                        try {
                          const settled = await settleShare(selectedFlockId);
                          setBillSplit(prev => ({
                            ...prev,
                            ...tallyOf(settled),
                            shares: prev.shares.map(s => String(s.userId) === String(authUser?.id) ? { ...s, settled: true, outstanding: 0 } : s),
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
                        only to be rejected is a dead button. Hidden for the
                        same reason on a share settled by carried credit, where
                        the server answers 409 reason:'credit' every time. */}
                    {billSplit.shares?.find(s => String(s.userId) === String(authUser?.id) && s.settled && !coveredByCredit(s))
                      && String(billSplit.paidBy?.id ?? '') !== String(authUser?.id ?? '') && (
                      <button className="hit44 glass-btn glass-secondary" onClick={async () => {
                        try {
                          const unsettled = await unsettleShare(selectedFlockId);
                          setBillSplit(prev => ({
                            ...prev,
                            ...tallyOf(unsettled),
                            shares: prev.shares.map(s => String(s.userId) === String(authUser?.id) ? { ...s, settled: false, settledAt: null, outstanding: owedOn(s) } : s),
                          }));
                          showToast('Your share is marked unpaid again');
                        } catch (err) { showToast(err.message, 'error'); }
                      }} style={{ width: '100%', padding: '10px', border: 'none', backgroundColor: 'transparent', color: 'var(--text-tertiary)', fontSize: 'var(--t-meta)', fontWeight: '600', cursor: 'pointer' }}>
                        That was a mistake, I have not paid
                      </button>
                    )}
                    {billBar.all && (
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
          // Confirm takes the vote row, not a name. The lookup used to be by name
          // in the nearby map pins, so a venue voted from a shared card or the
          // popular list saved with no place id and the plan lost Details,
          // Directions, Check In, the map and the feedback card. The row's own
          // place id, then the chat's venue card, then the pins. One PUT
          // carries the venue and the confirmation, so members get one push.
          const handleConfirmVenue = (row) => {
            const venueName = typeof row === 'string' ? row : row.venue;
            const rowPlaceId = typeof row === 'string' ? null : (row.place_id || null);
            const card = (flock.messages || []).find(m => m.message_type === 'venue_card' && m.venue_data && (
              (rowPlaceId && m.venue_data.place_id === rowPlaceId) || m.venue_data.name === venueName
            ))?.venue_data || null;
            const pin = allVenues.find(v => (rowPlaceId && v.place_id === rowPlaceId) || v.name === venueName) || null;
            setShowVotePanel(false);
            return updateFlockVenue(selectedFlockId, {
              name: venueName,
              addr: card?.addr || pin?.addr || pin?.formatted_address || '',
              place_id: rowPlaceId || card?.place_id || pin?.place_id || null,
              lat: card?.lat || pin?.location?.latitude || null,
              lng: card?.lng || pin?.location?.longitude || null,
              photo_url: card?.photo_url || pin?.photo_url || null,
              rating: card?.rating || card?.stars || pin?.stars || pin?.rating || null,
              status: 'confirmed',
            });
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
                      // Two venues at the same count are not "Leading" and a flame;
                      // the host reads that as the group's pick.
                      const topCount = sortedVotes.length ? voteTotal(sortedVotes[0]) : 0;
                      const isTiedTop = !isAssigned && count > 0 && count === topCount && sortedVotes.filter(x => voteTotal(x) === topCount).length > 1;
                      const isLeading = !isAssigned && idx === 0 && count > 0 && !isTiedTop;
                      const iconBg = isAssigned
                        ? colors.navyBg
                        : isLeading ? colors.steel : `linear-gradient(135deg, ${colors.navy}15, ${colors.navy}25)`;
                      return (
                        <div role="button" tabIndex={0} aria-pressed={isMyVote} key={v.venue} className="hit44 glass-btn glass-secondary" onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.currentTarget.click(); } }} onClick={(e) => { confirmClick(e); isMyVote ? handleUnvote() : handleQuickVote(v.venue, v.type, v.place_id); }} style={{ width: '100%', textAlign: 'left', padding: '12px 14px', borderRadius: '14px', border: isAssigned ? `2px solid ${colors.navy}` : isMyVote ? `2px solid ${colors.navy}` : `1.5px solid var(--border-default)`, backgroundColor: isAssigned ? `${colors.navy}05` : isMyVote ? `${colors.navy}06` : 'var(--bg-card-solid)', cursor: 'pointer', position: 'relative', overflow: 'hidden', transition: 'opacity 0.2s' }}>
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
                                {(isLeading || isTiedTop) && <span style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: colors.steel, backgroundColor: `${colors.steel}15`, padding: '1px 6px', borderRadius: '6px', flexShrink: 0 }}>{isLeading ? 'Leading' : 'Tied'}</span>}
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
                                <button className="hit44 glass-btn glass-primary" onClick={(e) => { e.stopPropagation(); confirmClick(e); handleConfirmVenue(v); }} style={{ padding: '4px 8px', borderRadius: '8px', border: 'none', background: colors.steel, color: 'white', fontSize: 'var(--t-meta)', fontWeight: '600', cursor: 'pointer', position: 'relative', overflow: 'hidden' }}>{isAssigned ? 'Lock it in' : 'Confirm'}</button>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : votesError ? (
                  <div role="alert" style={{ padding: '20px', textAlign: 'center', backgroundColor: 'var(--bg-tertiary)', borderRadius: '14px', marginBottom: '16px' }}>
                    <BirdieStill bird={WARM_BIRD} size={64} style={{ margin: '0 auto 8px' }} />
                    <p style={{ fontSize: 'var(--t-label)', color: 'var(--text-secondary)', margin: '0 0 4px', fontWeight: '500' }}>{votesError}</p>
                    <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)', margin: '0 0 12px' }}>Nobody's vote has been lost. This is the tally failing to load.</p>
                    <button className="hit44 glass-btn glass-navy" onClick={() => loadFlockVotes(selectedFlockId)} style={{ padding: '10px 16px', borderRadius: '10px', border: 'none', background: colors.navyBg, color: 'white', fontSize: 'var(--t-meta)', fontWeight: '600', cursor: 'pointer' }}>Try again</button>
                  </div>
                ) : (
                  <div style={{ padding: '20px', textAlign: 'center', backgroundColor: 'var(--bg-tertiary)', borderRadius: '14px', marginBottom: '16px' }}>
                    {userLocation ? (
                      <>
                        <BirdieStill size={64} style={{ margin: '0 auto 8px' }} />
                        <p style={{ fontSize: 'var(--t-label)', color: 'var(--text-tertiary)', margin: 0, fontWeight: '500' }}>{suggestedVenues.length > 0
                          ? 'No votes yet. Vote for a place below, or share one of your own.'
                          : 'No votes yet. Be the first to suggest a venue!'}</p>
                      </>
                    ) : (
                      /* The instruction used to have no way to be followed: a
                         fresh install with no location got "be the first to
                         suggest a venue" over an empty panel (the nearby list
                         is location-fed), and the only other door claimed
                         venue search was down. Name the actual next step and
                         open the door to it. */
                      <>
                        <BirdieStill bird={WARM_BIRD} size={64} style={{ margin: '0 auto 8px' }} />
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
                    <BirdieStill bird={WARM_BIRD} size={64} style={{ margin: '0 auto 8px' }} />
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
                    {Icons.check('var(--accent-green-text)', 13)} Copied. Anyone with this link can see the plan, answer, vote, and join this flock. It stops working two weeks from now or a week after the plan, whichever is later.
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
