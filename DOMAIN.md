# Making flockcorp.com live

Goal: everything lives at **flockcorp.com** — the site, the app, and the legal
pages — instead of `flock-app-w65m.vercel.app`.

---

## Read this first: you are not leaving Vercel

Vercel **is** the cloud host. "Getting off Vercel" and "getting a real domain" are
two different things, and only the second one is what you actually want.

- **Pointing flockcorp.com at Vercel** = 5 minutes of DNS, zero code changes,
  zero risk. Every URL becomes `flockcorp.com/...`. Vercel's name never appears
  in front of a user again.
- **Actually migrating hosts** (Netlify, Cloudflare Pages, a VPS) = rebuilding
  the deploy pipeline and re-entering every env var, days before an App Store
  submission, to end up with an identical website.

Do the first one. If you ever outgrow Vercel, migrating later is easy *because*
the domain is yours — you just re-point the same DNS.

---

## What the URLs become

| Now | After |
|---|---|
| flock-app-w65m.vercel.app/landing | **flockcorp.com** |
| flock-app-w65m.vercel.app/ (the app) | **flockcorp.com/app** |
| .../privacy | **flockcorp.com/privacy** |
| .../terms · /guidelines · /support · /delete-account | **flockcorp.com/terms**, etc. |
| — | **flockcorp.com/signup** (new — account creation) |

The marketing site is now the root. The app moved to `/app`. This does **not**
affect the iOS app: the Capacitor shell also boots at `/`, so the router
explicitly checks `window.Capacitor` and always starts the app there.

---

## Step 1 — Add the domain in Vercel (2 min)

1. Vercel → project **flock-app-w65m** → **Settings → Domains**.
2. Add `flockcorp.com`. Add `www.flockcorp.com` too and let Vercel redirect it
   to the apex (it offers this automatically).
3. Vercel will show you the exact DNS records it wants. Keep that tab open.

## Step 2 — Point DNS at Vercel (5 min, then wait)

In your registrar's DNS panel (wherever flockcorp.com is registered), add what
Vercel showed you. It is normally:

| Type | Name | Value |
|---|---|---|
| A | `@` | `76.76.21.21` |
| CNAME | `www` | `cname.vercel-dns.com` |

> **Use the values Vercel shows you, not these**, if they differ — Vercel
> occasionally changes them.

### While you're in DNS anyway: make hello@flockcorp.com real (5 min)
Resend can RECEIVE mail for this domain (verified available on the account,
receiving currently disabled). In the Resend dashboard → Domains →
flockcorp.com → enable **Receiving**, copy the inbound **MX record** it shows,
and add it at the registrar together with the records above. Once verified,
tell Claude — the site's contact email swaps from the noreply Gmail to
hello@flockcorp.com everywhere, and incoming mail is readable via the Resend
connector ("check the support inbox").

### Do not delete your email records
flockcorp.com already has **Resend** DNS records for sending mail. Touch only
the `A` / `CNAME` records above. Leave every `MX`, `TXT`, `SPF`, `DKIM`, and
`_dmarc` record exactly as it is, or outbound email breaks.

## Step 3 — Wait for propagation

Usually 10–60 minutes, occasionally a few hours. Vercel's Domains page shows a
green check when it's live and issues the HTTPS certificate automatically.

Check it yourself:
```
curl -s -o /dev/null -w "%{http_code}\n" https://flockcorp.com
curl -s -o /dev/null -w "%{http_code}\n" https://flockcorp.com/privacy
```
Both should print `200`.

## Step 4 — Flip the app's own links (after both return 200)

Only once the domain resolves:

1. **Railway** → backend service → Variables → add
   `PUBLIC_WEB_URL = https://flockcorp.com`
   That switches the NFC check-in redirect and the waitlist email logo over in
   one move — no code change needed.
2. **Vercel** → Settings → Environment Variables → set
   `REACT_APP_API_URL` only if you also move the backend to a subdomain
   (e.g. `api.flockcorp.com`). Not required.
3. Update the App Store Connect fields (`TESTFLIGHT_TEST_INFO.md`) to the
   flockcorp.com versions of the Privacy Policy and Marketing URLs.
4. **Google Sign-In — you must add the new origin yourself.** Google Identity
   Services refuses to render the "Continue with Google" button on any origin
   that isn't registered, so the button will silently 403 on flockcorp.com until
   you add it. Google Cloud Console → APIs & Services → Credentials → the OAuth
   2.0 Client ID `1012360079798-apa806ukb8dul36on3304tr9996c217s` → **Authorized
   JavaScript origins** → add `https://flockcorp.com` and
   `https://www.flockcorp.com`. Leave the existing Vercel origin in place. (Add
   the same two to **Authorized redirect URIs** only if you ever move off the
   button-based flow — the current one doesn't redirect.)
5. **CORS — already handled in code.** `https://flockcorp.com` and
   `https://www.flockcorp.com` are in the backend allowlist
   (`backend/server.js`). You just need the backend deployed with that change
   (it ships on your next push to `main`). Without it the app at
   flockcorp.com/app would load and then fail every single API call.

---

## Pre-flight checklist

- [ ] Domain added in Vercel, both apex and www
- [ ] A + CNAME records added at the registrar
- [ ] MX / TXT / DKIM / DMARC records untouched (test: send yourself a waitlist email)
- [ ] `https://flockcorp.com` returns 200
- [ ] `https://flockcorp.com/privacy` returns 200
- [x] `https://flockcorp.com` added to the backend CORS allowlist (done in code — just redeploy)
- [ ] `https://flockcorp.com` + `www` added to Google OAuth **Authorized JavaScript origins**
      (test: load flockcorp.com/app and confirm the Google button actually renders)
- [ ] `PUBLIC_WEB_URL` set on Railway
- [ ] App Store Connect URLs updated to flockcorp.com
