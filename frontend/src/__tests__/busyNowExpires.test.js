/**
 * THE OWNER'S LIVE NUMBER LEAVES THE DASHBOARD WHEN IT EXPIRES.
 *
 * An owner's "how full are you" number is shown to users for 90 minutes and
 * then the forecast takes over again (backend, busy-now). The dashboard read
 * it only when the tab, the place or the plan changed, so the card went on
 * saying "Users see 62% full now" with "0 min left", and the insight cards
 * "Users currently see 62% full", long after users had stopped seeing it. At
 * its expiresAt the reading is dropped and busy-now read again, and a return
 * to the app reads it again too.
 *
 * The effects are lifted out of App.js by source and run.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test busyNowExpires --watchAll=false
 */

const fs = require('fs');
const path = require('path');

const APP = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8').replace(/\r\n/g, '\n');

/* One brace-matched block starting at the first `{` at or after `from`,
   skipping strings and comments (chatThreadSwitch.test.js's helper). */
function blockFrom(source, from) {
  let i = source.indexOf('{', from);
  let depth = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === '/' && next === '/') { i = source.indexOf('\n', i); if (i === -1) break; continue; }
    if (ch === '/' && next === '*') { const end = source.indexOf('*/', i + 2); i = end === -1 ? source.length : end + 2; continue; }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      i += 1;
      while (i < source.length) {
        if (source[i] === '\\') { i += 2; continue; }
        if (source[i] === quote) { i += 1; break; }
        i += 1;
      }
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(source.indexOf('{', from), i + 1);
    }
    i += 1;
  }
  throw new Error('blockFrom: unterminated block');
}

function effectAfter(marker, names) {
  const at = APP.indexOf(marker);
  if (at === -1) throw new Error(`no ${marker} in App.js`);
  // eslint-disable-next-line no-new-func
  return new Function(...names, blockFrom(APP, APP.indexOf('useEffect(() => {', at)));
}

const flush = async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); };
const NOW = Date.parse('2026-11-17T20:00:00Z');
const live = (minutesLeft) => ({ percent: 62, expiresAt: new Date(NOW + minutesLeft * 60000).toISOString() });

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
});
afterEach(() => { jest.useRealTimers(); });

function holder(initial) {
  const box = { value: initial };
  box.set = (v) => { box.value = typeof v === 'function' ? v(box.value) : v; };
  return box;
}

test('at its expiresAt the reading is dropped, and busy-now is read again', async () => {
  const state = holder({ available: true, ttlMinutes: 90, live: live(5) });
  const getVenueBusyNow = jest.fn(() => Promise.resolve({ available: true, ttlMinutes: 90, live: null }));
  const effect = effectAfter('const busyNowExpiresAt = venueBusyNow?.live?.expiresAt;', ['busyNowExpiresAt', 'setVenueBusyNow', 'getVenueBusyNow']);
  effect(state.value.live.expiresAt, state.set, getVenueBusyNow);

  jest.advanceTimersByTime(5 * 60000 - 1);
  expect(state.value.live).not.toBeNull();
  jest.advanceTimersByTime(1);
  expect(state.value.live).toBeNull();
  expect(getVenueBusyNow).toHaveBeenCalledTimes(1);
  await flush();
  expect(state.value).toEqual({ available: true, ttlMinutes: 90, live: null });
});

test('a reading already past its time on this clock is dropped without a read, so no loop', () => {
  const state = holder({ available: true, live: live(-1) });
  const getVenueBusyNow = jest.fn(() => Promise.resolve(state.value));
  const effect = effectAfter('const busyNowExpiresAt = venueBusyNow?.live?.expiresAt;', ['busyNowExpiresAt', 'setVenueBusyNow', 'getVenueBusyNow']);
  effect(state.value.live.expiresAt, state.set, getVenueBusyNow);
  expect(state.value.live).toBeNull();
  expect(getVenueBusyNow).not.toHaveBeenCalled();
});

test('a newer number set meanwhile is not the one dropped', () => {
  const first = live(5);
  const state = holder({ available: true, live: first });
  const effect = effectAfter('const busyNowExpiresAt = venueBusyNow?.live?.expiresAt;', ['busyNowExpiresAt', 'setVenueBusyNow', 'getVenueBusyNow']);
  effect(first.expiresAt, state.set, () => new Promise(() => {}));
  // Updated from another device before the first one ran out.
  state.value = { available: true, live: live(90) };
  jest.advanceTimersByTime(5 * 60000);
  expect(state.value.live).not.toBeNull();
});

test('a return to the app with the card on screen reads busy-now again', async () => {
  const names = ['busyNowSeenVisibleRef', 'docVisible', 'currentScreen', 'venueTab', 'venueProfile', 'getVenueBusyNow', 'setVenueBusyNow'];
  const effect = effectAfter('const busyNowSeenVisibleRef = useRef(', names);
  const seen = { current: true };
  const state = holder({ available: true, live: live(-30) });
  const getVenueBusyNow = jest.fn(() => Promise.resolve({ available: true, live: null }));
  const run = (visible, tab = 'analytics') => effect(seen, visible, 'venueDashboard', tab, { google_place_id: 'P' }, getVenueBusyNow, state.set);
  run(true);
  expect(getVenueBusyNow).not.toHaveBeenCalled();
  run(false);
  run(true);
  expect(getVenueBusyNow).toHaveBeenCalledTimes(1);
  await flush();
  expect(state.value.live).toBeNull();
  // Not from a tab that does not show it.
  run(false, 'reviews');
  run(true, 'reviews');
  expect(getVenueBusyNow).toHaveBeenCalledTimes(1);
});
