/**
 * @jest-environment node
 */
/*
 * scripts/publish-skip.js decides whether `npm run deploy:cloudflare` has
 * anything to publish. A wrong "nothing to publish" leaves the live site on
 * old code, so every case where it cannot tell has to publish. The decision
 * runs here on stand-ins, the git questions run in a repository made for the
 * test, and the whole run (deploy in scripts/deploy-cloudflare.js) runs with
 * a stand-in for the build and the upload.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const skip = require('../../scripts/publish-skip');
const history = require('../../scripts/asset-history');
const { deploy, publish } = require('../../scripts/deploy-cloudflare');
const { PRERENDER, servableSnapshot } = require('../../scripts/build-cloudflare');

const never = (what) => () => {
  throw new Error(what + ' should not be asked for this case');
};

const COMMIT_A = 'a'.repeat(40);
const COMMIT_B = 'b'.repeat(40);
const COMMIT_C = 'c'.repeat(40);
const BUILD = '33858ef main.1647d1fd.js main.e3c65b94.css';
const PRINT = { env: '1'.repeat(64), envFiles: '2'.repeat(64), packages: '3'.repeat(64), node: 'v25.3.0' };
const RECORD = { commit: COMMIT_A, build: BUILD, at: '2026-11-11T14:30:00.000Z', fingerprint: PRINT };
const STATE = { head: COMMIT_B, trackedChanges: '', fingerprint: PRINT };

// The page a build makes: the id, one main script, one stylesheet.
const page = (meta) => '<!doctype html><html lang="en"><head><meta charset="utf-8"/>' + meta
  + '<script defer="defer" src="/static/js/main.1647d1fd.js"></script>'
  + '<link href="/static/css/main.e3c65b94.css" rel="stylesheet">'
  + '</head><body><div id="root"></div></body></html>';
const PAGE = page('<meta name="flock-build" content="33858ef"/>');
// A marketing page's snapshot, made the way the build makes one: the page as
// a browser writes it back out (no slash in the meta), with the screen in it.
const SNAPSHOT = servableSnapshot(
  page('<meta name="flock-build" content="33858ef">').replace('<div id="root">', '<div id="root"><h1>Flock</h1>'),
  { loader: '/static/js/paint-first.0a0b0c0d.js', css: () => 'body{margin:0}' },
);
const SNAPSHOTS = Object.fromEntries(PRERENDER.map(({ file }) => [file, SNAPSHOT]));

// Everything says "skip" unless a case changes one answer.
const ask = (over = {}) => skip.decide({
  flags: {},
  record: RECORD,
  state: STATE,
  diffExitCode: () => 0,
  loose: () => [],
  liveBuild: async () => BUILD,
  ...over,
});
// The same with nothing to ask: for the cases that are settled before git or the site.
const settled = (over) => ask({ diffExitCode: never('git diff'), loose: never('the untracked files'), liveBuild: never('the live site'), ...over });

let root;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-skip-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
});

function write(dir, files) {
  for (const [name, text] of Object.entries(files)) {
    const file = path.join(dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
}

describe('the decision', () => {
  test('skips when nothing the site is built from changed and the recorded build is live', async () => {
    const seen = [];
    const verdict = await ask({ diffExitCode: (commit) => { seen.push(commit); return 0; } });
    expect(verdict).toEqual({
      publish: false,
      reason: 'nothing the site is built from changed since aaaaaaaa, and the live site is serving that upload (' + BUILD + ')',
    });
    // Compared with the commit that was uploaded, not with the one before HEAD.
    expect(seen).toEqual([COMMIT_A]);
  });

  test('--force, --drop-old and --skip-build always publish', async () => {
    expect(await settled({ flags: { force: true } })).toEqual({ publish: true, reason: '--force' });
    expect(await settled({ flags: { dropOld: true } })).toEqual({ publish: true, reason: '--drop-old takes the earlier builds\' files off the site' });
    expect(await settled({ flags: { skipBuild: true } })).toEqual({ publish: true, reason: '--skip-build uploads build/ as it is' });
  });

  test('publishes with no record, with no commit to name, and from a tree with changes', async () => {
    expect(await settled({ record: null })).toEqual({ publish: true, reason: 'this checkout has no record of an earlier publish' });
    expect(await settled({ state: { ...STATE, head: null } })).toEqual({ publish: true, reason: 'git did not name the commit' });
    expect(await settled({ state: { ...STATE, trackedChanges: null } })).toEqual({ publish: true, reason: 'git did not say whether the tree has changes' });
    expect(await settled({ state: { ...STATE, trackedChanges: ' M src/App.js' } })).toEqual({ publish: true, reason: 'the tree has changes that are not committed' });
  });

  test.each([
    ['env', 'an environment variable the build reads changed since the last publish'],
    ['envFiles', 'a .env file changed since the last publish'],
    ['packages', 'what is installed in node_modules changed since the last publish'],
    ['node', 'the Node version changed since the last publish'],
  ])('publishes when %s differs from the record, and when it cannot be read', async (part, reason) => {
    const changed = { ...STATE, fingerprint: { ...PRINT, [part]: part === 'node' ? 'v26.0.0' : '9'.repeat(64) } };
    expect(await settled({ state: changed })).toEqual({ publish: true, reason });
    const unread = await settled({ state: { ...STATE, fingerprint: { ...PRINT, [part]: null } } });
    expect(unread).toEqual({ publish: true, reason: skip.LOCAL_INPUTS[part].unread });
  });

  test('publishes when the site changed, and when git cannot compare', async () => {
    const after = { loose: never('the untracked files'), liveBuild: never('the live site') };
    expect(await ask({ ...after, diffExitCode: () => 1 })).toEqual({ publish: true, reason: 'the site changed since aaaaaaaa' });
    expect(await ask({ ...after, diffExitCode: () => 128 })).toEqual({ publish: true, reason: 'could not compare with aaaaaaaa (git exit 128)' });
    expect(await ask({ ...after, diffExitCode: () => -1 })).toEqual({ publish: true, reason: 'could not compare with aaaaaaaa (git exit -1)' });
  });

  test('publishes when an untracked file is in the site\'s folders, and when git cannot list them', async () => {
    const liveBuild = never('the live site');
    expect(await ask({ liveBuild, loose: () => ['public/stray.png', 'src/new/'] })).toEqual({
      publish: true,
      reason: 'files git does not track are in the site\'s folders: public/stray.png, src/new/',
    });
    const many = await ask({ liveBuild, loose: () => ['a', 'b', 'c', 'd', 'e', 'f', 'g'] });
    expect(many.reason).toBe('files git does not track are in the site\'s folders: a, b, c, d, e and 2 more');
    expect(await ask({ liveBuild, loose: () => null })).toEqual({ publish: true, reason: 'git could not list the files it does not track' });
  });

  test('publishes when the live site cannot be read, or is serving another build', async () => {
    expect(await ask({ liveBuild: async () => null })).toEqual({ publish: true, reason: 'could not read which build is live' });
    // The same commit built with other keys, and another commit.
    for (const live of ['33858ef main.0badc0de.js main.e3c65b94.css', 'ccccccc main.1647d1fd.js main.e3c65b94.css']) {
      expect(await ask({ liveBuild: async () => live })).toEqual({
        publish: true,
        reason: 'the live site is serving ' + live + ', and the last publish from here was ' + BUILD,
      });
    }
  });
});

describe('what git is asked', () => {
  test('every pathspec after "." only excludes', () => {
    for (const spec of [...skip.NOT_THE_SITE, ...skip.LOCAL]) expect(spec.startsWith(':(exclude')).toBe(true);
  });

  test('the tests are not excluded: Tailwind reads them for class names', () => {
    const tailwind = require('../../tailwind.config');
    expect(tailwind.content).toEqual(['./src/**/*.{js,jsx,ts,tsx}']);
    expect(skip.NOT_THE_SITE.join(' ')).not.toMatch(/test/);
  });
});

describe('which build a page is', () => {
  test('the id, then the main script and stylesheet the page loads', () => {
    expect(skip.buildIn(PAGE)).toBe(BUILD);
    // As public/index.html writes the meta, and as a browser writes it back out.
    expect(skip.buildIn(page('<meta name="flock-build" content="33858ef" />'))).toBe(BUILD);
    expect(skip.buildIn(page('<meta name="flock-build" content="33858ef">'))).toBe(BUILD);
    // A build with no commit to name carries the day it was made.
    expect(skip.buildIn(page('<meta name="flock-build" content="2026-11-11"/>'))).toBe('2026-11-11 main.1647d1fd.js main.e3c65b94.css');
  });

  test('a name the page gives twice counts once, and a snapshot is the same build as the page', () => {
    const preloaded = PAGE.replace('</head>', '<link rel="preload" as="script" href="/static/js/main.1647d1fd.js"></head>');
    expect(skip.buildIn(preloaded)).toBe(BUILD);
    expect(SNAPSHOT).toContain('data-main="/static/js/main.1647d1fd.js"');
    expect(SNAPSHOT).toContain('<style data-href="/static/css/main.e3c65b94.css">');
    expect(skip.buildIn(SNAPSHOT)).toBe(BUILD);
  });

  test('null when the page does not say', () => {
    const META = '<meta name="flock-build" content="33858ef"/>';
    expect(skip.buildIn(page(''))).toBeNull();
    expect(skip.buildIn(page(META + '<meta name="flock-build" content="1473311"/>'))).toBeNull();
    expect(skip.buildIn(page('<meta name="flock-build" content="%REACT_APP_BUILD_ID%"/>'))).toBeNull();
    expect(skip.buildIn(page('<meta name="flock-build" content=""/>'))).toBeNull();
    // A stylesheet alone, a source map, and a file that only starts like the script.
    expect(skip.buildIn(PAGE.replace('main.1647d1fd.js', 'app.1647d1fd.js'))).toBeNull();
    expect(skip.buildIn(PAGE.replace('main.1647d1fd.js', 'main.1647d1fd.js.map'))).toBeNull();
    expect(skip.buildIn(PAGE.replace('main.1647d1fd.js', 'main.1647d1fd.jsx'))).toBeNull();
    const five = ['11111111', '22222222', '33333333', '44444444'].map((hash) => '<script src="/static/js/main.' + hash + '.js"></script>').join('');
    expect(skip.buildIn(PAGE.replace('</head>', five + '</head>'))).toBeNull();
    expect(skip.buildIn(undefined)).toBeNull();
  });
});

describe('the read of the live site', () => {
  const answers = (text, ok = true) => async () => ({ ok, text: async () => text });

  test('asks for the app page, uncached and without following a redirect', async () => {
    const calls = [];
    const fetchImpl = async (url, options) => {
      calls.push({ url, options });
      return { ok: true, text: async () => PAGE };
    };
    expect(await skip.liveBuild({ fetchImpl })).toBe(BUILD);
    expect(skip.LIVE_PAGE).toBe('https://www.flockcorp.com/app');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(skip.LIVE_PAGE);
    expect(calls[0].options).toEqual({ cache: 'no-store', redirect: 'error', signal: expect.anything() });
    expect(calls[0].options.signal.aborted).toBe(false);
  });

  test('null when the site does not answer with a page that says', async () => {
    expect(await skip.liveBuild({ fetchImpl: answers(PAGE, false) })).toBeNull();
    expect(await skip.liveBuild({ fetchImpl: answers(page('')) })).toBeNull();
    expect(await skip.liveBuild({ fetchImpl: async () => { throw new Error('getaddrinfo ENOTFOUND'); } })).toBeNull();
    expect(await skip.liveBuild({ fetchImpl: async () => ({ ok: true, text: async () => { throw new Error('cut short'); } }) })).toBeNull();
    expect(await skip.liveBuild({ fetchImpl: null })).toBeNull();
  });

  test('gives up on a site that never answers', async () => {
    const hangs = (url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
    expect(await skip.liveBuild({ fetchImpl: hangs, timeoutMs: 20 })).toBeNull();
  });
});

describe('what the build reads from this machine', () => {
  const ENV = { REACT_APP_MAPTILER_KEY: 'maptiler-key-one', GENERATE_SOURCEMAP: 'false', PATH: '/usr/bin' };
  let site;
  const print = (over = {}) => skip.fingerprint({ root: site, env: ENV, node: 'v25.3.0', ...over });

  beforeEach(() => {
    site = path.join(root, 'site');
    write(site, { '.env': 'REACT_APP_POSTHOG_KEY=posthog-key-one\n', 'node_modules/.package-lock.json': '{"packages":{}}\n' });
  });

  test('the same inputs give the same answer, and only digests are kept', () => {
    const first = print();
    expect(print()).toEqual(first);
    expect(first.node).toBe('v25.3.0');
    for (const part of ['env', 'envFiles', 'packages']) expect(first[part]).toMatch(/^[0-9a-f]{64}$/);
    // The values are keys, and the record is a file.
    const kept = JSON.stringify(first);
    expect(kept).not.toContain('maptiler-key-one');
    expect(kept).not.toContain('posthog-key-one');
  });

  test.each([
    ['a key\'s value', { REACT_APP_MAPTILER_KEY: 'maptiler-key-two' }],
    ['a new REACT_APP_ variable', { REACT_APP_PURCHASES: '1' }],
    ['GENERATE_SOURCEMAP', { GENERATE_SOURCEMAP: 'true' }],
    ['a commit the host names', { GITHUB_SHA: 'abcdef1' }],
    ['BROWSERSLIST_ENV', { BROWSERSLIST_ENV: 'development' }],
    ['BABEL_ENV', { BABEL_ENV: 'test' }],
    ['PUBLIC_URL', { PUBLIC_URL: '/sub' }],
  ])('%s changes the environment\'s digest', (what, change) => {
    const before = print();
    const after = print({ env: { ...ENV, ...change } });
    expect(after.env).not.toBe(before.env);
    expect({ ...after, env: before.env }).toEqual(before);
  });

  test('a variable the build does not read changes nothing, and a name counts whatever its case', () => {
    const before = print();
    // CF_PAGES and APPLE_TEAM_ID are set by the deploy itself.
    expect(print({ env: { ...ENV, PATH: '/bin', GIT_DIR: '.git', CF_PAGES: '1', APPLE_TEAM_ID: 'TEAM123456', HOME: '/home/someone' } })).toEqual(before);
    const { GENERATE_SOURCEMAP, ...rest } = ENV;
    expect(print({ env: { ...rest, generate_sourcemap: GENERATE_SOURCEMAP } })).toEqual(before);
  });

  test('a .env file that changed, or one more of them, changes the files\' digest', () => {
    const before = print();
    write(site, { '.env': 'REACT_APP_POSTHOG_KEY=posthog-key-two\n' });
    const edited = print();
    expect(edited.envFiles).not.toBe(before.envFiles);
    expect({ ...edited, envFiles: before.envFiles }).toEqual(before);
    write(site, { '.env.production.local': 'REACT_APP_PURCHASES=1\n' });
    expect(print().envFiles).not.toBe(edited.envFiles);
  });

  test('a folder is not read as a .env file, and a checkout with none still has a digest', () => {
    const before = print();
    fs.mkdirSync(path.join(site, '.env.d'));
    expect(print()).toEqual(before);
    fs.rmSync(path.join(site, '.env'));
    const none = print();
    expect(none.envFiles).toMatch(/^[0-9a-f]{64}$/);
    expect(none.envFiles).not.toBe(before.envFiles);
  });

  test('an install changes the packages\' digest, and no install at all is null', () => {
    const before = print();
    write(site, { 'node_modules/.package-lock.json': '{"packages":{"left-pad":{}}}\n' });
    const installed = print();
    expect(installed.packages).not.toBe(before.packages);
    expect({ ...installed, packages: before.packages }).toEqual(before);
    fs.rmSync(path.join(site, 'node_modules'), { recursive: true });
    expect(print().packages).toBeNull();
  });

  test('null for what cannot be read', () => {
    const nowhere = print({ root: path.join(root, 'no-such-folder') });
    expect(nowhere.envFiles).toBeNull();
    expect(nowhere.packages).toBeNull();
    expect(nowhere.env).toBe(print().env);
    expect(print({ node: '' }).node).toBeNull();
  });
});

describe('the record of the last upload', () => {
  let historyDir;
  const put = (value) => write(historyDir, { 'published.json': typeof value === 'string' ? value : JSON.stringify(value) });

  beforeEach(() => {
    historyDir = path.join(root, 'site', '.asset-history');
  });

  test('is read back as it was written, from the folder of the earlier builds\' files', () => {
    expect(skip.readRecord(historyDir)).toBeNull();
    skip.writeRecord(historyDir, RECORD);
    expect(skip.RECORD).toBe('published.json');
    expect(fs.readdirSync(historyDir)).toEqual(['published.json']);
    expect(skip.readRecord(historyDir)).toEqual(RECORD);
  });

  test.each([
    ['cut short', '{"commit": "aaa'],
    ['the word null', 'null'],
    ['a list', '[]'],
    ['a commit cut short', { ...RECORD, commit: 'aaaaaaa' }],
    ['no build', { ...RECORD, build: undefined }],
    ['a build id alone', { ...RECORD, build: '33858ef' }],
    ['a date that is none', { ...RECORD, at: 'yesterday' }],
    ['no fingerprint', { ...RECORD, fingerprint: undefined }],
    ['a digest that could not be read', { ...RECORD, fingerprint: { ...PRINT, packages: null } }],
    ['no Node version', { ...RECORD, fingerprint: { ...PRINT, node: '' } }],
  ])('reads as no record when it is not whole: %s', (what, value) => {
    put(value);
    expect(skip.readRecord(historyDir)).toBeNull();
  });

  test('keeps what it knows and nothing else', () => {
    put({ ...RECORD, note: 'extra', fingerprint: { ...PRINT, note: 'extra' } });
    expect(skip.readRecord(historyDir)).toEqual(RECORD);
  });

  test('forgetting it takes the file alone, and does not mind there being none', () => {
    skip.forgetRecord(historyDir);
    skip.writeRecord(historyDir, RECORD);
    write(historyDir, { 'index.json': '{}\n' });
    skip.forgetRecord(historyDir);
    expect(fs.readdirSync(historyDir)).toEqual(['index.json']);
    skip.forgetRecord(historyDir);
    expect(skip.readRecord(historyDir)).toBeNull();
  });

  test('--drop-old takes it with the folder', () => {
    skip.writeRecord(historyDir, RECORD);
    history.forget(historyDir);
    expect(fs.existsSync(historyDir)).toBe(false);
    expect(skip.readRecord(historyDir)).toBeNull();
  });
});

describe('what an upload leaves on record', () => {
  let out;
  const NOW = new Date('2026-11-11T16:00:00.000Z');
  const record = (over = {}) => skip.recordOf({ flags: {}, state: STATE, loose: [], out, now: NOW, ...over });

  beforeEach(() => {
    out = path.join(root, 'site', 'build');
    write(out, { 'index.html': PAGE, ...SNAPSHOTS });
  });

  test('the commit, the build and the fingerprint of a build made whole from a clean tree', () => {
    expect(skip.shellPages(out)).toEqual([]);
    expect(record()).toEqual({ record: { commit: COMMIT_B, build: BUILD, at: '2026-11-11T16:00:00.000Z', fingerprint: PRINT } });
    // Publishing this build alone is still an upload of it.
    expect(record({ flags: { dropOld: true, force: true } }).record.build).toBe(BUILD);
  });

  test.each([
    ['--skip-build uploaded a build that was already there', { flags: { skipBuild: true } }],
    ['git did not name the commit', { state: { ...STATE, head: null } }],
    ['git did not say whether the tree had changes', { state: { ...STATE, trackedChanges: null } }],
    ['the tree had changes that are not committed', { state: { ...STATE, trackedChanges: ' M frontend/src/App.js' } }],
    ['git could not list the files it does not track', { loose: null }],
    ['files git does not track were in the site\'s folders', { loose: ['public/stray.png'] }],
    ['the .env files could not be read', { state: { ...STATE, fingerprint: { ...PRINT, envFiles: null } } }],
    ['node_modules has no .package-lock.json to compare', { state: { ...STATE, fingerprint: { ...PRINT, packages: null } } }],
  ])('none: %s', (why, over) => {
    expect(record(over)).toEqual({ why });
  });

  test('none when build/index.html does not say which build it is', () => {
    write(out, { 'index.html': page('') });
    expect(record()).toEqual({ why: 'build/index.html does not say which build it is' });
    fs.rmSync(path.join(out, 'index.html'));
    expect(record()).toEqual({ why: 'build/index.html does not say which build it is' });
  });

  test('none when a marketing page went up as the empty page', () => {
    // What build-cloudflare.js leaves when a snapshot fails: a copy of index.html.
    write(out, { 'about.html': PAGE });
    expect(skip.shellPages(out)).toEqual(['about.html']);
    expect(record()).toEqual({ why: 'about.html went up without its snapshot' });
    fs.rmSync(path.join(out, 'flux.html'));
    expect(skip.shellPages(out)).toEqual(['about.html', 'flux.html']);
    expect(record()).toEqual({ why: 'about.html, flux.html went up without their snapshot' });
  });
});

// A check that cannot be performed on this machine says so by name and does
// not run.
const HAS_GIT = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;
const NEEDS_GIT = 'SKIPPED, git is not reachable from this process: the questions'
  + ' publish-skip.js puts to git were not asked of a real repository on this run';
const gitTest = HAS_GIT ? test : test.skip;
const g = (name) => (HAS_GIT ? name : `${name} [${NEEDS_GIT}]`);

if (!HAS_GIT) {
  // eslint-disable-next-line no-console
  console.warn(`[publishSkip] ${NEEDS_GIT}.`);
}

describe('the git questions, in a repository made for the test', () => {
  jest.setTimeout(60000);

  // The identity is passed on each call and never written, a hook's GIT_DIR
  // does not reach these calls either, and git may not look above the temp
  // folder for a repository (the home folder is one on some machines).
  const IDENTITY = ['-c', 'user.email=publish-skip-test@example.com', '-c', 'user.name=Publish Skip Test', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false'];
  const ownEnv = () => {
    const env = { GIT_CEILING_DIRECTORIES: os.tmpdir() };
    for (const [key, value] of Object.entries(process.env)) {
      if (!/^GIT_/i.test(key)) env[key] = value;
    }
    return env;
  };
  function git(cwd, args) {
    const result = spawnSync('git', [...IDENTITY, ...args], { cwd, encoding: 'utf8', env: ownEnv() });
    if (result.status !== 0) throw new Error('git ' + args.join(' ') + ' failed: ' + result.stderr);
    return result.stdout;
  }

  let repo;
  let frontend;

  beforeEach(() => {
    if (!HAS_GIT) return;
    repo = path.join(root, 'repo');
    frontend = path.join(repo, 'frontend');
    fs.mkdirSync(repo);
    git(repo, ['init', '-q', '-b', 'main']);
    // Nothing below may touch a repository other than the one just made.
    const top = path.resolve(git(repo, ['rev-parse', '--show-toplevel']).trim());
    expect(top.toLowerCase()).toBe(fs.realpathSync(repo).toLowerCase());
  });

  // Writes the files, commits exactly those paths, and returns the new commit.
  function commit(files) {
    write(repo, files);
    git(repo, ['add', '--', ...Object.keys(files)]);
    git(repo, ['commit', '-q', '-m', 'a change']);
    return git(repo, ['rev-parse', 'HEAD']).trim();
  }

  gitTest(g('names the commit, and says so where git cannot answer'), () => {
    // A repository with no commit yet, then one with a commit.
    expect(skip.headCommit(repo)).toBeNull();
    const first = commit({ 'frontend/src/App.js': 'one\n', 'backend/server.js': 'one\n' });
    expect(first).toMatch(/^[0-9a-f]{40}$/);
    expect(skip.headCommit(frontend)).toBe(first);
    const nowhere = path.join(root, 'no-such-folder');
    expect(skip.headCommit(nowhere)).toBeNull();
    expect(skip.trackedChanges(nowhere)).toBeNull();
    expect(skip.diffExitCode(first, nowhere)).toBe(-1);
    expect(skip.looseFiles(nowhere)).toBeNull();
  });

  gitTest(g('compares bytes, not the text a converter makes of them'), () => {
    // Git for Windows diffs a PDF through `astextplain`; here a converter that
    // prints the same words for any file stands in for it. A paper whose words
    // stayed and whose references became links read as unchanged that way
    // (12 November 2026), and the deploy skipped it.
    git(repo, ['config', 'diff.sametext.textconv', 'node -e "process.stdout.write(String(1))"']);
    const first = commit({
      '.gitattributes': '*.pdf diff=sametext\n',
      'frontend/public/papers/paper.pdf': '%PDF-1.7 the paper, plain\n',
    });
    commit({ 'frontend/public/papers/paper.pdf': '%PDF-1.7 the paper, with its references as links\n' });
    // The trap is set: git's own quiet diff, through the converter, sees nothing.
    const fooled = spawnSync('git', ['diff', '--quiet', first, 'HEAD', '--', '.'], { cwd: frontend, encoding: 'utf8', env: ownEnv() });
    expect(fooled.status).toBe(0);
    // The question the deploy asks does not fall into it.
    expect(skip.diffExitCode(first, frontend)).toBe(1);
  });

  gitTest(g('compares only what the site is built from'), () => {
    const first = commit({
      'frontend/src/App.js': 'one\n',
      'frontend/package.json': '{}\n',
      'backend/server.js': 'one\n',
    });
    // Each change is one commit on top of the last, compared with the commit before it.
    let last = first;
    const after = (file) => {
      const before = last;
      last = commit({ [file]: 'changed in ' + file + '\n' });
      return [file, skip.diffExitCode(before, frontend)];
    };
    const SAME = [
      'backend/server.js',
      'README.md',
      'frontend/ios/App/App.swift',
      'frontend/.maestro/flow.yaml',
      'frontend/screenshots/home.png',
      'frontend/DESIGN.md',
    ];
    const CHANGED = [
      'frontend/src/App.js',
      // Tailwind reads the tests for class names.
      'frontend/src/__tests__/App.test.js',
      'frontend/public/index.html',
      'frontend/functions/invite.js',
      'frontend/scripts/build.js',
      'frontend/package.json',
      // Only the top of frontend/ is left out.
      'frontend/public/readme.md',
      'frontend/public/screenshots/home.png',
      'frontend/src/ios/notes.js',
    ];
    for (const file of SAME) expect(after(file)).toEqual([file, 0]);
    for (const file of CHANGED) expect(after(file)).toEqual([file, 1]);
    expect(skip.diffExitCode(first, frontend)).toBe(1);
    expect(skip.diffExitCode(last, frontend)).toBe(0);
    // A commit this repository does not have, and a word that is no commit.
    expect(skip.diffExitCode('f'.repeat(40), frontend)).toBe(128);
    expect(skip.diffExitCode('HEAD~1', frontend)).toBe(-1);
    expect(skip.diffExitCode(undefined, frontend)).toBe(-1);
  });

  gitTest(g('says which tracked files under frontend/ have a change that is not committed'), () => {
    commit({ 'frontend/src/App.js': 'one\n', 'backend/server.js': 'one\n' });
    expect(skip.trackedChanges(frontend)).toBe('');
    // Outside frontend/, and a file git does not track: neither is a tracked change.
    write(repo, { 'backend/server.js': 'two\n', 'frontend/src/New.js': 'new\n' });
    expect(skip.trackedChanges(frontend)).toBe('');
    write(repo, { 'frontend/src/App.js': 'two, and longer\n' });
    expect(skip.trackedChanges(frontend)).toBe(' M frontend/src/App.js');
    git(repo, ['add', '--', 'frontend/src/App.js']);
    expect(skip.trackedChanges(frontend)).toBe('M  frontend/src/App.js');
  });

  gitTest(g('lists what git does not track in the site\'s folders, ignored files included'), () => {
    commit({
      'frontend/.gitignore': '/src/ignored.js\n',
      'frontend/src/App.js': 'one\n',
      'frontend/public/index.html': 'one\n',
      'frontend/ios/App/App.swift': 'one\n',
      'frontend/.maestro/flow.yaml': 'one\n',
      'frontend/screenshots/home.png': 'one\n',
      'backend/server.js': 'one\n',
    });
    expect(skip.looseFiles(frontend)).toEqual([]);
    // What a deploy checkout holds, and what is no part of the site.
    write(repo, {
      'frontend/.env': 'REACT_APP_KEY=one\n',
      'frontend/.env.local': 'REACT_APP_KEY=two\n',
      'frontend/build/index.html': PAGE,
      'frontend/node_modules/.package-lock.json': '{}\n',
      'frontend/.asset-history/index.json': '{}\n',
      'frontend/.wrangler/state.json': '{}\n',
      'frontend/ios/App/notes.txt': 'new\n',
      'frontend/ios/App/Pods/Pod.swift': 'new\n',
      'frontend/.maestro/out/shot.png': 'new\n',
      'frontend/screenshots/new.png': 'new\n',
      'frontend/NOTES.md': 'new\n',
      'backend/stray.js': 'new\n',
    });
    expect(skip.looseFiles(frontend)).toEqual([]);
    write(repo, {
      'frontend/public/stray.png': 'new\n',
      'frontend/src/new/Screen.js': 'new\n',
      'frontend/src/ignored.js': 'new\n',
    });
    expect(skip.looseFiles(frontend)).toEqual(['public/stray.png', 'src/ignored.js', 'src/new/']);
  });

  test('a hook\'s variables are left out of the environment git is started with', () => {
    expect(skip.gitEnv({ GIT_DIR: 'x', git_work_tree: 'y', PATH: 'p', GITHUB_SHA: 'abc' })).toEqual({ PATH: 'p', GITHUB_SHA: 'abc' });
  });

  gitTest(g('answers for its own folder while GIT_DIR names another repository'), () => {
    const first = commit({ 'frontend/src/App.js': 'one\n' });
    const other = path.join(root, 'other');
    fs.mkdirSync(other);
    git(other, ['init', '-q', '-b', 'main']);
    const before = process.env.GIT_DIR;
    // What a pre-push hook run from a linked worktree leaves in the environment.
    process.env.GIT_DIR = path.join(other, '.git');
    try {
      expect(skip.headCommit(frontend)).toBe(first);
      expect(skip.trackedChanges(frontend)).toBe('');
      expect(skip.looseFiles(frontend)).toEqual([]);
    } finally {
      if (before === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = before;
    }
  });
});

describe('one run of the deploy', () => {
  const NOW = new Date('2026-11-11T16:00:00.000Z');
  const LATER = new Date('2026-11-11T17:00:00.000Z');
  const SITE = { 'index.html': PAGE, ...SNAPSHOTS };
  const PUBLISHING = 'deploy:cloudflare: publishing: ';
  const PUBLISHED = 'deploy:cloudflare: published build ' + BUILD;
  const AGAIN = 'deploy:cloudflare: published. The next run publishes again: ';
  const NO_RECORD = PUBLISHING + 'this checkout has no record of an earlier publish';
  let out;
  let historyDir;
  const recordFile = () => path.join(historyDir, 'published.json');

  beforeEach(() => {
    out = path.join(root, 'site', 'build');
    historyDir = path.join(root, 'site', '.asset-history');
  });

  // One run with stand-ins for the checkout, the live site, the build and the
  // upload. `events` is what was asked and done, in order.
  async function run({ head = COMMIT_B, flags = {}, now = NOW, live = BUILD, site = SITE, over = {}, upload } = {}) {
    const events = [];
    const lines = [];
    const uploads = [];
    const checks = {
      headCommit: () => head,
      trackedChanges: () => '',
      fingerprint: () => PRINT,
      diffExitCode: (commit) => { events.push('diff ' + commit); return 0; },
      looseFiles: () => { events.push('loose'); return []; },
      liveBuild: async () => { events.push('live'); return live; },
      ...over,
    };
    const standIn = (options) => {
      events.push('upload');
      uploads.push({ options, recordThere: fs.existsSync(recordFile()) });
      write(out, site);
    };
    const published = await deploy({
      flags, teamId: 'TEAM123456', out, historyDir, now, log: (line) => lines.push(line), checks, upload: upload || standIn,
    });
    return { published, events, lines, uploads };
  }

  test('the first run publishes, and leaves a record of what went up', async () => {
    const first = await run();
    expect(first.published).toBe(true);
    expect(first.lines).toEqual([NO_RECORD, PUBLISHED]);
    // The untracked files are listed before the build writes anything.
    expect(first.events).toEqual(['loose', 'upload']);
    expect(first.uploads).toEqual([{
      options: { teamId: 'TEAM123456', skipBuild: undefined, dropOld: undefined, out, historyDir, now: NOW, log: expect.any(Function) },
      recordThere: false,
    }]);
    expect(skip.readRecord(historyDir)).toEqual({ commit: COMMIT_B, build: BUILD, at: '2026-11-11T16:00:00.000Z', fingerprint: PRINT });
  });

  test('the next run, with nothing changed, stops before the build', async () => {
    await run();
    const record = fs.readFileSync(recordFile(), 'utf8');
    // A commit later that touched nothing the site is built from.
    const second = await run({ head: COMMIT_C, now: LATER });
    expect(second.published).toBe(false);
    expect(second.uploads).toEqual([]);
    expect(second.events).toEqual(['diff ' + COMMIT_B, 'loose', 'live']);
    expect(second.lines).toEqual([
      'deploy:cloudflare: nothing to publish: nothing the site is built from changed since bbbbbbbb, and the live site is serving that upload ('
        + BUILD + '). To publish anyway: npm run deploy:cloudflare -- --force',
    ]);
    expect(fs.readFileSync(recordFile(), 'utf8')).toBe(record);
  });

  test('--force publishes all the same, and the record moves to that commit', async () => {
    await run();
    const forced = await run({ head: COMMIT_C, now: LATER, flags: { force: true } });
    expect(forced.published).toBe(true);
    expect(forced.events).toEqual(['loose', 'upload']);
    expect(forced.lines).toEqual([PUBLISHING + '--force', PUBLISHED]);
    // The old record is gone before the upload starts.
    expect(forced.uploads[0].recordThere).toBe(false);
    expect(skip.readRecord(historyDir)).toEqual({ commit: COMMIT_C, build: BUILD, at: '2026-11-11T17:00:00.000Z', fingerprint: PRINT });
  });

  test('an upload that fails leaves no record, so the next run publishes', async () => {
    await run();
    const fails = () => {
      throw new Error('npx pages deploy exited 1');
    };
    await expect(run({ head: COMMIT_C, over: { diffExitCode: () => 1 }, upload: fails })).rejects.toThrow('npx pages deploy exited 1');
    expect(fs.existsSync(recordFile())).toBe(false);
    // The live site may be the old build or the new one by now: nothing here says which.
    const next = await run({ head: COMMIT_C, now: LATER });
    expect(next.published).toBe(true);
    expect(next.lines).toEqual([NO_RECORD, PUBLISHED]);
    expect(next.events).toEqual(['loose', 'upload']);
  });

  test('a build whose marketing page went up empty is published, and published again next time', async () => {
    const result = await run({ site: { ...SITE, 'about.html': PAGE } });
    expect(result.published).toBe(true);
    expect(result.lines).toEqual([NO_RECORD, AGAIN + 'about.html went up without its snapshot']);
    expect(fs.existsSync(recordFile())).toBe(false);
  });

  test('an untracked file in the site\'s folders publishes, and leaves no record', async () => {
    await run();
    let asked = 0;
    const stray = await run({ head: COMMIT_C, over: { looseFiles: () => { asked += 1; return ['public/stray.png']; } } });
    expect(stray.published).toBe(true);
    expect(stray.lines).toEqual([
      PUBLISHING + 'files git does not track are in the site\'s folders: public/stray.png',
      AGAIN + 'files git does not track were in the site\'s folders',
    ]);
    // Asked once, before the build.
    expect(asked).toBe(1);
    expect(fs.existsSync(recordFile())).toBe(false);
  });

  test('a list git could not give is asked for once, and leaves no record', async () => {
    await run();
    let asked = 0;
    const unlisted = await run({ head: COMMIT_C, over: { looseFiles: () => { asked += 1; return null; } } });
    expect(unlisted.published).toBe(true);
    expect(unlisted.lines).toEqual([
      PUBLISHING + 'git could not list the files it does not track',
      AGAIN + 'git could not list the files it does not track',
    ]);
    expect(asked).toBe(1);
    expect(fs.existsSync(recordFile())).toBe(false);
  });

  test('publishes when the live site is serving something else, or does not say', async () => {
    await run();
    // Someone published from another checkout, with other keys.
    const other = '33858ef main.0badc0de.js main.e3c65b94.css';
    const replaced = await run({ head: COMMIT_C, now: LATER, live: other });
    expect(replaced.published).toBe(true);
    expect(replaced.events).toEqual(['diff ' + COMMIT_B, 'loose', 'live', 'upload']);
    expect(replaced.lines).toEqual([PUBLISHING + 'the live site is serving ' + other + ', and the last publish from here was ' + BUILD, PUBLISHED]);
    expect(skip.readRecord(historyDir).commit).toBe(COMMIT_C);
    const silent = await run({ head: COMMIT_C, now: LATER, live: null });
    expect(silent.published).toBe(true);
    expect(silent.events).toEqual(['diff ' + COMMIT_C, 'loose', 'live', 'upload']);
    expect(silent.lines).toEqual([PUBLISHING + 'could not read which build is live', PUBLISHED]);
  });

  test.each([
    ['--skip-build', { flags: { skipBuild: true } }, '--skip-build uploads build/ as it is', '--skip-build uploaded a build that was already there'],
    ['a commit git cannot name', { over: { headCommit: () => null } }, 'git did not name the commit', 'git did not name the commit'],
    ['a tree with changes, under --allow-dirty,', { over: { trackedChanges: () => ' M frontend/src/App.js' } }, 'the tree has changes that are not committed', 'the tree had changes that are not committed'],
  ])('%s publishes and leaves no record', async (what, options, reason, why) => {
    await run();
    const result = await run({ ...options, now: LATER });
    expect(result.published).toBe(true);
    expect(result.lines).toEqual([PUBLISHING + reason, AGAIN + why]);
    expect(result.uploads).toHaveLength(1);
    expect(result.uploads[0].options.skipBuild).toBe(options.flags ? true : undefined);
    expect(fs.existsSync(recordFile())).toBe(false);
  });

  test('with the real publish step, the record sits beside the earlier builds\' files, and --drop-old starts both again', async () => {
    const calls = [];
    const start = (command, args, env) => {
      calls.push(command);
      if (command !== 'node') return;
      // What the build does: empties build/ and writes the site.
      expect(env.APPLE_TEAM_ID).toBe('TEAM123456');
      fs.rmSync(out, { recursive: true, force: true });
      write(out, { ...SITE, 'static/js/main.1647d1fd.js': 'main', 'static/css/main.e3c65b94.css': 'css' });
    };
    const upload = (options) => publish({ ...options, start });

    const first = await run({ upload });
    expect(calls).toEqual(['node', 'npx']);
    expect(first.lines).toEqual([
      NO_RECORD,
      'deploy:cloudflare: 0 hashed files of earlier builds stay on the site beside this build\'s 2',
      PUBLISHED,
    ]);
    expect(fs.readdirSync(historyDir).sort()).toEqual(['files', 'index.json', 'published.json']);
    expect(history.readIndex(historyDir).live).toEqual(['static/css/main.e3c65b94.css', 'static/js/main.1647d1fd.js']);

    const second = await run({ head: COMMIT_C, now: LATER, upload });
    expect(second.published).toBe(false);
    expect(calls).toEqual(['node', 'npx']);

    const alone = await run({ head: COMMIT_C, now: LATER, flags: { dropOld: true }, upload });
    expect(alone.published).toBe(true);
    expect(calls).toEqual(['node', 'npx', 'node', 'npx']);
    expect(alone.lines[0]).toBe(PUBLISHING + '--drop-old takes the earlier builds\' files off the site');
    expect(fs.readdirSync(historyDir).sort()).toEqual(['files', 'index.json', 'published.json']);
    expect(skip.readRecord(historyDir)).toEqual({ commit: COMMIT_C, build: BUILD, at: '2026-11-11T17:00:00.000Z', fingerprint: PRINT });
  });
});
