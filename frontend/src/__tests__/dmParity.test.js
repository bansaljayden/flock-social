// The DM side of what the flock side already did. Source contracts.
const fs = require('fs');
const path = require('path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

test('guarded DM emits answer whether they happened', () => {
  const s = read('services/socket.js');
  expect(s).toMatch(/export function dmReact\(dmId, emoji, receiverId\) \{\s*if \(!socket\?\.connected\) return false;/);
  expect(s).toMatch(/export function dmRemoveReact\(dmId, emoji, receiverId\) \{\s*if \(!socket\?\.connected\) return false;/);
  expect(s).toMatch(/export function dmPinVenue\(receiverId, venueData\) \{\s*if \(!socket\?\.connected\) return false;/);
});

test('a DM reaction over a dead socket falls back to REST instead of vanishing', () => {
  const d = read('screens/DmDetail.js');
  expect(d).toMatch(/addDmReaction, removeDmReaction \} from '\.\.\/services\/api'/);
  expect(d).toMatch(/if \(!dmRemoveReact\(m\.id, g\.emoji, otherUser\)\) removeDmReaction\(m\.id, g\.emoji\)/);
  expect(d).toMatch(/else if \(!dmReact\(m\.id, g\.emoji, otherUser\)\) \{ addDmReaction\(m\.id, g\.emoji\)/);
  expect(d).toMatch(/if \(!dmReact\(m\.id, emoji, selectedDmId\)\) addDmReaction\(m\.id, emoji\)/);
});

test('a DM venue pin persists over REST AND puts the old pin back when it fails', () => {
  /* THIS TEST USED TO PIN THE SHAPE AND HAS BEEN REPOINTED AT THE PROPERTY.
     It asserted that the literal `if (!dmPinVenue(selectedDmId, v)) pinDmVenue(...)`
     appeared exactly twice, which locked both call sites into an inline
     fire-and-forget whose .catch only toasted. That inline version had a real
     defect the assertion could not see: it wrote `setDmPinnedVenue(v)`
     optimistically and NEVER ROLLED BACK, so a refused pin left the strip
     advertising a venue the server had never stored until a reload. Counting
     the occurrences of a broken line twice does not make it correct.

     The behaviour that matters is three things, so those are what is checked:
     the socket is tried first, REST is the fallback when it could not emit,
     and a failure restores the previous pin. That is the same contract
     unpinDmVenueNow already honours, which is why both now go through a
     named helper instead of a copied expression. This is the THIRD time in
     this file's history that a shape assertion outlived the behaviour it was
     standing in for; prefer the property. */
  const a = read('App.js');

  // One helper, used by both call sites, rather than the expression twice.
  expect(a).toMatch(/const pinDmVenueNow = useCallback\(async \(userId, venue\) => \{/);
  expect((a.match(/pinDmVenueNow\(selectedDmId, v\);/g) || []).length).toBe(2);
  expect(a).not.toMatch(/if \(!dmPinVenue\(selectedDmId, v\)\) pinDmVenue/);

  // Socket first, REST only when the emit could not happen.
  const body = a.slice(a.indexOf('const pinDmVenueNow'));
  const fn = body.slice(0, body.indexOf('const retryFailedMessage'));
  expect(fn).toMatch(/if \(dmPinVenue\(userId, venue\)\) return;/);
  expect(fn).toMatch(/await pinDmVenue\(userId, venue\);/);

  // And the rollback, which is the half the old assertion could not express.
  expect(fn).toMatch(/const previous = dmPinnedVenue;/);
  expect(fn).toMatch(/setDmPinnedVenue\(previous\);/);

  const api = read('services/api.js');
  expect(api).toMatch(/export async function pinDmVenue\(userId, v\) \{[\s\S]*?method: 'PUT'/);
});

test('a refused socket write is no longer thrown away', () => {
  /* The global socket-error listener early-returned unless a MESSAGE was in
     flight, so every non-message socket write had its server refusal
     discarded: dm_pin_venue, dm_vote_venue, dm_share_location,
     dm_stop_sharing_location. Those emitters return true on emit and never
     hear back, so that discard was the only place the error could surface. */
  const a = read('App.js');
  expect(a).not.toMatch(/if \(pendingEchoRef\.current\.size === 0 && dmEchoRef\.current\.size === 0\) return;/);
  // The DM "not connected" case still takes the standing-explanation path
  // rather than a toast, and still only when a DM send is in flight to
  // attribute it to.
  expect(a).toMatch(/NOT_CONNECTED_HINT\.test\(message\) && dmEchoRef\.current\.size > 0/);
});

test('DM search says when nothing matches, and an empty query keeps scrollback', () => {
  const d = read('screens/DmDetail.js');
  expect(d).toMatch(/No messages match "\{dmChatSearch\}"/);
  expect(d).toMatch(/!\(showDmChatSearch && dmChatSearch\.trim\(\)\) && !dmAtTop\[selectedDmId\]/);
});

test('the person you are talking to is drawn in a colour, not the secondary grey', () => {
  /* MessageList's colourOf falls through to --chat-name-fallback, which is
     --text-secondary, so a screen that passes neither `colours` nor `colourFor`
     draws every run that is not yours in the same grey as every other secondary
     word on the page. Both chat screens did exactly that: in a six person flock
     all five other people were identical, and in a DM the friend was grey.

     TWO THINGS ARE PINNED HERE, and the second is the one that bit me. colourOf
     consults `colourFor` FIRST and returns whatever it says, so a colourFor
     that answers only for the other person hands back undefined for your own
     runs and takes your own colour away instead of deferring to ownColour. It
     has to answer for both sides. */
  const d = read('screens/DmDetail.js');
  expect(d).toMatch(/colourFor=\{\(run\) => \(run\.isMine \? DM_OWN_COLOUR : DM_FRIEND_COLOUR\)\}/);
  expect(d).toMatch(/const DM_OWN_COLOUR = /);
  expect(d).toMatch(/DM_FRIEND_COLOUR \} from '\.\.\/components\/chat'/);

  /* THE PALETTE IS WRITTEN DOWN IN CODE, and in the one place where it can be
     theme aware. It lived only in the plan document for a fortnight, which is
     why no screen could pass it. The hexes are in chat.css because the run
     colour is drawn as TEXT, the sender's name at 11.5px, and the values
     measured off the reference capture read between 1.50:1 and 2.32:1 on this
     app's light ground. Six of seven failed even the 3:1 floor, and the DM
     friend's label was made WORSE than the grey it replaced: 5.3:1 down to
     2.07:1. So each hue has a light value and a dark one. */
  const css = read('components/chat/chat.css');
  const palette = read('components/chat/runColours.js');
  ['1', '2', '3', '4', '5', '6', 'friend'].forEach((slot) => {
    // Defined twice: once on :root and once under the dark theme.
    expect((css.match(new RegExp(`--chat-run-${slot}:`, 'g')) || []).length).toBe(2);
    // And reached only through the token, never as a literal in the module.
    expect(palette).toContain(`var(--chat-run-${slot})`);
  });
  // No hex survives in the CODE. Comments may name one (the light ground is
  // #f1ede0 and the reasoning has to be able to say so), so the check reads
  // what actually runs.
  const paletteCode = palette.replace(/^\s*(\/\*[\s\S]*?\*\/|\/\/.*|\*.*)$/gm, '');
  expect(paletteCode).not.toMatch(/#[0-9A-Fa-f]{6}/);

  /* STABLE PER PERSON, AND STABLE BY ID. Pinned at a multi-digit id on
     purpose. For a single digit the character sum and a plain `id % 6` agree
     (55 % 6 and 7 % 6 are both 1), so anything asserted about id 7 would pass
     just as happily for the positional index the module forbids, and asserting
     that a pure function returns the same thing twice pins nothing at all.
     This is what an id-keyed mapping does that a position-keyed one cannot. */
  const { runColourFor, RUN_COLOURS } = require('../components/chat/runColours');
  expect(runColourFor(7)).toBe(runColourFor('7'));
  expect(runColourFor(12)).toBe(RUN_COLOURS[(49 + 50) % 6]);
  expect(runColourFor(12)).not.toBe(runColourFor(7));
  // The day an id stops being a small integer, which the docblock promises.
  expect(RUN_COLOURS).toContain(runColourFor('u_9f3a'));
  expect(runColourFor(null)).toBeNull();
});
