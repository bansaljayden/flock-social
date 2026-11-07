// ONE ROW PER PLACE IN A SEARCH ANSWER (2026-11-06).
//
// Typing "tor" in Discover listed "Tor Chimney & Fireplace" twice, as rows 1
// and 3 of one answer, the second with its address cut off: Google's Text
// Search can hand back the same place twice, or two listings of one business
// a few doors apart. The list read as broken, and the repeat took a row from a
// place the person had not seen. Each answer is cleaned here, before
// routes/venueSearch.js caches it, so the cache holds the clean list too:
//   * a place id already listed is dropped;
//   * a row whose name matches a row above it, once case, punctuation and
//     "&"/"and" are set aside, and that stands within 150 m of it, is dropped.
// The first row is kept, which is the one Google ranked higher. Nothing is
// merged across rows: a dropped listing's photo or rating is its own and is
// never carried onto the one kept. Rows without coordinates are matched on
// the place id alone.

const SAME_PLACE_METRES = 150;

function normalizedName(name) {
  if (typeof name !== 'string') return '';
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function metresBetween(a, b) {
  const R = 6371000;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.latitude - a.latitude);
  const dLng = rad(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

const hasPoint = (loc) => Boolean(loc) && Number.isFinite(loc.latitude) && Number.isFinite(loc.longitude);

// `rows`: venue rows shaped as routes/venueSearch.js builds them
// ({ place_id, name, location: { latitude, longitude } }). Returns a new array.
function dedupeSearchRows(rows) {
  if (!Array.isArray(rows)) return [];
  const kept = [];
  const ids = new Set();
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const id = typeof row.place_id === 'string' && row.place_id ? row.place_id : null;
    if (id && ids.has(id)) continue;
    const name = normalizedName(row.name);
    const twin = name && hasPoint(row.location) && kept.some((k) => normalizedName(k.name) === name
      && hasPoint(k.location) && metresBetween(k.location, row.location) <= SAME_PLACE_METRES);
    if (twin) continue;
    if (id) ids.add(id);
    kept.push(row);
  }
  return kept;
}

module.exports = { dedupeSearchRows, normalizedName, SAME_PLACE_METRES };
