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

    const grid = main.match(/rows,\s*cols\s*=\s*(\d+),\s*(\d+)/);
    expect(grid).not.toBeNull();
    const rows = Number(grid[1]);
    const cols = Number(grid[2]);
    expect(privacy).toContain(`${rows} by ${cols} grid`);
    expect(privacy).toContain(`${rows * cols} temperature readings`);
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
    expect(code).not.toMatch(/^\s*(import|from)\s+(cv2|picamera\w*|PIL|pyaudio|sounddevice|bluetooth|bluepy|scapy)\b/m);
    expect(code).not.toMatch(/VideoCapture|imwrite|wave\.open|\.wav\b/i);
    expect(code).not.toMatch(/iwlist|iw dev|hcitool|bluetoothctl|airodump|tcpdump|arp -a/i);
    expect(privacy).toMatch(/No phone detection/);
    expect(privacy).toMatch(/No audio recording/);
  });
});

describe('stories are not described as something a user can do', () => {
  const app = read('frontend', 'src', 'App.js');

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
  test('revocation is still gated on env that has to be configured', () => {
    const appleAuth = read('backend', 'services', 'appleAuth.js');
    expect(appleAuth).toMatch(/function isConfigured\(\)\s*\{\s*return !!\(TEAM_ID && KEY_ID && PRIVATE_KEY\);/);
    // Deletion only calls revoke when that gate passes, which is why the pages
    // cannot promise it unconditionally.
    const users = read('backend', 'routes', 'users.js');
    expect(users).toMatch(/appleAuthConfigured\(\)/);
  });

  test('neither page promises revocation, and both tell the user how to do it themselves', () => {
    // Revert both of these together, in the same commit that sets APPLE_TEAM_ID,
    // APPLE_KEY_ID and APPLE_PRIVATE_KEY on the server. Not before.
    expect(deletePage).not.toMatch(/we\s+also revoke Flock's Sign in with Apple access/i);
    expect(deletePage).toMatch(/Stop using Apple ID/);
    expect(privacy).toMatch(/we hold no Apple refresh token/i);
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
    expect(safety).toMatch(/alerts are sent by email/);
    expect(privacy).toMatch(/SOS alerts are sent by <strong>email only<\/strong>/);
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
    const app = read('frontend', 'src', 'App.js');
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
    const app = read('frontend', 'src', 'App.js');
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
    const app = read('frontend', 'src', 'App.js');
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
    // social@flockcorp.com is the one verified address (SLOP-AUDIT B). A page
    // that mails a dead box is worse than one with no contact at all.
    for (const [name, src] of Object.entries(PAGES)) {
      const addresses = [...src.matchAll(/[\w.]+@flockcorp\.com/g)].map((m) => m[0]);
      for (const address of addresses) {
        expect([name, address]).toEqual([name, 'social@flockcorp.com']);
      }
    }
  });
});
