// /api/marketing-page, the function's own URL (Vercel served every api/ file
// at /api/<name>). The middleware adds X-Robots-Tag: noindex here, as
// vercel.json:256-261 did.
import { marketingPage } from '../_lib/handlers.js';

export function onRequest(context) {
  return marketingPage(context.request, undefined, new URL(context.request.url).searchParams);
}
