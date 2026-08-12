// ---------------------------------------------------------------------------
// Special-night lookup — resolves a city + local date against holidays.json's
// research layers (see generate_holidays.py). Used to stamp collection rows so
// future retrains can learn holiday/eve effects. Zero network, pure lookup.
// ---------------------------------------------------------------------------

const HOLIDAYS = require('./holidays.json');

function calendarKey(cityKey) {
  return HOLIDAYS.cities?.[cityKey] || null; // e.g. 'US_NY'
}

// {name, effect: 'boost'|'suppress'|'mixed', conf: 'high'|'med'|'low'} | null.
// Country layer first, city layer wins on collisions.
function specialNightFor(cityKey, dateStr) {
  const cal = calendarKey(cityKey);
  if (!cal) return null;
  const country = cal.split('_')[0];
  const sn = HOLIDAYS.special_nights || {};
  return (sn[cityKey] && sn[cityKey][dateStr]) || (sn[country] && sn[country][dateStr]) || null;
}

function nextDateStr(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

// True when tomorrow is an official public holiday in the city's calendar —
// the eve is the bar night (Thanksgiving Eve pattern).
function isHolidayEve(cityKey, dateStr) {
  const cal = calendarKey(cityKey);
  if (!cal) return false;
  const dates = HOLIDAYS.holidays?.[cal] || [];
  return dates.includes(nextDateStr(dateStr));
}

// ---------------------------------------------------------------------------
// Inference-side context (v2.5 feature parity with prepare_features.py's
// add_holiday_features — weights and semantics must stay identical)
// ---------------------------------------------------------------------------

const { CITIES } = require('./config');
const CONF_W = { high: 1.0, med: 0.6, low: 0.3 };

function haversineKm(lat1, lng1, lat2, lng2) {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}

function nearestCityKey(lat, lng) {
  let best = null;
  let bestKm = Infinity;
  for (const [key, c] of Object.entries(CITIES)) {
    const km = haversineKm(lat, lng, c.lat, c.lon);
    if (km < bestKm) { bestKm = km; best = key; }
  }
  return { key: best, km: bestKm };
}

// {is_special_night, special_boost, special_suppress, is_holiday_eve} for an
// arbitrary venue location. Within 250km of a training city: that city's full
// context. Otherwise, inside the continental US: US country layer only (real
// Flock venues are US; city-scoped entries like Pride would be wrong there).
// Anywhere else: zeros — honest "we don't know", same as training rows
// without a date.
function specialNightContext(lat, lng, dateStr) {
  const zeros = { is_special_night: 0, special_boost: 0, special_suppress: 0, is_holiday_eve: 0 };
  if (!lat || !lng || !dateStr) return zeros;

  const { key, km } = nearestCityKey(lat, lng);
  let hit = null;
  let calKey = null;
  if (key && km <= 250) {
    hit = specialNightFor(key, dateStr);
    calKey = calendarKey(key);
  } else if (lat >= 24 && lat <= 49 && lng >= -125 && lng <= -66) {
    hit = (HOLIDAYS.special_nights?.US || {})[dateStr] || null;
    calKey = Object.keys(HOLIDAYS.holidays || {}).find(k => k.startsWith('US')) || null;
  } else {
    return zeros;
  }

  const w = hit ? (CONF_W[hit.conf] ?? 0.3) : 0;
  const eveDates = calKey ? (HOLIDAYS.holidays?.[calKey] || []) : [];
  return {
    is_special_night: hit ? 1 : 0,
    special_boost: hit && hit.effect === 'boost' ? w : 0,
    special_suppress: hit && hit.effect === 'suppress' ? w : 0,
    is_holiday_eve: eveDates.includes(nextDateStr(dateStr)) ? 1 : 0,
  };
}

module.exports = { specialNightFor, isHolidayEve, specialNightContext };
