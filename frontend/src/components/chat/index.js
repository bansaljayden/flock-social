/**
 * The chat module's one door.
 *
 * `screens/ChatDetail.js` and `screens/DmDetail.js` import from here and from
 * nowhere else inside `components/chat/`, so the module's surface is this file
 * and the integration pass has one line to write per screen.
 *
 * WHAT IS IN HERE, and what is deliberately not. The stream: the scroller, a
 * run, a row, the day divider, the status line, the presence and typing strip,
 * and the pure grouping function underneath them. Not the composer, not the
 * keyboard docking, not the long-press menu, not the cards. Those are other
 * workstreams, and a row draws a card only by calling the `renderCard` the
 * parent handed it.
 *
 * EVERY COMPONENT IS PRESENTATIONAL. No API call, no context read, no global
 * state, no socket. State stays in the app shell, exactly as it does for the
 * two screens these replace, and colours arrive as props because a member's
 * colour is a fact about a flock and not about a stylesheet.
 */
export { default as MessageList } from './MessageList';
export { default as MessageGroup } from './MessageGroup';
export { default as MessageRow } from './MessageRow';
export { default as DayDivider } from './DayDivider';
export { default as StatusLine } from './StatusLine';
export { default as TypingRow } from './TypingRow';

export {
  groupRows,
  dayKeyOf,
  dayLabelOf,
  isSystemRow,
} from './groupRows';

export {
  groupReactions,
  imageOf,
  aspectOf,
  LONG_PRESS_MS,
  SWIPE_THRESHOLD,
} from './MessageRow';

export { nameList } from './StatusLine';
export { typingSentence, presenceSentence } from './TypingRow';

/* No default export on purpose. Six components come out of here and none of
   them is the obvious "the" one, so naming them at the import site is the
   difference between reading a screen's header and guessing at it. */

/* THE REST OF THE MODULE.
   Four workstreams wrote this folder in parallel and each appended to this one
   file, so only the first group's exports survived: the input bar, every card
   and every sheet were unreachable from outside. The integration pass imports
   from here and nowhere else, so anything the screens need has a line below.
   Helpers come with their component rather than in a bag of their own, because
   the component is the thing a reader is looking for. */

export { default as ChatInputBar } from './ChatInputBar';

export { default as BillCard, billTally } from './cards/BillCard';
export { default as PollCard } from './cards/PollCard';
export { default as VenueCardRow } from './cards/VenueCardRow';
export { default as LocationCard, remainingLabel, distanceLabel } from './cards/LocationCard';
export { default as WhoIsHereCard } from './cards/WhoIsHereCard';
export { default as SystemRow, formatMoney, CardShell, MemberAvatar } from './cards/SystemRow';
export { default as NudgeRow } from './cards/NudgeRow';

export { default as FlockProfileSheet, useSheetDialog, ChatSheet } from './sheets/FlockProfileSheet';
export { default as ComposerPlusSheet } from './sheets/ComposerPlusSheet';
export { default as PinStrip } from './sheets/PinStrip';
export { default as PinnedMessageBar } from './sheets/PinnedMessageBar';
