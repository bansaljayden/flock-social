// Google Scholar's citation tags for the page that carries a paper.
//
// Scholar finds a paper through the page that links it when that page's HTML
// names the paper in its head: citation_title, one citation_author per author,
// citation_publication_date and citation_pdf_url, the tags its inclusion
// guidelines ask for (scholar.google.com/intl/en/scholar/inclusion.html). Its
// crawler runs no JavaScript, so these are written from the page's effect, the
// way shareCard.js writes the link card, and reach Scholar in the snapshot
// scripts/build-cloudflare.js takes of a prerendered route. A route that is not
// prerendered would be served index.html's head without them.
//
// Every citation_ tag already in the head goes first, so the client booting on
// top of the snapshot writes the same tags again instead of a second set, and
// the returned cleanup removes them, so a page reached by navigating inside
// the app never carries another page's paper.

const clear = () => {
  document.head.querySelectorAll('meta[name^="citation_"]').forEach((tag) => tag.remove());
};

function add(name, content) {
  const tag = document.createElement('meta');
  tag.setAttribute('name', name);
  tag.setAttribute('content', content);
  document.head.appendChild(tag);
}

export function citePaper({ title, authors, date, institution, pdfUrl }) {
  clear();
  add('citation_title', title);
  for (const author of authors) add('citation_author', author);
  add('citation_publication_date', date);
  add('citation_technical_report_institution', institution);
  add('citation_pdf_url', pdfUrl);
  return clear;
}
