// ---------------------------------------------------------------------------
// Proactive Crowd Alerts
// Checks confirmed flocks with upcoming events and sends push notifications
// when venue is expected to get busy soon.
// ---------------------------------------------------------------------------

const pool = require('../config/database');
const { calculateCrowdScore, generateHourlyForecast } = require('./crowdEngine');
const { getWeather } = require('./weatherService');
const { pushAlways } = require('./pushHelper');

const ALERT_TYPE = 'crowd';

// Round 12: dedupe used to be a per-process Map. server.js runs this sweep in
// the WEB process, so a second Railway instance (or an overlapping deploy)
// meant every member got the same push once per instance, and a restart
// re-sent everything. The marker is now a row in crowd_alert_sends
// (migration 007) claimed with INSERT ... ON CONFLICT DO NOTHING BEFORE any
// push: exactly one process wins the primary key, the rest send nothing.
async function claimAlert(flockId) {
  const { rowCount } = await pool.query(
    `INSERT INTO crowd_alert_sends (flock_id, alert_type)
     VALUES ($1, $2)
     ON CONFLICT (flock_id, alert_type) DO NOTHING`,
    [flockId, ALERT_TYPE]
  );
  return rowCount === 1;
}

async function releaseAlert(flockId) {
  await pool
    .query('DELETE FROM crowd_alert_sends WHERE flock_id = $1 AND alert_type = $2', [flockId, ALERT_TYPE])
    .catch(() => {});
}

async function checkCrowdAlerts() {
  try {
    // Keep the marker table proportional to live flocks. Markers only need to
    // outlive the 3-hour pre-event window they guard.
    await pool
      .query("DELETE FROM crowd_alert_sends WHERE sent_at < NOW() - INTERVAL '7 days'")
      .catch((e) => console.warn('[CrowdAlerts] marker sweep failed:', e.message));

    // Find confirmed flocks with event_time in the next 3 hours that have a venue set
    const { rows: flocks } = await pool.query(`
      SELECT f.id, f.name, f.venue_id, f.venue_name, f.venue_latitude, f.venue_longitude, f.event_time
      FROM flocks f
      WHERE f.status = 'confirmed'
        AND f.venue_id IS NOT NULL
        AND f.event_time > NOW()
        AND f.event_time < NOW() + INTERVAL '3 hours'
    `);

    if (!flocks.length) return;

    for (const flock of flocks) {
      await processFlockAlert(flock);
    }
  } catch (err) {
    console.error('[CrowdAlerts] Error checking alerts:', err.message);
  }
}

async function processFlockAlert(flock) {
  // Cheap pre-check so a flock that was already alerted costs one indexed read
  // instead of a weather call plus a scoring pass. The authoritative claim
  // happens below, right before the pushes go out.
  const already = await pool.query(
    'SELECT 1 FROM crowd_alert_sends WHERE flock_id = $1 AND alert_type = $2',
    [flock.id, ALERT_TYPE]
  );
  if (already.rowCount > 0) return;

  try {
    // Build venue object for crowd engine
    const venue = {
      place_id: flock.venue_id,
      name: flock.venue_name,
      types: [],
      user_ratings_total: 0,
      rating: 0,
    };

    // Try to get venue details from DB if we have them.
    // Round 12: this read named columns that have never existed — ml_venues has
    // google_place_id and google_types, not place_id/types (see
    // database/ml-schema.sql). Every call threw, the catch below swallowed it,
    // and NO confirmed flock has ever received a pre-event crowd push.
    const { rows: venueRows } = await pool.query(
      `SELECT google_types, review_count, rating, price_level
       FROM ml_venues WHERE google_place_id = $1 LIMIT 1`,
      [flock.venue_id]
    );
    if (venueRows.length) {
      venue.types = venueRows[0].google_types || [];
      venue.user_ratings_total = venueRows[0].review_count || 0;
      venue.rating = venueRows[0].rating || 0;
      venue.price_level = venueRows[0].price_level || 0;
    }

    // Get weather data
    let weather = null;
    if (flock.venue_latitude && flock.venue_longitude) {
      try {
        weather = await getWeather(flock.venue_latitude, flock.venue_longitude);
      } catch (e) {
        // Continue without weather
      }
    }

    // Calculate current crowd score
    const now = new Date();
    const currentScore = calculateCrowdScore(venue, weather, now);

    // Calculate score at event time
    const eventScore = calculateCrowdScore(venue, weather, new Date(flock.event_time));

    // Generate hourly forecast for next 3 hours
    const forecast = generateHourlyForecast(venue, weather, now.getHours(), 3, now);
    const peakHour = forecast.reduce((max, h) => h.score > max.score ? h : max, forecast[0]);

    // Decision: alert if venue will be busy (score >= 70) or getting busier
    const willBeBusy = eventScore.score >= 70;
    const gettingBusier = eventScore.score > currentScore.score + 15;
    const peakSoon = peakHour.score >= 75;

    if (!willBeBusy && !gettingBusier && !peakSoon) return;

    // Build notification message
    let title, body;
    const venueName = flock.venue_name || 'Your venue';

    if (eventScore.score >= 85) {
      title = `${venueName} will be packed`;
      body = `Expected to be ${eventScore.label.toLowerCase()} around your flock time. Consider heading out early!`;
    } else if (gettingBusier) {
      title = `${venueName} is filling up`;
      body = `It's ${currentScore.label.toLowerCase()} now but expected to get ${eventScore.label.toLowerCase()} soon. Go now to beat the rush!`;
    } else if (peakSoon) {
      title = `${venueName} is about to peak`;
      body = `Peak time is coming up (${peakHour.hour}). Head out now for a better spot!`;
    } else {
      title = `${venueName} — heads up`;
      body = `Expected to be ${eventScore.label.toLowerCase()} at your flock time.`;
    }

    // Get all accepted members of this flock. Proactive crowd alerts are a
    // Flock Pro perk once the paywall is live; with PAYWALL_ENABLED unset,
    // everyone still gets them (today's behavior).
    const proOnly = process.env.PAYWALL_ENABLED === 'true';
    const { rows: members } = await pool.query(
      proOnly
        ? `SELECT fm.user_id FROM flock_members fm
           JOIN users u ON u.id = fm.user_id
           WHERE fm.flock_id = $1 AND fm.status = 'accepted' AND u.is_premium = true`
        : `SELECT user_id FROM flock_members WHERE flock_id = $1 AND status = 'accepted'`,
      [flock.id]
    );

    if (!members.length) return;

    // Claim BEFORE sending. Losing the race means another instance is already
    // pushing this flock, so stop here rather than double-notifying.
    if (!(await claimAlert(flock.id))) return;

    // Send push to all members
    let delivered = 0;
    try {
      for (const member of members) {
        await pushAlways(member.user_id, title, body, {
          type: 'crowd_alert',
          flockId: String(flock.id),
          score: String(eventScore.score),
          label: eventScore.label,
        });
        delivered += 1;
      }
    } catch (pushErr) {
      // Nothing went out — drop the claim so the next sweep can retry rather
      // than the flock being permanently marked as alerted.
      if (delivered === 0) await releaseAlert(flock.id);
      throw pushErr;
    }

    console.log(`[CrowdAlerts] Sent alert for flock ${flock.id} (${flock.venue_name}): score=${eventScore.score}`);
  } catch (err) {
    console.error(`[CrowdAlerts] Error processing flock ${flock.id}:`, err.message);
  }
}

module.exports = { checkCrowdAlerts };
