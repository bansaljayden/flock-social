# Technical SEO: flockcorp.com

Audited 2026-08-14. Every claim below was measured against the live site, not inferred from source.

## Score: 78/100 before fixes, 84/100 after

## What works, and is worth not breaking

| Check | Result |
|---|---|
| HTTPS + HSTS | `Strict-Transport-Security: max-age=63072000` |
| Apex to www | 308 to `https://www.flockcorp.com`, www is canonical everywhere |
| Canonical | Served per route as an HTTP `Link: rel="canonical"` header from `vercel.json`. Correct and unusual. A single static `<link rel=canonical>` in the shared `index.html` would have pointed `/about`, `/privacy` and `/terms` at the homepage and dropped them from the index. |
| Security headers | `X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options`, `CSP frame-ancestors`, `Permissions-Policy` all present on `/(.*)` |
| robots.txt | Valid, reachable, correct Sitemap directive |
| sitemap.xml | Valid XML, 7 URLs, all 200, all canonical-consistent, no `lastmod` theatre |
| Private routes | `/app`, `/signup`, `/admin`, `/i/` are `X-Robots-Tag: noindex` rather than `Disallow`. This is the right call and the reasoning in `robots.txt` is correct: a `Disallow` on `/i/` would kill the link previews that are the entire growth channel. |
| Compression | Brotli on HTML, JS and CSS |
| Static caching | `immutable, max-age=31536000` on `/static/*`, revalidating HTML |

## Findings

### T1. Soft 404s on every unknown URL: Medium
Evidence:
```
GET /nonexistent-page-xyz  ->  HTTP 200, 2880 bytes, <title>Flock | Plans that actually happen</title>
```
The catch-all rewrite `{"source": "/(.*)", "destination": "/index.html"}` in `vercel.json:239` returns HTTP 200 for every path that does not exist. `frontend/src/index.js:472` does set `document.title = 'Page not found | Flock'` client-side, but the status line stays 200.

Impact: any mistyped or stale inbound link becomes an indexable 200 page. Google classifies these as soft 404s and they consume crawl budget. Low urgency today because the site has almost no inbound links, and rising with every link that gets built.

Not fixed here. A real 404 status from a CRA SPA on Vercel needs a catch-all serverless function that returns 404 with the shell, which is a larger change than this audit's remit and touches the rendering path for every route. See ACTION-PLAN.md.

### T2. The site is invisible to crawlers that do not run JavaScript: High
Evidence. The raw HTML response body, for every route, is:
```html
<body><noscript>You need to enable JavaScript to run this app.</noscript><div id="root"></div></body>
```
Rendering the same URL through headless Chromium produces 818 words on `/` and a full heading tree. `render_page.py` reports `is_spa: true`, `mode_used: rendered`.

So the two questions have different answers, which is what was asked for:
- **Googlebot** renders JavaScript. It sees the full page, the per-route `<title>`, and the heading structure. Google is fine.
- **LLM and answer-engine crawlers do not render JavaScript.** GPTBot, OAI-SearchBot, ClaudeBot, Claude-User, PerplexityBot, Amazonbot and Meta-ExternalAgent were each served a live request and each received the identical 2880-byte shell with an empty body. Verified individually, all HTTP 200.

For those crawlers the entire knowable content of flockcorp.com was the `<title>` and one `<meta name="description">`. This is the single biggest finding in the audit and it lands squarely on the channel that matters most for a pre-launch consumer app.

Mitigated, not solved, by `public/llms.txt` (created in this pass) and by the JSON-LD added to `public/index.html`, both of which are in the raw HTML and therefore visible without JavaScript. The complete fix is prerendering or SSR for the marketing routes, which is a build-system decision. See ACTION-PLAN.md.

### T3. No llms.txt: High. FIXED
Before: `GET /llms.txt` returned HTTP 200 with the SPA shell, because the catch-all rewrite swallowed it. A crawler looking for the file got an HTML page pretending to be one.

After: `frontend/public/llms.txt` created, 4329 bytes, pure ASCII. `vercel.json` now serves it with `Content-Type: text/plain; charset=utf-8` and a 1 hour cache. Static files in `public/` take precedence over rewrites on Vercel, which is already proven live by `robots.txt` and `sitemap.xml` resolving correctly.

### T4. AI crawler policy was implicit: Medium. FIXED
`User-agent: * / Allow: /` did permit every AI crawler, but by omission rather than intent. `robots.txt` now names the answer-time agents (OAI-SearchBot, ChatGPT-User, Claude-User, Claude-SearchBot, PerplexityBot, Perplexity-User) and the training agents (GPTBot, ClaudeBot, Google-Extended, Applebot-Extended) in separate groups, with a comment recording that allowing training is a decision and how to reverse only that half.

One hazard is documented in the file and repeated here because it is easy to trip: **a named user-agent group replaces the `*` group for that crawler, it does not stack.** Any future `Disallow` added to `*` will not apply to the eleven named bots. Add it to every group or delete the groups.

### T5. Invite link previews: verified working, no defect found
This was flagged as the most expensive possible defect, so it was tested directly rather than assumed.

`https://www.flockcorp.com/i/<token>` was requested with eight user agents. Results:

| User agent | Bytes | Served by |
|---|---|---|
| facebookexternalhit, Twitterbot, Slackbot, Discordbot, WhatsApp, Applebot | 3073 | `/api/invite-preview` |
| Real iMessage UA (`...Safari/601.3.9 facebookexternalhit/1.1 Facebot Twitterbot/1.0`) | 3073 | `/api/invite-preview` |
| Chrome desktop (human) | 2880 | CRA shell |

The UA-conditional rewrite fires, humans still get the React app at the same URL, and iMessage matches through the `facebookexternalhit` token in its user agent string. The function returns a real document with a real anchor, no meta refresh.

The success path was verified by reading the code against `backend/routes/guest.js`:
- Title template `host + ' invited you to ' + name` at `frontend/api/invite-preview.js:285`, producing `Sarah invited you to Friday Night Out`.
- Description assembles `when`, venue and going count separated by a middot: `Fri, Aug 14 at 9:00 PM EDT - The Rooftop - 6 going`.
- The same string feeds `<title>`, `og:title`, `twitter:title` and the visible `<h1>`.
- Backend base URL is `process.env.REACT_APP_API_URL || 'https://flock-app-production.up.railway.app'` at line 148. **The variable is unset in Vercel and that is the intended configuration**; the hardcoded fallback is the live Railway backend, and it is the same fallback `frontend/src/services/api.js:1` and `GuestInvite.js:4` use. The success path fires in production today. The only way to break it is to *set* the variable to something wrong.
- 2500 ms abort, five enumerated fallback paths, all returning HTTP 200 with the generic tags so a scraper can never cache a failure.
- Successful previews are CDN-cacheable for 10 minutes with `Vary: User-Agent`; failures are `private, no-store`. Correct in both directions.
- `esc()` is applied to every user-authored value that reaches the document. Nothing reaches the output unescaped.
- The two copies of the bot regex in `vercel.json` (line 149 `missing`, line 234 `has`) are byte-for-byte identical. No drift.

The only defect found in this area was documentation: the comment block in `public/index.html` still claimed the function and the rewrite did not exist. Corrected in this pass. `TASKS.md:274-279` still lists the same function as an open TODO and should be ticked so nobody rebuilds it.

### T6. Duplicate raw-HTML title and description across all 7 indexable URLs: High
Every route ships the identical `<title>Flock | Plans that actually happen</title>` and the identical meta description in the raw response. React corrects the title per route after hydration, so Googlebot resolves unique titles, but no crawler that skips JavaScript ever does, and the meta description is never corrected on six of the seven pages at all.

This is an on-page finding with a technical cause. Detail and the exact fix per file is in `findings/on-page.md`; it needs edits under `frontend/src/`, which this pass does not own.
