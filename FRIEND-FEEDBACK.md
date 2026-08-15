# Friend feedback, 2026-08-14

Verbatim requests from a friend testing the app, captured from Jayden's
screenshot. Nothing here is built yet. Each item carries what it would take and
anything that blocks it, so the next session can pick these up without
re-deriving the analysis.

## 1. Heat map

A map surface showing where crowds are, rather than the per-venue numbers the
Discover map shows today.

Feasible now. The crowd data already exists: `services/mlPredictor.js` scores any
venue, `/api/crowd/batch` scores many at once, and the Discover map already
renders real venues with photo pins. This is a rendering layer over data the app
already computes, not new intelligence. Cost caution: a heat map over a viewport
implies scoring every visible venue on every pan, so it must ride the existing
batch endpoint plus the Places budget, never one call per pin.

## 2. Apple Pay to pay friends

**Blocked by Apple, not by us, and this needs a decision rather than an
implementation.** Third-party apps cannot initiate Apple Cash person-to-person
payments; there is no public API for it. Apple Pay proper is for paying a
merchant through a payment processor, which is not what a bill split between
friends is. The shipping behavior (Venmo, Cash App, Zelle deep links from
`bill_splits`) is the correct pattern and is what comparable apps do.

What is actually possible, in order of honesty:
- Keep the deep links and make them faster to reach after a split.
- Add Apple Pay only if Flock ever becomes the merchant of record, which means
  taking payments, holding money, and the compliance that follows. Large scope,
  and it changes what the company is.

Recommend telling the friend the honest version rather than shipping something
called Apple Pay that is not.

## 3. "Make birdie smarter, Kome is full"

**Resolved by Jayden: Kome is a restaurant name, not a typo.** The friend saw
Kome, a popular Atlanta restaurant, reading about 20 percent capacity at 6pm.
That is a peak dinner hour at a busy venue, so the number is simply wrong.

This is a crowd prediction accuracy bug, not a Birdie feature request, and it is
the most serious item on this list: crowd forecasting is the app's
differentiator, and a visibly wrong number on a venue the user knows destroys
trust in the whole feature. Under investigation as of 2026-08-14. Leading
suspicions, in order: the scored hour may not be the venue's local hour (6pm
Eastern is 22:00 UTC, and this exact class of bug already shipped once, which
migration 021 corrected in the feedback corpus), the venue may have no entry in
the ml_venues corpus and be answered by the rule fallback's generic curve, or
the venue's Google types may dispatch it into a non-dinner category.

The honesty question rides along with the fix: if the app cannot support a
confident number for a venue it has no data on, it must not assert a precise
percentage anyway.

## 4. Bio on the profile

A profile field other people can view. `users` has `interests` but no bio, so
this is a migration plus a profile edit field plus the viewer surface. Small.
Must go through the same moderation path other user text uses (strip markup,
profanity screen, length cap) and appear in the data export.

## 5. About page section: how it compares to other products

The About page exists (`frontend/src/website/AboutPage.js`). The request is a
comparison section.

Constraint that binds hard here: SLOP-AUDIT rules forbid claiming features the
app does not have, and naming competitors invites both legal and credibility
problems. A comparison section that survives those rules describes what Flock
does and does not do plainly, and lets the reader draw the comparison. No
checkmark grid against named rivals.

## 6. Flock history

A list of past flocks with who was in them and where they went, and a way to run
one again.

Feasible and the data is already there: completed flocks keep their members,
venue, and time. Two pieces of work, a history view and a "do it again" action
that seeds a new flock from an old one's members and venue. The second is the
valuable half, since it turns the archive into the fastest path to a new plan.

## Priority, if these get built

6 and 1 are the two that add real product value on data the app already has. 4
is cheap. 3 needs Jayden to say which reading he meant. 5 is a copy task bound
by the design rules. 2 is a conversation, not a task.
