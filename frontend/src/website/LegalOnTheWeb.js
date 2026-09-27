import React from 'react';

// WHAT /terms, /privacy AND /about ARE IN A BUILD THAT SELLS NOTHING.
//
// The App Store build is made with REACT_APP_PURCHASES=off
// (lib/purchasesBuild.js) and must carry no price and no purchase offer. The
// Terms price Roost and set out how Flock Pro is sold on flockcorp.com, and
// the Privacy Policy names where each plan is bought and who takes the
// payment. Those are disclosures, so they are not cut; that build does not
// carry a copy of either document and sends the reader to the published one
// instead, in the browser. That is where every legal link in the app already
// goes (the You tab, sign-in and sign-up all open flockcorp.com), so there is
// one text and it is always complete. The About page is handled the same way:
// it explains why venues pay, describes Roost and Flock Pro and invites venues
// to write in for early access, and the published page is the whole of it.
// index.js decides when this page stands in for the full one.
export const LEGAL_URLS = {
  terms: 'https://www.flockcorp.com/terms',
  privacy: 'https://www.flockcorp.com/privacy',
  about: 'https://www.flockcorp.com/about',
};

const TITLES = {
  terms: 'Terms of Service',
  privacy: 'Privacy Policy',
  about: 'About Flock',
};

// The subject of the sentence below, per page.
const NAMES = {
  terms: "Flock's Terms of Service",
  privacy: "Flock's Privacy Policy",
  about: 'The page about Flock',
};

export default function LegalOnTheWeb({ doc }) {
  const url = LEGAL_URLS[doc];
  const title = TITLES[doc];
  React.useEffect(() => {
    document.title = `${title} | Flock`;
  }, [title]);
  return (
    <main style={{ maxWidth: 560, margin: '0 auto', padding: '48px 16px', fontFamily: 'inherit', lineHeight: 1.5 }}>
      <h1 style={{ fontSize: 24, margin: '0 0 12px' }}>{title}</h1>
      <p style={{ margin: '0 0 16px' }}>
        {NAMES[doc]} is published at{' '}
        <a href={url} target="_blank" rel="noopener noreferrer">{url.replace('https://www.', '')}</a>.
        It opens in your browser, and it is the complete and current text.
      </p>
      <p style={{ margin: 0 }}>
        <a href="/">Back to Flock</a>
      </p>
    </main>
  );
}
