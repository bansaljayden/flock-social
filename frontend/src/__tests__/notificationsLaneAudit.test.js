/**
 * NOTIFICATIONS LANE (audit 2026-09-05): source pins for the client half.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test notificationsLaneAudit --watchAll=false
 */
const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

test('a browser signing out without a token only clears rows of its own kind', () => {
  const api = read('services/api.js');
  const fb = read('services/firebase.js');
  expect(api).toContain("export async function unregisterAllTokens(deviceType) {");
  expect(api).toContain("const kind = ['web', 'ios', 'android'].includes(deviceType) ? `?deviceType=${encodeURIComponent(deviceType)}` : '';");
  expect(fb).toContain("? unregisterAllTokens(isNativeApp() ? (window.Capacitor.getPlatform() === 'android' ? 'android' : 'ios') : 'web').catch(() => {})");
});

test('a deleted DM thread comes back when the list read says it has unread messages', () => {
  const app = read('App.js');
  expect(app).toContain(".filter(c => hidden.includes(c.userId) && Number(c.unread) > 0)");
  expect(app).toContain("const fresh = (data.conversations || []).filter(c => !hidden.includes(c.userId) || revivedIds.includes(c.userId));");
  expect(app).toContain("const revived = prevDeleted.filter(id => !revivedIds.includes(id));");
});

test('live messages in an open thread mark read once per thread per window, with the newest id', () => {
  const app = read('App.js');
  expect(app).toContain('const dmReadTimersRef = useRef({});');
  expect(app).toContain("if (timers[otherUserId]) clearTimeout(timers[otherUserId]);");
  expect(app).toContain("timers[otherUserId] = setTimeout(() => {\n          delete timers[otherUserId];\n          markDmRead(msg.id).catch(() => {});\n        }, 1500);");
  expect(app).not.toContain("      if (threadOpen && isServerId(msg.id)) {\n        markDmRead(msg.id).catch(() => {});\n      }");
});
