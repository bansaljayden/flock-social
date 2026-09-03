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
// The safety screen and its trusted-contacts list left App.js on 2026-08-27
// with the profile and settings screen (the You tab), now
// screens/ProfileSettings.js. Its handlers (loadTrustedContacts, handleSaveContact
// and the rest) stayed in App.js, so that file is concatenated for the call-site
// checks the same way DmDetail is.
const APP_SRC = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8')
  + fs.readFileSync(path.join(__dirname, '..', 'screens', 'DmDetail.js'), 'utf8')
  + fs.readFileSync(path.join(__dirname, '..', 'screens', 'ProfileSettings.js'), 'utf8')
  // The venue card posted into the chat by a brand new flock is written by the
  // create screen, which left App.js for screens/CreateScreen.js on 2026-09-01;
  // its source is appended so the pending / failed contract on that card is
  // still read at the call site that writes it.
  + fs.readFileSync(path.join(__dirname, '..', 'screens', 'CreateScreen.js'), 'utf8');

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
// 1b. The same vote, in a direct message
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Incident 1 was fixed in the flock and never in the DM, and the comment above
 * the DM panel is the reason it stayed hidden: it reads "Vote panel, identical
 * to flock with optimistic local updates", which stopped being true the day the
 * flock panel got its rollback.
 *
 * The DM does not vote over REST. It votes through dmVoteVenue, which was a
 * guarded emit returning nothing:
 *
 *   export function dmVoteVenue(receiverId, venueName, venueId) {
 *     if (socket?.connected) socket.emit('dm_vote_venue', { ... });
 *   }
 *
 * Over a dead socket that sent nothing and said nothing. All three vote buttons
 * on the screen (the panel's nearby list, the panel's un-vote, and Vote on a
 * venue card in the thread) rewrote the tally first and called it afterwards,
 * so the tile flipped, the count went up, the voter's own name landed in the
 * list, and the server had no vote. loadDmVenueVotes wiped it at the next open
 * with no explanation: "the tile quietly reverted on the next load", verbatim.
 *
 * A tunnel, a locked phone, or the second after a resume before the socket is
 * back are all ordinary, so this is not an edge case. The emit now answers, and
 * every one of the three buttons reconciles against the answer.
 */
describe('a DM venue vote that never left the device', () => {
  const SOCKET = codeOnly(fs.readFileSync(path.join(__dirname, '..', 'services', 'socket.js'), 'utf8'));
  const dmVotes = () => region(APP, 'const commitDmVote = ', 'const readConnection');

  test('the emit answers whether it emitted, like every other send in socket.js', () => {
    const fn = region(SOCKET, 'export function dmVoteVenue', 'export function onDmNewVote');
    expect(fn).toMatch(/if \(!socket\?\.connected\) return false;/);
    expect(fn).toMatch(/return true;/);
  });

  test('a vote that did not go out puts the tally back', () => {
    expect(dmVotes()).toMatch(/setDmVenueVotes\(previousVotes\);/);
  });

  test('and says so, naming the action, as an error toast', () => {
    const fn = dmVotes();
    expect(fn).toMatch(/showToast\(.*'error'\)/);
    expect(fn).toMatch(/You're not connected right now\./);
    expect(APP).toMatch(/Your vote didn't save\./);
    expect(APP).toMatch(/Clearing your vote didn't save\./);
  });

  test('all three vote buttons go through the one reconciled path', () => {
    // The third is the Vote button on a venue card in the thread, which is a
    // long way from the panel and was written separately. A fourth added later
    // that calls the raw emit would put the defect straight back, so the raw
    // emit has exactly one caller on this screen.
    expect(APP).toMatch(/const commitDmVote = \(venueName, venueId, previousVotes, lead\) => \{/);
    const commits = APP.match(/commitDmVote\(/g) || [];
    expect(commits.length).toBe(3);
    // And the raw emit is called from exactly one place, inside commitDmVote.
    const raw = APP.match(/dmVoteVenue\(selectedDmId,/g) || [];
    expect(raw.length).toBe(1);
  });

  test('each caller captures the tally before its optimistic write', () => {
    // Captured by the caller, not by commitDmVote, for the same reason
    // updateFlockVotes captures its own: by the time the emit is attempted the
    // optimistic rewrite has already happened.
    const captures = APP.match(/const previousVotes = dmVenueVotes;/g) || [];
    expect(captures.length).toBe(3);
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
// 2b. A calendar event removed
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The same defect as 2, pointed the other way, and it outlived the fix for 2 by
 * three weeks because it was written inline in JSX and no region ever read it.
 *
 * The X on a calendar row was:
 *
 *   onClick={() => { setCalendarEvents(calendarEvents.filter(...));
 *                    if (typeof event.id === 'number')
 *                      deleteCalendarEvent(event.id).catch(() => {}); }}
 *
 * A refused DELETE took the row off the calendar anyway. The event looked
 * deleted, the user stopped planning around it, and the server still had it, so
 * it was back on the calendar at the next launch. Both halves of the calendar
 * now go through one delete, and a refusal puts the row back and says so.
 */
describe('a calendar event that did not delete', () => {
  const del = () => region(APP, 'const deleteSavedCalendarEvent = useCallback', 'const addEventToCalendar = useCallback');
  const remove = () => region(APP, 'const removeCalendarEvent = useCallback', 'const addMessageToFlock');

  test('the row goes back on the calendar when the delete is refused', () => {
    expect(del()).toMatch(/setCalendarEvents\(prev => \(prev\.some\(e => e\.id === row\.id\) \? prev : \[\.\.\.prev, row\]\)\)/);
  });

  test('and the user is told, in words naming the calendar', () => {
    const fn = del();
    expect(fn).toMatch(/That didn't get removed from your calendar\./);
    expect(fn).toMatch(/showToast\(.*'error'\)/);
    // A dead session has already announced itself through api.js's own toast.
    expect(fn).toMatch(/err\?\.sessionExpired/);
  });

  test('the button no longer carries its own write', () => {
    // The whole reason this one hid: the call site was a JSX attribute, so
    // every region in this file stepped over it. It is a named handler now.
    expect(APP).toMatch(/onClick=\{\(\) => removeCalendarEvent\(event\)\}/);
    expect(APP).not.toMatch(/deleteCalendarEvent\(event\.id\)\.catch\(\(\) => \{\}\)/);
  });

  test('nothing on either path swallows the failure', () => {
    expect(del()).not.toMatch(/\.catch\(\(\) => \{\}\)/);
    expect(remove()).not.toMatch(/\.catch\(\(\) => \{\}\)/);
  });

  test('a row removed while its create was in flight is deleted once the id exists', () => {
    // The X is tappable during the create round trip, and in that window there
    // is no server id to delete. Filtering the row and stopping there left the
    // event on the server: gone from the screen, back at the next launch, which
    // is the same lie by a different route.
    expect(remove()).toMatch(/removedTempCalendarIdsRef\.current\.add\(event\.id\)/);
    const cal = region(APP, 'const addEventToCalendar = useCallback', 'const removeCalendarEvent = useCallback');
    expect(cal).toMatch(/if \(removedTempCalendarIdsRef\.current\.delete\(tempId\)\) \{/);
    expect(cal).toMatch(/deleteSavedCalendarEvent\(saved\)/);
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
// 4b. The avatar the server never got
// ═══════════════════════════════════════════════════════════════════════════

/**
 * One sheet, two buttons, two different ideas of the truth.
 *
 * The Profile Photo sheet offers "Choose from Library" and "Generate AI
 * Avatar". confirmCrop, the first one, has had the honest contract for weeks:
 * the success toast comes after the await and a refusal gets "That photo
 * didn't upload. Try again."
 *
 * generateAIAvatar, sixty lines below it in the same feature, did this:
 *
 *   setProfilePic(url);
 *   setShowPicModal(false);
 *   try { await saveProfileImageUrl(url); }
 *   catch (err) { console.error('Avatar save failed:', err); }
 *
 * Optimistic write, no rollback, sheet already closed so the failure had
 * nowhere to be drawn, and the only record of it in the console. The new
 * picture then sat in the header, on the profile and on the user's own chat
 * bubbles for the rest of the session while the server still held the old one,
 * and it reverted at the next cold launch with nothing having said a word. The
 * user reads that as the app losing their avatar.
 */
describe('an avatar that did not save', () => {
  const avatar = () => region(APP, 'const generateAIAvatar = useCallback', 'const Toggle = ');

  test('the picture on screen goes back to the one the server has', () => {
    const fn = avatar();
    const captured = fn.indexOf('const previousPic = profilePic;');
    const optimistic = fn.indexOf('setProfilePic(url);');
    expect(captured).toBeGreaterThan(-1);
    expect(optimistic).toBeGreaterThan(captured);
    expect(fn).toMatch(/setProfilePic\(previousPic\);/);
  });

  test('and the user is told, in the same shape as the button beside it', () => {
    const fn = avatar();
    expect(fn).toMatch(/That avatar didn't save\. Try again\./);
    expect(fn).toMatch(/showToast\(.*'error'\)/);
    // A dead session has already announced itself through api.js's own toast.
    expect(fn).toMatch(/err\?\.sessionExpired/);
  });

  test('success is claimed only after the write came back', () => {
    const fn = avatar();
    const awaited = fn.indexOf('await saveProfileImageUrl(url);');
    const claimed = fn.indexOf("showToast('Profile picture updated!', 'success')");
    expect(awaited).toBeGreaterThan(-1);
    expect(claimed).toBeGreaterThan(awaited);
  });

  test('the console is no longer the only place the failure lands', () => {
    // console.error stays. It is the stack trace, not the user-facing answer,
    // and the photo-upload branch keeps its own for the same reason.
    const fn = avatar();
    expect(fn).toMatch(/console\.error\('Avatar save failed:', err\);/);
    expect(fn.slice(fn.indexOf('catch (err)'))).toMatch(/showToast/);
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

  test('an emergency send is only refused on a zero that was actually measured', () => {
    // The 2026-08-27 safety audit moved this a step further than the pin it
    // replaces: the old code answered an UNKNOWN list (read failed) with a
    // toast and no request, so a failed GET stood between a person in trouble
    // and a POST the server might have accepted. Now only a MEASURED zero is
    // refused locally; an unknown list attempts the alert and lets the server,
    // the authority on the list, answer (its zero-contact refusal names 911).
    const alert = region(APP, 'const handleEmergencyAlert = useCallback', 'cancelSosLocationFollowUp();');
    expect(alert).toMatch(/trustedContacts\.length === 0 && trustedContactsLoaded/);
    expect(alert).toMatch(/Add trusted contacts in Safety settings first/);
    expect(alert).not.toMatch(/return;\s*\}\s*\}/);
  });

  test('opening the emergency sheet re-reads a list that never loaded, boundedly', () => {
    // Still re-reads on open, but the retry is capped per open: fully offline
    // the old effect refired at microtask speed for as long as the sheet was
    // up. Three tries with a widening gap, then the sheet's contactsUnknown
    // state carries it (the buttons stay live either way).
    expect(APP).toMatch(/sosContactRetryRef\.current >= 3/);
    expect(APP).toMatch(/setTimeout\(\(\) => loadTrustedContacts\(\), attempt === 0 \? 0 : 2000 \* attempt\)/);
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
