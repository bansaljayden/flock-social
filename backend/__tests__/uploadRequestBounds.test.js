// ---------------------------------------------------------------------------
// The avatar upload's request bounds: routes/users.js
// ---------------------------------------------------------------------------
// `POST /api/users/upload-image` is the only multipart endpoint in the app, and
// multipart is the one transport express.json() does not bound. Its ceiling is
// whatever multer's `limits` says, and every limit multer is not TOLD about
// defaults to Infinity.
//
// The hole this suite pins closed: `fileSize` bounded the FILE and nothing
// bounded the REQUEST. A multipart body of ordinary text fields with no file
// part at all is accumulated into req.body one allocation per field, forever, on
// one connection. The billed-image limiter in server.js refuses requests, and
// that is one request, so it cannot help. On a Railway container that is an OOM
// and a restart, which is every user offline.
//
// Nothing here asserts a byte-for-byte error string; what matters is that the
// stream stops being read, which is what a MulterError means.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const express = require('express');
const multer = require('multer');

const { upload, detectImageFormat } = require('../routes/users').__testing;

// --- a real multipart body, built by hand -----------------------------------
const BOUNDARY = 'flocktestboundary';

function filePart(name, filename, contentType, bytes) {
  return Buffer.concat([
    Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"; filename="${filename}"\r\n`
      + `Content-Type: ${contentType}\r\n\r\n`, 'latin1'),
    bytes,
    Buffer.from('\r\n', 'latin1'),
  ]);
}

function textPart(name, value) {
  return Buffer.from(
    `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`, 'latin1');
}

const closing = () => Buffer.from(`--${BOUNDARY}--\r\n`, 'latin1');

// A real JPEG, small. detectImageFormat is imported so the fixture is one the
// route's own byte-typer accepts rather than one this file merely believes in.
const JPEG = Buffer.concat([
  Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]),
  Buffer.from([0x00, 0x10]), Buffer.from('JFIF\0', 'latin1'), Buffer.alloc(9),
  Buffer.from([0xFF, 0xDA, 0x00, 0x05, 0x01, 0x01, 0x00]),
  Buffer.from([0x11, 0x22, 0x33]),
  Buffer.from([0xFF, 0xD9]),
]);

// A bare harness around the SAME multer instance the route uses. Driving the
// route itself would need auth, a database and a Vision stub; what is under test
// is the middleware's limits, so the middleware is what gets driven.
let server;
let base;
let received;

test.before(() => new Promise((resolve) => {
  const app = express();
  app.post('/upload', (req, res) => {
    upload.single('image')(req, res, (err) => {
      if (err) {
        return res.status(400).json({
          multerError: err instanceof multer.MulterError,
          code: err.code || null,
        });
      }
      received = {
        fileBytes: req.file ? req.file.buffer.length : 0,
        fieldCount: Object.keys(req.body || {}).length,
        fieldBytes: Object.values(req.body || {}).join('').length,
      };
      res.json({ ok: true, ...received });
    });
  });
  server = http.createServer(app);
  server.listen(0, '127.0.0.1', () => {
    base = `http://127.0.0.1:${server.address().port}`;
    resolve();
  });
}));

test.after(() => new Promise((resolve) => server.close(resolve)));

async function post(body) {
  const res = await fetch(`${base}/upload`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${BOUNDARY}` },
    body,
  });
  return { status: res.status, body: await res.json() };
}

// ---------------------------------------------------------------------------

test('the fixture is an image by the route\'s own byte-typer', () => {
  assert.strictEqual(detectImageFormat(JPEG), 'jpeg');
});

test('an ordinary single-file upload still works', async () => {
  const out = await post(Buffer.concat([
    filePart('image', 'photo.jpg', 'image/jpeg', JPEG),
    closing(),
  ]));
  assert.strictEqual(out.status, 200);
  assert.strictEqual(out.body.fileBytes, JPEG.length);
});

test('a body of nothing but text fields is refused instead of buffered without end', async () => {
  // The shape of the OOM: no file part at all, just fields. Before the limits
  // were named this returned 200 with 5,000 fields in req.body, and 5,000 is
  // only where this test stops, not where multer would have.
  const parts = [];
  for (let i = 0; i < 5000; i++) parts.push(textPart(`f${i}`, 'x'.repeat(200)));
  parts.push(closing());

  const out = await post(Buffer.concat(parts));
  assert.strictEqual(out.status, 400);
  assert.strictEqual(out.body.multerError, true);
  assert.ok(['LIMIT_PART_COUNT', 'LIMIT_FIELD_COUNT'].includes(out.body.code), out.body.code);
});

test('one oversized text field is refused on its own', async () => {
  const out = await post(Buffer.concat([
    textPart('caption', 'x'.repeat(64 * 1024)),
    closing(),
  ]));
  assert.strictEqual(out.status, 400);
  assert.strictEqual(out.body.multerError, true);
  assert.strictEqual(out.body.code, 'LIMIT_FIELD_VALUE');
});

test('a second file part is refused: this endpoint takes exactly one image', async () => {
  const out = await post(Buffer.concat([
    filePart('image', 'a.jpg', 'image/jpeg', JPEG),
    filePart('image', 'b.jpg', 'image/jpeg', JPEG),
    closing(),
  ]));
  assert.strictEqual(out.status, 400);
  assert.strictEqual(out.body.multerError, true);
  // .single() already refuses a second part by name; the point of files:1 is
  // that the refusal does not depend on which name the attacker chose.
  assert.ok(['LIMIT_FILE_COUNT', 'LIMIT_UNEXPECTED_FILE', 'LIMIT_PART_COUNT'].includes(out.body.code), out.body.code);
});

test('a file over 5 MB is refused, and the refusal is the one the route names', async () => {
  const big = Buffer.concat([JPEG, Buffer.alloc(6 * 1024 * 1024, 0x41)]);
  const out = await post(Buffer.concat([
    filePart('image', 'big.jpg', 'image/jpeg', big),
    closing(),
  ]));
  assert.strictEqual(out.status, 400);
  assert.strictEqual(out.body.code, 'LIMIT_FILE_SIZE');
});

test('every limit that defaults to Infinity is named', () => {
  // The actual defect was an unnamed default, not a wrong number, so this reads
  // the config rather than re-testing behaviour: a future edit that drops one of
  // these silently restores Infinity, and no behavioural test would fail until
  // the container was already dying.
  //
  // multer keeps its options on the middleware factory it returns; reaching for
  // them is a test-only liberty, and the assertions below are about which keys
  // exist, not about multer's internals staying stable.
  const limits = upload.limits || {};
  for (const key of ['fileSize', 'files', 'parts', 'fields', 'fieldSize', 'fieldNameSize']) {
    assert.strictEqual(typeof limits[key], 'number', `limits.${key} is unset, so it is Infinity`);
    assert.ok(limits[key] > 0 && Number.isFinite(limits[key]), `limits.${key} must be finite`);
  }
  // The file ceiling and the stored-avatar ceiling are different numbers on
  // purpose (5 MB raw upload, 600 KB stored data URL); this only pins that the
  // raw one has not drifted somewhere absurd.
  assert.strictEqual(limits.fileSize, 5 * 1024 * 1024);
  assert.strictEqual(limits.files, 1);
});
