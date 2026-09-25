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
 *   10. Two captionless photos, one landed and one failed: a history read
 *      matched the landed row to whichever bubble came first, so the photo
 *      that never arrived could vanish (reload store included) while the
 *      bubble left behind offered to retry the one that had. A stored row
 *      never settles a photo now; its own echo does, even once the row is
 *      already on screen.
 *   11. A history read that went out before a block, answering after it,
 *      replaced the pins and the page, and pins or quotes of the blocked
 *      person's OLDER messages came back. A read overtaken by a later one of
 *      the same chat now changes nothing, and a block drops the blocked
 *      person's pins and quotes by the author id both carry.
 *   12. A block cleaned quotes only of messages loaded here, so a quote of an
 *      older one survived every keepOlder merge. The author id reaches those.
 *   13. Your own DM from another device, into a thread this device did not
 *      have, made an inbox row named after you.
 *   14. A photo sent over REST whose row a history read brought in while the
 *      send was in flight: the answer gave the bubble that row's id, so the
 *      thread held two rows under one id. The bubble goes instead, flock and
 *      DM.
 *   15. A live row built before a block and landing after it kept its quote
 *      of the blocked person: a reply by somebody else in any plan but the
 *      open one, and your own echo in a DM thread emptied for the person who
 *      was blocked. The quote goes by its author id, which the DM quote now
 *      carries too.
 *   16. Two reads of the DM list answering out of order: the older answer
 *      replaced the list last and took away the thread the newer one brought
 *      in. An overtaken read changes nothing, and the newest puts the loading
 *      flag down.
 *   17. A pin or unpin answer cut before a block and landing after it put the
 *      blocked person's pin back on the bar. It is filtered like the live copy.
 *   18. A socket send that landed but lost its echo: a history read brought
 *      its row in and took the bubble down, and then the eight second timer
 *      failed it anyway and stored it, so the next read put the delivered
 *      message back as a failed copy with a retry. The timer fails only a
 *      bubble still on screen and still sending.
 *   19. A read of the DM list that went out before a block and landed after
 *      it put the blocked person's row back: name, photo, last message. The
 *      read notes where the retraction log stood, and anybody blocked since
 *      is left as the block left them.
 *   20. The same delivered message came back two more ways. Over HTTP: the
 *      socket came back, its read brought the row in, the request's answer
 *      was lost, and the failure path toasted, failed and stored it anyway.
 *      And through the timer, when the read's merge had not rendered yet by
 *      the time the timer fired. Then the opposite, from deciding early: a
 *      read that matched a look-alike sent from another device was taken for
 *      this send's delivery, and the send was left sending with no way to
 *      fail. A failure path now queues an update that fails the bubble only
 *      if the newest state still shows it sending, and the toast and the copy
 *      in the reload store follow what that update decided, as the render
 *      commits (settleSendFailures).
 *
 * App.js cannot be imported (it is the whole app), so its pure helpers are
 * lifted out by name and run, the way chatSurface.test.js and
 * contentTakedownWiring.test.js do it. The socket handlers and the two
 * callbacks behind 10 to 13 are lifted too and run against stand-ins for the
 * refs and setters they close over. Where a behaviour is only reachable
 * through a mounted hook it is pinned on the source instead, and says so.
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
  'saidByAny', 'withoutBlockedQuote', 'dropRetracted', 'dropRetractedPins', 'noteRetraction', 'mergeHistory',
  'sameContentId', 'applyTakedownToFlocks', 'mapFlockRow', 'mapDmRow', 'messagePreview',
  'FAILED_MSG_KEY', 'readFailedStore', 'writeFailedStore', 'readFailedFlockMessages',
  'writeFailedFlockMessages', 'persistFailedFlockMessage', 'removeFailedFlockMessage',
  'TYPING_REFRESH_MS', 'TYPING_EXPIRE_MS', 'NOT_CONNECTED_HINT',
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

// The arrow function a socket subscription is handed inside an effect, found
// by the line that subscribes (`const unsub = onNewMessage(`) and
// brace-matched to its end, skipping strings and comments the way the two
// extractors above do.
function liftListener(source, opener) {
  const at = source.indexOf(opener);
  if (at === -1) throw new Error(`liftListener: no \`${opener}\` in source`);
  const fnStart = at + opener.length;
  let i = source.indexOf('{', source.indexOf('=>', fnStart));
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
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(fnStart, i + 1);
    }
    i += 1;
  }
  throw new Error(`liftListener: unterminated listener after ${opener}`);
}

/** Run lifted source against named stand-ins for what it closes over. */
function runLifted(src, scope) {
  // eslint-disable-next-line no-new-func
  return new Function(...Object.keys(scope), src)(...Object.values(scope));
}

/** A setter that behaves like useState's: a function is applied to the state. */
const setterOn = (state, key) => (next) => { state[key] = typeof next === 'function' ? next(state[key]) : next; };

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
// The two live handlers, lifted and run. Each closes over refs and setters
// inside FlockAppInner; these are stand-ins with the same names.
// ---------------------------------------------------------------------------
// `blocked` is who this device has blocked by the time the row lands.
function flockEcho({ flocks, pending = [], blocked = [] }) {
  const state = { flocks, storeRemoved: [], timersCleared: [] };
  const pendingEchoRef = { current: new Map(pending) };
  const handler = runLifted(`return ${liftListener(appSource, 'const unsub = onNewMessage(')};`, {
    authUser: { id: ME },
    pendingEchoRef,
    echoMatches: H.echoMatches,
    flocksRef: { get current() { return state.flocks; } },
    removeFailedFlockMessage: (flockId, id) => state.storeRemoved.push([flockId, id]),
    setFlocks: setterOn(state, 'flocks'),
    mapFlockRow: H.mapFlockRow,
    withoutBlockedQuote: H.withoutBlockedQuote,
    orderByServerId: H.orderByServerId,
    blockedIdsRef: { current: new Set(blocked.map(String)) },
    retractionsRef: { current: { seq: 0, log: [] } },
    catchUpTargetRef: { current: {} },
    clearTimeout: (t) => state.timersCleared.push(t),
  });
  return { state, pendingEchoRef, handler };
}

function dmEcho({ threads, pending = [], blocked = [] }) {
  const state = { threads, listReads: 0, timersCleared: [] };
  const dmEchoRef = { current: new Map(pending) };
  const handler = runLifted(`return ${liftListener(appSource, 'const unsub = onNewDm(')};`, {
    authUser: { id: ME },
    blockedIdsRef: { current: new Set(blocked.map(String)) },
    withoutBlockedQuote: H.withoutBlockedQuote,
    retractionsRef: { current: { seq: 0, log: [] } },
    catchUpTargetRef: { current: {} },
    setDmNotConnected: () => {},
    isServerId: H.isServerId,
    dmReadTimersRef: { current: {} },
    markDmRead: () => Promise.resolve(),
    messagePreview: H.messagePreview,
    dmEchoRef,
    echoMatches: H.echoMatches,
    setDeletedDmUserIds: () => {},
    setDirectMessages: setterOn(state, 'threads'),
    orderByServerId: H.orderByServerId,
    directMessagesRef: { get current() { return state.threads; } },
    loadDmConversations: () => { state.listReads += 1; },
    clearTimeout: (t) => state.timersCleared.push(t),
  });
  return { state, dmEchoRef, handler };
}

const AT = '2026-09-25T20:00:00Z';
// A flock row as the socket delivers it, and a DM row the same way.
const flockWire = (id, over = {}) => ({ id, flock_id: 7, sender_id: ME, sender_name: 'Ava', message_text: '', message_type: 'text', created_at: AT, ...over });
const dmWire = (id, over = {}) => ({ id, sender_id: ME, receiver_id: 5, sender_name: 'Ava', message_text: 'hey', message_type: 'text', created_at: AT, ...over });

// ---------------------------------------------------------------------------
// 2. The sender's other devices
// ---------------------------------------------------------------------------
describe("an own message with no bubble is this account's other device, and it is shown", () => {
  test('the flock echo handler appends it through the history mapper instead of dropping it', () => {
    // The old handler ended in `if (staleIdx === -1) return prev;` under a
    // comment saying the server echoed only to the sending socket, which the
    // server no longer does.
    const handler = between(appSource, 'const unsub = onNewMessage((msg) => {', '// ── RECEIPTS ARRIVING');
    // Through the history mapper, minus a quote of somebody blocked (15).
    expect(handler).toMatch(/if \(at === -1\) \{[\s\S]*?updated\.push\(withoutBlockedQuote\(mapFlockRow\(msg, authUser\?\.id\), blockedIdsRef\.current\)\);/);
    expect(handler).not.toMatch(/if \(staleIdx === -1\) return prev;/);
    const run = flockEcho({ flocks: [{ id: 7, messages: [row(20, 'earlier')] }] });
    run.handler(flockWire(21, { message_text: 'from my phone' }));
    expect(run.state.flocks[0].messages.map((m) => m.id)).toEqual([20, 21]);
    expect(run.state.flocks[0].messages[1].sender).toBe('You');
  });

  test('deduped on id, so the device that sent it never shows it twice, and the list is left alone', () => {
    const flocks = [{ id: 7, messages: [row(21, 'hi')] }];
    const run = flockEcho({ flocks });
    run.handler(flockWire(21, { message_text: 'hi' }));
    expect(run.state.flocks).toBe(flocks);
  });

  test('your own DM from another device, into a thread this one lacks, is never named after you', () => {
    const run = dmEcho({ threads: [] });
    run.handler(dmWire(90, { sender_name: 'Ava' }));
    // The payload names only the sender, who is you; no row is drawn from it.
    expect(run.state.threads).toEqual([]);
    // The conversation list is read now instead, and it names the thread.
    expect(run.state.listReads).toBe(1);
  });

  test('into a thread this device holds, it is appended and the list is not read again', () => {
    const run = dmEcho({ threads: [{ userId: 5, name: 'Bo', messages: [], unread: 0 }] });
    run.handler(dmWire(91, { message_text: 'on my way' }));
    expect(run.state.threads[0].name).toBe('Bo');
    expect(run.state.threads[0].messages.map((m) => m.id)).toEqual([91]);
    expect(run.state.listReads).toBe(0);
  });

  test("somebody else's first message still makes the thread, named after them", () => {
    const run = dmEcho({ threads: [] });
    run.handler(dmWire(92, { sender_id: 5, receiver_id: ME, sender_name: 'Bo' }));
    expect(run.state.threads.map((d) => [d.userId, d.name, d.unread])).toEqual([[5, 'Bo', 1]]);
    expect(run.state.listReads).toBe(0);
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

// A history row as GET /api/flocks/:id/messages sends it.
const srv = (id, text, { senderId = ME, name = 'Ava', type = 'text', thumb = null, reply = null } = {}) => ({
  id, sender_id: senderId, sender_name: name, message_text: text, message_type: type, created_at: AT,
  ...(thumb ? { thumb_url: thumb } : {}), ...(reply ? { reply_to: reply } : {}),
});

// loadFlockMessages, lifted and run, with the request left open until a test
// answers it: reads[n] is the nth read's { resolve, reject }.
function liftedFlockLoader(flocks = [{ id: 7, messages: [], pins: [] }]) {
  const state = { flocks, errors: [], acks: [] };
  const reads = [];
  const retractionsRef = { current: { seq: 0, log: [] } };
  const load = runLifted(`${liftCallback(appSource, 'loadFlockMessages')}\nreturn loadFlockMessages;`, {
    useCallback: (fn) => fn,
    historyReadAtRef: { current: {} },
    historyReadSeqRef: { current: {} },
    retractionsRef,
    setMessagesLoading: () => {},
    setMessagesError: (e) => { if (e) state.errors.push(e); },
    getMessages: () => new Promise((resolve, reject) => { reads.push({ resolve, reject }); }),
    mapFlockRow: H.mapFlockRow,
    meRef: { current: { id: ME } },
    retractedSince: H.retractedSince,
    readFailedFlockMessages: H.readFailedFlockMessages,
    flocksRef: { get current() { return state.flocks; } },
    isServerId: H.isServerId,
    landedSends: H.landedSends,
    writeFailedFlockMessages: H.writeFailedFlockMessages,
    setFlockAtTop: () => {},
    retractedIdsIn: H.retractedIdsIn,
    dropRetractedPins: H.dropRetractedPins,
    setFlocks: setterOn(state, 'flocks'),
    mergeHistory: H.mergeHistory,
    sendFlockAck: (flockId, id) => state.acks.push([flockId, id]),
  });
  return { state, reads, load, retractionsRef };
}

// ---------------------------------------------------------------------------
// 10. A photo is settled by its own echo, never by a row that looks like it
// ---------------------------------------------------------------------------
describe('a stored row never settles a photo; its own echo does', () => {
  const THUMB = 'data:image/jpeg;base64,THUMB';
  const photo = (id, clientId, { failed = false } = {}) => bubble(id, '', {
    clientId, afterId: 20, failed, type: 'image', image: `data:image/jpeg;base64,${clientId}`,
  });
  // The history read blanks image_url whenever a thumbnail exists.
  const photoRow = (id) => row(id, '', { type: 'image', thumb: THUMB });

  test('two captionless photos, one landed and one failed: the history read settles neither', () => {
    const a = photo(1700000000101, 'cA', { failed: true });
    const b = photo(1700000000102, 'cB', { failed: true });
    // By looks, row 21 is either of them. It used to take the first, which
    // here is the photo that never arrived.
    expect(H.sendLandedAs(a, photoRow(21))).toBe(false);
    expect(H.sendLandedAs(b, photoRow(21))).toBe(false);
    expect(H.landedSends([a, b], [photoRow(21)], []).size).toBe(0);
    const merged = H.mergeHistory([a, b], [photoRow(21)]);
    expect(merged.map((m) => m.id)).toEqual([21, a.id, b.id]);
    expect(merged.filter((m) => m.failed).map((m) => m.clientId)).toEqual(['cA', 'cB']);
  });

  test('a DM photo, which carries its picture on image_url, is held the same way', () => {
    const dmPhoto = { id: 'temp-1', text: '', message_type: 'image', image_url: 'data:image/jpeg;base64,AAA', senderId: ME, sender: 'You', clientId: 'cD', afterId: 20, pending: true };
    const hist = [{ id: 21, text: '', message_type: 'image', senderId: ME, sender: 'You', image_url: null, thumb_url: THUMB }];
    expect(H.mergeHistory([dmPhoto], hist).map((m) => m.id)).toEqual([21, 'temp-1']);
  });

  test('a row that carries the send\'s own client id is that send, and no other', () => {
    const a = photo(1700000000103, 'cA', { failed: true });
    expect(H.sendLandedAs(a, { ...photoRow(21), clientId: 'cA' })).toBe(true);
    expect(H.sendLandedAs(a, { ...photoRow(21), clientId: 'cB' })).toBe(false);
    expect(H.sendLandedAs({ ...a, clientId: undefined }, photoRow(21))).toBe(false);
  });

  test('text keeps the content rule: the same words are the same send', () => {
    const line = bubble(1700000000104, 'ok', { failed: true, afterId: 20 });
    expect(H.mergeHistory([line], [row(21, 'ok')]).map((m) => m.id)).toEqual([21]);
  });

  test('the reload store keeps the failed photo and still drops the failed line that landed', async () => {
    localStorage.clear();
    const failedPhoto = photo(1700000000105, 'cA', { failed: true });
    const failedLine = bubble(1700000000106, 'ok', { failed: true, afterId: 20, clientId: 'cT' });
    H.writeFailedFlockMessages(7, [failedPhoto, failedLine]);
    const run = liftedFlockLoader();
    const done = run.load(7);
    run.reads[0].resolve({ messages: [srv(21, '', { type: 'image', thumb: THUMB }), srv(22, 'ok')], readers: [], pins: [] });
    await done;
    expect(H.readFailedFlockMessages(7).map((m) => m.id)).toEqual([failedPhoto.id]);
    expect(run.state.flocks[0].messages.map((m) => m.id)).toEqual([21, 22, failedPhoto.id]);
    localStorage.clear();
  });

  test('a sending photo whose row a history read already brought in is taken down by its own echo', () => {
    // Without this the bubble spun forever: the echo found the row already on
    // screen and returned, after clearing the timer that would have failed it.
    const sending = photo(1700000000107, 'cA');
    const run = flockEcho({
      flocks: [{ id: 7, messages: [photoRow(21), sending] }],
      pending: [[sending.id, { flockId: 7, text: '', message_type: 'image', image: sending.image, clientId: 'cA', timer: 'timer-A' }]],
    });
    run.handler(flockWire(21, { message_type: 'image', image_url: sending.image, client_id: 'cA', status: 'sent' }));
    expect(run.state.flocks[0].messages.map((m) => m.id)).toEqual([21]);
    expect(run.pendingEchoRef.current.size).toBe(0);
    expect(run.state.timersCleared).toEqual(['timer-A']);
  });

  test("a failed photo's echo takes down that bubble and its stored copy, and leaves the other photo", () => {
    const a = photo(1700000000108, 'cA', { failed: true });
    const b = photo(1700000000109, 'cB', { failed: true });
    const run = flockEcho({ flocks: [{ id: 7, messages: [photoRow(21), a, b] }] });
    run.handler(flockWire(21, { message_type: 'image', image_url: b.image, client_id: 'cB' }));
    expect(run.state.flocks[0].messages.map((m) => m.id)).toEqual([21, a.id]);
    expect(run.state.flocks[0].messages[1].failed).toBe(true);
    expect(run.state.storeRemoved).toEqual([[7, b.id]]);
  });

  test('with no row on screen yet, the echo still settles the bubble in place', () => {
    const sending = photo(1700000000110, 'cA');
    const run = flockEcho({
      flocks: [{ id: 7, messages: [row(20, 'before'), sending] }],
      pending: [[sending.id, { flockId: 7, text: '', message_type: 'image', image: sending.image, clientId: 'cA', timer: 't' }]],
    });
    run.handler(flockWire(21, { message_type: 'image', image_url: sending.image, client_id: 'cA', status: 'sent' }));
    const settled = run.state.flocks[0].messages[1];
    expect([settled.id, settled.pending, settled.failed, settled.status]).toEqual([21, false, false, 'sent']);
  });

  test('the DM twin: a sending photo beside its own landed row goes with its echo', () => {
    const tempId = 'temp-1700000000111-abcde';
    const sending = { id: tempId, sender: 'You', senderId: ME, text: '', message_type: 'image', image_url: 'data:image/jpeg;base64,AAA', clientId: 'cD', afterId: 20, pending: true };
    const landed = { id: 21, sender: 'You', senderId: ME, text: '', message_type: 'image', image_url: null, thumb_url: THUMB };
    const run = dmEcho({
      threads: [{ userId: 5, name: 'Bo', messages: [landed, sending], unread: 0 }],
      pending: [[tempId, { userId: 5, payload: { text: '', message_type: 'image', image_url: sending.image_url, clientId: 'cD' }, timer: 'timer-D' }]],
    });
    run.handler(dmWire(21, { message_text: '', message_type: 'image', image_url: sending.image_url, client_id: 'cD' }));
    expect(run.state.threads[0].messages.map((m) => m.id)).toEqual([21]);
    expect(run.state.timersCleared).toEqual(['timer-D']);
    expect(run.state.listReads).toBe(0);
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
    expect(block).toMatch(/\(theirs\.has\(String\(m\.reply_to\.id\)\) \|\| saidByAny\(m\.reply_to\.senderId, them\)\) \? \{ \.\.\.m, reply_to: null \}/);
    expect(block).toMatch(/f\.pins\.filter\(p => !theirs\.has\(/);
  });
});

// ---------------------------------------------------------------------------
// 12. A block reaches quotes and pins of messages that are not loaded here
// ---------------------------------------------------------------------------
describe('a block takes the blocked person\'s words out of every quote and pin, loaded or not', () => {
  function block({ flocks, selectedFlockId = null }) {
    const state = { flocks, reads: [] };
    const noop = () => {};
    const handle = runLifted(`${liftCallback(appSource, 'handleUserBlocked')}\nreturn handleUserBlocked;`, {
      useCallback: (fn) => fn,
      blockedIdsRef: { current: new Set() },
      selectedDmId: null,
      selectedFlockId,
      setDirectMessages: noop,
      setSelectedDmId: noop,
      setCurrentScreen: noop,
      noteRetraction: H.noteRetraction,
      retractionsRef: { current: { seq: 0, log: [] } },
      setFlocks: setterOn(state, 'flocks'),
      saidByAny: H.saidByAny,
      setFlockReplyingTo: noop,
      setFriendsPulses: noop,
      setPendingRequests: noop,
      setOutgoingRequests: noop,
      setAddFriendsResults: noop,
      setFriendSuggestions: noop,
      setConnectResults: noop,
      setContactsUsers: noop,
      setPhoneLookupUsers: noop,
      setFriendStatuses: noop,
      setFlockMemberLocations: noop,
      withoutPersonPin: (pins) => pins,
      setDmMemberLocation: noop,
      refreshFlockRoster: noop,
      loadFlockMessages: (id, opts) => state.reads.push([id, opts]),
      loadBlockedUsers: noop,
    });
    return { state, handle };
  }

  // Cy (9) said "door code 4411" far enough back that it is not loaded here;
  // Ava quoted it, and somebody pinned it. Bo (2) is not blocked.
  const scrollback = () => ([
    {
      id: 7,
      messages: [
        row(60, 'that still work?', { reply: { id: 3, text: 'door code 4411', sender: 'Cy', senderId: 9 } }),
        row(61, 'agreed', { senderId: 2, reply: { id: 4, text: 'meet at 9', sender: 'Bo', senderId: 2 } }),
        row(62, 'also Cy', { senderId: 9 }),
      ],
      pins: [
        { id: 3, messageId: 3, text: 'door code 4411', senderId: 9 },
        { id: 4, messageId: 4, text: 'meet at 9', senderId: 2 },
      ],
    },
    // A plan that is not open is cleaned the same way.
    { id: 8, messages: [row(70, 'lol', { reply: { id: 5, text: 'Cy again', sender: 'Cy', senderId: 9 } })], pins: [] },
  ]);

  test('by the author id on the quote and on the pin', () => {
    const run = block({ flocks: scrollback(), selectedFlockId: 7 });
    run.handle(9);
    const [open, other] = run.state.flocks;
    expect(open.messages.map((m) => m.id)).toEqual([60, 61]);
    expect(open.messages[0].reply_to).toBeNull();
    expect(open.messages[1].reply_to).toEqual({ id: 4, text: 'meet at 9', sender: 'Bo', senderId: 2 });
    expect(open.pins.map((p) => p.messageId)).toEqual([4]);
    expect(other.messages[0].reply_to).toBeNull();
    // And the open chat is read again, which overtakes any read in flight.
    expect(run.state.reads).toEqual([[7, { keepOlder: true }]]);
  });

  test('a quote from a server that does not send the id is left to the loaded-row check', () => {
    const flocks = [{ id: 7, messages: [row(60, 'hm', { reply: { id: 3, text: 'x', sender: 'Cy' } })], pins: [] }];
    const run = block({ flocks });
    run.handle(9);
    // Nothing here can be tied to them, so the plan is handed back untouched.
    expect(run.state.flocks[0]).toBe(flocks[0]);
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
// 11. A read from before a block, answering after it
// ---------------------------------------------------------------------------
describe('a read from before a block does not bring back the blocked person\'s pins and quotes', () => {
  const blockedSince = () => H.retractedSince([{ seq: 1, senderId: 9 }], 0, 'flock');

  test('the row mapper keeps the quoted author, and says null when the server does not', () => {
    const withId = H.mapFlockRow(srv(30, 'yes', { reply: { id: 3, message_text: 'x', message_type: 'text', sender_name: 'Cy', sender_id: 9 } }), ME);
    expect(withId.reply_to).toEqual({ id: 3, text: 'x', sender: 'Cy', senderId: 9, message_type: 'text' });
    const without = H.mapFlockRow(srv(31, 'yes', { reply: { id: 3, message_text: 'x', sender_name: 'Cy' } }), ME);
    expect(without.reply_to.senderId).toBeNull();
  });

  test('a quote of their words goes even when the quoted message is not on the page', () => {
    const hist = [
      row(30, 'about that', { reply: { id: 3, text: 'door code 4411', sender: 'Cy', senderId: 9 } }),
      row(31, 'agreed', { reply: { id: 4, text: 'meet at 9', sender: 'Bo', senderId: 2 } }),
      // A server that predates the id: nothing to tie it to, so it stays.
      row(32, 'hm', { reply: { id: 5, text: 'x', sender: 'Cy' } }),
    ];
    const out = H.dropRetracted(hist, blockedSince());
    expect(out.map((m) => [m.id, m.reply_to && m.reply_to.id])).toEqual([[30, null], [31, 4], [32, 5]]);
  });

  test('so does a pin of their words, and a pin of a row the answer just dropped', () => {
    const pins = [
      { id: 3, messageId: 3, text: 'door code 4411', senderId: 9 },
      { id: 4, messageId: 4, text: 'meet at 9', senderId: 2 },
      { id: 6, messageId: 6, text: 'unsent', senderId: 2 },
    ];
    expect(H.dropRetractedPins(pins, new Set(['6']), blockedSince()).map((p) => p.id)).toEqual([4]);
    // Nothing to drop: the same list back, so nothing re-renders.
    expect(H.dropRetractedPins(pins, new Set(), null)).toBe(pins);
    expect(H.dropRetractedPins(pins, new Set(), H.retractedSince([{ seq: 1, senderId: 77 }], 0, 'flock'))).toBe(pins);
  });

  test('a read in flight across a block, with nothing newer, still answers without their words', async () => {
    const run = liftedFlockLoader();
    const pending = run.load(7);
    H.noteRetraction(run.retractionsRef, { senderId: 9 });
    run.reads[0].resolve({
      messages: [
        srv(50, 'that still work?', { reply: { id: 3, message_text: 'door code 4411', sender_name: 'Cy', sender_id: 9 } }),
        srv(51, 'lol', { senderId: 9, name: 'Cy' }),
      ],
      readers: [],
      pins: [{ id: 3, messageId: 3, text: 'door code 4411', senderId: 9 }, { id: 4, messageId: 4, text: 'meet at 9', senderId: 2 }],
    });
    await pending;
    const flock = run.state.flocks[0];
    expect(flock.messages.map((m) => m.id)).toEqual([50]);
    expect(flock.messages[0].reply_to).toBeNull();
    expect(flock.pins.map((p) => p.messageId)).toEqual([4]);
  });

  test('an answer a later read of the same chat has overtaken changes nothing', async () => {
    const run = liftedFlockLoader();
    const first = run.load(7, { showSpinner: true });
    const second = run.load(7, { keepOlder: true });
    run.reads[1].resolve({ messages: [srv(40, 'newest')], readers: [], pins: [] });
    await second;
    // The older answer lands last, carrying the pins and the page as they
    // stood before whatever the newer read already knew about.
    run.reads[0].resolve({
      messages: [srv(39, 'from before', { senderId: 9, name: 'Cy' })],
      readers: [{ userId: 9 }],
      pins: [{ id: 39, messageId: 39, text: 'from before', senderId: 9 }],
    });
    await first;
    expect(run.state.flocks[0].messages.map((m) => m.id)).toEqual([40]);
    expect(run.state.flocks[0].pins).toEqual([]);
    expect(run.state.flocks[0].readers).toEqual([]);
    expect(run.state.acks).toEqual([[7, 40]]);
  });

  test('nor does its failure: the later read owns the error line', async () => {
    const run = liftedFlockLoader();
    const first = run.load(7);
    const second = run.load(7);
    run.reads[1].resolve({ messages: [srv(40, 'newest')], readers: [], pins: [] });
    await second;
    run.reads[0].reject(new Error('The request timed out.'));
    await first;
    expect(run.state.errors).toEqual([]);
    expect(run.state.flocks[0].messages.map((m) => m.id)).toEqual([40]);
  });

  test('a read of a different chat is not overtaken by this one', async () => {
    const run = liftedFlockLoader([{ id: 7, messages: [], pins: [] }, { id: 8, messages: [], pins: [] }]);
    const a = run.load(7);
    const b = run.load(8);
    run.reads[1].resolve({ messages: [srv(80, 'in eight')], readers: [], pins: [] });
    run.reads[0].resolve({ messages: [srv(70, 'in seven')], readers: [], pins: [] });
    await Promise.all([a, b]);
    expect(run.state.flocks.map((f) => f.messages.map((m) => m.id))).toEqual([[70], [80]]);
  });

  test('the DM twin keeps the same place in line', () => {
    const dmLoader = between(appSource, 'const loadDmMessages = useCallback', '// ── Scrollback ──');
    expect(dmLoader).toMatch(/historyReadSeqRef\.current\[`dm:\$\{userId\}`\] = turn;/);
    expect((dmLoader.match(/if \(overtaken\(\)\) return;/g) || []).length).toBe(2);
  });

  test('a live pin list cut just before a block does not put their pin back', () => {
    const state = { flocks: [{ id: 7, pins: [] }] };
    const handler = runLifted(`return ${liftListener(appSource, 'const unsubPins = onFlockPinsChanged(')};`, {
      saidByAny: H.saidByAny,
      blockedIdsRef: { current: new Set(['9']) },
      setFlocks: setterOn(state, 'flocks'),
    });
    handler({ flockId: 7, pins: [{ id: 3, messageId: 3, senderId: 9 }, { id: 4, messageId: 4, senderId: 2 }] });
    expect(state.flocks[0].pins.map((p) => p.id)).toEqual([4]);
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

// ---------------------------------------------------------------------------
// 14. A photo sent over REST whose row a history read already brought in
// ---------------------------------------------------------------------------
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const PHOTO = 'data:image/jpeg;base64,PHOTO';
const PHOTO_THUMB = 'data:image/jpeg;base64,THUMB';

// The two send paths, lifted and run with the socket down, so each send goes
// over REST and waits for a test to answer it: sends[n] is the nth POST's
// { resolve, reject }.
function liftedFlockTransmit(flocks) {
  const state = { flocks, toasts: [], failedStored: [] };
  const sends = [];
  const transmit = runLifted(`${liftCallback(appSource, 'transmitFlockMessage')}\nreturn transmitFlockMessage;`, {
    useCallback: (fn) => fn,
    makeChatThumb: async () => PHOTO_THUMB,
    newClientId: H.newClientId,
    newestServerId: H.newestServerId,
    flocksRef: { get current() { return state.flocks; } },
    addMessageToFlock: (flockId, msg) => {
      state.flocks = state.flocks.map((f) => (f.id === flockId ? { ...f, messages: [...(f.messages || []), msg] } : f));
    },
    authUser: { id: ME },
    profilePicRef: { current: null },
    getSocket: () => null,
    socketSendMessage: () => { throw new Error('the socket is down, so nothing goes on it'); },
    trackFlockMessageSent: () => {},
    pendingEchoRef: { current: new Map() },
    sendFailuresRef: { current: new Map() },
    setFlocks: setterOn(state, 'flocks'),
    persistFailedFlockMessage: (flockId, msg) => state.failedStored.push([flockId, msg.id]),
    apiSendMessage: () => new Promise((resolve, reject) => { sends.push({ resolve, reject }); }),
    isServerId: H.isServerId,
    orderByServerId: H.orderByServerId,
    showToast: (message) => state.toasts.push(message),
  });
  return { state, sends, transmit };
}

function liftedDmTransmit(threads) {
  const state = { threads, toasts: [], notConnected: {} };
  const sends = [];
  const transmit = runLifted(`${liftCallback(appSource, 'transmitDm')}\nreturn transmitDm;`, {
    useCallback: (fn) => fn,
    makeChatThumb: async () => PHOTO_THUMB,
    newClientId: H.newClientId,
    authUser: { id: ME },
    setDirectMessages: setterOn(state, 'threads'),
    newestServerId: H.newestServerId,
    messagePreview: H.messagePreview,
    orderByServerId: H.orderByServerId,
    isServerId: H.isServerId,
    getSocket: () => null,
    socketSendDm: () => { throw new Error('the socket is down, so nothing goes on it'); },
    trackDmSent: () => {},
    dmEchoRef: { current: new Map() },
    apiSendDM: () => new Promise((resolve, reject) => { sends.push({ resolve, reject }); }),
    setDmNotConnected: setterOn(state, 'notConnected'),
    NOT_CONNECTED_HINT: H.NOT_CONNECTED_HINT,
    showToast: (message) => state.toasts.push(message),
  });
  return { state, sends, transmit };
}

// A DM row as GET /api/dm/:userId sends it, through the app's own mapper.
const dmHistoryRow = (id, text, { senderId = ME, type = 'text', thumb = null } = {}) => H.mapDmRow({
  id, sender_id: senderId, receiver_id: senderId === ME ? 5 : ME, sender_name: senderId === ME ? 'Ava' : 'Bo',
  message_text: text, message_type: type, created_at: AT, ...(thumb ? { thumb_url: thumb } : {}),
}, ME);

describe('a photo sent over REST whose row a history read already brought in', () => {
  test('the answer takes the bubble down instead of giving it the id of the row beside it', async () => {
    const run = liftedFlockTransmit([{ id: 7, messages: [row(20, 'before')] }]);
    const done = run.transmit(7, '', { image_url: PHOTO });
    await flush();
    expect(run.sends).toHaveLength(1);
    const bubbleId = run.state.flocks[0].messages.find((m) => m.pending).id;
    // A read lands while the POST is out (a reconnect's catch-up, a way back
    // into the chat). It carries the photo's row and, rightly, leaves the
    // bubble up: no stored row settles a photo (10).
    const landed = row(21, '', { type: 'image', thumb: PHOTO_THUMB });
    run.state.flocks = [{ ...run.state.flocks[0], messages: H.mergeHistory(run.state.flocks[0].messages, [row(20, 'before'), landed]) }];
    expect(run.state.flocks[0].messages.map((m) => m.id)).toEqual([20, 21, bubbleId]);
    run.sends[0].resolve({ message: { id: 21, created_at: AT, status: 'sent' } });
    await done;
    // One row under id 21, the server's, where there used to be two.
    expect(run.state.flocks[0].messages.map((m) => m.id)).toEqual([20, 21]);
    expect(run.state.flocks[0].messages[1]).toBe(landed);
  });

  test('with no row here yet, the answer still gives the bubble its id', async () => {
    const run = liftedFlockTransmit([{ id: 7, messages: [row(20, 'before')] }]);
    const done = run.transmit(7, '', { image_url: PHOTO });
    await flush();
    run.sends[0].resolve({ message: { id: 21, created_at: AT, status: 'sent' } });
    await done;
    const settled = run.state.flocks[0].messages[1];
    expect(run.state.flocks[0].messages).toHaveLength(2);
    expect([settled.id, settled.pending, settled.status, settled.sentAt, settled.image]).toEqual([21, false, 'sent', AT, PHOTO]);
  });

  test('an echo that settled the bubble first is left as it is', async () => {
    const run = liftedFlockTransmit([{ id: 7, messages: [row(20, 'before')] }]);
    const done = run.transmit(7, '', { image_url: PHOTO });
    await flush();
    // The socket came back in time to hear the account echo, which settled
    // the bubble in place under the row's id.
    const f = run.state.flocks[0];
    run.state.flocks = [{ ...f, messages: f.messages.map((m) => (m.pending ? { ...m, id: 21, pending: false, status: 'sent' } : m)) }];
    run.sends[0].resolve({ message: { id: 21, created_at: AT, status: 'sent' } });
    await done;
    expect(run.state.flocks[0].messages.map((m) => [m.id, m.image || null])).toEqual([[20, null], [21, PHOTO]]);
  });

  test('the DM twin: the answer takes the bubble down when the thread already holds its row', async () => {
    const run = liftedDmTransmit([{ userId: 5, name: 'Bo', messages: [dmHistoryRow(20, 'before', { senderId: 5 })], unread: 0 }]);
    await run.transmit(5, { text: '', message_type: 'image', image_url: PHOTO });
    expect(run.sends).toHaveLength(1);
    const bubbleId = run.state.threads[0].messages.find((m) => m.pending).id;
    const landed = dmHistoryRow(21, '', { type: 'image', thumb: PHOTO_THUMB });
    const thread = run.state.threads[0];
    run.state.threads = [{ ...thread, messages: H.mergeHistory(thread.messages, [dmHistoryRow(20, 'before', { senderId: 5 }), landed]) }];
    expect(run.state.threads[0].messages.map((m) => m.id)).toEqual([20, 21, bubbleId]);
    run.sends[0].resolve({ message: { id: 21, created_at: AT, status: 'sent' } });
    await flush();
    expect(run.state.threads[0].messages.map((m) => m.id)).toEqual([20, 21]);
    expect(run.state.threads[0].messages[1]).toBe(landed);
  });

  test('the DM twin with no row here yet still gives the bubble its id', async () => {
    const run = liftedDmTransmit([{ userId: 5, name: 'Bo', messages: [dmHistoryRow(20, 'before', { senderId: 5 })], unread: 0 }]);
    await run.transmit(5, { text: '', message_type: 'image', image_url: PHOTO });
    run.sends[0].resolve({ message: { id: 21, created_at: AT, status: 'sent' } });
    await flush();
    const settled = run.state.threads[0].messages[1];
    expect(run.state.threads[0].messages).toHaveLength(2);
    expect([settled.id, settled.pending, settled.status, settled.sentAt, settled.image_url]).toEqual([21, false, 'sent', AT, PHOTO]);
  });
});

// ---------------------------------------------------------------------------
// 15. A live row built before a block keeps no quote of the blocked person
// ---------------------------------------------------------------------------
describe('a live row built before a block does not bring back a quote of the blocked person', () => {
  // Cy (9) is blocked by the time these rows land. Bo (2) is not.
  const quoteOf = (id, text, senderId, name) => ({ id, message_text: text, message_type: 'text', sender_id: senderId, sender_name: name });

  test("somebody else's reply quoting them lands, without the quote, in a plan nobody re-read", () => {
    const run = flockEcho({ flocks: [{ id: 7, messages: [row(20, 'earlier', { senderId: 2 })] }], blocked: [9] });
    run.handler(flockWire(30, { sender_id: 2, sender_name: 'Bo', message_text: 'still on?', reply_to: quoteOf(3, 'door code 4411', 9, 'Cy') }));
    const landed = run.state.flocks[0].messages.find((m) => m.id === 30);
    expect(landed.text).toBe('still on?');
    expect(landed.reply_to).toBeNull();
  });

  test('a quote of anybody else stays, and so does one from a server that sends no author', () => {
    const run = flockEcho({ flocks: [{ id: 7, messages: [] }], blocked: [9] });
    run.handler(flockWire(31, { sender_id: 2, sender_name: 'Bo', message_text: 'yes', reply_to: quoteOf(4, 'meet at 9', 2, 'Bo') }));
    const noAuthor = { id: 5, message_text: 'x', message_type: 'text', sender_name: 'Cy' };
    run.handler(flockWire(32, { sender_id: 2, sender_name: 'Bo', message_text: 'hm', reply_to: noAuthor }));
    const [kept, legacy] = run.state.flocks[0].messages;
    expect(kept.reply_to).toEqual({ id: 4, text: 'meet at 9', sender: 'Bo', senderId: 2, message_type: 'text' });
    expect(legacy.reply_to.id).toBe(5);
  });

  test('your own message from another device, quoting them, lands without the quote', () => {
    const run = flockEcho({ flocks: [{ id: 7, messages: [] }], blocked: [9] });
    run.handler(flockWire(33, { message_text: 'from my phone', reply_to: quoteOf(3, 'door code 4411', 9, 'Cy') }));
    const [own] = run.state.flocks[0].messages;
    expect([own.id, own.sender, own.text, own.reply_to]).toEqual([33, 'You', 'from my phone', null]);
  });

  test('with nobody blocked the quote arrives whole', () => {
    const run = flockEcho({ flocks: [{ id: 7, messages: [] }] });
    run.handler(flockWire(34, { sender_id: 2, sender_name: 'Bo', message_text: 'still on?', reply_to: quoteOf(3, 'door code 4411', 9, 'Cy') }));
    expect(run.state.flocks[0].messages[0].reply_to).toEqual({ id: 3, text: 'door code 4411', sender: 'Cy', senderId: 9, message_type: 'text' });
  });

  test('a DM quote carries its author, reloaded and live alike', () => {
    const quote = { id: 40, message_text: 'meet me', sender_id: 5, sender_name: 'Bo' };
    const reloaded = H.mapDmRow({ id: 41, sender_id: ME, receiver_id: 5, message_text: 'ok', created_at: AT, reply_to: quote }, ME);
    expect(reloaded.reply_to).toEqual({ id: 40, text: 'meet me', sender: 'Bo', senderId: 5 });
    const noAuthor = { id: 40, message_text: 'meet me', sender_name: 'Bo' };
    expect(H.mapDmRow({ id: 42, sender_id: ME, receiver_id: 5, message_text: 'ok', created_at: AT, reply_to: noAuthor }, ME).reply_to.senderId).toBeNull();
    const run = dmEcho({ threads: [{ userId: 5, name: 'Bo', messages: [], unread: 0 }] });
    run.handler(dmWire(43, { message_text: 'ok', reply_to: quote }));
    expect(run.state.threads[0].messages[0].reply_to).toEqual(reloaded.reply_to);
  });

  test('your own DM echo, in a thread emptied for the person who was blocked, lands without their words', () => {
    // Bo (5) blocked this account, so the thread was emptied and left open
    // under the notice that it is closed. Your own reply to Bo, sent from
    // another device a moment before, is exempt from the sender check.
    const run = dmEcho({ threads: [{ userId: 5, name: 'Bo', messages: [], unread: 0 }], blocked: [5] });
    run.handler(dmWire(44, { message_text: 'on my way', reply_to: { id: 40, message_text: 'where are you', sender_id: 5, sender_name: 'Bo' } }));
    const [own] = run.state.threads[0].messages;
    expect([own.id, own.text, own.reply_to]).toEqual([44, 'on my way', null]);
    // A quote of your own words is not theirs, and stays.
    run.handler(dmWire(45, { message_text: 'as I said', reply_to: { id: 39, message_text: 'running late', sender_id: ME, sender_name: 'Ava' } }));
    expect(run.state.threads[0].messages[1].reply_to).toEqual({ id: 39, text: 'running late', sender: 'Ava', senderId: ME });
  });
});

// ---------------------------------------------------------------------------
// 16. Two reads of the DM list answering out of order
// ---------------------------------------------------------------------------
describe('two reads of the DM list answering out of order', () => {
  const conv = (userId, name, over = {}) => ({
    userId, name, image: null, lastMessage: 'hi', lastMessageTime: AT, lastMessageIsYou: false, unread: 0, ...over,
  });

  // loadDmConversations, lifted and run, with each request left open until a
  // test answers it: reads[n] is the nth read's { resolve, reject }.
  function liftedDmListLoader(threads = []) {
    const state = { threads, loading: [], error: null, deleted: [] };
    const reads = [];
    const load = runLifted(`${liftCallback(appSource, 'loadDmConversations')}\nreturn loadDmConversations;`, {
      useCallback: (fn) => fn,
      dmListReadSeqRef: { current: 0 },
      setDmsLoading: (value) => state.loading.push(value),
      setDmsError: (message) => { state.error = message; },
      getDMConversations: () => new Promise((resolve, reject) => { reads.push({ resolve, reject }); }),
      deletedDmUserIdsRef: { current: [] },
      setDeletedDmUserIds: setterOn(state, 'deleted'),
      setDirectMessages: setterOn(state, 'threads'),
      // Nobody is blocked in these; 19 below runs the blocks.
      retractionsRef: { current: { seq: 0, log: [] } },
      retractedSince: H.retractedSince,
    });
    return { state, reads, load };
  }

  test('an older answer landing last does not take away the thread the newer one brought in', async () => {
    const run = liftedDmListLoader([{ ...conv(5, 'Bo'), messages: [] }]);
    // A reconnect's read leaves first, before your message from another
    // device is stored. That message's echo, for a thread this device does
    // not hold, starts the second.
    const reconnectRead = run.load();
    const echoRead = run.load();
    run.reads[1].resolve({ conversations: [conv(8, 'Di', { lastMessageIsYou: true }), conv(5, 'Bo')] });
    await echoRead;
    expect(run.state.threads.map((d) => d.userId)).toEqual([8, 5]);
    run.reads[0].resolve({ conversations: [conv(5, 'Bo')] });
    await reconnectRead;
    expect(run.state.threads.map((d) => d.userId)).toEqual([8, 5]);
  });

  test('the loading flag stays up until the newest read answers, then comes down once', async () => {
    const run = liftedDmListLoader([]);
    const first = run.load();
    const second = run.load();
    run.reads[0].resolve({ conversations: [conv(5, 'Bo')] });
    await first;
    expect(run.state.loading).toEqual([true, true]);
    expect(run.state.threads).toEqual([]);
    run.reads[1].resolve({ conversations: [conv(5, 'Bo'), conv(8, 'Di')] });
    await second;
    expect(run.state.loading).toEqual([true, true, false]);
    expect(run.state.threads.map((d) => d.userId)).toEqual([5, 8]);
  });

  test("an overtaken read's failure says nothing, and the newest read's failure still does", async () => {
    const run = liftedDmListLoader([]);
    const first = run.load();
    const second = run.load();
    run.reads[1].resolve({ conversations: [conv(5, 'Bo')] });
    await second;
    run.reads[0].reject(new Error('The request timed out.'));
    await first;
    expect(run.state.error).toBe('');
    expect(run.state.loading).toEqual([true, true, false]);
    const third = run.load();
    run.reads[2].reject(new Error('The request timed out.'));
    await third;
    expect(run.state.error).toBe('The request timed out.');
    expect(run.state.loading[run.state.loading.length - 1]).toBe(false);
    // The list on screen is left as the last good answer had it.
    expect(run.state.threads.map((d) => d.userId)).toEqual([5]);
  });
});

// ---------------------------------------------------------------------------
// 17. A pin or unpin answer cut before a block
// ---------------------------------------------------------------------------
describe('a pin or unpin answer cut before a block does not put their pin back', () => {
  // applyPins and the two taps that call it, lifted and run. Each answer
  // waits for a test to give it: answers[n] resolves the nth request.
  function liftedPins(flocks) {
    const state = { flocks, toasts: [] };
    const blockedIdsRef = { current: new Set() };
    const answers = [];
    const applyPins = runLifted(`${liftCallback(appSource, 'applyPins')}\nreturn applyPins;`, {
      useCallback: (fn) => fn,
      setFlocks: setterOn(state, 'flocks'),
      saidByAny: H.saidByAny,
      blockedIdsRef,
    });
    const answer = () => new Promise((resolve) => { answers.push(resolve); });
    const scope = {
      useCallback: (fn) => fn,
      applyPins,
      showToast: (message) => state.toasts.push(message),
      apiPinFlockMessage: answer,
      apiUnpinFlockMessage: answer,
    };
    return {
      state,
      blockedIdsRef,
      answers,
      pinMessage: runLifted(`${liftCallback(appSource, 'pinMessage')}\nreturn pinMessage;`, scope),
      unpinMessage: runLifted(`${liftCallback(appSource, 'unpinMessage')}\nreturn unpinMessage;`, scope),
    };
  }
  // A pin as the route's pinPayload shapes it.
  const pinOf = (id, senderId) => ({ id, messageId: id, text: `line ${id}`, messageType: 'text', senderId, senderName: 'x', pinnedBy: ME });

  test('a block that lands while a pin is on its way keeps their pin off the bar', async () => {
    const run = liftedPins([{ id: 7, pins: [] }]);
    const pending = run.pinMessage(7, 4);
    run.blockedIdsRef.current.add('9');
    run.answers[0]([pinOf(3, 9), pinOf(4, 2)]);
    await pending;
    expect(run.state.flocks[0].pins.map((p) => p.id)).toEqual([4]);
    expect(run.state.toasts).toEqual([]);
  });

  test('and while an unpin is', async () => {
    const run = liftedPins([{ id: 7, pins: [pinOf(4, 2), pinOf(6, 2)] }]);
    const pending = run.unpinMessage(7, 6);
    run.blockedIdsRef.current.add('9');
    run.answers[0]([pinOf(3, 9), pinOf(4, 2)]);
    await pending;
    expect(run.state.flocks[0].pins.map((p) => p.id)).toEqual([4]);
  });

  test('with nobody blocked the list is the server\'s, whole and in its order', async () => {
    const run = liftedPins([{ id: 7, pins: [] }, { id: 8, pins: [pinOf(9, 2)] }]);
    const pending = run.pinMessage(7, 4);
    run.answers[0]([pinOf(3, 9), pinOf(4, 2)]);
    await pending;
    expect(run.state.flocks.map((f) => f.pins.map((p) => p.id))).toEqual([[3, 4], [9]]);
  });
});

// settleSendFailures, lifted: what runs as each render commits and carries out
// what a send's failure update decided, the toast and the copy in the reload
// store, or nothing at all (App.js, sendFailuresRef). 18 and 20 call it on
// every commit, as the app's layout effect does.
function liftedSettleSendFailures(sendFailuresRef) {
  return runLifted(`${liftCallback(appSource, 'settleSendFailures')}\nreturn settleSendFailures;`, {
    useCallback: (fn) => fn,
    sendFailuresRef,
  });
}

// ---------------------------------------------------------------------------
// 18. A socket send that landed, lost its echo, and was brought in by a read
// ---------------------------------------------------------------------------
describe('a send delivered while its echo was lost never comes back as a failed copy', () => {
  // The send path and the history read, lifted and run over ONE state, so the
  // read settles the bubble the send drew. The socket is up and takes the
  // send; its echo is what never arrives. The failure timer is held so a test
  // can fire it: timers[n] is the nth timer's { fn, ms }. Every update here
  // renders and commits at once, and settleSendFailures runs on each commit
  // as it does in the app. The reload store is the real one, in jsdom's
  // localStorage.
  function liftedSocketSendAndRead(flocks) {
    const state = { flocks, errors: [], acks: [], toasts: [] };
    const timers = [];
    const reads = [];
    const pendingEchoRef = { current: new Map() };
    const sendFailuresRef = { current: new Map() };
    const settle = liftedSettleSendFailures(sendFailuresRef);
    const commit = (next) => { setterOn(state, 'flocks')(next); settle(state.flocks); };
    const flocksRef = { get current() { return state.flocks; } };
    const transmit = runLifted(`${liftCallback(appSource, 'transmitFlockMessage')}\nreturn transmitFlockMessage;`, {
      useCallback: (fn) => fn,
      makeChatThumb: async () => PHOTO_THUMB,
      newClientId: H.newClientId,
      newestServerId: H.newestServerId,
      flocksRef,
      addMessageToFlock: (flockId, msg) => {
        state.flocks = state.flocks.map((f) => (f.id === flockId ? { ...f, messages: [...(f.messages || []), msg] } : f));
      },
      authUser: { id: ME },
      profilePicRef: { current: null },
      getSocket: () => ({ connected: true }),
      socketSendMessage: () => true,
      trackFlockMessageSent: () => {},
      pendingEchoRef,
      sendFailuresRef,
      setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
      setFlocks: commit,
      persistFailedFlockMessage: H.persistFailedFlockMessage,
      apiSendMessage: () => { throw new Error('the socket took this send, so REST is never asked'); },
      isServerId: H.isServerId,
      orderByServerId: H.orderByServerId,
      showToast: (message) => state.toasts.push(message),
    });
    const load = runLifted(`${liftCallback(appSource, 'loadFlockMessages')}\nreturn loadFlockMessages;`, {
      useCallback: (fn) => fn,
      historyReadAtRef: { current: {} },
      historyReadSeqRef: { current: {} },
      retractionsRef: { current: { seq: 0, log: [] } },
      setMessagesLoading: () => {},
      setMessagesError: (e) => { if (e) state.errors.push(e); },
      getMessages: () => new Promise((resolve, reject) => { reads.push({ resolve, reject }); }),
      mapFlockRow: H.mapFlockRow,
      meRef: { current: { id: ME } },
      retractedSince: H.retractedSince,
      readFailedFlockMessages: H.readFailedFlockMessages,
      flocksRef,
      isServerId: H.isServerId,
      landedSends: H.landedSends,
      writeFailedFlockMessages: H.writeFailedFlockMessages,
      setFlockAtTop: () => {},
      retractedIdsIn: H.retractedIdsIn,
      dropRetractedPins: H.dropRetractedPins,
      setFlocks: commit,
      mergeHistory: H.mergeHistory,
      sendFlockAck: (flockId, id) => state.acks.push([flockId, id]),
    });
    // One history read, answered with these rows.
    const readWith = async (rows) => {
      const done = load(7);
      reads[reads.length - 1].resolve({ messages: rows, readers: [], pins: [] });
      await done;
    };
    return { state, timers, pendingEchoRef, transmit, readWith };
  }

  const ids = (run) => run.state.flocks[0].messages.map((m) => m.id);

  beforeEach(() => localStorage.clear());
  afterAll(() => localStorage.clear());

  test('the read took the bubble down, so the timer fails nothing and stores nothing', async () => {
    const run = liftedSocketSendAndRead([{ id: 7, messages: [row(20, 'before')], pins: [] }]);
    await run.transmit(7, 'on my way');
    expect(run.state.flocks[0].messages[1].pending).toBe(true);
    expect(run.timers.map((t) => t.ms)).toEqual([8000]);
    // No echo. The reconnect's catch-up read answers with the stored row.
    await run.readWith([srv(20, 'before'), srv(21, 'on my way')]);
    expect(ids(run)).toEqual([20, 21]);
    // Eight seconds after the send, the timer fires.
    run.timers[0].fn();
    expect(run.pendingEchoRef.current.size).toBe(0);
    expect(H.readFailedFlockMessages(7)).toEqual([]);
    expect(ids(run)).toEqual([20, 21]);
    // The chat opened again: one row, delivered, and no copy offering a retry.
    await run.readWith([srv(20, 'before'), srv(21, 'on my way')]);
    expect(ids(run)).toEqual([20, 21]);
    expect(run.state.flocks[0].messages.filter((m) => m.failed || m.pending)).toEqual([]);
    expect(run.state.toasts).toEqual([]);
  });

  test('a send no read has accounted for still fails, and is kept for the next launch', async () => {
    const run = liftedSocketSendAndRead([{ id: 7, messages: [row(20, 'before')], pins: [] }]);
    await run.transmit(7, 'on my way');
    const bubbleId = run.state.flocks[0].messages[1].id;
    // A read lands without the row: this send really did not arrive.
    await run.readWith([srv(20, 'before')]);
    run.timers[0].fn();
    const bubble = run.state.flocks[0].messages.find((m) => m.id === bubbleId);
    expect([bubble.pending, bubble.failed]).toEqual([false, true]);
    expect(H.readFailedFlockMessages(7).map((m) => [m.id, m.text, m.failed])).toEqual([[bubbleId, 'on my way', true]]);
    expect(run.pendingEchoRef.current.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 19. A read of the DM list that went out before a block
// ---------------------------------------------------------------------------
describe('a DM list read from before a block does not put the blocked person back', () => {
  const conv = (userId, name, over = {}) => ({
    userId, name, image: null, lastMessage: 'hi', lastMessageTime: AT, lastMessageIsYou: false, unread: 0, ...over,
  });
  const thread = (userId, name, over = {}) => ({ ...conv(userId, name, over), messages: [] });

  // loadDmConversations and handleUserBlocked, lifted and run over ONE list and
  // ONE retraction log, the way FlockAppInner holds them. Each list read waits
  // for a test to answer it: reads[n] is the nth read's { resolve, reject }.
  function liftedListAndBlock({ threads, selectedDmId = null, deleted = [] }) {
    const state = { threads, deleted, flocks: [], screens: [] };
    const reads = [];
    const noop = () => {};
    const retractionsRef = { current: { seq: 0, log: [] } };
    const load = runLifted(`${liftCallback(appSource, 'loadDmConversations')}\nreturn loadDmConversations;`, {
      useCallback: (fn) => fn,
      dmListReadSeqRef: { current: 0 },
      setDmsLoading: noop,
      setDmsError: noop,
      getDMConversations: () => new Promise((resolve, reject) => { reads.push({ resolve, reject }); }),
      deletedDmUserIdsRef: { get current() { return state.deleted; } },
      setDeletedDmUserIds: setterOn(state, 'deleted'),
      setDirectMessages: setterOn(state, 'threads'),
      retractionsRef,
      retractedSince: H.retractedSince,
    });
    const block = runLifted(`${liftCallback(appSource, 'handleUserBlocked')}\nreturn handleUserBlocked;`, {
      useCallback: (fn) => fn,
      blockedIdsRef: { current: new Set() },
      selectedDmId,
      selectedFlockId: null,
      setDirectMessages: setterOn(state, 'threads'),
      setSelectedDmId: noop,
      setCurrentScreen: (screen) => state.screens.push(screen),
      noteRetraction: H.noteRetraction,
      retractionsRef,
      setFlocks: setterOn(state, 'flocks'),
      saidByAny: H.saidByAny,
      setFlockReplyingTo: noop,
      setFriendsPulses: noop,
      setPendingRequests: noop,
      setOutgoingRequests: noop,
      setAddFriendsResults: noop,
      setFriendSuggestions: noop,
      setConnectResults: noop,
      setContactsUsers: noop,
      setPhoneLookupUsers: noop,
      setFriendStatuses: noop,
      setFlockMemberLocations: noop,
      withoutPersonPin: (pins) => pins,
      setDmMemberLocation: noop,
      refreshFlockRoster: noop,
      loadFlockMessages: noop,
      loadBlockedUsers: noop,
    });
    return { state, reads, load, block };
  }

  const listed = (run) => run.state.threads.map((d) => d.userId);

  afterAll(() => localStorage.clear());

  test('the person you just blocked is not recreated by a read that was already on its way', async () => {
    const run = liftedListAndBlock({ threads: [thread(5, 'Bo'), thread(9, 'Cy', { lastMessage: 'door code 4411' })] });
    // A reconnect's list read goes out and the server builds its answer.
    const read = run.load();
    // Then Cy is blocked, and the row comes off the list at once.
    run.block(9);
    expect(listed(run)).toEqual([5]);
    // The answer, built before the block, lands after it.
    run.reads[0].resolve({ conversations: [conv(9, 'Cy', { lastMessage: 'door code 4411', unread: 2 }), conv(5, 'Bo')] });
    await read;
    expect(listed(run)).toEqual([5]);
    expect(JSON.stringify(run.state.threads)).not.toMatch(/Cy|door code/);
  });

  test('nor is their thread undeleted by that answer', async () => {
    const run = liftedListAndBlock({ threads: [thread(5, 'Bo')], deleted: [9] });
    const read = run.load();
    run.block(9);
    // Unread messages would revive a deleted thread; from somebody blocked
    // since, they are not this answer's to count.
    run.reads[0].resolve({ conversations: [conv(9, 'Cy', { unread: 2 }), conv(5, 'Bo')] });
    await read;
    expect(run.state.deleted).toEqual([9]);
    expect(listed(run)).toEqual([5]);
  });

  test('for the person who was blocked, the thread left open stays exactly as the block left it', async () => {
    const run = liftedListAndBlock({
      threads: [thread(5, 'Bo'), { ...thread(9, 'Cy', { lastMessage: 'see you there' }), messages: [{ id: 40, text: 'see you there' }] }],
      selectedDmId: 9,
    });
    const read = run.load();
    // Cy blocked this account while the thread was open: emptied, kept, and
    // left on screen under its notice.
    run.block(9, { keepDmOpen: true });
    const kept = run.state.threads.find((d) => d.userId === 9);
    expect(kept.messages).toEqual([]);
    run.reads[0].resolve({ conversations: [conv(9, 'Cy', { lastMessage: 'see you there', unread: 3 }), conv(5, 'Bo')] });
    await read;
    expect(run.state.threads.find((d) => d.userId === 9)).toBe(kept);
    expect(run.state.screens).toEqual([]);
  });

  test("a read that went out after the block is the server's answer, taken whole", async () => {
    const run = liftedListAndBlock({ threads: [thread(5, 'Bo'), thread(9, 'Cy')] });
    run.block(9);
    // Unblocked since, somewhere: the server lists them again, and a read that
    // left after the block knows everything the block did.
    const read = run.load();
    run.reads[0].resolve({ conversations: [conv(9, 'Cy'), conv(5, 'Bo')] });
    await read;
    expect(listed(run)).toEqual([9, 5]);
  });
});

// ---------------------------------------------------------------------------
// 20. A send's failure is decided by the newest state, on both transports
// ---------------------------------------------------------------------------
describe("a send's failure is decided by the newest state, whatever the transport", () => {
  // The send path, the history read and the live echo, lifted and run over
  // ONE state the way React holds it: `rendered` is what the last render
  // committed and all that flocksRef can see, setFlocks only queues an update
  // for the next render(), and each render() ends with settleSendFailures, as
  // the app's layout effect does on every commit. The failure timer is held
  // (timers[n]) and fireDue() fires every one still set; each request waits
  // for a test to answer it (posts[n]); the reload store is the real one, in
  // jsdom's localStorage.
  function liftedSendReadAndEcho({ socketUp }) {
    const state = { rendered: [{ id: 7, messages: [row(20, 'before')], pins: [] }], queue: [], toasts: [], cleared: [] };
    const timers = [];
    const fired = new Set();
    const reads = [];
    const posts = [];
    const pendingEchoRef = { current: new Map() };
    const sendFailuresRef = { current: new Map() };
    const settle = liftedSettleSendFailures(sendFailuresRef);
    const flocksRef = { get current() { return state.rendered; } };
    const setFlocks = (next) => { state.queue.push(next); };
    const render = () => {
      for (const next of state.queue.splice(0)) state.rendered = typeof next === 'function' ? next(state.rendered) : next;
      settle(state.rendered);
    };
    const clearTimeout = (t) => state.cleared.push(t);
    const fireDue = () => {
      timers.forEach((t, i) => {
        const id = `timer-${i + 1}`;
        if (state.cleared.includes(id) || fired.has(id)) return;
        fired.add(id);
        t.fn();
      });
    };
    const transmit = runLifted(`${liftCallback(appSource, 'transmitFlockMessage')}\nreturn transmitFlockMessage;`, {
      useCallback: (fn) => fn,
      makeChatThumb: async () => PHOTO_THUMB,
      newClientId: H.newClientId,
      newestServerId: H.newestServerId,
      flocksRef,
      addMessageToFlock: (flockId, msg) => setFlocks((prev) => prev.map((f) => (f.id === flockId ? { ...f, messages: [...(f.messages || []), msg] } : f))),
      authUser: { id: ME },
      profilePicRef: { current: null },
      getSocket: () => ({ connected: socketUp }),
      socketSendMessage: () => socketUp,
      trackFlockMessageSent: () => {},
      pendingEchoRef,
      sendFailuresRef,
      setTimeout: (fn, ms) => { timers.push({ fn, ms }); return `timer-${timers.length}`; },
      setFlocks,
      persistFailedFlockMessage: H.persistFailedFlockMessage,
      apiSendMessage: () => new Promise((resolve, reject) => { posts.push({ resolve, reject }); }),
      isServerId: H.isServerId,
      orderByServerId: H.orderByServerId,
      showToast: (message) => state.toasts.push(message),
    });
    const load = runLifted(`${liftCallback(appSource, 'loadFlockMessages')}\nreturn loadFlockMessages;`, {
      useCallback: (fn) => fn,
      historyReadAtRef: { current: {} },
      historyReadSeqRef: { current: {} },
      retractionsRef: { current: { seq: 0, log: [] } },
      setMessagesLoading: () => {},
      setMessagesError: () => {},
      getMessages: () => new Promise((resolve, reject) => { reads.push({ resolve, reject }); }),
      mapFlockRow: H.mapFlockRow,
      meRef: { current: { id: ME } },
      retractedSince: H.retractedSince,
      readFailedFlockMessages: H.readFailedFlockMessages,
      flocksRef,
      isServerId: H.isServerId,
      landedSends: H.landedSends,
      writeFailedFlockMessages: H.writeFailedFlockMessages,
      setFlockAtTop: () => {},
      retractedIdsIn: H.retractedIdsIn,
      dropRetractedPins: H.dropRetractedPins,
      setFlocks,
      mergeHistory: H.mergeHistory,
      sendFlockAck: () => {},
    });
    const echo = runLifted(`return ${liftListener(appSource, 'const unsub = onNewMessage(')};`, {
      authUser: { id: ME },
      pendingEchoRef,
      echoMatches: H.echoMatches,
      flocksRef,
      removeFailedFlockMessage: H.removeFailedFlockMessage,
      setFlocks,
      mapFlockRow: H.mapFlockRow,
      withoutBlockedQuote: H.withoutBlockedQuote,
      orderByServerId: H.orderByServerId,
      blockedIdsRef: { current: new Set() },
      retractionsRef: { current: { seq: 0, log: [] } },
      catchUpTargetRef: { current: {} },
      clearTimeout,
    });
    // One history read, answered with these rows. Its merge is queued like
    // any update and shows only after the next render().
    const readWith = async (rows) => {
      const done = load(7);
      reads[reads.length - 1].resolve({ messages: rows, readers: [], pins: [] });
      await done;
    };
    const ids = () => state.rendered[0].messages.map((m) => m.id);
    const bubbleOf = (id) => state.rendered[0].messages.find((m) => m.id === id);
    return { state, timers, posts, transmit, readWith, echo, render, fireDue, ids, bubbleOf };
  }

  const delivered = [srv(20, 'before'), srv(21, 'on my way')];
  // What api.js rejects with when a request's answer never comes.
  const TOOK_TOO_LONG = 'That took too long. Check your signal and try again.';
  const lostAnswer = () => Object.assign(new Error(TOOK_TOO_LONG), { isTimeout: true });
  // The same account saying "ok" from another device: the server echoes it to
  // this device too, under that device's own client id.
  const okFromAnotherDevice = () => flockWire(21, { message_text: 'ok', client_id: 'cAnotherDevice', status: 'sent' });

  beforeEach(() => localStorage.clear());
  afterAll(() => localStorage.clear());

  test('over HTTP: the socket comes back, its read delivers the row, the answer is lost, and nothing fails', async () => {
    const run = liftedSendReadAndEcho({ socketUp: false });
    const sending = run.transmit(7, 'on my way');
    run.render();
    await flush();
    expect(run.posts).toHaveLength(1);
    // The reconnect's catch-up read has the stored row, and renders.
    await run.readWith(delivered);
    run.render();
    expect(run.ids()).toEqual([20, 21]);
    // Then the request's deadline fires: its answer was lost on the way back.
    run.posts[0].reject(lostAnswer());
    await sending;
    run.render();
    expect(run.state.toasts).toEqual([]);
    expect(H.readFailedFlockMessages(7)).toEqual([]);
    // The chat opened again: one delivered row and no copy offering a retry.
    await run.readWith(delivered);
    run.render();
    expect(run.ids()).toEqual([20, 21]);
  });

  test('over HTTP, the same when the answer is lost before that read has rendered', async () => {
    const run = liftedSendReadAndEcho({ socketUp: false });
    const sending = run.transmit(7, 'on my way');
    run.render();
    await flush();
    await run.readWith(delivered);
    // The request fails in the moment between the read landing and its render.
    run.posts[0].reject(lostAnswer());
    await sending;
    run.render();
    expect(run.state.toasts).toEqual([]);
    expect(H.readFailedFlockMessages(7)).toEqual([]);
    expect(run.ids()).toEqual([20, 21]);
  });

  test("over HTTP, the same when this account's own echo of the send came back first", async () => {
    const run = liftedSendReadAndEcho({ socketUp: false });
    const sending = run.transmit(7, 'on my way');
    run.render();
    await flush();
    const { clientId } = run.state.rendered[0].messages[1];
    // The socket comes back in time to hear the server's echo of the request.
    run.echo(flockWire(21, { message_text: 'on my way', client_id: clientId, status: 'sent' }));
    run.render();
    expect(run.ids()).toEqual([20, 21]);
    run.posts[0].reject(lostAnswer());
    await sending;
    run.render();
    expect(run.state.toasts).toEqual([]);
    expect(H.readFailedFlockMessages(7)).toEqual([]);
    expect(run.ids()).toEqual([20, 21]);
  });

  test('over HTTP, a request nothing accounted for still fails out loud and is kept for the next launch', async () => {
    const run = liftedSendReadAndEcho({ socketUp: false });
    const sending = run.transmit(7, 'on my way');
    run.render();
    await flush();
    const bubbleId = run.state.rendered[0].messages[1].id;
    // A read lands without the row: this send really has not arrived.
    await run.readWith([srv(20, 'before')]);
    run.render();
    run.posts[0].reject(lostAnswer());
    await sending;
    run.render();
    expect(run.state.toasts).toEqual([TOOK_TOO_LONG]);
    const bubble = run.bubbleOf(bubbleId);
    expect([bubble.pending, bubble.failed]).toEqual([false, true]);
    expect(H.readFailedFlockMessages(7).map((m) => m.id)).toEqual([bubbleId]);
  });

  test('over HTTP, a look-alike from another device that the read matched instead leaves this send to fail out loud', async () => {
    const run = liftedSendReadAndEcho({ socketUp: false });
    const sending = run.transmit(7, 'ok');
    run.render();
    await flush();
    const bubbleId = run.state.rendered[0].messages[1].id;
    // The socket comes back, and the same account says "ok" from another
    // device. Its echo is queued as row 21, not rendered yet.
    run.echo(okFromAnotherDevice());
    // The catch-up read lands before that render, row 21 in it, and to the
    // last render that row looks like this send's.
    await run.readWith([srv(20, 'before'), srv(21, 'ok')]);
    run.render();
    // It is not: row 21 is the other device's, so this send is still sending.
    expect(run.ids()).toEqual([20, 21, bubbleId]);
    expect(run.bubbleOf(bubbleId).pending).toBe(true);
    // Then the request fails. This send did fail, and it says so.
    run.posts[0].reject(lostAnswer());
    await sending;
    run.render();
    const bubble = run.bubbleOf(bubbleId);
    expect([bubble.pending, bubble.failed]).toEqual([false, true]);
    expect(run.state.toasts).toEqual([TOOK_TOO_LONG]);
    expect(H.readFailedFlockMessages(7).map((m) => [m.id, m.text])).toEqual([[bubbleId, 'ok']]);
  });

  test('over the socket, the same look-alike never leaves a send without a way to fail', async () => {
    const run = liftedSendReadAndEcho({ socketUp: true });
    await run.transmit(7, 'ok');
    run.render();
    const bubbleId = run.state.rendered[0].messages[1].id;
    // This send's echo is lost. The other device's "ok" is queued as row 21,
    // and the catch-up read lands before it renders.
    run.echo(okFromAnotherDevice());
    await run.readWith([srv(20, 'before'), srv(21, 'ok')]);
    run.render();
    expect(run.bubbleOf(bubbleId).pending).toBe(true);
    // The eight seconds run out: the timer is still there, and it fails the send.
    run.fireDue();
    run.render();
    const bubble = run.bubbleOf(bubbleId);
    expect([bubble.pending, bubble.failed]).toEqual([false, true]);
    expect(H.readFailedFlockMessages(7).map((m) => [m.id, m.text])).toEqual([[bubbleId, 'ok']]);
  });

  test('over the socket, a timer that fires before the read has rendered fails nothing', async () => {
    const run = liftedSendReadAndEcho({ socketUp: true });
    await run.transmit(7, 'on my way');
    run.render();
    const bubbleId = run.state.rendered[0].messages[1].id;
    expect(run.timers.map((t) => t.ms)).toEqual([8000]);
    // No echo. The catch-up read lands; its merge is queued, not rendered, so
    // the last render still shows the bubble sending.
    await run.readWith(delivered);
    expect(run.ids()).toEqual([20, bubbleId]);
    // The eight seconds run out before that render. The failure update is
    // queued behind the read's, finds the bubble gone, and nothing is stored.
    run.fireDue();
    run.render();
    expect(H.readFailedFlockMessages(7)).toEqual([]);
    expect(run.ids()).toEqual([20, 21]);
    expect(run.state.rendered[0].messages.filter((m) => m.failed || m.pending)).toEqual([]);
    // The next read brings nothing back.
    await run.readWith(delivered);
    run.render();
    expect(run.ids()).toEqual([20, 21]);
  });
});
