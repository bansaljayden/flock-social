/**
 * BIRDIE AND ROOST (chat audit, 2026-09-05): the chirp box unlocks at the
 * reset it prints, a dropped reply is said in voice, and Roost keeps the
 * server's sentence for a refusal.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test aiChatLaneAudit --watchAll=false
 */
const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8').replace(/\r\n/g, '\n');

test('the Birdie box unlocks at the reset time it prints', () => {
  const app = read('App.js');
  expect(app).toContain("&& (!aiResetsAt || Date.now() < Date.parse(aiResetsAt));");
  expect(app).toContain("const t = setTimeout(() => { setAiResetsAt(null); refreshEntitlements(); }, Math.min(ms + 1000, 2147483647));");
  expect(app).toContain("}, [aiResetsAt, refreshEntitlements]);");
});

test('a dropped reply reads in Birdie voice, not as a form submission', () => {
  const api = read('services/api.js');
  expect(api).toContain("if (err && err.isBadReply) err.message = 'lost that one. ask again';");
});

test('Roost renders a 4xx sentence as a quiet answer and keeps the error row for 5xx', () => {
  const chat = read('components/VenueAdvisorChat.js');
  expect(chat).toContain("const said = [400, 403, 429].includes(Number(err?.status)) && typeof err?.message === 'string' && err.message.trim().length > 12");
  expect(chat).toContain("? (said ? { ...turn, status: 'done', answer: { mode: 'refusal', text: said } } : { ...turn, status: 'error' })");
});
