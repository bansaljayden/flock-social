// THE SOS BUTTON STEPS ASIDE WHILE BIRDIE'S PANEL IS OPEN.
//
// The 2026-10-20 proportion pass found the red SOS disc showing as a sliver
// past the right edge of Birdie's panel on the Nest: drawn under the panel,
// still tappable on the few pixels left over. It already leaves the screen
// for the You tab and while its own sheet is open, for the same reason: it
// would sit over controls it does not belong to. Closing Birdie (X, Escape)
// puts it back.

import fs from 'fs';
import path from 'path';

// CRLF normalised: with core.autocrlf on, a checkout writes App.js with CRLF,
// and the guard below is matched up to its line end.
const APP = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8').replace(/\r\n/g, '\n');

test('the SOS button steps aside for Birdie\'s sheets only: closed, or a thread in the Nest\'s page, it stays', () => {
  // 'inline' (2026-11-06) is an answer in the Nest's own page, which covers
  // nothing, so the emergency control stays beside it. The docked panel and
  // the full screen are drawn over SOS's corner, and there it steps aside.
  expect(APP).toContain(
    "const SafetyButton = () => safetyOn && currentScreen === 'main' && currentTab !== 'profile' && !showSOS && (aiChatMode === 'bubble' || aiChatMode === 'inline') && ("
  );
  const guard = APP.match(/const SafetyButton = \(\) => (safetyOn && [^\n]*?) && \(\n/);
  expect(guard).not.toBeNull();
  // eslint-disable-next-line no-new-func
  const shown = (aiChatMode) => !!new Function('safetyOn', 'currentScreen', 'currentTab', 'showSOS', 'aiChatMode', `return (${guard[1]});`)(true, 'main', 'home', false, aiChatMode);
  expect(shown('bubble')).toBe(true);
  expect(shown('inline')).toBe(true);
  expect(shown('panel')).toBe(false);
  expect(shown('fullscreen')).toBe(false);
});

test("'bubble' is the closed state, the one closing Birdie returns to", () => {
  expect(APP).toContain("const [aiChatMode, setAiChatMode] = useState('bubble');");
  expect(APP).toContain("const closeAiChat = () => setAiChatMode('bubble');");
});
