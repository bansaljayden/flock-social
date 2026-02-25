/**
 * Strip HTML tags from a string to prevent stored XSS.
 * Preserves text content; only removes markup.
 */
function stripHtml(str) {
  if (typeof str !== 'string') return str;
  return str.replace(/<[^>]*>/g, '');
}

module.exports = { stripHtml };
