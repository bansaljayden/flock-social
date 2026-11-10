/**
 * WHAT scripts/check-purchase-bundle.js LOOKS FOR, AND THAT IT FINDS IT.
 *
 * The script reads a real production build (`node scripts/check-purchase-bundle.js
 * iap --build` makes one with REACT_APP_PURCHASES=iap) and fails unless the
 * bundle holds what its mode allows: for iap, the App Store build, the
 * RevenueCat SDK and the Pro sheet, and none of the web's ways to pay. A build
 * takes minutes, so the suite does not make one; it pins the list and runs the
 * checker on small bundles written here, so a pattern that stops matching, or
 * a check that stops failing, shows up on every run.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test purchaseBundleCheck --watchAll=false
 */
const path = require('path');

const check = require(path.join(__dirname, '..', '..', 'scripts', 'check-purchase-bundle.js'));

// The smallest bundle an iap build could be: the RevenueCat plugin's own
// string, the Pro sheet's App Store half, and a minifier's three-letter name.
const SDK_CHUNK = { name: '7270.a.chunk.js', code: 'var e=new Proxy(n,{get:function(n,t,r){return"trackCustomPaywallImpression"===t?1:Reflect.get(n,t,r)}});', sources: ['services/purchases.js', '../node_modules/@revenuecat/purchases-capacitor/dist/esm/index.js'] };
const SHEET_CHUNK = { name: '5400.b.chunk.js', code: 'var a={children:"Restore purchases"},b=`Renews at ${p} every ${q} until you cancel in your App Store settings. `;', sources: ['components/PaywallSheet.js'] };
const MAIN = { name: 'main.c.js', code: 'function $99(e){return e}var $990=$99(2);fetch("/api/pro/status");', sources: ['index.js', 'App.js'] };
const IAP = [MAIN, SDK_CHUNK, SHEET_CHUNK];
const OFF = [MAIN];

const withCode = (code) => ({ name: 'extra.d.js', code, sources: ['screens/VenueDashboard.js'] });

describe('the list', () => {
  test('is the web\'s ways to pay, as the App Store build must not carry them', () => {
    expect(check.WEB_PURCHASE.map((p) => p.text)).toEqual([
      'checkout.stripe.com',
      'billing.stripe.com',
      '/api/pro/checkout',
      '/api/venue-billing',
      'FLOCKFRIENDS',
      '/pro?',
      '$99',
    ]);
    expect(check.REVENUECAT_SDK).toBe('trackCustomPaywallImpression');
    expect(check.PRO_SHEET).toBe('Restore purchases');
  });

  test('the SDK marker is a string the plugin itself carries', () => {
    const fs = require('fs');
    const index = fs.readFileSync(require.resolve('@revenuecat/purchases-capacitor'), 'utf8');
    expect(index).toContain(`'${check.REVENUECAT_SDK}'`);
  });

  test('the Pro sheet marker is the App Store half\'s Restore button', () => {
    const fs = require('fs');
    const sheet = fs.readFileSync(path.join(__dirname, '..', 'components', 'PaywallSheet.js'), 'utf8');
    expect(sheet).toContain(`{restoring ? 'Restoring…' : '${check.PRO_SHEET}'}`);
  });
});

describe('iap, the App Store build', () => {
  test('a bundle with the SDK and the Pro sheet and no web way to pay passes', () => {
    expect(check.checkBundle('iap', IAP).problems).toEqual([]);
  });

  test.each([
    ['"https://checkout.stripe.com/c/pay/cs_test"'],
    ['"https://billing.stripe.com/p/session/x"'],
    ['"/api/pro/checkout"'],
    ['"/api/venue-billing/status"'],
    ['"Code FLOCKFRIENDS is applied"'],
    ['{FLOCKFRIENDS:.5}'],
    ['`/pro?code=${c}`'],
    ['"Roost · $99/mo"'],
    ['"$990 a year"'],
  ])('fails on %s', (literal) => {
    const { problems } = check.checkBundle('iap', [...IAP, withCode(`var x=${literal};`)]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/ is in extra\.d\.js$/);
  });

  test('fails on the web halves\' own wording', () => {
    for (const words of check.WEB_HALF_WORDS) {
      const { problems } = check.checkBundle('iap', [...IAP, withCode(`var x=${JSON.stringify(words)};`)]);
      expect({ words, problems }).toEqual({ words, problems: [`the web's purchase wording "${words}" is in extra.d.js`] });
    }
  });

  test('a minified name is not a price: $99 and $990 as variables pass', () => {
    expect(check.checkBundle('iap', [...IAP, withCode('function $99(){}var $990=$99;')]).problems).toEqual([]);
  });

  test('fails without the RevenueCat SDK, and without the Pro sheet', () => {
    expect(check.checkBundle('iap', [MAIN, SHEET_CHUNK]).problems).toEqual([
      'the RevenueCat SDK is not in the bundle (no "trackCustomPaywallImpression" literal)',
      'no source map lists @revenuecat/purchases-capacitor/, which codemagic.yaml\'s key step reads to require the Apple key',
    ]);
    expect(check.checkBundle('iap', [MAIN, SDK_CHUNK]).problems).toEqual([
      'the Pro sheet\'s App Store half is not in the bundle (no "Restore purchases")',
    ]);
  });
});

describe('off, the build that sells nothing', () => {
  test('a bundle with neither the SDK nor the sheet passes', () => {
    expect(check.checkBundle('off', OFF).problems).toEqual([]);
  });

  test('fails with the SDK or the sheet in it, or a web way to pay', () => {
    expect(check.checkBundle('off', IAP).problems).toEqual([
      'the RevenueCat SDK is in a build that sells nothing (7270.a.chunk.js)',
      'the Pro sheet is in a build that sells nothing (5400.b.chunk.js)',
    ]);
    expect(check.checkBundle('off', [...OFF, withCode('fetch("/api/pro/checkout")')]).problems).toEqual([
      'Flock Pro web checkout call ("/api/pro/checkout") is in extra.d.js',
    ]);
  });
});

describe('web, the website', () => {
  test('must still carry the calls the other modes may not, or the patterns have gone stale', () => {
    expect(check.checkBundle('web', IAP).problems).toEqual([
      'the web build no longer carries "/api/pro/checkout", so this check would not see it either',
      'the web build no longer carries "/api/venue-billing", so this check would not see it either',
      'the web build no longer carries "$99", so this check would not see it either',
    ]);
    const site = [...IAP, withCode('fetch("/api/pro/checkout");fetch("/api/venue-billing/status");var p="$99 a month";')];
    expect(check.checkBundle('web', site).problems).toEqual([]);
  });
});

describe('the reader', () => {
  test('reads strings, templates and regular expressions, and names apart', () => {
    const { strings, names } = check.literalsOf('var FLOCK=1,a="x",b=`t${a}u`,c=/re+gex/g;');
    expect(strings).toEqual(['x', 't', 'u', 're+gex']);
    expect(names).toEqual(expect.arrayContaining(['FLOCK', 'a', 'b', 'c']));
  });

  test('an unknown mode is refused rather than checked as something else', () => {
    expect(() => check.checkBundle('on', IAP)).toThrow(/mode is one of iap, off, web/);
  });
});
