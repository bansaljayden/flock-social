# Flock Compliance Build — Adversarial Review (self-review)

The external Codex adversarial review couldn't run (the ChatGPT account has no
Codex model entitlement — auth works, the model allowlist is empty). This is the
honest substitute: a critical pass over the *design*, not just the code, grounded
in the bugs the local E2E harness actually caught.

## What is PROVEN vs ASSUMED
- **Backend: proven.** `backend/scripts/e2e-local.js` boots a real Postgres,
  applies schema + migrations, and exercises the endpoints over HTTP — **31/31**
  including age gate, content filter, report, mutual block + unblock, admin
  hide/ban, banned-can-still-delete, deletion cascade, and authz boundaries.
- **Mobile/UI: assumed.** Parse-checked only. The age screen, terms checkbox,
  report/block sheets, and DOB threading have NOT run on a device. First boot
  will surface render/runtime issues no static check catches. This is the single
  biggest unverified surface.

## Bugs the harness caught (would have shipped otherwise)
1. Fresh DB needs `schema.sql` before migrations — staging bootstrap order.
2. `flocks` schema drift (`venue_rating`/`venue_photo_url` in prod, not in VCS) →
   flock-create 500 on a fresh DB.
3. `/api/health` was 401-shadowed by the authenticated `/api` catch-all.
4. Banned users were 403'd on `DELETE /api/users/me` → couldn't exercise the
   right to erasure (Apple 5.1.1(v)/GDPR). Now deletion is exempt from the ban.
5. Mutual block didn't hide a blocked user's messages in a *shared flock* (only
   DMs). Now consistent across DMs, lists, and group flocks.

## Design choices challenged
- **Offline profanity filter (content-checker) as the text gate.** Cheap, sync,
  no API key — but it's a word-list + light intent check. It over-blocks (a teen
  saying "this is shit" is blocked) AND under-blocks (slurs via spacing/leetspeak,
  or objectionable content with no banned word). It satisfies "a filter exists"
  for review, not real moderation. The report→ban pipeline is the real backstop.
- **NSFW image pre-screening ≠ CSAM detection.** `isImageNSFW` catches porn/
  nudity, not child-safety material specifically. Defensible launch posture
  (NSFW filter + reporting + CSAE policy + NCMEC escalation), but do NOT describe
  it as "CSAM detection" anywhere. Already worded correctly in SUBMISSION.md.
- **Image moderation is fail-CLOSED but unconfigured.** Correct default, but in
  prod it only actually screens when `OPENMODERATOR_API_KEY` + `IMAGE_MODERATION_
  REQUIRED=true` are set. Until then it's allow-with-warning. Ship-blocker if
  forgotten — it's in the env checklist.
- **Age gate: device-local screen + server enforcement.** The device screen is
  bypassable (reinstall), so the server now recomputes age from the submitted DOB
  and 403s under-13 + stores it. Residual: enforcement is "when DOB present"; a
  hand-crafted client could omit DOB and the server wouldn't block. The mobile
  client always sends it, so the realistic path is covered, but a strict reading
  would *require* DOB at signup.
- **Ship v1.0 free, paywall deferred.** Right call (no usage data to price), and
  it dodges Apple 2.1. The entitlement gates are dormant scaffolding; they are
  UNTESTED beyond "isPremium returns false."
- **Single moderator + "prompt" (not 24-hr) SLA.** Honest, but a solo mod asleep
  at 3am means real latency. The report-alert (push/email) is the mitigation; it
  only works once a real admin device + email are wired.

## Known limitations / gaps (not fixed)
- **Socket live-block leak — MITIGATED client-side.** The server still broadcasts
  flock messages to all members (`io.to('flock:…').emit`), but FlockChatScreen now
  loads the user's block list on mount and drops incoming live messages from
  blocked senders (each side filters its OWN block list, which is exactly the
  direction mutual invisibility needs — so no server broadcast change and zero
  delivery risk to others). Server-side per-recipient emit remains a possible
  defense-in-depth hardening but is no longer needed for the user-visible leak.
  DMs were already safe (blocked sender rejected at send).
- **Mobile is unproven** (see above). Needs a build + the manual checklist.
- **content-checker word list is default/untuned** — expect false positives on
  normal teen slang; plan to tune or downgrade to flag-not-block post-launch.
- **No rate-limit on reports/blocks** beyond the global API limiter — a user
  could spam reports. Low priority at this scale; worth a per-user cap later.

## Assumptions the whole thing depends on
- The mobile client always runs the age gate before signup (so DOB is present).
- Railway prod already has the core tables (true) and will get the new columns on
  the next deploy of this branch (idempotent migrations on boot).
- An image-moderation provider key will be set before store submission.
- A real admin account + alert channel exist before launch so reports are acted on.

## Verdict
The compliance *backend* is genuinely working, not just written — and the
adversarial harness materially improved it (5 bugs). The remaining risk is
concentrated in two places: the **unproven mobile layer** (needs a build) and
**unconfigured external dependencies** (image-mod key, Apple revocation keys,
admin alert channel). Neither is a code-correctness problem; both are
deploy/wiring steps on the submission checklist.
