/**
 * THE TONIGHT PULSE GOES OUT WHEN IT EXPIRES.
 *
 * Friday at 8 PM somebody taps Down, and the pulse expires at 4 AM. The app
 * stays open (a web tab, or a phone that kept it alive in the background). On
 * Saturday evening the Nest still lit Down, because the viewer's own pulse was
 * read once at mount and nothing compared it with its expires_at, while the
 * server had stopped showing it to friends at 4 AM. Tapping Down to be sure
 * then CLEARED it: the toggle took the lit button to mean "tap again to unset".
 *
 * lib/pulse.js holds the rule and is tested directly. handleSetPulse is
 * compiled out of App.js and run, so the tap is tested as it ships.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test tonightPulseExpiry --watchAll=false
 */
import { livePulse, pulseEndsAt, pulseTapAction } from '../lib/pulse';

const fs = require('fs');
const path = require('path');

const APP = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8').replace(/\r\n/g, '\n');

const NOW = Date.parse('2026-09-26T23:00:00Z'); // Saturday 7 PM in New York
const ENDED = { status: 'down', note: null, set_at: '2026-09-26T00:00:00Z', expires_at: '2026-09-26T08:00:00Z' };
const ON = { status: 'down', note: null, set_at: '2026-09-26T22:00:00Z', expires_at: '2026-09-27T08:00:00Z' };

describe('lib/pulse', () => {
  test('a pulse past its expiry is not on', () => {
    expect(livePulse(ENDED, NOW)).toBeNull();
    expect(livePulse(ON, NOW)).toBe(ON);
  });

  test('a pulse with no readable end is treated as on, as the friends list treats one', () => {
    expect(livePulse({ status: 'maybe' }, NOW)).toEqual({ status: 'maybe' });
    expect(livePulse({ status: 'maybe', expires_at: 'not a date' }, NOW)).toEqual({ status: 'maybe', expires_at: 'not a date' });
    expect(pulseEndsAt({ status: 'maybe' })).toBeNull();
  });

  test('no pulse is no pulse', () => {
    expect(livePulse(null, NOW)).toBeNull();
    expect(livePulse({ status: null, expires_at: ON.expires_at }, NOW)).toBeNull();
  });

  test('a tap clears only a status that is still on', () => {
    expect(pulseTapAction(ON, 'down', NOW)).toBe('clear');
    expect(pulseTapAction(ENDED, 'down', NOW)).toBe('set');
    expect(pulseTapAction(ON, 'maybe', NOW)).toBe('set');
    expect(pulseTapAction(null, 'down', NOW)).toBe('set');
  });
});

describe('the tap, as App.js ships it', () => {
  const SCOPE = ['pulseSaving', 'hapticTap', 'setPulseSaving', 'myPulse', 'pulseTapAction',
    'clearAvailability', 'setMyPulse', 'setAvailability', 'showToast', 'livePulse', 'myPulseSeqRef'];

  function compileTap(deps) {
    const m = APP.match(/const handleSetPulse = useCallback\((async \(status\) => \{[\s\S]*?\n {2}\}), \[myPulse, pulseSaving, showToast\]\);/);
    expect(m).not.toBeNull();
    // eslint-disable-next-line no-new-func
    return new Function(...SCOPE, `return (${m[1]});`)(...SCOPE.map((k) => deps[k]));
  }

  function tapWith(myPulse) {
    const calls = { set: [], clear: 0, shown: undefined };
    const deps = {
      pulseSaving: false,
      hapticTap: () => {},
      setPulseSaving: () => {},
      myPulse,
      pulseTapAction,
      livePulse,
      myPulseSeqRef: { current: 0 },
      clearAvailability: async () => { calls.clear += 1; },
      setMyPulse: (p) => { calls.shown = p; },
      setAvailability: async (body) => { calls.set.push(body); return { pulse: { ...ON, status: body.status } }; },
      showToast: () => {},
    };
    return { tap: compileTap(deps), calls };
  }

  test('tapping Down on a Down that expired sets it again', async () => {
    const { tap, calls } = tapWith({ ...ENDED, expires_at: new Date(Date.now() - 60 * 60 * 1000).toISOString() });
    await tap('down');
    expect(calls.clear).toBe(0);
    expect(calls.set.map((b) => b.status)).toEqual(['down']);
    expect(calls.shown.status).toBe('down');
  });

  test('tapping Down on a Down that is still on still clears it', async () => {
    const { tap, calls } = tapWith({ ...ON, expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString() });
    await tap('down');
    expect(calls.clear).toBe(1);
    expect(calls.set).toEqual([]);
    expect(calls.shown).toBeNull();
  });
});

describe('the Nest shows what friends see', () => {
  test('the button is lit only while the pulse is on', () => {
    expect(APP).toContain('const active = livePulse(myPulse)?.status === opt.key;');
  });

  test('the pulse is dropped when it ends, even with nothing else re-rendering', () => {
    expect(APP).toContain('const end = pulseEndsAt(myPulse);');
    expect(APP).toContain('const drop = () => setMyPulse(prev => (prev === myPulse && !livePulse(prev) ? null : prev));');
  });

  test('a re-read that was out when a tap answered does not undo the tap', () => {
    expect(APP).toContain('if (seq === myPulseSeqRef.current) setMyPulse(d.pulse || null);');
    const tap = APP.slice(APP.indexOf('const handleSetPulse = useCallback'), APP.indexOf('}, [myPulse, pulseSaving, showToast]);'));
    expect(tap).toContain('myPulseSeqRef.current += 1;');
  });

  test('a return to the app and a socket reconnect re-read both pulses', () => {
    const effect = APP.slice(APP.indexOf('// Availability pulse: load my current'), APP.indexOf('// Flock ordering & pinning'));
    expect(effect).toContain("document.addEventListener('visibilitychange', onVisible);");
    expect(effect).toContain("document.removeEventListener('visibilitychange', onVisible);");
    expect(effect).toMatch(/refreshMyPulse\(\);\s*refreshFriendsPulses\(\);\s*\};/);
    expect(APP).toMatch(/if \(!reconnectTick\) return;\n[^\n]*visibilityState === 'hidden'\) return;\n\s*refreshMyPulse\(\);\n\s*refreshFriendsPulses\(\);\n\s*\}, \[reconnectTick, refreshMyPulse, refreshFriendsPulses\]\);/);
  });
});
