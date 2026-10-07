// /api/demo-relay, the function's own URL. The website demo calls
// /relay/public/* (functions/_middleware.js), which runs the same handler.
import { demoRelay } from '../_lib/handlers.js';

export function onRequest(context) {
  return demoRelay(context.request, undefined, new URL(context.request.url).searchParams);
}
