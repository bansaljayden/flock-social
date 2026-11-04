/**
 * A FULL RUN OF THE SCREENSHOT RIG LEAVES WIRING.md ALONE (2026-11-04).
 *
 * public/screenshots/WIRING.md says what the shipped captures show and where
 * each one is used, and it was corrected by hand on 2026-11-03: the crowd
 * figures are Flock's estimates from typical patterns, not the crowd model's;
 * two of the names in the frames are real people's; the plates paint at about
 * 190 to 310 CSS px. But scripts/capture-screenshots.mjs rewrote that file on
 * every full run (no --out) from a template of its own, the swap plan from its
 * first run, so the next run would have put older, false text back. The
 * manifest.json beside it still said the friends were invented and the crowd
 * figures the model's.
 *
 * The rig now writes manifest.json alone, with a note that only points at
 * WIRING.md, and the committed manifest carries the same note and generator,
 * so a run changes neither file's words. This runs the rig's own writer,
 * lifted from its source, against a stand-in for fs that records each write.
 * FRONTEND test (jest via react-scripts).
 */
const fs = require('fs');
const path = require('path');

const FRONTEND = path.resolve(__dirname, '..', '..');
const SHOTS = path.join(FRONTEND, 'public', 'screenshots');
const MANIFEST = path.join(SHOTS, 'manifest.json');
const RIG = fs.readFileSync(path.join(FRONTEND, 'scripts', 'capture-screenshots.mjs'), 'utf8').replace(/\r\n/g, '\n');
const committedManifest = () => JSON.parse(fs.readFileSync(MANIFEST, 'utf8').replace(/^﻿/, ''));

// The rig's writeManifest exactly as written, handed public/screenshots as its
// output directory: it may read the committed manifest (it merges into it),
// and every write it makes is recorded here instead of reaching the disk.
function runWriteManifest(runCaptures) {
  const start = RIG.indexOf('function writeManifest(manifest) {');
  if (start < 0) throw new Error('no writeManifest in the rig');
  const src = RIG.slice(start, RIG.indexOf('\n}\n', start) + 2);
  const writes = [];
  const standIn = {
    readFileSync: (p, enc) => {
      if (path.resolve(p) !== MANIFEST) throw new Error(`unexpected read of ${p}`);
      return fs.readFileSync(p, enc);
    },
    writeFileSync: (p, data) => { writes.push({ file: path.relative(SHOTS, path.resolve(p)), data: String(data) }); },
  };
  const writeManifest = new Function('fs', 'path', 'OUT_DIR', 'log', `${src}\nreturn writeManifest;`)(standIn, path, SHOTS, () => {});
  writeManifest(runCaptures);
  return writes;
}

const RUN_CAPTURE = { file: 'screenshots/nest-dark@2x.png', screen: 'nest', title: 'Nest', mode: 'dark', set: 'web', width: 780, height: 1688, replaces: null };

test('a full run writes manifest.json and nothing else, so WIRING.md keeps the words it was given', () => {
  expect(runWriteManifest([RUN_CAPTURE]).map((w) => w.file)).toEqual(['manifest.json']);
  // The only writer: nothing else in the rig builds a path to WIRING.md, and
  // the old template is gone, not just unused.
  expect(RIG).not.toMatch(/path\.(?:join|resolve)\([^)]*WIRING/);
  expect(RIG).not.toContain('# Screenshot wiring plan');
  // A full run is the manifest and then the archive step, which moves
  // captures only; --out does neither.
  expect(RIG).toMatch(/if \(OUT_OVERRIDE\) \{\n[^\n]*\n\s+\} else \{\n\s+writeManifest\(manifest\);\n\s+archiveUnshipped\(\);\n\s+\}/);
  expect(RIG).toContain('if (!/\\.(png|webp)$/.test(f) || shipped.has(f)) continue;');
  expect(fs.existsSync(path.join(SHOTS, 'WIRING.md'))).toBe(true);
});

test('the manifest a run writes carries the committed note and generator: a pointer to WIRING.md, no claims of its own', () => {
  const committed = committedManifest();
  const [written] = runWriteManifest([RUN_CAPTURE]).map((w) => JSON.parse(w.data));
  expect(written.note).toBe(committed.note);
  expect(written.generator).toBe(committed.generator);
  expect(committed.note).toContain('WIRING.md');
  // What the frames show is WIRING.md's to say: the note says none of it.
  expect(committed.note).not.toMatch(/crowd|model|invent|made up|real|Google|Philadelphia|Copper Finch|friends/i);
  expect(committed.generator).not.toMatch(/real-venue/);
  // The run merges into the committed entries rather than replacing them.
  const files = written.captures.map((c) => c.file);
  for (const c of committed.captures) expect(files).toContain(c.file);
  expect(files).toContain(RUN_CAPTURE.file);
});
