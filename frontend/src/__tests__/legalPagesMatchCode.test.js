// ---------------------------------------------------------------------------
// The legal pages must describe the product that actually exists.
//
// These are not grep-for-a-phrase tests. Each one reads the file that DECIDES
// the behaviour and fails when the page and that file disagree, so the failure
// arrives on the commit that changes the behaviour rather than on the day
// somebody reads the policy and notices it is wrong.
//
// If one of these fails, the fix is almost always to change the page. The
// exception is a test that fails because a feature genuinely shipped (a story
// UI, Apple revocation going live), and each of those says so in its own
// message.
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..', '..');
const read = (...p) => fs.readFileSync(path.join(REPO, ...p), 'utf8');

// The flock chat screen left App.js on 2026-08-26 and the one-to-one DM thread
// left on 2026-08-27: they live in screens/ChatDetail.js and screens/DmDetail.js
// now, and the report entry points (the dm and profile report surfaces among
// them) went with them. Nothing asserted below changed. The app source is
// simply in three files, so all three are read, in the order they used to be
// one.
// The profile and settings screen (the You tab) left App.js on 2026-08-27 for
// screens/ProfileSettings.js, and the "Get a copy of my data" export control the
// privacy policy points at went with it, so that file is read here too.
// The flock plan detail screen left App.js on 2026-09-01 for
// screens/FlockDetail.js, and the guest RSVP report entry point went with
// it, so that file is read here too.
const APP_SOURCE = read('frontend', 'src', 'App.js')
  + read('frontend', 'src', 'screens', 'ChatDetail.js')
  + read('frontend', 'src', 'screens', 'DmDetail.js')
  + read('frontend', 'src', 'screens', 'ProfileSettings.js')
  + read('frontend', 'src', 'screens', 'FlockDetail.js');
const exists = (...p) => fs.existsSync(path.join(REPO, ...p));

const privacy = read('frontend', 'src', 'website', 'PrivacyPolicy.js');
const deletePage = read('frontend', 'src', 'website', 'DeleteAccount.js');
const guidelines = read('frontend', 'src', 'website', 'CommunityGuidelines.js');
const terms = read('frontend', 'src', 'website', 'TermsOfService.js');

const PAGES = {
  'PrivacyPolicy.js': privacy,
  'DeleteAccount.js': deletePage,
  'CommunityGuidelines.js': guidelines,
  'TermsOfService.js': terms,
};

describe('venue occupancy sensors are disclosed for as long as the sensor exists', () => {
  test('a live sensor ingest route requires a sensor section in the privacy policy', () => {
    // The condition is the route being mounted, not the file merely sitting on
    // disk: an unmounted route collects nothing.
    if (!exists('backend', 'routes', 'sensors.js')) return;
    const server = read('backend', 'server.js');
    expect(server).toMatch(/app\.use\('\/api\/sensors'/);

    expect(privacy).toMatch(/id="venue-sensors"/);
    expect(privacy).toMatch(/Venue occupancy sensors/);
  });

  test('the policy names every field the sensor route actually stores', () => {
    const sensors = read('backend', 'routes', 'sensors.js');
    // The INSERT is the authority on what is kept.
    const insert = sensors.match(/INSERT INTO venue_sensor_data\s*\(([^)]+)\)/);
    expect(insert).not.toBeNull();
    const columns = insert[1].split(',').map((c) => c.trim());

    // Each stored measurement has to be described in plain words on the page.
    const described = {
      ir_beam_count: /infrared beam/i,
      thermal_headcount: /heat clusters/i,
      noise_db: /loudness/i,
    };
    for (const column of columns) {
      if (!described[column]) continue; // venue id, device id, timestamp: not measurements
      expect(privacy).toMatch(described[column]);
    }
    // And every measurement the page knows about is one the route stores.
    for (const column of Object.keys(described)) {
      expect(columns).toContain(column);
    }
  });

  test('the push cadence and thermal grid in the copy come from the device code', () => {
    const main = read('flock-sensor', 'main.py');

    const interval = main.match(/_cfg_number\('PUSH_INTERVAL_SECONDS',\s*int,\s*\d+,\s*\d+,\s*(\d+)\)/);
    expect(interval).not.toBeNull();
    expect(privacy).toContain(`Every ${interval[1]} seconds`);

    // The sensor's own geometry constants, not a number typed twice. The
    // device moved from a 24x32 MLX90640 to a 160x120 FLIR Lepton, which is
    // twenty-five times as many readings, and the policy sentence that says
    // what the thermal part IS has to move with it or it describes a device
    // that no longer exists.
    const grid = main.match(/THERMAL_COLS,\s*THERMAL_ROWS\s*=\s*(\d+),\s*(\d+)/);
    expect(grid).not.toBeNull();
    const cols = Number(grid[1]);
    const rows = Number(grid[2]);
    expect(privacy).toContain(`${cols} by ${rows} grid`);
    expect(privacy).toContain(`${(cols * rows).toLocaleString('en-US')} temperature readings`);
  });

  test('the thermal stream is a raw temperature format, not a picture format', () => {
    // The policy calls the thermal part "a grid of temperatures, not a
    // picture". On a USB thermal camera that is a claim about the pixel
    // format the device asks V4L2 for: Y16 raw is 16 bits of temperature per
    // pixel, and the same camera's other node is 8-bit AGC greyscale, which
    // is an image. Pinned because the difference is invisible in a diff.
    const main = read('flock-sensor', 'main.py');
    expect(main).toMatch(/_V4L2_PIX_FMT_Y16\s*=\s*0x20363159/);
    expect(main).toMatch(/pixelformat\s*=\s*_V4L2_PIX_FMT_Y16/);
    expect(privacy).toMatch(/not a picture/);
  });

  test('the "cannot identify anyone" claim holds: no camera, audio, or radio capture on the device', () => {
    const main = read('flock-sensor', 'main.py');
    // Prose is stripped first: main.py's own header SAYS "no Bluetooth or wifi
    // probe", and a scan that counts the denial as evidence of the thing being
    // denied would fail on a correct file.
    const code = main
      .replace(/"""[\s\S]*?"""/g, '')
      .replace(/'''[\s\S]*?'''/g, '')
      .split('\n')
      .map((line) => line.replace(/(^|\s)#.*$/, ''))
      .join('\n');
    // Every way this device could start identifying people arrives as one of
    // these. While none of them is imported or shelled out to, the page is true.
    expect(code).not.toMatch(/^\s*(import|from)\s+(cv2|picamera\w*|PIL|imageio|pyaudio|sounddevice|bluetooth|bluepy|scapy)\b/m);
    expect(code).not.toMatch(/VideoCapture|VideoWriter|imwrite|imsave|fromarray|wave\.open|\.wav\b/i);
    expect(code).not.toMatch(/iwlist|iw dev|hcitool|bluetoothctl|airodump|tcpdump|arp -a/i);
    // A 24x32 frame was a few warm blobs. A 160x120 frame is a scene, so the
    // "never stored" half of the claim needs pinning too: nothing on the
    // device may write one anywhere.
    expect(code).not.toMatch(/\.tofile\(|pickle\.dump|np\.save/);
    expect(privacy).toMatch(/No phone detection/);
    expect(privacy).toMatch(/No audio recording/);
  });
});

describe('stories are not described as something a user can do', () => {
  const app = APP_SOURCE;

  test('there is still no story surface in the client', () => {
    // If this fails because a story UI shipped, the policy needs the feature
    // written back in (what is collected, how long it lives), not a test edit.
    expect(app).not.toMatch(/\bgetStories\b/);
    expect(app).not.toMatch(/\bcreateStory\b|\bpostStory\b|\bdeleteStory\b/);
  });

  test('while there is no surface, the policy says so instead of advertising stories', () => {
    expect(privacy).toMatch(/there is no way to post or see a story/i);
    // The old copy, which described a feature nobody can reach.
    expect(privacy).not.toMatch(/stories \(visible for 24 hours\)/i);
  });

  test('the retention wording matches the lifetime and grace window in routes/stories.js', () => {
    const stories = read('backend', 'routes', 'stories.js');

    const life = stories.match(/NOW\(\) \+ INTERVAL '(\d+) hours'/);
    expect(life).not.toBeNull();
    expect(privacy).toContain(`stops being visible to everyone ${life[1]} hours after it is posted`);

    // The purge grace default, and the cleanup interval it hangs off.
    const grace = stories.match(/if \(!Number\.isInteger\(raw\)\) return (\d+);/);
    expect(grace).not.toBeNull();
    expect(privacy).toContain(`expired more than ${grace[1]} hours ago`);
    expect(stories).toMatch(/PURGE_INTERVAL_MS = 60 \* 60 \* 1000/);
    expect(privacy).toMatch(/at most once an hour/);

    // Reported stories survive the purge and the author's own delete.
    expect(stories).toMatch(/content_type = 'story'[\s\S]{0,200}status IN \('open', 'under_review'\)/);
    expect(privacy).toMatch(/reported is held until the report is closed/i);
  });
});

describe('Sign in with Apple revocation is described as it currently behaves', () => {
  test('revocation is gated on env that is configured in production', () => {
    const appleAuth = read('backend', 'services', 'appleAuth.js');
    expect(appleAuth).toMatch(/function isConfigured\(\)\s*\{\s*return !!\(TEAM_ID && KEY_ID && PRIVATE_KEY\);/);
    // Deletion calls revoke only when that gate passes, and it passes in
    // production: APPLE_TEAM_ID, APPLE_KEY_ID and APPLE_PRIVATE_KEY were
    // confirmed set on the Railway service on 2026-08-16, which is what lets
    // the pages promise revocation in the test below.
    const users = read('backend', 'routes', 'users.js');
    expect(users).toMatch(/appleAuthConfigured\(\)/);
  });

  test('both pages promise revocation on deletion', () => {
    // Inverted 2026-08-18, in the change that recorded the APPLE_* variables
    // as set on the server. What would make these assertions wrong again is
    // APPLE_TEAM_ID, APPLE_KEY_ID or APPLE_PRIVATE_KEY being removed from the
    // server: isConfigured() goes false and revocation silently stops. If
    // that happens, withdraw the promise from both pages and flip these back
    // to asserting its absence. Apple 5.1.1(v) is checked by a human.
    expect(deletePage).toMatch(/we\s+also revoke Flock's Sign in with Apple access/i);
    expect(deletePage).not.toMatch(/built but\s+not switched on/i);
    expect(privacy).toMatch(/we use it to revoke Flock's access to your Apple ID/i);
    expect(privacy).not.toMatch(/we hold no Apple refresh token/i);
  });
});

describe('deletion copy matches the deletion path', () => {
  const users = read('backend', 'routes', 'users.js');

  test('re-authentication is required, and both pages say so', () => {
    expect(users).toMatch(/reauthRequired: 'password'/);
    expect(users).toMatch(/reauthRequired: 'reauth'/);
    expect(deletePage).toMatch(/you'll enter it to prove it's\s+you/);
    expect(privacy).toMatch(/confirm your password, or to sign in again/);
  });

  test('what survives deletion is exactly what the pages list', () => {
    // Evidence is de-attributed, not deleted.
    expect(users).toMatch(/UPDATE content_reports SET reporter_id = NULL/);
    expect(users).toMatch(/UPDATE moderation_actions SET target_user_id = NULL/);
    expect(deletePage).toMatch(/Reports and moderation records are kept/);

    // The ban tombstone, and its lifetime.
    expect(users).toMatch(/recordBannedIdentity/);
    expect(deletePage).toMatch(/12 months/);
    expect(privacy).toMatch(/12 months/);

    // The per-plan research row: written on flock close, keyed on a flock that
    // is SET NULL rather than cascaded, so it outlives the account.
    const flocks = read('backend', 'routes', 'flocks.js');
    expect(flocks).toMatch(/INSERT INTO research_analytics/);
    const baseline = read('backend', 'migrations', '001_baseline.sql');
    expect(baseline).toMatch(/research_analytics[\s\S]{0,120}flock_id INTEGER REFERENCES flocks\(id\) ON DELETE SET NULL/);
    expect(deletePage).toMatch(/one row per finished plan/i);
    expect(privacy).toMatch(/Plan statistics/);
  });

  test('created flocks cascade, so both pages warn that the whole plan goes', () => {
    const schema = read('backend', 'database', 'schema.sql');
    expect(schema).toMatch(/creator_id INTEGER REFERENCES users\(id\) ON DELETE CASCADE/);
    expect(deletePage).toMatch(/every flock you created/i);
    expect(terms).toMatch(/deletes every flock you created/i);

    // A DM row belongs to both people: either account being deleted takes the
    // thread with it, which is why both pages say so.
    expect(schema).toMatch(
      /CREATE TABLE IF NOT EXISTS direct_messages[\s\S]*?sender_id INTEGER REFERENCES users\(id\) ON DELETE CASCADE[\s\S]*?receiver_id INTEGER REFERENCES users\(id\) ON DELETE CASCADE/
    );
    expect(deletePage).toMatch(/removes that conversation from the other person's app/);
    expect(privacy).toMatch(/removes your direct message threads from the other person's app/);
  });

  test('the backup window quoted to users is the one in the written retention rule', () => {
    const backupDoc = read('BACKUP-AND-VERIFICATION.md');
    const rule = backupDoc.match(/Age out any backup at (\d+) days/);
    expect(rule).not.toBeNull();
    expect(privacy).toContain(`no backup is kept longer than ${rule[1]} days`);
    expect(deletePage).toContain(`no backup is kept longer than ${rule[1]} days`);
    // Nothing about the current backups is encrypted by default, so neither
    // page may call them encrypted.
    expect(deletePage).not.toMatch(/encrypted backups/i);
  });
});

describe('privacy claims that depend on how the code behaves', () => {
  test('live location is relayed and never written to the database', () => {
    const handlers = read('backend', 'sockets', 'handlers.js');
    const start = handlers.indexOf("socket.on('update_location'");
    expect(start).toBeGreaterThan(-1);
    const handler = handlers.slice(start, handlers.indexOf("socket.on('stop_sharing_location'"));
    expect(handler).not.toMatch(/INSERT INTO|UPDATE\s+\w+\s+SET/i);
    expect(privacy).toMatch(/never written to our database/);
  });

  test('SOS alerts go by email only, so no page implies a text message', () => {
    const safety = read('backend', 'routes', 'safety.js');
    expect(safety).not.toMatch(/twilio|sendSms|messagingServiceSid/i);
    // Case-insensitive on purpose. This pins that the route TELLS the user
    // alerts go by email, which is the property the privacy policy depends on.
    // It previously matched a lowercase literal and broke the day that sentence
    // was moved into a validation message and gained a capital A, which is a
    // spelling changing, not the behaviour.
    expect(safety).toMatch(/alerts are sent by email/i);
    expect(privacy).toMatch(/SOS alerts are sent by <strong>email only<\/strong>/);
  });

  test('the do-not-mail list does not swallow an SOS, and the policy says so', () => {
    // The defect this pins: HARD_REASONS blocked every category, so a trusted
    // contact whose address once hard-bounced, or who once marked a Flock
    // message as spam, got no emergency alert — while the policy said the
    // opposite in as many words. The code now carries an 'emergency' category
    // that no suppression reason stops, and the SOS route is its only caller.
    const suppression = read('backend', 'services', 'emailSuppression.js');
    const safety = read('backend', 'routes', 'safety.js');
    expect(suppression).toMatch(/const EMERGENCY_CATEGORY = 'emergency';/);
    expect(suppression).toMatch(/if \(category === EMERGENCY_CATEGORY\) return \{ blocked: false/);
    // Two callers, and the count is pinned rather than the floor, so a third
    // one cannot arrive without this argument being made about it. Both are in
    // routes/safety.js: the SOS fan-out, and the stand-down that mails an
    // all-clear to exactly the people the fan-out reached. The second one is
    // here because bypassing the list for the alarm is what creates the duty to
    // bypass it for the all-clear: an address that received "your child needs
    // help" and is then denied the retraction is left acting on an emergency
    // that has ended. emailSuppression.js carries that argument in writing,
    // which is the condition the first version of this test set.
    expect(safety.match(/category: EMERGENCY_CATEGORY/g)).toHaveLength(2);
    const suppressionSource = read('backend', 'services', 'emailSuppression.js');
    expect(suppressionSource).toMatch(/THE SECOND CALLER, and the argument for it/);
    expect(privacy).toMatch(/all-clear/);
    expect(privacy).toMatch(/an SOS alert\s+is sent even to an address that has hard-bounced/);

    // The other half of the trade: the user is now the only one who can notice
    // a broken contact address, so the API has to hand them that fact.
    expect(safety).toMatch(/email_deliverable/);
    const app = APP_SOURCE;
    expect(app).toMatch(/c\.email_deliverable === false/);
    expect(privacy).toMatch(/the Safety screen marks a trusted contact whose address has been failing/);
  });

  test('the suppression check fails open, and the policy admits it', () => {
    const suppression = read('backend', 'services', 'emailSuppression.js');
    expect(suppression).toMatch(/console\.error\('\[emailSuppression\] lookup failed, mailing anyway/);
    expect(privacy).toMatch(/if that check cannot reach our database it lets the\s+message go/);
    // The old sentence claimed nothing could walk past the list. Two things
    // can: a database error, and an emergency.
    expect(privacy).not.toMatch(/so nothing can walk past it/);
  });

  test('the digest opt-out flips a setting; only the waitlist link writes a suppression row', () => {
    const digest = read('backend', 'routes', 'venueDigest.js');
    const unsub = read('backend', 'routes', 'unsubscribe.js');
    expect(digest).toMatch(/notification_prefs/);
    expect(digest).not.toMatch(/require\(.*emailSuppression/);
    expect(unsub).toMatch(/suppress\(address, 'unsubscribe'/);
    expect(privacy).toMatch(/Unsubscribing from the waitlist writes your address to a do-not-mail list/);
    expect(privacy).toMatch(/switches off a setting on your venue account/);
  });

  test('invite links expire at the LATER of the two windows, which is what the policy now says', () => {
    const flocks = read('backend', 'routes', 'flocks.js');
    expect(flocks).toMatch(/GREATEST\(\s+NOW\(\) \+ INTERVAL '14 days',/);
    expect(privacy).toMatch(/whichever is <strong>later<\/strong>/);
    expect(privacy).not.toMatch(/a week after the plan, whichever comes first/);
  });

  test('contact sync does not store the numbers it checks', () => {
    const friends = read('backend', 'routes', 'friends.js');
    const start = friends.indexOf("router.post('/find-by-phone'");
    expect(start).toBeGreaterThan(-1);
    const handler = friends.slice(start, start + 3500);
    expect(handler).not.toMatch(/INSERT INTO/i);
    expect(privacy).toMatch(/We run the lookup and don't store those numbers/);
  });

  test('there is no stored friend code, matching what the policy says', () => {
    const migrations = fs
      .readdirSync(path.join(REPO, 'backend', 'migrations'))
      .filter((f) => f.endsWith('.sql'))
      .map((f) => read('backend', 'migrations', f))
      .join('\n');
    expect(migrations).not.toMatch(/friend_code/);
    expect(privacy).toMatch(/worked out from your account number/);
  });

  test('PostHog autocapture is off, which is what the policy tells people', () => {
    const index = read('frontend', 'src', 'index.js');
    expect(index).toMatch(/autocapture:\s*false/);
    expect(privacy).toMatch(/Automatic capture of clicks and typing is switched off/);
  });

  test('Birdie sends a first name, an age bracket and a rounded location, and the policy says exactly that', () => {
    const ai = read('backend', 'routes', 'ai.js');
    expect(ai).toMatch(/\.split\(' '\)\[0\]/);              // first name only
    expect(ai).toMatch(/age < 18 \? 'minor' : age < 21 \? 'under21' : 'adult'/);
    expect(ai).toMatch(/toFixed\(2\)/);                      // ~1km rounding
    expect(privacy).toMatch(/your first name, your age bracket/);
    expect(privacy).toMatch(/rounded to about a kilometer/);
    // Rosters and message bodies are deliberately not in the payload.
    expect(ai).toMatch(/member COUNT instead of/);
    expect(privacy).toMatch(/we don't send your email, exact coordinates, or messages/);
  });

  test('blocking removes the friendship, which the guidelines now state', () => {
    const moderation = read('backend', 'routes', 'moderation.js');
    expect(moderation).toMatch(/DELETE FROM friendships/);
    expect(guidelines).toMatch(/ends the friendship/);
  });

  test('the routes the pages tell people to walk actually exist in the app', () => {
    const app = APP_SOURCE;
    // Blocked accounts and Delete account both hang off the Profile screen.
    // There is no Settings screen between them, so no page may say there is.
    expect(app).toMatch(/\{ l: 'Blocked accounts', s: 'blocked'/);
    expect(guidelines).toMatch(/<strong>Profile<\/strong> &rarr; <strong>Blocked accounts<\/strong>/);
    expect(guidelines).not.toMatch(/Settings<\/strong> &rarr; <strong>Blocked/);
    expect(app).toMatch(/Delete account \(Apple Guideline 5\.1\.1\(v\)\)/);
    expect(privacy).toMatch(/Profile &rarr; Delete account/);
    expect(deletePage).toMatch(/<strong>Profile<\/strong> &rarr; <strong>Delete account<\/strong>/);

    // Every reporting surface the guidelines promise has a report entry point.
    for (const type of ['flock_message', 'dm', 'profile', 'venue_review', 'guest_rsvp']) {
      expect(app).toContain(`contentType: '${type}'`);
    }
  });

  test('push notifications can only be turned off on the device, and the policy says that', () => {
    const app = APP_SOURCE;
    const firebase = read('frontend', 'src', 'services', 'firebase.js');
    // The settings row offers Enable and a status. There is no in-app off
    // switch, so the page must not claim one.
    expect(app).toMatch(/Push Notifications/);
    expect(privacy).toMatch(/turn notifications off for Flock in your device settings/);
    expect(privacy).not.toMatch(/turn off in your device settings or inside Flock/);
    // Signing out really does drop the token.
    expect(firebase).toMatch(/unregisterDeviceToken|unregisterAllTokens/);
    expect(app).toMatch(/unregisterPushToken\(\)/);
  });

  test('the calendar and availability features the policy now discloses are really wired', () => {
    const app = APP_SOURCE;
    expect(app).toMatch(/getCalendarEvents\(/);
    expect(app).toMatch(/setAvailability\(/);
    expect(privacy).toMatch(/Your calendar entries/);
    expect(privacy).toMatch(/Availability status/);

    // The waitlist form on the marketing site stores an email address.
    const landing = read('frontend', 'src', 'website', 'LandingPage.js');
    expect(landing).toMatch(/api\/waitlist/);
    expect(privacy).toMatch(/Waitlist email/);
  });

  test('image screening is fail-closed, which is what the guidelines claim', () => {
    const mod = read('backend', 'utils', 'moderation.js');
    expect(mod).toMatch(/IMAGE_MODERATION_REQUIRED[\s\S]{0,200}allowed: false/);
    expect(guidelines).toMatch(/if it cannot run at all, the content does not post/);
  });
});

// ---------------------------------------------------------------------------
// CONTACT DISCOVERY. The page used to say that adding a phone number was what
// let friends who already had it find you. That was true of the old lookup,
// which matched the last ten digits of every stored number and asked nobody,
// and it is not true of this one. What follows pins the promises the new
// wording makes, each against the file that decides the behaviour, so that a
// change to backend/utils/phone.js or to the gate in backend/routes/friends.js
// fails here instead of quietly turning the policy into a false statement.
// ---------------------------------------------------------------------------
describe('contact discovery is opt-in, keyed, and erasable', () => {
  const friends = read('backend', 'routes', 'friends.js');
  const phone = read('backend', 'utils', 'phone.js');
  const users = read('backend', 'routes', 'users.js');
  const discoveryMigration = read('backend', 'migrations', '051_phone_discovery_optin.sql');

  // The endpoint's own body, bounded by the route that follows it, so an
  // assertion about what this handler does cannot be satisfied by a line
  // somewhere else in the file.
  function findByPhoneHandler() {
    const start = friends.indexOf("router.post('/find-by-phone'");
    if (start < 0) throw new Error('POST /api/friends/find-by-phone is gone from routes/friends.js');
    const end = friends.indexOf("router.get('/status/:userId'", start);
    if (end < 0) throw new Error('cannot find the end of the find-by-phone handler');
    return friends.slice(start, end);
  }

  test('the lookup is gated on a consent column that defaults to off', () => {
    // FALSE is what makes "off until you turn it on" true for every account
    // that already existed when the feature shipped. A default of TRUE, or the
    // column being dropped, makes the page a lie about consent.
    expect(discoveryMigration).toMatch(
      /ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_discoverable BOOLEAN NOT NULL DEFAULT FALSE;/
    );
    // And the gate is inside the query the endpoint runs, not in a caller that
    // a later refactor can route around.
    expect(findByPhoneHandler()).toMatch(
      /WHERE phone_hash = ANY\(\$2::text\[\]\)\s*AND phone_discoverable\b/
    );
    expect(privacy).toMatch(/which is off until you turn it on/);
    // The sentence the old behaviour justified and this one does not.
    expect(privacy).not.toMatch(/so friends who already have your number can find you/);
  });

  test('matching is a keyed digest, with no unkeyed fallback', () => {
    // "One-way keyed code" is a claim about the key. A phone number holds
    // roughly 30 bits, so a bare digest of one is reversible by anybody with a
    // laptop and would make the word "one-way" false.
    expect(phone).toMatch(/crypto\.createHmac\('sha256', key\)/);
    expect(phone).not.toMatch(/createHash\(/);
    // No key configured means no digest, so discovery stops instead of
    // degrading to something reversible.
    expect(phone).toMatch(/function discoveryDigest\(e164\) \{[\s\S]{0,200}if \(!key[\s\S]{0,120}return null;/);
    expect(privacy).toMatch(/one-way keyed code/);
  });

  test('nothing about an uploaded number is written, so a non-user leaves nothing behind', () => {
    const handler = findByPhoneHandler();
    expect(handler).not.toMatch(/INSERT INTO|UPDATE\s+\w+\s+SET/i);
    // Digests are what reach the query. The numbers themselves exist on the
    // request and are gone with it.
    expect(handler).toMatch(/discoveryDigest\(n\)/);
    expect(privacy).toMatch(/a number belonging to someone who is not on Flock leaves nothing behind/);
  });

  test('turning discovery off erases the stored code, and deleting the account takes it too', () => {
    expect(users).toMatch(/SET phone_discoverable = FALSE, phone_hash = NULL/);
    expect(users).toMatch(/SET phone_discoverable = TRUE, phone_hash = \$2/);
    // The digest is a column on the account row, which is why deleting the
    // account removes it without anything extra having to run.
    expect(discoveryMigration).toMatch(/ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_hash TEXT;/);
    expect(privacy).toMatch(/turning discovery off erases the code we match against/);
    expect(privacy).toMatch(/deleted the moment you switch discovery off or delete your account/);
  });

  test('only phone numbers leave the device, which is what the page promises', () => {
    const contacts = read('frontend', 'src', 'services', 'contacts.js');
    // The projection is the request. Asking for phones and nothing else means
    // a name cannot arrive by accident and then be described away in prose.
    expect(contacts).toMatch(/projection:\s*\{\s*phones:\s*true\s*\}/);
    expect(contacts).toMatch(/navigator\.contacts\.select\(\['tel'\]/);
    expect(contacts).not.toMatch(/projection:\s*\{[^}]*\b(name|emails|image|postalAddresses)\b/);
    expect(privacy).toMatch(/only phone numbers are sent, never names or anything else on a contact card/);
  });

  test('every phone digest the database holds is disclosed, not just the ban tombstone', () => {
    // Derived from the migrations rather than restated: whichever tables carry
    // a one-way code of a phone number, the policy owes the reader a line
    // about each. A third one appearing fails here until it is written up.
    const tables = new Set();
    const files = fs
      .readdirSync(path.join(REPO, 'backend', 'migrations'))
      .filter((f) => f.endsWith('.sql'));
    for (const file of files) {
      const sql = read('backend', 'migrations', file).replace(/--.*$/gm, '');
      for (const [, table] of sql.matchAll(/ALTER TABLE (\w+) ADD COLUMN IF NOT EXISTS phone_hash\b/g)) {
        tables.add(table);
      }
      for (const [, table, body] of sql.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)\s*\(([\s\S]*?)\n\);/g)) {
        if (/\bphone_hash\b/.test(body)) tables.add(table);
      }
    }
    expect([...tables].sort()).toEqual(['banned_identities', 'users']);
    expect(privacy).toMatch(/<strong>Banned accounts:<\/strong>/);
    expect(privacy).toMatch(/<strong>A phone matching code,<\/strong>/);
  });
});

describe('house copy rules', () => {
  test.each(Object.keys(PAGES))('%s contains no em dash', (name) => {
    // SLOP-AUDIT A2/H18. The legal pages are the easiest place for one to creep
    // back in, because legal prose invites them.
    expect(PAGES[name]).not.toMatch(/—/);
  });

  test('every privacy section id has a heading and a contents entry', () => {
    const listed = [...privacy.matchAll(/\{ id: '([a-z-]+)', title: '([^']+)' \}/g)].map((m) => m[1]);
    expect(listed.length).toBeGreaterThan(5);
    for (const id of listed) {
      expect(privacy).toContain(`<section id="${id}">`);
      expect(privacy).toContain(`{num('${id}')}`);
    }
    // Section numbers are derived from the list, so no heading may hard-code one.
    expect(privacy).not.toMatch(/\{num\(\d+\)\}/);

    // Cross-references in the prose are written out ("see section 3"), so they
    // have to agree with the list they point into. Reorder SECTIONS and this
    // fails rather than sending a reader to the wrong section.
    for (const [, number] of privacy.matchAll(/[Ss]ection (\d+)\b/g)) {
      expect(listed[Number(number) - 1]).toBe('venue-sensors');
    }
  });

  test('the pages point at mailboxes that exist', () => {
    // The contact address on flockcorp.com is the one verified mailbox
    // (SLOP-AUDIT B). A page
    // that mails a dead box is worse than one with no contact at all.
    for (const [name, src] of Object.entries(PAGES)) {
      const addresses = [...src.matchAll(/[\w.]+@flockcorp\.com/g)].map((m) => m[0]);
      for (const address of addresses) {
        expect([name, address]).toEqual([name, 'social@flockcorp.com']);
      }
    }
  });
});

describe('the promised in-app data export exists and is gated the way the policy says', () => {
  // The policy used to send people to an email address for a copy of their
  // data while GET /api/users/export sat built and unreachable, so every
  // request was answered by hand using a route that already did the whole job.
  // Now the policy names an in-app control. A page that names a control the app
  // does not have is the exact failure this file was written to prevent, and it
  // is worse for a data right than for a feature, because somebody relying on
  // it is exercising a legal one.
  test('the policy points at the control by the name the app actually uses', () => {
    expect(privacy).toMatch(/Get a copy of my data/);
    expect(APP_SOURCE).toContain('Get a copy of my data');
  });

  test('the export the policy promises is really wired to the route', () => {
    const api = read('frontend', 'src', 'services', 'api.js');
    expect(api).toContain("'/api/users/export'");
    // And something calls it. An exported wrapper with no caller is the state
    // this whole change existed to end.
    expect(APP_SOURCE).toContain('exportMyData(');
  });

  test('it asks for a password, which is what the policy tells people it does', () => {
    expect(privacy).toMatch(/asks for your password/i);
    const api = read('frontend', 'src', 'services', 'api.js');
    expect(api).toContain("'x-export-password'");
  });

  test('the policy no longer says email is the only way to get a copy', () => {
    // The old sentence: "ask us at {mail} and we will send you one." Email is
    // still offered, and it is no longer the only route.
    expect(privacy).not.toMatch(/copy of your data before you delete it, ask us at/);
  });
});
