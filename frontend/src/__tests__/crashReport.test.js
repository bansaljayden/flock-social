/**
 * "SEND THIS TO FLOCK", ON THE CRASH SCREEN.
 *
 * A crash on a phone used to end in a WebView console nobody can read, and
 * Sentry is off on purpose. The crash screen now offers a button that sends
 * one report when it is pressed, and only then. Pinned here:
 *
 *   1. what a report holds: the boundary, the error's name, a message clamped
 *      to 200 characters with tokens, coordinates and addresses removed, up to
 *      eight component names, the build and native or web; no account;
 *   2. the request carries no cookie and no Authorization header;
 *   3. the button says "Sent" only when the server kept it, and a failed send
 *      can be tried again;
 *   4. it is on the app-wide fallback and both screen-level fallbacks, and not
 *      on a download that died, which is the network and not a bug;
 *   5. the privacy policy says what it sends.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test --watchAll=false --testPathPattern crashReport
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ErrorBoundary from '../components/ErrorBoundary';
import {
  componentNames, crashReportPayload, sendCrashReport, buildId, MESSAGE_MAX, MAX_COMPONENTS,
} from '../services/crashReport';
import { worthReporting, CRASH_REPORT_NOTE } from '../components/CrashReportButton';

const fs = require('fs');
const path = require('path');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8').replace(/\r\n/g, '\n');

const REACT19_STACK = `
    at FlockChat (https://flockcorp.com/static/js/123.abc.chunk.js:1:2)
    at div
    at FlockChat (https://flockcorp.com/static/js/123.abc.chunk.js:1:2)
    at ScreenSlot (https://flockcorp.com/static/js/main.abc123def456.js:3:4)
    at ErrorBoundary (https://flockcorp.com/static/js/main.abc123def456.js:5:6)
    at FlockAppInner (https://flockcorp.com/static/js/main.abc123def456.js:7:8)`;

describe('what a report holds', () => {
  test('component names come off the stack, host elements and repeats left out', () => {
    expect(componentNames(REACT19_STACK)).toEqual(['FlockChat', 'ScreenSlot', 'ErrorBoundary', 'FlockAppInner']);
    expect(componentNames('\n    in Nest (at App.js:12)\n    in span\n    in App')).toEqual(['Nest', 'App']);
    const deep = Array.from({ length: 20 }, (_, i) => `    at Screen${i} (x.js:1:1)`).join('\n');
    expect(componentNames(deep)).toHaveLength(MAX_COMPONENTS);
    expect(componentNames(null)).toEqual([]);
  });

  test('the message leaves the device with tokens, coordinates and addresses removed, clamped', () => {
    const error = new TypeError(
      'failed at https://api.flockcorp.com/api/weather?lat=40.6259&lon=-75.3705 for ava@example.com on /i/AbC123_x '.repeat(4),
    );
    const p = crashReportPayload({ error, componentStack: REACT19_STACK, label: 'screen:chat' });
    expect(p.name).toBe('TypeError');
    expect(p.boundary).toBe('screen:chat');
    expect(p.message.length).toBeLessThanOrEqual(MESSAGE_MAX);
    expect(p.message).not.toMatch(/40\.6259|-75\.3705|ava@example\.com|AbC123_x/);
    expect(p.message).toMatch(/lat=redacted/);
    expect(p.message).toMatch(/\[email\]/);
    expect(p.message).toMatch(/\/i\/:token/);
    expect(p.components[0]).toBe('FlockChat');
    expect(['native', 'web']).toContain(p.platform);
    // Nothing that could name a person is a field at all.
    expect(Object.keys(p).sort()).toEqual(
      ['boundary', 'components', 'message', 'name', 'platform', ...(p.build ? ['build'] : [])].sort(),
    );
  });

  test('an odd error name or label is replaced with one the server accepts', () => {
    const odd = { name: 'Weird Error <b>', message: 'x' };
    const p = crashReportPayload({ error: odd, componentStack: '', label: '<root>' });
    expect(p.name).toBe('Error');
    expect(p.boundary).toMatch(/^[A-Za-z0-9][\w .:-]{0,39}$/);
    expect(crashReportPayload({ error: null, label: undefined }).boundary).toBe('root');
  });

  test('the build is read off the entry bundle name, and is absent without one', () => {
    const doc = { scripts: [{ src: 'https://flockcorp.com/static/js/main.9f8e7d6c5b4a3f21.js' }] };
    expect(buildId(doc)).toBe('9f8e7d6c5b4a');
    expect(buildId({ scripts: [{ src: '/static/js/bundle.js' }] })).toBeNull();
  });
});

describe('the request', () => {
  test('posts JSON to the crash route with no cookie and no token', async () => {
    const calls = [];
    const ok = await sendCrashReport({ boundary: 'root' }, async (url, opts) => {
      calls.push({ url, opts });
      return { ok: true, status: 201 };
    });
    expect(ok).toBe(true);
    expect(calls[0].url).toMatch(/\/api\/client-crash$/);
    expect(calls[0].opts.method).toBe('POST');
    expect(calls[0].opts.credentials).toBe('omit');
    expect(Object.keys(calls[0].opts.headers).map((h) => h.toLowerCase())).not.toContain('authorization');
  });

  test('a refusal or a dead network answers false, never throws', async () => {
    await expect(sendCrashReport({}, async () => ({ ok: false, status: 429 }))).resolves.toBe(false);
    await expect(sendCrashReport({}, async () => { throw new Error('offline'); })).resolves.toBe(false);
  });
});

function Boom({ error }) {
  throw error;
}

describe('the crash screen', () => {
  let realFetch;
  let realError;
  beforeEach(() => {
    realFetch = global.fetch;
    realError = console.error;
    console.error = () => {};
  });
  afterEach(() => {
    global.fetch = realFetch;
    console.error = realError;
  });

  test('the app-wide fallback offers the button, and it reads Sent once the server kept it', async () => {
    const sent = [];
    global.fetch = jest.fn(async (url, opts) => { sent.push(JSON.parse(opts.body)); return { ok: true, status: 201 }; });
    render(
      <ErrorBoundary label="app-root">
        <Boom error={new TypeError('votes is undefined')} />
      </ErrorBoundary>,
    );
    const button = screen.getByRole('button', { name: 'Send this to Flock' });
    expect(screen.getByText(CRASH_REPORT_NOTE)).toBeTruthy();
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sent' })).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Sent' }).disabled).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].boundary).toBe('app-root');
    expect(sent[0].name).toBe('TypeError');
    expect(sent[0].components).toContain('Boom');
    // A second press sends nothing more.
    fireEvent.click(screen.getByRole('button', { name: 'Sent' }));
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('a send that failed says so and can be tried again', async () => {
    global.fetch = jest.fn(async () => ({ ok: false, status: 500 }));
    render(
      <ErrorBoundary label="app-root">
        <Boom error={new Error('boom')} />
      </ErrorBoundary>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Send this to Flock' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Not sent. Try again' })).toBeTruthy());
    global.fetch = jest.fn(async () => ({ ok: true, status: 201 }));
    fireEvent.click(screen.getByRole('button', { name: 'Not sent. Try again' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sent' })).toBeTruthy());
  });

  test('a download that died gets no button: that is the network, not a bug', () => {
    const chunk = new Error('Loading chunk 42 failed.');
    chunk.name = 'ChunkLoadError';
    expect(worthReporting(chunk)).toBe(false);
    expect(worthReporting(new Error('Loading CSS chunk 7 failed'))).toBe(false);
    expect(worthReporting(new TypeError('x is undefined'))).toBe(true);
    render(
      <ErrorBoundary label="app-root">
        <Boom error={chunk} />
      </ErrorBoundary>,
    );
    expect(screen.queryByRole('button', { name: 'Send this to Flock' })).toBeNull();
  });

  test('a custom fallback is handed what the button needs', () => {
    let got = null;
    render(
      <ErrorBoundary label="screen:chat" fallback={(args) => { got = args; return <p>fallback</p>; }}>
        <Boom error={new Error('x')} />
      </ErrorBoundary>,
    );
    expect(got.label).toBe('screen:chat');
    expect(typeof got.reset).toBe('function');
    expect(String(got.componentStack || '')).toMatch(/Boom/);
  });

  test('both screen-level fallbacks in App.js carry the button and the note', () => {
    const app = read('App.js');
    for (const name of ['screenCrashFallback', 'exploreCrashFallback']) {
      const start = app.indexOf(`const ${name} = (`);
      expect(start).toBeGreaterThan(0);
      const body = app.slice(start, app.indexOf('\n  );\n', start));
      expect(body).toMatch(/componentStack, label \}\) =>/);
      expect(body).toMatch(/<CrashReportButton\s/);
      expect(body).toMatch(/\{CRASH_REPORT_NOTE\}/);
      expect(body).toMatch(/worthReporting\(error\)/);
    }
  });
});

describe('the words', () => {
  test('the privacy policy says what a report holds and that nothing goes without the press', () => {
    const policy = read('website', 'PrivacyPolicy.js');
    expect(policy).toMatch(/Send this\s+to Flock/);
    expect(policy).toMatch(/nothing is sent unless you press it/);
    expect(policy).toMatch(/delete it after 90 days/);
    expect(policy).not.toMatch(/no crash\s+report is being sent anywhere today/);
  });

  test('no em dash in anything the crash screen says', () => {
    const src = read('components', 'CrashReportButton.js');
    const strings = src.match(/'[^'\n]*'/g) || [];
    for (const s of strings) expect(s).not.toMatch(/—/);
  });
});
