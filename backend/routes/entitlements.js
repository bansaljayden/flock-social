const express = require('express');
const { authenticate } = require('../middleware/auth');
const { getEntitlements } = require('../services/entitlements');

const router = express.Router();

router.use(authenticate);

// GET /api/entitlements — current user's premium status + Birdie quota.
// Response shape (frontend contract):
// { isPremium, paywallEnabled, birdie: { limit, used, remaining } }
router.get('/', async (req, res) => {
  try {
    const entitlements = await getEntitlements(req.user.id);
    res.json(entitlements);
  } catch (err) {
    console.error('Get entitlements error:', err);
    res.status(500).json({ error: 'Failed to get entitlements' });
  }
});

module.exports = router;
