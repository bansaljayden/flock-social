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
// The flock chat screen left App.js on 2026-08-26: it lives in
// screens/ChatDetail.js now, and the message list, the composer, the reaction
// row and the report entry went with it. Nothing asserted below changed. The
// app source is simply in two files, so both are read, in the order they used
// to be one.
const appSource = fs.readFileSync(appPath, 'utf8')
  + fs.readFileSync(path.join(__dirname, '..', 'screens', 'ChatDetail.js'), 'utf8');
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

  test('the dot is driven by a caught-up cursor that the screen writes', () => {
    expect(appSource).toMatch(/const \[flockSeen, setFlockSeen\] = useState/);
    expect(appSource).toMatch(/flock_chat_seen/);
    expect(appSource).toMatch(/newestFromOthersId !== null && newestFromOthersId > \(flockSeen\[f\.id\] \|\| 0\)/);
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
    // The New Message sheet searches every account by name or email, so the
    // ordinary way to start a DM finds strangers and the first send is refused.
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
  });
});
