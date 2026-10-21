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

const APP = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8');

test('the SOS button is drawn only while Birdie is closed to its bubble', () => {
  expect(APP).toContain(
    "const SafetyButton = () => safetyOn && currentScreen === 'main' && currentTab !== 'profile' && !showSOS && aiChatMode === 'bubble' && ("
  );
});

test("'bubble' is the closed state, the one closing Birdie returns to", () => {
  expect(APP).toContain("const [aiChatMode, setAiChatMode] = useState('bubble');");
  expect(APP).toContain("const closeAiChat = () => setAiChatMode('bubble');");
});
