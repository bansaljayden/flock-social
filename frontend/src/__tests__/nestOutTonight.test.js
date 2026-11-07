/**
 * OUT TONIGHT? ON THE NEST (components/nest/NestPulse.js), the second look
 * (2026-11-06).
 *
 *   - Add friends sits at the end of the band's heading, a steel text link, so
 *     a returning person with friends has it on the first screen; it had moved
 *     to the footer, about 800px down at 390 with four plans.
 *   - "Plan with them" belongs to the names: when it wraps, it starts under
 *     their first letter, where it sat alone at the right edge at 320.
 *   - The chosen answer is a tint of its hue with dark ink (light) or a deeper
 *     tint with light ink (dark), where Down filled its segment solid green
 *     under white, the loudest block on the page after the hero and SOS. Each
 *     ink clears 4.5:1 on its tint, and each tint stands apart from the track.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test nestOutTonight --watchAll=false
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import NestPulse, { PULSE_OPTIONS } from '../components/nest/NestPulse';

const fs = require('fs');
const path = require('path');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8').replace(/\r\n/g, '\n');
const PULSE = read('components', 'nest', 'NestPulse.js');
const APP = read('App.js');
const HOME = APP.slice(APP.indexOf('const HomeScreen = () => {'), APP.indexOf('// The past flocks screen was declared here'));
const CSS = read('index.css');

const friends = {
  people: [{ id: 1, name: 'Sam Rivera' }, { id: 2, name: 'Leo Martin' }, { id: 3, name: 'Priya Shah' }],
  text: 'Sam and Leo are down tonight, Priya said maybe',
  planLabel: 'Plan with them',
};
const props = (over = {}) => ({ active: null, saving: false, onSet: jest.fn(), friends, onPlanWith: jest.fn(), onAddFriends: jest.fn(), ...over });

describe('Add friends in the band', () => {
  test('a link at the end of the heading, one tap to the same opener the other doors use', () => {
    const p = props();
    render(<NestPulse {...p} />);
    const heading = screen.getByRole('heading', { name: 'Out tonight?' });
    const add = screen.getByRole('button', { name: 'Add friends' });
    expect(add.parentElement).toBe(heading.parentElement);
    fireEvent.click(add);
    expect(p.onAddFriends).toHaveBeenCalledTimes(1);
    expect(HOME).toMatch(/onAddFriends=\{openAddFriendsFromNest\}/);
  });

  test('it is there with or without friends out tonight', () => {
    render(<NestPulse {...props({ friends: null })} />);
    expect(screen.getByRole('button', { name: 'Add friends' })).toBeInTheDocument();
  });

  test('the footer keeps its own Add friends too', () => {
    expect(HOME).toMatch(/<footer data-nest-band="footer"[\s\S]*?onClick=\{openAddFriendsFromNest\}[\s\S]*?Add friends[\s\S]*?<\/footer>/);
  });
});

describe('Plan with them stays with the names', () => {
  test('it shares a wrapping line with the names, apart from the faces, and is never pushed to the right edge', () => {
    render(<NestPulse {...props()} />);
    const plan = screen.getByRole('button', { name: /Plan with them/ });
    const line = plan.parentElement;
    expect(line.textContent).toContain(friends.text);
    expect(line.style.flexWrap).toBe('wrap');
    // space-between puts it at the end beside one line of names, and at the
    // start of its own line when it wraps.
    expect(line.style.justifyContent).toBe('space-between');
    expect(plan.style.marginLeft).toBe('');
    // The faces are outside that line, so a wrapped button starts under the
    // names' first letter, not under the faces.
    expect(line.querySelector('[aria-hidden="true"] > span')).toBeNull();
  });
});

describe('the chosen answer', () => {
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
  const lum = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
    .reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
  const ratio = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };

  test.each([[':root'], ['[data-theme="dark"]']])('%s: each ink clears 4.5:1 on its tint, and each tint stands apart from the track', (sel) => {
    const t = block(sel);
    const track = t['--bg-inset'] || block(':root')['--bg-inset'];
    for (const { key } of PULSE_OPTIONS) {
      const bg = t[`--pulse-${key}-bg`];
      const ink = t[`--pulse-${key}-ink`];
      expect({ key, bg }).toEqual({ key, bg: expect.stringMatching(/^#[0-9a-f]{6}$/i) });
      expect({ key, ink: ratio(ink, bg) >= 4.5 }).toEqual({ key, ink: true });
      expect({ key, apart: ratio(bg, track) >= 1.1 }).toEqual({ key, apart: true });
    }
  });

  test('the segment reads its tint and ink from those tokens, never white on a solid fill', () => {
    expect(PULSE).toContain("backgroundColor: on ? `var(--pulse-${opt.key}-bg)` : 'transparent',");
    expect(PULSE).toContain("color: on ? `var(--pulse-${opt.key}-ink)` : 'var(--text-secondary)',");
    expect(PULSE).not.toMatch(/#ffffff|#047857/);
  });

  test('pressed state and the spoken names are unchanged', () => {
    render(<NestPulse {...props({ active: 'down' })} />);
    expect(screen.getByRole('button', { name: 'Tonight: Down' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Tonight: Maybe' })).toHaveAttribute('aria-pressed', 'false');
  });
});
