#!/usr/bin/env node
/**
 * tools/asc/asc.mjs: App Store Connect from the command line.
 *
 *   node tools/asc/asc.mjs status
 *   node tools/asc/asc.mjs metadata get --version 1.0.1
 *   node tools/asc/asc.mjs screenshots list --version 1.0.1
 *   node tools/asc/asc.mjs screenshots replace --dir <folder> --version 1.0.1 --dry-run
 *   node tools/asc/asc.mjs review cancel --version 1.0.1 --dry-run
 *   node tools/asc/asc.mjs review submit --version 1.0.1 --dry-run
 *   node tools/asc/asc.mjs builds list
 *
 * Plain Node 18 or later: the global fetch, and node:crypto for the ES256 token
 * (mintAscJwt in ../asc-upload/lib.mjs). No packages. README.md beside this
 * file has the rules; in short:
 *
 *  - Credentials come from ASC_KEY_PATH, ASC_KEY_ID, ASC_ISSUER_ID and
 *    ASC_APP_ID, or from a JSON file kept outside the repository (keyPath,
 *    keyId, issuerId, appId). No line this prints carries the key or those
 *    three ids: they are masked as {keyId}, {issuerId} and {appId}.
 *  - Every write takes --dry-run, which prints the exact calls and makes none.
 *    A write without --yes prints the same plan and stops: nothing is ever
 *    asked interactively, and nothing is written unless --yes is given.
 *  - Exit codes: 0 done, 1 an API call failed, 2 usage or configuration,
 *    3 refused before any write (a check failed, nothing changed), 4 a write
 *    that was not confirmed with --yes (nothing changed).
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import { APPLE_LIMITS, mintAscJwt } from '../asc-upload/lib.mjs';

export const API_BASE = 'https://api.appstoreconnect.apple.com';
export const EXIT = Object.freeze({ OK: 0, API: 1, USAGE: 2, REFUSED: 3, UNCONFIRMED: 4 });

// Apple refuses an eleventh screenshot in a set ("has already 10
// appScreenshots"), so a set holds at most ten at any moment.
export const MAX_SHOTS_PER_SET = 10;
const POLL_MS = 2000;
// Five minutes a screenshot. On 2026-10-20 one upload was still processing
// after the 90 seconds an earlier script allowed.
const MAX_POLLS = 150;

// Version states in which a version's listing and screenshots can change.
export const EDITABLE_STATES = new Set(['PREPARE_FOR_SUBMISSION', 'DEVELOPER_REJECTED', 'REJECTED', 'METADATA_REJECTED']);
const SUBMITTABLE_STATES = new Set([...EDITABLE_STATES, 'READY_FOR_REVIEW']);
const LIVE_STATES = new Set(['READY_FOR_SALE', 'READY_FOR_DISTRIBUTION', 'REPLACED_WITH_NEW_INFO']);
// Apple's help: a submission can be removed from review while it waits, while
// it is in review, and (as a submission with unresolved issues) after a
// rejection. The version becomes DEVELOPER_REJECTED.
export const CANCELABLE_STATES = ['WAITING_FOR_REVIEW', 'IN_REVIEW', 'UNRESOLVED_ISSUES'];
const OPEN_SUBMISSION_STATES = ['READY_FOR_REVIEW', 'WAITING_FOR_REVIEW', 'IN_REVIEW', 'UNRESOLVED_ISSUES', 'CANCELING', 'COMPLETING'];

/* Apple's accepted screenshot sizes per display type, from
   developer.apple.com/help/app-store-connect/reference/screenshot-specifications
   (read 2026-11-05), matched to the API's ScreenshotDisplayType names. The
   numbers in those names are old: APP_IPHONE_67 is the 6.9-inch class
   (1260x2736, 1290x2796, 1320x2868), APP_IPHONE_61 the 6.3-inch Dynamic
   Island class and APP_IPHONE_58 the 6.1-inch Face ID class. Portrait and
   landscape are both listed; the old "no status bar" sizes are not plain
   transposes, so those types list each pair as Apple prints it. */
const both = (...portrait) => portrait.flatMap(([w, h]) => [[w, h], [h, w]]);
export const ACCEPTED_SIZES = Object.freeze({
  APP_IPHONE_67: both([1260, 2736], [1290, 2796], [1320, 2868]),
  APP_IPHONE_65: both([1242, 2688], [1284, 2778]),
  APP_IPHONE_61: both([1179, 2556], [1206, 2622]),
  APP_IPHONE_58: both([1080, 2340], [1125, 2436], [1170, 2532]),
  APP_IPHONE_55: both([1242, 2208]),
  APP_IPHONE_47: both([750, 1334]),
  APP_IPHONE_40: [[640, 1096], [640, 1136], [1136, 600], [1136, 640]],
  APP_IPHONE_35: [[640, 920], [640, 960], [960, 600], [960, 640]],
  APP_IPAD_PRO_3GEN_129: both([2064, 2752], [2048, 2732]),
  APP_IPAD_PRO_129: both([2048, 2732]),
  APP_IPAD_PRO_3GEN_11: both([1488, 2266], [1512, 2316], [1668, 2420], [1668, 2388], [1640, 2360]),
  APP_IPAD_105: both([1668, 2224]),
  APP_IPAD_97: [[1536, 2008], [1536, 2048], [768, 1004], [768, 1024], [2048, 1496], [2048, 1536], [1024, 748], [1024, 768]],
});
export const DEFAULT_DISPLAY_TYPE = 'APP_IPHONE_67';

/* The listing fields, and where Apple keeps each: name and subtitle on the
   app info localization (one per app info, which follows the version being
   prepared), the rest on the version's localization. Promotional text is the
   one field Apple lets change on a version in any state. */
export const FIELDS = Object.freeze({
  name: { home: 'appInfo', max: APPLE_LIMITS.name },
  subtitle: { home: 'appInfo', max: APPLE_LIMITS.subtitle },
  promotionalText: { home: 'version', max: APPLE_LIMITS.promotionalText, anyState: true },
  description: { home: 'version', max: APPLE_LIMITS.description },
  keywords: { home: 'version', max: APPLE_LIMITS.keywords },
  whatsNew: { home: 'version', max: APPLE_LIMITS.whatsNew },
  supportUrl: { home: 'version', url: true },
  marketingUrl: { home: 'version', url: true },
});

export class UsageError extends Error {}
/** A check failed before anything was written. */
export class RefusedError extends Error {}
export class AscError extends Error {
  constructor(message, status = null, errors = null) {
    super(message);
    this.status = status;
    this.errors = errors;
  }
}

export const HELP = `asc: App Store Connect for this app, from the command line.

Read only:
  status                                  versions, review submissions, builds, subscriptions
  metadata get [--version V] [--locale en-US] [--json]
  screenshots list [--version V] [--locale L] [--display-type T]
  screenshots backup --version V --out <folder> [--locale L] [--display-type T]
                                          saves the set's current images (local files only)
  builds list [--limit N] [--version V]

Writes (each prints its exact calls; --dry-run stops there, --yes makes them):
  metadata set --version V [--locale en-US] --<field> <text> | --<field>-file <path> | --from-json <file>
      fields: name, subtitle, promotional-text, description, keywords, whats-new, support-url, marketing-url
  screenshots replace --dir <folder> --version V [--display-type ${DEFAULT_DISPLAY_TYPE}] [--locale all|en-US,...]
                      [--make-room] [--backup-dir <folder>]
  review cancel --version V [--wait seconds]
  review submit --version V [--wait seconds]

Options: --config <file>  --dry-run  --yes  --help
Credentials: ASC_KEY_PATH, ASC_KEY_ID, ASC_ISSUER_ID, ASC_APP_ID, or a JSON file
  (ASC_CONFIG or --config; default ${path.join('~', 'OneDrive', 'Documents', 'Flock', 'Apple-Review', 'asc-config.json')}).
Exit codes: 0 done, 1 an API call failed, 2 usage or configuration,
  3 refused before any write, 4 not confirmed (add --yes).`;

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

const VALUE_OPTIONS = new Set(['config', 'version', 'locale', 'dir', 'display-type', 'backup-dir', 'out', 'limit', 'wait', 'from-json']);
const FLAG_OPTIONS = new Set(['dry-run', 'yes', 'make-room', 'json', 'help']);
const SPEC = {
  status: { '': [] },
  metadata: {
    get: ['version', 'locale', 'json'],
    set: ['version', 'locale', 'from-json', 'dry-run', 'yes'],
  },
  screenshots: {
    list: ['version', 'locale', 'display-type'],
    backup: ['version', 'locale', 'display-type', 'out'],
    replace: ['dir', 'version', 'display-type', 'locale', 'make-room', 'backup-dir', 'dry-run', 'yes'],
  },
  review: {
    cancel: ['version', 'wait', 'dry-run', 'yes'],
    submit: ['version', 'wait', 'dry-run', 'yes'],
  },
  builds: { list: ['limit', 'version'] },
};
const WRITES = new Set(['metadata set', 'screenshots replace', 'review cancel', 'review submit']);
const REQUIRED = {
  'metadata set': ['version'],
  'screenshots replace': ['dir', 'version'],
  'screenshots backup': ['version', 'out'],
  'review cancel': ['version'],
  'review submit': ['version'],
};

/** --whats-new, --whatsNew and --whats-new-file all name whatsNew. */
export function fieldForFlag(flag) {
  let name = flag;
  let fromFile = false;
  if (/-file$/i.test(name)) {
    fromFile = true;
    name = name.slice(0, -5);
  }
  const key = name.replace(/-/g, '').toLowerCase();
  const field = Object.keys(FIELDS).find((f) => f.toLowerCase() === key);
  return field ? { field, fromFile } : null;
}

export function parseArgs(argv) {
  const words = [];
  const opts = {};
  const fields = {};
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
      opts[flag] = true;
      continue;
    }
    const field = fieldForFlag(flag);
    if (!field && !VALUE_OPTIONS.has(flag)) throw new UsageError(`unknown option --${flag}`);
    if (value === undefined) {
      value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new UsageError(`--${flag} needs a value`);
      i += 1;
    }
    if (field) {
      if (fields[field.field]) throw new UsageError(`${field.field} is given twice`);
      fields[field.field] = field.fromFile ? { file: value } : { value };
      continue;
    }
    if (opts[flag] !== undefined) throw new UsageError(`--${flag} is given twice`);
    opts[flag] = value;
  }

  if (opts.help || words.length === 0 || words[0] === 'help') return { command: 'help', sub: '', name: 'help', opts, fields, write: false };
  const [command, maybeSub, ...rest] = words;
  const spec = SPEC[command];
  if (!spec) throw new UsageError(`unknown command "${command}"`);
  let sub = '';
  if (spec['']) {
    if (maybeSub !== undefined) rest.unshift(maybeSub);
  } else {
    sub = maybeSub;
    if (!sub || !spec[sub]) throw new UsageError(`"${command}" takes one of: ${Object.keys(spec).join(', ')}`);
  }
  if (rest.length) throw new UsageError(`unexpected "${rest[0]}"`);
  const name = sub ? `${command} ${sub}` : command;
  const allowed = new Set(['config', 'help', ...spec[sub]]);
  for (const k of Object.keys(opts)) {
    if (!allowed.has(k)) throw new UsageError(`--${k} does not apply to "${name}"`);
  }
  if (Object.keys(fields).length && name !== 'metadata set') throw new UsageError('field options apply only to "metadata set"');
  for (const k of REQUIRED[name] || []) {
    if (opts[k] === undefined) throw new UsageError(`"${name}" needs --${k}`);
  }
  if (name === 'metadata set' && !Object.keys(fields).length && !opts['from-json']) {
    throw new UsageError('"metadata set" needs at least one field, e.g. --whats-new "..." or --description-file notes.txt');
  }
  if (opts['display-type'] !== undefined && name !== 'screenshots list' && !ACCEPTED_SIZES[opts['display-type']]) {
    throw new UsageError(`--display-type ${opts['display-type']} is not one this tool has Apple's sizes for (${Object.keys(ACCEPTED_SIZES).join(', ')})`);
  }
  for (const [k, lo, hi] of [['limit', 1, 200], ['wait', 0, 3600]]) {
    if (opts[k] === undefined) continue;
    if (!/^\d+$/.test(opts[k]) || Number(opts[k]) < lo || Number(opts[k]) > hi) {
      throw new UsageError(`--${k} takes a whole number from ${lo} to ${hi}`);
    }
    opts[k] = Number(opts[k]);
  }
  if (opts.locale !== undefined && !/^(all|[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*(,[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*)*)$/.test(opts.locale)) {
    throw new UsageError(`--locale takes "all" or locale codes such as en-US or en-US,en-GB, not "${opts.locale}"`);
  }
  return { command, sub, name, opts, fields, write: WRITES.has(name) };
}

/** null means every localization. */
export function parseLocales(value) {
  if (value === undefined || value === 'all') return null;
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Configuration and output
// ---------------------------------------------------------------------------

export function defaultConfigPath(home = os.homedir()) {
  return path.join(home, 'OneDrive', 'Documents', 'Flock', 'Apple-Review', 'asc-config.json');
}

const stripBom = (s) => String(s).replace(/^﻿/, '');

/**
 * Each value comes from its environment variable when set, else from the JSON
 * file (--config, else ASC_CONFIG, else the default path). The key is read
 * here and never printed; neither is its path, which carries the key id.
 */
export function loadConfig({ env = process.env, configPath, home, readFile = fs.readFileSync, exists = fs.existsSync } = {}) {
  const explicit = configPath || env.ASC_CONFIG;
  const file = explicit || defaultConfigPath(home);
  const allFromEnv = env.ASC_KEY_PATH && env.ASC_KEY_ID && env.ASC_ISSUER_ID && env.ASC_APP_ID;
  let fromFile = {};
  // With all four in the environment the default file is not read at all; a
  // file named outright must exist.
  if (explicit || !allFromEnv) {
    if (exists(file)) {
      try {
        fromFile = JSON.parse(stripBom(readFile(file, 'utf8')));
      } catch (e) {
        throw new UsageError(`the config file ${file} is not valid JSON (${e.message})`);
      }
    } else if (explicit) {
      throw new UsageError(`no config file at ${file}`);
    }
  }
  const cfg = {
    keyPath: env.ASC_KEY_PATH || fromFile.keyPath,
    keyId: env.ASC_KEY_ID || fromFile.keyId,
    issuerId: env.ASC_ISSUER_ID || fromFile.issuerId,
    appId: env.ASC_APP_ID || fromFile.appId,
  };
  const names = { keyPath: 'ASC_KEY_PATH', keyId: 'ASC_KEY_ID', issuerId: 'ASC_ISSUER_ID', appId: 'ASC_APP_ID' };
  const missing = Object.keys(names).filter((k) => !cfg[k]).map((k) => `${k} (${names[k]})`);
  if (missing.length) throw new UsageError(`missing ${missing.join(', ')}: set them in the environment or in ${file}`);
  if (!exists(cfg.keyPath)) throw new UsageError(`the key file named by keyPath (${names.keyPath}) does not exist`);
  cfg.appId = String(cfg.appId);
  cfg.keyPem = readFile(cfg.keyPath, 'utf8');
  return cfg;
}

/** Masks the app id, key id and issuer id wherever they would be printed. */
export function makeRedactor(cfg) {
  const pairs = [[cfg.appId, '{appId}'], [cfg.keyId, '{keyId}'], [cfg.issuerId, '{issuerId}']]
    .filter(([v]) => v && String(v).length >= 4)
    .map(([v, r]) => [String(v), r]);
  return (text) => {
    let s = String(text);
    for (const [v, r] of pairs) s = s.split(v).join(r);
    return s;
  };
}

function tokenSource(cfg) {
  let token = null;
  let mintedAt = 0;
  return () => {
    // Apple caps a token at 20 minutes; a fresh one every 10 is plenty.
    if (!token || Date.now() - mintedAt > 10 * 60 * 1000) {
      token = mintAscJwt({ privateKeyPem: cfg.keyPem, keyId: cfg.keyId, issuerId: cfg.issuerId });
      mintedAt = Date.now();
    }
    return token;
  };
}

const timeoutSignal = (ms) => (typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined);

/** The API client. GETs retry twice on 429 and 5xx; writes are never retried. */
export function makeClient({ fetchImpl, token, sleep, base = API_BASE }) {
  async function request(method, p, body) {
    const retries = method === 'GET' ? 2 : 0;
    for (let attempt = 0; ; attempt += 1) {
      const res = await fetchImpl(base + p, {
        method,
        headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: timeoutSignal(60000),
      });
      const text = await res.text();
      let json = null;
      if (text) {
        try { json = JSON.parse(text); } catch { json = null; }
      }
      if (res.ok) return json || {};
      if (attempt < retries && (res.status === 429 || res.status >= 500)) {
        await sleep(2000 * (attempt + 1));
        continue;
      }
      const detail = json && Array.isArray(json.errors)
        ? json.errors.map((e) => [e.code, e.detail || e.title].filter(Boolean).join(': ')).join('; ')
        : text.slice(0, 300);
      throw new AscError(`${method} ${p} -> HTTP ${res.status}${detail ? `: ${detail}` : ''}`, res.status, json && json.errors);
    }
  }
  async function getAll(p) {
    const data = [];
    const included = [];
    let next = p;
    for (let page = 0; next && page < 50; page += 1) {
      const j = await request('GET', next);
      data.push(...(j.data || []));
      included.push(...(j.included || []));
      const link = j.links && j.links.next;
      next = link && link.startsWith(base) ? link.slice(base.length) : null;
    }
    return { data, included };
  }
  return {
    get: (p) => request('GET', p),
    post: (p, b) => request('POST', p, b),
    patch: (p, b) => request('PATCH', p, b),
    del: (p) => request('DELETE', p),
    getAll,
  };
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
const PNG_COLOUR = { 0: 'grey', 2: 'RGB', 3: 'palette', 4: 'grey+alpha', 6: 'RGBA' };

/** Size, format, alpha and colour tagging, from the file's own headers. */
export function inspectImage(buf) {
  if (buf.length >= 33 && buf.subarray(0, 8).equals(PNG_SIG)) {
    if (buf.toString('latin1', 12, 16) !== 'IHDR') return { format: 'png', problems: ['PNG with no IHDR chunk'] };
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    const bitDepth = buf[24];
    const colourType = buf[25];
    const chunks = new Set();
    let icc = null;
    for (let off = 8; off + 8 <= buf.length;) {
      const len = buf.readUInt32BE(off);
      const type = buf.toString('latin1', off + 4, off + 8);
      chunks.add(type);
      if (type === 'iCCP') {
        // Profile name, a NUL, the compression method (0 = zlib), the profile.
        const data = buf.subarray(off + 8, off + 8 + len);
        const nul = data.indexOf(0);
        icc = { name: data.subarray(0, nul === -1 ? Math.min(data.length, 79) : nul).toString('latin1'), srgb: false };
        if (nul !== -1 && data[nul + 1] === 0) {
          try {
            const profile = inflateSync(data.subarray(nul + 2));
            icc.srgb = profile.includes(Buffer.from('sRGB', 'latin1')) || profile.includes(Buffer.from('\0s\0R\0G\0B', 'latin1'));
          } catch { /* an unreadable profile is reported by name only */ }
        }
      }
      if (type === 'IDAT' || type === 'IEND') break;
      off += 12 + len;
    }
    const alpha = colourType === 4 || colourType === 6 || chunks.has('tRNS');
    const colourSpace = chunks.has('sRGB') ? 'sRGB'
      : icc ? (icc.srgb ? 'sRGB (ICC profile)' : `ICC profile "${icc.name}"`)
        : 'untagged (read as sRGB)';
    return {
      format: 'png', width, height, alpha, colourSpace,
      detail: `PNG ${PNG_COLOUR[colourType] || `colour type ${colourType}`} ${bitDepth}-bit`,
      problems: [],
    };
  }
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    for (let off = 2; off + 9 < buf.length;) {
      if (buf[off] !== 0xff) { off += 1; continue; }
      const marker = buf[off + 1];
      if (marker === 0xff) { off += 1; continue; }
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { off += 2; continue; }
      if (marker === 0xda || marker === 0xd9) break;
      const len = buf.readUInt16BE(off + 2);
      if (JPEG_SOF.has(marker)) {
        const components = buf[off + 9];
        return {
          format: 'jpeg', height: buf.readUInt16BE(off + 5), width: buf.readUInt16BE(off + 7), alpha: false,
          colourSpace: components === 4 ? 'CMYK' : components === 1 ? 'grey' : 'YCbCr',
          detail: `JPEG ${components} component(s)`,
          problems: components === 4 ? ['CMYK JPEG; export it as RGB'] : [],
        };
      }
      off += 2 + len;
    }
    return { format: 'jpeg', problems: ['JPEG with no frame header'] };
  }
  return { format: null, problems: ['not a PNG or JPEG file'] };
}

export const sizesText = (displayType) => ACCEPTED_SIZES[displayType].map(([w, h]) => `${w}x${h}`).join(', ');

/**
 * Every file against Apple's sizes for the display type, before any call.
 * files: [{ name, buf }]. Returns the per-file report and the problems.
 */
export function checkScreenshotFiles(files, displayType) {
  const problems = [];
  const accepted = ACCEPTED_SIZES[displayType];
  if (!accepted) problems.push(`no size table for ${displayType}`);
  if (!files.length) problems.push('the folder holds no numbered images (01-name.png, 02-name.png, ...)');
  if (files.length > MAX_SHOTS_PER_SET) problems.push(`${files.length} images, and a set holds at most ${MAX_SHOTS_PER_SET}`);
  const report = files.map((f) => {
    const info = inspectImage(f.buf);
    const own = [...info.problems];
    if (info.width && accepted && !accepted.some(([w, h]) => w === info.width && h === info.height)) {
      own.push(`${info.width}x${info.height} is not a ${displayType} size (${sizesText(displayType)})`);
    }
    if (info.alpha) own.push('has an alpha channel or transparency, which Apple refuses');
    if (!f.buf.length) own.push('is empty');
    for (const p of own) problems.push(`${f.name}: ${p}`);
    return {
      name: f.name, bytes: f.buf.length, md5: createHash('md5').update(f.buf).digest('hex'),
      width: info.width || null, height: info.height || null, detail: info.detail || info.format || '?',
      colourSpace: info.colourSpace || '?', alpha: !!info.alpha, ok: own.length === 0, problems: own, buf: f.buf,
    };
  });
  return { report, problems };
}

/** The numbered images in a folder, in filename order; anything else is listed as ignored. */
export function readScreenshotDir(dir, { readdir = fs.readdirSync, readFile = fs.readFileSync, exists = fs.existsSync } = {}) {
  if (!exists(dir)) throw new RefusedError(`no folder at ${dir}`);
  const files = [];
  const ignored = [];
  for (const e of readdir(dir, { withFileTypes: true })) {
    if (!e.isFile()) continue;
    if (/^\d/.test(e.name) && /\.(png|jpe?g)$/i.test(e.name)) files.push(e.name);
    else ignored.push(e.name);
  }
  files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return { files: files.map((name) => ({ name, buf: readFile(path.join(dir, name)) })), ignored: ignored.sort() };
}

// ---------------------------------------------------------------------------
// Reading App Store Connect
// ---------------------------------------------------------------------------

export const stateOf = (v) => (v && v.attributes ? v.attributes.appStoreState || v.attributes.appVersionState || null : null);
const infoState = (i) => i.attributes.appStoreState || i.attributes.state || null;
const enc = encodeURIComponent;

async function findVersion(api, cfg, versionString) {
  const j = await api.get(`/v1/apps/${cfg.appId}/appStoreVersions?filter[platform]=IOS&filter[versionString]=${enc(versionString)}&limit=1`);
  return (j.data && j.data[0]) || null;
}

async function resolveVersion(api, cfg, versionString) {
  if (versionString) {
    const v = await findVersion(api, cfg, versionString);
    if (!v) throw new RefusedError(`version ${versionString} does not exist for this app`);
    return v;
  }
  const all = (await api.get(`/v1/apps/${cfg.appId}/appStoreVersions?filter[platform]=IOS&limit=10`)).data || [];
  if (!all.length) throw new RefusedError('this app has no iOS versions');
  return [...all].sort((a, b) => String(b.attributes.createdDate || '').localeCompare(String(a.attributes.createdDate || '')))[0];
}

const toShot = (s) => {
  const a = s.attributes || {};
  return {
    id: s.id,
    fileName: a.fileName,
    fileSize: a.fileSize ?? null,
    checksum: a.sourceFileChecksum || null,
    state: (a.assetDeliveryState && a.assetDeliveryState.state) || 'UNKNOWN',
    width: (a.imageAsset && a.imageAsset.width) || null,
    height: (a.imageAsset && a.imageAsset.height) || null,
    templateUrl: (a.imageAsset && a.imageAsset.templateUrl) || null,
  };
};

/** [{ locale, localizationId, sets: [{ id, displayType, shots }] }] in locale order. */
async function loadScreenshotState(api, version, { locales = null, displayType = null } = {}) {
  const locs = (await api.getAll(`/v1/appStoreVersions/${version.id}/appStoreVersionLocalizations?limit=50`)).data;
  const out = [];
  for (const loc of [...locs].sort((a, b) => a.attributes.locale.localeCompare(b.attributes.locale))) {
    if (locales && !locales.includes(loc.attributes.locale)) continue;
    const sets = (await api.getAll(`/v1/appStoreVersionLocalizations/${loc.id}/appScreenshotSets?limit=50`)).data;
    const entries = [];
    for (const s of sets) {
      if (displayType && s.attributes.screenshotDisplayType !== displayType) continue;
      const shots = (await api.getAll(`/v1/appScreenshotSets/${s.id}/appScreenshots?limit=50`)).data.map(toShot);
      entries.push({ id: s.id, displayType: s.attributes.screenshotDisplayType, shots });
    }
    out.push({ locale: loc.attributes.locale, localizationId: loc.id, sets: entries });
  }
  return out;
}

/** The app info whose name and subtitle go with this version. */
async function appInfoFor(api, cfg, version) {
  const infos = (await api.get(`/v1/apps/${cfg.appId}/appInfos?limit=10`)).data || [];
  const live = LIVE_STATES.has(stateOf(version));
  const pick = infos.find((i) => {
    const st = infoState(i);
    return live ? LIVE_STATES.has(st) && st !== 'REPLACED_WITH_NEW_INFO' : !LIVE_STATES.has(st);
  });
  return pick ? { id: pick.id, state: infoState(pick) } : null;
}

async function loadListing(api, cfg, version, locale) {
  const vlocs = (await api.getAll(`/v1/appStoreVersions/${version.id}/appStoreVersionLocalizations?limit=50`)).data;
  const vloc = vlocs.find((l) => l.attributes.locale === locale) || null;
  const info = await appInfoFor(api, cfg, version);
  let iloc = null;
  if (info) {
    const ilocs = (await api.getAll(`/v1/appInfos/${info.id}/appInfoLocalizations?limit=50`)).data;
    iloc = ilocs.find((l) => l.attributes.locale === locale) || null;
  }
  const values = {};
  for (const [field, spec] of Object.entries(FIELDS)) {
    const src = spec.home === 'appInfo' ? iloc : vloc;
    values[field] = src ? (src.attributes[field] ?? null) : null;
  }
  return { vloc, info, iloc, values, locales: vlocs.map((l) => l.attributes.locale).sort() };
}

/** Review submissions for the platform, with the version each one carries. */
async function loadSubmissions(api, cfg, states) {
  const q = `/v1/reviewSubmissions?filter[app]=${cfg.appId}&filter[platform]=IOS`
    + `${states ? `&filter[state]=${states.join(',')}` : ''}`
    + '&include=appStoreVersionForReview&fields[reviewSubmissions]=state,submittedDate,platform,appStoreVersionForReview&limit=50';
  const subs = (await api.getAll(q)).data;
  const out = [];
  for (const s of subs) {
    let versionId = (s.relationships && s.relationships.appStoreVersionForReview && s.relationships.appStoreVersionForReview.data
      && s.relationships.appStoreVersionForReview.data.id) || null;
    let items = null;
    if (!versionId) {
      items = (await api.get(`/v1/reviewSubmissions/${s.id}/items?fields[reviewSubmissionItems]=state,appStoreVersion&limit=50`)).data || [];
      versionId = items.map((it) => it.relationships && it.relationships.appStoreVersion && it.relationships.appStoreVersion.data
        && it.relationships.appStoreVersion.data.id).find(Boolean) || null;
    }
    out.push({ id: s.id, state: s.attributes.state, submittedDate: s.attributes.submittedDate || null, versionId, items });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Planning (pure: these build the exact calls, and the dry run prints them)
// ---------------------------------------------------------------------------

const pos2 = (i) => String(i + 1).padStart(2, '0');
const short = (s, n = 70) => {
  const t = String(s ?? '').replace(/\s+/g, ' ');
  return t.length > n ? `${t.slice(0, n - 1)}...` : t;
};

/**
 * The replace plan. Phase order, across every set, is the safety rule:
 *   1. create a missing set;
 *   2. with --make-room only: save every old screenshot first;
 *   3. upload each new file (reserve, send, commit, wait for COMPLETE), and
 *      with --make-room delete one old screenshot just before each upload
 *      that Apple's cap of ten would otherwise refuse;
 *   4. only then delete the other old screenshots, put each set in filename
 *      order, and read it back.
 * A file already in the set (same name and MD5, uploaded or processing) is
 * kept, so a run that stopped part way resumes.
 */
export function planScreenshotReplace({ version, localizations, wantLocales = null, displayType, files, makeRoom = false, backupDir }) {
  const problems = [];
  const vs = version.attributes.versionString;
  const st = stateOf(version);
  if (!EDITABLE_STATES.has(st)) {
    problems.push(`version ${vs} is ${st}: its screenshots change only while it is editable (${[...EDITABLE_STATES].join(', ')}).`
      + `${CANCELABLE_STATES.includes(st) ? ` "review cancel --version ${vs}" takes it out of review first.` : ''}`);
  }
  for (const want of wantLocales || []) {
    if (!localizations.some((l) => l.locale === want)) problems.push(`version ${vs} has no ${want} localization`);
  }
  const sets = [];
  for (const loc of localizations) {
    if (wantLocales && !wantLocales.includes(loc.locale)) continue;
    const set = loc.sets.find((s) => s.displayType === displayType) || null;
    const live = set ? set.shots : [];
    const keep = new Map();
    const old = [];
    for (const shot of live) {
      const f = files.find((x) => x.name === shot.fileName && x.md5 === shot.checksum);
      if (f && !keep.has(f.name) && (shot.state === 'COMPLETE' || shot.state === 'UPLOAD_COMPLETE')) keep.set(f.name, shot);
      else old.push(shot);
    }
    const upload = files.filter((f) => !keep.has(f.name));
    const room = MAX_SHOTS_PER_SET - live.length;
    const mustFree = Math.max(0, upload.length - room);
    const inOrder = live.length === files.length && live.every((s, i) => keep.get(files[i].name) === s && s.state === 'COMPLETE');
    const entry = {
      locale: loc.locale, localizationId: loc.localizationId, setId: set ? set.id : null, live, keep, old, upload,
      mustFree, freeEarly: [], backup: [], deleteLater: [], unchanged: inOrder && !upload.length && !old.length,
    };
    if (mustFree > 0 && !makeRoom) {
      problems.push(`${loc.locale}: the ${displayType} set holds ${live.length} and Apple caps a set at ${MAX_SHOTS_PER_SET}, `
        + `so the ${upload.length} new screenshot(s) fit only if ${mustFree} old one(s) go first. --make-room saves every old `
        + `screenshot to ${backupDir}, then deletes an old one only when the next upload would not fit (${mustFree} in all), `
        + 'and the rest only after every new one is COMPLETE.');
    }
    if (makeRoom && mustFree > 0) {
      entry.backup = old;
      for (const s of old) {
        if (!s.templateUrl || !s.width || !s.height) problems.push(`${loc.locale}: ${s.fileName} has no image to save, so --make-room cannot back it up`);
      }
    }
    // Under the cap, one old screenshot goes just before each upload that
    // would not fit, taken from the end of the live order, so a stop part way
    // has cost no more old ones than new ones have landed.
    const spare = [...old];
    let slots = room;
    entry.uploadPlan = upload.map((file) => {
      if (slots > 0 || !makeRoom) {
        slots -= 1;
        return { file, free: null };
      }
      return { file, free: spare.pop() };
    });
    entry.freeEarly = entry.uploadPlan.map((u) => u.free).filter(Boolean);
    entry.deleteLater = old.filter((s) => !entry.freeEarly.includes(s));
    sets.push(entry);
  }

  const steps = [];
  const active = sets.filter((s) => !s.unchanged);
  for (const s of active) if (!s.setId) steps.push({ kind: 'create-set', locale: s.locale, localizationId: s.localizationId, displayType });
  for (const s of active) {
    s.backup.forEach((shot, i) => {
      const base = String(shot.fileName || shot.id).replace(/\.[A-Za-z0-9]+$/, '');
      steps.push({ kind: 'backup', locale: s.locale, shot, to: path.join(backupDir, s.locale, `${pos2(s.live.indexOf(shot) >= 0 ? s.live.indexOf(shot) : i)}-${base}.png`) });
    });
  }
  for (const s of active) {
    for (const u of s.uploadPlan) {
      if (u.free) steps.push({ kind: 'delete', locale: s.locale, shot: u.free, why: 'make-room' });
      steps.push({ kind: 'upload', locale: s.locale, file: u.file });
    }
    for (const shot of s.keep.values()) if (shot.state !== 'COMPLETE') steps.push({ kind: 'wait', locale: s.locale, shot });
  }
  for (const s of active) {
    for (const shot of s.deleteLater) steps.push({ kind: 'delete', locale: s.locale, shot, why: 'old' });
    steps.push({ kind: 'order', locale: s.locale, entries: files.map((f) => ({ name: f.name, id: s.keep.has(f.name) ? s.keep.get(f.name).id : null })) });
    steps.push({ kind: 'verify', locale: s.locale });
  }
  return { problems, sets, steps, backupDir };
}

export function reserveBody(fileName, fileSize, setId) {
  return {
    data: {
      type: 'appScreenshots',
      attributes: { fileName, fileSize },
      relationships: { appScreenshotSet: { data: { type: 'appScreenshotSets', id: setId } } },
    },
  };
}
export const commitBody = (id, md5) => ({ data: { type: 'appScreenshots', id, attributes: { uploaded: true, sourceFileChecksum: md5 } } });
export const createSetBody = (localizationId, displayType) => ({
  data: {
    type: 'appScreenshotSets',
    attributes: { screenshotDisplayType: displayType },
    relationships: { appStoreVersionLocalization: { data: { type: 'appStoreVersionLocalizations', id: localizationId } } },
  },
});
export const orderBody = (ids) => ({ data: ids.map((id) => ({ type: 'appScreenshots', id })) });
export const cancelBody = (id) => ({ data: { type: 'reviewSubmissions', id, attributes: { canceled: true } } });
export const submitBody = (id) => ({ data: { type: 'reviewSubmissions', id, attributes: { submitted: true } } });
export const newSubmissionBody = (appId) => ({
  data: { type: 'reviewSubmissions', attributes: { platform: 'IOS' }, relationships: { app: { data: { type: 'apps', id: appId } } } },
});
export const itemBody = (submissionId, versionId) => ({
  data: {
    type: 'reviewSubmissionItems',
    relationships: {
      reviewSubmission: { data: { type: 'reviewSubmissions', id: submissionId } },
      appStoreVersion: { data: { type: 'appStoreVersions', id: versionId } },
    },
  },
});

const json = (b) => JSON.stringify(b);

/** The plan as the exact calls, one numbered step each. */
export function describeReplaceSteps(plan, { pollMs = POLL_MS, maxPolls = MAX_POLLS } = {}) {
  const lines = [];
  const setRef = (locale) => {
    const s = plan.sets.find((x) => x.locale === locale);
    return s && s.setId ? s.setId : `{new ${locale} set}`;
  };
  let n = 0;
  const step = (text, ...more) => {
    n += 1;
    lines.push(`${String(n).padStart(3)}. ${text}`);
    for (const m of more) lines.push(`       ${m}`);
  };
  for (const s of plan.steps) {
    if (s.kind === 'create-set') {
      step(`POST /v1/appScreenshotSets ${json(createSetBody(s.localizationId, s.displayType))}`, `(${s.locale}: no ${s.displayType} set yet)`);
    } else if (s.kind === 'backup') {
      step(`GET ${s.shot.templateUrl} with {w}=${s.shot.width} {h}=${s.shot.height} {f}=png, no credentials`,
        `(${s.locale}: save old ${s.shot.fileName} to ${s.to})`);
    } else if (s.kind === 'delete') {
      step(`DELETE /v1/appScreenshots/${s.shot.id}`,
        `(${s.locale}: ${s.why === 'make-room' ? 'old, saved above; makes room under the cap of ten for the next upload' : 'old, now replaced'}: ${s.shot.fileName})`);
    } else if (s.kind === 'upload') {
      const ref = `{new ${s.locale} ${s.file.name}}`;
      step(`POST /v1/appScreenshots ${json(reserveBody(s.file.name, s.file.bytes, setRef(s.locale)))}`,
        `then PUT the bytes of ${s.file.name} to each uploadOperations[] url Apple returns, with its requestHeaders, offset and length`,
        `then PATCH /v1/appScreenshots/${ref} ${json(commitBody(ref, s.file.md5))}`,
        `then GET /v1/appScreenshots/${ref}?fields[appScreenshots]=assetDeliveryState every ${pollMs / 1000} s until COMPLETE`
        + ` (at most ${Math.round((pollMs * maxPolls) / 60000)} min; FAILED stops the run and deletes only that new upload)`);
    } else if (s.kind === 'wait') {
      step(`GET /v1/appScreenshots/${s.shot.id}?fields[appScreenshots]=assetDeliveryState until COMPLETE`,
        `(${s.locale}: ${s.shot.fileName} is already uploaded and still processing)`);
    } else if (s.kind === 'order') {
      const ids = s.entries.map((e) => e.id || `{new ${s.locale} ${e.name}}`);
      step(`PATCH /v1/appScreenshotSets/${setRef(s.locale)}/relationships/appScreenshots ${json(orderBody(ids))}`,
        `(${s.locale}: filename order ${s.entries.map((e) => e.name).join(', ')})`);
    } else if (s.kind === 'verify') {
      step(`GET /v1/appScreenshotSets/${setRef(s.locale)}/appScreenshots?limit=50`, `(${s.locale}: read the set back)`);
    }
  }
  return lines;
}

/** Field values from flags, files and --from-json, checked against Apple's limits. */
export function readFieldInputs(args, { readFile = fs.readFileSync } = {}) {
  const problems = [];
  const values = {};
  if (args.opts['from-json']) {
    let obj;
    try {
      obj = JSON.parse(stripBom(readFile(args.opts['from-json'], 'utf8')));
    } catch (e) {
      throw new UsageError(`--from-json ${args.opts['from-json']}: ${e.message}`);
    }
    const src = obj && typeof obj.fields === 'object' && obj.fields ? obj.fields : obj;
    for (const [k, v] of Object.entries(src || {})) {
      if (!FIELDS[k]) { problems.push(`--from-json: "${k}" is not a field (${Object.keys(FIELDS).join(', ')})`); continue; }
      if (v === null || v === undefined) continue;
      values[k] = String(v);
    }
  }
  for (const [field, given] of Object.entries(args.fields)) {
    if (given.file) {
      try {
        values[field] = stripBom(readFile(given.file, 'utf8')).replace(/\r\n/g, '\n').replace(/\s+$/, '');
      } catch (e) {
        throw new UsageError(`--${field}-file ${given.file}: ${e.message}`);
      }
    } else {
      values[field] = given.value;
    }
  }
  for (const [field, value] of Object.entries(values)) {
    const p = checkField(field, value);
    if (p) problems.push(p);
  }
  return { values, problems };
}

export function checkField(field, value) {
  const spec = FIELDS[field];
  if (spec.url) {
    try {
      const u = new URL(value);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') return `${field} must be an http or https address, not "${value}"`;
    } catch {
      return `${field} is not a web address: "${value}"`;
    }
    return null;
  }
  const chars = [...value].length;
  if (spec.max.chars != null && chars > spec.max.chars) return `${field} is ${chars} characters; Apple's limit is ${spec.max.chars}`;
  const bytes = Buffer.byteLength(value, 'utf8');
  if (spec.max.bytes != null && bytes > spec.max.bytes) return `${field} is ${bytes} bytes; Apple's limit is ${spec.max.bytes} bytes`;
  return null;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function finishPlan(ctx, args, problems) {
  if (problems.length) {
    ctx.say('');
    ctx.say(`Refused, nothing changed (${problems.length} problem${problems.length === 1 ? '' : 's'}):`);
    for (const p of problems) ctx.say(`  - ${p}`);
    return EXIT.REFUSED;
  }
  if (args.opts['dry-run']) {
    ctx.say('');
    ctx.say('Dry run: nothing changed.');
    return EXIT.OK;
  }
  if (!args.opts.yes) {
    ctx.say('');
    ctx.say('Nothing changed: add --yes to make these calls (--dry-run only prints them).');
    return EXIT.UNCONFIRMED;
  }
  return null;
}

async function runStatus(api, cfg, args, ctx) {
  const app = cfg.appId;
  let failed = 0;
  const line = async (label, fn) => {
    try {
      ctx.say(`${label}: ${await fn()}`);
    } catch (e) {
      failed += 1;
      ctx.say(`${label}: ${e.status || e.message}`);
    }
  };
  await line('versions', async () => (await api.get(`/v1/apps/${app}/appStoreVersions?filter[platform]=IOS&fields[appStoreVersions]=versionString,appStoreState,createdDate&limit=3`))
    .data.map((d) => `${d.attributes.versionString} ${d.attributes.appStoreState}`).join(' | '));
  await line('review submissions', async () => (await api.get(`/v1/reviewSubmissions?filter[app]=${app}&limit=5&fields[reviewSubmissions]=state,submittedDate,platform`))
    .data.map((d) => `${d.attributes.state} ${String(d.attributes.submittedDate || '').slice(0, 16)}`).join(' | '));
  await line('builds', async () => (await api.get(`/v1/builds?filter[app]=${app}&sort=-uploadedDate&limit=3&fields[builds]=version,processingState,uploadedDate`))
    .data.map((b) => `${b.attributes.version} ${b.attributes.processingState} ${String(b.attributes.uploadedDate || '').slice(0, 10)}`).join(' | '));
  await line('subscriptions', async () => {
    const groups = (await api.get(`/v1/apps/${app}/subscriptionGroups?limit=20`)).data || [];
    const subs = [];
    for (const g of groups) {
      subs.push(...((await api.get(`/v1/subscriptionGroups/${g.id}/subscriptions?fields[subscriptions]=productId,state,groupLevel&limit=50`)).data || []));
    }
    return subs.map((d) => `${d.attributes.productId} ${d.attributes.state}`).join(' | ');
  });
  return failed ? EXIT.API : EXIT.OK;
}

async function runMetadataGet(api, cfg, args, ctx) {
  const locale = args.opts.locale || 'en-US';
  const version = await resolveVersion(api, cfg, args.opts.version);
  const listing = await loadListing(api, cfg, version, locale);
  if (!listing.vloc) throw new RefusedError(`version ${version.attributes.versionString} has no ${locale} localization (it has ${listing.locales.join(', ') || 'none'})`);
  if (args.opts.json) {
    ctx.say(JSON.stringify({
      version: version.attributes.versionString, state: stateOf(version), locale,
      appInfoState: listing.info ? listing.info.state : null, fields: listing.values,
    }, null, 2));
    return EXIT.OK;
  }
  ctx.say(`version ${version.attributes.versionString} (${stateOf(version)}), ${locale}`);
  ctx.say(`app info: ${listing.info ? listing.info.state : 'none found'}`);
  for (const [field, spec] of Object.entries(FIELDS)) {
    const v = listing.values[field];
    const where = spec.home === 'appInfo' ? 'app info' : 'version';
    let size = '';
    if (v != null && spec.max) size = spec.max.bytes != null ? ` (${Buffer.byteLength(v, 'utf8')}/${spec.max.bytes} bytes)` : ` (${[...v].length}/${spec.max.chars})`;
    if (v == null) ctx.say(`  ${field.padEnd(16)} (not set)  [${where}]`);
    else if (field === 'description' || field === 'whatsNew') {
      ctx.say(`  ${field.padEnd(16)}${size}  [${where}]`);
      for (const l of v.split('\n')) ctx.say(`      | ${l}`);
    } else ctx.say(`  ${field.padEnd(16)} ${JSON.stringify(v)}${size}  [${where}]`);
  }
  return EXIT.OK;
}

async function runMetadataSet(api, cfg, args, ctx, local) {
  const locale = args.opts.locale || 'en-US';
  const version = await resolveVersion(api, cfg, args.opts.version);
  const vs = version.attributes.versionString;
  const st = stateOf(version);
  const listing = await loadListing(api, cfg, version, locale);
  const problems = [...local.problems];
  ctx.say(`version ${vs} (${st}), ${locale}; app info ${listing.info ? listing.info.state : 'none found'}`);
  if (!listing.vloc) problems.push(`version ${vs} has no ${locale} localization`);
  const versionAttrs = {};
  const infoAttrs = {};
  for (const [field, value] of Object.entries(local.values)) {
    const spec = FIELDS[field];
    const before = listing.values[field];
    if (before === value) {
      ctx.say(`  ${field}: already ${JSON.stringify(short(value, 60))}, left as it is`);
      continue;
    }
    ctx.say(`  ${field}: ${JSON.stringify(short(before, 60))} -> ${JSON.stringify(short(value, 60))} (${[...value].length} chars)`);
    if (spec.home === 'appInfo') {
      if (!listing.info || !listing.iloc) problems.push(`${field}: no ${locale} app info localization to write it to`);
      else if (!EDITABLE_STATES.has(listing.info.state)) problems.push(`${field}: the app info is ${listing.info.state}; name and subtitle change only while it is editable`);
      infoAttrs[field] = value;
    } else {
      if (!spec.anyState && !EDITABLE_STATES.has(st)) problems.push(`${field}: version ${vs} is ${st}; only promotionalText can change in that state`);
      versionAttrs[field] = value;
    }
  }
  const calls = [];
  if (Object.keys(versionAttrs).length && listing.vloc) {
    calls.push(['PATCH', `/v1/appStoreVersionLocalizations/${listing.vloc.id}`, { data: { type: 'appStoreVersionLocalizations', id: listing.vloc.id, attributes: versionAttrs } }]);
  }
  if (Object.keys(infoAttrs).length && listing.iloc) {
    calls.push(['PATCH', `/v1/appInfoLocalizations/${listing.iloc.id}`, { data: { type: 'appInfoLocalizations', id: listing.iloc.id, attributes: infoAttrs } }]);
  }
  if (!calls.length && !problems.length) {
    ctx.say('Nothing to change.');
    return EXIT.OK;
  }
  ctx.say('');
  ctx.say('Calls:');
  calls.forEach(([m, p, b], i) => ctx.say(`${String(i + 1).padStart(3)}. ${m} ${p} ${json(b)}`));
  const fin = finishPlan(ctx, args, problems);
  if (fin !== null) return fin;
  for (const [m, p, b] of calls) await api.patch(p, b);
  const after = await loadListing(api, cfg, version, locale);
  let mismatch = 0;
  for (const [field, value] of Object.entries({ ...versionAttrs, ...infoAttrs })) {
    const ok = after.values[field] === value;
    if (!ok) mismatch += 1;
    ctx.say(`  ${field}: ${ok ? 'written' : `reads back as ${JSON.stringify(short(after.values[field], 60))}`}`);
  }
  return mismatch ? EXIT.API : EXIT.OK;
}

async function runScreenshotsList(api, cfg, args, ctx) {
  const version = await resolveVersion(api, cfg, args.opts.version);
  const wanted = parseLocales(args.opts.locale);
  const locs = await loadScreenshotState(api, version, { locales: wanted, displayType: args.opts['display-type'] || null });
  ctx.say(`version ${version.attributes.versionString} (${stateOf(version)})`);
  for (const l of locs) {
    if (!l.sets.length) ctx.say(`${l.locale}: no screenshot sets${args.opts['display-type'] ? ` of ${args.opts['display-type']}` : ''}`);
    for (const s of l.sets) {
      ctx.say(`${l.locale} ${s.displayType}: ${s.shots.length} screenshot(s)`);
      s.shots.forEach((x, i) => ctx.say(`  ${String(i + 1).padStart(2)}. ${x.fileName}  ${x.width}x${x.height}  ${x.state}  md5 ${(x.checksum || '-').slice(0, 8)}`));
    }
  }
  const missing = (wanted || []).filter((w) => !locs.some((l) => l.locale === w));
  for (const m of missing) ctx.say(`${m}: version has no such localization`);
  return missing.length ? EXIT.REFUSED : EXIT.OK;
}

/** Download one screenshot as Apple serves it, at its own size, as PNG. */
async function saveShot(ctx, shot, to) {
  if (!shot.templateUrl || !shot.width || !shot.height) throw new AscError(`${shot.fileName}: Apple gave no image address to save it from`);
  const url = shot.templateUrl.replace('{w}', shot.width).replace('{h}', shot.height).replace('{f}', 'png');
  // A public image host: the API token is never sent there.
  const res = await ctx.fetchImpl(url, { method: 'GET', signal: timeoutSignal(60000) });
  if (!res.ok) throw new AscError(`${shot.fileName}: saving the old image answered HTTP ${res.status}`, res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  const info = inspectImage(buf);
  if (info.format !== 'png' || info.width !== shot.width || info.height !== shot.height) {
    throw new AscError(`${shot.fileName}: the saved image is ${info.format || 'not an image'} ${info.width || '?'}x${info.height || '?'}, not the ${shot.width}x${shot.height} PNG expected`);
  }
  ctx.fs.mkdirSync(path.dirname(to), { recursive: true });
  ctx.fs.writeFileSync(to, buf);
  return buf.length;
}

async function runScreenshotsBackup(api, cfg, args, ctx) {
  const version = await resolveVersion(api, cfg, args.opts.version);
  const displayType = args.opts['display-type'] || DEFAULT_DISPLAY_TYPE;
  const locs = await loadScreenshotState(api, version, { locales: parseLocales(args.opts.locale), displayType });
  let saved = 0;
  for (const l of locs) {
    const set = l.sets[0];
    if (!set) { ctx.say(`${l.locale}: no ${displayType} set`); continue; }
    for (const [i, shot] of set.shots.entries()) {
      const to = path.join(args.opts.out, l.locale, `${pos2(i)}-${String(shot.fileName).replace(/\.[A-Za-z0-9]+$/, '')}.png`);
      const bytes = await saveShot(ctx, shot, to);
      saved += 1;
      ctx.say(`${l.locale}: saved ${shot.fileName} (${shot.width}x${shot.height}, ${bytes} bytes) to ${to}`);
    }
  }
  ctx.say(`saved ${saved} screenshot(s) of version ${version.attributes.versionString}`);
  return EXIT.OK;
}

function stampOf(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Local checks for replace: read the folder and check every file, before credentials or any call. */
function checkLocalScreenshots(args, ctx) {
  const displayType = args.opts['display-type'] || DEFAULT_DISPLAY_TYPE;
  const dir = path.resolve(args.opts.dir);
  const { files, ignored } = readScreenshotDir(dir, { readdir: ctx.fs.readdirSync, readFile: ctx.fs.readFileSync, exists: ctx.fs.existsSync });
  const { report, problems } = checkScreenshotFiles(files, displayType);
  ctx.say(`${report.length} file(s) in ${dir}, for ${displayType} (${sizesText(displayType)}):`);
  for (const r of report) {
    ctx.say(`  ${r.name}  ${r.width || '?'}x${r.height || '?'}  ${r.detail}, ${r.colourSpace}, ${r.alpha ? 'ALPHA' : 'no alpha'}  ${r.bytes} bytes  md5 ${r.md5.slice(0, 8)}  ${r.ok ? 'ok' : r.problems.join('; ')}`);
  }
  if (ignored.length) ctx.say(`  ignored (not a numbered PNG or JPEG): ${ignored.join(', ')}`);
  return { displayType, dir, files: report, problems };
}

async function runScreenshotsReplace(api, cfg, args, ctx, local) {
  const version = await resolveVersion(api, cfg, args.opts.version);
  const vs = version.attributes.versionString;
  const wantLocales = parseLocales(args.opts.locale);
  const backupDir = path.resolve(args.opts['backup-dir'] || `${local.dir}-replaced-${stampOf(ctx.now())}`);
  const localizations = await loadScreenshotState(api, version, { locales: null, displayType: local.displayType });
  const plan = planScreenshotReplace({
    version, localizations, wantLocales, displayType: local.displayType, files: local.files, makeRoom: !!args.opts['make-room'], backupDir,
  });
  ctx.say('');
  ctx.say(`version ${vs} (${stateOf(version)})`);
  for (const s of plan.sets) {
    ctx.say(`${s.locale}: ${s.setId ? `${local.displayType} set holds ${s.live.length}` : `no ${local.displayType} set`}; `
      + `keep ${s.keep.size}, upload ${s.upload.length}, delete ${s.old.length} old`
      + `${s.freeEarly.length ? ` (all ${s.backup.length} saved first; ${s.freeEarly.length} deleted one at a time just before an upload that would not fit, `
        + `${s.deleteLater.length} after every new one is COMPLETE)` : ' (after every new one is COMPLETE)'}`
      + `${s.unchanged ? ': already this set, in this order' : ''}`);
  }
  const lines = describeReplaceSteps(plan, { pollMs: ctx.pollMs, maxPolls: ctx.maxPolls });
  ctx.say('');
  ctx.say(lines.length ? 'Calls, in order:' : 'No calls needed.');
  for (const l of lines) ctx.say(l);
  const fin = finishPlan(ctx, args, plan.problems);
  if (fin !== null) return fin;
  if (!lines.length) return EXIT.OK;
  return executeReplace(api, ctx, plan, local);
}

async function waitForComplete(api, ctx, id, label) {
  let st = 'UNKNOWN';
  for (let i = 0; i < ctx.maxPolls; i += 1) {
    const j = await api.get(`/v1/appScreenshots/${id}?fields[appScreenshots]=assetDeliveryState`);
    const ads = (j.data && j.data.attributes && j.data.attributes.assetDeliveryState) || {};
    st = ads.state || st;
    if (st === 'COMPLETE') return { polls: i + 1 };
    if (st === 'FAILED') {
      const why = (ads.errors || []).map((e) => e.description || e.code).filter(Boolean).join('; ');
      throw Object.assign(new AscError(`${label}: Apple marked the upload FAILED${why ? ` (${why})` : ''}`), { failed: true });
    }
    await ctx.sleep(ctx.pollMs);
  }
  throw Object.assign(new AscError(`${label}: still ${st} after ${Math.round((ctx.pollMs * ctx.maxPolls) / 1000)} s; run again to resume (a finished upload is kept)`), { timedOut: true });
}

async function uploadScreenshot(api, ctx, setId, file) {
  const r = await api.post('/v1/appScreenshots', reserveBody(file.name, file.bytes, setId));
  const id = r.data.id;
  try {
    for (const op of r.data.attributes.uploadOperations || []) {
      const part = file.buf.subarray(op.offset, op.offset + op.length);
      const headers = Object.fromEntries((op.requestHeaders || []).map((h) => [h.name, h.value]));
      // Apple's own upload address, signed: the API token is not sent.
      const res = await ctx.fetchImpl(op.url, { method: op.method, headers, body: part, signal: timeoutSignal(120000) });
      if (!res.ok) throw new AscError(`${file.name}: sending bytes ${op.offset}-${op.offset + op.length} answered HTTP ${res.status}`, res.status);
    }
    await api.patch(`/v1/appScreenshots/${id}`, commitBody(id, file.md5));
    const w = await waitForComplete(api, ctx, id, file.name);
    return { id, polls: w.polls };
  } catch (e) {
    // A reservation that never finished (or that Apple marked FAILED) holds a
    // slot in the set; it is this run's own, so it goes. One still processing
    // is left, because it may finish and a re-run keeps it.
    if (!e.timedOut) {
      try {
        await api.del(`/v1/appScreenshots/${id}`);
        e.message += '; that new upload was deleted again';
      } catch { /* the error above is the one to report */ }
    }
    throw e;
  }
}

async function executeReplace(api, ctx, plan, local) {
  const setIds = new Map(plan.sets.map((s) => [s.locale, s.setId]));
  const newIds = new Map();
  const status = new Map();
  const oldToGo = plan.steps.filter((s) => s.kind === 'delete' && s.why === 'old').length;
  let oldGone = 0;
  let roomGone = 0;
  for (const s of plan.sets) {
    for (const f of local.files) status.set(`${s.locale}/${f.name}`, s.keep.has(f.name) ? 'kept (already uploaded)' : 'not reached');
  }
  const report = () => {
    ctx.say('');
    ctx.say('Per file:');
    for (const s of plan.sets) for (const f of local.files) ctx.say(`  ${s.locale} ${f.name}: ${status.get(`${s.locale}/${f.name}`)}`);
  };
  ctx.say('');
  try {
    for (const step of plan.steps) {
      if (step.kind === 'create-set') {
        const r = await api.post('/v1/appScreenshotSets', createSetBody(step.localizationId, step.displayType));
        setIds.set(step.locale, r.data.id);
        ctx.say(`${step.locale}: created the ${step.displayType} set`);
      } else if (step.kind === 'backup') {
        const bytes = await saveShot(ctx, step.shot, step.to);
        ctx.say(`${step.locale}: saved old ${step.shot.fileName} (${bytes} bytes) to ${step.to}`);
      } else if (step.kind === 'delete') {
        await api.del(`/v1/appScreenshots/${step.shot.id}`);
        if (step.why === 'old') oldGone += 1;
        else roomGone += 1;
        ctx.say(`${step.locale}: - deleted ${step.why === 'make-room' ? 'old (to make room)' : 'old'} ${step.shot.fileName}`);
      } else if (step.kind === 'upload') {
        const key = `${step.locale}/${step.file.name}`;
        status.set(key, 'uploading');
        const started = Date.now();
        try {
          const r = await uploadScreenshot(api, ctx, setIds.get(step.locale), step.file);
          newIds.set(key, r.id);
          status.set(key, `uploaded, COMPLETE (${r.polls} check${r.polls === 1 ? '' : 's'}, ${Math.round((Date.now() - started) / 1000)} s)`);
          ctx.say(`${step.locale}: + ${step.file.name} COMPLETE`);
        } catch (e) {
          status.set(key, `FAILED: ${e.message}`);
          throw e;
        }
      } else if (step.kind === 'wait') {
        await waitForComplete(api, ctx, step.shot.id, step.shot.fileName);
        status.set(`${step.locale}/${step.shot.fileName}`, 'kept (already uploaded), COMPLETE');
      } else if (step.kind === 'order') {
        const ids = step.entries.map((e) => e.id || newIds.get(`${step.locale}/${e.name}`));
        await api.patch(`/v1/appScreenshotSets/${setIds.get(step.locale)}/relationships/appScreenshots`, orderBody(ids));
      } else if (step.kind === 'verify') {
        const shots = (await api.getAll(`/v1/appScreenshotSets/${setIds.get(step.locale)}/appScreenshots?limit=50`)).data.map(toShot);
        ctx.say(`${step.locale}: now ${shots.length}: ${shots.map((x) => `${x.fileName}[${x.state}]`).join(', ')}`);
      }
    }
  } catch (e) {
    report();
    ctx.say('');
    ctx.say(`Stopped: ${e.message}`);
    if (oldToGo && !oldGone) ctx.say(`All ${oldToGo} old screenshot(s) due to go after the new ones are still in place.`);
    else if (oldToGo) ctx.say(`${oldGone} of the ${oldToGo} old screenshot(s) had been deleted when it stopped; run again to finish.`);
    if (roomGone) ctx.say(`${roomGone} old screenshot(s) went to make room before the stop; every old one is saved in ${plan.backupDir}.`);
    throw e;
  }
  report();
  return EXIT.OK;
}

async function runReviewCancel(api, cfg, args, ctx) {
  const version = await resolveVersion(api, cfg, args.opts.version);
  const vs = version.attributes.versionString;
  const subs = await loadSubmissions(api, cfg, CANCELABLE_STATES);
  const mine = subs.filter((s) => s.versionId === version.id);
  ctx.say(`version ${vs}: ${stateOf(version)}, releaseType ${version.attributes.releaseType}`);
  const problems = [];
  if (!mine.length) problems.push(`no review submission carrying ${vs} is ${CANCELABLE_STATES.join(', ')}; there is nothing to cancel`);
  for (const s of mine) ctx.say(`review submission ${s.id}: ${s.state}, submitted ${String(s.submittedDate || '-').slice(0, 16)}`);
  const sub = mine[0];
  if (sub) {
    ctx.say('');
    ctx.say('Calls:');
    ctx.say(`  1. PATCH /v1/reviewSubmissions/${sub.id} ${json(cancelBody(sub.id))}`);
    ctx.say(`  then GET /v1/reviewSubmissions/${sub.id} and the version every 5 s for up to ${args.opts.wait ?? 120} s, until the version is editable`);
    ctx.say(`Apple's help: the version becomes DEVELOPER_REJECTED, and a resubmission starts the review over.`);
  }
  const fin = finishPlan(ctx, args, problems);
  if (fin !== null) return fin;
  await api.patch(`/v1/reviewSubmissions/${sub.id}`, cancelBody(sub.id));
  ctx.say(`cancel sent for review submission ${sub.id}`);
  const waitS = args.opts.wait ?? 120;
  let last = '';
  for (let t = 0; ; t += 5) {
    const s = await api.get(`/v1/reviewSubmissions/${sub.id}?fields[reviewSubmissions]=state`);
    const v = await findVersion(api, cfg, vs);
    const now = `submission ${s.data.attributes.state}, version ${stateOf(v)}`;
    if (now !== last) { ctx.say(`  ${now}`); last = now; }
    if (EDITABLE_STATES.has(stateOf(v)) && s.data.attributes.state !== 'CANCELING') break;
    if (t >= waitS) {
      ctx.say(`  not settled after ${waitS} s; "status" shows when it has`);
      break;
    }
    await ctx.sleep(5000);
  }
  return EXIT.OK;
}

async function runReviewSubmit(api, cfg, args, ctx) {
  const version = await resolveVersion(api, cfg, args.opts.version);
  const vs = version.attributes.versionString;
  const st = stateOf(version);
  const problems = [];
  ctx.say(`version ${vs}: ${st}, releaseType ${version.attributes.releaseType} (left as it is: this command never writes it)`);
  if (!SUBMITTABLE_STATES.has(st)) problems.push(`version ${vs} is ${st}; it can be submitted from ${[...SUBMITTABLE_STATES].join(', ')}`);

  let build = null;
  try {
    build = (await api.get(`/v1/appStoreVersions/${version.id}/build?fields[builds]=version,processingState,usesNonExemptEncryption,expired`)).data || null;
  } catch (e) {
    if (e.status !== 404) throw e;
  }
  if (!build) problems.push(`no build is attached to ${vs}`);
  else {
    const b = build.attributes;
    ctx.say(`build ${b.version}: ${b.processingState}, export compliance ${b.usesNonExemptEncryption === null || b.usesNonExemptEncryption === undefined ? 'NOT answered' : 'answered'}${b.expired ? ', EXPIRED' : ''}`);
    if (b.processingState !== 'VALID') problems.push(`build ${b.version} is ${b.processingState}, not VALID`);
    if (b.usesNonExemptEncryption === null || b.usesNonExemptEncryption === undefined) problems.push(`build ${b.version} has no export compliance answer`);
    if (b.expired) problems.push(`build ${b.version} has expired`);
  }

  const shotState = await loadScreenshotState(api, version);
  for (const l of shotState) {
    const shots = l.sets.flatMap((s) => s.shots);
    const busy = shots.filter((s) => s.state !== 'COMPLETE');
    ctx.say(`${l.locale}: ${shots.length} screenshot(s)${busy.length ? `, ${busy.length} not COMPLETE` : ', all COMPLETE'}`);
    if (busy.length) problems.push(`${l.locale}: ${busy.map((s) => `${s.fileName} ${s.state}`).join(', ')}; Apple refuses a submission while screenshots are still processing`);
  }

  const open = await loadSubmissions(api, cfg, OPEN_SUBMISSION_STATES);
  for (const s of open) ctx.say(`review submission ${s.id}: ${s.state}${s.versionId === version.id ? ` (carries ${vs})` : ''}`);
  for (const s of open.filter((x) => x.state !== 'READY_FOR_REVIEW')) {
    problems.push(s.state === 'CANCELING'
      ? `review submission ${s.id} is still CANCELING; Apple refuses a new submission until the cancellation completes, so wait and run again`
      : `review submission ${s.id} is ${s.state}; only one submission per platform can be open at a time`);
  }
  const draft = open.find((x) => x.state === 'READY_FOR_REVIEW') || null;
  let hasItem = false;
  if (draft) {
    const items = draft.items || (await api.get(`/v1/reviewSubmissions/${draft.id}/items?fields[reviewSubmissionItems]=state,appStoreVersion&limit=50`)).data || [];
    hasItem = draft.versionId === version.id || items.some((it) => it.relationships && it.relationships.appStoreVersion
      && it.relationships.appStoreVersion.data && it.relationships.appStoreVersion.data.id === version.id);
  }

  const subRef = draft ? draft.id : '{new review submission}';
  ctx.say('');
  ctx.say('Calls:');
  let n = 0;
  const call = (t) => ctx.say(`${String(++n).padStart(3)}. ${t}`);
  if (draft) ctx.say(`     (reuses draft review submission ${draft.id})`);
  else call(`POST /v1/reviewSubmissions ${json(newSubmissionBody('{appId}'))}`);
  if (!hasItem) call(`POST /v1/reviewSubmissionItems ${json(itemBody(subRef, version.id))}`);
  call(`PATCH /v1/reviewSubmissions/${subRef} ${json(submitBody(subRef))}`);
  const fin = finishPlan(ctx, args, problems);
  if (fin !== null) return fin;

  const subId = draft ? draft.id : (await api.post('/v1/reviewSubmissions', newSubmissionBody(cfg.appId))).data.id;
  if (!draft) ctx.say(`created review submission ${subId}`);
  if (!hasItem) {
    await api.post('/v1/reviewSubmissionItems', itemBody(subId, version.id));
    ctx.say(`added ${vs} to it`);
  }
  const done = await api.patch(`/v1/reviewSubmissions/${subId}`, submitBody(subId));
  ctx.say(`submitted: submission ${done.data && done.data.attributes ? done.data.attributes.state : '?'}`);
  const waitS = args.opts.wait ?? 30;
  for (let t = 0; t <= waitS; t += 5) {
    const v = await findVersion(api, cfg, vs);
    if (stateOf(v) !== st || t >= waitS) {
      ctx.say(`version ${vs}: ${stateOf(v)}, releaseType ${v.attributes.releaseType}`);
      break;
    }
    await ctx.sleep(5000);
  }
  return EXIT.OK;
}

async function runBuildsList(api, cfg, args, ctx) {
  const app = cfg.appId;
  const limit = args.opts.limit || 10;
  let q = `/v1/builds?filter[app]=${app}&sort=-uploadedDate&limit=${limit}`
    + '&fields[builds]=version,processingState,uploadedDate,expired,usesNonExemptEncryption,minOsVersion,preReleaseVersion'
    + '&include=preReleaseVersion&fields[preReleaseVersions]=version,platform';
  if (args.opts.version) q += `&filter[preReleaseVersion.version]=${enc(args.opts.version)}`;
  const j = await api.get(q);
  const pre = new Map((j.included || []).filter((x) => x.type === 'preReleaseVersions').map((x) => [x.id, x.attributes.version]));
  const versions = (await api.get(`/v1/apps/${app}/appStoreVersions?filter[platform]=IOS&limit=5`)).data || [];
  const attached = new Map();
  for (const v of versions) {
    try {
      const b = (await api.get(`/v1/appStoreVersions/${v.id}/build?fields[builds]=version`)).data;
      if (b) attached.set(b.id, `${v.attributes.versionString} ${stateOf(v)}`);
    } catch (e) {
      if (e.status !== 404) throw e;
    }
  }
  if (!(j.data || []).length) ctx.say('no builds');
  for (const b of j.data || []) {
    const a = b.attributes;
    const preId = b.relationships && b.relationships.preReleaseVersion && b.relationships.preReleaseVersion.data && b.relationships.preReleaseVersion.data.id;
    const enc2 = a.usesNonExemptEncryption === null || a.usesNonExemptEncryption === undefined ? 'not answered' : a.usesNonExemptEncryption ? 'yes' : 'no';
    // Apple writes uploadedDate with a Pacific offset; printed here in UTC.
    const when = a.uploadedDate && !Number.isNaN(Date.parse(a.uploadedDate)) ? `${new Date(a.uploadedDate).toISOString().slice(0, 16).replace('T', ' ')}Z` : '?';
    ctx.say(`build ${String(a.version).padEnd(5)} ${String(pre.get(preId) || '?').padEnd(7)} ${String(a.processingState).padEnd(10)} uploaded ${when}`
      + `  encryption ${enc2}${a.expired ? '  EXPIRED' : ''}${attached.has(b.id) ? `  attached to ${attached.get(b.id)}` : ''}`);
  }
  return EXIT.OK;
}

const RUNNERS = {
  status: runStatus,
  'metadata get': runMetadataGet,
  'metadata set': runMetadataSet,
  'screenshots list': runScreenshotsList,
  'screenshots backup': runScreenshotsBackup,
  'screenshots replace': runScreenshotsReplace,
  'review cancel': runReviewCancel,
  'review submit': runReviewSubmit,
  'builds list': runBuildsList,
};

/**
 * deps (tests): { env, fetch, stdout, stderr, sleep, pollMs, maxPolls, config, token, fs, now }.
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
    pollMs: deps.pollMs ?? POLL_MS,
    maxPolls: deps.maxPolls ?? MAX_POLLS,
    fetchImpl: deps.fetch || globalThis.fetch,
    now: deps.now || (() => new Date()),
    fs: deps.fs || fs,
  };
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    ctx.warn(`asc: ${e.message}`);
    ctx.warn('Run with --help for the commands.');
    return EXIT.USAGE;
  }
  if (args.command === 'help') {
    ctx.say(HELP);
    return EXIT.OK;
  }
  try {
    // Local inputs are checked before credentials are read or any call is made.
    let local = null;
    if (args.name === 'screenshots replace') {
      local = checkLocalScreenshots(args, ctx);
      if (local.problems.length) return finishPlan(ctx, args, local.problems);
    } else if (args.name === 'metadata set') {
      local = readFieldInputs(args, { readFile: ctx.fs.readFileSync });
    }
    const cfg = deps.config || loadConfig({ env: deps.env || process.env, configPath: args.opts.config });
    redact = makeRedactor(cfg);
    const token = deps.token ? () => deps.token : tokenSource(cfg);
    const api = makeClient({ fetchImpl: ctx.fetchImpl, token, sleep: ctx.sleep });
    return await RUNNERS[args.name](api, cfg, args, ctx, local);
  } catch (e) {
    if (e instanceof UsageError) {
      ctx.warn(`asc: ${e.message}`);
      return EXIT.USAGE;
    }
    if (e instanceof RefusedError) {
      ctx.warn(`asc: ${e.message}`);
      return EXIT.REFUSED;
    }
    ctx.warn(`asc: ${e instanceof AscError ? e.message : (e.stack || e.message)}`);
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
