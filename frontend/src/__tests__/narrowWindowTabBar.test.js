// The bottom tab bar fits a window narrower than a phone. Five tabs with
// 14 px side padding ran 3 px off a 320 px window; iPadOS 27 makes iPhone-only
// apps freely resizable, so App Review can open Flock that narrow.
const fs = require('fs');
const path = require('path');

const app = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '..', 'index.css'), 'utf8');

test('the tab buttons carry the class the narrow-window rule targets', () => {
  expect(app).toContain('<button className="hit44 main-nav-tab" key={t.id} onClick={() => handleTabClick(t.id)}');
});

test('below 360 px the side padding drops to 8 px, and only there', () => {
  const rule = css.slice(css.indexOf('@media (max-width: 359px) {'));
  expect(rule).toMatch(/^@media \(max-width: 359px\) \{\s*\.main-nav-tab \{\s*padding-left: 8px !important;\s*padding-right: 8px !important;\s*\}\s*\}/);
  expect((css.match(/\.main-nav-tab/g) || []).length).toBe(1);
});
