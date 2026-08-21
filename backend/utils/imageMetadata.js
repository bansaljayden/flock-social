// ---------------------------------------------------------------------------
// EXIF / XMP / IPTC stripping for stored user images
// ---------------------------------------------------------------------------
// Every user image in this app is stored INLINE as a base64 data: URL. The
// avatar sits in users.profile_image_url, the story in stories.image_url, the
// chat photo in messages.image_url and direct_messages.image_url, and every one
// of those columns is read straight back out and rendered as an <img src> to
// somebody else. Whatever the phone wrote into the file travels with it.
//
// A photo taken on an iPhone with location services on carries an EXIF GPS
// block accurate to a few metres. A selfie taken at home is a home address, and
// the person who sends it has no idea they sent one. It also carries the device
// model, the serial number on some bodies, the capture timestamp, and on many
// cameras a full-size EXIF thumbnail of the ORIGINAL, pre-crop frame, so
// cropping someone out of a photo does not necessarily remove them from the
// file. None of that is visible in any UI, so nobody can
// discover it and nobody can undo it after the fact. It has to come off before
// the bytes are stored.
//
// WHY THIS IS HAND-ROLLED. The obvious answer is sharp, and sharp is a native
// module with a platform-specific binary that would have to build on Railway
// and on a Mac and in CI. It also RE-ENCODES, which means every avatar in the
// app changes quality the day it lands. What is actually needed here is much
// smaller: walk the container, drop the metadata segments, leave the compressed
// image data byte-identical. That is a few hundred lines of container walking
// with no dependency and no re-encode, and it is exactly the kind of parsing
// utils/moderation.js already does to count frames.
//
// THE CONTRACT, and it is the important part: this NEVER corrupts an image. If
// anything about the container does not parse exactly as the format says it
// should (a length that runs past the end, a chunk table that does not close, a
// signature that is not there), the ORIGINAL buffer is returned unchanged and
// nothing is claimed. Returning the input identically is also what happens when
// there was no metadata to remove, which is the common case and keeps the
// callers' "the payload is byte-for-byte untouched" tests honest.
//
// GIF IS DELIBERATELY NOT HANDLED. GIF has no EXIF: the format predates it, and
// no camera produces one. Its metadata surface is the Comment and Application
// extension blocks, which carry authoring-tool strings rather than location.
// Walking a GIF safely means walking every LZW sub-block of every frame, which
// is real risk of corrupting a working image for no privacy gain. Left alone,
// on purpose, rather than half-done.
// ---------------------------------------------------------------------------

// --- JPEG -------------------------------------------------------------------
// Markers whose whole segment comes out. APP1 is Exif AND XMP, which is the one
// that matters. APP13 is the Photoshop/IPTC block (it carries a location field
// of its own). APP12 is Ducky/"Picture Info". COM is a free-text comment.
// APP3..APP11 and APP15 are vendor metadata blocks of various kinds; none of
// them is needed to decode the image.
//
// KEPT, and each for a reason a future reader should not have to guess:
//   APP0  (0xE0) JFIF/JFXX: the density header; a decoder reads it.
//   APP2  (0xE2) ICC_PROFILE: dropping it changes the COLOURS of the image on
//                a wide-gamut display. That is a visible regression, and an ICC
//                profile is a colour space, not a person.
//   APP14 (0xEE) Adobe: carries the colour transform flag; dropping it makes
//                some CMYK/YCCK JPEGs decode with inverted colours.
const JPEG_DROP_MARKERS = new Set([
  0xE1, 0xE3, 0xE4, 0xE5, 0xE6, 0xE7, 0xE8, 0xE9,
  0xEA, 0xEB, 0xEC, 0xED, 0xEF,
  0xFE, // COM
]);

function stripJpeg(buf) {
  if (buf.length < 4 || buf[0] !== 0xFF || buf[1] !== 0xD8) return null;
  const keep = [buf.subarray(0, 2)];
  let removed = false;
  let pos = 2;

  while (pos + 1 < buf.length) {
    if (buf[pos] !== 0xFF) return null; // not sitting on a marker: bail
    const marker = buf[pos + 1];

    // Fill bytes: any number of 0xFF may precede a marker.
    if (marker === 0xFF) { pos += 1; continue; }

    // Standalone markers carry no length. TEM (0x01) and RSTn (0xD0-0xD7).
    if (marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) {
      keep.push(buf.subarray(pos, pos + 2));
      pos += 2;
      continue;
    }

    // Start of scan: everything from here to the end is entropy-coded data with
    // no segment table to walk. Copy it verbatim and stop.
    if (marker === 0xDA) {
      keep.push(buf.subarray(pos));
      return removed ? Buffer.concat(keep) : buf;
    }

    if (marker === 0xD9) { // EOI
      keep.push(buf.subarray(pos, pos + 2));
      return removed ? Buffer.concat(keep) : buf;
    }

    if (pos + 3 >= buf.length) return null;
    const segLen = buf.readUInt16BE(pos + 2);
    if (segLen < 2) return null;
    const end = pos + 2 + segLen;
    if (end > buf.length) return null;

    if (JPEG_DROP_MARKERS.has(marker)) removed = true;
    else keep.push(buf.subarray(pos, end));
    pos = end;
  }

  // Ran off the end without ever reaching a scan or an EOI. Not a JPEG we
  // understand, so we do not get to rewrite it.
  return null;
}

// --- PNG --------------------------------------------------------------------
// PNG metadata lives in ancillary chunks, all of them optional and all of them
// safe to remove: eXIf is the EXIF block (GPS included), tEXt/zTXt/iTXt are
// text (iTXt is where XMP lives), tIME is the modification timestamp.
//
// Everything else is copied through untouched, INCLUDING chunks this file does
// not recognise. An unknown chunk might be APNG's acTL/fcTL/fdAT, and dropping
// half an animation would produce a broken file. The rule here is "remove the
// four things known to carry metadata", never "keep only what is known".
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
const PNG_DROP_CHUNKS = new Set(['eXIf', 'tEXt', 'zTXt', 'iTXt', 'tIME']);

function stripPng(buf) {
  if (buf.length < 8 + 12 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  const keep = [buf.subarray(0, 8)];
  let removed = false;
  let pos = 8;
  let sawIhdr = false;

  while (pos + 8 <= buf.length) {
    const dataLen = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    // 12 = 4 length + 4 type + 4 CRC.
    const end = pos + 12 + dataLen;
    if (dataLen > buf.length || end > buf.length || end < pos) return null;
    if (!/^[A-Za-z]{4}$/.test(type)) return null;
    if (!sawIhdr) {
      if (type !== 'IHDR') return null;
      sawIhdr = true;
    }

    if (PNG_DROP_CHUNKS.has(type)) removed = true;
    else keep.push(buf.subarray(pos, end));
    pos = end;

    if (type === 'IEND') {
      // Trailing bytes after IEND are not ours to interpret; copy them along.
      if (pos < buf.length) keep.push(buf.subarray(pos));
      return removed ? Buffer.concat(keep) : buf;
    }
  }

  // A chunk table that never closes with IEND is not a PNG we understand.
  return null;
}

// --- WebP -------------------------------------------------------------------
// WebP is a RIFF container. Metadata rides in two optional chunks, 'EXIF' and
// 'XMP ' (note the trailing space, it is a four-character code). Both only
// exist in the extended form, which opens with a VP8X chunk whose first payload
// byte is a flags bitfield announcing which optional chunks are present.
//
// Removing a chunk without clearing its flag leaves a file that ANNOUNCES an
// EXIF block it does not contain, which strict decoders reject. Both halves, or
// neither. The RIFF size field is rewritten to match the shorter body for the
// same reason.
const WEBP_DROP_CHUNKS = new Set(['EXIF', 'XMP ']);
const WEBP_IMAGE_CHUNKS = new Set(['VP8 ', 'VP8L', 'VP8X']);
// VP8X flags byte, MSB first: Rsv Rsv I(CC) L(alpha) E(xif) X(mp) A(nim) Rsv.
// Bit 3 is EXIF, bit 2 is XMP.
const VP8X_METADATA_FLAGS = 0x0C;

function stripWebp(buf) {
  if (buf.length < 12) return null;
  if (buf.toString('latin1', 0, 4) !== 'RIFF') return null;
  if (buf.toString('latin1', 8, 12) !== 'WEBP') return null;

  const riffSize = buf.readUInt32LE(4);
  if (riffSize < 4) return null;
  const bodyEnd = 8 + riffSize;
  if (bodyEnd > buf.length) return null;

  const keep = [];
  let removed = false;
  let pos = 12;
  let sawImageChunk = false;

  while (pos + 8 <= bodyEnd) {
    const fourcc = buf.toString('latin1', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const padded = size + (size & 1); // RIFF chunks are even-aligned
    const end = pos + 8 + padded;
    if (end > bodyEnd || end < pos) return null;

    if (!sawImageChunk) {
      if (!WEBP_IMAGE_CHUNKS.has(fourcc)) return null;
      sawImageChunk = true;
    }

    if (WEBP_DROP_CHUNKS.has(fourcc)) {
      removed = true;
    } else if (fourcc === 'VP8X') {
      if (size < 10) return null;
      const flags = buf[pos + 8];
      if (flags & VP8X_METADATA_FLAGS) {
        const rewritten = Buffer.from(buf.subarray(pos, end));
        rewritten[8] = flags & ~VP8X_METADATA_FLAGS;
        keep.push(rewritten);
        removed = true;
      } else {
        keep.push(buf.subarray(pos, end));
      }
    } else {
      keep.push(buf.subarray(pos, end));
    }
    pos = end;
  }

  if (!sawImageChunk) return null;
  if (pos !== bodyEnd) return null; // a partial chunk at the tail: bail
  if (!removed) return buf;

  const body = Buffer.concat(keep);
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(4 + body.length, 4);
  header.write('WEBP', 8, 'latin1');
  // Anything past the declared RIFF size was never part of the container.
  const trailing = buf.subarray(bodyEnd);
  return trailing.length ? Buffer.concat([header, body, trailing]) : Buffer.concat([header, body]);
}

// Returns a buffer with the metadata segments removed, or THE SAME buffer when
// there was nothing to remove or the container did not parse. Never throws:
// this runs on the send path of every photo in the app and a metadata parser is
// not allowed to be the reason a message fails.
function stripImageMetadata(buf) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) return buf;
  try {
    let out = null;
    if (buf[0] === 0xFF && buf[1] === 0xD8) out = stripJpeg(buf);
    else if (buf[0] === 0x89 && buf[1] === 0x50) out = stripPng(buf);
    else if (buf[0] === 0x52 && buf[1] === 0x49) out = stripWebp(buf);
    // Sanity: stripping only ever removes bytes. A "stripped" image that grew
    // means the parser is wrong about something, and the original is safer.
    if (!out || out.length > buf.length) return buf;
    return out;
  } catch (_) {
    return buf;
  }
}

// The data: URL form, for the four columns that store an image as one. The MIME
// prefix is preserved exactly as given: re-typing it is restampImageMime's job
// in sockets/handlers.js and this must not become a second opinion about what
// the bytes are. Non-strings, non-data: URLs and payloads that do not decode
// come back untouched, the same way restampImageMime treats them.
function stripDataUrlMetadata(dataUrl) {
  if (typeof dataUrl !== 'string') return dataUrl;
  const comma = dataUrl.indexOf(',');
  if (comma < 0) return dataUrl;
  const payload = dataUrl.slice(comma + 1);
  if (!payload) return dataUrl;
  let bytes;
  try {
    bytes = Buffer.from(payload.replace(/\s+/g, ''), 'base64');
  } catch (_) {
    return dataUrl;
  }
  if (bytes.length === 0) return dataUrl;
  const stripped = stripImageMetadata(bytes);
  // Identity, not length. Clearing the VP8X metadata flags rewrites one byte
  // without changing the size, and that rewrite still has to be stored.
  if (stripped === bytes) return dataUrl;
  return `${dataUrl.slice(0, comma + 1)}${stripped.toString('base64')}`;
}

module.exports = { stripImageMetadata, stripDataUrlMetadata };
