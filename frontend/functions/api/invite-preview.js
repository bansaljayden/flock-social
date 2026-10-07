// /api/invite-preview, the function's own URL. Preview bots reach the same
// handler through /i/<token> (functions/_middleware.js).
import { invitePreview } from '../_lib/handlers.js';

export function onRequest(context) {
  return invitePreview(context, undefined, new URL(context.request.url).searchParams);
}
