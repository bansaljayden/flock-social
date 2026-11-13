/**
 * /about's TIMELINE: THE COMPANY'S STORY IN ABOUT TEN DOTS.
 *
 * It was "Milestones so far", which grew to seventeen lines dated to the day
 * on 2026-11-11 and then, his calls the same night: keep it to about ten,
 * drop the minor ones (the crowd data, the 30 cities), and make it a timeline
 * of where the company started, grew, changed and became, because a list of
 * days read as everything happening at once.
 *
 * Pinned: about ten dots; each names its stage and its month, never a day;
 * oldest first; no competition entry or pitch (those are in Competitions),
 * while the two results (DECA States, LionCage) are dots with their
 * competition's logo; the minor ones stay out; no accuracy figures or user
 * counts; the App Store dot is the one set apart (appStoreLive.test.js pins
 * its link).
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test aboutTimeline --watchAll=false
 */
const React = require('react');
const { render } = require('@testing-library/react');

jest.mock('../website/LiveDemo', () => ({ __esModule: true, default: () => null }));
jest.mock('../components/ui/BirdieBird', () => ({
  __esModule: true,
  default: () => null,
  WARM_BIRD: { body: '', head: '', flap: null, neck: '0 0' },
  BIRDIE: { body: '', head: '', flap: null, neck: '0 0' },
}));

const AboutPage = require('../website/AboutPage').default;

const flat = (s) => s.replace(/\s+/g, ' ').trim();

function page() {
  const { container } = render(React.createElement(AboutPage));
  return container;
}
const dots = (c = page()) => Array.from(c.querySelectorAll('.ab-timeline li'));

test('the section is the Timeline, and the old Milestones list is gone', () => {
  const c = page();
  expect(flat(c.querySelector('#ab-h-timeline').textContent)).toBe('Timeline');
  expect(c.querySelector('.ab-milestones')).toBeNull();
  expect(c.textContent).not.toMatch(/Milestones so far/);
});

test('it started in 2025, not with the first commit in January 2026 (his correction, 2026-11-13)', () => {
  const first = dots()[0];
  expect(flat(first.querySelector('.ab-tl-stage').textContent)).toBe('It started');
  expect(flat(first.querySelector('.ab-when').textContent)).toBe('2025');
  expect(first.querySelector('time')).toBeNull();
});

test('about ten dots', () => {
  const n = dots().length;
  expect(n).toBeGreaterThanOrEqual(8);
  expect(n).toBeLessThanOrEqual(12);
});

test('each dot names its stage and its month, never a day', () => {
  for (const li of dots()) {
    const stage = li.querySelector('.ab-tl-stage');
    const when = li.querySelector('.ab-when');
    expect(flat(stage.textContent).length).toBeGreaterThan(2);
    expect([flat(li.textContent), flat(when.textContent)]).toEqual([flat(li.textContent), expect.stringMatching(/^(Early |Late )?([A-Z][a-z]+ )?\d{4}$/)]);
    const time = li.querySelector('time.ab-when');
    if (time) expect(time.getAttribute('datetime') || time.getAttribute('dateTime')).toMatch(/^\d{4}-\d{2}$/);
  }
});

test('oldest first', () => {
  let last = '';
  for (const li of dots()) {
    const time = li.querySelector('time.ab-when');
    if (!time) continue;
    const d = time.getAttribute('datetime') || time.getAttribute('dateTime');
    expect([flat(li.textContent), d >= last]).toEqual([flat(li.textContent), true]);
    last = d;
  }
});

test('no competition entry or pitch; the two results carry their competition\'s logo', () => {
  const list = dots();
  const text = list.map((li) => flat(li.textContent)).join(' | ');
  expect(text).not.toMatch(/pitch|submitted|entered|applied/i);
  const withLogo = list.filter((li) => li.querySelector('.ab-tl-logo img'));
  expect(withLogo.map((li) => li.querySelector('.ab-tl-stage').textContent)).toEqual(['First win', 'Recognized']);
  for (const li of withLogo) {
    const img = li.querySelector('.ab-tl-logo img');
    expect(img.getAttribute('src')).toMatch(/^\/logos\/competitions\/[a-z0-9-]+\.png$/);
    expect(img.getAttribute('alt')).toBe('');
    expect(Number(img.getAttribute('width'))).toBeGreaterThan(0);
    expect(Number(img.getAttribute('height'))).toBeGreaterThan(0);
  }
});

test('the minor ones stay out, and there are no figures or user counts', () => {
  const text = dots().map((li) => flat(li.textContent)).join(' | ');
  expect(text).not.toMatch(/30 cities|crowd dataset|people-count|D-U-N-S|retrained/i);
  expect(text).not.toMatch(/%|accuracy|R²|\bR2\b|users\b|accounts\b|downloads/i);
});

test('the App Store dot is the one set apart', () => {
  const set = page().querySelectorAll('.ab-timeline li.is-milestone');
  expect(set).toHaveLength(1);
  expect(flat(set[0].textContent)).toBe('Launched November 2026 Flock is on the App Store.');
});
