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
 * Two halves. The first reads every source file under src (tests aside) with
 * its comments taken out, so a later branch cannot bring a status label or a
 * pulsing dot back. The second renders the crowd forecast, the one surface
 * where the chip used to decide LIVE from the reply, with the payloads that
 * used to earn it.
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
const codeOf = (file) => {
  const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  if (file.endsWith('.css')) return text.replace(/\/\*[\s\S]*?\*\//g, '');
  return text
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/[ \t]+\/\/ .*$/gm, '');
};

const FILES = walk(SRC).map((file) => ({ rel: path.relative(SRC, file).replace(/\\/g, '/'), code: codeOf(file) }));

// Every match of `re` in code, as "file: match", so a failure names the line.
const offenders = (re) => {
  const hits = [];
  for (const { rel, code } of FILES) {
    for (const m of code.matchAll(re)) hits.push(`${rel}: ${m[0].trim().slice(0, 80)}`);
  }
  return hits;
};

describe('no status label says LIVE, ESTIMATED or FORECAST on its own', () => {
  test('the reading covers the files it should', () => {
    // A walk that found nothing would pass every test below.
    const names = FILES.map((f) => f.rel);
    for (const f of ['App.js', 'components/venue/ConsumerVenueCard.js', 'screens/CalendarScreen.js', 'screens/VenueDashboard.js', 'website/LiveDemo.js', 'website/LandingPage.css', 'index.css']) {
      expect(names).toContain(f);
    }
    expect(FILES.length).toBeGreaterThan(100);
  });

  test('no string or JSX text is just the word', () => {
    // 'LIVE', "Live", `ESTIMATED`, >FORECAST< and the like: a word standing
    // alone as a badge. A sentence may still use the word ("Sharing live
    // location", "recent live readings"); a label may not.
    expect(offenders(/(['"`])\s*(LIVE|Live|ESTIMATED|Estimated|FORECAST)\s*\1/g)).toEqual([]);
    expect(offenders(/>\s*(LIVE|Live|ESTIMATED|Estimated|FORECAST)\s*</g)).toEqual([]);
  });

  test('no heading names a card by the word', () => {
    // The two sensor cards were "Live Occupancy" (drawn in capitals) and "Live
    // Sensor", each beside a pulsing dot, and the map's sharing banner led with
    // "Live location ·". They are "Venue sensor", "Your sensor" and "Sharing
    // your location ·" now.
    expect(offenders(/Live Occupancy|LIVE OCCUPANCY|Live Sensor|LIVE SENSOR|Live location ·/g)).toEqual([]);
  });

  test('the demo note leads with where the number came from, not with Live', () => {
    // It was `${live ? 'Live from' : 'From'} ${madeFrom}` and 'Live from the
    // model inside Flock', beside the green dot.
    expect(offenders(/['"`]Live from the model/g)).toEqual([]);
    expect(offenders(/['"`]Live from['"`]/g)).toEqual([]);
    expect(offenders(/`Live from \$\{/g)).toEqual([]);
  });
});

describe('no pulsing status dot', () => {
  test('the dot classes and their keyframes are gone', () => {
    expect(offenders(/flock-pulse-dot|flockPulse|lpd-live-dot|@keyframes\s+lpd-live\b/g)).toEqual([]);
  });

  test('nothing animates with a keyframe named pulse', () => {
    // `animation: 'pulse 2s ease-in-out infinite'` drew the crowd chip's dot,
    // the location sharing banners' dot and, before them, the weather badge.
    // Named skeleton shimmers (gil-pulse, gi-pulse) are not dots and keep
    // their own names, so a hyphen on either side does not count.
    // The chip's own was conditional, `animation: isLiveNow ? 'pulse 2s ...'
    // : 'none'`, so the value is read up to the end of the property.
    expect(offenders(/animation:[^,}\n]*(?<![\w-])pulse(?![\w-])/g)).toEqual([]);
    expect(offenders(/(?<![\w-])pulse \d/g)).toEqual([]);
    expect(offenders(/@keyframes\s+pulse(?![\w-])/g)).toEqual([]);
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
