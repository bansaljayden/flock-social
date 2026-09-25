/**
 * A COARSE FIX READS THE SAME ON THE ALARM SCREEN AS IN THE EMAIL.
 *
 * Since round 23 the SOS email calls a fix the phone put wider than a
 * kilometre an area to search, not a spot, because a pin drawn from a cell
 * tower two kilometres off is exactly the claim that makes somebody stop
 * looking when they arrive. The flock's alarm was still handed six decimal
 * places and "See where they are". The server now sends the radius with the
 * alarm (routes/safety.js, alertFlockMembers), and the alarm screen uses the
 * email's words, over both transports.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test --watchAll=false sosCoarseFixAlarm
 */
const fs = require('fs');
const path = require('path');
const { intentFromData } = require('../services/pushNavigation');

const APP = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8').replace(/\r\n/g, '\n');
const SAFETY = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'backend', 'routes', 'safety.js'), 'utf8').replace(/\r\n/g, '\n');

// The body of `function name(metres) { ... }`, whitespace folded, so the two
// copies of the phrase can be compared as code and then run.
function functionBody(src, name) {
  const start = src.indexOf(`function ${name}(metres) {`);
  expect(start).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    if (src[i] === '}') { depth -= 1; if (depth === 0) return src.slice(src.indexOf('{', start) + 1, i); }
  }
  throw new Error(`no body for ${name}`);
}
const fold = (s) => s.replace(/\s+/g, ' ').trim();

describe('the radius travels', () => {
  test('a tapped alarm carries the radius, as a number, only alongside a position', () => {
    // FCM data values arrive as strings, like the coordinates beside them.
    expect(intentFromData({
      type: 'safety_alert', fromUserId: '7', fromUserName: 'Ava',
      latitude: '40.05', longitude: '-75.12', accuracy: '2400', at: 'x',
    })).toEqual({
      screen: 'safety', userId: 7, name: 'Ava',
      lat: 40.05, lng: -75.12, accuracy: 2400, at: 'x', type: 'safety_alert',
    });
    // No position, no radius to describe.
    expect(intentFromData({ type: 'safety_alert', fromUserId: '7', accuracy: '2400', at: 'x' }))
      .not.toHaveProperty('accuracy');
    // Junk and zero are "we were not told".
    for (const bad of ['', 'wide', '0', '-5']) {
      expect(intentFromData({
        type: 'safety_alert', fromUserId: '7', latitude: '40.05', longitude: '-75.12', accuracy: bad, at: 'x',
      })).not.toHaveProperty('accuracy');
    }
  });

  test('the live socket event and the tapped push both put it into the alarm state', () => {
    const socket = APP.slice(APP.indexOf('const unsub = onSafetyAlert((data) => {'), APP.indexOf('const unsub = onSafetyAlertCancelled('));
    expect(socket).toMatch(/\{ accuracy: Number\(data\.accuracy\) \}/);
    const tap = APP.slice(APP.indexOf("} else if (intent.screen === 'safety') {"));
    expect(tap.slice(0, tap.indexOf('});'))).toMatch(/\.\.\.\(Number\.isFinite\(intent\.accuracy\) \? \{ accuracy: intent\.accuracy \} : \{\}\),/);
  });

  test('the server sends it, and says "approximate" in the push body too', () => {
    expect(SAFETY).toMatch(/\.\.\.\(fixMetres !== null \? \{ accuracy: Math\.round\(fixMetres\) \} : \{\}\),/);
    expect(SAFETY).toMatch(/shared an approximate location, within \$\{accuracyPhrase\(fixMetres\)\}/);
  });
});

describe('the words match the email', () => {
  test('the same threshold as the email', () => {
    const server = Number((SAFETY.match(/const COARSE_FIX_METRES = (\d+);/) || [])[1]);
    const client = Number((APP.match(/const SOS_COARSE_FIX_METRES = (\d+);/) || [])[1]);
    expect(server).toBe(1000);
    expect(client).toBe(server);
  });

  test('the same phrase for a radius, as code and as output', () => {
    const serverBody = functionBody(SAFETY, 'accuracyPhrase');
    const clientBody = functionBody(APP, 'sosAccuracyPhrase');
    expect(fold(clientBody)).toBe(fold(serverBody));
    // eslint-disable-next-line no-new-func
    const phrase = new Function('metres', clientBody);
    expect(phrase(2400)).toBe('about 2.4 km');
    expect(phrase(12000)).toBe('about 12 km');
    expect(phrase(640)).toBe('about 600 m');
    expect(phrase(12)).toBe('about 10 m');
  });

  test('a coarse fix is an area to search, and the map link says so', () => {
    const overlay = APP.slice(APP.indexOf('{safetyAlert && ('), APP.indexOf('{SOSModal()}'));
    // The email's sentence, word for word after its first clause.
    expect(SAFETY).toMatch(/so treat it as the area to search rather than the spot\./);
    expect(overlay).toMatch(/safetyAlert\.lat !== null && safetyAlert\.accuracy > SOS_COARSE_FIX_METRES/);
    expect(overlay).toMatch(/Their location is approximate\. The phone put it within \$\{sosAccuracyPhrase\(safetyAlert\.accuracy\)\}, so treat it as the area to search rather than the spot\./);
    expect(overlay).toMatch(/safetyAlert\.accuracy > SOS_COARSE_FIX_METRES \? 'See the area they are in' : 'See where they are'/);
    // No em dash in anything the overlay says.
    const said = overlay.split('\n').filter((l) => !/^\s*(\/\/|\*|\{\/\*)/.test(l)).join('\n');
    expect(said).not.toContain(String.fromCharCode(0x2014));
  });
});
