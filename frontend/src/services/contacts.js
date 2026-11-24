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
/* RESOLVED WHERE IT IS USED, not at module scope. App.js imports
   contactsAvailable and syncContacts from this file eagerly, so a static
   `import { Contacts } from '@capacitor-community/contacts'` dragged
   @capacitor/core into the app's first-paint chunk group on every platform,
   web included, for a plugin only the two native branches below ever touch.
   Every other Capacitor plugin in src/ is already behind a dynamic import;
   this was the only one that was not. The two readers are both async, so
   awaiting the module costs them nothing. */
const loadContactsPlugin = () => import('@capacitor-community/contacts').then((m) => m.Contacts);

// The server's own ceiling (backend/routes/friends.js MAX_SYNC_PHONES). A
// larger request is a 400, so the client chunks rather than discovering this.
export const CONTACT_BATCH_SIZE = 200;

// The server allows three bulk syncs an hour. An address book bigger than
// CONTACT_BATCH_SIZE * MAX_BATCHES cannot be checked in one go, and the honest
// thing is to say so rather than to silently check the first 600 numbers and
// report "nobody in your contacts uses Flock". The next run carries on from
// where this one stopped (syncContacts's cursor), so a big book is checked in
// full over a few runs instead of its first 600 numbers every time.
export const MAX_BATCHES = 3;

// Phone labels a person is likely to be reachable on, best first. 'iphone' is
// what the plugin calls a number saved under the iPhone label, which is the
// one somebody signed up with as often as 'mobile' is; it used to rank below
// home, work and custom, so a card with three numbers dropped exactly that
// one. Work is last of the kept ones: it is the least likely to be the number
// on somebody's Flock account.
const PREFERRED_PHONE_TYPES = ['mobile', 'iphone', 'main', 'home', 'other', 'custom', 'work'];
// Never sent at all: nobody signs up to Flock with a fax or a pager.
const SKIPPED_PHONE_TYPES = /^(fax_|pager$)/;
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
    const Contacts = await loadContactsPlugin();
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
    .filter((p) => !SKIPPED_PHONE_TYPES.test(String(p?.type || '')))
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
 *   'unavailable'  no contacts API on this platform, or the plugin could not
 *                  be reached
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
  // The plugin could not be reached at all. That is not a refusal, and the
  // screen must not send somebody to a Settings switch that is already on.
  if (state === 'unavailable') {
    const err = new Error('Contacts could not be opened');
    err.code = 'unavailable';
    throw err;
  }
  if (state === 'prompt') {
    try {
      const Contacts = await loadContactsPlugin();
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
  const Contacts = await loadContactsPlugin();
  const result = await Contacts.getContacts({ projection: { phones: true } });
  const list = Array.isArray(result?.contacts) ? result.contacts : [];
  const numbers = list.flatMap(phonesFromContact);
  return { numbers: dedupe(numbers), contactCount: list.length, permission: state };
}

// Same digits, different punctuation, is one number. Deduping on the digits
// before anything is sent cuts a real address book down by a third or more, and
// every number removed here is one that never leaves the phone.
//
// THE WHOLE NUMBER, with a North American leading 1 taken off, never its last
// ten digits: keying on the last ten merged a London number with an American
// one that happened to end the same way, and one of them was never checked.
// Fewer than ten digits is an extension or a short code, which no Flock
// account can be reached on, and it is not sent.
const dedupeKey = (raw) => {
  const digits = raw.replace(/\D/g, '');
  return digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
};

function dedupe(numbers) {
  const seen = new Map();
  for (const raw of numbers) {
    if (typeof raw !== 'string') continue;
    const key = dedupeKey(raw);
    if (key.length < 10) continue;
    if (!seen.has(key)) seen.set(key, raw.trim());
  }
  return [...seen.values()];
}

// The book in one fixed order, so batch 3 is the same 200 numbers on every
// run and a run that carries on from the last one checks the numbers it has
// not checked yet rather than a reshuffled set.
const inStableOrder = (numbers) => numbers
  .map((raw) => ({ raw, key: dedupeKey(raw) }))
  .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  .map((n) => n.raw);

// A short print of the book in that order, so a run carries on from the last
// one only over the same book. The size alone let a number replaced by another
// land before the cursor, where no run of the pass would ever check it while
// the pass said nothing was left. A 32-bit FNV-1a hash of the keys: it names
// the book without holding a single number of it. With each key, whether the
// number starts with a +, because the server reads 442079460018 and
// +442079460018 differently: a number saved without its + and then corrected
// is a number no run has looked up, so the book is another book.
const bookPrint = (ordered) => {
  let h = 0x811c9dc5;
  for (const raw of ordered) {
    const key = `${raw.trim().startsWith('+') ? '+' : ''}${dedupeKey(raw)},`;
    for (let i = 0; i < key.length; i += 1) h = Math.imul(h ^ key.charCodeAt(i), 0x01000193) >>> 0;
  }
  return h.toString(36);
};

export function chunkNumbers(numbers, size = CONTACT_BATCH_SIZE) {
  const out = [];
  for (let i = 0; i < numbers.length; i += size) out.push(numbers.slice(i, i + size));
  return out;
}

// When a refused run can run again. The server says how long in the 429's
// body (retryAfterSeconds); a server that does not say is read as the hour the
// allowance is counted over.
const ONE_HOUR_S = 3600;
function retryAtFrom(err) {
  const seconds = Number(err?.data?.retryAfterSeconds);
  const wait = Number.isFinite(seconds) && seconds > 0 ? seconds : ONE_HOUR_S;
  return new Date(Date.now() + wait * 1000).toISOString();
}

/**
 * Runs one check of the book: read it, put it in a fixed order, look up at most
 * MAX_BATCHES batches starting where the last run stopped, and stop when the
 * server says the allowance is spent.
 *
 * `lookup` is injected rather than imported so this file has no opinion about
 * the API layer and can be exercised without one. Pass `findFriendsByPhone`
 * from services/api.js.
 *
 * `cursor` is where the last run stopped, { nextBatch, total, book }, which
 * the caller keeps between runs. It is used only while the book is the one it
 * was then (`book`, the print this returns); a book that changed in any way, a
 * finished one, or no cursor at all starts from the first batch.
 *
 * The return value is enough to write an HONEST summary with, and it keeps
 * apart the three things the screen used to fold into one "try the rest in an
 * hour":
 *   sent        numbers in the batches the server answered
 *   checked     the server's count of those it could read and looked up, so
 *               sent - checked is `unreadable` (a number saved without its
 *               area code, or a foreign one without its + and country code)
 *   notReached  numbers no batch of this run carried, because the book is
 *               bigger than one run or the allowance ran out
 *   throttled   only a 429, with `retryAt` saying when the next run can go
 *   failed      a lookup failed after earlier batches had answered; what they
 *               found is kept and the next run starts at the batch that failed
 *
 * @returns {Promise<{ users: object[], sent: number, checked: number, unreadable: number,
 *   total: number, notReached: number, startBatch: number, nextBatch: (number|null),
 *   book: string, answered: number, throttled: boolean, retryAt: (string|null), failed: boolean,
 *   contactCount: number, permission: string }>}
 */
export async function syncContacts(lookup, { cursor } = {}) {
  const read = await readContactPhoneNumbers();
  const numbers = inStableOrder(read.numbers);
  const all = chunkNumbers(numbers);
  const book = bookPrint(numbers);
  const resumable = cursor
    && cursor.book === book
    && Number(cursor.total) === numbers.length
    && Number.isInteger(cursor.nextBatch)
    && cursor.nextBatch > 0
    && cursor.nextBatch < all.length;
  const startBatch = resumable ? cursor.nextBatch : 0;
  const batches = all.slice(startBatch, startBatch + MAX_BATCHES);
  const byId = new Map();
  let sent = 0;
  let checked = 0;
  let answered = 0;
  let throttled = false;
  let retryAt = null;
  let failed = false;

  for (const batch of batches) {
    try {
      const data = await lookup(batch);
      answered += 1;
      sent += batch.length;
      checked += typeof data?.checked === 'number' ? Math.min(data.checked, batch.length) : batch.length;
      for (const user of data?.users || []) byId.set(user.id, user);
    } catch (err) {
      // 429 is "your allowance is spent", which is a partial result rather than
      // a failure: whatever the earlier batches found is still true and still
      // worth showing. Anything else is a real error and belongs to the
      // caller, unless earlier batches had already answered: then what they
      // found is not thrown away for the one that did not.
      if (err?.status === 429) { throttled = true; retryAt = retryAtFrom(err); break; }
      if (answered === 0) throw err;
      failed = true;
      break;
    }
  }

  const stoppedAt = startBatch + answered;
  return {
    users: [...byId.values()],
    sent,
    checked,
    unreadable: Math.max(0, sent - checked),
    total: numbers.length,
    // Everything after the last batch answered. The batches before
    // startBatch were answered by the runs this one carries on from, so over
    // a pass through the book this is exactly what is left. `sent` and
    // `checked` are this run's alone; the caller adds the earlier runs.
    notReached: Math.max(0, numbers.length - (startBatch * CONTACT_BATCH_SIZE) - sent),
    startBatch,
    nextBatch: stoppedAt < all.length ? stoppedAt : null,
    book,
    answered,
    throttled,
    retryAt,
    failed,
    contactCount: read.contactCount,
    // The browser's picker asks every time it opens, so there is no lasting
    // grant to report there.
    permission: contactsMode() === 'web' ? 'web' : read.permission,
  };
}
