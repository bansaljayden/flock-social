const express = require('express');
const router = express.Router();
// ---------------------------------------------------------------------------
// WHY THE SOS ROUTES DO NOT USE THE ORDINARY `authenticate` (round 23).
// ---------------------------------------------------------------------------
// `authenticate` answers 403 "This account has been suspended for violating our
// community guidelines." for any row with is_banned. Mounted on POST /alert,
// that sentence is what a suspended sixteen-year-old gets back from the button
// they pressed because something was wrong. A ban is a judgement about how
// somebody behaved in a group chat. It is not a finding that their night is
// safe, and it is not a reason to refuse to email the parent they nominated.
//
// This is the same argument, and the same middleware, that DELETE
// /api/users/me already uses: there are actions an account keeps after a ban
// because refusing them causes harm out of all proportion to the offence.
// Erasing yourself is one. Telling the people you nominated that you need help
// is the other.
//
// THE BOUNDARY IS THE SAME SHAPE AS THE EMERGENCY MAIL CATEGORY BELOW: as
// narrow as it can be. Only the two routes that stand an alert up and stand it
// down are exempt, plus the read that tells the screen who is on the list.
// Adding a trusted contact, editing one, and /share-location all keep the
// ordinary gate, because those are the surfaces that turn an account into a
// mail relay aimed at a new address, and a banned account has no business
// reaching a new address.
//
// WHAT THIS DOES NOT FIX, STATED PLAINLY. App.js signs a banned user out at
// boot: GET /api/auth/me answers 403 and the app shows "This account is
// suspended". So a banned account cannot reach the SOS button today no matter
// what this file allows, and this change is the half that lives here rather
// than a user-visible fix on its own. The other half is a product decision
// recorded in the handoff, not something this route can make.
const { authenticate, authenticateAllowBanned } = require('../middleware/auth');
const pool = require('../config/database');
const { stripHtml } = require('../utils/sanitize');
// Round 20: this file used to build its own Resend client, at REQUIRE time:
//
//     const resend = process.env.RESEND_API_KEY ? new Resend(...) : null;
//
// and then guard each send with `if (!process.env.RESEND_API_KEY)`. The two
// read the key at different MOMENTS. Any process that loaded this router before
// the key reached the environment — a require-order change, a key rotation, a
// test — held `resend === null` for its whole life, sailed past the guard, and
// dereferenced null on every send. That failure is caught and reported as "this
// contact could not be reached", for every contact, forever, on the SOS route.
//
// services/emailService.js exists for exactly this ("the client is built
// lazily, not at require time, so a module loaded before dotenv (or in a test)
// does not permanently capture a missing key") and its header names this file
// as one of the two callers that should stop hand-rolling it. That migration is
// now done, and it brings three more things with it: one definition of what a
// deliverable address is, CR/LF stripping on the subject, and masked recipients
// in the log.
const emailService = require('../services/emailService');
const { escapeHtml, isMailableAddress, maskAddress } = emailService;
const { suppressionReason, EMERGENCY_CATEGORY } = require('../services/emailSuppression');
// The one push this file sends. See alertFlockMembers: pushAlways rather than
// pushIfOffline, because being in the app is not a reason to stay quiet about
// somebody pressing SOS on the plan you are both on.
const { pushAlways } = require('../services/pushHelper');

// Names are capped shorter than a whole subject line because a subject reads
// "🚨 Emergency Alert from {name}" and the words that matter are at the front.
function safeSubjectText(str) {
  return String(str == null ? '' : str).replace(/[\r\n]+/g, ' ').trim().slice(0, 120);
}

// Every send on this route goes through the shared sender, which owns the lazy
// client, the 8s deadline (round 12: an undeadlined send held an EMERGENCY
// alert open for minutes with nothing sent), the recipient check and the log
// masking. The only thing kept here is the from-address: an SOS does not come
// from the marketing mailbox.
const SAFETY_FROM = 'Flock Safety <alerts@flockcorp.com>';

// `category` is the do-not-mail list's question, and only ONE caller in this
// file answers it 'emergency': POST /alert. The whole argument is written at
// EMERGENCY_CATEGORY in services/emailSuppression.js. The short version is that
// a trusted contact whose address once hard-bounced, or who once hit "spam" on
// a Monday venue digest, was having their SOS alert dropped by a list that
// exists to stop marketing. A bounce is a fact about a mailbox and a complaint
// is a refusal of the thing complained about; neither is a refusal of an
// emergency from the person who named that contact.
//
// The test email and the share-my-location email deliberately do NOT get this.
// Neither is an emergency, and on both of them a suppression is doing exactly
// the job it was built for.
async function sendAlertEmail(to, subject, htmlBody, { category = 'transactional' } = {}) {
  const result = await emailService.sendEmail({
    to, subject, html: htmlBody, from: SAFETY_FROM, category,
  });
  if (result.skipped) {
    console.warn('[Safety] alert NOT sent to', maskAddress(to), ': RESEND_API_KEY is not set');
  } else if (!result.sent) {
    console.error('[Safety] alert NOT sent to', maskAddress(to), ':', result.error);
  }
  return result;
}

// ── Test email endpoint ──
// Round 8: account emails are unverified, so without a throttle this was a
// relay for Flock-branded mail to any address an attacker set on their own
// account. 1 test per 10 minutes, 3 per day, per user.
const testEmailLog = new Map(); // userId -> { lastAt, dayCount, dayResetAt }
router.get('/test-email', authenticate, async (req, res) => {
  if (!process.env.RESEND_API_KEY) {
    return res.json({ ok: false, error: 'RESEND_API_KEY not set' });
  }
  try {
    const now = Date.now();
    if (testEmailLog.size > 5000) {
      for (const [k, v] of testEmailLog) { if (now > v.dayResetAt) testEmailLog.delete(k); }
    }
    // Round 20: the allowance used to be charged HERE, before the route looked
    // at whether there was anywhere to send to. An account with no mailable
    // address (an Apple private-relay signup, before the user adds a real one)
    // spent its whole day's budget on three refusals, and the button whose only
    // job is to answer "are my emergency alerts set up" stopped answering for
    // 24 hours. Nothing is spent by asking a question whose answer cannot
    // change inside the window, and no mail leaves on that path either way, so
    // the lookup moves in front of the meter.
    const user = await pool.query('SELECT name, email FROM users WHERE id = $1', [req.user.id]);
    // The `.invalid` check here was the first half of the rule that the trusted
    // contact form was missing entirely. Both now ask the shared question, so
    // the two cannot drift again.
    if (!isMailableAddress(user.rows[0]?.email)) {
      return res.json({ ok: false, error: 'No email address on file' });
    }

    let entry = testEmailLog.get(req.user.id);
    if (!entry || now > entry.dayResetAt) {
      entry = { lastAt: 0, dayCount: 0, dayResetAt: now + 24 * 60 * 60 * 1000 };
      testEmailLog.set(req.user.id, entry);
    }
    if (now - entry.lastAt < 10 * 60 * 1000 || entry.dayCount >= 3) {
      return res.status(429).json({ ok: false, error: 'Test email already sent. Try again later.' });
    }
    entry.lastAt = now;
    entry.dayCount += 1;

    const result = await sendAlertEmail(
      user.rows[0].email,
      'Flock Safety: test email',
      '<div style="font-family:Arial,sans-serif;padding:20px;text-align:center"><h2>It works!</h2><p>Your Flock emergency alerts are set up correctly.</p></div>'
    );
    res.json({ ok: result.sent || false, error: result.error });
  } catch (err) {
    console.error('[Safety] Error:', err.message);
    res.json({ ok: false, error: 'Failed to process request' });
  }
});

// ---------------------------------------------------------------------------
// Coordinates arrive on the two email-sending routes as raw request-body JSON
// and were never validated. Round 15 fixes two separate problems with that.
//
// 1. AVAILABILITY OF THE EMERGENCY PATH. Both routes call `latitude.toFixed(6)`
//    while building the email. `toFixed` exists on numbers and nothing else, so
//    a client sending coordinates as JSON strings ("40.712") or as an array
//    threw a TypeError. On /alert that throw happens AFTER the alert row is
//    committed, so the outer catch answered `500 Failed to send alert` having
//    sent NOTHING to ANY trusted contact, and the claimed row then blocked the
//    retry for a further 60 seconds. A type mismatch must degrade an SOS to
//    "sent without a location", never to "not sent".
//
// 2. CONSENT. /alert wrote `latitude || null` into emergency_alerts regardless
//    of includeLocation, so a user who declined to attach their location still
//    had their precise position persisted. Only consented coordinates are
//    stored now.
//
// Returns a finite {lat, lng} in range, or null.
// ---------------------------------------------------------------------------
function readCoords(latitude, longitude) {
  const lat = typeof latitude === 'number' ? latitude
    : (typeof latitude === 'string' && latitude.trim() !== '' ? Number(latitude) : NaN);
  const lng = typeof longitude === 'number' ? longitude
    : (typeof longitude === 'string' && longitude.trim() !== '' ? Number(longitude) : NaN);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

// ---------------------------------------------------------------------------
// HOW SURE ARE WE (round 23). The alert email printed six decimal places of
// latitude and a button reading "View Location on Map", and it printed exactly
// that whether the fix came from GPS on a street corner or from a cell tower
// through two floors of concrete. Six decimal places is eleven centimetres.
// The second fix is routinely wrong by two kilometres, and App.js asks for it
// with `maximumAge: 60000`, so it can also be a minute old.
//
// A parent driving to a pin that is two kilometres from their child is worse
// off than a parent told "somewhere around here, we are not sure", because the
// first one stops looking when they arrive. The browser already hands us the
// number that settles it — `position.coords.accuracy`, a radius in metres at
// 95% confidence — and nothing was doing anything with it.
//
// OPTIONAL, AND SILENT WHEN ABSENT. A client that does not send it produces
// exactly the email it produces today. Nothing here may turn a missing field
// into a refused alert; see the three things this route is not allowed to do.
const COARSE_FIX_METRES = 1000;

function readAccuracy(value) {
  const n = typeof value === 'number' ? value
    : (typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN);
  // Zero and negatives are not radii, and anything past 100 km is a broken
  // sensor rather than a wide fix. Both read as "we were not told".
  if (!Number.isFinite(n) || n <= 0 || n > 100000) return null;
  return n;
}

// Metres, in the words a person driving somewhere would use. Never more
// precise than the number deserves: 1,847 m is "about 2 km", because writing
// it out to the metre is the same false confidence as the six decimal places.
function accuracyPhrase(metres) {
  if (metres >= 1000) {
    const km = metres / 1000;
    return `about ${km >= 10 ? Math.round(km) : Math.round(km * 10) / 10} km`;
  }
  if (metres >= 100) return `about ${Math.round(metres / 100) * 100} m`;
  return `about ${Math.max(5, Math.round(metres / 5) * 5)} m`;
}

// ── Get user's trusted contacts ──
//
// Each contact carries `email_deliverable`. It is false when the address is on
// the do-not-mail list, which since the emergency bypass above no longer stops
// an SOS — and that is exactly why this field has to exist. The bypass means
// nothing on our side blocks the send any more, so the only remaining signal
// that a contact is unreachable is the provider's, and the only person who can
// act on it is the one who typed the address. Silence here would be the same
// failure in a different place.
//
// A BOOLEAN, NEVER THE REASON. 'bounce' and 'complaint' both render as false
// and the copy on the screen says the same thing for both, because the reason
// is a fact about the contact, not about the account holder: telling a
// 15-year-old that their mother marked Flock as spam discloses something the
// mother told us and not them. What the user needs is "this address is not
// working, fix it", which the boolean carries in full.
//
// The lookups are per contact and there are at most MAX_TRUSTED_CONTACTS of
// them, each answered from the module's five-minute cache after the first.
// suppressionReason never throws and answers null on a database error, so a
// blip renders every contact as fine rather than failing the screen — the same
// fail-open direction the send path takes, for the same reason.
router.get('/contacts', authenticateAllowBanned, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM trusted_contacts WHERE user_id = $1 ORDER BY created_at DESC',
      [req.user.id]
    );
    const contacts = await Promise.all(result.rows.map(async (c) => ({
      ...c,
      email_deliverable: isMailableAddress(c.contact_email)
        ? !(await suppressionReason(c.contact_email))
        : false,
    })));
    res.json({ contacts });
  } catch (err) {
    console.error('[Safety] Get contacts error:', err);
    res.status(500).json({ error: 'Failed to load contacts' });
  }
});

// ── Add trusted contact ──
// Trusted contacts are an EMAIL-SENDING surface, so they're bounded (round 5:
// unbounded contacts + no cooldown made /share-location a harassment relay).
const MAX_TRUSTED_CONTACTS = 5;
// Round 20: this was a private `/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/`, whose class
// excluded whitespace and `@` and nothing else. Three things it accepted, all
// on the field that is handed to the provider as `to` on the emergency path:
//
//   mum@example.invalid   RFC 2606 reserved, can NEVER be delivered to — and it
//                         is the exact domain this codebase mints for Apple
//                         private-relay placeholders (@apple-signin.invalid)
//                         and evicted squats (@unclaimed.invalid), so a user
//                         pasting their own Apple address hit it
//   a@b.co,x.co           one contact row, two recipients
//   Mum<a@b.co>           an RFC 5322 display name the user chose, rendered by
//                         the mail client INSTEAD of the address it goes to
//
// services/moderationAlerts.js already refused all three for the operator-
// facing list. The user-facing one, on the route where being unreachable
// matters most, did not. Both now ask the same shared question.
const EMAIL_RE = emailService.MAILABLE_RE;

// Round 17. Three separate problems on this form, all of which surfaced as
// "Failed to add contact" on a safety screen:
//
// 1. EMAIL WAS OPTIONAL SERVER-SIDE. Email is the ONLY delivery channel an
//    alert has — nothing in this file sends SMS — so a contact without one is
//    a contact who will never be told anything. App.js already refuses to save
//    without an email, and per CLAUDE.md rule 7 a frontend gate that isn't
//    enforced here is not a gate. A user who saved contacts through an older
//    build, or any non-browser client, ends up with a Safety screen listing
//    five people and an SOS that reaches nobody.
// 2. NO LENGTH LIMITS. The columns are VARCHAR(100)/(20)/(255)/(50); a phone
//    number longer than 20 characters (a pasted "+1 (555) 010-0000 ext. 4021")
//    reached Postgres as a 22001 and came back a 500.
// 3. NO SANITIZATION. contact_name is echoed back in the /alert response.
//
// Existing rows without an email are NOT deleted — they are reported honestly
// by /alert instead (see the unreachable-contacts branch there).
// contact_email is VARCHAR(255); the limit here is 254 because that is RFC
// 5321's maximum path length and therefore what isMailableAddress enforces. The
// two have to agree, or a 255-character address gets "does not look right"
// instead of the message that names the actual problem.
const FIELD_LIMITS = { name: 100, phone: 20, email: 254, relationship: 50 };

// ---------------------------------------------------------------------------
// THE PHONE FIELD (round 22).
// ---------------------------------------------------------------------------
// Round 17 gave this field a length and round 20 rewrote the email rules onto
// the shared deliverability question, and in between the phone stayed the one
// field on the form checked for nothing but how long it was. It accepted
// `<script>alert(1)</script>`, an email address, and the word "later".
//
// Nothing here dials it, and PrivacyPolicy.js says so to users in so many words
// ("we store the phone number because the form asks for it and you may want it
// on file, but nothing in Flock texts or calls it"). So this is NOT a
// dialability test and it must not pretend to be one — a rule that guessed at
// national formats would start refusing real numbers, and refusing a real
// number on the emergency contact form is a worse failure than storing an odd
// one. It is also why rows saved before this rule existed are left alone rather
// than swept: the same treatment the email rule gave them (see the
// unreachable-contacts branch on /alert). Editing one of those rows does have
// to fix the phone, and the message says which character is the problem.
//
// Two things make it worth checking anyway:
//
//   * contact_phone is the ON CONFLICT key. UNIQUE(user_id, contact_phone)
//     decides whether saving Mum a second time updates her row or spends
//     another of the five slots, so a field that accepts free text quietly
//     turns the five-contact list into four copies of one person.
//   * it is rendered on the Safety screen next to people the user is trusting
//     with an emergency.
//
// The rule is therefore the weakest one that is still true of every phone
// number and false of everything that is not one: the characters people
// actually write numbers with, and enough digits to be one. Four is under any
// real number including short codes, and under every fixture in the suite.
//
// A literal space rather than \s, which also matches a newline and a tab. The
// value is trimmed but not otherwise normalised before it is stored and
// rendered, so there is no reason to accept a control character in the middle
// of it.
const PHONE_SHAPE_RE = /^\+?[\d ().-]+$/;
const MIN_PHONE_DIGITS = 4;

function phoneError(phone) {
  if (!PHONE_SHAPE_RE.test(phone)) {
    return 'A phone number can only contain digits, spaces, and + - ( ) .';
  }
  if ((phone.match(/\d/g) || []).length < MIN_PHONE_DIGITS) {
    return 'That phone number does not look right';
  }
  return null;
}

function readContactFields(body) {
  const name = typeof body.name === 'string' ? stripHtml(body.name).trim() : '';
  const phone = typeof body.phone === 'string' ? body.phone.trim() : '';
  const email = typeof body.email === 'string' ? body.email.trim() : '';
  const relationship = typeof body.relationship === 'string' ? stripHtml(body.relationship).trim() : '';

  if (!name || !phone) return { error: 'Name and phone are required' };
  if (!email) return { error: 'An email address is required. Alerts are sent by email.' };
  // Length before shape, so an over-long address gets the message that names
  // the actual problem instead of "does not look right".
  if (email.length > FIELD_LIMITS.email) return { error: 'That email address is too long' };
  if (!isMailableAddress(email)) return { error: 'That email address does not look right. It has to be one address that can receive mail.' };
  if (name.length > FIELD_LIMITS.name) return { error: `Name must be ${FIELD_LIMITS.name} characters or fewer` };
  if (phone.length > FIELD_LIMITS.phone) return { error: `Phone number must be ${FIELD_LIMITS.phone} characters or fewer` };
  // After the length, for the same reason the email shape check is after its
  // length: a pasted "+1 (555) 010-0000 ext. 4021" fails both, and the message
  // that names the actual problem is the one about the length.
  const phoneProblem = phoneError(phone);
  if (phoneProblem) return { error: phoneProblem };
  if (relationship.length > FIELD_LIMITS.relationship) return { error: `Relationship must be ${FIELD_LIMITS.relationship} characters or fewer` };

  return { name, phone, email, relationship: relationship || null };
}

// ---------------------------------------------------------------------------
// THE CONTACT FORM IS THE MAIL RELAY, NOT THE ALERT (round 20).
// ---------------------------------------------------------------------------
// A trusted contact is an address the user types, and nothing verifies it —
// nobody asks Mum whether she agreed to this. /alert is well bounded per USER
// (MAX_ATTEMPTS_PER_WINDOW attempts per 15 minutes) but says nothing at all
// about which ADDRESSES those attempts reach, and the contact form had no
// throttle of any kind. Five slots rewritten between alerts turned a bounded
// six-attempts-per-quarter-hour into roughly 120 Flock-branded emails an hour
// aimed at 120 DIFFERENT strangers, each with a subject line ending in a
// display name the sender chose.
//
// The lever is deliberately here and not on /alert. Throttling the alert would
// mean delaying an SOS in order to slow down a spammer, and that is not a trade
// this file is allowed to make. Changing who your emergency contacts are is not
// something anyone does thirty times an hour; sending an SOS might be.
//
// DELETE is deliberately NOT counted. Removing a recipient cannot send mail to
// anybody, and taking someone off your emergency contact list is not an action
// to put a speed limit on.
//
// Per process, like shareCooldowns and checkin.js's tapCache. On a multi-
// instance deployment the effective ceiling is this number times the instance
// count, which still bounds the relay; the DB-backed limit that would not have
// that property belongs on the same table as the /alert cooldown and is noted
// as a follow-up rather than built here.
const MAX_CONTACT_WRITES_PER_HOUR = 20;
const CONTACT_WRITE_WINDOW_MS = 60 * 60 * 1000;
const CONTACT_WRITE_MAX_KEYS = 5000;
const contactWrites = new Map(); // userId -> { count, resetAt }

function windowFor(userId, now) {
  if (contactWrites.size > CONTACT_WRITE_MAX_KEYS) {
    for (const [k, v] of contactWrites) if (now >= v.resetAt) contactWrites.delete(k);
    while (contactWrites.size > CONTACT_WRITE_MAX_KEYS) {
      contactWrites.delete(contactWrites.keys().next().value);
    }
  }
  let entry = contactWrites.get(userId);
  if (!entry || now >= entry.resetAt) {
    entry = { count: 0, resetAt: now + CONTACT_WRITE_WINDOW_MS };
    contactWrites.set(userId, entry);
  }
  return entry;
}

function allowContactWrite(userId, now = Date.now()) {
  return windowFor(userId, now).count < MAX_CONTACT_WRITES_PER_HOUR;
}

// CHARGED WHERE THE WRITE LANDS, not where the request arrives.
//
// The first version of this charged up front, on the theory that a limiter
// counting only successes can be walked past. That does not survive contact
// with what the limiter is for: reaching a NEW address requires a write that
// actually STORES one. A request refused for a bad address, or a PUT against
// somebody else's contact, stores nothing, mails nothing and does not even open
// a database connection, so charging it buys no safety.
//
// What it did buy was the wrong person paying. Somebody adding five contacts on
// a phone keyboard and mistyping a few addresses could spend the hour's budget
// without saving a single contact, and then be locked out of their own Safety
// screen. That is the worst trade available here: this throttle exists to
// protect strangers from a spammer, and it was charging the person setting up
// their emergency contacts.
//
// Check-then-charge is not atomic, so two simultaneous writes can both see the
// last slot. Being one over on a spam ceiling is not worth an advisory lock;
// the five-contact cap, where an off-by-one is a real bypass, keeps its.
function chargeContactWrite(userId) {
  windowFor(userId, Date.now()).count += 1;
}

function refuseContactWriteBurst(req, res) {
  if (allowContactWrite(req.user.id)) return false;
  res.status(429).json({
    error: 'You have changed your trusted contacts a lot in the last hour. Give it a while before changing them again.',
  });
  return true;
}

router.post('/contacts', authenticate, async (req, res) => {
  try {
    if (refuseContactWriteBurst(req, res)) return;
    const fields = readContactFields(req.body);
    if (fields.error) return res.status(400).json({ error: fields.error });
    const { name, phone, email, relationship } = fields;

    // Round 9: the cap was a standalone COUNT followed by a separate INSERT, so
    // N concurrent adds all read the same stale count and every one of them
    // landed — the five-contact ceiling on this email-sending surface was
    // trivially bypassable. Count and insert now run in ONE transaction under a
    // per-user advisory lock, so concurrent adds serialize behind each other.
    const client = await pool.connect();
    let contact;
    try {
      await client.query('BEGIN');
      await client.query("SELECT pg_advisory_xact_lock(hashtext('safety:' || $1::text))", [String(req.user.id)]);

      // Round 22: the cap counted every row, including the one this request is
      // about to UPDATE rather than insert. The INSERT below carries
      // `ON CONFLICT (user_id, contact_phone) DO UPDATE`, so re-saving a number
      // already on the list has never added a contact — but at five contacts
      // the count refused it first, with "You can have up to 5 trusted
      // contacts". The person that stops is the one at the cap fixing an
      // address on a contact who cannot currently be reached, which is the
      // exact repair the unreachable-contacts branch on /alert tells them to go
      // and make. Counting the rows this write will NOT touch asks the question
      // the cap is actually for: will this add a sixth person.
      const count = await client.query(
        'SELECT COUNT(*)::int AS n FROM trusted_contacts WHERE user_id = $1 AND contact_phone IS DISTINCT FROM $2',
        [req.user.id, phone]
      );
      if (count.rows[0].n >= MAX_TRUSTED_CONTACTS) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `You can have up to ${MAX_TRUSTED_CONTACTS} trusted contacts` });
      }

      // The conflict branch is the ordinary re-save of a contact you already
      // have (UNIQUE(user_id, contact_phone)), and it used to change the address
      // without touching email_set_at. That left this door open to the exact
      // thing migration 052 was written to close: add a contact, raise a real
      // SOS so that address gets the alarm, then re-save the same phone with a
      // different email. The stand-down audience is `COALESCE(email_set_at,
      // created_at) <= alert time`, so the new address passed as if it had
      // received the alarm, and the all-clear went out to it under
      // EMERGENCY_CATEGORY, which is the one category that bypasses the
      // do-not-mail list on the strength of an argument that is only true of
      // the address that actually got the alarm. PUT /contacts/:id had the
      // fix; this statement did not. Same CASE, same IS DISTINCT FROM, so a
      // name or relationship edit still does not reset the clock.
      const result = await client.query(
        `INSERT INTO trusted_contacts (user_id, contact_name, contact_phone, contact_email, relationship)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id, contact_phone) DO UPDATE
           SET contact_name = EXCLUDED.contact_name,
               contact_email = EXCLUDED.contact_email,
               relationship = EXCLUDED.relationship,
               email_set_at = CASE WHEN trusted_contacts.contact_email IS DISTINCT FROM EXCLUDED.contact_email THEN NOW()
                                   ELSE COALESCE(trusted_contacts.email_set_at, trusted_contacts.created_at) END
         RETURNING *`,
        [req.user.id, name, phone, email, relationship]
      );
      contact = result.rows[0];

      await client.query('COMMIT');
    } catch (txErr) {
      await client.query('ROLLBACK').catch(() => {});
      throw txErr;
    } finally {
      client.release();
    }

    // Reached only when the INSERT committed. The five-contact refusal above
    // returns from inside the transaction, so it never gets here: nothing was
    // stored, so nothing is charged. An address in the table is the only state
    // that can turn into mail to a stranger, and this is where it is spent.
    chargeContactWrite(req.user.id);
    res.status(201).json({ contact });
  } catch (err) {
    console.error('[Safety] Add contact error:', err);
    res.status(500).json({ error: 'Failed to add contact' });
  }
});

// ── Update trusted contact ──
// trusted_contacts.id is an integer key. A non-numeric :id reached Postgres and
// came back as a 500; these are 404s, and a 500 on a safety screen reads to the
// user as "the app is broken" rather than "that contact is gone".
const contactId = (raw) => (/^\d+$/.test(String(raw)) ? parseInt(raw, 10) : null);

router.put('/contacts/:id', authenticate, async (req, res) => {
  try {
    if (refuseContactWriteBurst(req, res)) return;
    const id = contactId(req.params.id);
    if (id === null) return res.status(404).json({ error: 'Contact not found' });
    const fields = readContactFields(req.body);
    if (fields.error) return res.status(400).json({ error: fields.error });
    const { name, phone, email, relationship } = fields;
    // email_set_at is WHEN THIS ADDRESS JOINED THE LIST, and it moves only when
    // the address does. POST /alert/cancel mails the all clear to the contacts
    // who were on the list when the alert went out, and it decided that from
    // created_at, which this statement does not move: add a contact, raise a
    // real SOS, edit the address, stand down, and the all clear went to an
    // address that never received the alarm, past the do-not-mail list, on the
    // strength of an argument (services/emailSuppression.js, EMERGENCY_CATEGORY)
    // that is only true of the address that got the alarm. Editing a name or a
    // relationship is not that, so IS DISTINCT FROM rather than a blanket NOW().
    // Migration 052 carries the whole reasoning.
    const result = await pool.query(
      `UPDATE trusted_contacts
          SET contact_name = $1, contact_phone = $2, contact_email = $3, relationship = $4,
              email_set_at = CASE WHEN contact_email IS DISTINCT FROM $3 THEN NOW()
                                  ELSE COALESCE(email_set_at, created_at) END
        WHERE id = $5 AND user_id = $6 RETURNING *`,
      [name, phone, email, relationship, id, req.user.id]
    );
    if (result.rowCount === 0) {
      // Nothing changed, so nothing new can be mailed: not charged.
      return res.status(404).json({ error: 'Contact not found' });
    }
    chargeContactWrite(req.user.id);
    res.json({ contact: result.rows[0] });
  } catch (err) {
    // Round 22. POST carries `ON CONFLICT (user_id, contact_phone) DO UPDATE`;
    // this route had no answer for the same UNIQUE at all. Editing one
    // contact's number to a number another of your contacts already has raised
    // 23505 and came back as `500 Failed to update contact` — a safety screen
    // telling somebody the app is broken when the real answer is one word of
    // theirs to fix. It is a conflict, it is theirs to resolve, and 409 is what
    // that is.
    if (err.code === '23505') {
      return res.status(409).json({
        error: 'One of your other trusted contacts already has that phone number.',
      });
    }
    console.error('[Safety] Update contact error:', err);
    res.status(500).json({ error: 'Failed to update contact' });
  }
});

// ── Delete trusted contact ──
router.delete('/contacts/:id', authenticate, async (req, res) => {
  try {
    const id = contactId(req.params.id);
    if (id === null) return res.status(404).json({ error: 'Contact not found' });
    const result = await pool.query(
      'DELETE FROM trusted_contacts WHERE id = $1 AND user_id = $2 RETURNING id',
      [id, req.user.id]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Contact not found' });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('[Safety] Delete contact error:', err);
    res.status(500).json({ error: 'Failed to delete contact' });
  }
});

// ── Send emergency alert ──
// Round 9: the cooldown was a SELECT, then every email, then the INSERT that
// armed it. Concurrent taps all read the same empty cooldown and each sent a
// full round of mail to every contact. The claim now happens FIRST, inside a
// transaction holding a per-user advisory lock, so the second request loses.
//
// Round 17 — THE COOLDOWN MUST NOT BE A LOCKOUT. A flat "1 alert per 5
// minutes" is a sensible anti-abuse rule and a terrible emergency rule. Three
// concrete ways it failed the person it exists for:
//
//   a) ESCALATION. You send an SOS from the bar, then you are moved. Two
//      minutes later you tap again to say where you are now, and the app
//      answers "Please wait 3 minutes". The most important alert of the night
//      is the one it refuses. A new alert that carries a MATERIALLY DIFFERENT
//      LOCATION is now allowed through after the 60-second floor, up to
//      MAX_ESCALATIONS times inside the window. That is the update a contact
//      actually needs, and it cannot be produced by mashing the button, since
//      an unchanged position is still refused.
//   b) TOTAL FAILURE. When every send failed we answered 502 "could not be
//      delivered" and then left the claim row blocking retries for another 60
//      seconds. We had already told the user it failed; refusing their retry
//      is indefensible. Nothing is in flight after a settled failure, so the
//      claim is released immediately (the row stays, as an audit record of an
//      attempt that reached nobody).
//   c) THE 429 COPY. "Please wait 4 minutes before sending another alert" does
//      not tell a frightened person whether their first alert went out. Every
//      refusal now states plainly that the earlier alert WAS delivered, to how
//      many people, and how long ago — and every failure path names 911.
const ALERT_COOLDOWN_MS = 5 * 60 * 1000;
const ALERT_FLOOR_MS = 60 * 1000;          // hard minimum between sends
const ESCALATION_WINDOW_MS = 15 * 60 * 1000;
const MAX_ESCALATIONS = 3;                 // delivered alerts per 15 min, ceiling
const MAX_ATTEMPTS_PER_WINDOW = 6;         // outer bound: any attempt, delivered or not
const ESCALATION_METERS = 250;             // "I have moved" threshold

// Round 18 — THE LOCATION FOLLOW-UP.
//
// The client no longer holds an SOS back for up to fifteen seconds waiting on a
// GPS fix. It sends the alert immediately, waits a few seconds for a fix, and
// posts the coordinates as a second alert. That second alert is the only one
// that tells a contact WHERE to go — and this route refused it, because a
// follow-up arriving seconds behind the first is inside ALERT_FLOOR_MS.
//
// The client's answer was to wait the floor out: App.js sits on the fix it
// already has for a full sixty-five seconds before posting it. So the location
// for an emergency alert reliably arrived over a minute after the alert, and
// the delay was the server's rule, not the satellite's.
//
// This is the one case the floor should not hold. The follow-up adds
// information to an alert that has ALREADY gone out, so it cannot reach anyone
// who was not about to be reached anyway, and the person it helps is by
// definition someone in trouble. With this in place App.js can post the fix the
// moment it has one; its own chase gives up at 45s, which fits inside the
// window below with room to spare.
//
// Not derived from ALERT_FLOOR_MS on purpose. Today it is the same sixty
// seconds, so the exemption covers the floor exactly and nothing beyond it —
// past the floor the ordinary escalation path already lets a first location
// through, because isEscalation counts "they had no location and now they do"
// as an escalation. There is therefore no gap at any point on the timeline.
// Deriving the window would mean a future change to the floor silently widened
// the exemption with it; this is its own policy and stays its own.
const LOCATION_FOLLOWUP_WINDOW_MS = 60 * 1000;

const CALL_911 = 'If you are in danger, call 911.';

// Metres between two coordinate pairs (haversine). Only ever compared against
// ESCALATION_METERS, so precision beyond a few metres is irrelevant.
function metresBetween(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

// True when this alert says something new about where the user is: they have
// moved far enough to matter, or the last alert went out with no location at
// all and this one has one.
function isEscalation(coords, previous) {
  if (!coords) return false;
  const hadLocation = previous.latitude != null && previous.longitude != null;
  if (!hadLocation) return true;
  return metresBetween(coords, { lat: Number(previous.latitude), lng: Number(previous.longitude) }) > ESCALATION_METERS;
}

// True when this request is a location-only follow-up to an alert that went out
// without one, and is therefore exempt from the send floor. Three bounds, all
// required:
//
//   1. It must ACTUALLY ADD A LOCATION. No coordinates, no exemption, so a bare
//      re-tap can never buy one.
//   2. The previous alert must GENUINELY HAVE HAD NO LOCATION. If it carried
//      coordinates, this is an ordinary update and the floor plus the 250 m
//      escalation rule apply as before.
//   3. It must be PROMPT. The client chases its fix for seconds, not minutes.
//
// ONCE. There is no counter for this because there does not need to be one:
// bound 2 is the counter. A granted follow-up writes its coordinates into the
// claim row inside the same advisory-locked transaction, BEFORE a single email
// leaves, so the next request through this function — concurrent or not — reads
// a most-recent alert that HAS a location and is refused. The allowance is spent
// atomically at claim time.
//
// The one way it is granted twice is a follow-up whose sends ALL failed: that
// row backdates itself out of the way like any other total failure, so the
// earlier no-location alert is once again the most recent. An attempt that
// reached nobody has not spent anything, and MAX_ATTEMPTS_PER_WINDOW is the
// ceiling on that loop, exactly as it is for a failing first alert.
// What an escalation is called in the email: a change of position when the
// previous alert carried one, the first position when it did not.
function escalationKind(previous) {
  const hadLocation = previous && previous.latitude != null && previous.longitude != null;
  return hadLocation ? 'moved' : 'location';
}

function isLocationFollowUp(coords, previous, ageMs) {
  if (!coords || !previous) return false;
  if (previous.latitude != null || previous.longitude != null) return false;
  return Number(ageMs) <= LOCATION_FOLLOWUP_WINDOW_MS;
}

// "Mum has" / "Mum and Dad have" / "Mum, Dad and 2 others have". Two names is
// the cap because this lands in a toast on a phone, and a list of five names
// the user typed themselves can be longer than the screen. Names are
// stripHtml'd on the way in and this string is rendered as text, never as
// markup.
function namePhrase(names) {
  const list = names.map((n) => String(n == null ? '' : n).trim()).filter(Boolean);
  if (list.length === 0) return 'They have';
  if (list.length === 1) return `${list[0]} has`;
  if (list.length === 2) return `${list[0]} and ${list[1]} have`;
  return `${list[0]}, ${list[1]} and ${list.length - 2} other${list.length - 2 === 1 ? '' : 's'} have`;
}

function agoPhrase(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${Math.max(1, s)} second${s === 1 ? '' : 's'} ago`;
  const m = Math.round(s / 60);
  return `${m} minute${m === 1 ? '' : 's'} ago`;
}

// ---------------------------------------------------------------------------
// THE THREE THINGS THIS ROUTE IS NOT ALLOWED TO DO (round 22, written down
// because each one has been quietly proposed at least once).
// ---------------------------------------------------------------------------
//
// 1. IT MUST NOT REFUSE A RETRY OF AN SOS THAT FAILED. The rule an emergency
//    limiter has to satisfy is not "be strict", it is "never be the reason an
//    alert did not go out", and a limiter that blocks the second attempt is
//    worse than no limiter at all. Walking the three retries somebody
//    frightened actually makes, against the numbers above:
//
//      first alert FAILED          allowed at once. The claim row backdates
//                                  itself past the floor the moment the sends
//                                  settle, so the retry the 502 tells them to
//                                  make is already open. This is the case a
//                                  naive cooldown gets wrong and it is the one
//                                  that matters most.
//      DELIVERED, and they have
//      moved 250 m or gained a
//      location they did not have  allowed after the 60s floor, up to
//                                  MAX_ESCALATIONS delivered alerts per 15 min.
//                                  That update is the thing a contact needs,
//                                  and it cannot be produced by mashing the
//                                  button, because an unchanged position is
//                                  still refused.
//      DELIVERED, nothing changed  refused — and the refusal says the earlier
//                                  alert WENT OUT, to how many people, how long
//                                  ago, and names 911. A duplicate of a
//                                  confirmed-delivered alert adds nothing to
//                                  what the contacts know; being told it was
//                                  delivered adds a great deal to what the
//                                  sender knows.
//
//    MAX_ATTEMPTS_PER_WINDOW is the only ceiling that can refuse an undelivered
//    attempt, and it exists solely to stop the total-failure loop a provider
//    outage produces (every retry allowed, every retry fanning out to every
//    contact, forever). Six in fifteen minutes is well past any real sequence
//    of taps, and it is checked LAST so every more specific and more useful
//    refusal answers first.
//
// 2. IT MUST NOT ASK A QUESTION IT CAN BE REFUSED AN ANSWER TO. There is no
//    block lookup on this route and there must not be one. A trusted contact is
//    an address somebody typed, not a Flock account, so there is no
//    relationship to consult — and if there were, a lookup that ERRORED would
//    have to answer "send anyway", because an SOS that does not go out because
//    a block table was slow is the worst outcome available here. The same rule
//    governs everything else the route reads around the message: unreadable
//    coordinates degrade the alert to one without a location, an unknown
//    timezone falls back to a labelled UTC, and a missing display name falls
//    back to "A Flock user". None of them may cost a delivery. The only two
//    refusals before a send are "you have no contacts" and "none of them can
//    receive mail", and both are conditions no retry could fix.
//
// 3. IT MUST NOT LET ONE RECIPIENT TAKE DOWN ANOTHER. There is exactly one
//    delivery channel here — email, one message per contact — and there cannot
//    be a second: a trusted contact has no Flock account and therefore no
//    device token, which is why PrivacyPolicy.js tells users "SOS alerts are
//    sent by email only". So the isolation that matters is per RECIPIENT, and
//    it is Promise.allSettled below: a rejection, a provider error, or an
//    address that can never be delivered to costs that contact and nobody else.
//    The second seam is between the fan-out and the bookkeeping write that
//    follows it, which is why that UPDATE carries a .catch — it runs after
//    every email is already out, and its failure is not the user's to hear
//    about.

// ---------------------------------------------------------------------------
// TELLING THE PEOPLE YOU ARE ACTUALLY OUT WITH
// ---------------------------------------------------------------------------
// Everything above this reaches TRUSTED CONTACTS, who are external people with
// no Flock account, by email. That is correct for them and it was the whole of
// what an SOS did. Nobody inside the app learned anything: this route sent no
// push and emitted nothing over a socket, so the four people standing in the
// same room as you, on the plan you are both on, found out when you told them.
//
// The nearest help is the nearest person. A trusted contact is often a parent
// in another city reading an email; the flock is who can walk across a bar.
//
// WHO GETS IT, AND WHY IT IS THIS NARROW. Accepted members of a CONFIRMED flock
// whose event_time sits inside a twelve hour window either side of now. Not
// every flock the person has ever joined, not a plan that is still being voted
// on, and not next Saturday. "Confirmed and happening around now" is the
// closest thing the schema has to "the people you are with", and the cost of
// widening it is somebody's phone going off about a night they are not at.
//
// The sender is excluded, and so is anyone in a block relationship with them.
// The push carries fromUserId so services/pushHelper.js can make that second
// check itself: canNotify refuses a push whose actor is blocked, and a payload
// with no actor is not checked at all, which is the defect the batched RSVP
// notification had.
//
// LOCATION IS INCLUDED WHEN THE SENDER SHARED IT, on exactly the same terms the
// contact email uses. Somebody who pressed this wants to be found, and a
// notification that says only "Ava needs help" to a person fifteen feet away is
// a worse outcome than the one it replaced.
//
// Never awaited by the response and never able to fail it. The alert has
// already been recorded and the emails have already gone out; the flock leg is
// additional reach, and a socket or a push failing must not turn a delivered
// SOS into a 500 that invites a frightened person to press it again.
const SOS_FLOCK_WINDOW_HOURS = 12;

// The audience for BOTH directions of an SOS. The alarm and its stand-down
// must reach the same people, so they share one query: a stand-down that
// missed somebody the alarm reached leaves that person acting on a withdrawn
// emergency, which is the failure the stand-down exists to prevent.
const SOS_FLOCK_AUDIENCE_SQL = `SELECT DISTINCT fm.user_id
       FROM flock_members fm
       JOIN flocks f ON f.id = fm.flock_id
       JOIN flock_members me
         ON me.flock_id = f.id AND me.user_id = $1 AND me.status = 'accepted'
      WHERE fm.status = 'accepted'
        AND fm.user_id <> $1
        AND f.status = 'confirmed'
        AND f.event_time IS NOT NULL
        AND f.event_time BETWEEN (NOW() AT TIME ZONE 'UTC') - ($2::int * INTERVAL '1 hour')
                            AND (NOW() AT TIME ZONE 'UTC') + ($2::int * INTERVAL '1 hour')
        AND COALESCE((SELECT is_banned FROM users u WHERE u.id = fm.user_id), FALSE) = FALSE
        AND NOT EXISTS (
          SELECT 1 FROM user_blocks b
          WHERE (b.blocker_id = $1 AND b.blocked_id = fm.user_id)
             OR (b.blocker_id = fm.user_id AND b.blocked_id = $1)
        )`;

async function alertFlockMembers(io, user, coords, contactsAlerted) {
  const members = await pool.query(SOS_FLOCK_AUDIENCE_SQL, [user.id, SOS_FLOCK_WINDOW_HOURS]);

  if (members.rows.length === 0) return { notified: 0 };

  const name = String(user.name || 'Someone you are out with').slice(0, 80);
  const title = `${name} needs help`;
  const body = coords
    ? 'They pressed SOS on Flock and shared their location. Open the app, then call them.'
    : 'They pressed SOS on Flock. Open the app, then call them.';

  const payload = {
    type: 'safety_alert',
    fromUserId: String(user.id),
    fromUserName: name,
    // Sent to the app as numbers, so a client can put a pin on a map without
    // reparsing a sentence. Absent entirely when nothing was shared, rather
    // than present and null, so a consumer cannot mistake one for the other.
    // readCoords hands back { lat, lng }. This read .latitude/.longitude, so
    // the keys were undefined, the FCM builder dropped them, and every
    // flockmate's alarm screen said "They did not share their location" and
    // hid the map, while the push body said the opposite. The unit test
    // passed the wrong shape in, so it was green. 2026-09-04.
    ...(coords ? { latitude: coords.lat, longitude: coords.lng } : {}),
    // How many trusted contacts the emails actually reached. The flockmate's
    // alarm screen stated "their trusted contacts have already been emailed"
    // unconditionally, so when every email failed the only people who knew
    // were told the adults were handled. A number, not a boolean, because the
    // screen says something different for none than for some.
    ...(typeof contactsAlerted === 'number' ? { contactsAlerted } : {}),
    at: new Date().toISOString(),
  };

  for (const row of members.rows) {
    // The socket first: somebody with the app open should see this before a
    // notification tray can draw it.
    if (io) io.to(`user:${row.user_id}`).emit('safety_alert', payload);
  }

  // pushAlways, not pushIfOffline. "Already looking at the app" is not a reason
  // to stay silent about this one, and 'safety_alert' is in the set
  // pushHelper rings through quiet hours (RINGS_THROUGH_THE_NIGHT), which was
  // reserved for a producer that until now did not exist.
  const results = await Promise.allSettled(
    members.rows.map((row) => pushAlways(row.user_id, title, body, payload))
  );
  // A member with no registered device answers { sent: 0 }, which is not
  // reached; only a delivered push counts, so the log does not over-report.
  const notified = results.filter((r) => r.status === 'fulfilled' && r.value && (r.value.sent || 0) > 0).length;
  console.log(`[Safety] SOS from user ${user.id} reached ${notified} of ${members.rows.length} flock members in the app.`);
  // Everyone the alarm was ADDRESSED to, not only those a push reached: a
  // socket emit lands on an open app without a device row, and the stand-down
  // has to reach every one of them. Written on the alert row by the caller.
  return { notified, recipientIds: members.rows.map((row) => Number(row.user_id)) };
}

// The flock leg's audience, written on the alert row so the stand-down can
// go to exactly those people (migration 063). Nothing to record is not an
// error; a write that fails is logged by the caller's catch.
function recordFlockRecipients(alertId, leg) {
  if (!alertId || !leg || !Array.isArray(leg.recipientIds) || leg.recipientIds.length === 0) return null;
  return pool.query('UPDATE emergency_alerts SET flock_recipient_ids = $1::int[] WHERE id = $2', [leg.recipientIds, alertId]);
}

// The stand-down's audience when the alarm recorded who it reached (migration
// 063): exactly those people, less anyone banned or blocked since. Nothing
// about the flock is consulted, because the flock is what changed under the
// old query: a plan the sweep marked completed, one the host cancelled, or
// one the sender had since left answered no rows, and every flockmate's
// full-screen alarm stayed up for good (safety audit, 2026-09-05).
const SOS_STAND_DOWN_SNAPSHOT_SQL = `SELECT DISTINCT u.id AS user_id
       FROM users u
      WHERE u.id = ANY($2::int[])
        AND u.id <> $1
        AND COALESCE(u.is_banned, FALSE) = FALSE
        AND NOT EXISTS (
          SELECT 1 FROM user_blocks b
          WHERE (b.blocker_id = $1 AND b.blocked_id = u.id)
             OR (b.blocker_id = u.id AND b.blocked_id = $1)
        )`;

// The stand-down's flock leg, and the leg /alert/cancel forgot for as long as
// it existed: the alarm above deliberately rings through quiet hours and puts
// a full-screen "call 911" modal on every flockmate's phone, and cancelling
// reached only the email contacts, so a flockmate could still be calling 911
// or leaving the venue to search for somebody who had already said they are
// OK. Same audience query as the alarm, on purpose and by construction. The
// window is re-evaluated at cancel time, which can only shrink the set toward
// people whose plan is still near; anyone the alarm reached outside it holds
// a stale alert, which the email contacts always risked too.
async function notifyFlockStandDown(io, user, hoursSinceAlert = 0, recipientIds = null) {
  // `recipientIds` is what the alarm recorded (migration 063). When it is
  // there, the stand-down goes to that list and to nobody else; the live
  // audience query below is the fallback for alerts written before the
  // column existed, and it carries the widening below for the same reason it
  // always did.
  const snapshot = Array.isArray(recipientIds)
    ? recipientIds.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0)
    : [];
  // The window is widened by the time since the alarm, so a plan that was
  // inside the alarm's window is still inside this one. Re-evaluated as it
  // was, the window could only shrink, and a flockmate reached near its
  // edge held a full-screen alarm nobody ever called off.
  const windowHours = SOS_FLOCK_WINDOW_HOURS + Math.max(0, Math.ceil(Number(hoursSinceAlert) || 0));
  const members = snapshot.length
    ? await pool.query(SOS_STAND_DOWN_SNAPSHOT_SQL, [user.id, snapshot])
    : await pool.query(SOS_FLOCK_AUDIENCE_SQL, [user.id, windowHours]);
  if (members.rows.length === 0) return { notified: 0 };

  const name = String(user.name || 'Someone you are out with').slice(0, 80);
  const payload = {
    type: 'safety_alert_cancelled',
    fromUserId: String(user.id),
    fromUserName: name,
    at: new Date().toISOString(),
  };
  for (const row of members.rows) {
    if (io) io.to(`user:${row.user_id}`).emit('safety_alert_cancelled', payload);
  }
  // pushAlways for the same reason the alarm uses it: the person this must
  // reach may have put the phone down to go help. It also rings through quiet
  // hours (pushHelper), because anyone it reaches was already woken by the
  // alarm and is worrying or moving; the all-clear cannot wait for morning.
  const results = await Promise.allSettled(
    members.rows.map((row) => pushAlways(
      row.user_id,
      `${name} says they are OK`,
      'They withdrew their SOS on Flock. If you already set out or called someone, let them know.',
      payload
    ))
  );
  const notified = results.filter((r) => r.status === 'fulfilled' && r.value && (r.value.sent || 0) > 0).length;
  console.log(`[Safety] Stand-down from user ${user.id} reached ${notified} of ${members.rows.length} flock members.`);
  return { notified };
}

router.post('/alert', authenticateAllowBanned, async (req, res) => {
  try {
    const { latitude, longitude, accuracy, includeLocation, timezone } = req.body;

    // Parsed once, up front, before anything is committed or sent. `coords` is
    // null when the user opted out OR when the client sent something we cannot
    // safely put on a map — both mean "alert without a location", which is a
    // degraded alert, not a failed one.
    const coords = includeLocation === false ? null : readCoords(latitude, longitude);
    // Only meaningful alongside a position, and never stored: the accuracy of
    // a fix is a fact about the moment the alert was sent, not about the
    // account, and emergency_alerts holds only what the privacy policy says it
    // holds (the account, the coordinates, the number of contacts emailed).
    const fixMetres = coords ? readAccuracy(accuracy) : null;

    // Claim phase: cooldown check, contact read, and the emergency_alerts row
    // are one atomic unit. The row is written with contacts_alerted = 0, which
    // reserves the slot for 60 seconds while the emails go out; a real
    // send updates it to the confirmed count and arms the full cooldown, and a
    // total failure leaves it at 0 so the retry path reopens in a minute
    // instead of being blocked for five (round 8's rule, kept).
    const client = await pool.connect();
    let contacts;
    let userName;
    let alertId;
    // Whether THIS send is an update to an alert already out, and which kind.
    // Decided inside the claim transaction below and read at the email build
    // AFTER it, which is why these live out here: declared inside the try they
    // were out of scope at the send site, and the first version threw exactly
    // there.
    let updateKind = null; // 'moved' | 'location'
    let updateAgeMs = 0;
    try {
      await client.query('BEGIN');
      await client.query("SELECT pg_advisory_xact_lock(hashtext('safety:' || $1::text))", [String(req.user.id)]);

      // The most recent attempt of ANY kind, plus how many delivered alerts are
      // inside the escalation window. `age_ms` is computed by Postgres so the
      // decision does not depend on the app clock agreeing with the database's.
      const recent = await client.query(
        `SELECT created_at,
                latitude,
                longitude,
                COALESCE(contacts_alerted, 0) AS contacts_alerted,
                EXTRACT(EPOCH FROM ((NOW() AT TIME ZONE 'UTC') - created_at)) * 1000 AS age_ms,
                (SELECT COUNT(*)::int FROM emergency_alerts e2
                  WHERE e2.user_id = $1
                    AND COALESCE(e2.contacts_alerted, 0) > 0
                    AND e2.created_at > (NOW() AT TIME ZONE 'UTC') - ($2::int || ' milliseconds')::interval) AS delivered_in_window,
                (SELECT COUNT(*)::int FROM emergency_alerts e3
                  WHERE e3.user_id = $1
                    AND e3.created_at > (NOW() AT TIME ZONE 'UTC') - ($2::int || ' milliseconds')::interval) AS attempts_in_window
         FROM emergency_alerts
         WHERE user_id = $1
         ORDER BY created_at DESC LIMIT 1`,
        [req.user.id, ESCALATION_WINDOW_MS]
      );

      const last = recent.rows[0] || null;
      // Whether THIS send is an update to an alert already out, and which
      // kind. Decided in the admission branches below and read at the send
      // site, so the email can say so: a contact holding two byte-identical
      // "Emergency Alert from Ava" messages cannot tell an update from a
      // duplicate, and identical subjects thread in Gmail, collapsing the
      // update under the original. (The bindings live above the transaction,
      // in the same scope as the email build that reads them.)
      if (last) {
        const ageMs = Number(last.age_ms) || 0;
        const delivered = last.contacts_alerted > 0;

        // The floor's one exemption (see isLocationFollowUp). Evaluated once,
        // here, so both floor refusals below answer the same question and
        // cannot drift apart.
        const locationFollowUp = isLocationFollowUp(coords, last, ageMs);
        if (locationFollowUp) { updateKind = 'location'; updateAgeMs = ageMs; }

        // In flight: a claim row with nothing confirmed yet. This is the only
        // refusal that is purely about concurrency, and it lapses in 60s.
        //
        // The follow-up is exempt HERE too, and this is the branch it actually
        // meets in production: the first alert's emails are still fanning out
        // three seconds later, so contacts_alerted is still 0 and the row still
        // reads as in flight. Exempting only the delivered-floor branch below
        // would have left the fix inert for the timing it was written for.
        if (!delivered && ageMs < ALERT_FLOOR_MS && !locationFollowUp) {
          await client.query('ROLLBACK');
          // Round 23: this was the one refusal in the file that did not name
          // 911, and it is the refusal that fires while the outcome of the
          // first alert is still unknown — nothing has been confirmed
          // delivered, so the person reading it has been told less than every
          // other 429 here tells them. That is the wrong place to be quietest.
          return res.status(429).json({
            error: `An alert is already going out. Give it a moment before trying again. ${CALL_911}`,
          });
        }

        if (delivered && ageMs < ALERT_COOLDOWN_MS) {
          const sentAgo = agoPhrase(ageMs);
          const reached = `${last.contacts_alerted} contact${last.contacts_alerted === 1 ? '' : 's'}`;

          // Same exemption on the delivered side: the first alert is confirmed
          // out, it just could not say where. Everything else keeps the floor.
          if (ageMs < ALERT_FLOOR_MS && !locationFollowUp) {
            await client.query('ROLLBACK');
            return res.status(429).json({
              error: `Your alert went out to ${reached} ${sentAgo}. Hang on a moment before sending another. ${CALL_911}`,
              alreadySent: true,
              contactsAlerted: last.contacts_alerted,
            });
          }

          const escalating = isEscalation(coords, last);
          if (!escalating || Number(last.delivered_in_window) >= MAX_ESCALATIONS) {
            await client.query('ROLLBACK');
            const minsLeft = Math.max(1, Math.ceil((ALERT_COOLDOWN_MS - ageMs) / 60000));
            return res.status(429).json({
              error: escalating
                ? `Your alert went out to ${reached} ${sentAgo}, and you have sent several updates already. You can send another in ${minsLeft} minute${minsLeft > 1 ? 's' : ''}. ${CALL_911}`
                : `Your alert already went out to ${reached} ${sentAgo}. You can send another in ${minsLeft} minute${minsLeft > 1 ? 's' : ''}, or straight away if you move somewhere new. ${CALL_911}`,
              alreadySent: true,
              contactsAlerted: last.contacts_alerted,
            });
          }
          // Escalation allowed: fall through and send the updated location.
          // Past the follow-up window this is a plain escalation, and the
          // email used to say "Their location has changed" over an alert
          // that never had one. There is nothing to have moved from.
          updateKind = escalationKind(last);
          updateAgeMs = ageMs;
        }

        // Round 17, second pass. Releasing the claim on a total failure (below)
        // opened a loop I had to close: if EVERY send fails — which is exactly
        // what a Resend outage looks like — each retry is allowed at once,
        // writes a row, and fans out to every contact again, forever. The
        // escalation cap counts only DELIVERED alerts, so it does not bite
        // there. This is the outer bound on attempts of any kind, and it is
        // deliberately checked LAST so that every more specific (and more
        // useful) refusal above gets to answer first, and so a genuine first
        // alert never meets it at all.
        if (Number(last.attempts_in_window) >= MAX_ATTEMPTS_PER_WINDOW) {
          await client.query('ROLLBACK');
          return res.status(429).json({
            error: `You have sent several alerts in the last few minutes. Give it a moment before the next one. ${CALL_911}`,
          });
        }
      }

      contacts = await client.query(
        'SELECT * FROM trusted_contacts WHERE user_id = $1 ORDER BY created_at ASC',
        [req.user.id]
      );
      if (contacts.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `You have no trusted contacts set up, so there is nobody to alert. ${CALL_911}` });
      }

      // Round 17: email is the only channel this route has. Contacts saved
      // through an older build (when the server let email through as optional)
      // are listed on the Safety screen and look exactly like working ones, so
      // a user could sit on five unreachable contacts believing SOS was armed.
      // Detect it BEFORE claiming a slot: this is not a transient failure that
      // a retry can fix, so it must not burn the retry window, and the message
      // has to say what to actually do.
      // Round 20: this asked only whether contact_email was TRUTHY, so a row
      // holding an address that can never be delivered to — an .invalid domain,
      // a comma-joined pair, anything saved before the rule above existed —
      // read as reachable. The alert then claimed a slot, fanned out, failed,
      // and answered 502 "try again right away", which is the wrong advice: no
      // number of retries fixes an undeliverable address. The same shared
      // question that guards the add form guards the send.
      if (!contacts.rows.some((c) => isMailableAddress(c.contact_email))) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: `None of your trusted contacts have an email address that can receive mail, so the alert cannot reach anyone. Add an email to a contact in Safety settings. ${CALL_911}`,
          unreachableContacts: true,
        });
      }

      const user = await client.query('SELECT name FROM users WHERE id = $1', [req.user.id]);
      userName = user.rows[0]?.name || 'A Flock user';

      const claim = await client.query(
        `INSERT INTO emergency_alerts (user_id, latitude, longitude, contacts_alerted)
         VALUES ($1, $2, $3, 0) RETURNING id`,
        [req.user.id, coords?.lat ?? null, coords?.lng ?? null]
      );
      alertId = claim.rows[0].id;

      await client.query('COMMIT');
    } catch (txErr) {
      await client.query('ROLLBACK').catch(() => {});
      throw txErr;
    } finally {
      client.release();
    }

    // Round 17: the client never sends `timezone`, so every alert email said
    // "Alert sent at 8/14/2026, 3:12:04 AM" to a parent whose clock reads
    // 11:12 PM. A timestamp that looks eight hours wrong on an emergency email
    // undermines the whole message, so an unlabelled local time is not an
    // option — when we were not told the zone, we say which zone we used.
    const tz = timezone || 'UTC';
    let time;
    try {
      time = new Date().toLocaleString('en-US', { timeZone: tz, timeZoneName: 'short' });
    } catch {
      time = `${new Date().toLocaleString('en-US', { timeZone: 'UTC' })} UTC`;
    }

    const safeName = escapeHtml(userName);

    // The slot is claimed; now send and record what ACTUALLY happened (audit
    // 2026-08-12: the response must never claim a delivery that did not occur).
    const alerts = [];
    let emailsSent = 0;

    // Round 12: these went out one at a time and awaited in sequence, so five
    // contacts meant five serial round trips — with the new 8s deadline a
    // brownout would still delay the last contact by half a minute. Fan out and
    // settle: contact 3 is not held hostage by contact 1's slow send, and no
    // single rejection can abort the loop mid-alert.
    const withEmail = contacts.rows.filter((c) => isMailableAddress(c.contact_email));

    // coords is already numeric and in range, so nothing user-controlled reaches
    // this HTML — the href cannot be broken out of and toFixed cannot throw.
    // fixMetres is likewise a finite number or null.
    //
    // Round 23: the button used to read "View Location on Map" for every fix we
    // had, and the coordinates were always printed to six decimal places. When
    // the phone tells us the fix is only good to a kilometre, saying "location"
    // and printing eleven centimetres of precision is a claim we cannot support,
    // and it is the claim that makes somebody stop searching once they arrive.
    // So a coarse fix is labelled as an area, and the radius is printed next to
    // the coordinates in both cases when we were told one.
    const coarse = fixMetres !== null && fixMetres > COARSE_FIX_METRES;
    const accuracyLine = fixMetres === null
      ? ''
      : (coarse
        ? `<p style="color:#b45309;font-size:13px;margin:8px 0 0">This position is approximate. The phone put it within ${accuracyPhrase(fixMetres)}, so treat it as the area to search rather than the spot.</p>`
        : `<p style="color:#6b7280;font-size:13px;margin:4px 0 0">Accurate to ${accuracyPhrase(fixMetres)}.</p>`);
    const locationBlock = coords
      ? `<p style="margin:12px 0"><a href="https://maps.google.com/?q=${coords.lat},${coords.lng}" style="display:inline-block;padding:12px 24px;background:#ef4444;color:white;text-decoration:none;border-radius:8px;font-weight:bold">${coarse ? 'View Area on Map' : 'View Location on Map'}</a></p>
         <p style="color:#6b7280;font-size:13px">Coordinates: ${coords.lat.toFixed(6)}, ${coords.lng.toFixed(6)}</p>
         ${accuracyLine}`
      : '<p style="color:#6b7280">Location was not available.</p>';

    // Round 23: WHO ELSE IS COMING. A trusted contact had no way to know
    // whether they were one of five people being told or the only one, and the
    // two call for opposite things. Somebody who is the only contact needs to
    // act rather than assume a parent already has it; one of five needs to
    // know that four other people are about to ring the same number. The count
    // is settled before the fan-out starts, so it costs nothing to say.
    const updateLine = updateKind
      ? `<p style="font-size:14px;color:#b45309;margin:0 0 10px"><strong>This is an update to the alert sent ${agoPhrase(updateAgeMs)}.</strong> ${updateKind === 'moved' ? 'Their location has changed; the map below is the newest position.' : 'Their location is now available; the first alert had none.'}</p>`
      : '';
    const alsoLine = withEmail.length > 1
      ? `<p style="color:#6b7280;font-size:13px">You are one of ${withEmail.length} people ${safeName} asked us to alert.</p>`
      : `<p style="color:#6b7280;font-size:13px">You are the only contact ${safeName} asked us to alert.</p>`;

    const htmlBody = `
      <div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;padding:20px">
        <div style="background:#fee2e2;border-radius:12px;padding:20px;text-align:center;margin-bottom:20px">
          <h1 style="color:#dc2626;margin:0 0 8px;font-size:24px">Emergency Alert</h1>
          <p style="color:#991b1b;margin:0;font-size:16px"><strong>${safeName}</strong> needs help</p>
        </div>
        <p style="font-size:15px;color:#1e293b">${safeName} has triggered an emergency alert on the <strong>Flock</strong> app and may need your assistance.</p>
        ${updateLine}
        ${locationBlock}
        ${alsoLine}
        <hr style="border:none;border-top:1px solid #e5e7eb;margin:20px 0">
        <p style="color:#6b7280;font-size:12px">Alert sent at ${time}</p>
        <p style="color:#9ca3af;font-size:11px">This is an automated safety alert from the Flock app. If this is an emergency, call your local emergency number. Replying to this message does not reach ${safeName}.</p>
      </div>`;

    for (const c of contacts.rows) {
      if (!isMailableAddress(c.contact_email)) {
        // The response says which contact could not be reached and why, because
        // the only person who can fix it is the one reading it.
        alerts.push({
          contactName: c.contact_name,
          email: c.contact_email || null,
          sent: false,
          reason: c.contact_email ? 'that address cannot receive mail' : 'no email',
        });
      }
    }

    const settled = await Promise.allSettled(
      withEmail.map((c) => sendAlertEmail(
        c.contact_email,
        `🚨 ${updateKind ? 'Update: ' : ''}Emergency Alert from ${safeSubjectText(userName)}`,
        htmlBody,
        // The one send in Flock that the do-not-mail list does not get a vote on.
        { category: EMERGENCY_CATEGORY }
      ))
    );
    settled.forEach((outcome, i) => {
      const c = withEmail[i];
      const sent = outcome.status === 'fulfilled' && outcome.value?.sent === true;
      if (outcome.status === 'rejected') {
        // A TRUSTED CONTACT IS A THIRD PARTY WHO NEVER SIGNED UP — typically a
        // parent, on a product whose floor is 13 — and their address reaches
        // us only because a teenager typed it into a safety screen. This line
        // put it into Railway's log in full on every send failure. The
        // maskAddress note in services/emailService.js argues exactly this
        // case, in those words, and services/venueDigest.js already honours
        // it; the SOS path, the one where it matters most, did not.
        console.error('[Safety] Alert email threw for', maskAddress(c.contact_email), outcome.reason?.message);
      }
      alerts.push({ contactName: c.contact_name, email: c.contact_email, sent });
      if (sent) emailsSent++;
    });

    // Record what actually happened on the row we already claimed.
    // contacts_alerted = confirmed sends only; leaving it at 0 means the row
    // stops blocking retries once the in-flight window lapses.
    if (emailsSent > 0) {
      // Round 20: this write was the only statement in the route with no
      // `.catch()`, and it runs AFTER every email has already gone out. A blip
      // on a one-row UPDATE therefore threw into the outer catch and answered
      // "500 Failed to send alert" for an alert that had been DELIVERED.
      //
      // That is round 17's bug pointing the other way and this direction is
      // worse: the user is told nobody was reached when everybody was, so they
      // tap again, and the row is still sitting at contacts_alerted = 0, so it
      // reads as in flight and refuses the retry for a further sixty seconds.
      // Delivered, disbelieved, and locked out.
      //
      // This write is bookkeeping for the COOLDOWN. Losing it costs at worst a
      // duplicate alert a minute later, which on this route is the cheap
      // direction. It is not the thing the user asked for and its failure is
      // not theirs to hear about, so it is logged and the truth is reported.
      // One retry first: a lost write here also makes the alert impossible
      // to stand down, because /alert/cancel only withdraws an alert that
      // reached somebody, and this count is how it knows.
      // The contacts the mail provider accepted, kept on the row so the
      // stand-down reaches them whether or not they are still on the list
      // (migration 063).
      const contactRecipients = alerts
        .filter((a) => a.sent === true && isMailableAddress(a.email))
        .map((a) => ({ name: String(a.contactName || '').slice(0, 100), email: a.email }));
      const recordCount = () => pool.query(
        'UPDATE emergency_alerts SET contacts_alerted = $1, contact_recipients = $3::jsonb WHERE id = $2',
        [emailsSent, alertId, JSON.stringify(contactRecipients)]
      );
      await recordCount().catch(() => recordCount()).catch((e) => console.error(
        `[Safety] alert ${alertId} was DELIVERED to ${emailsSent} contact(s) but the count could not be recorded: ${e.message}. The cooldown for this user is not armed.`
      ));
    } else {
      // Round 17: leaving the claim row at contacts_alerted = 0 still blocked
      // the next attempt for the remainder of the 60-second in-flight window —
      // after we had ALREADY told the user, in this same response, that nothing
      // was delivered. Telling someone their SOS failed and then refusing their
      // retry is the worst behavior in this file. Nothing is in flight once the
      // sends have settled, so the claim is released now by backdating it past
      // the floor. The row survives as an audit record of an attempt that
      // reached nobody; only its ability to block is given up.
      await pool.query(
        `UPDATE emergency_alerts
         SET created_at = NOW() - ($1::int || ' milliseconds')::interval
         WHERE id = $2`,
        [ALERT_FLOOR_MS + 1000, alertId]
      ).catch((e) => console.error('[Safety] Failed to release alert claim:', e.message));
    }

    // The flock leg, before the email verdict below can end the request.
    // It used to run only after the success response, so when every contact
    // email failed the people in the room were told nothing at all, and
    // they are the ones who can physically get there. Fire-and-forget: the
    // response is never held on it, and it cannot change the answer.
    // Who the alarm reached goes on the row (migration 063) so the all-clear
    // can go to them; best effort, the live-audience fallback stands otherwise.
    alertFlockMembers(req.app.get('io'), req.user, coords, emailsSent)
      .then((leg) => recordFlockRecipients(alertId, leg))
      .catch((err) => console.error(
        `[Safety] SOS from user ${req.user.id}: the flock leg failed (${err.message}). `
        + 'The trusted-contact emails are unaffected.'
      ));

    if (emailsSent === 0) {
      // Nobody was reached — say so loudly, and the retry path is open now.
      return res.status(502).json({
        success: false,
        error: `Your alert could not be delivered to any contact. ${CALL_911} You can try again right away.`,
        canRetry: true,
        alerts,
      });
    }

    // Round 23: this said "2 emails sent". App.js puts it straight into the
    // toast that is the only confirmation a frightened person gets, and it
    // answered the machinery's question rather than theirs. Nobody presses SOS
    // wanting to know how many SMTP transactions succeeded; they want to know
    // WHO now knows. The names are already in hand.
    //
    // The second half counts EVERY contact who was not reached, not just the
    // ones with no usable address. The old counter covered only the rows we
    // refused to attempt, never a send that was attempted and failed, so a
    // contact whose provider was down vanished from the sentence entirely and
    // the user finished the night believing everybody had been told. Total
    // contacts minus confirmed deliveries is the number they have to act on.
    const notReached = contacts.rows.length - emailsSent;
    const parts = [`${namePhrase(alerts.filter((a) => a.sent).map((a) => a.contactName))} been told`];
    if (notReached > 0) parts.push(`${notReached} contact${notReached > 1 ? 's' : ''} could not be reached`);

    res.json({
      success: true,
      message: parts.join('. '),
      contactsAlerted: emailsSent,
      alerts,
    });

  } catch (err) {
    // Round 23: this answered `500 Failed to send alert` and stopped there. It
    // is the only outcome in this route that tells a person nothing about what
    // to do next, and it fires on the worst inputs available — the database
    // being unreachable, or a throw from somewhere nobody predicted. Every
    // other failure here names 911 and says whether a retry is worth making;
    // the one that means "we do not know what just happened" said the least.
    //
    // `canRetry` is honest rather than optimistic. A throw before the COMMIT
    // stored nothing, and a throw after it leaves a claim row that stops
    // blocking in sixty seconds, so trying again is the right advice in both
    // cases even though only one of them is clean.
    console.error('[Safety] Alert error:', err);
    res.status(500).json({
      error: `Something went wrong on our end and we cannot tell whether your alert went out. ${CALL_911} Try again in a moment.`,
      canRetry: true,
    });
  }
});

// ---------------------------------------------------------------------------
// ── Stand the alert down (round 23) ──
// ---------------------------------------------------------------------------
// THE GAP THIS CLOSES. Until now an SOS was a one-way door. Five people, at
// least one of them a parent, received "your child needs help" with a map link,
// and there was no mechanism in this product — not a button, not a route, not a
// second email — by which they could ever be told otherwise. The only thing
// that ended an alert was the user phoning each contact individually, which is
// the thing they pressed a button to avoid having to do.
//
// That matters most in the case that is by far the most common one. On a
// product whose floor is 13 and whose users are 15 to 22, most SOS presses are
// going to be a pocket, a dare, or a scare that resolves in ninety seconds. The
// alert is right to be cheap to send. What it must not be is impossible to
// withdraw, because a false alarm nobody can cancel teaches exactly one lesson,
// which is not to press the button.
//
// WHY THIS ROUTE MAY BE LIMITED WHEN /alert MAY NOT. The rule on /alert is
// "never be the reason an alert did not go out", and a refused SOS can leave
// somebody alone. A refused stand-down leaves somebody worried. Those are not
// the same harm, so this route is allowed a meter that /alert is not — and the
// meter is still set well past any real sequence of taps.
//
// WHAT IT DOES NOT DO.
//
//   * It writes NO row. emergency_alerts is the alert log, and the cooldown
//     reads its most recent row: a stand-down inserted there would read as a
//     delivered alert and block the next real SOS for five minutes. A cancel
//     must never be able to do that, so it touches nothing.
//   * It sends no location, ever. The whole content of the message is that the
//     earlier one is withdrawn.
//   * It cannot invent an alert. With nothing delivered in the window there is
//     nobody holding a message to withdraw, and mailing a stand-down for an
//     alert that never went out would be the first thing some contacts ever
//     heard from Flock.
const CANCEL_WINDOW_MS = 6 * 60 * 60 * 1000;
const MAX_CANCELS_PER_WINDOW = 3;
const CANCEL_METER_WINDOW_MS = 15 * 60 * 1000;
const CANCEL_METER_MAX_KEYS = 5000;
// THE REFUND NEEDS A FLOOR UNDER IT, OR IT IS NOT A METER.
//
// A stand-down that reached nobody gives its slot back, and it should: nothing
// was withdrawn, so nothing was spent, and the person still needs to be able to
// try. But the refund is unconditional and the failure is caller-reachable, so
// the two together mean a request whose sends ALWAYS fail costs nothing and can
// be repeated without limit for the whole six-hour window, each attempt fanning
// out to every contact. That is exactly the load the comment below says the
// meter exists to bound, and the refund was handing it back.
//
// So attempts are counted separately and never refunded. The refundable count
// is what bounds successful stand-downs, which is a product rule; this bounds
// requests that reach the mail provider, which is a load rule, and the two
// numbers are different for the same reason. It sits well above any real
// sequence of taps: a person retrying a genuinely broken send gets nine more
// goes inside a quarter of an hour.
const MAX_CANCEL_ATTEMPTS_PER_WINDOW = 12;
const cancelWrites = new Map(); // userId -> { count, attempts, resetAt }

// Check-then-charge, and charged BEFORE the sends rather than after. The
// opposite of the contact form's rule, and for the opposite reason: there the
// meter protects strangers from a relay and only a stored address can become
// mail, so only a stored address is charged. Here the send itself is the whole
// action, and an attempt that fanned out and failed has already put the load on
// the provider that this number exists to bound.
function allowCancel(userId, now = Date.now()) {
  if (cancelWrites.size > CANCEL_METER_MAX_KEYS) {
    for (const [k, v] of cancelWrites) if (now >= v.resetAt) cancelWrites.delete(k);
    while (cancelWrites.size > CANCEL_METER_MAX_KEYS) {
      cancelWrites.delete(cancelWrites.keys().next().value);
    }
  }
  let entry = cancelWrites.get(userId);
  if (!entry || now >= entry.resetAt) {
    entry = { count: 0, attempts: 0, resetAt: now + CANCEL_METER_WINDOW_MS };
    cancelWrites.set(userId, entry);
  }
  if (entry.count >= MAX_CANCELS_PER_WINDOW) return false;
  // Never refunded. See MAX_CANCEL_ATTEMPTS_PER_WINDOW: this is the one that
  // stops a stand-down whose sends always fail from being free forever.
  if ((entry.attempts || 0) >= MAX_CANCEL_ATTEMPTS_PER_WINDOW) return false;
  entry.count += 1;
  entry.attempts = (entry.attempts || 0) + 1;
  return true;
}

router.post('/alert/cancel', authenticateAllowBanned, async (req, res) => {
  try {
    const { timezone } = req.body || {};

    // The most recent alert that actually reached somebody. contacts_alerted is
    // confirmed sends only (see the claim comment on /alert), so a claim row
    // that reached nobody correctly does not qualify: there is no message out
    // there to withdraw.
    // An alarm the FLOCK heard is an alarm that can be withdrawn, whether or
    // not a single email landed (safety audit, 2026-09-05): the flock leg
    // runs regardless of the email verdict, so gating the all-clear on
    // contacts_alerted left a full-screen alarm on every flockmate's phone
    // with no way to call it off whenever the mail provider was down.
    const last = await pool.query(
      `SELECT id, created_at, contacts_alerted, flock_recipient_ids, contact_recipients
         FROM emergency_alerts
        WHERE user_id = $1
          AND (COALESCE(contacts_alerted, 0) > 0 OR COALESCE(cardinality(flock_recipient_ids), 0) > 0)
          AND created_at > (NOW() AT TIME ZONE 'UTC') - ($2::int || ' milliseconds')::interval
        ORDER BY created_at DESC LIMIT 1`,
      [req.user.id, CANCEL_WINDOW_MS]
    );
    if (last.rowCount === 0) {
      return res.status(400).json({
        error: 'You have not sent an alert that reached anyone recently, so there is nothing to stand down.',
        nothingToCancel: true,
      });
    }

    if (!allowCancel(req.user.id)) {
      return res.status(429).json({
        error: 'You have already told your contacts you are OK a few times just now. Give it a few minutes.',
      });
    }

    // Exactly the ADDRESSES that were on the list when the alert went out. A
    // contact added afterwards never received the alert, and a stand-down is
    // the wrong first message to send anybody. A contact removed since is gone
    // from the table and cannot be reached at all, which is reported rather
    // than hidden.
    //
    // The column is email_set_at and not created_at, because the obligation is
    // about the address rather than the row, and PUT /contacts/:id rewrites the
    // address of an existing row without moving its creation date. Reading
    // created_at here meant a contact could be added, alerted, edited to a
    // different address, and stood down, and the all clear went to somebody who
    // had never heard of us, past the do-not-mail list, on the strength of the
    // one argument that lets this route past it. COALESCE covers every row
    // written before migration 052, where the two dates are the same thing.
    // THE FLOCK FIRST, and to exactly who the alarm reached. Before the
    // contacts are even looked at, because the refusal below used to come
    // first and a person whose contacts had all been removed could not call
    // off the flock alarm at all. The recorded ids (migration 063) make a
    // completed, cancelled or departed plan irrelevant; a row from before
    // the column falls back to the live audience query, widened by the time
    // since the alarm as it always was.
    const hoursSinceAlert = (Date.now() - new Date(last.rows[0].created_at).getTime()) / 3600000;
    const flockIds = Array.isArray(last.rows[0].flock_recipient_ids) ? last.rows[0].flock_recipient_ids : [];
    // A push the alarm queued for a retry (a device that timed out) must not
    // be released after the all-clear: it would put "X needs help" back on a
    // lock screen minutes after "X says they are OK". Best effort.
    pool.query(
      `DELETE FROM push_outbox WHERE data->>'type' = 'safety_alert' AND data->>'fromUserId' = $1`,
      [String(req.user.id)]
    ).catch((outboxErr) => console.error('[Safety] Could not withdraw queued SOS pushes:', outboxErr?.message));
    notifyFlockStandDown(req.app.get('io'), req.user, hoursSinceAlert, flockIds).catch((fanErr) => {
      console.error('[Safety] Flock stand-down fan-out failed:', fanErr?.message);
    });

    // The contacts the alarm's emails reached, as recorded on the row; a
    // contact removed since still gets the all-clear, because they still
    // hold the alarm. Rows from before migration 063 fall back to the list
    // as it stood when the alarm went out.
    const recorded = Array.isArray(last.rows[0].contact_recipients)
      ? last.rows[0].contact_recipients
          .filter((c) => c && isMailableAddress(c.email))
          .map((c) => ({ contact_name: String(c.name || 'Your contact').slice(0, 100), contact_email: c.email }))
      : [];
    let withEmail = recorded;
    if (withEmail.length === 0) {
      const contacts = await pool.query(
        `SELECT contact_name, contact_email
           FROM trusted_contacts
          WHERE user_id = $1 AND COALESCE(email_set_at, created_at) <= $2
          ORDER BY created_at ASC`,
        [req.user.id, last.rows[0].created_at]
      );
      withEmail = contacts.rows.filter((c) => isMailableAddress(c.contact_email));
    }
    if (withEmail.length === 0) {
      // The flock leg above has already gone out. If the alarm reached a
      // flock, that is the honest answer; only when it reached nobody at all
      // is there nothing this route can do.
      if (flockIds.length > 0) {
        return res.json({
          success: true,
          message: 'The people on your plan have been told you are OK. None of your contacts could be reached here, so call them.',
          contactsToldCount: 0,
          flockStoodDown: true,
        });
      }
      return res.status(400).json({
        error: 'None of the contacts who received that alert are still on your list with a working email, so we cannot reach them here. Call them.',
        unreachableContacts: true,
      });
    }

    const user = await pool.query('SELECT name FROM users WHERE id = $1', [req.user.id]);
    const userName = user.rows[0]?.name || 'A Flock user';
    const safeName = escapeHtml(userName);
    const tz = timezone || 'UTC';
    let time;
    try { time = new Date().toLocaleString('en-US', { timeZone: tz, timeZoneName: 'short' }); }
    catch { time = `${new Date().toLocaleString('en-US', { timeZone: 'UTC' })} UTC`; }

    const htmlBody = `
      <div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;padding:20px">
        <div style="background:#dcfce7;border-radius:12px;padding:20px;text-align:center;margin-bottom:20px">
          <h1 style="color:#15803d;margin:0 0 8px;font-size:24px">All Clear</h1>
          <p style="color:#166534;margin:0;font-size:16px"><strong>${safeName}</strong> says they are OK</p>
        </div>
        <p style="font-size:15px;color:#1e293b">${safeName} has withdrawn the emergency alert you were sent earlier and says they are safe. Nothing further is needed.</p>
        <p style="font-size:15px;color:#1e293b">This came from ${safeName}'s own phone, not from us. If you are not satisfied that they are safe, contact them directly.</p>
        <hr style="border:none;border-top:1px solid #e5e7eb;margin:20px 0">
        <p style="color:#6b7280;font-size:12px">Stood down at ${time}</p>
        <p style="color:#9ca3af;font-size:11px">This is an automated safety message from the Flock app. Replying to this message does not reach ${safeName}.</p>
      </div>`;

    // EMERGENCY_CATEGORY, deliberately, and this is the SECOND caller of it —
    // services/emailSuppression.js asks that the argument be made in writing
    // before a second one exists, so here it is.
    //
    // The whole reason a hard bounce does not stop an SOS is that a trusted
    // contact never subscribed to anything and a deliverability fact is not a
    // refusal. Every word of that applies unchanged to the message that ends
    // the alert. It applies with more force, in fact: the only person who can
    // receive a stand-down is somebody who already received the alarm, so a
    // suppression that swallowed this one would leave a parent holding "your
    // child needs help" and nothing else, forever. Withdrawing an emergency is
    // part of the emergency. It is not a new list to be on.
    //
    // The boundary does not widen past this. Both callers are the same alert,
    // one raising it and one ending it. A third caller needs its own argument.
    const settled = await Promise.allSettled(
      withEmail.map((c) => sendAlertEmail(
        c.contact_email,
        `${safeSubjectText(userName)} is OK`,
        htmlBody,
        { category: EMERGENCY_CATEGORY }
      ))
    );

    const told = [];
    settled.forEach((outcome, i) => {
      const c = withEmail[i];
      if (outcome.status === 'rejected') {
        console.error('[Safety] Stand-down email threw for', maskAddress(c.contact_email), outcome.reason?.message);
      }
      if (outcome.status === 'fulfilled' && outcome.value?.sent === true) told.push(c.contact_name);
    });

    // The flock leg first, for the same reason as on /alert: a stand-down
    // whose emails all failed used to leave every flockmate holding the
    // alarm. Best-effort and never awaited by the response.
    if (told.length === 0) {
      // Same rule as /alert: never report a delivery that did not happen, and
      // say what to do instead. The meter is given back, because an attempt
      // that reached nobody has not withdrawn anything. `attempts` is NOT given
      // back: the fan-out happened either way, and a refund with nothing under
      // it is a limit an attacker turns off by making sure the sends fail.
      const entry = cancelWrites.get(req.user.id);
      if (entry && entry.count > 0) entry.count -= 1;
      return res.status(502).json({
        success: false,
        error: flockIds.length > 0
          ? 'The people on your plan have been told you are OK, but we could not tell any of your contacts. They still have your alert. Call them.'
          : 'We could not tell any of your contacts that you are OK. They still have your alert. Call them.',
        canRetry: true,
        flockStoodDown: flockIds.length > 0,
      });
    }

    const missed = withEmail.length - told.length;
    const parts = [`${namePhrase(told)} been told you are OK`];
    if (missed > 0) parts.push(`${missed} contact${missed > 1 ? 's' : ''} could not be reached, so call them`);

    res.json({
      success: true,
      message: parts.join('. '),
      contactsToldCount: told.length,
      flockStoodDown: flockIds.length > 0,
    });

    return undefined;
  } catch (err) {
    console.error('[Safety] Alert cancel error:', err);
    res.status(500).json({
      error: 'Something went wrong and we could not tell your contacts you are OK. They still have your alert. Try again, or call them.',
      canRetry: true,
    });
  }
});

// ── Share location with trusted contacts ──
// Cooldown: sharing your location is a deliberate act, not a loop. 10 min
// between sends per user keeps the email path un-abusable (SOS has its own
// route and is NOT limited by this).
const shareCooldowns = new Map();
const SHARE_COOLDOWN_MS = 10 * 60 * 1000;
const SHARE_COOLDOWN_MAX = 5000;
router.post('/share-location', authenticate, async (req, res) => {
  try {
    const { latitude, longitude, timezone } = req.body;
    // Unlike /alert, a location share with no usable location is pointless, so
    // this one is a 400 — but it is now an HONEST 400 up front rather than the
    // 500 a string coordinate used to produce halfway through building the
    // email. `!latitude` also rejected the equator and the prime meridian,
    // which a range check does not.
    const coords = readCoords(latitude, longitude);
    if (!coords) {
      return res.status(400).json({ error: 'Location required' });
    }

    const now = Date.now();
    const last = shareCooldowns.get(req.user.id) || 0;
    if (now - last < SHARE_COOLDOWN_MS) {
      return res.status(429).json({ error: 'You shared your location a moment ago. Give it a few minutes.' });
    }
    shareCooldowns.set(req.user.id, now);
    // Round 17: this was `shareCooldowns.clear()`, which handed a fresh window
    // to EVERY user at once — and anyone could force that moment by filling the
    // map. Expire what is actually stale instead, and only then evict
    // oldest-first (matching checkin.js's tapCache).
    if (shareCooldowns.size > SHARE_COOLDOWN_MAX) {
      for (const [k, ts] of shareCooldowns) {
        if (now - ts >= SHARE_COOLDOWN_MS) shareCooldowns.delete(k);
      }
      while (shareCooldowns.size > SHARE_COOLDOWN_MAX) {
        shareCooldowns.delete(shareCooldowns.keys().next().value);
      }
    }

    const contacts = await pool.query(
      'SELECT * FROM trusted_contacts WHERE user_id = $1 ORDER BY created_at ASC LIMIT 5',
      [req.user.id]
    );
    if (contacts.rows.length === 0) {
      return res.status(400).json({ error: 'No trusted contacts set up' });
    }
    if (!contacts.rows.some((c) => isMailableAddress(c.contact_email))) {
      // Same honest refusal as /alert, and it must not burn the 10-minute
      // window on a share that could never have been delivered.
      shareCooldowns.set(req.user.id, last);
      return res.status(400).json({
        error: 'None of your trusted contacts have an email address that can receive mail, so there is nowhere to send this. Add an email to a contact in Safety settings.',
        unreachableContacts: true,
      });
    }

    const user = await pool.query('SELECT name FROM users WHERE id = $1', [req.user.id]);
    const userName = user.rows[0]?.name || 'A Flock user';
    const safeName = escapeHtml(userName);
    const tz = timezone || 'UTC';
    let time;
    try { time = new Date().toLocaleString('en-US', { timeZone: tz, timeZoneName: 'short' }); }
    catch { time = `${new Date().toLocaleString('en-US', { timeZone: 'UTC' })} UTC`; }

    const htmlBody = `
      <div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;padding:20px">
        <div style="background:#e0f2fe;border-radius:12px;padding:20px;text-align:center;margin-bottom:20px">
          <h1 style="color:#0369a1;margin:0 0 8px;font-size:22px">Location Shared</h1>
          <p style="color:#0c4a6e;margin:0;font-size:15px"><strong>${safeName}</strong> shared their location</p>
        </div>
        <p style="font-size:15px;color:#1e293b">${safeName} wants you to know where they are right now.</p>
        <p style="margin:12px 0"><a href="https://maps.google.com/?q=${coords.lat},${coords.lng}" style="display:inline-block;padding:12px 24px;background:#0ea5e9;color:white;text-decoration:none;border-radius:8px;font-weight:bold">View Location on Map</a></p>
        <p style="color:#6b7280;font-size:13px">Coordinates: ${coords.lat.toFixed(6)}, ${coords.lng.toFixed(6)}</p>
        <hr style="border:none;border-top:1px solid #e5e7eb;margin:20px 0">
        <p style="color:#6b7280;font-size:12px">Shared at ${time}</p>
        <p style="color:#9ca3af;font-size:11px">This is an automated message from the Flock app.</p>
      </div>`;

    let emailsSent = 0;
    let emailsSkipped = 0;

    // Same fan-out as /alert (round 12), and the same reachability question.
    const withEmail = contacts.rows.filter((c) => isMailableAddress(c.contact_email));
    emailsSkipped = contacts.rows.length - withEmail.length;
    const settled = await Promise.allSettled(
      withEmail.map((c) => sendAlertEmail(c.contact_email, `📍 ${safeSubjectText(userName)} shared their location with you`, htmlBody))
    );
    for (const outcome of settled) {
      if (outcome.status === 'fulfilled' && outcome.value?.sent) emailsSent++;
      else if (outcome.status === 'rejected') console.error('[Safety] Share email threw:', outcome.reason?.message);
    }

    // Round 17: with every send failed this answered 200 `success: true` and
    // "Location share processed" — App.js puts data.message straight into a
    // toast, so the user was told their location had gone out when nothing
    // had. /alert was fixed for exactly this in the 2026-08-12 audit; the
    // sibling route kept the bug. A failure is a failure, and it gives the
    // ten-minute window back so the retry is possible.
    if (emailsSent === 0) {
      shareCooldowns.set(req.user.id, last);
      return res.status(502).json({
        success: false,
        error: 'Your location could not be sent to any contact. Try again in a moment.',
        canRetry: true,
      });
    }

    const parts = [`Location shared with ${emailsSent} contact${emailsSent > 1 ? 's' : ''}`];
    // "no email" was accurate when the only reason to skip was a missing
    // address. It now also covers an address that cannot receive mail, and a
    // message that names the wrong cause sends the user to the wrong fix.
    if (emailsSkipped > 0) parts.push(`${emailsSkipped} skipped (no usable email address)`);

    res.json({
      success: true,
      message: parts.join(', '),
    });
  } catch (err) {
    console.error('[Safety] Share location error:', err);
    res.status(500).json({ error: 'Failed to share location' });
  }
});

module.exports = router;
// Exposed for __tests__/safetySecurity.test.js and __tests__/safetyFlow.test.js.
// See the checkin.js note: a property on the router changes nothing about the
// mount in server.js.
module.exports.__test = {
  // The flock leg of an SOS. Exposed because the alternative is asserting it
  // through a full HTTP round trip that first has to get past the advisory
  // lock, the sixty second claim window and the email fan-out, none of which
  // this function is about.
  alertFlockMembers,
  notifyFlockStandDown,
  SOS_FLOCK_WINDOW_HOURS,
  readCoords,
  EMAIL_RE,
  MAX_TRUSTED_CONTACTS,
  readContactFields,
  // The column widths these have to stay under live in the migrations, and a
  // limit wider than its column is a 22001 served as "Failed to add contact".
  // __tests__/moderationSafetySweep.test.js diffs the two.
  FIELD_LIMITS,
  phoneError,
  MIN_PHONE_DIGITS,
  escapeHtml,
  safeSubjectText,
  metresBetween,
  isEscalation,
  escalationKind,
  isLocationFollowUp,
  SOS_STAND_DOWN_SNAPSHOT_SQL,
  agoPhrase,
  namePhrase,
  readAccuracy,
  accuracyPhrase,
  COARSE_FIX_METRES,
  CANCEL_WINDOW_MS,
  MAX_CANCELS_PER_WINDOW,
  MAX_CANCEL_ATTEMPTS_PER_WINDOW,
  resetCancels: () => cancelWrites.clear(),
  ALERT_COOLDOWN_MS,
  ALERT_FLOOR_MS,
  LOCATION_FOLLOWUP_WINDOW_MS,
  MAX_ESCALATIONS,
  MAX_ATTEMPTS_PER_WINDOW,
  ESCALATION_METERS,
  MAX_CONTACT_WRITES_PER_HOUR,
  allowContactWrite,
  resetContactWrites: () => contactWrites.clear(),
};
