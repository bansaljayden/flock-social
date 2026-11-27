/**
 * The AI-crawler surface: api/marketing-page.js against the React pages it
 * mirrors, and the vercel.json wiring that routes bots to it.
 *
 * WHY THIS SUITE EXISTS
 * AI and answer-engine crawlers do not execute JavaScript, so vercel.json
 * rewrites five marketing routes (/, /about, /support, /privacy, /terms) to
 * api/marketing-page.js when the user agent is one of the named AI crawlers.
 * Humans keep the React app at the same URLs. Serving bots a different
 * document is legitimate exactly as long as it says what the rendered page
 * says, and becomes cloaking the moment it diverges. This suite is the line:
 *
 *   1. It renders the five components with ReactDOMServer, extracts their
 *      content blocks with fixed rules, and requires DEEP EQUALITY with the
 *      blocks the function serves. A copy edit in src/website that is not
 *      mirrored into api/marketing-page.js fails here, and the jest diff
 *      prints the exact new text to carry over.
 *   2. It pins the function's JSON-LD @graph to the copy in public/index.html
 *      so the site describes one Organization everywhere.
 *   3. It checks the user-agent pattern routes the AI crawlers and does NOT
 *      route Googlebot, Bingbot or Applebot, which render JavaScript and must
 *      keep seeing exactly what humans see.
 *
 * WHEN THE BLOCK-EQUALITY TESTS FAIL after a deliberate copy change: update
 * the strings in api/marketing-page.js PAGE_BLOCKS to the freshly extracted
 * text shown in the diff. Do NOT paste in anything from a mock or example
 * element (the hygiene test below backstops that); if a new illustration or
 * form appears on a page, add its selector to EXCLUDE here instead.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test --watchAll=false
 *
 * This is a FRONTEND test (jest via react-scripts), not a `node --test` one.
 */

const fs = require('fs');
const path = require('path');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

// Same stubs as marketingSiteAccessibility.test.js: LiveDemo pulls a 1 MB map
// engine and BirdieBird runs a rAF loop over photographs. Neither carries
// marketing copy (LiveDemo's content is fetched at runtime and is excluded
// from the bot document for the same reason the mocks are excluded: it is
// illustration, not claims), so stubbing them is consistent with what the
// function serves.
jest.mock('../website/LiveDemo', () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock('../components/ui/BirdieBird', () => ({
  __esModule: true,
  default: () => null,
  WARM_BIRD: { body: '', head: '', flap: null, neck: '0 0' },
  BIRDIE: { body: '', head: '', flap: null, neck: '0 0' },
}));

const LandingPage = require('../website/LandingPage').default;
const AboutPage = require('../website/AboutPage').default;
const SupportPage = require('../website/SupportPage').default;
const PrivacyPolicy = require('../website/PrivacyPolicy').default;
const TermsOfService = require('../website/TermsOfService').default;

const api = require('../../api/marketing-page.js');

const FRONTEND = path.join(__dirname, '..', '..');
const WEBSITE = path.join(__dirname, '..', 'website');
const read = (p) => fs.readFileSync(p, 'utf8');

// ───────────────────────────────────────────────────────────────────────────
// Extraction. These rules define what "the same content" means, so changing
// them changes the cloaking guarantee — think before touching.
//
// Included: h1/h2/h3, paragraphs, list items, and the privacy contact email
// link (its only wrapper is a div). Excluded, per page:
//   - navigation chrome: skip links, header nav, the menu panel, the legal
//     pages' contents rail and back link, footers (the bot document has its
//     own nav block instead);
//   - form controls and their live regions (nothing a bot can submit);
//   - the three synthetic illustrations on the landing page (dead-chat mock,
//     example bill split, example SOS email) so example numbers can never be
//     quoted as data;
//   - aria-hidden decoration and the pp section numbers.
// ───────────────────────────────────────────────────────────────────────────
const EXCLUDE = {
  home: [
    '.lp-skip', 'header.lp-nav', '#lp-menu', '.lp-chat', '.lp-split',
    // `.lp-appstore` was in this list and is not any more. Everything else
    // here is navigation chrome or a synthetic illustration; that one was a
    // status badge whose visible text was "Coming soon to the App Store".
    // Stripping it left the bot document saying nothing at all about
    // availability, beside a Terms heading that used to assert the app WAS on
    // the store. An answer engine read the claim and never read the caveat,
    // which is the cloaking line this file exists to hold. Since 2026-11-04
    // `.lp-appstore` is Apple's badge, an image link with no text of its own,
    // and the availability claim is in the paragraphs beside it, which this
    // extraction carries ("Now on the App Store. Released November 4, 2026").
    // `form.lp-form` and `.lp-form-status` left with the waitlist form
    // (2026-11-05); the page has no form now.
    '.lp-sos-mail',
    'figure', 'footer.lp-footer',
    // The accuracy caption that sat over LiveDemo (`.lp-demo-proof`) was cut
    // from the page on 2026-10-03, and from api/marketing-page.js with it, so
    // there is nothing here to exclude. The measured figures remain on /about.
  ],
  pp: ['.pp-skip', '.pp-back', 'nav', 'footer'],
  // Pages built on the landing page's system with SiteNav (/about since
  // 2026-10-21): the skip link, the bar, the menu panel, the photo plates and
  // the footer.
  lpPage: ['.lp-skip', 'header.lp-nav', '#lp-menu', 'figure', 'footer'],
};

function extractBlocks(markup, excludeSelectors) {
  const host = document.createElement('div');
  host.innerHTML = markup;
  for (const sel of excludeSelectors) {
    host.querySelectorAll(sel).forEach((n) => n.remove());
  }
  host.querySelectorAll('[aria-hidden="true"], .pp-num, .pp-toc-num').forEach((n) => n.remove());
  host.querySelectorAll('br').forEach((n) => n.replaceWith(document.createTextNode(' ')));
  const blocks = [];
  host.querySelectorAll('h1,h2,h3,p,li,a.pp-contact-mail').forEach((el) => {
    const text = el.textContent.replace(/\s+/g, ' ').trim();
    const tag = el.tagName === 'A' ? 'p' : el.tagName.toLowerCase();
    if (text) blocks.push([tag, text]);
  });
  return blocks;
}

const rendered = {
  home: extractBlocks(renderToStaticMarkup(React.createElement(LandingPage)), EXCLUDE.home),
  about: extractBlocks(renderToStaticMarkup(React.createElement(AboutPage)), EXCLUDE.lpPage),
  support: extractBlocks(renderToStaticMarkup(React.createElement(SupportPage)), EXCLUDE.pp),
  privacy: extractBlocks(renderToStaticMarkup(React.createElement(PrivacyPolicy)), EXCLUDE.pp),
  terms: extractBlocks(renderToStaticMarkup(React.createElement(TermsOfService)), EXCLUDE.pp),
};

// ───────────────────────────────────────────────────────────────────────────
describe('the bot document is the rendered page, block for block', () => {
  for (const key of ['home', 'about', 'support', 'privacy', 'terms']) {
    test(`${key}: served blocks deep-equal the extracted React render`, () => {
      expect(api.PAGE_BLOCKS[key]).toEqual(rendered[key]);
    });
  }

  test('titles and descriptions are the ones each page writes into the head', () => {
    const sources = {
      home: read(path.join(WEBSITE, 'LandingPage.js')),
      about: read(path.join(WEBSITE, 'AboutPage.js')),
      support: read(path.join(WEBSITE, 'SupportPage.js')),
      privacy: read(path.join(WEBSITE, 'PrivacyPolicy.js')),
      terms: read(path.join(WEBSITE, 'TermsOfService.js')),
    };
    for (const key of Object.keys(sources)) {
      const meta = api.PAGE_META[key];
      expect(sources[key]).toContain(meta.title);
      expect(sources[key]).toContain(meta.description);
    }
  });

  test('no block carries text from a mock or example element', () => {
    // Backstop for the exclusion list: these strings live in the landing
    // page's synthetic illustrations and must never reach a bot as data. If
    // one shows up here, a mock element changed class names and escaped the
    // EXCLUDE list — fix the list, not this test.
    const all = Object.values(api.PAGE_BLOCKS).flat().map(([, text]) => text).join('\n');
    expect(all).not.toMatch(/\$116\.82|\$23\.3[67]/);
    expect(all).not.toMatch(/needs help|View location on map|Accurate to about|Alert sent at/i);
    expect(all).not.toMatch(/Seen by 6/);
  });

  test('no em dash anywhere in the served copy (DESIGN-STANDARD rule 1)', () => {
    const all = Object.values(api.PAGE_BLOCKS).flat().map(([, text]) => text).join('\n')
      + Object.values(api.PAGE_META).map((m) => m.title + m.description).join('\n');
    expect(all).not.toMatch(/—/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('structured data', () => {
  test('the function serves the same @graph as public/index.html', () => {
    const html = read(path.join(FRONTEND, 'public', 'index.html'));
    const m = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html);
    expect(m).not.toBeNull();
    const graph = JSON.parse(m[1])['@graph'];
    expect(api.SITE_GRAPH).toEqual(graph);
  });

  test('with Flock Pro on sale the app offers Free and Pro, at the prices Pro is sold for', () => {
    // index.html's own rule: the price 0 Offer alone was true only while
    // PAYWALL_ENABLED was unset. It went on 2026-11-13 and the Offer stayed
    // 0 alone, so the one machine-readable price said Flock costs nothing.
    // The Pro amounts are held to the stated-price registry
    // (backend/services/statedPrices.js), not restated here.
    const html = read(path.join(FRONTEND, 'public', 'index.html'));
    const graph = JSON.parse(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)[1])['@graph'];
    const app = graph.find((e) => e['@type'] === 'WebApplication');
    const { STATED_PRICES } = require(path.join(FRONTEND, '..', 'backend', 'services', 'statedPrices.js'));
    const registry = (plan) => {
      const amounts = new Set(STATED_PRICES.filter((s) => s.product === 'pro' && s.plan === plan).map((s) => s.usd));
      expect(amounts.size).toBe(1);
      return [...amounts][0];
    };

    expect(Array.isArray(app.offers)).toBe(true);
    const [free, ...pro] = app.offers;
    expect(free).toMatchObject({ '@type': 'Offer', price: '0', priceCurrency: 'USD' });
    expect(pro).toHaveLength(2);
    const byUnit = Object.fromEntries(pro.map((o) => [o.priceSpecification.unitCode, o]));
    for (const [unit, plan] of [['MON', 'monthly'], ['ANN', 'yearly']]) {
      const o = byUnit[unit];
      expect(o).toMatchObject({ '@type': 'Offer', priceCurrency: 'USD', url: 'https://www.flockcorp.com/pro' });
      expect(Number(o.price)).toBe(registry(plan));
      expect(o.priceSpecification).toMatchObject({ '@type': 'UnitPriceSpecification', price: o.price, priceCurrency: 'USD' });
    }

    // The rule above the block moved with it.
    expect(html).not.toMatch(/price 0 Offer is true only while PAYWALL_ENABLED is unset/);
    expect(api.SITE_GRAPH).toEqual(graph);
  });

  test('the support FAQPage is derived from the visible Q&A, not stored twice', () => {
    const faq = api.supportFaq(api.PAGE_BLOCKS.support);
    expect(faq.length).toBeGreaterThanOrEqual(5);
    for (const { q, a } of faq) {
      expect(q.endsWith('?')).toBe(true);
      expect(a.length).toBeGreaterThan(20);
    }
    const ld = api.buildJsonLd('support');
    const faqPage = ld['@graph'].find((e) => e['@type'] === 'FAQPage');
    expect(faqPage).toBeDefined();
    expect(faqPage['@id']).toBe('https://www.flockcorp.com/support#faq');
    expect(faqPage.mainEntity.map((e) => e.name)).toEqual(faq.map((p) => p.q));
  });

  test('every page renders JSON-LD that parses and names the right canonical', () => {
    for (const key of Object.keys(api.PAGE_META)) {
      const html = api.renderPage(key);
      const m = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html);
      const ld = JSON.parse(m[1].replace(/\\u003c/g, '<'));
      const webPage = ld['@graph'].find((e) => e['@type'] === 'WebPage');
      expect(webPage.url).toBe('https://www.flockcorp.com' + api.PAGE_META[key].path);
      expect(html).toContain(
        `<link rel="canonical" href="https://www.flockcorp.com${api.PAGE_META[key].path}">`
      );
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('vercel.json wiring', () => {
  const config = JSON.parse(read(path.join(FRONTEND, 'vercel.json')));
  const rewrites = config.rewrites || [];
  const botRules = rewrites.filter((r) => String(r.destination).startsWith('/api/marketing-page'));

  test('two rewrite rules route AI crawlers to the function', () => {
    expect(botRules).toHaveLength(2);
    const sources = botRules.map((r) => r.source).sort();
    // /landing, not /: Vercel gives the filesystem precedence over rewrites,
    // so a rewrite on / lost to the built index.html and crawlers got the
    // empty shell (verified against production 2026-09-04). A bot-only
    // redirect below carries / to /landing first.
    expect(sources).toEqual(['/:page(about|support|privacy|terms)', '/landing']);
  });

  test('a bot-only redirect carries / to /landing, ahead of the filesystem', () => {
    const redirects = Array.isArray(config.redirects) ? config.redirects : [];
    const home = redirects.filter((r) => r.source === '/');
    expect(home).toHaveLength(1);
    expect(home[0].destination).toBe('/landing');
    expect(home[0].permanent).toBe(false);
    expect(home[0].has).toHaveLength(1);
    expect(home[0].has[0]).toMatchObject({ type: 'header', key: 'user-agent' });
    // The same crawler list as the rewrites, by hand, since JSON has no variables.
    expect(home[0].has[0].value).toBe(botRules[0].has[0].value);
  });

  test('the bot rules sit after the invite rules and before the SPA fallback', () => {
    const idxInvite = rewrites.findIndex((r) => String(r.destination).startsWith('/api/invite-preview'));
    const idxFallback = rewrites.findIndex((r) => r.destination === '/index.html' && r.source === '/(.*)');
    expect(idxInvite).toBeGreaterThan(-1);
    expect(idxFallback).toBe(rewrites.length - 1);
    for (const rule of botRules) {
      const i = rewrites.indexOf(rule);
      expect(i).toBeGreaterThan(idxInvite);
      expect(i).toBeLessThan(idxFallback);
    }
  });

  test('the user-agent condition matches AI crawlers and never a JS-rendering engine', () => {
    const patterns = botRules.map((r) => {
      expect(r.has).toHaveLength(1);
      expect(r.has[0]).toMatchObject({ type: 'header', key: 'user-agent' });
      return r.has[0].value;
    });
    // JSON has no variables; the two copies must stay identical by hand.
    expect(patterns[0]).toBe(patterns[1]);

    const re = new RegExp(patterns[0]);
    // Answer-time and training crawlers named in robots.txt, plus the ones
    // the 2026-08-14 audit measured hitting the site.
    for (const ua of [
      'GPTBot/1.2', 'OAI-SearchBot/1.0', 'ChatGPT-User/1.0', 'ClaudeBot/1.0',
      'Claude-User/1.0', 'Claude-SearchBot/1.0', 'PerplexityBot/1.0',
      'Perplexity-User/1.0', 'Amazonbot/0.1', 'Meta-ExternalAgent/1.1',
      // Meta documents the lowercase form; the exact-cased list carries both.
      'meta-externalagent/1.1', 'meta-externalfetcher/1.1',
      'Bytespider', 'CCBot/2.0', 'DuckAssistBot/1.0',
      'cohere-training-data-crawler/1.0',
    ]) {
      expect(re.test(`Mozilla/5.0 (compatible; ${ua}; +https://example.com/bot)`)).toBe(true);
    }
    // The engines that render JavaScript must keep seeing the human site.
    // Routing them here is where this pattern would turn into cloaking.
    for (const ua of [
      'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
      'Mozilla/5.0 AppleWebKit/537.36 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (compatible; Applebot/0.1)',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) Safari/604.1',
    ]) {
      expect(re.test(ua)).toBe(false);
    }
  });

  test('direct hits on /api/marketing-page are noindex; rewritten routes are not', () => {
    // Header source patterns match the ORIGINAL request path (that is how the
    // /i/(.*) rules already reach responses the invite rewrite hands to a
    // function), so this rule only touches someone fetching the function URL
    // itself: a duplicate-content address whose canonical points at the real
    // route. The five marketing routes must NOT carry an X-Robots-Tag, or the
    // bot surface would be asking answer engines to forget it.
    const headerRules = config.headers || [];
    const direct = headerRules.find((h) => h.source === '/api/marketing-page');
    expect(direct).toBeDefined();
    expect(direct.headers).toEqual([{ key: 'X-Robots-Tag', value: 'noindex' }]);
    for (const route of ['/', '/about', '/support', '/privacy', '/terms']) {
      for (const rule of headerRules.filter((h) => h.source === route)) {
        expect(rule.headers.map((h) => h.key)).not.toContain('X-Robots-Tag');
      }
    }
  });

  test('every route the rewrite can name exists in the function, and vice versa', () => {
    const keys = Object.keys(api.PAGE_META).sort();
    expect(keys).toEqual(['about', 'home', 'privacy', 'support', 'terms']);
    const grouped = /\(([^)]+)\)/.exec(botRules.find((r) => r.source !== '/landing').source)[1].split('|').sort();
    expect(grouped).toEqual(['about', 'privacy', 'support', 'terms']);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('the handler', () => {
  function fakeRes() {
    const headers = {};
    return {
      statusCode: 0,
      headers,
      body: '',
      setHeader(k, v) { headers[k.toLowerCase()] = v; },
      end(html) { this.body = html || ''; },
    };
  }

  test('serves the requested page with Vary: User-Agent and a canonical Link', async () => {
    const res = fakeRes();
    await api({ query: { page: 'about' }, url: '/api/marketing-page?page=about' }, res);
    expect(res.statusCode).toBe(200);
    expect(res.headers.vary).toBe('User-Agent');
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.headers.link).toBe('<https://www.flockcorp.com/about>; rel="canonical"');
    expect(res.body).toContain('<h1>About Flock</h1>');
  });

  test('an ambiguous or unknown page key falls back to the home document', async () => {
    for (const query of [
      { page: ['about', 'privacy'] },
      { page: 'admin' },
      {},
    ]) {
      const res = fakeRes();
      await api({ query, url: '/api/marketing-page' }, res);
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('Nurturing friendship, one flock at a time.');
    }
  });

  test('never throws, even on a hostile request object', async () => {
    const res = fakeRes();
    await api(null, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Flock');
  });

  test('esc neutralises markup in any interpolated value', () => {
    expect(api.esc('<script>"x"&\'</script>'))
      .toBe('&lt;script&gt;&quot;x&quot;&amp;&#39;&lt;/script&gt;');
    expect(api.renderBlocks([['p', '<img src=x onerror=alert(1)>']]))
      .not.toMatch(/<img/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('llms.txt stays true to the shipped model', () => {
  const llms = read(path.join(FRONTEND, 'public', 'llms.txt'));
  const meta = JSON.parse(read(path.join(
    FRONTEND, '..', 'backend', 'scripts', 'ml', 'models', 'model_metadata.json'
  )));

  test('the five crowd-model figures match model_metadata.json', () => {
    // Same pinning AboutPage and the landing proof line get. A retrain that
    // changes the corpus must change llms.txt in the same commit.
    // Re-recorded 2026-11-26 from 2.8.0-starling's metadata (v2.6.0's were
    // 1,934,988 rows, 395,464 held out, 30 cities and 106 signals; llms.txt
    // now gives those as the previous version's).
    expect(meta.training_rows).toBe(3533480);
    expect(llms).toContain('3,533,480');
    expect(meta.holdout_rows).toBe(367007);
    expect(llms).toContain('367,007');
    expect(meta.training_cities).toHaveLength(31);
    expect(llms).toContain('across 31 cities');
    expect(meta.feature_names).toHaveLength(104);
    expect(llms).toContain('104 input signals');
  });

  // llms.txt also states the serving model's size, how the corpus splits and
  // which rows the point gate scores, so those are held to the same file.
  //
  // Which of the corpus's provider readings are real is not in the metadata:
  // it is the count of the investigation of 2026-11-27 (research paper 7.2),
  // made on the registered training frame. Of the 1,481,472 provider readings
  // 2.8.0 trained on, 158,262 are real live readings of 1 September to 12
  // October (Philadelphia and the Lehigh Valley), 6 trickled in on 14 and 15
  // October, and 1,323,204, from 23 October on, were generated by the
  // provider from its own weekly forecast. Its point gate's 39,752 Miami rows
  // are 9,912 real readings and 29,840 generated ones. The sums are held to
  // the metadata, so a retrain that changes the corpus fails here until the
  // split is counted again.
  const REAL_TRAINING_READINGS = 158262;
  const TRICKLE_READINGS = 6;
  const GENERATED_TRAINING_READINGS = 1323204;
  const MIAMI_REAL = 9912;
  const MIAMI_GENERATED = 29840;
  test("the model's size, the corpus split and the point gate's rows match model_metadata.json", () => {
    const flat = llms.replace(/\s+/g, ' ');
    const by = meta.training_metrics_by_population;
    expect(meta.best_params.n_estimators).toBe(2000);
    expect(meta.best_params.max_depth).toBe(10);
    expect(flat).toContain('It is 2,000 trees, each up to 10 splits deep');
    expect(by.weekly_anchor.rows).toBe(2052008);
    expect(by.realtime_served.rows).toBe(1481472);
    expect(by.weekly_anchor.rows + by.realtime_served.rows).toBe(meta.training_rows);
    expect(flat).toContain("2,052,008 of them are venues' typical-week values, and the other 1,481,472 are readings from Flock's data provider taken from September 1 to November 11, 2026.");
    expect(meta.time_holdout.training_live_through).toBe('2026-11-11');
    // The real and generated parts, rounded as the text rounds them.
    expect(REAL_TRAINING_READINGS + TRICKLE_READINGS + GENERATED_TRAINING_READINGS).toBe(by.realtime_served.rows);
    expect(flat).toContain(`About ${Math.round(REAL_TRAINING_READINGS / 1000)},000 of those are real live readings in Philadelphia and the Lehigh Valley, taken from September 1 to October 12, 2026.`);
    expect(flat).toContain(`Almost all the rest, about ${(GENERATED_TRAINING_READINGS / 1e6).toFixed(2)} million taken in 30 cities from October 23, 2026 on, were generated by the provider from its own weekly forecast and are not measurements.`);
    expect(flat).not.toMatch(/verified live readings/);
    expect(meta.ship_gate.realtime_rows).toBe(39752);
    expect(MIAMI_REAL + MIAMI_GENERATED).toBe(meta.ship_gate.realtime_rows);
    expect(Object.keys(meta.ship_gate.per_city)).toEqual(['miami']);
    expect(flat).toContain(`the 39,752 realtime rows among them that have a usable curve, all of them in Miami: ${MIAMI_REAL.toLocaleString('en-US')} real live readings from September 5 to October 12, 2026, and ${MIAMI_GENERATED.toLocaleString('en-US')} readings the provider generated after October 23, 2026.`);
  });

  // The November gate (ship_gate.band_gate) was scored on readings the
  // provider generated from its own weekly forecast, so llms.txt gives it only
  // as the result Flock withdrew, with the reason in the same sentence. The
  // figures it names are still the artifact's own record, so they are held to
  // it: what was withdrawn is described exactly. The other November figures
  // (the 31-city 94.3%, the replays) are named in the sentence that withdraws
  // them, and the passage that presented them as accuracy may not come back.
  test('the November gate is stated only as withdrawn, with its reason, and today has no live readings', () => {
    const flat = llms.replace(/\s+/g, ' ');
    const gate = meta.ship_gate.band_gate;
    expect(meta.ship_gate.overall_pass).toBe(true);
    expect(gate.pass).toBe(true);
    expect(Object.keys(gate.criteria)).toHaveLength(8);
    expect(gate.window_from).toBe('2026-11-12');
    expect(Object.keys(gate.criteria.no_city_regression.per_city)).toHaveLength(6);
    expect(flat).toContain(`On November 27, 2026, Flock withdrew the November test of version 2.8.0 that it had published the day before (a pass of all eight tests of a gate fixed in advance, and ${gate.candidate.within_10}% within 10 points on ${gate.candidate.n.toLocaleString('en-US')} readings from November 12 to 25, 2026 in six cities), because a peer review of Flock's own paper found that those readings were not measurements.`);
    expect(flat).toContain('The other November figures Flock published from the same readings (94.3% within 10 points across 31 cities, and 88.2%, 87.1% and 84.5% in replays without a fresh reading) are withdrawn for the same reason.');
    // The reason, and what is and is not known about it.
    expect(flat).toContain('every reading the provider sent as live was generated from its own weekly forecast');
    expect(flat).toContain("A venue's reading was the same number as seven days earlier in 89% to 99% of pairs, against 13% to 18% for the real readings of September and early October.");
    expect(flat).toContain('so none of those figures is quoted as accuracy.');
    expect(flat).toContain('Why the provider did this is not known.');
    // The passages that presented the gate as accuracy stay out.
    expect(flat).not.toMatch(/On those readings Starling's number was within 10 points/);
    expect(flat).not.toMatch(/Those readings were scored with the live feed on/);
    expect(flat).not.toMatch(/It then replaced version 2\.6\.0\. The gate was decided/);
    expect(flat).not.toMatch(/six cities Flock read every hour/);
    // Today: no live readings, and the model that serves.
    expect(flat).toContain('Flock has had no live readings since November 25, 2026, when its subscription to the data provider ended, and no real ones since October 12, 2026.');
    expect(flat).toContain('Version 2.8.0 serves today.');
    expect(flat).toContain('They are not head counts.');
    // The version it replaced is named as the previous one, never as serving.
    expect(flat).toContain('Version 2.6.0, the previous version,');
    expect(flat).not.toMatch(/next version of Starling|is not trained|not trained yet/);
  });

  // The served-number figures have their own section, after Starling's, and
  // they are pinned to the file that records what the serving configuration
  // measured, the same way the corpus figures are pinned to the model's
  // metadata.
  test('the served-number figures match servedAccuracy.json', () => {
    const served = JSON.parse(read(path.join(
      FRONTEND, '..', 'backend', 'services', 'servedAccuracy.json'
    )));
    const flat = llms.replace(/\s+/g, ' ');
    // The public copy quotes the month's out-of-sample test, which measured the
    // nowcast weights served until 2026-10-14 (previous_weights). The weights
    // served since were chosen on that same window, so their figures on it are
    // not quoted as a test result; the October holdout scores them first.
    const tested = served.previous_weights;
    expect(served.rows).toBe(119939);
    expect(tested.rows).toBe(119939);
    expect(flat).toContain('119,939 real live readings');
    // Exact level beside within-one, for the reason given on the /about pin.
    expect(flat).toContain(`${tested.band_exact.toFixed(1)}% of Flock's crowd numbers named the exact crowd level of the live reading, ${tested.within_one_band}% landed within one level`);
    expect(flat).toContain(`${tested.within_10}% within 10 points`);
    expect(flat).toContain(`scored ${served.before.band_exact.toFixed(1)}%, ${served.before.within_one_band}% and ${served.before.within_10}%`);
    expect(flat).toContain(`average miss was ${tested.mae.toFixed(1)} points, down from ${served.before.mae.toFixed(1)}`);
    expect(Math.abs(tested.bias)).toBeLessThan(2);
    expect(flat).toContain(`${served.reading_one_hour_earlier.band_exact.toFixed(1)}% of numbers named the exact crowd level and ${served.reading_one_hour_earlier.within_one_band}% landed within one, and ${served.reading_one_hour_earlier.within_10}% were within 10 points of the reading`);
    // The hour-before figures are on a subset, and say how big it is; the
    // pre-upgrade figures are on the whole set, as /about now says too.
    expect(flat).toContain(`which ${served.reading_one_hour_earlier.rows.toLocaleString('en-US')} of those 119,939 readings did`);
    expect(flat).toContain('119,939 real live readings at venues in Philadelphia, the Lehigh Valley and Miami');
    // The horizon and the target are stated with the figures, and so is WHICH
    // forecast they measure and over what. They are previous_weights: the
    // forecast served from 2026-09-26, when the two serving switches went
    // live, until its nowcast weights changed on 2026-10-14. The readings run
    // from 09-09, so the first 39,000 of them were replayed, not served: the
    // app showed v2.6.0's numbers then, the `before` figures below
    // (backend/scripts/ml/MODEL-METRICS.md, the month section). "How the crowd
    // numbers in the app performed ... from September 9" said the app showed
    // these numbers over the whole window, and it did not.
    expect(flat).toContain('How the crowd forecast Flock served from September 26 to mid-October 2026 scored one hour ahead, replayed on 119,939 real live readings at venues in Philadelphia, the Lehigh Valley and Miami from September 9 to October 8, 2026, none of which was used to set it');
    expect(flat).toContain("relative 0 to 100 scores, not headcounts");
    expect(flat).not.toMatch(/crowd numbers in the app perform/);
    // Both ends of the served period are the records' own: the end is the
    // one servedAccuracy.json gives previous_weights, and the start is the
    // date RETRAIN.md gives the switches the incumbent is scored with.
    expect(tested.what).toMatch(/served until 2026-10-14/);
    expect(served.before.configuration).toMatch(/as served before the two switches/);
    const retrain = read(path.join(FRONTEND, '..', 'backend', 'scripts', 'ml', 'RETRAIN.md')).replace(/\s+/g, ' ');
    expect(retrain).toMatch(/Production served curve_offset \+ #? ?nowcast from 2026-09-26/);
    // Not held out of the forecast served now: the nowcast weights served
    // since 2026-10-14 were chosen on these same readings, so the sentence
    // names the forecast it is true of.
    expect(flat).not.toMatch(/held out from September/);
  });

  // A venue with no pattern is answered by its kind's pattern or the rule
  // engine, so no sentence that describes every venue's number may credit it
  // to Starling or to the provider's readings. Production has served the
  // model since the evening of 2026-11-01 (CROWD_SERVE_MODE=model). Under
  // v2.6.0 model mode added half the venue's trailing offset, the median gap
  // of its readings in the 28 days before the hour
  // (backend/services/mlPredictor.js DEVIATION_WEIGHT, trailingOffsetBefore),
  // to Starling's forecast. 2.8.0-starling lists that offset among its inputs
  // (recent_offset), so nothing is added after the model
  // (artifactLearnsOffset). No reading has arrived since 2026-11-25 15:59 UTC
  // (the provider's subscription was cancelled at 11:08 EST, 16:08 UTC, that
  // day), so the offset empties by about 2026-12-23. Every reading in that
  // window came after 23 October, when the provider's readings stopped being
  // measurements, so the sentence calls them the provider's readings, never
  // live ones. The pattern-plus-live-readings sentence is the forecast the
  // September to October figures measured, in the past tense, and it ends the
  // real live readings on 12 October.
  test('the crowd sentences limit live readings to the venues and the weeks Flock had them', () => {
    const flat = llms.replace(/\s+/g, ' ');
    expect(flat).not.toMatch(/Each venue's number/);
    // The sentence is true of an artifact that reads the offset as an input.
    expect(meta.feature_names).toContain('recent_offset');
    expect(flat).toContain("Where Flock knows a venue's usual pattern, the number starts from Starling's forecast: that pattern plus Starling's prediction of how far each hour will move from it. For a venue Flock has readings for, one of Starling's inputs is how far its readings from Flock's data provider over the last four weeks ran above or below that pattern. The last of those readings came in on November 25, 2026, so that input runs out by late December 2026. A place Flock has no pattern for yet gets an estimate from what is typical for its kind.");
    expect(flat).not.toMatch(/live readings from the last four weeks|For a venue Flock read live/);
    expect(flat).toContain("Flock's live readings ran from September 1 to October 12, 2026, hourly from September 3 in Philadelphia and the Lehigh Valley and at 11:00 and 19:00 in Miami. They are the last real live readings Flock has.");
    expect(flat).not.toMatch(/collection of those readings ran from September 3 to November 25/);
    // v2.6.0's step, which 2.8.0 does not take.
    expect(flat).not.toMatch(/also moves by half/);
    expect(flat).not.toMatch(/the number is Starling's forecast/);
    expect(flat).not.toMatch(/has come from Starling/);
    expect(flat).not.toMatch(/moved by the venue's latest live reading/);
    expect(flat).toContain("In that period a venue's number was its own usual pattern for that hour, moved by its newest live readings where Flock had them.");
    expect(flat).not.toMatch(/A venue's number is its own usual pattern/);
    expect(flat).not.toMatch(/Flock collects live busyness readings/);
  });

  // AUDIT 2026-08-26. The five figures above were pinned; the sentence that
  // ATTRIBUTES them was not, and it drifted. llms.txt read "as of the August
  // 12, 2026 training run (version 2.5.0 \"Starling\")" over numbers that had
  // all been updated to the 2.6.0 corpus. 2.5.0 is named inside this same
  // metadata as ship_gate.incumbent_version, i.e. the model the shipping one
  // beat, so the file was crediting the losing model with the winner's
  // numbers. A version string is a claim like any other.
  test('llms.txt credits the model version and training date that actually shipped', () => {
    const version = meta.model_version.replace(/-starling$/i, '');
    expect(llms).toContain(`version ${version} "Starling"`);

    const trained = new Date(meta.trained_at);
    const stamp = trained.toLocaleDateString('en-US', {
      month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC',
    });
    expect(llms).toContain(`as of the ${stamp} training run`);
  });

  test('the holdout cities named are the ones in the metadata, disjoint from training', () => {
    expect(meta.evaluation.holdout_cities.sort()).toEqual(['barcelona', 'miami', 'tokyo']);
    expect(llms).toContain('Barcelona, Miami, and Tokyo');
    for (const c of meta.evaluation.holdout_cities) {
      expect(meta.training_cities).not.toContain(c);
    }
  });

  test('no em dash, and no fabricated popularity signals', () => {
    expect(llms).not.toMatch(/—/);
    expect(llms).not.toMatch(/\b(rating|review|downloads|users)\b.*\d/i);
  });
});
