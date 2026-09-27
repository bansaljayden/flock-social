/**
 * The profile streak is counted in the person's own calendar days, so the
 * stats read carries the device's IANA zone. Without it the server counts UTC
 * days, and an evening in the Americas splits at UTC midnight: two messages
 * minutes apart become two days, and two evenings in a row read as a gap.
 * backend/__tests__/profileSettingsAndStreak.test.js pins the counting.
 */
import { getUserStats } from '../services/api';

function jsonRes(body) {
  return {
    ok: true,
    status: 200,
    headers: { get: (h) => (String(h).toLowerCase() === 'content-type' ? 'application/json' : null) },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

beforeEach(() => {
  global.fetch = jest.fn(async () => jsonRes({ streak: 2 }));
  localStorage.clear();
});

test('the stats read sends the device zone', async () => {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  expect(zone).toBeTruthy();
  await getUserStats();
  const url = String(global.fetch.mock.calls[0][0]);
  expect(url).toContain(`/api/users/stats?tz=${encodeURIComponent(zone)}`);
});

test('a runtime with no zone still reads the stats, without the parameter', async () => {
  const real = Intl.DateTimeFormat;
  Intl.DateTimeFormat = function NoZone() { return { resolvedOptions: () => ({}) }; };
  try {
    await getUserStats();
  } finally {
    Intl.DateTimeFormat = real;
  }
  const url = String(global.fetch.mock.calls[0][0]);
  expect(url).toMatch(/\/api\/users\/stats$/);
});
