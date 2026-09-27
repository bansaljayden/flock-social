import React from 'react';

// WHAT /terms AND /privacy ARE IN A BUILD THAT SELLS NOTHING.
//
// The App Store build is made with REACT_APP_PURCHASES=off
// (lib/purchasesBuild.js) and must carry no price and no purchase offer. The
// Terms price Roost and set out how Flock Pro is sold on flockcorp.com, and
// the Privacy Policy names where each plan is bought and who takes the
// payment. Those are disclosures, so they are not cut; that build does not
// carry a copy of either document and sends the reader to the published one
// instead, in the browser. That is where every legal link in the app already
// goes (the You tab, sign-in and sign-up all open flockcorp.com), so there is
// one text and it is always complete. index.js decides when this page stands
// in for the full one.
export const LEGAL_URLS = {
  terms: 'https://www.flockcorp.com/terms',
  privacy: 'https://www.flockcorp.com/privacy',
};

const TITLES = {
  terms: 'Terms of Service',
  privacy: 'Privacy Policy',
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
        Flock's {title} is published at{' '}
        <a href={url} target="_blank" rel="noopener noreferrer">{url.replace('https://www.', '')}</a>.
        It opens in your browser, and it is the complete and current text.
      </p>
      <p style={{ margin: 0 }}>
        <a href="/">Back to Flock</a>
      </p>
    </main>
  );
}
