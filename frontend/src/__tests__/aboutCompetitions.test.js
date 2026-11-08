/**
 * /about's Competitions and Honors (2026-11-06), from src/website/competitions.js.
 *
 * What this pins:
 *   1. the data keeps to its rules: every entry names its organizer, what went
 *      in, who entered it and a status that is a past or present fact, never a
 *      result (finalist, winner, award) and never a prize, fee or deadline; the
 *      date behind a status says the same month as the words, and none is in
 *      the future; only the Conrad and DECA entries are the maintainer's with Asad;
 *      only DECA's season-long team event may show as in progress, and its
 *      line says who is preparing it, never "Entered by";
 *   2. the page renders every entry as a row of the Competitions ledger on the
 *      navy band, between the milestones (or the honors) and where things
 *      stand, under a lead that names what is being prepared while any entry
 *      is in progress;
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
  test('every entry names its organizer, what went in, who entered it and a status', () => {
    expect(COMPETITIONS.length).toBeGreaterThan(0);
    const allowed = ['name', 'organizer', 'entered', 'status', 'date', 'team'];
    for (const c of COMPETITIONS) {
      expect(Object.keys(c).filter((k) => !allowed.includes(k))).toEqual([]);
      for (const k of ['name', 'organizer', 'entered', 'status', 'team']) {
        expect([c.name, k, typeof c[k] === 'string' && c[k].trim().length > 0]).toEqual([c.name, k, true]);
      }
    }
    expect(new Set(COMPETITIONS.map((c) => c.name)).size).toBe(COMPETITIONS.length);
  });

  test('a status is a fact about the entry, never a result, a prize, a fee or a deadline', () => {
    for (const c of COMPETITIONS) {
      expect([c.name, c.status]).toEqual([c.name, expect.stringMatching(/^(Submitted|Pitched|Accepted)\b/)]);
      const words = [c.name, c.organizer, c.entered, c.status, c.team].join(' | ');
      expect([c.name, RESULT_WORDS.exec(words)]).toEqual([c.name, null]);
      expect([c.name, MONEY_AND_DATES.exec(words)]).toEqual([c.name, null]);
    }
  });

  test('the date behind a status says the same thing as its words, and none is in the future', () => {
    const now = Date.now();
    for (const c of COMPETITIONS) {
      expect([c.name, c.date]).toEqual([c.name, expect.stringMatching(/^\d{4}-\d{2}(-\d{2})?$/)]);
      expect([c.name, c.status.endsWith(spoken(c.date))]).toEqual([c.name, true]);
      expect([c.name, startOf(c.date) <= now]).toEqual([c.name, true]);
    }
    // Newest first, every entry dated.
    const dated = COMPETITIONS.filter((c) => c.date).map((c) => startOf(c.date));
    expect(dated).toEqual([...dated].sort((a, b) => b - a));
    const firstUndated = COMPETITIONS.findIndex((c) => !c.date);
    if (firstUndated >= 0) expect(COMPETITIONS.slice(firstUndated).every((c) => !c.date)).toBe(true);
  });

  test('only the Conrad entry is the maintainer\'s with Asad; the rest are the maintainer\'s alone', () => {
    const withAsad = COMPETITIONS.filter((c) => /Asad Ali/.test(c.team)).map((c) => c.name);
    expect(withAsad).toEqual(['Conrad Challenge']);
    for (const c of COMPETITIONS) {
      expect([c.name, c.team]).toEqual([c.name, expect.stringMatching(/^Entered by Jayden Bansal( and Asad Ali)?$/)]);
    }
  });

  test('nothing still being prepared is listed: an entry goes in once it is submitted', () => {
    for (const c of COMPETITIONS) {
      expect([c.name, c.team.startsWith('Entered by ')]).toEqual([c.name, true]);
      expect([c.name, typeof c.date]).toEqual([c.name, 'string']);
    }
    expect(COMPETITIONS.map((c) => c.name).join(' ')).not.toMatch(/Jacobson|Start-Up Business Plan/);
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
        .toEqual([c.name, c.organizer, c.entered, c.team, c.status]);
      const time = row.querySelector('.ab-comp-status time');
      if (c.date) {
        expect(time.getAttribute('datetime') || time.getAttribute('dateTime')).toBe(c.date);
      } else {
        expect(time).toBeNull();
      }
    });
    unmount();
  });

  test('the lead says where Flock has been entered, and nothing about what is being prepared', () => {
    const { container, unmount } = render(React.createElement(AboutPage));
    expect(flat(container.querySelector('section[aria-labelledby="ab-h-comps"] .lp-lead').textContent)).toBe('Where Flock has been entered.');
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
