// /api/apple-app-site-association, the function's own URL. Apple fetches
// /.well-known/apple-app-site-association, which is a static file in the
// build (scripts/build-cloudflare.js).
import { appSiteAssociation } from '../_lib/handlers.js';

export function onRequest(context) {
  return appSiteAssociation(context.request);
}
