const express = require('express');
const router = express.Router();
const { Resend } = require('resend');
const { authenticate } = require('../middleware/auth');
const pool = require('../config/database');
const { upstreamSignal } = require('../utils/upstream');
const { stripHtml } = require('../utils/sanitize');

// ── Resend email client (configured via RESEND_API_KEY on Railway) ──
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

// Round 17: users.name is interpolated straight into the alert HTML and into
// the Resend subject line. A display name is user-controlled text that we never
// re-escape on the way out, so `<img src=x onerror=...>` — or, far more
// plausibly on a safety email, `<a href="http://evil">` — landed inside a
// message sent to somebody's mother. Escaping for the HTML context (rather than
// stripping tags) also keeps ordinary names intact: "O'Brien & Sons" renders as
// itself. CR/LF is removed separately because the subject is a header field.
function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
function safeSubjectText(str) {
  return String(str == null ? '' : str).replace(/[\r\n]+/g, ' ').trim().slice(0, 120);
}

async function sendAlertEmail(to, subject, htmlBody) {
  if (!process.env.RESEND_API_KEY) {
    console.warn('[Safety] RESEND_API_KEY not set — skipping email to', to);
    return { skipped: true };
  }
  try {
    // Round 12: the Resend SDK passes request options straight through to
    // fetch, and without a deadline a slow Resend held an EMERGENCY alert open
    // for minutes with nothing sent. 8s budget — see utils/upstream.js.
    const { data, error } = await resend.emails.send({
      from: 'Flock Safety <alerts@flockcorp.com>',
      to,
      subject,
      html: htmlBody,
    }, { signal: upstreamSignal('email') });
    if (error) {
      console.error('[Safety] Resend error for', to, JSON.stringify(error));
      return { sent: false, error: error.message || JSON.stringify(error) };
    }
    console.log('[Safety] Email sent to', to, 'id:', data?.id);
    return { sent: true };
  } catch (err) {
    console.error('[Safety] Email failed for', to, err.message);
    return { sent: false, error: err.message };
  }
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

    const user = await pool.query('SELECT name, email FROM users WHERE id = $1', [req.user.id]);
    if (!user.rows[0]?.email || user.rows[0].email.endsWith('.invalid')) {
      return res.json({ ok: false, error: 'No email address on file' });
    }
    const result = await sendAlertEmail(
      user.rows[0].email,
      'Flock Safety — Test Email',
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

// ── Get user's trusted contacts ──
router.get('/contacts', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM trusted_contacts WHERE user_id = $1 ORDER BY created_at DESC',
      [req.user.id]
    );
    res.json({ contacts: result.rows });
  } catch (err) {
    console.error('[Safety] Get contacts error:', err);
    res.status(500).json({ error: 'Failed to load contacts' });
  }
});

// ── Add trusted contact ──
// Trusted contacts are an EMAIL-SENDING surface, so they're bounded (round 5:
// unbounded contacts + no cooldown made /share-location a harassment relay).
const MAX_TRUSTED_CONTACTS = 5;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

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
const FIELD_LIMITS = { name: 100, phone: 20, email: 255, relationship: 50 };

function readContactFields(body) {
  const name = typeof body.name === 'string' ? stripHtml(body.name).trim() : '';
  const phone = typeof body.phone === 'string' ? body.phone.trim() : '';
  const email = typeof body.email === 'string' ? body.email.trim() : '';
  const relationship = typeof body.relationship === 'string' ? stripHtml(body.relationship).trim() : '';

  if (!name || !phone) return { error: 'Name and phone are required' };
  if (!email) return { error: 'An email address is required — alerts are sent by email' };
  if (!EMAIL_RE.test(email)) return { error: 'That email address does not look right' };
  if (name.length > FIELD_LIMITS.name) return { error: `Name must be ${FIELD_LIMITS.name} characters or fewer` };
  if (phone.length > FIELD_LIMITS.phone) return { error: `Phone number must be ${FIELD_LIMITS.phone} characters or fewer` };
  if (email.length > FIELD_LIMITS.email) return { error: 'That email address is too long' };
  if (relationship.length > FIELD_LIMITS.relationship) return { error: `Relationship must be ${FIELD_LIMITS.relationship} characters or fewer` };

  return { name, phone, email, relationship: relationship || null };
}

router.post('/contacts', authenticate, async (req, res) => {
  try {
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

      const count = await client.query('SELECT COUNT(*)::int AS n FROM trusted_contacts WHERE user_id = $1', [req.user.id]);
      if (count.rows[0].n >= MAX_TRUSTED_CONTACTS) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `You can have up to ${MAX_TRUSTED_CONTACTS} trusted contacts` });
      }

      const result = await client.query(
        `INSERT INTO trusted_contacts (user_id, contact_name, contact_phone, contact_email, relationship)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id, contact_phone) DO UPDATE SET contact_name = $2, contact_email = $4, relationship = $5
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
    const id = contactId(req.params.id);
    if (id === null) return res.status(404).json({ error: 'Contact not found' });
    const fields = readContactFields(req.body);
    if (fields.error) return res.status(400).json({ error: fields.error });
    const { name, phone, email, relationship } = fields;
    const result = await pool.query(
      `UPDATE trusted_contacts SET contact_name = $1, contact_phone = $2, contact_email = $3, relationship = $4
       WHERE id = $5 AND user_id = $6 RETURNING *`,
      [name, phone, email, relationship, id, req.user.id]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Contact not found' });
    }
    res.json({ contact: result.rows[0] });
  } catch (err) {
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

function agoPhrase(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${Math.max(1, s)} second${s === 1 ? '' : 's'} ago`;
  const m = Math.round(s / 60);
  return `${m} minute${m === 1 ? '' : 's'} ago`;
}

router.post('/alert', authenticate, async (req, res) => {
  try {
    const { latitude, longitude, includeLocation, timezone } = req.body;

    // Parsed once, up front, before anything is committed or sent. `coords` is
    // null when the user opted out OR when the client sent something we cannot
    // safely put on a map — both mean "alert without a location", which is a
    // degraded alert, not a failed one.
    const coords = includeLocation === false ? null : readCoords(latitude, longitude);

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
                EXTRACT(EPOCH FROM (NOW() - created_at)) * 1000 AS age_ms,
                (SELECT COUNT(*)::int FROM emergency_alerts e2
                  WHERE e2.user_id = $1
                    AND COALESCE(e2.contacts_alerted, 0) > 0
                    AND e2.created_at > NOW() - ($2::int || ' milliseconds')::interval) AS delivered_in_window,
                (SELECT COUNT(*)::int FROM emergency_alerts e3
                  WHERE e3.user_id = $1
                    AND e3.created_at > NOW() - ($2::int || ' milliseconds')::interval) AS attempts_in_window
         FROM emergency_alerts
         WHERE user_id = $1
         ORDER BY created_at DESC LIMIT 1`,
        [req.user.id, ESCALATION_WINDOW_MS]
      );

      const last = recent.rows[0] || null;
      if (last) {
        const ageMs = Number(last.age_ms) || 0;
        const delivered = last.contacts_alerted > 0;

        // In flight: a claim row with nothing confirmed yet. This is the only
        // refusal that is purely about concurrency, and it lapses in 60s.
        if (!delivered && ageMs < ALERT_FLOOR_MS) {
          await client.query('ROLLBACK');
          return res.status(429).json({
            error: 'An alert is already going out. Give it a moment before trying again.',
          });
        }

        if (delivered && ageMs < ALERT_COOLDOWN_MS) {
          const sentAgo = agoPhrase(ageMs);
          const reached = `${last.contacts_alerted} contact${last.contacts_alerted === 1 ? '' : 's'}`;

          if (ageMs < ALERT_FLOOR_MS) {
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
      if (!contacts.rows.some((c) => c.contact_email)) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: `None of your trusted contacts have an email address, so the alert cannot reach anyone. Add an email to a contact in Safety settings. ${CALL_911}`,
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

    // coords is already numeric and in range, so nothing user-controlled reaches
    // this HTML — the href cannot be broken out of and toFixed cannot throw.
    const locationBlock = coords
      ? `<p style="margin:12px 0"><a href="https://maps.google.com/?q=${coords.lat},${coords.lng}" style="display:inline-block;padding:12px 24px;background:#ef4444;color:white;text-decoration:none;border-radius:8px;font-weight:bold">View Location on Map</a></p>
         <p style="color:#6b7280;font-size:13px">Coordinates: ${coords.lat.toFixed(6)}, ${coords.lng.toFixed(6)}</p>`
      : '<p style="color:#6b7280">Location was not available.</p>';

    const htmlBody = `
      <div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;padding:20px">
        <div style="background:#fee2e2;border-radius:12px;padding:20px;text-align:center;margin-bottom:20px">
          <h1 style="color:#dc2626;margin:0 0 8px;font-size:24px">Emergency Alert</h1>
          <p style="color:#991b1b;margin:0;font-size:16px"><strong>${safeName}</strong> needs help</p>
        </div>
        <p style="font-size:15px;color:#1e293b">${safeName} has triggered an emergency alert on the <strong>Flock</strong> app and may need your assistance.</p>
        ${locationBlock}
        <hr style="border:none;border-top:1px solid #e5e7eb;margin:20px 0">
        <p style="color:#6b7280;font-size:12px">Alert sent at ${time}</p>
        <p style="color:#9ca3af;font-size:11px">This is an automated safety alert from the Flock app. If this is an emergency, call your local emergency number.</p>
      </div>`;

    // The slot is claimed; now send and record what ACTUALLY happened (audit
    // 2026-08-12: the response must never claim a delivery that did not occur).
    const alerts = [];
    let emailsSent = 0;
    let emailsSkipped = 0;

    // Round 12: these went out one at a time and awaited in sequence, so five
    // contacts meant five serial round trips — with the new 8s deadline a
    // brownout would still delay the last contact by half a minute. Fan out and
    // settle: contact 3 is not held hostage by contact 1's slow send, and no
    // single rejection can abort the loop mid-alert.
    const withEmail = contacts.rows.filter((c) => c.contact_email);
    for (const c of contacts.rows) {
      if (!c.contact_email) {
        alerts.push({ contactName: c.contact_name, email: null, sent: false, reason: 'no email' });
        emailsSkipped++;
      }
    }

    const settled = await Promise.allSettled(
      withEmail.map((c) => sendAlertEmail(c.contact_email, `🚨 Emergency Alert from ${safeSubjectText(userName)}`, htmlBody))
    );
    settled.forEach((outcome, i) => {
      const c = withEmail[i];
      const sent = outcome.status === 'fulfilled' && outcome.value?.sent === true;
      if (outcome.status === 'rejected') {
        console.error('[Safety] Alert email threw for', c.contact_email, outcome.reason?.message);
      }
      alerts.push({ contactName: c.contact_name, email: c.contact_email, sent });
      if (sent) emailsSent++;
    });

    // Record what actually happened on the row we already claimed.
    // contacts_alerted = confirmed sends only; leaving it at 0 means the row
    // stops blocking retries once the in-flight window lapses.
    if (emailsSent > 0) {
      await pool.query(
        'UPDATE emergency_alerts SET contacts_alerted = $1 WHERE id = $2',
        [emailsSent, alertId]
      );
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

    if (emailsSent === 0) {
      // Nobody was reached — say so loudly, and the retry path is open now.
      return res.status(502).json({
        success: false,
        error: `Your alert could not be delivered to any contact. ${CALL_911} You can try again right away.`,
        canRetry: true,
        alerts,
      });
    }

    const parts = [`${emailsSent} email${emailsSent > 1 ? 's' : ''} sent`];
    if (emailsSkipped > 0) parts.push(`${emailsSkipped} contact${emailsSkipped > 1 ? 's' : ''} skipped (no email)`);

    res.json({
      success: true,
      message: parts.join(', '),
      alerts,
    });
  } catch (err) {
    console.error('[Safety] Alert error:', err);
    res.status(500).json({ error: 'Failed to send alert' });
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
    if (!contacts.rows.some((c) => c.contact_email)) {
      // Same honest refusal as /alert, and it must not burn the 10-minute
      // window on a share that could never have been delivered.
      shareCooldowns.set(req.user.id, last);
      return res.status(400).json({
        error: 'None of your trusted contacts have an email address, so there is nowhere to send this. Add an email to a contact in Safety settings.',
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

    // Same fan-out as /alert (round 12).
    const withEmail = contacts.rows.filter((c) => c.contact_email);
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
    if (emailsSkipped > 0) parts.push(`${emailsSkipped} skipped (no email)`);

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
  readCoords,
  EMAIL_RE,
  MAX_TRUSTED_CONTACTS,
  readContactFields,
  escapeHtml,
  safeSubjectText,
  metresBetween,
  isEscalation,
  agoPhrase,
  ALERT_COOLDOWN_MS,
  ALERT_FLOOR_MS,
  MAX_ESCALATIONS,
  MAX_ATTEMPTS_PER_WINDOW,
  ESCALATION_METERS,
};
