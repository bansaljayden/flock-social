# Action Plan: flockcorp.com

Audited 2026-08-14. Health score **60/100 before this pass, 74/100 after**.

Priorities are weighted for a pre-launch consumer app whose growth channel is invite links pasted into group chats and whose most valuable search surface is an AI assistant, not a blue link.

---

## Already done in this pass

| # | Change | File |
|---|---|---|
| 1 | Created `llms.txt` with the full product description, not just a link index | `frontend/public/llms.txt` (new) |
| 2 | Added `Organization` + `WebSite` + `WebApplication` JSON-LD, no fabricated ratings or counts | `frontend/public/index.html` |
| 3 | Named every AI crawler explicitly and recorded the training-versus-citation decision | `frontend/public/robots.txt` |
| 4 | Served `llms.txt` as `text/plain; charset=utf-8` with a 1 hour cache | `frontend/vercel.json` |
| 5 | Corrected the stale comment block claiming the invite preview function did not exist | `frontend/public/index.html` |

Verified with `CI=true npm run build`. The JSON-LD parses in the built output and `llms.txt` is copied to `build/`.

---

## Phase 1: Critical fixes (this week)

**1.1. Delete the two unshipped venue feature claims from the homepage.**
`LandingPage.js:792` ("Show up in venue voting near you") and `:794` ("Put an offer up on a slow night") are both on the **Not built** list in `CLAUDE.md`. They sit in a card whose CTA is a sales `mailto:`. This is an accuracy failure, not an SEO one, and it outranks everything else here. Handoff item 1.

**1.2. Resolve "we're a small team" versus "a student founder".**
Six places across four files assert a headcount and a moderation SLA that do not exist, including two commitments an App Store reviewer will read. Handoff item 2.

**1.3. Give the six subpages their own meta descriptions.**
`/privacy` currently tells searchers it is about voting on bars and splitting bills. Copy is written and ready in Handoff item 3.

**1.4. Repoint the five `/landing` links at `/`.**
Five pages send their only outbound link to a non-canonical duplicate. One-line change in each of five files. Handoff item 4.

---

## Phase 2: High-impact (weeks 2 to 3)

**2.1. Prerender the seven marketing routes.**
This is the largest remaining item and it fixes the root cause of the biggest finding. Every AI crawler tested received an empty document because the site is client-rendered. `llms.txt` and the JSON-LD mitigate this; they do not solve it.

The cheapest path that does not change the stack: add a build-time prerender step that runs the existing headless Chromium over the seven sitemap URLs and writes static HTML per route. This also fixes the duplicate raw-HTML title and description in one move, and removes the `WhenNear` crawler risk in 2.4.

Note this is a build-system change and needs a decision from whoever owns the deploy. It does not require leaving CRA.

**2.2. Add FAQPage JSON-LD to `/support` and reword four headings.**
Seven real Q&A pairs already exist with no markup. Must be injected from `SupportPage.js`, not `index.html`. Handoff item 5.

**2.3. Extract the landing footer into a shared component and mount it on all seven routes.**
The six subpages currently emit between zero and three internal links each. Handoff item 6.

**2.4. Raise the `WhenNear` `rootMargin` or render the live demo's text unconditionally.**
Googlebot's renderer has `IntersectionObserver`, so the existing fallback does not protect this content. Handoff item 7.

---

## Phase 3: Content and authority (month 2)

**3.1. Thicken `/about`.**
It is 513 words, has no image, and carries the only verifiable proof points on the site. All five crowd-model numbers there were checked against `model_metadata.json` and hold. That paragraph is the most citable content Flock has and it deserves a real page.

**3.2. Decide whether Flock wants non-product content at all.**
There is currently nothing on this domain that could rank for "how to plan a night out with friends" or "app to decide where to go with friends". That is a defensible pre-launch choice, but it should be an explicit one. If yes, three or four genuinely useful pages beat twenty thin ones.

**3.3. Build entity corroboration.** See human steps below. This is the ceiling on all GEO work and almost none of it is code.

---

## Phase 4: Monitoring (ongoing)

**4.1.** Re-run this audit after prerendering lands, specifically re-testing the AI crawler user agents against the live site to confirm they now receive content.
**4.2.** Keep `llms.txt` in step with the landing page copy and `sitemap.xml`. It is a third place the product description lives.
**4.3.** If `PAYWALL_ENABLED` ever flips, four things change together: the landing pricing section, the `og:description` in `index.html`, the JSON-LD `Offer`, and `llms.txt`.
**4.4.** Tick `TASKS.md:274-279`. It still lists the invite preview function as an open TODO; the function exists and ships.

---

## Deferred with reasons

**Soft 404s.** Every unknown URL returns HTTP 200 with the SPA shell (`vercel.json:239` catch-all). Returning a real 404 needs a catch-all serverless function in the rendering path for every route, which is disproportionate today given the site has almost no inbound links. Revisit when link building starts, or fold it into the Phase 2.1 prerender work.

**BreadcrumbList schema.** No value on a flat 7-page site.

**Image filename keywords.** Real but low value pre-launch.

---

## Human steps that cannot be done from the repo

These need an account, a credential, a domain record, or a decision. Each is written so it can be actioned without further research.

| # | Step | Detail |
|---|---|---|
| H1 | **Verify the domain in Google Search Console** | Add `www.flockcorp.com` as a property, verify by DNS TXT record. Then submit `https://www.flockcorp.com/sitemap.xml`. Nothing in this audit could measure real indexation status, impressions or click-through without this, and no field Core Web Vitals data is obtainable either. This is the highest-value human step. |
| H2 | **Verify in Bing Webmaster Tools** | Bing powers ChatGPT's web search index. For a product whose GEO matters more than its Google position, this is not optional. Import from Search Console once H1 is done. |
| H3 | **Run PageSpeed Insights against the live URL** | The performance score in this audit is inferred from asset weights, not measured from users. PSI needs a Google API key or the public web UI. Run it on `/` and `/about`, mobile profile. |
| H4 | **Create the social profiles that `sameAs` needs** | The site has zero social presence in its source, and there is no third-party source an answer engine can use to corroborate that Flock exists. At minimum: Instagram and TikTok, given the 15 to 22 audience. Then add them to the JSON-LD `Organization.sameAs` in `public/index.html`. |
| H5 | **Publish the App Store listing, then wire it up** | `https://apps.apple.com/app/id6781442127` returns 404 today. When Apple approves: flip `APP_STORE_LIVE` to `true` in `LandingPage.js:43`, add the URL to `Organization.sameAs`, add a `MobileApplication` entity, and add iOS to `operatingSystem`. All four in one change. |
| H6 | **Decide the AI training question** | `robots.txt` now allows both answer-time crawlers and training crawlers, and says so explicitly. If Flock wants to be citable without being training data, disallow `GPTBot`, `ClaudeBot`, `Google-Extended` and `Applebot-Extended` and leave the rest. This is a business decision, and the current setting is the permissive one. |
| H7 | **Answer the provenance question on the bird illustrations** | SLOP-AUDIT Section M bans AI-generated photography. `LandingPage.js:117` describes "the two photographed birds", but no provenance is recorded anywhere in the repo for those cutouts or for the `mark-steps` / `mark-crowd` / `mark-money` illustrations. If any of them are generated, Section M is violated on the homepage. Only a human knows the answer. |
| H8 | **Add a year and a link to the DECA credential** | "1st place at PA DECA States" is the only third-party credibility signal on the site, and it appears twice with no year and nothing resolvable. |
| H9 | **Consider a Product Hunt or equivalent launch listing** | Entity corroboration. An answer engine needs more than one source before it will confidently name a product. |

## Not attempted

DataForSEO, Moz, and Ahrefs work (keyword volumes, real SERP positions, backlink profiles, competitor gaps) all require paid API keys that are not present. Google Search Console, PageSpeed Insights, CrUX field data and GA4 organic traffic all require a Google Cloud project or domain verification. Common Crawl domain metrics were not run. No competitor comparison was performed, because without SERP data it would be guesswork.
