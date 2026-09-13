/**
 * Two build flags exist only so the unattended review recording films clean:
 * REACT_APP_REVIEW_HIDE_LOCATION_BANNER keeps Discover's "Could not get your
 * location" banner out of the take (the Simulator's fix never reaches the app
 * under Maestro), and REACT_APP_REVIEW_FORCE_LIGHT makes the theme clock
 * answer light (the machine that films keeps UTC time, so a run after 20:00
 * UTC would otherwise come out dark).
 *
 * Both hide something true from a real person if they ever reach production,
 * so this pins where they may be set: the ios-review-recording workflow's
 * build line and nowhere else, and it pins that the flag reads stay exactly
 * where the comments say they are.
 */
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..', '..', '..');
const read = (...p) => fs.readFileSync(path.join(REPO, ...p), 'utf8');

const APP = read('frontend', 'src', 'App.js');
// The banner the flag gates is drawn on Discover, and the Discover tab left
// App.js on 2026-09-13 for screens/ExploreScreen.js. The flag itself is still
// declared and read in App.js, so the two halves are asserted against the two
// files: pointed at App.js alone the render half would look for a line that is
// not there any more and go red on a move rather than on a regression.
const EXPLORE = read('frontend', 'src', 'screens', 'ExploreScreen.js');
const THEME = read('frontend', 'src', 'context', 'ThemeContext.js');
const INDEX = read('frontend', 'src', 'index.js');
const CODEMAGIC = read('codemagic.yaml');
const ENV_EXAMPLE = read('frontend', '.env.example');

describe('the recording-only build flags', () => {
  test('the banner flag is read once, compared to the string true, and gates the banner render', () => {
    const reads = APP.match(/process\.env\.REACT_APP_REVIEW_HIDE_LOCATION_BANNER/g) || [];
    expect(reads).toHaveLength(1);
    expect(APP).toContain("const REVIEW_HIDE_LOCATION_BANNER = process.env.REACT_APP_REVIEW_HIDE_LOCATION_BANNER === 'true';");
    expect(EXPLORE).toContain('(locationError || venueLoadError) && !REVIEW_HIDE_LOCATION_BANNER && (');
  });

  test('the light flag short-circuits the clock in both places the clock lives', () => {
    const line = "if (process.env.REACT_APP_REVIEW_FORCE_LIGHT === 'true') return false;";
    expect(THEME).toContain(line);
    expect(INDEX).toContain(line);
    // and only there
    const all = [APP, THEME, INDEX].join('\n').match(/REACT_APP_REVIEW_FORCE_LIGHT/g) || [];
    expect(all).toHaveLength(2);
  });

  test('only the review-recording workflow sets them, on its own build line', () => {
    const setters = CODEMAGIC.match(/REACT_APP_REVIEW_(HIDE_LOCATION_BANNER|FORCE_LIGHT)=true/g) || [];
    expect(setters).toEqual(['REACT_APP_REVIEW_HIDE_LOCATION_BANNER=true', 'REACT_APP_REVIEW_FORCE_LIGHT=true']);
    const recording = CODEMAGIC.slice(CODEMAGIC.indexOf('ios-review-recording:'));
    expect(recording).toContain('script: REACT_APP_REVIEW_HIDE_LOCATION_BANNER=true REACT_APP_REVIEW_FORCE_LIGHT=true npm run build');
    // the workflows before it build without them
    const before = CODEMAGIC.slice(0, CODEMAGIC.indexOf('ios-review-recording:'));
    expect(before).not.toContain('REACT_APP_REVIEW_');
  });

  test('the env example documents both as unset', () => {
    expect(ENV_EXAMPLE).toMatch(/^REACT_APP_REVIEW_HIDE_LOCATION_BANNER=$/m);
    expect(ENV_EXAMPLE).toMatch(/^REACT_APP_REVIEW_FORCE_LIGHT=$/m);
  });
});
