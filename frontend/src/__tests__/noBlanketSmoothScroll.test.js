/**
 * The app has no blanket smooth scroll (app audit 2026-10-03). App.js carried
 * `* { scroll-behavior: smooth }` and `[style*="overflow"] { scroll-behavior:
 * smooth }`, which turned every programmatic scroll into an animation: a chat
 * opening glided through its history, the keep-your-place correction when
 * older messages load slid, the keyboard lift lagged, and jump-to-message
 * animated despite its own "No smooth scroll" comment. A scroll that should
 * glide asks for it explicitly. FRONTEND test (jest via react-scripts).
 */
const fs = require('fs');
const path = require('path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '');

test('App.js declares no scroll-behavior: smooth rule', () => {
  expect(code(read('App.js'))).not.toMatch(/scroll-behavior:\s*smooth/);
});

test('the scrolls that should glide still ask for it themselves', () => {
  expect(read('components/chat/MessageList.js')).toContain("el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });");
  expect(read('App.js')).toContain("el.scrollTo({ top: 0, behavior: 'smooth' });");
});

test('the scrolls that must arrive at once set no behavior, so nothing makes them glide', () => {
  expect(read('screens/ChatDetail.js')).toContain("el.scrollIntoView({ block: 'center' });");
  expect(read('components/chat/MessageList.js')).toContain('if (grew > 0) el.scrollTop = el.scrollTop + grew;');
});
