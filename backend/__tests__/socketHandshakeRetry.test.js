// Run: node --test  (from backend/)
//
// ---------------------------------------------------------------------------
// A HANDSHAKE THE SERVER COULD NOT CHECK IS NOT A DEAD CREDENTIAL
// ---------------------------------------------------------------------------
// authenticateSocket (middleware/auth.js) answered everything that threw with
// 'Authentication failed': a forged or expired token, and equally a pool
// timeout or a Postgres restart during the user lookup. The client counts
// that string as a strike against a dead credential, and, more to the point,
// nothing on the client dialled again after ANY middleware refusal:
// socket.io-client destroys the socket on a CONNECT_ERROR packet and switches
// its manager's reconnection off. One database blip during a handshake left a
// foreground app with no live chat until it was backgrounded.
//
// Two halves, two files. This one holds the server to a distinct, retryable
// answer when the lookup fails, and proves over a real connection, with the
// client the app ships, both that the answer arrives intact and that the
// library really does leave the retry to the app. The client's retry loop is
// held by frontend/src/__tests__/socketHandshakeRetry.test.js.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { Server } = require('socket.io');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'socket-handshake-retry-secret';

const pool = require('../config/database');
const { authenticateSocket, signUserToken, SOCKET_RETRYABLE_MESSAGE } = require('../middleware/auth');

const ME = { id: 41, email: 'me@example.com', name: 'Me', role: 'user', profile_image_url: null, email_verified: true, is_banned: false, token_version: 0 };
const TOKEN = signUserToken(ME);

// The lookup either answers with ME or throws the way a saturated pool does.
let lookupFails = 0;
const realQuery = pool.query;
test.before(() => {
  pool.query = async (text) => {
    if (String(text).includes('FROM users WHERE id = $1')) {
      if (lookupFails > 0) {
        lookupFails -= 1;
        throw new Error('timeout exceeded when trying to connect');
      }
      return { rows: [ME], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
});
test.after(() => { pool.query = realQuery; });

function handshake(auth) {
  return new Promise((resolve) => {
    authenticateSocket({ handshake: { auth } }, (err) => resolve(err));
  });
}

test('a lookup that throws is answered as retryable, not as a failed authentication', async () => {
  lookupFails = 1;
  const quiet = console.error;
  console.error = () => {};
  let err;
  try { err = await handshake({ token: TOKEN }); } finally { console.error = quiet; }
  assert.ok(err, 'the handshake must be refused while the lookup is failing');
  assert.strictEqual(err.message, SOCKET_RETRYABLE_MESSAGE);
  assert.deepStrictEqual(err.data, { retryable: true });
});

test('a credential that is actually bad is still refused as one', async () => {
  lookupFails = 0;
  assert.strictEqual((await handshake({ token: 'not-a-jwt' })).message, 'Authentication failed');
  assert.strictEqual((await handshake({})).message, 'No token provided');
  assert.strictEqual(await handshake({ token: TOKEN }), undefined, 'a good token connects');
});

test('the retryable answer carries none of the strings the client counts as a dead credential', () => {
  // Read from the client itself, so a word added to its fatal list that the
  // busy answer happens to contain is caught here rather than in production.
  const clientSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'src', 'services', 'socket.js'), 'utf8');
  const block = clientSrc.match(/const FATAL_AUTH_ERRORS = \[([\s\S]*?)\];/);
  assert.ok(block, 'frontend/src/services/socket.js must still declare FATAL_AUTH_ERRORS');
  const fatal = [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.ok(fatal.includes('authentication failed'), `unexpected fatal list: ${fatal.join(', ')}`);
  for (const phrase of fatal) {
    assert.ok(!SOCKET_RETRYABLE_MESSAGE.toLowerCase().includes(phrase),
      `the busy answer contains "${phrase}", so the client would count a database blip as a strike`);
  }
});

// The real client, from frontend/node_modules: see deployReconnect.test.js for
// why it is loaded from there rather than installed into backend.
let clientIo = null;
let skipReason = false;
try {
  clientIo = require(require.resolve('socket.io-client', { paths: [path.join(__dirname, '..', '..', 'frontend')] })).io;
} catch (_) {
  skipReason = 'socket.io-client is not installed under frontend/ (run npm install there)';
}

test('over a real connection: the busy answer arrives intact, the library leaves the retry to the app, and the retry gets in',
  { skip: skipReason, timeout: 15000 }, async () => {
    const server = http.createServer();
    const io = new Server(server, { transports: ['websocket', 'polling'] });
    io.use(authenticateSocket);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    const client = clientIo(`http://127.0.0.1:${port}`, {
      auth: { token: TOKEN },
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 50,
      reconnectionDelayMax: 200,
    });
    const quiet = console.error;
    console.error = () => {};
    try {
      lookupFails = 1;
      const [err] = await new Promise((resolve) => client.once('connect_error', (...a) => resolve(a)));
      assert.strictEqual(err.message, SOCKET_RETRYABLE_MESSAGE);
      assert.deepStrictEqual(err.data, { retryable: true }, 'the retryable flag must survive the wire');

      // The premise the client's retry loop exists for. Give the library far
      // longer than its own backoff to prove it is not going to try again.
      assert.strictEqual(client.active, false, 'socket.io-client gives up on a refused handshake');
      await new Promise((r) => setTimeout(r, 600));
      assert.strictEqual(client.connected, false, 'and nothing reconnected it behind our back');

      // What frontend/src/services/socket.js now does once the backoff fires.
      client.connect();
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('the retry never connected')), 5000);
        client.once('connect', () => { clearTimeout(t); resolve(); });
      });
      assert.strictEqual(client.connected, true);
    } finally {
      console.error = quiet;
      client.close();
      await io.close();
    }
  });
