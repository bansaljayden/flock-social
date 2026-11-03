// ---------------------------------------------------------------------------
// WHO CAN PUT AN ACCOUNT ON A PLAN, AND WHO FLOCK SUGGESTS IT TO (migration 133)
// ---------------------------------------------------------------------------
//
// Two choices an account makes in Settings, under "Invites and Quick Add":
//
//   invites_friends_only  TRUE: only an accepted friend can add the account to
//                         a plan or relay a plan invite to it. FALSE: any
//                         member of a plan can, which is how Flock worked
//                         before this file.
//   show_in_suggestions   TRUE: Flock may suggest the account to people who
//                         are not its friends (Quick Add, and the Suggested
//                         row on a new plan and a new message). FALSE: it is
//                         suggested to its friends only.
//
// NULL IN EITHER COLUMN MEANS "NEVER CHOSEN", AND THEN THE DEFAULT FOLLOWS THE
// ACCOUNT'S AGE. An account whose stored date of birth makes it under 18 reads
// as friends only and not suggested. Every other account, including the many
// with no date of birth at all (the iPhone app asks for none), reads as before:
// anyone on a plan can invite it and Quick Add can suggest it. Nothing writes a
// default into a row, so a date of birth added later moves the default with it
// and nobody's own choice is ever overwritten.
//
// THE RULE IS ENFORCED BY THE SERVER, in the statements that write an invite or
// list a suggestion, so a client that skips the switch changes nothing:
//
//   acceptsInvitesFromSql  POST /api/flocks (invited_user_ids), POST
//                          /api/flocks/:id/invite, POST /api/flocks/:id/rerun,
//                          and the flock_invite socket relay.
//   suggestableToSql       GET /api/friends/suggestions (both of its reads)
//                          and GET /api/users/suggested.
//
// A REFUSED INVITE LOOKS LIKE AN ID WITH NO ACCOUNT. The invite doors fold the
// predicate into the directory read they already make, so an account that
// takes invites from friends only is, to a stranger's invite, exactly an id
// nobody holds: skipped after the invite budget is charged, absent from the
// list of who was invited, no push, no socket event. That is the shape the
// blocked pair already has, and it tells the stranger nothing about the person
// or the setting.
//
// ONE DEFINITION FOR JAVASCRIPT AND SQL. knownMinor and knownMinorSql answer
// the same question, and __tests__/invitesAndSuggestions.test.js runs both on
// the same dates, the leap days included. The SQL compares the stored date of
// birth with the UTC calendar date 18 years ago; utils/age.js counts whole
// years against the UTC calendar date. For a calendar date those are the same
// test: under 18 exactly when the date of birth is later than the day 18
// years before today.

const { ageFromDob } = require('./age');

const ADULT_AGE = 18;

/** True only when a stored date of birth makes the account under 18 today. */
function knownMinor(dob, now = new Date()) {
  const age = ageFromDob(dob, now);
  return age !== null && age < ADULT_AGE;
}

/**
 * The two settings as they apply to an account now: its own choice, else the
 * default for its age. `row` carries invites_friends_only, show_in_suggestions
 * and date_of_birth.
 */
function effectiveSettings(row, now = new Date()) {
  const minor = knownMinor(row ? row.date_of_birth : null, now);
  const friendsOnly = typeof row?.invites_friends_only === 'boolean' ? row.invites_friends_only : minor;
  const suggested = typeof row?.show_in_suggestions === 'boolean' ? row.show_in_suggestions : !minor;
  return { invitesFrom: friendsOnly ? 'friends' : 'everyone', showInSuggestions: suggested };
}

// ---------------------------------------------------------------------------
// The SQL. Fragments, never statements, and nothing in them comes from a
// request: aliases and placeholders are route constants, checked anyway,
// because a fragment built by concatenation is the one construct here that
// could become an injection if somebody passed a value through.
// ---------------------------------------------------------------------------
const SQL_IDENTIFIER = /^[a-z_][a-z0-9_]*$/i;
const SQL_PLACEHOLDER = /^\$[1-9][0-9]*$/;
// The UTC calendar date, the "today" utils/age.js reads. A test may pass a
// bound date instead (`$4::date`), so a leap day can be checked on any day.
const UTC_TODAY_SQL = "(NOW() AT TIME ZONE 'UTC')::date";
const DATE_PLACEHOLDER = /^\$[1-9][0-9]*::date$/;

function identifier(value, what) {
  if (typeof value !== 'string' || !SQL_IDENTIFIER.test(value)) {
    throw new Error(`invitesAndSuggestions: ${what} must be a bare SQL identifier`);
  }
  return value;
}

function placeholder(value, what) {
  if (typeof value !== 'string' || !SQL_PLACEHOLDER.test(value)) {
    throw new Error(`invitesAndSuggestions: ${what} must be a bind placeholder like "$2"`);
  }
  return value;
}

function today(value) {
  if (value === undefined) return UTC_TODAY_SQL;
  if (typeof value !== 'string' || !DATE_PLACEHOLDER.test(value)) {
    throw new Error('invitesAndSuggestions: today must be a bound date like "$4::date"');
  }
  return value;
}

/** TRUE when `alias`'s stored date of birth makes it under 18, FALSE otherwise (never NULL). */
function knownMinorSql(alias, { asOf } = {}) {
  const a = identifier(alias, 'alias');
  return `(${a}.date_of_birth IS NOT NULL AND ${a}.date_of_birth > (${today(asOf)} - INTERVAL '18 years'))`;
}

/** The account's choice, else the default for its age. Never NULL. */
function invitesFriendsOnlySql(alias, opts) {
  const a = identifier(alias, 'alias');
  return `COALESCE(${a}.invites_friends_only, ${knownMinorSql(a, opts)})`;
}

/** The account's choice, else the default for its age. Never NULL. */
function showInSuggestionsSql(alias, opts) {
  const a = identifier(alias, 'alias');
  return `COALESCE(${a}.show_in_suggestions, NOT ${knownMinorSql(a, opts)})`;
}

// An accepted friendship between the account and the other person, in either
// direction. The alias inside is its own, so the fragment can sit in a
// statement that already joins friendships under another name.
function friendsWithSql(alias, other) {
  const a = identifier(alias, 'alias');
  const o = placeholder(other, 'other');
  return `EXISTS (SELECT 1 FROM friendships reach_f WHERE reach_f.status = 'accepted' AND ((reach_f.requester_id = ${o} AND reach_f.addressee_id = ${a}.id) OR (reach_f.requester_id = ${a}.id AND reach_f.addressee_id = ${o})))`;
}

/** May the person in `inviter` add the account `alias` to a plan? */
function acceptsInvitesFromSql(alias, inviter, opts) {
  return `(${invitesFriendsOnlySql(alias, opts)} IS NOT TRUE OR ${friendsWithSql(alias, inviter)})`;
}

/** May the account `alias` be suggested to the person in `viewer`? */
function suggestableToSql(alias, viewer, opts) {
  return `(${showInSuggestionsSql(alias, opts)} IS NOT FALSE OR ${friendsWithSql(alias, viewer)})`;
}

module.exports = {
  ADULT_AGE,
  knownMinor,
  effectiveSettings,
  knownMinorSql,
  invitesFriendsOnlySql,
  showInSuggestionsSql,
  acceptsInvitesFromSql,
  suggestableToSql,
};
