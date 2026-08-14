const express = require('express');
const { authenticate } = require('../middleware/auth');
const { getEntitlements } = require('../services/entitlements');

const router = express.Router();

router.use(authenticate);

// GET /api/entitlements — current user's premium status + Birdie quota.
// Response shape (frontend contract):
// { isPremium, paywallEnabled,
//   birdie:   { limit, used, remaining },
//   forecast: { limit, used, remaining } }
router.get('/', async (req, res) => {
  try {
    // Per-account state on a route that answers differently for every caller,
    // and the one answer in the app that decides whether somebody sees a
    // paywall. Nothing between us and the client may keep a copy: a shared
    // cache that held this for even a few seconds could hand one user another
    // user's subscription state, and a client cache could keep serving "not a
    // subscriber" after a purchase. `private` is not enough for the first of
    // those, so it is no-store.
    res.set('Cache-Control', 'no-store');

    // authenticate() sets req.user, and every path through it either sets one
    // or answers 401 itself. Belt and braces so a future change to the
    // middleware cannot turn this into a TypeError that reads as a server bug.
    if (!req.user?.id) return res.status(401).json({ error: 'Authentication required' });

    const entitlements = await getEntitlements(req.user.id);
    res.json(entitlements);
  } catch (err) {
    // A LOOKUP THAT FAILED IS NOT AN ANSWER OF "NO".
    //
    // getEntitlements throws rather than reporting isPremium:false when it
    // could not read users.is_premium. The client holds this snapshot for the
    // whole session, so answering 200 with a confident false during a database
    // blip shows the upgrade sheet to somebody who already paid, and keeps
    // showing it until they restart the app. 503 leaves the client with no
    // snapshot, which renders as neither Pro nor paywalled, and is retryable.
    if (err?.entitlementUnavailable) {
      console.error('Get entitlements unavailable:', err.reason);
      res.set('Retry-After', '5');
      return res.status(503).json({
        error: 'Could not check your plan just now. Try again.',
        code: 'ENTITLEMENT_UNAVAILABLE',
        retryable: true,
      });
    }
    console.error('Get entitlements error:', err);
    res.status(500).json({ error: 'Failed to get entitlements' });
  }
});

module.exports = router;
