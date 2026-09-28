// The imports frontend/src/services/socket.js needs, for a backend suite that
// runs the real client module in node.
//
// chatTransportParity.test.js and socketRoomRejoin.test.js both strip the
// file's ESM imports, drop its `export` keywords and evaluate the body with
// every imported name passed in as a parameter. Each suite used to list those
// names by hand, so an import added to socket.js surfaced as a ReferenceError
// inside whichever test first reached it, in two suites at once. This reads the
// import list off the file and refuses to hand back a set that does not cover
// it, naming what is missing.
//
// What stands in for each name:
//   io, getToken, BASE_URL   the caller's own fakes: they are what each suite
//                            is observing.
//   storedSessionIsThisTabs  true. services/api.js answers false only when the
//                            stored token names a different account from the
//                            one this tab began with or signed in to itself.
//                            Every token these suites hand over is this tab's
//                            own session; an account switch in them is this
//                            tab signing in as somebody else, which rebinds
//                            the tab (api.js storeSession), so the real answer
//                            is true throughout. The refusal of another tab's
//                            token is pinned where api.js runs for real, in
//                            frontend/src/__tests__/crossTabAccountSwitch.test.js.
//   travelFields, sameSignIn the real functions. lib/travel.js and
//                            lib/sessionIdentity.js have no imports of their
//                            own, so they load the same way socket.js does.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const CLIENT_DIR = path.join(__dirname, '..', '..', '..', 'frontend', 'src');
const SOCKET_FILE = path.join(CLIENT_DIR, 'services', 'socket.js');

// The names a module imports, from `import { a, b as c } from '...'` lines.
// A default or namespace import has no name this loader could bind, so it is
// reported rather than skipped.
function importedNames(src, file) {
  const names = [];
  for (const m of src.matchAll(/^import\s+([\s\S]*?)\s+from\s+'[^']*';/gm)) {
    const clause = m[1].trim();
    assert.ok(/^\{[\s\S]*\}$/.test(clause),
      `${file} has an import this loader cannot bind (${clause}); only named imports are supported`);
    for (const part of clause.slice(1, -1).split(',')) {
      const spec = part.trim();
      if (!spec) continue;
      const local = spec.split(/\s+as\s+/).pop().trim();
      names.push(local);
    }
  }
  return names;
}

// Evaluate an import-free ESM module and return the named bindings.
function loadPureModule(rel, wanted) {
  const src = fs.readFileSync(path.join(CLIENT_DIR, rel), 'utf8');
  assert.deepStrictEqual(importedNames(src, rel), [],
    `${rel} gained an import, so it can no longer be loaded on its own here`);
  const body = src.replace(/^export /gm, '');
  // eslint-disable-next-line no-new-func
  return new Function(`${body}\nreturn { ${wanted.join(', ')} };`)();
}

/**
 * @param {object} fakes  { io, getToken, BASE_URL }, the suite's own stand-ins
 * @returns {{ names: string[], values: any[] }} parameter names and values, in
 *          the same order, covering every name socket.js imports
 */
function clientSocketImports({ io, getToken, BASE_URL }) {
  const src = fs.readFileSync(SOCKET_FILE, 'utf8');
  const { travelFields } = loadPureModule(path.join('lib', 'travel.js'), ['travelFields']);
  const { sameSignIn } = loadPureModule(path.join('lib', 'sessionIdentity.js'), ['sameSignIn']);
  const provided = {
    io,
    getToken,
    BASE_URL,
    storedSessionIsThisTabs: () => true,
    travelFields,
    sameSignIn,
  };
  const needed = importedNames(src, 'services/socket.js');
  const missing = needed.filter((n) => !(n in provided));
  assert.deepStrictEqual(missing, [],
    `services/socket.js imports ${missing.join(', ')}, which __tests__/helpers/clientSocketImports.js does not provide`);
  return { names: needed, values: needed.map((n) => provided[n]) };
}

module.exports = { clientSocketImports, importedNames };
