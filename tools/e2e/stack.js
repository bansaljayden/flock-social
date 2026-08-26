#!/usr/bin/env node
/* A whole Flock, running on this machine, for a browser to actually use.
 *
 * WHY THIS EXISTS RATHER THAN POINTING A BROWSER AT PRODUCTION.
 * backend/.env holds PGHOST=caboose.proxy.rlwy.net, which is the live Railway
 * database. An end to end run against that creates real accounts, real flocks
 * and real messages in production, spends real money on Google Places, Vision
 * and Gemini on every loop, and pollutes the PostHog funnel that is the only
 * instrument for whether the product works. On a product with roughly zero
 * users, that pollution is not noise, it is most of the data.
 *
 * So this boots the real server.js against a throwaway embedded Postgres and
 * serves the real production frontend build against it. Same code, no blast
 * radius, and it can be thrown away and rebuilt in a minute.
 *
 * THE THREE ENVIRONMENT TRAPS, all of which backend/scripts/e2e-local.js hit
 * first and documented:
 *   1. server.js runs dotenv on backend/.env, and dotenv never overrides a
 *      value that is already set. PGHOST is pre-set to empty here so the
 *      production host cannot leak in. server.js has its own quarantine guard
 *      that refuses to boot on a Railway host, and this keeps that guard
 *      looking at the embedded database rather than tripping on the leak.
 *   2. .env sets PGSSLMODE=require for the Railway proxy. Embedded Postgres
 *      speaks no TLS, so the pool dies at the handshake without an override.
 *   3. PostgreSQL 18's default io_method=worker leaves io_worker children alive
 *      forever when a run is killed. sync starts none.
 *
 * AND THE FRONTEND TRAP, which is worse because it fails silently:
 * services/api.js reads `process.env.REACT_APP_API_URL || <the Railway
 * production URL>`. A build made without that variable set is a local looking
 * app talking to production. build.js sets it explicitly and this file refuses
 * to serve a bundle that still names the production host.
 *
 * Usage:
 *   node tools/e2e/build.js     # once, and after any frontend change
 *   node tools/e2e/stack.js     # boots, prints the URL, stays up until killed
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { createRequire } = require('module');

// Resolve backend dependencies the way the backend itself would. A plain
// path.join into backend/node_modules assumes nothing was hoisted, and both
// embedded-postgres and express live at the repository root here.
const backendRequire = createRequire(path.join(__dirname, '..', '..', 'backend', 'package.json'));

const REPO = path.resolve(__dirname, '..', '..');
const BACKEND = path.join(REPO, 'backend');
const BUILD_DIR = path.join(REPO, 'tools', 'e2e', 'build');

const PG_PORT = Number(process.env.E2E_PG_PORT || 59610);
const API_PORT = Number(process.env.E2E_API_PORT || 5199);
const WEB_PORT = Number(process.env.E2E_WEB_PORT || 3199);
const API_BASE = `http://127.0.0.1:${API_PORT}`;

// 127.0.0.1 and not localhost, everywhere. Node's fetch can fail localhost on
// the IPv6/IPv4 split even while the server is listening on one of them.
const WEB_BASE = `http://127.0.0.1:${WEB_PORT}`;

function log(msg) { process.stdout.write(`[e2e] ${msg}\n`); }

async function waitFor(fn, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if (await fn()) return true; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function main() {
  if (!fs.existsSync(path.join(BUILD_DIR, 'index.html'))) {
    log('No build found. Run: node tools/e2e/build.js');
    process.exit(1);
  }

  // The refusal that makes the rest of this safe to run unattended: a build made
  // without REACT_APP_API_URL is a local looking app talking to the production
  // database, and it looks completely normal doing it.
  //
  // Asserted as "the local base is present", not "the production host is
  // absent". The production hostname is also the hardcoded Apple Sign-In
  // redirectURI and api.js's own fallback string, so it ships in every bundle
  // regardless and an absence check fails on a correct build. Substitution is
  // the property. The stronger proof is the runtime one in the playwright
  // setup, which watches where the first request actually goes.
  const jsDir = path.join(BUILD_DIR, 'static', 'js');
  const bundles = fs.existsSync(jsDir) ? fs.readdirSync(jsDir).filter((f) => f.endsWith('.js')) : [];
  const pointed = bundles.filter((f) => fs.readFileSync(path.join(jsDir, f), 'utf8').includes(API_BASE));
  if (pointed.length === 0) {
    log('REFUSING TO SERVE: no bundle names the local api, so this build talks to production.');
    log('Rebuild with tools/e2e/build.js, which sets REACT_APP_API_URL.');
    process.exit(1);
  }

  const EP = backendRequire('embedded-postgres');
  const EmbeddedPostgres = EP.default || EP;
  const dataDir = path.join(os.tmpdir(), `flock-e2e-pg-${process.pid}`);

  const pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: 'postgres',
    password: 'postgres',
    port: PG_PORT,
    persistent: false,
    postgresFlags: ['-c', 'io_method=sync'],
  });

  log('starting embedded postgres (first run downloads binaries)');
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('flock_e2e');

  process.env.DATABASE_URL = `postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/flock_e2e`;
  process.env.PGHOST = '';            // trap 1
  process.env.PGSSLMODE = 'disable';  // trap 2
  process.env.NODE_ENV = 'development';
  process.env.PORT = String(API_PORT);
  process.env.JWT_SECRET = 'e2e-local-secret';
  // No Google, Gemini, Vision or Resend keys are set on purpose. Every one of
  // those degrades rather than throwing, and a run that cannot spend money is
  // a run that can be left going.
  process.env.PUBLIC_WEB_URL = WEB_BASE;
  // The web build is served from a different port than the API, so every call
  // is cross origin. server.js's allowlist is exact hosts only and deliberately
  // holds no pattern (two successive regexes over *.vercel.app were bypassed),
  // so 127.0.0.1:3199 is not on it and never should be. EXTRA_CORS_ORIGIN is
  // the opt-in that exists for precisely this, and it is UNSET in production.
  process.env.EXTRA_CORS_ORIGIN = WEB_BASE;
  // FRONTEND_URL is the first entry of that same allowlist, and it also decides
  // where emailed links point.
  process.env.FRONTEND_URL = WEB_BASE;

  log('booting backend (this runs the real migrations)');
  require(path.join(BACKEND, 'server.js'));
  await waitFor(async () => (await fetch(`${API_BASE}/api/health`)).ok, 60000, 'the api');
  log(`api up on ${API_BASE}`);

  // Static server with SPA fallback. frontend/src/index.js is a path router
  // (/, /app, /privacy, /i/:token, /admin/moderation ...), so every unknown
  // path has to return index.html or half the app 404s under a browser.
  const express = backendRequire('express');
  const app = express();
  app.use(express.static(BUILD_DIR, { index: false, maxAge: 0 }));
  app.get('*', (_req, res) => res.sendFile(path.join(BUILD_DIR, 'index.html')));
  await new Promise((r) => app.listen(WEB_PORT, '127.0.0.1', r));

  log(`web up on ${WEB_BASE}`);
  log('');
  log(`  OPEN: ${WEB_BASE}/app`);
  log(`  API:  ${API_BASE}`);
  log('');
  log('ctrl-c to stop. the database is thrown away on exit.');

  const stop = async () => {
    log('stopping');
    try { await pg.stop(); } catch { /* already gone */ }
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((err) => {
  log(`failed: ${err.stack || err.message}`);
  process.exit(1);
});
