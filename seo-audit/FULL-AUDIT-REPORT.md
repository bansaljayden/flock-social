# SEO Audit: www.flockcorp.com

**Audited** 2026-08-14
**Business type** Pre-launch consumer app (social planning / group coordination), audience 15 to 22, free to users with a venue-side B2B model
**Pages in scope** 7 indexable URLs from `sitemap.xml`, plus header and preview testing on the noindex app and invite routes

## SEO Health Score: 74 / 100

Was **60 / 100** before the fixes applied in this pass.

| Category | Weight | Before | After |
|---|---|---|---|
| Technical SEO | 22% | 78 | **84** |
| Content Quality | 23% | 70 | 70 |
| On-Page SEO | 20% | 62 | 62 |
| Schema / Structured Data | 10% | 0 | **75** |
| Performance (CWV) | 10% | 80 | 80 |
| AI Search Readiness | 10% | 25 | **70** |
| Images | 5% | 82 | 82 |

Content Quality and On-Page did not move because every fix in those categories lives under `frontend/src/`, which this pass did not own. All of it is specified file-by-file and line-by-line in `HANDOFF-frontend-src.md`.

---

## Executive summary

This is a well-built site with one architectural blind spot that happens to sit exactly where this business needs to be seen.

The engineering here is better than most sites of this size. Canonicals are served as per-route HTTP `Link` headers rather than a single static tag that would have collapsed all seven pages onto the homepage. Private routes use `X-Robots-Tag: noindex` instead of a `robots.txt` `Disallow`, which is the right call and preserves the link previews that are the entire growth channel. Every page has exactly one h1 with no heading-level skips. Every link is a real anchor. The copy contains zero em dashes, zero banned marketing register, and no fabricated numbers. Decisions are documented inline in the files, with the measurement that justified them.

The blind spot: **flockcorp.com is a client-rendered React app, so the HTML body served to every crawler is empty.** Googlebot renders JavaScript and is fine. AI crawlers do not. Ten of them were tested live and all ten received an identical 2880-byte document containing one title, one meta description, and nothing else.

For a pre-launch consumer app with no backlinks and no domain authority, being the answer when someone asks an assistant for a way to plan things with friends is worth more than a Google position it will not hold for a year. That channel was receiving an empty page.

### The five findings that matter

1. **AI crawlers saw nothing.** GPTBot, OAI-SearchBot, ChatGPT-User, ClaudeBot, Claude-User, PerplexityBot, Google-Extended, Amazonbot, Meta-ExternalAgent and Bingbot were each issued a live request. All returned HTTP 200 with an empty body. Mitigated in this pass by `llms.txt` and static JSON-LD; the root cause needs prerendering.

2. **The homepage claims two features that are not built.** `LandingPage.js:792` claims promoted placement in vote lists and `:794` claims slow-night push offers. Both are on the **Not built** list in `CLAUDE.md` and both are Boost-tier features in `backend/routes/venueDashboard.js:38`. They sit in a card whose CTA is a sales `mailto:`. This is an accuracy failure, not an SEO one, and it outranks everything else in this report.

3. **Zero structured data existed anywhere.** Nothing told a search or answer engine what Flock is, who makes it, or that it costs nothing. Fixed at site level in this pass.

4. **Six of seven pages inherited the homepage meta description.** `/privacy` described itself to searchers as being about voting on bars and splitting bills.

5. **The site says "we" and "our team" in six places across four files**, while `/about` says a solo student founder. Two of those are moderation-response commitments an App Store reviewer will read.

### The thing that was most at risk, and is fine

Invite links were flagged going in as the most expensive possible defect, on the reasoning that an invite previewing as generic site chrome in iMessage would be worse than any ranking problem. **It was tested directly rather than assumed, and it works.**

`https://www.flockcorp.com/i/<token>` was requested with eight user agents. facebookexternalhit, Twitterbot, Slackbot, Discordbot, WhatsApp, Applebot and the real iMessage user agent all reached `/api/invite-preview` and received a purpose-built 3073-byte document. Chrome received the 2880-byte React app at the same URL. iMessage matches through the `facebookexternalhit` token in its user agent, so the coverage is real and not theoretical.

Reading the function against `backend/routes/guest.js` confirmed the success path produces `Sarah invited you to Friday Night Out` with the date, venue and going count, feeding `<title>`, `og:title`, `twitter:title` and the visible `<h1>` from the same string. The backend URL falls back to the live Railway origin when `REACT_APP_API_URL` is unset, which is the intended production configuration. Failures always return HTTP 200 with generic tags and are never cached, so a scraper can never poison a link. Every user-authored value is HTML-escaped. The two copies of the bot regex in `vercel.json` are byte-for-byte identical.

The only defect in this area was documentation: `public/index.html` still carried a comment saying the function did not exist. Corrected. `TASKS.md:274-279` still lists it as an open TODO and should be ticked.

---

## What was fixed in this pass

Files owned and changed:

| File | Change |
|---|---|
| `frontend/public/llms.txt` | **Created.** 4329 bytes, pure ASCII. Carries the full product description rather than a link index, because the rendered body is unreachable to the crawlers that read it. Includes a "Notes for answer engines" section stating what Flock is *not*, and the two facts most likely to be got wrong. |
| `frontend/public/index.html` | Added `Organization` + `WebSite` + `WebApplication` JSON-LD as one `@graph`. Rewrote the stale Open Graph comment block. |
| `frontend/public/robots.txt` | Named eleven AI crawlers in explicit groups, split into answer-time and training agents, with the reversal path and the group-precedence hazard documented. |
| `frontend/vercel.json` | Serves `/llms.txt` as `text/plain; charset=utf-8` with a 1 hour cache. |

Verified with `CI=true npm run build`. The JSON-LD parses in the built output and `llms.txt` is copied to `build/`.

**What was deliberately not put in the JSON-LD**, with the reasoning recorded in the file so nobody "improves" it later: no `aggregateRating`, `reviewCount`, `downloadCount` or `userInteractionCount`, because Flock is pre-launch and inventing those is fabricated review markup; no `sameAs` to the App Store, because `https://apps.apple.com/app/id6781442127` returns 404 today and `LandingPage.js:43` keeps `APP_STORE_LIVE = false` for the same reason; no iOS in `operatingSystem`, because the build is on TestFlight rather than the store; and no `FAQPage`, because `index.html` is the response for every route and it would claim `/privacy` carries the support questions.

---

## Evidence

Every claim in this report was measured against the live site. The method:

- Raw HTML fetched per route and per crawler user agent, headers captured.
- The same URLs rendered through headless Chromium via the skill's `render_page.py`, so the difference between what Googlebot sees and what an LLM crawler sees could be stated with evidence rather than assumed.
- Rendered HTML parsed for titles, descriptions, canonicals, heading trees, images, internal links, word counts and JSON-LD blocks.
- Image files read directly to verify declared dimensions.
- Numeric content claims cross-checked against the artifacts they describe.

Raw captures are in `raw/`. Category detail is in `findings/`.

**Notable verification:** the five numeric claims about the crowd model at `AboutPage.js:63-75` were checked against `backend/scripts/ml/models/model_metadata.json`. All five hold exactly: 106 features, 2,070,239 training rows, 31 cities, 419,320 holdout rows, 2.29 point realtime MAE improvement. This is real, specific, verifiable expertise and it is the most citable content Flock has. It is on the site's thinnest page, with no image and no schema.

---

## What could not be measured, and why

No paid API keys, no Google Cloud project and no domain verification were available.

- **Indexation status, impressions, click-through, and query data**: needs Google Search Console.
- **Field Core Web Vitals**: needs CrUX or PageSpeed Insights. The performance score here is inferred from asset weights and caching, not measured from real users, and should be treated as provisional.
- **Keyword volumes, SERP positions, backlink profiles, competitor gaps**: need DataForSEO, Moz or Ahrefs.
- **Competitor comparison**: not attempted. Without SERP data it would be guesswork.

These are listed as human steps H1 through H9 in `ACTION-PLAN.md`, each written so it can be actioned without further research.

---

## Reading order

1. `ACTION-PLAN.md`: prioritised phases and the nine human steps.
2. `HANDOFF-frontend-src.md`: every fix that lives under `frontend/src/`, by file and line. This is the document for whoever owns those files.
3. `findings/technical.md`: crawlability, headers, and the full invite preview verification.
4. `findings/geo.md`: AI crawler evidence, citability, entity signals.
5. `findings/content-and-on-page.md`: E-E-A-T, thin content, meta, internal linking.
6. `findings/schema-performance-images.md`: structured data, asset weights, image audit.
7. `audit-data.json`: the same findings structured for report generation.
