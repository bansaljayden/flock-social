// ---------------------------------------------------------------------------
// APPLE APP SITE ASSOCIATION
// ---------------------------------------------------------------------------
// Serves https://www.flockcorp.com/.well-known/apple-app-site-association, the
// file iOS fetches to decide whether a flockcorp.com link should open the Flock
// app instead of Safari. Without it, every invite link a user texts opens a web
// page even on a phone that has the app installed, which is what happens today.
//
// This is one half of a two-part switch and the half that lives in this repo.
// The other half is the Associated Domains capability on App ID
// com.flockcorp.flock in the Apple Developer portal, plus the matching
// `com.apple.developer.associated-domains` entitlement, which cannot be added
// until that capability is on or the archive fails to sign (see the long note
// in ios/App/App/App.entitlements). Serving this file early is harmless: iOS
// only ever fetches it for an app that already claims the domain, so until the
// capability is enabled nothing reads it and nothing changes.
//
// WHY THIS IS A FUNCTION AND NOT A STATIC FILE. The payload has to name the
// Apple Team ID, which is not in this repository and should not be pasted into
// it: it lives in APPLE_TEAM_ID on Railway and in the portal. Reading it from
// the environment keeps the one deployment-specific value out of git and makes
// a wrong or missing value fail loudly here rather than silently producing a
// file that iOS rejects without telling anybody.
//
// SET `APPLE_TEAM_ID` IN THE VERCEL PROJECT to the same value Railway carries.
// Until it is set this route answers 503 and says so, which is the honest
// answer: a placeholder Team ID would serve a file that looks correct, parses
// correctly, and silently never matches, and that failure is invisible from the
// outside. An explicit 503 is findable.
//
// THE APPLE RULES THIS FILE HAS TO SATISFY, all of which have bitten people:
//   * It is served from /.well-known/apple-app-site-association with NO file
//     extension. The rewrite in vercel.json points that path here.
//   * Content-Type must be application/json. iOS ignores the file otherwise.
//   * It must be reachable over https with no redirect. A redirect from the
//     apex to www, or www to apex, makes iOS give up, so BOTH hosts have to
//     answer this directly. Vercel serves both from this deployment.
//   * It must not be behind authentication or a bot wall.
//
// WHAT THE PATHS MEAN. `/i/*` is the invite link, which is the whole reason
// this exists: someone texts an invite and it should open the plan in the app.
// `/tap` is deliberately EXCLUDED with a NOT pattern, because that page is the
// NFC card and stand landing page whose entire job is to offer the App Store to
// somebody who does not have the app yet. Opening the app for a person who
// already has it would skip the page, but it would also break the measurement
// the printed cards exist to produce, and the tap page already routes an
// existing user onward in one tap.
// ---------------------------------------------------------------------------

const TEAM_ID_PATTERN = /^[A-Z0-9]{10}$/;

function handler(req, res) {
  const teamId = (process.env.APPLE_TEAM_ID || '').trim();

  if (!teamId) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(503).json({
      error: 'APPLE_TEAM_ID is not set on this deployment, so the app association cannot be served.',
    });
  }

  // An Apple Team ID is ten uppercase alphanumerics. Anything else is a typo or
  // a value copied with quotes or whitespace still attached, and every one of
  // those produces a file iOS silently refuses. Fail here where it is visible.
  if (!TEAM_ID_PATTERN.test(teamId)) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(503).json({
      error: 'APPLE_TEAM_ID is set but is not a ten character Apple Team ID.',
    });
  }

  const appId = `${teamId}.com.flockcorp.flock`;

  const payload = {
    applinks: {
      details: [
        {
          appIDs: [appId],
          components: [
            { '/': '/tap', exclude: true, comment: 'the NFC landing page offers the App Store on purpose' },
            { '/': '/tap*', exclude: true, comment: 'same page with a source parameter' },
            { '/': '/i/*', comment: 'flock invite links open the plan in the app' },
          ],
        },
      ],
    },
    // Declared so a future Sign in with Apple or password autofill flow works
    // without a second round trip through the portal. Harmless while unused.
    webcredentials: { apps: [appId] },
  };

  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  // iOS caches this aggressively and re-fetches on app install and update.
  // A short cache keeps a corrected Team ID from being stuck for a day.
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  return res.status(200).json(payload);
}

module.exports = handler;
module.exports.default = handler;
