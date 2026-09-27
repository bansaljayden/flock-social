// Run: node --test  (from backend/)
//
// ---------------------------------------------------------------------------
// A DEPLOY MUST NOT LEAVE EVERY OPEN APP WITH A DEAD SOCKET
// ---------------------------------------------------------------------------
// Railway sends SIGTERM on every deploy, and server.js's shutdown() used to
// open the drain with io.disconnectSockets(true), believing clients would
// reconnect to the freshly deployed instance. They never did. That call writes
// a socket.io DISCONNECT packet to each client before closing it, and
// socket.io-client reads that packet as "io server disconnect": the one reason
// it never reconnects from, by design, because it is how a ban or a revoke
// keeps a client off. frontend/src/services/socket.js has no 'disconnect'
// listener, so nothing else dialled either. Every web tab and every open phone
// kept a dead socket after every deploy (no live messages, votes, typing or
// location, the chat header stuck on "reconnecting") until the app was
// backgrounded or the network changed.
//
// observability.test.js pins the drain ORDER with a fake io, and a fake io
// cannot say what a client does with the goodbye it is sent. This file runs
// the shutdown() body out of server.js against a real socket.io server and the
// real client the app ships, then brings up a second server on the same port
// (the next deploy) and asks the only question that matters: does the client
// get there on its own?
//
// The client is loaded from frontend/node_modules rather than installed into
// backend: the property under test is how THAT library, at the version the app
// ships, reads the server's goodbye, so a client upgrade that changes its
// reconnect rules shows up here as well. A checkout with no frontend install
// (the backend-only CI job) skips, and says why.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { Server } = require('socket.io');

const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

let clientIo = null;
let skipReason = false;
try {
  const resolved = require.resolve('socket.io-client', { paths: [path.join(__dirname, '..', '..', 'frontend')] });
  clientIo = require(resolved).io;
} catch (_) {
  skipReason = 'socket.io-client is not installed under frontend/ (run npm install there); '
    + 'this suite drives the real client the app ships';
}

// The reconnect settings frontend/src/services/socket.js gives the app, with
// the delays shortened so the test does not wait out a real backoff. What is
// under test is whether a retry is scheduled at all, not how long it waits.
const CLIENT_OPTS = {
  transports: ['websocket', 'polling'],
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 50,
  reconnectionDelayMax: 200,
  randomizationFactor: 0.5,
};

function startInstance(port = 0) {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    const io = new Server(server, { transports: ['websocket', 'polling'] });
    const seen = [];
    io.on('connection', (socket) => seen.push(socket.id));
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve({ server, io, seen, port: server.address().port }));
  });
}

// shutdown() lifted out of server.js exactly as observability.test.js lifts it,
// with the REAL io and http server handed in. The pool and the meter store are
// fakes (there is no database here), and so is process, so exit() records
// instead of ending the test run.
function loadShutdown({ io, server }) {
  const start = serverSrc.indexOf('const SHUTDOWN_DEADLINE_MS');
  assert.ok(start > 0, 'server.js must declare SHUTDOWN_DEADLINE_MS');
  const endAnchor = "process.on('SIGINT', () => shutdown('SIGINT'));";
  const at = serverSrc.indexOf(endAnchor, start);
  assert.ok(at > start, 'server.js must register the SIGINT handler');
  const body = serverSrc.slice(start, at + endAnchor.length);

  const signals = {};
  let exited;
  const exitedAt = new Promise((resolve) => { exited = resolve; });
  const proc = {
    exitCodes: [],
    exit(code) { this.exitCodes.push(code); exited(code); },
    on: (sig, fn) => { signals[sig] = fn; },
  };
  const quiet = { log: () => {}, warn: () => {}, error: () => {} };
  const pool = { end: () => Promise.resolve() };
  const usageStore = { flushNow: () => Promise.resolve() };
  const timerHandles = [...serverSrc.matchAll(/^let (\w+(?:Interval|Kickoff)) = null;/gm)].map((m) => m[1]);
  // eslint-disable-next-line no-new-func
  new Function(
    'io', 'server', 'pool', 'usageStore', 'console', 'process', ...timerHandles,
    `${body}\nreturn shutdown;`
  )(io, server, pool, usageStore, quiet, proc, ...timerHandles.map(() => null));
  return { signals, proc, exitedAt };
}

function waitFor(emitter, event, ms, what) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms waiting for ${what}`)), ms);
    emitter.once(event, (...args) => { clearTimeout(timer); resolve(args); });
  });
}

// Both transports the app allows: a websocket (nearly everyone) and long
// polling (the fallback when a network will not carry a websocket). They are
// closed by different code in engine.io, so each gets its own run.
for (const transports of [['websocket', 'polling'], ['polling']]) {
  test(`a deploy's SIGTERM leaves every connected client dialling the next instance, and it gets there (${transports[0]})`,
    { skip: skipReason, timeout: 20000 }, async () => {
    const old = await startInstance();
    const client = clientIo(`http://127.0.0.1:${old.port}`, { ...CLIENT_OPTS, transports });
    let next = null;
    try {
      await waitFor(client, 'connect', 5000, 'the first connect');
      assert.strictEqual(old.seen.length, 1);

      const reasons = [];
      client.on('disconnect', (reason) => reasons.push(reason));
      const gone = waitFor(client, 'disconnect', 5000, 'the client to notice the shutdown');

      const { signals, proc, exitedAt } = loadShutdown({ io: old.io, server: old.server });
      signals.SIGTERM();
      await gone;

      assert.notStrictEqual(reasons[0], 'io server disconnect',
        'shutdown sent a socket.io DISCONNECT packet, and socket.io-client never reconnects from one: '
        + 'every open app would sit on a dead socket after every deploy');
      assert.strictEqual(client.active, true,
        `the client must still be trying after the shutdown (disconnect reason: ${reasons[0]})`);

      // The drain still completes: closing the transports releases the
      // connections server.close() is waiting on, so exit(0) is reached well
      // inside the deadline rather than by it.
      const code = await Promise.race([
        exitedAt,
        new Promise((_, reject) => setTimeout(() => reject(new Error('the drain never finished')), 5000)),
      ]);
      assert.strictEqual(code, 0);
      assert.deepStrictEqual(proc.exitCodes, [0]);

      // The next deploy comes up on the same address. Nobody backgrounds the
      // app, nobody flips the network: the client has to find it by itself.
      next = await startInstance(old.port);
      await waitFor(client, 'connect', 8000, 'the client to reconnect to the new instance on its own');
      assert.strictEqual(client.connected, true);
      assert.strictEqual(next.seen.length, 1, 'the reconnect must land on the new instance');
    } finally {
      client.close();
      if (next) await next.io.close();
      if (old.server.listening) await new Promise((r) => old.server.close(r));
    }
  });
}

test('the premise: socket.io-client does not come back from a server DISCONNECT, so shutdown must not send one',
  { skip: skipReason, timeout: 10000 }, async () => {
    // If this ever fails, the client library changed its rules, and the
    // comment above shutdown() in server.js needs rereading. It is also the
    // proof that the test above can tell the two shutdowns apart.
    const inst = await startInstance();
    const client = clientIo(`http://127.0.0.1:${inst.port}`, CLIENT_OPTS);
    try {
      await waitFor(client, 'connect', 5000, 'the first connect');
      const gone = waitFor(client, 'disconnect', 5000, 'the disconnect');
      inst.io.disconnectSockets(true);
      const [reason] = await gone;
      assert.strictEqual(reason, 'io server disconnect');
      assert.strictEqual(client.active, false, 'no retry is scheduled after a server DISCONNECT');
    } finally {
      client.close();
      await inst.io.close();
    }
  });
