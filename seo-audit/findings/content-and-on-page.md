# Content Quality and On-Page SEO: flockcorp.com

Content Quality score: 70/100. On-Page score: 62/100. Neither moved in this pass, because every fix lives under `frontend/src/`, which this audit does not own. All of it is specified in `HANDOFF-frontend-src.md`.

## Measured inventory

Rendered through headless Chromium, since raw HTML is empty.

| URL | Words | h1 | JSON-LD | Internal links out | Unique description |
|---|---|---|---|---|---|
| `/` | 818 | `Plans die in the group chat. Flock is where they happen.` | 0 | 11 | yes |
| `/about` | 513 | `What Flock is` | 0 | 2 | **no** |
| `/support` | 393 | `Support` | 0 | 3 | **no** |
| `/privacy` | 3195 | `Privacy Policy` | 0 | 6 | **no** |
| `/terms` | 700 | `Terms of Service & EULA` | 0 | 5 | **no** |
| `/guidelines` | 529 | `Community Guidelines` | 0 | 1 | **no** |
| `/delete-account` | 489 | `Delete your Flock account` | 0 | 2 | **no** |

Total indexable corpus: roughly 5,500 words across 7 URLs, and 58% of it is the privacy policy.

## Content Quality

### What is genuinely good

The copy is the strongest asset this site has, and it is unusual. Checked against the full SLOP-AUDIT banned-register list, the shipping copy contains **zero** instances of `seamless`, `effortless`, `empower`, `unlock`, `elevate`, `revolutionize`, `leverage`, `cutting-edge`, `robust`, `streamline`, `supercharge` or `personalize your experience`. Zero em dashes in user-visible text. Zero emoji used as icons. Zero fake testimonials, zero fabricated user counts, no purple gradients, no scroll-reveal animations, no builder badge.

The source comments show this is actively maintained rather than accidental: `LandingPage.js:698-704` records deleting an entire six-card feature grid on the grounds that "a page that says the same six things four times is not thorough, it is unsure". That is the opposite of AI slop.

### E-E-A-T

**Experience and Expertise: strong but buried.** `AboutPage.js:63-75` describes the crowd model with five numeric claims. All five were verified against `backend/scripts/ml/models/model_metadata.json`: 106 features, 2,070,239 training rows, 31 cities, 419,320 holdout rows, 2.29 point realtime MAE improvement. Every one holds. This is real, specific, verifiable expertise and it sits on the site's thinnest page with no image and no author markup.

**Authoritativeness: near zero, and this is the ceiling on everything.** The only third-party credential is "1st place at PA DECA States", stated twice with no year and no link. No social profiles exist anywhere in the source. No App Store listing (404 as of 2026-08-14), no Product Hunt, no Crunchbase, no press. See `findings/geo.md` O4.

**Trustworthiness: mostly strong, with one contradiction.** The privacy policy is substantial and names 15 subprocessors by name. The terms have 11 numbered sections. A real human byline appears at `LandingPage.js:897`. Against that, six places across four files say "we", "our team", or "we triage every week", while `AboutPage.js:122-123` says "a student founder". Handoff item 2.

### Thin content

`/about` (513 words) and `/support` (393 words) are thin for their intent. `/about` is the page an answer engine is most likely to want and it is six paragraphs.

### The gap that matters most

There is no blog, no comparison page, no glossary, no location page. For a query like "how to plan a night out with friends" or "app to decide where to go with friends" there is nothing on this domain to rank. The entire site is product and legal pages. That is a content strategy decision, not a defect, and it is the right decision until launch, but it should be a decision.

## On-Page SEO

### Titles

Unique per route after hydration, identical in raw HTML. `document.title` is set in a `useEffect` in all seven files, so Googlebot resolves unique titles and no non-rendering crawler ever does.

Two defects: the delimiter is inconsistent (`|` on `/`, `·` on the six subpages), and subpage titles are thin. `About · Flock` is 13 characters with no topic token.

### Meta descriptions

**Six of seven pages inherit the homepage description.** Only `LandingPage.js:241-242` writes one. `/privacy` currently describes itself as "Vote on where to go, see how busy it is before you leave, and split the bill after." Handoff item 3.

A related inconsistency: the homepage itself has two different descriptions depending on whether JavaScript ran, the static one in `public/index.html` and the one at `LandingPage.js:242`. Pick one.

### Open Graph

No route sets its own OG tags, so sharing `/about` or `/privacy` shows the homepage card. Invite links are the exception and are correctly handled by `api/invite-preview.js`.

### Headings

Clean. Every page has exactly one h1 and there are no level skips anywhere, which is rarer than it should be. Verified across all seven files. The only weakness is SEO rather than structure: `Support`, `Privacy Policy` and `Community Guidelines` carry no brand or topic modifier.

### Internal linking

The weakest on-page area. The landing page footer is the only full navigation on the site; the six subpages emit between zero and three internal links each, and `CommunityGuidelines.js` emits exactly one. Five of those links point at `/landing`, a non-canonical duplicate of the homepage. Handoff items 4 and 6.

Positively: every link on the site is a real `<a href>`. There are no onClick-only pseudo-links, and the landing menu panel stays in the DOM with only a CSS class toggling visibility, so a crawler sees all six menu links.

### Canonicals

Correct, and solved in an unusual way worth preserving. There is no `<link rel=canonical>` in the shared `index.html`, because a static one would point `/about`, `/privacy` and `/terms` at the homepage. Canonicals are instead served per route as HTTP `Link` headers from `vercel.json`. Verified live on all seven URLs.
