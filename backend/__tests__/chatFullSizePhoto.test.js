// Run: node --test  (from backend/)
//
// THE FULL-SIZE PHOTO READS — routes/messages.js
//
// History deliberately ships only the thumbnail for image messages (the CASE
// in both history SELECTs, chatImageThumbs round), and the full image stays in
// the row "for a future full-size viewer". That viewer exists now (Jayden,
// 2026-08-27: images are wanted in full, the bandwidth saving stays), and
// these two endpoints are the only door to the stored original. What is
// pinned: the flock read is membership-gated, the DM read answers 404 to a
// stranger (not 403, which would confirm the id exists), and a hidden
// (taken down) message serves nothing on either path.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

process.env.JWT_SECRET = 'full-size-photo-test-secret';

const pool = require('../config/database');
const { signUserToken } = require('../middleware/auth');

const ME = { id: 5, email: 'me@example.com', name: 'Me', role: 'user', email_verified: true, is_banned: false, token_version: 0 };
const TOKEN = signUserToken(ME);

// Script: each test sets these.
let isMember = false;
let flockImageRow = null;   // { image_url } or null for no-row
let dmRow = null;           // { sender_id, receiver_id, image_url } or null

pool.query = async (text, params = []) => {
  const sql = String(text).replace(/\s+/g, ' ').trim();
  if (sql.includes('FROM users WHERE id = $1') && sql.includes('token_version')) {
    return { rows: [ME], rowCount: 1 };
  }
  if (sql.includes('FROM flock_members WHERE flock_id = $1')) {
    return isMember ? { rows: [{ id: 1 }], rowCount: 1 } : { rows: [], rowCount: 0 };
  }
  if (sql.startsWith('SELECT image_url FROM messages')) {
    assert.match(sql, /COALESCE\(is_hidden, false\) = false/, 'a taken-down message serves nothing');
    return flockImageRow ? { rows: [flockImageRow], rowCount: 1 } : { rows: [], rowCount: 0 };
  }
  if (sql.includes('FROM direct_messages')) {
    assert.match(sql, /COALESCE\(is_hidden, false\) = false/, 'a taken-down DM serves nothing');
    return dmRow ? { rows: [dmRow], rowCount: 1 } : { rows: [], rowCount: 0 };
  }
  return { rows: [], rowCount: 0 };
};
pool.connect = async () => { throw new Error('pool.connect reached unexpectedly'); };

const app = express();
app.use(express.json());
app.use('/api', require('../routes/messages'));
const server = http.createServer(app);

function get(urlPath) {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    const req = http.request({
      host: '127.0.0.1', port: addr.port, path: urlPath, method: 'GET',
      headers: { Authorization: `Bearer ${TOKEN}` },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(raw); } catch { parsed = raw; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

test.before(() => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)));
test.after(() => new Promise((resolve) => server.close(resolve)));

test('a member gets the stored original', async () => {
  isMember = true;
  flockImageRow = { image_url: 'data:image/jpeg;base64,FULL' };
  const res = await get('/api/flocks/12/messages/34/image');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.image, 'data:image/jpeg;base64,FULL');
});

test('a non-member is refused before the message table is ever read', async () => {
  isMember = false;
  flockImageRow = { image_url: 'data:image/jpeg;base64,FULL' };
  const res = await get('/api/flocks/12/messages/34/image');
  assert.strictEqual(res.status, 403);
});

test('a message with no image, or no such message, is a plain 404', async () => {
  isMember = true;
  flockImageRow = null;
  let res = await get('/api/flocks/12/messages/34/image');
  assert.strictEqual(res.status, 404);
  flockImageRow = { image_url: null };
  res = await get('/api/flocks/12/messages/34/image');
  assert.strictEqual(res.status, 404);
});

test('a DM participant gets the original', async () => {
  dmRow = { sender_id: 5, receiver_id: 8, image_url: 'data:image/jpeg;base64,DMFULL' };
  const res = await get('/api/dm/messages/77/image');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.image, 'data:image/jpeg;base64,DMFULL');
});

test('a stranger gets 404, not 403, so the message id is not confirmed to exist', async () => {
  dmRow = { sender_id: 2, receiver_id: 8, image_url: 'data:image/jpeg;base64,DMFULL' };
  const res = await get('/api/dm/messages/77/image');
  assert.strictEqual(res.status, 404);
});

test('non-integer ids are refused by validation', async () => {
  const res = await get('/api/flocks/abc/messages/34/image');
  assert.strictEqual(res.status, 400);
  const res2 = await get('/api/dm/messages/abc/image');
  assert.strictEqual(res2.status, 400);
});
