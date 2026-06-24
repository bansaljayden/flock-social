# Flock — Staging Setup & Verification (do this before prod)

Goal: prove the `submission-readiness` branch works against a real deployed
backend + a real device — WITHOUT touching prod. Only merge to `main` after the
checklist below passes on staging.

> The local E2E harness (`backend/scripts/e2e-local.js`, **32/32**) already proved
> the backend logic. Staging proves the *mobile* half + the deploy path.

## 1. Stand up a Railway staging service
- In Railway, create a **second service/environment** off the same repo, deployed
  from the `submission-readiness` branch (NOT `main`).
- Add a **separate Postgres** to it (a throwaway DB — never point staging at the
  prod database).

## 2. Bootstrap the staging DB (order matters!)
The harness proved migrations alone do NOT bootstrap a fresh DB — they only ADD
to existing core tables. So:
1. Apply the base schema first: run `backend/database/schema.sql` against the
   staging DB once (Railway's psql console, or `psql "$STAGING_DATABASE_URL" -f backend/database/schema.sql`).
2. Then deploy the branch — `server.js` `runMigrations()` adds the new columns/
   tables (moderation, age, etc.) idempotently on boot.

## 3. Staging env vars (Railway dashboard — never commit)
- `DATABASE_URL` = staging Postgres
- `JWT_SECRET` = any staging secret
- `NODE_ENV=production` (or staging), plus `GOOGLE_PLACES_API_KEY`, `RESEND_API_KEY`, etc. as needed for the features you'll test
- For image moderation testing: `OPENMODERATOR_API_KEY` + `IMAGE_MODERATION_REQUIRED=true`
- For Apple-deletion testing: `APPLE_TEAM_ID` (998W73654F), `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY` (.p8), `APPLE_CLIENT_ID=com.flockcorp.flock`, `APPLE_BUNDLE_ID=com.flockcorp.flock`

## 4. Seed the reviewer/demo account (also your manual test fixture)
Against the **staging** DATABASE_URL:
```
cd backend && DATABASE_URL="$STAGING_DATABASE_URL" node scripts/seed-review-account.js
```
Creates `review@flockcorp.com / ReviewPass123` + a `buddy` to block + a flock with
reportable messages. (Verified to run by the E2E harness.)

## 5. Point a dev Android build at staging
In `mobile/src/config/env.js`, set:
```js
const DEV_API_URL = 'https://<your-staging-service>.up.railway.app';
```
Debug builds will use it; release builds always use prod (can't ship staging by
accident). Then:
```
cd mobile && eas build --platform android --profile preview
```
(No Apple needed for Android. iOS parallels via `--platform ios --profile production`
now that the Apple membership is active.)

## 6. Walk the checklist on the device (mirrors the E2E harness)
- [ ] First launch → **age gate**; enter a < 13 DOB → blocked; restart, enter 20yo → in.
- [ ] Signup → **terms checkbox required** (can't continue unchecked); links open /terms + /guidelines.
- [ ] Create a flock, send a message; send `you piece of shit` → **rejected**.
- [ ] As the buddy, **report** a message (pick a reason) → confirmation.
- [ ] **Block** the buddy → their DMs rejected, their messages vanish from the flock; **unblock** → reappear.
- [ ] Log in as admin on web `/<staging>/admin/moderation` → see the report → **Hide** (message gone) / **Ban** (buddy locked out next request).
- [ ] Profile → **Delete account** → confirm; sign back in → fresh account (Apple reviewers test this exactly).
- [ ] `/<staging>/terms`, `/guidelines`, `/delete-account`, `/privacy`, `/support` all render.

## 7. Only then → prod
Once the checklist passes on staging, merge `submission-readiness` → `main`.
Railway auto-deploys prod; prod already has the core tables and gets the new
columns on boot (idempotent). Then proceed with the store submission steps in
`SUBMISSION.md`.
