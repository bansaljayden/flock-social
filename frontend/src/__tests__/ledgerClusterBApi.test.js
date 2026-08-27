/**
 * Ledger cluster B, the api.js half: what an error status turns into by the
 * time a person reads it, and how many paid calls one tap is allowed to spend.
 *
 *   B1. buildHttpError used to throw away a 502/503/504 body EVEN WHEN the
 *       server itself sent a real JSON sentence, replacing it with a generic
 *       line. It now keeps the server's own sentence and falls back to the
 *       generic only when there is none. The startsWith('<') guard still
 *       rejects a gateway's HTML error page, which is not display copy.
 *
 *   B2. searchVenues and getVenueDetails are GETs, so they inherited the
 *       automatic 502/503/504 retry. Every one of those is a fresh PAID Google
 *       Places call, so a flaky gateway spent up to three searches on one tap.
 *       Both now pass retry: false and fire exactly once.
 *
 *   B4. A 500 answered with the backend's catch-all literal "Server error"
 *       surfaced that placeholder verbatim (the flock-send toast printed it).
 *       That exact string is now dropped for honest client copy, while a 500
 *       carrying a real hand-written sentence is kept.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test ledgerClusterBApi --watchAll=false
 */

import request, {
  searchVenues,
  getVenueDetails,
  voteForVenue,
  getBlockedUsers,
} from '../services/api';

const fs = require('fs');
const path = require('path');

// A tracking failure must never break a request, and the SDK is only imported
// when a key is set, so with no key these tests never touch it. Mocked anyway
// so a stray import cannot reach the network.
jest.mock('socket.io-client', () => ({ io: () => ({ on() {}, off() {}, emit() {}, connect() {}, disconnect() {}, removeAllListeners() {} }) }));

function jsonRes(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (h) => (String(h).toLowerCase() === 'content-type' ? 'application/json; charset=utf-8' : null) },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

// 502/503/504 the way a real gateway answers: an HTML error page, not JSON.
function htmlRes(status) {
  const html = '<html><body><h1>502 Bad Gateway</h1><p>nginx</p></body></html>';
  return {
    ok: false,
    status,
    headers: { get: (h) => (String(h).toLowerCase() === 'content-type' ? 'text/html; charset=utf-8' : null) },
    json: async () => { throw new SyntaxError('Unexpected token <'); },
    text: async () => html,
  };
}

function setOnline(value) {
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => value });
}

async function rejection(promise) {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error('expected the promise to reject');
}

beforeEach(() => {
  global.fetch = jest.fn();
  localStorage.clear();
  setOnline(true);
});

/* ═══════════════════════════════════════════════════════════════════════════
   B1. A gateway status keeps the server's own words when it has any
   ═══════════════════════════════════════════════════════════════════════════ */

describe('B1: 502/503/504 error copy', () => {
  test("a 503 with the server's own JSON sentence keeps that sentence", () => {
    // A write, so buildHttpError runs on the first and only response.
    global.fetch.mockResolvedValue(jsonRes({ error: 'Down for scheduled maintenance until 3pm.' }, 503));
    return rejection(voteForVenue(1, 'The Basement')).then((err) => {
      expect(err.status).toBe(503);
      // The mutation this kills: an unconditional generic override, which is
      // what the code did before B1.
      expect(err.message).toBe('Down for scheduled maintenance until 3pm.');
    });
  });

  test('a 503 whose body is a gateway HTML page still gets the generic line', () => {
    // The other half of B1: the startsWith('<') guard means HTML never becomes
    // copy, so the generic sentence speaks and no markup leaks.
    global.fetch.mockResolvedValue(htmlRes(503));
    return rejection(voteForVenue(1, 'The Basement')).then((err) => {
      expect(err.status).toBe(503);
      expect(err.message).toMatch(/servers are having a moment/i);
      expect(err.message).not.toContain('<');
    });
  });

  test('a 502 with no usable body falls back to the generic line', () => {
    global.fetch.mockResolvedValue(jsonRes({}, 502));
    return rejection(voteForVenue(1, 'The Basement')).then((err) => {
      expect(err.status).toBe(502);
      expect(err.message).toMatch(/servers are having a moment/i);
    });
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   B4. A 500's catch-all placeholder never reaches a person
   ═══════════════════════════════════════════════════════════════════════════ */

describe('B4: a 500 does not surface the backend literal', () => {
  test('the "Server error" placeholder becomes honest client copy', () => {
    global.fetch.mockResolvedValue(jsonRes({ error: 'Server error' }, 500));
    return rejection(voteForVenue(1, 'The Basement')).then((err) => {
      expect(err.status).toBe(500);
      expect(err.message).not.toMatch(/server error/i);
      expect(err.message).toMatch(/something went wrong on our end/i);
    });
  });

  test('a 500 with a real hand-written sentence is kept', () => {
    // B4 drops only the exact catch-all string, so a 500 that the backend
    // deliberately worded for a person still reaches them.
    const sentence = 'Venue search hit a problem on our side. Try again in a moment.';
    global.fetch.mockResolvedValue(jsonRes({ error: sentence }, 500));
    return rejection(voteForVenue(1, 'Kome')).then((err) => {
      expect(err.status).toBe(500);
      expect(err.message).toBe(sentence);
    });
  });

  test('the backend error code still rides along for callers that key off it', () => {
    global.fetch.mockResolvedValue(jsonRes({ error: 'Server error', code: 'SOMETHING' }, 500));
    return rejection(voteForVenue(1, 'The Basement')).then((err) => {
      expect(err.code).toBe('SOMETHING');
      expect(err.message).toMatch(/something went wrong on our end/i);
    });
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   B2. Venue search never auto-retries: each retry is a paid Google call
   ═══════════════════════════════════════════════════════════════════════════ */

describe('B2: venue search fires exactly once on a 5xx', () => {
  test('searchVenues does not retry a 503', async () => {
    global.fetch.mockResolvedValue(jsonRes({ error: 'upstream' }, 503));
    const err = await rejection(searchVenues('bars near me', '40.0,-75.0'));
    expect(err.status).toBe(503);
    // The mutation this kills: dropping retry: false, which would make this a
    // retrying GET and fire the paid call three times.
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('getVenueDetails does not retry a 503', async () => {
    global.fetch.mockResolvedValue(jsonRes({ error: 'upstream' }, 503));
    const err = await rejection(getVenueDetails('place_abc'));
    expect(err.status).toBe(503);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('an ordinary GET still retries a 503, so the difference above is real', async () => {
    // Without this counter-example, a retry policy hard-disabled everywhere
    // would pass the two tests above for the wrong reason.
    global.fetch.mockResolvedValue(jsonRes({ error: 'upstream' }, 503));
    const err = await rejection(getBlockedUsers());
    expect(err.status).toBe(503);
    expect(global.fetch).toHaveBeenCalledTimes(3);
  }, 10000);
});

/* ═══════════════════════════════════════════════════════════════════════════
   Source pin: the opt-out cannot be silently deleted
   ═══════════════════════════════════════════════════════════════════════════ */

describe('the retry opt-out is present in source', () => {
  // Comments stripped so a note that merely mentions "retry: false" cannot pass
  // for the call actually carrying it.
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'api.js'), 'utf8');
  const codeOnly = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');

  function bodyOf(name) {
    const at = codeOnly.indexOf(`export async function ${name}(`);
    expect(at).toBeGreaterThan(-1);
    return codeOnly.slice(at, at + 500);
  }

  test('searchVenues passes retry: false', () => {
    expect(bodyOf('searchVenues')).toMatch(/retry:\s*false/);
  });

  test('getVenueDetails passes retry: false', () => {
    expect(bodyOf('getVenueDetails')).toMatch(/retry:\s*false/);
  });
});
