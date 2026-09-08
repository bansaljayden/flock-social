/**
 * The permission block in the demo flows, pinned to what Maestro will accept.
 *
 * A wrong value here is not a wrong value at runtime, it is a DEAD BUILD: the
 * launch is the first command in the flow, so the run ends nine seconds in and
 * the whole recording is lost. Build 41 ended exactly that way, on
 * `location: allow` -- which is the value Maestro's own documentation puts in
 * its iOS example.
 *
 * Location is the one permission Maestro does not hand to applesimutils. It
 * goes through `LocalSimulatorUtils.setLocationPermission`, which switches on
 * always / inuse / never / unset and throws IllegalArgumentException on
 * anything else. `allow` is fine for every other permission and fatal for this
 * one, which is why reading the neighbouring line is not enough to get it
 * right, and why this test exists rather than a comment.
 */
const fs = require('fs');
const path = require('path');

const MAESTRO = path.join(__dirname, '..', '..', '.maestro');
const FLOWS = ['demo-person.yaml', 'demo-venue.yaml'];

// maestro-ios-driver/src/main/kotlin/util/LocalSimulatorUtils.kt
const LOCATION_VALUES = ['always', 'inuse', 'never', 'unset'];
// Everything else is routed through applesimutils, which takes these three.
const ORDINARY_VALUES = ['allow', 'deny', 'unset'];

const read = (f) => fs.readFileSync(path.join(MAESTRO, f), 'utf8');

/* A deliberately small parser rather than a YAML dependency: this reads the one
   block it is about, and a test that cannot run without adding a package to the
   app's dependencies is a test that gets deleted. */
function permissionsIn(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^\s*permissions:\s*$/.test(l));
  if (start === -1) return null;
  const indent = lines[start].match(/^\s*/)[0].length;
  const out = {};
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\s*(#.*)?$/.test(line)) continue;
    if (line.match(/^\s*/)[0].length <= indent) break;
    const m = line.match(/^\s*([A-Za-z0-9_.]+):\s*(\S+)\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

describe.each(FLOWS)('%s launch permissions', (flow) => {
  const perms = permissionsIn(read(flow));

  test('has a permission block at all', () => {
    expect(perms).not.toBeNull();
    expect(Object.keys(perms).length).toBeGreaterThan(0);
  });

  test('location is granted, and with a value the driver accepts', () => {
    // Granted rather than prompted, because `all: unset` wipes the grant the
    // build script gives the Simulator and the app is then left asking. In
    // build 40 it asked, no prompt was drawn, CoreLocation never answered, and
    // every shot that needs a coordinate was empty.
    expect(perms.location).toBeDefined();
    expect(LOCATION_VALUES).toContain(perms.location);
    expect(perms.location).not.toBe('never');
    expect(perms.location).not.toBe('unset');
  });

  test('every other permission uses a value applesimutils accepts', () => {
    Object.entries(perms).forEach(([name, value]) => {
      if (name === 'location') return;
      expect(ORDINARY_VALUES).toContain(value);
    });
  });
});
