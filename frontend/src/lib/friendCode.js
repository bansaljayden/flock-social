// ---------------------------------------------------------------------------
// FRIEND CODES, IN EVERY SHAPE ONE ARRIVES IN.
//
// A code is issued by the server as 'FLOCK-' plus eight characters from an
// alphabet with no look-alikes (backend routes/friends.js FRIEND_CODE_ALPHABET:
// no 0 or O, no 1, I or L). It reaches the app in more shapes than the one it
// was issued in, and each of them used to fail:
//
//   - the link the share sheet carries, and the QR once the server says so
//     (friendQrText, below), https://www.flockcorp.com/add/FLOCK-XXXXXXXX (or
//     the page's own origin, which is what a local or preview build serves);
//   - the JSON the QR carries until then, and the only thing older builds
//     draw, {"type":"flock_friend","code"}, which stays readable for as long
//     as an old phone or a saved screenshot can show one;
//   - a pasted invite, "Add me on Flock. My code is FLOCK-XXXXXXXX.", which a
//     long press in Messages copies whole;
//   - a code read out and typed by hand: without the prefix, in lower case,
//     with a space in the middle or a full stop on the end.
//
// friendCodeFrom is the one reader for all of them. The scanner, the code
// field, the deep link and the website page use it, so a shape one of them
// accepts is a shape all of them accept. The server normalises again on its
// side, so this is a convenience for the person and never a gate on its own.
//
// Links on any other host are not read at all, even when their path looks
// right. The scanner sends the request the moment it reads a code, so a QR
// printed with somebody else's domain must not be able to pick who you add.
// ---------------------------------------------------------------------------

export const FRIEND_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const BODY = `[${FRIEND_CODE_ALPHABET}]{8}`;
const BODY_ONLY = new RegExp(`^${BODY}$`);
// The prefix, up to three separators (a dash, a space, a colon), then the
// eight characters, which may not run straight on into a longer word.
const IN_TEXT = new RegExp(`FLOCK[^A-Z0-9]{0,3}(${BODY})(?![A-Z0-9])`);
// A link anywhere in the text, in any scheme. A link that is not an http one
// (ftp://, some other app's scheme) is set aside like a link to another host,
// rather than read as words with a code-shaped run inside it. The server's
// reader (backend/utils/friendCode.js) draws the same line; it has to, because
// this side sends the code it read, never the text, so the server's own check
// never sees the link.
const LINK = /\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"']+/gi;

// The two hosts the site answers on. The page's own origin is added by the
// caller, so the local stack and a preview deploy read their own links.
const SITE_HOSTS = new Set(['flockcorp.com', 'www.flockcorp.com']);

// Where a code's link points when the server has not said (an older server, or
// a code read from the cache before the first answer).
export const FRIEND_LINK_BASE = 'https://www.flockcorp.com';

/**
 * 'FLOCK-XXXXXXXX' from a code written any way a person might write it, or
 * null. Spaces, dashes, punctuation and case are dropped; the prefix is
 * optional. Anything that is not exactly eight characters of the alphabet
 * after that is not a code.
 */
export function normalizeFriendCode(raw) {
  if (typeof raw !== 'string') return null;
  const squeezed = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  // 'L' and 'O' are not in the alphabet, so a body can never start with
  // FLOCK and the prefix can be taken off without any ambiguity.
  const body = squeezed.length === 13 && squeezed.startsWith('FLOCK') ? squeezed.slice(5) : squeezed;
  return BODY_ONLY.test(body) ? `FLOCK-${body}` : null;
}

const currentOrigin = () => {
  try { return typeof window !== 'undefined' && window.location ? window.location.origin : ''; } catch { return ''; }
};

function codeFromLink(link, origin) {
  let url;
  try { url = new URL(link); } catch { return null; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  let own = false;
  try { own = Boolean(origin) && new URL(origin).host.toLowerCase() === url.host.toLowerCase(); } catch { own = false; }
  if (!own && !SITE_HOSTS.has(url.hostname.toLowerCase())) return null;
  const m = url.pathname.match(/^\/add\/([^/]+)\/?$/i);
  if (!m) return null;
  let segment = m[1];
  try { segment = decodeURIComponent(segment); } catch { /* keep it as it came */ }
  return normalizeFriendCode(segment);
}

/**
 * The code in whatever arrived: the link, the old JSON, a pasted invite or a
 * bare code. Returns 'FLOCK-XXXXXXXX' or null.
 *
 * `origin` is the page's own origin, read from window when it is not given.
 */
export function friendCodeFrom(text, { origin } = {}) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  // A real code in any of its shapes is well under this. Anything longer is
  // not something a person pasted on purpose.
  if (!trimmed || trimmed.length > 2000) return null;

  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      return parsed && parsed.type === 'flock_friend' && typeof parsed.code === 'string'
        ? normalizeFriendCode(parsed.code)
        : null;
    } catch {
      return null;
    }
  }

  const home = origin === undefined ? currentOrigin() : origin;
  const links = trimmed.match(LINK) || [];
  for (const link of links) {
    const code = codeFromLink(link, home);
    if (code) return code;
  }
  // Every link is out of the text before it is read as words, so a code
  // inside somebody else's URL is never picked up as if it had been typed.
  const words = links.reduce((rest, link) => rest.split(link).join(' '), trimmed);
  const inText = words.toUpperCase().match(IN_TEXT);
  if (inText) return `FLOCK-${inText[1]}`;
  return normalizeFriendCode(words);
}

/** The link for a code, on the server's base when it gave one. */
export function friendCodeLink(code, base = FRIEND_LINK_BASE) {
  const normal = normalizeFriendCode(code || '');
  if (!normal) return '';
  return `${String(base || FRIEND_LINK_BASE).replace(/\/+$/, '')}/add/${normal}`;
}

/**
 * WHAT THE QR CODE CARRIES: the text the server said (GET /api/friends/my-code
 * `qr`), or the old JSON when it said nothing usable. '' without a code.
 *
 * Not the link by default. The iPhone app ships its own copy of the web build,
 * and the scanner in the builds already on phones (1.0.3 and older) reads a
 * scan with JSON.parse and nothing else, so a link in the QR would be "Not a
 * valid Flock QR code" on every phone that has not updated. The server switches
 * to the link once the build that reads links is the one in the App Store.
 *
 * Whatever the server sent has to read back to this code, or the JSON is drawn
 * instead: a QR that scans to somebody else, or to nothing, is worse than one
 * an old phone also reads. An older server that sends no `qr` gets the JSON.
 * (Every code the server issues reads back; one in another shape is drawn as
 * the server sent it, there being nothing to check it against.)
 */
export function friendQrText(code, qr) {
  const given = typeof code === 'string' ? code.trim() : '';
  if (!given) return '';
  const sent = typeof qr === 'string' && qr ? qr : '';
  const normal = normalizeFriendCode(given);
  if (!normal) return sent || JSON.stringify({ type: 'flock_friend', code: given });
  if (sent && friendCodeFrom(sent) === normal) return sent;
  return JSON.stringify({ type: 'flock_friend', code: normal });
}

/** True when the QR's text is a link a phone's own camera can open. */
export const qrTextIsLink = (text) => typeof text === 'string' && /^https?:\/\//i.test(text);

// ---------------------------------------------------------------------------
// A CODE WAITING FOR SOMEBODY TO ACT ON IT.
//
// A link tapped before there is an account (the website page, a universal link
// to a signed-out app) has to survive the sign-up, and a tap whose add the
// server refused for an unconfirmed email has to survive the confirmation. The
// rule is inviteHandoff.js's: localStorage, under a flock* key so a sign-out
// sweeps it with the rest of the account, for a day at most, and never read in
// a way that can throw on the boot path.
//
// Nothing here sends anything. The app shows who the code belongs to and the
// person decides; a link never adds a friend by itself.
// ---------------------------------------------------------------------------
export const PENDING_FRIEND_CODE_KEY = 'flock_pending_friend_code';
const PENDING_TTL_MS = 24 * 60 * 60 * 1000;

export function rememberFriendCode(raw) {
  const code = normalizeFriendCode(typeof raw === 'string' ? raw : '');
  if (!code) return false;
  try {
    window.localStorage.setItem(PENDING_FRIEND_CODE_KEY, JSON.stringify({ code, at: Date.now() }));
    return true;
  } catch {
    // Storage is off. The sheet still opens for this launch; it just cannot
    // wait through a sign-up.
    return false;
  }
}

export function forgetFriendCode() {
  try { window.localStorage.removeItem(PENDING_FRIEND_CODE_KEY); } catch { /* storage blocked */ }
}

/** The waiting code, or null. An expired or unreadable entry is cleared on the way out. */
export function pendingFriendCode() {
  let saved = null;
  try {
    const raw = window.localStorage.getItem(PENDING_FRIEND_CODE_KEY);
    saved = raw ? JSON.parse(raw) : null;
  } catch {
    saved = null;
  }
  if (!saved) return null;
  const code = normalizeFriendCode(typeof saved.code === 'string' ? saved.code : '');
  const at = Number(saved.at);
  // A missing or future timestamp reads as expired, never as immortal.
  if (!code || !Number.isFinite(at) || Date.now() - at > PENDING_TTL_MS || at > Date.now() + 60000) {
    forgetFriendCode();
    return null;
  }
  return code;
}

// ---------------------------------------------------------------------------
// SHARING A CODE.
//
// The share sheet carries the link as its own field, which is what gives
// Messages a link card, and the code in the sentence, which still works while
// the link opens the website rather than the app. Closing the sheet is an
// answer, so nothing is said. Without a share sheet (a computer) the same
// words go to the clipboard, and a copy that fails still hands over the code,
// which is the part a friend needs.
// ---------------------------------------------------------------------------
export async function shareFriendCode({
  code,
  url,
  showToast,
  copiedNote = 'Link copied. Paste it into a text.',
  nav = typeof navigator !== 'undefined' ? navigator : undefined,
}) {
  if (!code) {
    // The share sheet needs the tap it was opened from, and a wait for the
    // code's request would spend it, so a code still loading is said rather
    // than waited for.
    showToast('Your code is still loading. Try again in a moment.', 'error');
    return 'waiting';
  }
  const link = url || friendCodeLink(code);
  const text = `Add me on Flock. My code is ${code}.`;
  if (nav && typeof nav.share === 'function') {
    try {
      await nav.share({ title: 'Add me on Flock', text, url: link });
      return 'shared';
    } catch (err) {
      if (err && err.name === 'AbortError') return 'closed';
    }
  }
  try {
    await nav.clipboard.writeText(link ? `${text} ${link}` : text);
    showToast(copiedNote);
    return 'copied';
  } catch {
    showToast(`Couldn't copy it. Your code is ${code}.`, 'error');
    return 'failed';
  }
}
