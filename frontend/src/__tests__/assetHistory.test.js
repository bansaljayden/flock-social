/**
 * scripts/asset-history.js keeps the hashed files of earlier builds on the
 * site, so a tab that was open across a deploy can still load the screens it
 * had not opened yet. These run the deploy itself (publish in
 * scripts/deploy-cloudflare.js) in folders of their own, with a stand-in for
 * the build and for the upload.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const history = require('../../scripts/asset-history');
const { publish, WRANGLER } = require('../../scripts/deploy-cloudflare');

const DAY_MS = 24 * 60 * 60 * 1000;
const day = (n) => new Date(Date.UTC(2026, 10, 1) + n * DAY_MS);

// Three builds of one app. B renames the main bundle and one chunk, C renames
// the main bundle again, and the rest never changes.
const SHARED = {
  'static/js/202.22222222.chunk.js': 'chunk 202',
  'static/css/main.cccccccc.css': 'styles',
  'static/media/Fraunces-var.252d721d4b7469f6889f.woff2': 'font',
};
const BUILD_A = {
  'index.html': 'page A',
  'asset-manifest.json': 'manifest A',
  'static/js/main.aaaaaaaa.js': 'main A',
  'static/js/main.aaaaaaaa.js.map': 'map A',
  'static/js/main.aaaaaaaa.js.LICENSE.txt': 'licence A',
  'static/js/101.11111111.chunk.js': 'chunk 101 A',
  ...SHARED,
};
const BUILD_B = {
  'index.html': 'page B',
  'asset-manifest.json': 'manifest B',
  'static/js/main.bbbbbbbb.js': 'main B',
  'static/js/main.bbbbbbbb.js.LICENSE.txt': 'licence B',
  'static/js/101.33333333.chunk.js': 'chunk 101 B',
  ...SHARED,
};
const BUILD_C = {
  'index.html': 'page C',
  'asset-manifest.json': 'manifest C',
  'static/js/main.dddddddd.js': 'main C',
  'static/js/101.33333333.chunk.js': 'chunk 101 B',
  ...SHARED,
};
// What a later build no longer has.
const ONLY_A = { 'static/js/main.aaaaaaaa.js': 'main A', 'static/js/101.11111111.chunk.js': 'chunk 101 A' };
const ONLY_B = { 'static/js/main.bbbbbbbb.js': 'main B' };
const hashedNames = (files) => Object.keys(files).filter((name) => history.isHistoryName(name)).sort();

let root;
let out;
let historyDir;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'asset-history-'));
  out = path.join(root, 'site', 'build');
  historyDir = path.join(root, 'site', '.asset-history');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
});

function write(dir, files) {
  for (const [name, text] of Object.entries(files)) {
    const file = path.join(dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
}

// Every file under `dir`, by its path from it, with its text.
function read(dir, rel = '', found = {}) {
  if (!fs.existsSync(path.join(dir, rel))) return found;
  for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const next = rel ? rel + '/' + entry.name : entry.name;
    if (entry.isDirectory()) read(dir, next, found);
    else found[next] = fs.readFileSync(path.join(dir, next), 'utf8');
  }
  return found;
}

// One deploy. The build empties the output folder and writes `files`, as
// react-scripts does; the upload is a record of what the folder held then.
function deploy(files, when, { fail = false, atUpload = () => {}, ...options } = {}) {
  const calls = [];
  const lines = [];
  const result = { uploaded: null, calls, lines };
  const start = (command, args, env) => {
    calls.push({ command, args, env });
    if (command === 'node') {
      fs.rmSync(out, { recursive: true, force: true });
      write(out, files);
    } else {
      if (fail) throw new Error('npx exited 1');
      result.uploaded = read(out);
      atUpload();
    }
  };
  publish({ teamId: 'TEAM123456', out, historyDir, now: when, start, log: (line) => lines.push(line), ...options });
  return result;
}

describe('which files are kept', () => {
  test('a name the build made from the file\'s bytes, and never a source map or a licence text', () => {
    for (const name of [
      'main.a7f2e0c7.js', '9665.98e29dad.chunk.js', 'landing.0f3b9c1d.chunk.css', 'main.0f3b9c1d.css',
      'paint-first.1a2b3c4d.js', 'Fraunces-var.252d721d4b7469f6889f.woff2', 'hero.6ce24c58023cc2f8fd88fe9d219db6c6.PNG',
    ]) {
      expect(`${name}: ${history.isCarriable(name)}`).toBe(`${name}: true`);
    }
    for (const name of [
      'main.a7f2e0c7.js.map', 'main.a7f2e0c7.css.map', 'main.a7f2e0c7.js.LICENSE.txt', 'index.html',
      'asset-manifest.json', 'logo.png', 'main.js', 'main.a7f2.js', 'main.a7f2e0c7.js.tmp', 'main.a7f2e0c7.map',
    ]) {
      expect(`${name}: ${history.isCarriable(name)}`).toBe(`${name}: false`);
    }
  });

  test('only under static/, by a path that stays inside it', () => {
    expect(history.isHistoryName('static/js/main.a7f2e0c7.js')).toBe(true);
    expect(history.isHistoryName('static/media/fonts/Fraunces-var.252d721d4b7469f6889f.woff2')).toBe(true);
    for (const name of [
      'js/main.a7f2e0c7.js', '/static/js/main.a7f2e0c7.js', 'static/../../main.a7f2e0c7.js', '../static/js/main.a7f2e0c7.js',
      'static/./main.a7f2e0c7.js', 'static//main.a7f2e0c7.js', 'static\\js\\main.a7f2e0c7.js', 'static/js/main.js', 7, null,
    ]) {
      expect(`${name}: ${history.isHistoryName(name)}`).toBe(`${name}: false`);
    }
  });

  test('the folder of copies is never committed', () => {
    const ignored = fs.readFileSync(path.join(__dirname, '..', '..', '.gitignore'), 'utf8').split(/\r?\n/);
    expect(ignored).toContain('/.asset-history/');
  });
});

describe('a deploy keeps the earlier builds\' hashed files on the site', () => {
  test('the first one uploads the build alone, with the commands the deploy always ran', () => {
    const { uploaded, calls, lines } = deploy(BUILD_A, day(0));
    expect(uploaded).toEqual(BUILD_A);
    expect(calls.map((call) => [call.command, ...call.args].join(' '))).toEqual([
      'node scripts/build-cloudflare.js',
      'npx -y ' + WRANGLER + ' pages deploy build --project-name flockcorp --branch main',
    ]);
    expect(calls[0].env).toMatchObject({ CF_PAGES: '1', APPLE_TEAM_ID: 'TEAM123456' });
    expect(lines).toEqual(['deploy:cloudflare: 0 hashed files of earlier builds stay on the site beside this build\'s 5']);
    // What it remembers: the hashed files, and that this build is the live one.
    expect(Object.keys(read(path.join(historyDir, 'files'))).sort()).toEqual(hashedNames(BUILD_A));
    expect(history.readIndex(historyDir).live).toEqual(hashedNames(BUILD_A));
  });

  test('the next one uploads the files the new build no longer has beside it, and leaves build/ as the build', () => {
    deploy(BUILD_A, day(0));
    const { uploaded, lines } = deploy(BUILD_B, day(1));
    // Not the old page, manifest, source map or licence text.
    expect(uploaded).toEqual({ ...BUILD_B, ...ONLY_A });
    expect(lines).toEqual(['deploy:cloudflare: 2 hashed files of earlier builds stay on the site beside this build\'s 5']);
    expect(read(out)).toEqual(BUILD_B);
    expect(history.readIndex(historyDir).live).toEqual(hashedNames(BUILD_B));
  });

  test('a build that was in build/ before this had ever run is taken for the live one', () => {
    write(out, BUILD_A);
    expect(deploy(BUILD_B, day(0)).uploaded).toEqual({ ...BUILD_B, ...ONLY_A });
  });

  test('a file stays KEEP_DAYS from the day its build was replaced, however long that build was live', () => {
    deploy(BUILD_A, day(0));
    expect(deploy(BUILD_B, day(60)).uploaded).toEqual({ ...BUILD_B, ...ONLY_A });
    // A was replaced on day 60.
    expect(deploy(BUILD_C, day(60 + history.KEEP_DAYS)).uploaded).toEqual({ ...BUILD_C, ...ONLY_A, ...ONLY_B });
    expect(deploy(BUILD_C, day(61 + history.KEEP_DAYS)).uploaded).toEqual({ ...BUILD_C, ...ONLY_B });
    // Past its days, the copy goes too.
    expect(Object.keys(read(path.join(historyDir, 'files'))).sort()).toEqual([...hashedNames(BUILD_C), ...Object.keys(ONLY_B)].sort());
  });

  test('a deploy with no change of code keeps every name and carries what the last one carried', () => {
    deploy(BUILD_A, day(0));
    deploy(BUILD_B, day(1));
    expect(deploy(BUILD_B, day(2)).uploaded).toEqual({ ...BUILD_B, ...ONLY_A });
  });

  test('an upload that fails leaves build/ as the build and the live build as it was', () => {
    deploy(BUILD_A, day(0));
    expect(() => deploy(BUILD_B, day(10), { fail: true })).toThrow('npx exited 1');
    expect(read(out)).toEqual(BUILD_B);
    expect(history.readIndex(historyDir).live).toEqual(hashedNames(BUILD_A));
    // A is what tabs were running until day 35. B never reached the site, so
    // its days run from the attempt.
    expect(deploy(BUILD_C, day(35)).uploaded).toEqual({ ...BUILD_C, ...ONLY_A, ...ONLY_B });
    expect(deploy(BUILD_C, day(45)).uploaded).toEqual({ ...BUILD_C, ...ONLY_A });
  });

  test('--skip-build uploads the build that is there, with the earlier files beside it', () => {
    deploy(BUILD_A, day(0));
    deploy(BUILD_B, day(1));
    fs.rmSync(out, { recursive: true, force: true });
    write(out, BUILD_C);
    const { uploaded, calls } = deploy(null, day(2), { skipBuild: true });
    expect(calls.map((call) => call.command)).toEqual(['npx']);
    expect(uploaded).toEqual({ ...BUILD_C, ...ONLY_A, ...ONLY_B });
    expect(read(out)).toEqual(BUILD_C);
  });

  test('past the cap, the files that were live most recently are the ones kept', () => {
    deploy(BUILD_A, day(0));
    deploy(BUILD_B, day(1));
    history.noteLive(out, historyDir, day(2));
    fs.rmSync(out, { recursive: true, force: true });
    write(out, BUILD_C);
    const { current, carried } = history.carryForward(out, historyDir, day(2), { maxFiles: 1 });
    expect(current).toEqual(hashedNames(BUILD_C));
    expect(carried).toEqual(Object.keys(ONLY_B));
    expect(Object.keys(read(path.join(historyDir, 'files'))).sort()).toEqual([...hashedNames(BUILD_C), ...Object.keys(ONLY_B)].sort());
  });
});

describe('taking a file off the site', () => {
  test('--drop-old uploads the build alone and starts again from it', () => {
    deploy(BUILD_A, day(0));
    const dropped = deploy(BUILD_B, day(1), { dropOld: true });
    expect(dropped.uploaded).toEqual(BUILD_B);
    expect(dropped.lines).toEqual(['deploy:cloudflare: 0 hashed files of earlier builds stay on the site beside this build\'s 5']);
    expect(deploy(BUILD_C, day(2)).uploaded).toEqual({ ...BUILD_C, ...ONLY_B });
  });

  test('a file deleted from the history is not uploaded again', () => {
    deploy(BUILD_A, day(0));
    deploy(BUILD_B, day(1));
    fs.rmSync(path.join(historyDir, 'files', 'static', 'js', 'main.aaaaaaaa.js'));
    expect(deploy(BUILD_C, day(2)).uploaded).toEqual({ ...BUILD_C, ...ONLY_B, 'static/js/101.11111111.chunk.js': 'chunk 101 A' });
    expect(Object.keys(history.readIndex(historyDir).seen)).not.toContain('static/js/main.aaaaaaaa.js');
  });

  test('deleting the whole history still keeps the build that is in build/, as the script\'s header warns', () => {
    deploy(BUILD_A, day(0));
    deploy(BUILD_B, day(1));
    fs.rmSync(historyDir, { recursive: true, force: true });
    expect(deploy(BUILD_C, day(2)).uploaded).toEqual({ ...BUILD_C, ...ONLY_B });
  });
});

describe('the record on disk is read as input', () => {
  test('a name that points outside static/ is neither copied nor deleted', () => {
    deploy(BUILD_A, day(0));
    // Where a join from files/ and a join from build/ would each land.
    const bait = path.join(root, 'site', 'outside.12345678.js');
    const target = path.join(root, 'outside.12345678.js');
    fs.writeFileSync(bait, 'left alone');
    const file = path.join(historyDir, 'index.json');
    const index = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const name of ['../../outside.12345678.js', 'static/../../../outside.12345678.js']) {
      index.live.push(name);
      index.seen[name] = day(0).toISOString();
    }
    index.seen['static/js/main.eeeeeeee.js'] = 'no date';
    fs.writeFileSync(file, JSON.stringify(index));

    let copiedOut = null;
    const { uploaded, lines } = deploy(BUILD_B, day(1), { atUpload: () => { copiedOut = fs.existsSync(target); } });
    expect(uploaded).toEqual({ ...BUILD_B, ...ONLY_A });
    expect(lines).toEqual(['deploy:cloudflare: 2 hashed files of earlier builds stay on the site beside this build\'s 5']);
    expect(copiedOut).toBe(false);
    expect(fs.readFileSync(bait, 'utf8')).toBe('left alone');
    const after = history.readIndex(historyDir);
    expect(Object.keys(after.seen).sort()).toEqual([...hashedNames(BUILD_B), ...Object.keys(ONLY_A)].sort());
    expect(after.live).toEqual(hashedNames(BUILD_B));
  });

  test('a record that cannot be read starts again from the build in build/', () => {
    deploy(BUILD_A, day(0));
    fs.writeFileSync(path.join(historyDir, 'index.json'), '{"live": [');
    expect(deploy(BUILD_B, day(1)).uploaded).toEqual({ ...BUILD_B, ...ONLY_A });
  });

  test('a copy that was cut short is replaced, and one left half-written is cleared', () => {
    deploy(BUILD_A, day(0));
    const kept = path.join(historyDir, 'files', 'static', 'js');
    fs.writeFileSync(path.join(kept, 'main.aaaaaaaa.js'), 'mai');
    fs.writeFileSync(path.join(kept, '101.11111111.chunk.js.tmp'), 'chu');
    // build/ still holds A, so the same build goes up again and its copy is made whole.
    deploy(null, day(1), { skipBuild: true });
    expect(deploy(BUILD_B, day(2)).uploaded).toEqual({ ...BUILD_B, ...ONLY_A });
    expect(fs.existsSync(path.join(kept, '101.11111111.chunk.js.tmp'))).toBe(false);
  });
});

describe('putting build/ back', () => {
  test('a file that will not go is reported, and one already gone is not an error', () => {
    write(out, BUILD_B);
    fs.mkdirSync(path.join(out, 'static', 'js', 'main.aaaaaaaa.js'));
    write(out, { 'static/js/101.11111111.chunk.js': 'chunk 101 A' });
    const left = history.dropCarried(out, ['static/js/main.aaaaaaaa.js', 'static/js/101.11111111.chunk.js', 'static/js/gone.12345678.js']);
    expect(left).toEqual(['static/js/main.aaaaaaaa.js']);
    expect(fs.existsSync(path.join(out, 'static', 'js', '101.11111111.chunk.js'))).toBe(false);
  });
});
