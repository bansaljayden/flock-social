const weatherCache = new Map();
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes

let warnedOnce = false;

function getCacheKey(lat, lon) {
  return `${Number(lat).toFixed(2)},${Number(lon).toFixed(2)}`;
}

function getCached(key) {
  const entry = weatherCache.get(key);
  if (entry && Date.now() - entry.ts < CACHE_TTL) return entry.data;
  if (entry) weatherCache.delete(key);
  return null;
}

function setCache(key, data) {
  weatherCache.set(key, { data, ts: Date.now() });
  if (weatherCache.size > 100) {
    const now = Date.now();
    for (const [k, v] of weatherCache) {
      if (now - v.ts > CACHE_TTL) weatherCache.delete(k);
    }
  }
}

async function getWeather(lat, lon) {
  try {
    const apiKey = process.env.WEATHER_API_KEY;
    if (!apiKey) {
      if (!warnedOnce) {
        console.warn('[Weather] WEATHER_API_KEY not set — skipping weather data');
        warnedOnce = true;
      }
      return null;
    }

    const cacheKey = getCacheKey(lat, lon);
    const cached = getCached(cacheKey);
    if (cached) return cached;

    const url = `https://api.openweathermap.org/data/2.5/weather?lat=${Number(lat).toFixed(2)}&lon=${Number(lon).toFixed(2)}&appid=${apiKey}&units=imperial`;
    const response = await fetch(url);

    if (!response.ok) {
      console.error(`[Weather] API returned ${response.status} for ${cacheKey}`);
      return null;
    }

    const data = await response.json();

    const weatherMain = (data.weather && data.weather[0] && data.weather[0].main) || '';
    const result = {
      temp: data.main.temp,
      feelsLike: data.main.feels_like,
      humidity: data.main.humidity,
      windSpeed: data.wind.speed,
      conditions: (data.weather && data.weather[0] && data.weather[0].description) || '',
      isRaining: ['rain', 'drizzle', 'thunderstorm'].some(w => weatherMain.toLowerCase().includes(w)),
    };

    setCache(cacheKey, result);
    return result;
  } catch (err) {
    console.error('[Weather] Failed to fetch weather:', err.message);
    return null;
  }
}

// 5-day forecast (3-hour intervals) — returns daily summaries
async function getForecast(lat, lon) {
  try {
    const apiKey = process.env.WEATHER_API_KEY;
    if (!apiKey) return null;

    const cacheKey = `forecast_${getCacheKey(lat, lon)}`;
    const cached = getCached(cacheKey);
    if (cached) return cached;

    const url = `https://api.openweathermap.org/data/2.5/forecast?lat=${Number(lat).toFixed(2)}&lon=${Number(lon).toFixed(2)}&appid=${apiKey}&units=imperial`;
    const response = await fetch(url);
    if (!response.ok) return null;

    const data = await response.json();

    // Group by date, pick midday (12:00) or closest entry per day
    const dailyMap = {};
    for (const entry of data.list) {
      const date = entry.dt_txt.split(' ')[0]; // "2026-03-13"
      const hour = parseInt(entry.dt_txt.split(' ')[1].split(':')[0]);
      if (!dailyMap[date] || Math.abs(hour - 12) < Math.abs(dailyMap[date].hour - 12)) {
        dailyMap[date] = {
          hour,
          date,
          temp: entry.main.temp,
          feelsLike: entry.main.feels_like,
          humidity: entry.main.humidity,
          windSpeed: entry.wind.speed,
          conditions: entry.weather?.[0]?.description || '',
          icon: entry.weather?.[0]?.icon || '',
        };
      }
    }

    const result = Object.values(dailyMap).map(({ hour, ...rest }) => rest);
    setCache(cacheKey, result);
    return result;
  } catch (err) {
    console.error('[Weather] Forecast error:', err.message);
    return null;
  }
}

module.exports = { getWeather, getForecast };
