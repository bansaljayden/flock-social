// ---------------------------------------------------------------------------
// THE iOS BUNDLE'S SCRIPTS MUST LOAD FROM EVERY PATH THE SHELL NAVIGATES TO.
//
// codemagic.yaml built the App Store bundle with PUBLIC_URL ".", so CRA wrote
// relative asset URLs into index.html (./static/js/main.<hash>.js) and gave
// webpack the same relative public path for every lazy chunk. Capacitor serves
// the bundle from the root of capacitor://localhost and answers any path with
// no extension with index.html. Relative URLs are fine at "/" and at a
// one-segment path like /app. They break at a nested one:
//
//   capacitor://localhost/admin/moderation
//     index.html            served (no extension, so the router falls back)
//     ./static/js/main.js   -> /admin/static/js/main.js, not in the bundle
//
// Nothing ran, #root stayed empty, and a WebView has no URL bar and no back
// gesture, so the admin was left on a blank screen until a force-quit. That is
// exactly where a moderation_report push tap and the admin dashboard's
// "Moderation console" button send the WebView, in place, on purpose
// (paymentHandoffAndDeepLinks.test.js says why it must be in place).
//
// A local build without PUBLIC_URL writes /static/..., which is why nothing on
// a developer machine ever showed it. So this reads the workflows that build
// the iOS bundle, works out the public path CRA will use from the same helper
// react-scripts calls, and resolves the main script against every literal path
// the app navigates the WebView to.
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
// The function react-scripts' config/paths.js calls to turn PUBLIC_URL and
// "homepage" into the public path, so the answer here is the build's answer.
const getPublicUrlOrPath = require('react-dev-utils/getPublicUrlOrPath');

const REPO = path.resolve(__dirname, '..', '..', '..');
const SRC = path.join(REPO, 'frontend', 'src');
const read = (...p) => fs.readFileSync(path.join(REPO, ...p), 'utf8').replace(/\r\n/g, '\n');

const yaml = read('codemagic.yaml');
const pkg = JSON.parse(read('frontend', 'package.json'));

// Every workflow under `workflows:`, as { id, block }.
function workflows() {
  const body = yaml.slice(yaml.indexOf('\nworkflows:\n') + 1);
  const heads = [...body.matchAll(/\n {2}([a-z][a-z0-9-]*):\n/g)];
  return heads.map((m, i) => ({
    id: m[1],
    block: body.slice(m.index, i + 1 < heads.length ? heads[i + 1].index : body.length),
  }));
}

// The PUBLIC_URL a workflow's web build runs with: an inline assignment on the
// build line wins over the workflow's vars, as it would in the shell.
function publicUrlOf(block) {
  const build = /\n\s+script: ([^\n]*npm run build[^\n]*)\n/.exec(block);
  const inline = build && /(?:^|\s)PUBLIC_URL=("[^"]*"|'[^']*'|\S+)/.exec(build[1]);
  if (inline) return inline[1].replace(/^["']|["']$/g, '');
  const v = /\n\s+PUBLIC_URL:\s*("([^"]*)"|'([^']*)'|(\S+))/.exec(block);
  if (!v) return undefined;
  return v[2] !== undefined ? v[2] : v[3] !== undefined ? v[3] : v[4];
}

// Every literal path the app sends the WebView to in place.
function inPlaceTargets() {
  const out = new Set();
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (name === '__tests__' || name === 'node_modules') continue;
      if (fs.statSync(full).isDirectory()) { walk(full); continue; }
      if (!name.endsWith('.js')) continue;
      const src = fs.readFileSync(full, 'utf8');
      for (const m of src.matchAll(/location\.(?:assign|replace)\(\s*'(\/[^']*)'\s*\)|location\.href\s*=\s*'(\/[^']*)'/g)) {
        out.add(m[1] || m[2]);
      }
    }
  };
  walk(SRC);
  return [...out].sort();
}

const IOS = workflows().filter((w) => /npx cap sync ios/.test(w.block));
const ORIGIN = 'capacitor://localhost';

describe('the iOS bundle loads its scripts from every path the shell opens', () => {
  test('there are iOS workflows to check, and the console is among the paths', () => {
    // Not vacuous: both halves of the check below have something in them.
    expect(IOS.map((w) => w.id)).toEqual(expect.arrayContaining(['ios-capacitor', 'ios-review-recording']));
    expect(inPlaceTargets()).toContain('/admin/moderation');
  });

  test.each(IOS.map((w) => [w.id, w.block]))('%s builds with a root-absolute public path', (id, block) => {
    const publicPath = getPublicUrlOrPath(false, pkg.homepage, publicUrlOf(block));
    expect([id, publicPath.startsWith('/')]).toEqual([id, true]);
  });

  test.each(IOS.map((w) => [w.id, w.block]))('%s: the main script resolves to the bundle root from every in-place path', (id, block) => {
    const publicPath = getPublicUrlOrPath(false, pkg.homepage, publicUrlOf(block));
    for (const target of ['/', ...inPlaceTargets()]) {
      const script = new URL(`${publicPath}static/js/main.0123abcd.js`, `${ORIGIN}${target}`).href;
      expect([target, script]).toEqual([target, `${ORIGIN}/static/js/main.0123abcd.js`]);
    }
  });

  test('the check itself tells a relative path apart, so it cannot pass on nothing', () => {
    // What the workflows used to set. If this ever resolves to the root, the
    // two tests above have stopped measuring anything.
    const relative = getPublicUrlOrPath(false, pkg.homepage, '.');
    const script = new URL(`${relative}static/js/main.0123abcd.js`, `${ORIGIN}/admin/moderation`).href;
    expect(script).toBe(`${ORIGIN}/admin/static/js/main.0123abcd.js`);
  });
});
