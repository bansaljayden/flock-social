/**
 * WHAT THE PLANS WEATHER CARD CAN SAY.
 *
 * The card over the selected day on the Plans tab draws one reading: today's
 * from GET /api/weather, or one day of GET /api/weather/forecast for a day
 * ahead. Neither promises every number. The current reading is refused by the
 * server only when it has no temperature, so feels-like and humidity arrive as
 * whatever the upstream sent, and a forecast day carries null for each number
 * its upstream entry left out (backend/services/weatherService.js).
 *
 * The card printed all four unconditionally. Math.round(undefined) is NaN and
 * Math.round(null) is 0, so a reading short of a number drew "NaN°", "0°", a
 * bare "%" or "NaN mph", in the same type as the real ones.
 *
 * weatherForCard() answers what can be drawn: null when there is no
 * temperature, which is no card at all (the screen already has a shape for a
 * day with no weather), and otherwise the temperature, the conditions and
 * only the detail cells whose number is one.
 *
 * Pure, and its own module, so the rule can be tested without the screen.
 */
const finite = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

export function weatherForCard(reading) {
  if (!reading || typeof reading !== 'object') return null;
  const temp = finite(reading.temp);
  if (temp === null) return null;
  const feelsLike = finite(reading.feelsLike);
  const humidity = finite(reading.humidity);
  const windSpeed = finite(reading.windSpeed);
  const details = [];
  if (feelsLike !== null) details.push({ key: 'feelsLike', label: 'Feels like', value: `${Math.round(feelsLike)}°`, unit: '' });
  if (humidity !== null) details.push({ key: 'humidity', label: 'Humidity', value: `${Math.round(humidity)}%`, unit: '' });
  if (windSpeed !== null) details.push({ key: 'windSpeed', label: 'Wind', value: String(Math.round(windSpeed)), unit: ' mph' });
  return {
    temp,
    conditions: typeof reading.conditions === 'string' ? reading.conditions : '',
    // A number or null, for the high-wind line: null is never over 20.
    windSpeed,
    details,
  };
}

export default weatherForCard;
