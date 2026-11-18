/**
 * THE OWNER'S LIVE NUMBER LEAVES THE DASHBOARD WHEN IT EXPIRES.
 *
 * An owner's "how full are you" number is shown to users for 90 minutes and
 * then the forecast takes over again (backend, busy-now). The dashboard read
 * it only when the tab, the place or the plan changed, so the card went on
 * saying "Users see 62% full now" with "0 min left", and the insight cards
 * "Users currently see 62% full", long after users had stopped seeing it. At
 * its expiresAt the reading is dropped and busy-now read again, and a return
 * to the app reads it again too. Neither read is waited on, so each one's
 * answer is kept only if no newer read or saved number came after it
 * (busyNowSeqRef): a number set while one was out stays set.
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

// The expiry effect, run as (expiresAt, setVenueBusyNow, getVenueBusyNow,
// busyNowSeqRef).
const expiryEffect = () => effectAfter('const busyNowExpiresAt = venueBusyNow?.live?.expiresAt;',
  ['busyNowExpiresAt', 'setVenueBusyNow', 'getVenueBusyNow', 'busyNowSeqRef']);

// The return-to-app effect, run as (seenVisibleRef, docVisible, currentScreen,
// venueTab, venueProfile, getVenueBusyNow, setVenueBusyNow, busyNowSeqRef).
const resumeEffect = () => effectAfter('const busyNowSeenVisibleRef = useRef(',
  ['busyNowSeenVisibleRef', 'docVisible', 'currentScreen', 'venueTab', 'venueProfile', 'getVenueBusyNow', 'setVenueBusyNow', 'busyNowSeqRef']);

// The Set button's handler, lifted the same way.
function setBusyNowHandler(env) {
  const marker = 'const handleSetBusyNow = async () =>';
  const at = APP.indexOf(marker);
  if (at === -1) throw new Error(`no ${marker} in App.js`);
  const names = Object.keys(env);
  // eslint-disable-next-line no-new-func
  return new Function(...names, `return async () => ${blockFrom(APP, at)};`)(...names.map((n) => env[n]));
}

// A read the test answers by hand: the GET is out until answer() is called.
function heldRead() {
  const read = { calls: 0 };
  read.fn = jest.fn(() => { read.calls += 1; return new Promise((resolve) => { read.answer = resolve; }); });
  return read;
}

test('at its expiresAt the reading is dropped, and busy-now is read again', async () => {
  const state = holder({ available: true, ttlMinutes: 90, live: live(5) });
  const getVenueBusyNow = jest.fn(() => Promise.resolve({ available: true, ttlMinutes: 90, live: null }));
  const effect = expiryEffect();
  effect(state.value.live.expiresAt, state.set, getVenueBusyNow, { current: 0 });

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
  const effect = expiryEffect();
  effect(state.value.live.expiresAt, state.set, getVenueBusyNow, { current: 0 });
  expect(state.value.live).toBeNull();
  expect(getVenueBusyNow).not.toHaveBeenCalled();
});

test('a newer number set meanwhile is not the one dropped', () => {
  const first = live(5);
  const state = holder({ available: true, live: first });
  const effect = expiryEffect();
  effect(first.expiresAt, state.set, () => new Promise(() => {}), { current: 0 });
  // Updated from another device before the first one ran out.
  state.value = { available: true, live: live(90) };
  jest.advanceTimersByTime(5 * 60000);
  expect(state.value.live).not.toBeNull();
});

test('a return to the app with the card on screen reads busy-now again', async () => {
  const effect = resumeEffect();
  const seen = { current: true };
  const state = holder({ available: true, live: live(-30) });
  const getVenueBusyNow = jest.fn(() => Promise.resolve({ available: true, live: null }));
  const run = (visible, tab = 'analytics') => effect(seen, visible, 'venueDashboard', tab, { google_place_id: 'P' }, getVenueBusyNow, state.set, { current: 0 });
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

// THE OWNER'S NEW NUMBER IS NOT UNDONE BY A READ THAT WAS ALREADY OUT. Both
// refreshes are GETs the dashboard did not wait on, and the expiry one is
// started by a timer: a number set while either was in flight landed, and then
// the older answer replaced it, live reading, expiry timer and all.
function submitWith(state, seq, fresh) {
  return setBusyNowHandler({
    venueBusyDraft: 70,
    venueBusyNow: state.value,
    setVenueBusySaving: () => {},
    updateVenueBusyNow: () => Promise.resolve(fresh),
    setVenueBusyNow: state.set,
    setVenueBusyDraft: () => {},
    refreshOwnerPublishedScore: () => {},
    showToast: () => {},
    userMessage: (e, fallback) => fallback,
    busyNowSeqRef: seq,
  });
}

test('a number set while the expiry read is out is still there when that read answers', async () => {
  const seq = { current: 0 };
  const state = holder({ available: true, ttlMinutes: 90, live: live(5) });
  const read = heldRead();
  expiryEffect()(state.value.live.expiresAt, state.set, read.fn, seq);
  jest.advanceTimersByTime(5 * 60000);
  expect(read.calls).toBe(1);

  const fresh = { available: true, ttlMinutes: 90, live: { percent: 70, expiresAt: new Date(NOW + 95 * 60000).toISOString() } };
  await submitWith(state, seq, fresh)();
  expect(state.value).toEqual(fresh);

  read.answer({ available: true, ttlMinutes: 90, live: null });
  await flush();
  expect(state.value).toEqual(fresh);
});

test('a number set while the return-to-app read is out is still there when that read answers', async () => {
  const seq = { current: 0 };
  const state = holder({ available: true, ttlMinutes: 90, live: null });
  const read = heldRead();
  const seen = { current: false };
  resumeEffect()(seen, true, 'venueDashboard', 'analytics', { google_place_id: 'P' }, read.fn, state.set, seq);
  expect(read.calls).toBe(1);

  const fresh = { available: true, ttlMinutes: 90, live: { percent: 70, expiresAt: new Date(NOW + 90 * 60000).toISOString() } };
  await submitWith(state, seq, fresh)();
  read.answer({ available: true, ttlMinutes: 90, live: null });
  await flush();
  expect(state.value).toEqual(fresh);
});

// WHAT THE TOAST SAYS AFTER A SAVE. A venue that is strike-suppressed still has
// its number recorded, but users see the forecast, and POST busy-now answers
// suppressed: true. The toast said "Users see your number now." either way. It
// now says what the card says when suppressed, in the card's own words.
async function toastAfterSave(answer) {
  const showToast = jest.fn();
  const state = holder({ available: true, ttlMinutes: 90, live: null });
  await setBusyNowHandler({
    venueBusyDraft: 70,
    venueBusyNow: state.value,
    setVenueBusySaving: () => {},
    updateVenueBusyNow: () => Promise.resolve(answer),
    setVenueBusyNow: state.set,
    setVenueBusyDraft: () => {},
    refreshOwnerPublishedScore: () => {},
    showToast,
    userMessage: (e, fallback) => fallback,
    busyNowSeqRef: { current: 0 },
  })();
  expect(showToast).toHaveBeenCalledTimes(1);
  return showToast.mock.calls[0][0];
}

const PAUSED_TOAST = 'Your live numbers are paused, so users see the forecast for now.';

test('a save the server answers suppressed says the number is paused and users see the forecast', async () => {
  const said = await toastAfterSave({ available: true, ttlMinutes: 90, live: null, suppressed: true });
  expect(said).toBe(PAUSED_TOAST);
  expect(said).not.toMatch(/see your number/i);
});

test('a save that is served still says users see the number', async () => {
  const said = await toastAfterSave({ available: true, ttlMinutes: 90, live: live(90), suppressed: false });
  expect(said).toBe('Users see your number now.');
});

test('the paused toast is the busy-now card\'s own suppressed wording, cut short', () => {
  const dashboard = fs.readFileSync(path.join(__dirname, '..', 'screens', 'VenueDashboard.js'), 'utf8');
  expect(dashboard).toContain('Your live numbers are paused.');
  expect(dashboard).toContain('so users see the forecast for now.');
});

test('of two reads, the older one answering last does not win', async () => {
  const seq = { current: 0 };
  const state = holder({ available: true, ttlMinutes: 90, live: null });
  const older = heldRead();
  const newer = heldRead();
  resumeEffect()({ current: false }, true, 'venueDashboard', 'analytics', { google_place_id: 'P' }, older.fn, state.set, seq);
  resumeEffect()({ current: false }, true, 'venueDashboard', 'map', { google_place_id: 'P' }, newer.fn, state.set, seq);
  const now = { available: true, ttlMinutes: 90, live: live(60) };
  newer.answer(now);
  await flush();
  older.answer({ available: true, ttlMinutes: 90, live: null });
  await flush();
  expect(state.value).toEqual(now);
});