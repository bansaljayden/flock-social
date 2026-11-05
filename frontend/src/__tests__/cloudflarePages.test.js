/**
 * @jest-environment node
 */
/*
 * The Cloudflare Pages configuration (cloudflare/ and
 * scripts/build-cloudflare.js), held against vercel.json for as long as both
 * hosts exist, plus the rules the move depends on:
 * - the security headers and user-agent lists are vercel.json's, value for value;
 * - every vercel.json header rule has the same headers in cloudflare/_headers;
 * - the _headers file the build writes stays inside Pages' limits and carries
 *   vercel.json's Content-Security-Policy byte for byte;
 * - _routes.json sends Functions exactly the paths the middleware handles;
 * - the build writes the 404 page and a file at every exact app route, all
 *   the app shell byte for byte, and nothing in public/ claims those names or
 *   leaks the Pages files;
 * - the app-site-association file in the build is the handler's own body;
 * - the build refuses an output Pages would serve wrong, a rewrite over a
 *   file included;
 * - the model of Pages the route tests stand on (build.pagesAnswer) does
 *   what Pages' asset server does.
 * The Functions themselves, and the status of every route, are pinned in
 * cloudflarePagesFunctions.test.js.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const build = require('../../scripts/build-cloudflare.js');

const ROOT = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const vercel = JSON.parse(read('vercel.json'));
const security = JSON.parse(read('cloudflare/security-headers.json')).headers;
const agents = JSON.parse(read('cloudflare/user-agents.json'));
const routes = JSON.parse(read('cloudflare/_routes.json'));
const vercelCsp = vercel.headers.find((r) => r.source === '/(.*)').headers
  .find((h) => h.key === 'Content-Security-Policy').value;

// _headers text as [{ path, headers: { name: value } }].
function headerBlocks(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (/^\S/.test(line)) out.push({ path: line.trim(), headers: {} });
    else {
      const i = line.indexOf(':');
      out[out.length - 1].headers[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
  }
  return out;
}

// vercel.json sources -> _headers paths: "/x/(.*)" is "/x/*", and the one
// "(a|b|c)" alternation is one rule per file.
function pagesPaths(source) {
  const alternation = /^\/\(([^()]+)\)$/.exec(source);
  if (alternation) return alternation[1].split('|').map((f) => '/' + f);
  return [source.replace(/\/\(\.\*\)$/, '/*')];
}

// A made-up Team ID in Apple's shape, ten of A-Z0-9. The real one is public,
// but nothing here should depend on it.
function fakeTeamId() {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let id = '';
  for (let i = 0; i < 10; i++) id += alphabet[crypto.randomInt(alphabet.length)];
  return id;
}

function withEnv(values, fn) {
  const saved = {};
  for (const key of Object.keys(values)) saved[key] = process.env[key];
  const apply = (from) => {
    for (const [key, value] of Object.entries(from)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  try {
    apply(values);
    return fn();
  } finally {
    apply(saved);
  }
}

describe('cloudflare/ is vercel.json, value for value', () => {
  test('security headers are vercel.json /(.*) plus the HSTS Vercel sends by default', () => {
    const global = vercel.headers.find((r) => r.source === '/(.*)').headers.map((h) => [h.key, h.value]);
    expect(security).toEqual([...global, ['Strict-Transport-Security', 'max-age=63072000']]);
  });

  test('user-agent lists equal every copy in vercel.json', () => {
    const values = [];
    for (const rule of [...vercel.headers, ...vercel.redirects, ...vercel.rewrites]) {
      for (const c of [...(rule.has || []), ...(rule.missing || [])]) {
        if (c.type === 'header' && c.key === 'user-agent') values.push(c.value.replace(/^\.\*\(/, '').replace(/\)\.\*$/, ''));
      }
    }
    expect(values).toHaveLength(5);
    expect(new Set(values)).toEqual(new Set([agents.previewBots, agents.aiCrawlers]));
  });

  test('every vercel.json header rule has the same headers in cloudflare/_headers, once', () => {
    const blocks = headerBlocks(read('cloudflare/_headers'));
    const byPath = new Map(blocks.map((b) => [b.path, b.headers]));
    // A repeated path silently replaces the earlier block on Pages.
    expect(blocks.length).toBe(byPath.size);
    // "/*" is generated from security-headers.json by build-cloudflare.js.
    expect(byPath.has('/*')).toBe(false);
    for (const rule of vercel.headers) {
      if (rule.source === '/(.*)' || rule.missing) continue;
      for (const p of pagesPaths(rule.source)) {
        for (const h of rule.headers) expect([p, h.key, (byPath.get(p) || {})[h.key]]).toEqual([p, h.key, h.value]);
      }
    }
    // The user-agent-conditional /i/(.*) no-store (vercel.json:168-178) is
    // merged into /i/*: a preview bot's answer there is a Function's, which
    // _headers never touches.
    expect(byPath.get('/i/*')['Cache-Control']).toBe('private, no-store');
    // Additions with no vercel.json rule: the pages.dev copies are noindex,
    // the project host and every deployment's <hash>.<project> host alike,
    // and the app-site-association file, which has no extension, is typed.
    expect(byPath.get('https://:project.pages.dev/*')).toEqual({ 'X-Robots-Tag': 'noindex' });
    expect(byPath.get('https://:version.:project.pages.dev/*')).toEqual({ 'X-Robots-Tag': 'noindex' });
    expect(blocks.filter((b) => /^https?:\/\//.test(b.path)).map((b) => b.path)).toEqual([
      'https://:project.pages.dev/*',
      'https://:version.:project.pages.dev/*',
    ]);
    expect(byPath.has('/.well-known/apple-app-site-association')).toBe(true);
  });

  test('_redirects holds the unconditional vercel.json redirects as 308s, then the app\'s id routes as rewrites, and no catch-all', () => {
    const text = read('cloudflare/_redirects');
    const lines = text.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#'));
    const unconditional = vercel.redirects.filter((r) => !r.has && !r.missing);
    const moves = lines.filter((l) => !l.endsWith(' 200'));
    expect(moves).toEqual(unconditional.map((r) => [r.source, r.destination, r.permanent ? '308' : '307'].join(' ')));
    expect(moves).toEqual([
      '/research/flock-research-paper.pdf /papers/flock-research-paper.pdf 308',
      '/papers/flock-research-paper-full.pdf /papers/flock-research-paper.pdf 308',
    ]);
    // The rewrites come last, so the two redirects stay exact rules (matched
    // by path before any splat), and each answers the shell: "/" is
    // index.html. Which paths they cover is held to src/index.js in
    // cloudflarePagesFunctions.test.js.
    expect(lines.slice(moves.length)).toEqual([
      '/app/* / 200', '/checkin/* / 200', '/f/* / 200', '/flock/* / 200', '/dm/* / 200',
    ]);
    expect([...build.parseRedirects(text).staticRules.keys()]).toEqual([
      '/research/flock-research-paper.pdf', '/papers/flock-research-paper-full.pdf',
    ]);
    expect(lines.filter((l) => /^\/\*\s/.test(l))).toEqual([]);
  });

  test('_routes.json sends Functions exactly the paths the middleware and functions/api handle', () => {
    expect(routes.version).toBe(1);
    expect(routes.exclude).toEqual([]);
    expect(new Set(routes.include)).toEqual(new Set([
      '/', '/landing', '/about', '/support', '/privacy', '/terms',
      '/i/*', '/relay/public/*', '/api/*', '/bg-city.mp4', '/404', '/404.html',
    ]));
    // Every function file is under a routed path, and every api/ handler a
    // function wraps has one at its own /api/<name> URL, as on Vercel.
    const functions = fs.readdirSync(path.join(ROOT, 'functions', 'api')).sort();
    expect(functions).toEqual(['apple-app-site-association.js', 'demo-relay.js', 'invite-og.js', 'invite-preview.js', 'marketing-page.js']);
    const handlers = fs.readdirSync(path.join(ROOT, 'api')).filter((f) => !f.startsWith('_')).sort();
    expect(functions).toEqual(handlers);
  });

  test('public/ holds none of the pages the build writes, and none of the Pages files', () => {
    // The build writes these as the shell (or a snapshot); one in public/
    // would be overwritten on every build without a word.
    const written = ['404.html', ...build.PRERENDER.map((p) => p.file), ...build.APP_ROUTES.map((r) => r.slice(1) + '.html')];
    for (const name of [...written, '_headers', '_redirects', '_routes.json', '_worker.js']) {
      expect([name, fs.existsSync(path.join(ROOT, 'public', name))]).toEqual([name, false]);
    }
  });

  test('/i and /i/* carry the same headers, since /i/<token> is answered with the /i file', () => {
    // functions/_middleware.js inviteShell: a token has no file of its own.
    const byPath = new Map(headerBlocks(read('cloudflare/_headers')).map((b) => [b.path, b.headers]));
    expect(byPath.get('/i')).toEqual(byPath.get('/i/*'));
    expect(byPath.get('/i')['Cache-Control']).toBe('private, no-store');
    expect(build.APP_ROUTES).toContain('/i');
  });

  test('package.json runs the build as build:cloudflare and leaves build as it was', () => {
    const pkg = JSON.parse(read('package.json'));
    expect(pkg.scripts['build:cloudflare']).toBe('node scripts/build-cloudflare.js');
    expect(pkg.scripts.build).toBe('node scripts/build.js');
  });

  test('a local wrangler run from frontend/ leaves nothing to commit', () => {
    // `wrangler pages dev` writes its state to .wrangler/ and reads the
    // Functions' secrets from .dev.vars, both inside frontend/ of a repo
    // whose contents are published.
    const ignored = read('.gitignore').split(/\r?\n/).map((line) => line.trim());
    expect(ignored).toEqual(expect.arrayContaining(['.wrangler/', '.dev.vars*']));
  });
});

describe('the _headers file the build writes', () => {
  const text = build.headersFile();

  test('stays inside Pages limits: 100 rules and 2,000 characters a line', () => {
    const rules = build.checkHeaders(text);
    expect(rules).toBe(headerBlocks(read('cloudflare/_headers')).length + 1);
    expect(rules).toBeLessThanOrEqual(build.MAX_HEADER_RULES);
    for (const line of text.split('\n')) expect(line.trim().length).toBeLessThanOrEqual(build.MAX_HEADER_LINE);
  });

  test('opens with a /* block carrying vercel.json\'s CSP byte for byte, then cloudflare/_headers unchanged', () => {
    const blocks = headerBlocks(text);
    expect(blocks[0].path).toBe('/*');
    expect(blocks[0].headers['Content-Security-Policy']).toBe(vercelCsp);
    // Referrer-Policy is Pages' own default with the same value; naming it
    // here would join it onto the no-referrer rules.
    expect(blocks[0].headers).toEqual(Object.fromEntries(security.filter(([name]) => name !== 'Referrer-Policy')));
    expect(blocks.slice(1).every((b) => b.path !== '/*')).toBe(true);
    expect(text.endsWith('\n\n' + read('cloudflare/_headers'))).toBe(true);
  });

  test('a file Pages would cut short fails the build', () => {
    const rule = (i) => '/r' + i + '\n  X-A: b\n';
    const hundred = Array.from({ length: 100 }, (_, i) => rule(i)).join('\n');
    expect(build.checkHeaders(hundred)).toBe(100);
    expect(() => build.checkHeaders(hundred + '\n' + rule(100))).toThrow(/101 rules/);
    expect(() => build.checkHeaders('https://:project.pages.dev/*\n  X-A: b\n\n' + hundred)).toThrow(/101 rules/);
    // Pages measures the trimmed line: "X-Long: " is 8 characters.
    expect(build.checkHeaders('/x\n  X-Long: ' + 'a'.repeat(1992) + '\n')).toBe(1);
    expect(() => build.checkHeaders('/x\n  X-Long: ' + 'a'.repeat(1993) + '\n')).toThrow(/over 2000 characters/);
    // Comments are skipped before either limit is applied.
    expect(build.checkHeaders('# ' + 'c'.repeat(3000) + '\n# /not-a-rule\n/x\n  X-A: b\n')).toBe(1);
  });
});

describe('_routes.json limits', () => {
  test('the file is inside them, and the build refuses one that is not', () => {
    expect(() => build.checkRoutes(routes)).not.toThrow();
    expect(() => build.checkRoutes({ version: 1, include: [], exclude: [] })).toThrow(/outside Pages limits/);
    expect(() => build.checkRoutes({ version: 2, include: ['/'], exclude: [] })).toThrow(/outside Pages limits/);
    expect(() => build.checkRoutes({ version: 1, include: Array.from({ length: 101 }, (_, i) => '/r' + i), exclude: [] }))
      .toThrow(/outside Pages limits/);
    expect(() => build.checkRoutes({ version: 1, include: ['/' + 'a'.repeat(100)], exclude: [] })).toThrow(/over 100 characters/);
  });
});

describe('the app-site-association file is the handler\'s own answer', () => {
  const handler = require('../../api/apple-app-site-association.js');

  function handlerAnswer() {
    const out = { status: 200, headers: {}, body: undefined };
    handler({ method: 'GET', headers: {} }, {
      setHeader(name, value) { out.headers[name.toLowerCase()] = value; },
      status(code) { out.status = code; return this; },
      json(value) { out.body = JSON.stringify(value); return this; },
    });
    return out;
  }

  test('byte for byte, typed and cached in _headers the way the handler types and caches it', () => {
    const team = fakeTeamId();
    withEnv({ APPLE_TEAM_ID: team }, () => {
      const body = build.appSiteAssociation();
      const answer = handlerAnswer();
      expect(answer.status).toBe(200);
      expect(body).toBe(answer.body);
      const parsed = JSON.parse(body);
      expect(parsed.applinks.details[0].appIDs).toEqual([team + '.com.flockcorp.flock']);
      expect(parsed.webcredentials.apps).toEqual([team + '.com.flockcorp.flock']);
      const rule = headerBlocks(read('cloudflare/_headers')).find((b) => b.path === '/.well-known/apple-app-site-association');
      expect(rule.headers).toEqual({
        'Content-Type': answer.headers['content-type'],
        'Cache-Control': answer.headers['cache-control'],
      });
      expect(rule.headers['Content-Type']).toBe('application/json; charset=utf-8');
    });
  });

  test('a missing or malformed Team ID fails the build instead of shipping a file iOS refuses', () => {
    for (const value of [undefined, '', '   ', 'abcde12345', 'ABCDE1234', 'ABCDE123456', '"ABCDE12345"']) {
      const refusal = withEnv({ APPLE_TEAM_ID: value }, () => {
        try {
          build.appSiteAssociation();
          return 'built';
        } catch (err) {
          return /APPLE_TEAM_ID/.test(err.message) ? 'refused' : err.message;
        }
      });
      expect([value, refusal]).toEqual([value, 'refused']);
    }
  });
});

describe('finishing an output directory', () => {
  let out;

  beforeEach(() => {
    out = fs.mkdtempSync(path.join(os.tmpdir(), 'flock-cf-build-'));
    fs.writeFileSync(path.join(out, 'index.html'), '<!doctype html><div id="root"></div>');
  });

  afterEach(() => {
    fs.rmSync(out, { recursive: true, force: true });
  });

  test('puts the four Pages files next to the build', () => {
    const team = fakeTeamId();
    withEnv({ APPLE_TEAM_ID: team, CF_PAGES: '1' }, () => build.finishOutput(out));
    expect(fs.readFileSync(path.join(out, '_headers'), 'utf8')).toBe(build.headersFile());
    expect(fs.readFileSync(path.join(out, '_redirects'), 'utf8')).toBe(read('cloudflare/_redirects'));
    expect(fs.readFileSync(path.join(out, '_routes.json'), 'utf8')).toBe(read('cloudflare/_routes.json'));
    const aasa = fs.readFileSync(path.join(out, '.well-known', 'apple-app-site-association'), 'utf8');
    expect(aasa).toBe(withEnv({ APPLE_TEAM_ID: team }, () => build.appSiteAssociation()));
  });

  test('sends the landing and How it works chunks, and the display face, as preloads on their routes', () => {
    // routePreloads reads the hashed names out of asset-manifest.json, the
    // only place they are known after a build. With no manifest there is
    // nothing to add, which is the case above: _headers is exactly the source.
    const files = {
      'main.js': '/static/js/main.1a2b3c4d.js',
      'landing.css': '/static/css/landing.0f0f0f0f.chunk.css',
      'landing.js': '/static/js/landing.12ab34cd.chunk.js',
      'howitworks.js': '/static/js/howitworks.9e8d7c6b.chunk.js',
      'static/media/Literata-Display-600.woff2': '/static/media/Literata-Display-600.5a5a5a5a.woff2',
    };
    fs.writeFileSync(path.join(out, 'asset-manifest.json'), JSON.stringify({ files }));
    withEnv({ APPLE_TEAM_ID: fakeTeamId(), CF_PAGES: '1' }, () => build.finishOutput(out));
    const text = fs.readFileSync(path.join(out, '_headers'), 'utf8');
    const source = build.headersFile();
    const font = '</static/media/Literata-Display-600.5a5a5a5a.woff2>; rel=preload; as=font; type="font/woff2"; crossorigin';
    // A second block for the same path replaces the first on Pages (seen on
    // the website-flux preview: /how-it-works lost its canonical), so the
    // hints join each route's own Link and every path stays one block.
    const blocks = headerBlocks(text);
    expect(blocks.length).toBe(new Set(blocks.map((b) => b.path)).size);
    const own = (p) => headerBlocks(source).find((b) => b.path === p).headers.Link;
    expect(own('/')).toContain('rel="canonical"');
    expect(own('/how-it-works')).toContain('rel="canonical"');
    expect(text).toBe(source
      .replace(`\n/\n  Link: ${own('/')}\n`, `\n/\n  Link: ${own('/')}, </static/css/landing.0f0f0f0f.chunk.css>; rel=preload; as=style, </static/js/landing.12ab34cd.chunk.js>; rel=preload; as=script, ${font}\n`)
      .replace(`\n/how-it-works\n  Link: ${own('/how-it-works')}\n`, `\n/how-it-works\n  Link: ${own('/how-it-works')}, </static/js/howitworks.9e8d7c6b.chunk.js>; rel=preload; as=script, ${font}\n`));
  });

  test('a hint for a path the source file does not name is added as a block of its own', () => {
    expect(build.joinHeaderBlocks('/a\n  Link: <x>\n', '\n/b\n  Link: <y>\n')).toBe('/a\n  Link: <x>\n\n/b\n  Link: <y>\n');
    expect(build.joinHeaderBlocks('/a\n  Cache-Control: no-store\n', '\n/a\n  Link: <y>\n')).toBe('/a\n  Cache-Control: no-store\n  Link: <y>\n');
    expect(build.joinHeaderBlocks('/a\n  Link: <x>\n', '')).toBe('/a\n  Link: <x>\n');
  });

  test('a prerendered snapshot hands its scripts to the loader, inlines its CSS, and marks #root', () => {
    // The four marketing routes are written as real HTML; index.html stays
    // the shell, so "/" is landing.html and nothing claims index.html.
    expect(build.PRERENDER.map((p) => p.file)).toEqual(['landing.html', 'how-it-works.html', 'about.html', 'research.html', 'flux.html', 'ai.html']);
    expect(build.PRERENDER.find((p) => p.route === '/').file).toBe('landing.html');

    const snapshot = '<!DOCTYPE html><html><head>'
      + '<script defer="defer" src="/static/js/main.1a2b.js"></script>'
      + '<link href="/static/css/main.3c4d.css" rel="stylesheet">'
      + '<script charset="utf-8" data-webpack="flock:chunk-landing" src="/static/js/landing.5e6f.chunk.js"></script>'
      + '<link rel="stylesheet" type="text/css" href="/static/css/7788.9a0b.chunk.css">'
      + '<link rel="stylesheet" href="/static/css/9999.dead.chunk.css">'
      + '</head><body><div id="root"><main><h1>Flock is how a group decides where to go out.</h1></main></div></body></html>';
    const font = '/static/media/Literata-Display-600.9f9f.woff2';
    const sheets = {
      '/static/css/main.3c4d.css': 'body{margin:0}@font-face{src:url(/static/media/x.woff2)}',
      '/static/css/7788.9a0b.chunk.css': '.lp{color:$1}',
    };
    const loader = '/static/js/paint-first.0a0b0c0d.js';
    const opts = { scripts: ['/static/js/landing.5e6f.chunk.js', '/static/js/4242.1b1b.chunk.js'], font, css: (h) => sheets[h] || null, loader };
    const out = build.servableSnapshot(snapshot, opts);

    // main.js gives way to the loader, which names it and the page's chunks:
    // the one webpack left as a tag and the one the load fetched, once each.
    // Nothing in the head fetches a script at parse time any more.
    expect(out).toContain('<script defer="defer" src="/static/js/paint-first.0a0b0c0d.js" data-main="/static/js/main.1a2b.js" data-chunks="/static/js/landing.5e6f.chunk.js /static/js/4242.1b1b.chunk.js"></script>');
    expect(out).not.toContain('<script defer="defer" src="/static/js/main.1a2b.js">');
    expect(out).not.toMatch(/data-webpack/);
    expect(out).not.toMatch(/rel="preload" as="script"/);

    // Each stylesheet the build has is written in where its link was, under
    // its own path as data-href (the mark webpack's CSS loader checks before
    // fetching a chunk's sheet), "$1" and all; one it cannot read keeps its link.
    expect(out).toContain('<style data-href="/static/css/main.3c4d.css">body{margin:0}@font-face{src:url(/static/media/x.woff2)}</style>');
    expect(out).toContain('<style data-href="/static/css/7788.9a0b.chunk.css">.lp{color:$1}</style>');
    expect(out).toContain('<link rel="stylesheet" href="/static/css/9999.dead.chunk.css">');
    expect(out.indexOf('main.3c4d.css')).toBeLessThan(out.indexOf('7788.9a0b'));

    // The display face is preloaded, with crossorigin or it is fetched twice,
    // and a page that already asked for it is not given a second hint.
    expect(out).toContain(`<link rel="preload" as="font" type="font/woff2" href="${font}" crossorigin="anonymous">`);
    expect(build.servableSnapshot(snapshot.replace('</head>', `<link rel="preload" as="font" href="${font}"></head>`), opts).split(font)).toHaveLength(2);
    expect(out).toContain('<div id="root" data-prerendered=""><main><h1>');

    // A stylesheet that could close the <style> early stays a link.
    const closer = build.servableSnapshot(snapshot, { ...opts, css: () => 'a{}</style><script>x</script>' });
    expect(closer).not.toContain('</style><script>x');
    expect(closer).toContain('<link href="/static/css/main.3c4d.css" rel="stylesheet">');

    // A snapshot that never rendered, or that the loader could not boot, is
    // refused rather than published.
    expect(() => build.servableSnapshot(snapshot, { ...opts, loader: undefined })).toThrow(/loader/);
    expect(() => build.servableSnapshot(snapshot.replace('main.1a2b.js', 'app.1a2b.js'), opts)).toThrow(/main\.js/);
    expect(() => build.servableSnapshot('<html><head><script defer="defer" src="/static/js/main.1a2b.js"></script></head><body><div id="root"></div></body></html>', opts)).toThrow(/no h1/);
    expect(() => build.servableSnapshot('<html><head><script defer="defer" src="/static/js/main.1a2b.js"></script></head><body><main><h1>x</h1></main></body></html>', opts)).toThrow(/root/);
  });

  test('the loader ships under a name that changes with its bytes', () => {
    // /static/ is cached for a year as immutable, so the name must move
    // whenever cloudflare/paint-first.js does.
    const a = build.paintFirst();
    const hash = crypto.createHash('sha256').update(read('cloudflare/paint-first.js')).digest('hex').slice(0, 8);
    expect(a.url).toBe(`/static/js/paint-first.${hash}.js`);
    expect(a.file.split(path.sep).join('/')).toBe(`static/js/paint-first.${hash}.js`);
    expect(a.source).toBe(read('cloudflare/paint-first.js'));
    expect(read('cloudflare/_headers')).toMatch(/^\/static\/\*\n {2}Cache-Control: public, max-age=31536000, immutable$/m);
  });

  test('a prerendered route is sent the display face alone, not its chunks', () => {
    // Its CSS is in the HTML and its scripts wait for the first paint, so a
    // chunk hint would be a second download or exactly the early fetch the
    // snapshot avoids. A route served from index.html keeps all three.
    const files = {
      'landing.css': '/static/css/landing.0f0f0f0f.chunk.css',
      'landing.js': '/static/js/landing.12ab34cd.chunk.js',
      'howitworks.js': '/static/js/howitworks.9e8d7c6b.chunk.js',
      'static/media/Literata-Display-600.woff2': '/static/media/Literata-Display-600.5a5a5a5a.woff2',
    };
    fs.writeFileSync(path.join(out, 'asset-manifest.json'), JSON.stringify({ files }));
    withEnv({ APPLE_TEAM_ID: fakeTeamId(), CF_PAGES: '1' }, () => build.finishOutput(out, { prerendered: ['/how-it-works'] }));
    const text = fs.readFileSync(path.join(out, '_headers'), 'utf8');
    const font = '</static/media/Literata-Display-600.5a5a5a5a.woff2>; rel=preload; as=font; type="font/woff2"; crossorigin';
    const link = (p) => headerBlocks(text).find((b) => b.path === p).headers.Link;
    const own = (p) => headerBlocks(build.headersFile()).find((b) => b.path === p).headers.Link;
    expect(link('/')).toBe(`${own('/')}, </static/css/landing.0f0f0f0f.chunk.css>; rel=preload; as=style, </static/js/landing.12ab34cd.chunk.js>; rel=preload; as=script, ${font}`);
    expect(link('/how-it-works')).toBe(`${own('/how-it-works')}, ${font}`);
  });

  test('writes the 404 page and every exact app route as the shell, byte for byte, and keeps a snapshot', () => {
    // 404.html is what Pages answers a path with that is neither a file nor a
    // _redirects rule, with a 404: the shell, so a browser still boots the
    // app and its own not-found page. A stale one (a hand-made page, a
    // previous run's) is replaced.
    fs.writeFileSync(path.join(out, '404.html'), 'not found');
    const snapshot = '<!doctype html><div id="root" data-prerendered=""><main><h1>About Flock</h1></main></div>';
    fs.writeFileSync(path.join(out, 'about.html'), snapshot);
    withEnv({ APPLE_TEAM_ID: fakeTeamId(), CF_PAGES: '1' }, () => build.finishOutput(out));
    const shell = fs.readFileSync(path.join(out, 'index.html'));
    const isShell = (file) => fs.readFileSync(path.join(out, file)).equals(shell);
    expect(isShell('404.html')).toBe(true);
    for (const route of build.APP_ROUTES) expect([route, isShell(route.slice(1) + '.html')]).toEqual([route, true]);
    // A prerendered route is a file and never a rewrite, so one whose
    // snapshot failed gets the shell under the snapshot's name; a snapshot
    // that exists is kept, and no route file is written over one.
    expect(build.APP_ROUTES.filter((route) => build.PRERENDER.some((p) => p.route === route))).toEqual([]);
    for (const { file } of build.PRERENDER) {
      expect([file, isShell(file)]).toEqual([file, file !== 'about.html']);
    }
    expect(fs.readFileSync(path.join(out, 'about.html'), 'utf8')).toBe(snapshot);
    // A second run over the same output (a --skip-build rerun) is the same output.
    withEnv({ APPLE_TEAM_ID: fakeTeamId(), CF_PAGES: '1' }, () => build.finishOutput(out));
    expect(isShell('404.html')).toBe(true);
    expect(fs.readFileSync(path.join(out, 'about.html'), 'utf8')).toBe(snapshot);
    // The served paths leave out the files Pages reads and never serves.
    const served = build.servedFiles(out);
    expect(served).toEqual(expect.arrayContaining(['/index.html', '/404.html', '/i.html', '/admin/moderation.html', '/.well-known/apple-app-site-association']));
    expect(served.filter((file) => /^\/_(headers|redirects|routes\.json)$/.test(file))).toEqual([]);
  });

  test('refuses a rewrite in _redirects that would hide a file: a catch-all, or one over a page', () => {
    // A 200 rule runs before Pages looks for a file.
    const files = ['/index.html', '/404.html', '/about.html', '/app.html', '/static/js/main.1a2b.js', '/docs/index.html'];
    expect(() => build.checkRedirects('/* / 200\n', files)).toThrow(/rewrites \/index\.html/);
    expect(() => build.checkRedirects('/static/* / 200\n', files)).toThrow(/serves \/static\/js\/main\.1a2b\.js/);
    expect(() => build.checkRedirects('/about / 200\n', files)).toThrow(/rewrites \/about /);
    expect(() => build.checkRedirects('/docs/ / 200\n', files)).toThrow(/rewrites \/docs\/ /);
    expect(() => build.checkRedirects('/app/* / 200\n/f/* / 200\n', files)).not.toThrow();
    // A redirect over a file is a decision, not an accident: only rewrites are refused.
    expect(() => build.checkRedirects('/about.html /about 308\n', files)).not.toThrow();
    // And the real file passes over the real output's names.
    expect(() => build.checkRedirects(read('cloudflare/_redirects'), files)).not.toThrow();
  });

  test('refuses source maps on a Pages build, and only there', () => {
    fs.mkdirSync(path.join(out, 'static', 'js'), { recursive: true });
    fs.writeFileSync(path.join(out, 'static', 'js', 'main.abc123.js.map'), '{}');
    expect(() => withEnv({ APPLE_TEAM_ID: fakeTeamId(), CF_PAGES: '1' }, () => build.finishOutput(out))).toThrow(/1 source maps/);
    expect(() => withEnv({ APPLE_TEAM_ID: fakeTeamId(), CF_PAGES: undefined }, () => build.finishOutput(out))).not.toThrow();
  });

  test('refuses an output with no index.html, and one with no Team ID', () => {
    expect(() => withEnv({ APPLE_TEAM_ID: undefined }, () => build.finishOutput(out))).toThrow(/APPLE_TEAM_ID/);
    fs.rmSync(path.join(out, 'index.html'));
    expect(() => withEnv({ APPLE_TEAM_ID: fakeTeamId() }, () => build.finishOutput(out))).toThrow(/index\.html is missing/);
  });

  test('the output is where react-scripts writes it: build/, or BUILD_PATH', () => {
    expect(build.outputDir({})).toBe(path.join(ROOT, 'build'));
    expect(build.outputDir({ BUILD_PATH: 'elsewhere' })).toBe(path.join(ROOT, 'elsewhere'));
    expect(build.outputDir({ BUILD_PATH: out })).toBe(out);
  });
});

// build.pagesAnswer is a transcription of Pages' static asset server
// (pages-shared/asset-server/handler.ts, as wrangler 4.151.3 carries it). The
// status tests in cloudflarePagesFunctions.test.js stand on it, so each case
// here is one that handler decides, written as Pages answers it.
describe('the model of how Pages answers a path', () => {
  const files = new Set(['/index.html', '/404.html', '/about.html', '/app.html', '/docs/index.html', '/docs/404.html', '/static/js/main.1a2b.js']);
  const answer = (target, redirects = '', method = 'GET') => build.pagesAnswer(target, { files, redirects, method });

  test('a file, with Pages\' handling of .html and trailing slashes', () => {
    expect(answer('/')).toEqual({ status: 200, file: '/index.html' });
    expect(answer('/static/js/main.1a2b.js')).toEqual({ status: 200, file: '/static/js/main.1a2b.js' });
    expect(answer('/about')).toEqual({ status: 200, file: '/about.html' });
    expect(answer('/about/')).toEqual({ status: 308, location: '/about' });
    expect(answer('/about.html?x=1')).toEqual({ status: 308, location: '/about?x=1' });
    expect(answer('/index.html')).toEqual({ status: 308, location: '/' });
    expect(answer('/docs')).toEqual({ status: 308, location: '/docs/' });
    expect(answer('/docs/')).toEqual({ status: 200, file: '/docs/index.html' });
    expect(answer('/docs/index')).toEqual({ status: 308, location: '/docs/' });
  });

  test('no file: the nearest 404.html with a 404, or with none at all, index.html and a 200', () => {
    expect(answer('/wp-login.php')).toEqual({ status: 404, file: '/404.html' });
    expect(answer('/.env')).toEqual({ status: 404, file: '/404.html' });
    expect(answer('/About')).toEqual({ status: 404, file: '/404.html' });
    expect(answer('/docs/missing/page')).toEqual({ status: 404, file: '/docs/404.html' });
    // The single-page-app fallback this site had until the build wrote 404.html.
    expect(build.pagesAnswer('/wp-login.php', { files: new Set(['/index.html']), redirects: '' })).toEqual({ status: 200, file: '/index.html' });
    expect(answer('/about', '', 'POST')).toEqual({ status: 405 });
  });

  test('_redirects first: a 200 keeps the URL and serves its target, and an exact rule above the splats wins', () => {
    const rules = '/old /about 308\n/app/* / 200\n/app/exact /about 200\n';
    expect(answer('/old?x=1', rules)).toEqual({ status: 308, location: '/about?x=1' });
    expect(answer('/app/venue/42', rules)).toEqual({ status: 200, file: '/index.html' });
    expect(answer('/app/', rules)).toEqual({ status: 200, file: '/index.html' });
    expect(answer('/app', rules)).toEqual({ status: 200, file: '/app.html' });
    // Below a splat an exact rule is matched in file order, so the splat answers first.
    expect(answer('/app/exact', rules)).toEqual({ status: 200, file: '/index.html' });
    expect(answer('/app/exact', '/app/exact /about 200\n/app/* / 200\n')).toEqual({ status: 200, file: '/about.html' });
    // A rewrite runs before the file lookup, which is why checkRedirects exists.
    expect(answer('/about', '/about / 200\n')).toEqual({ status: 200, file: '/index.html' });
    // A rewrite to /index.html is a 308 to "/", and wrangler drops a folder's
    // splat sent there (it loops), and a repeated path.
    expect(answer('/x', '/x /index.html 200\n')).toEqual({ status: 308, location: '/' });
    expect(answer('/app/x', '/app/* /index.html 200\n')).toEqual({ status: 404, file: '/404.html' });
    expect(answer('/old', '/old /about 308\n/old / 301\n')).toEqual({ status: 308, location: '/about' });
    // Placeholders and the splat carry into the target.
    expect(answer('/blog/2026/hello', '/blog/:year/* /news/:year/:splat 301\n')).toEqual({ status: 301, location: '/news/2026/hello' });
    // Matching is case-sensitive, as Pages' is.
    expect(answer('/APP/x', rules)).toEqual({ status: 404, file: '/404.html' });
  });
});
