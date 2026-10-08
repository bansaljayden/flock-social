#!/usr/bin/env node
// export-hosted.mjs: write "Flock Paper" and "Flock Night" as style JSON for
// pasting into MapTiler's Map Designer (its JSON editor, Alt+E).
//
// WHY HOSTED COPIES EXIST AT ALL. The app draws the style from the object built
// in frontend/src/components/map/flockStyle, so it needs no hosted style. Static
// Maps do: an image URL names a map id hosted on MapTiler, so the venue
// previews only match the app if the same two styles live there too. The repo
// stays the source of truth; the hosted copies are a mirror, and the
// `flock:styleVersion` in each file says which FLOCK_STYLE_VERSION was pasted.
//
// WHAT IT WRITES. Two files, flock-paper.json and flock-night.json, with every
// `?key=` removed: Map Designer serves its hosted styles with the account's own
// key, and no key belongs in a file that gets copied around.
//
// WHERE. To a scratch directory, never into frontend/public (a style there
// would ship to every visitor as a second, stale copy):
//
//   node tools/map-style/export-hosted.mjs              # os temp dir/flock-map-style
//   node tools/map-style/export-hosted.mjs --out DIR    # a directory you pick
//
// It fetches nothing and reads no environment variable.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const STYLE_MODULE = path.join(ROOT, 'frontend', 'src', 'components', 'map', 'flockStyle', 'index.js');
const PUBLIC_DIR = path.join(ROOT, 'frontend', 'public');
const PLACEHOLDER = 'FLOCK_EXPORT_PLACEHOLDER';

const outArg = process.argv.indexOf('--out');
const outDir = path.resolve(outArg > -1 && process.argv[outArg + 1]
  ? process.argv[outArg + 1]
  : path.join(os.tmpdir(), 'flock-map-style'));

const rel = path.relative(PUBLIC_DIR, outDir);
if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
  console.error(`Refusing to write into ${PUBLIC_DIR}: everything there ships with the site.`);
  process.exit(1);
}

// The style module is an ES module inside a CommonJS package; Node detects the
// syntax and loads it, with a one-line notice that is not an error.
const { buildFlockStyle, FLOCK_STYLE_VERSION } = await import(pathToFileURL(STYLE_MODULE).href);

const stripKey = (style) => JSON.parse(JSON.stringify(style)
  .split(`?key=${PLACEHOLDER}`).join('')
  .split(PLACEHOLDER).join(''));

fs.mkdirSync(outDir, { recursive: true });
for (const [file, dark] of [['flock-paper.json', false], ['flock-night.json', true]]) {
  const style = stripKey(buildFlockStyle({ dark, key: PLACEHOLDER }));
  const target = path.join(outDir, file);
  fs.writeFileSync(target, `${JSON.stringify(style, null, 2)}\n`);
  console.log(`${style.name}: ${style.layers.length} layers, style version ${FLOCK_STYLE_VERSION} -> ${target}`);
}
