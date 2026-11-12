// Whether `npm run deploy:cloudflare` has anything to publish.
//
// WHY. The deploy is run after a push to main, and many pushes change nothing
// the site is built from: of the last 400 commits on main (11 November 2026),
// 148 touched nothing under frontend/ and 3 more touched only the iPhone
// project. A deploy after such a push built the site and uploaded it again.
//
// WHEN IT SKIPS. Only when all of this holds, and anything it cannot tell is a
// reason to publish, because a wrong skip leaves the live site on old code:
// - this checkout has a record of its last upload (published.json, kept in
//   .asset-history/ beside the earlier builds' files);
// - git finds no difference between that commit and HEAD in what the site is
//   built from, the tree has no uncommitted change, and no untracked file sits
//   in the site's folders;
// - what the build reads from this machine is the same: the environment
//   variables, the .env files, what is installed in node_modules, and Node;
// - the live site is serving that upload: the page it answers with names the
//   same build and loads the same main script and stylesheet. An upload from
//   another checkout, or a rollback in the dashboard, is not skipped over.
//
// WHAT IT CANNOT SEE. A secret or variable changed in the Pages dashboard
// reaches the functions only with a new deployment, and nothing here can read
// the dashboard: publish with --force after changing one.
//
// The record is written after an upload that went through, of a build made
// from a clean tree with every marketing page snapshotted. Any other upload
// leaves no record, and the next run publishes again.
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { COMMIT_VARS } = require('./build');
const { PRERENDER } = require('./build-cloudflare');

const ROOT = path.join(__dirname, '..');
const RECORD = 'published.json';
// A page every visitor and every crawler gets the same way: "/" answers some
// crawlers with a redirect to the snapshot.
const LIVE_PAGE = 'https://www.flockcorp.com/app';

// Tracked under frontend/ and no part of the site: the iPhone project, the
// App Store flows and screenshots, and the notes at the top of the folder.
// The tests are NOT here, unlike scripts/vercel-ignore-build.js: Tailwind
// scans every file under src/ for class names (tailwind.config.js), so a test
// file can change the stylesheet.
const NOT_THE_SITE = [
  ':(exclude,glob)ios/**',
  ':(exclude,glob).maestro/**',
  ':(exclude,glob)screenshots/**',
  ':(exclude,glob)*.md',
];

// Untracked on purpose, and compared another way (LOCAL_INPUTS below) or made
// by the deploy itself.
const LOCAL = [
  ':(exclude,glob).env*',
  ':(exclude)build',
  ':(exclude)node_modules',
  ':(exclude).asset-history',
  ':(exclude).wrangler',
];

// The environment variables a build reads besides REACT_APP_*: build.js and
// build-cloudflare.js, react-scripts, and browserslist, Babel, Tailwind and
// PostCSS underneath it (read from their sources, 11 November 2026).
const ENV_NAMES = new Set([
  'BUILD_PATH', 'PUBLIC_URL', 'GENERATE_SOURCEMAP', 'INLINE_RUNTIME_CHUNK', 'IMAGE_INLINE_SIZE_LIMIT',
  'DISABLE_ESLINT_PLUGIN', 'DISABLE_NEW_JSX_TRANSFORM', 'TSC_COMPILE_ON_ERROR', 'ESLINT_NO_DEV_ERRORS',
  'NODE_PATH', 'NODE_OPTIONS', 'VERCEL', 'AUTOPREFIXER_GRID', ...COMMIT_VARS,
]);
const ENV_FAMILIES = /^(REACT_APP_|BROWSERSLIST|BABEL_|TAILWIND_|POSTCSS_|JITI_|WEBPACK_)/;

// What the build reads from this machine, and how each is named in a reason.
const LOCAL_INPUTS = {
  env: { changed: 'an environment variable the build reads changed', unread: 'the environment could not be read' },
  envFiles: { changed: 'a .env file changed', unread: 'the .env files could not be read' },
  packages: { changed: 'what is installed in node_modules changed', unread: 'node_modules has no .package-lock.json to compare' },
  node: { changed: 'the Node version changed', unread: 'the Node version could not be read' },
};

const COMMIT = /^[0-9a-f]{40}$/;
const DIGEST = /^[0-9a-f]{64}$/;
// Which build a page is, as "33858ef main.1647d1fd.js main.e3c65b94.css": the
// id in its <meta name="flock-build">, then the main script and stylesheet it
// loads. The id alone names the commit. The main script names every lazy
// chunk by its hash, so the two names stand for the compiled app, keys
// included: the same commit built with other keys is another build.
const BUILD_META = /<meta\s+name="flock-build"\s+content="([^"]*)"\s*\/?>/g;
const MAIN_FILES = /\/static\/(?:js|css)\/(main\.[0-9a-f]{8,32}\.(?:js|css))(?![\w.])/g;
const BUILD = /^[0-9A-Za-z][0-9A-Za-z._-]{0,39}(?: main\.[0-9a-f]{8,32}\.(?:js|css)){1,4}$/;
const SNAPSHOT_MARK = '<div id="root" data-prerendered="">';

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

// A hook's GIT_DIR and its like must not reach a git started here: it would
// answer for another repository.
function gitEnv(env = process.env) {
  const clean = {};
  for (const [key, value] of Object.entries(env)) {
    if (!/^GIT_/i.test(key)) clean[key] = value;
  }
  return clean;
}

function git(args, root = ROOT) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', env: gitEnv() });
  return { status: result.status === null ? -1 : result.status, stdout: result.stdout || '' };
}

/** The commit HEAD is at, or null when git does not say. */
function headCommit(root = ROOT) {
  const { status, stdout } = git(['rev-parse', 'HEAD'], root);
  const commit = stdout.trim();
  return status === 0 && COMMIT.test(commit) ? commit : null;
}

/**
 * Tracked files under frontend/ with a change that is not committed, as git
 * prints them: '' when there are none, null when git does not say.
 */
function trackedChanges(root = ROOT) {
  const { status, stdout } = git(['status', '--porcelain', '--untracked-files=no', '--', '.'], root);
  return status === 0 ? stdout.trimEnd() : null;
}

/**
 * 0: nothing the site is built from differs between `commit` and HEAD. 1: something does. Anything else: git could not compare.
 *
 * Byte for byte, never through a text converter. Git for Windows' own config
 * diffs a PDF (and .doc, .docx, .rtf) through `astextplain`, and `--quiet`
 * then compares the text it prints: on 12 November 2026 a new research paper
 * whose words were the same and whose references had become links read as no
 * change, and the deploy skipped it while the site went on serving the old
 * file. --no-ext-diff for the same reason, against an external diff tool.
 */
function diffExitCode(commit, root = ROOT) {
  if (!COMMIT.test(commit)) return -1;
  return git(['diff', '--quiet', '--no-textconv', '--no-ext-diff', commit, 'HEAD', '--', '.', ...NOT_THE_SITE], root).status;
}

/**
 * The files and folders under frontend/ that git does not track, ignored ones
 * included, apart from LOCAL and NOT_THE_SITE. The build copies public/ whole
 * and compiles whatever src/ imports, tracked or not. null when git cannot list.
 */
function looseFiles(root = ROOT) {
  const { status, stdout } = git(['ls-files', '--others', '--directory', '--no-empty-directory', '--', '.', ...LOCAL, ...NOT_THE_SITE], root);
  return status === 0 ? stdout.split('\n').map((line) => line.trim()).filter(Boolean) : null;
}

// Only digests are kept: the values are keys, and published.json is a file.
function fingerprint({ root = ROOT, env = process.env, node = process.version } = {}) {
  const lines = [];
  for (const [key, value] of Object.entries(env)) {
    // Windows reads a variable whatever the case of its name.
    const name = key.toUpperCase();
    if (ENV_NAMES.has(name) || ENV_FAMILIES.test(name)) lines.push(name + '=' + value);
  }
  let envFiles = null;
  let packages = null;
  try {
    const names = fs.readdirSync(root).filter((name) => name.startsWith('.env') && fs.statSync(path.join(root, name)).isFile()).sort();
    envFiles = sha256(names.map((name) => name + '\n' + sha256(fs.readFileSync(path.join(root, name)))).join('\n'));
  } catch {
    // Left null, which never matches a record.
  }
  try {
    // npm's own list of what it installed, rewritten by every install.
    packages = sha256(fs.readFileSync(path.join(root, 'node_modules', '.package-lock.json')));
  } catch {
    // The same.
  }
  return { env: sha256(lines.sort().join('\n')), envFiles, packages, node: typeof node === 'string' && node ? node : null };
}

/** Which build a page is (BUILD above), or null when the page does not say: no id or more than one, or no main script. */
function buildIn(html) {
  const text = String(html);
  const ids = new Set([...text.matchAll(BUILD_META)].map((match) => match[1]));
  const mains = [...new Set([...text.matchAll(MAIN_FILES)].map((match) => match[1]))].sort();
  if (ids.size !== 1 || !mains.some((name) => name.endsWith('.js'))) return null;
  const build = [...ids][0] + ' ' + mains.join(' ');
  return BUILD.test(build) ? build : null;
}

/** The build the live site is serving, or null when it cannot be read. */
async function liveBuild({ fetchImpl = typeof fetch === 'function' ? fetch : null, url = LIVE_PAGE, timeoutMs = 8000 } = {}) {
  if (!fetchImpl) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { cache: 'no-store', redirect: 'error', signal: controller.signal });
    return response.ok ? buildIn(await response.text()) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The marketing pages in `out` that are the empty page and not a snapshot.
 * build-cloudflare.js only warns when a snapshot fails and puts a copy of
 * index.html in its place, so the file is there either way.
 */
function shellPages(out) {
  return PRERENDER.map(({ file }) => file).filter((file) => {
    try {
      return !fs.readFileSync(path.join(out, file), 'utf8').includes(SNAPSHOT_MARK);
    } catch {
      return true;
    }
  });
}

/** The last upload this checkout recorded, or null. A file is checked like any other input. */
function readRecord(historyDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(historyDir, RECORD), 'utf8'));
    const print = parsed.fingerprint;
    const whole = COMMIT.test(parsed.commit)
      && BUILD.test(parsed.build)
      && Number.isFinite(Date.parse(parsed.at))
      && DIGEST.test(print.env) && DIGEST.test(print.envFiles) && DIGEST.test(print.packages)
      && typeof print.node === 'string' && print.node.length > 0;
    if (!whole) return null;
    return {
      commit: parsed.commit,
      build: parsed.build,
      at: parsed.at,
      fingerprint: { env: print.env, envFiles: print.envFiles, packages: print.packages, node: print.node },
    };
  } catch {
    return null;
  }
}

// A record that was cut short does not parse, and reads as no record.
function writeRecord(historyDir, record) {
  fs.mkdirSync(historyDir, { recursive: true });
  fs.writeFileSync(path.join(historyDir, RECORD), JSON.stringify(record, null, 1) + '\n');
}

function forgetRecord(historyDir) {
  fs.rmSync(path.join(historyDir, RECORD), { force: true });
}

/**
 * { publish, reason }. `state` is what is true of the checkout now: head,
 * trackedChanges, fingerprint. diffExitCode, loose and liveBuild are asked
 * only when everything before them allows a skip, in that order: the live
 * site is read last.
 */
async function decide({ flags = {}, record, state, diffExitCode: diff, loose, liveBuild: readLive }) {
  const publish = (reason) => ({ publish: true, reason });
  if (flags.force) return publish('--force');
  if (flags.dropOld) return publish('--drop-old takes the earlier builds\' files off the site');
  if (flags.skipBuild) return publish('--skip-build uploads build/ as it is');
  if (!state.head) return publish('git did not name the commit');
  if (typeof state.trackedChanges !== 'string') return publish('git did not say whether the tree has changes');
  if (state.trackedChanges) return publish('the tree has changes that are not committed');
  if (!record) return publish('this checkout has no record of an earlier publish');
  for (const [part, words] of Object.entries(LOCAL_INPUTS)) {
    if (!state.fingerprint[part]) return publish(words.unread);
    if (state.fingerprint[part] !== record.fingerprint[part]) return publish(words.changed + ' since the last publish');
  }
  const short = record.commit.slice(0, 8);
  const code = diff(record.commit);
  if (code === 1) return publish('the site changed since ' + short);
  if (code !== 0) return publish('could not compare with ' + short + ' (git exit ' + code + ')');
  const found = loose();
  if (!found) return publish('git could not list the files it does not track');
  if (found.length) {
    return publish('files git does not track are in the site\'s folders: ' + found.slice(0, 5).join(', ') + (found.length > 5 ? ' and ' + (found.length - 5) + ' more' : ''));
  }
  const live = await readLive();
  if (!live) return publish('could not read which build is live');
  if (live !== record.build) return publish('the live site is serving ' + live + ', and the last publish from here was ' + record.build);
  return { publish: false, reason: 'nothing the site is built from changed since ' + short + ', and the live site is serving that upload (' + live + ')' };
}

/**
 * After an upload that went through: { record } to keep, or { why } there is
 * none. `state` is the one decide() saw, with `loose` as it was before the
 * build.
 */
function recordOf({ flags = {}, state, loose, out, now = new Date() }) {
  if (flags.skipBuild) return { why: '--skip-build uploaded a build that was already there' };
  if (!state.head) return { why: 'git did not name the commit' };
  if (typeof state.trackedChanges !== 'string') return { why: 'git did not say whether the tree had changes' };
  if (state.trackedChanges) return { why: 'the tree had changes that are not committed' };
  if (!loose) return { why: 'git could not list the files it does not track' };
  if (loose.length) return { why: 'files git does not track were in the site\'s folders' };
  const unread = Object.keys(LOCAL_INPUTS).find((part) => !state.fingerprint[part]);
  if (unread) return { why: LOCAL_INPUTS[unread].unread };
  let build = null;
  try {
    build = buildIn(fs.readFileSync(path.join(out, 'index.html'), 'utf8'));
  } catch {
    // Reported below.
  }
  if (!build) return { why: 'build/index.html does not say which build it is' };
  const shells = shellPages(out);
  if (shells.length) return { why: shells.join(', ') + ' went up without ' + (shells.length === 1 ? 'its' : 'their') + ' snapshot' };
  return { record: { commit: state.head, build, at: now.toISOString(), fingerprint: state.fingerprint } };
}

module.exports = {
  NOT_THE_SITE,
  LOCAL,
  LOCAL_INPUTS,
  LIVE_PAGE,
  RECORD,
  gitEnv,
  headCommit,
  trackedChanges,
  diffExitCode,
  looseFiles,
  fingerprint,
  buildIn,
  liveBuild,
  shellPages,
  readRecord,
  writeRecord,
  forgetRecord,
  decide,
  recordOf,
};
