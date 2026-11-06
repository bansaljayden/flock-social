/**
 * Packages that reach a phone or a browser and once sat inside a published
 * advisory's range stay above it.
 *
 * The lockfile is what gets installed: Codemagic runs `npm install`, which keeps
 * the locked versions, and so does every web build. A package.json range such
 * as ^8.4.0 already allowed the fixed release and changed nothing on its own.
 * So these checks read the lockfile, every copy of each package in it, and a
 * regenerated or merged lockfile that slides back into a listed range fails
 * here instead of shipping.
 *
 * The Capacitor advisory is about native code. `npx cap sync ios` writes the
 * installed @capacitor/ios version into CapApp-SPM/Package.swift as the exact
 * capacitor-swift-pm pin, and that pin decides which Capacitor the iPhone app
 * links. The committed copy is kept by hand when a Windows box cannot write it
 * (its header says why), so it is held to the lockfile here too.
 */
const fs = require('fs');
const path = require('path');

const FRONTEND = path.resolve(__dirname, '..', '..');
const read = (...p) => fs.readFileSync(path.join(FRONTEND, ...p), 'utf8');

const lock = JSON.parse(read('package-lock.json'));
const pkg = JSON.parse(read('package.json'));
const spmManifest = read('ios', 'App', 'CapApp-SPM', 'Package.swift');

const parts = (v) => v.split('-')[0].split('.').map(Number);
const compare = (a, b) => {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
};
/** Ranges are [lowest affected, first fixed). */
const affectedBy = (version, ranges) =>
  ranges.some(([lo, fixed]) => compare(version, lo) >= 0 && compare(version, fixed) < 0);

/** Every installed copy of a package, nested ones included, as [lockfile key, version]. */
const copiesOf = (name) => Object.entries(lock.packages)
  .filter(([key]) => key === `node_modules/${name}` || key.endsWith(`/node_modules/${name}`))
  .map(([key, entry]) => [key, entry.version]);

const ADVISORIES = [
  {
    id: 'GHSA-rvm3-566m-v7fv',
    // Critical. The WebView's navigation guard ignored the path, so a tapped
    // link to /_capacitor_http_interceptor_ loaded remote content at the app's
    // own origin, with plugin access, even with CapacitorHttp off.
    name: '@capacitor/ios',
    // The Capacitor 8 ranges. 8.5.0 is affected as well (fixed in 8.5.1),
    // which matters for the move to 8.5 that the UIScene migration needs.
    affected: [['8.0.0', '8.4.3'], ['8.5.0', '8.5.1']],
  },
  {
    id: 'GHSA-cg2g-xh64-v4q7 and GHSA-mrv2-3pqr-j5jr',
    // Critical and high. Only posthog-js pulls it in, for its product tours,
    // and Flock never calls DOMPurify itself, so this one keeps the audit
    // honest rather than closing a reachable hole.
    name: 'dompurify',
    affected: [['0.0.0', '3.4.17']],
  },
];

describe.each(ADVISORIES)('$name stays outside $id', ({ name, affected }) => {
  test('every copy in the lockfile is a fixed version', () => {
    const copies = copiesOf(name);
    expect(copies.length).toBeGreaterThan(0);
    expect(copies.filter(([, version]) => affectedBy(version, affected))).toEqual([]);
  });

  test('a direct dependency declares a fixed version as its floor', () => {
    const range = pkg.dependencies[name] || (pkg.devDependencies || {})[name];
    if (!range) return; // pulled in by another package; the lockfile check covers it
    const floor = range.replace(/^[\^~>=\s]+/, '');
    expect(affectedBy(floor, affected)).toBe(false);
  });
});

describe('Capacitor runtime and SwiftPM pin', () => {
  const locked = (name) => lock.packages[`node_modules/${name}`].version;

  test('@capacitor/core and @capacitor/cli are locked to the @capacitor/ios version', () => {
    const ios = locked('@capacitor/ios');
    expect({ core: locked('@capacitor/core'), cli: locked('@capacitor/cli') }).toEqual({ core: ios, cli: ios });
  });

  test('the committed Package.swift pins capacitor-swift-pm to the locked @capacitor/ios version', () => {
    const pin = spmManifest.match(/capacitor-swift-pm\.git",\s*exact:\s*"([^"]+)"/);
    expect(pin).not.toBeNull();
    expect(pin[1]).toBe(locked('@capacitor/ios'));
  });
});
