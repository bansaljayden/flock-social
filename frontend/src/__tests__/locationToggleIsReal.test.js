/**
 * THE LOCATION SWITCH THAT REPORTED A STATE IT DID NOT ENFORCE.
 *
 * Settings has a "Location services" row. Turning it off wrote a flag, printed
 * "Location is turned off" under the row, and changed almost nothing. The boot
 * effect did check the flag. Two other doors did not:
 *
 *   1. Tapping the Discover tab called requestUserLocation() unconditionally.
 *   2. MapLibreMapView's init effect calls getUserLocation() whenever it is
 *      given no initialCenter, and the map mounts on the first visit to
 *      Discover.
 *
 * So the switch stopped the prompt at launch and the first tap on Discover
 * asked anyway. A switch that reports a state it does not enforce is worse than
 * no switch at all, because the person believes they have already handled it
 * and stops looking. On iOS it is worse still: the OS allows one prompt per
 * install and a denial is permanent, so the ask the switch was meant to prevent
 * is the only one the app will ever get.
 *
 * These read the compiled source rather than rendering, because the doors are
 * inside a 20,000 line component. Comments are stripped first: this file is
 * full of prose that names the very flag being checked, and a scan that cannot
 * tell code from prose reports whatever the prose says. That mistake has
 * defeated five separate guards in this repository.
 */

const fs = require('fs');
const path = require('path');

const RAW = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8').split('\r').join('');

/** Line comments removed, string literals kept. */
const APP = RAW
  .split('\n')
  .map((line) => line.replace(/(^|[^:])\/\/[^\n]*$/, '$1'))
  .join('\n');

function slice(from, to, min = 80, max = 4000) {
  const a = APP.indexOf(from);
  expect(a).toBeGreaterThan(-1);
  const b = APP.indexOf(to, a);
  expect(b).toBeGreaterThan(a);
  const src = APP.slice(a, b);
  expect(src.length).toBeGreaterThan(min);
  expect(src.length).toBeLessThan(max);
  return src;
}

describe('the stripper is doing its job', () => {
  it('removes a line comment and keeps the code beside it', () => {
    const out = ['const a = 1; // locationEnabled mentioned in prose', 'const b = 2;']
      .join('\n')
      .split('\n')
      .map((line) => line.replace(/(^|[^:])\/\/[^\n]*$/, '$1'))
      .join('\n');
    expect(out).toContain('const a = 1;');
    expect(out).toContain('const b = 2;');
    expect(out).not.toContain('prose');
  });

  it('does not eat a URL', () => {
    const out = "const u = 'https://x.test/a';"
      .replace(/(^|[^:])\/\/[^\n]*$/, '$1');
    expect(out).toContain('https://x.test/a');
  });
});

describe('every door that can raise the OS location prompt checks the switch', () => {
  it('the Discover tab does not ask when the switch is off', () => {
    const tab = slice("if (tabId === 'explore'", 'requestUserLocation();');
    expect(tab).toContain('locationEnabled');
  });

  it('the map skips its own geolocation call when the switch is off', () => {
    // The map is the second door and the one that survives a tab switch,
    // because it stays mounted once Discover has been opened.
    const init = slice('const located = ', 'const userLoc =');
    expect(init).toContain('locationAllowed');
  });

  it('the switch is actually handed to the map, not just accepted by it', () => {
    // A defaulted prop nobody passes is a gate that is always open.
    const render = slice('<MapLibreMapView', '/>');
    expect(render).toContain('locationAllowed={locationEnabled}');
  });

  it('the boot effect still checks it, which it always did', () => {
    const boot = slice('if (venueLoadAttemptedRef.current) return;', '}, [requestUserLocation]);');
    expect(boot).toContain("flock_location_enabled") ;
  });
});

describe('the state is visible on the screen the setting governs', () => {
  it('Discover says location is off rather than just showing a generic map', () => {
    // Without this the map opens somewhere generic with no user pin and nothing
    // explaining why, which reads as a broken map rather than a chosen setting.
    expect(APP).toMatch(/Location services are off/);
  });

  it('and offers a way back on, without a trip to Settings', () => {
    const band = slice('Location services are off', '</div>', 80, 3000);
    expect(band).toContain('toggleLocation(true)');
  });

  it('the off banner and the error banner cannot both claim the screen', () => {
    // The error banner is about a location attempt that failed. With the switch
    // off there is no attempt, so showing both would be two explanations for
    // one blank map.
    expect(APP).toContain('!locationLoading && locationEnabled && (locationError || venueLoadError)');
  });
});
