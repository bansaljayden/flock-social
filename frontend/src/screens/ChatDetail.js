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
 * meter and every sheet below were left where they were; re-homing those was
 * a later pass and doing it there would have made that diff unreadable, which
 * is the same reason the DM thread moved out separately.
 *
 * THE LATER PASS, AND WHAT IT TOOK OUT (2026-09-05, same day)
 *
 * The bands between the header and the first message. There were five of them
 * on a confirmed flock with a bill, about 215pt before anybody had said
 * anything, and the owner looked at the shipped screen and said it was far too
 * heavy. What is left in that space is one 36pt strip, and only when there is
 * something to put in it.
 *
 *   The momentum meter    GONE. screens/FlockDetail.js already draws the same
 *                         meter off the same data, and draws it better.
 *   The 40pt plan bar     GONE. Its two facts, the time and the status, are
 *                         the header's subtitle now, and the header itself is
 *                         the button that opens the plan.
 *   The 72pt venue banner GONE, replaced by `PinStrip`. Tapping the strip is
 *                         the old Map button; Change is in the strip's menu,
 *                         creator only; the rating and the address are a tap
 *                         away on the venue's own page. The two empty states
 *                         ("Add a Venue", "No venue yet") drew a band when
 *                         there was nothing to show and are gone with it; an
 *                         open vote now draws the strip instead, reading
 *                         "Vote open, 3 of 8" and opening the vote panel.
 *   The ghost commit card GONE, and the bill bar with it. They were two
 *   and the bill bar       surfaces for one object. `BillCard` is that object,
 *                         once, in the stream, updating in place, with the
 *                         header keeping a 24pt pill for the state.
 *
 * The stream therefore carries one row this screen invents rather than reads
 * off the server: see BILL_ROW_ID below.
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
 * NINE PROPS ARE NOW UNREAD and stay in the parameter list on purpose:
 * chatNavOpen, VenueCard, getRelativeTime, profilePic, isDark, colorsLight,
 * MOMENTUM_STAGES, momentumStageKey and memberCountLabel. The last three
 * joined on the chrome pass: the meter they drew retired to the plan screen,
 * and the member count gave up its half of the header subtitle to the time
 * and the status of the plan. App.js still computes all three for
 * screens/FlockDetail.js and the flock list, so nothing upstream changed.
 * chatNavOpen joined them when the header rail went behind the plus; App.js
 * still owns the flag and `setChatNavOpen(false)` on the way out still closes
 * it, so nothing is left half open if the rail ever comes back. It was seven
 * until the two scroll refs went: chatEndRef and chatNearBottomRef existed only
 * to feed a tail-follow effect in App.js, and MessageList does that work now,
 * so App.js no longer computes them and there is nothing left to keep in step. `__tests__/extractionEquivalence.test.js` pins this
 * list against what App.js passes, so dropping a name here would fail there
 * and would also hide the fact that App.js still computes them.
 *
 * REPLIES ARE WIRED, as of migration 066. MessageRow's right swipe and
 * ChatInputBar's quote bar were both built and both left disconnected on this
 * surface for as long as `messages` had no reply column. It has one now, both
 * transports carry a quote and the server refuses a target outside this flock,
 * so the affordances are connected to something real.
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
  BillCard,
  ChatInputBar,
  ComposerPlusSheet,
  MessageList,
  NudgeRow,
  PinStrip,
  PinnedMessageBar,
  PollCard,
  runColourFor,
  WhoIsHereCard,
  StatusLine,
  SystemRow,
  TypingRow,
  VenueCardRow,
} from '../components/chat';
import { VENUE_PHOTO_PLACEHOLDER } from '../lib/venuePhoto';
/* The keyboard lane. It is a hook and not part of the chat module's index on
   purpose: it owns DOM nodes and a native bridge rather than any markup, and
   both screens reach it the same way. See the block at its call below. */
import useKeyboardComposer from '../hooks/useKeyboardComposer';

/* A half-written message, per flock, for the length of the session.
   Module scope because App.js unmounts this screen on every navigation,
   and keyed by flock id because ONE shared box is the original bug: the
   composer text lives in a single ref in App.js that the DM composer
   reads too, so an unkeyed draft is a group sentence sitting in a private
   thread. Cleared for a flock when its draft is sent or emptied. */
const FLOCK_DRAFTS = new Map();

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

/**
 * A person's first name, by the one rule the whole feature uses.
 *
 * Identical to `firstName` in backend/utils/messageStatus.js, deliberately and
 * with the same defensiveness, because `users.name` is free text: a null, a
 * number out of a bad join, or a string of spaces all become null here rather
 * than an empty entry in a list StatusLine would then render as ", and".
 *
 * It exists because the two halves of the group ladder arrive named
 * differently. `openedBy` on a history row is a list the SERVER has already
 * trimmed. `readers[].name` is a FULL name, and so is the optional `name` on a
 * `flock_read` event, because both come straight off the users row. Anything
 * this file draws from the roster therefore has to be cut to match what the
 * server drew, or the same flock would say "Opened by Ava" before a reload and
 * "Opened by Ava Chen" after one.
 */
const firstNameOf = (name) => {
  if (typeof name !== 'string') return null;
  const trimmed = name.trim();
  if (!trimmed) return null;
  return trimmed.split(/\s+/)[0];
};

/**
 * THE GROUP LADDER: one own message plus the flock's roster, in, one receipt
 * out. Mirrors `flockStatusFor` in backend/utils/messageStatus.js.
 *
 * WHY THIS IS COMPUTED HERE AND NOT JUST READ OFF THE ROW. A history read does
 * hand every own row a `status` and, when there are openers, an `openedBy` —
 * and if that were the only source, a receipt would freeze at whatever it was
 * when the page was fetched. Nothing on the wire updates a row: the live event
 * is `flock_read`, which carries ONE MEMBER and their two watermarks and no
 * message ids at all, because the group side stores a watermark per member
 * rather than a row per reader (migration 065 explains the N+1 that buys). So
 * a message sent thirty seconds ago has no server-supplied receipt and never
 * will; the only way it can ever say Delivered is a comparison against the
 * roster.
 *
 * Given that the roster has to be the source for new rows, it is the source
 * for ALL of them. The alternative — server status for old rows, roster for
 * new ones — is two answers to one question on one screen, and the day they
 * disagree the reader is looking at both at once. The roster IS the data the
 * server ran its own comparison over, so the two agree by construction.
 *
 * WHAT THE ROW IS STILL FOR. Everything the roster cannot answer falls back to
 * it, and that is not a formality:
 *
 *   - Nobody has caught up to this message yet. The roster says nothing, the
 *     row says 'sent', and "Sent" is what the reader gets.
 *   - The roster read FAILED. routes/messages.js catches that and answers with
 *     `readers: []` and no status on any row, because a decoration must never
 *     turn a history read into a 500. Both halves are then silent and
 *     StatusLine draws nothing, which is the whole point of it drawing nothing
 *     for an unknown status. Synthesising 'sent' from an empty roster would
 *     invent a receipt out of a server error.
 *   - A row stored before this migration existed. 065 backfills nothing, on
 *     purpose, so those rows carry no receipt and never acquire one.
 *
 * ANY reader makes it opened, not every reader, which is what the word means
 * in a group and what "Opened by 3" says. Requiring all of them would leave a
 * message on Delivered because one member never opens the app.
 */
export const flockReceipt = (message, readers) => {
  const fallback = { status: message?.status || null, openedBy: message?.openedBy || null };
  const id = Number(message?.id);
  const list = Array.isArray(readers) ? readers : [];
  if (!Number.isFinite(id) || list.length === 0) return fallback;

  const openers = list.filter((r) => (Number(r?.lastOpenedMessageId) || 0) >= id);
  if (openers.length > 0) {
    /* The count and the names are the SAME array by the time StatusLine sees
       them, so they cannot disagree. A reader whose name cannot be read is
       dropped from both rather than from one, which is the rule the server
       states where it does the same filtering. An empty list left over from
       that renders as plain "Opened", which is honest: somebody opened it and
       we cannot say who. */
    return { status: 'opened', openedBy: openers.map((r) => firstNameOf(r.name)).filter(Boolean) };
  }
  if (list.some((r) => (Number(r?.lastDeliveredMessageId) || 0) >= id)) {
    return { status: 'delivered', openedBy: null };
  }
  return fallback;
};

/* The id of the one synthetic row this screen puts into the stream.
 *
 * A bill is not a message and `messages` has no row for it, so the card that
 * draws it rides in on a row this screen builds: `message_type: 'system'`, so
 * groupRows gives it its own centred run with no name and no coloured bar
 * (a bill belongs to the room, not to whoever opened it), and this id, so
 * `renderCard` can tell it apart from a real row without guessing at a shape.
 *
 * A STRING, DELIBERATELY, and it carries NO sentAt. Message ids on this table
 * are SERIAL integers, so nothing on the wire can ever collide with it, and
 * the lookups that resolve a row back to App.js's copy simply miss it, which
 * is the right answer: there is no server row to resolve it to. The missing
 * sentAt is the other half. groupRows opens a day divider on a change of
 * calendar day and skips any row with no timestamp, so wherever this card
 * lands it cannot invent a "Yesterday" between two of today's messages. Its
 * PLACE still comes from the bill's createdAt; only the divider vote is
 * withheld.
 */
const BILL_ROW_ID = 'bill-card';
/* The vote's synthetic row. Same shape and same reason as the bill's: it is
   spliced into the stream so the group can see the vote where the conversation
   is, and it carries no system_kind, so renderCard's server-authored gate lets
   it through to the branch that draws it. */
const POLL_ROW_ID = 'poll-card';
/* The nudge's synthetic row. Same shape as the other two: no system_kind, so
   renderCard's server-authored gate lets it through. */
const NUDGE_ROW_ID = 'nudge-row';

/* Hoisted for the same reason DmDetail hoists its own: colourFor has to answer
   for YOUR runs as well as everybody else's, so the value would otherwise be
   written twice and two copies of a colour drift. */
const OWN_RUN_COLOUR = 'var(--chat-accent)';
const WHO_ROW_ID = 'who-is-here';

/* WHAT COUNTS AS "AT THE VENUE", and why these two numbers.
   200m is a radius, not a doorstep: a phone indoors behind a bar's walls
   drifts, and a card that flipped somebody from "near" to "on the way"
   because they walked to the back is worse than one that is slightly
   generous. It is small enough that the next block over is not "near".
   Ten minutes is how long a position stays worth reporting. A fix from
   forty minutes ago is not where somebody is, and a card built on it would
   be the app claiming to know where people are while knowing nothing, which
   is the exact failure the component refuses to render for. */
const AT_VENUE_KM = 0.2;
const POSITION_FRESH_MS = 10 * 60 * 1000;

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
  chatNavOpen, // unused: the header rail it opened is gone; the plus holds those five
  chatSearch,
  chatSearchRef,
  colors,
  // The message this composer is answering, and its setter. Held in App.js
  // rather than here because a takedown arriving over the socket has to be
  // able to close the quote bar, and that listener lives up there.
  flockReplyingTo,
  setFlockReplyingTo,
  pinMessage,
  unpinMessage,
  // The numeric haversine. `flockMemberLocations` is already destructured
  // further down: this screen has had the positions since the header started
  // counting "N sharing" off them, and never did anything else with them.
  distanceKm,
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
  votesLoading,
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

    /* THE KEYBOARD DOCK.
     *
     * Settled decision 4 of the rebuild, in the owner's own words: the
     * keyboard is already up when the chat opens, the cursor is in the field,
     * the field rides on top of the keyboard, and nothing jumps.
     *
     * WHAT WAS HERE BEFORE. Nothing at all. `hooks/useKeyboardComposer.js` was
     * written, documented at length and covered by `chatInputBar.test.js`, and
     * outside that test it was called by no file in the app. So both chat
     * screens shipped with the composer wherever the WebView happened to leave
     * it and with no field focused on entry, which is the one item of the
     * brief a person feels within a second of opening a chat.
     *
     * WHERE THE COMMITTED INSET IS SPENT, AND WHY NOT ON THE STREAM. The hook
     * publishes one number at the end of every slide and the shell has to
     * spend it as real layout. It is spent here, as padding under this whole
     * column, because that is the one place that moves BOTH things that have
     * to move: the bar has to finish above the keyboard, and the scroller's
     * BOX has to end above it too. `MessageList`'s own `bottomInset` prop is
     * padding INSIDE the scroller, which lifts the last row but leaves the box
     * running on down behind the keys, so a reader who then scrolls up reads
     * the next few messages through the keyboard. Spending it in both places
     * is worse than either: the two insets add, and the thread ends up a
     * keyboard's height above the composer with an empty band between them.
     * One number, one place, and the stream is left at its default of zero.
     *
     * WHY `boxSizing` TRAVELS WITH THE PADDING. This app has no global
     * box-sizing reset; `chatInput.css` says so in as many words and carries
     * its own, which is why the composer once shipped 64 tall instead of 52.
     * On a content box, padding lands OUTSIDE the `height: 100%` written on
     * this column, so the composer would be pushed a keyboard's height BELOW
     * the bottom of the phone. That is the exact opposite of the fix, and it
     * would only appear on a device with a keyboard, so it is declared on the
     * same object as the padding rather than somewhere a later edit can lose.
     *
     * WHAT IT DOES TODAY, AND WHAT THE PLUGIN WOULD ADD. `@capacitor/keyboard`
     * is deliberately not installed, so the hook runs its `visualViewport`
     * fallback: the browser reports the keyboard once it has finished moving
     * it, and the dock commits the new layout in one step rather than riding a
     * 250ms curve into it. Everything else is identical on both paths, the
     * scroll restore and the drag dismissal included. Installing the plugin
     * adds the will-show and will-hide events, which arrive BEFORE the motion
     * and are the only thing that can turn that step into the slide.
     *
     * ONE THING THE PLUGIN WILL BRING WITH IT, AND IT IS NOT IN THE PLAN.
     * The slide moves the stream and the bar with a transform, and a
     * transformed element becomes a stacking context, which paints ABOVE the
     * in-flow siblings around it. Nothing between the header and the first
     * message is lifted, and neither is the typing strip between the stream
     * and the bar, so for the length of a rise the stream would be drawn over
     * the header, the pin strip and the search bar, and for the length of a
     * fall it would be drawn over the typing strip. None of that is reachable
     * today: the fallback commits with no transition at all, so `applyLift` is
     * never called on the way up, and on the way down the stream travels away
     * from the header rather than into it. It is written here because the
     * obvious fix is a trap of its own. Giving this header a z-index would put
     * the DM header's own overflow menu inside a stacking context it does not
     * have today, and that menu sits at 60 specifically to clear the dismissal
     * layer at 55 that is NOT inside the header. Work the painting order out
     * on a device with the plugin in hand, not from this file.
     *
     * THE SHEETS STAY SIBLINGS OF THE BAR. Every one of them below is rendered
     * out here rather than inside the composer, and it has to stay that way: a
     * transformed element is the containing block for a `position: fixed`
     * descendant, so a sheet inside the bar would position itself against a
     * bar part way through a slide and land somewhere different depending on
     * when the tap arrived. `__tests__/chatSheetOpensClean.test.js` pins it.
     */
    const keyboard = useKeyboardComposer();

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
    /* ONE DRAFT PER THREAD, kept outside the component so it survives the
       unmount that every screen change causes (App.js renders one screen at a
       time through ScreenSlot). Module scope, not localStorage: a draft is
       worth a trip back to the same flock in the same session, not worth
       persisting a half-written sentence to disk. */
    const [draft, setDraft] = React.useState(() => FLOCK_DRAFTS.get(selectedFlockId) || '');
    /* The mirror, readable from the effect below without widening its deps. */
    const draftRef = React.useRef('');
    const writeDraft = React.useCallback((next) => {
      draftRef.current = next;
      setDraft(next);
    }, []);
    /* Put the stashed sentence back into App.js's shared ref too, or the
       box would show text that Send does not read. Safe because
       leaveChatScreen empties that ref on the way out, so it is only ever
       loaded while this exact thread is on screen. */
    const restoredForRef = React.useRef(null);
    React.useEffect(() => {
      const id = selectedFlockId;
      if (!id || restoredForRef.current === id) return;
      restoredForRef.current = id;
      const stashed = FLOCK_DRAFTS.get(id) || '';
      if (!stashed) return;
      writeDraft(stashed);
      setChatInput(stashed);
    }, [selectedFlockId, writeDraft, setChatInput]);

    const hadTextRef = React.useRef(false);
    React.useEffect(() => {
      /* Same correction as the DM twin: chatInputHasText is `!!value.trim()`
         in App.js, so a box backspaced down to spaces drops the flag and this
         used to wipe those spaces. Clear only when the mirror still holds real
         text, which is the case where App.js emptied the box on a send or an
         exit and this screen never saw a change event. */
      const mirrorHasRealText = draftRef.current.trim().length > 0;
      if (hadTextRef.current && !chatInputHasText && mirrorHasRealText) writeDraft('');
      hadTextRef.current = chatInputHasText;
      // writeDraft is a useCallback with no deps, so it is stable and this
      // list still changes only when App.js's flag does.
    }, [chatInputHasText, writeDraft]);

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

    /* WHICH NUDGES THIS READER HAS SENT AWAY. Declared up here with the other
       hooks because the row that uses it is built below a conditional return
       and hooks cannot go there.

       Kept in state AND in localStorage, and read through the helper below
       rather than from state alone. State is what makes the dismissal
       immediate; storage is what stops the row coming back on the next reload,
       which is the difference between a nudge and the banner this replaces.

       Storage can throw outright in a private window or with site data
       blocked, so every access is guarded and a failure reads as "not
       dismissed". That is the safe direction here: the reader sees a nudge
       again, which is a small annoyance, rather than the app silently
       swallowing a prompt it had no way to know was still wanted. */
    /* WHICH PIN IS SHOWING. Controlled here rather than inside the bar, for
       the two reasons its own header gives: a pin can be removed by somebody
       else while the bar is open and only the shell sees that socket event,
       and this screen remounts on every trip out to a venue and back, so
       state kept inside the bar would silently reset to the first pin every
       time. */
    const [pinIndex, setPinIndex] = React.useState(0);

    const [nudgeDismissed, setNudgeDismissed] = React.useState({});
    const dismissNudge = React.useCallback((key) => {
      setNudgeDismissed((prev) => (prev[key] ? prev : { ...prev, [key]: true }));
      try {
        localStorage.setItem(`flock_nudge_${key}`, '1');
      } catch (err) {
        /* The dismissal still holds for this session through the state above. */
      }
    }, []);
    const nudgeIsDismissed = React.useCallback((key) => {
      if (nudgeDismissed[key]) return true;
      try {
        return localStorage.getItem(`flock_nudge_${key}`) === '1';
      } catch (err) {
        return false;
      }
    }, [nudgeDismissed]);
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
      /* STASHED, NOT DISCARDED. This used to be writeDraft('') and the
         sentence was gone. The leak it was closing is App.js's shared ref,
         which setChatInput above has already emptied, so keeping this
         screen's own copy against this flock's id costs nothing and returns
         the text when the same thread is opened again. */
      if (selectedFlockId) {
        const keep = draftRef.current;
        if (keep) FLOCK_DRAFTS.set(selectedFlockId, keep); else FLOCK_DRAFTS.delete(selectedFlockId);
      }
      restoredForRef.current = null;
      writeDraft('');
      /* THE SAME HOLE, and here it predates the rebuild. `shareImageToChat`
         reads the caption from the shared `chatInputRef`, so a photo picked in
         one flock and abandoned was offered in the next flock opened and went
         out with whatever was typed there. The DM twin of this was found by an
         adversarial review of the DM rewrite on 2026-09-05; this one had been
         reachable for longer and nobody had looked. */
      setPendingImage(null);
      setShowImagePreview(false);
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
    /* THE HEADER PILL'S WORDS. Money first, then how far along, and either
       half is dropped when there is nothing honest to put there rather than
       printed as a bare "$" or an "0/0" a shell would produce before anyone
       has committed. */
    const billPillMoney = typeof billSplit?.totalWithTip === 'number' ? `$${billSplit.totalWithTip.toFixed(2)}` : null;
    const billPillCount = billBar.total > 0 ? `${billBar.settled}/${billBar.total}` : null;
    const billPillLabel = billBar.all
      ? (billPillMoney ? `${billPillMoney} · settled` : 'Settled')
      : ([billPillMoney, billPillCount].filter(Boolean).join(' · ') || 'Bill');
    /* The viewer's own figure before a bill exists, for the card's shell
       state. It is the settled budget ceiling, which is the same number
       POST /ghost-commit answers with, so the card and the budget band cannot
       name two different amounts for one night. A withheld ceiling is not a
       number and is not turned into one. */
    const estimatedShare = budgetStatus?.ceiling != null && Number.isFinite(Number(budgetStatus.ceiling))
      ? Number(budgetStatus.ceiling)
      : null;
    /* THE GHOST STATE IS THE SAME CARD, WHICH MEANS IT HAS TO EXIST BEFORE THE
       BILL DOES. The card the "Lock in your share?" band became draws a bill,
       and the whole point of that band was the moment when there is no bill
       row at all: a venue is confirmed, the budget has settled, and committing
       is what CREATES the shell. So when those conditions hold and nothing has
       been posted yet, the card is handed a payerless bill with no shares,
       which is exactly what the server would answer with a second later, and
       it draws the estimate and the commit off that. The conditions are the
       old band's own, unchanged, including the ceiling having to be a real
       figure above zero: "Commit $0" is not a thing to ask anybody. */
    const ghostAsk = !billSplit
      && flock.status === 'confirmed'
      && flock.budgetEnabled
      && flock.ghostModeEnabled
      && estimatedShare != null && estimatedShare > 0;
    const billForCard = billSplit || (ghostAsk ? { hasPayer: false, shares: [] } : null);

    /* THE THREE MONEY ACTIONS, DECLARED ONCE AND CALLED FROM BOTH COPIES.
       The bill is drawn in two places now, as a card in the stream and as the
       sheet behind the header pill, and a Settle Up that does one thing on the
       card and another in the sheet is the same class of defect the tally had
       before billTally was pulled out: one object, two answers. The bodies are
       the sheet's own, moved rather than rewritten. */

    // Settling is a handoff, never an automatic write. A method with no deep
    // link, no web link and no instructions does nothing when it is tapped, so
    // it is not offered and it does not count towards "is there anything to
    // pay through". A failed lookup is NOT a payment: the debt stays open and
    // the reader is pointed at Mark as Paid, which is a deliberate tap.
    const startSettleUp = async () => {
      try {
        const result = await getPaymentLinks(selectedFlockId);
        const methods = (result.methods || []).filter((m) => paymentRoutes(m).actionable);
        setPaymentOptions({ ...result, methods });
        setShowPaymentPicker(true);
      } catch (err) {
        showToast(err?.message || 'Could not load payment links. Use "Mark as Paid" after paying.', 'error');
      }
    };

    // The way back out of "I paid". Settling used to be a one-way door and a
    // mis-tap left a debt recorded as cleared with no remedy in the product.
    const undoMySettle = async () => {
      try {
        const unsettled = await unsettleShare(selectedFlockId);
        setBillSplit(prev => ({
          ...prev,
          ...tallyOf(unsettled),
          shares: prev.shares.map(s => String(s.userId) === String(authUser?.id) ? { ...s, settled: false, settledAt: null, outstanding: owedOn(s) } : s),
        }));
        showToast('Your share is marked unpaid again');
      } catch (err) { showToast(err.message, 'error'); }
    };

    // Pre-committing to the group's number. The bill is re-read straight
    // after, because the commit changes the row the card draws and without
    // this the card stayed as it was until the screen was left.
    const commitEstimatedShare = async () => {
      try {
        await ghostCommit(selectedFlockId);
        try { const d = await getBillSplit(selectedFlockId); setBillSplit(d.bill); } catch (_) { /* the socket event covers it */ }
        showToast('Committed');
      } catch (err) { showToast(err.message, 'error'); }
    };
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

    /* WHICH STRIP, IF ANY, SITS UNDER THE HEADER.
       PinStrip takes ONE already-decided model and refuses to choose between
       states itself, which is the whole reason it exists: this screen used to
       hold three separate booleans for three separate bars and two of them
       could be true at once. So the order is decided here, once. A confirmed
       place wins, because it is the answer; an open vote is the strip while
       the answer is still being argued about; and a flock with neither gets
       nothing at all, which is the rule the header is built on. */
    const pinModel = (() => {
      if (flock.venue && flock.venue !== 'TBD') {
        return { kind: 'venue', name: flock.venue, thumbUrl: flock.venuePhoto || undefined, caption: 'Pinned' };
      }
      const openVotes = flock.votes || [];
      if (openVotes.length === 0) return null;
      /* The vote panel's own arithmetic, so the strip and the panel it opens
         cannot report two different tallies. Guests vote from the invite link
         and stay anonymous, so they add to the total without adding a name. */
      const votedCount = new Set(openVotes.flatMap(v => v.voters || [])).size
        + openVotes.reduce((sum, v) => sum + (v.guestCount || 0), 0);
      const roster = Number(flock.memberCount) || (flock.members || []).length;
      // PinStrip prints the figure only when both numbers really arrived, and
      // a flock whose roster has not loaded has no denominator to print.
      return { kind: 'vote', votedCount, memberCount: roster > 0 ? roster : undefined };
    })();

    /* A tap on the strip goes to whatever the strip is about. On a place that
       is the venue's page on the map, which is where the banner's "Map" button
       went and it pans exactly as that button did. On an open vote it is the
       panel, because the thing a member wants when they read "Vote open, 3 of
       8" is the ballot. The vote branch does not leave the screen, so it does
       not clear the composer; the venue branch does both. */
    const openPinStrip = (model) => {
      if (model && model.kind === 'vote') {
        setShowVotePanel(true);
        loadPopularVenues();
        return;
      }
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
    };

    /* The banner's "Change" button, which is PUT /api/flocks/:id and therefore
       creator-only. It hands off to the Discover picker the same way it always
       did, and it clears the composer on the way out like every other exit
       from this screen. */
    const changePinnedPlace = () => {
      leaveChatScreen();
      setPickingVenueForCreate(true);
      setPickingVenueForFlockId(flock.id);
      setCurrentTab('explore');
      setCurrentScreen('main');
    };

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
    /* THE VOTE, AS A CARD IN THE STREAM.
       The sheet stays for browsing and suggesting. What moves here is the vote
       itself, so scrolling back through a night shows WHEN the group decided
       and not only what it decided.

       WHERE IT SITS, and why that anchor. There is no "vote opened" timestamp
       in the schema, so the card is anchored to the first venue card anyone
       shared in this thread, which is the moment the vote visibly began to a
       reader. That is an approximation and it is deliberately the honest one
       available: inventing a real opened_at would be a migration and a server
       change for a line of chrome. Votes cast from the sheet with no card
       shared leave no anchor at all, and the card goes on the end.

       ONLY WHILE THERE IS SOMETHING TO SHOW. No votes, no card. A locked plan
       keeps its card, because the counts are the record of how the group got
       there, and the system row above it says when. */
    const pollVoteRows = flock.votes || [];
    const pollLockedName = (flock.status === 'confirmed' || flock.status === 'completed')
      ? (flock.venue && flock.venue !== 'TBD' ? flock.venue : null)
      : null;
    const pollForCard = pollVoteRows.length > 0;
    const pollAnchorMs = (() => {
      if (!pollForCard) return NaN;
      const firstCard = (flock.messages || []).find((m) => m.message_type === 'venue_card' && m.venue_data);
      return firstCard?.sentAt ? new Date(firstCard.sentAt).getTime() : NaN;
    })();

    /* THE NUDGE, and every rule that governs it lives here. NudgeRow draws a
       nudge the parent has already decided to show, the same way every other
       file in that folder takes its whole world as props.

       IT REPLACES THE 40pt MOMENTUM METER pinned under the header. A prompt
       that fires on a healthy plan is a banner, and banners between the header
       and the first message are the thing this rebuild exists to remove, so
       the gates below are the feature rather than trimming around it:

         - Only when the plan is actually STUCK. No venue has been suggested,
           so the group is stalled at step one, which is the failure the whole
           product is about.
         - Not in an empty thread. A flock nobody has spoken in yet is not
           stuck, it is new, and greeting somebody with a prompt is the banner
           again.
         - Not while somebody is typing. A prompt landing mid-sentence is an
           interruption, and what it is asking for may be about to happen.
         - Not once the plan locks, or is called off. There is nothing left to
           nudge toward.
         - Not once dismissed, and that is remembered across reloads.

       ONE NUDGE, not a queue. There is exactly one kind today; a second would
       need a priority order here, not a second row on screen. */
    /* WHO IS HERE. One card, updated in place, rather than one row per
       arrival: six people arriving over twenty minutes is six system rows,
       which is a chat nobody can read.

       Member positions have existed since the map was built and the chat said
       nothing about them, so a member sharing a location showed up on a screen
       the reader had to leave the conversation to see. This is the one line
       the group actually wants at nine o'clock.

       COUNTS ONLY, and only from FRESH positions. A stale fix is not where
       somebody is. The card refuses to draw when both counts are zero, so a
       night where nobody is sharing shows nothing at all rather than an empty
       claim.

       The viewer is not counted. "3 near Kome" meaning two other people and
       yourself reads as a bigger group than there is, and you already know
       where you are. */
    const whoIsHere = (() => {
      const positions = flockMemberLocations || {};
      const nowMs = Date.now();
      const hasVenue = Number.isFinite(Number(flock.venueLat)) && Number.isFinite(Number(flock.venueLng));
      let near = 0;
      let onTheWay = 0;
      const nearPeople = [];
      for (const [uid, loc] of Object.entries(positions)) {
        if (String(uid) === String(authUser?.id)) continue;
        if (!loc || !Number.isFinite(Number(loc.lat)) || !Number.isFinite(Number(loc.lng))) continue;
        const at = loc.timestamp ? new Date(loc.timestamp).getTime() : NaN;
        if (!Number.isFinite(at) || nowMs - at > POSITION_FRESH_MS) continue;
        // No venue yet means nobody can be "near" it, but people are still
        // moving toward each other and "2 on the way" is true. The card drops
        // the venue name in that case rather than naming one nobody picked.
        const isNear = hasVenue
          && distanceKm(Number(loc.lat), Number(loc.lng), Number(flock.venueLat), Number(flock.venueLng)) <= AT_VENUE_KM;
        if (isNear) {
          near += 1;
          const member = (flock.members || []).find((mm) => String(mm.id) === String(uid)) || null;
          nearPeople.push({ id: uid, name: loc.name || member?.name || 'Member', avatarUrl: member?.image || undefined });
        } else {
          onTheWay += 1;
        }
      }
      return (near === 0 && onTheWay === 0) ? null : { near, onTheWay, people: nearPeople, hasVenue };
    })();

    /* The bar takes `{ id, preview }`. The server sends the message id and
       enough of the row to describe it, so the preview is built here with the
       same helper the stream and the reply quote use rather than shipped as
       prose: a pinned photo or venue card has no text, and messagePreview is
       what turns that into "Photo" instead of a blank line. */
    const pinnedForBar = (flock.pins || []).map((p) => ({
      id: p.id,
      preview: messagePreview({ text: p.text, message_type: p.messageType, hadContent: true }),
    }));

    /* THE JUMP. MessageRow carries data-message-id, so a row is addressable
       without the module exposing anything new. A plain query rather than
       taking registerScroller, which the keyboard dock already owns and which
       the module warns has to keep its identity between renders.

       A PIN CAN POINT PAST THE LOADED PAGE. Three pins live for the whole
       night and the stream pages, so the row is often simply not mounted.
       Saying so beats a tap that does nothing, which on a control whose only
       job is "take me there" reads as broken. */
    const jumpToMessage = (messageId) => {
      const id = Number(messageId);
      if (!Number.isFinite(id)) return;
      const el = document.querySelector(`[data-message-id="${id}"]`);
      if (!el) {
        showToast('That message is further back in the chat.');
        return;
      }
      // No smooth scroll. Nothing in this rebuild slides, and a jump that
      // animates past everything between here and there is slower to read
      // than one that arrives.
      el.scrollIntoView({ block: 'center' });
    };

    const nudgeKey = `${flock.id}:no_venue`;
    const nudgeForCard = (
      pollVoteRows.length === 0
      && flock.status !== 'confirmed'
      && flock.status !== 'completed'
      && flock.status !== 'cancelled'
      && (flock.messages || []).length > 0
      && !isTyping
      && !nudgeIsDismissed(nudgeKey)
    )
      ? { key: nudgeKey, text: 'Nobody has picked a place yet.', actionLabel: 'Open the vote' }
      : null;

    const sourceRowById = new Map((flock.messages || []).map((m) => [m.id, m]));
    const originalRow = (m) => (m && sourceRowById.get(m.id)) || m;
    const needsDressing = searchActive
      || visibleMessages.some((m) => m.message_type === 'venue_card' && m.venue_data && m.text)
      // A quote needs the same preview treatment a row does: a reply to a photo
      // or a venue card has no text to show, and messagePreview is what turns
      // that into "Photo" instead of an empty quote block. Adding it to the
      // dressing test rather than mapping unconditionally keeps the array
      // identity stable for the common case, which is what MessageList's
      // scroll rules key off.
      || visibleMessages.some((m) => m.reply_to);
    const listRows = needsDressing ? visibleMessages.map((m) => {
      const isCard = m.message_type === 'venue_card' && m.venue_data;
      const carded0 = isCard ? { ...m, text: '' } : m;
      /* hadContent tells messagePreview the quoted row DID carry something,
         so an image quote reads "Photo" rather than falling through to the
         empty-message wording. Same call the DM stream makes. */
      const carded = m.reply_to
        ? { ...carded0, reply_to: { ...m.reply_to, text: messagePreview({ ...m.reply_to, hadContent: true }) } }
        : carded0;
      /* AND ON THE SEARCH PATH TOO. The highlight below rebuilds `text` from
         the row's own copy, so a query the caption matched ("check out") put
         that caption straight back under the card the line above had just
         cleared, which is the duplicate the blanking exists to stop. A card is
         a card whether or not a search is running. Fixed on the DM side
         already; this is the flock half of the same line. */
      if (isCard || !searchActive || typeof m.text !== 'string' || !m.text.toLowerCase().includes(chatSearch.toLowerCase())) return carded;
      return { ...carded, text: highlightMatches(m.text, chatSearch) };
    }) : visibleMessages;

    /* THE BILL CARD RIDES IN HERE, and the two bands it replaces are gone.
       A bill used to be told in two places at once above the first message: a
       "Lock in your share?" card that appeared the moment a venue was
       confirmed, and a summary bar under it once a bill existed. They were two
       surfaces for one object and they could disagree about it, which is
       exactly how a member came to see a commit card over a bill bar for the
       same night. This is one card, posted where the bill was created and
       rewritten in place every time somebody settles.

       NOT WHILE A SEARCH IS OPEN. A search shows the rows that match and
       nothing else; a card that ignored the query would be the one thing on
       screen that is not a result.

       PLACED BY THE BILL'S OWN createdAt, not appended. A bill posted before
       tonight's messages belongs above them, and MessageList reads the last
       row's id to decide whether something just arrived, so dropping an old
       bill on the end would announce it as a new message every time the screen
       re-rendered. Appending is the fallback for a bill whose createdAt did
       not parse, which is also the common case: a bill is usually the newest
       thing in the room. */
    /* THE TWO ROWS THAT ARE NOT MESSAGES: the bill and the vote. Both are
       placed by a timestamp so they sit where the thing they describe
       happened, and both are dropped while a search is open, because a search
       shows what matches and a card that ignored the query would be the one
       thing on screen that is not a result.

       The placement rule was written for the bill and is now shared, rather
       than copied: a second private copy of it is how the two would come to
       disagree about where a card belongs. A row with no parseable anchor goes
       on the end, which is also the common case for a bill, since a bill is
       usually the newest thing in the room. */
    const spliceByTime = (rows, row, whenMs) => {
      let at = rows.length;
      if (Number.isFinite(whenMs)) {
        // The first row that is NEWER than the anchor. Synthetic rows carry no
        // sentAt, so they read as NaN here and are skipped rather than
        // treated as the boundary.
        const after = rows.findIndex((m) => {
          const t = m.sentAt ? new Date(m.sentAt).getTime() : NaN;
          return Number.isFinite(t) && t > whenMs;
        });
        if (after >= 0) at = after;
      }
      const next = rows.slice();
      next.splice(at, 0, row);
      return next;
    };

    let streamRows = listRows;
    if (!searchActive) {
      if (pollForCard) {
        streamRows = spliceByTime(streamRows, { id: POLL_ROW_ID, message_type: 'system' }, pollAnchorMs);
      }
      if (billForCard) {
        const created = billForCard.createdAt ? new Date(billForCard.createdAt).getTime() : NaN;
        streamRows = spliceByTime(streamRows, { id: BILL_ROW_ID, message_type: 'system' }, created);
      }
      // Also on the end, and for the same reason as the nudge: this is the
      // state of the room right now, not a moment in the scrollback.
      if (whoIsHere) {
        streamRows = spliceByTime(streamRows, { id: WHO_ROW_ID, message_type: 'system' }, NaN);
      }
      // The nudge goes last and carries no anchor, so it lands on the end. The
      // other two describe a moment in the scrollback; this one describes the
      // state of the plan right now, and a prompt about the present belongs
      // where the reader already is.
      if (nudgeForCard) {
        streamRows = spliceByTime(streamRows, { id: NUDGE_ROW_ID, message_type: 'system' }, NaN);
      }
    }

    // A venue card is the one message shape the module does not own, so the
    // screen draws it and the module calls back for it. Same vote arithmetic
    // as the card this replaces, same exit through leaveChatScreen, and the
    // count is the real tally or nothing at all.
    /* THE THREE VOTE ACTIONS, HOISTED OUT OF THE VOTE PANEL on 2026-09-05.
       They were declared inside the `showVotePanel &&` IIFE, which meant only
       that sheet could reach them. The poll card below needs the same three,
       and this file already carries the scar from the alternative: the note on
       the flock send path records a venue card keeping "its own private copy
       of this whole function" and inheriting none of its fixes. Two surfaces
       casting a vote through two implementations is how they come to disagree
       about the tally in front of the group.

       Moved verbatim. The only change is the indentation and where they are
       declared; every comment below is the one that was already on them. */
    const flockVotesAll = flock.votes || [];

          const handleQuickVote = (venueName, venueType, venuePlaceId) => {
      const existingVote = flockVotesAll.find(v => v.venue === venueName);
      if (existingVote) {
        if (existingVote.voters.includes('You')) return; // already voted
        const newVotes = flockVotesAll.map(v => ({
          ...v,
          voters: v.venue === venueName
            ? [...v.voters, 'You']
            : v.voters.filter(x => x !== 'You')
        }));
        updateFlockVotes(selectedFlockId, newVotes);
      } else {
        const newVotes = [...flockVotesAll.map(v => ({ ...v, voters: v.voters.filter(x => x !== 'You') })), { venue: venueName, type: venueType || 'Venue', place_id: venuePlaceId || null, voters: ['You'] }];
        updateFlockVotes(selectedFlockId, newVotes);
      }
    };

    const handleUnvote = () => {
      const newVotes = flockVotesAll
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

    const renderCard = (m) => {
      /* THE PLAN'S OWN EVENTS (migration 067). groupRows already collapses
         consecutive system rows into one ownerless run and MessageGroup
         already routes them through this same door, so this branch is the
         last piece: the module has been ready for these rows since it was
         built and the database could not store one until 067 widened the
         CHECK on message_type.

         PARTS, NOT PROSE. SystemRow takes pieces and decides itself which one
         is accented, so the sentence is assembled here, next to the rest of
         this screen's copy, rather than shipped from the server. A kind this
         build does not recognise falls through to null and draws NOTHING,
         which is why the column carries no CHECK constraint: an older client
         meeting a newer event shows one missing line instead of a broken row,
         and a server rolled forward before its clients is the normal order. */
      /* GATED ON system_kind, NOT ON message_type ALONE, and that distinction
         is load-bearing rather than tidy. The bill row is a SYNTHETIC local
         row spliced into the stream as `{ id: BILL_ROW_ID, message_type:
         'system' }`, so that groupRows treats it as ownerless the way it
         treats a real system row. It carries no system_kind because no server
         ever wrote it.

         Claiming every row whose type is 'system' therefore swallowed the
         bill card whole: it fell past the venue_set check, hit the `return
         null` below, and bill splitting silently vanished from the chat. That
         shipped in 3561d30 and is the exact hazard of matching on a shape that
         two different things share.

         A row the SERVER authored always has a kind. A synthetic one never
         does. So the kind is the test, which also means any future local row
         borrowing this message_type keeps working without touching this. */
      if (m.message_type === 'system' && m.system_kind) {
        if (m.system_kind === 'venue_set') {
          return (
            <SystemRow
              kind="venue_set"
              parts={[
                { text: `${m.sender === 'You' ? 'You' : m.sender} set the venue: ` },
                { text: m.text, accent: true },
              ]}
            />
          );
        }
        return null;
      }

      /* The one row this screen builds itself. Its actions are the sheet's own
         handlers, so a settle from the card and a settle from the sheet are
         the same call. `canPayOnline` is deliberately not passed: this screen
         does not know whether the payer has a handle on file until
         getPaymentLinks answers, and BillCard treats an unstated capability as
         unstated rather than as "no", which keeps the label honest instead of
         promising a cash-only night the server never described. */
      if (m.id === WHO_ROW_ID) {
        return (
          <WhoIsHereCard
            /* Named only when the group has actually picked one. "3 near Kome"
               is a claim about a venue; without one the card says "3 nearby",
               which is still true. */
            venueName={whoIsHere.hasVenue ? (flock.venue && flock.venue !== 'TBD' ? flock.venue : null) : null}
            nearCount={whoIsHere.near}
            onTheWayCount={whoIsHere.onTheWay}
            members={whoIsHere.people}
            onOpenMap={() => {
              leaveChatScreen();
              setVenueDetailReturnTo({ tab: 'chat', screen: 'chatDetail', flockId: selectedFlockId });
              setCurrentTab('explore');
              setCurrentScreen('main');
            }}
          />
        );
      }

      if (m.id === NUDGE_ROW_ID) {
        return (
          <NudgeRow
            text={nudgeForCard.text}
            actionLabel={nudgeForCard.actionLabel}
            /* Acting does NOT dismiss. The nudge's condition is that nobody
               has picked a place, so voting clears it on its own and opening
               the sheet without voting leaves it true. Dismissing on the way
               in would hide a prompt whose reason had not gone away, which is
               the same lie as a banner that cannot be closed. */
            onAction={() => setShowVotePanel(true)}
            onDismiss={() => dismissNudge(nudgeForCard.key)}
          />
        );
      }

      if (m.id === POLL_ROW_ID) {
        /* The footer's two figures are read separately on purpose. A vote
           total is not a voter total: a guest voting from an invite link adds
           to a row's count without adding a name, so the row counts and the
           footer count are independent figures and the card is documented not
           to guess one from the other. This is the same arithmetic the sheet
           does, from the same hoisted list, so the two surfaces cannot print
           different tallies for the same night. */
        const voterNames = new Set(pollVoteRows.flatMap((v) => v.voters || []));
        const guestVotes = pollVoteRows.reduce((sum, v) => sum + (v.guestCount || 0), 0);
        const options = [...pollVoteRows]
          .sort((a, b) => voteTotal(b) - voteTotal(a))
          .map((v) => ({
            id: v.place_id || v.venue,
            name: v.venue,
            voteCount: voteTotal(v),
            voted: (v.voters || []).includes('You'),
            // Only when the row really carries one. The card draws a star for
            // a numeric rating and nothing at all otherwise, so passing a
            // guess here would put a figure on screen the server never sent.
            ...(typeof v.rating === 'number' ? { rating: v.rating } : {}),
          }));
        return (
          <PollCard
            title="Where are we going?"
            options={options}
            votedCount={voterNames.size + guestVotes}
            memberCount={flock.memberCount ?? (flock.members || []).length}
            isHost={!!flock.creatorId && String(flock.creatorId) === String(authUser?.id)}
            lockedName={pollLockedName}
            /* Toggle, matching the venue card row on this same screen: a tap
               on the option you already picked takes the vote back. The
               sheet's quick vote returns early instead, because that surface
               has its own separate unvote control and this one does not. */
            onVote={(o) => {
              if (o.voted) handleUnvote();
              else handleQuickVote(o.name, 'Venue', o.id === o.name ? null : o.id);
            }}
            /* The SAME confirm the sheet runs, which is the whole reason it
               was hoisted. It writes the venue and the status in one PUT, so
               members get one push and the plan cannot end up confirmed at a
               venue the server refused. */
            onLock={(o) => handleConfirmVenue({ venue: o.name, place_id: o.id === o.name ? null : o.id })}
            onOpen={() => setShowVotePanel(true)}
          />
        );
      }

      if (m.id === BILL_ROW_ID) {
        const roster = {};
        for (const mem of flock.members || []) {
          if (mem && typeof mem === 'object' && mem.id != null) roster[mem.id] = { avatarUrl: mem.image || undefined };
        }
        const isShell = billForCard.hasPayer === false;
        const myShare = (billForCard.shares || []).find((s) => String(s.userId) === String(authUser?.id)) || null;
        return (
          <BillCard
            bill={billForCard}
            viewerId={authUser?.id}
            members={roster}
            estimatedShare={estimatedShare}
            onOpen={() => setShowChatPool(true)}
            onCommit={isShell ? commitEstimatedShare : undefined}
            onSettle={!isShell && myShare && !myShare.settled ? startSettleUp : undefined}
            /* Hidden for the payer and for a share settled by carried credit,
               rather than shown and refused: the server answers 409 on both
               and a control that exists only to be rejected is a dead one. */
            onUndo={myShare && myShare.settled && !coveredByCredit(myShare)
              && String(billForCard.paidBy?.id ?? '') !== String(authUser?.id ?? '')
              ? undoMySettle
              : undefined}
          />
        );
      }
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

    // THE RECEIPT, AND ONLY WHAT THE SERVER CAN BACK.
    //
    // This comment used to say there was no delivered and no opened on the
    // flock side, "no column, no event, nothing to read", and that was true
    // until migration 065 and commit 2bcdc55. There are now two watermarks per
    // member, a `readers` roster on the history read, per-row `status` and
    // `openedBy`, and a `flock_read` event. All five words StatusLine knows are
    // reachable from this screen, and until this change none of them past
    // 'sending' was ever asked for, so the whole ladder was invisible.
    //
    // WHICH ROW GETS WHICH. The two client-owned states are per row and stay
    // per row: 'failed' belongs to the message that did not send, wherever in
    // the run that is, and 'sending' belongs to EVERY row still on the wire,
    // because two can be in flight at once and asking only about the last one
    // hid the first one's receipt entirely (and, during a search, attached it
    // to the last own row that MATCHED rather than the one still sending).
    //
    // The three SERVER states are not per row. They belong to the conversation
    // and appear exactly once, under your last own message, which is what
    // StatusLine's own header describes and what the capture shows: the word
    // goes away when the other person's next message arrives, because there is
    // a newer thing on the screen than your receipt.
    const lastThreadRow = (flock.messages || [])[(flock.messages || []).length - 1];
    /* Read off `flock.messages` and NOT off the rows being drawn. The stream
       can be a search result, and it can carry the synthetic bill row this
       screen splices in; neither changes which message is actually last in the
       conversation. A receipt that moved because somebody typed in the search
       box would be a receipt about the search box. */
    const receiptRowId = lastThreadRow && lastThreadRow.sender === 'You'
      && !lastThreadRow.pending && !lastThreadRow.failed
      ? lastThreadRow.id
      : null;

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
      if (m.id !== receiptRowId) return null;
      /* `flock.readers` is the roster GET /api/flocks/:id/messages hands back,
         kept current by the `flock_read` events App.js merges into it. An
         unknown or missing status returns null here rather than reaching
         StatusLine as a word, so a flock whose roster read failed draws
         nothing at all instead of claiming "Sent". */
      const { status, openedBy } = flockReceipt(m, flock.readers);
      if (!status) return null;
      return <StatusLine status={status} openedBy={openedBy} />;
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
      /* The keyboard's committed height, spent once, here. Both halves are
         explained at the hook call above: the padding is what puts the bar and
         the bottom of the stream above the keys, and the border box is what
         keeps that padding inside the 100% instead of hanging off the end of
         the phone. With the keyboard down this is `0px` and the column is what
         it always was. */
      <div key="chat-detail-screen-container" style={{ display: 'flex', flexDirection: 'column', height: '100%', boxSizing: 'border-box', paddingBottom: keyboard.bottomInset, backgroundColor: 'var(--bg-card-solid)' }}>
        <div style={{ padding: '10px 10px 8px 6px', background: colors.navyBg, flexShrink: 0, boxShadow: '0 2px 10px rgba(0,0,0,0.1)' }}>
          <div style={{ display: 'flex', alignItems: 'stretch', gap: '6px' }}>
            <button aria-label="Back" className="hit44" onClick={() => { leaveChatScreen(); setCurrentScreen('main'); }} style={{ width: '34px', borderRadius: '10px', background: 'none', border: 'none', color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{Icons.arrowLeft('white', 20)}</button>
            {/* THE NAME IS ALWAYS THE NAME, AND IT IS NOW THE DOOR TO THE PLAN.
                It used to be swapped out for a rail of five controls whenever
                the "Features" pill was pressed, so reaching for a feature cost
                you the title of the thing you were looking at. Those five live
                behind the plus now.

                WHAT ARRIVED HERE ON 2026-09-05. A full width 40pt button
                reading "Thu 3:59 AM · Called off" with a "Plan" affordance sat
                between this header and the first message, one of three bars
                stacked there. The two facts it carried are facts about the
                plan, and the plan's name is already on this line, so they moved
                into the line under it and the bar went. Same handler, same
                aria-label, one fewer band of chrome.

                WHY THE MEMBER COUNT DID NOT COME WITH THEM. Three things do not
                fit on a 12pt line at 320px without an ellipsis eating the one
                that changes, and the roster is the only one of the three that
                is not a live state: it is on the plan screen this button opens,
                in full, with names and RSVPs. The time and the status are the
                two that move under you while you are reading.

                WHY THE HEADING BECAME A SPAN. ARIA gives role=button
                presentational children, so an <h2> in here is announced by
                nothing and reachable by no rotor; it was a heading in name
                only. The name and the state are pulled back into the button's
                announcement by aria-describedby, which resolves an id
                reference whether or not the element it names is a child, so a
                screen reader hears which chat this is and what the plan is
                doing rather than four words about a screen it has not opened
                yet. */}
            <button
              type="button"
              className="hit44"
              aria-label="Open the plan"
              aria-describedby="chat-header-name chat-header-plan-state"
              onClick={() => { leaveChatScreen(); setCurrentScreen('detail'); }}
              style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'flex-start', padding: '0 2px', border: 'none', background: 'none', cursor: 'pointer', textAlign: 'left' }}
            >
                <span id="chat-header-name" style={{ maxWidth: '100%', fontFamily: 'var(--font-display)', letterSpacing: '-0.005em', fontWeight: '600', color: 'white', fontSize: 'var(--t-title)', lineHeight: '1.2', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{flock.name}</span>
                <span id="chat-header-plan-state" style={{ maxWidth: '100%', display: 'flex', alignItems: 'center', gap: '5px', marginTop: '2px', overflow: 'hidden' }}>
                  {/* Reads the live socket, not a literal. The dot and the
                      word both move, so the state is carried by more than a
                      tint, and "reconnecting" is the truth while socket.io
                      is still retrying: history is already on screen over
                      HTTP, and what is missing is anything said since. A total
                      loss of network is a different thing and OfflineGate
                      covers the whole app for it.

                      THE ORDER CHANGED AND THE WORDS DID NOT. The plan line
                      leads, because it is what a person came in to know, and
                      it is the half that ellipsises last. The dot and its
                      word close the line, together rather than a separator
                      apart, so the tint sits beside the word it tints and the
                      connection is the thing that gets cut on a narrow phone
                      rather than the time of the plan. What the member count
                      used to hold is this space; it is on the plan screen this
                      header opens, with names and RSVPs beside it. */}
                  {isTyping ? <span style={{ fontSize: 'var(--t-meta)', color: '#86EFAC', fontWeight: '500', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{typingUser} is typing...</span> : <><span style={{ fontSize: 'var(--t-meta)', color: 'rgba(255,255,255,0.55)', fontWeight: '500', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{flock.time && flock.time !== 'TBD' ? flock.time : 'Time still open'} · {flock.status === 'confirmed' ? 'Locked in' : flock.status === 'completed' ? 'Done' : flock.status === 'cancelled' ? 'Called off' : 'Still voting'}</span><span aria-hidden="true" style={{ width: '5px', height: '5px', borderRadius: '3px', flexShrink: 0, backgroundColor: connectionState === 'online' ? '#22c55e' : connectionState === 'offline' ? '#9CA3AF' : '#F59E0B', boxShadow: 'none' }} /><span style={{ fontSize: 'var(--t-meta)', color: 'rgba(255,255,255,0.55)', fontWeight: '500', flexShrink: 0 }}>{connectionState === 'online' ? 'online' : connectionState === 'offline' ? 'offline' : 'reconnecting...'}</span></>}
                </span>
            </button>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}>
              {/* THE BILL, AS A 24pt PILL, AND THE 30pt BAR IT REPLACES.
                  A bill used to own a full width band under the header reading
                  "Bill: $84.50 · 2/5 settled", stacked under a budget band
                  under a venue banner under a plan bar. The bill itself is a
                  card in the stream now (see the bill row handed to
                  MessageList), and what a header owes a reader is the state,
                  not the object: how much, and how far along. Same target as
                  the bar had, same aria-label, so the sheet is one tap from
                  here exactly as it was.

                  The figure is dropped rather than printed when the server
                  withholds it. billing.js sends null for every money field on
                  a shell whose flock has fallen under three present sharers,
                  and `null?.toFixed(2)` is undefined, which a template literal
                  prints as "$undefined". That bug shipped once on the bar this
                  pill replaces; it is not coming back through the pill. */}
              {billSplit && (
                <button
                  type="button"
                  className="hit44"
                  aria-label="Open bill split details"
                  /* The label names the action, so the figure inside would be
                     announced by nothing: ARIA gives a button presentational
                     children and aria-label wins over them. The description
                     resolves an id instead, which is not pruned, so a screen
                     reader hears the total and the tally as well as the door. */
                  aria-describedby="chat-bill-pill"
                  onClick={() => setShowChatPool(true)}
                  style={{ height: '24px', padding: '0 10px', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.18)', backgroundColor: billBar.all ? 'rgba(34,197,94,0.22)' : 'rgba(255,255,255,0.12)', color: 'white', fontSize: 'var(--t-meta)', fontWeight: '600', cursor: 'pointer', display: 'flex', alignItems: 'center', whiteSpace: 'nowrap', flexShrink: 0 }}
                >
                  <span id="chat-bill-pill">{billPillLabel}</span>
                </button>
              )}

              {/* THE RAIL AND ITS "Features" PILL STOOD HERE.
                Five controls behind a pill wide enough to push the plan's name
                into an ellipsis, on a header that already carried a back
                arrow, a title, a member count, a presence dot and an overflow
                button. Snapchat's chat header is a name and three small
                glyphs; everything else is behind the plus, and that is where
                these five went (the maintainer, 2026-09-05, looking at the shipped
                screen).

                Ask Birdie, Vote on a venue, Invite friends, Search messages
                and the cash pool are all tiles in ComposerPlusSheet now. None
                of them was dropped, and none of them moved anywhere a thumb
                has to travel further to reach: the plus is the control the
                hand is already on. */}
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

        {/* THE MOMENTUM METER STOOD HERE, and it retired to the plan screen.
            A 40pt band under the header: the word MOMENTUM, a sentence reading
            "2/4 RSVPs · Venue set · Time set", a stage label and five segment
            bars. It was one of three bands stacked between this header and the
            first message, and a meter is a thing you consult, not a thing you
            watch while you talk.

            NOTHING WAS LOST WITH IT, and that is worth saying plainly because
            "it moved to the plan page" is the kind of claim that turns out to
            be a plan rather than a fact. screens/FlockDetail.js already draws
            the same meter off the same `flock.momentum` and the same
            MOMENTUM_STAGES, and draws it BETTER: hollow outlines for the
            stages not yet reached so the boundary survives without colour, a
            role="img" label naming the stage for a screen reader, and a
            three-signal summary with check and ring glyphs instead of a
            run-on sentence. The header above is one tap from it.

            The Birdie nudge row the rebuild plan puts in this meter's place is
            a separate piece of work and is deliberately NOT here. Drawing a
            nudge with nothing behind it would ship a feature that cannot fire. */}

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

        {/* THE PLAN BAR AND THE PINNED VENUE BANNER STOOD HERE. One 36pt strip
            is what is left of the two of them.

            WHAT WENT. A full width 40pt button reading "Thu 3:59 AM · Called
            off" with a "Plan" affordance at its right, and under it a 72pt
            banner carrying a 52px photo, the venue name, a rating, the address
            and two buttons. With the momentum meter above them that was about
            180pt of chrome between a header and the first thing anybody said,
            on the screen this product exists to show.

            WHERE EVERYTHING WENT.
              The time and the status  the header's own subtitle, and the
                                       header is the button that opens the plan
                                       now. Same handler, same aria-label.
              The photo and the name   this strip, at 20 and 15 instead of 52
                                       and 17.
              Map                      the strip itself. Tapping it is the tap
                                       that used to be the Map button, pan and
                                       all. A place is what the strip is about,
                                       so opening it is what a tap on it should
                                       do.
              Change                   the strip's own menu, on a long press or
                                       on the visually hidden options button
                                       that PinStrip keeps in the DOM for
                                       everyone a long press cannot reach.
                                       Creator only, as the route behind it is.
              The rating and address   the venue's page, one tap through the
                                       strip. Neither is a live state and
                                       neither ever changed while a chat was
                                       open, so neither was earning a band.

            AND WHAT THE EMPTY STATES BECAME. "Add a Venue" for the host and
            "No venue yet, the host picks the spot" for everybody else were two
            more bands that appeared exactly when there was nothing to show.
            The strip draws nothing when there is no venue and no vote, which
            is the rule the rebuild is built on: nothing stacks between the
            header and the first message. Neither control was dropped. The
            host's picker is on the plan screen the header opens
            (screens/FlockDetail.js) and behind "Vote on a venue" in the "+"
            sheet, which lands on the vote panel's own "Browse venues on
            Discover"; and voting, which is the thing a member could actually
            do, is now the strip itself the moment a vote exists, reading
            "Vote open, 3 of 8" and opening the panel.

            NO UNPIN. A flock's venue is a column on the flock, not a pin, and
            nothing in this build clears it: the only route is the creator
            changing it to another place. PinStrip draws the menu item only
            when it is handed a handler, so the control that would fail is
            simply not there. */}
        <PinStrip
          model={pinModel}
          onOpen={openPinStrip}
          onChangePlace={pinModel && pinModel.kind === 'venue' && isCreator ? changePinnedPlace : undefined}
        />

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

        {/* THE GHOST COMMIT CARD (the "Ghost Mode Card") AND THE BILL BAR BOTH
            STOOD HERE, and they are one card in the stream now.

            They were two surfaces for one object. The ghost card ("Lock in
            your share? Pre-commit $40") appeared the moment a venue was
            confirmed and vanished the moment a bill existed; the bar under it
            ("Bill: $84.50 · 2/5 settled") appeared at exactly that moment.
            Between them they could describe the same night twice, and they
            had already done it once: a commit creates a REAL bill_splits row
            with paid_by NULL, so a member who committed saw a bar for a bill
            nobody had paid while the card that made it disappeared from under
            them.

            One card, posted where the bill was created and rewritten in place
            every time somebody settles, is what BillCard is for. The shell
            state IS the ghost state: same component, same row, "Estimated
            share $40" with Commit before a payer exists, "Bill $84.50, paid by
            Maya" after. What is left up here is a 24pt pill in the header
            carrying the state, and the sheet is still one tap behind it. */}

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
        {/* THE PINNED MESSAGES, one line under the strip. Shared pins: anyone
            in the thread can pin, up to three, and everyone sees them.

            The index is CLAMPED rather than trusted. Somebody else unpinning
            the one you were looking at is the ordinary case on a shared
            surface, and an index left pointing past the end would draw
            nothing while the bar still held its 32px. */}
        {pinnedForBar.length > 0 && (
          <PinnedMessageBar
            pins={pinnedForBar}
            activeIndex={Math.min(pinIndex, pinnedForBar.length - 1)}
            onActiveIndexChange={setPinIndex}
            onJump={(pin) => jumpToMessage(pin.id)}
            onUnpin={(pin) => unpinMessage(flock.id, pin.id)}
          />
        )}

        <MessageList
          /* The scroller itself, handed to the dock, and it is load-bearing:
             the hook measures how far this thread is from its own bottom before
             the layout changes and puts exactly that distance back after, and
             without the node it cannot, so the conversation would drop by the
             height of the keyboard on the frame the column re-lays-out.
             `registerList` is a stable callback, which is what keeps React
             from detaching this ref on every keystroke.

             `bottomInset` is deliberately NOT passed. The keyboard's height is
             spent on the column instead, for the reason written out at the
             hook call: this prop pads the inside of the scroller, and a
             scroller whose BOX still runs on behind the keyboard hides
             messages from anyone who scrolls up. */
          registerScroller={keyboard.registerList}
          /* A downward drag at the end of the thread puts the keyboard away.
             WebKit exposes no interactive dismissal to JavaScript, so the
             gesture is recognised rather than followed: the list has to be
             pinned to the bottom already and the finger has to travel more
             than 24px down. The hook reads the type off the event, so one
             function serves the whole sequence. */
          onTouch={keyboard.dismissOnDrag}
          rows={streamRows}
          threadKey={flock.id}
          myId={authUser?.id}
          ownName="You"
          ownColour={OWN_RUN_COLOUR}
          /* EVERY SENDER GETS THEIR OWN COLOUR, which is the whole point of a
             GROUP thread and was wired to nothing.

             components/chat/runColours.js exists for this: six colours, each
             measured against the chat ground in both themes, picked by a hash
             of the sender's id so the same person keeps the same colour across
             reloads and across devices. Nothing in the app imported
             runColourFor. Without a colourFor here every run that was not
             yours fell through to --chat-name-fallback, which is
             --text-secondary, so in a five-person flock all four other people
             were drawn in the same grey as every secondary word on the screen
             and the colours told you nothing.

             It answers for your own runs too, because MessageList consults
             colourFor FIRST and returns whatever it says, so one that returned
             nothing for your runs would take your own colour away rather than
             defer to ownColour. That is DmDetail's note, and it is the same
             trap here.

             A system run has a null senderId; runColourFor answers null for
             one, and MessageList's fallback covers it. Those rows draw no name
             anyway. */
          colourFor={(run) => (run.isMine ? OWN_RUN_COLOUR : runColourFor(run.senderId))}
          renderCard={renderCard}
          renderStatus={renderStatus}
          onLoadOlder={loadOlderHere}
          atTop={scrollbackExhausted}
          olderLoading={olderLoading}
          onLongPress={openMessageActions}
          /* originalRow, not the dressed row. The list rows carry a
             search-highlighted `text` full of <mark> tags and a blanked venue
             caption, and quoting either would put markup or an empty string in
             the composer's quote bar and then into the optimistic bubble. The
             photo viewer above takes the same care for the same reason. */
          onSwipeReply={(m) => setFlockReplyingTo(originalRow(m))}
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
              {/* The other way in. A swipe is faster once you know it is
                  there and completely invisible until then, so the long-press
                  sheet carries the same act. */}
              <button aria-label="Reply" className="hit44" onClick={() => { closeMessageActions(); setFlockReplyingTo(originalRow(actionsMessage)); }} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '6px', display: 'flex', alignItems: 'center', borderRadius: '10px' }} title="Reply">{Icons.reply(colors.navy, 15)}</button>
              {/* PIN, and only on a row the server has actually stored: a
                  message it has never seen has no id to pin. One control, and
                  its label says which way the tap goes, so it is never
                  ambiguous about what it is about to do. */}
              {typeof actionsMessage.id === 'number' && actionsMessage.id <= 2147483647 && (() => {
                const alreadyPinned = (flock.pins || []).some((p) => String(p.id) === String(actionsMessage.id));
                return (
                  <button
                    aria-label={alreadyPinned ? 'Unpin message' : 'Pin message'}
                    className="hit44"
                    onClick={() => {
                      closeMessageActions();
                      if (alreadyPinned) unpinMessage(flock.id, actionsMessage.id);
                      else pinMessage(flock.id, actionsMessage.id);
                    }}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '6px', display: 'flex', alignItems: 'center', borderRadius: '10px', fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', fontWeight: '600' }}
                    title={alreadyPinned ? 'Unpin' : 'Pin'}
                  >{alreadyPinned ? 'Unpin' : 'Pin'}</button>
                );
              })()}
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
        {/* THERE IS NO SEPARATE BAR HERE, and that is the point rather than an
            omission. The "Replying to" strip is ChatInputBar's own, drawn
            above the field from the `replyTo` prop below, so the composer is
            one stack. The DM screen learned this the hard way: it drew its own
            strip AND passed replyTo, so starting a reply put two identical
            quote bars on screen, one above the other. */}

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
          /* THE FIELD IS FOCUSED ON ENTRY, which is the half of decision 4
             that nothing else can do: the dock can only move a keyboard that
             something has asked for. A flock chat is a room you came here to
             say something in, and every reference app in the plan opens with
             the caret already in the box.

             It is unconditional here, and that is a decision about this
             surface rather than an oversight. This screen has no state in
             which the composer is drawn but must not be used: the flock is one
             you are a member of, the field is never disabled, and the search
             box, which is the one other field on the screen, is opened from
             the plus long after this mount. The DM thread is the surface where
             that is not true, and it answers it by drawing no composer at all
             for a blocked pair rather than by withholding this. */
          autoFocus
          /* The two nodes the dock moves. The bar is what rides the keyboard;
             the field is what it watches, because a focusout is the earliest
             honest signal that the keyboard is on its way down and waiting for
             the platform event instead leaves the bar hanging over a keyboard
             that is no longer there. */
          registerBar={keyboard.registerBar}
          registerInput={keyboard.registerInput}
          /* The quote bar. `preview` is read before `text` by the bar, and a
             quoted photo or venue card has no text at all, so the preview is
             computed here and carried over rather than letting the bar fall
             back to an empty line. Same call the stream makes for the bubble's
             own quote block, so the two agree on what a photo is called. */
          replyTo={flockReplyingTo && { ...flockReplyingTo, preview: messagePreview({ ...flockReplyingTo, hadContent: true }) }}
          onCancelReply={() => setFlockReplyingTo(null)}
          value={draft}
          onChange={(next) => {
            writeDraft(next);
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
          /* The four the header rail used to hold. Same handlers, same order
             of use, one tap further from the thumb's resting place instead of
             two taps behind a pill. */
          onCashPool={() => { setPlusOpen(false); setShowChatPool(true); }}
          onInviteFriends={() => {
            setPlusOpen(false);
            setShowFlockInviteModal(true);
            setCopiedInviteUrl('');
            setFlockInviteSelected([]);
            setFlockInviteSearch('');
          }}
          onSearchMessages={() => { setPlusOpen(false); setShowChatSearch(!showChatSearch); }}
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
                      /* startSettleUp, declared once above and called by the
                          bill card in the stream as well, so the two copies of
                          this bill cannot behave differently.

                          ONE pay surface, whatever the payee saved. This used
                          to branch three ways and two of them were wrong. With
                          exactly one handle it launched the wallet with
                          nothing on screen naming who or where. With none it
                          called settleShare on the spot, so tapping "Settle
                          Up" recorded the debt as PAID without anybody having
                          paid anything, which is the same class of bug as
                          auto-settling on a handoff (see startPaymentHandoff).
                          Marking it paid is still one tap away, on the button
                          directly below this one, where the payer chooses it
                          deliberately. */
                      <button className="hit44 glass-btn glass-primary" onClick={startSettleUp} style={{ ...styles.gradientButton, padding: '14px', marginBottom: '8px' }}>
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
                      <button className="hit44 glass-btn glass-secondary" onClick={undoMySettle} style={{ width: '100%', padding: '10px', border: 'none', backgroundColor: 'transparent', color: 'var(--text-tertiary)', fontSize: 'var(--t-meta)', fontWeight: '600', cursor: 'pointer' }}>
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
          // The hoisted list, so the sheet and the poll card count the same
          // rows. It was declared here when this sheet was the only surface.
          const flockVotes = flockVotesAll;
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
                ) : votesLoading ? (
                  /* NOT AN EMPTY STATE UNTIL THE DATA ARRIVES. Between opening
                     a flock and its tally landing, this rendered "No votes yet.
                     Be the first to suggest a venue!" over votes that already
                     existed — a claim about the user's data made before the
                     data was known, which is what ListSkeleton's header in
                     App.js forbids. */
                  <div style={{ padding: '20px', textAlign: 'center', backgroundColor: 'var(--bg-tertiary)', borderRadius: '14px', marginBottom: '16px' }} aria-busy="true">
                    <p style={{ fontSize: 'var(--t-label)', color: 'var(--text-tertiary)', margin: 0, fontWeight: '500' }}>Loading the votes…</p>
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
