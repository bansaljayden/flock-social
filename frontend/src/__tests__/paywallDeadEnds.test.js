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
    // The mid-thread chips (not drawn at all in the Nest's inline thread).
    expect(birdie).toMatch(/\{!isInline && !aiTyping && aiMessages\.length > 0 && !outOfChirps && \(/);
    // And the Nest's own suggestions are none while the day's messages are
    // spent (lib/birdieChips.js; birdieChips.test.js runs it).
    expect(app).toMatch(/chips=\{birdieChips\(\{ liveFlocks, now: nestNow, outOfChirps \}\)\}/);
  });

  test('the panel is handed both names it now reads', () => {
    const props = app.slice(app.indexOf('const birdiePanelProps = {'), app.indexOf('};', app.indexOf('const birdiePanelProps = {')));
    expect(props).toMatch(/\n\s+outOfChirps,\n/);
    expect(props).toMatch(/\n\s+setPaywallTrigger,\n/);
  });

  test("the Nest's own field at rest says so too, and sends nothing (2026-11-06)", () => {
    // The resting field in the Nest's page took a question at the cap and
    // sent nothing, with no thread open to say why. It is off now, with the
    // composer's own line under it and Get Flock Pro where it is sold
    // (birdieInline.test.js renders it).
    const section = read('components/nest/NestBirdieSection.js');
    expect(section).toMatch(/disabled=\{outOfChirps\}/);
    expect(section).toMatch(/They come back \{birdieBackText\(resetsAt\)\}\./);
    expect(section).toMatch(/\{onGetPro && \(/);
    const home = app.slice(app.indexOf('const nestBirdieSection = ('), app.indexOf('    return (', app.indexOf('const nestBirdieSection = (')));
    expect(home).toMatch(/outOfChirps=\{outOfChirps\}/);
    expect(home).toMatch(/onGetPro=\{process\.env\.REACT_APP_PURCHASES !== 'off' \? \(\) => setPaywallTrigger\('birdie'\) : null\}/);
    const send = app.slice(app.indexOf('const nestBirdieSend = () => {'), app.indexOf('const nestBirdieChip'));
    expect(send).toMatch(/if \(outOfChirps\) return;/);
  });
});

describe('the locked venue card', () => {
  test('one row names what is behind it instead of a heading over nothing', () => {
    const locked = card.indexOf("{cd?.forecastAccess?.locked && !(process.env.REACT_APP_PURCHASES !== 'off') ? (\n                  <m.div");
    const heading = card.indexOf('Expected crowd by hour');
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
    // The entitlement check comes first; the purchases flag then picks the
    // Pro button (web) or nothing (the App Store build), never the switch.
    expect(profile).toMatch(/\{entitlements\?\.paywallEnabled && !isPro \? \(\n\s*\(process\.env\.REACT_APP_PURCHASES !== 'off'\) \? \(\n\s*<button type="button" className="hit44" aria-label="Crowd alerts come with Flock Pro" onClick=\{\(\) => setPaywallTrigger\('settings'\)\}/);
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
    // Only a build that sells on the web has /pro to go back to; off and the
    // App Store build (iap) never read it, so never send anybody there.
    expect(fn).toMatch(/const back = \(process\.env\.REACT_APP_PURCHASES !== 'off' && process\.env\.REACT_APP_PURCHASES !== 'iap'\) \? takeReturnAfterSignIn\(\) : null;\n\s+if \(back\) window\.location\.assign\(back\);/);
  });
});

describe('Pro bought somewhere else', () => {
  // Paying on flockcorp.com while the app sat in the background left the
  // open copy on its free-tier snapshot, Birdie capped, until a restart.
  const start = app.indexOf('const onForeground = () => {');
  const effect = app.slice(start, app.indexOf('}, [refreshEntitlements]);', start));

  test('the open app re-reads entitlements when it comes back to the foreground', () => {
    expect(start).toBeGreaterThan(-1);
    expect(effect).toMatch(/if \(document\.visibilityState === 'hidden'\) return;/);
    expect(effect).toMatch(/refreshEntitlements\(\);/);
    expect(effect).toMatch(/document\.addEventListener\('visibilitychange', onForeground\);/);
    expect(effect).toMatch(/window\.addEventListener\('focus', onForeground\);/);
  });

  test('once per 30 seconds, because iOS fires focus and visibilitychange together', () => {
    expect(effect).toMatch(/if \(Date\.now\(\) - lastRead < 30000\) return;/);
  });

  test('both listeners come off when the app unmounts', () => {
    expect(effect).toMatch(/document\.removeEventListener\('visibilitychange', onForeground\);/);
    expect(effect).toMatch(/window\.removeEventListener\('focus', onForeground\);/);
  });

  test('an older answer never overwrites a newer one', () => {
    // A resume read sent before the webhook lands can arrive after the upgrade
    // poll's Pro answer; applying it would flip a paying user back to free.
    expect(app).toMatch(/const applyEntitlements = useCallback\(\(seq, data\) => \{\n\s+if \(seq < entitlementsAppliedRef\.current\) return;/);
    expect(app).toMatch(/const seq = \+\+entitlementsSentRef\.current;\n\s+\(takeBootRead\('entitlements'\) \|\| getEntitlements\(\)\)\.then\(\(data\) => applyEntitlements\(seq, data\)\)/);
    expect(app).toMatch(/applyEntitlements\(seq, data\);\n[\s\S]{0,200}if \(!data\?\.isPremium\) again\(\);/);
    // Both readers go through it; nothing else sets the snapshot from a fetch.
    expect((app.match(/setEntitlements\(data\)/g) || []).length).toBe(1);
  });

  test('a Pro answer is what lifts the Birdie cap', () => {
    expect(app).toContain('const outOfChirps = !!entitlements?.paywallEnabled && !isPro && aiRemaining === 0');
  });
});
