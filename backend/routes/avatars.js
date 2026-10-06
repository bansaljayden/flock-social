'use strict';
// GET /api/avatars/:style/svg?seed=<seed> — the cartoon avatars, drawn here
// (services/avatarArt.js says why). PUBLIC: an <img> cannot send a token, and
// the picture for a style and seed is the same for everybody, so there is
// nothing to protect. Mounted before the /api catch-alls in server.js, behind
// apiLimiter like every other public route.
const express = require('express');
const { isAvatarStyle, isAvatarSeed, renderAvatarSvg } = require('../services/avatarArt');

const router = express.Router();

router.get('/:style/svg', async (req, res) => {
  const { style } = req.params;
  const { seed } = req.query;
  if (!isAvatarStyle(style)) return res.status(404).json({ error: 'No such avatar style' });
  if (!isAvatarSeed(seed)) return res.status(400).json({ error: 'Invalid avatar seed' });
  try {
    const svg = await renderAvatarSvg(style, seed);
    res.set({
      'Content-Type': 'image/svg+xml; charset=utf-8',
      // A style and seed always draw the same picture, so a copy can be kept
      // for a year: each person's avatar is fetched once per device.
      'Cache-Control': 'public, max-age=31536000, immutable',
      // Opened on its own, the file can do nothing: no scripts, no fetches,
      // nothing but its own inline styles and images.
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox",
    });
    return res.send(svg);
  } catch (err) {
    console.error('[avatars] could not draw an avatar:', err?.message || err);
    return res.status(500).json({ error: 'Could not draw that avatar' });
  }
});

module.exports = router;
