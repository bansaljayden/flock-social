// Messages and direct messages, traced 2026-09-04. Source contracts.
const fs = require('fs');
const path = require('path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const app = read('App.js');
const modal = read('components/NewDmModal.js');
const messages = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'backend', 'routes', 'messages.js'), 'utf8');
const handlers = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'backend', 'sockets', 'handlers.js'), 'utf8');

test('a DM screen with no conversation is not a blank dead end', () => {
  expect(app).toMatch(/const MissingDmPanel = \(\) => \(/);
  expect(app).toMatch(/if \(!selectedDm\) return <MissingDmPanel \/>;/);
  expect(app).toMatch(/This conversation is not here/);
  expect(app).toMatch(/Back to Messages/);
});

test('a reconnect keeps the thread this session already read', () => {
  const i = app.indexOf('const loadDmConversations = useCallback');
  const fn = app.slice(i, i + 2600);
  expect(fn).toMatch(/setDirectMessages\(prev => fresh\.map\(c => \{/);
  expect(fn).toMatch(/messages: old && old\.messages && old\.messages\.length \? old\.messages : \[\],/);
});

test('a photo the server re-encoded is one bubble, not two', () => {
  expect(app).toMatch(/&& !!localImage === !!\(server\.image_url \|\| null\);/);
  expect(app).not.toMatch(/&& localImage === \(server\.image_url \|\| null\);/);
});

test('the typing indicator is reset when the open thread changes', () => {
  const i = app.indexOf('// DM typing indicators');
  const eff = app.slice(i, i + 900);
  expect(eff).toMatch(/setDmIsTyping\(false\);\s*setDmTypingUser\(''\);/);
});

test('one venue is one row in every DM tally', () => {
  expect((messages.match(/GROUP BY venue_name ORDER BY vote_count DESC/g) || []).length).toBe(2);
  expect((handlers.match(/GROUP BY venue_name ORDER BY vote_count DESC/g) || []).length).toBe(1);
  expect(messages).not.toMatch(/GROUP BY venue_name, venue_id/);
  expect(handlers).not.toMatch(/GROUP BY venue_name, venue_id/);
  expect((messages.match(/MIN\(venue_id\) FILTER \(WHERE venue_id IS NOT NULL\) AS venue_id/g) || []).length).toBe(2);
  expect((handlers.match(/MIN\(venue_id\) FILTER \(WHERE venue_id IS NOT NULL\) AS venue_id/g) || []).length).toBe(1);
});

test('the person row shows something the server actually returns', () => {
  expect(modal).not.toMatch(/\{user\.email\}/);
  expect(modal).toMatch(/user\.shared_flocks > 0 \?/);
});

test('the DM unread badge is capped and announced', () => {
  expect(app).toMatch(/\{dm\.unread > 99 \? '99\+' : dm\.unread\}<span className="sr-only"> unread messages<\/span>/);
  expect(app).toMatch(/minWidth: '20px', height: '20px', padding: '0 6px', borderRadius: '10px', background: 'linear-gradient\(135deg, #EF4444, #DC2626\)'/);
});
