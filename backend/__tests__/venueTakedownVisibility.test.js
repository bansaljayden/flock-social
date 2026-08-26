// Run: node --test  (from backend/)
//
// TWO CONTRACTS THE SERVER HOLDS UP ON ITS OWN AND THE INTERFACE DOES NOT.
//
// 1. MODERATION TAKEDOWNS. backend/routes/venueDashboard.js has flagged hidden
//    promotions as `hidden_by_moderation` since round 18 and hidden events since
//    round 22, and it refuses an edit to either with 409 CONTENT_HIDDEN. Until
//    now frontend/src/App.js did not contain the string `hidden_by_moderation`
//    anywhere: a venue owner whose promotion had been taken down saw it listed
//    exactly like one that was running, and the only signal they ever got was a
//    409 telling them to "delete it and create a new one" for a problem the
//    screen had never mentioned.
//
// 2. THE VENUE PAYLOAD. utils/venuePayload.js drops `stars` and `price`, both of
//    which the client sends. `stars` was survivable (the sanitizer already read
//    it as an alias for `rating`). `price` was not: it was read by nothing, so a
//    venue whose price_level was anything but an integer 0-4 kept its '$$' on
//    the sender's screen and lost it for every recipient.
//
// WHY THIS FILE READS SOURCE FOR THE FRONTEND HALF. Same reason
// moderationConsoleContract.test.js does: App.js is a 16,500-line browser module
// that pulls in Firebase, socket.io and a canvas renderer at import time, and
// the routers here open a pg pool on import. Neither side can load the other,
// which is exactly why the two drift. The one piece of real LOGIC the frontend
// added (isModerationHidden) is extracted from the source and executed, so its
// truth table is tested for behaviour and not for spelling.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { sanitizeVenueData } = require('../utils/venuePayload');

const FRONTEND = path.join(__dirname, '..', '..', 'frontend', 'src');
const APP_FILE = path.join(FRONTEND, 'App.js');
const FIREBASE_FILE = path.join(FRONTEND, 'services', 'firebase.js');
const DASHBOARD_FILE = path.join(__dirname, '..', 'routes', 'venueDashboard.js');

// Line endings normalised: these files are edited on Windows and on CI, and a
// guard that passes or fails on \r\n is a guard nobody can trust.
const read = (f) => fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');

// The venue owner dashboard left App.js on 2026-08-26: it is its own lazily
// loaded chunk now (screens/VenueDashboard.js), and every promotion and event
// surface this file scans went with it. Nothing asserted below changed. The app
// source is simply in two files, so both are read, in the order they used to be
// one.
const appSrc = read(APP_FILE) + read(path.join(FRONTEND, 'screens', 'VenueDashboard.js'));
const firebaseSrc = read(FIREBASE_FILE);
const dashboardSrc = read(DASHBOARD_FILE);

// Comments are prose and must never satisfy a check about code. Every source
// assertion below runs against this, not against the raw file.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
}
const appCode = stripComments(appSrc);
const firebaseCode = stripComments(firebaseSrc);
const dashboardCode = stripComments(dashboardSrc);

// ─── 1. The field name, end to end ───────────────────────────────────────────

test('the server states the takedown flag on BOTH owner lists', () => {
  // The frontend contract below is only worth anything if this is still true.
  // If a refactor renames it here, the frontend tests must fail loudly rather
  // than keep passing against a name nothing sends.
  const promoList = /router\.get\('\/promotions'[\s\S]*?^}\);/m.exec(dashboardCode);
  const eventList = /router\.get\('\/events'[\s\S]*?^}\);/m.exec(dashboardCode);
  assert.ok(promoList, 'GET /promotions not found in routes/venueDashboard.js');
  assert.ok(eventList, 'GET /events not found in routes/venueDashboard.js');
  assert.match(promoList[0], /hidden_by_moderation/, 'GET /promotions stopped stating hidden_by_moderation');
  assert.match(eventList[0], /hidden_by_moderation/, 'GET /events stopped stating hidden_by_moderation');
});

test('the server still refuses an edit to hidden content with 409 CONTENT_HIDDEN', () => {
  // The whole reason the interface has to show the state: this refusal exists
  // and reads as nonsense when nothing on screen ever mentioned a takedown.
  const conflicts = dashboardCode.match(/status\(409\)[\s\S]{0,400}?CONTENT_HIDDEN/g) || [];
  assert.strictEqual(
    conflicts.length, 2,
    'expected exactly two CONTENT_HIDDEN refusals (promotions PUT, events PUT); ' +
    `found ${conflicts.length}. If a third resource grew one, the dashboard has to render it too.`
  );
});

test('App.js reads the flag the server sends', () => {
  assert.match(
    appCode, /hidden_by_moderation/,
    'App.js does not mention hidden_by_moderation anywhere. A taken-down promotion ' +
    'renders identically to a running one and the owner is told nothing.'
  );
});

test('the events mapper carries the takedown flag through', () => {
  // The specific hole on the events side: the mapper reduces each row to
  // {id, title, date, time, capacity} and dropped the flag on the floor, so the
  // events tab could not have rendered it even once the backend started sending
  // it (migration 019). Promotions keep the raw row and never had this problem.
  const m = /setVenueEventsList\(\([\s\S]{0,400}?\)\)\);/.exec(appCode);
  assert.ok(m, 'the events list mapper was not found in App.js');
  assert.match(
    m[0], /hidden_by_moderation: isModerationHidden\(e\)/,
    'the events mapper drops the takedown flag, so the events tab can never show one'
  );
});

// ─── 2. isModerationHidden, executed rather than grepped ─────────────────────

// Pulled out of App.js and run. A source check would pass on a helper that
// always returned false; this does not.
const isModerationHidden = (() => {
  const m = /const isModerationHidden = ([\s\S]*?);\n/.exec(appCode);
  assert.ok(m, 'const isModerationHidden not found in App.js — it was renamed, and this guard went with it.');
  // eslint-disable-next-line no-new-func
  return new Function(`return (${m[1]});`)();
})();

test('isModerationHidden reads both spellings the server actually sends', () => {
  // GET /promotions and GET /events derive `hidden_by_moderation`. POST and PUT
  // on the same resources answer with RETURNING *, which carries the raw
  // `is_hidden` column and no derived flag. Both are real responses this app
  // builds rows from, so both have to read as hidden.
  assert.strictEqual(isModerationHidden({ hidden_by_moderation: true }), true, 'list row');
  assert.strictEqual(isModerationHidden({ is_hidden: true }), true, 'write response row');

  // And a running row is not hidden, however it is spelled.
  assert.strictEqual(isModerationHidden({ hidden_by_moderation: false, is_hidden: false }), false);
  assert.strictEqual(isModerationHidden({ title: 'Half price apps' }), false, 'flag absent');
  assert.strictEqual(isModerationHidden(null), false);
  assert.strictEqual(isModerationHidden(undefined), false);

  // Strictly true, never truthy. Postgres sends booleans, but an id or a
  // timestamp landing in this slot through a mapping mistake must not mark a
  // live promotion as taken down and strip its Edit button.
  assert.strictEqual(isModerationHidden({ is_hidden: 'false' }), false, "the string 'false' is not true");
  assert.strictEqual(isModerationHidden({ is_hidden: 1 }), false);
  assert.strictEqual(isModerationHidden({ hidden_by_moderation: 'yes' }), false);
});

// ─── 3. No control that cannot succeed ───────────────────────────────────────

// The promotions list body and the events list body, isolated so an assertion
// about one cannot be satisfied by the other.
function listBody(anchor) {
  const start = appCode.indexOf(anchor);
  assert.notStrictEqual(start, -1, `list anchor not found in App.js: ${anchor}`);
  return appCode.slice(start, start + 4000);
}
const promoListBody = listBody('Your Promotions ({promotions.length})');
const eventListBody = listBody('Your Events ({venueEventsList.length})');

test('the Edit control does not render on a taken-down promotion or event', () => {
  // PUT /promotions/:id and PUT /events/:id both answer 409 on a hidden row, so
  // an Edit button on one can only ever open a form, take everything the owner
  // types, and refuse it on Save. This project treats a control that cannot
  // succeed as a defect.
  for (const [what, body] of [['promotion', promoListBody], ['event', eventListBody]]) {
    const edit = /\{!hidden && \(\s*<button aria-label="Edit"/.exec(body);
    assert.ok(
      edit,
      `the ${what} Edit button is not gated on the takedown flag. It renders on a row ` +
      'the server will answer 409 CONTENT_HIDDEN for.'
    );
  }
});

test('Delete still renders on a taken-down promotion and event', () => {
  // The counterpart rule, and the one that stops this becoming a dead end:
  // DELETE has no is_hidden predicate on either resource, so it genuinely works
  // on a hidden row, and it is the only thing the owner can do about one.
  for (const [what, body] of [['promotion', promoListBody], ['event', eventListBody]]) {
    assert.match(body, /<button aria-label="Delete"/, `${what} row lost its Delete control`);
    assert.ok(
      !/\{!hidden && \(\s*<button aria-label="Delete"/.test(body),
      `the ${what} Delete button was gated on the takedown flag; deleting a hidden row is ` +
      'exactly what the server tells the owner to do.'
    );
  }
  for (const verb of ['DELETE FROM venue_promotions', 'DELETE FROM venue_events']) {
    const at = dashboardCode.indexOf(verb);
    assert.notStrictEqual(at, -1, `${verb} not found in routes/venueDashboard.js`);
    // Bounded by the closing quote of the string literal it sits in. Both are
    // single-quoted one-liners; running past that would let an is_hidden
    // hundreds of lines away answer for this statement.
    const stmt = dashboardCode.slice(at, dashboardCode.indexOf("'", at));
    assert.ok(
      !/is_hidden/.test(stmt),
      `${verb} grew an is_hidden predicate; the dashboard offers Delete on hidden rows ` +
      'because it does not have one.'
    );
  }
});

test('both lists render the takedown notice', () => {
  assert.match(promoListBody, /<ModerationHiddenNotice kind="promotion"/);
  assert.match(eventListBody, /<ModerationHiddenNotice kind="event"/);
});

test('the takedown copy promises nothing that does not exist', () => {
  const m = /const MODERATION_HIDDEN_COPY = \{([\s\S]*?)\};/.exec(appCode);
  assert.ok(m, 'MODERATION_HIDDEN_COPY not found in App.js');
  const copy = m[1];

  // What must be there: the fact, and the two things that actually work.
  for (const line of copy.split('\n').filter((l) => l.includes(':'))) {
    assert.match(line, /Removed by moderation/, `takedown copy does not say what happened: ${line.trim()}`);
    assert.match(line, /cannot be edited/, `takedown copy does not say the edit will fail: ${line.trim()}`);
    assert.match(line, /Delete it and/, `takedown copy does not name the way out: ${line.trim()}`);
  }

  // What must NOT be there. Nothing in this codebase runs an appeal, emails a
  // content author about a takedown, or reviews anything on request; and a
  // moderator CAN put content back (routes/admin.js 'unhide'), so it is not
  // permanent either. SLOP-AUDIT rule 5, and no em dashes anywhere in UI copy.
  for (const forbidden of [/appeal/i, /contact support/i, /under review/i, /reach out/i, /permanently/i, /—/]) {
    assert.ok(!forbidden.test(copy), `takedown copy promises or claims something untrue: ${forbidden}`);
  }
});

test('a 409 from the server is reconciled into the list, and the dead form is closed', () => {
  // The Edit button is gone for rows we already know are hidden, but a takedown
  // that lands AFTER the dashboard loaded is still reachable. The server's 409
  // is the fact; the row has to carry it afterwards, and the composer has to
  // close, because Save in it can now only ever 409 again.
  const hits = appCode.match(/code === 'CONTENT_HIDDEN' && editing(Promo|Event)\) mark(Promo|Event)TakenDown\(/g) || [];
  assert.strictEqual(
    hits.length, 2,
    `expected the promotion and event save handlers to both reconcile a 409; found ${hits.length}`
  );
  for (const [what, fn, setter, modal] of [
    ['promotion', 'markPromoTakenDown', 'setPromotions', 'setShowPromoModal'],
    ['event', 'markEventTakenDown', 'setVenueEventsList', 'setShowEventModal'],
  ]) {
    const at = appCode.indexOf(`const ${fn} = (id) => {`);
    assert.notStrictEqual(at, -1, `${fn} not found in App.js`);
    const body = appCode.slice(at, appCode.indexOf('\n    };', at));
    assert.match(body, new RegExp(`${setter}\\(prev =>`), `${what}: the 409 does not touch the list`);
    assert.match(body, /hidden_by_moderation: true/, `${what}: a 409 did not mark the row hidden`);
    assert.match(body, new RegExp(`${modal}\\(false\\)`), `${what}: a 409 left the composer open on a form that can never save`);
  }
});

test('a 404 on delete is reconciled, not reported as a failure', () => {
  // The server answers 404 for "not yours / already gone", so the row in front
  // of the owner does not exist. Leaving it on screen makes the trash icon look
  // broken and every further tap fails identically. Deleting is what they asked
  // for and it is already true.
  for (const [what, setter] of [['promotion', 'setPromotions'], ['event', 'setVenueEventsList']]) {
    const m = new RegExp(`const delete${what === 'promotion' ? 'Promo' : 'Event'} = async[\\s\\S]{0,700}?\\n    \\};`).exec(appCode);
    assert.ok(m, `the ${what} delete handler was not found in App.js`);
    assert.match(m[0], /status === 404/, `the ${what} delete handler does not reconcile a 404`);
    assert.ok(
      (m[0].match(new RegExp(`${setter}\\(prev =>`, 'g')) || []).length >= 2,
      `the ${what} delete handler reports a 404 without dropping the row it says is gone`
    );
  }
});

test('a newly created event is prepended, matching the order the server returns', () => {
  // GET /events orders by created_at DESC. Appending put a new event at the
  // bottom of the list until the next dashboard load silently moved it to the
  // top with nothing having changed. Promotions have always prepended.
  const at = appCode.indexOf('const created = await createVenueEvent(');
  assert.notStrictEqual(at, -1, 'the event create branch was not found in App.js');
  assert.match(
    appCode.slice(at, at + 700), /setVenueEventsList\(prev => \[\{ id: created\.id/,
    'a new event is appended, so it sorts differently before and after a reload'
  );
});

// ─── 4. A failed list read is not an empty list ──────────────────────────────

test('a failed promotions or events read never renders as "create your first one"', () => {
  // Both empty states invite the owner to create the content again, so a
  // network blip that rendered as empty told a venue owner their promotions
  // were gone and asked them to retype them.
  assert.ok(
    !/getVenuePromotions\(\)\.catch\(\(\) => \(\{ promotions: \[\] \}\)\)/.test(appCode),
    'the promotions read still swallows its failure into an empty list'
  );
  assert.ok(
    !/getVenueEvents\(\)\.catch\(\(\) => \(\{ events: \[\] \}\)\)/.test(appCode),
    'the events read still swallows its failure into an empty list'
  );
  assert.match(appCode, /venueListErrors/, 'no load-failure state exists for the owner content lists');

  for (const [what, body] of [['promotions', promoListBody], ['events', eventListBody]]) {
    assert.match(body, new RegExp(`venueListErrors\\.${what}`), `${what} list does not read its own error state`);
    assert.match(body, /Try again/, `${what} list offers no way to retry a failed read`);
    // The empty state must be SUPPRESSED by the error, not merely accompanied
    // by it: "No promotions yet. Create your first one!" under a failure banner
    // is still the same false statement.
    assert.match(
      body, new RegExp(`venueListErrors\\.${what} \\? null :`),
      `${what} list still prints its create-your-first-one empty state after a failed read`
    );
  }
});

test('a failed read leaves the rows that did load on screen', () => {
  // The banner must not replace the list. A promotion created after a failed
  // read is real and has to render; hiding it behind the error is the same lie
  // pointed the other way.
  for (const [what, body] of [['promotions', promoListBody], ['events', eventListBody]]) {
    const listVar = what === 'promotions' ? 'promotions' : 'venueEventsList';
    const errorFirst = body.indexOf(`venueListErrors.${what} && (`);
    const lengthCheck = body.indexOf(`${listVar}.length === 0`);
    assert.notStrictEqual(errorFirst, -1, `${what} error banner not found`);
    assert.notStrictEqual(lengthCheck, -1, `${what} length check not found`);
    assert.ok(
      errorFirst < lengthCheck,
      `${what}: the error state is branched BEFORE the list, so a failed read hides rows that did load`
    );
  }
});

// ─── 5. The venue payload contract ───────────────────────────────────────────

test('rating survives the round trip under one name, from either name', () => {
  // `stars` is an input alias for `rating` and is deliberately not echoed:
  // VenueCard renders `venue.stars || venue.rating`, so the canonical name
  // alone is enough, and two spellings of one number cannot then disagree.
  assert.strictEqual(sanitizeVenueData({ name: 'Bar', stars: 4.4 }).data.rating, 4.4);
  assert.strictEqual(sanitizeVenueData({ name: 'Bar', rating: 4.1, stars: 2 }).data.rating, 4.1, 'the canonical name wins');
  assert.strictEqual(sanitizeVenueData({ name: 'Bar', stars: 4.4 }).data.stars, undefined, 'stars is not echoed back');
});

test('price survives the round trip when price_level is unusable', () => {
  // THE LEAK. The card renders `venue.price || '$'.repeat(venue.price_level)`,
  // so a payload carrying `price: '$$'` and no usable integer showed '$$' on
  // the sender's screen from the local copy and came back with no price at all
  // for every recipient.
  for (const [priceLevel, label] of [
    [undefined, 'absent'],
    [null, 'null'],
    ['2', 'a numeric string'],
    ['PRICE_LEVEL_MODERATE', 'an unmapped Places v1 name'],
    [2.5, 'not an integer'],
  ]) {
    const { data } = sanitizeVenueData({ name: 'Bar', price: '$$', price_level: priceLevel });
    assert.strictEqual(data.price_level, 2, `price_level ${label}: the '$$' beside it was thrown away`);
  }
  // And the integer still wins when it is a real one.
  assert.strictEqual(sanitizeVenueData({ name: 'Bar', price: '$', price_level: 3 }).data.price_level, 3);
  assert.strictEqual(sanitizeVenueData({ name: 'Bar', price_level: 0 }).data.price_level, 0, 'free is a price level');
});

test('the price alias is clamped exactly as hard as the integer it feeds', () => {
  // Nothing new is trusted: the alias is only ever a COUNT of '$' characters,
  // held to the same 0-4 the integer is, so the most a hostile `price` can do
  // is set a price level. Out of range is dropped, never clamped, the same way
  // a rating of 1e308 is dropped rather than printed as 5.
  for (const bad of ['$$$$$', '$$$$$$$$', '££', 'cheap', '', '  ', '$ $', '2', 4, ['$$'], { toString: () => '$$' }, null]) {
    const { data } = sanitizeVenueData({ name: 'Bar', price: bad });
    assert.strictEqual(data.price_level, null, `let ${JSON.stringify(bad)} through as a price level`);
  }
  assert.strictEqual(sanitizeVenueData({ name: 'Bar', price: ' $$$ ' }).data.price_level, 3, 'surrounding space is not a reason to drop a price');
  // The output still carries no `price` string of its own — one name per fact,
  // and no free-text display field a sender could put anything into.
  assert.strictEqual(sanitizeVenueData({ name: 'Bar', price: '$$' }).data.price, undefined);
});

test('a garbage price_level with no price alias is still dropped', () => {
  // The pre-existing rule this change must not weaken (utilAudit.test.js pins
  // it too): an out-of-range integer is not clamped into a plausible one.
  for (const bad of [99, -1, 5, 1e308, NaN]) {
    assert.strictEqual(sanitizeVenueData({ name: 'Bar', price_level: bad }).data.price_level, null, `price_level ${bad}`);
  }
});

// ─── 6. One definition of the auth token ─────────────────────────────────────

test('firebase.js does not keep its own copy of the auth-token key', () => {
  // It was the THIRD copy of a contract api.js owns, after userSettings.js was
  // consolidated onto it. api.js decides where the token lives and CLEARS that
  // key itself on a fatal auth failure, so a duplicate read is a place the two
  // can disagree about whether there is a session — and this one drives whether
  // a signed-in device ever registers for push at all.
  assert.ok(
    !/flockToken/.test(firebaseCode),
    "services/firebase.js still spells out 'flockToken'. api.js owns that name."
  );
  assert.match(
    firebaseCode, /import \{[^}]*getToken as getAuthToken[^}]*\} from '\.\/api'/,
    'services/firebase.js does not take the auth token from api.js'
  );
  // The VALUE, not a boolean. The push session watcher compares the current
  // token with the last one it handled to tell "already registered this
  // session" from "a different account is signed in now", and an account switch
  // in another tab never passes through a logged-out state for isLoggedIn() to
  // notice.
  assert.match(firebaseCode, /getAuthToken\(\)/, 'firebase.js imports the token reader but does not call it');
  assert.match(
    firebaseCode, /handledAuthToken === authToken/,
    'the session watcher stopped comparing token values; an account switch would no longer re-register this device'
  );
});
