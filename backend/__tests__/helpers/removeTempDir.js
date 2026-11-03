'use strict';
// ---------------------------------------------------------------------------
// The last line of every suite that boots an embedded Postgres: removing its
// data directory in the suite's after hook.
//
// WHY THIS IS SHARED. When that hook runs, every test in the file has already
// passed or failed, and pg.stop() has already spent up to ten seconds removing
// the directory itself (embeddedPgPort.js, removeDirectoryPatiently). Anything
// still there is a directory another process holds a handle on, which happens
// on a busy machine. fs.rmSync then throws EPERM, node:test reports the whole
// file as failed with no failing test inside it, and the pre-push hook refuses
// the push. Four suites did that in one run on 2026-11-03. Before this helper
// every suite handled the throw its own way: some swallowed every error, some
// warned, and about half had no guard at all.
//
// THE RULE. EPERM, EBUSY and ENOTEMPTY mean the directory is still held. They
// print one warning and leave the directory to sweepOrphans.js, which removes
// stale flock-<name>-pg-* directories from the temp folder when the next
// `npm test` starts. Any other error still throws: it means the hook itself is
// wrong (a bad path, a bad argument), and a busy machine does not explain it.
//
// So a suite that calls this must name its directory flock-<name>-pg-...,
// with <name> in lowercase letters, digits and dashes, or nothing will ever
// remove what is left behind.
//
// The retries below are rmSync's own. On Node 25 under Windows they were seen
// to take no retries at all on EPERM (embeddedPgPort.js has the measurement);
// the patient removal is pg.stop()'s, and this is the check after it.
// ---------------------------------------------------------------------------
const fs = require('node:fs');

const STILL_HELD = new Set(['EPERM', 'EBUSY', 'ENOTEMPTY']);

/**
 * Remove a suite's embedded-Postgres data directory. A directory that was
 * never made (the suite failed before it got that far) is nothing to do.
 *
 * @param {string|undefined} dir
 * @param {string} label  the suite's name, for the warning
 */
function removeTempDir(dir, label) {
  if (!dir) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (err) {
    if (!STILL_HELD.has(err && err.code)) throw err;
    console.warn(`[${label}] temp data directory left for the sweep: ${err.code}`);
  }
}

module.exports = { removeTempDir };
