// ---------------------------------------------------------------------------
// WHAT THE ML COLLECTORS MAY PRINT ABOUT A FAILURE.
//
// The BestTime key rides in every request's query string, so any text that
// came back from BestTime, or that quotes a request, can carry it: an error
// body that echoes the request, a JSON parse error quoting the body it choked
// on, a Postgres error quoting the value that did not fit its column, a native
// fetch error whose `cause` holds the whole URL. Redacting such text was tried
// and leaked three different ways (a cut, an encoding, an overlap), so the rule
// is the other way round: those texts are never printed. A failure is logged
// as a fixed label, our own error message, or an error code.
//
// Its own module, not part of bestTimeService.js, because the collector test
// suites stub bestTimeService with the fetchers alone, and a helper imported
// from the stub would be undefined on exactly the error path it exists for.
// ---------------------------------------------------------------------------

// BestTime's known answers, reduced to what they mean.
const FAILURE_REASONS = [
  [/could not forecast/i, 'found, but BestTime has too little visitor data to forecast it'],
  [/could not find|not found|no venue/i, 'BestTime could not match a venue to that name and address'],
];
const UNRECOGNISED_REASON = 'reason not recognised';

function labelFor(message) {
  if (typeof message !== 'string' || !message) return UNRECOGNISED_REASON;
  for (const [pattern, label] of FAILURE_REASONS) {
    if (pattern.test(message)) return label;
  }
  return UNRECOGNISED_REASON;
}

// A failure body (bounded text, possibly cut) to its label.
function failureReason(text) {
  if (typeof text !== 'string' || !text) return null;
  let probe = text;
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed.message === 'string') probe = parsed.message;
  } catch { /* a cut or non-JSON body is matched as it stands */ }
  return labelFor(probe);
}

// The configured keys, whole and without their pri_/pub_ prefix.
function configuredSecrets() {
  const out = [];
  for (const k of [process.env.BESTTIME_API_KEY, process.env.BESTTIME_API_KEY_PUBLIC]) {
    if (typeof k !== 'string' || k.length < 8) continue;
    out.push(k);
    const body = k.replace(/^(pri|pub)_/i, '');
    if (body.length >= 12 && body !== k) out.push(body);
  }
  return out;
}

// Key-shaped text: a pri_/pub_ prefix, a configured key whole or by its body,
// or a long mixed hex run (a key's body without its prefix).
function keyShaped(text) {
  if (typeof text !== 'string' || !text) return false;
  if (/(pri|pub)[_%]/i.test(text)) return true;
  if (configuredSecrets().some((s) => text.includes(s))) return true;
  return (text.match(/[0-9a-f]{16,}/gi) || []).some((r) => /[a-f]/i.test(r));
}

// A value that came back in a response and is worth printing (a venue's
// name), printed only if nothing in it looks like a key.
function safeText(value) {
  const text = value === undefined || value === null ? '' : String(value);
  return keyShaped(text) ? '[withheld]' : text;
}

// A caught error, as one printable line. A JSON parse error quotes the body,
// so it becomes a fixed phrase. A native fetch error's cause can hold the
// request URL (an invalid redirect puts it in cause.input or cause.base), so
// only the cause's CODE is ever read. Everything else thrown on these paths is
// ours: a classified status, a timeout, a network failure, a shape error.
function describeError(err) {
  if (!err) return 'unknown error';
  if (err instanceof SyntaxError) return 'the response was not valid JSON';
  let text = typeof err.message === 'string' && err.message ? err.message : 'unknown error';
  // Node's fetch puts the whole URL in its own message for a URL it cannot
  // parse ("Failed to parse URL from https://...?api_key_private=...").
  if (/api_key|https?:\/\/\S*\?/i.test(text)) {
    text = `${err.name || 'Error'} naming a request URL (withheld)`;
  } else if (/(pri|pub)[_%]/i.test(text) || configuredSecrets().some((s) => text.includes(s))) {
    // Key-shaped, or a configured key whole or by its body, however it got in
    // (a URL with the key in its path has no "?").
    text = `${err.name || 'Error'} carrying key material (withheld)`;
  }
  const code = typeof err.code === 'string' ? err.code
    : (err.cause && typeof err.cause.code === 'string' ? err.cause.code : null);
  return code && !text.includes(code) ? `${text} (${code})` : text;
}

// A Postgres error. Class 22 (data exception: invalid text for a type, value
// out of range) quotes the offending value, which on these paths came from a
// BestTime response, so that class is printed by code alone.
function describeDbError(err) {
  if (!err) return 'unknown database error';
  const code = typeof err.code === 'string' ? err.code : null;
  if (code && code.startsWith('22')) return `data exception ${code}: a value from the response did not fit its column`;
  return describeError(err);
}

module.exports = {
  labelFor, failureReason, describeError, describeDbError, safeText, UNRECOGNISED_REASON,
};
