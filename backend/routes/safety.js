const express = require('express');
const router = express.Router();
const { Resend } = require('resend');
const { authenticate } = require('../middleware/auth');
const pool = require('../config/database');
const { upstreamSignal } = require('../utils/upstream');

// ── Resend email client (configured via RESEND_API_KEY on Railway) ──
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

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

router.post('/contacts', authenticate, async (req, res) => {
  try {
    const { name, phone, email, relationship } = req.body;
    if (!name || !phone) {
      return res.status(400).json({ error: 'Name and phone are required' });
    }
    if (email && !EMAIL_RE.test(email.trim())) {
      return res.status(400).json({ error: 'That email address does not look right' });
    }

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
        [req.user.id, name.trim(), phone.trim(), email?.trim() || null, relationship?.trim() || null]
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
    const { name, phone, email, relationship } = req.body;
    if (!name || !phone) {
      return res.status(400).json({ error: 'Name and phone are required' });
    }
    if (email && !EMAIL_RE.test(email.trim())) {
      return res.status(400).json({ error: 'That email address does not look right' });
    }
    const result = await pool.query(
      `UPDATE trusted_contacts SET contact_name = $1, contact_phone = $2, contact_email = $3, relationship = $4
       WHERE id = $5 AND user_id = $6 RETURNING *`,
      [name.trim(), phone.trim(), email?.trim() || null, relationship?.trim() || null, id, req.user.id]
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

// ── Send emergency alert (rate limited: 1 per 5 minutes) ──
// Round 9: the cooldown was a SELECT, then every email, then the INSERT that
// armed it. Concurrent taps all read the same empty cooldown and each sent a
// full round of mail to every contact. The claim now happens FIRST, inside a
// transaction holding a per-user advisory lock, so the second request loses.
const ALERT_COOLDOWN_MS = 5 * 60 * 1000;

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

      const recent = await client.query(
        `SELECT created_at, COALESCE(contacts_alerted, 0) AS contacts_alerted
         FROM emergency_alerts
         WHERE user_id = $1
           AND (
             (COALESCE(contacts_alerted, 0) > 0 AND created_at > NOW() - INTERVAL '5 minutes')
             OR (COALESCE(contacts_alerted, 0) = 0 AND created_at > NOW() - INTERVAL '60 seconds')
           )
         ORDER BY created_at DESC LIMIT 1`,
        [req.user.id]
      );
      if (recent.rows.length > 0) {
        await client.query('ROLLBACK');
        const row = recent.rows[0];
        if (row.contacts_alerted === 0) {
          return res.status(429).json({ error: 'An alert is already going out. Give it a moment before trying again.' });
        }
        const cooldownEnd = new Date(new Date(row.created_at).getTime() + ALERT_COOLDOWN_MS);
        const minsLeft = Math.max(1, Math.ceil((cooldownEnd - Date.now()) / 60000));
        return res.status(429).json({ error: `Please wait ${minsLeft} minute${minsLeft > 1 ? 's' : ''} before sending another alert` });
      }

      contacts = await client.query(
        'SELECT * FROM trusted_contacts WHERE user_id = $1',
        [req.user.id]
      );
      if (contacts.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'No trusted contacts set up' });
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

    const tz = timezone || 'UTC';
    let time;
    try { time = new Date().toLocaleString('en-US', { timeZone: tz }); }
    catch { time = new Date().toISOString(); }

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
          <p style="color:#991b1b;margin:0;font-size:16px"><strong>${userName}</strong> needs help</p>
        </div>
        <p style="font-size:15px;color:#1e293b">${userName} has triggered an emergency alert on the <strong>Flock</strong> app and may need your assistance.</p>
        ${locationBlock}
        <hr style="border:none;border-top:1px solid #e5e7eb;margin:20px 0">
        <p style="color:#6b7280;font-size:12px">Alert sent at ${time}</p>
        <p style="color:#9ca3af;font-size:11px">This is an automated safety alert from the Flock app.</p>
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
      withEmail.map((c) => sendAlertEmail(c.contact_email, `🚨 Emergency Alert from ${userName}`, htmlBody))
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
    }

    if (emailsSent === 0) {
      // Nobody was reached — say so loudly and leave the retry path open.
      return res.status(502).json({
        success: false,
        error: 'Your alert could not be delivered to any contact. Call 911 if you are in danger, and try again.',
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

    const last = shareCooldowns.get(req.user.id) || 0;
    if (Date.now() - last < 10 * 60_000) {
      return res.status(429).json({ error: 'You shared your location a moment ago. Give it a few minutes.' });
    }
    shareCooldowns.set(req.user.id, Date.now());
    if (shareCooldowns.size > 5000) shareCooldowns.clear();

    const contacts = await pool.query(
      'SELECT * FROM trusted_contacts WHERE user_id = $1 LIMIT 5',
      [req.user.id]
    );
    if (contacts.rows.length === 0) {
      return res.status(400).json({ error: 'No trusted contacts set up' });
    }

    const user = await pool.query('SELECT name FROM users WHERE id = $1', [req.user.id]);
    const userName = user.rows[0]?.name || 'A Flock user';
    const tz = timezone || 'UTC';
    let time;
    try { time = new Date().toLocaleString('en-US', { timeZone: tz }); }
    catch { time = new Date().toISOString(); }

    const htmlBody = `
      <div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;padding:20px">
        <div style="background:#e0f2fe;border-radius:12px;padding:20px;text-align:center;margin-bottom:20px">
          <h1 style="color:#0369a1;margin:0 0 8px;font-size:22px">Location Shared</h1>
          <p style="color:#0c4a6e;margin:0;font-size:15px"><strong>${userName}</strong> shared their location</p>
        </div>
        <p style="font-size:15px;color:#1e293b">${userName} wants you to know where they are right now.</p>
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
      withEmail.map((c) => sendAlertEmail(c.contact_email, `📍 ${userName} shared their location with you`, htmlBody))
    );
    for (const outcome of settled) {
      if (outcome.status === 'fulfilled' && outcome.value?.sent) emailsSent++;
      else if (outcome.status === 'rejected') console.error('[Safety] Share email threw:', outcome.reason?.message);
    }

    const parts = [];
    if (emailsSent > 0) parts.push(`Location shared with ${emailsSent} contact${emailsSent > 1 ? 's' : ''}`);
    if (emailsSkipped > 0) parts.push(`${emailsSkipped} skipped (no email)`);

    res.json({
      success: true,
      message: parts.join(', ') || 'Location share processed',
    });
  } catch (err) {
    console.error('[Safety] Share location error:', err);
    res.status(500).json({ error: 'Failed to share location' });
  }
});

module.exports = router;
// Exposed for __tests__/safetySecurity.test.js. See the checkin.js note: a
// property on the router changes nothing about the mount in server.js.
module.exports.__test = { readCoords, EMAIL_RE, MAX_TRUSTED_CONTACTS };
