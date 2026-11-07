/**
 * ONE WORD FOR A LOCKED-IN PLAN, IN SENTENCE CASE.
 *
 * The Nest said Locked in, the plan screen's badge Locked In, the Messages
 * list's chip Confirmed, and the guest page's tag LOCKED IN (its stylesheet
 * set the tag in capitals). Every place a plan's status shows now says
 * Locked in: the Nest's hero and chips, the plan screen, the Messages list,
 * the chat's header and the guest page's venue row.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test lockedInWording --watchAll=false
 */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(SRC, ...p), 'utf8').replace(/\r\n/g, '\n');

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
  const full = path.join(dir, d.name);
  if (d.isDirectory()) return d.name === '__tests__' || d.name === 'node_modules' ? [] : walk(full);
  return /\.(js|jsx|css)$/.test(d.name) ? [full] : [];
});

describe('a locked-in plan is Locked in wherever its status shows', () => {
  test('nothing in the app or the site says Locked In', () => {
    const files = walk(SRC);
    // The reading is not blind: it sees the files that carry the status.
    for (const f of ['screens/FlockDetail.js', 'screens/ChatListScreen.js', 'lib/nestHero.js', 'website/GuestInvite.js']) {
      expect(files.map((x) => path.relative(SRC, x).split(path.sep).join('/'))).toContain(f);
    }
    const offenders = files
      .filter((f) => /Locked In\b|LOCKED IN(?! AT A BAR)/.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(SRC, f));
    expect(offenders).toEqual([]);
  });

  test('the Nest, the plan screen, the Messages list, the chat header and the guest page each say it', () => {
    expect(read('lib', 'nestHero.js')).toMatch(/return \{ key: 'locked', label: 'Locked in' \};/);
    expect(read('lib', 'nestHero.js')).toMatch(/return \{ label: 'Locked in', tone: 'locked', icon: 'check' \};/);
    expect(read('screens', 'FlockDetail.js')).toContain("isConfirmed ? 'Locked in' : 'Planning'");
    expect(read('screens', 'ChatListScreen.js')).toContain("f.status === 'confirmed' ? 'Locked in'");
    expect(read('screens', 'ChatDetail.js')).toContain("flock.status === 'confirmed' ? 'Locked in'");
    expect(read('website', 'GuestInvite.js')).toContain('<span className="gi-tag gi-tag--locked">Locked in</span>');
  });

  test('the Messages list never calls a plan Confirmed', () => {
    const list = read('screens', 'ChatListScreen.js');
    const label = list.slice(list.indexOf('const statusLabel = '), list.indexOf('\n', list.indexOf('const statusLabel = ')));
    expect(label).toContain("'Locked in'");
    expect(label).not.toContain("'Confirmed'");
  });

  test("the guest page's tag is not set in capitals by its stylesheet", () => {
    const css = read('website', 'GuestInvite.css');
    const rule = /\n\.gi-tag \{([^}]*)\}/.exec(css);
    expect(rule).not.toBeNull();
    expect(rule[1]).not.toMatch(/text-transform/);
    // Nor by a rule around it: the tags sit in .gi-tags inside a venue row.
    for (const sel of ['.gi-tags', '.gi-venue', '.gi-venues']) {
      const around = new RegExp(`\\n${sel.replace('.', '\\.')} \\{([^}]*)\\}`).exec(css);
      if (around) expect(`${sel} ${/text-transform:\s*uppercase/.test(around[1])}`).toBe(`${sel} false`);
    }
  });
});
