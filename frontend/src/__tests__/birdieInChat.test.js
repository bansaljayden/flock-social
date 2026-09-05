// Birdie is present in the flock chat. the maintainer's TestFlight note of
// 2026-08-21; wired 2026-09-04. Source contracts.
const fs = require('fs');
const path = require('path');

const app = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8');
const chat = fs.readFileSync(path.join(__dirname, '..', 'screens', 'ChatDetail.js'), 'utf8');

test('the chat header has an Ask Birdie control that opens the panel', () => {
  expect(chat).toMatch(/<button aria-label="Ask Birdie" className="hit44 glass-btn" onClick=\{\(\) => \{ setChatNavOpen\(false\); openBirdie\(\); \}\}/);
  // The bird glyph, not a still bird: still birds have a 40px floor and this
  // is a 36px header control. The SIZE is deliberately not pinned. It was 18
  // while every other glyph in that rail was 15, which made the one solid mark
  // in the row both the largest and the heaviest thing in it, and pinning the
  // number here meant the rail could not be balanced without editing a test
  // about whether the control exists at all.
  expect(chat).toMatch(/aria-label="Ask Birdie"[^\n]*\{Icons\.birdie\('white', \d+\)\}<\/button>/);
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
