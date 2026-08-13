# TestFlight Test Information — paste-ready values

> Why: Build 15 (ec16dea7) processed fine but Codemagic's auto-submit to external
> beta review failed — ASC's Test Information page was never filled. Fill once at
> https://appstoreconnect.apple.com/apps/6781442127/testflight/test-info and every
> future build auto-submits cleanly. (Internal testers don't need this — check
> TestFlight on your phone regardless; the build may already be installable.)

## Beta App Information
- **Feedback Email:** bansaljayden@gmail.com
- **Beta App Description (suggested):**
  Flock helps you and your friends actually make plans. Create a flock, invite
  your people, vote on where to go, match budgets anonymously, and lock it in.
  This beta includes the redesigned interface, live crowd levels for venues,
  and the new plans calendar.
- **Marketing URL (optional):** https://flock-app-w65m.vercel.app/landing
- **Privacy Policy URL:** https://flock-app-w65m.vercel.app/privacy  ← verified 200
  > Use the Vercel domain, NOT flockcorp.com. `flockcorp.com` has no DNS pointed
  > at the app (checked 2026-08-11: does not resolve). A privacy-policy URL that
  > doesn't load is an automatic App Store rejection. Switch these to
  > flockcorp.com only after DNS is pointed at Vercel and both URLs return 200.

## Beta App Review Information
- **First Name:** Jayden
- **Last Name:** Bansal
- **Email:** bansaljayden@gmail.com
- **Phone:** ← fill in (required by Apple; not stored anywhere in this repo)

## Review notes (suggested)
Demo account for review, if asked: create via in-app signup (age gate requires
DOB 13+, and the signup screen links Terms, Privacy Policy, and Community
Guidelines).

Report a message (single TAP, there is no long-press gesture in this app):
single-tap the body of a message someone else sent, meaning a grey bubble on
the left, in either a flock chat or a DM. A row appears at the bubble with
four emoji, a reply arrow, and a red flag at the right end. Tap the red flag
to open the Report and Block sheet, tap "Report this message", pick a reason,
tap "Submit report". Your own messages (blue, on the right) do not offer
Report. A DM's three-dot menu also has "Report or block <name>".

Account deletion: Profile → Delete account.

## What Sign-In Information to provide
If the reviewer prompt asks for a demo login, create a fresh account first
(signup works without invite) or provide a test account you control. Do NOT
reuse your personal account credentials.
