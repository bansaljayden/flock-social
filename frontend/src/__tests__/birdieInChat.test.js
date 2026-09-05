// Birdie is present in the flock chat. the maintainer's TestFlight note of
// 2026-08-21; wired 2026-09-04. Source contracts.
const fs = require('fs');
const path = require('path');

const app = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8');
const chat = fs.readFileSync(path.join(__dirname, '..', 'screens', 'ChatDetail.js'), 'utf8');

test('the chat has an Ask Birdie control that opens the panel', () => {
  // BIRDIE MOVED TO THE PLUS. It was a glyph in the header's "Features" rail,
  // behind a pill that cost the plan's name its last few characters. The rail
  // is gone and every one of its controls is a tile in the composer sheet, so
  // what this asserts is that the chat still opens the panel, from the control
  // the thumb is already on.
  expect(chat).toMatch(/onAskBirdie=\{\(\) => \{ setPlusOpen\(false\); openBirdie\(\); \}\}/);
  // The tile draws the bird glyph, and the sheet steps it down a size because
  // it is the icon set's one solid mark: a filled glyph reads heavier than an
  // outline at the same nominal size, which is exactly what went wrong in the
  // rail it came from.
  const sheet = fs.readFileSync(
    path.join(__dirname, '..', 'components', 'chat', 'sheets', 'ComposerPlusSheet.js'), 'utf8'
  );
  expect(sheet).toMatch(/glyph: Icons\.birdie, label: 'Ask Birdie'/);
  expect(chat).toMatch(/^  openBirdie,$/m);
});

test('App hands the chat the opener, and the panel opens over the chat with this flock as context', () => {
  expect(app).toMatch(/const openBirdie = useCallback\(\(\) => setAiChatMode\('panel'\), \[\]\);/);
  const i = app.indexOf('const chatDetailProps = {');
  const block = app.slice(i, app.indexOf('return <ChatDetail {...chatDetailProps} />;', i));
  expect(block).toMatch(/^\s+openBirdie,$/m);
  // The panel mounts at the root, not inside a tab tree, so it can show over the chat.
  expect(app).toMatch(/\{aiAssistantModal\}/);
  expect(app).toMatch(/const onFlock = currentScreen === 'chatDetail' \|\| currentScreen === 'detail';/);
});
