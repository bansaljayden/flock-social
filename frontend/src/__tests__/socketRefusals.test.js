/**
 * A SOCKET REFUSAL WITH WORDS FOR A PERSON IS SAID; A LOG LINE IS NOT.
 *
 * The socket's generic 'error' channel carries both, and App.js toasted every
 * one of them as an error toast, which stays until it is closed. "Failed to
 * vote" and "Not a member of this flock" sat on screen until dismissed, and a
 * refused join_flock, which App.js sends again on every reconnect, came back
 * each time the connection did. lib/socketRefusals.js lists the sentences the
 * server writes for people, App.js shows only those, and the rest go to the
 * console.
 *
 * The list is held to the server's own source here, so a reworded refusal on
 * the backend fails this suite instead of silently going quiet on the phone.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test socketRefusals --watchAll=false
 */
import { SOCKET_REFUSALS_FOR_PEOPLE, JOIN_FLOCK_REFUSALS, socketRefusalToShow } from '../lib/socketRefusals';

const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..', '..', '..');
const exists = (p) => fs.existsSync(path.join(REPO, p));
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8').replace(/\r\n/g, '\n');

describe('what is shown', () => {
  test('a sentence written for people is shown as the server wrote it', () => {
    expect(socketRefusalToShow('Slow down a moment.')).toBe('Slow down a moment.');
    expect(socketRefusalToShow("  That doesn't fit our community guidelines. Rephrase and try again. "))
      .toBe("That doesn't fit our community guidelines. Rephrase and try again.");
    expect(socketRefusalToShow('This plan is finished, so its venue vote is closed')).toBe('This plan is finished, so its venue vote is closed');
  });

  test('a line written for a log is not', () => {
    for (const line of [
      'Failed to vote', 'Failed to send message', 'Failed to select venue', 'Invalid venue id',
      'Venue name is required', 'Venue name too long', 'Message is required', 'Unsupported image format',
      'Flock not found', 'Invalid crowd update data', 'Internal server error',
    ]) {
      expect([line, socketRefusalToShow(line)]).toEqual([line, null]);
    }
  });

  test('a refused join_flock never is, since it comes back with every reconnect', () => {
    for (const line of JOIN_FLOCK_REFUSALS) expect(socketRefusalToShow(line)).toBeNull();
    for (const line of JOIN_FLOCK_REFUSALS) expect(SOCKET_REFUSALS_FOR_PEOPLE.has(line)).toBe(false);
  });

  test('whole sentences only: a log line that contains words from one is still a log line', () => {
    expect(socketRefusalToShow('Slow down a moment. (debug: bucket=send_message)')).toBeNull();
    expect(socketRefusalToShow('')).toBeNull();
    expect(socketRefusalToShow(undefined)).toBeNull();
    expect(socketRefusalToShow({ message: 'Slow down a moment.' })).toBeNull();
  });

  test('nothing on the list carries an em dash', () => {
    for (const s of SOCKET_REFUSALS_FOR_PEOPLE) expect(s).not.toMatch(/—/);
  });
});

describe('held to what the server says', () => {
  const SOURCES = ['backend/sockets/handlers.js', 'backend/utils/moderation.js', 'backend/utils/relationships.js', 'backend/routes/venues.js'];
  const haveBackend = SOURCES.every(exists);
  const maybe = haveBackend ? test : test.skip;

  maybe('every sentence on the list is one the backend writes, word for word', () => {
    const all = SOURCES.map(read).join('\n');
    for (const s of SOCKET_REFUSALS_FOR_PEOPLE) expect([s, all.includes(s)]).toEqual([s, true]);
  });

  maybe('join_flock refuses with nothing the list does not know to keep quiet', () => {
    const handlers = read('backend/sockets/handlers.js');
    const start = handlers.indexOf("socket.on('join_flock'");
    expect(start).toBeGreaterThan(-1);
    const block = handlers.slice(start, handlers.indexOf("socket.on('leave_flock'", start));
    const said = [...block.matchAll(/socket\.emit\('error', \{ message: '([^']+)' \}\)/g)].map((m) => m[1]);
    expect(said.length).toBeGreaterThan(0);
    for (const s of said) expect([s, JOIN_FLOCK_REFUSALS.has(s)]).toEqual([s, true]);
  });
});

describe('App.js listens through the list', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8').replace(/\r\n/g, '\n');
  const listener = app.slice(app.indexOf('return onSocketError((data) => {'), app.indexOf('}, [authUser?.id, showToast]);', app.indexOf('return onSocketError((data) => {')));

  test('only what socketRefusalToShow returns is toasted, and the rest is logged', () => {
    expect(listener.length).toBeGreaterThan(200);
    expect(app).toContain("import { socketRefusalToShow } from './lib/socketRefusals';");
    expect(listener).toContain('const shown = socketRefusalToShow(message);');
    expect(listener).toMatch(/if \(!shown\) \{\s*console\.warn\('\[flock\] socket refusal kept off the screen:', message\);\s*return;\s*\}\s*showToast\(shown, 'error'\);/);
    expect(listener).not.toMatch(/showToast\(message, 'error'\)/);
  });

  test("the DM not-connected case still takes its standing explanation first", () => {
    expect(listener.indexOf('NOT_CONNECTED_HINT.test(message) && dmEchoRef.current.size > 0'))
      .toBeLessThan(listener.indexOf('socketRefusalToShow(message)'));
  });
});
