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

module.exports = { specialNightFor, isHolidayEve };
