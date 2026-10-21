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
// Needs `wrangler login` once on the machine (Pages access is enough).
// tools/cloudflare/deploy-if-changed.ps1 runs this when origin/main moves.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const WRANGLER = 'wrangler@4.151.3';

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

function main(argv) {
  const git = spawnSync('git', ['status', '--porcelain', '--untracked-files=no', '--', '.'], { cwd: ROOT, encoding: 'utf8' });
  const reason = refusal({
    trackedChanges: git.stdout.trim(),
    hasEnv: fs.existsSync(path.join(ROOT, '.env')),
    allowDirty: argv.includes('--allow-dirty'),
  });
  if (reason) throw new Error(reason);
  const teamId = teamIdFrom(fs.readFileSync(path.join(ROOT, 'wrangler.toml'), 'utf8'));
  if (!argv.includes('--skip-build')) {
    run('node', ['scripts/build-cloudflare.js'], { ...process.env, CF_PAGES: '1', APPLE_TEAM_ID: teamId });
  }
  run('npx', ['-y', WRANGLER, 'pages', 'deploy', 'build', '--project-name', 'flockcorp', '--branch', 'main'], process.env);
}

module.exports = { teamIdFrom, refusal, WRANGLER };

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error('deploy:cloudflare: ' + err.message);
    process.exit(1);
  }
}
