/**
 * The places a free account meets a limit lead somewhere (2026-09-24).
 *
 * A screenshot pass with the paywall on found four of them ending in nothing:
 * Birdie at its daily cap had no way to Pro and kept offering suggestion chips
 * that could not send; the locked venue card drew the hour-by-hour heading over
 * an empty gap; the You tab showed crowd alerts switched on for an account the
 * server never sends them to; and /pro's sign-in dropped the reader on /app
 * with no way back. Source contracts, plus the return helper run for real.
 */
import { rememberReturnAfterSignIn, takeReturnAfterSignIn } from '../lib/returnAfterSignIn';

const fs = require('fs');
const path = require('path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');
const birdie = read('components/birdie/BirdiePanel.js');
const card = read('components/venue/ConsumerVenueCard.js');
const profile = read('screens/ProfileSettings.js');
const app = read('App.js');
const landing = read('website/LandingPage.js');

describe('Birdie at the daily cap', () => {
  test('says when the messages come back and offers Pro', () => {
    expect(birdie).toMatch(/\{outOfChirps \? \(/);
    expect(birdie).toMatch(/They come back \{chirpsBackText\(aiResetsAt\)\}\./);
    expect(birdie).toMatch(/onClick=\{\(\) => setPaywallTrigger\('birdie'\)\}/);
  });

  test('offers no chip that would send while nothing can be sent', () => {
    expect(birdie).toMatch(/\{!outOfChirps && \(\n\s*<div style=\{\{ display: 'flex', gap: '6px', flexWrap: 'wrap', justifyContent: 'center', pointerEvents: 'auto' \}\}>/);
    expect(birdie).toMatch(/\{!aiTyping && aiMessages\.length > 0 && !outOfChirps && \(/);
  });

  test('the panel is handed both names it now reads', () => {
    const props = app.slice(app.indexOf('const birdiePanelProps = {'), app.indexOf('};', app.indexOf('const birdiePanelProps = {')));
    expect(props).toMatch(/\n\s+outOfChirps,\n/);
    expect(props).toMatch(/\n\s+setPaywallTrigger,\n/);
  });
});

describe('the locked venue card', () => {
  test('one row names what is behind it instead of a heading over nothing', () => {
    const locked = card.indexOf('{cd?.forecastAccess?.locked ? (\n                  <m.div');
    const heading = card.indexOf('Expected Crowd by Hour');
    expect(locked).toBeGreaterThan(-1);
    expect(locked).toBeLessThan(heading);
    expect(card).toContain('The hour-by-hour chart is part of Flock Pro.');
  });

  test('the number is said once, by the dial', () => {
    expect(card).not.toMatch(/\{'·'\} \{score\}/);
  });
});

describe('crowd alerts on a free account', () => {
  test('with the paywall on and no Pro, the row opens Pro instead of showing a switch', () => {
    expect(profile).toMatch(/\{entitlements\?\.paywallEnabled && !isPro \? \(\n\s*<button type="button" className="hit44" aria-label="Crowd alerts come with Flock Pro" onClick=\{\(\) => setPaywallTrigger\('settings'\)\}/);
    // The switch itself is unchanged for everyone else.
    expect(profile).toContain('<Toggle label="Crowd alerts" on={crowdAlertsOn} onChange={() => setCrowdAlertsEnabled(!crowdAlertsOn)} />');
  });
});

describe('the homepage pricing row', () => {
  test('three cards get three columns', () => {
    expect(landing).toContain("<div className={proOffer ? 'lp-plans lp-plans-3' : 'lp-plans'}>");
  });
});

describe('back to /pro after signing in', () => {
  beforeEach(() => { window.sessionStorage.clear(); });

  test('a remembered /pro comes back once', () => {
    rememberReturnAfterSignIn('/pro');
    expect(takeReturnAfterSignIn()).toBe('/pro');
    expect(takeReturnAfterSignIn()).toBeNull();
  });

  test('nothing outside the list is remembered or returned', () => {
    rememberReturnAfterSignIn('https://evil.example/');
    expect(takeReturnAfterSignIn()).toBeNull();
    window.sessionStorage.setItem('flock_return_after_sign_in', JSON.stringify({ path: '//evil.example', at: Date.now() }));
    expect(takeReturnAfterSignIn()).toBeNull();
  });

  test('an abandoned sign-in does not bounce a later one', () => {
    window.sessionStorage.setItem('flock_return_after_sign_in', JSON.stringify({ path: '/pro', at: Date.now() - 31 * 60 * 1000 }));
    expect(takeReturnAfterSignIn()).toBeNull();
  });

  test('every session start asks, after the settings pull', () => {
    const i = app.indexOf('const beginSession = useCallback');
    const fn = app.slice(i, app.indexOf('}, []);', i));
    expect(fn.indexOf('pullSettings().catch(() => {});')).toBeLessThan(fn.indexOf('takeReturnAfterSignIn()'));
    expect(fn).toMatch(/const back = takeReturnAfterSignIn\(\);\n\s+if \(back\) window\.location\.assign\(back\);/);
  });
});
