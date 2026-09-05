/**
 * FLOCK REPLY, the client half (migration 066).
 *
 * The affordances for this shipped long before the feature did. MessageRow has
 * reported a right swipe and ChatInputBar has drawn a quote bar since the chat
 * module was built, and on the flock surface both were deliberately connected
 * to nothing, because `messages` had no reply column: a swipe would have
 * opened a quote bar over a send path that dropped it, so the sender saw
 * "Replying to" and the recipient got a loose message.
 *
 * App.js carried a note naming the three things a real fix needs together: the
 * migration, both transports, and the quote render. This file pins the third,
 * and the two places where wiring it wrongly is silent rather than loud.
 *
 * Source pins are anchored on searchable strings, never on line numbers in a
 * 21,000-line file. Every read normalises CRLF: the pre-commit hook stashes
 * and restores, which leaves CRLF working copies on Windows.
 */

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(SRC, ...p), 'utf8').replace(/\r\n/g, '\n');

const appSrc = read('App.js');
const chatDetailSrc = read('screens', 'ChatDetail.js');
const socketSrc = read('services', 'socket.js');
const apiSrc = read('services', 'api.js');

/** The body of a named function/const, for pinning one site rather than a file. */
function slice(src, anchor, chars = 3000) {
  const at = src.indexOf(anchor);
  expect(at).toBeGreaterThan(-1);
  return src.slice(at, at + chars);
}

describe('both transports carry the quote', () => {
  test('socket sendMessage emits reply_to_id', () => {
    const body = slice(socketSrc, 'export function sendMessage(flockId, messageText', 900);
    expect(body).toMatch(/reply_to_id: opts\.reply_to_id \|\| null,/);
  });

  test('the REST fallback sends it too, so a reply survives a dead socket', () => {
    // The whole point of the fallback is that the SAME message goes out. A
    // reply that silently became a loose message on the weak signal that put
    // it on this transport is the drift this file's backend twin exists for.
    //
    // TWO HALVES, AND THIS TEST ONLY CHECKED ONE. It asserted the body builder
    // in api.js and passed while App.js's CALL SITE was still not passing the
    // field, so the option was read from an object nobody put it on and every
    // reply sent on the fallback arrived as a loose message. The backend's
    // transport-parity suite caught it, deriving the field list from the
    // function rather than from a list somebody maintained. Both halves now.
    const body = slice(apiSrc, 'export async function sendMessage(flockId, text', 1400);
    expect(body).toMatch(/reply_to_id: opts\.reply_to_id \|\| undefined,/);
    expect(appSrc).toMatch(/apiSendMessage\(flockId, text, \{[^}]*reply_to_id: replyToId \|\| undefined \}\)/);
  });
});

describe('the row mapper', () => {
  test('mapFlockRow flattens the quote to the names mapDmRow uses', () => {
    const body = slice(appSrc, 'const mapFlockRow = (m, myId)', 2600);
    expect(body).toMatch(/reply_to: m\.reply_to/);
    expect(body).toMatch(/text: m\.reply_to\.message_text/);
    expect(body).toMatch(/sender: m\.reply_to\.sender_name/);
    // Without message_type a quoted photo or venue card has nothing to show,
    // and the quote block renders empty rather than saying "Photo".
    expect(body).toMatch(/message_type: m\.reply_to\.message_type \|\| 'text'/);
  });
});

describe('the send path', () => {
  test('the optimistic bubble draws the quote before any echo arrives', () => {
    const body = slice(appSrc, 'const transmitFlockMessage = useCallback', 2600);
    expect(body).toMatch(/const replyToId = opts\.reply_to_id \|\| null;/);
    // The bubble is rendered from this, immediately, before anything is sent.
    // Without it a reply shows as a loose message until the echo lands, which
    // on a slow connection is exactly when the thread is hardest to follow.
    expect(body).toMatch(/reply_to: replyQuote,/);
  });

  test('the socket send carries the id the bubble was drawn from', () => {
    // Pinned on the emit itself rather than inside the enclosing function:
    // the send sits far enough below the head of transmitFlockMessage that a
    // fixed-size slice from there is a window that moves whenever a comment
    // above it grows.
    expect(appSrc).toMatch(/socketSendMessage\(flockId, text, \{[^}]*reply_to_id: replyToId \}\)/);
  });

  test('a failed reply remembers what it was quoting, so a retry resends it', () => {
    // Both persistFailedFlockMessage calls, the socket-timeout one and the
    // REST-catch one. A retry that dropped the quote would resend the reply as
    // a loose message, which is where an answer stops making sense in a busy
    // thread.
    const persisted = appSrc.match(/persistFailedFlockMessage\(flockId, \{[^}]*reply_to: replyQuote/g) || [];
    expect(persisted).toHaveLength(2);
    expect(slice(appSrc, 'const retryFailedMessage = useCallback', 1200))
      .toMatch(/reply_to_id: failedMsg\.reply_to\?\.id \|\| null/);
  });

  test('sending clears the quote bar, and reads it before clearing', () => {
    const body = slice(appSrc, 'const sendChatMessage = useCallback', 2200);
    // Read first, then cleared, then sent. The other order sends nothing.
    const readAt = body.indexOf('const quoting = flockReplyingTo;');
    const clearAt = body.indexOf('setFlockReplyingTo(null);');
    const sendAt = body.indexOf('transmitFlockMessage(selectedFlockId, text, quoting');
    expect(readAt).toBeGreaterThan(-1);
    expect(clearAt).toBeGreaterThan(readAt);
    expect(sendAt).toBeGreaterThan(clearAt);
    expect(body).toMatch(/flockReplyingTo\]\);/); // and it is in the dep list
  });
});

describe('a quote must not outlive the message it quotes', () => {
  test('a takedown strips the quote from every reply to the removed message', () => {
    const body = slice(appSrc, 'const applyTakedownToFlocks =', 2600);
    expect(body).toMatch(/const quoting = msgs\.some\(\(m\) => m\.reply_to && sameContentId\(m\.reply_to\.id, contentId\)\)/);
    expect(body).toMatch(/\{ \.\.\.m, reply_to: null \}/);
    // The early return has to account for the quote too, or a takedown of a
    // message that is no longer in the page leaves its words in every reply.
    expect(body).toMatch(/if \(kept\.length === msgs\.length && !quoting\) return f;/);
  });

  test('a takedown also closes the composer if it was quoting that message', () => {
    // This branch was an EMPTY BLOCK left behind when the dead affordance was
    // removed. An empty `if` is invisible in review and this is what it costs:
    // the removed words sit under "Replying to" until the screen is left.
    expect(appSrc).toMatch(
      /if \(ev\.contentType === 'flock_message'\) \{\s*\n\s*setFlockReplyingTo\(\(cur\) => \(cur && sameContentId\(cur\.id, ev\.contentId\) \? null : cur\)\);/
    );
  });
});

describe('the screen', () => {
  test('both ways into a reply exist: the swipe and the long-press sheet', () => {
    expect(chatDetailSrc).toMatch(/onSwipeReply=\{\(m\) => setFlockReplyingTo\(originalRow\(m\)\)\}/);
    expect(chatDetailSrc).toMatch(/aria-label="Reply"[^\n]*setFlockReplyingTo\(originalRow\(actionsMessage\)\)/);
  });

  test('BOTH quote the original row, never the dressed one', () => {
    /* THE SILENT BUG THIS PINS. The rows handed to MessageList are dressed:
       a search wraps matches in <mark> tags and a venue card's caption is
       blanked. Quoting a dressed row would put literal markup into the quote
       bar and then into the stored reply, or quote an empty string for a
       venue card. `originalRow` maps back to the undressed row by id, which
       is why the photo viewer on the same component already uses it.

       Asserted as an absence as well as a presence: a future edit that drops
       originalRow from either call site is exactly the regression. */
    expect(chatDetailSrc).not.toMatch(/onSwipeReply=\{setFlockReplyingTo\}/);
    expect(chatDetailSrc).not.toMatch(/setFlockReplyingTo\(m\)\}/);
    expect(chatDetailSrc).not.toMatch(/setFlockReplyingTo\(actionsMessage\)/);
  });

  test('the composer draws ONE quote bar, the input bar\'s own', () => {
    // The DM screen shipped two identical bars for a while by drawing its own
    // strip and also passing replyTo. This surface only passes the prop.
    expect(chatDetailSrc).toMatch(/replyTo=\{flockReplyingTo && \{ \.\.\.flockReplyingTo, preview: messagePreview\(/);
    expect(chatDetailSrc).toMatch(/onCancelReply=\{\(\) => setFlockReplyingTo\(null\)\}/);
    expect(chatDetailSrc).not.toMatch(/Replying to \{/);
  });

  test('a quoted photo is previewed, not shown as an empty line', () => {
    // hadContent is what makes messagePreview say "Photo" for a row with an
    // image and no text, instead of falling through to the empty wording.
    expect(chatDetailSrc).toMatch(/reply_to: \{ \.\.\.m\.reply_to, text: messagePreview\(\{ \.\.\.m\.reply_to, hadContent: true \}\) \}/);
    // And the dressing pass has to run at all when a reply is on screen.
    expect(chatDetailSrc).toMatch(/\|\| visibleMessages\.some\(\(m\) => m\.reply_to\);/);
  });

  test('the header note no longer claims replies are unwired', () => {
    expect(chatDetailSrc).not.toMatch(/REPLIES ARE STILL NOT WIRED/);
    expect(chatDetailSrc).toMatch(/REPLIES ARE WIRED, as of migration 066/);
  });
});
