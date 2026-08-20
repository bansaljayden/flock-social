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
const PROD_API_URL = 'https://flock-app-production.up.railway.app';

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

async function sendEmail({ to, subject, html, from = 'Flock <hello@flockcorp.com>', headers }) {
  if (!isMailableAddress(to)) {
    console.error('[email] refusing a recipient that is not one deliverable address:', maskAddress(to));
    return { sent: false, error: 'invalid recipient' };
  }
  const recipient = to.trim();
  const safeSubject = safeSubjectLine(subject);
  // `to` and `subject` are settled above; `from` is the third header and was
  // the only one still passed through untouched. It is a constant at both call
  // sites today, which is the argument for closing it now rather than after a
  // fourth caller builds one out of something it read.
  const safeFrom = String(from == null ? '' : from).replace(/[\r\n]+/g, ' ').trim();
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
    return { sent: false, error: err.message };
  }
  if (!resend) {
    console.warn('[email] RESEND_API_KEY not set, skipping email to', shown);
    return { sent: false, skipped: true };
  }
  try {
    const { data, error } = await resend.emails.send(
      {
        from: safeFrom,
        to: recipient,
        subject: safeSubject,
        html,
        ...(extraHeaders ? { headers: extraHeaders } : {}),
      },
      { signal: upstreamSignal('email') }
    );
    if (error) {
      console.error('[email] Resend error for', shown, JSON.stringify(error));
      return { sent: false, error: error.message || 'send failed' };
    }
    console.log('[email] sent to', shown, 'id:', data?.id);
    return { sent: true, id: data?.id };
  } catch (err) {
    console.error('[email] send failed for', shown, err.message);
    return { sent: false, error: err.message };
  }
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
async function sendWaitlistConfirmation({ to }) {
  return sendEmail({
    to,
    subject: "You're on the Flock waitlist",
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
  maskAddress,
  escapeHtml,
};
