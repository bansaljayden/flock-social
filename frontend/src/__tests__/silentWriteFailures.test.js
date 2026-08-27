/**
 * THE APP MAY NOT SHOW SUCCESS IT DID NOT HAVE.
 *
 * A UI that lies about success is worse than one that fails honestly, because
 * the person acts on it. Five writes in App.js used to end in `.catch(() => {})`
 * and one of them carried a comment stating the lie out loud.
 *
 *   1. A VOTE. updateFlockVotes flipped the tile, posted nothing, rolled
 *      nothing back and said nothing. The user believed they had voted; the
 *      flock believed they had not; the tile quietly reverted on the next
 *      load. updateFlockVenue, the function directly below it, had documented
 *      the rollback shape for weeks.
 *
 *   2. A CALENDAR EVENT. addEventToCalendar kept the optimistic row on a
 *      failed write, under a comment reading "offline: keep the optimistic
 *      local copy for this session". The event looked saved, the user closed
 *      the app trusting it, and it was gone at the next launch.
 *
 *   3. A FRIEND REQUEST. startNewDmWithUser fired one on the way into a new
 *      chat and dropped every refusal. Nothing existed on either account.
 *
 *   4. THE VENUE CARD THAT STARTS THE PLAN. The create-flock flow posted it
 *      fire and forget, so a refused write left the card in the creator's own
 *      chat and nowhere else, with nothing on either screen saying so.
 *
 *   5. FAILED LOADS DRAWN AS EMPTY. Six reads swallowed their errors and let
 *      an empty state speak for them. The safety screen was the worst: "No
 *      trusted contacts yet", on the surface an emergency alert runs through.
 *
 * WHAT IS DELIBERATELY NOT CHANGED, and pinned here so the next reader does not
 * re-open it as an oversight:
 *
 *   getPublicPromotions stays silent. Its section renders only when there is at
 *   least one promotion, so a failed read hides a heading and asserts nothing.
 *   There is no sentence claiming the venue has no deals, so there is nothing
 *   dressed as emptiness. The invariant that makes the silence safe is pinned
 *   below.
 *
 *   getMyAvailability stays silent. The Tonight control is a live three-way
 *   switch in the busiest header in the app: it prints no sentence about the
 *   user's status, and the next tap writes the truth to the server regardless
 *   of what the failed read left on screen.
 *
 * Source-scanning, not rendering, like every other App.js suite in this folder:
 * each fact under test is a call-site choice inside a 20,000-line file. Most of
 * the screens that draw these states mount inside the same monolith; the DM
 * thread left it for screens/DmDetail.js on 2026-08-27 and is read alongside.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test --watchAll=false
 */

const fs = require('fs');
const path = require('path');

// The venue-vote panel and its "not connected" copy below are drawn by the DM
// screen, which left App.js for screens/DmDetail.js on 2026-08-27; its source is
// concatenated so those call-site checks still find them. The handlers behind
// them (loadDmVenueVotes, onDmNewVote, startNewDmWithUser) did not move.
const APP_SRC = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8')
  + fs.readFileSync(path.join(__dirname, '..', 'screens', 'DmDetail.js'), 'utf8');

/**
 * Comments dropped, so prose describing a fix cannot pass for the fix. Line
 * endings normalised first: this working tree checks out CRLF, and a marker
 * written with a plain newline finds nothing in a file full of \r\n.
 */
function codeOnly(src) {
  return src
    .replace(/\r\n/g, '\n')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');
}

const APP = codeOnly(APP_SRC);

function region(src, startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf(endMarker, start + startMarker.length);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. A vote
// ═══════════════════════════════════════════════════════════════════════════

describe('a vote that did not save', () => {
  const votes = () => region(APP, 'const updateFlockVotes = useCallback', 'const updateFlockVenue = useCallback');

  test('the tallies on screen are captured before the optimistic write', () => {
    const fn = votes();
    const captured = fn.indexOf('flocksRef.current.find');
    const optimistic = fn.indexOf('setFlocks(prev => prev.map(f => f.id === flockId ? { ...f, votes: optimistic }');
    expect(captured).toBeGreaterThan(-1);
    expect(optimistic).toBeGreaterThan(captured);
  });

  test('a refusal puts them back', () => {
    expect(votes()).toMatch(/if \(previousVotes\) setFlocks\(prev => prev\.map\(f => f\.id === flockId \? \{ \.\.\.f, votes: previousVotes \} : f\)\)/);
  });

  test('and says so, naming the action, as an error toast', () => {
    const fn = votes();
    expect(fn).toMatch(/showToast\(.*'error'\)/);
    expect(fn).toMatch(/Your vote didn't save\./);
    expect(fn).toMatch(/Clearing your vote didn't save\./);
    // A dead session has already announced itself through api.js's own toast.
    expect(fn).toMatch(/err\?\.sessionExpired/);
  });

  test('nothing in it swallows the failure any more', () => {
    expect(votes()).not.toMatch(/\.catch\(\(\) => \{\}\)/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. A calendar event
// ═══════════════════════════════════════════════════════════════════════════

describe('a calendar event that did not save', () => {
  const cal = () => region(APP, 'const addEventToCalendar = useCallback', 'const addMessageToFlock');

  test('the optimistic row is taken back off the calendar', () => {
    expect(cal()).toMatch(/setCalendarEvents\(prev => prev\.filter\(e => e\.id !== tempId\)\)/);
  });

  test('and the user is told, in words naming the calendar', () => {
    const fn = cal();
    expect(fn).toMatch(/That didn't get added to your calendar\./);
    expect(fn).toMatch(/showToast\(.*'error'\)/);
  });

  test('the comment that stated the lie survives only as a tombstone', () => {
    // "offline: keep the optimistic local copy for this session" sat on the
    // catch that caused it. It is worth keeping the sentence, because it is
    // the clearest description of the defect anyone wrote. It is not worth
    // keeping it anywhere it could be read as current behaviour, so the one
    // surviving copy has to be a comment.
    const hits = APP_SRC
      .split('\n')
      .filter((line) => line.includes('keep the optimistic local copy for this session'));
    expect(hits).toHaveLength(1);
    expect(hits[0].trim().startsWith('//')).toBe(true);
    expect(cal()).not.toMatch(/\.catch\(\(\) => \{\}\)/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. A friend request
// ═══════════════════════════════════════════════════════════════════════════

describe('the friend request sent on the way into a new chat', () => {
  // The New Message sheet that used to close this region left App.js on
  // 2026-08-26 (components/NewDmModal.js), so the region now ends at the next
  // declaration after startNewDmWithUser. The handler itself did not move: it
  // is still FlockAppInner's, and the sheet receives it as a prop.
  const dm = () => region(APP, 'const startNewDmWithUser = useCallback', 'const selectedDm =');

  test('a refusal is reported rather than dropped', () => {
    const fn = dm();
    expect(fn).toMatch(/sendFriendRequest\(user\.id\)\.catch\(\(err\) => \{/);
    expect(fn).not.toMatch(/sendFriendRequest\(user\.id\)\.catch\(\(\) => \{\}\)/);
  });

  test('the copy separates the half that worked from the half that did not', () => {
    // Both "already friends" and "already sent" are 200s from
    // routes/friends.js, so anything caught here is a real refusal and worth
    // a sentence.
    expect(dm()).toMatch(/Your message is here, but the friend request didn't send\./);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. The venue card that starts the plan
// ═══════════════════════════════════════════════════════════════════════════

describe('the venue card posted when a flock is created', () => {
  const card = () => region(APP, 'const venueCardTempId', 'const invitedNames');

  test('it goes out as a pending message, not a settled one', () => {
    expect(card()).toMatch(/pending: true/);
  });

  test('a stored card settles and adopts the id the server issued', () => {
    const fn = card();
    expect(fn).toMatch(/isServerId\(savedId\)/);
    expect(fn).toMatch(/pending: false/);
  });

  test('a refused card is marked failed, which is what draws tap to retry', () => {
    const fn = card();
    expect(fn).toMatch(/failed: true/);
    expect(fn).toMatch(/showToast\(.*'error'\)/);
    expect(fn).toMatch(/The flock is created, but the venue card didn't reach the chat\./);
    expect(fn).not.toMatch(/\.catch\(\(\) => \{\}\)/);
  });

  test('retryFailedMessage can actually resend a venue card', () => {
    // The affordance the failed flag turns on is only worth turning on if the
    // retry carries venue_data. It does, and this is what says so.
    const retry = region(APP, 'const retryFailedMessage = useCallback', 'const sendChatMessage');
    expect(retry).toMatch(/venue_data: failedMsg\.venue_data \|\| null/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. Failed loads are never drawn as empty
// ═══════════════════════════════════════════════════════════════════════════

describe('the safety screen, which is the one that matters most', () => {
  test('a failed read is recorded instead of warned about in a console nobody reads', () => {
    const load = region(APP, 'const loadTrustedContacts = useCallback', 'const handleEditContact');
    expect(load).toMatch(/setTrustedContactsLoaded\(true\)/);
    expect(load).toMatch(/setTrustedContactsError\(/);
  });

  test('the mount read reports its failure too', () => {
    const mount = region(APP, 'getTrustedContacts()\n', '}, []);');
    expect(mount).toMatch(/setTrustedContactsError\(/);
    expect(mount).not.toMatch(/\.catch\(\(\) => \{\}\)/);
  });

  test('"No trusted contacts yet" waits for a read that landed', () => {
    const empty = region(APP, 'trustedContactsError && trustedContactsLoaded', 'No trusted contacts yet');
    expect(empty).toMatch(/trustedContacts\.length === 0/);
  });

  test('the failure says so, offers the retry, and is announced', () => {
    const card = region(APP, '{!safetyLoading && trustedContactsError && (', 'Try again');
    expect(card).toMatch(/role="alert"/);
    expect(card).toMatch(/\{trustedContactsError\}/);
    expect(APP).toMatch(/onClick=\{loadTrustedContacts\}/);
  });

  test('the count is only printed once the list is known', () => {
    expect(APP).toMatch(/Trusted Contacts\{trustedContactsLoaded \? ` \(\$\{trustedContacts\.length\}\)` : ''\}/);
  });

  test('an emergency send does not tell someone to add contacts they may already have', () => {
    const alert = region(APP, 'const handleEmergencyAlert = useCallback', 'cancelSosLocationFollowUp();');
    expect(alert).toMatch(/if \(!trustedContactsLoaded\)/);
    expect(alert).toMatch(/couldn't be loaded, so nobody has been alerted/);
    // The old sentence survives, for the zero that was actually measured.
    expect(alert).toMatch(/Add trusted contacts in Safety settings first/);
  });

  test('opening the emergency sheet re-reads a list that never loaded', () => {
    expect(APP).toMatch(/if \(showSOS && !trustedContactsLoaded && !safetyLoading\) loadTrustedContacts\(\);/);
  });

  test('the sheet is still handed the same count prop it was extracted with', () => {
    // sosEmergencyRebuild pins this line as well. Both suites want it verbatim.
    expect(APP).toMatch(/contactCount=\{trustedContacts\.length\}/);
  });
});

describe('venue reviews', () => {
  test('the list is null until a read lands', () => {
    expect(APP).toMatch(/const \[venueDetailReviews, setVenueDetailReviews\] = useState\(null\)/);
  });

  test('"Be the first" is only said about a venue the server answered for', () => {
    const list = region(APP, '{venueDetailReviews && venueDetailReviews.length > 0 ?', 'Get Directions');
    expect(list).toMatch(/venueDetailReviewsError \?/);
    expect(list).toMatch(/role="alert"/);
    expect(list).toMatch(/No reviews yet\. Be the first!/);
    // The empty line sits behind BOTH the error branch and the not-yet-loaded
    // branch, which is the whole point of the ordering.
    expect(list.indexOf('venueDetailReviewsError ?')).toBeLessThan(list.indexOf('No reviews yet'));
    expect(list.indexOf('!venueDetailReviews ?')).toBeLessThan(list.indexOf('No reviews yet'));
  });

  test('the count is only printed once the reviews are known', () => {
    expect(APP).toMatch(/Flock Reviews\{venueDetailReviews \? ` \(\$\{venueDetailReviews\.length\}\)` : ''\}/);
  });

  test('the retry runs the same read the screen does', () => {
    expect(APP).toMatch(/onClick=\{\(\) => loadVenueDetailReviews\(venueDetailPlaceId\)\}/);
  });
});

describe('the venue votes in a direct message', () => {
  test('a failed read is recorded and the stale conversation is cleared', () => {
    const load = region(APP, 'const loadDmVenueVotes = useCallback', '}, []);');
    expect(load).toMatch(/setDmVenueVotes\(\[\]\)/);
    expect(load).toMatch(/setDmVenueVotesError\(/);
    expect(load).not.toMatch(/\.catch\(\(\) => \{\}\)/);
  });

  test('"No votes yet" is not said about a chat nobody could read', () => {
    expect(APP).toMatch(/\{dmVenueVotesError && \(/);
    expect(APP).toMatch(/\) : !dmVenueVotesError && \(/);
    expect(APP).toMatch(/onClick=\{\(\) => loadDmVenueVotes\(selectedDmId\)\}/);
  });

  test('the tally of other people is only printed when it was measured', () => {
    expect(APP).toMatch(/\{!dmVenueVotesError && \(/);
  });

  test('a live vote arriving clears the failure it answers', () => {
    const live = region(APP, 'const unsub = onDmNewVote(', 'return unsub;');
    expect(live).toMatch(/setDmVenueVotesError\(''\)/);
  });
});

describe('the events screen', () => {
  test('every read goes through one function with three answers', () => {
    const fetcher = region(APP, 'const fetchFeaturedEvents = useCallback', '}, [userInterests]);');
    expect(fetcher).toMatch(/setFeaturedEventsLoading\(true\)/);
    expect(fetcher).toMatch(/setFeaturedEventsError\(''\)/);
    expect(fetcher).toMatch(/setFeaturedEvents\(null\)/);
    expect(fetcher).toMatch(/setFeaturedEventsError\(err\?\.message/);
  });

  test('no call site fetches events around it any more', () => {
    // Four copies used to exist, three of them with their own private idea of
    // what a failure meant.
    // One call each, both of them inside fetchFeaturedEvents. The imports name
    // the functions without calling them, so they do not match.
    expect(APP.match(/getFeaturedEvents\(/g)).toHaveLength(1);
    expect(APP.match(/searchEvents\(/g)).toHaveLength(1);
  });

  test('"No events found nearby" waits for a read that landed', () => {
    expect(APP).toMatch(/\{!featuredEventsLoading && !featuredEventsError && featuredEvents && featuredEvents\.length === 0 && \(/);
    expect(APP).toMatch(/\{!featuredEventsLoading && featuredEventsError && \(/);
  });

  test('a failure keeps the retry on the screen it failed on', () => {
    expect(APP).toMatch(/fetchFeaturedEvents\(`\$\{userLocation\.lat\},\$\{userLocation\.lng\}`, eventsSearchQuery\)/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. The two silences that are correct
// ═══════════════════════════════════════════════════════════════════════════

describe('what was left silent, and why it is safe', () => {
  test('the promotions section makes no claim when it has nothing', () => {
    // Rendering only on a non-empty list is what lets its read stay quiet: a
    // hidden heading says nothing, and a heading that said "no deals" would be
    // the failure this whole suite is about.
    expect(APP).toMatch(/\{venueDetailPromos\.length > 0 && \(/);
    expect(APP).not.toMatch(/No deals/);
    expect(APP).not.toMatch(/No promotions/);
  });

  test('the Tonight control prints no sentence about the pulse it failed to read', () => {
    const pulse = region(APP, "{ key: 'down', fill: '#047857', label: 'Down' }", 'aria-pressed={active}');
    expect(pulse).toMatch(/const active = myPulse\?\.status === opt\.key;/);
    expect(APP).not.toMatch(/You have no status set/);
  });
});
