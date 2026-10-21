// vercel.json "ignoreCommand": Vercel's Ignored Build Step. Exit 0 cancels
// the deployment, exit 1 lets it build.
//
// Every push to main rebuilt the website, also when only backend/,
// flock-sensor/ or research files changed, and Vercel keeps each deployment
// its retention policy deletes for another 30 days. Those copies (13 MB each,
// about 27 a day) filled the Hobby plan's 10 GB of deployment storage by
// 2026-10-20 with only five deployments live.
//
// So it builds main only, and only when something the site is built from
// changed since the last deployment that built. When it cannot tell (no
// previous SHA, or that commit is outside Vercel's shallow clone, which makes
// git exit 128) it builds.
'use strict';
const { spawnSync } = require('child_process');

// Under frontend/ (the project's Root Directory, where Vercel runs this) but
// not part of the website build: the native shells and the tests.
const NOT_THE_SITE = [
  ':(exclude,glob)ios/**',
  ':(exclude,glob)android/**',
  ':(exclude,glob)**/__tests__/**',
  ':(exclude,glob)**/*.test.js',
  ':(exclude,glob)*.md',
];

function decide(env, diffExitCode) {
  const ref = env.VERCEL_GIT_COMMIT_REF;
  if (ref && ref !== 'main') return { build: false, reason: 'branch ' + ref + ': only main deploys' };
  const previous = env.VERCEL_GIT_PREVIOUS_SHA;
  if (!previous) return { build: true, reason: 'no earlier deployment to compare with' };
  const short = previous.slice(0, 8);
  const code = diffExitCode(previous);
  if (code === 0) return { build: false, reason: 'nothing the site is built from changed since ' + short };
  if (code === 1) return { build: true, reason: 'the site changed since ' + short };
  return { build: true, reason: 'could not compare with ' + short + ' (git exit ' + code + ')' };
}

function gitDiffExitCode(previous) {
  const result = spawnSync('git', ['diff', '--quiet', previous, 'HEAD', '--', '.', ...NOT_THE_SITE], { stdio: 'inherit' });
  return result.status === null ? -1 : result.status;
}

module.exports = { decide, NOT_THE_SITE };

if (require.main === module) {
  const { build, reason } = decide(process.env, gitDiffExitCode);
  console.log((build ? 'Building: ' : 'Skipping: ') + reason);
  process.exit(build ? 1 : 0);
}
