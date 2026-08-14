// Run: node --test  (from backend/)
//
// SOCKET ROOMS SURVIVE A RECONNECT, AND THE CLIENT STOPS SWALLOWING REFUSALS.
//
// Room membership lives on the SERVER's socket object. When a connection drops
// and socket.io reconnects, the server hands out a brand new socket with none
// of the old one's `socket.join()` calls — so every room-scoped event
// (typing indicators, live votes, presence, budget and bill updates, the live
// venue sensor feed) is addressed to a room this client is no longer in.
// App.js emits `join_flock` once, from an effect keyed on the selected flock,
// and `join_venue` once per open venue sheet. Neither re-runs on a reconnect.
// The symptom was a socket that looked perfectly healthy and delivered nothing:
// the only cure was leaving the chat and coming back.
//
// The other half of the same story is listeners. App.js used to bind
// `sock.on('error', ...)`, `sock.on('availability_updated', ...)` and
// `sock.on('blocked_by', ...)` directly to whatever object getSocket() returned
// at mount, inside effects with empty dependency arrays — so they were lost on
// any socket rebuild (account switch, fatal-auth teardown, session expiry) and
// never attached at all when the effect ran before connectSocket() had made an
// instance. services/socket.js's subscription registry exists precisely so a
// caller cannot make that mistake.
//
// These tests EXECUTE the real frontend/src/services/socket.js rather than
// pattern-matching it: the file is read, its two imports are replaced with
// injected stubs (`io` and `getToken`), and the module body is run. Everything
// asserted below is the shipping code's actual behaviour.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const CLIENT_DIR = path.join(__dirname, '..', '..', 'frontend', 'src');
const SOCKET_SRC = fs.readFileSync(path.join(CLIENT_DIR, 'services', 'socket.js'), 'utf8');
const APP_SRC = fs.readFileSync(path.join(CLIENT_DIR, 'App.js'), 'utf8');

// --- load the real module --------------------------------------------------
//
// socket.js is ESM with exactly two imports and only `export function`
// declarations. Strip the imports (their bindings are injected as parameters)
// and drop the `export` keyword, then evaluate. If either of those assumptions
// ever stops holding, this throws loudly instead of silently testing nothing.
function loadSocketModule({ token = 'tok-a' } = {}) {
  const exported = [...SOCKET_SRC.matchAll(/^export function (\w+)/gm)].map((m) => m[1]);
  assert.ok(exported.includes('connectSocket') && exported.includes('joinFlock'),
    'socket.js no longer declares its exports as `export function` — this loader needs updating');
  const body = SOCKET_SRC
    .replace(/^import[\s\S]*?;$/gm, '')
    .replace(/^export function/gm, 'function');

  const built = [];
  const io = () => {
    const sock = makeFakeSocket();
    built.push(sock);
    return sock;
  };
  let current = token;
  // eslint-disable-next-line no-new-func
  const factory = new Function('io', 'getToken', 'BASE_URL',
    `${body}\nreturn { ${exported.join(', ')} };`);
  const api = factory(io, () => current, 'http://test.invalid');
  return { api, built, setToken: (t) => { current = t; } };
}

// A stand-in for the socket.io client Socket. `emit` is the outbound channel
// (what the client sends the server); `fire` plays an inbound event.
function makeFakeSocket() {
  const handlers = new Map();
  return {
    connected: false,
    active: false,
    emits: [],
    disposed: false,
    on(event, cb) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event).add(cb);
      return this;
    },
    off(event, cb) {
      handlers.get(event)?.delete(cb);
      return this;
    },
    removeAllListeners() { handlers.clear(); this.disposed = true; },
    emit(event, payload) { this.emits.push([event, payload]); },
    connect() { this.connected = true; this.fire('connect'); },
    disconnect() { this.connected = false; },
    fire(event, payload) { [...(handlers.get(event) || [])].forEach((cb) => cb(payload)); },
    listenerCount(event) { return (handlers.get(event) || new Set()).size; },
    sent(event) { return this.emits.filter(([e]) => e === event).map(([, p]) => p); },
  };
}

// Bring a freshly built instance up the way socket.io would.
function goOnline(sock) {
  sock.connected = true;
  sock.fire('connect');
}

// ===========================================================================
// PART 1 — a reconnect re-enters every room the client believes it is in
// ===========================================================================

test('a flock room joined before the handshake finishes is still joined', () => {
  const { api, built } = loadSocketModule();
  api.connectSocket();
  const sock = built[0];

  // The socket exists but has not connected yet — the exact order on a cold
  // start, where the chat effect can run first. The OLD joinFlock no-oped here
  // and the room was never entered at all.
  assert.strictEqual(sock.connected, false);
  api.joinFlock(42);
  assert.deepStrictEqual(sock.sent('join_flock'), [], 'nothing may go out on a socket that is down');

  goOnline(sock);
  assert.deepStrictEqual(sock.sent('join_flock'), [42], 'the pending join must land on connect');
});

test('a reconnect re-emits join_flock and join_venue', () => {
  const { api, built } = loadSocketModule();
  api.connectSocket();
  const sock = built[0];
  goOnline(sock);

  api.joinFlock(7);
  api.joinVenueRoom('ChIJplace');
  assert.deepStrictEqual(sock.sent('join_flock'), [7]);
  assert.deepStrictEqual(sock.sent('join_venue'), [{ placeId: 'ChIJplace' }]);

  // Tunnel, lift, lock screen. socket.io reconnects the SAME instance, and the
  // server-side socket behind it is new and holds no rooms.
  sock.disconnect();
  goOnline(sock);

  assert.deepStrictEqual(sock.sent('join_flock'), [7, 7],
    'the flock room must be re-entered, or typing indicators and live votes stay silent');
  assert.deepStrictEqual(sock.sent('join_venue'), [{ placeId: 'ChIJplace' }, { placeId: 'ChIJplace' }],
    'the venue sensor feed must be re-entered too');
});

test('leaving a room stops it being replayed, even while offline', () => {
  const { api, built } = loadSocketModule();
  api.connectSocket();
  const sock = built[0];
  goOnline(sock);

  api.joinFlock(7);
  api.joinVenueRoom('ChIJplace');

  // Close the chat during an outage. The emit cannot go out, but the intent
  // must still be forgotten — otherwise the reconnect silently re-subscribes
  // the user to a conversation they closed.
  sock.disconnect();
  api.leaveFlock(7);
  api.leaveVenueRoom('ChIJplace');

  goOnline(sock);
  assert.deepStrictEqual(sock.sent('join_flock'), [7], 'a left room was re-joined on reconnect');
  assert.deepStrictEqual(sock.sent('join_venue'), [{ placeId: 'ChIJplace' }]);
});

test('joining the same flock twice records one room, whatever the id type', () => {
  const { api, built } = loadSocketModule();
  api.connectSocket();
  const sock = built[0];
  goOnline(sock);

  api.joinFlock(7);
  api.joinFlock('7');
  sock.disconnect();
  goOnline(sock);

  // Two live emits (each call is a real user action), but the REPLAY must not
  // multiply: the registry is keyed by String(id).
  const replayed = sock.sent('join_flock').slice(2);
  assert.strictEqual(replayed.length, 1, `a duplicate join was replayed ${replayed.length} times`);
});

test('rooms do not survive a sign-out, but subscriptions do', () => {
  const { api, built } = loadSocketModule();
  api.connectSocket();
  goOnline(built[0]);

  const seen = [];
  api.onNewMessage((m) => seen.push(m));
  api.joinFlock(7);

  api.disconnectSocket();
  api.connectSocket();
  const fresh = built[1];
  goOnline(fresh);

  assert.deepStrictEqual(fresh.sent('join_flock'), [],
    'the next account must not be auto-joined to the previous one\'s flock');
  fresh.fire('new_message', { id: 1 });
  assert.deepStrictEqual(seen, [{ id: 1 }],
    'a component subscription belongs to the component and must outlive the socket');
});

test('an account switch rebuilds the socket and drops the old rooms', () => {
  const { api, built, setToken } = loadSocketModule({ token: 'tok-a' });
  api.connectSocket();
  goOnline(built[0]);
  api.joinFlock(7);

  setToken('tok-b');
  api.connectSocket();
  assert.strictEqual(built.length, 2, 'a different token must build a new socket');
  assert.strictEqual(built[0].disposed, true, 'the previous user\'s socket must be torn down');
  goOnline(built[1]);
  assert.deepStrictEqual(built[1].sent('join_flock'), []);
});

// ===========================================================================
// PART 2 — the registry, not the instance, owns listeners
// ===========================================================================

test('onSocketError survives a socket rebuild and an early subscribe', () => {
  const { api, built, setToken } = loadSocketModule({ token: 'tok-a' });

  // Subscribed BEFORE any socket exists — the case a raw sock.on() cannot
  // handle at all, because there is nothing to bind to.
  const errors = [];
  const off = api.onSocketError((d) => errors.push(d?.message));

  api.connectSocket();
  goOnline(built[0]);
  built[0].fire('error', { message: 'Slow down a moment.' });

  setToken('tok-b');
  api.connectSocket();
  goOnline(built[1]);
  built[1].fire('error', { message: 'You can no longer message this user.' });

  assert.deepStrictEqual(errors, ['Slow down a moment.', 'You can no longer message this user.'],
    'a refusal the server worded for a person must reach the app on every instance');

  off();
  built[1].fire('error', { message: 'ignored' });
  assert.strictEqual(errors.length, 2, 'unsubscribe must actually unsubscribe');
});

test('the events App.js used to bind by hand are exported through the registry', () => {
  const { api, built } = loadSocketModule();
  for (const name of ['onSocketError', 'onAvailabilityUpdated', 'onBlockedBy']) {
    assert.strictEqual(typeof api[name], 'function', `${name} must be exported`);
  }
  const pulses = [];
  const blocks = [];
  api.onAvailabilityUpdated((p) => pulses.push(p));
  api.onBlockedBy((p) => blocks.push(p));
  api.connectSocket();
  goOnline(built[0]);
  built[0].fire('availability_updated', { userId: 3, status: 'down' });
  built[0].fire('blocked_by', { userId: 9 });
  assert.deepStrictEqual(pulses, [{ userId: 3, status: 'down' }]);
  assert.deepStrictEqual(blocks, [{ userId: 9 }]);
});

test('App.js binds nothing directly to a raw socket instance', () => {
  // Comment lines are excluded: the fixed sites explain themselves by naming
  // the pattern they no longer use.
  const raw = APP_SRC.split('\n')
    .map((line, i) => [i + 1, line])
    .filter(([, line]) => /\bsock\w*\.(on|off)\(/.test(line))
    .filter(([, line]) => !/^\s*(\/\/|\*|\/\*)/.test(line));
  assert.deepStrictEqual(raw, [],
    'a listener on the object getSocket() returned is lost the moment that object is replaced');
});

// ===========================================================================
// PART 3 — one message, one emit: text, caption and venue card alike
// ===========================================================================

test('sendMessage carries text and image together, and reports whether it sent', () => {
  const { api, built } = loadSocketModule();
  api.connectSocket();
  const sock = built[0];

  assert.strictEqual(api.sendMessage(1, 'hi'), false, 'a send on a down socket must report failure');
  assert.deepStrictEqual(sock.sent('send_message'), [], 'and must put nothing on the wire');

  goOnline(sock);
  assert.strictEqual(api.sendMessage(1, 'look at this', { message_type: 'image', image_url: 'data:x' }), true);
  assert.deepStrictEqual(sock.sent('send_message'), [{
    flockId: 1,
    message_text: 'look at this',
    message_type: 'image',
    venue_data: null,
    image_url: 'data:x',
  }], 'a captioned photo must go out as ONE message carrying both');
});

test('sendImageMessage is the same code path and keeps a caption', () => {
  const { api, built } = loadSocketModule();
  api.connectSocket();
  goOnline(built[0]);
  api.sendImageMessage(2, 'data:y', { message_text: 'sunset' });
  assert.deepStrictEqual(built[0].sent('send_message'), [{
    flockId: 2,
    message_text: 'sunset',
    message_type: 'image',
    venue_data: null,
    image_url: 'data:y',
  }]);
});

// Comment lines are dropped before anything below counts a call site or scans
// for a field that should be gone. Every one of these fixes explains itself in
// a comment that NAMES the thing it no longer does, so prose that mentions
// `apiSendMessage()` or a removed column would otherwise fail the test that the
// fix was written to pass. Same exclusion, and same reason, as the raw-socket
// listener test above.
function codeOnly(src) {
  return src.split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
}

// Slice one top-level `const NAME = useCallback(` out of App.js, up to the
// declaration that follows it. Assertions below are scoped to a single function
// so they cannot be satisfied by some unrelated corner of a 16,000-line file.
function appFn(name, endsBefore) {
  const start = APP_SRC.indexOf(`const ${name} = useCallback(`);
  assert.ok(start > 0, `${name} not found in App.js`);
  const end = APP_SRC.indexOf(`const ${endsBefore} = `, start);
  assert.ok(end > start,
    `${endsBefore} no longer follows ${name} — this slice needs updating, it is not a real failure`);
  return codeOnly(APP_SRC.slice(start, end));
}

// Every call to `name(...)`, with its argument text, paren-balanced. A regex
// cannot do this: the arguments contain braces, nested calls and ternaries.
function callArgs(src, name) {
  const needle = `${name}(`;
  const out = [];
  for (let i = src.indexOf(needle); i !== -1; i = src.indexOf(needle, i + 1)) {
    let depth = 0;
    let j = i + needle.length - 1;
    for (; j < src.length; j++) {
      if (src[j] === '(') depth += 1;
      else if (src[j] === ')') { depth -= 1; if (depth === 0) break; }
    }
    out.push(src.slice(i + needle.length, j));
  }
  return out;
}

// The leading positional arguments of a call, as written. Splitting on commas
// is safe only down to the first object/array/call argument, so it stops there —
// which is all these tests read.
function positional(args) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const c of args) {
    if ('([{'.includes(c)) depth += 1;
    else if (')]}'.includes(c)) depth -= 1;
    if (c === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  out.push(cur.trim());
  return out;
}

// The value expression a call's options object gives one key, as written.
function objField(args, key) {
  const m = args.match(new RegExp(`\\b${key}:\\s*([^,}]+)`));
  return m ? m[1].trim() : null;
}

// The payload fields transmitFlockMessage accepts, read off the function itself
// rather than listed here. A message is a body plus attachments; `message_type`
// is the label, checked separately. Deriving the list is the point: a FOURTH
// kind of attachment is covered by these tests the day it is added, instead of
// shipping wired to one transport and not the other — which is exactly how both
// bugs below happened.
function attachmentFields(fnSrc) {
  return [...new Set([...fnSrc.matchAll(/\bopts\.(\w+)/g)].map((m) => m[1]))]
    .filter((f) => f !== 'message_type');
}

// This test used to pin the literal source text of the two send calls, which
// made it fail on any edit to them — including the correct one that added venue
// cards to this path. What it is actually guarding is a PROPERTY, and the
// property is what is asserted now: one message is one send on each transport,
// carrying everything the message has, described identically on both.
//
// The property is real. A photo/text branch here once meant a captioned photo
// could not be sent at all: the socket emitter had no text field and the REST
// one did, so the same photo arrived with different content depending on which
// transport the network chose. A venue card kept its own private copy of this
// whole function for the same reason, and inherited none of its fixes.
test('App.js sends a flock message with one send per transport, whatever it carries', () => {
  assert.ok(!/sendImageMessage as socketSendImage/.test(APP_SRC),
    'the second emitter is gone; a caption must not depend on which helper the caller picks');

  const fn = appFn('transmitFlockMessage', 'retryFailedMessage');
  const socketSends = callArgs(fn, 'socketSendMessage');
  const restSends = callArgs(fn, 'apiSendMessage');

  assert.strictEqual(socketSends.length, 1,
    `transmitFlockMessage makes ${socketSends.length} socket sends; a second one is a branch, and a branch is where the two drift`);
  assert.strictEqual(restSends.length, 1,
    `transmitFlockMessage makes ${restSends.length} REST sends; the fallback must describe the same message, once`);

  // Same room, same body, same label — compared to EACH OTHER rather than to a
  // spelling written down here, so renaming a local variable does not fail a
  // test about transports. A caption was lost precisely because one of the two
  // was handed a hardcoded '' while the other was handed the text.
  const [socketRoom, socketBody] = positional(socketSends[0]);
  const [restRoom, restBody] = positional(restSends[0]);
  assert.strictEqual(socketRoom, restRoom, 'the two transports must address the same flock');
  assert.strictEqual(socketBody, restBody, 'the two transports must send the same message body');
  assert.doesNotMatch(socketBody, /^['"`]/,
    'the body must be what the caller handed in, not a literal baked into the send');
  assert.strictEqual(objField(socketSends[0], 'message_type'), objField(restSends[0], 'message_type'),
    'the two transports must label the message identically');
  assert.ok(objField(socketSends[0], 'message_type'), 'neither send may go out untyped');

  // Every attachment the function accepts must reach BOTH transports, carrying
  // the same value. The REST helper omits absent keys rather than nulling them,
  // so its expression is allowed to extend the socket's with a nullish fallback
  // (`image` / `image || undefined`) and nothing else.
  const attachments = attachmentFields(fn);
  assert.ok(attachments.includes('image_url') && attachments.includes('venue_data'),
    'a photo and a venue card are both attachments on the one send path, not separate send paths');
  for (const field of attachments) {
    const onSocket = objField(socketSends[0], field);
    const onRest = objField(restSends[0], field);
    assert.ok(onSocket, `the socket send drops ${field}`);
    assert.ok(onRest, `the REST fallback drops ${field}`);
    assert.ok(onRest === onSocket || onRest.startsWith(`${onSocket} ||`),
      `the two transports disagree about ${field}: socket sends \`${onSocket}\`, REST sends \`${onRest}\``);
  }
});

test('a shared venue card goes out on the reconciled path, not a copy of it', () => {
  const fn = appFn('shareVenueToChat', 'shareImageToChat');

  assert.ok(/transmitFlockMessage\(/.test(fn) && /venue_data:/.test(fn),
    'the card must be handed to transmitFlockMessage with its venue_data');

  // Every one of these is a piece of the send path this function used to own a
  // private copy of. The copy registered nothing in pendingEchoRef, so the
  // bubble kept its Date.now() id forever and a reaction or a report on the card
  // you had just shared addressed a row the server never issued; and a socket
  // send the server dropped left the card on screen looking sent.
  for (const owned of ['socketSendMessage(', 'apiSendMessage(', 'addMessageToFlock(', 'pendingEchoRef']) {
    assert.ok(!fn.includes(owned),
      `shareVenueToChat hand-rolls ${owned} again — a second send path is how the card lost id reconciliation and tap-to-retry`);
  }
});

test('tap-to-retry re-sends everything the failed bubble was carrying', () => {
  const retry = appFn('retryFailedMessage', 'sendChatMessage');
  const attachments = attachmentFields(appFn('transmitFlockMessage', 'retryFailedMessage'));

  assert.ok(/transmitFlockMessage\(/.test(retry), 'a retry must go back through the one send path');
  for (const field of attachments) {
    assert.match(retry, new RegExp(`\\b${field}:`),
      `a retry drops ${field}, so retrying downgrades the message into something the user never sent`);
  }
});

test('the photo composer sends whatever caption is typed', () => {
  const share = APP_SRC.slice(APP_SRC.indexOf('const shareImageToChat'));
  assert.ok(!/transmitFlockMessage\(flockId, '',/.test(share.slice(0, 1200)),
    'the caption was hardcoded empty, so the transport fix would be unreachable');
  assert.ok(/transmitFlockMessage\(flockId, caption,/.test(share.slice(0, 1200)));
});

// ===========================================================================
// PART 4 — the venue's own clock reaches the batch scorer
// ===========================================================================

test('the batch crowd payload forwards each venue\'s own utcOffsetMinutes', () => {
  const start = APP_SRC.indexOf('const batchPayload');
  assert.ok(start > 0, 'batchPayload not found');
  const payload = APP_SRC.slice(start, start + 500);
  assert.ok(/utcOffsetMinutes:/.test(payload),
    'without the venue offset every row in the list is scored on the viewer\'s clock');
  assert.ok(!/utcOffsetMinutes: undefined/.test(payload),
    'the field must be forwarded or null, never undefined');
  // The server whitelists it with Number.isFinite, so null is the safe absent
  // value and the fallback behaviour is unchanged.
  const route = fs.readFileSync(path.join(__dirname, '..', 'routes', 'crowd.js'), 'utf8');
  assert.ok(/utcOffsetMinutes: Number\.isFinite\(v\?\.utcOffsetMinutes\)/.test(route),
    '/api/crowd/batch must keep validating the client-supplied offset');
});

// ===========================================================================
// PART 5 — the venue dashboard says what the server said, and invents nothing
// ===========================================================================

// The whole VenueDashboard body, so these assertions cannot be satisfied by
// some unrelated part of a 16,000-line file.
const dashboard = (() => {
  const start = APP_SRC.indexOf('const VenueDashboard = ');
  assert.ok(start > 0, 'VenueDashboard not found');
  return APP_SRC.slice(start, APP_SRC.indexOf('// Hours Modal', start) || APP_SRC.length);
})();

test('deleting a promotion or an event reports the server refusal', () => {
  for (const [name, api] of [['deletePromo', 'deleteVenuePromotion'], ['deleteEvent', 'deleteVenueEvent']]) {
    const start = dashboard.indexOf(`const ${name} = `);
    assert.ok(start > 0, `${name} not found`);
    const fn = dashboard.slice(start, start + 500);
    assert.ok(new RegExp(`await ${api}\\(`).test(fn));
    assert.ok(/showToast\(e\?\.message \|\|/.test(fn),
      `${name} still swallows the refusal — the trash icon does nothing at all when the server says no`);
    assert.ok(!/console\.error/.test(fn.slice(0, fn.indexOf('};'))),
      `${name} must not log the refusal instead of showing it`);
  }
});

test('a refused promotion or event save keeps the form open instead of faking success', () => {
  for (const modal of ['PromoModal', 'EventModal']) {
    const start = dashboard.indexOf(`<${modal}`);
    assert.ok(start > 0, `${modal} not found`);
    const block = dashboard.slice(start, start + 1600);
    assert.ok(/showToast\(e\?\.message \|\|/.test(block), `${modal} save swallows the refusal`);
    assert.ok(/catch \(e\) \{[\s\S]*?return;/.test(block),
      `${modal} closes on failure, so a rejected save looks identical to a successful one`);
  }
});

test('the dashboard renders no counter that nothing in the repo ever increments', () => {
  assert.ok(!/promo\.claims/.test(APP_SRC),
    'venue_promotions.claims is never written anywhere, so the number was permanently 0');
  assert.ok(!/event\.rsvps/.test(APP_SRC),
    'venue_events.rsvps is never written anywhere, and no RSVP flow for venue events exists');
  assert.ok(/promo\.views/.test(APP_SRC), 'views is real and must stay');

  // The claim above, verified rather than asserted: exactly one of the three
  // columns is incremented by the backend.
  const backend = ['routes', 'services', 'sockets']
    .flatMap((dir) => fs.readdirSync(path.join(__dirname, '..', dir)).map((f) => path.join(__dirname, '..', dir, f)))
    .filter((f) => f.endsWith('.js'))
    .map((f) => fs.readFileSync(f, 'utf8'))
    .join('\n');
  assert.ok(/SET views = views \+ 1/.test(backend), 'views must still be counted server-side');
  assert.ok(!/\bclaims\s*=\s*claims\s*\+/.test(backend), 'if claims is now counted, put the display back');
  assert.ok(!/\brsvps\s*=\s*rsvps\s*\+/.test(backend), 'if venue-event RSVPs are now counted, put the display back');
});

test('no flock field is read from a column that does not exist', () => {
  // App.js mapped `venuePriceLevel: f.venue_price_level` off GET /api/flocks.
  // `flocks` has no such column — the route selects f.*, so the field was
  // absent and the read was null on every flock, every time. The nearest thing
  // in the schema is research_analytics.venue_price_level_selected, which
  // routes/flocks.js inserts as a literal null. Price level is real Google
  // Places data and it is still shown where this session actually looked it
  // up; it is just no longer sourced from a column nobody ever created.
  assert.ok(!/f\.venue_price_level\b/.test(codeOnly(APP_SRC)),
    'flocks.venue_price_level does not exist; reading it back is a value the user can never actually keep');

  const schema = ['database/schema.sql']
    .concat(fs.readdirSync(path.join(__dirname, '..', 'migrations')).map((f) => `migrations/${f}`))
    .map((rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8'))
    .join('\n');
  assert.ok(!/\bvenue_price_level\b(?!_selected)/.test(schema),
    'the column now exists — put the mapping back, and persist it on the venue save route too');
});

test('the hardcoded "This Week" calendar is gone', () => {
  assert.ok(!/\[19, 20, 21, 22, 23, 24, 25\]/.test(APP_SRC),
    'a seven-cell calendar of literal dates with fixed event dots is a mockup, not data');
});

// ===========================================================================
// PART 6 — the flock typing indicator recovers after a send
// ===========================================================================

test('sending a flock message releases the typing throttle', () => {
  const start = APP_SRC.indexOf('const sendChatMessage');
  assert.ok(start > 0);
  const fn = APP_SRC.slice(start, start + 1400);
  assert.ok(/typingActiveRef\.current = false;/.test(fn),
    'the latch stayed true after a send, so the sender never showed as typing again');
});
