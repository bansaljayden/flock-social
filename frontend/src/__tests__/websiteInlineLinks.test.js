/**
 * IN-TEXT LINKS ON THE WEBSITE ARE UNDERLINED (2026-10-29).
 *
 * axe's link-in-text-block flagged the links inside paragraphs on /about,
 * /ai, /flux and /how-it-works: they were told apart from the words around
 * them by colour alone (WCAG 1.4.1). Each rule set an underline offset, so an
 * underline was meant, but none set the underline itself, and the global
 * reset (text-decoration: inherit) left them plain.
 */
const fs = require('fs');
const path = require('path');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', 'website', file), 'utf8');

test.each([
  ['AboutPage.css', '.ab-contact-lead a, .ab-fine a'],
  ['AiPage.css', '.ai-text a'],
  ['FluxPage.css', '.lp-on-navy .fx-measure a'],
  ['FluxPage.css', '.fx-figure .lp-fig-cap a'],
  ['HowItWorks.css', '.hw-ai-more a'],
  ['HowItWorks.css', '.hw-venues a'],
  // The home page's "No iPhone?" line under the App Store badge (2026-11-05).
  ['LandingPage.css', '.lp-get-web a'],
  // /about's November 4, 2026 milestone, whose "on the App Store" links to
  // the picture of the listing (2026-11-05).
  ['AboutPage.css', '.ab-what a'],
])('%s: %s carries an underline', (file, selector) => {
  const css = read(file);
  const at = css.indexOf(`${selector} {`);
  expect(at).toBeGreaterThan(-1);
  expect(css.slice(at, css.indexOf('}', at))).toMatch(/text-decoration:\s*underline/);
});
