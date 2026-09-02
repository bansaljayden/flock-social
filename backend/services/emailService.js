// ---------------------------------------------------------------------------
// Transactional email (round 16)
// ---------------------------------------------------------------------------
// Resend was called directly from two places (routes/safety.js and
// routes/waitlist.js), each with its own copy of the client, the null-key skip
// and the 8s abort signal. Email verification is the third caller and the first
// one that mails a SECRET, so the shared behaviour lives here instead of being
// copied a third time:
//
//   * the client is built lazily, not at require time, so a module loaded
//     before dotenv (or in a test) does not permanently capture a missing key;
//   * a missing RESEND_API_KEY is a skip with a warning, never a throw — the
//     same fail-soft the other two callers already had;
//   * every send carries upstreamSignal('email') (round 12: an undeadlined
//     fetch parks an Express connection and a pg pool slot for ~5 minutes);
//   * links are built from a PINNED production base URL, never from the
//     request. See baseWebUrl below — this is the half that matters.
// ---------------------------------------------------------------------------
const { upstreamSignal } = require('../utils/upstream');
// The do-not-mail list. Required here rather than in each sender for the same
// reason the abort signal and the recipient gate are: a check every caller has
// to remember is a check that the fourth caller forgets.
const suppression = require('./emailSuppression');
// The one category no do-not-mail list and, as of round 27, no send counter
// stops. Read from the suppression module rather than spelled again here, so
// the two files cannot come to disagree about which string means "emergency".
const EMERGENCY_CATEGORY = suppression.EMERGENCY_CATEGORY;
// Address-keyed unsubscribe tokens, for the mail that is not keyed on a row
// somebody owns. See the header of that file for why the waitlist needed one.
const { mintUnsubscribeToken } = require('./emailUnsubscribe');

// The hosts we are willing to put in an email. A link in an email outlives the
// request that made it and is clicked on a device that is not the one that
// triggered it, so `localhost` in a verification link is not a cosmetic bug: it
// is a link that can never work, mailed to a real person, for the one action
// that unlocks their account.
// www, not the apex: DOMAIN.md and frontend/api/marketing-page.js pin
// https://www.flockcorp.com as the canonical host, and the apex answers 308 to
// it. A link in an email should land directly, not ride a redirect — mailbox
// scanners follow redirects inconsistently, and a fragment-borne reset token
// has one less hop on which a client can drop it.
const PROD_WEB_URL = 'https://www.flockcorp.com';
// api.flockcorp.com, not the Railway-generated name: both answer, but the
// Railway name is an implementation detail that changes if the service is ever
// recreated, and a confirmation link mailed today is clicked later. The
// custom domain is the address the app itself uses (frontend/src/services/api.js).
const PROD_API_URL = 'https://api.flockcorp.com';

// Where a reply lands. The reasoning is at safeReplyTo inside sendEmail; the
// short version is that several of these messages ask the reader to reply, one
// of them is sent From an address with no inbound route, and nothing had ever
// set a Reply-To. This address is the one the product already publishes as the
// way to reach a person, so if it ever stops being routed in Cloudflare, this
// constant and routes/users.js change together.
const DEFAULT_REPLY_TO = 'hello@flockcorp.com';

// True for anything that would produce a dead or downgraded link: a non-https
// scheme, a loopback / link-local / .local host, or junk that does not parse.
//
// Round 20: the comment above has always said "link-local" and the code did not
// check a single link-local address. 169.254.0.0/16 was absent — that is the
// range the cloud metadata endpoint lives on — and so were fe80::/10 and
// fc00::/7, the IPv6 link-local and unique-local ranges, the second of which
// has no IPv4 equivalent anywhere in the list. A base URL is interpolated into
// a verification link and a password-reset link, so a host from any of those
// ranges is a dead link mailed to a real person for the one action that
// unlocks their account.
//
// The IPv6 rules are applied ONLY to a host that is actually an IPv6 literal.
// Matching `^f[cd]` against a hostname would refuse fdic.gov and fcbank.com,
// which is the classic way a prefix check for an address range starts refusing
// domain names.
function isUnmailableBase(value) {
  if (typeof value !== 'string' || !value.trim()) return true;
  let u;
  try {
    u = new URL(value.trim());
  } catch {
    return true;
  }
  if (u.protocol !== 'https:') return true;
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host.endsWith('.local') || host.endsWith('.internal')) return true;

  // An IPv6 literal is the only host that can contain a colon.
  if (host.includes(':')) {
    if (host === '::' || host === '::1') return true;
    if (host.startsWith('::ffff:')) return true;      // IPv4-mapped; we never mail one
    if (/^fe[89ab]/.test(host)) return true;          // fe80::/10 link-local
    if (/^f[cd][0-9a-f]{2}:/.test(host)) return true; // fc00::/7 unique-local
    return false;
  }

  if (host === '0.0.0.0') return true;
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)) return true;
  if (/^169\.254\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// CAN THIS ADDRESS RECEIVE MAIL — one definition, for everything that sends.
// ---------------------------------------------------------------------------
// There were three, and they disagreed:
//
//   routes/auth.js            isMailableAddress
//   services/moderationAlerts.js  isMailable   `[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+`
//   routes/safety.js          EMAIL_RE         `[^\s@]+@[^\s@]+\.[^\s@]{2,}`
//
// The disagreement had teeth. The safety copy's character class excluded
// whitespace and `@` and nothing else, so `mum@example.invalid` (RFC 2606 —
// guaranteed undeliverable, and the domain THIS codebase mints for Apple
// private-relay placeholders and evicted-squat tombstones) was a perfectly good
// trusted contact, while the moderation copy refused the identical string. A
// trusted contact who cannot be mailed is a person on the Safety screen who
// will never be told anything, on a feature whose only channel is email.
//
// Beyond the reserved TLDs, the class also has to exclude the characters that
// make one field mean more than one recipient: `,` and `;` separate addresses,
// and `<` `>` `"` open the RFC 5322 display-name form, so `Mum<a@b.co>` is a
// user-chosen label rendered in place of the address it actually goes to.
//
// This is deliberately a DELIVERABILITY test, not an RFC 5322 parser. Nobody's
// real address is refused by it; every string it refuses is one that would
// bounce, fan out, or mislead.
const MAILABLE_RE = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>".]{2,}$/;
const MAX_ADDRESS_LENGTH = 254; // RFC 5321 §4.5.3.1

function isMailableAddress(addr) {
  if (typeof addr !== 'string') return false;
  const t = addr.trim();
  if (!t || t.length > MAX_ADDRESS_LENGTH) return false;
  if (!MAILABLE_RE.test(t)) return false;
  // .invalid is reserved and can never resolve. .test / .example / .localhost
  // are reserved on the same RFC and are just as undeliverable.
  if (/\.(invalid|test|example|localhost)$/i.test(t)) return false;
  return true;
}

// A subject IS a header, so a CR or LF in one is header injection, and an
// unbounded one is a truncated line in somebody's inbox list. Applied HERE, in
// the one place every outbound message passes through, rather than in each
// caller's own copy — a caller that forgets is the entire failure mode, and
// there are now three callers.
const MAX_SUBJECT_LENGTH = 200;
function safeSubjectLine(s) {
  return String(s == null ? '' : s).replace(/[\r\n\t]+/g, ' ').trim().slice(0, MAX_SUBJECT_LENGTH);
}

// A recipient address is the most identifying thing in most of these messages,
// and on the SOS path it belongs to a THIRD PARTY who never signed up for Flock
// — typically a parent, on a product whose floor is 13. Railway keeps stderr,
// and nobody consented to that.
//
// The question a log line here has to answer is "did this go out, and roughly
// where to". The domain answers the deliverability half; the local part answers
// nothing that is not already in the database. So the local part goes.
function maskAddress(to) {
  if (Array.isArray(to)) return to.map(maskAddress).join(', ');
  if (typeof to !== 'string' || !to.trim()) return '(no address)';
  const t = to.trim();
  const at = t.lastIndexOf('@');
  if (at <= 0) return '(address hidden)';
  return `${t[0]}${'*'.repeat(5)}@${t.slice(at + 1)}`;
}

// The HTML-escaper the three email sinks each had a copy of. Escaping (rather
// than stripping) is what keeps "O'Brien & Sons" rendering as itself while
// `<a href="http://evil">` cannot become a link in a message sent to somebody's
// mother.
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function pickBase(envValue, fallback, label) {
  if (isUnmailableBase(envValue)) {
    if (envValue) {
      console.warn(`[email] ${label} is not a public https URL ("${envValue}"), so ${fallback} is being mailed instead`);
    }
    return fallback;
  }
  return envValue.trim().replace(/\/+$/, '');
}

// Where a human lands. PUBLIC_WEB_URL is the same variable the invite links and
// the NFC redirect already use.
function baseWebUrl() {
  return pickBase(process.env.PUBLIC_WEB_URL, PROD_WEB_URL, 'PUBLIC_WEB_URL');
}

// Where the verification link points. It has to be the API, not the web app:
// the API is what can actually consume the token, and it redirects the browser
// back to the web app afterwards. Deliberately NOT derived from req.protocol /
// req.get('host') — the Host header is attacker-controlled, and building an
// emailed secret's URL out of it is textbook host-header injection.
function baseApiUrl() {
  return pickBase(process.env.PUBLIC_API_URL, PROD_API_URL, 'PUBLIC_API_URL');
}

let client = null;
let clientKey = null;
function resendClient() {
  const key = process.env.RESEND_API_KEY;
  if (!key) return null;
  // Round 20: the client was built once and kept forever, so a key ROTATED
  // inside a live process left every subsequent send authenticating with the
  // old secret. That is a 401 from the provider on every message including an
  // SOS, with nothing in the code able to notice — resetClient() exists but
  // only the tests ever call it. This is the same defect routes/safety.js was
  // migrated off (a client that outlives the value it was built from), one
  // layer down, so the cache is keyed on the thing it was built from.
  if (!client || clientKey !== key) {
    const { Resend } = require('resend');
    client = new Resend(key);
    clientKey = key;
  }
  return client;
}

// Reset point for tests. A key rotation no longer needs it (see above), but
// swapping the `resend` module itself under a test does.
function resetClient() {
  client = null;
  clientKey = null;
}

// Never throws. Returns { sent } | { sent:false, skipped } | { sent: false, error }.
//
// ONE MESSAGE, ONE RECIPIENT. `to` used to be passed through untouched, so an
// array fanned out to every element, a comma-joined string became a header with
// several recipients, and `undefined` bought a provider round trip and an 8s
// deadline before failing. Every caller in the codebase sends exactly one
// address, which is why refusing anything else costs nothing and closes the
// class for whatever the next caller turns out to be.
// Extra RFC 5322 headers, for the one thing that needs them: the Monday
// digest's List-Unsubscribe pair (RFC 8058). Treated exactly like the three
// headers above rather than passed through, because a bare CR or LF in a name
// or a value is header injection into the outgoing message, and the caller
// builds one of these values out of a URL. Names are restricted to the token
// characters RFC 5322 allows; a name outside that set is dropped rather than
// repaired, so a caller that got a header name wrong sends no header instead
// of a mangled one.
function safeHeaders(headers) {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return null;
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) continue;
    if (value == null || typeof value === 'object' || typeof value === 'function') continue;
    const clean = String(value).replace(/[\r\n]+/g, ' ').trim();
    if (clean) out[name] = clean;
  }
  return Object.keys(out).length ? out : null;
}

// ---------------------------------------------------------------------------
// THE EMAIL ALARM, and why this module needed one of its own.
// ---------------------------------------------------------------------------
// Email is the only channel this product has to somebody who is not currently
// holding the app. It carries the signup verification link, the password reset
// link, the SOS alert to a parent, the SOS stand-down, moderation notices, the
// venue digest and venue verification claims. Every one of those paths was
// built to FAIL SOFT, which is right on its own terms and adds up to something
// that is not: a Resend key that expires, a sending domain that lapses, or an
// account suspension produces `{ sent: false }` at every caller, each caller
// logs its own polite line, every screen in the product still looks correct,
// and nobody is told. An account cannot be created, a password cannot be
// recovered, and a parent is not told their child raised an alarm.
//
// The money watch in server.js is the same shape of fix for the paid APIs: a
// PUSH, once per condition per UTC day, on a greppable token, with a Sentry
// message for the half that reaches a person who is not reading the log. This
// is that, for the channel where the failure is silent by construction.
//
// It lives HERE and fires ON THE SEND rather than on a fifteen-minute poll,
// because there is no counter to poll: the fact worth alarming on is the
// outcome of a message the product just tried to deliver.
//
// IT REPORTS, IT NEVER REFUSES. Nothing below changes what is sent, and the
// whole of it is wrapped so a broken alarm can never break a send. A watchdog
// that can break the thing it watches is worse than no watchdog.
// ---------------------------------------------------------------------------
const CONSECUTIVE_FAILURES_BEFORE_ALARM = 5;

function utcDay(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 10);
}

// condition key -> the UTC day it last spoke, so each condition says its piece
// once a day. Repeating it on every send would train the reader to skip it,
// which is the same failure as saying nothing.
const alarmSaid = new Map();
const ALARM_KEYS_MAX = 2000;

function raiseEmailAlarm(key, message, extra) {
  try {
    const day = utcDay();
    if (alarmSaid.get(key) === day) return false;
    // Bounded, and swept STALE-FIRST rather than cleared. Two of the keys below
    // carry a recipient address, so an attacker who could force a clear() would
    // be forcing the alarm to speak again about something it had already
    // reported. That is the harmless direction, but the rule in
    // utils/cacheKeyInventory.js is that a map holding state a caller can
    // influence never gets emptied wholesale, and there is no reason for this
    // one to be the exception.
    if (alarmSaid.size > ALARM_KEYS_MAX) {
      for (const [k, v] of alarmSaid) if (v !== day) alarmSaid.delete(k);
      // AND THE STALE SWEEP ON ITS OWN DOES NOT BOUND ANYTHING, which is what
      // this file and utils/cacheKeyInventory.js both claimed it did. The value
      // of every entry is a UTC day string and the sweep deletes only the
      // entries whose day is not today, so on the day the map actually fills up
      // there is nothing stale in it and the loop above frees nothing at all.
      // Two of the five keys carry a recipient address, so the entry count is
      // the number of DISTINCT ADDRESSES the alarm has spoken about since
      // midnight, and it grows without a ceiling. Measured 2026-08-26; the word
      // "bounded" was aspirational.
      //
      // Insertion order is what Map iterates in, so this drops the OLDEST live
      // entries, which are the conditions that have already had their say
      // furthest back. Losing one only lets that alarm repeat later today,
      // which is the direction that makes a problem MORE visible, and is the
      // same trade the paragraph above already accepts.
      let over = alarmSaid.size - ALARM_KEYS_MAX;
      if (over > 0) {
        for (const k of alarmSaid.keys()) {
          alarmSaid.delete(k);
          if (--over <= 0) break;
        }
      }
    }
    alarmSaid.set(key, day);
    // One token, so a single grep over the Railway log finds every email
    // failure whatever raised it, the way 'MONEY' already works for spend.
    console.error(`🛡️ EMAIL: ${message}`);
    try {
      // Lazily required and fully guarded: a build without @sentry/node, and
      // every test that never loads it, must be unaffected. instrument.js
      // makes this a no-op while SENTRY_DSN is unset, which it is on the
      // production service today, so the console line above is the half that
      // actually lands until that variable is set.
      // eslint-disable-next-line global-require
      const Sentry = require('@sentry/node');
      if (Sentry && typeof Sentry.captureMessage === 'function') {
        Sentry.captureMessage(`EMAIL: ${message}`, {
          level: 'error',
          tags: { email_alarm: key },
          extra: { day, ...extra },
        });
      }
    } catch (err) {
      // No Sentry in this build. The console line stands on its own.
    }
    return true;
  } catch (err) {
    return false;
  }
}

// What an ops surface can read to answer "is email working right now". Counts
// roll at UTC midnight with the alarm, and they are process-local, so a deploy
// resets them the same way every other in-memory meter in this app resets.
const health = {
  day: null,
  attempted: 0,
  sent: 0,
  failed: 0,
  skipped: 0,
  suppressed: 0,
  capped: 0,
  consecutiveFailures: 0,
  lastSentAt: null,
  lastFailureAt: null,
  lastError: null,
};

function rollHealthDay() {
  const day = utcDay();
  if (health.day === day) return;
  health.day = day;
  health.attempted = 0;
  health.sent = 0;
  health.failed = 0;
  health.skipped = 0;
  health.suppressed = 0;
  health.capped = 0;
}

function emailHealthStatus() {
  return {
    ...health,
    keyConfigured: Boolean(process.env.RESEND_API_KEY),
    // How many distinct conditions the alarm is currently holding a "said this
    // already today" note for. Worth an ops surface on its own — a number that
    // climbs into the hundreds means hundreds of DIFFERENT addresses are being
    // reported, not one noisy one — and it is also what pins the ceiling above
    // it, which claimed to bound this map and did not.
    alarmKeys: alarmSaid.size,
    alarmKeysMax: ALARM_KEYS_MAX,
  };
}

function resetEmailHealth() {
  alarmSaid.clear();
  health.day = null;
  health.attempted = 0;
  health.sent = 0;
  health.failed = 0;
  health.skipped = 0;
  health.suppressed = 0;
  health.capped = 0;
  health.consecutiveFailures = 0;
  health.lastSentAt = null;
  health.lastFailureAt = null;
  health.lastError = null;
}

// ---------------------------------------------------------------------------
// PER-RECIPIENT DAILY CEILING.
// ---------------------------------------------------------------------------
// Every caller has its own throttle (the waitlist route's 500/day, the
// moderation service's 40/hour, the reset route's hourly debounce, the digest's
// one-marker-per-venue-per-week) and none of them can see each other. A loop
// that spans two of them, or a caller added later with no throttle at all, is
// unbounded outbound mail charged per send. So there is one backstop here, at
// the only place they all pass through, counted per RECIPIENT because that is
// what a runaway loop looks like from the mailbox's side.
//
// ROUND 27: THE NUMBER WAS 60, AND THE SENTENCE THAT JUSTIFIED IT WAS WRONG.
//
// It read: "the busiest legitimate recipient is a moderation address during a
// report flood, bounded at 40/hour by moderationAlerts. 60 messages to one
// address in a day is not a busy day, it is a bug." Forty an HOUR is nine
// hundred and sixty a DAY. The backstop was sitting an order of magnitude
// BELOW the ceiling of the loudest caller it was written to back up, so it was
// not catching loops, it was cutting the operator inbox off at message
// sixty-one and then dropping everything else that address was owed for the
// rest of the day.
//
// What lands on that one address: every content report alert
// (services/moderationAlerts.js), every CHILD-SAFETY report alert on the same
// hourly window, and every venue verification claim
// (routes/venueProfile.js notifyVerificationRequested). All three resolve
// their recipient from MODERATION_ALERT_EMAIL, so the day that variable is
// finally set they are one mailbox sharing one counter, and a venue owner who
// re-claims a listing in a loop (changing google_place_id clears
// verification_requested_at, so the claim can be made again) could spend that
// mailbox's day and silence the child-safety alert channel from an ordinary
// authenticated account. That is not a cap doing its job.
//
// So the counter is now keyed on the CATEGORY as well as the address, and the
// number is 300 rather than 60.
//
// THE KEY IS THE HALF THAT MATTERS. A cap that silently eats a verification
// link is worse than one that eats a digest, and with a single shared counter
// the digest and the verification link were spending the same allowance, so
// whichever arrived first decided which one was dropped. Separate counters mean
// a flood of marketing to an address can never be the reason a password reset
// to that same address is refused, whatever order they arrive in.
//
// THE NUMBER. 300 is above any day a PERSON's mailbox can legitimately see:
// their own verification, resets and moderation notices are throttled into
// single digits by routes/auth.js and routes/safety.js, and the marketing they
// can receive is one digest a week. It is also above a real operator day, while
// staying unmistakably a loop if it is ever reached. There is one number rather
// than one per category because a second magic number is a second thing to be
// wrong about, and the key already separates what needed separating.
//
// EMERGENCY IS NOT CAPPED AT ALL. See below.
//
// THE EMERGENCY EXEMPTION IS THE SAME ARGUMENT THE SUPPRESSION LIST ALREADY
// MAKES, and it was missing here. services/emailSuppression.js lets an SOS
// past a hard bounce because a deliverability fact is not a refusal of an
// ambulance. A counter built to stop marketing loops is not a refusal of one
// either, and it was silently eating both halves of the SOS path: the alert to
// a parent and, worse, the stand-down that tells them it is over. What bounds
// the emergency path is not this map, it is routes/safety.js: a five-minute
// per-user cooldown held in Postgres (emergency_alerts), which unlike this map
// survives a deploy. A loop is still counted and still says so out loud when
// it crosses the transactional number, so an emergency loop is visible without
// being swallowed.
const PER_RECIPIENT_DAILY_CAP = 300;
const RECIPIENT_WINDOW_MS = 24 * 60 * 60 * 1000;
const recipientCounts = new Map(); // `${category}\n${address}` -> { count, resetAt }

// Returns { allowed, count, cap }. `allowed` is false only for a category that
// is actually capped; the emergency path always goes, and the count comes back
// so the caller can say so when it is plainly a loop.
function claimRecipientBudget(recipient, category) {
  const key = `${category}\n${recipient.toLowerCase()}`;
  const now = Date.now();
  if (recipientCounts.size > 5000) {
    for (const [k, v] of recipientCounts) if (now > v.resetAt) recipientCounts.delete(k);
  }
  let entry = recipientCounts.get(key);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + RECIPIENT_WINDOW_MS };
    recipientCounts.set(key, entry);
  }
  const cap = PER_RECIPIENT_DAILY_CAP;
  if (category !== EMERGENCY_CATEGORY && entry.count >= cap) {
    return { allowed: false, count: entry.count, cap };
  }
  entry.count += 1;
  return { allowed: true, count: entry.count, cap };
}

function resetRecipientBudget() {
  recipientCounts.clear();
}

// A plain-text alternative part. Two reasons it is not optional:
//
//   * every major spam filter scores an HTML-only message worse than a
//     multipart one, and the messages that matter most here (verification,
//     password reset) are the ones a spam folder breaks entirely;
//   * a text part is what a screen reader, a watch, and a text-only client
//     actually render, and "view this in an HTML mail client" is not a
//     password reset.
//
// Sanitised for the same reason the subject is: this is a body, not a header,
// but a null byte or a lone CR in it is a message some MTAs reject outright.
function safeTextBody(text) {
  if (typeof text !== 'string') return undefined;
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '').trim();
  return clean ? clean : undefined;
}

// A LAST-RESORT TEXT PART, derived from the HTML when the caller passed none.
//
// safeTextBody's comment above says why an HTML-only message is a problem, and
// then four of this codebase's senders shipped HTML-only anyway, because the
// text part was left to each caller to remember and each caller is a different
// file. The ones that forgot are not the cheap ones: the SOS alert to a
// trusted contact, the SOS stand-down, the share-my-location message and the
// safety test email (routes/safety.js), plus every content report and
// child-safety alert (services/moderationAlerts.js). The most important
// message this product sends was the one most likely to be scored as spam.
//
// So the default is derived here, at the one place every message passes
// through, for the same reason the suppression check and the abort signal live
// here: a step every caller has to remember is a step the next caller forgets.
// A caller that passes its own `text` is untouched, and a hand-written part is
// always better than this one.
//
// The rules are deliberately small. Block-level tags become line breaks so the
// result is not one run-on paragraph, an <a> keeps its href beside the words
// (a text part whose links have vanished is worse than no text part on a
// message whose whole purpose is a link), <style> and <script> contents are
// dropped rather than rendered as CSS, and the five escapes escapeHtml writes
// are turned back into the characters a person reads.
const BLOCK_TAGS = 'address|article|aside|blockquote|br|div|dl|dt|dd|fieldset|figure|footer|form|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|table|tbody|td|tfoot|th|thead|tr|ul';

function deriveTextFromHtml(html) {
  if (typeof html !== 'string' || !html.trim()) return undefined;
  let s = html;
  s = s.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  // Keep the destination of a link next to its label. The href is read out of
  // the tag before the tag is removed, and only an http(s) one is kept: a
  // mailto or a javascript: URI printed into a plain-text body is noise at
  // best.
  s = s.replace(/<a\b[^>]*href\s*=\s*["']?(https?:\/\/[^"'\s>]+)["']?[^>]*>([\s\S]*?)<\/a>/gi,
    (_m, href, label) => `${label} ( ${href} )`);
  s = s.replace(new RegExp(`<(?:${BLOCK_TAGS})\\b[^>]*>`, 'gi'), '\n');
  s = s.replace(new RegExp(`</(?:${BLOCK_TAGS})\\s*>`, 'gi'), '\n');
  s = s.replace(/<[^>]+>/g, '');
  s = s.replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&#0*34;/g, '"')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    // Ampersand LAST, so `&amp;lt;` does not become a `<` that was never in the
    // original. Same ordering rule escapeHtml applies in reverse.
    .replace(/&amp;/gi, '&');
  s = s.replace(/[ \t]+/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
  return safeTextBody(s);
}

async function sendEmail({ to, subject, html, text, replyTo, from = 'Flock <hello@flockcorp.com>', headers, category = 'transactional' }) {
  if (!isMailableAddress(to)) {
    console.error('[email] refusing a recipient that is not one deliverable address:', maskAddress(to));
    return { sent: false, error: 'invalid recipient', refused: true };
  }
  const recipient = to.trim();
  rollHealthDay();
  health.attempted += 1;

  // The do-not-mail list, consulted HERE rather than in each caller, because a
  // suppression list every sender has to remember to check is a suppression
  // list. A hard bounce or a spam complaint blocks every category except
  // 'emergency'; an unsubscribe blocks marketing and leaves a password reset
  // alone. 'emergency' is the SOS alert in routes/safety.js and nothing else,
  // and the argument for why a bounce must not swallow one is written out at
  // EMERGENCY_CATEGORY in services/emailSuppression.js. See the same file for
  // why this fails open.
  const allowed = await suppression.checkSendAllowed(recipient, category);
  if (allowed.blocked) {
    health.suppressed += 1;
    console.warn('[email] suppressed, not sending to', maskAddress(recipient), `(${allowed.reason})`);
    // A MARKETING message stopped by this list is the list working. A
    // TRANSACTIONAL one stopped by it is a person who cannot confirm their
    // address and cannot recover their password, on an account whose only
    // identifier is that address, and nothing in this codebase can take a row
    // back off email_suppressions. That is a locked-out user, and until this
    // line it produced a console.warn indistinguishable from a suppressed
    // digest. It is named, at alarm level, once per address per day, because
    // an operator has to know WHICH address to act on.
    if (category !== 'marketing') {
      raiseEmailAlarm(
        `locked-out:${recipient.toLowerCase()}`,
        `${maskAddress(recipient)} is on the do-not-mail list (${allowed.reason}) and a ${category} message was just refused for it. `
        + 'If that address owns a Flock account, its owner cannot verify their email and cannot reset their password, and there is no self-service way back. '
        + 'Clearing the row in email_suppressions is the only fix.',
        { reason: allowed.reason, category }
      );
    }
    return { sent: false, suppressed: true, reason: allowed.reason, refused: true };
  }

  const budget = claimRecipientBudget(recipient, category);
  if (!budget.allowed) {
    const message = `${maskAddress(recipient)} has already been mailed ${budget.cap} ${category} messages in 24 hours. `
      + 'That is a send loop, not a busy day. Nothing further in this category goes to this address until the window rolls.';
    health.capped += 1;
    console.error(`[email] REFUSING to send: ${message}`);
    raiseEmailAlarm(`cap:${category}`, message, { category, cap: budget.cap });
    return { sent: false, error: 'per-recipient daily cap', refused: true };
  }
  // The emergency path is not capped, so a loop on it would otherwise be
  // invisible. It is still counted, and it still says so once it crosses the
  // number every other category stops at.
  if (category === EMERGENCY_CATEGORY && budget.count > PER_RECIPIENT_DAILY_CAP) {
    raiseEmailAlarm(
      `emergency-loop:${recipient.toLowerCase()}`,
      `${maskAddress(recipient)} has been sent ${budget.count} emergency messages in 24 hours. `
      + 'These are deliberately not capped so an SOS alert and its stand-down can never be swallowed, so this is being reported rather than refused. '
      + 'Check the alert cooldown in routes/safety.js.',
      { count: budget.count }
    );
  }
  const safeSubject = safeSubjectLine(subject);
  // A caller's own text part wins. Only when there is none does the HTML get
  // flattened into one, so no message leaves here HTML-only. See
  // deriveTextFromHtml for which senders that was silently true of.
  const safeText = safeTextBody(text) || deriveTextFromHtml(html);
  // `to` and `subject` are settled above; `from` is the third header and was
  // the only one still passed through untouched. It is a constant at both call
  // sites today, which is the argument for closing it now rather than after a
  // fourth caller builds one out of something it read.
  const safeFrom = String(from == null ? '' : from).replace(/[\r\n]+/g, ' ').trim();
  // WHERE A REPLY GOES, which until round 27 was nowhere anybody had checked.
  //
  // Three of these messages tell the reader in so many words to reply: the
  // moderation warning ("reply to this email and a person will read it"), and
  // both unsubscribe failure pages. And the message with the strongest natural
  // pull to reply is the one nobody wrote that line into, the SOS alert to a
  // parent, which routes/safety.js sends From `alerts@flockcorp.com`. Resend
  // will send From any address on a verified domain whether or not a mailbox
  // exists behind it, so an address that was never created in Cloudflare Email
  // Routing sends perfectly well and bounces every reply. A parent replying to
  // "your child raised an alarm" is the worst place in this product to
  // discover that.
  //
  // So every message carries a Reply-To that a person reads, unless its caller
  // names a better one. hello@flockcorp.com is the address the product already
  // publishes as the way to reach a human (routes/users.js) and already sends
  // most of its mail from. Sanitised exactly like `from` and `subject`,
  // because it is a header too.
  const safeReplyTo = String(replyTo == null ? DEFAULT_REPLY_TO : replyTo).replace(/[\r\n]+/g, ' ').trim();
  const extraHeaders = safeHeaders(headers);
  const shown = maskAddress(recipient);

  // Round 21: resendClient() ran OUTSIDE the try below, so a throw from
  // require('resend') or the Resend constructor (a broken install, a bad
  // node_modules deploy) became a rejected promise — from the function whose
  // contract line one says "Never throws", and which routes/safety.js and
  // routes/auth.js await without a catch of their own on the strength of it.
  let resend;
  try {
    resend = resendClient();
  } catch (err) {
    console.error('[email] Resend client could not be built:', err.message);
    noteSendFailure(err.message);
    return { sent: false, error: err.message };
  }
  if (!resend) {
    health.skipped += 1;
    console.warn('[email] RESEND_API_KEY not set, skipping email to', shown);
    // In development this is the ordinary state and the warn above is right.
    // On the production service it means the product has no outbound channel
    // at all, and every screen still looks correct while it is true.
    if (process.env.NODE_ENV === 'production') {
      raiseEmailAlarm(
        'no-key',
        'RESEND_API_KEY is not set on this deployment, so NOTHING is being mailed: no signup verification, no password reset, '
        + 'no SOS alert to a trusted contact and no stand-down. Nothing in the app looks broken while this is true. '
        + 'Set the variable in the Railway service.',
        { attempted: health.attempted }
      );
    }
    return { sent: false, skipped: true };
  }
  try {
    const { data, error } = await resend.emails.send(
      {
        from: safeFrom,
        to: recipient,
        subject: safeSubject,
        html,
        ...(safeReplyTo ? { replyTo: safeReplyTo } : {}),
        ...(safeText ? { text: safeText } : {}),
        ...(extraHeaders ? { headers: extraHeaders } : {}),
      },
      { signal: upstreamSignal('email') }
    );
    // `refused: true` means the provider ANSWERED and declined, so no message
    // left the building. That is a different fact from the catch below, where
    // the request was in flight when it was aborted or the socket died and
    // nobody knows whether Resend accepted it. A caller that retries (the
    // Monday digest releases its send marker) has to be able to tell them
    // apart, because retrying the ambiguous one is how a person gets the same
    // email twice and Flock gets billed twice.
    if (error) {
      console.error('[email] Resend error for', shown, JSON.stringify(error));
      noteSendFailure(error.message || 'send failed');
      return { sent: false, error: error.message || 'send failed', refused: true };
    }
    console.log('[email] sent to', shown, 'id:', data?.id);
    health.sent += 1;
    health.consecutiveFailures = 0;
    health.lastSentAt = Date.now();
    return { sent: true, id: data?.id };
  } catch (err) {
    console.error('[email] send failed for', shown, err.message);
    noteSendFailure(err.message);
    return { sent: false, error: err.message };
  }
}

// A single failed send is weather: one mailbox refused it, one request timed
// out. A RUN of them is the channel being down, and the three ways that
// happens are exactly the three nobody would otherwise hear about. An expired
// or revoked API key answers 401 on every message. A sending domain that
// lapsed, or an account suspended for a reputation problem, answers 403 on
// every message. Both look identical from every caller: fail soft, log a line,
// carry on with a product that appears to work.
function noteSendFailure(message) {
  health.failed += 1;
  health.consecutiveFailures += 1;
  health.lastFailureAt = Date.now();
  health.lastError = typeof message === 'string' ? message.slice(0, 300) : String(message);
  if (health.consecutiveFailures < CONSECUTIVE_FAILURES_BEFORE_ALARM) return;
  raiseEmailAlarm(
    'failing',
    `the last ${health.consecutiveFailures} outbound emails all failed. Nothing is reaching anybody: not a verification link, not a password reset, `
    + `not an SOS alert. The provider's last words were "${health.lastError}". `
    + 'Check the Resend API key, the flockcorp.com sending domain, and whether the Resend account is in good standing.',
    { consecutiveFailures: health.consecutiveFailures, lastError: health.lastError, sentToday: health.sent }
  );
}

function verificationLink(token) {
  return `${baseApiUrl()}/api/auth/verify-email?token=${encodeURIComponent(token)}`;
}

// Where a reset link points. The WEB app, not the API: unlike verification,
// consuming a reset needs the person to type a new password, so the link has to
// land on a screen. Same pinned base URL, same reasoning as baseApiUrl above.
//
// The token rides in the FRAGMENT, not the query string. Three things read a
// URL that a fragment is invisible to: the server it is requested from (so the
// token never reaches a Vercel access log), the Referer header sent to anything
// the page loads, and any mailbox scanner that prefetches links. That last one
// matters here in a way it did not for verification: Outlook Safe Links and
// friends GET every link in every message, and a GET can never spend a reset
// token because consuming one requires an explicit POST from the screen.
function passwordResetLink(token) {
  return `${baseWebUrl()}/reset-password#token=${encodeURIComponent(token)}`;
}

// A link in one of these messages is about to become a clickable href in
// somebody's inbox. The builders above always produce one from a pinned https
// base, so a value that fails the same test the base URLs pass can only mean a
// caller was handed something it should not have been: user input, a
// `javascript:` URI (which escapeHtml preserves perfectly — escaping is about
// markup, not schemes), or a dev URL. Refusing to send beats mailing a link
// that is dead or hostile.
function isMailableLink(link) {
  return typeof link === 'string' && !isUnmailableBase(link);
}

// The TTL numbers are interpolated into body copy unescaped, which is fine for
// a number and is "expires in undefined hours" for anything else. The callers
// pass constants today (auth.js: 24 hours, 60 minutes); the fallbacks match
// them so a caller slip degrades to true-enough copy, never to gibberish.
function ttlNumber(value, fallback) {
  // Number(Symbol) THROWS, and this helper sits inside senders whose contract
  // is "settles, never rejects" — so only the types Number can actually read
  // are offered to it.
  const n = (typeof value === 'number' || typeof value === 'string') ? Number(value) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Copy rules (SLOP-AUDIT.md): no em dashes, no marketing words, sounds like a
// person. The name is UGC and is HTML-escaped even though it was screened at
// signup, because this is the one place it is rendered outside our own client.
async function sendVerificationEmail({ to, name, link, hours }) {
  if (!isMailableLink(link)) {
    console.error('[email] refusing to mail a verification link that is not a public https URL, to', maskAddress(to));
    return { sent: false, error: 'invalid link' };
  }
  const safeName = escapeHtml(name || 'there');
  const safeLink = escapeHtml(link);
  const safeHours = ttlNumber(hours, 24);
  return sendEmail({
    to,
    subject: 'Confirm your email for Flock',
    // The text part carries the RAW name and the RAW link, not the escaped
    // ones: `&amp;` is correct in an href attribute and wrong in a plain-text
    // body, where it is what the reader pastes into their browser.
    text: [
      'Confirm your email',
      '',
      `Hi ${name || 'there'}, someone created a Flock account with this address. Confirm it and the account is yours.`,
      '',
      link,
      '',
      `This link works once and expires in ${safeHours} hours.`,
      '',
      'If you did not sign up, ignore this. Without a confirmation the account cannot add friends, join plans, or store payment handles, and it will stay that way.',
      '',
      'The Flock Team',
    ].join('\n'),
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 24px;">
        <div style="text-align: center; margin-bottom: 32px;">
          <img src="${baseWebUrl()}/flock-logo.png" alt="Flock" width="64" height="64" style="border-radius: 16px;" />
        </div>
        <h1 style="font-size: 24px; font-weight: 700; color: #0d2847; margin-bottom: 16px;">Confirm your email</h1>
        <p style="font-size: 16px; color: #4a5568; line-height: 1.6; margin-bottom: 24px;">
          Hi ${safeName}, someone created a Flock account with this address. Confirm it and the account is yours.
        </p>
        <p style="margin: 0 0 24px;">
          <a href="${safeLink}" style="display: inline-block; background: #0d2847; color: #ffffff; text-decoration: none; padding: 14px 28px; border-radius: 10px; font-size: 16px; font-weight: 600;">Confirm my email</a>
        </p>
        <p style="font-size: 14px; color: #4a5568; line-height: 1.6; margin-bottom: 24px;">
          This link works once and expires in ${safeHours} hours. If the button does nothing, paste this into your browser:<br />
          <span style="word-break: break-all; color: #2b6cb0;">${safeLink}</span>
        </p>
        <p style="font-size: 14px; color: #4a5568; line-height: 1.6; margin-bottom: 24px;">
          If you did not sign up, ignore this. Without a confirmation the account cannot add friends, join plans, or store payment handles, and it will stay that way.
        </p>
        <p style="font-size: 14px; color: #a0aec0;">The Flock Team</p>
      </div>
    `,
  });
}

// The reset mail itself. Two things it deliberately does NOT say: it never
// names the account (no display name lookup beyond the one on the row, no "your
// Flock account for X"), and it never confirms anything to a person who did not
// ask, because the "if you did not ask for this" line has to be true for a
// mistyped address as well as a targeted one.
async function sendPasswordResetEmail({ to, name, link, minutes }) {
  if (!isMailableLink(link)) {
    console.error('[email] refusing to mail a reset link that is not a public https URL, to', maskAddress(to));
    return { sent: false, error: 'invalid link' };
  }
  const safeName = escapeHtml(name || 'there');
  const safeLink = escapeHtml(link);
  const safeMinutes = ttlNumber(minutes, 60);
  return sendEmail({
    to,
    subject: 'Reset your Flock password',
    text: [
      'Reset your password',
      '',
      `Hi ${name || 'there'}, someone asked to reset the password on the Flock account for this address. Set a new one here.`,
      '',
      link,
      '',
      `This link works once and expires in ${safeMinutes} minutes.`,
      '',
      'If you did not ask for this, you can ignore it. Your password has not changed, and nobody can change it without this link. Setting a new password signs the account out everywhere.',
      '',
      'The Flock Team',
    ].join('\n'),
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 24px;">
        <div style="text-align: center; margin-bottom: 32px;">
          <img src="${baseWebUrl()}/flock-logo.png" alt="Flock" width="64" height="64" style="border-radius: 16px;" />
        </div>
        <h1 style="font-size: 24px; font-weight: 700; color: #0d2847; margin-bottom: 16px;">Reset your password</h1>
        <p style="font-size: 16px; color: #4a5568; line-height: 1.6; margin-bottom: 24px;">
          Hi ${safeName}, someone asked to reset the password on the Flock account for this address. Set a new one here.
        </p>
        <p style="margin: 0 0 24px;">
          <a href="${safeLink}" style="display: inline-block; background: #0d2847; color: #ffffff; text-decoration: none; padding: 14px 28px; border-radius: 10px; font-size: 16px; font-weight: 600;">Set a new password</a>
        </p>
        <p style="font-size: 14px; color: #4a5568; line-height: 1.6; margin-bottom: 24px;">
          This link works once and expires in ${safeMinutes} minutes. If the button does nothing, paste this into your browser:<br />
          <span style="word-break: break-all; color: #2b6cb0;">${safeLink}</span>
        </p>
        <p style="font-size: 14px; color: #4a5568; line-height: 1.6; margin-bottom: 24px;">
          If you did not ask for this, you can ignore it. Your password has not changed, and nobody can change it without this link. Setting a new password signs the account out everywhere.
        </p>
        <p style="font-size: 14px; color: #a0aec0;">The Flock Team</p>
      </div>
    `,
  });
}

// The other half of the neutral answer. An account created with Google or Apple
// has no password, so there is nothing to reset. Silently creating one would be
// the worst possible outcome: it would add a second, weaker way into an account
// whose owner never asked for one and would never think to protect it. So the
// mailbox owner gets told which button to press instead. Naming the provider is
// safe here and nowhere else, because this only ever reaches the mailbox that
// owns the account.
async function sendPasswordResetOAuthEmail({ to, name, provider }) {
  const safeName = escapeHtml(name || 'there');
  const safeProvider = escapeHtml(provider === 'apple' ? 'Apple' : 'Google');
  return sendEmail({
    to,
    subject: 'About your Flock sign-in',
    text: [
      'There is no password to reset',
      '',
      `Hi ${name || 'there'}, someone asked to reset a Flock password for this address. This account signs in with ${provider === 'apple' ? 'Apple' : 'Google'}, so it has never had a password. Open Flock and tap Continue with ${provider === 'apple' ? 'Apple' : 'Google'}.`,
      '',
      baseWebUrl(),
      '',
      'Nothing about the account has changed. If this was not you, you can ignore it.',
      '',
      'The Flock Team',
    ].join('\n'),
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 24px;">
        <div style="text-align: center; margin-bottom: 32px;">
          <img src="${baseWebUrl()}/flock-logo.png" alt="Flock" width="64" height="64" style="border-radius: 16px;" />
        </div>
        <h1 style="font-size: 24px; font-weight: 700; color: #0d2847; margin-bottom: 16px;">There is no password to reset</h1>
        <p style="font-size: 16px; color: #4a5568; line-height: 1.6; margin-bottom: 24px;">
          Hi ${safeName}, someone asked to reset a Flock password for this address. This account signs in with ${safeProvider}, so it has never had a password. Open Flock and tap Continue with ${safeProvider}.
        </p>
        <p style="margin: 0 0 24px;">
          <a href="${baseWebUrl()}" style="display: inline-block; background: #0d2847; color: #ffffff; text-decoration: none; padding: 14px 28px; border-radius: 10px; font-size: 16px; font-weight: 600;">Open Flock</a>
        </p>
        <p style="font-size: 14px; color: #4a5568; line-height: 1.6; margin-bottom: 24px;">
          Nothing about the account has changed. If this was not you, you can ignore it.
        </p>
        <p style="font-size: 14px; color: #a0aec0;">The Flock Team</p>
      </div>
    `,
  });
}

// The waitlist confirmation. routes/waitlist.js was the last caller still
// holding its own Resend client, its own null-key skip and its own copy of the
// abort signal — the exact trio this module was extracted to own (see the
// header). Moving the send here hands the route the rest of the hardening it
// lacked: the settle contract, the pinned www logo host, and the recipient
// gate. The body deliberately renders NO user-supplied value — the address
// someone typed on the public marketing site is the recipient and nothing
// else, and sendEmail refuses any address that could carry markup before the
// provider is consulted (isMailableAddress excludes < > "). Copy is the
// route's own, unchanged: plain "The Flock Team" signoff, logo from the
// pinned www host via baseWebUrl().
//
// THE UNSUBSCRIBE, added after the round-26 audit. This message announces a
// future mailing ("We'll let you know as soon as it's ready") to a list of
// addresses collected on a public marketing page, and it carried no way off
// that list: no link in the body, no header a mail client could offer, and no
// column in the waitlist table that could have recorded a request to stop. It
// is the one message in the codebase that is plainly commercial rather than
// transactional, so it is the one that CAN-SPAM §7704(a)(3) is about.
//
// Same two-verb shape as the digest's opt-out and for the same reason: the
// href in the body opens a page with a button, and only a POST writes, so
// Defender Safe Links and Proofpoint cannot unsubscribe somebody by scanning
// their mail. The RFC 8058 header pair is what makes Gmail and Apple Mail show
// their own one-tap Unsubscribe next to the sender, which is both what the law
// wants and the strongest deliverability signal a small sending domain has.
function unsubscribeUrl(address) {
  const token = mintUnsubscribeToken(address);
  if (!token) return null;
  return `${baseApiUrl()}/api/unsubscribe?token=${encodeURIComponent(token)}`;
}

async function sendWaitlistConfirmation({ to }) {
  // Built from the recipient, which sendEmail is about to re-check; a missing
  // JWT_SECRET yields no link rather than a broken one, and the body then says
  // where else to write.
  const optOut = unsubscribeUrl(typeof to === 'string' ? to.trim() : '');
  const optOutHtml = optOut
    ? `<a href="${escapeHtml(optOut)}" style="color: #a0aec0;">Stop these emails</a>.`
    : 'Reply to this message and we will take you off the list.';
  const optOutText = optOut
    ? `Stop these emails: ${optOut}`
    : 'Reply to this message and we will take you off the list.';
  return sendEmail({
    to,
    category: 'marketing',
    subject: "You're on the Flock waitlist",
    ...(optOut ? {
      headers: {
        'List-Unsubscribe': `<${optOut}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    } : {}),
    text: [
      "You're on the list.",
      '',
      "Thanks for signing up for early access to Flock. We're building the app that replaces the broken group chat planning process with something that actually works.",
      '',
      "We'll let you know as soon as it's ready.",
      '',
      'The Flock Team',
      '',
      `You are getting this because this address was entered on the Flock waitlist at ${baseWebUrl()}.`,
      optOutText,
    ].join('\n'),
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 24px;">
        <div style="text-align: center; margin-bottom: 32px;">
          <img src="${baseWebUrl()}/flock-logo.png" alt="Flock" width="64" height="64" style="border-radius: 16px;" />
        </div>
        <h1 style="font-size: 24px; font-weight: 700; color: #0d2847; margin-bottom: 16px;">You're on the list.</h1>
        <p style="font-size: 16px; color: #4a5568; line-height: 1.6; margin-bottom: 24px;">
          Thanks for signing up for early access to Flock. We're building the app that replaces the broken group chat planning process with something that actually works.
        </p>
        <p style="font-size: 16px; color: #4a5568; line-height: 1.6; margin-bottom: 24px;">
          We'll let you know as soon as it's ready.
        </p>
        <p style="font-size: 14px; color: #a0aec0;">The Flock Team</p>
        <p style="font-size: 13px; color: #a0aec0; margin-top: 32px; line-height: 1.6;">
          You are getting this because this address was entered on the Flock waitlist. ${optOutHtml}
        </p>
      </div>
    `,
  });
}

// The other half of the waitlist promise. sendWaitlistConfirmation tells a
// person they are ON the list; this one tells them they are OFF it because the
// app is out. Sent only by the admin announce route (routes/admin.js), once
// per address, recorded in waitlist.announced_at. Same marketing category and
// the same one-click unsubscribe as the confirmation, because it is the same
// consent. APP_STORE_URL points the button at the store once the app is live;
// until that env var exists the button goes to signup on the web app, which
// is real today.
async function sendWaitlistLaunchEmail({ to }) {
  const getUrl = process.env.APP_STORE_URL || `${baseWebUrl()}/signup`;
  const optOut = unsubscribeUrl(typeof to === 'string' ? to.trim() : '');
  const optOutHtml = optOut
    ? `<a href="${escapeHtml(optOut)}" style="color: #a0aec0;">Stop these emails</a>.`
    : 'Reply to this message and we will take you off the list.';
  const optOutText = optOut
    ? `Stop these emails: ${optOut}`
    : 'Reply to this message and we will take you off the list.';
  return sendEmail({
    to,
    category: 'marketing',
    subject: "You're off the waitlist. Flock is out.",
    ...(optOut ? {
      headers: {
        'List-Unsubscribe': `<${optOut}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    } : {}),
    text: [
      "You're off the waitlist.",
      '',
      'Flock is out. You signed up early, so you are first in line: create your account with this email address and your spot counts from the day you joined the list.',
      '',
      `Get Flock: ${getUrl}`,
      '',
      'The Flock Team',
      '',
      `You are getting this because this address joined the Flock waitlist at ${baseWebUrl()}.`,
      optOutText,
    ].join('\n'),
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 24px;">
        <div style="text-align: center; margin-bottom: 32px;">
          <img src="${baseWebUrl()}/flock-logo.png" alt="Flock" width="64" height="64" style="border-radius: 16px;" />
        </div>
        <h1 style="font-size: 24px; font-weight: 700; color: #0d2847; margin-bottom: 16px;">You're off the waitlist.</h1>
        <p style="font-size: 16px; color: #4a5568; line-height: 1.6; margin-bottom: 24px;">
          Flock is out. You signed up early, so you are first in line: create your account with this email address and your spot counts from the day you joined the list.
        </p>
        <div style="text-align: center; margin-bottom: 32px;">
          <a href="${escapeHtml(getUrl)}" style="display: inline-block; background: #0d2847; color: #ffffff; text-decoration: none; font-weight: 600; font-size: 16px; padding: 14px 28px; border-radius: 12px;">Get Flock</a>
        </div>
        <p style="font-size: 14px; color: #718096; line-height: 1.6;">The Flock Team</p>
        <p style="font-size: 12px; color: #a0aec0; line-height: 1.6; margin-top: 32px;">
          You are getting this because this address joined the Flock waitlist at ${baseWebUrl()}. ${optOutHtml}
        </p>
      </div>
    `,
  });
}

module.exports = {
  sendEmail,
  sendVerificationEmail,
  sendPasswordResetEmail,
  sendPasswordResetOAuthEmail,
  sendWaitlistConfirmation,
  sendWaitlistLaunchEmail,
  verificationLink,
  passwordResetLink,
  baseWebUrl,
  baseApiUrl,
  isUnmailableBase,
  resetClient,
  PROD_WEB_URL,
  PROD_API_URL,
  // The shared vocabulary every sender needs. routes/safety.js and
  // services/moderationAlerts.js import these instead of keeping their own; see
  // the note on isMailableAddress for what the three private copies cost.
  // routes/auth.js still has its own isMailableAddress and should move to this
  // one — it is owned by another agent this round.
  isMailableAddress,
  MAILABLE_RE,
  safeSubjectLine,
  safeHeaders,
  safeTextBody,
  maskAddress,
  unsubscribeUrl,
  PER_RECIPIENT_DAILY_CAP,
  resetRecipientBudget,
  escapeHtml,
  deriveTextFromHtml,
  DEFAULT_REPLY_TO,
  // The alarm and what it counts. emailHealthStatus() is what an ops surface
  // reads to answer "is email working"; nothing in the app calls it yet, and
  // the handoff for the admin cost panel says where it goes.
  emailHealthStatus,
  resetEmailHealth,
  CONSECUTIVE_FAILURES_BEFORE_ALARM,
  // Exported for the same reason resetEmailHealth is: the dedupe map's growth
  // bound is a property of THIS function, and a test that reimplemented the
  // keying would be measuring a different map from the one the alarm uses. It
  // is not called from anywhere in the app; every alarm is raised inside
  // sendEmail.
  raiseEmailAlarm,
};
