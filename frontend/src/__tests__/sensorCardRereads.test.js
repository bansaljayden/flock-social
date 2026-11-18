/**
 * THE SENSOR CARDS READ AGAIN AFTER A GAP, AND COUNT CHECK-INS THE SERVER'S WAY.
 *
 * The owner's "Your sensor" card (venue dashboard) and the venue sheet's card
 * read GET /current and /history once when they open and after that only
 * folded the live pushes in. socket.js lets the connection go while the app
 * is hidden and a rejoined room replays nothing, so every reading sent in the
 * gap was missing from the card (today's door count, the hourly bars) for
 * the rest of the visit. They read again on a reconnect and on a return to
 * the app now, and the answer replaces what was folded.
 *
 * "Last hour check-ins" added one per venue_checkin and never let the hour
 * age out, while the server counts each person once over the last hour
 * (backend/routes/sensors.js). A check-in still adds one at once; the
 * server's figure replaces it a moment later.
 *
 * The effects are lifted out of App.js by source and run.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test sensorCardRereads --watchAll=false
 */

const fs = require('fs');
const path = require('path');
const { foldSensorReading } = require('../lib/sensorHistory');

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

/** The body of the first `useEffect(() => {` after `marker`, as a function of `names`. */
function effectAfter(marker, names) {
  const at = APP.indexOf(marker);
  if (at === -1) throw new Error(`no ${marker} in App.js`);
  const start = APP.indexOf('useEffect(() => {', at);
  // eslint-disable-next-line no-new-func
  return new Function(...names, blockFrom(APP, start));
}

const flush = async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); };

const hour = (h) => new Date(2026, 10, 17, h).toISOString();
const reading = (h, ir) => ({ venue_place_id: 'P', recorded_at: hour(h), ir_beam_count: ir, thermal_headcount: 30 });

/** A server that answers what it holds now, and a socket that is recorded. */
function world() {
  const server = { current: { sensor_data: null, recent_checkins: 3 }, history: [reading(18, 40)], fail: false };
  const socket = { update: null, checkin: null };
  const api = {
    getSensorCurrent: jest.fn(() => (server.fail ? Promise.reject(new Error('down')) : Promise.resolve(server.current))),
    getSensorHistory: jest.fn(() => (server.fail ? Promise.reject(new Error('down')) : Promise.resolve({ readings: server.history }))),
    joinVenueRoom: jest.fn(),
    leaveVenueRoom: jest.fn(),
    onVenueSensorUpdate: (fn) => { socket.update = fn; return () => {}; },
    onVenueCheckin: (fn) => { socket.checkin = fn; return () => {}; },
    foldSensorReading,
  };
  return { server, socket, api };
}

const OWNER_NAMES = ['ownerVenuePlaceId', 'currentScreen', 'getSensorCurrent', 'getSensorHistory', 'setOwnerSensorData',
  'setOwnerSensorHistory', 'ownerSensorRereadRef', 'joinVenueRoom', 'leaveVenueRoom', 'onVenueSensorUpdate', 'onVenueCheckin', 'foldSensorReading'];
const TRIGGER_NAMES = ['sensorRereadSeenRef', 'reconnectTick', 'docVisible', 'sensorRereadRef', 'ownerSensorRereadRef'];

function openOwnerCard() {
  const w = world();
  const card = { data: null, history: [] };
  const scope = {
    ...w.api,
    ownerVenuePlaceId: 'P',
    currentScreen: 'venueDashboard',
    setOwnerSensorData: (v) => { card.data = typeof v === 'function' ? v(card.data) : v; },
    setOwnerSensorHistory: (v) => { card.history = typeof v === 'function' ? v(card.history) : v; },
    ownerSensorRereadRef: { current: null },
  };
  const effect = effectAfter('// Pull live sensor data + history for the dashboard analytics tab.', OWNER_NAMES);
  effect(...OWNER_NAMES.map((n) => scope[n]));
  const trigger = effectAfter('const sensorRereadSeenRef = useRef(', TRIGGER_NAMES);
  const seen = { current: { tick: 0, visible: true } };
  const sheetRef = { current: null };
  const app = (tick, visible) => trigger(seen, tick, visible, sheetRef, scope.ownerSensorRereadRef);
  return { ...w, card, app };
}

beforeEach(() => { jest.useFakeTimers(); });
afterEach(() => { jest.useRealTimers(); });

test('a reconnect reads the card again, and the answer replaces what the pushes folded', async () => {
  const { server, socket, api, card, app } = openOwnerCard();
  await flush();
  expect(card.history).toEqual([reading(18, 40)]);

  socket.update(reading(18, 4));
  expect(card.history[0].ir_beam_count).toBe(44);

  // In a pocket: the socket goes, the readings of 18:05 to 19:59 never arrive.
  app(0, false);
  server.history = [reading(18, 480), reading(19, 480)];
  // Back, and the socket with it.
  app(0, true);
  app(1, true);
  await flush();
  expect(api.getSensorHistory).toHaveBeenCalledTimes(3);
  expect(card.history).toEqual([reading(18, 480), reading(19, 480)]);
});

test('a read again that fails keeps the card on screen', async () => {
  const { server, card, app } = openOwnerCard();
  await flush();
  server.fail = true;
  app(1, true);
  await flush();
  expect(card.data).toEqual({ sensor_data: null, recent_checkins: 3 });
  expect(card.history).toEqual([reading(18, 40)]);
});

test('nothing is read again while the app stays hidden, or on a render that changed nothing', async () => {
  const { api, app } = openOwnerCard();
  await flush();
  app(0, true);
  app(1, false);
  await flush();
  expect(api.getSensorHistory).toHaveBeenCalledTimes(1);
});

test('a check-in adds one at once, and the server\'s count of people replaces it', async () => {
  const { server, socket, card } = openOwnerCard();
  await flush();
  expect(card.data.recent_checkins).toBe(3);
  // The same person, from the app and then the tag: two events, one person.
  server.current = { sensor_data: null, recent_checkins: 4 };
  socket.checkin({ venue_place_id: 'P' });
  socket.checkin({ venue_place_id: 'P' });
  expect(card.data.recent_checkins).toBe(5);
  jest.advanceTimersByTime(5000);
  await flush();
  expect(card.data.recent_checkins).toBe(4);
});

test('the venue sheet\'s card reads again on the same signal', () => {
  const trigger = effectAfter('const sensorRereadSeenRef = useRef(', TRIGGER_NAMES);
  const sheet = { current: jest.fn() };
  const owner = { current: null };
  const seen = { current: { tick: 0, visible: true } };
  trigger(seen, 1, true, sheet, owner);
  expect(sheet.current).toHaveBeenCalledWith(true);
  // And the sheet's effect hands its read over.
  const at = APP.indexOf('// Sensor: fetch + subscribe when active venue changes');
  const sheetEffect = blockFrom(APP, APP.indexOf('useEffect(() => {', at));
  expect(sheetEffect).toMatch(/sensorRereadRef\.current = read;/);
});
