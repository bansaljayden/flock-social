/**
 * THE SECOND ACCENT, BLUSH, AND THE FOUR PLACES IT GOES (2026-11-07).
 *
 * Blush (#F4C6CF) is a pale pink that is only ever a fill under navy words
 * (#1e293b, 9.63:1) or a ring on the navy. It marks a plan coming together
 * and the people in it, in these places (a tad more of them since the same
 * day's first pass, which had only the first four):
 *
 *   1. the Nest hero's Locked in pill          components/nest/NestHero.js
 *   2. the hero's face rings                   components/nest/NestHero.js
 *   3. your own Down, once you chose it        components/nest/NestPulse.js
 *   4. the plan screen's Locked in badge       screens/FlockDetail.js
 *   5. every other Locked in chip: the Nest's  components/nest/NestChip.js
 *      Coming up cards and same-night rows,    screens/ChatListScreen.js
 *      the Messages list, the guest page's tag website/GuestInvite.css
 *   6. the envelope's disc on an invite row    components/nest/NestRows.js
 *   7. Plan with them, a pill in Out tonight   components/nest/NestPulse.js
 *   8. the home page's Now on the App Store,   website/LandingPage.css
 *      a pill on the hero's navy
 *   9. the home page's yes in "Still in?",     website/LandingPage.css
 *      a highlight on that beat's navy band
 *
 * On the website (flockcorp.com) blush is those two and the guest page's tag,
 * each on a navy ground, and nowhere else.
 *
 * On the cream it is 1.30:1, so it is never words or a mark on the page, and
 * it stays off every other button, the links, the tab bar, Birdie, crowd
 * levels, money, errors and SOS. This file pins the two tokens, the four uses
 * as they render, the keyboard ring on the blush Down, and the list itself: a
 * fifth use anywhere in the app or the site, blush as words, or the hex
 * written out in place of the token fails here.
 *
 * The renders go through react-dom/server. jsdom drops a var() colour from an
 * element's style (its cssstyle 2.3 parser does not read var()), and the
 * server markup keeps each style attribute as React wrote it.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test accentBlush --watchAll=false
 */

const fs = require('fs');
const path = require('path');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const parser = require('@babel/parser');

jest.mock('../components/ui/MapsChooser', () => ({
  __esModule: true,
  default: () => null,
  openMapsChooser: jest.fn(() => true),
  closeMapsChooser: jest.fn(),
}));
jest.mock('../services/api', () => ({
  __esModule: true,
  submitVenueFeedback: jest.fn(),
  getTableSummaries: jest.fn(() => Promise.resolve({})),
  getTableSummary: jest.fn(() => Promise.resolve(null)),
  isLoggedIn: jest.fn(() => false),
}));

const NestHero = require('../components/nest/NestHero').default;
const NestPulse = require('../components/nest/NestPulse').default;
const NestChip = require('../components/nest/NestChip').default;
const NestRows = require('../components/nest/NestRows').default;
const { planChip } = require('../lib/nestHero');
const FlockDetail = require('../screens/FlockDetail').default;

const SRC = path.join(__dirname, '..');
const FRONTEND = path.join(SRC, '..');
const read = (...p) => fs.readFileSync(path.join(SRC, ...p), 'utf8').replace(/\r\n/g, '\n');
const CSS = read('index.css');
const APP = read('App.js');

const BLUSH = '#F4C6CF';
const NAVY = '#1e293b';

// ── colour arithmetic ───────────────────────────────────────────────────
const rgb = (c) => {
  if (Array.isArray(c)) return c;
  const s = String(c).trim();
  let m = s.match(/^#([0-9a-f]{6})$/i);
  if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)).concat(1);
  m = s.match(/^rgba?\(([^)]+)\)$/i);
  if (m) {
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
  }
  throw new Error(`not a colour: ${c}`);
};
// A see-through colour as it lands on what is under it.
const over = (top, under) => {
  const [r, g, b, a] = rgb(top);
  const u = rgb(under);
  return [r * a + u[0] * (1 - a), g * a + u[1] * (1 - a), b * a + u[2] * (1 - a), 1];
};
const lum = (c) => rgb(c).slice(0, 3).map((v) => v / 255)
  .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
  .reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
const ratio = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };

// Custom properties across every top-level block with exactly this selector
// (index.css opens :root more than once).
const block = (selector) => {
  const out = {};
  let from = 0;
  for (;;) {
    const open = CSS.indexOf(`\n${selector} {`, from);
    if (open === -1) break;
    const close = CSS.indexOf('}', open);
    for (const m of CSS.slice(open, close).matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
    from = close;
  }
  return out;
};
const LIGHT = block(':root');
const DARK = block('[data-theme="dark"]');

// One key of App.js's light or dark palette (the plan screen's header reads
// colors.navyBg).
const palette = (name, key) => {
  const at = APP.indexOf(`\nconst ${name} = {`);
  const end = APP.indexOf('\n};', at);
  const m = APP.slice(at, end).match(new RegExp(`\\n\\s*${key}: '([^']+)'`));
  return m ? m[1] : null;
};

// ── rendering ───────────────────────────────────────────────────────────
const mount = (element) => {
  const host = document.createElement('div');
  host.innerHTML = renderToStaticMarkup(element);
  return host;
};
const styleOf = (el) => Object.fromEntries((el.getAttribute('style') || '')
  .split(';').map((d) => d.trim()).filter(Boolean)
  .map((d) => { const i = d.indexOf(':'); return [d.slice(0, i).trim(), d.slice(i + 1).trim()]; }));
const count = (text, needle) => text.split(needle).length - 1;

const heroProps = (over = {}) => ({
  flock: { id: 5, name: 'Trivia Night' },
  when: 'Tonight at 8:33 PM',
  status: { key: 'locked', label: 'Locked in' },
  place: 'The Copper Finch',
  faces: [{ key: 1, name: 'Maya' }, { key: 2, name: 'Jordan' }],
  total: 3,
  names: 'You, Jordan and 1 more',
  note: null,
  action: { kind: 'budget', label: 'Add your budget' },
  onOpen: () => {},
  onAction: () => {},
  sameNight: [],
  ...over,
});
// The hero's face discs: 28px round spans (the "+N" is min-width, not width).
const faceDiscs = (root) => [...root.querySelectorAll('section span')]
  .filter((s) => styleOf(s).width === '28px' && styleOf(s)['border-radius'] === 'var(--r-pill)');

const pulseProps = (over = {}) => ({
  active: null,
  saving: false,
  onSet: () => {},
  friends: { people: [{ id: 1, name: 'Sam Rivera' }, { id: 2, name: 'Leo Martin' }], text: 'Sam and Leo are down tonight', planLabel: 'Plan with them' },
  onPlanWith: () => {},
  onAddFriends: () => {},
  ...over,
});
const segment = (root, label) => root.querySelector(`button[aria-label="Tonight: ${label}"]`);

// The plan screen, from its own parameter list, the way
// planScreenFactsOnce.test.js renders it.
const DETAIL_SRC = read('screens', 'FlockDetail.js');
const PARAMS = (() => {
  const from = DETAIL_SRC.indexOf('export default function FlockDetail({');
  const to = DETAIL_SRC.indexOf('}) {', from);
  return DETAIL_SRC.slice(from, to).split('\n').slice(1).map((l) => l.replace(/\/\/.*$/, '').trim())
    .filter(Boolean).flatMap((l) => l.split(',')).map((w) => w.trim()).filter(Boolean);
})();
const AT = new Date(2026, 10, 7, 20, 0, 0);
const plan = (extra = {}) => ({
  id: 41,
  name: 'Trivia Night',
  host: 'Maya Chen',
  creatorId: 9,
  status: 'confirmed',
  venue: 'The Copper Finch',
  venueId: 'ChIJcopperFinch01',
  venueAddress: '214 Main St',
  venueLat: 40.61,
  venueLng: -75.37,
  eventTime: AT.toISOString(),
  time: 'Sat 8:00 PM',
  members: [
    { id: 9, name: 'Maya Chen', status: 'accepted' },
    { id: 11, name: 'Jordan Park', status: 'accepted' },
  ],
  guests: [],
  votes: [],
  ...extra,
});
const detailProps = (flock) => {
  const p = {};
  for (const name of PARAMS) p[name] = jest.fn();
  return Object.assign(p, {
    DialogBehavior: () => null,
    MissingFlockPanel: () => null,
    authUser: { id: 9 },
    checkinSaving: false,
    colors: {},
    confirmingPlan: false,
    crowdPredictions: {},
    feedbackState: { crowdLevel: null, priceWorth: null, rating: null },
    feedbackSubmitting: false,
    getSelectedFlock: () => flock,
    recapSharing: false,
    rerunningFlockId: null,
    resolveEventTime: () => new Date(AT),
    rosterError: null,
    savingEventTime: false,
    showTimeEditor: false,
    slideFillRef: { current: null },
    slidePctRef: { current: 0 },
    slideRef: { current: null },
    slideStage: 'idle',
    slideThumbRef: { current: null },
    slidingRef: { current: false },
    styles: { card: {} },
    submittedFeedback: new Set(),
    timeEditDay: 'Tonight',
    timeEditHour: '9 PM',
    voteTotal: (v) => (v.voters || []).length,
  });
};
const badge = (root, word) => [...root.querySelectorAll('span')].find((s) => s.textContent.trim() === word);

describe('the tokens', () => {
  test('both themes define blush and the navy that goes on it, with the same values', () => {
    for (const theme of [LIGHT, DARK]) {
      expect(theme['--accent-blush']).toBe(BLUSH);
      expect(theme['--on-accent-blush']).toBe(NAVY);
    }
  });

  test('navy words on blush clear 4.5:1 with room (9.63:1)', () => {
    expect(ratio(LIGHT['--on-accent-blush'], LIGHT['--accent-blush'])).toBeGreaterThanOrEqual(9.6);
    expect(ratio(DARK['--on-accent-blush'], DARK['--accent-blush'])).toBeGreaterThanOrEqual(9.6);
  });

  test('blush stands on the navy it sits on: the hero card and the plan header, in both themes', () => {
    expect(ratio(BLUSH, LIGHT['--nest-hero-bg'])).toBeGreaterThanOrEqual(9.6);
    expect(ratio(BLUSH, DARK['--nest-hero-bg'])).toBeGreaterThanOrEqual(7.6);
    expect(palette('colorsLight', 'navyBg')).toBe('#1e293b');
    expect(palette('colorsDark', 'navyBg')).toBe('#1e3a5c');
    expect(ratio(BLUSH, palette('colorsLight', 'navyBg'))).toBeGreaterThanOrEqual(9.6);
    expect(ratio(BLUSH, palette('colorsDark', 'navyBg'))).toBeGreaterThanOrEqual(7.6);
  });

  test('on the cream it would be 1.30:1, which is why it is never words or a mark on the page', () => {
    expect(ratio(BLUSH, LIGHT['--bg-primary'])).toBeLessThan(1.35);
  });
});

describe('1 and 2: the Nest hero', () => {
  test('Locked in is a blush pill with navy words and check, fully rounded', () => {
    const hero = mount(<NestHero {...heroProps()} />);
    const pill = hero.querySelector('[data-nest-hero-status="locked"]');
    expect(pill.textContent).toBe('Locked in');
    expect(styleOf(pill)).toMatchObject({
      'background-color': 'var(--accent-blush)',
      color: 'var(--on-accent-blush)',
      'border-radius': 'var(--r-pill)',
      padding: '3px 10px 3px 8px',
      margin: '-3px 0',
    });
    expect(styleOf(pill.querySelector('.flock-icon-wrap')).color).toBe('var(--on-accent-blush)');
  });

  test('the pill gives back its own padding, so nothing else on the card moves', () => {
    const pill = mount(<NestHero {...heroProps()} />).querySelector('[data-nest-hero-status="locked"]');
    const [top, , bottom] = styleOf(pill).padding.split(' ');
    const [vertical, horizontal] = styleOf(pill).margin.split(' ');
    expect(vertical).toBe(`-${top}`);
    expect(bottom).toBe(top);
    // No sideways margin: the pill's right edge stays on the card's padding.
    expect(horizontal).toBe('0');
  });

  test('a plan still voting says so in plain words, with no pill', () => {
    const hero = mount(<NestHero {...heroProps({ status: { key: 'voting', label: 'Still voting' } })} />);
    const words = hero.querySelector('[data-nest-hero-status="voting"]');
    const s = styleOf(words);
    expect(s.color).toBe('var(--nest-hero-meta)');
    expect(s['background-color']).toBeUndefined();
    expect(s.padding).toBeUndefined();
    expect(words.querySelector('.flock-icon-wrap')).toBeNull();
  });

  test("the faces wear a 2px blush ring where they have a ring; the +N keeps the card's navy", () => {
    const hero = mount(<NestHero {...heroProps()} />);
    const discs = faceDiscs(hero);
    expect(discs).toHaveLength(2);
    discs.forEach((d) => expect(styleOf(d)['box-shadow']).toBe('0 0 0 2px var(--accent-blush)'));
    const more = [...hero.querySelectorAll('section span')].find((s) => s.textContent === '+1');
    expect(styleOf(more)['box-shadow']).toBe('0 0 0 2px var(--nest-hero-bg)');
    // The rings are the people's, so they hold on a plan still voting too.
    const voting = mount(<NestHero {...heroProps({ status: { key: 'voting', label: 'Still voting' } })} />);
    faceDiscs(voting).forEach((d) => expect(styleOf(d)['box-shadow']).toBe('0 0 0 2px var(--accent-blush)'));
  });

  test('a face on its own has no ring, so no blush ring either', () => {
    const hero = mount(<NestHero {...heroProps({ faces: [{ key: 1, name: 'Maya' }], total: 1, names: 'You' })} />);
    const discs = faceDiscs(hero);
    expect(discs).toHaveLength(1);
    expect(styleOf(discs[0])['box-shadow']).toBe('none');
  });

  test('a plan under the hero on the same night shows Locked in on a blush chip, and a vote on the quiet well', () => {
    const same = [
      { id: 9, name: 'Friday Night Crew', line: 'Also tonight at 8:00 PM', chip: planChip({ status: 'confirmed' }), onClick: () => {} },
      { id: 10, name: 'Game Night', line: 'Also tonight at 9:00 PM', chip: planChip({ status: 'voting' }, { voted: true }), onClick: () => {} },
    ];
    const hero = mount(<NestHero {...heroProps({ sameNight: same })} />);
    const chips = [...hero.querySelectorAll('ul li span[id$="-chip"]')];
    expect(chips.map((c) => c.textContent)).toEqual(['Locked in', 'Voted']);
    expect(styleOf(chips[0])).toMatchObject({ 'background-color': 'var(--accent-blush)', color: 'var(--on-accent-blush)' });
    expect(styleOf(chips[0].querySelector('.flock-icon-wrap')).color).toBe('var(--on-accent-blush)');
    expect(styleOf(chips[1])['background-color']).toBe('var(--bg-inset)');
  });
});

describe('5: every other Locked in chip', () => {
  test("planChip names a locked-in plan's chip by its own tone, and no other chip gets it", () => {
    expect(planChip({ status: 'confirmed' })).toEqual({ label: 'Locked in', tone: 'locked', icon: 'check' });
    expect(planChip({ status: 'confirmed', askHowItWas: true }).tone).toBe('neutral');
    expect(planChip({ status: 'voting' }, { needsVote: true }).tone).toBe('accent');
  });

  test('the Nest chip (Coming up, the same night) is a blush chip with navy words and check; its box is unchanged', () => {
    const locked = mount(<NestChip chip={planChip({ status: 'confirmed' })} id="c" />).firstChild;
    const plain = mount(<NestChip chip={{ label: 'Voted', tone: 'neutral', icon: null }} id="c" />).firstChild;
    expect(styleOf(locked)).toMatchObject({ 'background-color': 'var(--accent-blush)', color: 'var(--on-accent-blush)' });
    for (const k of ['padding', 'border-radius', 'font-size', 'line-height']) expect(styleOf(locked)[k]).toBe(styleOf(plain)[k]);
  });

  test("the Messages list's chip and the guest page's tag wear blush for Locked in only", () => {
    const list = strip(read('screens', 'ChatListScreen.js'));
    expect(list).toContain("const lockedIn = f.status === 'confirmed';");
    expect(list).toContain("color: lockedIn ? 'var(--on-accent-blush)' : statusTextColor, backgroundColor: lockedIn ? 'var(--accent-blush)' : `${statusColor}15`, padding: '1px 6px', borderRadius: 'var(--r-xs)', whiteSpace: 'nowrap', flexShrink: 0 }}>{statusLabel}</span>");
    expect(read('website', 'GuestInvite.js')).toContain('{chosen && <span className="gi-tag gi-tag--locked">Locked in</span>}');
    expect(read('website', 'GuestInvite.js')).toContain('{mine && <span className="gi-tag">Your vote</span>}');
    const css = strip(read('website', 'GuestInvite.css'), 'x.css');
    expect(css).toMatch(/\n\.gi-tag--locked \{\n {2}background: var\(--accent-blush\);\n {2}color: var\(--on-accent-blush\);\n {2}border-radius: 999px;\n {2}padding: 1px 8px;\n {2}margin: -1px 0;\n\}/);
  });
});

describe('6: the invite row', () => {
  test("the envelope sits on a blush disc in navy, and gives the disc's room back; other rows keep a plain icon", () => {
    const rows = [
      { key: 'i', kind: 'invite', title: 'Leo invited you to Bowling Night', when: 'Tue 8:00 PM', venue: 'Juniper Bowl', onClick: () => {} },
      { key: 'v', kind: 'vote', title: "Vote on Sam's Birthday", when: 'Today 2:00 PM', venue: 'Juniper Bowl', onClick: () => {} },
    ];
    const view = mount(<NestRows rows={rows} />);
    const iconOf = (kind) => view.querySelector(`[data-nest-row="${kind}"] .flock-icon-wrap`).parentElement;
    expect(styleOf(iconOf('invite'))).toMatchObject({ 'background-color': 'var(--accent-blush)', 'border-radius': 'var(--r-pill)', padding: '7px', margin: '-7px' });
    expect(styleOf(iconOf('invite').firstChild).color).toBe('var(--on-accent-blush)');
    expect(styleOf(iconOf('vote'))['background-color']).toBeUndefined();
    expect(count(view.innerHTML, 'var(--accent-blush)')).toBe(1);
  });
});

describe('3: Out tonight', () => {
  test('your chosen Down is blush with navy words, and Maybe and Not stay as they were', () => {
    const down = mount(<NestPulse {...pulseProps({ active: 'down' })} />);
    expect(segment(down, 'Down').getAttribute('aria-pressed')).toBe('true');
    expect(styleOf(segment(down, 'Down'))).toMatchObject({ 'background-color': 'var(--accent-blush)', color: 'var(--on-accent-blush)' });
    for (const other of ['Maybe', 'Not']) {
      expect(styleOf(segment(down, other))).toMatchObject({ 'background-color': 'transparent', color: 'var(--text-primary)' });
    }
  });

  test('a chosen Maybe or Not keeps its own tint, and the Down beside it carries no blush', () => {
    for (const [key, label] of [['maybe', 'Maybe'], ['not', 'Not']]) {
      const band = mount(<NestPulse {...pulseProps({ active: key, friends: null })} />);
      expect(styleOf(segment(band, label))).toMatchObject({ 'background-color': `var(--pulse-${key}-bg)`, color: `var(--pulse-${key}-ink)` });
      expect(styleOf(segment(band, 'Down'))).toMatchObject({ 'background-color': 'transparent', color: 'var(--text-primary)' });
      expect(band.innerHTML).not.toMatch(/accent-blush/);
    }
    expect(mount(<NestPulse {...pulseProps({ friends: null })} />).innerHTML).not.toMatch(/accent-blush/);
  });

  test('7: Plan with them is a blush pill with navy words and chevron, giving its padding back to the line', () => {
    const band = mount(<NestPulse {...pulseProps()} />);
    const plan = [...band.querySelectorAll('button')].find((b) => /^Plan with them/.test(b.textContent));
    expect(styleOf(plan)).toMatchObject({
      'background-color': 'var(--accent-blush)',
      color: 'var(--on-accent-blush)',
      'border-radius': 'var(--r-pill)',
      padding: '0 9px 0 11px',
      'min-height': '32px',
      margin: '0 -9px 0 -11px',
    });
    expect(styleOf(plan.querySelector('.flock-icon-wrap')).color).toBe('var(--on-accent-blush)');
  });

  test("blush in the band is the chosen Down and Plan with them: not the friends' faces or Add friends", () => {
    const band = mount(<NestPulse {...pulseProps({ active: 'down' })} />);
    expect(count(band.innerHTML, 'var(--accent-blush)')).toBe(2);
    expect(count(band.innerHTML, 'var(--on-accent-blush)')).toBe(3);
    const add = [...band.querySelectorAll('button')].find((b) => b.textContent.includes('Add friends'));
    expect(add.outerHTML).not.toMatch(/accent-blush/);
  });

  test('the keyboard ring is the app\'s, 2px outside the segment, and clears 3:1 on what it is drawn on', () => {
    // The segment sets no outline of its own, so index.css :focus-visible
    // draws it: 2px wide, 2px out, across the track's 2px padding and the
    // 2px gap between segments, so a strip of the track always lies between
    // the ring and the blush.
    const pulse = strip(read('components', 'nest', 'NestPulse.js'));
    expect(pulse).not.toMatch(/outline/i);
    expect(pulse).toContain("display: 'flex', gap: '2px', padding: '2px', minHeight: '48px'");
    expect(CSS).toMatch(/\n:focus-visible \{\n  outline: 2px solid var\(--focus-ring\);\n  outline-offset: 2px;/);
    const track = { light: LIGHT['--bg-card-solid'], dark: DARK['--bg-card-solid'] };
    const page = { light: LIGHT['--bg-primary'], dark: DARK['--bg-primary'] };
    for (const mode of ['light', 'dark']) {
      const ring = (mode === 'light' ? LIGHT : DARK)['--focus-ring'];
      expect({ mode, onTrack: ratio(over(ring, track[mode]), track[mode]) >= 3 }).toEqual({ mode, onTrack: true });
      expect({ mode, onPage: ratio(over(ring, page[mode]), page[mode]) >= 3 }).toEqual({ mode, onPage: true });
    }
    // The light ring would hold even against the blush itself (3.70:1). The
    // dark one is cream, 1.08:1 on blush: the strip of track is what keeps
    // it visible there.
    expect(ratio(over(LIGHT['--focus-ring'], track.light), BLUSH)).toBeGreaterThanOrEqual(3);
  });
});

describe('4: the plan screen', () => {
  // The clock is pinned two days before the plan, so no "is the night over"
  // gate depends on the day this runs.
  beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(new Date(2026, 10, 5, 12, 0, 0)); });
  afterEach(() => { jest.useRealTimers(); });

  test('a locked-in plan\'s badge is blush with navy words', () => {
    const view = mount(React.createElement(FlockDetail, detailProps(plan())));
    const locked = badge(view, 'Locked in');
    expect(locked).toBeTruthy();
    expect(styleOf(locked)).toMatchObject({ background: 'var(--accent-blush)', color: 'var(--on-accent-blush)', 'border-radius': 'var(--r-pill)' });
    // The badge and nothing else on the screen.
    expect(count(view.innerHTML, 'var(--accent-blush)')).toBe(1);
    expect(count(view.innerHTML, 'var(--on-accent-blush)')).toBe(1);
  });

  test('Planning, Done and Cancelled keep their own colours', () => {
    for (const [status, word] of [['planning', 'Planning'], ['completed', 'Done'], ['cancelled', 'Cancelled']]) {
      const view = mount(React.createElement(FlockDetail, detailProps(plan({ status }))));
      expect({ status, badge: !!badge(view, word) }).toEqual({ status, badge: true });
      expect({ status, blush: /accent-blush/.test(view.innerHTML) }).toEqual({ status, blush: false });
    }
  });
});

// ── the list ─────────────────────────────────────────────────────────────
// Comments out, so a sentence about blush is not counted as a use of it. A
// script's comments come from Babel's parser, not a pattern, which would
// read a '/*' inside a string as the start of one and swallow code after it.
function strip(src, file = 'x.js') {
  if (/\.css$/.test(file)) return src.replace(/\/\*[\s\S]*?\*\//g, '');
  if (/\.(html|svg)$/.test(file)) return src.replace(/<!--[\s\S]*?-->/g, '');
  if (!/\.jsx?$/.test(file)) return src;
  const ast = parser.parse(src, { sourceType: 'module', errorRecovery: true, plugins: ['jsx', 'classProperties', 'optionalChaining', 'nullishCoalescingOperator', 'objectRestSpread', 'dynamicImport'] });
  let out = '';
  let at = 0;
  for (const c of ast.comments) { out += src.slice(at, c.start); at = c.end; }
  return out + src.slice(at);
}
// Every script, style sheet, page and drawing of the app and the site. Only a
// file that mentions blush in some form is read past its name.
const MENTION = /accent-blush|f4c6cf|244\s*,\s*198\s*,\s*207/i;
function sourceFiles() {
  const out = [];
  const walk = (dir, rel) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '__tests__' || entry.name === 'screenshots') continue;
      const abs = path.join(dir, entry.name);
      const r = `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(abs, r);
      else if (/\.(jsx?|css|html|svg|json)$/.test(entry.name)) {
        const raw = fs.readFileSync(abs, 'utf8').replace(/\r\n/g, '\n');
        out.push({ rel: r, src: MENTION.test(raw) ? strip(raw, entry.name) : '' });
      }
    }
  };
  walk(SRC, 'src');
  walk(path.join(FRONTEND, 'public'), 'public');
  return out;
}
const FILES = sourceFiles();
const tally = (re) => {
  const out = {};
  for (const { rel, src } of FILES) {
    const n = (src.match(re) || []).length;
    if (n) out[rel] = n;
  }
  return out;
};

// Every use of each token, file by file.
const USES = {
  accent: {
    'src/components/nest/NestHero.js': 2, // the pill, the face rings
    'src/components/nest/NestPulse.js': 2, // the chosen Down, Plan with them
    'src/components/nest/NestChip.js': 1, // Locked in on Coming up and the same night
    'src/components/nest/NestRows.js': 1, // the invite's disc
    'src/screens/ChatListScreen.js': 1, // Locked in on the Messages list
    'src/screens/FlockDetail.js': 1, // the plan screen's badge
    'src/website/GuestInvite.css': 1, // Locked in on the guest page
    'src/website/LandingPage.css': 2, // Now on the App Store, the yes in "Still in?"
  },
  onAccent: {
    'src/components/nest/NestHero.js': 2, // the pill's words and check
    'src/components/nest/NestPulse.js': 3, // the Down's words, Plan with them's words and chevron
    'src/components/nest/NestChip.js': 1, // the chip's words and check
    'src/components/nest/NestRows.js': 1, // the envelope
    'src/screens/ChatListScreen.js': 1,
    'src/screens/FlockDetail.js': 1,
    'src/website/GuestInvite.css': 1,
    'src/website/LandingPage.css': 2,
  },
};

describe('8 and 9: the website, on its navy only', () => {
  const LP_JS = read('website', 'LandingPage.js');
  const LP_CSS = strip(read('website', 'LandingPage.css'), 'x.css');
  const LP = (() => {
    const at = LP_CSS.indexOf('\n.lp {');
    const body = LP_CSS.slice(at, LP_CSS.indexOf('\n}', at));
    return Object.fromEntries([...body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
  })();
  const rule = (selector) => {
    const at = LP_CSS.indexOf(`\n${selector} {`);
    return at === -1 ? null : LP_CSS.slice(at + 1, LP_CSS.indexOf('\n}', at) + 2);
  };
  // The JSX of one <section> of the home page, by a string inside it.
  const sectionWith = (needle) => {
    const at = LP_JS.indexOf(needle);
    const open = LP_JS.lastIndexOf('<section ', at);
    return { open: LP_JS.slice(open, LP_JS.indexOf('>', open) + 1), body: LP_JS.slice(open, LP_JS.indexOf('</section>', at)) };
  };

  test('8: Now on the App Store is a blush pill under navy words, its left edge on the date under it', () => {
    expect(rule('.lp-hero-store-note strong')).toBe([
      '.lp-hero-store-note strong {',
      '  display: block;',
      '  width: fit-content;',
      '  padding: 2px 10px;',
      '  border-radius: 999px;',
      '  background: var(--accent-blush);',
      '  color: var(--on-accent-blush);',
      '  font-size: 15px;',
      '  font-weight: 600;',
      '}',
    ].join('\n'));
    expect(LP_CSS).toContain('.lp-hero-store-date { display: block; margin-top: 5px; font-size: 14px; color: var(--cream-2); }');
    const hero = sectionWith('<strong>Now on the App Store</strong>');
    expect(hero.open).toContain('lp-hero lp-on-navy');
    expect(count(LP_JS, '<strong>Now on the App Store</strong>')).toBe(1);
  });

  test('9: the yes in "Still in?" is a blush highlight that gives its padding back, on a navy beat', () => {
    expect(rule('.lp-blush-mark')).toBe([
      '.lp-blush-mark {',
      '  padding: 0 3px;',
      '  margin: 0 -3px;',
      '  border-radius: 3px;',
      '  background: var(--accent-blush);',
      '  color: var(--on-accent-blush);',
      '  -webkit-box-decoration-break: clone;',
      '  box-decoration-break: clone;',
      '}',
    ].join('\n'));
    // One mark on the site, the beat's yes, and its words read as before.
    const files = FILES.filter((f) => f.rel.startsWith('src/website/') && /lp-blush-mark/.test(fs.readFileSync(path.join(FRONTEND, f.rel), 'utf8')));
    expect(files.map((f) => f.rel).sort()).toEqual(['src/website/LandingPage.css', 'src/website/LandingPage.js']);
    expect(count(LP_JS, 'className="lp-blush-mark"')).toBe(1);
    expect(LP_JS).toContain("All five say{' '}\n              <span className=\"lp-blush-mark\">yes</span>, and one last crowd check");
    const beat = sectionWith('className="lp-blush-mark"');
    expect(beat.open).toContain('lp-sec-navy lp-on-navy');
    expect(beat.body).toContain('id="lp-h-beat-4"');
  });

  test('on the navy the site paints, blush and its navy words clear 9:1 and the fill stands off the ground', () => {
    expect(LP['--navy']).toBe('#0b1a2e');
    expect(LP['--hero-lift']).toBe('#1b2a44');
    // The words on each fill: the token's navy on blush.
    expect(ratio(NAVY, BLUSH)).toBeGreaterThanOrEqual(9.6);
    // The fill against the ground around it: the beat's flat navy, and the
    // hero's lightest stop, the worst case under the pill.
    expect(ratio(BLUSH, LP['--navy'])).toBeGreaterThanOrEqual(11.5); // 11.51:1
    expect(ratio(BLUSH, LP['--hero-lift'])).toBeGreaterThanOrEqual(9.4); // 9.46:1
    // And the paper it never goes on.
    expect(ratio(BLUSH, LP['--paper'])).toBeLessThan(1.5); // 1.43:1
  });

  test('no other website page or rule uses it', () => {
    const site = Object.keys(USES.accent).filter((f) => f.startsWith('src/website/')).sort();
    expect(site).toEqual(['src/website/GuestInvite.css', 'src/website/LandingPage.css']);
    expect(Object.keys(tally(/accent-blush/g)).filter((f) => f.startsWith('src/website/')).sort()).toEqual(site);
  });
});

describe('blush goes in those places and nowhere else', () => {
  test('the scan reads the app and the site', () => {
    const names = FILES.map((f) => f.rel);
    for (const f of ['src/App.js', 'src/index.css', 'src/components/nest/NestHero.js', 'src/screens/FlockDetail.js', 'public/index.html']) {
      expect(names).toContain(f);
    }
    expect(names.some((n) => n.startsWith('src/website/'))).toBe(true);
    expect(names.some((n) => n.startsWith('src/__tests__/'))).toBe(false);
  });

  test('var(--accent-blush) is used exactly where the list says', () => {
    expect(tally(/var\(--accent-blush\)/g)).toEqual(USES.accent);
  });

  test('var(--on-accent-blush) goes with it: the words and icons on each blush fill', () => {
    expect(tally(/var\(--on-accent-blush\)/g)).toEqual(USES.onAccent);
  });

  test('past those uses the tokens are only defined, in index.css once a theme, and nothing aliases them', () => {
    expect(tally(/--accent-blush\b/g)).toEqual({ 'src/index.css': 2, ...USES.accent });
    expect(tally(/--on-accent-blush\b/g)).toEqual({ 'src/index.css': 2, ...USES.onAccent });
    const css = FILES.find((f) => f.rel === 'src/index.css').src;
    expect(css).not.toMatch(/var\(--(on-)?accent-blush\)/);
    expect(css.match(/\n {2}--accent-blush: #F4C6CF;\n {2}--on-accent-blush: #1e293b;\n\}/g)).toHaveLength(2);
  });

  test('the colour is never written out in place of the token', () => {
    expect(tally(/#f4c6cf\b/gi)).toEqual({ 'src/index.css': 2 });
    expect(tally(/rgba?\(\s*244\s*,\s*198\s*,\s*207\b/gi)).toEqual({});
  });

  test('blush is a fill or a ring, never words; the navy is its words and check', () => {
    // Each use, by the property or argument it is handed to.
    const roles = (token) => {
      const out = [];
      for (const { rel, src } of FILES) {
        if (rel === 'src/index.css') continue;
        for (const line of src.split('\n')) {
          let at = line.indexOf(`var(${token})`);
          while (at !== -1) {
            const before = line.slice(0, at).replace(/['"`]$/, '');
            // An icon's colour argument: Icons.name(...) or Icons[KEY](...),
            // straight or as one branch of a ternary.
            const icon = /Icons(\.\w+|\[[^\]]*\]\])\([^()]*$/.test(before);
            const keys = [...before.matchAll(/(\w+)\s*[:=]\s*/g)];
            out.push(icon ? 'icon' : (keys.length ? keys[keys.length - 1][1] : '?'));
            at = line.indexOf(`var(${token})`, at + 1);
          }
        }
      }
      return out.sort();
    };
    const fills = new Set(['background', 'backgroundColor', 'bg', 'faceRing']);
    const words = new Set(['color', 'ink', 'icon']);
    const a = roles('--accent-blush');
    const b = roles('--on-accent-blush');
    expect(a.filter((r) => !fills.has(r))).toEqual([]);
    expect(b.filter((r) => !words.has(r))).toEqual([]);
    expect(a).toHaveLength(Object.values(USES.accent).reduce((s, n) => s + n, 0));
    expect(b).toHaveLength(Object.values(USES.onAccent).reduce((s, n) => s + n, 0));
    // The two buttons that wear it are the chosen Down and Plan with them.
    const pulse = strip(read('components', 'nest', 'NestPulse.js'));
    expect(pulse).toContain("{ key: 'down', label: 'Down', bg: 'var(--accent-blush)', ink: 'var(--on-accent-blush)' },");
    expect(pulse).toContain('style={{ ...textLink, ...PLAN_PILL }}');
  });
});
