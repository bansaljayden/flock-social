/**
 * EVERY METER THE COSTS PAYLOAD CARRIES IS RENDERED, OR IS NAMED AS NOT RENDERED.
 *
 * GET /api/admin/costs assembles a block per meter, and the admin panel in
 * App.js is the only reader. There is no error when the two disagree: the
 * server computes the number, serializes it, ships it across the wire, and the
 * panel simply does not mention it. Everything stays green. The number the work
 * existed to surface is exactly as invisible as it was before.
 *
 * That has now happened twice to the same key. `predictionCoverage` was added
 * to the response on 2026-08-26 to make the model-versus-fallback split
 * visible. It first came back null on every request, because meterOrNull's
 * `Number.isFinite(v) ? v : null` answers null for any object and this meter
 * returns a block; routes/admin.js grew meterBlockOrNull and a server test for
 * that. The block then arrived correctly and still reached no screen, because
 * nothing had ever rendered it. Two fixes, both real, and the number stayed
 * invisible through both.
 *
 * The server-side tests cannot see this. They assert the payload, which was
 * right. The gap is the join, so the test has to read both files.
 *
 * Shape: an expected-set check, like the route auth coverage guard in the
 * backend. A key is either referenced by the panel or named below with a
 * reason. Adding a meter without rendering it fails here with its own name in
 * the message, and the fix is either to render it or to say why not.
 */

const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..', '..');
const read = (...p) => fs.readFileSync(path.join(REPO, ...p), 'utf8').split('\r').join('');

const ADMIN = read('backend', 'routes', 'admin.js');
const APP_RAW = read('frontend', 'src', 'App.js');

/**
 * App.js with comments removed.
 *
 * The first version of this file matched against the raw source and two of its
 * three mutations sailed through, because the explanatory comment written
 * directly above the panel names the very key the test was looking for. A
 * comment is text, so a scan that reads text cannot tell the difference between
 * a rendered value and a paragraph about one. That has now been the failure in
 * five separate guards in this codebase, so it is the default here rather than
 * an afterthought.
 *
 * Line comments only, and deliberately: a JSX block comment rule needs to pair
 * `{/*` with the matching close, and getting that wrong silently deletes whole
 * regions of the file, which is a worse failure than the one it fixes. Line
 * comments are what carry the key names.
 */
const APP = APP_RAW
  .split('\n')
  .map((line) => line.replace(/(^|[^:])\/\/[^\n]*$/, '$1'))
  .join('\n');

// Keys that are deliberately not drawn as a meter, each with the reason.
const NOT_RENDERED = {
  generatedAt: 'a timestamp on the payload, not a measurement anybody reads as one',
  watchlist: 'a static list from costModel, rendered through its own block rather than by key name',
  reconciled: 'same, a static costModel constant',
  rates: 'per model unit prices, consumed inside the other blocks rather than shown on their own',
  dependencies: 'the dependency table, rendered by its own component rather than by this key',
  disclaimer: 'the panel states this in its own words at the observed block, and the payload copy exists so an API reader cannot miss it either',
};

/** Top level keys of the object passed to res.json() inside GET /costs. */
function costsPayloadKeys() {
  const routeAt = ADMIN.indexOf("router.get('/costs'");
  expect(routeAt).toBeGreaterThan(-1);

  const jsonAt = ADMIN.indexOf('res.json({', routeAt);
  expect(jsonAt).toBeGreaterThan(routeAt);

  // Walk braces from the opening one so nested objects are skipped rather than
  // contributing their own keys.
  const open = ADMIN.indexOf('{', jsonAt);
  let depth = 0;
  let end = -1;
  for (let i = open; i < ADMIN.length; i += 1) {
    if (ADMIN[i] === '{') depth += 1;
    else if (ADMIN[i] === '}') {
      depth -= 1;
      if (depth === 0) { end = i; break; }
    }
  }
  expect(end).toBeGreaterThan(open);

  const body = ADMIN.slice(open + 1, end);
  const keys = [];
  let d = 0;
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (d === 0) {
      const m = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*[:,]/);
      if (m) keys.push(m[1]);
    }
    for (const ch of line) {
      if (ch === '{' || ch === '[') d += 1;
      else if (ch === '}' || ch === ']') d -= 1;
    }
  }
  return [...new Set(keys)];
}

const KEYS = costsPayloadKeys();

describe('the admin costs payload and the panel that reads it', () => {
  it('found the payload, so an empty result cannot pass as agreement', () => {
    // Without this the whole file would go green on a renamed route, which is
    // the failure mode it exists to prevent in the first place.
    expect(KEYS.length).toBeGreaterThanOrEqual(8);
    expect(KEYS).toContain('observed');
    expect(KEYS).toContain('predictionCoverage');
  });

  it('renders every meter it carries, or names the ones it does not and why', () => {
    const missing = KEYS
      .filter((k) => !(k in NOT_RENDERED))
      .filter((k) => !APP.includes(`d.${k}`) && !APP.includes(`${k}:`) && !APP.includes(`.${k}`));

    expect(missing).toEqual([]);
  });

  it('the reasons on the not-rendered list are real sentences', () => {
    for (const [key, reason] of Object.entries(NOT_RENDERED)) {
      expect(typeof reason).toBe('string');
      expect(reason.trim().length).toBeGreaterThan(20);
      // A key that stopped being served should leave the list rather than sit
      // on it forever explaining an absence nobody can check.
      expect(KEYS).toContain(key);
    }
  });

  it('predictionCoverage reaches a screen, which is the case that failed twice', () => {
    // A guard on the JSX itself, not on a mention. `{d.x && (` is the panel
    // actually deciding to draw the block; the key appearing anywhere else in
    // the file proves nothing, which is how the first draft of this test passed
    // over a panel whose condition had been replaced with `false`.
    expect(APP).toMatch(/\{d\.predictionCoverage\s*&&\s*\(/);

    // And it says the thing that makes the number readable: this counter lives
    // in server memory and restarts with the process, so a low reading is not
    // evidence the model is unused. Checked against the visible copy, which is
    // why the comment stripping above matters.
    const at = APP.indexOf('{d.predictionCoverage');
    const block = APP.slice(at, at + 3000);
    expect(block).toMatch(/on every deploy/i);
    // The fallback has to be nameable, or a percentage means nothing.
    expect(block).toMatch(/rule engine/i);
  });

  it('pushDelivery reaches a screen too, since its server test only proved the payload', () => {
    expect(APP).toContain('d.pushDelivery');
  });
});
