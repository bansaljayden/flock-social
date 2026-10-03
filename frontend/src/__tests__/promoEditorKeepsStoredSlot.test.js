/**
 * The promotion editor shows the time slot a deal really has (venue audit
 * 2026-10-03). The quick-deal chips save "Weekend", which the editor's select
 * did not offer, so a quick deal opened in Edit read "Happy Hour" and choosing
 * Happy Hour changed nothing. FRONTEND test (jest via react-scripts).
 */
const fs = require('fs');
const path = require('path');

const APP = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8');
const DASH = fs.readFileSync(path.join(__dirname, '..', 'screens', 'VenueDashboard.js'), 'utf8');

test('every time slot a quick deal can save is one the editor offers', () => {
  const chips = /\{\[('Happy Hour'[^\]]*)\]\.map\(slot =>/.exec(DASH);
  expect(chips).not.toBeNull();
  const saved = chips[1].split(',').map((x) => x.trim().replace(/'/g, ''));
  const select = APP.slice(APP.indexOf('<select id="promo-time-slot"'), APP.indexOf('</select>', APP.indexOf('<select id="promo-time-slot"')));
  for (const slot of saved) expect(select).toContain(`<option value="${slot}">`);
});

test('a stored value the lists do not name is shown as itself, not as the first option', () => {
  expect(APP).toContain('{form.time && !PROMO_TIME_SLOTS.includes(form.time) && <option value={form.time}>{form.time}</option>}');
  expect(APP).toContain('{form.days && !PROMO_DAYS.includes(form.days) && <option value={form.days}>{form.days}</option>}');
  const lists = /const PROMO_TIME_SLOTS = \[([^\]]*)\];/.exec(APP)[1];
  const select = APP.slice(APP.indexOf('<select id="promo-time-slot"'), APP.indexOf('</select>', APP.indexOf('<select id="promo-time-slot"')));
  const offered = [...select.matchAll(/<option value="([^"]+)">/g)].map((m) => `'${m[1]}'`).join(', ');
  expect(lists).toBe(offered);
});
