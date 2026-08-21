-- 041: the list of addresses Flock is not allowed to mail.
--
-- Nothing in this codebase held one. Every send path checked whether an
-- address LOOKED deliverable (services/emailService.js isMailableAddress) and
-- whether the recipient had switched a feature off (venue_profiles
-- notification_prefs.weekly), and neither of those is the same question as
-- "did the last message to this address bounce, or did this person ask us to
-- stop". So a venue owner whose mailbox was deleted kept being mailed every
-- Monday forever, each send charged by Resend and each hard bounce spent
-- against the sending domain's reputation, which is what eventually puts the
-- password-reset mail in everybody else's spam folder.
--
-- TWO KINDS, because they are not the same promise:
--
--   'bounce'      the address does not exist / the server permanently refused.
--   'complaint'   the recipient pressed "this is spam".
--                 Both block EVERYTHING. There is no message worth sending to
--                 an address that cannot receive one, and a complaint is the
--                 strongest possible instruction to stop.
--
--   'unsubscribe' the recipient used an unsubscribe link.
--                 Blocks MARKETING only. Unsubscribing from the waitlist must
--                 not silently break that person's password reset later, and
--                 an SOS to a trusted contact is not a mailing they opted
--                 into in the first place.
--
-- The address is stored lowercased and trimmed (services/emailSuppression.js
-- normalises before both the read and the write), so the primary key is the
-- address as a mailbox rather than as a string somebody typed.
CREATE TABLE IF NOT EXISTS email_suppressions (
  email TEXT PRIMARY KEY,
  reason TEXT NOT NULL CHECK (reason IN ('bounce', 'complaint', 'unsubscribe')),
  detail TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The send path asks "is this address suppressed at all", and only then reads
-- the reason to decide whether a transactional message may still go. One index
-- on reason keeps the operator query ("how many hard bounces this month")
-- off a sequential scan once the table is not tiny.
CREATE INDEX IF NOT EXISTS idx_email_suppressions_reason ON email_suppressions(reason, created_at);
