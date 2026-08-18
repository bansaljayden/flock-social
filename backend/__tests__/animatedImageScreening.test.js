// Run: node --test  (from backend/)
//
// Round 19 of the animated-image gap. utils/moderation.js already refused GIF,
// APNG and animated WebP by inspecting the bytes; three ways past it were still
// open, and all three are reachable because every call site's allowlist checks
// the CLIENT-DECLARED prefix of a data: URL while Blink and WebKit choose an
// image decoder by SNIFFING the bytes. `data:image/png;base64,<anything>` is
// decoded as whatever the bytes actually are.
//
//   1. An ICO is a DIRECTORY of images and each entry may embed a whole PNG,
//      which may be an APNG. Counting directory entries missed a one-entry ICO
//      wrapping an animated PNG.
//   2. Animated AVIF and HEIF image SEQUENCES are `....ftyp....` containers.
//      They fell in the `unknown` bucket and passed the gate. Nothing reached
//      users, because Cloud Vision cannot decode either format and threw into
//      the fail-closed catch — but that is an accident of provider coverage,
//      not a control, and the iOS build is a WKWebView that decodes HEIF
//      natively.
//   3. routes/users.js typed avatar bytes with TRUNCATED magic (`GIF8`, four of
//      PNG's eight), so it and inspectImageFrames could reach different
//      conclusions about one file. Two byte-typers that disagree are a bypass
//      waiting to be found.
//
// Containers are built by hand rather than shipped as binary fixtures, so what
// is being asserted is legible in the diff.
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

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngChunk(type, data = Buffer.alloc(0)) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, data, Buffer.alloc(4)]); // CRC is not validated here
}

function png({ animated = false } = {}) {
  const parts = [PNG_SIGNATURE, pngChunk('IHDR', Buffer.alloc(13))];
  if (animated) parts.push(pngChunk('acTL', Buffer.alloc(8)));
  parts.push(pngChunk('IDAT'), pngChunk('IEND'));
  return Buffer.concat(parts);
}

function gif({ frames = 1 } = {}) {
  const parts = [Buffer.from('GIF89a', 'latin1'), Buffer.from([0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00])];
  for (let i = 0; i < frames; i++) {
    parts.push(Buffer.from([0x2c, 0, 0, 0, 0, 0x01, 0x00, 0x01, 0x00, 0x00]));
    parts.push(Buffer.from([0x02, 0x01, 0x00, 0x00]));
  }
  parts.push(Buffer.from([0x3b]));
  return Buffer.concat(parts);
}

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32), Buffer.from([0xff, 0xd9])]);

// ICO: 6-byte header, then `count` 16-byte directory entries, then the payloads.
// Each entry carries its payload's byte size at +8 and its file offset at +12.
function ico(payloads) {
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0);                 // reserved
  head.writeUInt16LE(1, 2);                 // type 1 = icon
  head.writeUInt16LE(payloads.length, 4);
  const dir = Buffer.alloc(16 * payloads.length);
  let offset = 6 + 16 * payloads.length;
  payloads.forEach((p, i) => {
    dir.writeUInt32LE(p.length, 16 * i + 8);
    dir.writeUInt32LE(offset, 16 * i + 12);
    offset += p.length;
  });
  return Buffer.concat([head, dir, ...payloads]);
}

// ISO base media container: `ftyp` box (major brand, minor version, compatible
// brands) followed by whatever top-level boxes are asked for.
function isoBox(type, payload) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + payload.length, 0);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, payload]);
}

function isobmff(major, compatible, boxes = []) {
  const ftyp = isoBox('ftyp', Buffer.concat([
    Buffer.from(major, 'latin1'),
    Buffer.from([0, 0, 0, 0]),
    ...compatible.map((b) => Buffer.from(b, 'latin1')),
  ]));
  return Buffer.concat([ftyp, ...boxes]);
}

const ANIMATED_AVIF = isobmff('avis', ['avis', 'avif', 'msf1'], [isoBox('moov', Buffer.alloc(32)), isoBox('mdat', Buffer.alloc(64))]);
const STILL_AVIF = isobmff('avif', ['avif', 'mif1', 'miaf'], [isoBox('meta', Buffer.alloc(32)), isoBox('mdat', Buffer.alloc(64))]);
const HEIF_SEQUENCE = isobmff('msf1', ['msf1', 'hevc'], [isoBox('moov', Buffer.alloc(32))]);
const STILL_HEIC = isobmff('heic', ['heic', 'mif1'], [isoBox('meta', Buffer.alloc(64))]);

const asDataUrl = (mime, buf) => `data:${mime};base64,${buf.toString('base64')}`;

// ---------------------------------------------------------------------------
// 1. ICO is a directory, and one entry is not one frame
// ---------------------------------------------------------------------------

test('a one-entry ICO wrapping an APNG is multi-frame', () => {
  // The whole trick: the directory says "1 image", which the old check read as
  // "a still", while the single entry is a complete animated PNG.
  assert.strictEqual(inspectImageFrames(ico([png({ animated: true })])).animated, true);
  assert.strictEqual(inspectImageFrames(ico([png()])).animated, false, 'a still icon must still post');
});

test('an ICO is inspected entry by entry, not just by its declared count', () => {
  assert.strictEqual(inspectImageFrames(ico([gif({ frames: 3 })])).animated, true);
  assert.strictEqual(inspectImageFrames(ico([png(), png(), png()])).animated, true, 'three images is three frames');
  assert.strictEqual(inspectImageFrames(ico([JPEG])).animated, false);
});

test('an ICO entry that points outside the file is not followed', () => {
  // A decoder cannot reach those bytes either, so there is nothing to inspect
  // and nothing to render.
  const overrun = ico([png({ animated: true })]);
  overrun.writeUInt32LE(0xfffffff0, 6 + 8);   // size past EOF
  assert.strictEqual(inspectImageFrames(overrun).animated, false);

  const backPointer = ico([png({ animated: true })]);
  backPointer.writeUInt32LE(0, 6 + 12);       // offset into the header itself
  assert.strictEqual(inspectImageFrames(backPointer).animated, false);

  const empty = ico([]);
  assert.strictEqual(inspectImageFrames(empty).animated, false);
});

test('an ICO nested inside itself terminates, and stops being provably still', () => {
  // Each level moves strictly forward into a strictly shorter slice, so this
  // cannot recurse forever; past the depth limit we can no longer prove single
  // frame, which takes the same answer as an unparseable GIF.
  let nested = png({ animated: true });
  for (let i = 0; i < 12; i++) nested = ico([nested]);
  const out = inspectImageFrames(nested);
  assert.strictEqual(out.animated, true);

  let benign = png();
  for (let i = 0; i < 12; i++) benign = ico([benign]);
  assert.strictEqual(inspectImageFrames(benign).animated, true,
    'a 12-deep icon is not something a user sends; unprovable is not clean');
});

// ---------------------------------------------------------------------------
// 2. ISO base media: animated AVIF and HEIF sequences
// ---------------------------------------------------------------------------

test('an animated AVIF is caught by its brand and by its movie box', () => {
  assert.strictEqual(inspectImageFrames(ANIMATED_AVIF).animated, true);
  // Either signal alone is enough: a file can carry a moov without advertising
  // a sequence brand, and vice versa.
  assert.strictEqual(inspectImageFrames(isobmff('avif', ['avif'], [isoBox('moov', Buffer.alloc(16))])).animated, true);
  assert.strictEqual(inspectImageFrames(isobmff('avis', ['avis', 'avif'], [isoBox('meta', Buffer.alloc(16))])).animated, true);
});

test('a HEIF image sequence is caught; a still HEIC and a still AVIF are not', () => {
  assert.strictEqual(inspectImageFrames(HEIF_SEQUENCE).animated, true);
  // Still HEIF/AVIF are left to the provider, exactly like any other container
  // this file does not claim to understand. Refusing them here would be a
  // format ban dressed up as a safety check.
  assert.strictEqual(inspectImageFrames(STILL_AVIF).animated, false);
  assert.strictEqual(inspectImageFrames(STILL_HEIC).animated, false);
});

test('the string "moov" inside sample data is not mistaken for a movie box', () => {
  // Boxes are walked by their size prefixes. A raw scan would fire on this, and
  // mdat contents are fully attacker-controlled.
  const decoy = isobmff('avif', ['avif', 'mif1'], [isoBox('mdat', Buffer.from('xxmoovxxavisxxhevcxx', 'latin1'))]);
  assert.strictEqual(inspectImageFrames(decoy).animated, false);
});

test('a malformed ftyp box cannot make the brand scan sweep the whole file', () => {
  // With an unusable box size the scan is capped at a fixed window. Sweeping
  // megabytes of attacker-chosen bytes four at a time would eventually hit a
  // brand by luck and refuse a valid image.
  const lying = isobmff('avif', ['avif'], [isoBox('mdat', Buffer.concat([Buffer.alloc(4096), Buffer.from('hevc', 'latin1')]))]);
  lying.writeUInt32BE(0xfffffff0, 0);          // ftyp size past EOF
  assert.strictEqual(inspectImageFrames(lying).animated, false);
});

test('ISO box sizes that cannot be walked end the walk instead of spinning it', () => {
  for (const size of [0, 1, 7, 0xffffffff]) {
    const buf = Buffer.concat([isoBox('ftyp', Buffer.from('avifavif', 'latin1')), Buffer.alloc(64)]);
    buf.writeUInt32BE(size, 0);
    const out = inspectImageFrames(buf);
    assert.strictEqual(typeof out.animated, 'boolean');
  }
});

test('an ftyp container is typed as one, not misread as an icon', () => {
  // The ICO signature is four loose bytes (00 00 01|02 00) that a big-endian
  // box-size field can imitate, so the more specific signature is tested first.
  assert.strictEqual(inspectImageFrames(ANIMATED_AVIF).format, 'isobmff');
  assert.strictEqual(inspectImageFrames(ico([png()])).format, 'ico');
});

// ---------------------------------------------------------------------------
// 3. MNG, the PNG family's animation container
// ---------------------------------------------------------------------------

test('MNG has its own signature and is animation by definition', () => {
  const mng = Buffer.concat([Buffer.from([0x8a, 0x4d, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
  assert.strictEqual(inspectImageFrames(mng).animated, true);
  // It must not be swallowed by the PNG branch, which looks for acTL and would
  // find none.
  assert.notStrictEqual(inspectImageFrames(mng).format, 'png');
});

// ---------------------------------------------------------------------------
// 4. The two byte-typers in this repo must agree about what a file is
// ---------------------------------------------------------------------------

test('routes/users.js and utils/moderation.js cannot disagree about a format', () => {
  const { detectImageFormat } = require('../routes/users').__testing;

  // Anything the avatar path types as an image must be a format the frame
  // inspector also recognises. Otherwise the avatar is stored as, say,
  // `data:image/gif` while the inspector treats it as an unknown container —
  // and unknown is the branch that does not look for extra frames.
  const inspectorKnows = new Set(['gif', 'png', 'webp', 'jpeg']);
  const files = [
    png(), png({ animated: true }), gif({ frames: 1 }), gif({ frames: 6 }), JPEG,
    Buffer.concat([Buffer.from('GIF87a', 'latin1'), Buffer.alloc(16)]),
  ];
  for (const buf of files) {
    const typed = detectImageFormat(buf);
    if (typed === null) continue;
    assert.ok(inspectorKnows.has(inspectImageFrames(buf).format),
      `users.js typed these bytes as ${typed}; the frame inspector did not recognise them`);
  }

  // The specific seams that were open: a truncated PNG signature and a `GIF8`
  // prefix both typed as images here and as unknown containers over there.
  assert.strictEqual(detectImageFormat(Buffer.concat([Buffer.from('GIF8Xa', 'latin1'), Buffer.alloc(16)])), null);
  assert.strictEqual(detectImageFormat(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from('junk', 'latin1'), Buffer.alloc(16)])), null);

  // Real files must be unaffected. Every GIF ever written is 87a or 89a.
  assert.strictEqual(detectImageFormat(gif({ frames: 1 })), 'gif');
  assert.strictEqual(detectImageFormat(png()), 'png');
  assert.strictEqual(detectImageFormat(JPEG), 'jpeg');
});

// ---------------------------------------------------------------------------
// 5. Through moderateImage, end to end
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

test('the new containers are refused through the real entry point, announced as anything', () => {
  // The declared MIME is the attacker's to choose and browsers ignore it, so
  // each of these is sent under a type the call-site allowlists accept.
  const smuggles = [
    ['image/png', ico([png({ animated: true })])],
    ['image/png', ANIMATED_AVIF],
    ['image/jpeg', HEIF_SEQUENCE],
    ['image/webp', ico([gif({ frames: 4 })])],
  ];
  return Promise.all(smuggles.map(async ([mime, buf]) => {
    const res = await moderation.moderateImage(asDataUrl(mime, buf));
    assert.strictEqual(res.allowed, false, `${mime} carrying ${inspectImageFrames(buf).format} must not post`);
    assert.strictEqual(res.reason, 'animated_image');
    assert.strictEqual(
      moderation.imageRejectionMessage(res),
      moderation.ANIMATED_IMAGE_REJECTED_MESSAGE,
      'the refusal must say why, not imply the photo looked unsafe'
    );
  }));
});

test('the new gates cost no Vision quota and do not eat still images', async () => {
  for (const buf of [ico([png({ animated: true })]), ANIMATED_AVIF, HEIF_SEQUENCE]) {
    assert.strictEqual((await moderation.moderateImage(asDataUrl('image/png', buf))).allowed, false);
  }
  assert.strictEqual(visionCalls, 0, 'the frame gate runs before the provider');

  for (const buf of [png(), gif({ frames: 1 }), JPEG, ico([png()])]) {
    assert.strictEqual((await moderation.moderateImage(asDataUrl('image/png', buf))).allowed, true);
  }
  assert.strictEqual(visionCalls, 4, 'every still image was still screened by the provider');
});

// ---------------------------------------------------------------------------
// 6. Fail-closed, re-verified once more over the whole surface
// ---------------------------------------------------------------------------
// A regression in any of these is silent: the upload succeeds and nobody finds
// out until the wrong image is already on a 13-year-old's screen.

const STILL = asDataUrl('image/png', png());

test('every provider failure mode still ends in a refusal', async () => {
  const failures = [
    ['throws', async () => { throw new Error('socket hang up'); }],
    ['times out', async () => { const e = new Error('aborted'); e.name = 'TimeoutError'; throw e; }],
    ['429 quota', async () => ({ ok: false, status: 429, json: async () => ({ error: { message: 'quota' } }) })],
    ['403 key blocked', async () => ({ ok: false, status: 403, json: async () => ({ error: { details: [{ reason: 'API_KEY_SERVICE_BLOCKED' }] } }) })],
    ['503 outage', async () => ({ ok: false, status: 503, json: async () => { throw new Error('html'); } })],
    ['200, unparseable body', async () => ({ ok: true, json: async () => { throw new SyntaxError('<'); } })],
    ['200, no annotation', async () => ({ ok: true, json: async () => ({ responses: [{}] }) })],
    ['200, per-image error', async () => ({ ok: true, json: async () => ({ responses: [{ error: { message: 'Bad image data' } }] }) })],
    ['200, strict category unanswered', async () => ({ ok: true, json: async () => ({ responses: [{ safeSearchAnnotation: { ...CLEAN, adult: 'UNKNOWN' } }] }) })],
    ['200, responses is not an array', async () => ({ ok: true, json: async () => ({ responses: {} }) })],
    ['200, body is null', async () => ({ ok: true, json: async () => null })],
  ];
  for (const [label, impl] of failures) {
    global.fetch = impl;
    const res = await moderation.moderateImage(STILL);
    assert.strictEqual(res.allowed, false, `provider ${label} must not allow an image through`);
    assert.strictEqual(res.reason, 'moderation_error');
    // The user-facing wording for a degraded provider must NOT claim the image
    // was animated, and must not be blank.
    assert.strictEqual(moderation.imageRejectionMessage(res), moderation.IMAGE_REJECTED_MESSAGE);
  }
});

test('a missing key is a refusal in production, whatever the bytes are', async () => {
  const saved = {
    v: process.env.VISION_API_KEY,
    g: process.env.GOOGLE_VISION_API_KEY,
    r: process.env.IMAGE_MODERATION_REQUIRED,
    n: process.env.NODE_ENV,
  };
  delete process.env.VISION_API_KEY;
  delete process.env.GOOGLE_VISION_API_KEY;
  delete process.env.IMAGE_MODERATION_REQUIRED;   // NOT set to anything: the omission case
  process.env.NODE_ENV = 'production';
  delete require.cache[require.resolve('../utils/moderation')];
  try {
    const mod = require('../utils/moderation');
    // The point of the default: forgetting the variable must not open the gate.
    assert.strictEqual(mod.__test.IMAGE_MODERATION_REQUIRED, true);
    assert.strictEqual(mod.__test.IMAGE_PROVIDER_CONFIGURED, false);
    const res = await mod.moderateImage(STILL);
    assert.strictEqual(res.allowed, false);
    assert.strictEqual(res.reason, 'moderation_unavailable');
  } finally {
    for (const [key, value] of [['VISION_API_KEY', saved.v], ['GOOGLE_VISION_API_KEY', saved.g],
      ['IMAGE_MODERATION_REQUIRED', saved.r], ['NODE_ENV', saved.n]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    delete require.cache[require.resolve('../utils/moderation')];
  }
});

test('nothing undecodable is ever reported as clean', async () => {
  const nothingToScreen = [
    '', null, undefined, [], {}, 0,
    'data:image/png;base64,',              // no payload
    'data:image/png;base64,==',            // decodes to zero bytes
    'data:image/png;base64,\r\n \t',       // whitespace only
    'data:;base64,AAAA',                   // no media type
    'javascript:alert(1)',
    'http://example.com/x.png',            // plaintext scheme
    'HTTPS://example.com/x.png',           // scheme casing must not be a bypass
    'file:///etc/passwd',
  ];
  for (const value of nothingToScreen) {
    const res = await moderation.moderateImage(value);
    assert.strictEqual(res.allowed, false, `${String(value)} must not be allowed`);
  }
  assert.strictEqual(visionCalls, 0, 'none of that should have reached the provider');
});

// ---------------------------------------------------------------------------
// 7. The inspector stays total over the formats added here
// ---------------------------------------------------------------------------

test('frame inspection never throws on truncated or corrupted new containers', () => {
  // It runs OUTSIDE the provider try/catch and walks attacker-chosen bytes, so
  // a throw would surface as a 500 rather than a refusal. Seeded for
  // reproducibility.
  let seed = 0x13579bdf;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const seeds = [
    ico([png({ animated: true })]),
    ico([png(), gif({ frames: 2 })]),
    ANIMATED_AVIF, STILL_AVIF, HEIF_SEQUENCE, STILL_HEIC,
    Buffer.from([0x8a, 0x4d, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  ];
  for (let i = 0; i < 4000; i++) {
    const base = seeds[i % seeds.length];
    const cut = base.subarray(0, Math.max(0, Math.floor(rand() * base.length)));
    const mutated = Buffer.from(cut);
    for (let k = 0; k < 4 && mutated.length; k++) {
      mutated[Math.floor(rand() * mutated.length)] = Math.floor(rand() * 256);
    }
    const out = inspectImageFrames(mutated);
    assert.strictEqual(typeof out.animated, 'boolean', `non-boolean verdict for ${mutated.toString('hex')}`);
    assert.strictEqual(typeof out.format, 'string');
  }
});

test('frame inspection returns promptly on hostile sizes', () => {
  // Every walk is bounded by a step ceiling AND by forward progress. A file
  // that spun one of them would hang an upload request, not fail it.
  const big = Buffer.alloc(1024 * 1024);
  const shapes = [
    Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.alloc(4), Buffer.from('WEBP', 'latin1'), big]),
    Buffer.concat([PNG_SIGNATURE, big]),
    Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.alloc(7), Buffer.alloc(1024 * 1024, 0x2c)]),
    Buffer.concat([isoBox('ftyp', Buffer.from('avifavif', 'latin1')), big]),
  ];
  const started = Date.now();
  for (const buf of shapes) assert.strictEqual(typeof inspectImageFrames(buf).animated, 'boolean');
  assert.ok(Date.now() - started < 5000, 'frame inspection must not become the slow path');
});

// ---------------------------------------------------------------------------
// 8. The REST upload paths keep using the shared verdict and its wording
// ---------------------------------------------------------------------------

test('both REST message paths refuse on the verdict and explain it accurately', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'messages.js'), 'utf8');

  // Flock chat and DMs are two separate handlers in one file. Both write
  // image_url, so both must screen, and neither may reach for the generic
  // constant — a multi-frame refusal told as "we couldn't verify that image is
  // safe" is both wrong and unactionable.
  // The `{ userId: req.user.id }` half is not decoration: moderateImage's
  // userId is optional, so a screen that omits it charges the process-wide
  // Vision ceiling only and one account can spend the whole day on everyone
  // else (utils/visionBudget.js, and __tests__/visionSpendBudget.test.js
  // section 10, which owns that argument). Pinned here too because this is the
  // assertion a refactor of these two handlers will read first.
  assert.strictEqual((src.match(/await moderateImage\(image_url, \{ userId: req\.user\.id \}\)/g) || []).length, 2,
    'both the flock-message and DM handlers must screen image_url, charged to the sender');
  assert.strictEqual((src.match(/imageRejectionMessage\(verdict\)/g) || []).length, 2);
  assert.ok(!/IMAGE_REJECTED_MESSAGE/.test(src),
    'routes/messages.js must not use the raw constant; the wording comes from the verdict');

  const users = fs.readFileSync(path.join(__dirname, '..', 'routes', 'users.js'), 'utf8');
  assert.match(users, /await moderateImage\(dataUrl, \{ userId: req\.user\.id \}\)/,
    'the avatar path must screen the bytes it is about to store, and charge the account storing them');
  assert.match(users, /imageRejectionMessage\(verdict\)/);
  assert.ok(!/IMAGE_REJECTED_MESSAGE/.test(users));
});
