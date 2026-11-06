/**
 * THE SUPPORT ADDRESS, INSIDE A SENTENCE, AS SOMETHING TO USE.
 *
 * Inside the app its own words do not select (index.css, html.flock-app), and
 * several of them tell a person to write to us ("Email <the address> from it
 * and we will clear that", "Write to <the address> to link one"). Read off a
 * screen that cannot be copied from, the address had to be typed out by hand.
 * `withSupportAddress` draws every occurrence of it in such a sentence as a
 * mailto: link, whose long press keeps the Copy action (index.css lets a
 * mailto: link raise its callout), with the text itself on the allow-list
 * (.selectable) for a pointer. `{ link: false }` draws it as selectable text
 * only, for a sentence that names where mail comes FROM ("It comes from <the
 * address>") rather than asking for any.
 *
 * The address is not written out in this comment: ESLint's Flow rule reads a
 * file's first comment for an annotation, and an at sign followed by "flo"
 * there fails the production build as a malformed one.
 *
 * Anything that is not a string, or holds no address, comes back unchanged,
 * so a render site can hand it whatever it was printing before.
 */
import React from 'react';

export const SUPPORT_EMAIL = 'social@flockcorp.com';

export function withSupportAddress(text, { link = true } = {}) {
  if (typeof text !== 'string' || !text.includes(SUPPORT_EMAIL)) return text;
  const parts = text.split(SUPPORT_EMAIL);
  return (
    <>
      {parts.map((part, i) => (
        <React.Fragment key={i}>
          {i > 0 && (link ? (
            <a className="selectable" href={`mailto:${SUPPORT_EMAIL}`} style={{ color: 'inherit', textDecoration: 'underline' }}>{SUPPORT_EMAIL}</a>
          ) : (
            <span className="selectable">{SUPPORT_EMAIL}</span>
          ))}
          {part}
        </React.Fragment>
      ))}
    </>
  );
}

export default withSupportAddress;
