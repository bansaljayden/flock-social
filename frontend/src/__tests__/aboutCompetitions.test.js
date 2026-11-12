/**
 * /about's Competitions and Honors (2026-11-06), from src/website/competitions.js.
 *
 * What this pins:
 *   1. the data keeps to its rules: every entry names its organizer, who
 *      entered it and a status that is a past or present fact, never a
 *      result (finalist, winner, award) and never a prize, fee or deadline; the
 *      date behind a status says the same month as the words, and none is in
 *      the future, except the main ones being entered next ("Entering,
 *      <month>", his call 2026-11-11), which are never in the past; Asad is
 *      on DECA, the Diamond Challenge and Conrad; every credit says "By";
 *   2. the page renders every entry as a row of the Competitions ledger on the
 *      navy band, between the milestones (or the honors) and where things
 *      stand: the name, who runs it and who entered it, beside the status. The
 *      middle column, a line on what went in, came off on 2026-11-11 (his
 *      call: not needed), and the data no longer carries it;
 *   3. the Honors section is there only when HONORS has an entry. Empty, the
 *      page says nothing about honors at all (no heading, no "coming soon");
 *      with one, it is the dated log on the stone band before the
 *      competitions, and no two neighbouring sections share a band;
 *   4. the DECA result the site has claimed since August is an honor, not a
 *      milestone labelled "Award", and the JSON-LD `award` says it in the
 *      same words as the Honors entry.
 *
 * Both Honors states render the real AboutPage with competitions.js mocked
 * inside jest.isolateModules, to static markup from that fresh registry.
 *
 * "In the future" is measured against the real clock on purpose: a status is
 * a fact about the past or present whenever the suite runs, and a pinned
 * clock would fail the day an honor from after 2026-11-06 is added.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test --watchAll=false aboutCompetitions
 */

const fs = require('fs');
const path = require('path');
const React = require('react');
const { render } = require('@testing-library/react');

jest.mock('../website/LiveDemo', () => ({ __esModule: true, default: () => null }));
jest.mock('../components/ui/BirdieBird', () => ({
  __esModule: true,
  default: () => null,
  WARM_BIRD: { body: '', head: '', flap: null, neck: '0 0' },
  BIRDIE: { body: '', head: '', flap: null, neck: '0 0' },
}));

const { COMPETITIONS, HONORS } = require('../website/competitions');
const AboutPage = require('../website/AboutPage').default;

const flat = (s) => s.replace(/\s+/g, ' ').trim();
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

// "2026-10" -> "October 2026"; "2026-11-06" -> "November 6, 2026".
function spoken(date) {
  const [y, m, d] = date.split('-').map(Number);
  return d ? `${MONTHS[m - 1]} ${d}, ${y}` : `${MONTHS[m - 1]} ${y}`;
}
// The first moment of the day or month a date names, local time.
const startOf = (date) => {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d || 1).getTime();
};

const RESULT_WORDS = /finalist|semi-?final|winner|\bwon\b|\bwin\b|award|\bplace[ds]?\b|prize|honou?r/i;
const MONEY_AND_DATES = /\$|\bprize|\bfee\b|deadline|\bdue\b|scholarship/i;

// Renders the real page with competitions.js replaced, from a fresh registry,
// to static markup (the testing library registers hooks when it is required,
// so it cannot be required again inside a test). The effect that sets the
// title does not run; nothing here reads it.
function renderWith(data) {
  let markup;
  jest.isolateModules(() => {
    jest.doMock('../website/competitions', () => data);
    // eslint-disable-next-line global-require
    const IsoReact = require('react');
    // eslint-disable-next-line global-require
    const { renderToStaticMarkup } = require('react-dom/server');
    // eslint-disable-next-line global-require
    const Page = require('../website/AboutPage').default;
    markup = renderToStaticMarkup(IsoReact.createElement(Page));
  });
  const container = document.createElement('div');
  container.innerHTML = markup;
  return { container, unmount: () => {} };
}

const BANDS = ['lp-sec-navy', 'lp-sec-paper', 'lp-sec-sand'];
const bandOf = (section) => BANDS.find((b) => section.classList.contains(b)) || 'other';
const sectionsOf = (container) => Array.from(container.querySelectorAll('main > section'));

afterEach(() => {
  jest.dontMock('../website/competitions');
});

// ───────────────────────────────────────────────────────────────────────────
describe('competitions.js keeps to its rules', () => {
  test('every entry names its organizer, who entered it and a status, and nothing about what went in', () => {
    expect(COMPETITIONS.length).toBeGreaterThan(0);
    const allowed = ['name', 'organizer', 'logo', 'status', 'date', 'team'];
    for (const c of COMPETITIONS) {
      expect(Object.keys(c).filter((k) => !allowed.includes(k))).toEqual([]);
      for (const k of ['name', 'organizer', 'status', 'team']) {
        expect([c.name, k, typeof c[k] === 'string' && c[k].trim().length > 0]).toEqual([c.name, k, true]);
      }
    }
    expect(new Set(COMPETITIONS.map((c) => c.name)).size).toBe(COMPETITIONS.length);
  });

  test('a status is a fact about the entry, never a result, a prize, a fee or a deadline', () => {
    for (const c of COMPETITIONS) {
      expect([c.name, c.status]).toEqual([c.name, expect.stringMatching(/^(Submitted|Pitched|Accepted|Entering)\b/)]);
      const words = [c.name, c.organizer, c.status, c.team].join(' | ');
      expect([c.name, RESULT_WORDS.exec(words)]).toEqual([c.name, null]);
      expect([c.name, MONEY_AND_DATES.exec(words)]).toEqual([c.name, null]);
    }
  });

  /* His call 2026-11-11: the main competitions Flock is entering next are
     listed too ("Entering, <month>"). An upcoming one is never in the past:
     when its month goes by, this fails until the status says what happened,
     which keeps the page from claiming a plan that already ran. */
  test('the date behind a status says the same thing as its words; what is in is not in the future, and what is next is not in the past', () => {
    const now = Date.now();
    const thisMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime();
    for (const c of COMPETITIONS) {
      expect([c.name, c.date]).toEqual([c.name, expect.stringMatching(/^\d{4}-\d{2}(-\d{2})?$/)]);
      expect([c.name, c.status.endsWith(spoken(c.date))]).toEqual([c.name, true]);
      if (c.status.startsWith('Entering')) {
        expect([c.name, startOf(c.date) >= thisMonth]).toEqual([c.name, true]);
      } else {
        expect([c.name, startOf(c.date) <= now]).toEqual([c.name, true]);
      }
    }
    // Upcoming first, soonest first; then the rest, newest first.
    const next = COMPETITIONS.filter((c) => c.status.startsWith('Entering'));
    const done = COMPETITIONS.filter((c) => !c.status.startsWith('Entering'));
    expect(COMPETITIONS).toEqual([...next, ...done]);
    const nextDates = next.map((c) => startOf(c.date));
    expect(nextDates).toEqual([...nextDates].sort((a, b) => a - b));
    const doneDates = done.map((c) => startOf(c.date));
    expect(doneDates).toEqual([...doneDates].sort((a, b) => b - a));
  });

  test('Asad is on DECA, the Diamond Challenge and Conrad; the rest are the maintainer\'s alone', () => {
    const withAsad = COMPETITIONS.filter((c) => /Asad Ali/.test(c.team)).map((c) => c.name);
    expect(withAsad).toEqual(['Start-Up Business Plan', 'Diamond Challenge', 'Conrad Challenge']);
    for (const c of COMPETITIONS) {
      // "By", never "Entered by": an upcoming entry has not been entered.
      expect([c.name, c.team]).toEqual([c.name, expect.stringMatching(/^By Jayden Bansal( and Asad Ali)?$/)]);
    }
  });

  /* His call 2026-11-11: each competition shows its organizer's logo. The
     file must be in public/, be the size the entry says (so the tile keeps
     its shape before it loads), and stay small; and nothing claims more than
     the status does. */
  test('every entry has its organizer\'s logo, a real file of the size it says', () => {
    const PUBLIC = path.join(__dirname, '..', '..', 'public');
    for (const c of COMPETITIONS) {
      expect([c.name, typeof c.logo]).toEqual([c.name, 'object']);
      expect([c.name, c.logo.src]).toEqual([c.name, expect.stringMatching(/^\/logos\/competitions\/[a-z0-9-]+\.png$/)]);
      const file = path.join(PUBLIC, c.logo.src);
      expect([c.name, fs.existsSync(file)]).toEqual([c.name, true]);
      const png = fs.readFileSync(file);
      expect([c.name, png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([c.name, c.logo.width, c.logo.height]);
      expect([c.name, png.length < 80 * 1024]).toEqual([c.name, true]);
    }
    const all = JSON.stringify(COMPETITIONS);
    expect(all).not.toMatch(/certif|endors|partner|official|sponsor/i);
  });

  test('the main ones he named are listed, and an upcoming one never says Submitted', () => {
    const names = COMPETITIONS.map((c) => c.name);
    for (const n of ['Diamond Challenge', 'Blue Ocean Competition', 'Conrad Challenge', 'Start-Up Business Plan']) {
      expect(names).toContain(n);
    }
    const upcoming = COMPETITIONS.filter((c) => /Diamond|Blue Ocean|Start-Up/.test(c.name));
    for (const c of upcoming) expect([c.name, c.status]).toEqual([c.name, expect.stringMatching(/^Entering, /)]);
  });

  test('Jacobson is listed now that it is submitted (2026-11-11), the newest of what is in', () => {
    expect(COMPETITIONS.find((c) => !c.status.startsWith('Entering'))).toEqual({
      name: 'Jacobson Innovator Competition',
      organizer: 'University of Iowa',
      logo: { src: '/logos/competitions/university-of-iowa.png', width: 640, height: 186 },
      status: 'Submitted November 11, 2026',
      date: '2026-11-11',
      team: 'By Jayden Bansal',
    });
  });

  test('the science-fair project is not Flock, and no team member\'s school is named', () => {
    const all = JSON.stringify([COMPETITIONS, HONORS]);
    expect(all).not.toMatch(/LVSF|Lehigh Valley Science|FocusSeg|ISEF|Delaware Valley Science/i);
    expect(all).not.toMatch(/Moravian/i);
  });

  test('house copy rules: no em or en dash, and the curly apostrophe the site uses', () => {
    const all = JSON.stringify([COMPETITIONS, HONORS]);
    expect(all).not.toMatch(/[—–]/);
    expect(all).not.toMatch(/[A-Za-z]'[A-Za-z]/);
  });

  test('each honor is a dated plain sentence, or names its year while the month is unconfirmed', () => {
    expect(Array.isArray(HONORS)).toBe(true);
    const now = Date.now();
    for (const h of HONORS) {
      expect(Object.keys(h).filter((k) => !['when', 'date', 'what'].includes(k))).toEqual([]);
      expect(typeof h.when === 'string' && h.when.length > 0).toBe(true);
      expect(h.what).toMatch(/^\S.*\.$/);
      if (h.date) {
        expect(h.date).toMatch(/^\d{4}-\d{2}(-\d{2})?$/);
        expect(h.when).toBe(spoken(h.date));
        expect(startOf(h.date) <= now).toBe(true);
      } else {
        // Never a bare label such as "Award": the year, and not a future one.
        expect([h.what, h.when]).toEqual([h.what, expect.stringMatching(/^\d{4}$/)]);
        expect(new Date(Number(h.when), 0, 1).getTime() <= now).toBe(true);
      }
    }
  });

  test('the DECA result is an honor, and the JSON-LD award says it in the same words', () => {
    const deca = HONORS.filter((h) => /DECA States/.test(h.what));
    expect(deca).toEqual([{ when: '2026', what: '1st place in Innovation Plan at Pennsylvania DECA States.' }]);
    // The Organization's one credibility claim, in both copies of the JSON-LD
    // (public/index.html for people, api/marketing-page.js for crawlers).
    const read = (rel) => fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8');
    const awards = [
      ...read('public/index.html').matchAll(/"award":\s*"([^"]+)"/g),
      ...read('api/marketing-page.js').matchAll(/\baward:\s*'([^']+)'/g),
    ].map((m) => m[1]);
    const words = deca[0].what.replace(/\.$/, '');
    expect(awards).toEqual([words, words]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('/about shows the competitions', () => {
  test('one row per entry in the Competitions ledger, in the order of competitions.js', () => {
    const { container, unmount } = render(React.createElement(AboutPage));
    const band = container.querySelector('section[aria-labelledby="ab-h-comps"]');
    expect(band).not.toBeNull();
    expect(flat(band.querySelector('h2').textContent)).toBe('Competitions');
    const rows = Array.from(band.querySelectorAll('.ab-comp'));
    expect(rows.map((r) => flat(r.querySelector('h3').textContent))).toEqual(COMPETITIONS.map((c) => c.name));
    rows.forEach((row, i) => {
      const c = COMPETITIONS[i];
      expect(Array.from(row.querySelectorAll('h3, p')).map((n) => flat(n.textContent)))
        .toEqual([c.name, c.organizer, c.team, c.status]);
      // Three parts: the organizer's logo, the competition, where it stands.
      expect(row.children).toHaveLength(3);
      expect(row.querySelector('.ab-comp-what')).toBeNull();
      const img = row.querySelector('.ab-comp-logo img');
      expect(img.getAttribute('src')).toBe(c.logo.src);
      expect(Number(img.getAttribute('width'))).toBe(c.logo.width);
      expect(Number(img.getAttribute('height'))).toBe(c.logo.height);
      // Named in words beside it, so the picture is not read out again.
      expect(img.getAttribute('alt')).toBe('');
      expect(img.getAttribute('loading')).toBe('lazy');
      const time = row.querySelector('.ab-comp-status time');
      if (c.date) {
        expect(time.getAttribute('datetime') || time.getAttribute('dateTime')).toBe(c.date);
      } else {
        expect(time).toBeNull();
      }
    });
    unmount();
  });

  test('the lead says where Flock competes, and nothing about what is being prepared', () => {
    const { container, unmount } = render(React.createElement(AboutPage));
    expect(flat(container.querySelector('section[aria-labelledby="ab-h-comps"] .lp-lead').textContent)).toBe('Where Flock competes.');
    expect(container.textContent).not.toMatch(/being prepared|In progress/i);
    unmount();
  });

  test('the ledger sits on the navy band between the milestones and where things stand', () => {
    const { container, unmount } = render(React.createElement(AboutPage));
    const sections = sectionsOf(container);
    const at = sections.findIndex((s) => s.getAttribute('aria-labelledby') === 'ab-h-comps');
    expect(bandOf(sections[at])).toBe('lp-sec-navy');
    expect(sections[at].classList.contains('lp-on-navy')).toBe(true);
    expect(sections[at + 1].getAttribute('aria-labelledby')).toBe('ab-h-now');
    const before = sections[at - 1].getAttribute('aria-labelledby');
    expect(before).toBe(HONORS.length ? 'ab-h-honors' : 'ab-h-milestones');
    unmount();
  });

  test('the page names no team member\'s school', () => {
    const { container, unmount } = render(React.createElement(AboutPage));
    expect(container.textContent).not.toMatch(/Moravian/i);
    unmount();
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('Honors appear only when there is one', () => {
  test('the live page matches HONORS: a section exactly when it has an entry', () => {
    const { container, unmount } = render(React.createElement(AboutPage));
    expect(container.querySelector('#ab-h-honors') !== null).toBe(HONORS.length > 0);
    unmount();
  });

  test('today the Honors section holds the LionCage and DECA results, newest first, and the milestones no longer do', () => {
    const { container, unmount } = render(React.createElement(AboutPage));
    const section = container.querySelector('section[aria-labelledby="ab-h-honors"]');
    expect(section).not.toBeNull();
    expect(bandOf(section)).toBe('lp-sec-sand');
    const items = Array.from(section.querySelectorAll('.ab-honors li'));
    expect(items.map((li) => flat(li.textContent))).toEqual([
      'November 6, 2026 2nd place in the Technology category and the Rising Entrepreneur Award at the LionCage Pitch Competition, Penn State Great Valley.',
      '2026 1st place in Innovation Plan at Pennsylvania DECA States.',
    ]);
    // A dated honor carries its date; a year alone gets no machine-readable date.
    expect(items[0].querySelector('time').getAttribute('datetime')).toBe('2026-11-06');
    expect(items[1].querySelector('time')).toBeNull();
    expect(flat(items[1].querySelector('.ab-when').textContent)).toBe('2026');

    const milestones = Array.from(container.querySelectorAll('.ab-milestones li')).map((li) => flat(li.textContent));
    expect(milestones.join(' | ')).not.toMatch(/DECA|\bAward\b/);
    // Said once on the page, in the Honors section.
    expect(container.textContent.match(/DECA States/g)).toHaveLength(1);

    const bands = sectionsOf(container).map(bandOf);
    for (let i = 1; i < bands.length; i += 1) expect([i, bands[i]]).not.toEqual([i, bands[i - 1]]);
    unmount();
  });

  test('empty: no section, no heading, and no word about honors anywhere on the page', () => {
    const { container, unmount } = renderWith({ COMPETITIONS, HONORS: [] });
    expect(container.querySelector('#ab-h-honors')).toBeNull();
    expect(container.querySelector('.ab-honors')).toBeNull();
    expect(container.textContent).not.toMatch(/honou?rs?\b/i);
    const bands = sectionsOf(container).map(bandOf);
    for (let i = 1; i < bands.length; i += 1) expect([i, bands[i]]).not.toEqual([i, bands[i - 1]]);
    unmount();
  });

  test('with an honor: the dated log on the stone band, before the competitions', () => {
    const honor = { when: 'October 2026', date: '2026-10', what: 'A test honor at a test competition.' };
    const { container, unmount } = renderWith({ COMPETITIONS, HONORS: [honor] });
    const section = container.querySelector('section[aria-labelledby="ab-h-honors"]');
    expect(section).not.toBeNull();
    expect(flat(section.querySelector('h2').textContent)).toBe('Honors');
    expect(bandOf(section)).toBe('lp-sec-sand');
    const items = Array.from(section.querySelectorAll('.ab-honors li'));
    expect(items.map((li) => flat(li.textContent))).toEqual(['October 2026 A test honor at a test competition.']);
    const time = items[0].querySelector('time.ab-when');
    expect(time.getAttribute('datetime') || time.getAttribute('dateTime')).toBe('2026-10');

    const sections = sectionsOf(container);
    const at = sections.indexOf(section);
    expect(sections[at - 1].getAttribute('aria-labelledby')).toBe('ab-h-milestones');
    expect(sections[at + 1].getAttribute('aria-labelledby')).toBe('ab-h-comps');
    const bands = sections.map(bandOf);
    for (let i = 1; i < bands.length; i += 1) expect([i, bands[i]]).not.toEqual([i, bands[i - 1]]);

    // The honors log is its own list: the App Store day stays the last
    // milestone, which appStoreLive.test.js holds it to.
    const milestones = Array.from(container.querySelectorAll('.ab-milestones li'));
    expect(flat(milestones[milestones.length - 1].textContent)).toBe('November 4, 2026 Flock is on the App Store.');

    // The outline still steps one level at a time.
    const levels = Array.from(container.querySelectorAll('h1,h2,h3')).map((h) => Number(h.tagName[1]));
    for (let i = 1; i < levels.length; i += 1) expect(levels[i] - levels[i - 1]).toBeLessThanOrEqual(1);
    unmount();
  });

  test('an entry without a month still renders, its year as plain text', () => {
    const honor = { when: '2025', what: 'A test honor with no month.' };
    const { container, unmount } = renderWith({ COMPETITIONS, HONORS: [honor] });
    const li = container.querySelector('.ab-honors li');
    expect(li.querySelector('time')).toBeNull();
    expect(flat(li.querySelector('.ab-when').textContent)).toBe('2025');
    unmount();
  });
});
