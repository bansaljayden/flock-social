# MODERATION-LEGAL.md - child safety reporting duties (CSAM)

Written 2026-08-14 for a solo operator. This is a working summary of federal law
plus the exact steps to take, not legal advice. The statute is short; read it
once: 18 U.S.C. § 2258A (https://www.law.cornell.edu/uscode/text/18/2258A), as
amended by the REPORT Act (Pub. L. 118-59, May 2024).

This is the one compliance area on this app with criminal-law stakes. Everything
else in moderation is App Store policy. This page is federal law.

---

## 1. Does this law apply to Flock?

Yes. § 2258A applies to any "provider" - an electronic communication service or
remote computing service offered to the public (§ 2258E, cross-referencing
§§ 2510 and 2711). There is NO size threshold, no user minimum, no revenue
floor. A social app with photo sharing and ~0 users is a provider the same as
Meta is. The only thing user count changes is the fine tier (below).

## 2. What is REQUIRED vs what is not

REQUIRED by statute:

1. **Report on actual knowledge.** On obtaining actual knowledge of an apparent
   violation of §§ 2251, 2251A, 2252, 2252A, 2252B, or 2260 (child sexual
   abuse material), § 1591 involving a minor (sex trafficking), or § 2422(b)
   (enticement of a minor - the last two added by the REPORT Act), file a
   report with the NCMEC CyberTipline "as soon as reasonably possible"
   (§ 2258A(a)).
2. **Preserve for one year.** After submitting a CyberTipline report, preserve
   the reported content plus anything reasonably accessible that gives it
   context (the image, the surrounding messages, the account data) for ONE YEAR
   (§ 2258A(h) - the REPORT Act extended this from 90 days). Keep it in a
   secure location with access limited to as few people as possible, handled
   consistent with the NIST Cybersecurity Framework.
3. **Confidentiality.** Do not announce reports. Nothing in the statute
   authorizes telling the user they were reported, and doing so can tip off a
   subject of a federal investigation. Say nothing to the reported user beyond
   normal moderation messaging (content removed, account banned).

NOT required:

- **No proactive scanning duty.** § 2258A(f) says outright that nothing in the
  section requires a provider to monitor users or affirmatively search, screen,
  or scan for violations. The SafeSearch gate in `backend/utils/moderation.js`
  is voluntary product safety, not a legal obligation, and running it does not
  create new duties.

Penalty for skipping the required part: knowing and willful failure to report
is punishable by fines that the REPORT Act raised to $600,000 for a first
violation and $850,000 for subsequent ones at Flock's size (under 100M monthly
active users), higher above that (§ 2258A(e)).

BEST PRACTICE (voluntary, not required):

- Hash matching against known CSAM (PhotoDNA, NCMEC hash lists via § 2258C,
  Google CSAI Match) and classifier-based detection (Google Content Safety
  API). These are vetted-access programs; worth applying for if the app grows.
  Until then, the human report queue is the detection channel, and that is a
  legally sufficient posture.
- Registering as an ESP with NCMEC before the first report, so the reporting
  path already exists on the day it is needed (see § 6).

## 3. What "actual knowledge" means here

Google Cloud Vision SafeSearch is NOT a CSAM detector. Its `adult` category
cannot judge age. A SafeSearch rejection is therefore not knowledge of
anything, and a rejected upload is refused BEFORE storage, so no copy exists
and nothing attaches to it.

Knowledge arrives when a human looks at content and recognizes apparent CSAM.
In this app that means:

- A user files a report (reason `sexual` is where these land - the report
  vocabulary has no dedicated child-safety reason) and you open it in the
  moderation queue at `/admin/moderation`.
- You see it directly in any other context.

Viewing reported content to assess it is the moderation job, and § 2258B gives
providers good-faith immunity for the reporting, storage, and handling that
this process requires.

## 4. THE STEPS - when a report that might be CSAM lands

You will know because the alert is distinct: the email subject starts with
"CHILD SAFETY:", and the server log carries the token `[CHILD-SAFETY]`
(grep the Railway logs for exactly that string).

1. **Look at it now, not later.** Open `/admin/moderation` and assess the
   reported content. "As soon as reasonably possible" is the statutory clock
   and it starts at knowledge. If it is clearly not CSAM (adult-looking adults,
   spam, a bad-faith report), handle it as a normal report and stop here.

2. **If it appears to involve a minor: PRESERVE FIRST, before any other
   action.** Do not hide it yet, do not ban yet, do not resolve the report yet.
   The database will not preserve this for you:
   - Account deletion (`DELETE /api/users/me`) hard-deletes the user's
     messages and cascades away their stories and DMs, reported or not. The
     offender can destroy the evidence with one authenticated request at any
     moment.
   - The story purge keeps rows only while a report is `open`/`under_review`;
     after resolution the row is deleted on the normal retention schedule.

   Export now, to an encrypted disk or encrypted archive OFF the production
   database, access limited to you. Image bytes live inline in the rows as
   `data:` URLs (`stories.image_url`, `messages.image_url`,
   `direct_messages.image_url`), so a row export IS the image export.
   From a machine with prod `PG*` credentials (see the Railway dashboard):

   ```
   -- Replace the ids. \copy writes a local CSV; run one per relevant table.
   \copy (SELECT * FROM content_reports WHERE id = <REPORT_ID>) TO 'report.csv' CSV HEADER
   \copy (SELECT * FROM stories WHERE id = <CONTENT_ID>) TO 'story.csv' CSV HEADER
   \copy (SELECT * FROM messages WHERE id = <CONTENT_ID>) TO 'message.csv' CSV HEADER
   \copy (SELECT * FROM direct_messages WHERE id = <CONTENT_ID>) TO 'dm.csv' CSV HEADER
   -- Context: the uploader's account and their other recent content.
   \copy (SELECT id, email, phone, name, oauth_provider, oauth_id, date_of_birth, created_at FROM users WHERE id = <UPLOADER_ID>) TO 'account.csv' CSV HEADER
   ```

   Also record: report id, timestamps, uploader user id, reporter user id, and
   which surface it appeared on. Keep this archive for ONE YEAR from the day
   you file the CyberTipline report. Do not put it in the repo, in cloud
   storage you share, or on a personal phone.

3. **File the CyberTipline report.** Registered path: the ESP account (see § 6)
   at https://report.cybertip.org/ispws. Not registered yet: use the public
   form at https://report.cybertip.org/ (works for any entity; phone
   1-800-843-5678). Include what § 2258A(b) asks for: your contact info
   (operator name, email, mailing address, phone), the facts (what was posted,
   where, when, by which account), and the uploader identifiers you have
   (email, IP if available, OAuth identity). Save the CyberTipline report ID
   NCMEC gives you into the evidence archive.

4. **Now take it down in-app.** Use the moderation console: hide the content
   (takedown sets `is_hidden`, it does not delete) and ban the account. Do NOT
   delete rows by hand, and do not use any path that deletes.

5. **Say nothing to the reported user** beyond the standard removed/banned
   messaging. Do not mention NCMEC, law enforcement, or a report.

6. **If law enforcement or NCMEC contacts you**, cooperate through legal
   process, hand over the preserved archive when lawfully requested, and note
   that § 2258A(g) restricts what they and you may disclose onward.

7. **Log it for yourself**: date of knowledge, date reported, CyberTipline
   report ID, where the evidence archive lives. One year later you may delete
   the archive unless law enforcement asked you to hold it.

## 5. Where this touches the code

- `backend/utils/moderation.js` - voluntary SafeSearch gate; emits
  `[CHILD-SAFETY]` at error level when an upload scores adult LIKELY or
  VERY_LIKELY (a pattern signal, not knowledge; the image was never stored).
- `backend/services/moderationAlerts.js` - reports with reason `sexual` get a
  distinct log token, a "CHILD SAFETY:" mail subject, a statutory note in the
  mail body, and a separate email rate window so report spam cannot starve
  this category of alerts.
- `backend/routes/stories.js` - the retention purge skips stories with
  open/under-review reports; the file documents why that is not sufficient for
  § 2258A(h) preservation (step 2 above is).
- `backend/routes/users.js` (`deleteAccount`) - documents that account
  deletion destroys the author's content including reported content, which is
  the other reason step 2 says preserve first.
- Takedown (`backend/routes/admin.js`) hides content (`is_hidden = true`)
  rather than deleting it, and bans write `banned_identities` tombstones that
  outlive the account.

## 6. One-time setup (human steps, in order of value)

- [ ] Register Flock as an ESP with NCMEC at https://esp.ncmec.org/registration
      (org account; needs a real point of contact and takes a human
      conversation). Do this before launch scale, not after the first incident.
- [ ] Decide and set up the evidence location now: an encrypted volume or
      password-protected archive on a machine only you control, so step 2 is a
      two-minute action instead of a research project during an incident.
- [ ] Set `MODERATION_ALERT_EMAIL` on Railway to an inbox you actually read;
      the child-safety alert rides the same email leg as every other report
      alert. (`ADMIN_USER_IDS` too - the moderation console is unreachable
      without an admin account.)
- [ ] If the app grows real volume: apply for Google's Content Safety API /
      CSAI Match or Microsoft PhotoDNA (voluntary hash matching, § 2258C).

## 7. Sources

- 18 U.S.C. § 2258A: https://www.law.cornell.edu/uscode/text/18/2258A
- 18 U.S.C. § 2258B (good-faith immunity): https://www.law.cornell.edu/uscode/text/18/2258B
- 18 U.S.C. § 2258C (hash sharing): https://www.law.cornell.edu/uscode/text/18/2258C
- 18 U.S.C. § 2258E (definitions): https://www.law.cornell.edu/uscode/text/18/2258E
- REPORT Act, Pub. L. 118-59: https://www.congress.gov/bill/118th-congress/senate-bill/474
- NCMEC CyberTipline: https://report.cybertip.org/ and https://www.missingkids.org/gethelpnow/cybertipline
- ESP registration: https://esp.ncmec.org/registration
