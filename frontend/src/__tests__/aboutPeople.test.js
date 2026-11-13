/**
 * /about's people and story (2026-11-13, his asks: Asad's photo on the page,
 * a longer story, the bios filled out).
 *
 * Pinned: each person has a round portrait spot above the name; Asad's is the
 * photo he sent (a file that exists, small), the maintainer's shows his initials
 * until his photo comes; the story and the bios carry no "coming soon"
 * placeholder any more; the story keeps its first line and says Flock started
 * in 2025; no school is named.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test aboutPeople --watchAll=false
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

const AboutPage = require('../website/AboutPage').default;
const PUBLIC = path.join(__dirname, '..', '..', 'public');
const flat = (s) => s.replace(/\s+/g, ' ').trim();

function page() {
  return render(React.createElement(AboutPage)).container;
}

test('each person has a portrait spot above the name', () => {
  const people = Array.from(page().querySelectorAll('.ab-person'));
  expect(people.map((p) => flat(p.querySelector('h3').textContent))).toEqual(['Jayden Bansal', 'Asad Ali']);
  for (const p of people) {
    const first = p.firstElementChild;
    expect(first.classList.contains('ab-portrait')).toBe(true);
    expect(first.nextElementSibling.tagName).toBe('H3');
  }
});

test('Asad\'s portrait is his photo, a real small file, with an empty alt beside his name', () => {
  const asad = Array.from(page().querySelectorAll('.ab-person')).find((p) => /Asad Ali/.test(p.textContent));
  const img = asad.querySelector('img.ab-portrait');
  expect(img).not.toBeNull();
  expect(img.getAttribute('alt')).toBe('');
  const files = [img.getAttribute('src'), ...img.getAttribute('srcset').split(',').map((s) => s.trim().split(' ')[0])];
  for (const src of new Set(files)) {
    expect(src).toMatch(/^\/people\/asad-ali-\d+\.webp$/);
    const file = path.join(PUBLIC, src);
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.statSync(file).size).toBeLessThan(40 * 1024);
  }
});

test('the maintainer\'s spot shows his initials until his photo comes', () => {
  const jayden = Array.from(page().querySelectorAll('.ab-person')).find((p) => /Jayden Bansal/.test(p.textContent));
  const spot = jayden.querySelector('.ab-portrait');
  expect(spot.tagName).toBe('SPAN');
  expect(spot.getAttribute('aria-hidden')).toBe('true');
  expect(flat(spot.textContent)).toBe('JB');
});

test('the story and the bios are filled out: no "coming soon", first line kept, started in 2025', () => {
  const c = page();
  const story = c.querySelector('section[aria-labelledby="ab-h-story"]');
  const people = c.querySelector('section[aria-labelledby="ab-h-people"]');
  expect(flat(story.textContent)).not.toMatch(/coming soon/i);
  expect(flat(people.textContent)).not.toMatch(/coming soon/i);
  const paras = Array.from(story.querySelectorAll('p')).map((p) => flat(p.textContent));
  expect(paras[0]).toBe('Flock exists because the group chat kept killing perfectly good Friday nights.');
  expect(paras.length).toBeGreaterThanOrEqual(3);
  expect(paras.join(' ')).toMatch(/started building Flock in 2025/);
  for (const person of people.querySelectorAll('.ab-person')) {
    expect(person.querySelectorAll('p').length).toBeGreaterThanOrEqual(3);
  }
  // No school named for either of them (two competitions' own names say
  // "High School", so this reads only the story and the people).
  expect(`${story.textContent} ${people.textContent}`).not.toMatch(/Moravian|High School|Academy/i);
});
