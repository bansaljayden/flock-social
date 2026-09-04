// The DM side of what the flock side already did. Source contracts.
const fs = require('fs');
const path = require('path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

test('guarded DM emits answer whether they happened', () => {
  const s = read('services/socket.js');
  expect(s).toMatch(/export function dmReact\(dmId, emoji, receiverId\) \{\s*if \(!socket\?\.connected\) return false;/);
  expect(s).toMatch(/export function dmRemoveReact\(dmId, emoji, receiverId\) \{\s*if \(!socket\?\.connected\) return false;/);
  expect(s).toMatch(/export function dmPinVenue\(receiverId, venueData\) \{\s*if \(!socket\?\.connected\) return false;/);
});

test('a DM reaction over a dead socket falls back to REST instead of vanishing', () => {
  const d = read('screens/DmDetail.js');
  expect(d).toMatch(/addDmReaction, removeDmReaction \} from '\.\.\/services\/api'/);
  expect(d).toMatch(/if \(!dmRemoveReact\(m\.id, g\.emoji, otherUser\)\) removeDmReaction\(m\.id, g\.emoji\)/);
  expect(d).toMatch(/else if \(!dmReact\(m\.id, g\.emoji, otherUser\)\) \{ addDmReaction\(m\.id, g\.emoji\)/);
  expect(d).toMatch(/if \(!dmReact\(m\.id, emoji, selectedDmId\)\) addDmReaction\(m\.id, emoji\)/);
});

test('a DM venue pin over a dead socket persists over REST', () => {
  const a = read('App.js');
  expect((a.match(/if \(!dmPinVenue\(selectedDmId, v\)\) pinDmVenue\(selectedDmId, v\)/g) || []).length).toBe(2);
  expect(a).not.toMatch(/\n\s+dmPinVenue\(selectedDmId, v\);\n/);
  const api = read('services/api.js');
  expect(api).toMatch(/export async function pinDmVenue\(userId, v\) \{[\s\S]*?method: 'PUT'/);
});

test('DM search says when nothing matches, and an empty query keeps scrollback', () => {
  const d = read('screens/DmDetail.js');
  expect(d).toMatch(/No messages match "\{dmChatSearch\}"/);
  expect(d).toMatch(/!\(showDmChatSearch && dmChatSearch\.trim\(\)\) && !dmAtTop\[selectedDmId\]/);
});
