-- 116: drawn avatars point at Flock, not at DiceBear's hosted API.
--
-- ASCII only, like 094 and 100-102: the embedded server the boot-safety suite
-- runs is WIN1252.
--
-- WHY. The avatar button saved https://api.dicebear.com/7.x/<style>/svg?seed=<seed>,
-- and every device that showed the picture fetched it from DiceBear. That API
-- is free for non-commercial use only. The server now draws the same picture
-- itself (services/avatarArt.js, GET /api/avatars/<style>/svg), and the 9.x
-- packages it uses draw exactly what the hosted 7.x API drew for the same
-- style and seed, so this rewrite changes no one's avatar.
--
-- WHICH ROWS. Only the exact form the button wrote, one of the five styles it
-- picked from, and a seed of 1 to 64 letters and digits; the same rule
-- canonicalAvatarUrl applies to a new save. Anything else is left as it is.
-- The host is the production API (the address the app itself calls,
-- frontend/src/services/api.js), the same origin baseApiUrl() answers there.
--
-- REVERSIBLE by the same replace the other way round, and idempotent: a
-- rewritten row no longer matches.
UPDATE users
   SET profile_image_url = regexp_replace(
         profile_image_url,
         '^https://api\.dicebear\.com/7\.x/(adventurer|avataaars|bottts|personas|pixel-art)/svg\?seed=([A-Za-z0-9]{1,64})$',
         'https://api.flockcorp.com/api/avatars/\1/svg?seed=\2'
       )
 WHERE profile_image_url ~ '^https://api\.dicebear\.com/7\.x/(adventurer|avataaars|bottts|personas|pixel-art)/svg\?seed=[A-Za-z0-9]{1,64}$';
