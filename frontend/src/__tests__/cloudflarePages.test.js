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
 * - nothing in public/ switches off Pages' SPA fallback or leaks the Pages files;
 * - the app-site-association file in the build is the handler's own body;
 * - the build refuses an output Pages would serve differently from Vercel.
 * The Functions themselves are pinned in cloudflarePagesFunctions.test.js.
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
    // Two additions with no vercel.json rule: the pages.dev copy is noindex,
    // and the app-site-association file, which has no extension, is typed.
    expect(byPath.get('https://:project.pages.dev/*')).toEqual({ 'X-Robots-Tag': 'noindex' });
    expect(byPath.has('/.well-known/apple-app-site-association')).toBe(true);
  });

  test('_redirects holds the one unconditional vercel.json redirect, as a 308, and no catch-all', () => {
    const lines = read('cloudflare/_redirects').split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#'));
    const unconditional = vercel.redirects.filter((r) => !r.has && !r.missing);
    expect(lines).toEqual(unconditional.map((r) => [r.source, r.destination, r.permanent ? '308' : '307'].join(' ')));
    expect(lines).toEqual(['/research/flock-research-paper.pdf /papers/flock-research-paper.pdf 308']);
  });

  test('_routes.json sends Functions exactly the paths the middleware and functions/api handle', () => {
    expect(routes.version).toBe(1);
    expect(routes.exclude).toEqual([]);
    expect(new Set(routes.include)).toEqual(new Set([
      '/', '/landing', '/about', '/support', '/privacy', '/terms',
      '/i/*', '/relay/public/*', '/api/*', '/bg-city.mp4',
    ]));
    // Every function file is under a routed path, and every api/ handler a
    // function wraps has one at its own /api/<name> URL, as on Vercel.
    const functions = fs.readdirSync(path.join(ROOT, 'functions', 'api')).sort();
    expect(functions).toEqual(['apple-app-site-association.js', 'demo-relay.js', 'invite-og.js', 'invite-preview.js', 'marketing-page.js']);
    const handlers = fs.readdirSync(path.join(ROOT, 'api')).filter((f) => !f.startsWith('_')).sort();
    expect(functions).toEqual(handlers);
  });

  test('public/ holds no 404.html and none of the Pages files', () => {
    for (const name of ['404.html', '_headers', '_redirects', '_routes.json', '_worker.js']) {
      expect([name, fs.existsSync(path.join(ROOT, 'public', name))]).toEqual([name, false]);
    }
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

  test('refuses an output with a top-level 404.html, which turns off the SPA fallback', () => {
    fs.writeFileSync(path.join(out, '404.html'), 'not found');
    expect(() => withEnv({ APPLE_TEAM_ID: fakeTeamId() }, () => build.finishOutput(out))).toThrow(/404\.html/);
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
