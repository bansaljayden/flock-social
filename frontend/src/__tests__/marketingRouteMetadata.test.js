/**
 * Per-route <title>, <meta name="description"> and the /support FAQPage.
 *
 * WHY THIS FILE EXISTS
 *
 * Create React App does no server rendering. `public/index.html` is the
 * byte-for-byte response for /, /about, /support, /privacy, /terms,
 * /guidelines and /delete-account alike, so its single static
 * <meta name="description"> was the description all six subpages shipped
 * with: /privacy told searchers it was about voting on where to go and
 * splitting the bill.
 *
 * The only mechanism available without adding a dependency is the one
 * LandingPage.js already uses: each route rewrites the tag index.html ships,
 * from its own useEffect. That is a real mechanism rather than a workaround
 * (Googlebot renders JavaScript and reads the rewritten value), but it has two
 * silent failure modes, and both are pinned here:
 *
 *   1. It is a no-op if index.html ever stops shipping the tag, because every
 *      page guards with `if (meta)`. So the tag's presence in index.html is
 *      asserted as the premise, not assumed.
 *   2. A page that forgets the write inherits the homepage description again
 *      and nothing anywhere fails. So every page is rendered and its written
 *      value is read back off the document.
 *
 * Scrapers that do not execute JavaScript (iMessage, Slack, Discord) keep the
 * static og: block in index.html. That is why the og: block stays generic.
 *
 * THE FAQ MARKUP IS COMPARED AGAINST THE PAGE, NOT REVIEWED BY EYE.
 * JSON-LD that describes questions a page does not carry is fabricated markup
 * and a manual-action risk. The FAQPage on /support is hand-written next to
 * hand-written JSX, which is exactly the arrangement that drifts, so the
 * assertions below render the page and compare every question and every answer
 * against the DOM.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test --watchAll=false
 *
 * This is a FRONTEND test (jest via react-scripts), not a `node --test` one.
 */

const fs = require('fs');
const path = require('path');
const React = require('react');
const { render } = require('@testing-library/react');

const FRONTEND = path.join(__dirname, '..', '..');
const WEBSITE = path.join(__dirname, '..', 'website');
const readJs = (f) => fs.readFileSync(path.join(WEBSITE, f), 'utf8');
const INDEX_HTML = fs.readFileSync(path.join(FRONTEND, 'public', 'index.html'), 'utf8');

// The six routes that inherited the homepage description. LandingPage is not
// here: it is another owner's file and already writes its own.
const PAGES = [
  { file: 'AboutPage.js', route: '/about', title: 'What Flock is, and why venues pay | Flock' },
  { file: 'SupportPage.js', route: '/support', title: 'Support and common questions | Flock' },
  { file: 'PrivacyPolicy.js', route: '/privacy', title: 'Privacy Policy | Flock' },
  { file: 'TermsOfService.js', route: '/terms', title: 'Terms of Service and EULA | Flock' },
  { file: 'CommunityGuidelines.js', route: '/guidelines', title: 'Community Guidelines | Flock' },
  { file: 'DeleteAccount.js', route: '/delete-account', title: 'Delete your account | Flock' },
];

const load = (file) => {
  // eslint-disable-next-line global-require, import/no-dynamic-require
  return require(`../website/${file.replace(/\.js$/, '')}`).default;
};

// The description index.html ships, which is the value every one of these
// pages used to inherit. Parsed out rather than pasted, so the "different from
// the default" assertions cannot go stale against a reworded homepage.
const DEFAULT_DESCRIPTION = (() => {
  const m = /<meta name="description" content="([^"]*)"/.exec(INDEX_HTML);
  if (!m) throw new Error('public/index.html ships no <meta name="description">');
  return m[1];
})();

const collapse = (s) => s.replace(/\s+/g, ' ').trim();

// Render into a document that looks like the one the browser gets: the head
// index.html ships, and nothing left over from the previous test.
function mount(file) {
  document.head.innerHTML = '';
  document.title = '';
  const meta = document.createElement('meta');
  meta.setAttribute('name', 'description');
  meta.setAttribute('content', DEFAULT_DESCRIPTION);
  document.head.appendChild(meta);
  return render(React.createElement(load(file)));
}

const describedBy = () => {
  const meta = document.head.querySelector('meta[name="description"]');
  return meta && meta.getAttribute('content');
};

// ───────────────────────────────────────────────────────────────────────────
describe('the premise: one static head, served on every route', () => {
  test('index.html ships exactly one meta description, and the pages target it', () => {
    // Every page guards its write with `if (meta)`. Rename or drop this tag and
    // all six writes become silent no-ops with nothing failing, so the tag is
    // the premise of the mechanism and is asserted rather than assumed.
    const tags = INDEX_HTML.match(/<meta name="description"/g) || [];
    expect(tags).toHaveLength(1);
    expect(DEFAULT_DESCRIPTION.length).toBeGreaterThan(0);

    for (const { file } of PAGES) {
      expect(readJs(file)).toContain("document.querySelector('meta[name=\"description\"]')");
    }
  });

  test('no page-specific schema is in index.html, where it would claim every route', () => {
    // A FAQPage here would tell a crawler that /privacy and /terms carry the
    // support questions. index.html's own comment says so; this holds it.
    expect(INDEX_HTML).not.toMatch(/"FAQPage"/);
    expect(INDEX_HTML).not.toMatch(/"aggregateRating"|"ratingValue"|"reviewCount"/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('every subpage writes its own title and description', () => {
  test.each(PAGES.map((p) => [p.route, p]))('%s', (_route, page) => {
    const { unmount } = mount(page.file);

    expect(document.title).toBe(page.title);

    const description = describedBy();
    expect(description).not.toBe(DEFAULT_DESCRIPTION);
    expect(description).toBeTruthy();
    // Google truncates around 155-160 characters; under 50 wastes the slot.
    expect(description.length).toBeLessThanOrEqual(155);
    expect(description.length).toBeGreaterThanOrEqual(50);
    // SLOP-AUDIT A2. A description is user-visible copy; it is just visible in
    // a search result instead of on the page.
    expect(description).not.toMatch(/—/);
    // Sentence case, ends like a sentence, and not a keyword list.
    expect(description).toMatch(/[.]$/);
    expect(description).not.toMatch(/\|/);

    unmount();
  });

  test('the six descriptions and the six titles are all distinct', () => {
    // Two pages sharing a description is the same defect as inheriting the
    // homepage one, just harder to see.
    const descriptions = [];
    for (const page of PAGES) {
      const { unmount } = mount(page.file);
      descriptions.push(describedBy());
      unmount();
    }
    expect(new Set(descriptions).size).toBe(PAGES.length);

    const titles = PAGES.map((p) => p.title);
    expect(new Set(titles).size).toBe(PAGES.length);
  });

  test('titles use one delimiter, the one index.html already uses', () => {
    // The subpages shipped "About · Flock" while / and /i/ used "|".
    const siteTitle = /<title>([^<]+)<\/title>/.exec(INDEX_HTML);
    expect(siteTitle).not.toBeNull();
    expect(siteTitle[1]).toContain(' | ');

    for (const page of PAGES) {
      expect(page.title).toContain(' | Flock');
      expect(page.title).not.toContain('·');
      // Google truncates the title around 60 characters.
      expect(page.title.length).toBeLessThanOrEqual(60);
      // ...and the title the component writes has to be the one asserted here.
      expect(readJs(page.file)).toContain(`document.title = '${page.title}'`);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('the pages link to the canonical homepage', () => {
  test('nothing points at /landing', () => {
    // /landing serves the homepage and vercel.json canonicalises it to /, so it
    // is never indexed. Every subpage sent its only outbound link there.
    for (const { file } of PAGES) {
      expect({ file, hits: readJs(file).match(/["']\/landing["']/g) })
        .toEqual({ file, hits: null });
    }
  });

  test('the back link on every subpage resolves to /', () => {
    for (const { file } of PAGES) {
      const { container, unmount } = mount(file);
      const back = container.querySelector('.pp-back');
      expect(back).not.toBeNull();
      expect(back.getAttribute('href')).toBe('/');
      unmount();
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('the register matches the company that exists', () => {
  test('no page claims a team, and /about still names the one person', () => {
    // /about says "a student founder". Support and the guidelines said "we're a
    // small team" and "our team reviews reports", and the second of those is a
    // moderation commitment App Review reads.
    for (const { file } of PAGES) {
      const { container, unmount } = mount(file);
      const copy = collapse(container.textContent);
      expect({ file, hit: /our team|small team|our staff|our moderators/i.exec(copy) })
        .toEqual({ file, hit: null });
      unmount();
    }

    const { container, unmount } = mount('AboutPage.js');
    expect(collapse(container.textContent)).toContain('a student founder in Bethlehem, PA');
    unmount();
  });

  test('the moderation commitment survived the rewrite on both pages that carry it', () => {
    // Guideline 1.2 wants a stated commitment to act on reports. Removing the
    // invented headcount must not remove the promise with it.
    const guidelines = collapse(readJs('CommunityGuidelines.js'));
    expect(guidelines).toMatch(/Every report is reviewed and acted on promptly/);
    const terms = collapse(readJs('TermsOfService.js'));
    expect(terms).toMatch(/We act on reports of objectionable content and abusive behavior promptly/);
    // "we"/"us" in the Terms is a defined term for Flock Corp, which is why it
    // was left alone. If that definition ever goes, the pronoun becomes the
    // same unbacked claim the rest of this pass removed.
    expect(terms).toMatch(/\("Flock", "we", "us"\)/);
  });

  test('support answers in the first person and promises no response time', () => {
    const { container, unmount } = mount('SupportPage.js');
    const copy = collapse(container.textContent);
    expect(copy).toContain('I read every message.');
    // A support SLA nobody is staffed to meet is worse than none.
    expect(copy).not.toMatch(/within \d+ (hours|business days|days)/i);
    unmount();
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('/support FAQPage: the markup describes the page it is on', () => {
  const jsonLd = () => Array.from(
    document.head.querySelectorAll('script[type="application/ld+json"]')
  );

  test('the script is injected on mount and removed on unmount', () => {
    const { unmount } = mount('SupportPage.js');
    expect(jsonLd()).toHaveLength(1);
    unmount();
    // Without the cleanup, StrictMode's double-invoked effect in development
    // leaves two FAQPage blocks in the head.
    expect(jsonLd()).toHaveLength(0);
  });

  test('no other route injects structured data of its own', () => {
    for (const { file } of PAGES) {
      if (file === 'SupportPage.js') continue;
      const { unmount } = mount(file);
      expect({ file, scripts: jsonLd().length }).toEqual({ file, scripts: 0 });
      unmount();
    }
  });

  test('every question and answer in the JSON-LD is on the page, word for word', () => {
    const { container, unmount } = mount('SupportPage.js');

    const data = JSON.parse(jsonLd()[0].textContent);
    expect(data['@context']).toBe('https://schema.org');
    expect(data['@type']).toBe('FAQPage');

    // The questions as a reader sees them: an <h3> followed by its <p>.
    const headings = Array.from(container.querySelectorAll('h3'));
    expect(headings.length).toBeGreaterThan(5);
    expect(data.mainEntity).toHaveLength(headings.length);

    headings.forEach((h3, i) => {
      const entry = data.mainEntity[i];
      expect(entry['@type']).toBe('Question');
      expect(entry.acceptedAnswer['@type']).toBe('Answer');

      expect(entry.name).toBe(collapse(h3.textContent));

      const answer = h3.nextElementSibling;
      expect(answer.tagName).toBe('P');
      if (collapse(answer.textContent) !== entry.acceptedAnswer.text) {
        throw new Error(
          `FAQ entry ${i + 1} ("${entry.name}") answers\n  ${entry.acceptedAnswer.text}\n`
          + `but the page says\n  ${collapse(answer.textContent)}`
        );
      }
    });

    unmount();
  });

  test('the questions are shaped like questions, which is what they are markup for', () => {
    const { container, unmount } = mount('SupportPage.js');
    for (const h3 of container.querySelectorAll('h3')) {
      const text = collapse(h3.textContent);
      if (!text.endsWith('?')) {
        throw new Error(`"${text}" is an FAQ heading that is not a question`);
      }
    }
    unmount();
  });

  test('the FAQ invents no rating, count or other unearned rich-result field', () => {
    // Flock is pre-launch. There is nothing to aggregate.
    const { unmount } = mount('SupportPage.js');
    const raw = jsonLd()[0].textContent;
    expect(raw).not.toMatch(/aggregateRating|ratingValue|upvoteCount|answerCount|dateCreated/);
    unmount();
  });
});
