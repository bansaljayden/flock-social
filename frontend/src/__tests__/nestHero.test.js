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
    [voting, { ask: 'owe' }, 'Your share'],
    [voting, { needsVote: true }, 'Your vote'],
    [voting, { voted: true }, 'Voted'],
    [voting, {}, 'Voting'],
    [{ ...voting, status: 'confirmed', askHowItWas: true }, {}, 'How was it?'],
    [{ ...voting, status: 'confirmed' }, {}, 'Locked in'],
  ])('%#', (f, opts, want) => {
    expect(planChip(f, opts).label).toBe(want);
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

  test('a section named by the plan, whose body is one button read out as the whole card', () => {
    const p = props();
    render(<NestHero {...p} />);
    expect(screen.getByRole('region', { name: 'Trivia Night' })).toBeInTheDocument();
    const open = screen.getByRole('button', { name: 'Trivia Night, Tonight at 8:33 PM, The Copper Finch, Locked in, 3 going' });
    fireEvent.click(open);
    expect(p.onOpen).toHaveBeenCalledTimes(1);
    expect(p.onAction).not.toHaveBeenCalled();
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

  test("the plans beside it on the same night are rows with the reader's state", () => {
    const onClick = jest.fn();
    render(<NestHero {...props({ sameNight: [{ id: 9, name: 'Friday Night Crew', line: 'Also tonight at 8:00 PM', chip: { label: 'Voted', tone: 'neutral' }, onClick }] })} />);
    fireEvent.click(screen.getByRole('button', { name: /Friday Night Crew/ }));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Voted')).toBeInTheDocument();
  });
});
