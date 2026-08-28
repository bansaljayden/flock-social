// THE VOTE PANEL SCORES THE PLAN'S HOUR, NOT THE MAP'S NOW.
//
// The audit's sharpest moat finding: the only crowd-batch call site scored
// every venue at the current moment, so a vote for a Saturday 9 PM plan was
// argued with Thursday afternoon's crowd, on the one screen where the model's
// answer changes a decision. The server has accepted a caller clock all along
// (POST /api/crowd/batch, top-level localHour/localDay); the client just
// never sent any hour but now's. These pins hold the wiring together:
//
//   1. getCrowdBatch accepts an optional clock and only a well-formed one;
//      absent, the device clock rides along exactly as before.
//   2. App.js keeps event-hour scores in their own cache, because
//      crowdPredictions answers "how busy is it right now" for the map and
//      one key cannot hold two answers, and it OMITS utcOffsetMinutes from
//      the event payload, because the batch route lets a venue's own offset
//      override the top-level clock (right for "now", exactly wrong here).
//   3. The vote panel badge prefers the event score and prints the hour it
//      answers for, so 74% cannot be read as 74% right now.

import fs from 'fs';
import path from 'path';

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const API = read('services', 'api.js');
const APP = read('App.js');
const CHAT = read('screens', 'ChatDetail.js');

describe('getCrowdBatch carries a chosen clock', () => {
  const start = API.indexOf('export async function getCrowdBatch');
  const fn = API.slice(start, API.indexOf('}', API.indexOf('});', start)) + 1);

  test('the clock is optional and validated, with the device clock as the fallback', () => {
    expect(fn).toContain("Number.isInteger(clock?.localHour) ? clock.localHour : now.getHours()");
    expect(fn).toContain("Number.isInteger(clock?.localDay) ? clock.localDay : now.getDay()");
  });

  test('the body still sends exactly one localHour and one localDay', () => {
    expect(fn).toContain('JSON.stringify({ venues, localHour, localDay })');
  });
});

describe('App.js fetches the plan-hour scores into their own cache', () => {
  const start = APP.indexOf('const requestEventCrowdScores');
  expect(start).toBeGreaterThan(-1);
  const fn = APP.slice(start, APP.indexOf('}, []);', start));

  test('the clock sent is the flock event time, hour and day', () => {
    expect(fn).toContain('{ localHour: at.getHours(), localDay: at.getDay() }');
  });

  test('the event payload omits utcOffsetMinutes so the plan clock cannot be overridden per venue', () => {
    // requestCrowdScores (the map path) forwards it; this path must not.
    expect(fn).not.toContain('utcOffsetMinutes');
  });

  test('scores land in eventCrowdScores keyed by flock, never in crowdPredictions', () => {
    expect(fn).toContain('setEventCrowdScores');
    expect(fn).not.toContain('setCrowdPredictions');
  });

  test('a failed fetch stays fetchable; only a landed score is final', () => {
    expect(fn).toContain('eventCrowdFetchedRef.current.delete');
  });

  test('opening the vote panel is the trigger, with the suggestion list in the deps', () => {
    expect(APP).toContain('[showVotePanel, selectedFlockId, popularVenues, flocks, requestEventCrowdScores]');
  });

  test('ChatDetail receives the flock-scoped scores and an honest hour label', () => {
    expect(APP).toContain('const eventCrowd = eventCrowdScores[selectedFlockId] || null;');
    expect(APP).toMatch(/eventCrowdLabel/);
    expect(APP).toContain("`at ${d.toLocaleTimeString([], { hour: 'numeric' })}`");
  });
});

describe('the vote panel badge answers the plan question when it can', () => {
  test('the badge prefers the event score and falls back to the map score', () => {
    expect(CHAT).toContain('const ev = eventCrowd ? eventCrowd[venue.place_id] : undefined;');
    expect(CHAT).toContain("const score = typeof ev === 'number' ? ev : (typeof venue.crowd === 'number' ? venue.crowd : null);");
  });

  test('an event score is labeled with its hour, and a now score is not', () => {
    expect(CHAT).toContain("{score}%{typeof ev === 'number' && eventCrowdLabel ? ` ${eventCrowdLabel}` : ''}");
  });
});

describe('the first-run empty state teaches the guest link', () => {
  test('the copy sells the one motion that works with zero friends on the platform', () => {
    expect(APP).toContain('Start one and drop the invite link in the group chat. Nobody needs the app to see the plan and vote.');
  });
});
