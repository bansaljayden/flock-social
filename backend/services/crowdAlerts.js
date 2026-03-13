// ---------------------------------------------------------------------------
// Proactive Crowd Alerts
// Checks confirmed flocks with upcoming events and sends push notifications
// when venue is expected to get busy soon.
// ---------------------------------------------------------------------------

const pool = require('../config/database');
const { calculateCrowdScore, generateHourlyForecast } = require('./crowdEngine');
const { getWeather } = require('./weatherService');
const { pushAlways } = require('./pushHelper');

// Track which alerts we've already sent: `${flockId}:${alertType}` -> timestamp
const sentAlerts = new Map();

// Clean up old entries every hour
setInterval(() => {
  const now = Date.now();
  for (const [key, ts] of sentAlerts) {
    if (now - ts > 6 * 60 * 60 * 1000) sentAlerts.delete(key);
  }
}, 60 * 60 * 1000);

async function checkCrowdAlerts() {
  try {
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
  const alertKey = `${flock.id}:crowd`;

  // Already sent an alert for this flock
  if (sentAlerts.has(alertKey)) return;

  try {
    // Build venue object for crowd engine
    const venue = {
      place_id: flock.venue_id,
      name: flock.venue_name,
      types: [],
      user_ratings_total: 0,
      rating: 0,
    };

    // Try to get venue details from DB if we have them
    const { rows: venueRows } = await pool.query(
      `SELECT types, review_count, rating, price_level FROM ml_venues WHERE place_id = $1 LIMIT 1`,
      [flock.venue_id]
    );
    if (venueRows.length) {
      venue.types = venueRows[0].types || [];
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

    // Get all accepted members of this flock
    const { rows: members } = await pool.query(
      `SELECT user_id FROM flock_members WHERE flock_id = $1 AND status = 'accepted'`,
      [flock.id]
    );

    // Send push to all members
    for (const member of members) {
      await pushAlways(member.user_id, title, body, {
        type: 'crowd_alert',
        flockId: String(flock.id),
        score: String(eventScore.score),
        label: eventScore.label,
      });
    }

    // Mark as sent so we don't spam
    sentAlerts.set(alertKey, Date.now());

    console.log(`[CrowdAlerts] Sent alert for flock ${flock.id} (${flock.venue_name}): score=${eventScore.score}`);
  } catch (err) {
    console.error(`[CrowdAlerts] Error processing flock ${flock.id}:`, err.message);
  }
}

module.exports = { checkCrowdAlerts };
