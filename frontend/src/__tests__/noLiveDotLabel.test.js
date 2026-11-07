/**
 * NO "LIVE" LABEL, AND NO STATUS DOT BESIDE ONE (2026-11-06).
 *
 * A dot, usually pulsing, beside the word LIVE (or ESTIMATED, or FORECAST)
 * sat on the crowd forecast, the venue sensor card, the venue dashboard's
 * sensor card, the Plans tab's weather card, the website demo's note, the
 * location sharing banners and a friend's pin on the map. It reads as a
 * template, and it was not true: a screen recording showed LIVE beside a
 * number that was the venue's reading from an hour ago. Every one of those
 * surfaces now says where a number came from and how old it is, in words
 * ("From this venue's reading taken an hour ago.", "3 min ago", "updated 2m
 * ago"), and nothing else claims it.
 *
 * Three parts. The first reads every source file under src (tests aside) with
 * its comments taken out, so a later branch cannot bring a status label or a
 * dot that never stops moving back. The second runs the same checks over the
 * shapes such a label has taken or could take ('LIVE NOW', <span>● Live</span>,
 * a "live-dot" class, a dot that blinks forever), so a check that has gone
 * blind fails here instead of passing everything. The third renders the crowd
 * forecast, the one surface where the chip used to decide LIVE from the reply,
 * with the payloads that used to earn it.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npm test -- --watchAll=false --testPathPattern=noLiveDotLabel
 */
import React from 'react';
import { render } from '@testing-library/react';
import { CrowdForecastPanel } from '../components/venue/ConsumerVenueCard';

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..');

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(js|jsx|css)$/.test(entry.name)) out.push(full);
  }
  return out;
}

// Comments describe what used to be there, by name, and that is allowed.
// Only code is checked: JSX comments, block comments, whole-line // comments
// and a // comment that follows code after a space (a URL's // has a colon
// before it, never a space).
const stripComments = (text, css) => {
  const lf = text.replace(/\r\n/g, '\n');
  if (css) return lf.replace(/\/\*[\s\S]*?\*\//g, '');
  return lf
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/[ \t]+\/\/ .*$/gm, '');
};

const FILES = walk(SRC).map((file) => ({
  rel: path.relative(SRC, file).replace(/\\/g, '/'),
  code: stripComments(fs.readFileSync(file, 'utf8'), file.endsWith('.css')),
}));

// ── The checks, each a pattern over code ──────────────────────────────────
//
// A word standing alone as a badge: 'LIVE', "Live", `ESTIMATED`, >FORECAST<.
// A sentence may still use the word ("Sharing live location", "recent live
// readings"); a label may not.
const BARE_WORD = [
  /(['"`])\s*(LIVE|Live|ESTIMATED|Estimated|FORECAST)\s*\1/g,
  />\s*(LIVE|Live|ESTIMATED|Estimated|FORECAST)\s*</g,
];
// LIVE in capitals anywhere in a string or in JSX text: 'LIVE NOW', `LIVE ·
// ${pct}%`, <span>LIVE · {pct}%</span>. Capitals are a badge whatever sits
// beside them; prose writes the word in lower case. The JSX half stops at a
// character JSX text does not hold but code does (=, &, |, parentheses), so
// `(f) => ... && LIVE(f)` in lib/nestAsks.js, a function, is not text.
const CAPITAL_LIVE = [
  /(['"`])[^'"`\n]*\bLIVE\b[^'"`\n]*\1/g,
  />[^<>{}\n=&|();]*\bLIVE\b(?!\s*[(=])/g,
];
// Live leading a string or JSX text as a status: '● Live', 'Live now',
// 'Live · 62%', 'Live.', 'Live:', >Live now<. "Live music", "Live Events"
// and "Live location sharing" go on into a sentence and pass. A bare
// lower-case 'live' is left alone, because code compares a mode or a status
// to it; with a bullet before it, or "now" or a separator after it, it is a
// label again.
const LIVE_STATUS = [
  /(['"`>])\s*[●•]?\s*(Live|LIVE)(\s+(now|NOW))?\s*([·•|:.!–—-]|['"`<{])/g,
  /(['"`>])\s*([●•]\s*live\b|live\s+now\b|live\s*[·•|])/g,
  /[●•]\s*(LIVE|Live|live)\b/g,
];
// The two sensor cards were "Live Occupancy" (drawn in capitals) and "Live
// Sensor", each beside a pulsing dot, and the map's sharing banner led with
// "Live location ·". They are "Venue sensor", "Your sensor" and "Sharing your
// location ·" now.
const OLD_TITLES = [/Live Occupancy|LIVE OCCUPANCY|Live Sensor|LIVE SENSOR|Live location ·/g];
// The demo note was `${live ? 'Live from' : 'From'} ${madeFrom}` and 'Live
// from the model inside Flock', beside the green dot.
const DEMO_LEAD = [/['"`]Live from the model/g, /['"`]Live from['"`]/g, /`Live from \$\{/g];
// The dot classes the branch removed, and any class, id or variable that
// names an element a live dot, a status dot or a pulse dot.
const DOT_NAMES = [
  /flock-pulse-dot|flockPulse|lpd-live-dot|@keyframes\s+lpd-live\b/g,
  /(live|status|pulse)[-_]?dot/gi,
];
// `animation: 'pulse 2s ease-in-out infinite'` drew the crowd chip's dot, the
// location sharing banners' dot and, before them, the weather badge. Named
// skeleton shimmers (gil-pulse, gi-pulse) are not dots and keep their own
// names, so a hyphen on either side does not count. The chip's own was
// conditional, `animation: isLiveNow ? 'pulse 2s ...' : 'none'`, so the value
// is read up to the end of the property.
const PULSE = [
  /animation:[^,}\n]*(?<![\w-])pulse(?![\w-])/g,
  /(?<![\w-])pulse \d/g,
  /@keyframes\s+pulse(?![\w-])/g,
];
// framer-motion, the Web Animations API and SVG loop forever without the
// word infinite.
const OTHER_LOOPS = [/repeat:\s*Infinity\b|iterations:\s*Infinity\b|repeatCount=\{?\s*["']indefinite/g];

// Every animation that never stops, by keyframe name, and what it is. None is
// a status dot. A new one that runs forever (a dot that blinks, pings or
// breathes beside a word) fails until it is named here on purpose.
const LOOPS_ALLOWED = {
  spin: 'loading spinners',
  chatTypingDot: 'the typing indicator in chat',
  roostBob: "Roost's idle bob",
  skeletonSweep: 'loading skeletons',
  'gil-pulse': "the guest invite's loading skeleton, drawn from index.js",
  'gi-pulse': "the guest invite's loading skeleton",
  'lp-reel': "the landing page's reel",
  'lpd-shimmer': "the website demo's loading shimmer",
  tapBreath: "the tap page's breathing card",
  searchProgress: "Discover search's 2px progress line, drawn only while a search is out",
};
const TIMING_WORDS = new Set(['linear', 'ease', 'ease-in', 'ease-out', 'ease-in-out', 'step-start', 'step-end',
  'alternate', 'alternate-reverse', 'reverse', 'normal', 'forwards', 'backwards', 'both', 'none', 'running', 'paused']);

// The keyframe name of the animation each `infinite` belongs to, read back
// from the word to the property on the same line and past any earlier
// animation in a comma list; null when no name can be read, which fails too.
const foreverLoops = (code) => {
  const loops = [];
  for (const line of code.split('\n')) {
    for (const m of line.matchAll(/\binfinite\b/g)) {
      const at = line.lastIndexOf('animation', m.index);
      // cubic-bezier(0, 0, 0.2, 1) and steps(4, end) hold commas of their own.
      let value = line.slice(at < 0 ? 0 : at, m.index).replace(/\([^)]*\)/g, '');
      value = value.slice(value.lastIndexOf(',') + 1);
      const name = [...value.matchAll(/([A-Za-z][\w-]*)\s+[\d.]+m?s\b/g)]
        .map((n) => n[1])
        .find((n) => !TIMING_WORDS.has(n)) || null;
      loops.push({ name, line: line.trim().slice(0, 100) });
    }
  }
  return loops;
};
const unknownLoops = (code) => foreverLoops(code)
  .filter((l) => !l.name || !Object.prototype.hasOwnProperty.call(LOOPS_ALLOWED, l.name));

const ALL_PATTERNS = [...BARE_WORD, ...CAPITAL_LIVE, ...LIVE_STATUS, ...OLD_TITLES, ...DEMO_LEAD, ...DOT_NAMES, ...PULSE, ...OTHER_LOOPS];

// Every match of the patterns in every file, as "file: match", so a failure
// names the line.
const offenders = (patterns) => {
  const hits = [];
  for (const { rel, code } of FILES) {
    for (const re of patterns) {
      for (const m of code.matchAll(re)) hits.push(`${rel}: ${m[0].trim().slice(0, 80)}`);
    }
  }
  return hits;
};
// Whether any check at all fires on one piece of code.
const caught = (code) => ALL_PATTERNS.some((re) => [...code.matchAll(re)].length > 0) || unknownLoops(code).length > 0;

describe('no status label says LIVE, ESTIMATED or FORECAST', () => {
  test('the reading covers the files it should', () => {
    // A walk that found nothing would pass every test below.
    const names = FILES.map((f) => f.rel);
    for (const f of ['App.js', 'components/venue/ConsumerVenueCard.js', 'screens/CalendarScreen.js', 'screens/VenueDashboard.js', 'website/LiveDemo.js', 'website/LandingPage.css', 'index.css']) {
      expect(names).toContain(f);
    }
    expect(FILES.length).toBeGreaterThan(100);
  });

  test('no string or JSX text is just the word', () => {
    expect(offenders(BARE_WORD)).toEqual([]);
  });

  test('no string or JSX text carries LIVE in capitals', () => {
    expect(offenders(CAPITAL_LIVE)).toEqual([]);
  });

  test('no string or JSX text leads with Live as a status, and no bullet sits beside the word', () => {
    expect(offenders(LIVE_STATUS)).toEqual([]);
  });

  test('no heading names a card by the word', () => {
    expect(offenders(OLD_TITLES)).toEqual([]);
  });

  test('the demo note leads with where the number came from, not with Live', () => {
    expect(offenders(DEMO_LEAD)).toEqual([]);
  });
});

describe('no status dot, and nothing beside a word that moves forever', () => {
  test('no class or name calls an element a live, status or pulse dot', () => {
    expect(offenders(DOT_NAMES)).toEqual([]);
  });

  test('nothing animates with a keyframe named pulse', () => {
    expect(offenders(PULSE)).toEqual([]);
  });

  test('every animation that runs forever is one of a known few, none of them a status dot', () => {
    const unknown = [];
    for (const { rel, code } of FILES) {
      for (const l of unknownLoops(code)) unknown.push(`${rel}: ${l.name || '(no name read)'}: ${l.line}`);
    }
    expect(unknown).toEqual([]);
    expect(offenders(OTHER_LOOPS)).toEqual([]);
  });

});

describe('the checks are not blind', () => {
  // Each is a shape the label had, or a plausible way back for it. Every one
  // must trip at least one check above.
  const SHAPES = {
    'the old crowd chip': `<div style={{ width: '6px', height: '6px', borderRadius: '3px', backgroundColor: isLiveNow ? '#22C55E' : colors.amber, animation: isLiveNow ? 'pulse 2s ease-in-out infinite' : 'none' }} />
      <span style={{ fontSize: 'var(--t-meta)' }}>{isLiveNow ? 'LIVE' : 'ESTIMATED'}</span>`,
    'the old weather pill': `<span style={{ fontSize: 'var(--t-meta)' }}>{isLive ? 'LIVE' : 'FORECAST'}</span>`,
    'the old sensor heading': `<span className="flock-pulse-dot" /> Live Occupancy`,
    'the old sharing banner': `<div style={{ animation: 'pulse 2s ease-in-out infinite' }} />
      Live location · {count} nearby`,
    'a bullet and Live in JSX': '<span>● Live</span>',
    'LIVE NOW in a string': "const tag = 'LIVE NOW';",
    'Live now in a string': "const tag = 'Live now';",
    'Live now in JSX': '<span>Live now</span>',
    'LIVE beside a percent': '<span>LIVE · 62%</span>',
    'LIVE beside a percent in a template': 'const t = `LIVE · ${pct}%`;',
    'Live leading a toast': "showToast('Live. Users see your number now.');",
    'a live-dot class': '<span className="live-dot" />',
    'a status dot variable': 'const statusDot = <span style={dotStyle} />;',
    'a dot that blinks forever': "<span style={{ width: 6, height: 6, borderRadius: '50%', background: '#22C55E', animation: 'blink 2s infinite' }} />",
    'a CSS dot that pings forever': '.dot { width: 6px; height: 6px; animation: ping 1s cubic-bezier(0, 0, 0.2, 1) infinite; }\n@keyframes ping { 75%, 100% { transform: scale(2); opacity: 0; } }',
    'a forever loop after a finite one': "animation: 'fadeIn 0.3s ease, blink 1s infinite'",
    'a forever loop with no name read': '.x { animation-iteration-count: infinite; }',
    'framer-motion looping forever': '<motion.span animate={{ opacity: [1, 0.3, 1] }} transition={{ duration: 2, repeat: Infinity }} />',
    'Estimated alone': "{ label: 'Estimated' }",
  };
  test.each(Object.entries(SHAPES))('%s is caught', (_, code) => {
    expect(caught(code)).toBe(true);
  });

  // And the words that must keep passing, so the checks do not grow until
  // nobody can write the word in a sentence.
  const PROSE = {
    'a sharing sentence': "'Sharing live location'",
    'an events heading': '<span>Live events</span>',
    'music as a category': "{ id: 'music', label: 'Live Music' }",
    'a carried reading said with its age': "\"From this venue's reading taken an hour ago.\"",
    'a mode compared in code': "if (mode === 'live') return 1;",
    'a constant named in code': "const LIVE = (f) => f.status !== 'done';\nlist.filter((f) => f && LIVE(f));",
    'a stale table caption': "\"From the venue's Flux sensor. Not live right now.\"",
    'a spinner': "<span style={{ animation: 'spin 0.8s linear infinite' }} />",
    'a bob with a delay': '.roost-bob { animation: roostBob 1.6s ease-in-out 0.35s infinite; }',
  };
  test.each(Object.entries(PROSE))('%s passes', (_, code) => {
    expect(caught(code)).toBe(false);
  });
});

describe('the crowd forecast, rendered with the payloads that used to earn LIVE', () => {
  const PLACE = 'ChIJnoLiveDot0001';
  const HOURS = ['8 PM', '9 PM', '10 PM', '11 PM', '12 AM', '1 AM', '2 AM', '3 AM', '4 AM', '5 AM', '6 AM', '7 AM'];
  const read = (over = {}) => ({
    forPlaceId: PLACE,
    score: 62,
    label: 'Steady',
    predictionMethod: 'ml',
    confidenceBasis: 'model_holdout',
    lastUpdated: new Date().toISOString(),
    hourly: HOURS.map((hour, i) => ({ hour, score: 60 - i * 4, open: true })),
    isOpen: true,
    venueClock: { hour: new Date().getHours(), day: new Date().getDay(), local: true },
    ...over,
  });
  const band = (s) => (s > 84 ? 'red' : s > 39 ? 'amber' : 'green');
  const props = (crowdData) => ({
    venue: { place_id: PLACE, name: 'The Copper Finch', category: 'Nightlife', types: ['bar'], opening_hours: { openNow: true } },
    HOUR_ORDERING_MIN_GAP: 10,
    crowdColorFor: (s) => ({ red: '#EF4444', amber: '#F59E0B', green: '#22C55E' })[band(s)],
    crowdInkFor: () => 'var(--accent-amber-text)',
    colors: { navy: '#0d2847', steel: '#2d5a87', amber: '#F59E0B', red: '#EF4444', redText: '#b91c1c', textSecondary: '#556274' },
    crowdData,
    crowdFetchFailed: false,
    crowdLoading: false,
    partySize: null,
    setPartySize: () => {},
    setPaywallTrigger: () => {},
  });

  let getContext;
  beforeEach(() => {
    // jsdom has no 2D canvas; the dial draws into a stand-in.
    getContext = jest.spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockImplementation(() => ({ clearRect() {}, drawImage() {}, beginPath() {}, arc() {}, stroke() {} }));
  });
  afterEach(() => getContext.mockRestore());

  const noLabelNoPulse = (container) => {
    expect(container.textContent).not.toMatch(/\bLIVE\b|ESTIMATED/);
    const pulsing = Array.from(container.querySelectorAll('[style]')).filter((el) => /(?<![\w-])pulse(?![\w-])/.test(el.getAttribute('style')));
    expect(pulsing).toHaveLength(0);
  };

  test('the model\'s own fresh number: the line says the model made it, and nothing says live', () => {
    const { container, getByText } = render(<CrowdForecastPanel {...props(read())} />);
    expect(getByText('From the Flock crowd model.')).toBeTruthy();
    noLabelNoPulse(container);
  });

  test('a fresh reply carrying the venue\'s reading from an hour ago gives its age and is not called live', () => {
    const { container, getByText } = render(<CrowdForecastPanel {...props(read({ numberSource: 'live_reading_1h' }))} />);
    const line = getByText("From this venue's reading taken an hour ago.");
    expect(line.textContent).not.toMatch(/\blive\b/i);
    noLabelNoPulse(container);
  });

  test('a category estimate says it is one, and the owner\'s number says whose it is', () => {
    const estimate = render(<CrowdForecastPanel {...props(read({ predictionMethod: 'rule_engine', confidenceBasis: 'category_pattern' }))} />);
    expect(estimate.getByText('An estimate from typical patterns for this kind of place.')).toBeTruthy();
    noLabelNoPulse(estimate.container);
    estimate.unmount();
    const owner = render(<CrowdForecastPanel {...props(read({ score: 40, predictionMethod: 'owner_report', confidenceBasis: 'owner_report', ownerReport: { applied: true, noun: 'bar', percent: 40, reportedAt: new Date().toISOString() } }))} />);
    expect(owner.getByText("The bar says it's at 40% right now")).toBeTruthy();
    expect(owner.getByText('From the bar itself, not a Flock estimate.')).toBeTruthy();
    noLabelNoPulse(owner.container);
  });
});
