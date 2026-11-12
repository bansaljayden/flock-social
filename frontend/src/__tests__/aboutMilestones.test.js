/**
 * /about's MILESTONES ARE WHAT FLOCK BUILT, SHIPPED OR BECAME.
 *
 * The list was five lines, one of them "Two-minute pitch video entered in a
 * high school entrepreneurship and AI video competition", and it dated the
 * first App Store submission to October, which was a resubmission (the first
 * was August 17). His call on 2026-11-11: there are a lot more milestones,
 * and a submitted pitch "doesn't matter at all" there. Competitions have
 * their own section.
 *
 * Pinned: no competition entry is a milestone; the list is long enough to
 * say what happened; it runs oldest first; every entry has a when, and a
 * machine-readable date where the day or month is on the record; the App
 * Store day stays the last one (appStoreLive.test.js pins its link).
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test aboutMilestones --watchAll=false
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

function items() {
  const { container } = render(React.createElement(AboutPage));
  return Array.from(container.querySelectorAll('.ab-milestones li'));
}

test('no competition entry or pitch is a milestone', () => {
  const text = items().map((li) => flat(li.textContent)).join(' | ');
  expect(text).not.toMatch(/pitch|competition|challenge|entered in|award/i);
});

test('there are enough of them to tell the story', () => {
  expect(items().length).toBeGreaterThanOrEqual(12);
});

test('every entry has a when, and they run oldest first', () => {
  const list = items();
  let last = '';
  for (const li of list) {
    const when = li.querySelector('.ab-when');
    expect(when).not.toBeNull();
    expect(flat(when.textContent).length).toBeGreaterThan(0);
    const time = li.querySelector('time.ab-when');
    if (time) {
      const d = time.getAttribute('datetime') || time.getAttribute('dateTime');
      expect(d).toMatch(/^\d{4}-\d{2}(-\d{2})?$/);
      // Compared as strings: a month ("2026-10") sorts before its own days.
      expect([flat(li.textContent), d >= last.slice(0, d.length)]).toEqual([flat(li.textContent), true]);
      last = d;
    }
  }
});

test('the first App Store submission is August 17, and the App Store day is the last entry', () => {
  const text = items().map((li) => flat(li.textContent));
  expect(text).toContain('August 17, 2026 The iPhone app was submitted to the App Store for the first time.');
  expect(text[text.length - 1]).toBe('November 4, 2026 Flock is on the App Store.');
});

test('no accuracy figure and no user count', () => {
  const text = items().map((li) => flat(li.textContent)).join(' | ');
  expect(text).not.toMatch(/%|accuracy|R²|R2\b|users\b|accounts\b|downloads/i);
});
