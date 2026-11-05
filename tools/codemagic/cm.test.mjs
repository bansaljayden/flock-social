// tools/codemagic/cm.test.mjs
// Run: node --test tools/codemagic/cm.test.mjs
//
// Offline throughout: every Codemagic answer comes from FakeCodemagic below,
// handed to main() as its fetch, and wait runs on a fake clock. Covers argument
// parsing, the token file, the start plan (which must start nothing without
// --yes), wait's exit codes, and the artifact download sending the token to
// codemagic.io only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ENDED,
  EXIT,
  UsageError,
  YAML_PATH,
  defaultTokenPath,
  fileNames,
  fmtDuration,
  loadToken,
  main,
  parseArgs,
  parseTime,
  parseWorkflows,
  resolveWorkflow,
  sendsToken,
} from './cm.mjs';

const TOKEN = 'fake-test-token';
const APP = '00000000000000000000a001';
const APP2 = '00000000000000000000a002';
const TEAM = '00000000000000000000c001';
const B49 = '000000000000000000000b49';
const B50 = '000000000000000000000b50';
const B51 = '000000000000000000000b51';
const B52 = '000000000000000000000b52';
const B53 = '000000000000000000000b53';

const YAML = [
  '# a comment above',
  'workflows:',
  '  ios-capacitor:',
  '    name: Flock iOS (Capacitor)',
  '    instance_type: mac_mini_m2',
  '    scripts:',
  '      - name: Install web dependencies',
  '  # a comment inside the block',
  '  ios-review-recording:',
  '    name: "Flock iOS review recording (Simulator, unattended)"  # quoted',
  'other: 1',
  '  not-a-workflow:',
].join('\n');

// ---------------------------------------------------------------------------
// A fake Codemagic: the v3 routes this tool calls, in the schema's shapes.
// ---------------------------------------------------------------------------

const response = (status, body, { headers = {}, bytes } = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (k) => headers[String(k).toLowerCase()] ?? null },
  text: async () => (body === undefined ? '' : JSON.stringify(body)),
  arrayBuffer: async () => {
    const b = bytes || Buffer.alloc(0);
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  },
});

const ARTIFACTS = [
  { name: 'App.ipa', size_in_bytes: 11, type: 'ipa', short_lived_download_url: 'https://storage.example.test/a/App.ipa?sig=1', version_code: '53', version_name: '1.0.1' },
  { name: 'logs/xcodebuild.log', size_in_bytes: 5, type: 'log', short_lived_download_url: 'https://api.codemagic.io/artifacts/x/y/xcodebuild.log', version_code: null, version_name: null },
];
const BYTES = { '/a/App.ipa': Buffer.from('ipa-bytes!!'), '/artifacts/x/y/xcodebuild.log': Buffer.from('log!!') };

function build(over = {}) {
  return {
    id: B52,
    app_id: APP,
    index: 52,
    status: 'finished',
    workflow: { id: 'ios-capacitor', source: 'file', name: 'Flock iOS (Capacitor)' },
    instance_type: 'mac_mini_m2',
    labels: [],
    priority: 0,
    release_notes: [],
    remote_access_enabled: false,
    config: { xcode_version: '26.6', platforms: ['ios'] },
    branch: 'main',
    tag: null,
    commit: { hash: '24d1b1d8aaaabbbb', message: 'Fix the share sheet on iOS\n\nmore lines' },
    created_at: '2026-11-05T13:00:00Z',
    started_at: '2026-11-05T13:02:00Z',
    finished_at: '2026-11-05T13:49:12Z',
    app_store_connect_status: 'finished',
    artifacts: ARTIFACTS,
    ...over,
  };
}

const teamApp = (over = {}) => ({ id: APP, name: 'flock-app', last_build_id: B52, archived: false, repository: { url: 'git@github.com:example/flock.git' }, ...over });
const page = (data) => ({ data, page_size: 100, current_page: 1, total_pages: 1 });

class FakeCodemagic {
  constructor({
    personalApps = [],
    teams = [{ id: TEAM, name: 'Flock' }],
    teamApps = { [TEAM]: [teamApp()] },
    builds = [build()],
    timeline = {},
    notVisibleFor = 0,
    serverErrors = 0,
    actions = [],
    errorFor = null,
  } = {}) {
    this.calls = [];
    this.personalApps = personalApps;
    this.teams = teams;
    this.teamApps = teamApps;
    this.builds = new Map(builds.map((b) => [b.id, b]));
    this.timeline = timeline;
    this.notVisibleFor = notVisibleFor;
    this.serverErrors = serverErrors;
    this.actions = actions;
    this.errorFor = errorFor;
    this.fetch = this.fetch.bind(this);
  }

  get writes() {
    return this.calls.filter((c) => c.method !== 'GET');
  }

  get downloads() {
    return this.calls.filter((c) => c.host !== 'codemagic.io');
  }

  async fetch(url, init = {}) {
    const u = new URL(url);
    const method = String(init.method || 'GET').toUpperCase();
    const call = { method, url, host: u.host, path: u.pathname, query: u.searchParams, headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : undefined };
    this.calls.push(call);
    if (u.host !== 'codemagic.io') {
      const bytes = BYTES[u.pathname];
      return bytes ? response(200, undefined, { bytes }) : response(404, { detail: 'no such file' });
    }
    assert.ok(u.pathname.startsWith('/api/v3/'), `unexpected path ${u.pathname}`);
    const p = u.pathname.slice('/api/v3'.length);
    if (this.errorFor && this.errorFor.test(p)) return this.errorFor.answer();
    let m;
    if (method === 'GET' && p === '/user/apps') return response(200, page(this.personalApps));
    if (method === 'GET' && p === '/user/teams') return response(200, page(this.teams));
    if (method === 'GET' && (m = /^\/teams\/([^/]+)\/apps$/.exec(p))) return response(200, page(this.teamApps[m[1]] || []));
    if (method === 'GET' && (m = /^\/apps\/([^/]+)\/workflows$/.exec(p))) {
      return response(200, { data: [{ id: 'ios-capacitor', source: 'file', name: 'Flock iOS (Capacitor)' }, { id: 'ios-review-recording', source: 'file', name: null }] });
    }
    if (method === 'GET' && (m = /^\/teams\/([^/]+)\/builds$/.exec(p))) {
      const app = u.searchParams.get('app_id');
      const size = Number(u.searchParams.get('page_size') || 30);
      const list = [...this.builds.values()]
        .filter((b) => !app || b.app_id === app)
        .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
        .slice(0, size);
      return response(200, { data: list, page_size: size, cursor: null });
    }
    if (method === 'GET' && (m = /^\/builds\/([^/]+)\/actions$/.exec(p))) return response(200, page(this.actions));
    if (method === 'GET' && (m = /^\/builds\/([^/]+)$/.exec(p))) {
      const id = m[1];
      if (this.timeline[id]) {
        if (this.notVisibleFor > 0) {
          this.notVisibleFor -= 1;
          return response(404, { status_code: 404, detail: 'Not Found', errors: [] });
        }
        if (this.serverErrors > 0) {
          this.serverErrors -= 1;
          return response(500, { status_code: 500, detail: 'Internal Server Error', errors: [] });
        }
        const steps = this.timeline[id];
        const next = steps.length > 1 ? steps.shift() : steps[0];
        return response(200, { data: next });
      }
      const b = this.builds.get(id);
      return b ? response(200, { data: b }) : response(404, { status_code: 404, detail: 'Not Found', errors: [] });
    }
    if (method === 'POST' && (m = /^\/apps\/([^/]+)\/builds$/.exec(p))) return response(202, { data: { id: B53 } });
    return response(404, { status_code: 404, detail: `fake has no route for ${method} ${p}`, errors: [] });
  }
}

function fakeClock(startIso = '2026-11-05T13:00:00Z') {
  let t = Date.parse(startIso);
  return { now: () => new Date(t), sleep: async (ms) => { t += ms; } };
}

async function run(argv, fake, extra = {}) {
  const out = [];
  const err = [];
  const clock = extra.clock || fakeClock();
  const code = await main(argv, {
    env: { CODEMAGIC_TOKEN: TOKEN },
    fetch: fake ? fake.fetch : async () => { throw new Error('no network in this test'); },
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
    sleep: clock.sleep,
    now: clock.now,
    yamlText: YAML,
    ...extra,
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const tempDir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

test('parseArgs reads each command, its build id, both option spellings and the defaults', () => {
  assert.equal(parseArgs(['apps']).command, 'apps');
  assert.deepEqual(parseArgs(['recent']).opts, { limit: 5 });
  assert.equal(parseArgs(['recent', '--limit=3']).opts.limit, 3);
  const s = parseArgs(['start', '--branch', 'main', '--workflow=ios-capacitor', '--yes']);
  assert.equal(s.command, 'start');
  assert.equal(s.write, true);
  assert.deepEqual(s.opts, { branch: 'main', workflow: 'ios-capacitor', yes: true });
  assert.equal(parseArgs(['status', B52]).id, B52);
  assert.deepEqual(parseArgs(['wait', B52]).opts, { every: 30, timeout: 120 });
  assert.deepEqual(parseArgs(['wait', B52, '--every', '10', '--timeout', '90']).opts, { every: 10, timeout: 90 });
  assert.deepEqual(parseArgs(['artifacts', B52, '--download', '--out', 'here']).opts, { download: true, out: 'here' });
  assert.equal(parseArgs(['status', B52]).write, false);
  assert.equal(parseArgs([]).command, 'help');
  assert.equal(parseArgs(['start', '--help']).command, 'help');
});

test('parseArgs refuses what it cannot run, naming the problem', () => {
  const bad = [
    [['nope'], /unknown command "nope"/],
    [['status'], /needs a build id/],
    [['status', 'abc'], /not a Codemagic build id/],
    [['status', B52, B51], /unexpected/],
    [['apps', 'extra'], /unexpected "extra"/],
    [['start', '--workflow', 'ios-capacitor'], /needs --branch/],
    [['start', '--branch', 'main'], /needs --workflow/],
    [['start', '--branch', '-x', '--workflow', 'w'], /needs a value|not a branch/],
    [['start', '--branch', 'a..b', '--workflow', 'w'], /not a branch name/],
    [['start', '--branch', 'main', '--workflow', 'w', '--app', 'nope'], /not a Codemagic app id/],
    [['status', B52, '--yes'], /does not apply to "status"/],
    [['recent', '--every', '10'], /does not apply to "recent"/],
    [['wait', B52, '--every', '2'], /from 5 to 600/],
    [['wait', B52, '--timeout', 'ten'], /whole number/],
    [['recent', '--limit', '0'], /from 1 to 50/],
    [['recent', '--limit', '3', '--limit', '4'], /given twice/],
    [['start', '--yes=please', '--branch', 'main', '--workflow', 'w'], /takes no value/],
    [['recent', '--bogus'], /unknown option --bogus/],
    [['recent', '--limit'], /needs a value/],
    [['artifacts', B52, '--out', 'x'], /--out goes with --download/],
  ];
  for (const [argv, re] of bad) {
    assert.throws(() => parseArgs(argv), (e) => e instanceof UsageError && re.test(e.message), argv.join(' '));
  }
});

test('a usage error exits 2 without a single call', async () => {
  const r = await run(['start', '--branch', 'main'], null);
  assert.equal(r.code, EXIT.USAGE);
  assert.match(r.err, /needs --workflow/);
  assert.match(r.err, /--help/);
});

// ---------------------------------------------------------------------------
// The token
// ---------------------------------------------------------------------------

test('loadToken: --token-file beats CODEMAGIC_TOKEN, which beats the default file', () => {
  const home = tempDir('cm-home-');
  const def = defaultTokenPath(home);
  assert.equal(def, path.join(home, '.secrets', 'flock', 'codemagic-token'));
  fs.mkdirSync(path.dirname(def), { recursive: true });
  fs.writeFileSync(def, 'from-the-default-file\r\n');
  const other = path.join(home, 'other-token');
  fs.writeFileSync(other, '  from-the-named-file  \n');
  assert.equal(loadToken({ env: {}, home }).token, 'from-the-default-file');
  assert.equal(loadToken({ env: { CODEMAGIC_TOKEN: ' from-the-env ' }, home }).token, 'from-the-env');
  assert.equal(loadToken({ env: { CODEMAGIC_TOKEN: 'from-the-env' }, home, tokenFile: other }).token, 'from-the-named-file');
  assert.equal(loadToken({ env: { CODEMAGIC_TOKEN: '   ' }, home }).token, 'from-the-default-file');
});

test('a missing token file is a plain message naming the file, CODEMAGIC_TOKEN and the README, and exits 2 before any call', async () => {
  const home = tempDir('cm-home-');
  const fake = new FakeCodemagic();
  const r = await run(['recent'], fake, { env: {}, home });
  assert.equal(r.code, EXIT.USAGE);
  assert.ok(r.err.includes(defaultTokenPath(home)), r.err);
  assert.match(r.err, /CODEMAGIC_TOKEN/);
  assert.match(r.err, /README\.md/);
  assert.equal(fake.calls.length, 0);
  const named = await run(['recent', '--token-file', path.join(home, 'nope')], fake, { env: {}, home });
  assert.equal(named.code, EXIT.USAGE);
  assert.match(named.err, /no token file at .*nope/);
  assert.equal(fake.calls.length, 0);
});

test("token files: Notepad's .txt and a BOM are read; empty, two-line and NAME=value files are refused without echoing them", () => {
  const home = tempDir('cm-home-');
  const def = defaultTokenPath(home);
  fs.mkdirSync(path.dirname(def), { recursive: true });
  fs.writeFileSync(`${def}.txt`, '\uFEFF"saved-by-notepad"\r\n');
  assert.equal(loadToken({ env: {}, home }).token, 'saved-by-notepad');
  for (const [content, re] of [['', /is empty/], ['first-line\nsecond-line', /alone, on one line/], ['CODEMAGIC_TOKEN=abcdefghij', /NAME=value/]]) {
    fs.writeFileSync(def, content);
    assert.throws(() => loadToken({ env: {}, home }), (e) => e instanceof UsageError && re.test(e.message) && !e.message.includes('second-line') && !e.message.includes('abcdefghij'), JSON.stringify(content));
  }
});

// ---------------------------------------------------------------------------
// codemagic.yaml
// ---------------------------------------------------------------------------

test('parseWorkflows reads the keys and display names, and the real codemagic.yaml has ios-capacitor', () => {
  assert.deepEqual(parseWorkflows(YAML), [
    { key: 'ios-capacitor', name: 'Flock iOS (Capacitor)' },
    { key: 'ios-review-recording', name: 'Flock iOS review recording (Simulator, unattended)' },
  ]);
  const real = parseWorkflows(fs.readFileSync(YAML_PATH, 'utf8'));
  const wf = resolveWorkflow(real, 'ios-capacitor');
  assert.deepEqual(wf, { key: 'ios-capacitor', name: 'Flock iOS (Capacitor)' });
  assert.equal(resolveWorkflow(real, 'flock ios (capacitor)'), wf, 'the display name works too');
  assert.equal(resolveWorkflow(real, 'ios'), null);
});

// ---------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------

test('start without --yes prints the app, workflow, branch and the exact POST, starts nothing and exits 4', async () => {
  const fake = new FakeCodemagic();
  const r = await run(['start', '--branch', 'main', '--workflow', 'ios-capacitor'], fake);
  assert.equal(r.code, EXIT.UNCONFIRMED);
  assert.match(r.out, /app {7}flock-app \(00000000000000000000a001\), Flock/);
  assert.match(r.out, /workflow {2}ios-capacitor \("Flock iOS \(Capacitor\)" in codemagic\.yaml\)/);
  assert.match(r.out, /branch {4}main/);
  assert.match(r.out, /running {3}none of ios-capacitor on main \(checked the last 1 build\)/);
  assert.ok(r.out.includes(`POST https://codemagic.io/api/v3/apps/${APP}/builds {"workflow_id":"ios-capacitor","branch":"main"}`), r.out);
  assert.match(r.out, /Nothing started: add --yes/);
  assert.equal(fake.writes.length, 0);
});

test('start --dry-run prints the same plan and exits 0; the display name is turned into the key', async () => {
  const fake = new FakeCodemagic();
  const r = await run(['start', '--branch', 'main', '--workflow', 'Flock iOS (Capacitor)', '--dry-run'], fake);
  assert.equal(r.code, EXIT.OK);
  assert.match(r.out, /"workflow_id":"ios-capacitor"/);
  assert.match(r.out, /Dry run: nothing started/);
  assert.equal(fake.writes.length, 0);
});

test('start with a workflow codemagic.yaml does not have is refused before the token is read or any call', async () => {
  const fake = new FakeCodemagic();
  const r = await run(['start', '--branch', 'main', '--workflow', 'ios', '--yes'], fake, { env: {}, home: tempDir('cm-home-') });
  assert.equal(r.code, EXIT.REFUSED);
  assert.match(r.err, /"ios" is not a workflow in codemagic\.yaml; its workflows are ios-capacitor/);
  assert.equal(fake.calls.length, 0);
});

test('start refuses while a build of the same workflow and branch is running; --even-if-running lets it through', async () => {
  const running = build({ id: B53, index: 53, status: 'building', created_at: '2026-11-05T14:00:00Z', started_at: '2026-11-05T14:01:00Z', finished_at: null, artifacts: [] });
  const fake = new FakeCodemagic({ builds: [build(), running] });
  const r = await run(['start', '--branch', 'main', '--workflow', 'ios-capacitor', '--yes'], fake);
  assert.equal(r.code, EXIT.REFUSED);
  assert.match(r.out, /build #53 of ios-capacitor on main is already building/);
  assert.match(r.out, /Refused, nothing started/);
  assert.ok(r.out.includes(`"wait ${B53}" follows it`));
  assert.equal(fake.writes.length, 0);

  const other = await run(['start', '--branch', 'release', '--workflow', 'ios-capacitor'], new FakeCodemagic({ builds: [running] }));
  assert.equal(other.code, EXIT.UNCONFIRMED, 'a build on another branch is no reason to refuse');

  const fake2 = new FakeCodemagic({ builds: [build(), running] });
  const anyway = await run(['start', '--branch', 'main', '--workflow', 'ios-capacitor', '--even-if-running', '--yes'], fake2);
  assert.equal(anyway.code, EXIT.OK);
  assert.equal(fake2.writes.length, 1);
});

test('start --yes sends one POST with workflow_id and branch, with the token, and prints the build id and the wait command', async () => {
  const fake = new FakeCodemagic();
  const r = await run(['start', '--branch', 'main', '--workflow', 'ios-capacitor', '--yes'], fake);
  assert.equal(r.code, EXIT.OK);
  assert.equal(fake.writes.length, 1);
  const post = fake.writes[0];
  assert.equal(post.url, `https://codemagic.io/api/v3/apps/${APP}/builds`);
  assert.deepEqual(post.body, { workflow_id: 'ios-capacitor', branch: 'main' });
  assert.equal(post.headers['x-auth-token'], TOKEN);
  assert.ok(r.out.includes(`Started build ${B53}`));
  assert.ok(r.out.includes(`node tools/codemagic/cm.mjs wait ${B53}`));
  assert.ok(r.out.includes(`https://codemagic.io/app/${APP}/build/${B53}`));
  assert.ok(!r.out.includes(TOKEN));
});

test('start with two apps and no --app asks for one; --app or CODEMAGIC_APP_ID picks it', async () => {
  const apps = { personalApps: [{ id: APP2, name: 'old-sample', last_build_id: null, archived: false }] };
  const r = await run(['start', '--branch', 'main', '--workflow', 'ios-capacitor', '--yes'], new FakeCodemagic(apps));
  assert.equal(r.code, EXIT.USAGE);
  assert.ok(r.err.includes(APP) && r.err.includes(APP2), r.err);
  const fake = new FakeCodemagic(apps);
  const picked = await run(['start', '--branch', 'main', '--workflow', 'ios-capacitor', '--app', APP], fake);
  assert.equal(picked.code, EXIT.UNCONFIRMED);
  assert.ok(picked.out.includes(`/apps/${APP}/builds`));
  const viaEnv = await run(['start', '--branch', 'main', '--workflow', 'ios-capacitor'], new FakeCodemagic(apps), { env: { CODEMAGIC_TOKEN: TOKEN, CODEMAGIC_APP_ID: APP } });
  assert.equal(viaEnv.code, EXIT.UNCONFIRMED);
  const missing = await run(['start', '--branch', 'main', '--workflow', 'ios-capacitor', '--app', '00000000000000000000a0ff'], new FakeCodemagic(apps));
  assert.equal(missing.code, EXIT.REFUSED);
  assert.match(missing.err, /no app 00000000000000000000a0ff among the 2 app/);
});

test('start for an app no visible team holds checks its last build instead', async () => {
  const busy = build({ id: B51, index: 51, status: 'queued', started_at: null, finished_at: null, artifacts: [] });
  const fake = new FakeCodemagic({ teams: [], teamApps: {}, personalApps: [{ id: APP, name: 'flock-app', last_build_id: B51, archived: false }], builds: [busy] });
  const r = await run(['start', '--branch', 'main', '--workflow', 'ios-capacitor', '--yes'], fake);
  assert.equal(r.code, EXIT.REFUSED);
  assert.match(r.out, /app {7}flock-app \(00000000000000000000a001\), personal account/);
  assert.match(r.out, /build #51 of ios-capacitor on main is already queued/);
  assert.equal(fake.writes.length, 0);
});

// ---------------------------------------------------------------------------
// status and wait
// ---------------------------------------------------------------------------

test('status prints the number, status, times, duration, workflow and branch; a failed build names its step', async () => {
  const r = await run(['status', B52], new FakeCodemagic());
  assert.equal(r.code, EXIT.OK);
  assert.match(r.out, /^build #52 finished \(000000000000000000000b52\)/);
  assert.match(r.out, /workflow {4}ios-capacitor \(Flock iOS \(Capacitor\)\)/);
  assert.match(r.out, /from {8}branch main, commit 24d1b1d8 "Fix the share sheet on iOS"$/m);
  assert.match(r.out, /started {5}2026-11-05 13:02Z \(2m 00s in the queue\)/);
  assert.match(r.out, /ended {7}2026-11-05 13:49Z, took 47m 12s/);
  assert.match(r.out, /machine {5}mac_mini_m2, Xcode 26\.6/);
  assert.match(r.out, /artifacts {3}App\.ipa 11 B, logs\/xcodebuild\.log 5 B/);
  assert.ok(r.out.includes(`page        https://codemagic.io/app/${APP}/build/${B52}`));

  const failed = build({ status: 'failed', finished_at: '2026-11-05T13:14:00Z', artifacts: [] });
  const steps = [
    { id: 's1', name: 'Install web dependencies', type: 'script', status: 'success', started_at: 'x', finished_at: 'y' },
    { id: 's2', name: 'Check the fetched profile against App.entitlements', type: 'script', status: 'failed', started_at: 'x', finished_at: 'y' },
  ];
  const f = await run(['status', B52], new FakeCodemagic({ builds: [failed], actions: steps }));
  assert.equal(f.code, EXIT.OK);
  assert.match(f.out, /build #52 failed/);
  assert.match(f.out, /stopped at {2}"Check the fetched profile against App\.entitlements"/);
});

const stage = (status, over = {}) => build({
  id: B53,
  index: 53,
  status,
  started_at: status === 'queued' ? null : '2026-11-05T13:02:00Z',
  finished_at: ENDED.has(status) ? '2026-11-05T13:49:12Z' : null,
  artifacts: [],
  ...over,
});

test('wait follows a build to its end, one line per change, then the number, status and duration', async () => {
  const fake = new FakeCodemagic({ timeline: { [B53]: [stage('queued'), stage('building'), stage('building'), stage('publishing'), stage('finished')] } });
  const r = await run(['wait', B53], fake);
  assert.equal(r.code, EXIT.OK);
  const lines = r.out.split('\n');
  assert.equal(lines[0], `Waiting for build ${B53}: a check every 30 s, for at most 120 min.`);
  assert.deepEqual(lines.slice(1, 5), [
    '13:00:00Z  queued  (build #53)',
    '13:00:30Z  building',
    '13:01:30Z  publishing',
    '13:02:00Z  finished',
  ]);
  assert.equal(lines.at(-1), 'build #53 finished in 47m 12s (after 2m 00s in the queue)');
  assert.equal(fake.writes.length, 0);
});

test('wait exits 5 for a build that fails, naming the step, and 6 for one still running at --timeout, canceling nothing', async () => {
  const steps = [{ id: 's2', name: 'Build signed IPA', type: 'building_ios', status: 'failed', started_at: 'x', finished_at: 'y' }];
  const failed = new FakeCodemagic({ timeline: { [B53]: [stage('building'), stage('failed', { finished_at: '2026-11-05T13:20:00Z' })] }, actions: steps });
  const f = await run(['wait', B53], failed);
  assert.equal(f.code, EXIT.ENDED_BADLY);
  assert.match(f.out, /build #53 failed after 18m 00s \(after 2m 00s in the queue\)/);
  assert.match(f.out, /stopped at {2}"Build signed IPA"/);

  const canceled = await run(['wait', B53], new FakeCodemagic({ timeline: { [B53]: [stage('canceled', { started_at: null })] } }));
  assert.equal(canceled.code, EXIT.ENDED_BADLY);
  assert.match(canceled.out, /build #53 canceled/);

  const slow = new FakeCodemagic({ timeline: { [B53]: [stage('building', { created_at: '2026-11-05T12:58:00Z', started_at: '2026-11-05T12:59:00Z' })] } });
  const clock = fakeClock();
  const s = await run(['wait', B53, '--timeout', '1'], slow, { clock });
  assert.equal(s.code, EXIT.STILL_RUNNING);
  assert.match(s.out, /build #53 is building, running for 2m 00s, and --timeout 1 min is up\. Nothing was canceled/);
  assert.equal(slow.calls.filter((c) => c.path.endsWith(`/builds/${B53}`)).length, 3, 'checks at 0, 30 and 60 s');
  assert.equal(slow.writes.length, 0);
});

test('wait reads a 404 just after a start as not visible yet and rides out server errors; a 404 that lasts is an error', async () => {
  const fake = new FakeCodemagic({ timeline: { [B53]: [stage('finished')] }, notVisibleFor: 2, serverErrors: 3 });
  const r = await run(['wait', B53], fake);
  assert.equal(r.code, EXIT.OK);
  assert.match(r.out, /not visible yet/);
  assert.match(r.err, /HTTP 500.*checking again/);
  assert.match(r.out, /build #53 finished in 47m 12s/);

  const never = await run(['wait', B53], new FakeCodemagic({ timeline: { [B53]: [stage('finished')] }, notVisibleFor: 1000 }));
  assert.equal(never.code, EXIT.API);
  assert.match(never.err, /HTTP 404/);
});

// ---------------------------------------------------------------------------
// artifacts
// ---------------------------------------------------------------------------

test('artifacts lists the files and downloads nothing without --download', async () => {
  const fake = new FakeCodemagic();
  const r = await run(['artifacts', B52], fake);
  assert.equal(r.code, EXIT.OK);
  assert.match(r.out, /build #52 finished: 2 artifacts/);
  assert.match(r.out, /App\.ipa +ipa +11 B {2}version 1\.0\.1 \(53\)/);
  assert.match(r.out, /xcodebuild\.log +log +5 B/);
  assert.equal(fake.downloads.length, 0);
  assert.ok(!r.out.includes('sig=1'), 'the short-lived download address is not printed');
});

test('artifacts --download saves each file, and sends the token to codemagic.io only', async () => {
  const dir = tempDir('cm-out-');
  const fake = new FakeCodemagic();
  const r = await run(['artifacts', B52, '--download', '--out', dir], fake);
  assert.equal(r.code, EXIT.OK, r.err);
  assert.equal(fs.readFileSync(path.join(dir, 'App.ipa'), 'utf8'), 'ipa-bytes!!');
  assert.equal(fs.readFileSync(path.join(dir, 'xcodebuild.log'), 'utf8'), 'log!!');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['App.ipa', 'xcodebuild.log'], 'no .part file is left behind');
  const [ipa, log] = fake.downloads;
  assert.equal(ipa.host, 'storage.example.test');
  assert.equal(ipa.headers['x-auth-token'], undefined, 'no token to a storage host');
  assert.equal(log.host, 'api.codemagic.io');
  assert.equal(log.headers['x-auth-token'], TOKEN);
  assert.equal(sendsToken('http://api.codemagic.io/x'), false, 'never over plain http');
  assert.equal(sendsToken('https://codemagic.io.example.test/x'), false);
});

test('artifacts --download refuses to overwrite a file that is already there, before downloading anything', async () => {
  const dir = tempDir('cm-out-');
  fs.writeFileSync(path.join(dir, 'App.ipa'), 'an older build');
  const fake = new FakeCodemagic();
  const r = await run(['artifacts', B52, '--download', '--out', dir], fake);
  assert.equal(r.code, EXIT.REFUSED);
  assert.match(r.err, /nothing downloaded: already there/);
  assert.equal(fake.downloads.length, 0);
  assert.equal(fs.readFileSync(path.join(dir, 'App.ipa'), 'utf8'), 'an older build');
});

test('fileNames keeps artifact names safe and distinct', () => {
  assert.deepEqual(fileNames(['build/ios/ipa/App.ipa', 'App.ipa', 'a:b?.log', '', '..']), ['App.ipa', 'App (2).ipa', 'a_b_.log', 'artifact', 'artifact (2)']);
});

// ---------------------------------------------------------------------------
// recent and apps
// ---------------------------------------------------------------------------

test('recent lists the app\'s builds newest first, at most --limit, and only that app\'s', async () => {
  const builds = [
    build({ id: B49, index: 49, created_at: '2026-11-01T10:00:00Z', started_at: '2026-11-01T10:01:00Z', finished_at: '2026-11-01T10:40:00Z' }),
    build({ id: B51, index: 51, status: 'failed', created_at: '2026-11-03T10:00:00Z', started_at: '2026-11-03T10:01:00Z', finished_at: '2026-11-03T10:11:00Z' }),
    build({ id: B50, index: 50, created_at: '2026-11-02T10:00:00Z', started_at: '2026-11-02T10:01:00Z', finished_at: '2026-11-02T10:41:00Z' }),
    build(),
    build({ id: B53, app_id: APP2, index: 7, created_at: '2026-11-05T15:00:00Z' }),
  ];
  const fake = new FakeCodemagic({ builds });
  const r = await run(['recent', '--limit', '3'], fake);
  assert.equal(r.code, EXIT.OK);
  const rows = r.out.split('\n');
  assert.equal(rows[0], 'flock-app: the last 3 builds, newest first');
  assert.match(rows[1], /^#52 +finished +ios-capacitor +main +2026-11-05 13:02Z {2}47m 12s +000000000000000000000b52$/);
  assert.match(rows[2], /^#51 +failed /);
  assert.match(rows[3], /^#50 +finished /);
  assert.equal(rows.length, 4);
  const q = fake.calls.find((c) => c.path === `/api/v3/teams/${TEAM}/builds`).query;
  assert.equal(q.get('app_id'), APP);
  assert.equal(q.get('page_size'), '3');
  assert.equal(fake.writes.length, 0);
});

test('recent for an app no visible team holds shows its last build and says why', async () => {
  const fake = new FakeCodemagic({ teams: [], teamApps: {}, personalApps: [{ id: APP, name: 'flock-app', last_build_id: B52, archived: false }] });
  const r = await run(['recent'], fake);
  assert.equal(r.code, EXIT.OK);
  assert.match(r.out, /in none of the teams this token can see, so only its last build is listed/);
  assert.match(r.out, /#52 +finished/);
});

test('apps lists every app with its team, repository, last build and workflows', async () => {
  const fake = new FakeCodemagic({ personalApps: [{ id: APP2, name: 'old-sample', last_build_id: null, archived: true }] });
  const r = await run(['apps'], fake);
  assert.equal(r.code, EXIT.OK);
  assert.ok(r.out.includes(`${APP}  flock-app  (Flock)`), r.out);
  assert.ok(r.out.includes(`${APP2}  old-sample  (personal account)  archived`), r.out);
  assert.match(r.out, /repository {2}git@github\.com:example\/flock\.git/);
  assert.ok(r.out.includes(`last build  ${B52}`));
  assert.match(r.out, /workflows {3}ios-capacitor \("Flock iOS \(Capacitor\)"\), ios-review-recording/);
  assert.equal(fake.writes.length, 0);
});

// ---------------------------------------------------------------------------
// Errors and the token in output
// ---------------------------------------------------------------------------

test("an API error exits 1 with Codemagic's own detail, and a 401 says to check the token", async () => {
  const bad = new FakeCodemagic({ errorFor: { test: (p) => p === `/builds/${B52}`, answer: () => response(403, { status_code: 403, detail: 'The caller lacks the required permission', errors: [] }) } });
  const r = await run(['status', B52], bad);
  assert.equal(r.code, EXIT.API);
  assert.match(r.err, /GET \/builds\/000000000000000000000b52 -> HTTP 403: The caller lacks the required permission/);

  const unauth = new FakeCodemagic({ errorFor: { test: () => true, answer: () => response(401, { status_code: 401, detail: 'Authentication is missing or invalid', errors: [] }) } });
  const u = await run(['apps'], unauth);
  assert.equal(u.code, EXIT.API);
  assert.match(u.err, /HTTP 401: Authentication is missing or invalid \(Codemagic did not accept the token; README\.md/);
});

test('no output line carries the token, even an error that echoes it', async () => {
  const echo = new FakeCodemagic({ errorFor: { test: () => true, answer: () => response(400, { status_code: 400, detail: `bad header x-auth-token: ${TOKEN}`, errors: [{ message: `value ${TOKEN}`, key: 'x-auth-token' }] }) } });
  const r = await run(['recent'], echo);
  assert.equal(r.code, EXIT.API);
  assert.ok(!r.out.includes(TOKEN) && !r.err.includes(TOKEN), r.err);
  assert.match(r.err, /x-auth-token: \{token\}/);
});

test('times and durations read and print the way the build page shows them', () => {
  assert.equal(parseTime('2020-09-08T07:18:02.203+0000'), Date.parse('2020-09-08T07:18:02.203+00:00'));
  assert.equal(parseTime(null), null);
  assert.equal(fmtDuration(47 * 60000 + 12000), '47m 12s');
  assert.equal(fmtDuration(3 * 3600000 + 5 * 60000), '3h 05m');
  assert.equal(fmtDuration(9000), '9s');
  assert.equal(fmtDuration(null), '?');
});
