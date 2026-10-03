/**
 * Components declared inside FlockAppInner's render are CALLED, never mounted
 * as JSX (app audit 2026-10-03). Declared there, `<AIBubble />` is a new
 * component type on every app render, so React unmounted and remounted it each
 * time: a drag of the Birdie button in progress lost its pointer capture, and
 * the toast restarted as a fresh node. Calling them reconciles one node.
 * FRONTEND test (jest via react-scripts).
 */
const fs = require('fs');
const path = require('path');

const APP = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8');
const code = APP.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('no component declared inside the render is mounted as a JSX tag', () => {
  const nested = [...APP.matchAll(/^  const ([A-Z][A-Za-z]*) = \(\) =>/gm)].map((m) => m[1]);
  expect(nested).toEqual(expect.arrayContaining(['AIBubble', 'Toast', 'MissingDmPanel', 'SafetyButton', 'BottomNav']));
  for (const name of nested) {
    expect({ name, mounted: new RegExp(`<${name}\s*/>`).test(code) }).toEqual({ name, mounted: false });
  }
});
