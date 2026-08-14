# Handoff: SEO fixes that live under `frontend/src/`

This audit did not edit anything under `frontend/src/`. Everything below is a precise change request for whoever owns those files. Each item gives the file, the line, what is wrong, and what it should be.

Ordered by value. Items 1 and 2 are not really SEO; they are accuracy problems this audit found while reading the copy, and they outrank the SEO work.

---

## 1. CRITICAL, not SEO: the homepage claims two features that are not built

**File:** `frontend/src/website/LandingPage.js`
**Lines:** 792 and 794, inside the "For venues" pricing card whose CTA is a `mailto:` sales link.

```jsx
792   <li>Show up in venue voting near you</li>
793   <li>Post deals and events to nearby groups</li>
794   <li>Put an offer up on a slow night</li>
```

- Line 792 is **promoted placement in vote lists**. `backend/routes/venueDashboard.js:38` classes it as a Boost-tier feature and `CLAUDE.md` lists it under **Not built**.
- Line 794 is **slow-night push offers**. Same line in `venueDashboard.js`, also on the **Not built** list.
- Line 793 is fine. Promotions and events ship (`venueDashboard.js:63-89`).

This breaks SLOP-AUDIT design rule 5, "Never claim a feature that isn't in the shipping build", on the homepage, in a card that solicits sales enquiries. Note that `AboutPage.js` was already corrected for this exact class of problem (see the comment at `AboutPage.js:83-98`) and hedges at `AboutPage.js:113-114` with "Venue tools are in development". The landing card carries no such hedge.

**Fix:** delete lines 792 and 794, or move the card behind the same "in development" hedge `AboutPage.js` already uses.

---

## 2. HIGH: "we're a small team" versus "a student founder"

Two pages contradict each other, and the copy asserts a headcount and a response SLA that do not exist.

| File:line | Text |
|---|---|
| `SupportPage.js:25` | `We're a small team. We read every message.` |
| `SupportPage.js:90` | `We triage every week.` |
| `DeleteAccount.js:86-87` | `We action verified requests promptly.` |
| `TermsOfService.js:66-68` | `We act on reports of objectionable content and abusive behavior promptly...` |
| `CommunityGuidelines.js:115` | `Our team reviews reports and acts promptly...` |
| **versus** `AboutPage.js:122-123` | `Flock is built by Jayden Bansal, a student founder in Bethlehem, PA.` |

The last two are moderation-response commitments an App Store reviewer will read, so this is not only an E-E-A-T problem. Decide on one voice and apply it. "I read every message" is a stronger trust signal than "we're a small team" for a solo founder, and it is true.

---

## 3. HIGH: six of seven indexable pages inherit the homepage meta description

Only `LandingPage.js:241-242` writes a meta description. `/about`, `/support`, `/privacy`, `/terms`, `/guidelines` and `/delete-account` all ship with the homepage description from `public/index.html`, so `/privacy` currently describes itself to searchers as "Vote on where to go, see how busy it is before you leave, and split the bill after."

**Fix:** in the existing `useEffect` in each file, alongside the existing `document.title` write, add a description write using the same pattern as `LandingPage.js:241-242`. Suggested copy, each under 155 characters and none of it inventing anything:

| File | useEffect at | Suggested description |
|---|---|---|
| `AboutPage.js` | line 23 | `What Flock is, why group plans fall apart, how the crowd model works, and why venues pay while you never do.` |
| `SupportPage.js` | line 14 | `Answers on signing in, notifications, location, deleting your account, how budget matching stays private, and what happens when you tap SOS.` |
| `PrivacyPolicy.js` | line 35 | `What Flock collects, how location and anonymous budget data are handled, what venue sensors do and do not send, and how to get your data deleted.` |
| `TermsOfService.js` | line 9 | `The terms and EULA for using Flock: eligibility, acceptable use, user content, reporting and moderation, and how to contact us.` |
| `CommunityGuidelines.js` | line 15 | `What you may not post on Flock, our zero-tolerance child safety policy, how to report or block, and what happens after a report.` |
| `DeleteAccount.js` | line 10 | `How to delete your Flock account from inside the app or by email, and exactly what data is removed when you do.` |

While you are in there: the title delimiter is inconsistent. `/` and `/i/` use `|`; the six subpages use `·`. Pick one.

Subpage titles are also thin. `About · Flock` is 13 characters and contains no topic token. Consider `What Flock is | Group planning without the group chat · Flock` and similar, but do not stuff.

---

## 4. HIGH: five internal links point at `/landing`, a non-canonical duplicate

`/landing` serves the homepage (`src/index.js:567`) and `vercel.json` canonicalises it to `/`. It will not be indexed, which is correct, but five pages send their only outbound link there.

Change `/landing` to `/` at:
- `SupportPage.js:19` and `SupportPage.js:104`
- `PrivacyPolicy.js:107`
- `TermsOfService.js:16`
- `CommunityGuidelines.js:22`
- `DeleteAccount.js:25`

`AboutPage.js:28` and `AboutPage.js:130` already use `/` correctly. Match those.

---

## 5. HIGH: add FAQPage JSON-LD to the support page, and reword four headings

`SupportPage.js` has a hand-written 7-question FAQ where every question is an `<h3>` immediately followed by a `<p>`. This is the best structured-data opportunity on the site and the best LLM-citable content, and it has no markup.

Do **not** put this in `public/index.html`. That file is the response for every route, so a FAQPage there would claim `/privacy` and `/terms` carry these questions. Inject it from `SupportPage.js` (append a `<script type="application/ld+json">` to `document.head` in the existing `useEffect` and remove it on cleanup).

First, reword the four statement-shaped headings so they match query intent:

| Line | Current | Suggested |
|---|---|---|
| 44 | `I can't sign in.` | `Why can't I sign in to Flock?` |
| 51 | `I'm not getting notifications.` | `Why am I not getting Flock notifications?` |
| 58 | `The map isn't showing my location.` | `Why isn't the map showing my location?` |
| 87 | `I want to report a bug or suggest a feature.` | `How do I report a bug or suggest a feature?` |

These three are already correctly shaped and are the strongest passages on the site. Leave them:
- 64 `How do I delete my account?`
- 74 `How does the budget feature stay anonymous?`
- 81 `What happens when I tap SOS?`

---

## 6. MEDIUM: no navigation on any subpage

The six legal and marketing pages emit between zero and three internal links each. `CommunityGuidelines.js` emits exactly one. There is no shared footer component; the only full navigation on the site is the landing page footer at `LandingPage.js:862-899`.

Every subpage is therefore two clicks from every other subpage, via the homepage. `CommunityGuidelines.js` does not link to `/privacy` or `/terms` at all, even though `TermsOfService.js:31` declares the guidelines to be part of the Terms.

**Fix:** extract the `LandingPage.js` footer into a shared component and mount it on all seven marketing routes.

---

## 7. MEDIUM: `WhenNear` may hide the live demo from crawlers

`LandingPage.js:127-164` gates `LiveDemo` (mounted at 567-569) and both `BirdieBird` instances (598-606, 753-756) behind an `IntersectionObserver` with a 700-800px `rootMargin`.

The fallback at `LandingPage.js:129` (`typeof IntersectionObserver !== 'function'` renders immediately) does not help: Googlebot's renderer has `IntersectionObserver`. It renders at a viewport and does not reliably scroll, so content below the observer threshold, including the `<h3>` at `LiveDemo.js:961`, may never enter the DOM for the crawler.

This matters more than usual because `LandingPage.js:559-561` makes the page's boldest claim, "Everything below is live. The map, the pins, and the numbers come from the same model that ships inside Flock", directly above content a crawler may never see.

**Fix options:** raise `rootMargin` substantially, or render the demo's textual content unconditionally and gate only the interactive map.

---

## 8. MEDIUM: `/about` is the highest-intent page and the thinnest

About 450 words, no images, and it carries the only verifiable proof points on the site. All five numeric claims at `AboutPage.js:63-75` were checked against `backend/scripts/ml/models/model_metadata.json` and **every one holds** (106 features, 2,070,239 training rows, 31 cities, 419,320 holdout rows, 2.29 point realtime MAE gain).

That paragraph is the most citable content Flock has. It deserves a longer page, a product screenshot, and the DECA credential stated with a year.

---

## 9. LOW: image and copy nits

- `LandingPage.js:582-588`: the Birdie screenshot is the only lazy image on the page missing `decoding="async"` and `fetchPriority="low"`. Every other one has both.
- `LandingPage.js:62-69`: the `Mark` component never sets `decoding`.
- `components/ui/BirdieBird.js:641, 660, 680`: no intrinsic `width`/`height`. CLS is currently covered by the `aspectRatio` box reserved in the `WhenNear` `hold` prop, which works but is fragile.
- Image filenames carry no keywords: `app-nest.png`, `mark-steps-400.png`, `mark-crowd-400.png`, `mark-money-400.png`. Image search will not surface these.
- `SupportPage.js:53, 60, 66, 83` use a bare `→` (U+2192) inside body sentences. Screen readers say "right arrow" and text extractors take it literally. Everywhere else in the codebase the arrow is `&rarr;` inside `aria-hidden`.
- `LandingPage.js:686-692` (the `$116.82` bill split) and `LandingPage.js:729-739` (the SOS email mock, captioned "The actual email") render synthetic numbers as plain text, indistinguishable from real data to an extractor. A visually-hidden "Example" label would neutralise this.
- `LandingPage.js:723`: `No background tracking, ever.` SLOP-AUDIT rule 5 bans "forever" promises. It is true today (`PrivacyPolicy.js:220`) but "ever" becomes a lie by roadmap.
- `LandingPage.js:392-393`: "Free" does not hedge, while `TermsOfService.js:111` correctly does. If `PAYWALL_ENABLED` ever flips, this line, the `og:description` in `public/index.html`, the JSON-LD `Offer`, and `llms.txt` all change together.

---

## Confirmed clean, do not "fix"

- **Every page has exactly one h1 and there are zero heading-level skips.** The comment at `LandingPage.js:871-872` records that footer headings were deliberately raised from h4 to h3 to satisfy axe `heading-order`. Correct.
- **Every link is a real `<a href>`.** No onClick-only pseudo-links anywhere. The landing menu panel is always in the DOM with only a CSS class toggling visibility, so a crawler sees all six links.
- **Zero em dashes in user-visible copy** across all eight files. Every em dash found is inside a JS comment.
- **Zero banned register words** (`seamless`, `effortless`, `unlock`, `leverage`, `elevate`, and the rest of the SLOP-AUDIT list). Zero emoji used as icons. Zero fake testimonials. No purple gradients. No scroll-reveal animations.
- The App Store badge correctly points at the waitlist anchor while `APP_STORE_LIVE = false`, because `https://apps.apple.com/app/id6781442127` returns 404 today. Verified live.
