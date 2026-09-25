/**
 * THE MAP'S CROWD BATCH CARRIES EACH VENUE'S ZONE.
 *
 * /api/venues/search and /api/venues/details return each venue's IANA zone
 * beside its UTC offset, and POST /api/crowd/batch prefers the zone
 * (backend/routes/crowd.js). The offset is the one in force when the list was
 * fetched, and requestCrowdScores re-scores a list it still holds once its
 * scores are CROWD_SCORE_TTL_MS old, so after 2 AM on 2026-11-01 a New York
 * list put its pins an hour away from the venue card, which reads the zone.
 * These pin the client half: the map payload forwards the zone, the owner's
 * own map pin carries it from the details payload, and the plan-hour payload
 * leaves it out, because a venue's clock would override the plan's. Read as
 * source, the way the other App.js map suites read it.
 */
const fs = require('fs');
const path = require('path');

const APP = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8').replace(/\r\n/g, '\n');

// The source from `start` up to the next `end`, failing loudly if either moved.
function between(start, end) {
  const from = APP.indexOf(start);
  expect(from).toBeGreaterThan(-1);
  const to = APP.indexOf(end, from);
  expect(to).toBeGreaterThan(from);
  return APP.slice(from, to);
}

describe('the venue zone reaches the crowd batch', () => {
  test('the map payload forwards the zone beside the offset', () => {
    const payload = between('const batchPayload = unscored.slice(0, 20).map(v => ({', 'getCrowdBatch(batchPayload)');
    expect(payload).toContain('utcOffsetMinutes: v.utcOffsetMinutes != null ? v.utcOffsetMinutes : null,');
    expect(payload).toContain('timeZone: v.timeZone || null,');
  });

  test("the owner's own pin carries the zone from the details payload", () => {
    const owner = between('const ownerVenue = {', 'let nearby = [];');
    expect(owner).toContain('timeZone: v.timeZone || null,');
  });

  test("the plan-hour payload sends neither, so the plan's clock is the one scored", () => {
    const fn = between('const requestEventCrowdScores', '}, []);');
    expect(fn).not.toContain('timeZone');
    expect(fn).not.toContain('utcOffsetMinutes');
  });
});
