// Canonical public URLs for legal + support pages.
//
// NOTE: these point at the Vercel deployment, not flockcorp.com — the custom
// domain does not resolve to the web app yet (see project memory). Switch the
// BASE to https://flockcorp.com once DNS is pointed at Vercel.
const BASE = 'https://flock-app-w65m.vercel.app';

export const TERMS_URL = `${BASE}/terms`;
export const GUIDELINES_URL = `${BASE}/guidelines`;
export const PRIVACY_URL = `${BASE}/privacy`;
export const SUPPORT_URL = `${BASE}/support`;
export const DELETE_ACCOUNT_URL = `${BASE}/delete-account`;
export const SUPPORT_EMAIL = 'support@flockcorp.com';
