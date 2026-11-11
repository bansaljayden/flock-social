// `npm run deploy:cloudflare`: publish this checkout's site to Cloudflare
// Pages, project "flockcorp" (wrangler.toml), the host for flockcorp.com.
//
// Pages builds nothing itself for this project. The keys the site is built
// with (REACT_APP_* in frontend/.env) live only on the machine that deploys,
// and no one types them into a dashboard, so the build runs here and wrangler
// uploads build/ together with functions/. wrangler reads the commit, message
// and dirty state from git on its own; --branch main makes the upload the
// production deployment from a detached checkout too.
//
// It refuses a tree with tracked changes under frontend/, so what goes live is
// a commit someone can find, and refuses to build without frontend/.env,
// which would publish a site with no Google sign-in, maps or analytics.
//
// The hashed files of the builds published before go up again beside the new
// ones, so a tab that was open across the deploy can still load the screens
// it had not opened yet. scripts/asset-history.js says why, for how long, and
// how to take a file off the site at once; --drop-old publishes this build
// alone.
//
// A run with nothing to publish stops before the build. scripts/publish-skip.js
// says when that is, and what it cannot see: a secret or variable changed in
// the Pages dashboard reaches the functions only with a new deployment, so
// publish with --force after changing one (HOW_TO_FORCE below; npm keeps a
// --force that comes before the "--" for itself).
//
// Needs `wrangler login` once on the machine (Pages access is enough).
// Nothing runs this on its own. It is run after a push to main, from a
// checkout of the commit that is to go live.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const history = require('./asset-history');
const skip = require('./publish-skip');

const ROOT = path.join(__dirname, '..');
const WRANGLER = 'wrangler@4.151.3';
// What wrangler uploads (pages_build_output_dir in wrangler.toml), and the
// earlier builds' files beside it.
const OUT = path.join(ROOT, 'build');
const HISTORY = path.join(ROOT, '.asset-history');
const HOW_TO_FORCE = 'npm run deploy:cloudflare -- --force';

// Every word the command takes. One it does not know is refused: a mistyped
// --force would otherwise end in "nothing to publish".
const FLAGS = new Map([
  ['--force', 'force'],
  ['--skip-build', 'skipBuild'],
  ['--drop-old', 'dropOld'],
  ['--allow-dirty', 'allowDirty'],
]);

function flagsFrom(argv) {
  const flags = {};
  for (const word of argv) {
    if (!FLAGS.has(word)) throw new Error('unknown option ' + word + ' (it takes ' + [...FLAGS.keys()].join(', ') + ')');
    flags[FLAGS.get(word)] = true;
  }
  return flags;
}

function teamIdFrom(toml) {
  const match = /^\s*APPLE_TEAM_ID\s*=\s*"([A-Z0-9]{10})"\s*$/m.exec(toml);
  if (!match) throw new Error('wrangler.toml has no APPLE_TEAM_ID under [vars]');
  return match[1];
}

function refusal({ trackedChanges, hasEnv, allowDirty }) {
  if (trackedChanges && !allowDirty) return 'frontend/ has tracked changes; commit them first:\n' + trackedChanges;
  if (!hasEnv) return 'frontend/.env is missing: the site would build without its keys';
  return null;
}

function run(command, args, env) {
  // npx is a .cmd file on Windows, which Node only spawns through a shell.
  // Every argument here is a fixed word, so the shell sees nothing to expand.
  const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit', env, shell: process.platform === 'win32' });
  if (result.status !== 0) throw new Error(command + ' ' + args.join(' ') + ' exited ' + result.status);
}

async function main(argv) {
  const flags = flagsFrom(argv);
  const reason = refusal({
    trackedChanges: skip.trackedChanges(),
    hasEnv: fs.existsSync(path.join(ROOT, '.env')),
    allowDirty: flags.allowDirty,
  });
  if (reason) throw new Error(reason);
  const teamId = teamIdFrom(fs.readFileSync(path.join(ROOT, 'wrangler.toml'), 'utf8'));
  await deploy({ flags, teamId });
}

/**
 * One run: publish, unless publish-skip.js finds nothing to publish, and keep
 * its record of what went up. Returns whether it published. `checks` reads the
 * checkout and the live site and `upload` is publish below; a test passes its
 * own, with folders of its own.
 */
async function deploy({ flags = {}, teamId, out = OUT, historyDir = HISTORY, now = new Date(), log = console.log, checks = skip, upload = publish }) {
  const state = { head: checks.headCommit(), trackedChanges: checks.trackedChanges(), fingerprint: checks.fingerprint() };
  let loose;
  const looseFiles = () => {
    if (loose === undefined) loose = checks.looseFiles();
    return loose;
  };
  const verdict = await skip.decide({
    flags,
    record: skip.readRecord(historyDir),
    state,
    diffExitCode: checks.diffExitCode,
    loose: looseFiles,
    liveBuild: checks.liveBuild,
  });
  if (!verdict.publish) {
    log('deploy:cloudflare: nothing to publish: ' + verdict.reason + '. To publish anyway: ' + HOW_TO_FORCE);
    return false;
  }
  log('deploy:cloudflare: publishing: ' + verdict.reason);
  // Read before the build writes anything, and the record goes first: from
  // here until an upload is recorded again, nothing says what is live.
  const before = looseFiles();
  skip.forgetRecord(historyDir);
  upload({ teamId, skipBuild: flags.skipBuild, dropOld: flags.dropOld, out, historyDir, now, log });
  const { record, why } = skip.recordOf({ flags, state, loose: before, out, now });
  if (record) {
    skip.writeRecord(historyDir, record);
    log('deploy:cloudflare: published build ' + record.build);
  } else {
    log('deploy:cloudflare: published. The next run publishes again: ' + why);
  }
  return true;
}

/**
 * Build, upload, and keep the earlier builds' hashed files on the site through
 * it. `start` runs a command; a test passes its own in place of the build and
 * the upload, with folders of its own and a clock.
 */
function publish({ teamId, skipBuild = false, dropOld = false, out = OUT, historyDir = HISTORY, now = new Date(), start = run, log = console.log }) {
  // Before the build, which empties the folder the live build is still in.
  if (dropOld) history.forget(historyDir);
  else history.noteLive(out, historyDir, now);
  if (!skipBuild) {
    start('node', ['scripts/build-cloudflare.js'], { ...process.env, CF_PAGES: '1', APPLE_TEAM_ID: teamId });
  }
  // After the build's own checks, so nothing it verifies is an older file.
  const { current, carried } = history.carryForward(out, historyDir, now);
  log('deploy:cloudflare: ' + carried.length + ' hashed files of earlier builds stay on the site beside this build\'s ' + current.length);
  try {
    start('npx', ['-y', WRANGLER, 'pages', 'deploy', 'build', '--project-name', 'flockcorp', '--branch', 'main'], process.env);
    // Only an upload that went through changes what is live.
    history.markLive(historyDir, current);
  } finally {
    const left = history.dropCarried(out, carried);
    if (left.length) log('deploy:cloudflare: ' + left.length + ' of them could not be taken back out of build/; the next build clears them');
  }
}

module.exports = { teamIdFrom, refusal, flagsFrom, publish, deploy, WRANGLER, HOW_TO_FORCE };

if (require.main === module) {
  main(process.argv.slice(2)).catch((err) => {
    console.error('deploy:cloudflare: ' + err.message);
    process.exit(1);
  });
}
