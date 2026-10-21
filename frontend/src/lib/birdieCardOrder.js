// Birdie's venue cards follow its words: a place the reply names comes first,
// in the order the reply names them, then the rest in the search's own order.
// The search hands back places in its order and the model picks freely among
// them, so a reply recommending one place used to lead with another place's
// card (three live answers in a row did it on 2026-10-21).

// Lower case, accents and punctuation gone, spaces at both ends, so a match
// is always on whole words.
const norm = (s) => ` ${String(s || '')
  .toLowerCase()
  .normalize('NFKD')
  .replace(/[̀-ͯ]/g, '')
  .replace(/&/g, ' and ')
  .replace(/[^a-z0-9]+/g, ' ')
  .trim()} `;

// Words a reply often leaves off a listed name: "Oh Brother" for "Oh Brother
// Philly", "Franklin Fountain" for "The Franklin Fountain".
const TRAILING = / (philly|philadelphia|restaurant|pizzeria|cafe|bar|grill|kitchen|bistro|tavern|co|inc|llc)(?= $)/;
const LEADING = /^ the(?= )/;

function mentionAt(text, name) {
  const tries = [];
  let n = norm(name);
  while (n.trim().length >= 4 && !tries.includes(n)) {
    tries.push(n);
    const shorter = n.replace(TRAILING, '');
    n = shorter === n ? n.replace(LEADING, '') : shorter;
  }
  let at = -1;
  for (const t of tries) {
    const i = text.indexOf(t);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  return at;
}

export function venuesByMention(venues, text) {
  if (!Array.isArray(venues) || venues.length < 2) return venues || [];
  const t = norm(text);
  return venues
    .map((v, i) => ({ v, i, at: mentionAt(t, v && v.name) }))
    .sort((a, b) => {
      if ((a.at < 0) !== (b.at < 0)) return a.at < 0 ? 1 : -1;
      if (a.at >= 0 && a.at !== b.at) return a.at - b.at;
      return a.i - b.i;
    })
    .map((x) => x.v);
}
