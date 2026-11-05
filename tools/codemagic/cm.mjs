#!/usr/bin/env node
/**
 * tools/codemagic/cm.mjs: Codemagic builds from the command line.
 *
 *   node tools/codemagic/cm.mjs apps
 *   node tools/codemagic/cm.mjs recent [--limit 5]
 *   node tools/codemagic/cm.mjs start --branch main --workflow ios-capacitor [--yes]
 *   node tools/codemagic/cm.mjs status <build id>
 *   node tools/codemagic/cm.mjs wait <build id> [--every 30] [--timeout 120]
 *   node tools/codemagic/cm.mjs artifacts <build id> [--download] [--out <folder>]
 *
 * Plain Node 18 or later: the global fetch, no packages. README.md beside this
 * file has the commands and the one-time token setup; in short:
 *
 *  - It talks to Codemagic's v3 REST API, https://codemagic.io/api/v3 (schema
 *    at https://codemagic.io/api/v3/schema), which Codemagic's docs now point
 *    to. The api.codemagic.io endpoints for reading builds left those docs in
 *    September 2025.
 *  - The token comes from --token-file, else CODEMAGIC_TOKEN, else the file
 *    ~/.secrets/flock/codemagic-token. It is sent to codemagic.io only, and no
 *    line this prints carries it: it would show as {token}.
 *  - start is the only write to Codemagic. Without --yes it prints the exact
 *    call and stops; --dry-run prints it and exits 0. Nothing is ever asked
 *    interactively.
 *  - Exit codes: 0 done, 1 an API call failed, 2 usage or configuration (a
 *    missing token file too), 3 refused before the write (a check failed,
 *    nothing started), 4 not confirmed (add --yes), 5 wait: the build ended
 *    without finishing (failed, canceled, timeout or skipped), 6 wait: the
 *    build was still running when --timeout ran out.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const API_BASE = 'https://codemagic.io/api/v3';
export const SITE = 'https://codemagic.io';
export const EXIT = Object.freeze({ OK: 0, API: 1, USAGE: 2, REFUSED: 3, UNCONFIRMED: 4, ENDED_BADLY: 5, STILL_RUNNING: 6 });

/* BuildStatus in the v3 schema (read 2026-11-05): eight stages a build passes
   through, and five ways it ends, of which only "finished" is a success. */
export const RUNNING = new Set(['initializing', 'queued', 'preparing', 'fetching', 'testing', 'building', 'publishing', 'finishing']);
export const ENDED = new Set(['finished', 'failed', 'canceled', 'timeout', 'skipped']);

// The schema says GET /builds/{id} "can respond 404 for a short while" after a
// start returns the id, so wait reads a 404 in its first two minutes as "not
// visible yet" rather than as a wrong id.
const NOT_YET_VISIBLE_MS = 2 * 60 * 1000;
// wait gives up on this many failed checks in a row (network, 429 or 5xx, each
// check already retried twice by the client).
const MAX_FAILED_CHECKS = 5;

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const YAML_PATH = path.resolve(HERE, '..', '..', 'codemagic.yaml');
const ID_RE = /^[0-9a-f]{24}$/i;

export class UsageError extends Error {}
/** A check failed before anything was written. */
export class RefusedError extends Error {}
export class CmError extends Error {
  constructor(message, status = null) {
    super(message);
    this.status = status;
  }
}

export const HELP = `cm: Codemagic builds for this app, from the command line.

Read only:
  apps                              the apps this token can see: ids, names, workflows
  recent [--limit 5] [--app ID]     the latest builds, newest first
  status <build id>                 number, status, times, the step that failed, artifacts
  wait <build id> [--every 30] [--timeout 120]
                                    checks every --every seconds until the build ends,
                                    for at most --timeout minutes
  artifacts <build id> [--download] [--out <folder>]
                                    lists the build's files; --download saves them

Write (prints its exact call; --dry-run stops there, --yes makes it):
  start --branch <branch> --workflow <key> [--app ID] [--even-if-running]
      <key> is a workflow under workflows: in codemagic.yaml, e.g. ios-capacitor
      (its display name works too). A build of the same workflow and branch
      that is still running refuses the start unless --even-if-running.

Options: --token-file <file>  --dry-run  --yes  --help
Token: --token-file, else CODEMAGIC_TOKEN, else ${path.join('~', '.secrets', 'flock', 'codemagic-token')}
  (README.md beside this file has the one-time setup).
App: --app, else CODEMAGIC_APP_ID, else the one app the token can see.
Exit codes: 0 done, 1 an API call failed, 2 usage or configuration,
  3 refused before the write, 4 not confirmed (add --yes),
  5 wait: the build ended without finishing, 6 wait: still running at --timeout.`;

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

const VALUE_OPTIONS = new Set(['branch', 'workflow', 'app', 'every', 'timeout', 'limit', 'out', 'token-file']);
const FLAG_OPTIONS = new Set(['yes', 'dry-run', 'download', 'even-if-running', 'help']);
const SPEC = {
  apps: { id: false, opts: [] },
  recent: { id: false, opts: ['limit', 'app'] },
  start: { id: false, opts: ['branch', 'workflow', 'app', 'yes', 'dry-run', 'even-if-running'], required: ['branch', 'workflow'] },
  status: { id: true, opts: [] },
  wait: { id: true, opts: ['every', 'timeout'] },
  artifacts: { id: true, opts: ['download', 'out'] },
};
// [lowest, highest, default]
const NUMBERS = { limit: [1, 50, 5], every: [5, 600, 30], timeout: [1, 600, 120] };

const BUILD_ID_HELP = '24 characters, 0-9 and a-f: the last part of the build page\'s address';

export function parseArgs(argv) {
  const words = [];
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      words.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const flag = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    let value = eq === -1 ? undefined : arg.slice(eq + 1);
    if (!flag) throw new UsageError(`"${arg}" is not an option`);
    if (FLAG_OPTIONS.has(flag)) {
      if (value !== undefined) throw new UsageError(`--${flag} takes no value`);
      if (opts[flag]) throw new UsageError(`--${flag} is given twice`);
      opts[flag] = true;
      continue;
    }
    if (!VALUE_OPTIONS.has(flag)) throw new UsageError(`unknown option --${flag}`);
    if (value === undefined) {
      value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new UsageError(`--${flag} needs a value`);
      i += 1;
    }
    if (opts[flag] !== undefined) throw new UsageError(`--${flag} is given twice`);
    opts[flag] = value;
  }

  if (opts.help || words.length === 0 || words[0] === 'help') return { command: 'help', id: null, opts, write: false };
  const [command, ...rest] = words;
  const spec = SPEC[command];
  if (!spec) throw new UsageError(`unknown command "${command}" (${Object.keys(SPEC).join(', ')})`);
  const id = spec.id ? rest.shift() : null;
  if (spec.id && id === undefined) throw new UsageError(`"${command}" needs a build id (${BUILD_ID_HELP})`);
  if (rest.length) throw new UsageError(`unexpected "${rest[0]}"`);
  if (spec.id && !ID_RE.test(id)) throw new UsageError(`"${id}" is not a Codemagic build id (${BUILD_ID_HELP})`);

  const allowed = new Set(['token-file', 'help', ...spec.opts]);
  for (const k of Object.keys(opts)) {
    if (!allowed.has(k)) throw new UsageError(`--${k} does not apply to "${command}"`);
  }
  for (const k of spec.required || []) {
    if (opts[k] === undefined) throw new UsageError(`"${command}" needs --${k}`);
  }
  for (const [k, [lo, hi, dflt]] of Object.entries(NUMBERS)) {
    if (!spec.opts.includes(k)) continue;
    if (opts[k] === undefined) {
      opts[k] = dflt;
      continue;
    }
    if (!/^\d+$/.test(opts[k]) || Number(opts[k]) < lo || Number(opts[k]) > hi) {
      throw new UsageError(`--${k} takes a whole number from ${lo} to ${hi}`);
    }
    opts[k] = Number(opts[k]);
  }
  if (opts.app !== undefined && !ID_RE.test(opts.app)) {
    throw new UsageError(`--app ${opts.app} is not a Codemagic app id (24 characters, 0-9 and a-f; "apps" lists them)`);
  }
  if (opts.branch !== undefined && !/^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]+$/.test(opts.branch)) {
    throw new UsageError(`--branch ${opts.branch} is not a branch name`);
  }
  if (opts.workflow !== undefined && !opts.workflow.trim()) throw new UsageError('--workflow is empty');
  if (opts.out !== undefined && !opts.download) throw new UsageError('--out goes with --download');
  return { command, id, opts, write: command === 'start' };
}

// ---------------------------------------------------------------------------
// The token
// ---------------------------------------------------------------------------

export function defaultTokenPath(home = os.homedir()) {
  return path.join(home, '.secrets', 'flock', 'codemagic-token');
}

const stripBom = (s) => String(s).replace(/^\uFEFF/, '');

/**
 * The token, from --token-file, else CODEMAGIC_TOKEN, else the default file
 * (or the same name with .txt, which is what Notepad saves). The value is
 * checked for shape and never put in a message.
 */
export function loadToken({ env = process.env, tokenFile, home, readFile = fs.readFileSync, exists = fs.existsSync } = {}) {
  if (!tokenFile && env.CODEMAGIC_TOKEN && env.CODEMAGIC_TOKEN.trim()) {
    return { token: checkTokenShape(env.CODEMAGIC_TOKEN, 'CODEMAGIC_TOKEN'), source: 'CODEMAGIC_TOKEN' };
  }
  const file = tokenFile || defaultTokenPath(home);
  const found = (tokenFile ? [file] : [file, `${file}.txt`]).find((f) => exists(f));
  if (!found) {
    throw new UsageError(tokenFile
      ? `no token file at ${file}`
      : `no Codemagic token. Save it as ${file} (the token alone, on one line) or set CODEMAGIC_TOKEN. `
        + 'README.md beside this tool has the steps.');
  }
  return { token: checkTokenShape(readFile(found, 'utf8'), found), source: found };
}

function checkTokenShape(raw, where) {
  let t = stripBom(raw).trim();
  const quoted = /^(["'])(.*)\1$/.exec(t);
  if (quoted) t = quoted[2].trim();
  if (!t) throw new UsageError(`${where} is empty: it should hold the Codemagic API token`);
  if (/\s/.test(t)) throw new UsageError(`${where} should hold the token alone, on one line (it holds more than one word or line)`);
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) throw new UsageError(`${where} holds NAME=value; it should hold the token alone`);
  return t;
}

/** Masks each secret wherever it would be printed. */
export function makeRedactor(secrets) {
  const list = secrets.filter((s) => s && String(s).length >= 8).map(String);
  return (text) => {
    let s = String(text);
    for (const v of list) s = s.split(v).join('{token}');
    return s;
  };
}

// ---------------------------------------------------------------------------
// The API
// ---------------------------------------------------------------------------

const timeoutSignal = (ms) => (typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined);
const enc = encodeURIComponent;

function errorDetail(json, text) {
  if (json && (json.detail || Array.isArray(json.errors))) {
    const parts = [];
    if (json.detail) parts.push(String(json.detail));
    for (const e of json.errors || []) {
      if (e && e.message) parts.push(e.key ? `${e.key}: ${e.message}` : String(e.message));
    }
    return parts.length ? `: ${parts.join('; ')}` : '';
  }
  const t = String(text || '').trim().slice(0, 300);
  return t ? `: ${t}` : '';
}

function retryDelay(res, attempt) {
  const reset = res && res.headers && typeof res.headers.get === 'function' ? Number(res.headers.get('ratelimit-reset')) : NaN;
  if (res && res.status === 429 && Number.isFinite(reset) && reset > 0 && reset <= 60) return reset * 1000;
  return 2000 * (attempt + 1);
}

/** The API client. GETs retry twice on network errors, 429 and 5xx; the one write is never retried. */
export function makeClient({ fetchImpl, token, sleep, base = API_BASE }) {
  async function request(method, p, body) {
    const retries = method === 'GET' ? 2 : 0;
    for (let attempt = 0; ; attempt += 1) {
      let res;
      try {
        res = await fetchImpl(base + p, {
          method,
          headers: {
            'x-auth-token': token,
            Accept: 'application/json',
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: timeoutSignal(60000),
        });
      } catch (e) {
        if (attempt < retries) {
          await sleep(retryDelay(null, attempt));
          continue;
        }
        throw new CmError(`${method} ${p}: could not reach codemagic.io (${e.message})`, null);
      }
      const text = await res.text();
      let json = null;
      if (text) {
        try { json = JSON.parse(text); } catch { json = null; }
      }
      if (res.ok) return json || {};
      if (attempt < retries && (res.status === 429 || res.status >= 500)) {
        await sleep(retryDelay(res, attempt));
        continue;
      }
      const hint = res.status === 401 ? ' (Codemagic did not accept the token; README.md beside this tool says how to make one)' : '';
      throw new CmError(`${method} ${p} -> HTTP ${res.status}${errorDetail(json, text)}${hint}`, res.status);
    }
  }
  return {
    get: (p) => request('GET', p),
    post: (p, b) => request('POST', p, b),
  };
}

/** Every page of a list with page/total_pages paging. */
async function allPages(api, p, cap = 20) {
  const out = [];
  for (let page = 1; page <= cap; page += 1) {
    const j = await api.get(`${p}${p.includes('?') ? '&' : '?'}page=${page}&page_size=100`);
    out.push(...(Array.isArray(j.data) ? j.data : []));
    if (page >= (Number(j.total_pages) || 1)) break;
  }
  return out;
}

async function getBuild(api, id) {
  const j = await api.get(`/builds/${enc(id)}`);
  if (!j.data || !j.data.id) throw new CmError(`GET /builds/${id} answered without a build`);
  return j.data;
}

/**
 * The apps the token can see, each with the team it belongs to. The personal
 * account's apps come from /user/apps; a team's from /teams/{id}/apps. A team
 * that cannot be read is noted, not fatal.
 */
export async function discoverApps(api) {
  const apps = new Map();
  const notes = [];
  const put = (a, team) => {
    const was = apps.get(a.id) || {};
    apps.set(a.id, {
      id: a.id,
      name: a.name || was.name || '?',
      teamId: team ? team.id : (was.teamId ?? null),
      teamName: team ? (team.name || team.id) : (was.teamName || 'personal account'),
      lastBuildId: a.last_build_id || was.lastBuildId || null,
      archived: Boolean(a.archived ?? was.archived),
      repository: (a.repository && a.repository.url) || was.repository || null,
    });
  };
  for (const a of await allPages(api, '/user/apps')) put(a, null);
  let teams = [];
  try {
    teams = await allPages(api, '/user/teams');
  } catch (e) {
    notes.push(`the team list: ${e.message}`);
  }
  for (const t of teams) {
    try {
      for (const a of await allPages(api, `/teams/${enc(t.id)}/apps`)) put(a, t);
    } catch (e) {
      notes.push(`team ${t.name || t.id}: ${e.message}`);
    }
  }
  const list = [...apps.values()].sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return { apps: list, notes };
}

/** The app a command works on: --app, else CODEMAGIC_APP_ID, else the only one. */
export function chooseApp(found, wanted) {
  if (wanted) {
    if (!ID_RE.test(wanted)) throw new UsageError(`CODEMAGIC_APP_ID ${wanted} is not a Codemagic app id (24 characters, 0-9 and a-f)`);
    const a = found.apps.find((x) => x.id === wanted);
    if (!a) throw new RefusedError(`no app ${wanted} among the ${found.apps.length} app(s) this token can see ("apps" lists them)`);
    return a;
  }
  const live = found.apps.filter((a) => !a.archived);
  if (live.length === 1) return live[0];
  if (!live.length) throw new RefusedError('this token can see no Codemagic apps');
  throw new UsageError(`this token can see ${live.length} apps, so name one with --app or CODEMAGIC_APP_ID: `
    + `${live.map((a) => `${a.id} ${a.name}`).join('; ')}`);
}

// ---------------------------------------------------------------------------
// codemagic.yaml (read only)
// ---------------------------------------------------------------------------

const stripComment = (s) => String(s).replace(/\s+#.*$/, '');
const unquote = (s) => {
  const m = /^(["'])(.*)\1$/.exec(String(s).trim());
  return m ? m[2] : String(s).trim();
};

/** The workflow keys under workflows: and each one's display name. */
export function parseWorkflows(text) {
  const out = [];
  let inside = false;
  let current = null;
  for (const line of stripBom(text).split(/\r?\n/)) {
    if (!inside) {
      if (/^workflows:\s*(#.*)?$/.test(line)) inside = true;
      continue;
    }
    if (/^\S/.test(line) && !line.startsWith('#')) break;
    const key = /^ {2}([A-Za-z0-9_.-]+):\s*(#.*)?$/.exec(line);
    if (key) {
      current = { key: key[1], name: null };
      out.push(current);
      continue;
    }
    const name = /^ {4}name:\s*(.+?)\s*$/.exec(line);
    if (name && current && current.name === null) current.name = unquote(stripComment(name[1]));
  }
  return out;
}

/** A workflow by its key, or by its display name when exactly one has it. */
export function resolveWorkflow(workflows, wanted) {
  const byKey = workflows.find((w) => w.key === wanted);
  if (byKey) return byKey;
  const lower = String(wanted).trim().toLowerCase();
  const byName = workflows.filter((w) => w.name && w.name.toLowerCase() === lower);
  return byName.length === 1 ? byName[0] : null;
}

function checkStartLocally(args, ctx) {
  let text;
  try {
    text = ctx.readYaml();
  } catch (e) {
    throw new RefusedError(`cannot read ${ctx.yamlPath} (${e.code || e.message}), so the workflow cannot be checked`);
  }
  const workflows = parseWorkflows(text);
  const wf = resolveWorkflow(workflows, args.opts.workflow);
  if (!wf) {
    throw new RefusedError(`"${args.opts.workflow}" is not a workflow in codemagic.yaml; its workflows are `
      + `${workflows.map((w) => `${w.key}${w.name ? ` ("${w.name}")` : ''}`).join(', ') || 'none'}`);
  }
  return { workflow: wf };
}

// ---------------------------------------------------------------------------
// Printing
// ---------------------------------------------------------------------------

/** Milliseconds, or null. Accepts the +0000 offsets older Codemagic answers used. */
export function parseTime(s) {
  if (!s) return null;
  const t = Date.parse(String(s).replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  return Number.isNaN(t) ? null : t;
}

export const fmtTime = (t) => (t == null ? '?' : `${new Date(t).toISOString().slice(0, 16).replace('T', ' ')}Z`);
const fmtClock = (d) => `${d.toISOString().slice(11, 19)}Z`;

export function fmtDuration(ms) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '?';
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m) return `${m}m ${String(sec).padStart(2, '0')}s`;
  return `${sec}s`;
}

export function fmtBytes(n) {
  if (!Number.isFinite(n)) return '?';
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3) return `${Math.round(n / 1e3)} kB`;
  return `${n} B`;
}

const firstLine = (s, n) => {
  const t = String(s || '').split(/\r?\n/)[0].trim();
  return t.length > n ? `${t.slice(0, n - 3)}...` : t;
};

/** When it was queued, started and ended, and how long it waited and ran. */
export function timing(b, now) {
  const created = parseTime(b.created_at);
  const started = parseTime(b.started_at);
  const finished = parseTime(b.finished_at);
  const nowMs = now.getTime();
  let queued = null;
  if (created != null && started != null) queued = started - created;
  else if (created != null && started == null && RUNNING.has(b.status)) queued = nowMs - created;
  let ran = null;
  if (started != null && finished != null) ran = finished - started;
  else if (started != null && RUNNING.has(b.status)) ran = nowMs - started;
  return { created, started, finished, queued, ran };
}

const num = (b) => (b.index != null ? `#${b.index}` : b.id);
const wfLabel = (w) => (w ? `${w.id || '?'}${w.name && w.name !== w.id ? ` (${w.name})` : ''}` : '?');

/** One line: the build number, how it stands or ended, and how long it took. */
export function summaryLine(b, now) {
  const t = timing(b, now);
  const queue = t.queued != null && t.queued >= 60000 ? ` (after ${fmtDuration(t.queued)} in the queue)` : '';
  if (b.status === 'finished') return `build ${num(b)} finished in ${fmtDuration(t.ran)}${queue}`;
  if (ENDED.has(b.status)) return `build ${num(b)} ${b.status}${t.ran != null ? ` after ${fmtDuration(t.ran)}` : ''}${queue}`;
  return `build ${num(b)} is ${b.status}${t.ran != null ? `, running for ${fmtDuration(t.ran)}` : ''}`;
}

export function describeBuild(b, now) {
  const t = timing(b, now);
  const c = b.commit || {};
  const from = b.branch ? `branch ${b.branch}` : b.tag ? `tag ${b.tag}` : '?';
  const cfg = b.config || {};
  const arts = Array.isArray(b.artifacts) ? b.artifacts : [];
  const lines = [
    `build ${num(b)} ${b.status} (${b.id})`,
    `  workflow    ${wfLabel(b.workflow)}`,
    `  from        ${from}${c.hash ? `, commit ${String(c.hash).slice(0, 8)}` : ''}${c.message ? ` "${firstLine(c.message, 60)}"` : ''}`,
    `  queued      ${fmtTime(t.created)}`,
  ];
  if (t.started != null) lines.push(`  started     ${fmtTime(t.started)}${t.queued >= 60000 ? ` (${fmtDuration(t.queued)} in the queue)` : ''}`);
  if (t.finished != null) lines.push(`  ended       ${fmtTime(t.finished)}${t.ran != null ? `, took ${fmtDuration(t.ran)}` : ''}`);
  else if (RUNNING.has(b.status)) lines.push(t.started != null ? `  running     for ${fmtDuration(t.ran)}` : `  waiting     ${fmtDuration(t.queued)} so far`);
  lines.push(`  machine     ${b.instance_type || '?'}${cfg.xcode_version ? `, Xcode ${cfg.xcode_version}` : ''}`);
  if (b.app_store_connect_status) lines.push(`  App Store   ${b.app_store_connect_status}`);
  lines.push(`  artifacts   ${arts.length ? arts.map((a) => `${a.name} ${fmtBytes(a.size_in_bytes)}`).join(', ') : 'none'}`);
  return lines;
}

export function buildRow(b, now) {
  const t = timing(b, now);
  const when = fmtTime(t.started ?? t.created);
  const took = t.ran != null ? fmtDuration(t.ran) : '';
  const ref = b.branch || (b.tag ? `tag ${b.tag}` : '?');
  return `${String(num(b)).padEnd(5)} ${String(b.status).padEnd(10)} ${String((b.workflow && b.workflow.id) || '?').padEnd(22)} `
    + `${String(ref).padEnd(8)} ${when}  ${took.padEnd(8)} ${b.id}`;
}

/** The step a failed build stopped at, from its actions. */
async function failedStep(api, id) {
  const actions = (await api.get(`/builds/${enc(id)}/actions?page_size=100`)).data || [];
  const failed = actions.find((a) => a.status === 'failed');
  if (failed) return `"${failed.name}"`;
  const open = [...actions].reverse().find((a) => a.started_at && !a.finished_at);
  return open ? `"${open.name}" (still open when it ended)` : null;
}

/** Artifact names as safe, distinct file names. */
export function fileNames(names) {
  const seen = new Map();
  return names.map((raw) => {
    let base = path.posix.basename(String(raw || '').replace(/\\/g, '/')).replace(/[<>:"|?*\x00-\x1f]/g, '_');
    if (!base || base === '.' || base === '..') base = 'artifact';
    const n = (seen.get(base.toLowerCase()) || 0) + 1;
    seen.set(base.toLowerCase(), n);
    if (n === 1) return base;
    const ext = path.posix.extname(base);
    return `${base.slice(0, base.length - ext.length)} (${n})${ext}`;
  });
}

/** The token goes to codemagic.io over https and nowhere else. */
export function sendsToken(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && (u.hostname === 'codemagic.io' || u.hostname.endsWith('.codemagic.io'));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function finishPlan(ctx, args, problems) {
  if (problems.length) {
    ctx.say('');
    ctx.say(`Refused, nothing started (${problems.length} problem${problems.length === 1 ? '' : 's'}):`);
    for (const p of problems) ctx.say(`  - ${p}`);
    return EXIT.REFUSED;
  }
  if (args.opts['dry-run']) {
    ctx.say('');
    ctx.say('Dry run: nothing started.');
    return EXIT.OK;
  }
  if (!args.opts.yes) {
    ctx.say('');
    ctx.say('Nothing started: add --yes to make this call (--dry-run only prints it).');
    return EXIT.UNCONFIRMED;
  }
  return null;
}

async function runApps(api, args, ctx) {
  const found = await discoverApps(api);
  if (!found.apps.length) ctx.say('this token can see no apps');
  for (const a of found.apps) {
    ctx.say(`${a.id}  ${a.name}  (${a.teamName})${a.archived ? '  archived' : ''}`);
    if (a.repository) ctx.say(`    repository  ${a.repository}`);
    ctx.say(`    last build  ${a.lastBuildId || 'none'}`);
    try {
      const wfs = (await api.get(`/apps/${enc(a.id)}/workflows`)).data || [];
      ctx.say(`    workflows   ${wfs.length ? wfs.map((w) => `${w.id}${w.name && w.name !== w.id ? ` ("${w.name}")` : ''}`).join(', ') : 'none built yet'}`);
    } catch (e) {
      ctx.say(`    workflows   not readable (${e.status ? `HTTP ${e.status}` : e.message})`);
    }
  }
  for (const n of found.notes) ctx.warn(`cm: could not read ${n}`);
  return found.notes.length ? EXIT.API : EXIT.OK;
}

/** A team's builds, held to the one app even if the filter were ignored. */
const ofApp = (j, app) => (Array.isArray(j.data) ? j.data : []).filter((b) => !b.app_id || b.app_id === app.id);

async function runRecent(api, args, ctx) {
  const app = chooseApp(await discoverApps(api), args.opts.app || ctx.env.CODEMAGIC_APP_ID);
  const now = ctx.now();
  if (!app.teamId) {
    // Listing builds is a team call. An app that no visible team holds still
    // names its last build, so that one is shown.
    ctx.say(`${app.name} (${app.id}) is in none of the teams this token can see, so only its last build is listed.`);
    if (!app.lastBuildId) {
      ctx.say('no builds');
      return EXIT.OK;
    }
    ctx.say(buildRow(await getBuild(api, app.lastBuildId), now));
    return EXIT.OK;
  }
  const j = await api.get(`/teams/${enc(app.teamId)}/builds?app_id=${enc(app.id)}&page_size=${args.opts.limit}`);
  const builds = ofApp(j, app)
    .sort((a, b) => (parseTime(b.created_at) || 0) - (parseTime(a.created_at) || 0))
    .slice(0, args.opts.limit);
  ctx.say(`${app.name}: ${builds.length ? `the last ${builds.length} build${builds.length === 1 ? '' : 's'}, newest first` : 'no builds'}`);
  for (const b of builds) ctx.say(buildRow(b, now));
  return EXIT.OK;
}

const sameWorkflow = (b, wf) => Boolean(b.workflow) && (b.workflow.id === wf.key || (Boolean(wf.name) && b.workflow.name === wf.name));

/** Builds of this workflow and branch that have not ended yet. */
async function runningBuilds(api, app, wf, branch) {
  const match = (b) => b && RUNNING.has(b.status) && sameWorkflow(b, wf) && b.branch === branch;
  if (app.teamId) {
    const j = await api.get(`/teams/${enc(app.teamId)}/builds?app_id=${enc(app.id)}&page_size=20`);
    const builds = ofApp(j, app);
    return { checked: `the last ${builds.length} build${builds.length === 1 ? '' : 's'}`, running: builds.filter(match) };
  }
  if (app.lastBuildId) {
    const b = await getBuild(api, app.lastBuildId);
    return { checked: 'its last build', running: match(b) ? [b] : [] };
  }
  return { checked: 'nothing: the app has no builds yet', running: [] };
}

async function runStart(api, args, ctx, local) {
  const wf = local.workflow;
  const branch = args.opts.branch;
  const app = chooseApp(await discoverApps(api), args.opts.app || ctx.env.CODEMAGIC_APP_ID);
  const body = { workflow_id: wf.key, branch };
  const now = ctx.now();
  ctx.say('Start a Codemagic build:');
  ctx.say(`  app       ${app.name} (${app.id}), ${app.teamName}`);
  ctx.say(`  workflow  ${wf.key}${wf.name ? ` ("${wf.name}" in codemagic.yaml)` : ''}`);
  ctx.say(`  branch    ${branch}`);
  const problems = [];
  const { checked, running } = await runningBuilds(api, app, wf, branch);
  if (!running.length) ctx.say(`  running   none of ${wf.key} on ${branch} (checked ${checked})`);
  for (const b of running) {
    const line = `build ${num(b)} of ${wf.key} on ${branch} is already ${b.status} (${b.id}, queued ${fmtTime(parseTime(b.created_at))})`;
    ctx.say(`  running   ${line}`);
    if (!args.opts['even-if-running']) problems.push(`${line}. "wait ${b.id}" follows it; --even-if-running starts another anyway.`);
  }
  ctx.say('  uses      Mac build minutes');
  ctx.say('');
  ctx.say('Call:');
  ctx.say(`  POST ${API_BASE}/apps/${app.id}/builds ${JSON.stringify(body)}`);
  const fin = finishPlan(ctx, args, problems);
  if (fin !== null) return fin;

  const j = await api.post(`/apps/${enc(app.id)}/builds`, body);
  const id = j.data && j.data.id;
  if (!id) throw new CmError(`POST /apps/${app.id}/builds answered without a build id`);
  ctx.say('');
  ctx.say(`Started build ${id} at ${fmtTime(now.getTime())}. Codemagic has accepted it; it queues before it runs.`);
  ctx.say(`  follow it   node tools/codemagic/cm.mjs wait ${id}`);
  ctx.say(`  its page    ${SITE}/app/${app.id}/build/${id}`);
  return EXIT.OK;
}

async function runStatus(api, args, ctx) {
  const b = await getBuild(api, args.id);
  for (const line of describeBuild(b, ctx.now())) ctx.say(line);
  if (b.status === 'failed' || b.status === 'timeout') {
    let step;
    try {
      step = await failedStep(api, b.id);
    } catch (e) {
      step = `(the steps are not readable: ${e.status ? `HTTP ${e.status}` : e.message})`;
    }
    if (step) ctx.say(`  stopped at  ${step}`);
  }
  ctx.say(`  page        ${SITE}/app/${b.app_id}/build/${b.id}`);
  return EXIT.OK;
}

async function runWait(api, args, ctx) {
  const everyMs = args.opts.every * 1000;
  const began = ctx.now().getTime();
  const deadline = began + args.opts.timeout * 60000;
  ctx.say(`Waiting for build ${args.id}: a check every ${args.opts.every} s, for at most ${args.opts.timeout} min.`);
  let last = null;
  let failures = 0;
  let b = null;
  for (;;) {
    try {
      const first = b === null;
      b = await getBuild(api, args.id);
      failures = 0;
      if (b.status !== last) {
        ctx.say(`${fmtClock(ctx.now())}  ${b.status}${first && b.index != null ? `  (build #${b.index})` : ''}`);
        last = b.status;
      }
      if (ENDED.has(b.status)) break;
    } catch (e) {
      const young = ctx.now().getTime() - began < NOT_YET_VISIBLE_MS;
      if (e instanceof CmError && e.status === 404 && young && b === null) {
        if (last !== 'not visible yet') ctx.say(`${fmtClock(ctx.now())}  not visible yet (Codemagic shows a new build after a short while)`);
        last = 'not visible yet';
      } else if (e instanceof CmError && (e.status === null || e.status === 429 || e.status >= 500) && failures + 1 < MAX_FAILED_CHECKS) {
        // Not the build's own outcome, so not a reason to stop following it.
        failures += 1;
        ctx.warn(`cm: ${e.message}; checking again`);
      } else {
        throw e;
      }
    }
    if (ctx.now().getTime() + everyMs > deadline) {
      ctx.say('');
      ctx.say(`${b ? summaryLine(b, ctx.now()) : `build ${args.id} is not visible`}, and --timeout ${args.opts.timeout} min is up. `
        + 'Nothing was canceled; wait again to keep following it.');
      return EXIT.STILL_RUNNING;
    }
    await ctx.sleep(everyMs);
  }
  ctx.say('');
  ctx.say(summaryLine(b, ctx.now()));
  if (b.status === 'finished') return EXIT.OK;
  if (b.status === 'failed' || b.status === 'timeout') {
    try {
      const step = await failedStep(api, b.id);
      if (step) ctx.say(`  stopped at  ${step}`);
    } catch { /* the summary line above is the answer; the step is extra */ }
  }
  ctx.say(`  its page    ${SITE}/app/${b.app_id}/build/${b.id}`);
  return EXIT.ENDED_BADLY;
}

async function runArtifacts(api, args, ctx) {
  const b = await getBuild(api, args.id);
  const list = Array.isArray(b.artifacts) ? b.artifacts : [];
  const names = fileNames(list.map((a) => a.name));
  ctx.say(`build ${num(b)} ${b.status}: ${list.length ? `${list.length} artifact${list.length === 1 ? '' : 's'}` : 'no artifacts'}`);
  const width = Math.min(48, Math.max(0, ...names.map((n) => n.length)));
  list.forEach((a, i) => {
    const version = a.version_name ? `  version ${a.version_name}${a.version_code ? ` (${a.version_code})` : ''}` : '';
    ctx.say(`  ${names[i].padEnd(width)}  ${String(a.type || '?').padEnd(6)} ${fmtBytes(a.size_in_bytes).padStart(9)}${version}`);
  });
  if (!args.opts.download || !list.length) return EXIT.OK;

  const outDir = path.resolve(ctx.cwd, args.opts.out || `codemagic-${b.id}`);
  const targets = names.map((n) => path.join(outDir, n));
  const clash = targets.filter((t) => ctx.fs.existsSync(t));
  if (clash.length) throw new RefusedError(`nothing downloaded: already there: ${clash.join(', ')}. Move them, or pick another --out.`);
  for (const a of list) {
    if (!a.short_lived_download_url || !/^https:/i.test(a.short_lived_download_url)) {
      throw new RefusedError(`nothing downloaded: ${a.name} has no https download address`);
    }
  }
  ctx.fs.mkdirSync(outDir, { recursive: true });
  for (let i = 0; i < list.length; i += 1) {
    const a = list[i];
    const url = a.short_lived_download_url;
    let res;
    try {
      res = await ctx.fetchImpl(url, {
        headers: sendsToken(url) ? { 'x-auth-token': ctx.token } : {},
        signal: timeoutSignal(15 * 60 * 1000),
      });
    } catch (e) {
      throw new CmError(`download of ${a.name}: ${e.message}`);
    }
    if (!res.ok) throw new CmError(`download of ${a.name} -> HTTP ${res.status}`, res.status);
    const buf = Buffer.from(await res.arrayBuffer());
    if (Number.isFinite(a.size_in_bytes) && a.size_in_bytes > 0 && buf.length !== a.size_in_bytes) {
      throw new CmError(`download of ${a.name}: ${buf.length} bytes arrived and Codemagic lists ${a.size_in_bytes}; it was not saved`);
    }
    const part = `${targets[i]}.part`;
    ctx.fs.writeFileSync(part, buf);
    ctx.fs.renameSync(part, targets[i]);
    ctx.say(`saved ${targets[i]} (${fmtBytes(buf.length)})`);
  }
  return EXIT.OK;
}

const RUNNERS = {
  apps: runApps,
  recent: runRecent,
  start: runStart,
  status: runStatus,
  wait: runWait,
  artifacts: runArtifacts,
};

/**
 * deps (tests): { env, home, fetch, stdout, stderr, sleep, now, fs, cwd, yamlText }.
 * Returns the exit code.
 */
export async function main(argv, deps = {}) {
  const out = deps.stdout || ((s) => process.stdout.write(`${s}\n`));
  const errOut = deps.stderr || ((s) => process.stderr.write(`${s}\n`));
  let redact = (s) => String(s);
  const ctx = {
    say: (s = '') => out(redact(s)),
    warn: (s) => errOut(redact(s)),
    sleep: deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms))),
    now: deps.now || (() => new Date()),
    fetchImpl: deps.fetch || globalThis.fetch,
    fs: deps.fs || fs,
    env: deps.env || process.env,
    cwd: deps.cwd || process.cwd(),
    yamlPath: YAML_PATH,
    readYaml: () => (deps.yamlText !== undefined ? deps.yamlText : fs.readFileSync(YAML_PATH, 'utf8')),
    token: null,
  };
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    ctx.warn(`cm: ${e.message}`);
    ctx.warn('Run with --help for the commands.');
    return EXIT.USAGE;
  }
  if (args.command === 'help') {
    ctx.say(HELP);
    return EXIT.OK;
  }
  try {
    // Local inputs are checked before the token is read or any call is made.
    const local = args.command === 'start' ? checkStartLocally(args, ctx) : null;
    if (typeof ctx.fetchImpl !== 'function') throw new UsageError('this needs Node 18 or later (no global fetch here)');
    const { token } = loadToken({ env: ctx.env, tokenFile: args.opts['token-file'], home: deps.home, readFile: ctx.fs.readFileSync, exists: ctx.fs.existsSync });
    redact = makeRedactor([token]);
    ctx.token = token;
    const api = makeClient({ fetchImpl: ctx.fetchImpl, token, sleep: ctx.sleep });
    return await RUNNERS[args.command](api, args, ctx, local);
  } catch (e) {
    if (e instanceof UsageError) {
      ctx.warn(`cm: ${e.message}`);
      return EXIT.USAGE;
    }
    if (e instanceof RefusedError) {
      ctx.warn(`cm: ${e.message}`);
      return EXIT.REFUSED;
    }
    ctx.warn(`cm: ${e instanceof CmError ? e.message : (e.stack || e.message)}`);
    return EXIT.API;
  }
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  const a = path.resolve(process.argv[1]);
  const b = fileURLToPath(import.meta.url);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
})();
if (isMain) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
