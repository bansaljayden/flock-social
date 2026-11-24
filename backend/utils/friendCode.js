// ---------------------------------------------------------------------------
// Reading a friend code out of whatever it arrived in.
// ---------------------------------------------------------------------------
// routes/friends.js issues the codes (migration 079); this file only reads
// them. A code reaches POST /api/friends/add-by-code and GET
// /api/friends/by-code/:code in whatever shape the person had it in:
//
//   * typed off a friend's screen, without the FLOCK-, with a space after it,
//     in lower case, or with the full stop from the end of the sentence it
//     was read out of;
//   * pasted from an invite message: a whole sentence with a code inside;
//   * a link, https://www.flockcorp.com/add/FLOCK-XXXXXXXX, which is what the
//     QR code holds now;
//   * the JSON the QR code held before it was a link,
//     {"type":"flock_friend","code":"FLOCK-XXXXXXXX"}, which older builds still
//     draw and saved screenshots still carry.
//
// The app reads all of those itself (frontend/src/lib/friendCode.js) and sends
// the one spelling. This is the same reading on this side, for the builds
// already on phones, which send the code box exactly as it was typed, and so
// the server never depends on a client having got it right. It draws the same
// lines the app's reader draws, links on any other host included: those are
// not read, and a code inside one is not picked up as if it had been typed.
//
// IT READS, IT NEVER DECIDES. Whether a code names anybody is the lookup's
// answer, so the one shape this route always took, FLOCK- and then letters
// and digits, is passed on whatever its length: an id-shaped code from before
// migration 079 (FLOCK-0016) still reaches the lookup, still costs a probe,
// and misses byte for byte like a code nobody holds. Every other shape has to
// come out as an issued code (the issuing alphabet, the issued length),
// because there that shape is the only evidence it is a code at all. Nothing
// here reads an account or an id: the answer is built only from the text that
// came in.
// ---------------------------------------------------------------------------

const PREFIX = 'FLOCK';

// Longer than anything a code field, a QR code or an invite message holds.
// The routes bound their own inputs tighter; this keeps a caller that forgot
// from walking a megabyte through the patterns below.
const MAX_TEXT = 512;

// The one shape this route has always taken: FLOCK-, then one unbroken run of
// letters and digits, and nothing else.
const PREFIXED_RUN = new RegExp(`^${PREFIX}-([A-Z0-9]+)$`);

// A link anywhere in the text: any scheme, so that a link which is not an
// http one (ftp://, a custom app scheme) is set aside like a link to another
// host rather than read as words.
const LINK = /\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"']+/gi;

// The hosts a Flock link is minted on. The deployment's own base (the local
// stack's http://127.0.0.1 origin, a staging host) is added per call, because
// it is read from the environment at request time.
const FLOCK_HOSTS = ['flockcorp.com', 'www.flockcorp.com'];

function hostsFor(origins) {
  const hosts = new Set(FLOCK_HOSTS);
  for (const origin of origins || []) {
    try {
      hosts.add(new URL(String(origin)).host.toLowerCase());
    } catch {
      // Not a URL. Nothing to add, and nothing to fail over: the canonical
      // hosts above still read.
    }
  }
  return hosts;
}

/**
 * Build the reader for one issuing scheme. routes/friends.js owns the
 * alphabet and the length, so they are passed in rather than restated here.
 *
 * @param {{ alphabet: string, length: number }} scheme
 * @returns {(text: unknown, opts?: { origins?: string[] }) => string|null}
 *   the code as FLOCK-XXXXXXXX, or null when nothing in the text reads as one
 */
function createFriendCodeReader({ alphabet, length }) {
  if (typeof alphabet !== 'string' || !/^[A-Z0-9]+$/.test(alphabet)) {
    throw new Error('friendCode: the alphabet must be upper-case letters and digits');
  }
  if (!Number.isInteger(length) || length < 1) {
    throw new Error('friendCode: the length must be a positive integer');
  }
  const issued = new RegExp(`^[${alphabet}]{${length}}$`);
  // FLOCK, at most a few characters of punctuation, then exactly one issued
  // code that is not the start of a longer word. "Add me on Flock, my code is
  // FLOCK-7HNPQ3RW." passes over the first "Flock," because "MY" is not a
  // whole code, and stops at the second.
  const inText = new RegExp(`${PREFIX}[^A-Z0-9]{0,3}([${alphabet}]{${length}})(?![A-Z0-9])`);

  const spelled = (body) => `${PREFIX}-${body}`;

  // The whole text is a code.
  //
  // FLOCK- and one unbroken run of letters and digits is passed on as it is,
  // whatever its length, in any case: that is the shape this route has always
  // accepted, and an old id-shaped code still arrives in it, so the lookup is
  // what turns it down. Anything else is a code only when, with every
  // character that is not a letter or a digit taken out, what is left is an
  // issued code with or without its prefix: "7hnp q3rw", "FLOCK- 7HNPQ3RW.",
  // "flock:7hnpq3rw". The issuing alphabet has no O and no L, so an issued
  // code never begins with the prefix's own letters, and a leading FLOCK is
  // always the prefix.
  function fromCode(text) {
    const upper = String(text).toUpperCase();
    const run = upper.match(PREFIXED_RUN);
    if (run) return spelled(run[1]);
    const squeezed = upper.replace(/[^A-Z0-9]/g, '');
    const body = squeezed.length === PREFIX.length + length && squeezed.startsWith(PREFIX)
      ? squeezed.slice(PREFIX.length)
      : squeezed;
    return issued.test(body) ? spelled(body) : null;
  }

  // A link to a code's page, on one of Flock's own hosts. A link anywhere
  // else that happens to end in /add/<something> is not a Flock code.
  function fromLink(text, hosts) {
    let url;
    try {
      url = new URL(text);
    } catch {
      return null;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (!hosts.has(url.host.toLowerCase())) return null;
    const m = url.pathname.match(/^\/add\/([^/]+)\/?$/i);
    if (!m) return null;
    let segment = m[1];
    try {
      segment = decodeURIComponent(segment);
    } catch {
      // Kept as it came: a stray % cannot make it read as some other code.
    }
    return fromCode(segment);
  }

  // A code with its prefix somewhere in a sentence.
  function fromSentence(text) {
    const named = text.toUpperCase().match(inText);
    return named ? spelled(named[1]) : null;
  }

  return function friendCodeFrom(input, { origins = [] } = {}) {
    if (typeof input !== 'string') return null;
    const text = input.trim();
    if (!text || text.length > MAX_TEXT) return null;

    // The QR code's old payload. Text that opens like JSON and is not that
    // payload is not a code, even with a code-shaped string inside it.
    if (text.startsWith('{')) {
      try {
        const parsed = JSON.parse(text);
        return parsed && parsed.type === 'flock_friend' && typeof parsed.code === 'string'
          ? fromCode(parsed.code)
          : null;
      } catch {
        return null;
      }
    }

    const hosts = hostsFor(origins);
    const links = text.match(LINK) || [];
    for (const link of links) {
      const code = fromLink(link, hosts);
      if (code) return code;
    }
    // Every link is out of the text before it is read as words, so a code
    // inside a link to somewhere else is never picked up as if it had been
    // typed. The app's reader draws the same line.
    const words = links.reduce((rest, link) => rest.split(link).join(' '), text).trim();
    if (!words) return null;
    return fromCode(words) || fromSentence(words);
  };
}

module.exports = { createFriendCodeReader, FLOCK_HOSTS };
