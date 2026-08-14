// tools/asc-upload/lib.mjs
//
// Pure logic for the App Store Connect uploader: JWT minting, submission-doc
// parsing, validation against Apple's limits, screenshot manifest handling,
// and API-call planning. No network calls live in this file, which is what
// makes the whole tool testable before an API key exists.
//
// API facts in this file were verified against Apple's documentation on
// 2026-08-14 (the JSON data endpoints behind developer.apple.com/documentation):
//  - JWT: ES256, header {alg, kid, typ:"JWT"}, claims {iss, iat, exp, aud:
//    "appstoreconnect-v1"}, expiry at most 20 minutes out.
//    (appstoreconnectapi/generating-tokens-for-api-requests)
//  - Screenshot display types: APP_IPHONE_67 (6.7"), APP_IPHONE_65 (6.5").
//    (appstoreconnectapi/screenshotdisplaytype)
//  - Asset upload: POST /v1/appScreenshots reservation {fileName, fileSize} ->
//    uploadOperations [{method, url, offset, length, requestHeaders}] ->
//    PATCH commit {uploaded: true, sourceFileChecksum: <MD5 hex>} ->
//    assetDeliveryState AWAITING_UPLOAD / UPLOAD_COMPLETE / COMPLETE / FAILED.
//    (appstoreconnectapi/uploading-assets-to-app-store-connect)
//  - appStoreVersionLocalization attributes: locale (required on create),
//    description, keywords, marketingUrl, promotionalText, supportUrl, whatsNew.
//  - appInfoLocalization attributes: locale, name, subtitle, privacyPolicyUrl,
//    privacyPolicyText, privacyChoicesUrl.

import { createHash, createPrivateKey, sign as cryptoSign } from 'node:crypto';

export const ASC_BASE_URL = 'https://api.appstoreconnect.apple.com';
export const ASC_AUDIENCE = 'appstoreconnect-v1';
export const MAX_TOKEN_LIFETIME_SECONDS = 20 * 60; // Apple's hard cap
export const DEFAULT_TOKEN_LIFETIME_SECONDS = 19 * 60; // stay under the cap

// Apple's field limits (sources recorded in APP-STORE-SUBMISSION.md header):
// name 30 chars, subtitle 30 chars, keywords 100 BYTES, description 4000,
// promotionalText 170, whatsNew 4000.
export const APPLE_LIMITS = {
  name: { chars: 30 },
  subtitle: { chars: 30 },
  keywords: { bytes: 100 },
  description: { chars: 4000 },
  promotionalText: { chars: 170 },
  whatsNew: { chars: 4000 },
};

// Per display-type screenshot set limit.
export const MAX_SCREENSHOTS_PER_SET = 10;

// Pixel sizes -> ScreenshotDisplayType. Portrait and landscape both accepted.
// 6.9" (1320x2868) uploads land in the APP_IPHONE_67 set; the API enum has no
// APP_IPHONE_69 (verified against the ScreenshotDisplayType enum 2026-08-14).
export const DISPLAY_TYPE_SIZES = {
  APP_IPHONE_67: [
    [1290, 2796], [2796, 1290],
    [1320, 2868], [2868, 1320],
  ],
  APP_IPHONE_65: [
    [1242, 2688], [2688, 1242],
    [1284, 2778], [2778, 1284],
  ],
};

export const VALID_DISPLAY_TYPES = Object.keys(DISPLAY_TYPE_SIZES);

// ---------------------------------------------------------------------------
// JWT
// ---------------------------------------------------------------------------

export function base64url(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function loadEcPrivateKey(pem) {
  let keyObject;
  try {
    keyObject = createPrivateKey({ key: pem });
  } catch (err) {
    throw new Error(
      `Could not parse the private key: ${err.message}. ` +
      'FIX: pass the AuthKey_XXXXXXXXXX.p8 file exactly as downloaded from App Store Connect (PKCS#8 PEM).'
    );
  }
  if (keyObject.asymmetricKeyType !== 'ec') {
    throw new Error(
      `The key is ${keyObject.asymmetricKeyType}, not an EC key. ` +
      'FIX: App Store Connect API keys are P-256 EC keys; use the .p8 downloaded from the Users and Access > Integrations page.'
    );
  }
  const curve = keyObject.asymmetricKeyDetails?.namedCurve;
  if (curve && curve !== 'prime256v1') {
    throw new Error(
      `The EC key uses curve ${curve}, but ES256 requires P-256 (prime256v1). ` +
      'FIX: use the unmodified .p8 from App Store Connect.'
    );
  }
  return keyObject;
}

/**
 * Mint an App Store Connect API team-key JWT.
 * ES256 over base64url(header).base64url(payload); the signature must be the
 * raw 64-byte r||s form (ieee-p1363), not DER, per RFC 7518.
 */
export function mintAscJwt({ privateKeyPem, keyId, issuerId, nowSeconds, lifetimeSeconds }) {
  if (!keyId) throw new Error('keyId is required. FIX: pass --key-id (the 10-char ID from the API Keys page).');
  if (!issuerId) throw new Error('issuerId is required. FIX: pass --issuer (the UUID from the API Keys page).');
  const life = lifetimeSeconds ?? DEFAULT_TOKEN_LIFETIME_SECONDS;
  if (life > MAX_TOKEN_LIFETIME_SECONDS) {
    throw new Error(
      `Token lifetime ${life}s exceeds Apple's 20-minute cap. ` +
      `FIX: use a lifetime of at most ${MAX_TOKEN_LIFETIME_SECONDS} seconds.`
    );
  }
  const keyObject = loadEcPrivateKey(privateKeyPem);
  const iat = nowSeconds ?? Math.floor(Date.now() / 1000);
  const header = { alg: 'ES256', kid: keyId, typ: 'JWT' };
  const payload = { iss: issuerId, iat, exp: iat + life, aud: ASC_AUDIENCE };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signature = cryptoSign('sha256', Buffer.from(signingInput), {
    key: keyObject,
    dsaEncoding: 'ieee-p1363',
  });
  return `${signingInput}.${base64url(signature)}`;
}

/** Decode (without verifying) a JWT into { header, payload, signature }. */
export function decodeJwt(token) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Not a JWT: expected three dot-separated parts.');
  const fromB64url = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  return {
    header: JSON.parse(fromB64url(parts[0]).toString('utf8')),
    payload: JSON.parse(fromB64url(parts[1]).toString('utf8')),
    signature: fromB64url(parts[2]),
    signingInput: `${parts[0]}.${parts[1]}`,
  };
}

// ---------------------------------------------------------------------------
// Submission-doc parsing (APP-STORE-SUBMISSION.md sections 6 and 8)
// ---------------------------------------------------------------------------

function sliceBetween(lines, startIdx, endIdx) {
  return lines.slice(startIdx, endIdx === -1 ? undefined : endIdx);
}

function findHeading(lines, pattern) {
  return lines.findIndex((l) => pattern.test(l));
}

/** All blockquote groups ("> ..." runs) in a block of lines, joined per group. */
function blockquotes(lines) {
  const groups = [];
  let current = null;
  for (const line of lines) {
    const m = line.match(/^>\s?(.*)$/);
    if (m) {
      if (current === null) current = [];
      current.push(m[1]);
    } else if (current !== null) {
      groups.push(current.join('\n'));
      current = null;
    }
  }
  if (current !== null) groups.push(current.join('\n'));
  return groups;
}

/** Declared counts like "**2,140 characters.**" or "**98 characters / 98 bytes.**" */
function declaredCounts(lines) {
  const out = [];
  for (const line of lines) {
    const m = line.match(/\*\*([\d,]+) characters(?:\s*\/\s*([\d,]+) bytes)?/);
    if (m) {
      out.push({
        chars: Number(m[1].replace(/,/g, '')),
        bytes: m[2] ? Number(m[2].replace(/,/g, '')) : null,
      });
    }
  }
  return out;
}

function subsection(lines, number, nextNumber) {
  const start = findHeading(lines, new RegExp(`^###\\s+${number.replace('.', '\\.')}\\s`));
  if (start === -1) {
    throw new Error(
      `Section ${number} heading not found in the submission doc. ` +
      `FIX: APP-STORE-SUBMISSION.md must contain a "### ${number} ..." heading; restore it or update the parser.`
    );
  }
  let end = -1;
  if (nextNumber) {
    end = findHeading(lines, new RegExp(`^###\\s+${nextNumber.replace('.', '\\.')}\\s`));
  }
  if (end === -1) end = findHeading(lines.slice(start + 1), /^##\s/) === -1
    ? -1
    : start + 1 + findHeading(lines.slice(start + 1), /^##\s/);
  return sliceBetween(lines, start, end);
}

/**
 * Parse APP-STORE-SUBMISSION.md sections 6 and 8 into a listing object.
 * Throws with a FIX message when structure is broken; validation of limits is
 * a separate step (validateListing) so tests can distinguish the two.
 */
export function parseSubmissionDoc(markdown) {
  const lines = markdown.split(/\r?\n/);

  // Scope to section 6 and section 8 by their `## N.` headings.
  const s6start = findHeading(lines, /^##\s+6\.\s/);
  const s7start = findHeading(lines, /^##\s+7\.\s/);
  const s8start = findHeading(lines, /^##\s+8\.\s/);
  const s9start = findHeading(lines, /^##\s+9\.\s/);
  if (s6start === -1) throw new Error('Section 6 (listing copy) not found. FIX: the doc must contain "## 6. Listing copy".');
  if (s8start === -1) throw new Error('Section 8 (screenshot plan) not found. FIX: the doc must contain "## 8. Screenshot plan".');
  const s6 = sliceBetween(lines, s6start, s7start);
  const s8 = sliceBetween(lines, s8start, s9start);

  // --- 6.1 name (primary + fallback) ---
  const s61 = subsection(s6, '6.1', '6.2');
  const nameQuotes = blockquotes(s61);
  if (nameQuotes.length < 1) throw new Error('Section 6.1 has no blockquoted app name. FIX: the name must be a "> ..." blockquote under 6.1.');
  const s61counts = declaredCounts(s61);

  // --- 6.2 subtitle (primary + alternate) ---
  const s62 = subsection(s6, '6.2', '6.3');
  const subtitleQuotes = blockquotes(s62);
  if (subtitleQuotes.length < 1) throw new Error('Section 6.2 has no blockquoted subtitle. FIX: the subtitle must be a "> ..." blockquote under 6.2.');
  const s62counts = declaredCounts(s62);

  // --- 6.3 keywords ---
  const s63 = subsection(s6, '6.3', '6.4');
  const keywordQuotes = blockquotes(s63);
  if (keywordQuotes.length !== 1) throw new Error('Section 6.3 must contain exactly one blockquoted keyword line. FIX: keep a single "> ..." keyword string under 6.3.');
  const s63counts = declaredCounts(s63);

  // --- 6.4 description: between ---PASTE START--- / ---PASTE END--- ---
  const s64 = subsection(s6, '6.4', '6.5');
  const startIdx = s64.findIndex((l) => l.trim() === '---PASTE START---');
  const endIdx = s64.findIndex((l) => l.trim() === '---PASTE END---');
  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
    throw new Error(
      'Section 6.4 paste block delimiters are missing or out of order. ' +
      'FIX: the description must sit between a "---PASTE START---" line and a "---PASTE END---" line inside 6.4.'
    );
  }
  const description = s64.slice(startIdx + 1, endIdx).join('\n');
  const s64counts = declaredCounts(s64);

  // --- 6.5 promotional text ---
  const s65 = subsection(s6, '6.5', '6.6');
  const promoQuotes = blockquotes(s65);
  if (promoQuotes.length !== 1) throw new Error('Section 6.5 must contain exactly one blockquoted promotional text. FIX: keep a single "> ..." line under 6.5.');
  const s65counts = declaredCounts(s65);

  // --- 6.6 what's new ---
  const s66 = subsection(s6, '6.6', '6.7');
  const whatsNewQuotes = blockquotes(s66);
  if (whatsNewQuotes.length !== 1) throw new Error("Section 6.6 must contain exactly one blockquoted What's New text. FIX: keep a single \"> ...\" line under 6.6.");
  const s66counts = declaredCounts(s66);

  // --- 6.7 URLs table ---
  const s67 = subsection(s6, '6.7', '6.8');
  const urls = {};
  for (const line of s67) {
    const m = line.match(/^\|\s*(Support URL|Marketing URL|Privacy Policy URL)\s*\|\s*(\S+)\s*\|/);
    if (m) {
      const key = { 'Support URL': 'supportUrl', 'Marketing URL': 'marketingUrl', 'Privacy Policy URL': 'privacyPolicyUrl' }[m[1]];
      urls[key] = m[2];
    }
  }
  for (const key of ['supportUrl', 'marketingUrl', 'privacyPolicyUrl']) {
    if (!urls[key]) {
      throw new Error(`Section 6.7 URL table is missing ${key}. FIX: the 6.7 table needs Support URL, Marketing URL, and Privacy Policy URL rows.`);
    }
  }

  // --- 6.8 copyright ---
  const s68 = subsection(s6, '6.8', '6.9');
  const copyrightQuotes = blockquotes(s68);
  if (copyrightQuotes.length !== 1) throw new Error('Section 6.8 must contain exactly one blockquoted copyright line. FIX: keep a single "> ..." line under 6.8.');
  const s68counts = declaredCounts(s68);

  // --- 8 screenshot plan table ---
  const screenshotPlan = [];
  for (const line of s8) {
    const row = line.match(/^\|\s*(\d+)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*$/);
    if (!row) continue;
    const files = [...row[2].matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    if (files.length !== 2) {
      throw new Error(
        `Screenshot plan row ${row[1]} does not name exactly two files (light and dark). ` +
        'FIX: each section 8 row must list `NN-slug-light.png` / `NN-slug-dark.png` in backticks.'
      );
    }
    screenshotPlan.push({
      slot: Number(row[1]),
      light: files[0],
      dark: files[1],
      screen: row[3],
      caption: row[4],
    });
  }
  if (screenshotPlan.length === 0) {
    throw new Error('Section 8 screenshot table parsed to zero rows. FIX: restore the "| # | Files | Screen to show | Caption |" table.');
  }

  return {
    name: nameQuotes[0],
    nameFallback: nameQuotes[1] ?? null,
    subtitle: subtitleQuotes[0],
    subtitleAlternate: subtitleQuotes[1] ?? null,
    keywords: keywordQuotes[0],
    description,
    promotionalText: promoQuotes[0],
    whatsNew: whatsNewQuotes[0],
    ...urls,
    copyright: copyrightQuotes[0],
    declaredCounts: {
      name: s61counts[0] ?? null,
      nameFallback: s61counts[1] ?? null,
      subtitle: s62counts[0] ?? null,
      subtitleAlternate: s62counts[1] ?? null,
      keywords: s63counts[0] ?? null,
      description: s64counts[0] ?? null,
      promotionalText: s65counts[0] ?? null,
      whatsNew: s66counts[0] ?? null,
      copyright: s68counts[0] ?? null,
    },
    screenshotPlan,
  };
}

// ---------------------------------------------------------------------------
// Validation (independent of the doc's own arithmetic, then cross-checked
// against it so silent drift in either direction fails loudly)
// ---------------------------------------------------------------------------

const EM_DASH = '—';

export function validateListing(listing) {
  const errors = [];
  const err = (field, message) => errors.push({ field, message });

  const fields = {
    name: listing.name,
    subtitle: listing.subtitle,
    keywords: listing.keywords,
    description: listing.description,
    promotionalText: listing.promotionalText,
    whatsNew: listing.whatsNew,
  };

  // Apple limits, computed here from the actual text, never trusted from the doc.
  if (fields.name.length > APPLE_LIMITS.name.chars) {
    err('name', `App name is ${fields.name.length} characters; Apple's limit is ${APPLE_LIMITS.name.chars}. FIX: shorten section 6.1.`);
  }
  if (listing.nameFallback && listing.nameFallback.length > APPLE_LIMITS.name.chars) {
    err('nameFallback', `Fallback app name is ${listing.nameFallback.length} characters; Apple's limit is ${APPLE_LIMITS.name.chars}. FIX: shorten the 6.1 fallback.`);
  }
  if (fields.subtitle.length > APPLE_LIMITS.subtitle.chars) {
    err('subtitle', `Subtitle is ${fields.subtitle.length} characters; Apple's limit is ${APPLE_LIMITS.subtitle.chars}. FIX: shorten section 6.2.`);
  }
  const keywordBytes = Buffer.byteLength(fields.keywords, 'utf8');
  if (keywordBytes > APPLE_LIMITS.keywords.bytes) {
    err('keywords', `Keyword field is ${keywordBytes} bytes; Apple's limit is ${APPLE_LIMITS.keywords.bytes} bytes. FIX: trim section 6.3.`);
  }
  if (fields.description.length > APPLE_LIMITS.description.chars) {
    err('description', `Description is ${fields.description.length} characters; Apple's limit is ${APPLE_LIMITS.description.chars}. FIX: shorten section 6.4.`);
  }
  if (fields.promotionalText.length > APPLE_LIMITS.promotionalText.chars) {
    err('promotionalText', `Promotional text is ${fields.promotionalText.length} characters; Apple's limit is ${APPLE_LIMITS.promotionalText.chars}. FIX: shorten section 6.5.`);
  }
  if (fields.whatsNew.length > APPLE_LIMITS.whatsNew.chars) {
    err('whatsNew', `What's New is ${fields.whatsNew.length} characters; Apple's limit is ${APPLE_LIMITS.whatsNew.chars}. FIX: shorten section 6.6.`);
  }

  // House rule (SLOP-AUDIT): no em dashes in any user-visible text.
  for (const [field, value] of Object.entries({ ...fields, copyright: listing.copyright })) {
    if (value && value.includes(EM_DASH)) {
      err(field, `${field} contains an em dash, which the copy standard bans. FIX: replace it with a period, comma, or restructure (SLOP-AUDIT.md rule 1).`);
    }
  }

  // URLs must be https and parseable; www form is canonical (doc 6.7).
  for (const field of ['supportUrl', 'marketingUrl', 'privacyPolicyUrl']) {
    const value = listing[field];
    try {
      const u = new URL(value);
      if (u.protocol !== 'https:') err(field, `${field} must be https, got "${value}". FIX: use the https://www.flockcorp.com form from section 6.7.`);
    } catch {
      err(field, `${field} is not a valid URL: "${value}". FIX: correct the 6.7 table.`);
    }
  }

  // Cross-check computed counts against the doc's own declared counts.
  const checks = [
    ['name', listing.name.length, listing.declaredCounts.name?.chars],
    ['nameFallback', listing.nameFallback?.length, listing.declaredCounts.nameFallback?.chars],
    ['subtitle', listing.subtitle.length, listing.declaredCounts.subtitle?.chars],
    ['subtitleAlternate', listing.subtitleAlternate?.length, listing.declaredCounts.subtitleAlternate?.chars],
    ['keywords', listing.keywords.length, listing.declaredCounts.keywords?.chars],
    ['description', listing.description.length, listing.declaredCounts.description?.chars],
    ['promotionalText', listing.promotionalText.length, listing.declaredCounts.promotionalText?.chars],
    ['whatsNew', listing.whatsNew.length, listing.declaredCounts.whatsNew?.chars],
    ['copyright', listing.copyright.length, listing.declaredCounts.copyright?.chars],
  ];
  for (const [field, actual, declared] of checks) {
    if (declared == null || actual == null) continue;
    if (actual !== declared) {
      err(field, `Doc drift: section 6 declares ${field} as ${declared} characters but the text is ${actual}. FIX: the copy or its recorded count changed without the other; recompute and update APP-STORE-SUBMISSION.md.`);
    }
  }
  if (listing.declaredCounts.keywords?.bytes != null) {
    const actualBytes = Buffer.byteLength(listing.keywords, 'utf8');
    if (actualBytes !== listing.declaredCounts.keywords.bytes) {
      err('keywords', `Doc drift: 6.3 declares ${listing.declaredCounts.keywords.bytes} bytes but the keyword string is ${actualBytes} bytes. FIX: recompute and update the doc.`);
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Screenshots
// ---------------------------------------------------------------------------

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export const SCREENSHOT_NAME_RE = /^\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*-(light|dark)\.png$/;

/** Read width/height out of a PNG's IHDR chunk. */
export function pngDimensions(buf) {
  if (buf.length < 24 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('Not a PNG file (bad signature). FIX: screenshots must be PNG files.');
  }
  if (buf.toString('ascii', 12, 16) !== 'IHDR') {
    throw new Error('PNG is missing its IHDR chunk. FIX: re-export the screenshot.');
  }
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

export function displayTypeForDimensions(width, height) {
  for (const [displayType, sizes] of Object.entries(DISPLAY_TYPE_SIZES)) {
    if (sizes.some(([w, h]) => w === width && h === height)) return displayType;
  }
  const allowed = Object.entries(DISPLAY_TYPE_SIZES)
    .map(([t, sizes]) => `${t}: ${sizes.filter(([w, h]) => h > w).map(([w, h]) => `${w}x${h}`).join(' or ')}`)
    .join('; ');
  throw new Error(
    `${width}x${height} matches no supported iPhone screenshot size. ` +
    `FIX: export at one of ${allowed} (portrait), or the landscape transpose.`
  );
}

/**
 * Build the screenshot manifest from the doc plan plus the files actually on
 * disk. `files` is a Map of fileName -> { size, width, height }. Missing files
 * are listed and NEVER fatal: the uploader continues metadata-only.
 */
export function buildScreenshotManifest(screenshotPlan, files) {
  const errors = [];
  const present = [];
  const missing = [];
  const planned = new Set();

  for (const slot of screenshotPlan) {
    for (const mode of ['light', 'dark']) {
      const fileName = slot[mode];
      planned.add(fileName);
      if (!SCREENSHOT_NAME_RE.test(fileName)) {
        errors.push(
          `Planned file "${fileName}" (slot ${slot.slot}) breaks the naming convention. ` +
          'FIX: names must be NN-slug-light.png / NN-slug-dark.png (two digits, lowercase slug).'
        );
        continue;
      }
      const info = files.get(fileName);
      if (!info) {
        missing.push(fileName);
        continue;
      }
      let displayType;
      try {
        displayType = displayTypeForDimensions(info.width, info.height);
      } catch (e) {
        errors.push(`${fileName}: ${e.message}`);
        continue;
      }
      present.push({ fileName, slot: slot.slot, mode, displayType, size: info.size });
    }
  }

  // Files on disk that the plan does not know about: naming or plan drift.
  const unexpected = [...files.keys()].filter((f) => !planned.has(f));
  for (const f of unexpected) {
    if (!SCREENSHOT_NAME_RE.test(f)) {
      errors.push(
        `File "${f}" in the screenshots directory breaks the naming convention (NN-slug-light.png / NN-slug-dark.png). ` +
        'FIX: rename it to match the section 8 plan, or remove it.'
      );
    }
  }

  return { present, missing, unexpected, errors };
}

/**
 * Order uploads per display type: all light screenshots in slot order first,
 * then dark, capped at MAX_SCREENSHOTS_PER_SET per set (Apple's per-locale
 * limit; section 8 says light is primary and dark fills leftover room).
 */
export function planScreenshotUploads(manifest) {
  const byType = {};
  for (const shot of manifest.present) {
    (byType[shot.displayType] ??= []).push(shot);
  }
  const result = {};
  for (const [displayType, shots] of Object.entries(byType)) {
    const ordered = [...shots].sort((a, b) =>
      (a.mode === b.mode ? a.slot - b.slot : a.mode === 'light' ? -1 : 1)
    );
    result[displayType] = {
      upload: ordered.slice(0, MAX_SCREENSHOTS_PER_SET),
      skipped: ordered.slice(MAX_SCREENSHOTS_PER_SET),
    };
  }
  return result;
}

// ---------------------------------------------------------------------------
// API call planning
// ---------------------------------------------------------------------------

/**
 * Build the ordered list of API calls. `remote` is the known remote state
 * (null when offline): the same listing against a populated remote must plan
 * PATCH / DELETE+POST (replace), never a duplicate create. Payloads contain
 * listing copy only; no credentials ever enter a plan step.
 *
 * remote = {
 *   appId, versionId, versionLocalizationId, appInfoId, appInfoLocalizationId,
 *   screenshotSets: { [displayType]: { id, screenshotIds: [] } },
 * }
 */
export function buildPlan({ listing, uploads, remote, options }) {
  const { bundleId, versionString, locale, platform } = {
    platform: 'IOS',
    ...options,
  };
  const steps = [];
  const online = remote != null;
  const r = remote ?? {};
  const push = (step) => steps.push(step);

  push({
    kind: 'lookup-app', method: 'GET',
    path: `/v1/apps?filter[bundleId]=${bundleId}`,
    note: online ? `resolved: app ${r.appId}` : 'read-only lookup',
  });
  push({
    kind: 'lookup-version', method: 'GET',
    path: `/v1/apps/{appId}/appStoreVersions?filter[platform]=${platform}&filter[versionString]=${versionString}`,
    note: online ? (r.versionId ? `resolved: version ${r.versionId}` : 'no existing version') : 'read-only lookup',
  });

  const versionAttributes = { copyright: listing.copyright };
  if (!online || !r.versionId) {
    push({
      kind: 'create-version', method: 'POST', path: '/v1/appStoreVersions',
      conditional: !online,
      note: online
        ? `create ${platform} ${versionString}`
        : `only if no ${versionString} version exists yet (resolved live)`,
      body: { type: 'appStoreVersions', attributes: { platform, versionString, ...versionAttributes } },
    });
  } else {
    push({
      kind: 'update-version', method: 'PATCH', path: `/v1/appStoreVersions/${r.versionId}`,
      note: 'update copyright on the existing version (replace, not create)',
      body: { type: 'appStoreVersions', attributes: versionAttributes },
    });
  }

  const versionLocAttributes = {
    description: listing.description,
    keywords: listing.keywords,
    promotionalText: listing.promotionalText,
    whatsNew: listing.whatsNew,
    supportUrl: listing.supportUrl,
    marketingUrl: listing.marketingUrl,
  };
  if (online && r.versionLocalizationId) {
    push({
      kind: 'update-version-localization', method: 'PATCH',
      path: `/v1/appStoreVersionLocalizations/${r.versionLocalizationId}`,
      note: `update existing ${locale} localization (replace, not create)`,
      body: { type: 'appStoreVersionLocalizations', attributes: versionLocAttributes },
    });
  } else {
    push({
      kind: 'create-version-localization', method: 'POST',
      path: '/v1/appStoreVersionLocalizations',
      conditional: !online,
      note: online ? `create ${locale} localization` : `POST if no ${locale} localization exists, PATCH otherwise (resolved live)`,
      body: { type: 'appStoreVersionLocalizations', attributes: { locale, ...versionLocAttributes } },
    });
  }

  const appInfoAttributes = {
    name: listing.name,
    subtitle: listing.subtitle,
    privacyPolicyUrl: listing.privacyPolicyUrl,
  };
  if (online && r.appInfoLocalizationId) {
    push({
      kind: 'update-appinfo-localization', method: 'PATCH',
      path: `/v1/appInfoLocalizations/${r.appInfoLocalizationId}`,
      note: `update existing ${locale} app info localization (replace, not create). A 409 here usually means the name is not reserved for this app; reserve it in the ASC UI first.`,
      body: { type: 'appInfoLocalizations', attributes: appInfoAttributes },
    });
  } else {
    push({
      kind: 'create-appinfo-localization', method: 'POST',
      path: '/v1/appInfoLocalizations',
      conditional: !online,
      note: online ? `create ${locale} app info localization` : `POST if absent, PATCH otherwise (resolved live). A 409 on name means: reserve the name in the ASC UI first (doc 6.1 has the fallback pair).`,
      body: { type: 'appInfoLocalizations', attributes: { locale, ...appInfoAttributes } },
    });
  }

  // Screenshots: per display type, ensure set, delete existing (replace),
  // then reserve -> upload parts -> commit for each file.
  for (const [displayType, { upload, skipped }] of Object.entries(uploads ?? {})) {
    if (!VALID_DISPLAY_TYPES.includes(displayType)) {
      throw new Error(
        `"${displayType}" is not a valid iPhone screenshot display type. ` +
        `FIX: use one of ${VALID_DISPLAY_TYPES.join(', ')} (from Apple's ScreenshotDisplayType enum).`
      );
    }
    const existingSet = r.screenshotSets?.[displayType];
    if (existingSet) {
      push({
        kind: 'reuse-screenshot-set', method: null, path: null,
        note: `${displayType}: reuse existing appScreenshotSet ${existingSet.id}`,
      });
      for (const shotId of existingSet.screenshotIds ?? []) {
        push({
          kind: 'delete-screenshot', method: 'DELETE', path: `/v1/appScreenshots/${shotId}`,
          note: `${displayType}: delete existing screenshot before re-upload (replace, not duplicate)`,
        });
      }
    } else {
      push({
        kind: 'create-screenshot-set', method: 'POST', path: '/v1/appScreenshotSets',
        conditional: !online,
        note: online
          ? `${displayType}: create screenshot set`
          : `${displayType}: create set only if absent; if it exists its screenshots are deleted first (resolved live)`,
        body: { type: 'appScreenshotSets', attributes: { screenshotDisplayType: displayType } },
      });
    }
    for (const shot of upload) {
      push({
        kind: 'reserve-screenshot', method: 'POST', path: '/v1/appScreenshots',
        displayType, fileName: shot.fileName,
        note: `${displayType}: reserve ${shot.fileName} (${shot.size} bytes)`,
        body: { type: 'appScreenshots', attributes: { fileName: shot.fileName, fileSize: shot.size } },
      });
      push({
        kind: 'upload-parts', method: 'PUT', path: '(presigned uploadOperations URLs from the reservation)',
        displayType, fileName: shot.fileName,
        note: `${displayType}: upload ${shot.fileName} bytes per uploadOperations (method/url/offset/length/requestHeaders)`,
      });
      push({
        kind: 'commit-screenshot', method: 'PATCH', path: '/v1/appScreenshots/{reservationId}',
        displayType, fileName: shot.fileName,
        note: `${displayType}: commit ${shot.fileName} with uploaded=true + MD5 sourceFileChecksum, then poll assetDeliveryState to COMPLETE`,
        body: { type: 'appScreenshots', attributes: { uploaded: true, sourceFileChecksum: '(md5 of file, computed at upload time)' } },
      });
    }
    for (const shot of skipped) {
      push({
        kind: 'skip-screenshot', method: null, path: null,
        displayType, fileName: shot.fileName,
        note: `${displayType}: ${shot.fileName} skipped, per-set limit is ${MAX_SCREENSHOTS_PER_SET} (light set is primary, doc section 8)`,
      });
    }
  }

  return steps;
}

/** The things this tool deliberately never touches. Printed after every run. */
export function neverTouchesChecklist() {
  return [
    'Privacy nutrition labels: NOT pushed. Transcribe APP-STORE-SUBMISSION.md section 7 by hand in ASC.',
    'Age rating questionnaire: NOT pushed. Transcribe section 2; it must calculate 13+.',
    'App Review notes: NOT pushed. Section 6.10 has two preconditions (ADMIN_USER_IDS set; reviewer password re-seeded) that must be true first.',
    'Submission for review: NOT triggered. Nothing here creates an appStoreVersionSubmission or reviewSubmission.',
    'Category selection: NOT pushed. Section 6.9 records the recommendation (Social Networking + Lifestyle); it is Jayden\'s call in the UI.',
  ];
}
