// ---------------------------------------------------------------------------
// Proactive Crowd Alerts
// Checks confirmed flocks with upcoming events and sends push notifications
// when venue is expected to get busy soon.
// ---------------------------------------------------------------------------

const pool = require('../config/database');
const { calculateCrowdScore, generateHourlyForecast, venueLocalNow, weekdayOffset } = require('./crowdEngine');
const { getWeather } = require('./weatherService');
const { pushAlways, isPushConfigured } = require('./pushHelper');

const ALERT_TYPE = 'crowd';

// Minutes to ADD to UTC to reach local time in an IANA zone at instant `at`
// (e.g. -420 for America/Los_Angeles in summer) — the same sign convention
// Google's utcOffsetMinutes uses, so venueLocalNow consumes it unchanged. This
// is how the sweep gets a venue offset: unlike routes/crowd.js it has no Google
// place fetch, but ml_venues stores each venue's IANA timezone (000_bootstrap).
// Returns null for an unknown/blank zone so the caller falls back cleanly.
function offsetMinutesForZone(timeZone, at) {
  if (!timeZone || typeof timeZone !== 'string') return null;
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    const parts = dtf.formatToParts(at);
    const f = {};
    for (const p of parts) f[p.type] = p.value;
    const asUTC = Date.UTC(+f.year, +f.month - 1, +f.day, +f.hour, +f.minute, +f.second);
    if (Number.isNaN(asUTC)) return null;
    return Math.round((asUTC - at.getTime()) / 60000);
  } catch {
    return null; // invalid IANA name
  }
}

// Build a Date whose server-local getDay()/getHours() equal the venue's wall
// clock at `instant`, using the venue offset. Mirrors the routes/crowd.js
// pattern (venueLocalNow + weekdayOffset). Returns `instant` unchanged when we
// have no offset — i.e. the documented server-clock fallback.
function venueWallClock(instant, utcOffsetMinutes) {
  const clock = venueLocalNow(utcOffsetMinutes, instant);
  if (!clock) return { time: instant, hour: instant.getHours(), local: false };
  const t = new Date(instant);
  t.setDate(t.getDate() + weekdayOffset(t.getDay(), clock.day));
  t.setHours(clock.hour, 0, 0, 0);
  return { time: t, hour: clock.hour, local: true };
}

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

// ---------------------------------------------------------------------------
// Is there anything real behind the claim?
//
// When the venue is not in ml_venues, the stub built below carries types [],
// rating 0, review_count 0 — so calculateCrowdScore is scoring the CLOCK, not
// the venue, and "The Pearl will be packed" is a sentence about nothing. This
// app has a standing rule against putting fabricated numbers in front of a
// user, and an unsolicited push to a lock screen is the least recoverable
// place to break it. No venue record, no busyness claim.
// ---------------------------------------------------------------------------
function hasEnoughData({ known, reviews }) {
  return Boolean(known) && Number(reviews) > 0;
}

// One constant, read by both the decision and the copy, so the gate that lets
// an alert out can never disagree with the sentence it produces.
const PEAK_SCORE = 75;

// ---------------------------------------------------------------------------
// The opt-out
//
// This is the app's only UNSOLICITED push: nobody asked for it, it arrives on a
// lock screen, and until now there was no way to stop it short of revoking
// notification permission for the whole app at the OS level. Every other push
// in the codebase answers something the recipient or a friend just did.
//
// WHERE IT IS STORED. user_settings.settings, the JSONB blob that
// GET/PATCH /api/users/settings already reads and merges and that
// frontend/src/services/userSettings.js already syncs to every device. Key:
// `crowdAlerts`. No migration, no new route, no second client path for one
// boolean — the storage and the transport already exist and are already tested.
//
// DEFAULT ON, and the reason is what the alert actually is. It fires only for a
// flock the recipient ACCEPTED, only inside the three hours before an event
// they committed to, only once per flock (the crowd_alert_sends primary key),
// and only when we hold a real venue record with real reviews behind the claim
// (hasEnoughData above). It is about their own evening, not about ours. A
// default of off would mean nobody who never opens settings ever receives it,
// which is not a safer version of the feature, it is the feature deleted with
// extra code. What Apple 4.5.4 and basic trust ask for is a switch that works,
// and that is what this is.
//
// WHY IT TOLERATES A STRING. frontend/src/services/userSettings.js pullSettings
// writes every synced value into localStorage with String(value), and
// readLocalSettings pushes those raw strings back up on a first sync — so a
// boolean false round-trips into this column as the JSON string "false". A
// reader that only understood booleans would read a switched-off account as
// switched on, which is exactly the failure this code exists to prevent.
//
// Anything we cannot read means UNSET, not off: junk in the blob must not
// silently stop a notification the user never asked to stop.
const CROWD_ALERT_KEY = 'crowdAlerts';
const OFF_VALUES = new Set(['false', '0', 'off', 'no']);

function wantsCrowdAlerts(settings) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return true;
  const v = settings[CROWD_ALERT_KEY];
  if (v === undefined || v === null) return true;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return !OFF_VALUES.has(v.trim().toLowerCase());
  return true;
}

// The forecast's first entry is the hour ALREADY IN PROGRESS. Announcing it as
// "peak time is coming up" told people to hurry toward a peak they were
// standing in. Only a later hour can be news.
function pickPeak(forecast) {
  const upcoming = (forecast || []).slice(1);
  if (!upcoming.length) return null;
  return upcoming.reduce((max, h) => (h.score > max.score ? h : max), upcoming[0]);
}

// ---------------------------------------------------------------------------
// Copy
//
// Pure so the sentences can be tested without a database. Two things it exists
// to prevent, both of which shipped:
//   * an em dash in user-visible text (SLOP-AUDIT rule 1);
//   * "It's moderate now but expected to get moderate soon." The rule engine's
//     label bands are 20/40/60/80, so a 41 -> 57 climb clears the +15 "getting
//     busier" trigger without changing the word, and the sentence contradicted
//     itself. The alert is still worth sending; it just has to say what it
//     actually knows.
// ---------------------------------------------------------------------------
function buildAlertMessage({ venueName, currentScore, eventScore, peak }) {
  const name = venueName || 'Your venue';
  const soon = String(eventScore.label || '').toLowerCase();
  const now = String(currentScore.label || '').toLowerCase();
  const gettingBusier = eventScore.score > currentScore.score + 15;
  const peakSoon = Boolean(peak) && peak.score >= PEAK_SCORE;

  if (eventScore.score >= 85) {
    return {
      title: `${name} will be packed`,
      body: `Expected to be ${soon} around your flock time. Worth heading out early.`,
    };
  }
  if (gettingBusier) {
    return {
      title: `${name} is filling up`,
      body: soon === now
        ? `It's ${now} right now and still filling up before your flock time. Going early beats the rush.`
        : `It's ${now} right now and expected to be ${soon} by your flock time. Going early beats the rush.`,
    };
  }
  if (peakSoon) {
    return {
      title: `${name} is about to peak`,
      body: `The busiest stretch starts around ${peak.hour}. Head out now for a better spot.`,
    };
  }
  return {
    title: `Heads up about ${name}`,
    body: `Expected to be ${soon} at your flock time.`,
  };
}

async function checkCrowdAlerts() {
  // Nothing below can be delivered without Firebase, and the sweep is not
  // free: a marker sweep, a flock scan, an ml_venues read and a QUOTA-BEARING
  // weather fetch per flock. Worse, it claimed each flock in crowd_alert_sends
  // before pushing, so on a deployment with push unconfigured every upcoming
  // flock was permanently marked "already alerted" and would never be alerted
  // once Firebase was configured.
  if (!isPushConfigured()) return;

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
  try {
    // Cheap pre-check so a flock that was already alerted costs one indexed
    // read instead of a weather call plus a scoring pass. The authoritative
    // claim happens below, right before the pushes go out.
    //
    // Inside the try: this read used to sit outside it, so a single failure
    // here rejected out of processFlockAlert, and the caller's `for` loop is
    // wrapped in one try for the whole sweep — one unlucky flock cancelled the
    // alerts for every flock behind it in the list.
    const already = await pool.query(
      'SELECT 1 FROM crowd_alert_sends WHERE flock_id = $1 AND alert_type = $2',
      [flock.id, ALERT_TYPE]
    );
    if (already.rowCount > 0) return;

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
      `SELECT google_types, review_count, rating, price_level, timezone
       FROM ml_venues WHERE google_place_id = $1 LIMIT 1`,
      [flock.venue_id]
    );
    let venueTimezone = null;
    if (venueRows.length) {
      venue.types = venueRows[0].google_types || [];
      // Number(): ml_venues.rating is NUMERIC(2,1), and node-postgres hands
      // NUMERIC back as a STRING. The rule engine only ever subtracts from it
      // so the coercion happens implicitly today, but a single `+` anywhere
      // downstream would concatenate instead of add, and routes/crowd.js feeds
      // the same field a real number from Google. Same shape in, same shape out.
      venue.user_ratings_total = Number(venueRows[0].review_count) || 0;
      venue.rating = Number(venueRows[0].rating) || 0;
      venue.price_level = Number(venueRows[0].price_level) || 0;
      venueTimezone = venueRows[0].timezone || null;
    }

    // Bail BEFORE the paid weather call: a venue we hold no record of cannot
    // support a busyness claim, so there is nothing to spend a weather unit on.
    if (!hasEnoughData({ known: venueRows.length > 0, reviews: venue.user_ratings_total })) return;

    // Get weather data
    let weather = null;
    if (flock.venue_latitude && flock.venue_longitude) {
      try {
        weather = await getWeather(flock.venue_latitude, flock.venue_longitude);
      } catch (e) {
        // Continue without weather
      }
    }

    // WHOSE CLOCK: the VENUE's, not the WEB process's UTC. calculateCrowdScore
    // and generateHourlyForecast read .getHours()/.getDay() off the timestamp,
    // which run in the server's zone — so a bar in Los Angeles was scored on a
    // London hour and (near midnight) the wrong DATE, which drives the holiday
    // and special-night features. We derive the offset from ml_venues.timezone
    // and score on the venue's wall clock, matching routes/crowd.js.
    //
    // Fallback: when the venue's ml_venues row carries a blank or invalid
    // timezone we have no offset here — the sweep does no Google fetch, so the
    // server clock stands in, exactly the pre-existing behaviour. (A venue with
    // no ml_venues row at all no longer reaches this point: hasEnoughData above
    // refuses to make a busyness claim about a venue we hold no record of.)
    const now = new Date();
    const utcOffsetMinutes = offsetMinutesForZone(venueTimezone, now);
    // The rule engine (calculateCrowdScore) scores off the timestamp's own
    // getHours()/getDay(), so the venue-local timestamps below are what fix the
    // clock — it never reads this field. Set it anyway so a future swap to the
    // ML predictor (which needs it for the event window) stays correct.
    venue.utcOffsetMinutes = utcOffsetMinutes;

    // Calculate current crowd score on the venue's clock
    const nowClock = venueWallClock(now, utcOffsetMinutes);
    const currentScore = calculateCrowdScore(venue, weather, nowClock.time);

    // Calculate score at event time on the venue's clock. The offset can drift
    // across a DST boundary between now and the event, but the event is <3h out,
    // so re-deriving at the event instant is not worth the second Intl call.
    const eventClock = venueWallClock(new Date(flock.event_time), utcOffsetMinutes);
    const eventScore = calculateCrowdScore(venue, weather, eventClock.time);

    // Generate hourly forecast for next 3 hours, starting on the venue's hour.
    // The peak is taken from the hours still AHEAD — index 0 is the hour the
    // venue is already in, and "about to peak" about right now is not news.
    const forecast = generateHourlyForecast(venue, weather, nowClock.hour, 3, nowClock.time);
    const peak = pickPeak(forecast);

    // Decision: alert if venue will be busy (score >= 70) or getting busier
    const willBeBusy = eventScore.score >= 70;
    const gettingBusier = eventScore.score > currentScore.score + 15;
    const peakSoon = Boolean(peak) && peak.score >= PEAK_SCORE;

    if (!willBeBusy && !gettingBusier && !peakSoon) return;

    const { title, body } = buildAlertMessage({
      venueName: flock.venue_name,
      currentScore,
      eventScore,
      peak,
    });

    // Get all accepted members of this flock. Proactive crowd alerts are a
    // Flock Pro perk once the paywall is live; with PAYWALL_ENABLED unset,
    // everyone still gets them (today's behavior).
    //
    // The LEFT JOIN carries each recipient's settings blob back with them so
    // the opt-out is decided here, in wantsCrowdAlerts, rather than in a SQL
    // predicate that no test can read. LEFT, not INNER: most accounts have never
    // written a settings row at all, and those accounts are opted IN.
    const proOnly = process.env.PAYWALL_ENABLED === 'true';
    const { rows: candidates } = await pool.query(
      proOnly
        ? `SELECT fm.user_id, us.settings AS user_settings
           FROM flock_members fm
           JOIN users u ON u.id = fm.user_id
           LEFT JOIN user_settings us ON us.user_id = fm.user_id
           WHERE fm.flock_id = $1 AND fm.status = 'accepted' AND u.is_premium = true`
        : `SELECT fm.user_id, us.settings AS user_settings
           FROM flock_members fm
           LEFT JOIN user_settings us ON us.user_id = fm.user_id
           WHERE fm.flock_id = $1 AND fm.status = 'accepted'`,
      [flock.id]
    );

    // Filtered BEFORE the claim below, deliberately. A flock whose every member
    // has switched these off must not burn its one crowd_alert_sends row on a
    // notification that goes nowhere: the row is the permanent "already alerted"
    // marker, and writing it here would silently disable the alert for anyone
    // who joins the flock afterwards.
    const members = candidates.filter((m) => wantsCrowdAlerts(m.user_settings));

    if (!members.length) return;

    // Claim BEFORE sending. Losing the race means another instance is already
    // pushing this flock, so stop here rather than double-notifying.
    if (!(await claimAlert(flock.id))) return;

    // Send push to all members. Concurrent and allSettled: this is a background
    // sweep, but it was N sequential round trips to Google inside a loop that
    // holds the claim, so a restart part-way through left the flock marked as
    // alerted with most members never told.
    const outcomes = await Promise.allSettled(
      members.map((member) => pushAlways(member.user_id, title, body, {
        type: 'crowd_alert',
        flockId: String(flock.id),
        score: String(eventScore.score),
        label: eventScore.label,
      }))
    );

    // "Delivered" means a notification actually reached a device, not that a
    // call returned. pushAlways answers `{ skipped }` for a recipient the
    // visibility gate suppressed and `{ sent: 0 }` for one with no registered
    // device; counting those as delivery left the flock permanently marked as
    // alerted on the strength of nothing having been sent.
    const delivered = outcomes.reduce((n, o) => {
      const r = o.status === 'fulfilled' ? o.value : null;
      return n + (r && !r.skipped && r.sent > 0 ? 1 : 0);
    }, 0);

    if (delivered === 0) {
      // Drop the claim so a later sweep can retry rather than the flock being
      // permanently marked as alerted.
      await releaseAlert(flock.id);
      return;
    }

    console.log(`[CrowdAlerts] Sent alert for flock ${flock.id} (${flock.venue_name}): score=${eventScore.score}, delivered=${delivered}`);
  } catch (err) {
    console.error(`[CrowdAlerts] Error processing flock ${flock.id}:`, err.message);
  }
}

module.exports = { checkCrowdAlerts };
// Exposed for backend/__tests__/venueClockConsistency.test.js: the venue-clock
// derivation (IANA zone -> offset -> wall clock) is internal, so its edge cases
// (missing zone -> server-clock fallback, fractional +330 offsets, date roll
// near UTC midnight) are invisible to the route-level tests otherwise.
// backend/__tests__/pushDeliveryHardening.test.js drives the alert copy and the
// two gates in front of it directly: the sentences are what land on a lock
// screen, and reaching them through the whole sweep would need a scripted
// weather API and a scripted crowd model to say anything about them.
// backend/__tests__/alertPreferences.test.js drives wantsCrowdAlerts directly:
// it is the whole opt-out, it has to survive a boolean, a string and a junk
// value, and reaching every one of those through the sweep would be six
// scripted databases to test one function.
module.exports.__testables = { offsetMinutesForZone, venueWallClock, buildAlertMessage, pickPeak, hasEnoughData, wantsCrowdAlerts };
