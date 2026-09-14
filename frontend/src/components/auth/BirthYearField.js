import React from 'react';

// The one place the age gate's input shape lives.
//
// WHY IT IS A COMPONENT AND NOT THREE COPIES. The signup screen was changed to
// ask for a year and the sign-in screen was not, which left a full-date field
// on an account-creation path under the exact guideline that had just been
// cited. The drift is the bug, so there is now one field and one derivation.
//
// WHY A YEAR. Guideline 5.1.1(v) allows asking only for what the app needs, and
// the app needs one fact: whether this person is old enough. A year answers it
// without collecting a birthday.
//
// WHY DECEMBER 31, which is the part to not "simplify". A year spans two
// possible ages, so an end has to be chosen, and the ends are not equivalent.
// January 1 treats everybody as the OLDER of the two and would let a
// twelve-year-old born late in the year through the floor in
// backend/utils/age.js. December 31 treats everybody as the YOUNGER and can
// only ever turn somebody away. A gate that protects children fails closed.
//
// The cost, stated rather than buried: somebody who has had their thirteenth
// birthday but was born earlier in the year reads as twelve until January, so
// the floor is effectively "turns fourteen this year".
//
// WHERE THIS MUST NOT BE USED: backfilling a date onto an account that already
// exists. enforceDobOnLogin in backend/routes/auth.js treats an under-13 answer
// as actual knowledge and its UPDATE is deliberately unguarded — it bumps
// token_version, revokes every session and starts a lockout, permanently.
// Rounding an honest account holder born in March down to December would end
// their account with no way back. A stranger refused at creation can come back
// tomorrow; that cannot be undone. The server says which case it is: a 403
// carrying dobGranularity:'year' is creation, and its ABSENCE means the full
// date.
export const birthYearToDob = (year) => (/^\d{4}$/.test(year) ? `${year}-12-31` : '');

// Digits only, at most four. Typing is filtered rather than validated after the
// fact so the field cannot hold something the derivation silently drops.
export const cleanBirthYear = (raw) => String(raw || '').replace(/\D/g, '').slice(0, 4);

// A plain numeric text input, NOT <input type="date">. Two reasons and the
// second is not cosmetic: it is a year, so a date picker is the wrong control,
// and the native date control sizes ITSELF — it ignores the width its siblings
// take and rendered wider than every other field on a short viewport, pushing
// out of the card in the screenshot that came back with a review.
const BirthYearField = ({ id, hintId, value, onChange, label = 'Year of birth', hint }) => (
  <div className="auth-field-row">
    <label className="auth-label" htmlFor={id}>{label}</label>
    <input
      id={id}
      className="auth-field"
      type="text"
      inputMode="numeric"
      pattern="[0-9]*"
      maxLength={4}
      placeholder="YYYY"
      value={value}
      onChange={(e) => onChange(cleanBirthYear(e.target.value))}
      autoComplete="bday-year"
      aria-describedby={hintId}
      required
    />
    {/* Says what the year is for and nothing else. The number this field used
        to print above itself was the part that taught a child which birthday to
        type instead, so the hint names no threshold. */}
    <p className="auth-hint" id={hintId}>{hint || 'We use this to check your age.'}</p>
  </div>
);

export default BirthYearField;
