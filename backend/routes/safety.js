const express = require('express');
const router = express.Router();
const { Resend } = require('resend');
const { authenticate } = require('../middleware/auth');
const pool = require('../config/database');

// ── Resend email client (configured via RESEND_API_KEY on Railway) ──
const resend = new Resend(process.env.RESEND_API_KEY);

async function sendAlertEmail(to, subject, htmlBody) {
  if (!process.env.RESEND_API_KEY) {
    console.warn('[Safety] RESEND_API_KEY not set — skipping email to', to);
    return { skipped: true };
  }
  try {
    await resend.emails.send({
      from: 'Flock Safety <onboarding@resend.dev>',
      to,
      subject,
      html: htmlBody,
    });
    console.log('[Safety] Email sent to', to);
    return { sent: true };
  } catch (err) {
    console.error('[Safety] Email failed for', to, err.message);
    return { sent: false, error: err.message };
  }
}

// ── Test email endpoint ──
router.get('/test-email', authenticate, async (req, res) => {
  if (!process.env.RESEND_API_KEY) {
    return res.json({ ok: false, error: 'RESEND_API_KEY not set' });
  }
  try {
    const user = await pool.query('SELECT name, email FROM users WHERE id = $1', [req.user.id]);
    const result = await sendAlertEmail(
      user.rows[0].email,
      'Flock Safety — Test Email',
      '<div style="font-family:Arial,sans-serif;padding:20px;text-align:center"><h2>It works!</h2><p>Your Flock emergency alerts are set up correctly.</p></div>'
    );
    res.json({ ok: result.sent || false, error: result.error });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

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
router.post('/contacts', authenticate, async (req, res) => {
  try {
    const { name, phone, email, relationship } = req.body;
    if (!name || !phone) {
      return res.status(400).json({ error: 'Name and phone are required' });
    }

    const result = await pool.query(
      `INSERT INTO trusted_contacts (user_id, contact_name, contact_phone, contact_email, relationship)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, contact_phone) DO UPDATE SET contact_name = $2, contact_email = $4, relationship = $5
       RETURNING *`,
      [req.user.id, name.trim(), phone.trim(), email?.trim() || null, relationship?.trim() || null]
    );

    res.status(201).json({ contact: result.rows[0] });
  } catch (err) {
    console.error('[Safety] Add contact error:', err);
    res.status(500).json({ error: 'Failed to add contact' });
  }
});

// ── Delete trusted contact ──
router.delete('/contacts/:id', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM trusted_contacts WHERE id = $1 AND user_id = $2 RETURNING id',
      [req.params.id, req.user.id]
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
router.post('/alert', authenticate, async (req, res) => {
  try {
    const { latitude, longitude, includeLocation } = req.body;

    const contacts = await pool.query(
      'SELECT * FROM trusted_contacts WHERE user_id = $1',
      [req.user.id]
    );
    if (contacts.rows.length === 0) {
      return res.status(400).json({ error: 'No trusted contacts set up' });
    }

    const user = await pool.query('SELECT name FROM users WHERE id = $1', [req.user.id]);
    const userName = user.rows[0]?.name || 'A Flock user';
    const time = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });

    const locationBlock = includeLocation && latitude && longitude
      ? `<p style="margin:12px 0"><a href="https://maps.google.com/?q=${latitude},${longitude}" style="display:inline-block;padding:12px 24px;background:#ef4444;color:white;text-decoration:none;border-radius:8px;font-weight:bold">View Location on Map</a></p>
         <p style="color:#6b7280;font-size:13px">Coordinates: ${latitude.toFixed(6)}, ${longitude.toFixed(6)}</p>`
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

    // Log alert to database
    await pool.query(
      `INSERT INTO emergency_alerts (user_id, latitude, longitude, contacts_alerted)
       VALUES ($1, $2, $3, $4)`,
      [req.user.id, latitude || null, longitude || null, contacts.rows.length]
    );

    // Send emails to contacts that have an email address
    const alerts = [];
    let emailsSent = 0;
    let emailsSkipped = 0;

    for (const c of contacts.rows) {
      if (c.contact_email) {
        const result = await sendAlertEmail(
          c.contact_email,
          `🚨 Emergency Alert from ${userName}`,
          htmlBody
        );
        alerts.push({ contactName: c.contact_name, email: c.contact_email, sent: result.sent || false });
        if (result.sent) emailsSent++;
      } else {
        alerts.push({ contactName: c.contact_name, email: null, sent: false, reason: 'no email' });
        emailsSkipped++;
      }
    }

    const parts = [];
    if (emailsSent > 0) parts.push(`${emailsSent} email${emailsSent > 1 ? 's' : ''} sent`);
    if (emailsSkipped > 0) parts.push(`${emailsSkipped} contact${emailsSkipped > 1 ? 's' : ''} skipped (no email)`);

    res.json({
      success: true,
      message: parts.join(', ') || 'Alert processed',
      alerts,
    });
  } catch (err) {
    console.error('[Safety] Alert error:', err);
    res.status(500).json({ error: 'Failed to send alert' });
  }
});

// ── Share location with trusted contacts ──
router.post('/share-location', authenticate, async (req, res) => {
  try {
    const { latitude, longitude } = req.body;
    if (!latitude || !longitude) {
      return res.status(400).json({ error: 'Location required' });
    }

    const contacts = await pool.query(
      'SELECT * FROM trusted_contacts WHERE user_id = $1',
      [req.user.id]
    );
    if (contacts.rows.length === 0) {
      return res.status(400).json({ error: 'No trusted contacts set up' });
    }

    const user = await pool.query('SELECT name FROM users WHERE id = $1', [req.user.id]);
    const userName = user.rows[0]?.name || 'A Flock user';
    const time = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });

    const htmlBody = `
      <div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;padding:20px">
        <div style="background:#e0f2fe;border-radius:12px;padding:20px;text-align:center;margin-bottom:20px">
          <h1 style="color:#0369a1;margin:0 0 8px;font-size:22px">Location Shared</h1>
          <p style="color:#0c4a6e;margin:0;font-size:15px"><strong>${userName}</strong> shared their location</p>
        </div>
        <p style="font-size:15px;color:#1e293b">${userName} wants you to know where they are right now.</p>
        <p style="margin:12px 0"><a href="https://maps.google.com/?q=${latitude},${longitude}" style="display:inline-block;padding:12px 24px;background:#0ea5e9;color:white;text-decoration:none;border-radius:8px;font-weight:bold">View Location on Map</a></p>
        <p style="color:#6b7280;font-size:13px">Coordinates: ${latitude.toFixed(6)}, ${longitude.toFixed(6)}</p>
        <hr style="border:none;border-top:1px solid #e5e7eb;margin:20px 0">
        <p style="color:#6b7280;font-size:12px">Shared at ${time}</p>
        <p style="color:#9ca3af;font-size:11px">This is an automated message from the Flock app.</p>
      </div>`;

    let emailsSent = 0;
    let emailsSkipped = 0;

    for (const c of contacts.rows) {
      if (c.contact_email) {
        const result = await sendAlertEmail(
          c.contact_email,
          `📍 ${userName} shared their location with you`,
          htmlBody
        );
        if (result.sent) emailsSent++;
      } else {
        emailsSkipped++;
      }
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
