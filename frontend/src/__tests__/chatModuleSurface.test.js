/**
 * THE MODULE'S PUBLIC SURFACE (2026-09-05).
 *
 * Four workstreams wrote components/chat in parallel and each appended to the
 * same index.js, so only the first group's exports survived: the input bar,
 * every card and every sheet were written, tested, and unreachable. The
 * integration pass imports from the barrel and nowhere else, so a missing line
 * there is a component that does not exist as far as the screens are concerned.
 *
 * This asserts the barrel covers every component file in the folder, so the
 * next component somebody adds cannot be quietly stranded.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test chatModuleSurface --watchAll=false
 */
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'components', 'chat');
const barrel = fs.readFileSync(path.join(DIR, 'index.js'), 'utf8').replace(/\r\n/g, '\n');

const componentFiles = [];
const walk = (dir, prefix) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) { walk(path.join(dir, entry.name), `${prefix}${entry.name}/`); continue; }
    if (!entry.name.endsWith('.js') || entry.name === 'index.js') continue;
    componentFiles.push(prefix + entry.name.replace(/\.js$/, ''));
  }
};
walk(DIR, '');

test('every component file in the folder is reachable from the barrel', () => {
  const missing = componentFiles.filter((f) => !barrel.includes(`'./${f}'`));
  expect(missing).toEqual([]);
  // And the walk found something, so an empty list cannot mean an empty folder.
  expect(componentFiles.length).toBeGreaterThan(15);
});

test('the module imports as one thing, and the pieces the screens need are real', () => {
  const mod = require('../components/chat');
  const needed = [
    'MessageList', 'MessageGroup', 'MessageRow', 'StatusLine', 'TypingRow', 'DayDivider',
    'ChatInputBar', 'BillCard', 'PollCard', 'VenueCardRow', 'LocationCard', 'WhoIsHereCard',
    'SystemRow', 'NudgeRow', 'FlockProfileSheet', 'ComposerPlusSheet', 'PinStrip', 'PinnedMessageBar',
  ];
  const absent = needed.filter((n) => typeof mod[n] !== 'function' && typeof mod[n] !== 'object');
  expect(absent).toEqual([]);
  // The helpers the screens call directly, not just the components.
  expect(typeof mod.groupRows).toBe('function');
  expect(typeof mod.groupReactions).toBe('function');
  expect(typeof mod.formatMoney).toBe('function');
});
