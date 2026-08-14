# GEO / AI Search Readiness: flockcorp.com

Weighted heaviest in this audit. For a pre-launch consumer app with no domain authority and no backlink profile, being the answer when someone asks an assistant for "an app to plan things with friends" is worth more than a Google position it will not hold for a year.

## Score: 25/100 before fixes, 70/100 after

## O1. AI crawlers received an empty document: Critical. MITIGATED

This was measured, not assumed. Each of these user agents was issued a live request to `https://www.flockcorp.com/`:

| Crawler | Status | Body content |
|---|---|---|
| GPTBot | 200 | empty |
| OAI-SearchBot | 200 | empty |
| ChatGPT-User | 200 | empty |
| ClaudeBot | 200 | empty |
| Claude-User | 200 | empty |
| PerplexityBot | 200 | empty |
| Google-Extended | 200 | empty |
| Amazonbot | 200 | empty |
| Meta-ExternalAgent | 200 | empty |
| Bingbot | 200 | empty |

All ten received the identical 2880-byte CRA shell whose entire body is:
```html
<noscript>You need to enable JavaScript to run this app.</noscript><div id="root"></div>
```

None of these crawlers execute JavaScript. Googlebot does, and rendering the same URL through headless Chromium yields 818 words. So Google could see the site and answer engines could not. Every one of the 5,500 words of copy on this site was invisible to the channel that matters most.

**Mitigation applied in this pass**, both of which live in the raw HTML and need no JavaScript:

1. `frontend/public/llms.txt` created (4329 bytes, pure ASCII). It is not a link index. Because the rendered body is unreachable to these crawlers, the file carries the actual product description: what Flock does feature by feature, who it is for, the pricing model, a summary of each page, and a "Notes for answer engines" section that states the negative space (Flock is not a messaging app, not a calendar, not a bill splitter) and the two facts most likely to be got wrong (budget privacy, invite link format).
2. JSON-LD in `frontend/public/index.html`: `Organization`, `WebSite`, `WebApplication` with a `featureList` of eight shipping features and a price 0 `Offer`. This is in the static head, so it reaches a non-rendering crawler on every route.

**Not solved.** These two files describe the site; they are not the site. The complete fix is prerendering the seven marketing routes to static HTML at build time. See ACTION-PLAN Phase 2.

## O2. Zero structured data sitewide: High. FIXED (partially)

`grep 'application/ld+json|schema.org|itemprop'` across all of `frontend/` returned nothing before this pass. No Organization, no WebApplication, no FAQPage, no BreadcrumbList.

Now: one `@graph` with three site-level entities in `public/index.html`, validated as parsing JSON after the production build.

Deliberately excluded, and the reasoning is recorded in the file so nobody "improves" it later:
- **No `aggregateRating`, `ratingValue`, `reviewCount`, `userInteractionCount` or `downloadCount`.** Flock is pre-launch with roughly zero users. Inventing any of those is fabricated review markup and a manual-action risk.
- **No `sameAs` to the App Store.** Apple ID 6781442127 is real, but `https://apps.apple.com/app/id6781442127` returns HTTP 404 as of 2026-08-14 because the app is on TestFlight, not the store. `LandingPage.js:43` keeps `APP_STORE_LIVE = false` for exactly this reason and the badge correctly points at the waitlist anchor instead. Add `sameAs` in the same change that flips that flag.
- **`operatingSystem` stays generic.** Claiming iOS would outrun the shipping product.
- **No FAQPage.** It would be wrong in this file. `index.html` is the response for every route, so FAQPage here would claim `/privacy` and `/terms` carry the support questions. It belongs in `SupportPage.js`. See the handoff.

## O3. Passage-level citability

What an answer engine wants is a self-contained passage that answers a question without needing the surrounding page. The site has some genuinely strong material and it is in the wrong shape.

**Strongest citable passages that already exist:**
- `SupportPage.js:74-78`, "How does the budget feature stay anonymous?" with a specific, technical, non-generic answer. No competitor page can duplicate this because no competitor has the feature.
- `SupportPage.js:81`, "What happens when I tap SOS?"
- `AboutPage.js:63-75`, the crowd model description. Five numeric claims, all of which were checked against `backend/scripts/ml/models/model_metadata.json` and **all five hold**: 106 signals, 2,070,239 training rows, 31 cities, 419,320 holdout rows, 2.29 point realtime MAE improvement. This is the most citable content on the site and it is buried on the thinnest page.

**Why they do not currently get cited:**
- They are client-rendered, so no answer engine has ever read them (O1).
- Four of the seven support questions are phrased as statements, not questions: "I can't sign in.", "I'm not getting notifications.", "The map isn't showing my location.", "I want to report a bug or suggest a feature." Statement-shaped headings match query intent poorly.
- No FAQPage markup wraps any of them.

The `/about` crowd-model paragraph and the budget-anonymity answer are both summarised in `llms.txt`, which is the fastest available path to citability until prerendering lands.

## O4. Brand mention and entity signals: High, needs human action

There is nothing here to measure and that is the finding.

- No `sameAs` anywhere: no Instagram, no TikTok, no X, no LinkedIn, no GitHub, no Crunchbase. `grep` over `frontend/src/website/` for social domains returned only `mailto:` links.
- The only third-party credibility signal on the entire site is "Flock took 1st place at PA DECA States", which appears twice (`LandingPage.js:393`, `AboutPage.js:123`) with no year, no link, and no corroborating page an LLM could resolve.
- No Wikipedia, Wikidata, Crunchbase, Product Hunt or App Store entry exists to anchor "Flock" as an entity. "Flock" is also a heavily contested brand name, which makes disambiguation harder than usual.

An answer engine builds confidence in an entity from corroboration across independent sources. Flock currently has exactly one source: its own website. This is the highest-value remaining GEO work and almost all of it is human work, not code. See ACTION-PLAN human steps.

## O5. AI crawler policy now explicit: FIXED

`robots.txt` previously allowed every AI crawler by omission. It now names them in explicit groups and records the training-versus-citation distinction as a decision rather than an accident, with instructions for reversing only the training half.

One hazard is documented in the file: a named user-agent group **replaces** the `*` group for that crawler rather than stacking with it. Any future `Disallow` added to `*` will not reach the eleven named bots.
