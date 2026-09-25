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
  + read('frontend', 'src', 'screens', 'FlockDetail.js')
  // The venue detail sheet left App.js on 2026-09-13 for
  // components/overlays/VenueDetailSheet.js, and the only two report entry
  // points for a venue review and a venue promotion in the whole app went with
  // it, so that file is read here too.
  + read('frontend', 'src', 'components', 'overlays', 'VenueDetailSheet.js');
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

  test('Terms 9.6 states the Roost prices, trial and notice the backend enforces', () => {
    const entitlements = read('backend', 'services', 'venueEntitlements.js');
    const notice = read('backend', 'templates', 'roostNoticeEmail.js');
    const billing = read('backend', 'services', 'venueBilling.js');
    const cutoffIso = entitlements.match(/const ROOST_PRICED_FROM = '([^']+)'/)[1];
    const noticeDays = Number(entitlements.match(/const ROOST_NOTICE_DAYS = (\d+);/)[1]);
    const monthly = Number(notice.match(/const ROOST_MONTHLY_USD = (\d+);/)[1]);
    const yearly = Number(notice.match(/const ROOST_YEARLY_USD = (\d+);/)[1]);
    const trial = Number(billing.match(/const TRIAL_DAYS = (\d+);/)[1]);
    const cutoff = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'long', day: 'numeric', year: 'numeric' })
      .format(new Date(cutoffIso));
    const flat = terms.replace(/\s+/g, ' ');
    expect(flat).toContain(`$${monthly} a month, or $${yearly} a year, per location`);
    expect(flat).toContain(`${trial} days free, once per venue`);
    expect(flat).toContain(`created before ${cutoff}`);
    expect(flat).toContain(`at least ${noticeDays} days after that email`);
    // The old promise is gone rather than contradicted.
    expect(flat).not.toContain('nothing in the venue dashboard costs money and no payment method');
  });

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

    // The first-week code (migration 076), written on EVERY deletion. The pages
    // used to say nothing like the ban tombstone was kept for anyone else, which
    // stopped being true the day this was added.
    expect(users).toMatch(/recordGraceSpentIdentity\(account\)/);
    expect(privacy).toMatch(/<strong>Deleted accounts:<\/strong>/);
    expect(privacy).toMatch(/<strong>A first-week code,<\/strong>/);
    expect(deletePage).toMatch(/first week without free-tier limits/);
    expect(privacy).not.toMatch(/Nothing like (this|it) is kept for an? ?accounts? that (was not|weren't) banned/);
    expect(deletePage).not.toMatch(/Nothing like it is kept for an account that was not banned/);

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
    expect(privacy).toMatch(/Your trusted contacts get SOS alerts by <strong>email only<\/strong>/);
  });

  // WHO AN SOS REACHES IN THE APP, WHAT IT CARRIES, AND WHO THE ALL-CLEAR
  // LEAVES OUT, each held to the statement that decides it. The pages said
  // "everyone who has accepted a confirmed plan with you", "the people on a
  // confirmed plan with you" and "your current location", while the audience
  // query also needs the SENDER to have accepted and leaves out anyone banned
  // and anyone in a block either way, the alarm carries coordinates only when
  // the alert has them, and the all-clear's snapshot query drops anyone banned
  // or blocked since the alarm.
  describe('the SOS sentences say who the code reaches and what it sends', () => {
    const safety = read('backend', 'routes', 'safety.js');
    const crawler = read('frontend', 'api', 'marketing-page.js');
    const support = read('frontend', 'src', 'website', 'SupportPage.js');
    const llms = read('frontend', 'public', 'llms.txt');
    const sqlOf = (name) => {
      const m = safety.match(new RegExp(`const ${name} = \`([\\s\\S]*?)\`;`));
      if (!m) throw new Error(`${name} is gone from routes/safety.js`);
      return flat(m[1]);
    };
    // The FAQ constant is string concatenation; joined, it reads like the page.
    // A function because `flat` is declared further down this file.
    const supportText = () => flat(support.replace(/'\s*\+\s*'/g, ''));

    test('the in-app audience is the one SOS_FLOCK_AUDIENCE_SQL selects', () => {
      expect(safety).toMatch(/async function alertFlockMembers\(/);
      expect(safety).toMatch(/pushAlways\(row\.user_id, title, body/);
      expect(safety).toMatch(/pool\.query\(SOS_FLOCK_AUDIENCE_SQL, \[user\.id, SOS_FLOCK_WINDOW_HOURS\]\)/);
      expect(Number((safety.match(/const SOS_FLOCK_WINDOW_HOURS = (\d+);/) || [])[1])).toBe(12);
      const audience = sqlOf('SOS_FLOCK_AUDIENCE_SQL');
      expect(audience).toContain("me.user_id = $1 AND me.status = 'accepted'");
      expect(audience).toContain("WHERE fm.status = 'accepted'");
      expect(audience).toContain("f.status = 'confirmed'");
      expect(audience).toContain("f.event_time BETWEEN (NOW() AT TIME ZONE 'UTC') - ($2::int * INTERVAL '1 hour') AND (NOW() AT TIME ZONE 'UTC') + ($2::int * INTERVAL '1 hour')");
      expect(audience).toContain('COALESCE((SELECT is_banned FROM users u WHERE u.id = fm.user_id), FALSE) = FALSE');
      expect(audience).toContain('(b.blocker_id = $1 AND b.blocked_id = fm.user_id)');
      expect(audience).toContain('(b.blocker_id = fm.user_id AND b.blocked_id = $1)');

      const sentence = 'We also alert people in the app, as a notification and on screen: those who, like you, have accepted a confirmed plan that starts within twelve hours of that moment, before or after, other than anyone banned from Flock and anyone you have blocked or who has blocked you.';
      expect(flat(privacy)).toContain(sentence);
      expect(crawler).toContain(sentence);
      expect(flat(privacy)).toContain('people who, like you, have accepted a confirmed plan starting within twelve hours of the alert get an alert in the app, unless they are banned or one of you has blocked the other');
      expect(flat(terms)).toContain('the people who, like you, have accepted a confirmed plan that starts within twelve hours of the alert, before or after, unless they are banned or one of you has blocked the other');
      const faq = 'People who, like you, have accepted a confirmed plan that starts within twelve hours of the alert also get an alert in the app, with the same location when there is one, unless they are banned or one of you has blocked the other.';
      expect(supportText().split(faq).length - 1).toBe(2); // the FAQ data and the paragraph
      expect(flat(llms)).toContain('alerts in the app the people who, like the user, have accepted a confirmed plan that starts within twelve hours of the alert, before or after, unless they are banned or either one has blocked the other');
      for (const [name, src] of [['PrivacyPolicy.js', flat(privacy)], ['TermsOfService.js', flat(terms)], ['SupportPage.js', supportText()], ['llms.txt', flat(llms)], ['marketing-page.js', crawler]]) {
        expect([name, (src.match(/everyone who has accepted a confirmed plan|Anyone who has accepted a confirmed plan|anyone on a confirmed plan|show it to the people on a confirmed plan|the people on a confirmed plan with you get/) || [])[0]]).toEqual([name, undefined]);
      }
    });

    test('the location is promised only when the alert has one', () => {
      // The alarm spreads coordinates in only when there are some (its words
      // and data are built in services/sosPushes.js, which the flock leg in
      // routes/safety.js calls), and the email says so when there are none.
      const sosPushes = read('backend', 'services', 'sosPushes.js');
      expect(safety).toMatch(/alarmPush\(\{[\s\S]{0,200}coords,/);
      expect(sosPushes).toMatch(/\.\.\.\(coords \? \{ latitude: coords\.lat, longitude: coords\.lng \} : \{\}\)/);
      expect(safety).toMatch(/: '<p style="color:#6b7280">Location was not available\.<\/p>'/);
      for (const [name, src] of [['PrivacyPolicy.js', flat(withoutComments(privacy))], ['TermsOfService.js', flat(withoutComments(terms))], ['SupportPage.js', flat(withoutComments(support.replace(/'\s*\+\s*'/g, '')))], ['llms.txt', flat(llms)], ['marketing-page.js', flat(withoutComments(crawler))]]) {
        // Sharing a location from the Safety screen always has one, so "send
        // your trusted contacts your location" is not on this list.
        const hit = src.match(/SOS[^.]*current location|with the same location\.|an SOS alert with your location|emails trusted contacts the user's location|email your trusted contacts your location/);
        expect([name, hit && hit[0]]).toEqual([name, null]);
      }
      expect(flat(privacy)).toContain('we email your trusted contacts, with your location when your phone can find one');
      expect(flat(privacy)).toContain('Their alert carries the same location when the alert has one.');
      expect(flat(terms)).toContain('emails the trusted contacts you set up, with your location when your phone can find one');
      expect(supportText()).toContain('get an email with the time and, when your phone can find it, your location');
      expect(flat(llms)).toContain('emails trusted contacts, with the user\'s location when the phone can find one');
    });

    test('the all-clear leaves out whoever the snapshot query leaves out, and the policy says so', () => {
      const snapshot = sqlOf('SOS_STAND_DOWN_SNAPSHOT_SQL');
      expect(snapshot).toContain('COALESCE(u.is_banned, FALSE) = FALSE');
      expect(snapshot).toContain('(b.blocker_id = $1 AND b.blocked_id = u.id)');
      expect(snapshot).toContain('(b.blocker_id = u.id AND b.blocked_id = $1)');
      expect(safety).toMatch(/pool\.query\(SOS_STAND_DOWN_SNAPSHOT_SQL, \[user\.id, snapshot\]\)/);
      const p = flat(privacy);
      expect(p).toMatch(/who it reached, and when you stood it down/);
      expect(p).toContain('so an all-clear goes back to the people it reached. The all-clear in the app leaves out anyone who has since been banned, or who has since blocked you or been blocked by you.');
      expect(p).not.toMatch(/an all-clear reaches the same people/);
    });
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

  test('the friend code is random and stored, which is what the policy says', () => {
    // Until migration 079 the code was worked out from the account number and
    // stored nowhere, and this test held the policy to saying so. It is drawn
    // at random now and kept in users.friend_code, so the policy says that,
    // and the old sentence must not come back while the column exists.
    const migrations = fs
      .readdirSync(path.join(REPO, 'backend', 'migrations'))
      .filter((f) => f.endsWith('.sql'))
      .map((f) => read('backend', 'migrations', f))
      .join('\n');
    expect(migrations).toMatch(/ALTER TABLE users ADD COLUMN IF NOT EXISTS friend_code/);
    const friends = read('backend', 'routes', 'friends.js');
    expect(friends).toMatch(/crypto\.randomInt\(FRIEND_CODE_ALPHABET\.length\)/);
    expect(friends).not.toMatch(/toString\(36\)/);
    expect(privacy).toMatch(/Your friend code is made at random the first time you ask for it and stored with your account/);
    expect(privacy).not.toMatch(/worked out from your account number/);
    expect(privacy).not.toMatch(/no separate code stored anywhere/);
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
    // The tab is called You (App.js tab label); every page names it that way.
    expect(guidelines).toMatch(/<strong>You<\/strong> &rarr; <strong>Blocked accounts<\/strong>/);
    expect(guidelines).not.toMatch(/Settings<\/strong> &rarr; <strong>Blocked/);
    expect(app).toMatch(/Delete account \(Apple Guideline 5\.1\.1\(v\)\)/);
    expect(privacy).toMatch(/You &rarr; scroll to the bottom &rarr; Delete account/);
    expect(privacy).not.toMatch(/Profile &rarr; Delete account/);
    expect(deletePage).toMatch(/<strong>You<\/strong> \(the last tab\) &rarr; scroll to the bottom &rarr; <strong>Delete account<\/strong>/);

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
    // DESIGN-STANDARD A2/H18. The legal pages are the easiest place for one to creep
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
    // (DESIGN-STANDARD B). A page
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

// Whitespace is flattened because these sentences wrap across source lines, and
// comments are dropped because a note recording why a sentence went may quote it.
const flat = (s) => s.replace(/\s+/g, ' ');
const withoutComments = (src) => src
  .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

describe('the age check the pages describe is the one the server runs', () => {
  // The policy, the guidelines and the crawler copy say sign-up takes a birth
  // YEAR and the server works the age out from it in the one direction that can
  // only count someone younger. Every creation path used to judge the full date
  // in the body instead, so 2013-01-01 got an account on 2026-09-25 while
  // 2013-12-31 did not. backend/__tests__/minorsCompliance.test.js drives the
  // three doors; this holds the pages to the code they describe.
  test('all three creation paths judge 31 December of the submitted year', () => {
    const auth = read('backend', 'routes', 'auth.js');
    const age = read('backend', 'utils', 'age.js');
    expect(age).toMatch(/return `\$\{String\(b\.y\)\.padStart\(4, '0'\)\}-12-31`;/);
    expect(auth).toMatch(/const judgedDob = yearEndDob\(date_of_birth\);\s*const age = judgedDob \? ageFromDob\(judgedDob\) : null;/);
    expect(auth).toMatch(/const googleDob = yearEndDob\(suppliedDob\(req\.body\.date_of_birth\)\);/);
    expect(auth).toMatch(/const appleDob = yearEndDob\(suppliedDob\(req\.body\.date_of_birth\)\);/);

    expect(flat(privacy)).toMatch(/works out your age from that year in the one way that can only ever count you as younger/);
    expect(flat(guidelines)).toMatch(/works out the age from it in the one way that can only count someone as younger/);
  });
});

describe('invite links and guest answers are described as the guest routes behave', () => {
  const guest = read('backend', 'routes', 'guest.js');

  test('a link shows the plan and its roster; the chat and live location need a verified account that joins', () => {
    // The one authenticated route in guest.js is the join, and it wants a
    // confirmed email. No guest route reads a message or a position.
    expect(guest).toMatch(/router\.post\('\/:token\/join',\s*authenticate,\s*requireVerified,/);
    expect(withoutComments(guest)).not.toMatch(/\bFROM messages\b|\blatitude\b|\blongitude\b/i);
    // Live location is relayed only to a socket whose account is a member.
    const handlers = read('backend', 'sockets', 'handlers.js');
    const start = handlers.indexOf("socket.on('update_location'");
    expect(start).toBeGreaterThan(-1);
    const relay = handlers.slice(start, handlers.indexOf("socket.on('stop_sharing_location'", start));
    expect(relay).toMatch(/if \(!\(await verifyMembership\(flockId, user\.id\)\)\)/);

    const p = flat(privacy);
    expect(p).toMatch(/anyone holding it can see the plan and who is on it, by first name, and can answer, vote and share a budget amount as a guest/);
    expect(p).toMatch(/Reading the flock's chat or seeing live location takes joining, which needs a signed-in Flock account with a confirmed email/);
    expect(p).not.toMatch(/anyone holding it can join the flock, read its chat and see live location/);
  });

  test("a guest's budget amount is stored, and the policy says so and for how long", () => {
    expect(guest).toMatch(/INSERT INTO budget_submissions \(flock_id, guest_rsvp_id, amount, skipped, updated_at\)/);
    // The amount goes with the guest row, and the guest row goes with the plan.
    expect(read('backend', 'migrations', '071_guest_budget_answers.sql'))
      .toMatch(/guest_rsvp_id INTEGER REFERENCES guest_rsvps\(id\) ON DELETE CASCADE/);
    expect(read('backend', 'migrations', '001_baseline.sql'))
      .toMatch(/CREATE TABLE IF NOT EXISTS guest_rsvps \(\s*id SERIAL PRIMARY KEY,\s*flock_id INTEGER NOT NULL REFERENCES flocks\(id\) ON DELETE CASCADE/);

    const p = flat(privacy);
    expect(p).toMatch(/the budget amount they enter if they choose to share one, tied to a random link token/);
    expect(p).toMatch(/the display name, votes and budget amount a guest leaves on an invite link are kept with that plan, and deleted when the plan is deleted/);
  });
});

describe('the pages describe the apps that exist', () => {
  // Flock is an iOS shell and a browser app. There is no Android project, no
  // @capacitor/android and no Play billing, so a page that sells a subscription
  // "through Google Play" or covers use "on Android" describes an app nobody can
  // install. If an Android build ships, this fails and the pages get it back.
  test('no Android project exists, so no legal page or crawler copy names Google Play or an Android app', () => {
    const pkg = JSON.parse(read('frontend', 'package.json'));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    expect(deps['@capacitor/ios']).toBeDefined();
    expect(deps['@capacitor/android']).toBeUndefined();
    expect(exists('frontend', 'android')).toBe(false);

    const mirror = read('frontend', 'api', 'marketing-page.js');
    for (const [name, src] of [...Object.entries(PAGES), ['marketing-page.js', mirror]]) {
      const hit = flat(withoutComments(src)).match(/Google Play|Play Store|on Android|Android app/i);
      expect([name, hit && hit[0]]).toEqual([name, null]);
    }
  });
});

describe('the budget settles the way the pages say it does', () => {
  // The policy said the budget settles "when the last member has answered",
  // llms.txt "until every member has answered and at least three have shared"
  // and "after at least three people have submitted", and the home page "until
  // everyone has answered". The settle in routes/budget.js waits for every
  // accepted member AND every guest who said they are in, counts only members
  // toward the three, and the plan's creator can lock it sooner once three
  // members have shared, which none of those sentences allowed for.
  const budget = read('backend', 'routes', 'budget.js');
  const llms = read('frontend', 'public', 'llms.txt');
  const landing = read('frontend', 'src', 'website', 'LandingPage.js');
  const mirror = read('frontend', 'api', 'marketing-page.js');

  test('who has to answer, who makes the three, and who can lock it, in the code', () => {
    // answeringPopulation: accepted members plus visible guests who are in.
    expect(budget).toMatch(/"SELECT COUNT\(\*\) AS total FROM flock_members WHERE flock_id = \$1 AND status = 'accepted'"/);
    expect(budget).toMatch(/const GUEST_ANSWERERS_SQL = `SELECT COUNT\(\*\) AS total FROM guest_rsvps\s+WHERE flock_id = \$1 AND status = 'in'/);
    // The three are member amounts only, and the settle needs them.
    expect(budget).toMatch(/COUNT\(\*\) FILTER \(WHERE skipped = false AND bm\.id IS NOT NULL\) AS non_skip_count/);
    expect(budget).toMatch(/parseInt\(countRow\.non_skip_count\) >= 3/);
    // The lock: the creator alone, and only past three members' amounts.
    expect(budget).toMatch(/Only the flock creator can lock the budget/);
    expect(budget).toMatch(/SELECT COUNT\(\*\)::int AS n FROM \$\{MEMBER_SUBMISSIONS\}\s+WHERE bs\.flock_id = \$1 AND skipped = false/);
    expect(budget).toMatch(/if \(\(countResult\.rows\[0\]\?\.n \|\| 0\) < 3\) \{/);
  });

  test('the privacy page and its crawler copy say who answers, who counts, and the lock', () => {
    const settles = 'The budget settles when every member who has accepted the plan and every guest who said they are in from an invite link has answered, and at least three members have shared an amount (a guest\'s amount goes into the figure but does not count toward the three).';
    const lock = 'The person who created the plan can settle it sooner by locking it, which also needs three members\' amounts and closes it to anyone who has not answered yet.';
    for (const [name, src] of [['PrivacyPolicy.js', flat(privacy)], ['marketing-page.js', mirror]]) {
      expect([name, src.includes(settles)]).toEqual([name, true]);
      expect([name, src.includes(lock)]).toEqual([name, true]);
      expect([name, /settles when the last member has answered/.test(src)]).toEqual([name, false]);
    }
  });

  test('llms.txt and the home page say the same', () => {
    const l = flat(llms);
    expect(l).toContain('No figure at all is published until the budget settles: every accepted member and every guest who said they are in from an invite link has answered and at least three members have shared an amount, or the person who created the plan locks it sooner, which also needs three members\' amounts. A guest\'s amount counts in the figure but not toward the three.');
    expect(l).toContain('Only a group ceiling is shared, once, as a rounded-down band, and only after at least three members have shared an amount.');
    expect(l).not.toMatch(/until every member has answered|three people have submitted/);

    const home = flat(withoutComments(landing));
    const bullet = 'No number until everyone going has answered or the plan\'s creator locks it, with at least three members\' amounts in, and then it is a rounded band, not anyone\'s figure';
    expect(home).toContain(bullet);
    expect(mirror).toContain(bullet);
    expect(home).not.toMatch(/No number until everyone has answered/);
  });
});
