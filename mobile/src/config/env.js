// Single source of truth for the API base URL.
//
// - Release / production builds ALWAYS use PROD — you cannot accidentally ship a
//   staging or LAN URL in a store build.
// - Debug (__DEV__) builds use DEV_API_URL when it's set, so you can point a dev
//   build at a local backend (your machine's LAN IP, e.g. http://192.168.1.20:5000)
//   or a Railway staging URL for end-to-end testing — without editing api.js.
const PROD_API_URL = 'https://flock-app-production.up.railway.app';

// For local/staging E2E only (debug builds). Leave null to use prod everywhere.
// e.g. 'https://flock-staging.up.railway.app'  or  'http://192.168.1.20:5000'
const DEV_API_URL = null;

export const API_URL =
  (typeof __DEV__ !== 'undefined' && __DEV__ && DEV_API_URL) ? DEV_API_URL : PROD_API_URL;
