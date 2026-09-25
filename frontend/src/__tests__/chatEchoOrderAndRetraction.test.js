/**
 * THE CHAT'S BOOKKEEPING: which bubble a stored row is, where it goes, and
 * what a late answer from the server may put back.
 *
 * Nine things, each of which went wrong quietly:
 *
 *   1. Two sends that look alike (two photos with no caption, "ok" twice) in
 *      flight together were matched to their echoes on content, so the one
 *      the server finished first settled the first bubble. Each send now
 *      carries its own client id, the server hands it back on the sender's
 *      copies, and the echo is matched on that alone (echoMatches).
 *   2. A flock message reached only the device that sent it, and an own
 *      message with no bubble was dropped, so a second device never showed
 *      what its owner said. The server echoes to the whole account now and
 *      the app shows it.
 *   3. A failed or sending bubble was thrown away when ANY stored row had the
 *      same text, another member's included, and the reload store with it.
 *      Only the caller's own row, issued after the send began, counts now,
 *      one row per send (sendLandedAs, landedSends).
 *   4 and 5. An unsent or taken-down message, and a blocked member's words,
 *      stayed in reply quotes and in the pinned bar. The takedown's clear now
 *      takes the pin too, and unsend and block run through it.
 *   6. A history read already in flight when a message was unsent, hidden or
 *      its sender blocked put it straight back. Retractions are logged and a
 *      read drops whatever was retracted after it went out.
 *   7. A typing name stayed up forever when its stop was lost. Names expire
 *      unless refreshed, and the typist refreshes while typing.
 *   8. Rows were appended in arrival order, which is not the server's order,
 *      so the thread reordered itself on reload (orderByServerId).
 *   9. The same account reacting from two devices: the second device's
 *      "already reacted" rolled back a reaction the server kept.
 *
 * App.js cannot be imported (it is the whole app), so its pure helpers are
 * lifted out by name and run, the way chatSurface.test.js and
 * contentTakedownWiring.test.js do it. Where a behaviour lives inside a hook
 * it is pinned on the source instead, and says so.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test --watchAll=false
 */

const fs = require('fs');
const path = require('path');

// A fake socket.io-client that records what goes on the wire. Plain
// functions, not jest.fn(): react-scripts sets resetMocks.
jest.mock('socket.io-client', () => {
  const instances = [];
  const io = () => {
    const instance = {
      connected: true,
      active: true,
      sent: [],
      on: () => {},
      off: () => {},
      emit: (event, payload) => { instance.sent.push({ event, payload }); },
      connect: () => {},
      disconnect: () => {},
      removeAllListeners: () => {},
    };
    instances.push(instance);
    return instance;
  };
  return { io, __instances: instances };
});

const socketIoClient = require('socket.io-client');
const socketApi = require('../services/socket');
const api = require('../services/api');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8').replace(/\r\n/g, '\n');
const appSource = read('App.js');

// Same extractor as chatSurface.test.js: a module-scope `const` out of
// App.js, by name, to be evaluated.
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

// A `const <name> = useCallback(...)` declared inside the component.
function liftCallback(source, name) {
  const marker = `  const ${name} = useCallback(`;
  const start = source.indexOf(marker);
  if (start === -1) throw new Error(`liftCallback: no \`${name} = useCallback(\` in source`);
  let i = source.indexOf('=', start) + 1;
  let depth = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === '/' && next === '/') { i = source.indexOf('\n', i); if (i === -1) break; continue; }
    if (ch === '/' && next === '*') { const end = source.indexOf('*/', i + 2); i = end === -1 ? source.length : end + 2; continue; }
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

const HELPERS = [
  'SERVER_ID_MAX', 'isServerId', 'sameSend', 'newClientId', 'echoMatches', 'newestServerId',
  'sendLandedAs', 'landedSends', 'orderByServerId', 'retractedSince', 'retractedIdsIn',
  'dropRetracted', 'noteRetraction', 'mergeHistory', 'sameContentId', 'applyTakedownToFlocks',
  'TYPING_REFRESH_MS', 'TYPING_EXPIRE_MS',
];
const H = (() => {
  const chunk = HELPERS.map((n) => extractDeclaration(appSource, n)).join('\n');
  // eslint-disable-next-line no-new-func
  return new Function(`${chunk}\nreturn { ${HELPERS.join(', ')} };`)();
})();

/** A body slice between two markers, failing loudly when either moved. */
function between(source, from, to) {
  const start = source.indexOf(from);
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf(to, start + from.length);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

const ME = 1;
// History rows as mapFlockRow shapes them.
const row = (id, text, { senderId = ME, type = 'text', thumb = null, reply = null } = {}) => ({
  id, text, message_type: type, senderId, sender: senderId === ME ? 'You' : 'Bo', thumb, reply_to: reply,
});
// An unsettled bubble as transmitFlockMessage draws it.
const bubble = (id, text, { clientId, afterId, failed = false, image = null, type = 'text' } = {}) => ({
  id, text, message_type: type, senderId: ME, sender: 'You', clientId, afterId,
  ...(image ? { image } : {}), ...(failed ? { failed: true } : { pending: true }),
});

// ---------------------------------------------------------------------------
// 1. Which send an echo belongs to
// ---------------------------------------------------------------------------
describe('an echo settles the bubble that sent it, not the one that looks like it', () => {
  test('client ids are short, safe for the server, and different every time', () => {
    const ids = new Set();
    for (let n = 0; n < 200; n += 1) {
      const id = H.newClientId();
      // The server's shape (sockets/handlers.js readClientId).
      expect(id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
      ids.add(id);
    }
    expect(ids.size).toBe(200);
  });

  test('two captionless photos in flight: the second echo, first to land, settles the second bubble', () => {
    const first = bubble(101, '', { clientId: 'cA', type: 'image', image: 'data:image/jpeg;base64,AAA' });
    const second = bubble(102, '', { clientId: 'cB', type: 'image', image: 'data:image/jpeg;base64,BBB' });
    const echo = { id: 900, message_text: '', message_type: 'image', image_url: 'data:image/jpeg;base64,BBB', client_id: 'cB' };
    // On content alone they are the same send, which was the whole defect.
    expect(H.sameSend(first, echo)).toBe(true);
    expect(H.sameSend(second, echo)).toBe(true);
    // By client id there is exactly one answer.
    expect([first, second].filter((b) => H.echoMatches(b, echo))).toEqual([second]);
  });

  test('an echo that carries an id never settles a bubble with a different one, or none', () => {
    const echo = { message_text: 'ok', message_type: 'text', client_id: 'cZ' };
    expect(H.echoMatches(bubble(1, 'ok', { clientId: 'cY' }), echo)).toBe(false);
    expect(H.echoMatches(bubble(1, 'ok', {}), echo)).toBe(false);
  });

  test('an echo from a server without the id falls back to the old content match', () => {
    const echo = { message_text: 'ok ', message_type: 'text' };
    expect(H.echoMatches(bubble(1, 'ok', { clientId: 'cY' }), echo)).toBe(true);
    expect(H.echoMatches(bubble(1, 'no', { clientId: 'cY' }), echo)).toBe(false);
  });

  test('both transports carry the id, flock and DM, and the pending entries remember it', () => {
    const flock = between(appSource, 'const transmitFlockMessage = useCallback', 'const retryFailedMessage = useCallback');
    expect(flock).toMatch(/const clientId = newClientId\(\);/);
    expect(flock).toMatch(/socketSendMessage\(flockId, text, \{[^}]*client_id: clientId, reply_to_id: replyToId \}\)/);
    expect(flock).toMatch(/apiSendMessage\(flockId, text, \{[^}]*client_id: clientId, reply_to_id: replyToId \|\| undefined \}\)/);
    expect(flock).toMatch(/pendingEchoRef\.current\.set\(tempId, \{[^}]*clientId, timer \}\)/);
    const dm = between(appSource, 'const transmitDm = useCallback', 'const sendDmMessage = useCallback');
    expect(dm).toMatch(/const clientId = newClientId\(\);/);
    expect((dm.match(/client_id: clientId,/g) || []).length).toBe(2);
    expect(dm).toMatch(/dmEchoRef\.current\.set\(tempId, \{ userId, payload: \{ \.\.\.payload, clientId \}, timer \}\)/);
    // And both echo handlers match on it.
    expect(appSource).toMatch(/p\.flockId === msg\.flock_id && echoMatches\(p, msg\)/);
    expect(appSource).toMatch(/p\.userId === otherUserId && echoMatches\(p\.payload, msg\)/);
  });
});

// ---------------------------------------------------------------------------
// 2. The sender's other devices
// ---------------------------------------------------------------------------
describe("an own message with no bubble is this account's other device, and it is shown", () => {
  test('the flock echo handler appends it through the history mapper instead of dropping it', () => {
    // Inside a useEffect, so pinned rather than run. The old handler ended in
    // `if (staleIdx === -1) return prev;` under a comment saying the server
    // echoed only to the sending socket, which the server no longer does.
    const handler = between(appSource, 'const unsub = onNewMessage((msg) => {', '// ── RECEIPTS ARRIVING');
    expect(handler).toMatch(/if \(at === -1\) \{[\s\S]*?updated\.push\(mapFlockRow\(msg, authUser\?\.id\)\);/);
    expect(handler).not.toMatch(/if \(staleIdx === -1\) return prev;/);
    // Deduped on id first, so the device that sent it never shows it twice.
    expect(handler).toMatch(/if \(msgs\.some\(m => m\.id === msg\.id\)\) return prev;/);
  });
});

// ---------------------------------------------------------------------------
// 3. Only your own later row settles an unsettled send
// ---------------------------------------------------------------------------
describe('a history read only settles a send that could really be it', () => {
  test("another member's identical line does not take your failed one", () => {
    const failed = bubble(1700000000001, 'ok', { failed: true, afterId: 10 });
    const hist = [row(11, 'ok', { senderId: 2 })];
    expect(H.landedSends([failed], hist, []).size).toBe(0);
    const merged = H.mergeHistory([failed], hist);
    expect(merged.map((m) => m.id)).toEqual([11, 1700000000001]);
  });

  test('an older own row with the same words does not take the one still sending', () => {
    const sending = bubble(1700000000002, 'ok', { afterId: 20 });
    const hist = [row(15, 'ok')];
    expect(H.mergeHistory([sending], hist).map((m) => m.id)).toEqual([15, 1700000000002]);
  });

  test('your own row issued after the send began does settle it', () => {
    const failed = bubble(1700000000003, 'ok', { failed: true, afterId: 20 });
    const hist = [row(21, 'ok')];
    expect(H.mergeHistory([failed], hist).map((m) => m.id)).toEqual([21]);
  });

  test('one row settles one send: two identical sends with one landed leave one', () => {
    const a = bubble(1700000000004, 'ok', { failed: true, afterId: 20 });
    const b = bubble(1700000000005, 'ok', { failed: true, afterId: 20 });
    const landed = H.landedSends([a, b], [row(21, 'ok')], []);
    expect(landed.size).toBe(1);
    expect(H.mergeHistory([a, b], [row(21, 'ok')]).filter((m) => m.failed)).toHaveLength(1);
  });

  test('a row already on screen under its own id is somebody else\'s settled bubble', () => {
    const settled = { ...row(21, 'ok') };
    const sending = bubble(1700000000006, 'ok', { afterId: 20 });
    // Row 21 is the first "ok", already reconciled; the second is still out.
    expect(H.mergeHistory([settled, sending], [row(21, 'ok')]).map((m) => m.id)).toEqual([21, 1700000000006]);
  });

  test('a bubble from before the mark existed keeps the content match, own rows only', () => {
    const legacy = bubble(1700000000007, 'ok', { failed: true });
    delete legacy.afterId;
    expect(H.mergeHistory([legacy], [row(5, 'ok', { senderId: 2 })]).map((m) => m.id)).toEqual([5, 1700000000007]);
    expect(H.mergeHistory([legacy], [row(5, 'ok')]).map((m) => m.id)).toEqual([5]);
  });

  test('the reload store is rewritten by the same rule', () => {
    const loader = between(appSource, 'const loadFlockMessages = useCallback', '// The DM twin of loadFlockMessages');
    expect(loader).toMatch(/const landed = landedSends\(stored, msgs, onScreen\);/);
    expect(loader).toMatch(/const failed = stored\.filter\(fm => !landed\.has\(fm\)\);/);
    expect(loader).not.toMatch(/filter\(fm => !msgs\.some\(h => sameSend\(/);
  });
});

// ---------------------------------------------------------------------------
// 4 and 5. A pin and a quote go with the message
// ---------------------------------------------------------------------------
describe('the takedown clear takes the pin as well as the bubble and the quotes', () => {
  const flocks = () => ([{
    id: 1,
    messages: [row(10, 'door code 4411', { senderId: 2 }), row(11, 'thanks', { reply: { id: 10, text: 'door code 4411', sender: 'Bo' } })],
    pins: [{ id: 10, messageId: 10, text: 'door code 4411' }, { id: 12, messageId: 12, text: 'Venmo @bo' }],
  }]);

  test('the pinned copy of a removed message leaves the bar', () => {
    const after = H.applyTakedownToFlocks(flocks(), { contentType: 'flock_message', contentId: 10, flockId: 1 });
    expect(after[0].pins.map((p) => p.messageId)).toEqual([12]);
    expect(after[0].messages.map((m) => m.id)).toEqual([11]);
    expect(after[0].messages[0].reply_to).toBeNull();
  });

  test('a pin of a message that is not loaded here still goes', () => {
    const before = [{ id: 1, messages: [], pins: [{ id: 99, messageId: 99, text: 'old' }] }];
    const after = H.applyTakedownToFlocks(before, { contentType: 'flock_message', contentId: 99, flockId: 1 });
    expect(after).not.toBe(before);
    expect(after[0].pins).toEqual([]);
  });

  test('nothing matched, nothing moves: the same array back', () => {
    const before = flocks();
    expect(H.applyTakedownToFlocks(before, { contentType: 'flock_message', contentId: 404, flockId: 1 })).toBe(before);
  });

  test('unsend and block run the same clear', () => {
    const clear = between(appSource, 'const clearUnsentFlockMessage = useCallback', 'const handleUnsendDm = useCallback');
    expect(clear).toMatch(/applyTakedownToFlocks\(prev, \{ contentType: 'flock_message', contentId: messageId, flockId \}\)/);
    // The confirm and the live event are the same call now.
    expect(clear).toMatch(/onFlockMessageUnsent\(\(data\) => \{\s*clearUnsentFlockMessage\(data\.flockId, data\.messageId\);/);
    expect(clear).toMatch(/await unsendFlockMessage\(flockId, messageId\);\s*clearUnsentFlockMessage\(flockId, messageId\);/);
    const block = between(appSource, 'const handleUserBlocked = useCallback', 'const openUserProfile = useCallback');
    expect(block).toMatch(/theirs\.has\(String\(m\.reply_to\.id\)\) \? \{ \.\.\.m, reply_to: null \}/);
    expect(block).toMatch(/f\.pins\.filter\(p => !theirs\.has\(/);
  });
});

// ---------------------------------------------------------------------------
// 6. A late history answer does not bring back what was retracted
// ---------------------------------------------------------------------------
describe('a history read older than an unsend, a takedown or a block', () => {
  const log = [
    { seq: 1, kind: 'flock', messageId: 5 },
    { seq: 2, kind: 'dm', messageId: 7 },
    { seq: 3, senderId: 9 },
  ];

  test('only what was retracted after the read went out is dropped', () => {
    expect(H.retractedSince(log, 3, 'flock')).toBeNull();
    const since1 = H.retractedSince(log, 1, 'flock');
    // The flock unsend happened before this read, so the server already knew.
    expect([...since1.ids]).toEqual([]);
    expect([...since1.senders]).toEqual(['9']);
    const since0 = H.retractedSince(log, 0, 'flock');
    expect([...since0.ids]).toEqual(['5']);
    // DM ids and flock ids are separate sequences and never cross.
    expect([...H.retractedSince(log, 0, 'dm').ids]).toEqual(['7']);
  });

  test('the retracted rows are dropped from the merge, and every quote of them emptied', () => {
    const drop = H.retractedSince(log, 0, 'flock');
    const hist = [
      row(4, 'hi', { senderId: 2 }),
      row(5, 'unsent words', { senderId: 2 }),
      row(6, 'from somebody just blocked', { senderId: 9 }),
      row(8, 'replying', { reply: { id: 5, text: 'unsent words', sender: 'Bo' } }),
      row(10, 'replying to the blocked one', { reply: { id: 6, text: 'from somebody just blocked', sender: 'Cy' } }),
    ];
    const merged = H.mergeHistory([], hist, { drop });
    expect(merged.map((m) => m.id)).toEqual([4, 8, 10]);
    expect(merged.find((m) => m.id === 8).reply_to).toBeNull();
    expect(merged.find((m) => m.id === 10).reply_to).toBeNull();
    // With nothing to drop the history is taken whole, by reference.
    expect(H.dropRetracted(hist, null)).toBe(hist);
  });

  test('both history readers note where they started and drop what came after', () => {
    const flockLoader = between(appSource, 'const loadFlockMessages = useCallback', '// The DM twin of loadFlockMessages');
    expect(flockLoader).toMatch(/const since = retractionsRef\.current\.seq;/);
    expect(flockLoader).toMatch(/retractedSince\(retractionsRef\.current\.log, since, 'flock'\)/);
    expect(flockLoader).toMatch(/mergeHistory\(localWithFailed, msgs, \{ keepOlder, drop \}\)/);
    // The pins that ride with the read are filtered by the same drop.
    expect(flockLoader).toMatch(/const gone = retractedIdsIn\(msgs, drop\);/);
    const dmLoader = between(appSource, 'const loadDmMessages = useCallback', '// ── Scrollback ──');
    expect(dmLoader).toMatch(/if \(drop && drop\.senders\.has\(String\(userId\)\)\) return;/);
    expect(dmLoader).toMatch(/mergeHistory\(d\.messages, msgs, \{ keepOlder, drop \}\)/);
  });

  test('every retraction is logged: unsend both ways, takedown, and block', () => {
    expect(appSource).toMatch(/noteRetraction\(retractionsRef, \{ kind: 'flock', messageId \}\);/);
    expect(appSource).toMatch(/noteRetraction\(retractionsRef, \{ kind: 'dm', messageId: data\.messageId \}\);/);
    expect(appSource).toMatch(/noteRetraction\(retractionsRef, \{ kind: 'dm', messageId \}\);/);
    expect(appSource).toMatch(/if \(ev\.contentType === 'flock_message'\) noteRetraction\(retractionsRef, \{ kind: 'flock', messageId: ev\.contentId \}\);/);
    expect(appSource).toMatch(/noteRetraction\(retractionsRef, \{ kind: 'dm', messageId: ev\.contentId \}\);/);
    expect(appSource).toMatch(/noteRetraction\(retractionsRef, \{ senderId: id \}\);/);
  });

  test('the log numbers every entry and keeps the last two hundred', () => {
    const ref = { current: { seq: 0, log: [] } };
    H.noteRetraction(ref, { kind: 'flock', messageId: 1 });
    const since = ref.current.seq;
    H.noteRetraction(ref, { senderId: 4 });
    expect(ref.current.log.map((e) => e.seq)).toEqual([1, 2]);
    // A read that went out between the two sees only the second.
    expect([...H.retractedSince(ref.current.log, since, 'flock').senders]).toEqual(['4']);
    for (let n = 0; n < 250; n += 1) H.noteRetraction(ref, { kind: 'dm', messageId: n });
    expect(ref.current.log).toHaveLength(200);
    expect(ref.current.seq).toBe(252);
  });

  test('a live row from somebody blocked, or one already retracted, is not appended', () => {
    const flock = between(appSource, 'const unsub = onNewMessage((msg) => {', '// ── RECEIPTS ARRIVING');
    expect(flock).toMatch(/if \(blockedIdsRef\.current\.has\(String\(msg\.sender_id\)\)\) return;/);
    expect(flock).toMatch(/e\.kind === 'flock' && String\(e\.messageId\) === String\(msg\.id\)/);
    const dm = between(appSource, 'const unsub = onNewDm((msg) => {', 'const previewText = messagePreview(mapped);');
    expect(dm).toMatch(/if \(!isYou && blockedIdsRef\.current\.has\(String\(msg\.sender_id\)\)\) return;/);
    expect(dm).toMatch(/e\.kind === 'dm' && String\(e\.messageId\) === String\(msg\.id\)/);
  });
});

// ---------------------------------------------------------------------------
// 7. Typing names expire unless refreshed
// ---------------------------------------------------------------------------
describe('a typing name that is not refreshed comes off the screen', () => {
  test('the expiry outlasts two refreshes, so one lost frame does not blink it', () => {
    expect(H.TYPING_REFRESH_MS).toBeGreaterThan(0);
    expect(H.TYPING_EXPIRE_MS).toBeGreaterThanOrEqual(2 * H.TYPING_REFRESH_MS);
    // "A few seconds", not a minute: the point is that it ends.
    expect(H.TYPING_EXPIRE_MS).toBeLessThanOrEqual(10000);
  });

  test('both listeners set an expiry on every typing event and both typists refresh', () => {
    const flock = between(appSource, 'const typingUsersRef = useRef({});', '// --- Live location sharing ---');
    expect(flock).toMatch(/expiry\[data\.userId\] = setTimeout\(\(\) => forget\(data\.userId\), TYPING_EXPIRE_MS\);/);
    expect(flock).toMatch(/if \(typingActiveRef\.current\) startTyping\(selectedFlockId\);/);
    expect(flock).toMatch(/\}, TYPING_REFRESH_MS\);/);
    const dm = between(appSource, '  // DM typing indicators', '// DM input change with typing indicator');
    expect(dm).toMatch(/expiry = setTimeout\(clear, TYPING_EXPIRE_MS\);/);
    expect(dm).toMatch(/if \(dmTypingActiveRef\.current\) dmStartTyping\(selectedDmId\);/);
  });
});

// ---------------------------------------------------------------------------
// 8. The server's order
// ---------------------------------------------------------------------------
describe('rows sit in id order once both have one', () => {
  test('a row that arrives late goes in front of the newer one it lost the race to', () => {
    const list = [{ id: 10 }, { id: 12 }, { id: 11 }];
    expect(H.orderByServerId(list).map((m) => m.id)).toEqual([10, 11, 12]);
  });

  test('a sending bubble travels with the row it was sent after', () => {
    const list = [{ id: 10 }, { id: 12 }, { id: 'temp-a' }, { id: 11 }];
    expect(H.orderByServerId(list).map((m) => m.id)).toEqual([10, 11, 12, 'temp-a']);
  });

  test('a bubble that settles out of order moves to its place', () => {
    // Sent after 10, settled as 14 after 13 had already arrived below it.
    const list = [{ id: 10 }, { id: 14 }, { id: 13 }];
    expect(H.orderByServerId(list).map((m) => m.id)).toEqual([10, 13, 14]);
  });

  test('leading bubbles stay first, and an ordered list comes back by reference', () => {
    const lead = [{ id: 'temp-a' }, { id: 12 }, { id: 11 }];
    expect(H.orderByServerId(lead).map((m) => m.id)).toEqual(['temp-a', 11, 12]);
    const ordered = [{ id: 1 }, { id: 'temp-b' }, { id: 2 }];
    expect(H.orderByServerId(ordered)).toBe(ordered);
  });

  test('every live append and every settle goes through it, flock and DM', () => {
    expect(appSource).toMatch(/messages: orderByServerId\(\[\.\.\.\(f\.messages \|\| \[\]\), mapped\]\), unread: chatOpen/);
    expect(appSource).toMatch(/next\[fi\] = \{ \.\.\.prev\[fi\], messages: orderByServerId\(updated\) \};/);
    expect(appSource).toMatch(/messages: orderByServerId\(\[\.\.\.d\.messages, mapped\]\)/);
    expect(appSource).toMatch(/messages: orderByServerId\(d\.messages\.map\(m => \(m\.id === tempId/);
  });
});

// ---------------------------------------------------------------------------
// 9. A second device's reaction
// ---------------------------------------------------------------------------
describe("the same account reacting on two devices keeps the reaction the server kept", () => {
  function runReaction({ had = false, failWith }) {
    const state = {
      flocks: [{ id: 7, messages: [{ id: 40, reactions: had ? [{ emoji: '❤️', user_id: ME, user_name: 'Ava' }] : [] }] }],
    };
    const calls = { refresh: [], toasts: [] };
    const source = liftCallback(appSource, 'addReactionToMessage');
    // eslint-disable-next-line no-new-func
    const factory = new Function(
      'useCallback', 'setShowReactionPicker', 'meRef', 'flocksRef', 'setFlocks', 'isServerId',
      'removeReaction', 'addReaction', 'showToast', 'refreshFlockReactions',
      `${source}\nreturn addReactionToMessage;`
    );
    const flocksRef = { get current() { return state.flocks; } };
    const setFlocks = (fn) => { state.flocks = typeof fn === 'function' ? fn(state.flocks) : fn; };
    const reject = () => Promise.reject(failWith);
    const handler = factory(
      (fn) => fn, () => {}, { current: { id: ME, name: 'Ava' } }, flocksRef, setFlocks, H.isServerId,
      reject, reject, (message) => calls.toasts.push(message),
      (flockId, messageId) => calls.refresh.push([flockId, messageId])
    );
    handler(7, 40, '❤️');
    return new Promise((resolve) => setTimeout(() => resolve({ state, calls }), 0));
  }

  const err = (status, message, code) => Object.assign(new Error(message), { status, ...(code ? { code } : {}) });

  test('"already reacted" keeps the pill, reads the message again and says nothing', async () => {
    const { state, calls } = await runReaction({ failWith: err(400, 'Already reacted with this emoji', 'ALREADY_REACTED') });
    expect(state.flocks[0].messages[0].reactions).toEqual([{ emoji: '❤️', user_id: ME, user_name: 'Ava' }]);
    expect(calls.refresh).toEqual([[7, 40]]);
    expect(calls.toasts).toEqual([]);
  });

  test('an older server that sends only the sentence is read the same way', async () => {
    const { state, calls } = await runReaction({ failWith: err(400, 'Already reacted with this emoji') });
    expect(state.flocks[0].messages[0].reactions).toHaveLength(1);
    expect(calls.refresh).toHaveLength(1);
  });

  test('a removal the other device already made is not put back', async () => {
    const { state, calls } = await runReaction({ had: true, failWith: err(404, 'Reaction not found') });
    expect(state.flocks[0].messages[0].reactions).toEqual([]);
    expect(calls.refresh).toEqual([[7, 40]]);
    expect(calls.toasts).toEqual([]);
  });

  test('a real refusal still rolls back and says so', async () => {
    const { state, calls } = await runReaction({ failWith: err(500, 'Failed to add reaction') });
    expect(state.flocks[0].messages[0].reactions).toEqual([]);
    expect(calls.refresh).toEqual([]);
    expect(calls.toasts).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The two transport helpers
// ---------------------------------------------------------------------------
describe('the wire', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('flockToken', 'token-a');
    socketApi.disconnectSocket();
  });
  afterEach(() => socketApi.disconnectSocket());

  const lastSocket = () => socketIoClient.__instances[socketIoClient.__instances.length - 1];

  test('the socket sends carry the client id when there is one, and nothing extra when not', () => {
    socketApi.connectSocket();
    socketApi.sendMessage(4, 'ok', { client_id: 'cA1' });
    socketApi.sendMessage(4, 'ok', {});
    socketApi.socketSendDm(9, 'ok', { client_id: 'cB2' });
    const sent = lastSocket().sent.filter((s) => s.event === 'send_message' || s.event === 'send_dm');
    expect(sent[0].payload.client_id).toBe('cA1');
    expect(Object.prototype.hasOwnProperty.call(sent[1].payload, 'client_id')).toBe(false);
    expect(sent[2].payload.client_id).toBe('cB2');
  });

  function jsonRes(body, status = 200) {
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (h) => (String(h).toLowerCase() === 'content-type' ? 'application/json' : null) },
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  }

  test('the REST sends carry it in the body', async () => {
    global.fetch = jest.fn(() => Promise.resolve(jsonRes({ message: { id: 1 } }, 201)));
    await api.sendMessage(4, 'ok', { client_id: 'cA1' });
    await api.sendDM(9, 'ok', { client_id: 'cB2' });
    expect(JSON.parse(global.fetch.mock.calls[0][1].body).client_id).toBe('cA1');
    expect(JSON.parse(global.fetch.mock.calls[1][1].body).client_id).toBe('cB2');
  });

  test("one message's reactions are read from the row at that id, and only that row", async () => {
    const reactions = [{ emoji: '❤️', user_id: 2, user_name: 'Bo' }];
    global.fetch = jest.fn(() => Promise.resolve(jsonRes({ messages: [{ id: 40, reactions }] })));
    await expect(api.getFlockMessageReactions(7, 40)).resolves.toEqual(reactions);
    expect(global.fetch.mock.calls[0][0]).toMatch(/\/api\/flocks\/7\/messages\?before=41&limit=1$/);
    // Unsent or hidden since: the cursor answers with an older row, which is
    // not this message's reactions.
    global.fetch = jest.fn(() => Promise.resolve(jsonRes({ messages: [{ id: 39, reactions }] })));
    await expect(api.getFlockMessageReactions(7, 40)).resolves.toBeNull();
  });
});
