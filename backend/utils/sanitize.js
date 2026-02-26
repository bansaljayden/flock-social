const xss = require('xss');

/**
 * Sanitize a string to prevent stored XSS.
 * Uses the xss library to handle tags, entities, and attribute-based attacks.
 */
function stripHtml(str) {
  if (typeof str !== 'string') return str;
  return xss(str, {
    whiteList: {},          // Allow no HTML tags
    stripIgnoreTag: true,   // Strip all tags not in whitelist
    stripIgnoreTagBody: ['script', 'style'], // Remove script/style entirely
  });
}

/**
 * Sanitize each element in an array of strings.
 */
function sanitizeArray(arr) {
  if (!Array.isArray(arr)) return arr;
  return arr.map(item => (typeof item === 'string' ? stripHtml(item) : item));
}

module.exports = { stripHtml, sanitizeArray };
