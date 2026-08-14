// ===========================================================================
// stripHtml — remove markup from user text, and change nothing else.
// ===========================================================================
//
// WHAT THIS IS FOR (read this before "hardening" it again)
//
// Everything that goes through here is UGC that gets stored in Postgres and
// rendered by the React client, which escapes text nodes by default. So the
// job is to make sure a stored value cannot BE markup — no tags, no comments,
// no event-handler attributes, no script bodies. The job is NOT to entity-
// encode punctuation. React already handles the rendering side, and the two
// remaining server-side HTML sinks (the moderation alert email in
// services/emailService.js and the SOS email in routes/safety.js) run their
// own escapeHtml over whatever they interpolate.
//
// This used to be `xss(str, { whiteList: {}, stripIgnoreTag: true, ... })`,
// which is an HTML *filter*: it re-emits text nodes entity-encoded and its
// parser treats every `<` as a tag open. That is correct for "produce a safe
// HTML fragment" and wrong for "produce safe TEXT". It corrupted ordinary
// input on every route that calls this, and the damage was stored, not
// cosmetic:
//
//     "5 > 3"        ->  "5 &gt; 3"      user sees the entity in their own name
//     "a < b"        ->  "a "           everything after a bare `<` was eaten
//     "5 <= 6 >= 4"  ->  "5 = 4"
//     "I <3 you"     ->  "I "
//
// A flock called "pizza < tacos" is not an attack.
//
// THE RULE THIS FILE IMPLEMENTS
//
// Return the text a browser would render for the input, without decoding
// entities. An HTML tokenizer only starts a tag when `<` is followed by an
// ASCII letter, `/`, `!` or `?`; a `<` followed by a space, a digit, `=` or
// end-of-string is literal text, and `>` on its own is always literal text.
// So we strip precisely the constructs that are markup and leave every other
// character exactly as the user typed it.
//
// Consequences worth knowing:
//
//   - `<` immediately followed by a letter IS a tag open, so "3<x" loses
//     "<x" — same as a browser, which renders "3" for that input and drops
//     the unterminated tag at EOF. Deliberate: a value that still contains
//     `<img src=x onerror=...` with no `>` yet is one concatenation away from
//     being live markup in a sink that forgets to escape. Bare `<` before a
//     space or a digit — which is what people actually type — survives.
//   - Entities are NOT decoded. "&lt;script&gt;" stays "&lt;script&gt;":
//     inert text everywhere it is rendered, and decoding it would only turn
//     data the user typed back INTO markup we would then have to strip.
//   - The output is not trimmed and whitespace is not collapsed. Callers do
//     their own .trim() and length checks, and several of them depend on
//     "<b> </b>" sanitizing to blank so a markup-only name is a 400.
//
// This is a security control. Every change needs a matching case in
// __tests__/sanitizeText.test.js, which covers both halves: ordinary text
// must survive byte-for-byte, and markup must not.
// ===========================================================================

// Elements whose content is raw text rather than markup. Their bodies go with
// the tag, so "<script>alert(1)</script>x" leaves "x" and not "alert(1)x".
// Matches the old stripIgnoreTagBody list.
const RAW_TEXT_END = new Map([
  ['script', /<\/script[\s/>]/gi],
  ['style', /<\/style[\s/>]/gi],
]);

// C0 control characters and DEL, except tab, newline and CR. Removed BEFORE any
// parsing, because they are how filter bypasses are written ("<scr\0ipt>" is
// not a tag to a naive regex but the NUL is dropped by real parsers) and
// because a NUL in a bind parameter is a Postgres error, not a name.
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

const isSpace = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';
const isAlpha = (c) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');

// Index just past the next '>', or the end of the string. Used for the
// constructs an HTML parser consumes without caring about their contents:
// doctypes, CDATA, processing instructions and bogus comments.
function skipToGt(s, from) {
  const gt = s.indexOf('>', from);
  return gt === -1 ? s.length : gt + 1;
}

// Consume a tag whose name starts at `i` (i.e. just past `<` or `</`), and
// return the index just past its `>`, or the end of the string if it never
// closes. Quoted attribute values are honoured, so `<a title="a > b">` is one
// tag and the `>` inside the quotes does not end it early.
function skipTag(s, i) {
  const n = s.length;
  while (i < n && !isSpace(s[i]) && s[i] !== '/' && s[i] !== '>') i++;
  let afterEquals = false;
  while (i < n) {
    const c = s[i];
    if (c === '>') return i + 1;
    if (isSpace(c)) { i++; continue; }
    if (c === '=') { afterEquals = true; i++; continue; }
    if (afterEquals && (c === '"' || c === "'")) {
      const close = s.indexOf(c, i + 1);
      if (close === -1) return n;
      i = close + 1;
      afterEquals = false;
      continue;
    }
    afterEquals = false;
    i++;
  }
  return n;
}

// Lowercased tag name starting at `i`.
function readTagName(s, i) {
  let j = i;
  while (j < s.length && !isSpace(s[j]) && s[j] !== '/' && s[j] !== '>') j++;
  return s.slice(i, j).toLowerCase();
}

// Index just past the matching end tag of a raw-text element, or the end of
// the string (an unclosed <script> swallows the rest, exactly as it does in a
// browser).
function skipRawTextBody(s, from, tag) {
  const re = RAW_TEXT_END.get(tag);
  re.lastIndex = from;
  const m = re.exec(s);
  if (!m) return s.length;
  return skipTag(s, m.index + 2);
}

// `<!--` opens a comment; it ends at `-->` or `--!>`, and `<!-->` / `<!--->`
// are already complete. Anything else after `<!` is a doctype/CDATA/bogus
// comment and runs to the next `>`.
function skipDeclaration(s, lt) {
  if (s.startsWith('<!--', lt)) {
    if (s.startsWith('>', lt + 4)) return lt + 5;
    if (s.startsWith('->', lt + 4)) return lt + 6;
    const end = s.indexOf('-->', lt + 4);
    const bang = s.indexOf('--!>', lt + 4);
    if (end === -1 && bang === -1) return s.length;
    if (end === -1) return bang + 4;
    if (bang === -1) return end + 3;
    return end < bang ? end + 3 : bang + 4;
  }
  return skipToGt(s, lt + 2);
}

// One tokenizing pass: copy text through, drop markup.
function stripOnce(s) {
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    const lt = s.indexOf('<', i);
    if (lt === -1) { out += s.slice(i); break; }
    out += s.slice(i, lt);

    const next = s[lt + 1];
    if (next === '!') {
      i = skipDeclaration(s, lt);
    } else if (next === '?') {
      i = skipToGt(s, lt + 2);
    } else if (next === '/') {
      // `</x…>` is an end tag; `</>` and `</ x>` are bogus comments, which a
      // parser also discards.
      i = isAlpha(s[lt + 2]) ? skipTag(s, lt + 2) : skipToGt(s, lt + 2);
    } else if (isAlpha(next)) {
      const name = readTagName(s, lt + 1);
      const after = skipTag(s, lt + 1);
      i = RAW_TEXT_END.has(name) ? skipRawTextBody(s, after, name) : after;
    } else {
      // Not a tag open. This is the "5 > 3" / "pizza < tacos" case: a literal
      // less-than in ordinary text, kept as the user typed it.
      out += '<';
      i = lt + 1;
    }
  }
  return out;
}

// Stripping can splice two halves of the input into a construct that was not
// there before — "<<script>script>x<</script>/script>" leaves a `<` next to a
// `/script>` — so run to a fixed point instead of once. Each pass that changes
// anything removes at least one character, so this terminates; the cap and the
// bracket-stripping fallback exist so that no input, however adversarial, can
// return a value that still parses as markup.
const MAX_PASSES = 8;

function stripHtml(str) {
  if (typeof str !== 'string') return str;
  let cur = str.replace(CONTROL_CHARS, '');
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const next = stripOnce(cur);
    if (next === cur) return cur;
    cur = next;
  }
  return cur.replace(/[<>]/g, '');
}

/**
 * Sanitize each element of an array of strings (profile interests are the only
 * caller). Non-array input is returned untouched — callers validate shape.
 *
 * Objects and nested arrays are DROPPED rather than passed through: the
 * validators behind this only check `isArray()`, so `interests: [["<script>…"]]`
 * used to arrive here, skip stripHtml (it returns non-strings unchanged) and
 * reach a text[] column with its markup intact. Nothing legitimate sends a
 * nested object as an interest. Numbers and booleans are kept as-is; they
 * cannot carry markup.
 */
function sanitizeArray(arr) {
  if (!Array.isArray(arr)) return arr;
  const out = [];
  for (const item of arr) {
    if (typeof item === 'string') out.push(stripHtml(item));
    else if (typeof item === 'number' || typeof item === 'boolean') out.push(item);
  }
  return out;
}

module.exports = { stripHtml, sanitizeArray };
