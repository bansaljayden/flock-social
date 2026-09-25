/**
 * A VENUE CARD THAT COMES BACK LOCKED TAKES ITS NUMBER OFF THE MAP TOO.
 *
 * Once a free account has spent its month, the server covers the crowd card
 * of any venue it has not opened (backend/routes/crowd.js lockedCard) and
 * withholds that venue's number from the batch (lockedListRow). A withheld
 * batch row already cleared its pin (crowdDialCovered.test.js pins that). The
 * card did not: both card paths wrote a number back to the map only when
 * there was one, so the pin under a covered card kept quoting the score an
 * earlier, unlocked batch had left, and a score younger than
 * CROWD_SCORE_TTL_MS was never asked for again. Read as source, the way the
 * other App.js map suites read it.
 */
const fs = require('fs');
const path = require('path');

const APP = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8').replace(/\r\n/g, '\n');

describe('a covered card clears its own pin', () => {
  test('the entry it writes is the withheld row\'s shape: no number, no label, crowdLocked', () => {
    expect(APP).toContain('const lockedCrowdPrediction = (placeId, at) => ({ placeId, score: null, label: null, crowdLocked: true, fetchedAt: at });');
    // The pin sync that turns crowdLocked into an empty pin is the one the batch uses.
    expect(APP).toMatch(/if \(p && p\.crowdLocked && \(v\.crowd != null \|\| v\.crowdLabel != null\)\) \{\s*changed = true;\s*return \{ \.\.\.v, crowd: null, crowdLabel: null \};/);
  });

  test('the map pin path writes it when the card is locked', () => {
    const effect = APP.slice(APP.indexOf('getCrowdPrediction(pid)\n      .then(data => {'), APP.indexOf('.catch(() => {', APP.indexOf('getCrowdPrediction(pid)\n      .then(data => {')));
    expect(effect).toMatch(/\} else if \(data && data\.forecastAccess\?\.locked === true\) \{[\s\S]*?forecastLockedAtRef\.current = lockedAt;\s*setCrowdPredictions\(prev => \(\{ \.\.\.prev, \[pid\]: lockedCrowdPrediction\(pid, lockedAt\) \}\)\);/);
  });

  test('the venue detail path writes it too', () => {
    const open = APP.slice(APP.indexOf('const openVenueDetail = useCallback('), APP.indexOf('// Pan map to venue location once we have coordinates'));
    expect(open).toMatch(/\} else if \(crowd && crowd\.forecastAccess\?\.locked === true\) \{[\s\S]*?forecastLockedAtRef\.current = lockedAt;\s*setCrowdPredictions\(prev => \(\{ \.\.\.prev, \[placeId\]: lockedCrowdPrediction\(placeId, lockedAt\) \}\)\);/);
  });
});

describe('numbers scored before the lock are asked for again', () => {
  const batch = APP.slice(APP.indexOf('const requestCrowdScores = useCallback('), APP.indexOf('getCrowdBatch(batchPayload)'));

  test('the thirty-minute freshness rule is unchanged', () => {
    expect(batch).toContain('const stale = (e) => !e || !e.fetchedAt || Date.now() - e.fetchedAt > CROWD_SCORE_TTL_MS;');
  });

  test('a score fetched before the first locked card is re-asked, and a withheld row is not', () => {
    expect(APP).toMatch(/const forecastLockedAtRef = useRef\(0\);/);
    expect(APP.indexOf('const forecastLockedAtRef = useRef(0);')).toBeLessThan(APP.indexOf('const requestCrowdScores = useCallback('));
    expect(batch).toContain('const scoredBeforeLock = (e) => lockedAt > 0 && !!e && !e.crowdLocked && e.fetchedAt < lockedAt;');
    expect(batch).toMatch(/stale\(crowdPredictionsRef\.current\[v\.place_id\]\) \|\| scoredBeforeLock\(crowdPredictionsRef\.current\[v\.place_id\]\)/);
  });
});
