// The hashed files of the builds this checkout published before, kept on the
// site for a while after a newer build replaces them.
//
// WHY. Cloudflare Pages serves one deployment at a time. Once a new one is
// live, a file that only the last one had answers with the 404 page, unless
// the Cloudflare data centre the request reaches served that same file within
// the last week (Pages' preservation cache), and a screen nobody near the
// visitor opened that week is not in it. A tab that was already open is still
// running the last build's main bundle, which asks for its lazy chunks by
// their hashed names, so the first screen that tab had not loaded yet came up
// as "Part of the app didn't load" until the person reloaded. Measured over
// the 25 deployments between 5 and 11 November 2026: a tab three days old had
// lost between 34 and 50 of its 107 lazy files.
//
// HOW. A hashed name stands for one exact set of bytes (main.a7f2e0c7.js), so
// an old file can sit beside the new ones and never be taken for one of them.
// deploy-cloudflare.js keeps a copy of every hashed file it publishes in
// .asset-history/ (untracked, beside build/), and before each upload puts back
// into build/static/ the ones the new build no longer has. After the upload it
// takes them out again, so build/ is left holding the build alone.
//
// A file stays for KEEP_DAYS after the build that had it was replaced. The
// days count from the replacement, not from the first upload: a build that
// was live for two months is still what yesterday's tab is running.
//
// TO TAKE A FILE OFF THE SITE AT ONCE (a bundle that carried something it
// should not have): delete it from .asset-history/files/ and deploy, or deploy
// with --drop-old, which carries nothing forward and starts the history again
// from that build. Deleting the whole folder by hand is not enough while the
// last build is still in build/: the next deploy reads it as the live one and
// keeps it. Every deployment also stays reachable at its own
// <id>.flockcorp.pages.dev address until it is deleted in the Pages dashboard,
// and nothing here changes that.
//
// The folder is only ever a copy. Losing it costs the tabs that are open
// across that one deploy, and one publish that could have been skipped:
// publish-skip.js keeps its record of the last upload here too
// (published.json).
'use strict';
const fs = require('fs');
const path = require('path');

const KEEP_DAYS = 30;
// Pages takes 20,000 files in a deployment; the build itself is a few hundred.
const MAX_CARRIED = 5000;
const DAY_MS = 24 * 60 * 60 * 1000;
const INDEX = 'index.json';

// A name the build made from the file's own bytes: main.a7f2e0c7.js,
// 9665.98e29dad.chunk.js, Fraunces-var.252d721d4b7469f6889f.woff2. A source
// map and the licence text beside a script end differently and are never kept.
const HASHED = /\.[0-9a-f]{8,32}\.(?:chunk\.)?[A-Za-z0-9]+$/;

function isCarriable(fileName) {
  return HASHED.test(fileName) && !fileName.endsWith('.map');
}

// The only paths this file copies from the history or deletes by name: a
// hashed file under static/. The index is a file on disk, so a name read from
// it is checked like any other input before it is joined to a folder.
function isHistoryName(name) {
  if (typeof name !== 'string' || !name.startsWith('static/') || name.includes('\\')) return false;
  const parts = name.split('/');
  return parts.every((part) => part && part !== '.' && part !== '..') && isCarriable(parts[parts.length - 1]);
}

/** Every file under <dir>/static, as paths from <dir> with forward slashes, sorted. */
function staticFiles(dir) {
  const found = [];
  const walk = (rel) => {
    let entries;
    try {
      entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const next = rel + '/' + entry.name;
      if (entry.isDirectory()) walk(next);
      else if (entry.isFile()) found.push(next);
    }
  };
  walk('static');
  return found.sort();
}

/** The hashed ones among them. */
const hashedFiles = (dir) => staticFiles(dir).filter(isHistoryName);

const filesDir = (historyDir) => path.join(historyDir, 'files');
const keptPath = (historyDir, name) => path.join(filesDir(historyDir), name);
const sizeOf = (file) => (fs.existsSync(file) ? fs.statSync(file).size : -1);

function pause(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    // A handful of milliseconds, on a retry that is rare.
  }
}

// Windows refuses a rename for a moment while a virus scanner or the search
// indexer has the target open, which is likeliest just after it was written.
function moveInto(from, to) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      if (attempt === 5 || !['EPERM', 'EACCES', 'EBUSY'].includes(err.code)) throw err;
      pause(40 * attempt);
    }
  }
}

// Through a temporary name, so a copy that was cut short is never taken for
// the file.
function copyFile(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to + '.tmp');
  moveInto(to + '.tmp', to);
}

// One name is one set of bytes, so a copy that is already there is the file.
// One of another length is a copy that went wrong, and is replaced.
function keep(buildDir, historyDir, name) {
  const from = path.join(buildDir, name);
  const to = keptPath(historyDir, name);
  if (sizeOf(to) !== sizeOf(from)) copyFile(from, to);
}

/**
 * { live, seen }: `live` names the hashed files of the build uploaded last,
 * `seen` gives for each kept file the last moment it was known to be live.
 * A missing or unreadable index is an empty one.
 */
function readIndex(historyDir) {
  const index = { live: [], seen: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(historyDir, INDEX), 'utf8'));
    if (Array.isArray(parsed.live)) index.live = parsed.live.filter(isHistoryName);
    for (const [name, when] of Object.entries(parsed.seen || {})) {
      if (isHistoryName(name) && Number.isFinite(Date.parse(when))) index.seen[name] = when;
    }
  } catch {
    // Starts again: noteLive takes the build that is there for the live one.
  }
  return index;
}

function writeIndex(historyDir, index) {
  fs.mkdirSync(historyDir, { recursive: true });
  const seen = {};
  for (const name of Object.keys(index.seen).sort()) seen[name] = index.seen[name];
  const file = path.join(historyDir, INDEX);
  fs.writeFileSync(file + '.tmp', JSON.stringify({ live: [...index.live].sort(), seen }, null, 1) + '\n');
  moveInto(file + '.tmp', file);
}

/**
 * Before the build empties <buildDir>: whatever is live at this moment was
 * live until now. The first run has no record of what is live and takes the
 * build still in <buildDir> for it, which is the one the last deploy uploaded.
 */
function noteLive(buildDir, historyDir, now) {
  const index = readIndex(historyDir);
  if (!index.live.length) {
    index.live = hashedFiles(buildDir);
    for (const name of index.live) keep(buildDir, historyDir, name);
  }
  for (const name of index.live) index.seen[name] = now.toISOString();
  writeIndex(historyDir, index);
  return index.live;
}

/**
 * After the build: keep a copy of what it made, and put back beside it the
 * files earlier builds had and this one lacks. Files past their days, and the
 * oldest ones past `maxFiles`, leave the history here too. Returns what the
 * build made (`current`) and what was put back (`carried`), as paths from
 * <buildDir>.
 */
function carryForward(buildDir, historyDir, now, { keepDays = KEEP_DAYS, maxFiles = MAX_CARRIED } = {}) {
  const index = readIndex(historyDir);
  const current = hashedFiles(buildDir);
  const inBuild = new Set(current);
  for (const name of current) {
    keep(buildDir, historyDir, name);
    index.seen[name] = now.toISOString();
  }
  const oldest = now.getTime() - keepDays * DAY_MS;
  const lastLive = (name) => Date.parse(index.seen[name]);
  const carried = Object.keys(index.seen)
    .filter((name) => !inBuild.has(name) && lastLive(name) >= oldest && fs.existsSync(keptPath(historyDir, name)))
    .sort((a, b) => lastLive(b) - lastLive(a) || (a < b ? -1 : 1))
    .slice(0, maxFiles);

  // The index says what the folder holds. Anything else in it goes, a copy
  // that was cut short included.
  const staying = new Set([...current, ...carried]);
  for (const name of Object.keys(index.seen)) {
    if (!staying.has(name)) delete index.seen[name];
  }
  for (const name of staticFiles(filesDir(historyDir))) {
    if (!staying.has(name)) fs.rmSync(keptPath(historyDir, name), { force: true });
  }

  for (const name of carried) copyFile(keptPath(historyDir, name), path.join(buildDir, name));
  writeIndex(historyDir, index);
  return { current, carried };
}

/** After the upload went through: this build is the live one. */
function markLive(historyDir, current) {
  const index = readIndex(historyDir);
  index.live = current;
  writeIndex(historyDir, index);
}

/**
 * <buildDir> goes back to holding the build alone. Returns the files that
 * would not go (held open by another program); the next build empties the
 * folder before it writes, so they do not outlast it.
 */
function dropCarried(buildDir, carried) {
  const left = [];
  for (const name of carried) {
    try {
      fs.rmSync(path.join(buildDir, name), { force: true });
    } catch {
      left.push(name);
    }
  }
  return left;
}

/** --drop-old: nothing earlier is kept, and the history starts again from the next build. */
function forget(historyDir) {
  fs.rmSync(historyDir, { recursive: true, force: true, maxRetries: 3 });
}

module.exports = {
  KEEP_DAYS,
  MAX_CARRIED,
  isCarriable,
  isHistoryName,
  hashedFiles,
  readIndex,
  noteLive,
  carryForward,
  markLive,
  dropCarried,
  forget,
};
