/**
 * The friend-code scanner's camera goes off whenever the scanner does (app
 * audit 2026-10-03). Starting it is a 300ms wait, a fetched library and a
 * camera prompt; Close or leaving the screen during any of that found nothing
 * to stop, and the camera came on afterwards behind a closed screen. Each start
 * and stop now takes a session number, and a start that lands late stops
 * itself. FRONTEND test (jest via react-scripts), read from App.js.
 */
const fs = require('fs');
const path = require('path');

const APP = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8');
const between = (a, b) => {
  const s = APP.indexOf(a);
  expect(s).toBeGreaterThan(-1);
  return APP.slice(s, APP.indexOf(b, s));
};

test('a start checks it is still the live opening at every wait', () => {
  const start = between('const startQrScanner = useCallback', 'const stopQrScanner = useCallback');
  expect(start).toContain('const session = qrSessionRef.current + 1;');
  expect(start).toContain('const stillOpen = () => qrSessionRef.current === session;');
  expect(start).toMatch(/setTimeout\(async \(\) => \{\s*if \(!stillOpen\(\)\) return;/);
  expect(start).toMatch(/await import\('html5-qrcode'\);\s*if \(!stillOpen\(\)\) return;/);
  expect(start).toMatch(/if \(!stillOpen\(\)\) \{\s*try \{ await scanner\.stop\(\); \} catch \{\}/);
});

test('a stop moves the session on, which is what reaches a start in flight', () => {
  const stop = between('const stopQrScanner = useCallback', '// Flock invites');
  expect(stop).toMatch(/qrSessionRef\.current \+= 1;\s*if \(qrScannerRef\.current\)/);
});

test('leaving Add Friends turns the camera off', () => {
  const stop = between('const stopQrScanner = useCallback', '// Flock invites');
  expect(stop).toMatch(/if \(currentScreen !== 'addFriends' && \(showQrScanner \|\| qrScannerRef\.current\)\) stopQrScanner\(\);/);
});
