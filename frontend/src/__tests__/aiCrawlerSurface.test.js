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
    '.lp-sos-mail', '.lp-appstore', 'form.lp-form', '.lp-form-status',
    'figure', 'footer.lp-footer',
  ],
  pp: ['.pp-skip', '.pp-back', 'nav', 'footer'],
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
  about: extractBlocks(renderToStaticMarkup(React.createElement(AboutPage)), EXCLUDE.pp),
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
    expect(all).not.toMatch(/needs help|View location on map/);
    expect(all).not.toMatch(/Seen by 6/);
  });

  test('no em dash anywhere in the served copy (SLOP-AUDIT rule 1)', () => {
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
    expect(sources).toEqual(['/', '/:page(about|support|privacy|terms)']);
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
    const grouped = /\(([^)]+)\)/.exec(botRules.find((r) => r.source !== '/').source)[1].split('|').sort();
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
    expect(res.body).toContain('<h1>What Flock is</h1>');
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
      expect(res.body).toContain('Plans die in the group chat.');
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
    expect(meta.training_rows).toBe(2070239);
    expect(llms).toContain('2,070,239');
    expect(meta.holdout_rows).toBe(419320);
    expect(llms).toContain('419,320');
    expect(meta.training_cities).toHaveLength(31);
    expect(llms).toContain('across 31 cities');
    expect(meta.feature_names).toHaveLength(106);
    expect(llms).toContain('106 input signals');
    expect(meta.ship_gate.realtime_mae_improvement).toBeCloseTo(2.29, 2);
    expect(llms).toContain('2.29 points');
    expect(meta.ship_gate.realtime_rows).toBe(68459);
    expect(llms).toContain('68,459');
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
