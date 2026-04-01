// ---------------------------------------------------------------------------
// BestTime API Wrapper — placeholder-ready
// When BESTTIME_API_KEY is not set, functions return null gracefully.
// ---------------------------------------------------------------------------

const { sleep } = require('./config');

let warnedOnce = false;

function getKey() {
  const key = process.env.BESTTIME_API_KEY;
  if (!key && !warnedOnce) {
    console.warn('[ML:BestTime] BESTTIME_API_KEY not set — skipping BestTime calls');
    warnedOnce = true;
  }
  return key;
}

// Fetch weekly forecast for a venue (7 days × 24 hours of busyness %)
// Returns: { venueId, days: [{ dayInt, dayText, hours: [0-100 × 24] }], epochAnalysis }
async function fetchWeeklyForecast(venueName, venueAddress, existingVenueId) {
  const apiKey = getKey();
  if (!apiKey) return null;

  try {
    const params = existingVenueId
      ? new URLSearchParams({ api_key_private: apiKey, venue_id: existingVenueId })
      : new URLSearchParams({ api_key_private: apiKey, venue_name: venueName, venue_address: venueAddress });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    const response = await fetch(`https://besttime.app/api/v1/forecasts?${params}`, {
      method: 'POST',
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) {
      console.error(`[ML:BestTime] Weekly forecast failed (${response.status}) for ${venueName}`);
      return null;
    }

    const data = await response.json();

    if (!data.analysis || data.status !== 'OK') {
      console.error(`[ML:BestTime] No analysis data for ${venueName}:`, data.message || 'unknown error');
      return null;
    }

    const days = data.analysis.map(day => ({
      dayInt: day.day_info.day_int,       // BestTime: Mon=0..Sun=6
      dayText: day.day_info.day_text,
      hours: day.day_raw || [],           // array of 24 busyness values (0-100)
    }));

    await sleep(150);

    return {
      venueId: data.venue_info?.venue_id || null,
      days,
      epochAnalysis: data.epoch_analysis || null,
    };
  } catch (err) {
    console.error(`[ML:BestTime] Weekly forecast error for ${venueName}:`, err.message);
    return null;
  }
}

// Fetch live busyness for a venue
// Returns: { forecastedBusyness, liveBusyness, liveAvailable, hour, venueOpen }
async function fetchLiveBusyness(venueId) {
  const apiKey = getKey();
  if (!apiKey) return null;
  if (!venueId) {
    console.warn('[ML:BestTime] No venue_id for live query — run weekly forecast first');
    return null;
  }

  try {
    const params = new URLSearchParams({ api_key_private: apiKey, venue_id: venueId });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    const response = await fetch(`https://besttime.app/api/v1/forecasts/live?${params}`, {
      method: 'GET',
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) {
      console.error(`[ML:BestTime] Live query failed (${response.status}) for ${venueId}`);
      return null;
    }

    const data = await response.json();

    if (data.status !== 'OK') {
      return null;
    }

    await sleep(150);

    return {
      forecastedBusyness: data.analysis?.venue_forecasted_busyness ?? null,
      liveBusyness: data.analysis?.venue_live_busyness ?? null,
      liveAvailable: data.analysis?.venue_live_busyness_available ?? false,
      hour: data.analysis?.hour_analysis ?? null,
      venueOpen: data.analysis?.venue_open ?? null,
    };
  } catch (err) {
    console.error(`[ML:BestTime] Live query error for ${venueId}:`, err.message);
    return null;
  }
}

module.exports = { fetchWeeklyForecast, fetchLiveBusyness };
