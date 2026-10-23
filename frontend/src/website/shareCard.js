// The link card for a marketing page that is served as prerendered HTML.
//
// iMessage, LinkedIn, Slack, Discord and the other preview bots run no
// JavaScript, so a route answered with index.html gets index.html's generic
// card (its SHARE PREVIEW block, which is why that block stays generic). The
// routes scripts/build-cloudflare.js prerenders are answered with a snapshot
// taken after the page's effects have run, so a card written here is in the
// HTML those bots read. Each of those pages calls shareThisPage at the end of
// the effect that writes its title and description. The card then carries the
// same title and description as the search result, the values
// api/marketing-page.js already gives the AI crawlers, and og:url names the
// page's canonical address whatever URL was pasted.
//
// The returned cleanup puts index.html's card back and removes og:url, so a
// page reached by navigating inside the app never carries the previous page's
// card. index.html explains why it ships no og:url of its own.

const ORIGIN = 'https://www.flockcorp.com';

// index.html's SHARE PREVIEW values. marketingRouteMetadata.test.js reads them
// out of that file and holds these equal.
export const DEFAULT_CARD = {
  title: 'Flock | Nurturing friendship, one flock at a time',
  description: 'Everyone gets a vote, and nobody has to say their budget out loud.',
};

function setMeta(attribute, key, value) {
  let tag = document.head.querySelector(`meta[${attribute}="${key}"]`);
  if (value == null) {
    if (tag) tag.remove();
    return;
  }
  if (!tag) {
    tag = document.createElement('meta');
    tag.setAttribute(attribute, key);
    document.head.appendChild(tag);
  }
  tag.setAttribute('content', value);
}

function writeCard(title, description, url) {
  setMeta('property', 'og:title', title);
  setMeta('property', 'og:description', description);
  setMeta('property', 'og:url', url);
  setMeta('name', 'twitter:title', title);
  setMeta('name', 'twitter:description', description);
}

// Copies the title and description the page has just written into the card,
// with the page's canonical URL, and returns the effect's cleanup.
export function shareThisPage(path) {
  const meta = document.querySelector('meta[name="description"]');
  writeCard(document.title, meta ? meta.getAttribute('content') : DEFAULT_CARD.description, ORIGIN + path);
  return () => writeCard(DEFAULT_CARD.title, DEFAULT_CARD.description, null);
}
