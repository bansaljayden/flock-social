// The client half of the moderation loop: the console hears a new report
// live, and reported content leaves the reporter's own screen.
const fs = require('fs');
const path = require('path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

test('the console registers the moderation_report event and refreshes on it', () => {
  expect(read('services/socket.js')).toMatch(/export function onModerationReport\(callback\) \{\s*return register\('moderation_report', callback\);/);
  const dash = read('website/ModerationDashboard.js');
  expect(dash).toMatch(/import \{ connectSocket, onModerationReport \} from '\.\.\/services\/socket';/);
  expect(dash).toMatch(/return onModerationReport\(\(\) => \{\s*if \(document\.hidden\) return;\s*load\(\{ background: true \}\);/);
});

test('a successful report hides the content for the reporter only', () => {
  const sheet = read('components/ModerationSheet.js');
  expect(sheet).toMatch(/onReported\?\.\(\{ contentType, contentId, flockId: target\.flockId \?\? null \}\)/);
  const app = read('App.js');
  expect(app).toMatch(/onReported=\{\(ev\) => \{\s*setFlocks\(prev => applyTakedownToFlocks\(prev, ev\)\);\s*setDirectMessages\(prev => applyTakedownToDms\(prev, ev\)\);/);
});
