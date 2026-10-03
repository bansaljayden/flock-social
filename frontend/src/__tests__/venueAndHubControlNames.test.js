/**
 * Controls on the venue dashboard and the money hub say what they act on
 * (dashboard audit 2026-10-03): every deal and event's Edit read just "Edit",
 * the hub's expense rows' buttons did not name the bill, the deal-time chips
 * did not say which was chosen, and the hub's "Go to" links scrolled without
 * moving focus. FRONTEND test (jest via react-scripts).
 */
const fs = require('fs');
const path = require('path');

const DASH = fs.readFileSync(path.join(__dirname, '..', 'screens', 'VenueDashboard.js'), 'utf8');
const REV = fs.readFileSync(path.join(__dirname, '..', 'screens', 'RevenueScreen.js'), 'utf8');

test('no venue dashboard control is labelled just "Edit"', () => {
  expect(DASH).not.toContain('aria-label="Edit"');
  expect(DASH).toContain("aria-label={promo.title ? `Edit ${promo.title}` : 'Edit this deal'}");
  expect(DASH).toContain("aria-label={event.title ? `Edit ${event.title}` : 'Edit this event'}");
  expect(DASH).toContain('aria-pressed={dealTimeSlot === slot}');
});

test('the hub names the bill on its row buttons, and its jump links move focus', () => {
  expect(REV).toContain('aria-label={`Edit ${label}`}');
  expect(REV).toMatch(/el\.setAttribute\('tabindex', '-1'\);\s*el\.focus\(\{ preventScroll: true \}\);/);
});
