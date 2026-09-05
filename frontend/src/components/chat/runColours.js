/**
 * WHO IS SPEAKING, IN COLOUR.
 *
 * In the chat we are copying, every person in a group thread has a colour of
 * their own: their name is drawn in it and the vertical bar down the left of
 * their run is the same colour. It is the single strongest signal in the whole
 * stream. You do not read the names in a busy group, you read the colours, and
 * a run belongs to somebody before you have processed a word of it.
 *
 * WHY THIS FILE HAD TO EXIST. `MessageList` has always taken a `colours` prop
 * and a `colourFor` override, and its `colourOf` falls back to
 * `--chat-name-fallback`, which resolves to `--text-secondary`. Neither chat
 * screen passed either prop, so every run that was not yours took the
 * fallback: in a six person flock the other five people were rendered in one
 * identical grey, and in a DM the other person was grey too. The measured
 * palette from the capture was written into the plan document and never into
 * the code, so there was nothing for a screen to pass even if somebody had
 * remembered to pass it.
 *
 * THE SIX ARE MEASURED, not chosen. They come off the reference capture and
 * are recorded in CHAT-REBUILD-PLAN.md under "Colours". Do not re-pick them to
 * taste: they are far apart in hue on purpose, so that two people in the same
 * thread are never nearly the same colour.
 *
 * WHAT THEY ARE NOT is readable on both grounds as measured, and an earlier
 * version of this file claimed they were. They came off a capture of a
 * near-black chat; against this app's #f1ede0 light theme six of the seven
 * measure under 2.4:1 as text. Each hue therefore has two values, held in
 * chat.css and reached through the tokens below, and the numbers and the
 * reasoning are written out there rather than here.
 *
 * ASSIGNMENT IS STABLE, AND THAT IS THE WHOLE POINT. A colour that follows a
 * person around is a signal; a colour that changes between sessions, or when
 * somebody joins, is noise wearing a signal's clothes. So the index comes from
 * the sender's own id and nothing else: not from their position in the member
 * list, which changes as people join and leave, and not from the order they
 * happen to have spoken in, which changes on every scrollback page. The same
 * person is the same colour in the same thread forever, and on every device.
 *
 * TWO PEOPLE CAN COLLIDE, and that is accepted. Six colours cannot separate a
 * flock of eight. When two ids land on the same colour the names still differ
 * and the names are always drawn, so the worst case degrades to what the app
 * did before this file, for those two people only.
 */

/* TOKENS, NOT LITERALS, and that is the whole of the accessibility story.
   The measured hexes live in components/chat/chat.css, once for the light
   ground and once for the dark, because the run colour is drawn as TEXT: it is
   the sender's name at 11.5px uppercase. The values measured off the reference
   capture are correct on that capture's near-black ground and land between
   1.50:1 and 2.32:1 on this app's #f1ede0, so shipping them raw made the name
   label harder to read than the grey it replaced. The CSS carries the reasoning
   and the numbers. */
export const RUN_COLOURS = [
  'var(--chat-run-1)',
  'var(--chat-run-2)',
  'var(--chat-run-3)',
  'var(--chat-run-4)',
  'var(--chat-run-5)',
  'var(--chat-run-6)',
];

/* The other person in a one to one thread. Not from the palette above: a DM
   has exactly two people in it, so there is nothing to tell apart, and the
   capture uses one fixed blue for whoever you are talking to. Your own runs
   keep your own colour, which the screen passes as ownColour. */
export const DM_FRIEND_COLOUR = 'var(--chat-run-friend)';

/**
 * A stable index for an id, by summing its characters.
 *
 * Ids here are SERIAL integers today, so a plain modulo would do, and this
 * still handles them identically. It reads every character because the same id
 * reaches the client as a number from a REST payload and as a string from a
 * socket, the app has been bitten by that difference before, and because
 * nothing in this file should have to change on the day an id stops being a
 * small integer.
 */
export const runColourFor = (senderId) => {
  if (senderId == null) return null;
  const s = String(senderId);
  let sum = 0;
  for (let i = 0; i < s.length; i += 1) sum += s.charCodeAt(i);
  return RUN_COLOURS[sum % RUN_COLOURS.length];
};

export default runColourFor;
