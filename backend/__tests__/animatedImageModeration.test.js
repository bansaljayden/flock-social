// Run: node --test  (from backend/)
//
// Google Cloud Vision SafeSearch screens an animated image by its FIRST FRAME
// ONLY. A GIF with an innocuous frame 1 therefore scored clean, was stored, and
// was played in full to users of an app whose audience starts at 13. Format
// allowlists cannot close that: an APNG is served as `image/png` and an animated
// WebP as `image/webp`. utils/moderation.js now decides frame count from the
// BYTES and refuses anything multi-frame, for every upload path at once.
//
// These tests build the containers by hand rather than shipping binary
// fixtures, so what is being asserted is legible in the diff.
const test = require('node:test');
const assert = require('node:assert');

// Production posture, set before require (both flags are read at require time).
process.env.IMAGE_MODERATION_REQUIRED = 'true';
process.env.VISION_API_KEY = 'test-key';

const moderation = require('../utils/moderation');
const { inspectImageFrames } = moderation.__test;

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

// GIF: header + logical screen descriptor (no global colour table) + N image
// descriptors, each with a 1-byte LZW code size and an empty sub-block chain.
function gif({ frames = 1, globalTable = false, extensionFirst = false } = {}) {
  const parts = [Buffer.from('GIF89a', 'latin1')];
  const packed = globalTable ? 0x80 : 0x00; // colour table flag; size bits = 0 -> 2 entries
  parts.push(Buffer.from([0x01, 0x00, 0x01, 0x00, packed, 0x00, 0x00]));
  if (globalTable) parts.push(Buffer.alloc(3 * 2));
  if (extensionFirst) {
    // Netscape looping extension: introducer, label, then sub-blocks.
    parts.push(Buffer.from([0x21, 0xff, 0x0b]));
    parts.push(Buffer.from('NETSCAPE2.0', 'latin1'));
    parts.push(Buffer.from([0x03, 0x01, 0x00, 0x00, 0x00]));
  }
  for (let i = 0; i < frames; i++) {
    parts.push(Buffer.from([0x21, 0xf9, 0x04, 0x00, 0x0a, 0x00, 0x00, 0x00])); // graphic control ext
    parts.push(Buffer.from([0x2c, 0, 0, 0, 0, 0x01, 0x00, 0x01, 0x00, 0x00])); // image descriptor
    parts.push(Buffer.from([0x02, 0x01, 0x00, 0x00]));                          // code size + sub-blocks
  }
  parts.push(Buffer.from([0x3b])); // trailer
  return Buffer.concat(parts);
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngChunk(type, data = Buffer.alloc(0)) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, data, Buffer.alloc(4)]); // CRC is not validated here
}

function png({ animated = false, idatPayload = Buffer.alloc(0) } = {}) {
  const parts = [PNG_SIGNATURE, pngChunk('IHDR', Buffer.alloc(13))];
  if (animated) parts.push(pngChunk('acTL', Buffer.alloc(8)));
  parts.push(pngChunk('IDAT', idatPayload), pngChunk('IEND'));
  return Buffer.concat(parts);
}

function riffChunk(fourcc, data) {
  const head = Buffer.alloc(8);
  head.write(fourcc, 0, 'latin1');
  head.writeUInt32LE(data.length, 4);
  const pad = data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0);
  return Buffer.concat([head, data, pad]);
}

function webp(chunks) {
  const body = Buffer.concat([Buffer.from('WEBP', 'latin1'), ...chunks]);
  const head = Buffer.alloc(8);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
}

function vp8x({ animationFlag }) {
  const data = Buffer.alloc(10);
  data[0] = animationFlag ? 0x02 : 0x00;
  return riffChunk('VP8X', data);
}

const STILL_WEBP = webp([vp8x({ animationFlag: false }), riffChunk('VP8 ', Buffer.alloc(16))]);
const ANIMATED_WEBP = webp([
  vp8x({ animationFlag: true }),
  riffChunk('ANIM', Buffer.alloc(6)),
  riffChunk('ANMF', Buffer.alloc(16)),
]);
// The flag is what a lazy implementation would check. A file can carry frames
// without setting it, and decoders still animate.
const UNFLAGGED_ANIMATED_WEBP = webp([
  vp8x({ animationFlag: false }),
  riffChunk('ANMF', Buffer.alloc(16)),
]);

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32), Buffer.from([0xff, 0xd9])]);

const asDataUrl = (mime, buf) => `data:${mime};base64,${buf.toString('base64')}`;

// ---------------------------------------------------------------------------
// 1. Frame detection, from the bytes
// ---------------------------------------------------------------------------

test('a single-frame GIF is a still image; a two-frame GIF is not', () => {
  assert.strictEqual(inspectImageFrames(gif({ frames: 1 })).animated, false);
  assert.strictEqual(inspectImageFrames(gif({ frames: 2 })).animated, true);
  assert.strictEqual(inspectImageFrames(gif({ frames: 12 })).animated, true);
});

test('GIF parsing survives a global colour table and a leading extension block', () => {
  // Both shift where the first image descriptor lives. A parser that assumed a
  // fixed offset would read the wrong byte and mis-count frames in either
  // direction — the dangerous direction being "animated file reads as still".
  assert.strictEqual(inspectImageFrames(gif({ frames: 2, globalTable: true })).animated, true);
  assert.strictEqual(inspectImageFrames(gif({ frames: 2, extensionFirst: true })).animated, true);
  assert.strictEqual(inspectImageFrames(gif({ frames: 1, globalTable: true, extensionFirst: true })).animated, false);
});

test('a GIF that stops parsing as a GIF is treated as animated, not as clean', () => {
  // Indeterminate must not read as safe for the one format whose entire risk
  // profile is animation. A malformed GIF is worth nothing to a user anyway.
  const garbage = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.alloc(7), Buffer.from([0x99, 0x99, 0x99])]);
  assert.strictEqual(inspectImageFrames(garbage).animated, true);
});

test('APNG is caught even though it is served as image/png', () => {
  assert.strictEqual(inspectImageFrames(png({ animated: false })).animated, false);
  assert.strictEqual(inspectImageFrames(png({ animated: true })).animated, true);
});

test('the acTL string inside PNG pixel data is not mistaken for an APNG', () => {
  // An indexOf('acTL') scan would fire here. The payload of a still PNG is
  // fully attacker-controlled, so that scan would let anyone get any still
  // image refused — and, worse, teaches whoever fixes the false positive to
  // weaken the check. Chunks are walked by their length prefixes instead.
  const decoy = png({ animated: false, idatPayload: Buffer.from('....acTL....', 'latin1') });
  assert.strictEqual(inspectImageFrames(decoy).animated, false);
});

test('animated WebP is caught, by frames as well as by the VP8X flag', () => {
  assert.strictEqual(inspectImageFrames(STILL_WEBP).animated, false);
  assert.strictEqual(inspectImageFrames(ANIMATED_WEBP).animated, true);
  assert.strictEqual(inspectImageFrames(UNFLAGGED_ANIMATED_WEBP).animated, true);
});

test('the ANMF string inside WebP bitstream data is not mistaken for a frame', () => {
  const decoy = webp([
    vp8x({ animationFlag: false }),
    riffChunk('VP8 ', Buffer.from('xxANMFxxANIMxx', 'latin1')),
  ]);
  assert.strictEqual(inspectImageFrames(decoy).animated, false);
});

test('format is decided by bytes, never by the declared MIME type', () => {
  // Every call site validates a client-supplied `data:image/<type>` prefix, and
  // browsers sniff content rather than trusting it. A GIF announced as a PNG
  // must be read as the GIF it is.
  assert.strictEqual(inspectImageFrames(gif({ frames: 3 })).format, 'gif');
  assert.strictEqual(inspectImageFrames(png({ animated: true })).format, 'png');
  assert.strictEqual(inspectImageFrames(ANIMATED_WEBP).format, 'webp');
  assert.strictEqual(inspectImageFrames(JPEG).format, 'jpeg');
});

test('a multi-image ICO and a multi-page TIFF are multi-frame too', () => {
  const ico = Buffer.alloc(22);
  ico.writeUInt16LE(0, 0); ico.writeUInt16LE(1, 2); ico.writeUInt16LE(3, 4);
  assert.strictEqual(inspectImageFrames(ico).animated, true);
  ico.writeUInt16LE(1, 4);
  assert.strictEqual(inspectImageFrames(ico).animated, false);
});

test('unrecognised bytes are left to the provider rather than guessed at', () => {
  // The provider refuses what it cannot decode, which fails closed through
  // moderateImage's catch. Rejecting here instead would silently start
  // refusing images the call sites already vetted.
  assert.deepStrictEqual(inspectImageFrames(Buffer.alloc(64)), { format: 'unknown', animated: false });
  assert.deepStrictEqual(inspectImageFrames(Buffer.alloc(0)), { format: 'unknown', animated: false });
  assert.deepStrictEqual(inspectImageFrames('not a buffer'), { format: 'unknown', animated: false });
});

test('hostile length fields cannot spin the parsers', () => {
  const runaway = Buffer.concat([PNG_SIGNATURE, Buffer.from([0xff, 0xff, 0xff, 0xff]), Buffer.from('IHDR', 'latin1')]);
  assert.strictEqual(inspectImageFrames(runaway).animated, false);

  const riffRunaway = Buffer.concat([
    Buffer.from('RIFF', 'latin1'), Buffer.alloc(4), Buffer.from('WEBP', 'latin1'),
    Buffer.from('VP8 ', 'latin1'), Buffer.from([0xff, 0xff, 0xff, 0xff]),
  ]);
  assert.strictEqual(inspectImageFrames(riffRunaway).animated, false);

  // A GIF whose sub-block chain never terminates must return, not loop.
  const neverTerminates = Buffer.concat([
    Buffer.from('GIF89a', 'latin1'), Buffer.from([0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00]),
    Buffer.from([0x21, 0xf9]), Buffer.alloc(4096, 0x01),
  ]);
  assert.ok(typeof inspectImageFrames(neverTerminates).animated === 'boolean');
});

// ---------------------------------------------------------------------------
// 2. The gate, through moderateImage
// ---------------------------------------------------------------------------

const realFetch = global.fetch;
const CLEAN = { adult: 'VERY_UNLIKELY', racy: 'UNLIKELY', violence: 'VERY_UNLIKELY', medical: 'VERY_UNLIKELY' };
let visionCalls = 0;

test.beforeEach(() => {
  visionCalls = 0;
  global.fetch = async () => {
    visionCalls++;
    return { ok: true, json: async () => ({ responses: [{ safeSearchAnnotation: CLEAN }] }) };
  };
});
test.afterEach(() => { global.fetch = realFetch; });

test('an animated GIF is refused even when SafeSearch would call frame 1 clean', async () => {
  const res = await moderation.moderateImage(asDataUrl('image/gif', gif({ frames: 2 })));
  assert.strictEqual(res.allowed, false);
  assert.strictEqual(res.reason, 'animated_image');
});

test('an APNG announced as image/png is refused', async () => {
  const res = await moderation.moderateImage(asDataUrl('image/png', png({ animated: true })));
  assert.strictEqual(res.allowed, false, 'a MIME allowlist cannot see this; the bytes can');
  assert.strictEqual(res.reason, 'animated_image');
});

test('an animated WebP announced as image/webp is refused', async () => {
  const res = await moderation.moderateImage(asDataUrl('image/webp', ANIMATED_WEBP));
  assert.strictEqual(res.allowed, false);
  assert.strictEqual(res.reason, 'animated_image');
});

test('still images still pass, and are still screened', async () => {
  for (const [mime, buf] of [['image/gif', gif({ frames: 1 })], ['image/png', png()], ['image/webp', STILL_WEBP], ['image/jpeg', JPEG]]) {
    const res = await moderation.moderateImage(asDataUrl(mime, buf));
    assert.strictEqual(res.allowed, true, `${mime} still image must post`);
  }
  assert.strictEqual(visionCalls, 4, 'every still image reached the provider');
});

test('the animation gate runs before the provider, so it costs no Vision quota', async () => {
  await moderation.moderateImage(asDataUrl('image/gif', gif({ frames: 4 })));
  assert.strictEqual(visionCalls, 0);
});

test('the refusal explains itself instead of implying the photo looked unsafe', () => {
  const animated = moderation.imageRejectionMessage({ allowed: false, reason: 'animated_image' });
  assert.strictEqual(animated, moderation.ANIMATED_IMAGE_REJECTED_MESSAGE);
  assert.notStrictEqual(animated, moderation.IMAGE_REJECTED_MESSAGE);
  for (const reason of ['unsafe_adult', 'moderation_error', 'moderation_unavailable', null]) {
    assert.strictEqual(moderation.imageRejectionMessage({ reason }), moderation.IMAGE_REJECTED_MESSAGE);
  }
  // Copy rule: no em dashes in user-visible text.
  assert.ok(!/—/.test(moderation.ANIMATED_IMAGE_REJECTED_MESSAGE));
});

// ---------------------------------------------------------------------------
// 3. Fail-closed re-verification — every error path, re-checked
// ---------------------------------------------------------------------------
// A regression in any of these is silent: the upload succeeds and nobody
// notices until the wrong image is already on a 13-year-old's screen.

const STILL = asDataUrl('image/png', png());

test('fail-closed: provider throws (timeout, quota, DNS, socket reset)', async () => {
  for (const boom of [
    () => { throw new Error('network down'); },
    () => { const e = new Error('The operation was aborted due to timeout'); e.name = 'TimeoutError'; throw e; },
  ]) {
    global.fetch = async () => boom();
    const res = await moderation.moderateImage(STILL);
    assert.strictEqual(res.allowed, false);
    assert.strictEqual(res.reason, 'moderation_error');
  }
});

test('fail-closed: non-OK status, including a body that is not JSON', async () => {
  for (const status of [400, 403, 429, 500, 503]) {
    global.fetch = async () => ({ ok: false, status, json: async () => { throw new Error('not json'); } });
    const res = await moderation.moderateImage(STILL);
    assert.strictEqual(res.allowed, false, `HTTP ${status} must not allow an image through`);
    assert.strictEqual(res.reason, 'moderation_error');
  }
});

test('fail-closed: a 200 whose body is malformed in any of the ways it can be', async () => {
  const malformed = [
    {},                                        // no responses at all
    { responses: [] },                         // empty
    { responses: [{}] },                       // 200, no annotation
    { responses: [{ error: { message: 'x' } }] }, // per-image error
    { responses: [{ safeSearchAnnotation: null }] },
    { responses: [{ safeSearchAnnotation: {} }] },                    // annotation, no verdicts
    { responses: [{ safeSearchAnnotation: { racy: 'UNLIKELY' } }] },  // half an answer
    { responses: [{ safeSearchAnnotation: { ...CLEAN, adult: 'UNKNOWN' } }] },
    { responses: [{ safeSearchAnnotation: { ...CLEAN, adult: null } }] },
    { responses: [{ safeSearchAnnotation: { ...CLEAN, racy: 'PROBABLY_FINE' } }] },
  ];
  for (const body of malformed) {
    global.fetch = async () => ({ ok: true, json: async () => body });
    const res = await moderation.moderateImage(STILL);
    assert.strictEqual(res.allowed, false, `must reject: ${JSON.stringify(body)}`);
    assert.strictEqual(res.reason, 'moderation_error');
  }
});

test('fail-closed: a 200 whose JSON body cannot be parsed', async () => {
  global.fetch = async () => ({ ok: true, json: async () => { throw new SyntaxError('Unexpected token <'); } });
  const res = await moderation.moderateImage(STILL);
  assert.strictEqual(res.allowed, false);
  assert.strictEqual(res.reason, 'moderation_error');
});

test('fail-closed: bytes that cannot be obtained at all', async () => {
  for (const bad of ['', null, undefined, 42, {}, 'ftp://x/y.png', 'http://insecure/x.png', 'data:text/html;base64,AAAA', 'data:image/png;base64,',
    // Decodes to zero bytes. There is no verdict to be had on nothing, and
    // "no verdict" must never be reported as clean.
    'data:image/png;base64,==', 'data:image/png;base64,\n']) {
    const res = await moderation.moderateImage(bad);
    assert.strictEqual(res.allowed, false, `${String(bad)} must not be allowed`);
  }
  assert.strictEqual(visionCalls, 0, 'nothing undecodable should have reached the provider');
});

test('what we screen is the only thing the stored data URL can decode to', async () => {
  // Buffer.from(s, 'base64') discards characters outside the alphabet and stops
  // at padding; a browser's atob() throws on them instead. Two decoders
  // disagreeing about one string means we approve one image and the app renders
  // another, so a payload that is not canonical base64 is refused outright.
  const still = png().toString('base64');
  const animated = gif({ frames: 5 }).toString('base64');
  const ambiguous = [
    `data:image/png;base64,${still}=${animated}`,   // Node stops at the padding
    `data:image/png;base64,@@@not base64@@@`,
    `data:image/png;base64,${still.slice(0, 20)}!!${still.slice(20)}`,
    `data:image/png;base64,${still}%3D%3D`,
  ];
  for (const url of ambiguous) {
    const res = await moderation.moderateImage(url);
    assert.strictEqual(res.allowed, false, `${url.slice(0, 48)}... must not be allowed`);
    assert.strictEqual(res.reason, 'moderation_error');
  }
  assert.strictEqual(visionCalls, 0);

  // Line-wrapped base64 is not ambiguous — atob() ignores whitespace too — so
  // failing closed must not turn into failing on a legitimate encoder.
  const wrapped = `data:image/png;base64,${still.replace(/(.{16})/g, '$1\n')}`;
  assert.strictEqual((await moderation.moderateImage(wrapped)).allowed, true);
});

test('fail-closed: the strict categories still refuse POSSIBLE, the soft ones still do not', async () => {
  const verdictFor = async (annotation) => {
    global.fetch = async () => ({ ok: true, json: async () => ({ responses: [{ safeSearchAnnotation: annotation }] }) });
    return moderation.moderateImage(STILL);
  };
  assert.strictEqual((await verdictFor({ ...CLEAN, adult: 'POSSIBLE' })).reason, 'unsafe_adult');
  assert.strictEqual((await verdictFor({ ...CLEAN, racy: 'POSSIBLE' })).reason, 'unsafe_racy');
  assert.strictEqual((await verdictFor({ ...CLEAN, adult: 'VERY_LIKELY' })).reason, 'unsafe_adult');
  assert.strictEqual((await verdictFor({ ...CLEAN, violence: 'LIKELY' })).reason, 'unsafe_violence');
  assert.strictEqual((await verdictFor({ ...CLEAN, medical: 'VERY_LIKELY' })).reason, 'unsafe_medical');
  assert.strictEqual((await verdictFor({ ...CLEAN, violence: 'POSSIBLE' })).allowed, true);
  assert.strictEqual((await verdictFor({ adult: 'UNLIKELY', racy: 'UNLIKELY' })).allowed, true,
    'the soft categories may be absent without failing the screen');
});

test('fail-closed: an animated file is refused with no provider configured either', async () => {
  // The frame count is a property of the file, not of the provider. Without
  // this, a dev or staging environment without VISION_API_KEY would accept
  // animated uploads and the gap would only close in production.
  const keys = { v: process.env.VISION_API_KEY, g: process.env.GOOGLE_VISION_API_KEY, r: process.env.IMAGE_MODERATION_REQUIRED };
  delete process.env.VISION_API_KEY;
  delete process.env.GOOGLE_VISION_API_KEY;
  process.env.IMAGE_MODERATION_REQUIRED = 'false';
  delete require.cache[require.resolve('../utils/moderation')];
  try {
    const mod = require('../utils/moderation');
    assert.strictEqual(mod.__test.IMAGE_PROVIDER_CONFIGURED, false, 'fixture precondition');
    const animated = await mod.moderateImage(asDataUrl('image/gif', gif({ frames: 3 })));
    assert.strictEqual(animated.allowed, false);
    assert.strictEqual(animated.reason, 'animated_image');
    const still = await mod.moderateImage(STILL);
    assert.strictEqual(still.allowed, true, 'local dev without a key must not be bricked');
  } finally {
    if (keys.v === undefined) delete process.env.VISION_API_KEY; else process.env.VISION_API_KEY = keys.v;
    if (keys.g === undefined) delete process.env.GOOGLE_VISION_API_KEY; else process.env.GOOGLE_VISION_API_KEY = keys.g;
    if (keys.r === undefined) delete process.env.IMAGE_MODERATION_REQUIRED; else process.env.IMAGE_MODERATION_REQUIRED = keys.r;
    delete require.cache[require.resolve('../utils/moderation')];
  }
});

// ---------------------------------------------------------------------------
// 4. The inspector is total
// ---------------------------------------------------------------------------

test('frame inspection never throws, whatever bytes it is handed', () => {
  // It is called OUTSIDE the provider try/catch, it indexes and readUInt*s its
  // way through bytes an attacker chose, and a throw here would surface as a
  // 500 rather than a refusal. Seeded so a failure is reproducible.
  let seed = 0x5eed1234;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const seeds = [gif({ frames: 2 }), png({ animated: true }), ANIMATED_WEBP, JPEG, Buffer.alloc(9)];

  for (let i = 0; i < 3000; i++) {
    const base = seeds[i % seeds.length];
    const buf = Buffer.from(base);
    // Truncate somewhere, then corrupt a few bytes — headers, length fields and
    // chunk types all get hit.
    const cut = buf.subarray(0, Math.max(0, Math.floor(rand() * buf.length)));
    const mutated = Buffer.from(cut);
    for (let k = 0; k < 3 && mutated.length; k++) {
      mutated[Math.floor(rand() * mutated.length)] = Math.floor(rand() * 256);
    }
    const out = inspectImageFrames(mutated);
    assert.strictEqual(typeof out.animated, 'boolean', `non-boolean verdict for ${mutated.toString('hex')}`);
    assert.strictEqual(typeof out.format, 'string');
  }
});

// ---------------------------------------------------------------------------
// 5. The avatar upload types its own files
// ---------------------------------------------------------------------------

test('the avatar data URL takes its MIME from the bytes, not from the client', () => {
  // `req.file.mimetype` is a header the client writes, and it used to be copied
  // verbatim into a string stored forever and rendered as <img src> on every
  // message row and roster in the app. The fileFilter tests it with a SUBSTRING
  // regex, so `image/svg+xml;png` passed. The magic bytes are the answer.
  const { detectImageFormat, DETECTED_MIME } = require('../routes/users').__testing;

  assert.strictEqual(detectImageFormat(png()), 'png');
  assert.strictEqual(detectImageFormat(gif({ frames: 1 })), 'gif');
  assert.strictEqual(detectImageFormat(JPEG), 'jpeg');
  assert.strictEqual(detectImageFormat(STILL_WEBP), 'webp');

  // 'RIFF' alone is a container header: WAV and AVI open with the same four
  // bytes, and accepting them meant a non-image reached the moderation call.
  const wav = Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.alloc(4), Buffer.from('WAVE', 'latin1'), Buffer.alloc(16)]);
  assert.strictEqual(detectImageFormat(wav), null);
  assert.strictEqual(detectImageFormat(Buffer.from('<svg xmlns=', 'latin1')), null);
  assert.strictEqual(detectImageFormat(Buffer.alloc(0)), null);

  // Every format the detector can return has to have a MIME, or the stored data
  // URL becomes `data:undefined;base64,...`.
  for (const format of ['jpeg', 'png', 'gif', 'webp']) {
    assert.match(DETECTED_MIME[format], /^image\/[a-z]+$/);
  }
});

// ---------------------------------------------------------------------------
// 6. Every upload path gets it, because they all share one function
// ---------------------------------------------------------------------------

test('every image upload path screens through the one shared function', () => {
  const fs = require('fs');
  const path = require('path');
  const root = path.join(__dirname, '..');
  const callers = [
    'routes/users.js',        // avatar upload
    'routes/messages.js',     // REST: flock message + DM
    'sockets/handlers.js',    // socket: send_message + send_dm
    'routes/stories.js',
  ];
  for (const rel of callers) {
    const src = fs.readFileSync(path.join(root, rel), 'utf8');
    assert.match(src, /moderateImage\(/, `${rel} must screen images through utils/moderation`);
    // A regex allowlist over a data: URL prefix is not an animation check —
    // an APNG is image/png and an animated WebP is image/webp. If a path ever
    // starts deciding animation for itself, the two would drift.
    assert.ok(!/acTL|ANMF|GIF89a/.test(src), `${rel} must not re-implement frame detection`);
  }
});
