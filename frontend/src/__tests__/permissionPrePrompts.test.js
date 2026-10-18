/**
 * A MESSAGE SHOWN BEFORE A SYSTEM PERMISSION PROMPT GOES ON TO IT.
 *
 * App Store Guideline 5.1.1(iv): a custom message an app shows right before a
 * system permission alert must lead to that alert. Its button reads "Continue"
 * or "Next", never "Allow", "Enable" or "Turn on", and the message carries no
 * exit ("Not now", "Cancel", a close X): the person always reaches the system
 * prompt, which is where they say yes or no.
 *
 * Each place in the app that asks for a system permission, and how it is held:
 *   - the chat's notification row ("Know when they answer"): a message whose
 *     only purpose is the prompt, so Continue and no X;
 *   - Discover's location banner and Events' location gate: Continue;
 *   - the contacts disclosure before the address-book prompt: Continue, one
 *     button, leaving is the screen's ordinary back navigation;
 *   - the Push Notifications row in Settings: a feature control rather than a
 *     message, so it keeps a plain label, but not a permission word.
 * Controls that ask as a side effect of a feature the person reached for (the
 * map's recenter button, the camera, the photo picker, SOS) keep their labels.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npm test -- --watchAll=false --testPathPattern=permissionPrePrompts
 */

const fs = require('fs');
const path = require('path');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8').replace(/\r\n/g, '\n');
const chat = read('screens', 'ChatDetail.js');
const explore = read('screens', 'ExploreScreen.js');
const friends = read('screens', 'AddFriends.js');
const settings = read('screens', 'ProfileSettings.js');

const PERMISSION_WORDS = />\s*(Allow|Enable|Turn on)[^<]*<\/button>/;

describe('the chat\'s notification row', () => {
  const start = chat.indexOf('Know when they answer');
  const block = chat.slice(start, chat.indexOf('</div>\n        )}', start) + 20);

  test('asks with Continue and offers no way to close the row', () => {
    expect(start).toBeGreaterThan(-1);
    expect(block).toMatch(/requestNotificationPermission\(\)/);
    expect(block).toMatch(/>\s*Continue\s*<\/button>/);
    expect(block).not.toMatch(PERMISSION_WORDS);
    expect(block).not.toMatch(/aria-label="Not now"/);
    expect(block).not.toMatch(/Icons\.x\(/);
    expect((block.match(/<button/g) || []).length).toBe(1);
  });
});

describe('location', () => {
  test('Discover\'s banner says what Continue does, and reads Continue', () => {
    const start = explore.indexOf('Location services are off, so venues are not sorted by distance');
    expect(start).toBeGreaterThan(-1);
    const row = explore.slice(start, explore.indexOf('</div>', start));
    expect(row).toMatch(/Continue to use your location\./);
    expect(row).toMatch(/toggleLocation\(true\)/);
    expect(row).toMatch(/>Continue<\/button>/);
    expect(row).not.toMatch(PERMISSION_WORDS);
    expect((row.match(/<button/g) || []).length).toBe(1);
  });

  test('the Events gate reads Continue, and Try again only after a failure', () => {
    expect(explore).toMatch(/'Flock uses your location to show what is on near you\.'/);
    expect(explore).toMatch(/\{locationLoading \? 'Finding where you are' : locationError \? 'Try again' : 'Continue'\}<\/button>/);
    expect(explore).not.toMatch(/'Turn on location'\}<\/button>|>Turn on location</);
  });

  test('no button anywhere on the Discover screen uses a permission word', () => {
    expect(explore).not.toMatch(PERMISSION_WORDS);
  });
});

describe('contacts', () => {
  test('the disclosure keeps its explanation, and its one button reads Continue', () => {
    const start = friends.indexOf('Find friends from your contacts');
    const card = friends.slice(start, friends.indexOf('STATE 3', start));
    expect(card).toMatch(/Flock sends only phone numbers/);
    expect(card).toMatch(/handleSyncContacts\(\)/);
    expect(card).toMatch(/>\s*Continue\s*<\/button>/);
    expect((card.match(/<button/g) || []).length).toBe(1);
    expect(card).not.toMatch(/Not now|Cancel/);
  });
});

describe('the Settings row', () => {
  test('keeps a plain label that is not a permission word', () => {
    const start = settings.indexOf('Push Notifications</span>');
    const row = settings.slice(start, settings.indexOf('{notifStatus === \'unsupported\'', start));
    expect(row).toMatch(/requestNotificationPermission\(\)/);
    expect(row).toMatch(/>Set up<\/button>/);
    expect(row).not.toMatch(PERMISSION_WORDS);
  });
});
