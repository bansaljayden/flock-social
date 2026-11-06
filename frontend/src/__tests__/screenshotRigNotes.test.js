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

// One of the rig's functions, exactly as written, lifted from its source.
function lift(signature) {
  const start = RIG.indexOf(`function ${signature} {`);
  if (start < 0) throw new Error(`no ${signature} in the rig`);
  return RIG.slice(start, RIG.indexOf('\n}\n', start) + 2);
}

// The rig's writeManifest, handed public/screenshots as its output directory:
// it may read the committed manifest (it merges into it), and every write it
// makes is recorded here instead of reaching the disk. The folder it checks
// for files left is public/screenshots as it is plus what this run wrote, with
// nothing archived.
function runWriteManifest(runCaptures) {
  const src = lift('writeManifest(manifest)');
  const writes = [];
  const onDisk = new Set([...fs.readdirSync(SHOTS), ...runCaptures.map((c) => path.basename(c.file))]);
  const standIn = {
    readFileSync: (p, enc) => {
      if (path.resolve(p) !== MANIFEST) throw new Error(`unexpected read of ${p}`);
      return fs.readFileSync(p, enc);
    },
    existsSync: (p) => {
      if (path.dirname(path.resolve(p)) !== SHOTS) throw new Error(`unexpected look at ${p}`);
      return onDisk.has(path.basename(p));
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
  // A full run is the archive step, which moves captures only, and then the
  // manifest (the last test below); --out does neither.
  expect(RIG).toMatch(/if \(OUT_OVERRIDE\) \{\n[^\n]*\n\s+\} else \{\n\s+finishInPublic\(manifest\);\n\s+\}/);
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

test('after a full run the manifest names what public/ still holds, not the captures the archive step moved out', () => {
  // The rig's last step, with the archive step and the manifest writer it
  // calls, run against a stand-in for public/screenshots: the committed files,
  // plus what this run wrote. Two of the run's captures are a fresh take of a
  // shipped frame; two are referenced nowhere, so the archive step moves them.
  const src = ['archiveUnshipped()', 'writeManifest(manifest)', 'finishInPublic(manifest)'].map(lift).join('\n');
  const committed = committedManifest();
  const archive = path.join(FRONTEND, 'screenshots');
  const run = [
    { ...RUN_CAPTURE, file: 'screenshots/nest-dark-v2@2x.png' },
    { ...RUN_CAPTURE, file: 'screenshots/nest-dark-v2@2x.webp' },
    RUN_CAPTURE,
    { ...RUN_CAPTURE, file: 'screenshots/nest-dark@2x.webp' },
    { ...RUN_CAPTURE, file: 'store-assets/nest-dark-6.9in.png', set: 'appstore-6.9' },
  ];
  const shipped = new Set(fs.readdirSync(SHOTS).filter((f) => /\.(png|webp)$/.test(f)));
  const folder = new Set([...fs.readdirSync(SHOTS), 'nest-dark@2x.png', 'nest-dark@2x.webp']);
  const moved = [];
  let written = null;
  const inShots = (p) => {
    if (path.dirname(path.resolve(p)) !== SHOTS) throw new Error(`unexpected path ${p}`);
    return path.basename(p);
  };
  const standIn = {
    mkdirSync: (p) => { if (path.resolve(p) !== archive) throw new Error(`unexpected mkdir ${p}`); },
    readdirSync: (p) => {
      if (path.resolve(p) !== SHOTS) throw new Error(`unexpected listing of ${p}`);
      return [...folder];
    },
    renameSync: (from, to) => {
      if (written) throw new Error('a capture was moved after the manifest was written');
      if (path.dirname(path.resolve(to)) !== archive) throw new Error(`unexpected move to ${to}`);
      folder.delete(inShots(from));
      moved.push(path.basename(to));
    },
    existsSync: (p) => folder.has(inShots(p)),
    readFileSync: (p, enc) => {
      if (path.resolve(p) !== MANIFEST) throw new Error(`unexpected read of ${p}`);
      return fs.readFileSync(p, enc);
    },
    writeFileSync: (p, data) => {
      if (inShots(p) !== 'manifest.json') throw new Error(`unexpected write of ${p}`);
      written = JSON.parse(String(data));
    },
  };
  const finish = new Function('fs', 'path', 'OUT_DIR', 'FRONTEND_DIR', 'log', 'shippedCaptures', `${src}\nreturn finishInPublic;`)(
    standIn, path, SHOTS, FRONTEND, () => {}, () => shipped,
  );
  finish(run);

  expect(moved.sort()).toEqual(['nest-dark@2x.png', 'nest-dark@2x.webp']);
  const files = written.captures.map((c) => c.file);
  expect(files).not.toContain('screenshots/nest-dark@2x.png');
  expect(files).not.toContain('screenshots/nest-dark@2x.webp');
  // Every web entry names a file that is there.
  for (const f of files.filter((x) => x.startsWith('screenshots/'))) expect(folder.has(f.slice('screenshots/'.length))).toBe(true);
  // The committed entries stay, the fresh take of a shipped frame is the
  // run's entry now, and the App Store set, outside public/, is kept.
  for (const c of committed.captures) expect(files).toContain(c.file);
  expect(written.captures.find((c) => c.file === 'screenshots/nest-dark-v2@2x.png').set).toBe('web');
  expect(files).toContain('store-assets/nest-dark-6.9in.png');
});
