#!/usr/bin/env node
/* Build the real frontend, pointed at the local end to end API.
 *
 * THE ONE THING THIS FILE EXISTS FOR. services/api.js reads
 * `process.env.REACT_APP_API_URL || 'https://flock-app-production.up.railway.app'`.
 * Create React App inlines that at build time, so a build made without the
 * variable is a local looking app talking to the PRODUCTION database. It would
 * sign up real accounts and send real messages and look completely normal doing
 * it. Setting the variable is the whole job; stack.js additionally refuses to
 * serve a bundle that still names the production host, because one guard on
 * something this quiet is not enough.
 *
 * Output goes to tools/e2e/build rather than frontend/build so that an e2e
 * build can never be mistaken for a deployable one, and so running this does
 * not clobber whatever was last built for Vercel.
 *
 * Usage: node tools/e2e/build.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const FRONTEND = path.join(REPO, 'frontend');
const OUT = path.join(__dirname, 'build');
const CRA_BUILD = path.join(FRONTEND, 'build');

const API_PORT = Number(process.env.E2E_API_PORT || 5199);
const API_BASE = `http://127.0.0.1:${API_PORT}`;

function log(m) { process.stdout.write(`[e2e-build] ${m}\n`); }

// Whatever is in frontend/build right now belongs to somebody else. Move it
// aside rather than destroying it, and put it back afterwards.
const STASH = path.join(FRONTEND, 'build.e2e-stashed');

function restore() {
  try {
    if (fs.existsSync(STASH)) {
      fs.rmSync(CRA_BUILD, { recursive: true, force: true });
      fs.renameSync(STASH, CRA_BUILD);
      log('restored the previous frontend/build');
    }
  } catch (err) {
    log(`could not restore frontend/build: ${err.message}`);
  }
}

log(`building with REACT_APP_API_URL=${API_BASE}`);
if (fs.existsSync(CRA_BUILD)) fs.renameSync(CRA_BUILD, STASH);

try {
  const res = spawnSync('npm', ['run', 'build'], {
    cwd: FRONTEND,
    stdio: 'inherit',
    shell: true,
    env: {
      ...process.env,
      CI: 'true',
      REACT_APP_API_URL: API_BASE,
      // The analytics key must not be live in a run that clicks every button a
      // few hundred times. A run like that is exactly the localhost traffic
      // that once made 1,526 of 1,792 pageviews meaningless.
      REACT_APP_POSTHOG_KEY: '',
      REACT_APP_POSTHOG_HOST: '',
      REACT_APP_SENTRY_DSN: '',
    },
  });
  if (res.status !== 0) {
    log('build failed');
    restore();
    process.exit(res.status || 1);
  }

  fs.rmSync(OUT, { recursive: true, force: true });
  fs.cpSync(CRA_BUILD, OUT, { recursive: true });
  log(`build copied to ${OUT}`);
} finally {
  fs.rmSync(CRA_BUILD, { recursive: true, force: true });
  restore();
}

// THE CSP HAS TO LEARN ABOUT THE LOCAL API, and this is the only place that is
// allowed to teach it.
//
// public/index.html ships a Content-Security-Policy meta tag whose connect-src
// names the production Railway origin and nothing else. That is correct and it
// is enforced: a page served from 127.0.0.1:3199 trying to reach
// 127.0.0.1:5199 is blocked before a request is ever emitted, which is why the
// first run of this harness saw zero API calls and an app reporting it could
// not reach Flock. Chromium says "Failed to fetch" with no request in the log,
// which is the signature of CSP rather than CORS.
//
// So the built copy in tools/e2e/build gets the local API added to connect-src,
// and NOTHING else changes. frontend/public/index.html is never touched, the
// deployable build is never touched, and this rewrite happens after the copy so
// it can only ever affect the throwaway one.
{
  const indexPath = path.join(OUT, 'index.html');
  const html = fs.readFileSync(indexPath, 'utf8');
  const WS_BASE = API_BASE.replace('http://', 'ws://');
  const patched = html.replace(/connect-src ([^;"]*)/, (m, srcs) => `connect-src ${srcs} ${API_BASE} ${WS_BASE}`);
  if (patched === html) {
    log('FAILED: could not find connect-src in the built index.html, so the app cannot reach the local api.');
    process.exit(1);
  }
  fs.writeFileSync(indexPath, patched);
  log(`csp connect-src widened for the local api only (${API_BASE})`);
}

// Prove the substitution happened, rather than trusting the variable went in.
//
// The check is "is the local base present", NOT "is the production host
// absent", and the difference matters. The first version of this asserted the
// absence and failed on a correct build, because the production hostname is
// ALSO the hardcoded Apple Sign-In redirectURI in the source, and it appears in
// the bundle no matter what REACT_APP_API_URL is set to. api.js's own fallback
// string is in the source too. Absence was never the property; substitution is.
//
// The real proof is at runtime, and playwright asserts it: the first API call a
// page makes has to go to 127.0.0.1. A bundle can be inspected wrongly. A
// request cannot be misread.
const jsDir = path.join(OUT, 'static', 'js');
const bundles = fs.readdirSync(jsDir).filter((f) => f.endsWith('.js'));
const pointed = bundles.filter((f) => fs.readFileSync(path.join(jsDir, f), 'utf8').includes(API_BASE));
if (pointed.length === 0) {
  log(`FAILED: no bundle names ${API_BASE}, so the build did not take the variable and this app talks to production.`);
  process.exit(1);
}
log(`verified: ${pointed.length} bundle(s) name the local api (${API_BASE})`);
