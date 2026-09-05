// ---------------------------------------------------------------------------
// UGC content moderation (Apple 1.2 / Google UGC policy)
//
// TEXT: synchronous, offline, zero-cost profanity/intent filter via
//   content-checker (bad-words based). No API key required. Every user-writable
//   text field is screened before it is stored.
//
// IMAGE: synchronous, FAIL-CLOSED (build-time decision). Every image/story upload
//   is screened before it becomes visible via Google Cloud Vision SafeSearch; if
//   the provider errors, times out, or exhausts quota, the upload is REJECTED
//   rather than letting unmoderated imagery through during a degradation.
//
// IMAGE SPEND: Vision is a PAID upstream and every screen is an invoice line.
//   utils/visionBudget.js holds the two ceilings (per-account and process-wide
//   daily) and the arithmetic behind them. Exhausting either one REJECTS the
//   upload for the same reason every other failed screen does — read the
//   FAIL CLOSED block in that file before changing it.
//
// LEGAL POSTURE (18 U.S.C. § 2258A — see MODERATION-LEGAL.md in the repo root):
//   this screening is VOLUNTARY. § 2258A(f) imposes no duty to scan, and
//   SafeSearch is NOT a CSAM detector — its 'adult' category cannot judge age,
//   and Google's actual CSAM tooling (Content Safety API / CSAI Match) is a
//   separate, vetted-access product this app does not use. The statutory duty
//   (report to the NCMEC CyberTipline, preserve for one year) triggers on
//   ACTUAL KNOWLEDGE, which on this app arrives through human reports and
//   moderator review. What this file owes that pipeline is visibility: a hard
//   adult flag from the screen must not be indistinguishable from a timeout in
//   the logs. See the [CHILD-SAFETY] line in moderateImage.
// ---------------------------------------------------------------------------
const { Filter } = require('content-checker');

// Text screening only. content-checker's hosted image endpoint pointed at
// OpenModerator, which no longer exists; images go through Cloud Vision below.
const filter = new Filter();

// TEXT A MAP PROVIDER WROTE IS NOT TEXT A PERSON TYPED (first-session audit,
// 2026-09-05). The general list above refuses "Dick's Sporting Goods", "Cox
// Farms", "Wang's Kitchen", "Hell's Kitchen", "Sexy Fish", "Bloody Run Road"
// and "Butt Rd", every one of them a real business or street that Google
// Places hands the app verbatim, and the refusal told the person who picked
// it that THEY had written something objectionable, with nothing to rephrase.
// The Create screen is the first thing a new account is pointed at, so this
// was a first-session dead end on a real venue.
//
// So a venue name or address that arrives WITH a place id is screened by this
// second instance: the same list, less the words that are also surnames,
// street names and ordinary English. A slur or an explicit term is still on
// it, because a crafted request can put any string under a place-id-shaped
// value and the card renders to the whole flock. Text with no place id (a
// venue somebody typed) keeps the full list. The allow-list is short and
// deliberate; add to it from a real venue, not a guess.
const PROVIDER_ALLOWED = [
  'dick', 'dicks', 'cox', 'wang', 'wangs', 'willy', 'willys', 'willie', 'fanny', 'fannys',
  'sexy', 'hell', 'hells', 'god', 'damn', 'bloody', 'butt', 'butts', 'crap', 'screw',
  'balls', 'bum', 'knob', 'hooker', 'hookers', 'woody', 'arse', 'poo', 'pee',
];
const providerFilter = new Filter();
providerFilter.removeWords(...PROVIDER_ALLOWED);

const TEXT_REJECTED_MESSAGE =
  "That doesn't fit our community guidelines. Rephrase and try again.";

/**
 * Screen user-supplied text before storing it. Synchronous + offline.
 * @param {string} text
 * @returns {{ allowed: boolean, flagged: boolean, reason: string|null }}
 */
function moderateText(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    return { allowed: true, flagged: false, reason: null };
  }
  if (filter.isProfane(text)) {
    return { allowed: false, flagged: true, reason: 'profanity' };
  }
  return { allowed: true, flagged: false, reason: null };
}

/**
 * Express helper: returns true and sends a 400 if the text is rejected.
 * Usage: if (rejectIfProfane(res, req.body.content)) return;
 */
function rejectIfProfane(res, text) {
  const verdict = moderateText(text);
  if (!verdict.allowed) {
    res.status(400).json({ error: TEXT_REJECTED_MESSAGE, moderation: verdict.reason });
    return true;
  }
  return false;
}

/**
 * Screen a venue name or address. With a place id (Google's text) the
 * provider list applies; without one (typed) the full list does. Same
 * verdict shape as moderateText.
 */
function moderateVenueText(text, placeId) {
  if (typeof text !== 'string' || text.trim() === '') {
    return { allowed: true, flagged: false, reason: null };
  }
  const fromProvider = typeof placeId === 'string' && placeId.trim().length >= 6;
  if ((fromProvider ? providerFilter : filter).isProfane(text)) {
    return { allowed: false, flagged: true, reason: 'profanity' };
  }
  return { allowed: true, flagged: false, reason: null };
}

// The venue twin: the refusal names the venue, because the person cannot
// rephrase a name Google gave them and the general sentence blamed them.
const VENUE_REJECTED_MESSAGE = "That venue's name or address can't be shown here. Pick a different spot.";
function rejectIfProfaneVenue(res, text, placeId) {
  const verdict = moderateVenueText(text, placeId);
  if (!verdict.allowed) {
    res.status(400).json({ error: VENUE_REJECTED_MESSAGE, moderation: verdict.reason });
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Image moderation — fail-closed
// ---------------------------------------------------------------------------
// Round 17: this was `=== 'true'` and nothing else, so "fail-closed" was opt-IN
// via an environment variable that lives only in the Railway dashboard. Forget
// to set it on the production service — or lose it in a service re-create, an
// env import, a new environment for a staging build — and every image upload
// path in the app silently reverts to allow-with-a-console-warning. That is a
// teen social app shipping unscreened photo UGC, and the only evidence would be
// one line in a log nobody reads.
//
// A safety default has to be the DEFAULT. In production the answer is now
// "required" unless someone explicitly writes IMAGE_MODERATION_REQUIRED=false,
// which is a deliberate, greppable act rather than an omission. Dev and test
// are unchanged: no variable, no requirement.
const IMAGE_MODERATION_REQUIRED =
  process.env.IMAGE_MODERATION_REQUIRED === 'true' ||
  (process.env.NODE_ENV === 'production' && process.env.IMAGE_MODERATION_REQUIRED !== 'false');

// Provider: Google Cloud Vision SafeSearch.
//
// This replaced OpenModerator, whose hosted service was shut down by its owner
// (the domain now serves a paused-deployment 503, so the old key path could
// never have worked). Cloud Vision runs in the Google Cloud project this app
// already uses for Places and Gemini: enable the Vision API on that project and
// set VISION_API_KEY. A separate key is supported so the browser-restricted
// Maps key is never reused server-side.
const VISION_API_KEY = process.env.VISION_API_KEY || process.env.GOOGLE_VISION_API_KEY;
const IMAGE_PROVIDER_CONFIGURED = !!VISION_API_KEY;

// The spend ceilings on that provider. Required here rather than restated,
// because the numbers and the reasoning behind them belong in one file.
const { allowVisionCall } = require('./visionBudget');

// Say it once, at boot, where a deploy log will show it. Previously the only
// signal that image moderation was misconfigured arrived one line at a time,
// per upload, buried in request logs — after the fact.
if (process.env.NODE_ENV === 'production' && !IMAGE_PROVIDER_CONFIGURED) {
  console.error(
    '🛡️ STARTUP: no image moderation provider is configured (VISION_API_KEY unset). ' +
    (IMAGE_MODERATION_REQUIRED
      ? 'Every image upload in the app will be REJECTED until it is set.'
      : 'IMAGE_MODERATION_REQUIRED=false is set, so images are being stored UNSCREENED. Do not ship this to the App Store.')
  );
}

// SafeSearch returns a likelihood enum per category rather than a score.
// LIKELY and VERY_LIKELY are refused. POSSIBLE is refused for the two
// categories that carry real legal and App Store risk on a teen app, and
// allowed for the softer ones so ordinary night-out photos are not eaten.
const HARD_REJECT = new Set(['LIKELY', 'VERY_LIKELY']);
const STRICT_CATEGORIES = ['adult', 'racy'];
const OTHER_CATEGORIES = ['violence', 'medical'];

// Round 18: the only values SafeSearch is documented to return. Anything else —
// a missing key, a null, a string we do not recognise — is a response we did not
// understand, and "did not understand" has to mean the same thing as "no
// annotation at all" (see below), not "clean". Before this, an annotation of
// `{}` sailed through every category check and the image was ALLOWED, which is
// the same fail-open the `if (!safe)` guard was written to close, one level down.
const LIKELIHOODS = new Set([
  'UNKNOWN', 'VERY_UNLIKELY', 'UNLIKELY', 'POSSIBLE', 'LIKELY', 'VERY_LIKELY',
]);

// ---------------------------------------------------------------------------
// Multi-frame (animated) images — round 18
// ---------------------------------------------------------------------------
// THE HOLE. Cloud Vision SafeSearch screens an animated image by its FIRST
// FRAME ONLY. So a GIF whose frame 1 is a sunset and whose frame 2 is anything
// at all scored clean, was stored, and was then played in full to everyone who
// opened the thread. Every image path in the app shares this function, so the
// hole was app-wide: flock chat (REST + socket), DMs (REST + socket), avatars,
// stories.
//
// Format allowlists cannot close it. An APNG is served as `image/png` and an
// animated WebP as `image/webp`, so neither a file extension nor a
// client-supplied MIME type distinguishes them from the still images we want.
// Nothing here trusts either one: the decision is made from the BYTES.
//
// THE DECISION: REJECT anything with more than one frame. Not re-encode.
//
// The tradeoff, stated plainly, because the other option is genuinely stronger:
//
//   * Re-encoding to a single still frame before screening (and storing THAT)
//     would keep the screen honest AND keep the feature. It needs a decoder for
//     GIF, APNG and animated WebP. Nothing in backend/package.json can do it —
//     there is no sharp, jimp, canvas or ImageMagick binding anywhere in the
//     dependency tree, direct or transitive — so it means adding a native image
//     library to a Railway deploy, plus real CPU per upload on a single
//     instance that also serves ONNX inference. That is a large, permanent cost
//     to carry for a feature nobody has shipped or promised.
//
//   * Rejecting costs users animated avatars and reaction GIFs, which some will
//     expect. That is a real loss and it is worth naming rather than pretending
//     otherwise. But this is a child-safety control on an app whose audience
//     starts at 13, not a nicety: the failure mode it prevents is unscreened
//     imagery reaching minors, and the failure mode it causes is "that GIF
//     didn't post". Those are not the same size. Reject wins.
//
// If animated media is ever actually a product requirement, the correct move is
// to add the decoder and re-encode — NOT to relax this gate.
//
// Detection is positive-only: we reject what we can PROVE is multi-frame (plus
// the two cases where we cannot prove single-frame either — a GIF that stops
// parsing as a GIF, and a container nested deeper than we will follow). An
// unrecognised
// container is left to the provider, which refuses formats it cannot decode and
// therefore already fails closed through the catch below.
// ---------------------------------------------------------------------------

// Every parser below walks length-prefixed structures under a step ceiling, so
// a hostile file cannot spin the loop. In practice they exit within a few
// iterations: the answer is always in the header region.
const MAX_PARSE_STEPS = 5_000_000;

function magicIs(buf, offset, ascii) {
  if (buf.length < offset + ascii.length) return false;
  for (let i = 0; i < ascii.length; i++) {
    if (buf[offset + i] !== ascii.charCodeAt(i)) return false;
  }
  return true;
}

// GIF sub-blocks: a chain of length-prefixed chunks ending in a zero byte.
// Returns the offset just past the terminator, or the buffer length when the
// stream is truncated (nothing beyond that point is reachable by any decoder
// either), or -1 when the step ceiling is hit.
function gifSkipSubBlocks(buf, start) {
  let p = start;
  for (let step = 0; step < MAX_PARSE_STEPS; step++) {
    if (p >= buf.length) return buf.length;
    const len = buf[p];
    if (len === 0) return p + 1;
    p += 1 + len;
  }
  return -1;
}

// Counts IMAGE DESCRIPTORS (0x2C). One is a still GIF; two or more is an
// animation. Returns null when the byte stream stops making sense as a GIF,
// which for this format is treated as animated — see gifs in inspectImageFrames.
function gifIsAnimated(buf) {
  if (buf.length < 13) return null;
  const packed = buf[10];
  // Logical screen descriptor is 7 bytes; a global colour table may follow.
  let p = 13;
  if (packed & 0x80) p += 3 * (1 << ((packed & 0x07) + 1));

  let frames = 0;
  for (let step = 0; step < MAX_PARSE_STEPS; step++) {
    if (p >= buf.length) return frames > 1;   // truncated
    const block = buf[p];
    if (block === 0x3b) return frames > 1;    // trailer
    if (block === 0x21) {                     // extension: introducer + label + sub-blocks
      p = gifSkipSubBlocks(buf, p + 2);
      if (p < 0) return null;
      continue;
    }
    if (block === 0x2c) {                     // image descriptor == one frame
      frames++;
      if (frames > 1) return true;            // early exit, nothing else to learn
      if (p + 10 > buf.length) return false;
      const local = buf[p + 9];
      p += 10;
      if (local & 0x80) p += 3 * (1 << ((local & 0x07) + 1));
      p += 1;                                 // LZW minimum code size
      p = gifSkipSubBlocks(buf, p);
      if (p < 0) return null;
      continue;
    }
    return null;                              // not a block type the format defines
  }
  return null;
}

// APNG is a PNG carrying an `acTL` animation-control chunk, which the spec
// requires BEFORE the first IDAT. Chunks are walked by their length prefixes —
// an indexOf('acTL') would be fooled by those four bytes appearing inside
// compressed pixel data, which an attacker controls completely.
function pngIsAnimated(buf) {
  let p = 8; // past the 8-byte signature
  for (let step = 0; step < MAX_PARSE_STEPS; step++) {
    if (p + 8 > buf.length) return false;
    const len = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    if (type === 'acTL') return true;
    // acTL after either of these is ignored by every decoder, so the file is a
    // still image no matter what follows.
    if (type === 'IDAT' || type === 'IEND') return false;
    if (len > 0x7fffffff) return false;
    p += 12 + len; // length(4) + type(4) + data + crc(4)
  }
  return false;
}

// Animated WebP is a RIFF file carrying ANIM/ANMF chunks, flagged in VP8X.
// Both signals are checked: a file can carry frames without the flag set, and
// the flag alone is enough for a decoder to treat it as an animation. Chunk
// offsets are followed properly (RIFF pads odd-sized chunks to even), for the
// same reason as the PNG walk — a raw scan for 'ANMF' hits attacker-controlled
// bitstream bytes.
function webpIsAnimated(buf) {
  let p = 12; // past 'RIFF' + size + 'WEBP'
  for (let step = 0; step < MAX_PARSE_STEPS; step++) {
    if (p + 8 > buf.length) return false;
    const fourcc = buf.toString('latin1', p, p + 4);
    if (fourcc === 'ANIM' || fourcc === 'ANMF') return true;
    if (fourcc === 'VP8X' && p + 9 <= buf.length && (buf[p + 8] & 0x02)) return true;
    const size = buf.readUInt32LE(p + 4);
    if (size > 0x7fffffff) return false;
    p += 8 + size + (size % 2);
  }
  return false;
}

// ICO/CUR is a DIRECTORY of images, and each entry may embed a whole PNG —
// which may be an APNG. Round 19: counting the directory entries answered only
// half the question, so a one-entry ICO wrapping an animated PNG read as a
// still image and sailed through the gate.
//
// This is reachable. Every call site's allowlist checks the CLIENT-DECLARED
// prefix of a data: URL (`data:image/png;base64,`), while Blink and WebKit pick
// an image decoder by SNIFFING the bytes, so `data:image/png` carrying ICO
// bytes is decoded as an ICO by the very browsers this app ships in. The
// declared type gates nothing; only the bytes do.
//
// Recursion is depth-limited and each step moves strictly forward into a
// strictly shorter slice, so an ICO nested in an ICO terminates.
function icoIsMultiFrame(buf, depth) {
  const count = buf.readUInt16LE(4);
  if (count > 1) return true;               // more than one image, by declaration
  if (count === 0) return false;            // nothing to render
  if (buf.length < 22) return false;        // header + one 16-byte directory entry
  const size = buf.readUInt32LE(14);
  const offset = buf.readUInt32LE(18);
  // Must point strictly past the directory and lie wholly inside the file, or
  // no decoder can reach it either.
  if (offset < 22 || size < 8 || offset + size > buf.length) return false;
  return inspectImageFramesUnguarded(buf.subarray(offset, offset + size), depth + 1).animated;
}

// ISO base media containers (`....ftyp....`): animated AVIF and HEIF image
// SEQUENCES both live here, and both are multi-frame images a browser plays in
// a plain <img>. Round 19: these landed in the `unknown` bucket and passed the
// gate. Nothing bad reached users, because Cloud Vision cannot decode either
// format and therefore threw into the fail-closed catch — but that is an
// ACCIDENT of provider coverage, not a control. The day Vision learns to decode
// AVIF, animated AVIF starts passing with only frame 1 screened, silently.
//
// It matters more than it looks on this app specifically: the iOS build is a
// Capacitor WKWebView, and WebKit on Apple platforms decodes HEIF natively.
//
// Proven-positive only, same as everywhere else here: a STILL AVIF or HEIC is
// left alone and handed to the provider. Two independent signals of a sequence:
// a sequence brand in the ftyp box, or a top-level `moov` (a movie box only
// exists for timed, multi-sample content).
const ISOBMFF_SEQUENCE_BRANDS = new Set([
  'avis',                                                     // animated AVIF
  'msf1', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs',     // HEIF image sequences
]);

function isobmffIsAnimated(buf) {
  // Brands: major_brand at 8, minor_version at 12 (skipped — it is a number,
  // not a brand), compatible_brands from 16 to the end of the ftyp box.
  // Brands live in the FIRST box and nowhere else. When its declared size is
  // not usable, cap the scan at a window big enough for ~60 brands instead of
  // sweeping the whole file: a four-byte scan over megabytes of attacker-chosen
  // sample data would eventually hit 'hevc' by luck and refuse a valid image.
  const ftypSize = buf.readUInt32BE(0);
  const brandEnd = (ftypSize >= 16 && ftypSize <= buf.length)
    ? ftypSize
    : Math.min(buf.length, 256);
  for (let p = 8; p + 4 <= brandEnd; p += 4) {
    if (p === 12) continue;
    if (ISOBMFF_SEQUENCE_BRANDS.has(buf.toString('latin1', p, p + 4))) return true;
  }
  // Top-level box walk. Sizes are followed properly rather than scanned for,
  // for the same reason as the PNG and RIFF walks: 'moov' as four raw bytes
  // inside attacker-controlled sample data would otherwise be a false positive.
  let p = 0;
  for (let step = 0; step < 4096; step++) {
    if (p + 8 > buf.length) return false;
    let size = buf.readUInt32BE(p);
    if (buf.toString('latin1', p + 4, p + 8) === 'moov') return true;
    if (size === 1) {                       // 64-bit largesize follows the type
      if (p + 16 > buf.length) return false;
      if (buf.readUInt32BE(p + 8) !== 0) return false;  // larger than anything we hold
      size = buf.readUInt32BE(p + 12);
      if (size < 16) return false;
    } else if (size === 0) {
      return false;                         // runs to EOF; no box follows it
    } else if (size < 8) {
      return false;                         // malformed
    }
    p += size;
  }
  return false;
}

// TIFF pages are a linked list of IFDs; Vision screens the first one. Not
// reachable through any current upload path (every call site's allowlist stops
// well short of TIFF), but the check is four lines and the alternative is
// trusting that no future caller widens its allowlist.
function tiffIsMultiPage(buf) {
  const le = buf[0] === 0x49;
  const u16 = (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
  const u32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  if (buf.length < 8) return false;
  let off = u32(4);
  for (let step = 0; step < 4096; step++) {
    if (off === 0 || off + 2 > buf.length) return false;
    if (step > 0) return true;                    // a second IFD exists
    const entries = u16(off);
    const next = off + 2 + entries * 12;
    if (next + 4 > buf.length) return false;
    off = u32(next);
  }
  return false;
}

/**
 * What kind of file is this, and does it hold more than one frame?
 * Reads bytes only — never an extension, never a client-declared MIME type.
 * @param {Buffer} buf
 * @returns {{ format: string, animated: boolean }}
 */
function inspectImageFrames(buf) {
  try {
    return inspectImageFramesUnguarded(buf, 0);
  } catch (err) {
    // Re-audit: the parsers below index and readUInt* their way through
    // attacker-supplied bytes, and this is called OUTSIDE the provider try/catch
    // in moderateImage. An unexpected throw here would have escaped to the
    // route's handler as a 500 — and, worse, any future refactor that caught it
    // in the wrong place would turn a parser bug into "allowed". A bug in a
    // safety parser has to land on the safe side of the fence explicitly.
    console.error('🛡️ Image frame inspection threw, treating the image as unscreenable:', err.message);
    return { format: 'unreadable', animated: true };
  }
}

// `depth` exists only for containers that embed a whole image inside themselves
// (ICO today). A container nested past MAX_CONTAINER_DEPTH is a file nobody
// sends by accident and one we can no longer prove anything about, so it takes
// the same answer as an unparseable GIF: not provably single-frame.
const MAX_CONTAINER_DEPTH = 4;

function inspectImageFramesUnguarded(buf, depth = 0) {
  if (!Buffer.isBuffer(buf) || buf.length < 4) {
    return { format: 'unknown', animated: false };
  }
  if (depth > MAX_CONTAINER_DEPTH) {
    return { format: 'nested', animated: true };
  }
  if (magicIs(buf, 0, 'GIF87a') || magicIs(buf, 0, 'GIF89a')) {
    const animated = gifIsAnimated(buf);
    // GIF is the format whose entire risk profile IS animation. If the stream
    // stops parsing as a GIF we cannot claim it is a single frame, and a
    // malformed GIF is worth nothing to a user, so indeterminate == reject.
    return { format: 'gif', animated: animated === null ? true : animated };
  }
  if (magicIs(buf, 0, '\x89PNG\r\n\x1a\n')) {
    return { format: 'png', animated: pngIsAnimated(buf) };
  }
  if (magicIs(buf, 0, 'RIFF') && magicIs(buf, 8, 'WEBP')) {
    return { format: 'webp', animated: webpIsAnimated(buf) };
  }
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { format: 'jpeg', animated: false }; // JPEG holds exactly one image
  }
  // MNG is the PNG family's animation container and is animation by definition.
  // It opens with its own signature, so it is not caught by the PNG branch.
  if (magicIs(buf, 0, '\x8aMNG\r\n\x1a\n')) {
    return { format: 'mng', animated: true };
  }
  // ISO base media: animated AVIF, HEIF image sequences, and the video
  // containers that share the box format. Tested BEFORE the ICO branch, whose
  // signature is four loose bytes that a box-size field can imitate.
  if (buf.length >= 12 && magicIs(buf, 4, 'ftyp')) {
    return { format: 'isobmff', animated: isobmffIsAnimated(buf) };
  }
  // ICO/CUR is a directory of images; a single entry can itself be an APNG.
  if (buf.length >= 6 && buf[0] === 0x00 && buf[1] === 0x00
      && (buf[2] === 0x01 || buf[2] === 0x02) && buf[3] === 0x00) {
    return { format: 'ico', animated: icoIsMultiFrame(buf, depth) };
  }
  if (magicIs(buf, 0, 'II\x2a\x00') || magicIs(buf, 0, 'MM\x00\x2a')) {
    return { format: 'tiff', animated: tiffIsMultiPage(buf) };
  }
  // Unrecognised container. Deliberately NOT rejected here: the provider
  // refuses formats it cannot decode, which lands in the catch below and fails
  // closed anyway, and a byte-level allowlist in this function would silently
  // start refusing images the call sites already vetted.
  //
  // KNOWN RESIDUAL: JPEG XL (`FF 0A`, or an ISOBMFF file whose second box type
  // is `JXL `) can be animated, and proving it would mean bit-parsing the
  // codestream header rather than reading a magic number. It lands here. Today
  // that is safe for the same reason animated AVIF was until round 19 — Cloud
  // Vision cannot decode JXL, so the call throws into the fail-closed catch —
  // and that is provider coverage, not a control. It is left alone rather than
  // banned by format because refusing a STILL JXL would have to be explained to
  // the user as "animated images can't be posted", which would be a lie. If
  // Vision ever learns JXL, this needs a real frame check before that ships.
  return { format: 'unknown', animated: false };
}

/**
 * Screen an uploaded image before it becomes visible. FAIL-CLOSED.
 *
 * @param {string} imageUrl  data: URL or publicly-fetchable https URL
 * @param {object} [opts]
 * @param {number|string} [opts.userId]  the account the billed Vision call is
 *   charged to. OPTIONAL, and the omission is deliberate rather than lazy: a
 *   caller with no account (or one not yet wired) charges the process-wide
 *   daily ceiling only, exactly the way services/mlPredictor.js's
 *   allowEventFetch treats its background producers. Supplying a MALFORMED id
 *   is refused rather than waved through. Every call site that HAS a user
 *   should pass one — without it the per-account leg cannot bite and the only
 *   thing standing between one account and the whole day's global allowance is
 *   the 10-per-60s limiter in server.js.
 * @returns {Promise<{ allowed: boolean, reason: string|null }>}
 */
async function moderateImage(imageUrl, { userId } = {}) {
  // No provider configured AND screening is mandatory: nothing below can change
  // the answer, so refuse before spending a fetch on it.
  if (!IMAGE_PROVIDER_CONFIGURED && IMAGE_MODERATION_REQUIRED) {
    console.error('🛡️ Image moderation REQUIRED but no provider configured, rejecting upload (fail-closed).');
    return { allowed: false, reason: 'moderation_unavailable' };
  }

  // Obtain the bytes ONCE, up front. The frame check below is a property of the
  // file, not of the provider, so it runs whether or not a provider is
  // configured — otherwise a dev/staging environment without VISION_API_KEY
  // would still accept animated uploads and the gap would only close in prod.
  let bytes;
  try {
    const blob = await imageToBlob(imageUrl);
    bytes = Buffer.from(await blob.arrayBuffer());
    // Re-audit: `data:image/png;base64,==` and a 0-byte 200 from a remote host
    // both land here with nothing to screen. There is no verdict to be had on
    // zero bytes, and "no verdict" is the one thing this function must never
    // report as clean.
    if (bytes.length === 0) throw new Error('empty image data');
  } catch (err) {
    // Could not even obtain the bytes → FAIL CLOSED, in every environment.
    console.error('🛡️ Image could not be read for moderation, rejecting upload (fail-closed):', err.message);
    return { allowed: false, reason: 'moderation_error' };
  }

  // ANIMATION GATE — see the block comment above inspectImageFrames.
  const shape = inspectImageFrames(bytes);
  if (shape.animated) {
    console.warn(`🛡️ Rejected a multi-frame ${shape.format} upload: SafeSearch only sees frame 1.`);
    return { allowed: false, reason: 'animated_image' };
  }

  // No provider configured and screening is NOT required: dev only.
  if (!IMAGE_PROVIDER_CONFIGURED) {
    console.warn('⚠️ Image moderation provider not configured, allowing upload (dev only). Set VISION_API_KEY + IMAGE_MODERATION_REQUIRED=true before store submission.');
    return { allowed: true, reason: null };
  }

  // MONEY GATE — utils/visionBudget.js. Charged HERE and nowhere earlier, which
  // is the placesBudget rule ("charge before the fetch, and only for a call you
  // are actually going to make"): everything above this line refuses an image
  // for free, and a free refusal must not spend a unit the user needs for a
  // photo that would have worked.
  //
  // EXHAUSTION FAILS CLOSED — the upload is REFUSED, not allowed through
  // unscreened. Do not "fix" this into an allow. Every other way this function
  // can fail to obtain a verdict (no provider, unreadable bytes, provider 5xx,
  // timeout, a 200 with no annotation) rejects the upload, and a spend ceiling
  // that failed open would be strictly worse than all of them: it would be an
  // image-moderation bypass that any attacker could buy for the price of the
  // day's budget, on an app whose age floor is 13. The full argument, and the
  // denial-of-service cost it accepts in exchange, is in visionBudget.js under
  // "WHAT HAPPENS WHEN A CEILING IS HIT".
  const budget = allowVisionCall(userId);
  if (!budget.allowed) {
    // visionBudget already logged this loudly and greppably (with the account
    // id, and throttled so it cannot be used to flood the logs), so this does
    // not log a second line. The distinct `reason` exists so a route or a test
    // can tell "we ran out of money" apart from "the provider broke"; both
    // refuse the upload and both show the user the same sentence, because from
    // the user's side they are the same event.
    return { allowed: false, reason: 'moderation_budget' };
  }

  try {
    const response = await fetch(
      `https://vision.googleapis.com/v1/images:annotate?key=${encodeURIComponent(VISION_API_KEY)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requests: [{
            image: { content: bytes.toString('base64') },
            features: [{ type: 'SAFE_SEARCH_DETECTION' }],
          }],
        }),
        signal: AbortSignal.timeout(15000),
      }
    );

    if (!response.ok) {
      // Surface Google's own reason. A bare status is not actionable: 403
      // alone could be SERVICE_DISABLED (API not enabled on the project),
      // BILLING_DISABLED (no billing account, common on Firebase-created
      // projects), or API_KEY_SERVICE_BLOCKED (key restricted to other APIs).
      let detail = '';
      try {
        const body = await response.json();
        const reason = body?.error?.details?.[0]?.reason || body?.error?.status || '';
        detail = ` ${reason} ${body?.error?.message || ''}`.trimEnd();
      } catch { /* body was not JSON */ }
      throw new Error(`vision ${response.status}${detail}`);
    }
    const data = await response.json();
    const verdict = data?.responses?.[0];
    if (verdict?.error) throw new Error(verdict.error.message || 'vision error');

    const safe = verdict?.safeSearchAnnotation;
    // A 200 with no annotation means we learned nothing about the image, which
    // is not the same as it being clean.
    if (!safe || typeof safe !== 'object') throw new Error('no safeSearch annotation');

    // Round 18: the two categories the whole gate exists for must actually have
    // been ANSWERED. `{ safeSearchAnnotation: {} }`, `{ adult: null }` and
    // `{ adult: 'UNKNOWN' }` all used to read as "not LIKELY, not POSSIBLE →
    // allowed", so a truncated, half-parsed or degraded provider response
    // allowed the image through on the strength of a field that was never
    // filled in. Same doctrine as `if (!safe)` one line up, applied per
    // category: an unanswered strict category is a failed screen.
    for (const key of STRICT_CATEGORIES) {
      if (!LIKELIHOODS.has(safe[key]) || safe[key] === 'UNKNOWN') {
        throw new Error(`incomplete safeSearch annotation: ${key}`);
      }
    }

    // The provider answered, completely. Recorded so the admin cost panel can
    // tell a $0 that means "nobody uploaded" from a $0 that means "nothing
    // works". See probeVisionEnabled below.
    noteVisionOutcome(true);
    // CHILD-SAFETY VISIBILITY. A hard adult flag (LIKELY / VERY_LIKELY) used to
    // produce the same generic refusal as a quota error, so the one class of
    // rejection a human should glance at drowned in fail-closed noise. It gets
    // a distinct, greppable token instead. Stated plainly so nobody over-reads
    // it: SafeSearch cannot judge age, so this is NOT knowledge of CSAM and
    // does not trigger the § 2258A reporting duty by itself — and the image was
    // refused BEFORE storage, so no copy exists and nothing attaches to it. It
    // is a pattern signal (one account tripping it repeatedly is worth a look),
    // and the operator's search string for it is documented in
    // MODERATION-LEGAL.md. POSSIBLE is deliberately excluded: that band exists
    // to eat ordinary night-out photos, and alerting on it would train the
    // operator to ignore the token.
    if (HARD_REJECT.has(safe.adult)) {
      console.error(
        `🛡️ [CHILD-SAFETY] SafeSearch scored an upload adult=${safe.adult} (racy=${safe.racy}). ` +
        'The image was rejected before storage; no copy was kept. SafeSearch cannot judge age, so this is ' +
        'a pattern signal for a human, not knowledge of CSAM. See MODERATION-LEGAL.md.'
      );
    }
    for (const key of STRICT_CATEGORIES) {
      if (HARD_REJECT.has(safe[key]) || safe[key] === 'POSSIBLE') {
        return { allowed: false, reason: `unsafe_${key}` };
      }
    }
    // The softer categories stay best-effort: a missing `violence` must not
    // eat an ordinary night-out photo, and neither of these is the reason the
    // screen exists.
    for (const key of OTHER_CATEGORIES) {
      if (HARD_REJECT.has(safe[key])) {
        return { allowed: false, reason: `unsafe_${key}` };
      }
    }
    return { allowed: true, reason: null };
  } catch (err) {
    // Provider configured but call failed → FAIL CLOSED.
    noteVisionOutcome(false, err.message);
    console.error('🛡️ Image moderation call failed, rejecting upload (fail-closed):', err.message);
    return { allowed: false, reason: 'moderation_error' };
  }
}

const MAX_MODERATED_IMAGE_BYTES = 8 * 1024 * 1024;

// ---------------------------------------------------------------------------
// IS THE PROVIDER ACTUALLY REACHABLE. A separate question from "is a key set".
// ---------------------------------------------------------------------------
// IT LIVES BELOW moderateImage AND THAT IS DELIBERATE. It holds the second
// reference to vision.googleapis.com in this file, and
// __tests__/visionSpendBudget.test.js pins by file position that the spend
// charge sits above the first one. Put this block higher up and that invariant
// starts measuring the diagnostic instead of the call that costs money.
// ---------------------------------------------------------------------------
// A key can be set, well formed, and belong to a Google Cloud project on which
// the Vision API was never enabled. Every call then returns 403 SERVICE_DISABLED,
// moderateImage() fails closed, and EVERY IMAGE UPLOAD IN THE APP IS REFUSED.
// From the outside that looks like a bug in uploads. On a cost panel it looks
// like an API that bills nothing, which is true and is the least useful true
// thing anybody could be told: the $0 is there because nothing was answered.
//
// Nothing in this repo could tell those apart before. The boot warning only
// fires when the key is MISSING, and the per-upload error is one console line
// inside a request log. So two readings are published here.
//
//   1. THE LAST REAL OUTCOME. moderateImage() records whether the most recent
//      screen it attempted was answered, and Google's own reason when it was
//      not. In-process and since boot, like every other in-memory meter here,
//      and labelled that way rather than pretending to be a month.
//
//   2. A PROBE THAT COSTS NOTHING. images:annotate with an EMPTY request list
//      carries zero image units, so it is not billable, and it still has to
//      pass API-key auth and the service-enabled check before Google can look
//      at the (absent) payload. A 403 SERVICE_DISABLED or an API_KEY_ error
//      means the key cannot use Vision on its project. Anything that gets far
//      enough to complain about the request itself, including a 400, proves the
//      opposite: the key works and the API is enabled. The result is cached, so
//      opening the admin panel repeatedly does not turn into a fetch loop.
//
// The detail string is scrubbed before it leaves this file. Google's
// SERVICE_DISABLED message names the project, which is exactly the diagnostic
// worth showing, and no Google error echoes the key back. The scrub is there so
// that stays true if one ever does.

const VISION_PROBE_TTL_MS = 10 * 60 * 1000;
const VISION_PROBE_TIMEOUT_MS = 8000;

let visionLastOutcome = null;   // { at, ok, detail } or null if never attempted
let visionProbe = { at: 0, result: null, inFlight: null };

/** Strip anything key-shaped out of a provider message before publishing it. */
function scrubProviderDetail(text) {
  return String(text || '')
    .replace(/key=[^\s&"']+/gi, 'key=[redacted]')
    .replace(/AIza[0-9A-Za-z_-]{10,}/g, '[redacted]')
    .slice(0, 400);
}

function noteVisionOutcome(ok, detail) {
  visionLastOutcome = {
    at: new Date().toISOString(),
    ok: !!ok,
    detail: ok ? null : scrubProviderDetail(detail),
  };
}

/**
 * Ask Google whether this key can use Vision at all, without buying a unit.
 * Never throws. Returns reachable true, false, or null when it cannot be known.
 */
async function probeVisionEnabled() {
  if (!IMAGE_PROVIDER_CONFIGURED) {
    return {
      configured: false,
      required: IMAGE_MODERATION_REQUIRED,
      keyVar: null,
      reachable: null,
      reason: 'no_key',
      detail: null,
      at: null,
      cached: false,
      lastOutcome: visionLastOutcome,
    };
  }

  const keyVar = process.env.VISION_API_KEY ? 'VISION_API_KEY' : 'GOOGLE_VISION_API_KEY';
  const base = {
    configured: true,
    required: IMAGE_MODERATION_REQUIRED,
    keyVar,
    lastOutcome: visionLastOutcome,
  };

  const fresh = Date.now() - visionProbe.at < VISION_PROBE_TTL_MS && visionProbe.result;
  if (fresh) return { ...base, ...visionProbe.result, cached: true };
  if (visionProbe.inFlight) return visionProbe.inFlight.then((r) => ({ ...base, ...r, cached: true }));

  visionProbe.inFlight = (async () => {
    let result;
    try {
      const response = await fetch(
        `https://vision.googleapis.com/v1/images:annotate?key=${encodeURIComponent(VISION_API_KEY)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // Zero images, so zero billable units. This asks about the key and
          // the project, not about a picture.
          body: JSON.stringify({ requests: [] }),
          signal: AbortSignal.timeout(VISION_PROBE_TIMEOUT_MS),
        }
      );
      let reason = '';
      let message = '';
      try {
        const body = await response.json();
        reason = body?.error?.details?.[0]?.reason || body?.error?.status || '';
        message = body?.error?.message || '';
      } catch { /* not JSON, which the status alone still answers */ }

      if (response.ok) {
        result = { reachable: true, reason: 'ok', detail: null, status: response.status };
      } else if (response.status === 400) {
        // Google read the request and objected to it, which it could only do
        // after accepting the key and finding the API enabled.
        result = {
          reachable: true,
          reason: 'ok',
          detail: 'The API answered and rejected an empty request, which is the expected reply and proves the key works.',
          status: 400,
        };
      } else if (response.status === 403 || response.status === 401) {
        result = {
          reachable: false,
          reason: reason || 'forbidden',
          detail: scrubProviderDetail(message),
          status: response.status,
        };
      } else {
        result = {
          reachable: null,
          reason: reason || `http_${response.status}`,
          detail: scrubProviderDetail(message),
          status: response.status,
        };
      }
    } catch (err) {
      // A timeout or a DNS failure says nothing about whether the API is
      // enabled, so it must not read as "not enabled".
      result = { reachable: null, reason: 'unreachable', detail: scrubProviderDetail(err.message), status: null };
    }
    result.at = new Date().toISOString();
    visionProbe = { at: Date.now(), result, inFlight: null };
    return result;
  })();

  const r = await visionProbe.inFlight;
  return { ...base, ...r, cached: false };
}

// SSRF guard (round 5): remote fetches must resolve to PUBLIC addresses at
// every hop — attacker-controlled redirects toward localhost / RFC1918 /
// link-local (cloud metadata) are refused.
const dns = require('dns').promises;
const net = require('net');

function isPrivateIPv4(addr) {
  const parts = addr.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts;
  return a === 127 || a === 10 || a === 0
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 169 && b === 254)   // link-local: cloud metadata lives at 169.254.169.254
    || (a === 100 && b >= 64 && b <= 127) // carrier-grade NAT
    || a >= 224;
}

// Round 17: the IPv6 branch spot-checked THREE ::ffff: prefixes by string —
// 127., 10. and 192.168. — and every other private IPv4 range slipped through
// in mapped form. `::ffff:169.254.169.254` is the cloud metadata endpoint, and
// it was allowed; so were `::ffff:172.16.x.x` and `::ffff:100.64.x.x`. The fix
// is to stop pattern-matching prefixes and instead UNWRAP a mapped address back
// to its IPv4 form, then run the one IPv4 rule set over it. `::` (unspecified,
// which routes to localhost on several stacks) was missing too.
function isPrivateAddress(addr) {
  if (net.isIPv6(addr)) {
    const a = addr.toLowerCase();
    // IPv4-mapped and IPv4-compatible forms, e.g. ::ffff:169.254.169.254
    const mapped = a.match(/^::(?:ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/);
    if (mapped) return isPrivateIPv4(mapped[1]);
    if (a === '::1' || a === '::') return true;
    if (a.startsWith('fe80')) return true;              // link-local
    if (/^f[cd]/.test(a)) return true;                  // unique-local fc00::/7
    if (a.startsWith('ff')) return true;                // multicast
    return false;
  }
  return isPrivateIPv4(addr);
}

async function assertPublicHttpsUrl(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch { throw new Error('bad image URL'); }
  if (u.protocol !== 'https:') throw new Error('unsupported image URL scheme');
  if (net.isIP(u.hostname) && isPrivateAddress(u.hostname)) throw new Error('blocked address');
  if (!net.isIP(u.hostname)) {
    const addrs = await dns.lookup(u.hostname, { all: true });
    if (addrs.some(a => isPrivateAddress(a.address))) throw new Error('blocked address');
  }
  return u;
}

// Fetch with manual redirect following (each hop re-validated) and a
// STREAMING size cap — the old arrayBuffer() buffered an endless body on the
// heap before the size check ever ran.
async function fetchPublicImage(rawUrl) {
  let url = rawUrl;
  for (let hop = 0; hop < 3; hop++) {
    await assertPublicHttpsUrl(url);
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(15000) });
    if (response.status >= 300 && response.status < 400) {
      const loc = response.headers.get('location');
      if (!loc) throw new Error('bad redirect');
      url = new URL(loc, url).href;
      continue;
    }
    if (!response.ok) throw new Error(`image fetch failed: ${response.status}`);
    const type = response.headers.get('content-type') || '';
    if (!type.startsWith('image/')) throw new Error(`not an image: ${type}`);
    const declared = parseInt(response.headers.get('content-length') || '0', 10);
    if (declared > MAX_MODERATED_IMAGE_BYTES) throw new Error('image too large');

    const chunks = [];
    let total = 0;
    for await (const chunk of response.body) {
      total += chunk.length;
      if (total > MAX_MODERATED_IMAGE_BYTES) throw new Error('image too large');
      chunks.push(chunk);
    }
    return new Blob([Buffer.concat(chunks)], { type });
  }
  throw new Error('too many redirects');
}

async function imageToBlob(imageUrl) {
  if (typeof imageUrl !== 'string' || imageUrl === '') {
    throw new Error('no image data');
  }
  if (imageUrl.startsWith('data:')) {
    const match = imageUrl.match(/^data:(image\/[\w+.-]+);base64,(.+)$/s);
    if (!match) throw new Error('unsupported data URL');

    // Round 18: what we screen has to be the ONLY thing the stored data URL can
    // decode to. `Buffer.from(s, 'base64')` silently discards characters
    // outside the alphabet and stops at padding, so `<clean bytes>=<payload>`
    // and `<junk-interleaved payload>` both decoded to something here while a
    // browser's atob() — which throws on stray characters — would decode
    // differently or not at all. Two decoders disagreeing about the same string
    // is a moderation bypass by construction: we approve one image and the app
    // renders another. Requiring canonical base64 removes the ambiguity
    // entirely. ASCII whitespace is stripped first because atob() ignores it
    // too, so line-wrapped payloads are not a divergence and stay accepted.
    const b64 = match[2].replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) throw new Error('malformed image data');
    const bytes = Buffer.from(b64, 'base64');
    const unpadded = (s) => s.replace(/=+$/, '');
    if (unpadded(bytes.toString('base64')) !== unpadded(b64)) {
      throw new Error('malformed image data');
    }

    if (bytes.length > MAX_MODERATED_IMAGE_BYTES) throw new Error('image too large');
    return new Blob([bytes], { type: match[1] });
  }
  if (/^https:\/\//.test(imageUrl)) {
    return fetchPublicImage(imageUrl);
  }
  throw new Error('unsupported image URL scheme');
}

const IMAGE_REJECTED_MESSAGE =
  "We couldn't verify that image is safe to share, so it wasn't posted.";

// A multi-frame image is refused by POLICY, not because it looked unsafe.
// Telling the user their sunset GIF failed a safety check is both wrong and
// unactionable; they need to know a still photo will work.
const ANIMATED_IMAGE_REJECTED_MESSAGE =
  "Animated images can't be posted here. Try a still photo instead.";

/**
 * The message that belongs with a moderateImage() verdict. Call sites should
 * use this rather than reaching for IMAGE_REJECTED_MESSAGE directly, so a new
 * reason cannot be introduced with a message that misdescribes it.
 *
 * 'moderation_budget' deliberately takes the generic message. "We couldn't
 * verify that image is safe to share" is literally what happened — we did not
 * screen it, so we did not post it — and it is the same sentence a provider
 * outage produces, which is right: telling a user we ran out of moderation
 * budget invites them to retry until it comes back, and tells an attacker
 * exactly when their spend attack landed.
 * @param {{ reason: string|null }|string|null} verdict
 */
function imageRejectionMessage(verdict) {
  const reason = typeof verdict === 'string' ? verdict : verdict?.reason;
  return reason === 'animated_image' ? ANIMATED_IMAGE_REJECTED_MESSAGE : IMAGE_REJECTED_MESSAGE;
}

module.exports = {
  moderateText,
  rejectIfProfane,
  rejectIfProfaneVenue,
  moderateVenueText,
  VENUE_REJECTED_MESSAGE,
  PROVIDER_ALLOWED,
  moderateImage,
  probeVisionEnabled,
  filter,
  TEXT_REJECTED_MESSAGE,
  IMAGE_REJECTED_MESSAGE,
  ANIMATED_IMAGE_REJECTED_MESSAGE,
  imageRejectionMessage,
};
// Exposed for __tests__/safetyFlow.test.js, __tests__/animatedImageModeration.test.js
// and __tests__/animatedImageScreening.test.js.
module.exports.__test = {
  isPrivateAddress,
  inspectImageFrames,
  IMAGE_MODERATION_REQUIRED,
  IMAGE_PROVIDER_CONFIGURED,
};
