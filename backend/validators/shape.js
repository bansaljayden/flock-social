// ---------------------------------------------------------------------------
// SHAPE BEFORE CONTENT — the one definition, for every route.
//
// express-validator's validators COERCE a value before they test it, and
// coercion hides shape. validator.js stringifies a one-element array, so:
//
//     { "name":           ["<b>x</b>"] }  passes isLength({ min: 1, max: 60 })
//     { "status":         ["planning"]  }  passes isIn([...])
//     { "venue_latitude": ["1.5"]       }  passes isFloat()
//     { "crowd_level":    [2]           }  passes isInt({ min: 1, max: 3 })
//     { "guestToken":     ["<uuid>"]    }  passes isUUID()
//     { "image_url":      ["data:..."]  }  passes matches(/.../)
//
// A MULTI-element array gets through the same way whenever the joined string
// still satisfies the rule ("a,b" is 3 characters long), and an EMPTY array
// satisfies every length and range rule vacuously — so a `min: 1` field was
// never actually required.
//
// The value then STAYS an array in req.body, because sanitizers return
// non-strings untouched by design. That is two failures at once:
//
//   1. It walks straight past `stripHtml` and past `rejectIfProfane`
//      (utils/moderation.js `moderateText` returns allowed:true for a
//      non-string), so a field the route believed it had screened is stored
//      and re-broadcast with its markup and its slurs intact.
//   2. node-postgres serialises it as a Postgres array literal against a
//      scalar column, so the request comes back a 500 — "column is of type
//      character varying but expression is of type text[]", 22P02 on a numeric
//      or uuid column, 23514 on a CHECK — instead of a 400.
//
// The same family has two more members, checked at the same time:
//   * an OBJECT value, which coerces to "[object Object]" and can satisfy a
//     regex or a length rule the same way; and
//   * a NULL where the chain says `.optional()`, which in express-validator 7
//     skips ONLY `undefined`. A JSON null falls through to the validator and is
//     REFUSED — the failure mode that made routes/feedback.js 400 every honest
//     post-hangout submission the shipping client sent.
//
// This is the id-range guard's twin: settle the shape before anything else
// looks at the value, and let a bad shape be a 400 before any query runs.
//
// PROVENANCE: routes/flocks.js worked this out first and carries the original
// (longer) version of this note. This module is that pattern lifted out so the
// codebase has ONE spelling of the rule rather than one per router.
// routes/flocks.js still defines its own copy — it should import from here.
// ---------------------------------------------------------------------------

const { stripHtml } = require('../utils/sanitize');

// Arrays and objects only. `null` and `undefined` pass through to `.optional()`
// and the existing coercions, which already handle them — a shape guard that
// also decided optionality would be two rules wearing one name.
const isScalar = (v) => v === undefined || v === null || typeof v !== 'object';

// Per-field guard. Put it FIRST in the chain, so the rules after it are reading
// a value whose shape is already settled.
//
//   scalarOnly(body('status').optional(), 'status').isIn([...])
//
// A `.custom()` link DOES run for an empty array (verified against
// express-validator 7.3.1), so this closes the vacuous-`[]` case too — it does
// not need to be a separate gate in front of the chain.
const scalarOnly = (chain, label) => chain.custom(isScalar).withMessage(`Invalid ${label}`);

// `shape -> trim -> strip markup -> trim again`, as a reusable chain fragment,
// for any field a person types that is read back on a surface this route does
// not own.
//
// The trailing trim matters: stripping `<b> </b>` leaves a single space, which
// satisfies isLength({ min: 1 }) while being a blank value. Sanitize, then
// trim, then measure — measuring the PRE-sanitized string is how a 300-char
// value made of tags gets rejected while a real 300-char value that would
// overflow the column gets through.
const freeText = (chain, label) => scalarOnly(chain, label).trim().customSanitizer(stripHtml).trim();

// Whole-body gate, for a route on which EVERY body field is a single scalar and
// nothing it accepts is ever legitimately structured.
//
// Stronger than the per-field guard in exactly one way, and it is the reason
// routes/feedback.js uses it: the check is over every key PRESENT in the body
// rather than a hand-kept list, so a field added to the validator chain later —
// or a field with no validator at all — cannot silently reopen the hole. Unknown
// fields are ignored by the routes anyway, so refusing a structured one costs
// nothing.
//
// Do NOT reach for this on a route with a legitimate object or array field
// (messages' `venue_data`, billing's `customShares`, venueProfile's `goals` /
// `operatingHours` / `notificationPrefs`). Use scalarOnly per field there.
function requireScalarBody(req, res, next) {
  const body = req.body;
  // body-parser runs in strict mode, so this is an object or an array; either
  // way the validators below will answer for the missing required fields.
  if (body === null || body === undefined) return next();
  if (typeof body !== 'object') return next();
  for (const [field, value] of Object.entries(body)) {
    if (value !== null && typeof value === 'object') {
      return res.status(400).json({ error: `${field} must be a single value` });
    }
  }
  return next();
}

module.exports = { isScalar, scalarOnly, freeText, requireScalarBody };
