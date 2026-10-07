/**
 * Both iOS workflows build with Xcode 26.6, not `latest`. The shell has not
 * adopted the UIScene lifecycle, and an app built with the iOS 27 SDK without
 * it does not launch on iOS 27, App Review's iPads included. Codemagic moves
 * `latest` on its own schedule, so the pin has to stay until the shell is
 * migrated (npx cap migrate on Capacitor 8.5 or later adds the scene delegate).
 */
const fs = require('fs');
const path = require('path');

const yaml = fs.readFileSync(path.resolve(__dirname, '..', '..', '..', 'codemagic.yaml'), 'utf8').replace(/\r\n/g, '\n');

test('every workflow that builds the app pins Xcode 26.6', () => {
  const lines = yaml.split('\n').filter((l) => /^\s+xcode:/.test(l));
  expect(lines.length).toBeGreaterThanOrEqual(2);
  for (const line of lines) expect(line.trim()).toMatch(/^xcode: 26\.6\b/);
});

test('no workflow builds with latest until the shell adopts UIScene', () => {
  expect(yaml).not.toMatch(/^\s+xcode: latest\b/m);
});
