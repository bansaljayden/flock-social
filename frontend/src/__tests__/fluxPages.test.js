/**
 * /flux and /ai: what they say, what they show, and the slider that builds
 * the Flux case.
 *
 *   1. THE SLIDER. One number places every part (website/flux/fluxData.js).
 *      Its first stop has to be the exploded layout the labelled render was
 *      made from, its last the finished box on its stand, and every stop
 *      needs the render the bar shows where the 3D does not run.
 *   2. THE FILES. Each picture is written at two widths (scripts/
 *      flux_assets.py, and the pitch figures by hand); every srcset width is
 *      checked against the file's own header, AVIF and WebP both. The model
 *      is gzipped GLB, and the button that loads it states its size.
 *   3. THE COPY. Flux is a prototype, its door counter has never been read,
 *      Owl has not run in a venue, and neither page quotes an accuracy
 *      figure (those live on /research, with their limits). The sensor work
 *      asked for no battery life, no working 4G, no decibels and nothing that
 *      reads as surveillance; the site's legal wording asks for no "not a
 *      camera" and no "no tracking".
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test --watchAll=false fluxPages
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

const FRONTEND = path.join(__dirname, '..', '..');
const PUBLIC = path.join(FRONTEND, 'public');
const WEBSITE = path.join(__dirname, '..', 'website');

const data = require('../website/flux/fluxData');
const { MODEL_URL, MODEL_MB } = require('../website/flux/fluxModel');
const { IMAGES } = require('../website/FluxPage');
const { FIGURES } = require('../website/AiPage');

function webpWidth(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WEBP') throw new Error('not WebP');
  const fourcc = buf.toString('ascii', 12, 16);
  if (fourcc === 'VP8X') return (buf[24] | (buf[25] << 8) | (buf[26] << 16)) + 1;
  if (fourcc === 'VP8 ') return ((buf[27] << 8) | buf[26]) & 0x3fff;
  if (fourcc === 'VP8L') return 1 + (((buf[22] & 0x3f) << 8) | buf[21]);
  throw new Error(`unexpected WebP container ${fourcc}`);
}

// AVIF is an ISO-BMFF file; the image's size is in its 'ispe' property box.
function avifWidth(buf) {
  if (buf.toString('ascii', 4, 8) !== 'ftyp') throw new Error('not AVIF');
  const at = buf.indexOf('ispe');
  if (at < 0) throw new Error('no ispe box');
  return buf.readUInt32BE(at + 8);
}

function checkPair(base, one, two) {
  const out = [];
  for (const [suffix, width] of [['', one], ['@2x', two]]) {
    for (const [ext, read] of [['webp', webpWidth], ['avif', avifWidth]]) {
      const rel = `${base}${suffix}.${ext}`;
      const file = path.join(PUBLIC, rel);
      if (!fs.existsSync(file)) { out.push(`${rel} missing`); continue; }
      const got = read(fs.readFileSync(file));
      if (got !== width) out.push(`${rel} is ${got}w, page says ${width}w`);
    }
  }
  return out;
}

// What reaches a reader: the server render's text and every alt.
function readerText(Page) {
  const html = renderToStaticMarkup(React.createElement(Page));
  const alts = [...html.matchAll(/alt="([^"]*)"/g)].map((m) => m[1]);
  const text = html.replace(/<[^>]+>/g, ' ');
  return `${text} ${alts.join(' ')}`.replace(/&#x27;|&#39;/g, '’').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
}

describe('the slider builds the case from the exploded layout to the stand', () => {
  const names = Object.keys(data.LOOK);

  test('stop 0 is the exploded render: every listed part at its offset, the inserts hidden', () => {
    for (const name of names) {
      const { offset, visible } = data.partAt(name, 0);
      if (name.startsWith('Stand')) {
        expect([name, visible]).toEqual([name, false]);
        continue;
      }
      expect([name, offset]).toEqual([name, data.EXPLODED[name] || [0, 0, 0]]);
      expect([name, visible]).toEqual([name, name !== 'Brass M3 inserts (8)']);
    }
    expect(data.poseAt(0)).toEqual({ tilt: 0, lift: 0 });
  });

  test('the last stop is the finished box: everything in place, leaning 12 degrees on its stand', () => {
    for (const name of names) {
      expect([name, data.partAt(name, data.LAST)]).toEqual([name, { visible: true, offset: [0, 0, 0] }]);
    }
    for (const cable of ['Cable: battery to PD board', 'Cable: back USB port to Pi USB', 'Cable: LINK light']) {
      expect(data.partAt(cable, data.LAST)).toEqual({ visible: true, offset: [0, 0, 0] });
    }
    expect(data.poseAt(data.LAST)).toEqual({ tilt: 12, lift: 20.46 });
  });

  test('every part moves continuously: no jump bigger than a few millimetres between close positions', () => {
    for (const name of names) {
      let last = data.partAt(name, 0).offset;
      for (let u = 0.01; u <= data.LAST + 1e-9; u += 0.01) {
        const { offset } = data.partAt(name, u);
        const jump = Math.hypot(offset[0] - last[0], offset[1] - last[1], offset[2] - last[2]);
        expect(jump).toBeLessThan(6);
        last = offset;
      }
    }
  });

  test('each step names itself, and the mark on its parts is zero at every stop', () => {
    expect(data.STEPS).toHaveLength(8);
    expect(data.stepAt(0)).toBe(0);
    expect(data.stepAt(0.4)).toBe(1);
    expect(data.stepAt(1)).toBe(1);
    expect(data.stepAt(6.5)).toBe(7);
    expect(data.stepAt(data.LAST)).toBe(data.LAST);
    for (let k = 0; k <= data.LAST; k += 1) {
      for (const name of names) expect(data.markAt(name, k)).toBe(0);
    }
    expect(data.markAt('7 inch touchscreen', 1.5)).toBeCloseTo(1);
    expect(data.markAt('7 inch touchscreen', 3.5)).toBe(0);
  });

  test('the camera starts at the exploded render\'s angle and ends at the finished box\'s', () => {
    const near = (got, want) => {
      got.dir.forEach((v, i) => expect(v).toBeCloseTo(want.dir[i], 9));
      expect(got.fov).toBeCloseTo(want.fov, 9);
      expect(got.zoom).toBeCloseTo(want.zoom, 9);
    };
    // The repo viewer's "Exploded" and "Assembled" views.
    near(data.viewAt(0), { dir: [1.0, -0.42, 0.42], fov: 26, zoom: 0.9 });
    near(data.viewAt(data.LAST), { dir: [0.62, -1.0, 0.42], fov: 32, zoom: 1 });
  });

  test('every stop has its render, at the widths the viewer asks for', () => {
    expect(data.STEPS[0].still).toBe('flux-exploded');
    expect(data.STEPS[data.LAST].still).toBe('flux-assembled');
    const problems = data.STEPS.flatMap((s) => (s.still === 'flux-exploded'
      ? checkPair(`/sensor/${s.still}`, 1100, 2200)
      : checkPair(`/sensor/${s.still}`, 700, 1400)));
    expect(problems).toEqual([]);
  });
});

describe('the files the pages name', () => {
  test('every picture on /flux and /ai exists at the widths its srcset claims', () => {
    const problems = [...Object.values(IMAGES), ...Object.values(FIGURES)]
      .flatMap((img) => checkPair(img.base, img.one, img.two));
    expect(problems).toEqual([]);
  });

  test('the model is gzipped GLB holding every part the slider places, and none of the wall', () => {
    const file = path.join(PUBLIC, MODEL_URL);
    const gz = fs.readFileSync(file);
    expect([gz[0], gz[1]]).toEqual([0x1f, 0x8b]);
    const glb = zlib.gunzipSync(gz);
    expect(glb.toString('ascii', 0, 4)).toBe('glTF');
    expect(glb.readUInt32LE(4)).toBe(2);
    const json = JSON.parse(glb.toString('utf8', 20, 20 + glb.readUInt32LE(12)));
    const nodes = json.nodes.map((n) => n.name);
    for (const name of Object.keys(data.LOOK)) expect(nodes).toContain(name);
    expect(nodes.filter((n) => /CAMVATE|Arm screw|Wall/.test(n))).toEqual([]);
    // Decoded without WebAssembly: the site's CSP has no 'wasm-unsafe-eval'.
    expect(json.extensionsUsed || []).not.toContain('KHR_draco_mesh_compression');
    expect(json.extensionsUsed || []).not.toContain('EXT_meshopt_compression');
    // The button that loads it on Save-Data says what it costs.
    expect(`${(gz.length / 1048576).toFixed(1)} MB`).toBe(MODEL_MB);
  });

  test('no folder is named like a page, which would shadow the route on a static host', () => {
    for (const route of ['flux', 'ai']) expect(fs.existsSync(path.join(PUBLIC, route))).toBe(false);
  });

  // three.js is about 150 KB gzipped. One static import anywhere else would put
  // it on the path of every page, with nothing looking any different.
  test('three is imported by the viewer\'s scene alone, and the viewer loads that on demand', () => {
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) return e.name === '__tests__' ? [] : walk(full);
      return /\.(js|jsx)$/.test(e.name) ? [full] : [];
    });
    const importsThree = /(?:from|import|require)\s*\(?\s*['"]three(?:\/[^'"]*)?['"]/;
    const users = walk(path.join(__dirname, '..'))
      .filter((f) => importsThree.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(path.join(__dirname, '..'), f));
    expect(users).toEqual([path.join('website', 'flux', 'fluxScene.js')]);
    const viewer = fs.readFileSync(path.join(WEBSITE, 'flux', 'FluxViewer.js'), 'utf8');
    expect(viewer).toMatch(/import\(\s*\/\* webpackChunkName: "flux-scene" \*\/\s*'\.\/fluxScene'\s*\)/);
    expect(viewer).not.toMatch(/^import[^;]*['"]\.\/fluxScene['"]/m);
    expect(fs.readFileSync(path.join(WEBSITE, 'FluxPage.js'), 'utf8')).not.toMatch(/fluxScene|['"]three['"]/);
  });
});

describe('what the two pages say', () => {
  const FluxPage = require('../website/FluxPage').default;
  const AiPage = require('../website/AiPage').default;
  const flux = readerText(FluxPage);
  const ai = readerText(AiPage);

  test('Flux is a prototype, and says what is not done', () => {
    expect(flux).toContain('It’s a prototype.');
    expect(flux).toContain('hasn’t been printed yet');
    expect(flux).toContain('It hasn’t been wired up yet.');
    expect(flux).toContain('It hasn’t run in a venue yet.');
    expect(ai).toContain('It hasn’t run in a venue yet.');
    expect(flux).toContain('A mockup of the planned build');
    expect(flux).toContain('This frame is generated, not a picture of real people.');
  });

  test('no accuracy figure, no decibels, no battery life, no working cellular link', () => {
    for (const [name, text] of [['flux', flux], ['ai', ai]]) {
      expect(`${name}: ${(text.match(/\d+(\.\d+)?\s?%/) || [''])[0]}`).toBe(`${name}: `);
      expect(text).not.toMatch(/decibel|\bdB\b/i);
      expect(text).not.toMatch(/battery life|on (a|one) charge|hours? of battery/i);
      expect(text).not.toMatch(/\b(cellular|LTE|mobile data)\b/i);
      expect(text).not.toMatch(/4G (works|connects|sends|link)/i);
    }
  });

  test('none of the wording the records rule out', () => {
    for (const text of [flux, ai]) {
      expect(text).not.toMatch(/not a camera|no tracking|facial|face recognition|identif(y|ies) (people|faces)|fever/i);
      expect(text).not.toMatch(/surveil|watch(es)? (people|customers|guests)/i);
      expect(text).not.toMatch(/\b(installed|deployed) (in|at) /i);
      expect(text).not.toMatch(/—/);
    }
  });

  test('the "106 inputs" and "runs on the sensor" lines stay out of the copy too', () => {
    for (const text of [flux, ai]) {
      expect(text).not.toMatch(/\b106\b/);
      expect(text).not.toMatch(/runs on the (sensor|Pi|Raspberry)/i);
    }
  });

  test('no two neighbouring sections share a background', () => {
    const bands = (src) => [...src.matchAll(/<section className="([^"]+)"/g)].map(([, cls]) => {
      if (/\b(lp-sec-navy|lp-cta)\b/.test(cls)) return 'navy';
      if (/\blp-sec-sand\b/.test(cls)) return 'sand';
      if (/\blp-sec-paper\b/.test(cls)) return 'paper';
      return `unknown:${cls}`;
    });
    for (const file of ['FluxPage.js', 'AiPage.js']) {
      const seq = bands(fs.readFileSync(path.join(WEBSITE, file), 'utf8'));
      expect(seq.length).toBeGreaterThan(4);
      expect(seq.filter((b) => b.startsWith('unknown'))).toEqual([]);
      for (let i = 1; i < seq.length; i += 1) {
        expect(`${file} ${i}: ${seq[i - 1]} -> ${seq[i]}`).not.toMatch(/: (\w+) -> \1$/);
      }
    }
  });

  test('the page stylesheets keep to the token block and move nothing but opacity and colour', () => {
    for (const file of ['FluxPage.css', 'AiPage.css']) {
      const css = fs.readFileSync(path.join(WEBSITE, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      const tokens = /\.fx \{[\s\S]*?\}/.exec(css);
      const rest = tokens ? css.replace(tokens[0], '') : css;
      expect(`${file}: ${(rest.match(/#[0-9a-fA-F]{3,8}\b/g) || []).join(' ')}`).toBe(`${file}: `);
      for (const t of css.match(/transition:[^;]+;/g) || []) {
        expect(t).not.toMatch(/\b(width|height|top|left|right|bottom|margin|padding|all)\b/);
      }
      expect(css).not.toMatch(/box-shadow|gradient\(/);
      const tracks = css.match(/grid-template-columns:([^;]+);/g) || [];
      const bare = tracks.filter((t) => /(^|[\s:])1fr\b/.test(t.replace(/minmax\([^()]*(\([^()]*\))?[^()]*\)/g, 'M')));
      expect(bare).toEqual([]);
    }
  });
});
