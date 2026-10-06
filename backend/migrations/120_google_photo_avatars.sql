-- 120: a Google profile photo is no longer anyone's avatar.
--
-- ASCII only, like 094 and 100-102: the embedded server the boot-safety suite
-- runs is WIN1252.
--
-- WHY. Google sign-in stored the `picture` claim from the verified token as
-- profile_image_url: a link to Google's image host, on every new Google
-- account, and on a password account a Google sign-in claimed while it had no
-- avatar of its own. Every other avatar is either a photo the upload route
-- screened (moderateImage), stripped of its metadata and stored as a data URL,
-- or a drawn one (services/avatarArt.js). This one was neither, and it showed
-- on every roster, chat row and friends list, so a picture the upload screen
-- refuses could be set as the Google photo and brought in by signing in. A
-- link is not a picture either: what it shows can change after any check.
-- Sign-in no longer stores it (routes/auth.js, NOT THE PICTURE).
--
-- WHICH ROWS. An http(s) link whose host is googleusercontent.com or a
-- subdomain of it, which is where the claim points. Data URLs, drawn avatars
-- and anything else are left as they are. A cleared account shows the
-- initial, as a new account does, and its owner can add a photo through the
-- screened upload. An open report about one of these photos reads the live
-- column (routes/admin.js), so it will say no image is attached; the photo is
-- off every surface either way.
--
-- NOT REVERSIBLE, on purpose: none of these links was ever screened.
-- Idempotent: a cleared row no longer matches.
UPDATE users
   SET profile_image_url = NULL
 WHERE profile_image_url ~* '^https?://([a-z0-9-]+\.)*googleusercontent\.com([/:?#]|$)';
