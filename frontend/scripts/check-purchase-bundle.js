// WHAT A BUILT BUNDLE SELLS, CHECKED AGAINST WHAT ITS PURCHASES MODE ALLOWS.
//
//   node scripts/check-purchase-bundle.js iap            reads build/static/js
//   node scripts/check-purchase-bundle.js iap --build    builds first (below)
//   node scripts/check-purchase-bundle.js off|web [--build] [--dir=<build dir>]
//
// REACT_APP_PURCHASES has three modes (src/lib/purchasesBuild.js):
//   iap  the App Store build. Flock Pro through Apple's in-app purchase and
//        nothing else: it MUST carry the RevenueCat SDK and the Pro sheet, and
//        NONE of the web's ways to pay. Guideline 3.1.1: no link, button or
//        price that leads to a purchase outside the App Store, and Roost is
//        never sold in the app.
//   off  sells nothing: none of the web's ways to pay, and no RevenueCat SDK.
//   web  unset, the website: Stripe's checkout calls are there. Checked so the
//        patterns below are known to find what they look for.
//
// THE STRINGS, NOT THE WHOLE TEXT. Minified code names variables $9, $99 and
// so on once a scope runs out of shorter names, so "$99" in the raw text can be
// a variable as easily as a Roost price. The file is tokenized (acorn, which
// webpack itself parses with) and only its string, template and regular
// expression literals are searched, plus its names for the one pattern that
// can be a name (FLOCKFRIENDS).
//
// --build runs `npm run build` (scripts/build.js) for the mode, with CI=true
// and source maps on, into a folder of its own under the system temp folder
// (--dir moves it), so build/ is never overwritten. The source maps are read
// too when they are there: their source lists say whether the RevenueCat SDK
// was bundled, the same signal codemagic.yaml's RevenueCat key step reads.
//
// Exits 1 with every problem listed, 0 when the bundle holds exactly what its
// mode allows.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const FRONTEND = path.join(__dirname, '..');

// The web's ways to pay. None may be in a build that is not the website.
const WEB_PURCHASE = [
  { label: 'Stripe checkout page', text: 'checkout.stripe.com' },
  { label: 'Stripe billing portal', text: 'billing.stripe.com' },
  { label: 'Flock Pro web checkout call', text: '/api/pro/checkout' },
  { label: 'Roost billing calls', text: '/api/venue-billing' },
  { label: 'a promotion code for the web checkout', text: 'FLOCKFRIENDS', names: true },
  { label: 'a link into /pro with a query', text: '/pro?' },
  // $990 is found by $99 as well.
  { label: 'a Roost price', text: '$99' },
];

// What the web halves of the Pro sheet, the You tab's Flock Pro row and the
// venue dashboard say. Their absence is how the iap build shows the halves
// were compiled out rather than only hidden.
const WEB_HALF_WORDS = [
  'Opening checkout',
  'Flock Pro is not on sale on the web yet.',
  'Payment method and invoices',
  'Upgrade to Roost',
  'Requires Roost',
  'Email us about Roost',
];

// The RevenueCat Capacitor plugin's own code: its index names this method in
// a string literal (node_modules/@revenuecat/purchases-capacitor/dist/esm).
const REVENUECAT_SDK = 'trackCustomPaywallImpression';
const REVENUECAT_SOURCE = '@revenuecat/purchases-capacitor/';
// The Pro sheet's App Store half (components/PaywallSheet.js).
const PRO_SHEET = 'Restore purchases';

const MODES = ['iap', 'off', 'web'];

// Every string-ish literal in one file, and every name, as two lists.
function literalsOf(code) {
  const acorn = require('acorn');
  const strings = [];
  const names = [];
  acorn.parse(code, {
    ecmaVersion: 'latest',
    sourceType: 'script',
    allowHashBang: true,
    allowReturnOutsideFunction: true,
    onToken(token) {
      const label = token.type.label;
      if (label === 'string' || label === 'template') strings.push(String(token.value));
      else if (label === 'regexp') strings.push(String(token.value && token.value.pattern));
      else if (label === 'name' || label === 'privateId') names.push(String(token.value));
    },
  });
  return { strings, names };
}

// files: [{ name, code, sources }] where sources is the source map's list
// (or null without a map). Answers { problems, found }.
function checkBundle(mode, files) {
  if (!MODES.includes(mode)) throw new Error(`mode is one of ${MODES.join(', ')}, not ${mode}`);
  const problems = [];
  if (!files.length) return { problems: ['no JavaScript files to check'], found: {} };
  const hits = new Map();
  const note = (key, file) => {
    if (!hits.has(key)) hits.set(key, new Set());
    hits.get(key).add(file);
  };
  let sdkInMaps = false;
  let anyMap = false;
  for (const { name, code, sources } of files) {
    const { strings, names } = literalsOf(code);
    const text = strings.join('\n');
    for (const p of WEB_PURCHASE) {
      if (text.includes(p.text) || (p.names && names.some((n) => n.includes(p.text)))) note(p.text, name);
    }
    for (const w of WEB_HALF_WORDS) if (text.includes(w)) note(w, name);
    if (strings.some((s) => s === REVENUECAT_SDK)) note(REVENUECAT_SDK, name);
    if (text.includes(PRO_SHEET)) note(PRO_SHEET, name);
    if (Array.isArray(sources)) {
      anyMap = true;
      if (sources.some((s) => String(s).includes(REVENUECAT_SOURCE))) sdkInMaps = true;
    }
  }
  const where = (key) => [...(hits.get(key) || [])].sort().join(', ');
  const sdk = hits.has(REVENUECAT_SDK) || sdkInMaps;

  if (mode === 'iap' || mode === 'off') {
    for (const p of WEB_PURCHASE) {
      if (hits.has(p.text)) problems.push(`${p.label} ("${p.text}") is in ${where(p.text)}`);
    }
    for (const w of WEB_HALF_WORDS) {
      if (hits.has(w)) problems.push(`the web's purchase wording "${w}" is in ${where(w)}`);
    }
  }
  if (mode === 'iap') {
    if (!hits.has(REVENUECAT_SDK)) problems.push(`the RevenueCat SDK is not in the bundle (no "${REVENUECAT_SDK}" literal)`);
    if (anyMap && !sdkInMaps) problems.push(`no source map lists ${REVENUECAT_SOURCE}, which codemagic.yaml's key step reads to require the Apple key`);
    if (!hits.has(PRO_SHEET)) problems.push(`the Pro sheet's App Store half is not in the bundle (no "${PRO_SHEET}")`);
  }
  if (mode === 'off') {
    if (sdk) problems.push(`the RevenueCat SDK is in a build that sells nothing (${where(REVENUECAT_SDK) || 'named in a source map'})`);
    if (hits.has(PRO_SHEET)) problems.push(`the Pro sheet is in a build that sells nothing (${where(PRO_SHEET)})`);
  }
  if (mode === 'web') {
    // The website keeps all of it; these are here so a pattern that has gone
    // stale (a route renamed, say) shows up as a check that finds nothing.
    for (const t of ['/api/pro/checkout', '/api/venue-billing', '$99']) {
      if (!hits.has(t)) problems.push(`the web build no longer carries "${t}", so this check would not see it either`);
    }
    if (!hits.has(REVENUECAT_SDK)) problems.push('the web build no longer carries the RevenueCat SDK');
  }
  const found = Object.fromEntries([...hits.keys()].sort().map((k) => [k, where(k)]));
  return { problems, found, sdk, anyMap, sdkInMaps };
}

function readBuild(dir) {
  const js = path.join(dir, 'static', 'js');
  if (!fs.existsSync(js)) throw new Error(`${js} does not exist: build first, or pass --build`);
  return fs.readdirSync(js).filter((f) => f.endsWith('.js')).sort().map((name) => {
    let sources = null;
    const map = path.join(js, `${name}.map`);
    if (fs.existsSync(map)) {
      try {
        sources = JSON.parse(fs.readFileSync(map, 'utf8')).sources || [];
      } catch {
        sources = null;
      }
    }
    return { name, code: fs.readFileSync(path.join(js, name), 'utf8'), sources };
  });
}

function build(mode, dir) {
  const env = { ...process.env, CI: 'true', BUILD_PATH: dir, GENERATE_SOURCEMAP: 'true' };
  if (mode === 'web') delete env.REACT_APP_PURCHASES;
  else env.REACT_APP_PURCHASES = mode;
  console.log(`[purchase bundle] building with REACT_APP_PURCHASES=${mode === 'web' ? '(unset)' : mode} into ${dir}`);
  const r = spawnSync(process.execPath, [path.join(__dirname, 'build.js')], { cwd: FRONTEND, env, stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`the ${mode} build failed (exit ${r.status})`);
}

function main(argv) {
  const mode = argv.find((a) => !a.startsWith('--'));
  if (!MODES.includes(mode)) {
    console.error(`usage: node scripts/check-purchase-bundle.js <${MODES.join('|')}> [--build] [--dir=<build dir>]`);
    return 2;
  }
  const dirArg = argv.find((a) => a.startsWith('--dir='));
  const wantsBuild = argv.includes('--build');
  const dir = dirArg
    ? path.resolve(dirArg.slice('--dir='.length))
    : wantsBuild ? path.join(os.tmpdir(), `flock-purchase-bundle-${mode}`) : path.join(FRONTEND, 'build');
  if (wantsBuild) build(mode, dir);
  const files = readBuild(dir);
  const { problems, found, sdk, anyMap, sdkInMaps } = checkBundle(mode, files);
  console.log(`[purchase bundle] ${mode}: ${files.length} JS files in ${path.join(dir, 'static', 'js')}${anyMap ? '' : ' (no source maps)'}`);
  console.log(`[purchase bundle] RevenueCat SDK: ${sdk ? 'bundled' : 'absent'}${anyMap ? `; source maps ${sdkInMaps ? 'list' : 'do not list'} it` : ''}`);
  for (const [key, files_] of Object.entries(found)) console.log(`[purchase bundle]   "${key}": ${files_}`);
  if (problems.length) {
    console.error(`[purchase bundle] FAILED, ${problems.length} problem(s):`);
    for (const p of problems) console.error(`  - ${p}`);
    return 1;
  }
  console.log(`[purchase bundle] OK: the ${mode} bundle holds what its mode allows.`);
  return 0;
}

module.exports = { checkBundle, literalsOf, WEB_PURCHASE, WEB_HALF_WORDS, REVENUECAT_SDK, PRO_SHEET };

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    console.error(`[purchase bundle] ${err.message}`);
    process.exitCode = 1;
  }
}
