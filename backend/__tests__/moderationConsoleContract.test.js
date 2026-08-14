// Run: node --test  (from backend/)
//
// THE CONSOLE IS PART OF THE CONTRACT.
//
// backend/routes/moderation.js decides what a user may report, and
// backend/routes/admin.js decides what a moderator may then do about it. Neither
// of them is the screen. The screen is frontend/src/website/ModerationDashboard.js,
// it is a different file in a different build, and every time the server has
// grown a reportable type the console has been the last thing to hear about it:
//
//   venue_review / venue_promotion  reportable for rounds before the Hide button
//                                   rendered for either.
//   guest_rsvp                      hideable since migration 005; the console had
//                                   no entry for it, so an abusive guest name
//                                   broadcast to a whole flock had a report path
//                                   and no takedown button at the end of it.
//   venue_event                     added to both routers in round 20, absent
//                                   from the console on the same day.
//
// A report a moderator cannot see or cannot action is a Guideline 1.2 problem,
// and it looks exactly like a working queue. This test diffs the console's own
// maps against the server's, the same way safetyFlow.test.js diffs
// VALID_CONTENT_TYPES against the migration that has to allow it.
//
// No database, no rendering, no require of the routes themselves: three files
// read as text. The console is a browser module and the routers open a pg pool
// on import; neither side can load the other, which is the whole reason these
// lists drift.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const CONSOLE_FILE = path.join(__dirname, '..', '..', 'frontend', 'src', 'website', 'ModerationDashboard.js');
const ADMIN_FILE = path.join(__dirname, '..', 'routes', 'admin.js');
const MODERATION_FILE = path.join(__dirname, '..', 'routes', 'moderation.js');

const consoleSrc = fs.readFileSync(CONSOLE_FILE, 'utf8');
const adminSrc = fs.readFileSync(ADMIN_FILE, 'utf8');
const moderationSrc = fs.readFileSync(MODERATION_FILE, 'utf8');

// The authoritative list of what a user may report.
const VALID_CONTENT_TYPES = (() => {
  const m = /const VALID_CONTENT_TYPES = \[([^\]]*)\]/.exec(moderationSrc);
  assert.ok(m, 'VALID_CONTENT_TYPES not found in routes/moderation.js — this test needs updating.');
  const types = [...m[1].matchAll(/'([^']+)'/g)].map((q) => q[1]);
  assert.ok(types.length >= 6, 'Parsed a suspiciously short VALID_CONTENT_TYPES; the parser is wrong, not the code.');
  return types;
})();

// `const NAME = { ... };` reduced to its TOP-LEVEL entries only, with comments
// and string bodies removed, so nested keys (TAKEDOWN_TARGETS values are
// objects) and prose in comments cannot be mistaken for entries.
function topLevelEntries(src, name, file) {
  const head = `const ${name} = {`;
  const start = src.indexOf(head);
  assert.notStrictEqual(start, -1, `${name} not found in ${file} — it was renamed or removed, and this drift guard went with it.`);
  const body = src
    .slice(start + head.length - 1)
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/'[^']*'|"[^"]*"|`[^`]*`/g, "''");
  let depth = 0;
  let kept = '';
  for (const ch of body) {
    if (ch === '{') { depth += 1; if (depth === 1) continue; }
    else if (ch === '}') { depth -= 1; if (depth === 0) break; }
    if (depth === 1 && ch !== '{' && ch !== '}') kept += ch;
  }
  assert.notStrictEqual(depth, 1, `${name} in ${file} is never closed; this parser needs updating.`);
  return kept;
}

function objectKeys(src, name, file) {
  return [...topLevelEntries(src, name, file).matchAll(/(\w+)\s*:/g)].map((m) => m[1]);
}

// HIDEABLE maps type -> boolean, and the booleans carry the meaning.
function hideableMap() {
  const entries = topLevelEntries(consoleSrc, 'HIDEABLE', 'ModerationDashboard.js');
  const map = {};
  for (const m of entries.matchAll(/(\w+)\s*:\s*(true|false)/g)) map[m[1]] = m[2] === 'true';
  return map;
}

test('every reportable content type has a human-readable name in the console', () => {
  const labelled = objectKeys(consoleSrc, 'TYPE_LABEL', 'ModerationDashboard.js');
  for (const type of VALID_CONTENT_TYPES) {
    assert.ok(
      labelled.includes(type),
      `TYPE_LABEL is missing "${type}". A moderator sees the raw column value on the card and in the audit log.`
    );
  }
});

test('the console offers a takedown for exactly the types the server can take down', () => {
  const serverHideable = objectKeys(adminSrc, 'TAKEDOWN_TARGETS', 'routes/admin.js');
  const hideable = hideableMap();

  for (const type of serverHideable) {
    assert.strictEqual(
      hideable[type], true,
      `HIDEABLE.${type} is not true, so the Hide button never renders — but PUT /api/admin/reports/:id hides ${type} content. That report cannot be actioned from the console.`
    );
  }
  for (const [type, canHide] of Object.entries(hideable)) {
    if (!canHide) continue;
    assert.ok(
      serverHideable.includes(type),
      `HIDEABLE.${type} is true but there is no TAKEDOWN_TARGETS entry for it, so the Hide button can only ever produce a refusal. Dead controls are worse than absent ones on this screen.`
    );
  }
  // Every reportable type must have an opinion recorded, not be absent by
  // accident. 'profile' is the one deliberate false: there is no row to hide.
  for (const type of VALID_CONTENT_TYPES) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(hideable, type),
      `HIDEABLE has no entry for "${type}". Add it: true if routes/admin.js can hide it, false with a reason if it cannot.`
    );
  }
  assert.strictEqual(hideable.profile, false, 'A profile report has no content row; the server refuses to hide one.');
});

test('the console renders the evidence the queue sends', () => {
  // Each column the queue query adds for the moderator's benefit is worthless if
  // the card never reads it. This is the failure the whole change exists to fix:
  // a report arrived describing nothing.
  for (const field of [
    'content_excerpt', 'content_excerpt_clipped', 'content_has_image',
    'content_image_url', 'content_image_deferred', 'content_is_hidden', 'content_missing',
  ]) {
    assert.ok(adminSrc.includes(`AS ${field}`), `GET /api/admin/reports no longer selects ${field}; this test is out of date.`);
    assert.ok(
      consoleSrc.includes(field),
      `ModerationDashboard.js never reads ${field}, so the queue is describing the reported content to nobody.`
    );
  }
});

test('the deferred image is fetched with the admin token, not hung off an <img> src', () => {
  assert.ok(
    /GET \/api\/admin\/reports\/:id\/image|router\.get\('\/reports\/:id\/image'/.test(adminSrc),
    'The per-report image endpoint is gone from routes/admin.js.'
  );
  // The whole admin router is behind a Bearer token, so a browser image request
  // (which carries no Authorization header) 401s and paints a broken icon.
  assert.ok(
    /adminFetch\(`\/api\/admin\/reports\/\$\{[^}]+\}\/image`\)/.test(consoleSrc),
    'The console must fetch the reported image through adminFetch, which sends the Authorization header.'
  );
  assert.ok(
    !/<img[^>]*src=\{`\$\{BASE_URL\}\/api\/admin/.test(consoleSrc),
    'An <img> pointed at the admin router sends no Authorization header and will 401.'
  );
});
