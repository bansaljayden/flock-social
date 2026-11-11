/**
 * THE PLANS WEATHER CARD SHOWS THE WEATHER WHERE YOU ARE, AND ONLY NUMBERS IT HAS.
 *
 * The card over the selected day on the Plans tab printed "NaN°" under "Feels
 * like", a bare "%" under "Humidity" and "NaN mph" under "Wind", and its big
 * number could be another town's temperature.
 *
 * Both came from one leftover. A crowd answer carries a weather of its own:
 * the venue's (for a batch of scores, the first venue's on the list), holding
 * a temperature and a word and nothing else. Three places in App.js copied
 * that into the Plans reading, over the full reading the Plans tab had taken
 * at the person's own location. So opening a venue, or the Discover map
 * loading its scores, replaced "today" on Plans with a reading from somewhere
 * else that was three numbers short, and the card rounded the missing ones.
 *
 * Fixed in two places, each tested here:
 *
 *   1. lib/weatherCard.js decides what a reading can put on the card: no
 *      temperature is no card, and a number that did not arrive has no cell.
 *      A forecast day can be short of numbers too (the server sends null for
 *      each one its upstream left out), and Math.round(null) printed "0°".
 *   2. App.js keeps one writer for the reading, the Plans weather effect, and
 *      a failed read there is asked again after a minute rather than after
 *      thirty.
 *
 * The screen is rendered for real with stand-in props; the App.js half is a
 * source contract, because the effect lives inside FlockAppInner.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npm test -- --watchAll=false --testPathPattern=plansWeatherCard
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import CalendarScreen from '../screens/CalendarScreen';
import { weatherForCard } from '../lib/weatherCard';

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(SRC, ...p), 'utf8').replace(/\r\n/g, '\n');
const APP_SRC = read('App.js');
const SCREEN_SRC = read('screens', 'CalendarScreen.js');
const WEATHER_SERVICE_SRC = read('..', '..', 'backend', 'services', 'weatherService.js');
const CROWD_ROUTE_SRC = read('..', '..', 'backend', 'routes', 'crowd.js');

/** GET /api/weather, the way weatherService.getWeather answers. */
const FULL = {
  temp: 47.3, feelsLike: 43.6, humidity: 61, windSpeed: 9.2,
  conditions: 'scattered clouds', conditionId: 802, isRaining: false, fetchedAt: '2026-11-14T18:00:00.000Z',
};
/** The weather a crowd answer carries: a temperature and a word. */
const CROWD_SHAPED = { temp: 51.6, conditions: 'light rain' };

describe('weatherForCard: what a reading can put on the card', () => {
  test('a full reading gives the temperature, the word and all three cells, rounded', () => {
    const card = weatherForCard(FULL);
    expect(card.temp).toBe(47.3);
    expect(card.conditions).toBe('scattered clouds');
    expect(card.windSpeed).toBe(9.2);
    expect(card.details).toEqual([
      { key: 'feelsLike', label: 'Feels like', value: '44°', unit: '' },
      { key: 'humidity', label: 'Humidity', value: '61%', unit: '' },
      { key: 'windSpeed', label: 'Wind', value: '9', unit: ' mph' },
    ]);
  });

  test('a temperature and a word, and nothing else, is a card with no cells', () => {
    const card = weatherForCard(CROWD_SHAPED);
    expect(card).toEqual({ temp: 51.6, conditions: 'light rain', windSpeed: null, details: [] });
  });

  test('a number that did not arrive has no cell, and the others keep theirs', () => {
    // A forecast day as the server builds it when the upstream entry had no
    // feels-like and no humidity: null for each.
    const card = weatherForCard({ date: '2026-11-15', temp: 58.4, feelsLike: null, humidity: null, windSpeed: 22.8, conditions: 'light snow', icon: '13d' });
    expect(card.details.map(d => d.key)).toEqual(['windSpeed']);
    expect(card.details[0].value).toBe('23');
    expect(card.windSpeed).toBe(22.8);
  });

  test('a calm day is a number: wind 0 and humidity 0 keep their cells', () => {
    const card = weatherForCard({ temp: 0, feelsLike: -0.4, humidity: 0, windSpeed: 0, conditions: 'clear sky' });
    expect(card.temp).toBe(0);
    expect(card.details.map(d => `${d.label} ${d.value}${d.unit}`)).toEqual(['Feels like 0°', 'Humidity 0%', 'Wind 0 mph']);
  });

  test('no temperature is no card', () => {
    [undefined, null, NaN, Infinity, -Infinity, '47', '', true, {}, []].forEach((temp) => {
      expect(weatherForCard({ ...FULL, temp })).toBeNull();
    });
    const { temp, ...withoutTemp } = FULL;
    expect(temp).toBe(47.3);
    expect(weatherForCard(withoutTemp)).toBeNull();
  });

  test('nothing, or something that is not a reading, is no card', () => {
    [undefined, null, false, 0, 47, 'sunny', []].forEach((reading) => {
      expect(weatherForCard(reading)).toBeNull();
    });
  });

  test('numbers that are not numbers are left out, never rounded', () => {
    const card = weatherForCard({ temp: 61, feelsLike: NaN, humidity: '55', windSpeed: Infinity, conditions: 42 });
    expect(card).toEqual({ temp: 61, conditions: '', windSpeed: null, details: [] });
  });
});

// --- the screen, rendered ---------------------------------------------------

const NOW = new Date(2026, 10, 14, 13, 0, 0); // a Saturday, early afternoon
const TOMORROW = new Date(2026, 10, 15, 12, 0, 0);
const formatDateStr = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const nothing = () => {};
const None = () => null;

/** The Plans screen on a day with no plans, with the props App.js hands it. */
function plans(over = {}) {
  const props = {
    EmptyMark: None,
    ListSkeleton: None,
    SearchInputLocal: None,
    // App.js hands these two over as functions the screen calls.
    BottomNav: () => null,
    SafetyButton: () => null,
    addEventToCalendar: nothing,
    calendarError: '',
    calendarLoading: false,
    calendarMonth: NOW,
    colors: {
      navy: '#0d2847', navyBg: '#0d2847', navyMidBg: '#1a3a5c', steel: '#2d5a87', amber: '#F59E0B',
      foodText: '#b45309', nightlife: '#7c3aed', music: '#be185d', textSecondary: '#556274', creamDark: '#e7e0d2', red: '#EF4444',
    },
    confirmClick: nothing,
    feedScroll: { calendar: { ref: null, onScroll: nothing } },
    flocksError: '',
    flocksLoading: false,
    formatDateStr,
    getDaysInMonth: (d) => new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate(),
    getEventsForDate: () => [],
    getFirstDayOfMonth: (d) => new Date(d.getFullYear(), d.getMonth(), 1).getDay(),
    isDark: false,
    liveWeather: null,
    loadCalendar: nothing,
    loadFlocks: nothing,
    newEventCategory: 'social',
    newEventTime: '',
    newEventTitle: '',
    newEventVenue: '',
    removeCalendarEvent: nothing,
    selectedDate: NOW,
    setCalendarMonth: nothing,
    setCurrentScreen: nothing,
    setCurrentTab: nothing,
    setNewEventCategory: nothing,
    setNewEventTime: nothing,
    setNewEventTitle: nothing,
    setNewEventVenue: nothing,
    setSelectedDate: nothing,
    setSelectedFlockId: nothing,
    setShowAddEvent: nothing,
    showAddEvent: false,
    styles: { card: {}, input: {} },
    weatherForecast: [],
    ...over,
  };
  return render(<CalendarScreen {...props} />);
}

/** The value drawn under a cell's label. */
const under = (label) => screen.getByText(label).nextSibling.textContent;
/** A percent sign with no number in front of it. */
const BARE_PERCENT = /(^|[^0-9])%/;

describe('the Plans screen draws only what the reading carries', () => {
  beforeEach(() => {
    // The screen reads the clock to know which day is today.
    jest.useFakeTimers('modern');
    jest.setSystemTime(NOW);
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  test('today, with a full reading: the temperature, the word and three cells', () => {
    const { container } = plans({ liveWeather: FULL });
    expect(screen.getByText('47°')).toBeTruthy();
    expect(screen.getByText('Scattered clouds')).toBeTruthy();
    expect(under('Feels like')).toBe('44°');
    expect(under('Humidity')).toBe('61%');
    expect(under('Wind')).toBe('9 mph');
    expect(container.textContent).not.toContain('NaN');
  });

  test('a reading with a temperature and a word draws those and no cells', () => {
    // What the crowd copies left on the card. It printed "NaN°", "%" and
    // "NaN mph" here.
    const { container } = plans({ liveWeather: CROWD_SHAPED });
    expect(screen.getByText('52°')).toBeTruthy();
    expect(screen.getByText('Light rain')).toBeTruthy();
    expect(screen.getByText('Rain expected. Indoor spots are the move')).toBeTruthy();
    expect(screen.queryByText('Feels like')).toBeNull();
    expect(screen.queryByText('Humidity')).toBeNull();
    expect(screen.queryByText('Wind')).toBeNull();
    expect(container.textContent).not.toContain('NaN');
    expect(container.textContent).not.toMatch(BARE_PERCENT);
    expect(container.textContent).not.toContain('mph');
  });

  test('a reading short of one number draws the other two', () => {
    const { feelsLike, ...noFeelsLike } = FULL;
    expect(feelsLike).toBe(43.6);
    const { container } = plans({ liveWeather: noFeelsLike });
    expect(screen.queryByText('Feels like')).toBeNull();
    expect(under('Humidity')).toBe('61%');
    expect(under('Wind')).toBe('9 mph');
    expect(container.textContent).not.toContain('NaN');
  });

  test('a day ahead draws its forecast, and a forecast short of numbers prints no "0°"', () => {
    const { container } = plans({
      selectedDate: TOMORROW,
      liveWeather: FULL,
      weatherForecast: [
        { date: '2026-11-15', temp: 58.4, feelsLike: null, humidity: null, windSpeed: null, conditions: 'light snow', icon: '13d' },
      ],
    });
    expect(screen.getByText('58°')).toBeTruthy();
    expect(screen.getByText('Light snow')).toBeTruthy();
    expect(screen.getByText('Snow expected. Plan around it')).toBeTruthy();
    // Today's reading is not this day's.
    expect(screen.queryByText('47°')).toBeNull();
    expect(screen.queryByText('Feels like')).toBeNull();
    expect(container.textContent).not.toContain('0°');
    expect(container.textContent).not.toMatch(BARE_PERCENT);
    expect(container.textContent).not.toContain('mph');
  });

  test('a forecast day with no temperature draws no card, where it drew "0°"', () => {
    const { container } = plans({
      selectedDate: TOMORROW,
      weatherForecast: [
        { date: '2026-11-15', temp: null, feelsLike: null, humidity: null, windSpeed: null, conditions: '', icon: '01d' },
      ],
    });
    expect(container.textContent).not.toContain('°');
    expect(screen.queryByText('Clear')).toBeNull();
    // The day itself is still there.
    expect(screen.getByText('Nothing on this day')).toBeTruthy();
  });

  test('no reading at all draws no card and no stray units', () => {
    const { container } = plans();
    expect(container.textContent).not.toContain('°');
    expect(container.textContent).not.toMatch(BARE_PERCENT);
    expect(container.textContent).not.toContain('mph');
    expect(screen.getByText('Nothing on this day')).toBeTruthy();
  });

  test('the high-wind line needs a wind over 20: a missing wind is not one', () => {
    const windy = plans({ liveWeather: { ...FULL, windSpeed: 22.8, conditions: 'clear sky' } });
    expect(screen.getByText('High winds. Outdoor plans may suffer')).toBeTruthy();
    windy.unmount();
    plans({ liveWeather: { temp: 47.3, conditions: 'clear sky' } });
    expect(screen.queryByText('High winds. Outdoor plans may suffer')).toBeNull();
  });
});

// --- App.js: one writer -----------------------------------------------------

describe('the Plans reading has one writer, the Plans weather effect', () => {
  const from = APP_SRC.indexOf('const weatherFetchedRef = useRef(0);');
  const to = APP_SRC.indexOf('// Search result cache', from);
  const effect = APP_SRC.slice(from, to);
  const count = (src, needle) => src.split(needle).length - 1;

  test('the effect is where this test thinks it is', () => {
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    expect(effect.length).toBeLessThan(3000);
    expect(effect).toContain('getWeather(userLocation.lat, userLocation.lng)');
    expect(effect).toContain('getWeatherForecast(userLocation.lat, userLocation.lng)');
    expect(effect).toContain('}, [currentTab, userLocation]);');
  });

  test('every write of the reading is inside it', () => {
    expect(count(APP_SRC, 'setLiveWeather(')).toBe(1);
    expect(count(effect, 'setLiveWeather(')).toBe(1);
    expect(effect).toContain('if (data) setLiveWeather(data);');
  });

  test('no crowd answer is copied into it', () => {
    expect(APP_SRC).not.toMatch(/setLiveWeather\([^)]*\.weather\b/);
    // Why it matters: the crowd routes answer with the venue's weather, a
    // temperature and a word. If they ever send the full reading this comment
    // is out of date, though the Plans card is still not the place for it.
    expect(count(CROWD_ROUTE_SRC, 'weather: weather ? { temp: weather.temp, conditions: weather.conditions } : null')).toBeGreaterThanOrEqual(2);
  });

  test('a failed read is asked again after a minute, the time the server remembers a failure', () => {
    expect(effect).toContain('const startedAt = Date.now();');
    expect(effect).toContain('weatherFetchedRef.current = startedAt;');
    // Thirty minutes of gate less twenty-nine wound back leaves one.
    expect(effect).toContain('if (weatherFetchedRef.current === startedAt) weatherFetchedRef.current = startedAt - 29 * 60 * 1000;');
    expect(WEATHER_SERVICE_SRC).toMatch(/^const WX_NEGATIVE_TTL = 60 \* 1000;$/m);
    // Both reads, on a refusal and on an empty answer.
    expect(count(effect, '.catch(readAgainSoon);')).toBe(2);
    expect(effect).toContain('if (data) setLiveWeather(data); else readAgainSoon();');
    expect(effect).toContain('if (data?.forecast) setWeatherForecast(data.forecast); else readAgainSoon();');
    expect(effect).not.toContain('.catch(() => {})');
    // No timer: the next visit to Plans is what asks again.
    expect(effect).not.toMatch(/setTimeout|setInterval/);
  });
});

describe('the screen reads the card through the helper', () => {
  test('one reading, passed through weatherForCard', () => {
    expect(SCREEN_SRC).toContain("import { weatherForCard } from '../lib/weatherCard';");
    expect(SCREEN_SRC).toContain('const weatherData = weatherForCard(isSelectedToday ? liveWeather : forecastForDate);');
  });

  test('no number is rounded or printed on the card without being checked first', () => {
    expect(SCREEN_SRC).not.toMatch(/Math\.round\(w\.(feelsLike|humidity|windSpeed)\)/);
    expect(SCREEN_SRC).not.toContain('{w.humidity}%');
    expect(SCREEN_SRC).toContain('{w.details.length > 0 && (');
    // As many columns as there are cells, so two cells are not left-packed in
    // a three-column row.
    expect(SCREEN_SRC).toMatch(/gridTemplateColumns: `repeat\(\$\{w\.details\.length\}, 1fr\)`/);
  });
});
