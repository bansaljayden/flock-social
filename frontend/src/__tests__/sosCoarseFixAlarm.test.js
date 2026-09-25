/**
 * A COARSE FIX READS THE SAME ON THE ALARM SCREEN AS IN THE EMAIL.
 *
 * Since round 23 the SOS email calls a fix the phone put wider than a
 * kilometre an area to search, not a spot, because a pin drawn from a cell
 * tower two kilometres off is exactly the claim that makes somebody stop
 * looking when they arrive. The flock's alarm was still handed six decimal
 * places and "See where they are". The server now sends the radius with the
 * alarm (routes/safety.js, alertFlockMembers, which builds the push in
 * services/sosPushes.js), and the alarm screen uses the email's words, over
 * both transports.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test --watchAll=false sosCoarseFixAlarm
 */
const fs = require('fs');
const path = require('path');
const { intentFromData } = require('../services/pushNavigation');

const APP = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8').replace(/\r\n/g, '\n');
const SAFETY = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'backend', 'routes', 'safety.js'), 'utf8').replace(/\r\n/g, '\n');
// Where the alarm push, the coarse-fix line and the radius phrase are built,
// for the flock leg and for the push the server sends again (pushHelper).
const SOS_PUSHES = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'backend', 'services', 'sosPushes.js'), 'utf8').replace(/\r\n/g, '\n');

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

  test('an alarm sent again without its radius is an area, not a spot', () => {
    // The server keeps no radius, so an alarm it builds again from the
    // database says the location is approximate (services/sosPushes.js).
    const rebuilt = intentFromData({
      type: 'safety_alert', fromUserId: '7', fromUserName: 'Ava',
      latitude: '40.05', longitude: '-75.12', approximate: 'true', at: 'x',
    });
    expect(rebuilt.approximate).toBe(true);
    expect(rebuilt).not.toHaveProperty('accuracy');
    // A radius says more than the flag, and no position needs neither.
    expect(intentFromData({
      type: 'safety_alert', fromUserId: '7', latitude: '40.05', longitude: '-75.12', accuracy: '2400', approximate: 'true', at: 'x',
    })).not.toHaveProperty('approximate');
    expect(intentFromData({ type: 'safety_alert', fromUserId: '7', approximate: 'true', at: 'x' })).not.toHaveProperty('approximate');
    expect(intentFromData({
      type: 'safety_alert', fromUserId: '7', latitude: '40.05', longitude: '-75.12', approximate: 'false', at: 'x',
    })).not.toHaveProperty('approximate');

    // The tap carries it into the alarm state, and the screen says so.
    const tap = APP.slice(APP.indexOf("} else if (intent.screen === 'safety') {"));
    expect(tap.slice(0, tap.indexOf('});'))).toMatch(/\.\.\.\(intent\.approximate === true \? \{ approximate: true \} : \{\}\),/);
    const overlay = APP.slice(APP.indexOf('{safetyAlert && ('), APP.indexOf('{SOSModal()}'));
    expect(overlay).toMatch(/safetyAlert\.lat !== null && safetyAlert\.approximate === true && !\(safetyAlert\.accuracy > 0\)\n\s+\? ' Their location is approximate, so treat it as the area to search rather than the spot\.'/);
  });

  test('the live socket event and the tapped push both put it into the alarm state', () => {
    const socket = APP.slice(APP.indexOf('const unsub = onSafetyAlert((data) => {'), APP.indexOf('const unsub = onSafetyAlertCancelled('));
    expect(socket).toMatch(/\{ accuracy: Number\(data\.accuracy\) \}/);
    const tap = APP.slice(APP.indexOf("} else if (intent.screen === 'safety') {"));
    expect(tap.slice(0, tap.indexOf('});'))).toMatch(/\.\.\.\(Number\.isFinite\(intent\.accuracy\) \? \{ accuracy: intent\.accuracy \} : \{\}\),/);
  });

  test('the server sends it, and says "approximate" in the push body too', () => {
    // The flock leg hands the fix's radius to the builder, and the builder
    // sends it and words the body by it.
    expect(SAFETY).toMatch(/fixMetres: coords \? readAccuracy\(leg\.fixMetres\) : null,/);
    expect(SOS_PUSHES).toMatch(/\.\.\.\(radius !== null \? \{ accuracy: Math\.round\(radius\) \} : \{\}\),/);
    expect(SOS_PUSHES).toMatch(/shared an approximate location, within \$\{accuracyPhrase\(radius\)\}/);
  });
});

describe('the words match the email', () => {
  test('the same threshold as the email', () => {
    // The email in routes/safety.js and the alarm push both read it from
    // services/sosPushes.js.
    expect(SAFETY).toMatch(/const \{ COARSE_FIX_METRES, accuracyPhrase, alarmPush, allClearPush \} = require\('\.\.\/services\/sosPushes'\);/);
    const server = Number((SOS_PUSHES.match(/const COARSE_FIX_METRES = (\d+);/) || [])[1]);
    const client = Number((APP.match(/const SOS_COARSE_FIX_METRES = (\d+);/) || [])[1]);
    expect(server).toBe(1000);
    expect(client).toBe(server);
  });

  test('the same phrase for a radius, as code and as output', () => {
    const serverBody = functionBody(SOS_PUSHES, 'accuracyPhrase');
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
    expect(overlay).toMatch(/safetyAlert\.accuracy > SOS_COARSE_FIX_METRES \|\| safetyAlert\.approximate === true \? 'See the area they are in' : 'See where they are'/);
    // No em dash in anything the overlay says.
    const said = overlay.split('\n').filter((l) => !/^\s*(\/\/|\*|\{\/\*)/.test(l)).join('\n');
    expect(said).not.toContain(String.fromCharCode(0x2014));
  });
});
