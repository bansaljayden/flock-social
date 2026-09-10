/**
 * public/screenshots/ ships inside the web build and the 20 MB iPhone bundle,
 * so it carries only the captures something actually references: the two
 * the landing page shows, the four the PWA manifest lists, and the rig's own
 * manifest.json and WIRING.md. The rest of the capture set (every screen in
 * both themes, PNG and WebP) is kept at frontend/screenshots/, tracked but
 * not shipped; the rig moves its own output there after a run.
 *
 * Before this, 34 unreferenced files (7.96 MB) rode along in every IPA.
 */
const fs = require('fs');
const path = require('path');

const FRONTEND = path.resolve(__dirname, '..', '..');
const PUBLIC = path.join(FRONTEND, 'public');
const SHOTS = path.join(PUBLIC, 'screenshots');
const ARCHIVE = path.join(FRONTEND, 'screenshots');

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '__tests__') continue;
      out.push(...walk(p));
    } else if (/\.(js|jsx|css|html)$/.test(e.name)) {
      out.push(p);
    }
  }
  return out;
}

// The same rule the rig applies: a capture ships if source, the PWA manifest
// or index.html names it.
function shippedCaptures() {
  const names = new Set();
  for (const f of [...walk(path.join(FRONTEND, 'src')), path.join(PUBLIC, 'index.html')]) {
    const text = fs.readFileSync(f, 'utf8');
    for (const m of text.matchAll(/\/screenshots\/([A-Za-z0-9@._-]+\.(?:png|webp))/g)) names.add(m[1]);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'manifest.json'), 'utf8').replace(/^﻿/, ''));
  for (const s of manifest.screenshots || []) {
    const m = String(s.src).match(/screenshots\/([A-Za-z0-9@._-]+)/);
    if (m) names.add(m[1]);
  }
  return names;
}

const KEPT = new Set(['manifest.json', 'WIRING.md']);

test('public/screenshots holds only captures that something references', () => {
  const shipped = shippedCaptures();
  expect(shipped.size).toBeGreaterThanOrEqual(6);
  const present = fs.readdirSync(SHOTS).filter((n) => !KEPT.has(n));
  const stray = present.filter((n) => !shipped.has(n));
  expect(stray).toEqual([]);
});

test('every referenced capture exists where it is referenced', () => {
  for (const name of shippedCaptures()) {
    expect(fs.existsSync(path.join(SHOTS, name))).toBe(true);
  }
});

test('the archive holds the rest of the set and nothing that ships', () => {
  expect(fs.existsSync(ARCHIVE)).toBe(true);
  const shipped = shippedCaptures();
  const archived = fs.readdirSync(ARCHIVE).filter((n) => /\.(png|webp)$/.test(n));
  expect(archived.length).toBeGreaterThan(0);
  expect(archived.filter((n) => shipped.has(n))).toEqual([]);
});
