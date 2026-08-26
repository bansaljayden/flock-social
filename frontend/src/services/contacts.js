// ---------------------------------------------------------------------------
// The address book, on both platforms, and as little of it as possible.
// ---------------------------------------------------------------------------
//
// WHY THIS FILE EXISTS. Contact sync used to be web-only. `navigator.contacts`
// is the Contacts Picker API, which does not exist in WKWebView, so on iOS the
// answer was always "no" and the Contacts tab was kept out of the build
// entirely rather than shipping a tab that could only apologise. That was the
// right call for a tab with no implementation behind it. It also meant that on
// the launch platform there was no way to reach anybody who was not already on
// Flock: name search needs them to have an account, Quick Add is mutual friends
// only (so empty by construction for a new account), and the QR code needs you
// to be in the same room. "Add friends" is one of two calls to action on the
// empty home screen. This is the file that gives it somewhere to go.
//
// WHAT LEAVES THE PHONE. Phone numbers, and nothing else. Not names, not
// emails, not photos, not anything the address book calls a "note". The server
// hashes what it receives, answers with the Flock accounts that matched, and
// keeps nothing. That is why `readContactPhoneNumbers` returns numbers rather
// than contacts: a shape that cannot carry a name cannot leak one by accident
// later.
//
// TWO NUMBERS PER CONTACT, MOBILE FIRST. A contact card can hold a home line, a
// work line, a fax and three mobiles. Uploading all of them multiplies the size
// of what leaves the phone without improving the odds: the number somebody
// signed up to Flock with is a mobile. Preferring the mobile-ish labels and
// stopping at two is the whole rule.
// ---------------------------------------------------------------------------
import { Contacts } from '@capacitor-community/contacts';

// The server's own ceiling (backend/routes/friends.js MAX_SYNC_PHONES). A
// larger request is a 400, so the client chunks rather than discovering this.
export const CONTACT_BATCH_SIZE = 200;

// The server allows three bulk syncs an hour. An address book bigger than
// CONTACT_BATCH_SIZE * MAX_BATCHES cannot be checked in one go, and the honest
// thing is to say so rather than to silently check the first 600 numbers and
// report "nobody in your contacts uses Flock".
export const MAX_BATCHES = 3;

// Phone labels a person is likely to be reachable on, best first. Everything
// else on the card (fax, pager, company main) is skipped entirely.
const PREFERRED_PHONE_TYPES = ['mobile', 'main', 'home', 'work', 'other', 'custom'];
const NUMBERS_PER_CONTACT = 2;

function isNative() {
  return Boolean(typeof window !== 'undefined' && window.Capacitor?.isNativePlatform?.());
}

/**
 * 'native' | 'web' | 'none'
 *
 * 'none' is a real answer and callers must render it as one. A desktop browser
 * without the Contacts Picker API is the common case, and the correct UI there
 * is the typed-number field, not an apology.
 */
export function contactsMode() {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return 'none';
  if (isNative()) return 'native';
  return 'contacts' in navigator && 'ContactsManager' in window ? 'web' : 'none';
}

export function contactsAvailable() {
  return contactsMode() !== 'none';
}

/**
 * 'granted' | 'limited' | 'denied' | 'prompt' | 'unavailable'
 *
 * 'limited' is iOS 18's partial access, where the person chose which contacts
 * the app may see. It is a SUCCESS state, not a degraded one, and the copy
 * around it should not push anybody towards granting more.
 */
export async function contactsPermissionState() {
  const mode = contactsMode();
  if (mode === 'none') return 'unavailable';
  // The web picker is presented by the browser and asks every time it opens, so
  // there is no stored state to read.
  if (mode === 'web') return 'prompt';
  try {
    const status = await Contacts.checkPermissions();
    return status?.contacts || 'prompt';
  } catch {
    return 'unavailable';
  }
}

function phonesFromContact(contact) {
  const phones = Array.isArray(contact?.phones) ? contact.phones : [];
  const ranked = phones
    .filter((p) => typeof p?.number === 'string' && p.number.trim().length > 0)
    .sort((a, b) => {
      const ai = PREFERRED_PHONE_TYPES.indexOf(a?.type);
      const bi = PREFERRED_PHONE_TYPES.indexOf(b?.type);
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    });
  return ranked.slice(0, NUMBERS_PER_CONTACT).map((p) => p.number);
}

/**
 * Reads phone numbers out of the address book. Throws with a `code` a caller can
 * branch on rather than a string it would have to match:
 *   'unavailable'  no contacts API on this platform
 *   'denied'       the person said no, or said no earlier
 *   'cancelled'    the picker was dismissed without choosing anybody
 *
 * @returns {Promise<{ numbers: string[], contactCount: number, permission: string }>}
 */
export async function readContactPhoneNumbers() {
  const mode = contactsMode();
  if (mode === 'none') {
    const err = new Error('Contacts are not available on this device');
    err.code = 'unavailable';
    throw err;
  }

  if (mode === 'web') {
    let picked;
    try {
      picked = await navigator.contacts.select(['tel'], { multiple: true });
    } catch (err) {
      // The Picker API rejects with a TypeError when the user dismisses it,
      // which is a cancellation rather than a failure and must not be shown as
      // an error.
      const cancelled = new Error('No contacts chosen');
      cancelled.code = err?.name === 'TypeError' ? 'cancelled' : 'denied';
      throw cancelled;
    }
    const list = Array.isArray(picked) ? picked : [];
    if (list.length === 0) {
      const cancelled = new Error('No contacts chosen');
      cancelled.code = 'cancelled';
      throw cancelled;
    }
    const numbers = list.flatMap((c) => (Array.isArray(c.tel) ? c.tel.slice(0, NUMBERS_PER_CONTACT) : []));
    return { numbers: dedupe(numbers), contactCount: list.length, permission: 'granted' };
  }

  // Native. requestPermissions() is what fires the iOS prompt, and iOS asks
  // once per install: a denial here is permanent until the person changes it in
  // Settings, which is why nothing in the app may call this on launch or on a
  // screen the user did not ask for.
  let state = await contactsPermissionState();
  if (state === 'prompt') {
    try {
      const status = await Contacts.requestPermissions();
      state = status?.contacts || 'denied';
    } catch {
      state = 'denied';
    }
  }
  if (state !== 'granted' && state !== 'limited') {
    const err = new Error('Flock does not have permission to read your contacts');
    err.code = 'denied';
    throw err;
  }

  // The projection is the request. `phones: true` and nothing else: no name, no
  // email, no image, no note, no postal address. Under iOS 18 limited access
  // this returns only the contacts the person chose to share, which is exactly
  // the right amount and needs no special handling.
  const result = await Contacts.getContacts({ projection: { phones: true } });
  const list = Array.isArray(result?.contacts) ? result.contacts : [];
  const numbers = list.flatMap(phonesFromContact);
  return { numbers: dedupe(numbers), contactCount: list.length, permission: state };
}

// Same digits, different punctuation, is one number. Deduping on the digits
// before anything is sent cuts a real address book down by a third or more, and
// every number removed here is one that never leaves the phone.
function dedupe(numbers) {
  const seen = new Map();
  for (const raw of numbers) {
    if (typeof raw !== 'string') continue;
    const key = raw.replace(/\D/g, '').slice(-10);
    if (key.length < 10) continue;
    if (!seen.has(key)) seen.set(key, raw.trim());
  }
  return [...seen.values()];
}

export function chunkNumbers(numbers, size = CONTACT_BATCH_SIZE) {
  const out = [];
  for (let i = 0; i < numbers.length; i += size) out.push(numbers.slice(i, i + size));
  return out;
}

/**
 * Runs the whole sync: read the book, chunk it, look each chunk up, stop when
 * the server says the allowance is spent.
 *
 * `lookup` is injected rather than imported so this file has no opinion about
 * the API layer and can be exercised without one. Pass `findFriendsByPhone`
 * from services/api.js.
 *
 * The return value is deliberately enough to write an HONEST empty state with:
 * `checked` is how many numbers were actually looked up and `total` is how many
 * the phone had, so a screen can say "none of the 240 numbers we checked are on
 * Flock" instead of "none of your contacts use Flock" when it only looked at
 * some of them.
 *
 * @returns {Promise<{ users: object[], checked: number, total: number, contactCount: number, throttled: boolean, permission: string }>}
 */
export async function syncContacts(lookup) {
  const { numbers, contactCount, permission } = await readContactPhoneNumbers();
  const batches = chunkNumbers(numbers).slice(0, MAX_BATCHES);
  const byId = new Map();
  let checked = 0;
  let throttled = false;

  for (const batch of batches) {
    try {
      const data = await lookup(batch);
      checked += typeof data?.checked === 'number' ? data.checked : batch.length;
      for (const user of data?.users || []) byId.set(user.id, user);
    } catch (err) {
      // 429 is "your allowance is spent", which is a partial result rather than
      // a failure: whatever the earlier batches found is still true and still
      // worth showing. Anything else is a real error and belongs to the caller.
      if (err?.status === 429) { throttled = true; break; }
      throw err;
    }
  }

  return {
    users: [...byId.values()],
    checked,
    total: numbers.length,
    contactCount,
    // True when the phone held more numbers than this run could look at, for
    // either reason: the allowance ran out, or the book is bigger than
    // CONTACT_BATCH_SIZE * MAX_BATCHES.
    throttled: throttled || numbers.length > CONTACT_BATCH_SIZE * MAX_BATCHES,
    permission,
  };
}
