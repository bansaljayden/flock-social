/**
 * DM and flock chat, client side.
 *
 * WHAT THIS COVERS, and why each one is pinned rather than trusted
 *
 *   1. The flock unread dot. It used to be
 *        f.messages.some(m => m.sender !== 'You' && !m.read)
 *      and nothing in this app has ever written `read` on a flock message, so
 *      that predicate was true for every message anybody else had ever sent.
 *      Flocks arrive from GET /api/flocks with `messages: []` and the history
 *      is fetched per chat on entry, so the dot could only appear AFTER you
 *      read a flock, and then never cleared. This pins the replacement and
 *      pins that the phantom `read` field has not come back.
 *
 *   2. Scrollback. Both message routes have taken a `before` message-id cursor
 *      for rounds, fully ordered on the cursor column, and no client ever sent
 *      one, so every conversation was the newest 50 rows with no way past
 *      them. This pins that both readers send the cursor and that the paging
 *      helpers tile correctly.
 *
 *   3. The read receipt. PUT /api/dm/:messageId/read existed with zero callers,
 *      which is why a DM that arrived while its thread was OPEN stayed unread
 *      in the database: the only thing marking DMs read is a side effect of
 *      FETCHING history, so it can only cover what was there when the screen
 *      opened. The badge came back on the next reload for a message the user
 *      had watched land.
 *
 *   4. Two claims a chat screen must not make: an empty state during a fetch,
 *      and a "no messages" line for a flock whose history has not been read.
 *
 *   5. Horizontal overflow. A message with nowhere to break used to widen the
 *      bubble past the phone (SLOP-AUDIT H19).
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test --watchAll=false
 */

const fs = require('fs');
const path = require('path');

const appPath = path.join(__dirname, '..', 'App.js');
const apiPath = path.join(__dirname, '..', 'services', 'api.js');
// The flock chat screen left App.js on 2026-08-26 and the one-to-one DM thread
// left on 2026-08-27: they live in screens/ChatDetail.js and screens/DmDetail.js
// now, and the message lists, the composers, the reaction rows and the report
// entries went with them. Nothing asserted below changed. The app source is
// simply in three files, so all three are read, in the order they used to be
// one.
const appSource = fs.readFileSync(appPath, 'utf8')
  + fs.readFileSync(path.join(__dirname, '..', 'screens', 'ChatDetail.js'), 'utf8')
  + fs.readFileSync(path.join(__dirname, '..', 'screens', 'DmDetail.js'), 'utf8');
const apiSource = fs.readFileSync(apiPath, 'utf8');

// Same extractor as contentTakedownWiring.test.js: lift a module-scope `const`
// out of App.js and evaluate it, so a pure helper can be exercised without
// mounting a 23k-line component that pulls in maplibre and a QR scanner.
function extractDeclaration(source, name) {
  const start = source.search(new RegExp(`^const ${name} = `, 'm'));
  if (start === -1) throw new Error(`extractDeclaration: no module-scope \`const ${name} =\` in source`);
  let i = source.indexOf('=', start) + 1;
  let depth = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === '/' && next === '/') {
      i = source.indexOf('\n', i);
      if (i === -1) break;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? source.length : end + 2;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      i += 1;
      while (i < source.length) {
        if (source[i] === '\\') { i += 2; continue; }
        if (source[i] === quote) { i += 1; break; }
        i += 1;
      }
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    else if (ch === ';' && depth === 0) return source.slice(start, i + 1);
    i += 1;
  }
  throw new Error(`extractDeclaration: unterminated declaration for ${name}`);
}

const HELPER_NAMES = [
  'SERVER_ID_MAX',
  'isServerId',
  'newestFromOthers',
  'oldestServerId',
  'prependOlder',
  'conversationStamp',
  'DM_PAGE_SIZE',
  'NOT_CONNECTED_HINT',
];

const helpers = (() => {
  const chunk = HELPER_NAMES.map((n) => extractDeclaration(appSource, n)).join('\n');
  // eslint-disable-next-line no-new-func
  return new Function(`${chunk}\nreturn { ${HELPER_NAMES.join(', ')} };`)();
})();

const {
  newestFromOthers,
  oldestServerId,
  prependOlder,
  conversationStamp,
  DM_PAGE_SIZE,
  NOT_CONNECTED_HINT,
} = helpers;

describe('flock chat unread', () => {
  test('the phantom `read` field is gone from the unread predicate', () => {
    // The exact expression that shipped. If it comes back, so does a dot that
    // lights when you read a flock and never goes out.
    expect(appSource).not.toMatch(/m\.sender !== 'You' && !m\.read/);
    // And nothing else writes or reads a `read` flag on a chat message either,
    // which is what made the predicate a constant.
    expect(appSource).not.toMatch(/\bread: (true|false)\b/);
  });

  test('the badge is server truth, and the caught-up cursor writes through to it', () => {
    // Migration 056 answered the handoff the flockSeen comment always
    // carried: the badge is unread_count from the list (so it survives a
    // reload), the socket handler increments it live, opening the chat
    // zeroes it, and the same caught-up signal that writes flockSeen now
    // PUTs the server cursor, monotonic server-side so a stale mark can
    // never move it backwards. flockSeen stays as the PUT watermark.
    expect(appSource).toMatch(/const \[flockSeen, setFlockSeen\] = useState/);
    expect(appSource).toMatch(/flock_chat_seen/);
    expect(appSource).toMatch(/unread: Number\(f\.unread_count\) \|\| 0/);
    expect(appSource).toMatch(/const hasUnread = \(f\.unread \|\| 0\) > 0;/);
    // The failed PUT releases its key. It used to be stamped before the
    // request and never reset, so one failure (and the moment this fails is a
    // flaky connection, which is the moment you are most likely to be opening a
    // chat) left the server cursor where it was for the session: the badge came
    // back on the next flocks read, the app icon kept counting the same
    // messages, and reopening the same chat did not retry.
    expect(appSource).toMatch(/markFlockRead\(selectedFlockId, newest\)\.catch\(\(\) => \{\s*if \(readPutRef\.current === key\) readPutRef\.current = '';\s*\}\)/);
    expect(appSource).toMatch(/unread: chatOpen \? \(f\.unread \|\| 0\) : \(f\.unread \|\| 0\) \+ 1/);
  });

  test('newestFromOthers separates "nothing new" from "nothing known"', () => {
    // No history fetched yet. This MUST be null, not 0: a flock whose messages
    // have never been read must draw no dot rather than a guess.
    expect(newestFromOthers([])).toBeNull();
    // Only your own messages is also "nothing to be told about".
    expect(newestFromOthers([{ id: 5, sender: 'You' }])).toBeNull();
    // Optimistic bubbles carry temp string ids and can never be a cursor.
    expect(newestFromOthers([{ id: 'temp-abc', sender: 'Mia' }])).toBeNull();
    expect(newestFromOthers([
      { id: 4, sender: 'Mia' },
      { id: 9, sender: 'You' },
      { id: 7, sender: 'Ben' },
    ])).toBe(7);
  });

  test('a flock with no fetched history does not claim it has no messages', () => {
    expect(appSource).not.toMatch(/'No messages yet'/);
  });
});

describe('scrollback', () => {
  test('both message readers send the before cursor the routes have always taken', () => {
    expect(apiSource).toMatch(/export async function getDMs\(userId, \{ before \} = \{\}\)/);
    expect(apiSource).toMatch(/export async function getMessages\(flockId, \{ before \} = \{\}\)/);
    expect(apiSource).toMatch(/\?before=\$\{encodeURIComponent\(before\)\}/);
  });

  test('both threads offer the control and both loaders exist', () => {
    expect(appSource).toMatch(/const loadOlderDms = useCallback/);
    expect(appSource).toMatch(/const loadOlderFlockMessages = useCallback/);
    expect(appSource.match(/\{olderLoading \? 'Loading' : 'Load earlier messages'\}/g)).toHaveLength(2);
  });

  test('oldestServerId ignores bubbles the server never gave an id to', () => {
    expect(oldestServerId([])).toBeNull();
    expect(oldestServerId([{ id: 'temp-1' }, { id: 'temp-2' }])).toBeNull();
    expect(oldestServerId([{ id: 40 }, { id: 12 }, { id: 'temp-3' }])).toBe(12);
  });

  test('prependOlder tiles without duplicating and keeps identity when it adds nothing', () => {
    const current = [{ id: 10 }, { id: 11 }];
    const merged = prependOlder(current, [{ id: 8 }, { id: 9 }]);
    expect(merged.map((m) => m.id)).toEqual([8, 9, 10, 11]);
    // A row that arrived between the two reads belongs where it already is.
    expect(prependOlder(current, [{ id: 10 }])).toBe(current);
    // Same object back means the screen does not re-render and, more
    // importantly, that the caller can tell the top has been reached.
    expect(prependOlder(current, [])).toBe(current);
  });

  test('a full page is the only thing that offers more behind it', () => {
    // The page size the control is gated on has to be the routes' default, or
    // the button either never appears or never retires.
    expect(DM_PAGE_SIZE).toBe(50);
  });

  test('auto-scroll follows the tail, not the length', () => {
    // Loading older messages grows the list at the TOP. A length check read
    // that as new traffic and threw the reader back down to the newest
    // message the instant they asked for scrollback.
    expect(appSource).toMatch(/const chatTailRef = useRef\(null\)/);
    expect(appSource).toMatch(/const dmTailRef = useRef\(null\)/);
    expect(appSource).not.toMatch(/chatMsgCountRef|dmMsgCountRef/);
  });
});

describe('DM read state', () => {
  test('the read route finally has a caller', () => {
    expect(apiSource).toMatch(/export async function markDmRead\(messageId\)/);
    expect(apiSource).toMatch(/\/api\/dm\/\$\{messageId\}\/read/);
    expect(appSource).toMatch(/markDmRead\(msg\.id\)\.catch/);
  });

  test('a DM landing in the open thread is not counted unread', () => {
    expect(appSource).toMatch(/unread: \(isYou \|\| threadOpen\) \? d\.unread : d\.unread \+ 1/);
    // Read off the ref every render writes, not closed over: this effect is
    // keyed on authUser and a captured selectedDmId would be stale all session.
    expect(appSource).toMatch(/const target = catchUpTargetRef\.current \|\| \{\};/);
  });
});

describe('claims a chat screen must not make', () => {
  test('neither thread renders an empty state while its history is on the wire', () => {
    expect(appSource).toMatch(/const \[dmMessagesLoading, setDmMessagesLoading\] = useState\(false\)/);
    expect(appSource).toMatch(/\{dmMessagesLoading && selectedDm\.messages\.length === 0 \? \(/);
    expect(appSource).toMatch(/!messagesLoading && flock\.messages\.length === 0/);
  });

  test('both threads draw a skeleton rather than a blank rectangle', () => {
    expect(appSource).toMatch(/const ChatSkeleton = /);
    expect(appSource.match(/<ChatSkeleton /g)).toHaveLength(2);
  });

  test('a send in flight says so', () => {
    // `pending` has been set on every optimistic bubble since the echo work
    // landed and nothing rendered it, so a message looked delivered for the
    // whole eight seconds before its timer could call it failed.
    expect(appSource).toMatch(/m\.pending \? 'Sending' : getRelativeTime\(m\.time\)/);
    expect(appSource).toMatch(/m\.pending \? 'Sending' : \(m\.time \|\| getRelativeTime\(m\.time\)\)/);
    expect(appSource.match(/opacity: m\.pending \? 0\.6 : 1/g)).toHaveLength(2);
  });
});

describe('the refusal a new user actually hits', () => {
  test('"not connected" is a standing explanation, not a two second toast', () => {
    // The New Message sheet searches every account by name, so the ordinary
    // way to start a DM finds strangers and the first send is refused.
    expect(NOT_CONNECTED_HINT.test("You can only do that with people you're connected with.")).toBe(true);
    expect(NOT_CONNECTED_HINT.test('Message is required')).toBe(false);
    expect(appSource).toMatch(/const \[dmNotConnected, setDmNotConnected\] = useState\(\{\}\)/);
    expect(appSource).toMatch(/You are not connected to \{selectedDm\.name\} yet/);
    expect(appSource).toMatch(/Send a friend request/);
  });

  test('the refusal wording still matches what the server sends', () => {
    // If backend/utils/relationships.js is reworded, this goes red here rather
    // than silently degrading to the old toast in front of a user.
    const relationships = fs.readFileSync(
      path.join(__dirname, '..', '..', '..', 'backend', 'utils', 'relationships.js'),
      'utf8'
    );
    const match = /const NOT_CONNECTED_MESSAGE = "([^"]+)"/.exec(relationships);
    expect(match).not.toBeNull();
    expect(NOT_CONNECTED_HINT.test(match[1])).toBe(true);
  });
});

describe('a block landing mid-thread', () => {
  test('the blocked flag the route already sends is read', () => {
    // GET /api/dm/:userId answers a blocked pair with
    // `{ messages: [], blocked: true }`. Reading only the empty array turned a
    // conversation with months of history into the brand-new-chat empty state,
    // under "Say hi to start the conversation", with a live composer.
    expect(appSource).toMatch(/if \(data\.blocked\) \{/);
    expect(appSource).toMatch(/const \[dmBlocked, setDmBlocked\] = useState\(\{\}\)/);
    expect(appSource).toMatch(/You can no longer message \{selectedDm\.name\}/);
    expect(appSource).toMatch(/These messages are not available\./);
  });

  test('the composer is removed rather than left live', () => {
    expect(appSource).toMatch(/\{!dmBlocked\[String\(selectedDmId\)\] && \(\s*<div style=\{\{ padding: '10px 12px calc\(10px \+ var\(--safe-bottom\)\)'/);
  });

  test('the live blocked_by event closes the thread too', () => {
    // Without this the thread stayed open and typeable until the screen was
    // left and re-entered, and every send was refused with a two second toast.
    expect(appSource).toMatch(/return onBlockedBy\(\(\{ userId \}\) => \{[\s\S]*?setDmBlocked/);
  });
});

describe('layout', () => {
  test('a message with nowhere to break wraps instead of widening the phone', () => {
    expect(appSource.match(/overflowWrap: 'anywhere'/g).length).toBeGreaterThanOrEqual(3);
    // Both message scrollers refuse a horizontal axis outright.
    expect(appSource.match(/overflowY: 'auto', overflowX: 'hidden'/g)).toHaveLength(2);
  });

  test('a conversation row does not date-stamp something that arrived a minute ago', () => {
    // The DM row printed toLocaleDateString unconditionally, so a message that
    // landed a minute ago read "Aug 25" while the flock row beside it read
    // "3:45 PM" for the same instant.
    // THE CLOCK IS PINNED HERE, and it has to be.
    //
    // conversationStamp calls its own new Date() to find today's midnight, and
    // this test called new Date() again to build the input. Two independent
    // reads of the wall clock: a run that crosses local midnight between them
    // gets 'Yesterday' back where it expects a time string, and the suite fails
    // on the hour it ran rather than on the code. That is once a night, not
    // never, and it fails nowhere a developer can reproduce it.
    //
    // Measured, not reasoned about: at 23:59:59.900 and 00:00:00.100, two reads
    // 200ms apart, the test expects "11:59 PM" and conversationStamp answers
    // "Yesterday".
    //
    // The 'Yesterday' line was ALSO suspected of a DST problem, because
    // new Date(y, m, d) is LOCAL midnight and the zones whose transition lands
    // there (America/Santiago, America/Havana, Asia/Beirut, Australia/Lord_Howe)
    // have no such instant on the transition date. That one did NOT reproduce:
    // this file passes under all four today. It is not the reason for the pin
    // and is recorded only so the next person does not re-derive it.
    //
    // Mid-June at local noon is twelve hours from either midnight, which is the
    // whole requirement.
    jest.useFakeTimers();
    try {
      jest.setSystemTime(new Date(2026, 5, 17, 12, 0, 0));

      const now = new Date();
      const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const today = conversationStamp(now);
      expect(today).toBe(now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }));

      // One hour before today's midnight is the previous calendar day, always.
      expect(conversationStamp(new Date(midnight.getTime() - 60 * 60 * 1000))).toBe('Yesterday');

      const older = new Date(midnight.getTime() - 20 * 24 * 60 * 60 * 1000);
      expect(conversationStamp(older)).toBe(
        older.toLocaleDateString([], { month: 'short', day: 'numeric' })
      );

      expect(conversationStamp(null)).toBe('');
      expect(conversationStamp('not a date')).toBe('');
    } finally {
      jest.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// The send path itself.
//
// Measured 2026-08-26 by hand-mutating App.js one defect at a time and running
// all 1,666 assertions: making the socket's return value stop picking the
// transport, never marking a lost echo failed, swallowing a refused send,
// letting an empty composer send, and adopting any id the reply carried ALL
// stayed green. That is the most-used control in the product with no test
// under it at all.
//
// These are source pins, and pins are worth less than the executed helpers
// above: transmitFlockMessage is a useCallback closed over eight refs inside a
// 20,000-line component, so it cannot be lifted out the way isServerId and
// prependOlder were, and reaching it for real means rendering the whole app.
// A pin cannot prove the property. It can refuse the specific edit that
// removes it, which is what each one below was verified to do.
// ---------------------------------------------------------------------------
describe('a message that leaves the composer arrives, fails, or says which', () => {
  const transmit = (() => {
    const start = appSource.indexOf('const transmitFlockMessage');
    expect(start).toBeGreaterThan(-1);
    const end = appSource.indexOf('const retryFailedMessage', start);
    expect(end).toBeGreaterThan(start);
    return appSource.slice(start, end);
  })();

  test('the socket EMIT decides the transport, not the connected flag beside it', () => {
    // `connected` and the emit are two reads of the same socket a moment
    // apart. A drop in between answers false from the emit while `connected`
    // still says true, and nothing reached the wire. Gating on the flag alone
    // loses that message silently; gating on the emit's return value is what
    // lets the HTTP branch pick it up without ever double-posting, because a
    // true return means the write already happened.
    expect(transmit).toMatch(
      /const sentOverSocket = !!sock\?\.connected\s*\r?\n\s*&& socketSendMessage\(/
    );
  });

  test('an echo that never arrives turns the bubble failed, on a timer a person will wait out', () => {
    expect(transmit).toMatch(/pendingEchoRef\.current\.delete\(tempId\);/);
    expect(transmit).toMatch(/\{ \.\.\.m, pending: false, failed: true \}/);
    // Eight seconds. Long enough not to fire on a slow echo, short enough that
    // the retry is still the same thought. A number large enough to outlive
    // the session is the same defect as no timer at all.
    // Text stays on the short timer; a photo gets a longer leash, because a
    // 700KB image on venue wifi can still be honestly uploading at 8s and
    // failing it mid-flight is how a retry tap makes duplicates. The
    // late-echo reclaim self-heals either way.
    const [, imgMs, txtMs] = transmit.match(/\}, image \? (\d+) : (\d+)\);/) || [];
    expect(Number(txtMs)).toBeGreaterThan(2000);
    expect(Number(txtMs)).toBeLessThanOrEqual(15000);
    expect(Number(imgMs)).toBeGreaterThan(Number(txtMs));
    expect(Number(imgMs)).toBeLessThanOrEqual(60000);
  });

  test('the HTTP branch says out loud that a send was refused', () => {
    // Moderation refusals and network errors both land here. Silence is what
    // made a rejected photo look like it had gone through.
    const httpCatch = transmit.slice(transmit.indexOf('} catch (err) {'));
    expect(httpCatch).toMatch(/showToast\(err\?\.message \|\|/);
    expect(httpCatch).toMatch(/\{ \.\.\.m, pending: false, failed: true \}/);
  });

  test('a temp bubble only adopts an id the server could have issued', () => {
    // tempId is Date.now(), which is above int4, and mergeHistory compares ids
    // numerically. A string id, a 0, or a malformed body adopted here survives
    // every reload as a duplicate.
    expect(transmit).toMatch(/\.\.\.\(isServerId\(savedId\) \? \{ id: savedId \} : \{\}\)/);
  });

  test('an empty composer sends nothing', () => {
    const send = appSource.slice(appSource.indexOf('const sendChatMessage = useCallback'));
    const body = send.slice(0, send.indexOf('const getCategoryColor'));
    expect(body).toMatch(/if \(currentInput\.trim\(\)\) \{/);
    // And the typing latch is cleared on the way out, or the NEXT message this
    // person types shows no typing indicator to anyone in the flock.
    expect(body).toMatch(/typingActiveRef\.current = false;/);
  });

  test('a retry carries every attachment the bubble was holding', () => {
    const retry = appSource.slice(appSource.indexOf('const retryFailedMessage = useCallback'));
    const body = retry.slice(0, retry.indexOf('}, [transmitFlockMessage])'));
    // While venue_data was missing from this list, retrying a venue card
    // re-sent it as a plain sentence with no card under it.
    expect(body).toMatch(/message_type: failedMsg\.message_type/);
    expect(body).toMatch(/image_url: failedMsg\.image \|\| null/);
    expect(body).toMatch(/venue_data: failedMsg\.venue_data \|\| null/);
  });
});

// ---------------------------------------------------------------------------
// THE SEND BUTTON THAT LIT UP FOR A BOXFUL OF SPACES.
//
// `chatInputHasText` is the only thing arming Send on both chat screens, and
// both input handlers write it. Both computed `!!e.target.value`, which is
// true for a string of spaces, while every send path decides whether there is
// anything to send with `.trim()`. So a composer holding whitespace showed a
// live Send button, the tap reached `if (!text) return`, and nothing at all
// happened: no bubble, no error, no cleared box, no way to tell a dead button
// from a dropped message. `tools/e2e/chat.spec.js` drove it on the flock
// screen; the DM composer is the same state through a different handler, and
// it had no local guard of its own.
//
// screens/ChatDetail.js carries a second, local check on the flock side
// (`composerHasRealText`). This is the shared boolean underneath both of them,
// so the DM composer is correct at the source and the flock composer is
// covered twice.
//
// EXECUTED, not pinned. Both handlers are useCallbacks inside FlockAppInner,
// so they are lifted out as source text and run against stand-in
// collaborators, the same move this file already makes for the module-scope
// helpers above. A pin refuses one spelling of one edit; this one refuses the
// behaviour.
// ---------------------------------------------------------------------------

/** Lift a `const <name> = useCallback(...)` declared INSIDE a component. */
function liftCallback(source, name) {
  const marker = `  const ${name} = useCallback(`;
  const start = source.indexOf(marker);
  if (start === -1) throw new Error(`liftCallback: no \`${name} = useCallback(\` in source`);
  let i = source.indexOf('=', start) + 1;
  let depth = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === '/' && next === '/') {
      i = source.indexOf('\n', i);
      if (i === -1) break;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? source.length : end + 2;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      i += 1;
      while (i < source.length) {
        if (source[i] === '\\') { i += 2; continue; }
        if (source[i] === quote) { i += 1; break; }
        i += 1;
      }
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    else if (ch === ';' && depth === 0) return source.slice(start, i + 1);
    i += 1;
  }
  throw new Error(`liftCallback: unterminated declaration for ${name}`);
}

/**
 * Build one composer handler and hand back what it wrote. `useCallback` is the
 * identity here, and every free name the body reads is supplied, so a name the
 * body starts reading that this list does not carry is a ReferenceError rather
 * than a silent undefined.
 */
function runComposerHandler(name, value, { threadOpen = true } = {}) {
  const chatInputRef = { current: 'stale' };
  let hasText = null;
  const setChatInputHasText = (next) => {
    hasText = typeof next === 'function' ? next(hasText) : next;
  };
  const noop = () => {};
  const source = liftCallback(appSource, name);
  // eslint-disable-next-line no-new-func
  const factory = new Function(
    'useCallback', 'chatInputRef', 'setChatInputHasText', 'selectedFlockId',
    'selectedDmId', 'startTyping', 'stopTyping', 'dmStartTyping', 'dmStopTyping',
    'typingActiveRef', 'typingTimeoutRef', 'dmTypingTimeoutRef',
    `${source}\nreturn ${name};`
  );
  const handler = factory(
    (fn) => fn, chatInputRef, setChatInputHasText,
    threadOpen ? 7 : null, threadOpen ? 7 : null,
    noop, noop, noop, noop,
    { current: false }, { current: null }, { current: null }
  );
  handler({ target: { value } });
  return { hasText, draft: chatInputRef.current };
}

describe('whitespace does not arm the Send button on either chat screen', () => {
  const HANDLERS = [
    ['handleChatInputChange', 'the flock composer'],
    ['handleDmInputChange', 'the DM composer'],
  ];

  test('the lift found both handlers, so nothing below is running on nothing', () => {
    HANDLERS.forEach(([name]) => {
      const source = liftCallback(appSource, name);
      expect(source.length).toBeGreaterThan(120);
      expect(source).toContain('setChatInputHasText');
    });
  });

  HANDLERS.forEach(([name, label]) => {
    test(`${label} refuses to arm Send for spaces alone`, () => {
      // Three spaces is what a thumb on a phone keyboard produces on the way
      // to giving up on a sentence.
      expect(runComposerHandler(name, '   ').hasText).toBe(false);
      expect(runComposerHandler(name, '\n\t ').hasText).toBe(false);
    });

    test(`${label} still arms Send for real text, padded or not`, () => {
      expect(runComposerHandler(name, 'hi').hasText).toBe(true);
      // A leading space is ordinary and must not disarm anything.
      expect(runComposerHandler(name, '  see you at 9  ').hasText).toBe(true);
    });

    test(`${label} disarms Send for an empty box`, () => {
      expect(runComposerHandler(name, '').hasText).toBe(false);
    });

    test(`${label} still hands the untrimmed draft to the send path`, () => {
      // The trim belongs to the BUTTON, not to the draft. The send path does
      // its own trimming, and a handler that stored a trimmed value would
      // stop somebody typing "see you at " and then a venue name.
      expect(runComposerHandler(name, '  see you at  ').draft).toBe('  see you at  ');
    });
  });

  test('the DM Send button is the one reading that boolean', () => {
    // If this ever stops being true the executed tests above are describing a
    // button nothing is wired to.
    const bar = appSource.slice(appSource.indexOf('{/* Input bar'));
    const send = bar.slice(0, bar.indexOf('</div>', bar.indexOf('aria-label="Send"')));
    expect(send.length).toBeGreaterThan(200);
    expect(send).toContain('disabled={!chatInputHasText}');
  });
});

// ---------------------------------------------------------------------------
// From the flock chat trace of 2026-09-04. Four more, and the one above.
// ---------------------------------------------------------------------------
test('reaching the top of the scrollback is not permanent', () => {
  // Nothing cleared the exhausted flag, and a read that does not keep older
  // rows truncates the list back to one page, so the pages exist again. One
  // walk to the top of a long chat hid "Load earlier messages" for the rest of
  // the session: leave, come back to the newest fifty, and the control that
  // reaches the other two hundred and fifty is not on the screen.
  expect(appSource).toMatch(/if \(!keepOlder\) \{\s*setFlockAtTop\(t => \{/);
  expect(appSource).toMatch(/delete next\[flockId\];/);
});

test('a send the server will always refuse has a way off the screen', () => {
  // Retry was the only control, and a photo the image screen refuses or text
  // the language filter rejects comes back on every open with a retry that
  // runs the same refusal. It also parks a data URL in a 5 MB store.
  expect(appSource).toMatch(/const discardFailedMessage = useCallback\(\(flockId, failedMsg\) => \{/);
  expect(appSource).toMatch(/removeFailedFlockMessage\(flockId, failedMsg\.id\);/);
  expect(appSource).toMatch(/aria-label="Remove this message that did not send"/);
});

test('an unsent message stops being counted as unread', () => {
  // The badge is a server-backed count since 056, not derived from the array,
  // so dropping the bubble left the row asserting an unread that is gone.
  expect(appSource).toMatch(/\.\.\.\(removed && \(f\.unread \|\| 0\) > 0 \? \{ unread: f\.unread - 1 \} : \{\}\),/);
});

test('search says what it actually searched, and can widen it', () => {
  // There is no server-side message search, so the filter runs over the rows
  // this client holds. Hiding the scrollback control during a search made a
  // term three hundred messages back unreachable, and the empty state then
  // announced it did not exist.
  expect(appSource).toMatch(/Nothing loaded so far matches/);
  // "Everything is here" is the top of the scrollback OR a thread shorter than
  // one page. flockAtTop alone is only set by the paging reader, so a short
  // flock never sets it and would be told its own contents were not loaded.
  expect(appSource).toMatch(/\(flockAtTop\[flock\.id\] \|\| flock\.messages\.length < DM_PAGE_SIZE\)/);
  expect(appSource).toMatch(/Load earlier messages above to search further back\./);
  expect(appSource).not.toMatch(/\{!messagesLoading && !\(showChatSearch && chatSearch\.trim\(\)\) && !flockAtTop\[flock\.id\]/);
  expect(appSource).toMatch(/\{visibleMessages\.length === 1 \? 'message' : 'messages'\} found/);
});

test('a blocked person leaves with their reactions, and the full-size photo route agrees', () => {
  const messages = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'backend', 'routes', 'messages.js'), 'utf8');
  expect(appSource).toMatch(/const kept = m\.reactions\.filter\(r => String\(r && r\.user_id\) !== id\);/);
  // The one read in that file with no visibility filter.
  expect(messages).toMatch(/AND \(sender_id IS NULL OR NOT \(sender_id = ANY\(\$3::int\[\]\)\)\)/);
});
