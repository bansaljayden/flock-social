/**
 * THE NEST'S HERO CARD: which plan leads, and what it says (lib/nestTime.js
 * pickHero and whenLine, lib/nestHero.js), run on the cases the design turns
 * on: a plan the same night against one the next, a locked-in plan against a
 * sooner one still voting, the 4 AM hold after midnight, the one button's
 * order, the reader as "You", and no note when the host's name is unknown.
 *
 * Dates are built from local fields, so the cases hold in any time zone.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test nestHero --watchAll=false
 */
import { pickHero, whenLine, alsoLine } from '../lib/nestTime';
import { heroNames, heroAction, heroNote, heroStatus, placeLine, planChip, heroFaces } from '../lib/nestHero';
import { nestAsks } from '../lib/nestAsks';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import NestHero from '../components/nest/NestHero';

// 2026-11-06 is a Friday.
const at = (day, h, m = 0) => new Date(2026, 10, day, h, m);
const FRI_712 = at(6, 19, 12);
// lib/nestTime.js joins a time to its AM/PM with a narrow no-break space and a
// month to its day with a no-break space; the words are what matter here
// (nestTime.test.js holds the spaces).
const plain = (s) => String(s).replace(/[\u202f\u00a0]/g, ' ');

const plan = (id, when, extra = {}) => ({ id, name: `Plan ${id}`, status: 'voting', eventTime: when ? when.toISOString() : null, timePassed: false, ...extra });

describe('pickHero', () => {
  test('tonight beats tomorrow, whatever the list order', () => {
    const tomorrow = plan(1, at(7, 19, 0), { status: 'confirmed' });
    const tonight = plan(2, at(6, 20, 0));
    expect(pickHero([tomorrow, tonight], FRI_712).hero.id).toBe(2);
  });

  test('on one night, locked in comes before a sooner plan still voting', () => {
    const voting = plan(1, at(6, 20, 0));
    const locked = plan(2, at(6, 20, 33), { status: 'confirmed' });
    const { hero, sameNight } = pickHero([voting, locked], FRI_712);
    expect(hero.id).toBe(2);
    expect(sameNight.map((f) => f.id)).toEqual([1]);
  });

  test('two locked in the same night: the sooner one', () => {
    const late = plan(1, at(6, 22, 0), { status: 'confirmed' });
    const early = plan(2, at(6, 20, 0), { status: 'confirmed' });
    expect(pickHero([late, early], FRI_712).hero.id).toBe(2);
  });

  test('at 12:40 AM Friday\'s plan still holds the hero, and lets go at 4 AM', () => {
    const friday = plan(1, at(6, 20, 33), { status: 'confirmed' });
    const saturday = plan(2, at(7, 19, 0), { status: 'confirmed' });
    expect(pickHero([friday, saturday], at(7, 0, 40)).hero.id).toBe(1);
    expect(pickHero([friday, saturday], at(7, 3, 59)).hero.id).toBe(1);
    expect(pickHero([friday, saturday], at(7, 4, 0)).hero.id).toBe(2);
  });

  test('a plan with no time, a time passed or a finished plan never leads', () => {
    const list = [
      plan(1, null),
      plan(2, at(6, 20, 0), { timePassed: true }),
      plan(3, at(6, 21, 0), { status: 'completed' }),
      plan(4, at(5, 20, 0), { status: 'confirmed' }), // last night
    ];
    expect(pickHero(list, FRI_712)).toEqual({ hero: null, sameNight: [] });
  });

  test('nothing tonight: the next night with a plan leads, and only its own plans ride along', () => {
    const sun = plan(1, at(8, 11, 0));
    const sat = plan(2, at(7, 19, 0));
    const sat2 = plan(3, at(7, 21, 0));
    const { hero, sameNight } = pickHero([sat, sat2, sun], FRI_712);
    expect(hero.id).toBe(2);
    expect(sameNight.map((f) => f.id)).toEqual([3]);
  });

  test('two nights out or more, only a plan that needs the reader takes the hero', () => {
    // On a Tuesday a plan three weeks off with nothing to do got the navy
    // card, above the Needs you rows that did need a tap.
    const tue = at(3, 18, 0);
    const far = plan(1, at(24, 20, 0), { status: 'confirmed' });
    expect(pickHero([far], tue)).toEqual({ hero: null, sameNight: [] });
    const asks = (f) => f.id === 2;
    const farVote = plan(2, at(24, 21, 0));
    const { hero, sameNight } = pickHero([far, farVote], tue, { hasAsk: asks });
    expect(hero.id).toBe(2);
    expect(sameNight.map((f) => f.id)).toEqual([1]);
    // Tonight and tomorrow always lead, ask or not.
    expect(pickHero([plan(3, at(3, 20, 0), { status: 'confirmed' })], tue).hero.id).toBe(3);
    expect(pickHero([plan(4, at(4, 20, 0), { status: 'confirmed' })], tue).hero.id).toBe(4);
    expect(pickHero([plan(5, at(5, 20, 0), { status: 'confirmed' })], tue).hero).toBeNull();
  });

  test('the Nest hands pickHero its own asks', () => {
    const APP = require('fs').readFileSync(require('path').join(__dirname, '..', 'App.js'), 'utf8');
    expect(APP).toContain('pickHero(liveFlocks, nestNow, { hasAsk: (f) => !!heroAction(f, nestAskList) })');
  });

  test('it never sorts the list it is handed', () => {
    const list = [plan(1, at(7, 19, 0)), plan(2, at(6, 20, 0))];
    const copy = list.slice();
    pickHero(list, FRI_712);
    expect(list).toEqual(copy);
  });
});

describe('whenLine and alsoLine', () => {
  test.each([
    [at(6, 20, 33), 'Tonight at 8:33 PM'],
    [at(7, 1, 0), 'Tonight at 1:00 AM'],
    [at(6, 19, 0), 'Started at 7:00 PM'],
    [at(7, 11, 0), 'Tomorrow at 11:00 AM'],
    [at(7, 20, 33), 'Tomorrow at 8:33 PM'],
    [at(8, 11, 0), 'Sunday at 11:00 AM'],
    [at(12, 20, 0), 'Thursday at 8:00 PM'],
    [at(21, 20, 0), 'Nov 21 at 8:00 PM'],
    [at(5, 20, 0), 'Last night at 8:00 PM'],
  ])('%s from Friday 7:12 PM reads %s', (t, want) => {
    expect(plain(whenLine(t, FRI_712))).toBe(want);
  });

  test('a morning plan the same day is "Today", not "Tonight"', () => {
    expect(plain(whenLine(at(6, 11, 0), at(6, 9, 0)))).toBe('Today at 11:00 AM');
  });

  test('after midnight the next evening is tomorrow, the night the day line says it is', () => {
    expect(plain(whenLine(at(7, 19, 0), at(7, 0, 40)))).toBe('Tomorrow at 7:00 PM');
  });

  test('the same-night line says also, until the plan is under way', () => {
    expect(plain(alsoLine(at(6, 20, 0), FRI_712))).toBe('Also tonight at 8:00 PM');
    expect(plain(alsoLine(at(7, 20, 0), at(6, 18, 10)))).toBe('Also tomorrow at 8:00 PM');
    // The 12:20 AM frame: an 8:00 PM plan is not "also tonight", it started.
    expect(plain(alsoLine(at(6, 20, 0), at(7, 0, 20)))).toBe('Started at 8:00 PM');
  });

  test('no time, no words', () => {
    expect(whenLine(null, FRI_712)).toBe('');
  });
});

describe('the names line', () => {
  const previews = [
    { id: 7, name: 'Jordan Lee' },
    { id: 3, name: 'Maya Chen' },
    { id: 9, name: 'Priya Shah' },
  ];

  test('the reader comes first as You, then one name, then the rest counted', () => {
    expect(heroNames(previews, 3, 3)).toBe('You, Jordan and 1 more');
    expect(heroNames(previews, 5, 3)).toBe('You, Jordan and 3 more');
  });

  test('two people', () => {
    expect(heroNames([{ id: 3, name: 'Maya' }, { id: 7, name: 'Jordan' }], 2, 3)).toBe('You and Jordan');
  });

  test('alone', () => {
    expect(heroNames([{ id: 3, name: 'Maya' }], 1, 3)).toBe('Just you');
  });

  test('a reader outside the four previews is still You, and still counted', () => {
    const four = [{ id: 1, name: 'Ana' }, { id: 2, name: 'Ben' }, { id: 4, name: 'Cy' }, { id: 5, name: 'Di' }];
    expect(heroNames(four, 6, 99)).toBe('You, Ana and 4 more');
  });

  test('link guests count from the head count, not the previews', () => {
    expect(heroNames([{ id: 3, name: 'Maya' }], 3, 3)).toBe('You and 2 more');
  });

  test('faces keep the preview order and carry pictures', () => {
    expect(heroFaces([{ id: 7, name: 'Jordan', profile_image_url: '/j.png' }, 'Sam']))
      .toEqual([{ key: 7, name: 'Jordan', image: '/j.png' }, { key: 's1', name: 'Sam', image: null }]);
  });

  test("the reader's face leads, as You leads the names", () => {
    // Sam's plan: the faces read S, M while the line beside them said "You
    // and Sam".
    const sams = [{ id: 7, name: 'Sam Rivera' }, { id: 3, name: 'Maya Chen' }];
    expect(heroFaces(sams, 3).map((p) => p.name)).toEqual(['Maya Chen', 'Sam Rivera']);
    expect(heroNames(sams, 2, 3)).toBe('You and Sam');
    // Not among the four, or not known: the preview order stands.
    expect(heroFaces(sams, 99).map((p) => p.key)).toEqual([7, 3]);
    expect(heroFaces(sams).map((p) => p.key)).toEqual([7, 3]);
  });

  test('the Nest hands the reader to every face row it draws', () => {
    const APP = require('fs').readFileSync(require('path').join(__dirname, '..', 'App.js'), 'utf8');
    const home = APP.slice(APP.indexOf('const HomeScreen = () => {'), APP.indexOf('// The past flocks screen was declared here'));
    const calls = home.match(/heroFaces\([^\n]*\)/g) || [];
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const c of calls) expect(c).toMatch(/, authUser\?\.id\)$/);
  });
});

describe('the one button', () => {
  const f = plan(1, at(6, 20, 33), { status: 'confirmed', venue: 'The Copper Finch' });

  test('a bill owed comes before a budget, a budget before a vote', () => {
    const both = { ...f, iOwe: true, iBudgetOpen: true };
    const asks = nestAsks([both], [both]);
    expect(heroAction(both, asks)).toEqual({ kind: 'owe', label: 'Pay your share of the bill' });
    const budget = { ...f, iBudgetOpen: true };
    expect(heroAction(budget, nestAsks([budget], [budget]))).toEqual({ kind: 'budget', label: 'Add your budget' });
    const vote = { ...f, status: 'voting' };
    expect(heroAction(vote, nestAsks([vote], [vote]))).toEqual({ kind: 'vote', label: 'Vote on a place' });
  });

  test('the hero never asks how the night was: the night is still on while a plan is the hero', () => {
    // It asked "How was The Copper Finch?" an hour in. The Needs you row asks
    // the morning after (lib/planNight.js nestAsksHowItWas).
    const over = { ...f, askHowItWas: true };
    expect(heroAction(over, nestAsks([over], []))).toBeNull();
  });

  test('nothing asked of the reader, no button', () => {
    expect(heroAction(f, nestAsks([f], []))).toBeNull();
  });

  test('another plan\'s ask is not this plan\'s button', () => {
    const other = plan(2, at(7, 19, 0), { iOwe: true });
    expect(heroAction(f, nestAsks([f, other], []))).toBeNull();
  });

  test('a plan with no place has nothing to rate', () => {
    expect(heroAction({ ...f, venue: 'TBD', askHowItWas: true }, [])).toBeNull();
  });
});

describe('the note, the status and the place', () => {
  const voted = plan(1, at(6, 20, 0), { iVoted: true, host: 'Sam Rivera', creatorId: 7 });

  test('a voter who does not host is told who locks it in', () => {
    expect(heroNote(voted, 3)).toBe('You voted. Sam locks it in.');
  });

  test('the note follows the vote the moment it is cast: the tally first, as the chip does', () => {
    // Read from the list alone, the note waited for the next list read after
    // a vote the button had already let go of.
    const f = { status: 'voting', host: 'Sam Rivera', creatorId: 2, iVoted: false };
    expect(heroNote(f, 1)).toBeNull();
    expect(heroNote(f, 1, { voted: true })).toBe('You voted. Sam locks it in.');
    expect(heroNote({ ...f, iVoted: true }, 1, { voted: false })).toBeNull();
    const APP = require('fs').readFileSync(require('path').join(__dirname, '..', 'App.js'), 'utf8');
    expect(APP).toContain('note={heroNote(heroFlock, authUser?.id, { voted: iHaveVoted(heroFlock) })}');
  });

  test('no note when the host is Unknown, when the reader hosts, or before a vote is known', () => {
    expect(heroNote({ ...voted, host: 'Unknown' }, 3)).toBeNull();
    expect(heroNote(voted, 7)).toBeNull();
    expect(heroNote({ ...voted, iVoted: undefined }, 3)).toBeNull();
    expect(heroNote({ ...voted, status: 'confirmed' }, 3)).toBeNull();
  });

  test('two words of status, and a place that is not chosen says so', () => {
    expect(heroStatus({ status: 'confirmed' })).toEqual({ key: 'locked', label: 'Locked in' });
    expect(heroStatus({ status: 'voting' })).toEqual({ key: 'voting', label: 'Still voting' });
    expect(placeLine('TBD')).toBe('No place yet');
    expect(placeLine('Juniper Bowl')).toBe('Juniper Bowl');
  });
});

describe('the chip says the reader\'s state', () => {
  const voting = plan(1, at(7, 19, 0));

  test.each([
    [{ ...voting, timePassed: true }, {}, 'Time passed'],
    [voting, { ask: 'owe' }, 'Needs your share'],
    [voting, { ask: 'budget' }, 'Needs your budget'],
    [voting, { needsVote: true }, 'Needs your vote'],
    [voting, { voted: true }, 'Voted'],
    [voting, {}, 'Voting'],
    [{ ...voting, status: 'confirmed', askHowItWas: true }, {}, 'How was it?'],
    [{ ...voting, status: 'confirmed' }, {}, 'Locked in'],
  ])('%#', (f, opts, want) => {
    expect(planChip(f, opts).label).toBe(want);
  });

  test('an ask on a chip says what it needs, with a verb', () => {
    // "Your vote" read as "here is your vote", the guest page's own meaning
    // for it (the option already picked).
    for (const ask of ['owe', 'budget', 'vote']) expect(planChip(voting, { ask }).label).toMatch(/^Needs your /);
    expect(planChip(voting, { needsVote: true }).label).not.toBe('Your vote');
  });

  test('only the reader\'s own ask wears the accent', () => {
    expect(planChip(voting, { needsVote: true }).tone).toBe('accent');
    expect(planChip(voting, { voted: true }).tone).toBe('neutral');
  });
});

describe('the card', () => {
  const props = (over = {}) => ({
    flock: { id: 5, name: 'Trivia Night' },
    when: 'Tonight at 8:33 PM',
    status: { key: 'locked', label: 'Locked in' },
    place: 'The Copper Finch',
    faces: [{ key: 1, name: 'Maya' }, { key: 2, name: 'Jordan' }],
    total: 3,
    names: 'You, Jordan and 1 more',
    note: null,
    action: { kind: 'budget', label: 'Add your budget' },
    onOpen: jest.fn(),
    onAction: jest.fn(),
    sameNight: [],
    ...over,
  });

  test('a section named by the plan, whose name is a heading holding the one button that opens it', () => {
    const p = props();
    render(<NestHero {...p} />);
    expect(screen.getByRole('region', { name: 'Trivia Night' })).toBeInTheDocument();
    // A heading the rotor can reach (and the browser specs find a plan by),
    // never a span inside a button, whose children are presentational.
    const heading = screen.getByRole('heading', { level: 2, name: 'Trivia Night' });
    const open = screen.getByRole('button', { name: 'Trivia Night' });
    expect(heading.contains(open)).toBe(true);
    expect(open.parentElement.closest('button')).toBeNull();
    fireEvent.click(open);
    expect(p.onOpen).toHaveBeenCalledTimes(1);
    expect(p.onAction).not.toHaveBeenCalled();
  });

  test("the button says what it shows: no aria-label over the card, the rest is its description in the card's order", () => {
    const p = props({ note: 'You voted. Sam locks it in.' });
    const { container } = render(<NestHero {...p} />);
    const open = screen.getByRole('button', { name: 'Trivia Night' });
    // WCAG 2.5.3: the spoken name is the visible one. The label used to start
    // with the name while the card starts with the time, and it hid the
    // names line and the note from VoiceOver.
    expect(open).not.toHaveAttribute('aria-label');
    expect(open).toHaveAccessibleDescription('Tonight at 8:33 PM Locked in The Copper Finch You, Jordan and 1 more You voted. Sam locks it in.');
    expect(container.querySelector('[aria-label]')).toBeNull();
  });

  test('the tap area is stretched over the card from its own box, and the action rides above it', () => {
    const p = props();
    const { container } = render(<NestHero {...p} />);
    const section = container.querySelector('section');
    expect(section.style.position).toBe('relative');
    expect(section.style.isolation).toBe('isolate');
    const open = screen.getByRole('button', { name: 'Trivia Night' });
    expect(open).toHaveClass('nest-stretch', 'nest-stretch--hero');
    // Nothing between the button and the card moves: a transform on an
    // ancestor would shrink the layer to it. The settle moves a span inside.
    let el = open.parentElement;
    while (el && el !== section) { expect(el.className || '').not.toMatch(/nest-lock-settle/); el = el.parentElement; }
    expect(screen.getByRole('button', { name: 'Add your budget' })).toHaveClass('nest-raise', 'nest-on-navy');
  });

  test('a press never moves the button: the layer would shrink to the name and the tap would land on the heading', () => {
    // The app presses every button with button:active { transform: scale(.96) },
    // and a transformed element becomes the box its absolutely placed
    // children are laid out in. In the browser suite every tap on a plan's
    // heading away from its letters opened nothing.
    const css = require('fs').readFileSync(require('path').join(__dirname, '..', 'index.css'), 'utf8');
    expect(css).toMatch(/button:active, \[role="button"\]:active \{\s*transform: scale\(0\.96\);/);
    expect(css).toMatch(/\.nest-stretch:active \{ transform: none; \}/);
    // The card takes the press instead: it is already the layer's box.
    expect(css).toMatch(/\[data-nest-plan\]:has\(\.nest-stretch:active\) \{\s*transform: scale\(0\.985\);/);
    const p = props();
    const { container } = render(<NestHero {...p} />);
    expect(container.querySelector('section').getAttribute('data-nest-plan')).toBe('5');
  });

  test('the keyboard ring on the navy is near-white, 3:1 or better, never the steel ring (1.89:1)', () => {
    const css = require('fs').readFileSync(require('path').join(__dirname, '..', 'index.css'), 'utf8');
    expect(css).toMatch(/\.nest-stretch--hero:focus-visible::after \{[^}]*outline-color: rgba\(241, 237, 224, 0\.9\);[^}]*outline-offset: -4px;/);
    expect(css).toMatch(/\.nest-on-navy:focus-visible \{\s*outline-color: rgba\(241, 237, 224, 0\.9\);/);
    expect(css).toMatch(/\.nest-stretch::after \{[^}]*position: absolute;[^}]*inset: 0;/);
  });

  test("the plan's name is drawn in the display face down to its letters, never the body face", () => {
    // index.css sets the body face on every element with a `*` rule, not by
    // inheritance, so the span the lock-in settle moves, inside the button
    // inside the h2, drew the name in Hanken Grotesk under a Fraunces
    // heading. jsdom applies the real stylesheet here but does not inherit,
    // so faceOf walks up past every element that says inherit (or nothing)
    // to the face the cascade actually names.
    const css = require('fs').readFileSync(require('path').join(__dirname, '..', 'index.css'), 'utf8').replace(/\r\n/g, '\n');
    expect(css).toMatch(/\n\*,\n\*::before,\n\*::after \{\n  font-family: var\(--font-body\);\n\}/);
    expect(css).toMatch(/\.nest-stretch \{[^}]*font: inherit;/);
    expect(css).toMatch(/\.nest-stretch \* \{ font-family: inherit; \}/);
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
    try {
      const faceOf = (el) => {
        for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
          const f = getComputedStyle(n).fontFamily;
          if (f && f !== 'inherit') return f;
        }
        return null;
      };
      const p = props({ sameNight: [{ id: 9, name: 'Friday Night Crew', line: 'Also tonight at 8:00 PM', chip: null, onClick: jest.fn() }] });
      render(<NestHero {...p} />);
      const open = screen.getByRole('button', { name: 'Trivia Night' });
      const letters = screen.getByText('Trivia Night');
      expect(open.contains(letters)).toBe(true);
      expect(letters).not.toBe(open);
      expect(faceOf(screen.getByRole('heading', { level: 2 }))).toBe('var(--font-display)');
      expect(faceOf(letters)).toBe('var(--font-display)');
      // The check tells the two apart: the place line under the name gets
      // the body face, and so does a same-night row's name, a body-face
      // title by design.
      expect(faceOf(screen.getByText('The Copper Finch'))).toBe('var(--font-body)');
      expect(faceOf(screen.getByRole('button', { name: 'Friday Night Crew' }))).toBe('var(--font-body)');
    } finally {
      style.remove();
    }
  });

  test("the one action is a sibling button, never inside the card's button", () => {
    const p = props();
    const { container } = render(<NestHero {...p} />);
    const action = screen.getByRole('button', { name: 'Add your budget' });
    expect(container.querySelector('button button')).toBeNull();
    fireEvent.click(action);
    expect(p.onAction).toHaveBeenCalledTimes(1);
    expect(p.onOpen).not.toHaveBeenCalled();
  });

  test('no ask, no button, and no time counting down anywhere', () => {
    const { container } = render(<NestHero {...props({ action: null })} />);
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(container.textContent).not.toMatch(/\d+\s*(min|minutes|hrs?|hours) (left|to go)|starts in/i);
  });

  test("the plans beside it on the same night are rows with the reader's state, each name a heading", () => {
    const onClick = jest.fn();
    render(<NestHero {...props({ sameNight: [{ id: 9, name: 'Friday Night Crew', line: 'Also tonight at 8:00 PM', chip: { label: 'Voted', tone: 'neutral' }, onClick }] })} />);
    const heading = screen.getByRole('heading', { level: 3, name: 'Friday Night Crew' });
    const open = screen.getByRole('button', { name: 'Friday Night Crew' });
    expect(heading.contains(open)).toBe(true);
    expect(open).toHaveAccessibleDescription('Also tonight at 8:00 PM Voted');
    fireEvent.click(open);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Voted')).toBeInTheDocument();
    expect(screen.getByRole('list')).toBeInTheDocument();
  });
});
