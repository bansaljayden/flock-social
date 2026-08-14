# Schema, Performance and Images: flockcorp.com

## Schema / Structured Data: 0/100 before, 75/100 after

### Before
`grep 'application/ld+json|schema.org|itemprop'` across all of `frontend/` returned nothing. Confirmed live: `render_page.py` reported `structured_data.block_count: 0` on the homepage.

### Added in this pass
One `@graph` in `frontend/public/index.html` containing `Organization`, `WebSite` and `WebApplication`, cross-referenced by `@id` anchored to the homepage so a crawler meeting it on `/privacy` still resolves one entity per type sitewide. Verified to survive the production build and parse as JSON.

Only site-level entities are in that file, because it is the response for every route. The reasoning and the editing rules are documented in the file itself.

### Deliberately excluded
- `aggregateRating`, `ratingValue`, `reviewCount`, `userInteractionCount`, `downloadCount`. Flock is pre-launch. Any of these would be fabricated review markup.
- `sameAs` to the App Store. Apple ID 6781442127 is real but `https://apps.apple.com/app/id6781442127` returns 404 today (verified live). Add it when `APP_STORE_LIVE` flips in `LandingPage.js:43`.
- iOS in `operatingSystem`. The build is on TestFlight, not the store.

### Still missing
- **FAQPage** on `/support`. Seven hand-written Q&A pairs, correctly structured as `<h3>` followed by `<p>`, with no markup. This is the single best remaining schema opportunity and it must be injected from `SupportPage.js`, not from `index.html`. Handoff item 5.
- **BreadcrumbList**. Low value on a flat 7-page site. Skip until there is depth.

## Performance: 80/100 (lab-inferred, no field data)

Measured live.

| Asset | Transfer | Encoding | Cache |
|---|---|---|---|
| `main.25940427.js` | 67.6 KB | brotli | `immutable, max-age=31536000` |
| `main.c7336c06.css` | 10.9 KB | brotli | `immutable, max-age=31536000` |
| `index.html` | 2.9 KB before, 5.5 KB after JSON-LD | brotli | `max-age=0, must-revalidate` |
| `og-image.png` | 107 KB | none | `max-age=86400, swr=604800` |

This is a well-behaved build. 67.6 KB brotli for the main bundle is small, the build is code-split into many small chunks, fonts are self-hosted rather than pulled from a CDN, and there is no analytics tag or third-party script in the head. Sentry and PostHog are dynamic imports that are not fetched unless their env keys are set. The deliberate decision not to preload the hero screenshot is documented in `public/index.html` and is correct: the LCP element was measured as the Fraunces h1 at all four tested widths.

**The one structural risk** is inherent to the architecture: this is a client-rendered SPA, so first paint waits on JavaScript download, parse and execute. No lab tool can tell you what that costs real users on real phones.

**Field data was not obtainable.** CrUX and PageSpeed Insights both need a Google API key, and Search Console needs domain verification. Neither is available in this environment. So the 80 here is inferred from asset weights and caching, not measured from users, and it should be treated as provisional until someone runs PageSpeed Insights against the live URL. That is a human step.

The head comment blocks in `index.html` ship to production (comments are not stripped by this build). The JSON-LD block added in this pass grew the shell from 2880 to 5539 bytes uncompressed. Most of that is comment text, which brotli compresses heavily, and it is consistent with the file's existing convention of documenting decisions inline.

## Images: 82/100

### What is right
- Every `<img>` in the marketing pages has an `alt` attribute. No missing-alt offenders.
- Decorative images correctly use `alt=""` with `aria-hidden="true"`. Six such images, all correct: the logo mark beside the word "Flock", and four section illustrations whose meaning is carried by the adjacent heading.
- The two content images have genuinely descriptive alt text, for example "The Flock home screen: tonight's status, your flocks, and a plan that needs votes."
- Intrinsic `width`/`height` on every marketing image, so no CLS from the marketing pages.
- WebP with PNG fallback via `<picture>` on the hero and the Birdie screenshot.
- `og-image.png` is genuinely 1200x630 as declared. Icons match their declared sizes: favicon.ico is a 3-image ICO, logo192 is 192, apple-touch-icon is 180, logo512 is 512. Verified by reading the files.

### Findings
- `components/ui/BirdieBird.js:641, 660, 680` set no intrinsic `width`/`height`. CLS is covered by an `aspectRatio` box reserved in the `WhenNear` `hold` prop, which works but is fragile.
- `LandingPage.js:582-588` is the only lazy image missing `decoding="async"` and `fetchPriority="low"`.
- Image filenames carry no keywords (`app-nest.png`, `mark-steps-400.png`). Image search will not surface these. Low priority for a pre-launch app.
- `/about`, the highest-intent page, has no image at all.
- **`frontend/public/screenshots/` ships roughly 2 MB of unreferenced legacy PNGs** (`discover.png` 455 KB, `crowd.png` 155 KB, `chat.png` 166 KB, `split.png` 111 KB, `home.png`, `messages.png`, `profile.png`, `confirmed.png`, `create.png`, plus `app-create.png` and `app-crowd.png`). Only `app-nest` and `app-birdie` have WebP siblings and appear to be the live pair. These are deployed but not served to anyone. Worth confirming they are unused and deleting them, but that is a repo hygiene call for the `src/` owners since some may be referenced from `App.js`.
