// ---------------------------------------------------------------------------
// EXIF / XMP / IPTC stripping: utils/imageMetadata.js
// ---------------------------------------------------------------------------
// Every user image in this app is stored inline as a base64 data: URL and
// re-served to other people. A photo off a phone carries a GPS block accurate to
// a few metres, so the question these tests ask is the blunt one: does a byte
// string that says "40.0193 N, 75.2952 W" survive the write path?
//
// The second question is the one that makes the fix safe to ship: does the
// stripper ever produce something that is NOT the same picture? Its contract is
// that an unparseable container comes back byte-identical, and that stripping
// only ever removes whole metadata segments: never image data, never a header a
// decoder needs.
const test = require('node:test');
const assert = require('node:assert/strict');

const { stripImageMetadata, stripDataUrlMetadata } = require('../utils/imageMetadata');

// --- fixture builders -------------------------------------------------------
// Real containers, built byte by byte, because a fixture that is not actually a
// JPEG proves nothing about a JPEG.

// A recognisable needle. If this string survives, the GPS block survived.
const GPS_NEEDLE = Buffer.from('GPSLatitudeRef=N;40.0193,-75.2952', 'latin1');

function jpegSegment(marker, payload) {
  const head = Buffer.alloc(4);
  head[0] = 0xFF;
  head[1] = marker;
  head.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([head, payload]);
}

// SOI, then whatever segments were asked for, then a minimal SOS + entropy data
// + EOI so the walker reaches a real stopping point.
function buildJpeg(segments) {
  return Buffer.concat([
    Buffer.from([0xFF, 0xD8]),
    ...segments,
    jpegSegment(0xDA, Buffer.from([0x01, 0x01, 0x00])), // SOS header
    Buffer.from([0x11, 0x22, 0x33, 0x44, 0x55]),        // "entropy coded data"
    Buffer.from([0xFF, 0xD9]),                           // EOI
  ]);
}

const JFIF = jpegSegment(0xE0, Buffer.concat([Buffer.from('JFIF\0', 'latin1'), Buffer.alloc(9)]));
const EXIF = jpegSegment(0xE1, Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), GPS_NEEDLE]));
const XMP = jpegSegment(0xE1, Buffer.concat([Buffer.from('http://ns.adobe.com/xap/1.0/\0', 'latin1'), GPS_NEEDLE]));
const IPTC = jpegSegment(0xED, Buffer.concat([Buffer.from('Photoshop 3.0\0', 'latin1'), GPS_NEEDLE]));
const COMMENT = jpegSegment(0xFE, Buffer.from('taken at home', 'latin1'));
const ICC = jpegSegment(0xE2, Buffer.concat([Buffer.from('ICC_PROFILE\0', 'latin1'), Buffer.alloc(20, 0x7A)]));
const ADOBE = jpegSegment(0xEE, Buffer.concat([Buffer.from('Adobe', 'latin1'), Buffer.alloc(7)]));
const SOF0 = jpegSegment(0xC0, Buffer.from([0x08, 0, 16, 0, 16, 0x01, 0x11, 0x00]));

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

function pngChunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  data.copy(out, 8);
  // CRC is never validated by the stripper (it copies chunks whole), so a
  // placeholder is honest here rather than pretending to compute one.
  out.writeUInt32BE(0xDEADBEEF, 8 + data.length);
  return out;
}

function buildPng(chunks) {
  return Buffer.concat([
    PNG_SIG,
    pngChunk('IHDR', Buffer.from([0, 0, 0, 16, 0, 0, 0, 16, 8, 6, 0, 0, 0])),
    ...chunks,
    pngChunk('IDAT', Buffer.from([0x78, 0x9C, 0x01, 0x00])),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function riffChunk(fourcc, data) {
  const head = Buffer.alloc(8);
  head.write(fourcc, 0, 'latin1');
  head.writeUInt32LE(data.length, 4);
  const pad = data.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0);
  return Buffer.concat([head, data, pad]);
}

function buildWebp(chunks) {
  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(4 + body.length, 4);
  header.write('WEBP', 8, 'latin1');
  return Buffer.concat([header, body]);
}

// VP8X flags byte: bit 3 EXIF, bit 2 XMP, bit 5 ICC, bit 4 alpha.
const vp8x = (flags) => riffChunk('VP8X', Buffer.concat([
  Buffer.from([flags, 0, 0, 0]), Buffer.from([15, 0, 0, 15, 0, 0]),
]));
const VP8L = riffChunk('VP8L', Buffer.from([0x2F, 0x00, 0x00, 0x00, 0x00]));

const holdsNeedle = (buf) => buf.includes(GPS_NEEDLE);

// ---------------------------------------------------------------------------
// 1. The GPS block does not survive
// ---------------------------------------------------------------------------

test('JPEG: EXIF, XMP, IPTC and COM all come out, and the GPS bytes go with them', () => {
  const original = buildJpeg([JFIF, EXIF, XMP, IPTC, COMMENT, SOF0]);
  assert.ok(holdsNeedle(original), 'fixture must actually contain the needle');

  const stripped = stripImageMetadata(original);
  assert.ok(!holdsNeedle(stripped), 'the GPS bytes are still in the stored image');
  assert.ok(!stripped.includes(Buffer.from('taken at home', 'latin1')), 'the comment survived');
  assert.ok(stripped.length < original.length);
});

test('PNG: eXIf, tEXt, iTXt, zTXt and tIME come out', () => {
  const original = buildPng([
    pngChunk('eXIf', GPS_NEEDLE),
    pngChunk('tEXt', Buffer.from('Comment\0taken at home', 'latin1')),
    pngChunk('iTXt', Buffer.from('XML:com.adobe.xmp\0\0\0\0\0', 'latin1')),
    pngChunk('zTXt', Buffer.from('Software\0\0zzz', 'latin1')),
    pngChunk('tIME', Buffer.from([0x07, 0xE8, 1, 1, 0, 0, 0])),
  ]);
  assert.ok(holdsNeedle(original));

  const stripped = stripImageMetadata(original);
  assert.ok(!holdsNeedle(stripped), 'the eXIf chunk is still there');
  assert.ok(!stripped.includes(Buffer.from('taken at home', 'latin1')));
  assert.ok(stripped.subarray(0, 8).equals(PNG_SIG), 'the signature must survive');
  assert.ok(stripped.includes(Buffer.from('IHDR', 'latin1')));
  assert.ok(stripped.includes(Buffer.from('IDAT', 'latin1')), 'image data must survive');
  assert.ok(stripped.includes(Buffer.from('IEND', 'latin1')));
});

test('WebP: the EXIF and XMP chunks come out AND the VP8X flags stop announcing them', () => {
  // 0x0C = EXIF flag + XMP flag set, which is what a phone writes.
  const original = buildWebp([vp8x(0x0C), VP8L, riffChunk('EXIF', GPS_NEEDLE), riffChunk('XMP ', GPS_NEEDLE)]);
  assert.ok(holdsNeedle(original));

  const stripped = stripImageMetadata(original);
  assert.ok(!holdsNeedle(stripped), 'the EXIF chunk is still there');
  assert.strictEqual(stripped.toString('latin1', 0, 4), 'RIFF');
  assert.strictEqual(stripped.toString('latin1', 8, 12), 'WEBP');
  // A file that still ANNOUNCES an EXIF chunk it no longer contains is rejected
  // by strict decoders. Both halves or neither.
  assert.strictEqual(stripped[20] & 0x0C, 0, 'VP8X still claims EXIF/XMP are present');
  // The RIFF size header has to describe the shorter body, or the container is
  // truncated as far as any reader is concerned.
  assert.strictEqual(stripped.readUInt32LE(4), stripped.length - 8);
  assert.ok(stripped.includes(Buffer.from('VP8L', 'latin1')), 'image data must survive');
});

test('a WebP whose only metadata is the VP8X flag bits still gets the bits cleared', () => {
  // Same length in, same length out. The identity check in stripDataUrlMetadata
  // exists for exactly this case; a length comparison would miss it.
  const original = buildWebp([vp8x(0x0C), VP8L]);
  const stripped = stripImageMetadata(original);
  assert.notStrictEqual(stripped, original);
  assert.strictEqual(stripped.length, original.length);
  assert.strictEqual(stripped[20] & 0x0C, 0);
});

// ---------------------------------------------------------------------------
// 2. What the stripper must NOT do
// ---------------------------------------------------------------------------

test('the segments a decoder needs are kept: JFIF, ICC and Adobe', () => {
  const original = buildJpeg([JFIF, ICC, ADOBE, EXIF, SOF0]);
  const stripped = stripImageMetadata(original);
  assert.ok(stripped.includes(Buffer.from('JFIF\0', 'latin1')), 'APP0 is the density header');
  // Dropping the ICC profile changes the COLOURS on a wide-gamut screen. That is
  // a visible regression on every avatar in the app, for no privacy gain.
  assert.ok(stripped.includes(Buffer.from('ICC_PROFILE\0', 'latin1')), 'APP2 carries the colour space');
  assert.ok(stripped.includes(Buffer.from('Adobe', 'latin1')), 'APP14 carries the colour transform flag');
  assert.ok(!holdsNeedle(stripped));
});

test('the entropy-coded image data past SOS is copied byte for byte', () => {
  const original = buildJpeg([JFIF, EXIF, SOF0]);
  const stripped = stripImageMetadata(original);
  const scan = Buffer.from([0x11, 0x22, 0x33, 0x44, 0x55]);
  assert.ok(stripped.includes(scan));
  // Ends where a JPEG ends.
  assert.deepStrictEqual([...stripped.subarray(-2)], [0xFF, 0xD9]);
});

test('an image with no metadata comes back as the SAME buffer, not a copy', () => {
  // Identity matters: the callers compose this with restampImageMime, whose own
  // tests assert the payload is byte-for-byte untouched in the common case.
  for (const buf of [
    buildJpeg([JFIF, SOF0]),
    buildPng([]),
    buildWebp([VP8L]),
    buildWebp([vp8x(0x20), VP8L]), // ICC flag set, no metadata flags
  ]) {
    assert.strictEqual(stripImageMetadata(buf), buf, buf.toString('latin1', 0, 4));
  }
});

test('anything that does not parse comes back untouched: this must never corrupt an image', () => {
  const cases = [
    ['truncated JPEG segment length', Buffer.from([0xFF, 0xD8, 0xFF, 0xE1, 0xFF, 0xFF, 0x00])],
    ['JPEG that never reaches a scan', Buffer.concat([Buffer.from([0xFF, 0xD8]), JFIF])],
    ['JPEG segment length below the minimum', Buffer.from([0xFF, 0xD8, 0xFF, 0xE1, 0x00, 0x01, 0x00, 0x00])],
    ['PNG with no IEND', Buffer.concat([PNG_SIG, pngChunk('IHDR', Buffer.alloc(13))])],
    ['PNG whose first chunk is not IHDR', Buffer.concat([PNG_SIG, pngChunk('eXIf', GPS_NEEDLE), pngChunk('IEND', Buffer.alloc(0))])],
    ['PNG chunk running past the end', Buffer.concat([PNG_SIG, Buffer.from([0x7F, 0xFF, 0xFF, 0xFF]), Buffer.from('IHDR', 'latin1')])],
    ['RIFF that is not WEBP', Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.from([16, 0, 0, 0]), Buffer.from('WAVE', 'latin1'), Buffer.alloc(12)])],
    ['WebP whose RIFF size overruns the buffer', Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.from([0xFF, 0xFF, 0, 0]), Buffer.from('WEBP', 'latin1')])],
    ['WebP with a partial chunk at the tail', Buffer.concat([buildWebp([VP8L]), Buffer.from('EX', 'latin1')])],
    ['WebP whose first chunk is not an image chunk', buildWebp([riffChunk('EXIF', GPS_NEEDLE), VP8L])],
    ['GIF, which this file deliberately does not walk', Buffer.concat([Buffer.from('GIF89a', 'latin1'), GPS_NEEDLE])],
    ['bytes that are no image at all', Buffer.from('not an image at all', 'latin1')],
    ['empty', Buffer.alloc(0)],
  ];
  for (const [what, buf] of cases) {
    assert.strictEqual(stripImageMetadata(buf), buf, what);
  }
});

test('non-buffers do not throw', () => {
  for (const v of [null, undefined, '', 'abc', 42, {}, []]) {
    assert.strictEqual(stripImageMetadata(v), v);
  }
});

// ---------------------------------------------------------------------------
// 3. The data: URL wrapper, which is the form every column actually stores
// ---------------------------------------------------------------------------

test('stripDataUrlMetadata removes the GPS block and keeps the declared prefix', () => {
  const original = buildJpeg([JFIF, EXIF, SOF0]);
  const url = `data:image/jpeg;base64,${original.toString('base64')}`;
  const out = stripDataUrlMetadata(url);

  assert.ok(out.startsWith('data:image/jpeg;base64,'), 'the prefix is restampImageMime\'s job, not this one\'s');
  const bytes = Buffer.from(out.slice(out.indexOf(',') + 1), 'base64');
  assert.ok(!holdsNeedle(bytes));
  assert.ok(bytes.length < original.length);
});

test('stripDataUrlMetadata passes through everything it cannot decode, exactly', () => {
  const clean = `data:image/png;base64,${buildPng([]).toString('base64')}`;
  for (const v of [
    null, undefined, '', 'no-comma-here', 'data:image/png;base64,',
    'data:image/png;base64,!!!!not base64!!!!',
    clean, // nothing to strip: character for character the same string
  ]) {
    assert.strictEqual(stripDataUrlMetadata(v), v, String(v).slice(0, 40));
  }
});

test('whitespace-padded payloads are decoded the way a browser decodes them', () => {
  // restampImageMime strips whitespace before sniffing for exactly this reason:
  // the WHATWG data: URL decoder ignores it anywhere in the payload, so a padded
  // payload still renders and still has to be stripped.
  const original = buildJpeg([JFIF, EXIF, SOF0]);
  const padded = `data:image/jpeg;base64,${' '.repeat(80)}${original.toString('base64')}`;
  const out = stripDataUrlMetadata(padded);
  const bytes = Buffer.from(out.slice(out.indexOf(',') + 1).replace(/\s+/g, ''), 'base64');
  assert.ok(!holdsNeedle(bytes), 'a padded payload skipped the strip');
});

// ---------------------------------------------------------------------------
// 4. The write paths compose it
// ---------------------------------------------------------------------------

test('sanitizeStoredImage re-types the MIME AND strips the metadata', () => {
  const { sanitizeStoredImage, restampImageMime } = require('../sockets/handlers');
  const original = buildJpeg([JFIF, EXIF, SOF0]);
  // Declared as PNG, so the re-type has work to do as well as the strip.
  const url = `data:image/png;base64,${original.toString('base64')}`;
  const out = sanitizeStoredImage(url);

  assert.ok(out.startsWith('data:image/jpeg;base64,'), 'the re-type did not run');
  const bytes = Buffer.from(out.slice(out.indexOf(',') + 1), 'base64');
  assert.ok(!holdsNeedle(bytes), 'the strip did not run');

  // And the order is restamp-then-strip: the re-typer must see the bytes it is
  // typing, not a payload something else has already rewritten.
  assert.strictEqual(restampImageMime(url).slice(0, 23), 'data:image/jpeg;base64,');
});

test('every stored-image write path calls sanitizeStoredImage, not the bare re-typer', () => {
  // The four columns that hold a user image as a data: URL. A new write path
  // that reaches for restampImageMime alone stores the GPS block, and nothing
  // else in the suite would notice.
  const fs = require('fs');
  const path = require('path');
  const files = [
    'routes/messages.js',   // flock photo + DM photo over REST
    'routes/stories.js',    // story
    'sockets/handlers.js',  // flock photo + DM photo over the socket
  ];
  for (const rel of files) {
    const src = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
    const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    const bare = code.match(/restampImageMime\(image_url\)/g) || [];
    assert.deepStrictEqual(bare, [], `${rel} stores a restamped-but-unstripped image`);
    assert.ok(/sanitizeStoredImage\(image_url\)/.test(code), `${rel} has no sanitized write`);
  }
});

test('the avatar path stores the stripped bytes, not req.file.buffer', () => {
  // routes/users.js builds its own data: URL from the multer buffer rather than
  // going through sanitizeStoredImage, so it is checked separately.
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes/users.js'), 'utf8');
  const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.ok(/stripImageMetadata\(req\.file\.buffer\)/.test(code), 'the avatar buffer is never stripped');
  assert.ok(!/base64,\$\{req\.file\.buffer\.toString\('base64'\)\}/.test(code),
    'the avatar data URL is built from the unstripped buffer');
});
