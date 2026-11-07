/**
 * A BRAND-NEW ACCOUNT WITH BIRDIE OPEN STILL SEES ITS TWO WAYS IN (Asad S21,
 * 2026-11-06).
 *
 * On a new account (no flocks, no friends) the docked panel, when open,
 * covered everything under the painted birds: Start a flock and Add friends
 * went under it, and what was left was the greeting and a dead cream band.
 * Birdie is part of the Nest's page now, below the empty state; while a
 * thread is open the painted crowd folds away, so both buttons stay on the
 * first screen above the answer, and the page's scroll to a new question stops
 * where Start a flock is still on screen (data-nest-keep; birdieInline.test.js
 * runs that clamp).
 *
 * HomeScreen is called inside FlockAppInner and cannot be rendered on its own,
 * so the page's order and the gates are read off App.js's source.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test nestZeroFlockBirdieOpen --watchAll=false
 */
const fs = require('fs');
const path = require('path');

const APP = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8').replace(/\r\n/g, '\n');
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const HOME = strip(APP.slice(APP.indexOf('const HomeScreen = () => {'), APP.indexOf('// The past flocks screen was declared here')));
const EMPTY = HOME.slice(HOME.indexOf('{!flocksLoading && !flocksError && liveFlocks.length === 0 && ('), HOME.indexOf('{heroFlock && ('));

test('"open" means a thread in the page', () => {
  expect(HOME).toMatch(/const nestThreadOpen = aiChatMode === 'inline' && aiMessages\.length > 0;/);
});

test('with a thread open, Start a flock and Add friends still render: nothing about the thread gates them', () => {
  expect(EMPTY.length).toBeGreaterThan(500);
  expect(EMPTY).toMatch(/<button data-nest-keep="" className="hit44" onClick=\{\(\) => setCurrentScreen\('create'\)\}/);
  expect(EMPTY).toMatch(/onClick=\{openAddFriendsFromNest\}/);
  // The only thing the open thread changes in the empty state is the art.
  expect(EMPTY.match(/nestThreadOpen/g)).toHaveLength(2);
});

test('the painted crowd folds away, height and opacity, over 200 ms', () => {
  expect(EMPTY).toMatch(/<div data-nest-art="" style=\{\{ display: 'grid', width: '100%', gridTemplateRows: nestThreadOpen \? '0fr' : '1fr', opacity: nestThreadOpen \? 0 : 1, transition: 'grid-template-rows 200ms var\(--ease-out\), opacity 200ms var\(--ease-out\)' \}\}>/);
  const art = EMPTY.slice(EMPTY.indexOf('<div data-nest-art=""'));
  expect(art.indexOf('<EmptyMark name="crowd"')).toBeGreaterThan(-1);
  expect(art.indexOf('<EmptyMark name="crowd"')).toBeLessThan(art.indexOf("'No flocks yet'"));
});

test('Birdie is a section of the page after the empty state, not a panel over it', () => {
  const empty = HOME.indexOf('{!flocksLoading && !flocksError && liveFlocks.length === 0 && (');
  const section = HOME.indexOf('<NestBirdieSection');
  expect(empty).toBeGreaterThan(-1);
  expect(section).toBeGreaterThan(empty);
  // The thread renders INTO the section, through the panel's inline
  // presentation, which draws no backdrop and no sheet (birdieInline.test.js).
  expect(HOME).toMatch(/inline=\{nestBirdieInline\}/);
  expect(APP).toMatch(/const nestBirdieInline = aiChatMode === 'inline' && \(!birdieConsented \|\| aiMessages\.length > 0\) && \(/);
  // And the sheets over the page are for the panel and full screen only.
  expect(APP).toMatch(/const aiAssistantModal = \(isAiPanel \|\| isAiFullscreen\) && \(/);
});
