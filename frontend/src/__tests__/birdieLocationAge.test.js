/**
 * HOW OLD THE LOCATION BIRDIE IS SENT IS (lib/birdieLocation.js; backend
 * routes/ai.js, HOW FAR A VENUE IS).
 *
 * The server tells Birdie how far each venue is only from a fix it is told is
 * fresh, because the position the app sends can be where the phone was in an
 * earlier session. Pinned here:
 *   1. the age is the device fix's, in whole seconds, and only when the fix is
 *      at the place being sent; a restored position or no fix is null;
 *   2. sendAiChat puts it on the turn only beside a location, and leaves it
 *      off otherwise;
 *   3. the app reads the device fix for it, and both of Birdie's sends carry
 *      it.
 */
import fs from 'fs';
import path from 'path';
import { birdieLocationAgeSec } from '../lib/birdieLocation';

const NOW = Date.parse('2026-11-06T19:40:00Z');
const HERE = { lat: 39.9511, lng: -75.166 };

describe('the age of the position Birdie is sent', () => {
  test('a fix at the same place: its age in whole seconds', () => {
    expect(birdieLocationAgeSec(HERE, { ...HERE, at: NOW - 45_900 }, NOW)).toBe(45);
    expect(birdieLocationAgeSec(HERE, { ...HERE, at: NOW }, NOW)).toBe(0);
  });

  test('a live share lets the map lag a few metres behind the fix: still the same place', () => {
    const fix = { lat: HERE.lat + 0.00008, lng: HERE.lng - 0.00009, at: NOW - 5_000 };
    expect(birdieLocationAgeSec(HERE, fix, NOW)).toBe(5);
  });

  test('a position the fix is not at, or no fix at all, has no known age', () => {
    expect(birdieLocationAgeSec(HERE, { lat: 39.9701, lng: -75.134, at: NOW - 1_000 }, NOW)).toBeNull();
    expect(birdieLocationAgeSec(HERE, null, NOW)).toBeNull();
    expect(birdieLocationAgeSec(null, { ...HERE, at: NOW }, NOW)).toBeNull();
    expect(birdieLocationAgeSec(HERE, { ...HERE, at: undefined }, NOW)).toBeNull();
    expect(birdieLocationAgeSec(HERE, { ...HERE, at: NOW + 60_000 }, NOW)).toBeNull();
  });

  test('a very old fix reads as a day old, which the server takes and calls stale', () => {
    expect(birdieLocationAgeSec(HERE, { ...HERE, at: NOW - 9 * 24 * 3600 * 1000 }, NOW)).toBe(24 * 3600);
  });
});

describe('the turn sendAiChat sends', () => {
  const api = jest.requireActual('../services/api');
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });
  const answer = (body) => jest.fn(() => Promise.resolve({
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  }));
  const chatBody = () => {
    const call = global.fetch.mock.calls.find(([url]) => String(url).includes('/api/ai/chat'));
    return JSON.parse(call[1].body);
  };

  test('carries the age beside a location', async () => {
    global.fetch = answer({ text: 'go', venues: [] });
    await api.sendAiChat([{ role: 'user', text: 'pizza near me' }], HERE, null, 45);
    expect(chatBody().location).toEqual(HERE);
    expect(chatBody().locationAgeSec).toBe(45);
  });

  test.each([
    ['no age', HERE, null],
    ['an age that is not whole seconds', HERE, 4.5],
    ['an age with no location', null, 45],
  ])('leaves it off with %s', async (_name, location, age) => {
    global.fetch = answer({ text: 'go', venues: [] });
    await api.sendAiChat([{ role: 'user', text: 'pizza near me' }], location, null, age);
    expect('locationAgeSec' in chatBody()).toBe(false);
  });

  test('a caller that passes three arguments sends what it always sent', async () => {
    global.fetch = answer({ text: 'go', venues: [] });
    await api.sendAiChat([{ role: 'user', text: 'pizza near me' }], HERE, null);
    expect('locationAgeSec' in chatBody()).toBe(false);
  });
});

describe('the app', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8');
  const start = app.indexOf('const sendAiMessage = useCallback(');
  const send = app.slice(start, app.indexOf('const fillAiInput = useCallback', start));

  test('reads the age off the device fix, never off the map position alone', () => {
    expect(send).toContain('const locationAgeSec = birdieLocationAgeSec(location, deviceFixRef.current);');
  });

  test('both of Birdie\'s sends carry it', () => {
    const calls = send.match(/await sendAiChat\(.*\);/g);
    expect(calls).toHaveLength(2);
    for (const call of calls) expect(call).toContain(', locationAgeSec)');
  });
});
