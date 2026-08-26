// ---------------------------------------------------------------------------
// PHONE NUMBERS: ONE CANONICAL FORM, AND A KEYED DIGEST TO MATCH THEM BY.
// ---------------------------------------------------------------------------
//
// Contact discovery is the only feature in this product that asks a user to
// hand over other people's personal data. The people in an address book never
// agreed to anything, most of them will never be Flock users, and a meaningful
// share of the people holding the phone are 13 years old. So the rules are
// stricter than "it works":
//
//   1. A number is normalised to ONE canonical string before anything is done
//      with it, so the same human number cannot be two different lookups.
//   2. Matching happens on a KEYED digest, never on the digits. A phone number
//      carries about 30 bits of entropy inside a space a laptop walks in
//      seconds, so a bare SHA-256 of one is not a one-way function in any sense
//      that matters. HMAC with a server-held key is.
//   3. An uploaded number that belongs to nobody is never written anywhere. The
//      caller's numbers exist as strings on one request thread and are gone.
//
// WHY THE LAST-10-DIGITS RULE HAD TO GO. The previous comparison stripped
// non-digits, took the last 10, and accepted anything 7 digits or longer, then
// asked Postgres `... SIMILAR TO '%(a|b|c)'`. That is a SUFFIX match, so a
// 7-digit entry matched every user whose number ends with those 7 digits, in
// any of 1,000 area codes. One address-book slot bought a thousand numbers'
// worth of coverage, which is the opposite of what a contact sync is for, and
// exactly what a directory walk wants. A canonical form with a fixed length is
// what closes that: `toE164` returns a full number or it returns null, and a
// local 7-digit fragment is a null.
//
// SCOPE, STATED HONESTLY. The default region is +1 (NANP). The app's users are
// in Pennsylvania and the Lehigh Valley, every seeded venue is US, and there is
// no country picker anywhere in the client, so a bare 10-digit number can only
// sensibly mean a US or Canadian one. A number typed with a leading + is
// respected as written and kept whole, so an international contact is matched
// correctly if both sides stored it internationally. What is NOT supported is
// guessing a country for a bare national number outside the NANP, and guessing
// is worse than declining: a wrong guess resolves a stranger's number to a real
// account. Those return null and are skipped.
// ---------------------------------------------------------------------------
const crypto = require('crypto');

// ITU-T E.164: at most 15 digits after the +. The floor is not in the standard;
// 8 is the shortest real subscriber number in use once a country code is
// included, and it keeps a mistyped fragment out of the index.
const MIN_E164_DIGITS = 8;
const MAX_E164_DIGITS = 15;

// NANP: a 10-digit national number is NPA (area) + NXX (exchange) + 4 digits,
// and both NPA and NXX begin with 2-9 by definition. Enforcing that is not
// pedantry, it removes about a fifth of the guessable space at zero cost to
// anybody holding a real number, and it rejects the shapes a fuzzer produces
// (0000000000, 1111111111) before they reach the database.
const NANP_NATIONAL = /^[2-9]\d{2}[2-9]\d{6}$/;

/**
 * Canonical E.164 for a number as a human might have typed or stored it.
 * Returns `null` for anything that cannot be resolved to one whole number
 * without guessing.
 *
 * @param {string|number} raw
 * @returns {string|null} e.g. '+12025550101'
 */
function toE164(raw) {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const text = String(raw).trim();
  if (text.length === 0 || text.length > 40) return null;

  // A leading + is the only punctuation that carries meaning. Everything else
  // (spaces, dots, dashes, brackets, the "ext." a contacts app sometimes glues
  // on) is formatting. An extension is deliberately NOT preserved: it is not
  // part of the number that reaches a person's phone.
  const international = text.startsWith('+');
  let digits = text.replace(/\D/g, '');
  if (digits.length === 0) return null;

  if (international) {
    // Taken as written. A country code never starts with 0.
    if (digits[0] === '0') return null;
    if (digits.length < MIN_E164_DIGITS || digits.length > MAX_E164_DIGITS) return null;
    return `+${digits}`;
  }

  // 011 is the North American international dial-out prefix, and iOS hands it
  // back verbatim from an address book entry saved that way.
  if (digits.startsWith('011') && digits.length > 11) {
    const rest = digits.slice(3);
    if (rest[0] === '0') return null;
    if (rest.length < MIN_E164_DIGITS || rest.length > MAX_E164_DIGITS) return null;
    return `+${rest}`;
  }

  // Trunk-prefixed NANP: 1-202-555-0101.
  if (digits.length === 11 && digits[0] === '1') digits = digits.slice(1);

  if (digits.length !== 10) return null;
  if (!NANP_NATIONAL.test(digits)) return null;
  return `+1${digits}`;
}

// The key. A dedicated variable if one is set, JWT_SECRET otherwise, which is
// always present because the server cannot mint a token without it. Same
// fallback shape as the ban-tombstone pepper in routes/users.js, and for the
// same reason: a feature that silently downgrades to an unkeyed hash when a
// variable is missing is worse than one that stops working.
function discoveryPepper() {
  return process.env.CONTACT_DISCOVERY_SECRET || process.env.JWT_SECRET || '';
}

// A NAMESPACE OF ITS OWN, not shared with the ban tombstones. routes/users.js
// digests a phone as `phone:<last 10 digits>` for banned_identities; this
// digests it as `contact-discovery:v1:<E.164>`. Two different strings under the
// same key produce two unrelated digests, so a row in one table can never be
// compared against a row in the other, and neither table's contents tell you
// anything about the other's. The `v1` is there so a future change of canonical
// form can be a new namespace and a rebuild rather than a silent mismatch.
const DISCOVERY_NAMESPACE = 'contact-discovery:v1';

/**
 * Keyed digest of an already-canonical E.164 string.
 * Returns null when there is no key, which disables discovery rather than
 * falling back to something reversible.
 */
function discoveryDigest(e164) {
  const key = discoveryPepper();
  if (!key || typeof e164 !== 'string' || e164.length === 0) return null;
  return crypto.createHmac('sha256', key).update(`${DISCOVERY_NAMESPACE}:${e164}`).digest('hex');
}

/**
 * Normalise then digest, in one step, for the two callers that only ever want
 * the digest: the discovery lookup and the column that backs it.
 */
function phoneDiscoveryHash(raw) {
  const e164 = toE164(raw);
  return e164 ? discoveryDigest(e164) : null;
}

/**
 * Normalise a caller-supplied list, drop what cannot be resolved, de-duplicate,
 * and cap. De-duplication matters for more than tidiness: an address book holds
 * the same number under "Mom" and "Mom mobile", and without the dedupe those
 * two entries would each consume one of the caller's capped slots.
 *
 * Order is NOT preserved into the result on purpose; the caller sorts what it
 * returns so nothing about the response can be lined up against the input.
 *
 * @returns {string[]} canonical E.164 strings, at most `limit` of them
 */
function normalizePhoneList(list, limit) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  for (const entry of list) {
    if (seen.size >= limit) break;
    const e164 = toE164(entry);
    if (e164) seen.add(e164);
  }
  return [...seen];
}

module.exports = {
  toE164,
  discoveryDigest,
  phoneDiscoveryHash,
  normalizePhoneList,
  DISCOVERY_NAMESPACE,
  MIN_E164_DIGITS,
  MAX_E164_DIGITS,
};
