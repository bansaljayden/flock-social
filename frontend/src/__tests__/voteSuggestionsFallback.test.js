/**
 * The vote panel looks where the map looks, and says so.
 *
 * These two facts have to move together, which is why one file pins both.
 *
 * WHAT WENT WRONG. `loadPopularVenues` returned early with no location, so the
 * app contradicted itself in the space of one tab: Discover showed twenty
 * Philadelphia venues over a live crowd heat map, and the vote panel inside a
 * flock said "to see places to suggest, Flock needs your location" -- with the
 * venues already on screen a tab away. The coordinate was available; the panel
 * declined to use the one everything else was using.
 *
 * WHAT MAKES THE FIX HONEST. A fallback list headed "Popular Chains Nearby" is
 * a claim about distance made by an app that has just admitted it does not know
 * where you are. So the heading names the city instead, and the panel says the
 * same thing in words. That is the whole licence for showing the list at all,
 * and it is worth a test because a heading is exactly the kind of string that
 * gets "simplified" back later.
 */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..');
const APP = fs.readFileSync(path.join(SRC, 'App.js'), 'utf8');
const CHAT = fs.readFileSync(path.join(SRC, 'screens', 'ChatDetail.js'), 'utf8');
const DM = fs.readFileSync(path.join(SRC, 'screens', 'DmDetail.js'), 'utf8');

const region = (text, from, to) => {
  const a = text.indexOf(from);
  expect(a).toBeGreaterThan(-1);
  const b = text.indexOf(to, a);
  expect(b).toBeGreaterThan(a);
  return text.slice(a, b);
};

describe('venue suggestions with no location', () => {
  const loader = () => region(
    APP,
    'const loadPopularVenues = useCallback',
    '}, [userLocation, venuesToMapPins]);',
  );

  test('the loader falls back instead of returning empty-handed', () => {
    const fn = loader();
    expect(fn).toMatch(/userLocation \|\| NO_LOCATION_VIEW/);
    // The early return is the bug itself. Nothing else in this function may
    // reintroduce it.
    expect(fn).not.toMatch(/if \(!userLocation\) return/);
  });

  test('the fallback is a place to look, never a claim about the user', () => {
    const fn = loader();
    // The three things that turned the old fixed point in Bethlehem from a
    // default into a bug: a blue dot, a stored coordinate, and a distance
    // measured from a guess.
    expect(fn).not.toMatch(/setUserLocation/);
    expect(fn).not.toMatch(/localStorage\.setItem/);
  });

  test('the label is null exactly when the location is real', () => {
    expect(APP).toMatch(
      /const venuesFromLabel = userLocation \? null : NO_LOCATION_VIEW\.label;/,
    );
    expect(APP).toMatch(/label: 'Philadelphia'/);
  });
});

describe.each([['ChatDetail', CHAT], ['DmDetail', DM]])(
  '%s says where the list came from',
  (_name, text) => {
    test('"nearby" is used only when the coordinate was real', () => {
      // The heading is conditional, and the fallback branch names a city rather
      // than asserting proximity.
      expect(text).toMatch(
        /venuesFromLabel \? `Popular in \$\{venuesFromLabel\}` : 'Popular Chains Nearby'/,
      );
    });

    test('the screen takes the label as a prop', () => {
      expect(text).toMatch(/^\s{2}venuesFromLabel,$/m);
    });
  },
);

describe('the flock panel', () => {
  test('offers the list rather than refusing when there is one', () => {
    // The old condition was `userLocation ? ... : refuse`, which is what put a
    // refusal in front of a list the app already had.
    expect(CHAT).toMatch(
      /\{suggestedVenues\.length > 0 \|\| \(popularVenues \|\| \[\]\)\.length > 0 \?/,
    );
    expect(CHAT).not.toMatch(/To see places to suggest, Flock needs your location/);
  });

  test('and tells the reader whose city they are looking at', () => {
    expect(CHAT).toMatch(/These are in \{venuesFromLabel\}\./);
  });
});
