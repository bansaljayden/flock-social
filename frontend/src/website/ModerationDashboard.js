import React, { useEffect, useState, useCallback, useRef } from 'react';
import { getToken, BASE_URL } from '../services/api';
import Icons from '../components/ui/Icons';

// Admin-only moderation console (A6). Routed at /admin/moderation.
// Backed by GET/PUT /api/admin/reports + GET /api/admin/moderation-actions,
// all gated server-side by requireAdmin. Reviewers / the solo mod use this to
// action reports promptly (Apple 1.2 / Google UGC).

const REASON_LABEL = {
  harassment: 'Harassment', hate: 'Hate speech', sexual: 'Sexual content',
  violence: 'Violence/threats', self_harm: 'Self-harm', spam: 'Spam', other: 'Other',
};
// One entry per value in VALID_CONTENT_TYPES (backend/routes/moderation.js).
// A type that can be reported and is missing here renders as a raw column value
// like `guest_rsvp` on the one screen where a human has to decide what it is.
const TYPE_LABEL = {
  flock_message: 'Flock message', dm: 'Direct message', story: 'Story',
  profile: 'Profile', venue_review: 'Venue review', venue_promotion: 'Venue promotion',
  guest_rsvp: 'Guest RSVP', venue_event: 'Venue event',
};
// Types that appear in the AUDIT LOG only, never in the queue. A separate map
// on purpose: TYPE_LABEL is pinned to VALID_CONTENT_TYPES both ways (a queue
// type it cannot label renders raw; a label with no full-text source behind it
// would put a button on a card that can only 404), and venue_profile is
// neither — it is what the verify and tier routes (migration 020) write on
// their audit rows. Without this the log printed the raw column value.
const AUDIT_TYPE_LABEL = { venue_profile: 'Venue profile' };
// One entry per value migration 020 allows in moderation_actions.action. A
// value missing here used to fall back to replace(/_/g, ' '), which turned
// `tier_changed` into the shrugged "tier changed" on the permanent record.
// The fallback stays for a value added server-side before this map hears of
// it, but every value the server writes TODAY is named.
const ACTION_LABEL = {
  content_hidden: 'Content hidden', content_restored: 'Content restored',
  // 'user_warned' has been legal in the moderation_actions CHECK since
  // migration 001 and nothing wrote one until the Warn control below existed.
  user_warned: 'User warned', user_banned: 'User banned', user_unbanned: 'User unbanned',
  dismissed: 'Report dismissed', tier_changed: 'Venue tier changed',
  venue_verified: 'Venue verified', venue_unverified: 'Venue verification removed',
  evidence_viewed: 'Evidence viewed',
};
// What the audit log's last-action line should say on a card, in the past
// tense and short enough to sit in a sentence. Same keys, different job: the
// log labels a row, this finishes "last time we".
const PRIOR_ACTION_LABEL = {
  content_hidden: 'took content down', content_restored: 'restored content',
  user_warned: 'warned them', user_banned: 'banned them', user_unbanned: 'unbanned them',
  dismissed: 'dismissed the report', tier_changed: 'changed their venue tier',
  venue_verified: 'verified their venue', venue_unverified: 'removed their venue verification',
};
// Mirrors TAKEDOWN_TARGETS in backend/routes/admin.js: seven types have an
// is_hidden row behind them, 'profile' does not (a profile report is answered
// with a ban or a dismissal, and the server refuses 'hide' on it outright).
//
// Round 9 added venue_review / venue_promotion. Round 21 added guest_rsvp and
// venue_event: the server has hidden guest RSVPs since migration 005 and venue
// events since 019, and neither could be actioned from here, so an abusive
// guest name broadcast to a whole flock had a report path and no takedown
// button at the end of it.
const HIDEABLE = {
  flock_message: true, dm: true, story: true, profile: false,
  venue_review: true, venue_promotion: true, guest_rsvp: true, venue_event: true,
};
// The queue serves 'open' and (via the duplicate-report check) 'under_review'.
// Both are unhandled; resolved and dismissed are finished.
const UNHANDLED_STATUS = { open: true, under_review: true };

// Every lookup on the maps above goes through this. A bare `MAP[value]` answers
// 'constructor' and '__proto__' off the prototype chain with something truthy,
// which on HIDEABLE would render a Hide button for a content type that has no
// takedown behind it. The CHECK constraints on content_reports make that
// unreachable today; backend/routes/admin.js guards the same way for the same
// reason, and this file agrees with it rather than trusting a constraint it
// cannot see.
const own = (map, key) => (Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined);
const typeLabel = (t) => own(TYPE_LABEL, t) || own(AUDIT_TYPE_LABEL, t) || t || 'content';
const actionLabel = (a) => own(ACTION_LABEL, a) || String(a || '').replace(/_/g, ' ');
// Mid-sentence form. Only the first letter drops, so "Guest RSVP" reads as
// "guest RSVP" in "Hide this guest RSVP?" instead of the shouted-down "guest rsvp".
const lowerLabel = (t) => {
  const s = typeLabel(t);
  return s.charAt(0).toLowerCase() + s.slice(1);
};

// WHICH FAILURES ARE ACTUALLY "YOU ARE NOT SIGNED IN HERE".
//
// This console reads its bearer token out of localStorage on whatever origin it
// loads on, and the most likely way to arrive is a browser that has never had
// the Flock app open: a different laptop, a private window, the phone handing
// the address to Safari from inside the native shell. That is not a 403. It is
// middleware/auth.js answering 401 "No token provided", and the hint used to
// match on /403|Admin/ alone, so the one arrival that most needs the sentence
// was the one that never got it: a moderator opening the queue at two in the
// morning read the words "No token provided" and no next step.
//
// Matched on the server's own strings rather than on the status code, because
// adminFetch throws an Error carrying the message and the status is gone by the
// time this renders. All five 401 messages in middleware/auth.js are covered:
// no token, user no longer exists, session expired, token expired, invalid
// token. An unrelated failure (a 500 on the audit log, a dropped connection)
// still gets no hint, because telling somebody to sign in when they already are
// sends them away from a problem that is not theirs.
const needsSignIn = (m) => /403|admin access|token|session expired|sign in/i.test(String(m || ''));

// ---------------------------------------------------------------------------
// CHILD SAFETY, ON THE SCREEN WHERE THE DECISION IS MADE
// ---------------------------------------------------------------------------
//
// A report filed under 'sexual' is the only category in this product with a
// federal reporting duty behind it (18 U.S.C. 2258A, and the app's floor is
// 13). services/moderationAlerts.js has always given those reports a distinct
// email subject and a distinct log token, and the queue then rendered one as an
// ordinary row: same card, same three buttons, no sign that MODERATION-LEGAL.md
// exists or that its § 4 step 2 says to preserve the evidence BEFORE touching
// any of them.
//
// That gap is not cosmetic. Closing a report releases the holds that keep
// reported evidence alive: routes/stories.js refuses to delete a story only
// while its report is open or under review, and migration 020's owner_deleted_at
// sweep works the same way for venue rows. So the natural first click on a
// child-safety report is the one that starts the clock on the thing a
// CyberTipline report is supposed to be about.
//
// The flag is computed SERVER-side (routes/admin.js reads isChildSafetyReason
// from the same module the alerting uses) so this console cannot drift from the
// alert path. The fallback below only covers a server too old to send the
// field, and it is the same single reason value.
const isChildSafety = (r) => (
  typeof r.child_safety === 'boolean' ? r.child_safety : r.reason === 'sexual'
);

async function adminFetch(path, options = {}) {
  const token = getToken();
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(options.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

const fmt = (t) => {
  if (!t) return '';
  const d = new Date(t);
  // toLocaleString on an unparseable value prints the literal string
  // "Invalid Date" next to a real one, which reads as a timestamp nobody can
  // question. An em dash for "we do not know" is the honest render.
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
};

// The queue is paginated (backend/routes/admin.js, round 24): the server takes
// `limit` (default 200, max 1000) and orders unhandled work OLDEST-first, so
// the report that has waited longest is always row one — the pre-round-24
// ordering dropped exactly those rows once open reports outgrew 200, which is
// the one failure Guideline 1.2's "act promptly" names. The console asks for a
// growing window rather than appending pages: every load re-reads the whole
// window in one request, so there is no append/dedupe state to go stale and a
// refresh cannot lose a moderator's place. The audit log is still a plain
// LIMIT 200 list, and its header counts come from a GROUP BY over the whole
// table, so both lists say when they are showing less than everything.
const LIST_LIMIT = 200;
// Must not exceed QUEUE_LIMIT_MAX in backend/routes/admin.js — a larger ask is
// a 400, which would read as "the console is broken" on a Load more click.
// __tests__ pin the two against each other.
const WINDOW_MAX = 1000;

// Must match the LIMIT on GET /api/admin/venues/unverified in
// backend/routes/admin.js. That route has no offset and no hasMore, so a full
// list is the only signal that there may be more behind it, and a console that
// does not say so presents a truncated list as the whole of it.
const VENUE_LIST_LIMIT = 200;

// How long a request has been sitting, in whole days, from the timestamp the
// server sent. Derived, never invented: an unparseable or future value returns
// nothing at all rather than a confident "0 days".
// The "how long has this sat" line for report cards. Venue claims always
// printed it; reports, the surface Apple's "act promptly" language is about,
// showed only the filing date and left the arithmetic to the moderator.
const reportAge = (t) => {
  const d = daysWaiting(t);
  if (d == null || d < 1) return '';
  return `  \u00b7  waiting ${d} ${d === 1 ? 'day' : 'days'}`;
};

const daysWaiting = (t) => {
  if (!t) return null;
  const then = new Date(t).getTime();
  if (Number.isNaN(then)) return null;
  const days = Math.floor((Date.now() - then) / 86400000);
  return days >= 0 ? days : null;
};

export default function ModerationDashboard() {
  // ONE READ, ONE VERDICT, AND EACH VERDICT LIVES WITH ITS OWN DATA.
  //
  // Three reads now, not the two this note was written about: the queue, the
  // audit log, and the unverified venue claims. The rule did not change with
  // the third, which is the whole point of writing it down as a rule.
  //
  // One shared `error` string had two failure modes, both of them the console
  // saying something untrue about a list it never touched. An audit-log failure
  // printed "The queue could not be loaded, so this is not a count of anything."
  // over a queue that had loaded perfectly and was genuinely empty — and the
  // sentence it replaced, "Queue is clear.", is the one sentence on this screen
  // that must never be wrong in either direction. The reads were also
  // sequential inside one try, so a failure on the queue meant the audit log
  // was never fetched at all and then reported as having failed.
  //
  // Two loose strings would have fixed the symptom. Keeping each error in the
  // same object as the rows it is about is what makes the class of bug hard to
  // re-introduce: there is no `error` in scope that could be paired with the
  // wrong list.
  const [queue, setQueue] = useState({ reports: [], counts: [], hasMore: false, error: '' });
  const [log, setLog] = useState({ actions: [], error: '' });
  // The window the console is asking the server for. A ref, not state: `load`
  // must stay referentially stable (the mount effect keys on it) while still
  // reading the CURRENT window on a background refresh, so a moderator who has
  // loaded 600 rows keeps all 600 across the refresh an action triggers.
  const windowRef = useRef(LIST_LIMIT);
  // Loading MORE is neither loading nor refreshing: it must not blank the
  // screen and its failure is about the next page, not about the rows already
  // up. Its error lives here so it can never be printed over the queue.
  const [more, setMore] = useState({ busy: false, error: '' });
  // Whether the audit log includes 'evidence_viewed' access records. The
  // server excludes them by default so access noise cannot drown decisions;
  // the ref is what loadLog reads, so the mount-time load and a toggle-time
  // reload go through one code path.
  const [showEvidence, setShowEvidence] = useState(false);
  const showEvidenceRef = useRef(false);
  // reportId -> the optional reason typed for that card, sent with whichever
  // action is clicked and stored verbatim in the audit log.
  const [reasons, setReasons] = useState({});
  const [loading, setLoading] = useState(true);
  // Refreshing is NOT loading. `setLoading(true)` on every refresh replaced the
  // whole queue with the word "Loading…", so a moderator half way down a
  // 200-row list lost their place, lost every image and body they had opened
  // from the screen, and watched the evidence they were judging disappear. The
  // first load owns the blank screen; every later one keeps the queue up.
  const [refreshing, setRefreshing] = useState(false);
  const [busyId, setBusyId] = useState(null);
  // The last action's side effect, in one sentence. Not an error and not a
  // toast: there is no toast on this screen, and an alert() for something that
  // went right would make a moderator dismiss a dialog after every takedown.
  const [note, setNote] = useState('');
  // reportId -> { status: 'loading' | 'ready' | 'collapsed' | 'error',
  //               url, error, renderFailed, attempt }
  // Keyed by report id, which is stable across a refresh, so a picture a
  // moderator already opened is not re-fetched every time the queue reloads.
  const [images, setImages] = useState({});
  // reportId -> { status: 'loading' | 'ready' | 'error',
  //               text, clipped, totalLength, error }
  // Same keying, same reason, same shape as `images` above.
  const [texts, setTexts] = useState({});
  // THE VENUE CLAIMS WAITING ON A HUMAN, which nothing rendered anywhere.
  //
  // Migration 047 gave an owner a button that asks to be verified, and
  // routes/venueProfile.js answers "we confirm ownership by hand". The admin
  // half of that promise has existed since migration 020 (GET
  // /api/admin/venues/unverified lists the claims requested-first,
  // PUT /api/admin/venues/:profileId/verify decides one and writes a
  // moderation_actions row) and NO FRONTEND HAS EVER CALLED EITHER ROUTE. The
  // only notice a request generated was an email telling the operator to run
  // the PUT by hand, and the only way to see the queue was a psql prompt. So
  // "we confirm ownership by hand" was a promise kept by nobody: verification
  // gates the public badge, promotions, review replies and the whole Roost
  // advisor, and every claim sat where it landed.
  //
  // Its own state and its own error, for the reason the queue and the audit
  // log have theirs: one shared `error` string is how a screen ends up saying
  // something untrue about a list it never read.
  const [venues, setVenues] = useState({ list: [], error: '' });
  // profileId -> the optional reason typed for that claim, sent with whichever
  // decision is clicked and stored verbatim in moderation_actions. The same
  // control the report cards carry, and it matters more here: "why does this
  // business hold a badge" is a question with a person's word behind it.
  const [venueReasons, setVenueReasons] = useState({});
  const [venueBusyId, setVenueBusyId] = useState(null);
  // profileId -> the server's own refusal. A place already verified by someone
  // else comes back as a 409 naming the conflicting account and the place id,
  // which is the whole answer to why the click did nothing. alert() would
  // throw that sentence away the moment it is dismissed, so it renders on the
  // card it is about.
  const [venueErrors, setVenueErrors] = useState({});
  const [venueNote, setVenueNote] = useState('');
  // Claims nobody has asked about are collapsed. An owner who has not pressed
  // the button has not asked, and 200 unrequested claims above the audit log
  // would bury the handful that are actually waiting.
  const [showUnrequested, setShowUnrequested] = useState(false);

  // Drop the opened evidence for reports that are no longer in the queue.
  // `images` holds base64 bodies up to 700KB of reported UGC, sometimes
  // posted by a minor, which the server sets Cache-Control: no-store on
  // precisely so that nothing holds on to it — and this map was keyed by
  // report id and never pruned, so anything a moderator opened stayed in
  // memory for the life of the tab even after the row rotated out of the
  // window. Closing an image already frees it; this frees the ones that were
  // never closed. Typed-but-unsent reasons go with them: a reason drafted for
  // a report that has left the window would otherwise sit silently attached
  // to nothing. Shared by load and loadMore, so both reads free the same way.
  const pruneEvidence = useCallback((reports) => {
    const live = new Set(reports.map((row) => String(row.id)));
    const prune = (prev) => {
      const keys = Object.keys(prev).filter((k) => !live.has(k));
      if (keys.length === 0) return prev;
      const next = { ...prev };
      for (const k of keys) delete next[k];
      return next;
    };
    setImages(prune);
    setTexts(prune);
    setReasons(prune);
  }, []);

  // The audit log, alone: the queue read must not decide whether this runs
  // (two endpoints, one being down says nothing about the other), and the
  // evidence toggle re-reads THIS list without re-reading the queue.
  const loadLog = useCallback(async () => {
    try {
      const a = await adminFetch(`/api/admin/moderation-actions${showEvidenceRef.current ? '?include_evidence=true' : ''}`);
      if (!Array.isArray(a.actions)) {
        throw new Error('The audit log came back in a shape this console does not understand. Reload the page.');
      }
      setLog({ actions: a.actions, error: '' });
    } catch (e) { setLog((p) => ({ ...p, error: e.message || 'The audit log could not be loaded.' })); }
  }, []);

  // The venue claims, alone, for the same reason: three endpoints, and one
  // being down says nothing about the other two. The rows are deliberately NOT
  // cleared on a failure, so a dropped request does not empty a list somebody
  // is working through; the banner says the read failed instead.
  const loadVenues = useCallback(async () => {
    try {
      const v = await adminFetch('/api/admin/venues/unverified');
      if (!Array.isArray(v.venues)) {
        throw new Error('The venue queue came back in a shape this console does not understand. Reload the page.');
      }
      setVenues({ list: v.venues, error: '' });
      // Typed-but-unsent reasons and stale refusals belong to claims that are
      // still on the screen. A claim that has been decided leaves this list,
      // and its draft must not sit silently attached to nothing.
      const live = new Set(v.venues.map((row) => String(row.id)));
      const prune = (prev) => {
        const keys = Object.keys(prev).filter((k) => !live.has(k));
        if (keys.length === 0) return prev;
        const next = { ...prev };
        for (const k of keys) delete next[k];
        return next;
      };
      setVenueReasons(prune);
      setVenueErrors(prune);
    } catch (e) {
      setVenues((p) => ({ ...p, error: e.message || 'The venue verification queue could not be loaded.' }));
    }
  }, []);

  const load = useCallback(async ({ background = false } = {}) => {
    if (background) setRefreshing(true); else setLoading(true);
    try {
      // `|| []` on its own turned a malformed 200 into "Queue is clear." A
      // proxy, a gzip failure or a redirect to an HTML error page all arrive as
      // a 200 whose body adminFetch reduces to {}, and the most reassuring
      // sentence on a moderation console is the one it must never say by
      // accident. Same rule the strip view in routes/venueDashboard.js was
      // fixed for: an upstream failure is not an empty result set.
      try {
        const limit = windowRef.current;
        const r = await adminFetch(`/api/admin/reports?limit=${limit}`);
        if (!Array.isArray(r.reports) || !Array.isArray(r.counts)) {
          throw new Error('The queue came back in a shape this console does not understand. Reload the page.');
        }
        // A server from before pagination sends no hasMore. A full window is
        // then the honest guess in the safe direction: offering Load more to a
        // server that ignores `limit` just re-serves the same rows, and the
        // window stops growing on its own.
        const hasMore = typeof r.hasMore === 'boolean' ? r.hasMore : r.reports.length >= limit;
        setQueue({ reports: r.reports, counts: r.counts, hasMore, error: '' });
        pruneEvidence(r.reports);
        // The rows and counts are deliberately NOT cleared on a failure: a
        // moderator half way through a queue should not lose it to one dropped
        // request. They are labelled as stale in the header instead.
      } catch (e) { setQueue((p) => ({ ...p, error: e.message || 'The queue could not be loaded.' })); }

      // Deliberately not chained off the queue read: they are three endpoints
      // and one being down says nothing about the other two. Promise.all
      // rather than two awaits so a refresh costs one round trip instead of
      // two; neither of these can reject, because each swallows its own
      // failure into its own state, which is what makes the parallel form safe
      // here and would not be if either threw.
      await Promise.all([loadLog(), loadVenues()]);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [loadLog, loadVenues, pruneEvidence]);

  useEffect(() => { load(); }, [load]);

  // Load more = grow the window and re-read it whole. One request, one source
  // of truth: appending a second fetch to state invites the offset-drift bugs
  // (duplicates when a row moves up, skips when one moves down) that a
  // replace-not-append read cannot have. The rows already on screen come back
  // in the same order (unhandled work is oldest-first, which does not shuffle
  // under load), so nobody loses their place.
  // A report filed while the queue was already open used to be invisible
  // until a manual Refresh: nothing anywhere registers the moderation_report
  // socket event and this page opens no socket. Poll in the background
  // instead, which the refresh path already makes safe (it preserves scroll,
  // open evidence, and typed drafts). Skipped while the tab is hidden so an
  // abandoned tab does not poll all night, and while a load is running.
  useEffect(() => {
    const t = setInterval(() => {
      if (document.hidden || loading || refreshing) return;
      load({ background: true });
    }, 60000);
    return () => clearInterval(t);
  }, [load, loading, refreshing]);

  const loadMore = async () => {
    if (more.busy) return;
    setMore({ busy: true, error: '' });
    try {
      const limit = Math.min(windowRef.current + LIST_LIMIT, WINDOW_MAX);
      const r = await adminFetch(`/api/admin/reports?limit=${limit}`);
      if (!Array.isArray(r.reports) || !Array.isArray(r.counts)) {
        throw new Error('The queue came back in a shape this console does not understand. Reload the page.');
      }
      // The window only grows once the read it asked for has succeeded, so a
      // failed Load more leaves the next refresh asking for what is on screen.
      windowRef.current = limit;
      const hasMore = typeof r.hasMore === 'boolean' ? r.hasMore : r.reports.length >= limit;
      setQueue({ reports: r.reports, counts: r.counts, hasMore, error: '' });
      pruneEvidence(r.reports);
      setMore({ busy: false, error: '' });
    } catch (e) {
      // This failure is about the NEXT rows, not the ones on screen, so it
      // renders beside the button and never as the queue banner.
      setMore({ busy: false, error: e.message || 'More reports could not be loaded.' });
    }
  };

  const toggleEvidence = async () => {
    const next = !showEvidenceRef.current;
    showEvidenceRef.current = next;
    setShowEvidence(next);
    await loadLog();
  };

  // The picture, on demand and one report at a time.
  //
  // GET /api/admin/reports/:id/image answers with JSON, not bytes, and the whole
  // admin router is behind a Bearer token — so `<img src="/api/admin/...">`
  // cannot work here: the browser sends no Authorization header on an image
  // request and would render a broken icon on a 401. The fetch below carries the
  // header and hands the returned url (a data: URL for anything uploaded through
  // Flock, an https url for anything hosted) to the <img>.
  //
  // The list endpoint withholds inline base64 bodies deliberately, so this is
  // also why nothing loads until somebody asks: 200 story photos is a response
  // no console should pull. Every image is click-to-open for the same reason,
  // whether or not it was deferred, which keeps one behaviour on the screen and
  // means graphic UGC never appears unannounced.
  const toggleImage = async (report) => {
    const cur = images[report.id];
    if (cur && cur.status === 'loading') return;
    if (cur && cur.status === 'ready' && cur.renderFailed) {
      // A picture that failed to paint has to stay retryable. Bumping `attempt`
      // re-keys the <img>, so the browser genuinely requests it again instead of
      // reusing the failed element, which matters for a hosted url that lost a
      // single request.
      setImages((p) => ({ ...p, [report.id]: { ...cur, renderFailed: false, attempt: (cur.attempt || 0) + 1 } }));
      return;
    }
    if (cur && cur.status === 'ready') {
      // Closing a fetched image drops the bytes rather than parking them. A
      // deferred image is a base64 body up to 700KB (routes/stories.js caps it
      // there), it is reported UGC that the server refuses to let any cache
      // hold, and a moderator working a 200-row queue would otherwise
      // accumulate every photo they had ever glanced at for as long as the tab
      // stayed open. Re-opening costs one request. Inline urls are already in
      // the reports payload, so there is nothing to free.
      setImages((p) => {
        const next = { ...p };
        if (report.content_image_deferred) delete next[report.id];
        else next[report.id] = { ...cur, status: 'collapsed' };
        return next;
      });
      return;
    }
    if (cur && cur.status === 'collapsed') {
      setImages((p) => ({ ...p, [report.id]: { ...cur, status: 'ready', renderFailed: false } }));
      return;
    }
    // Not deferred means the list already carried the url, so there is nothing
    // to fetch. If it did not carry one — content_has_image and
    // content_image_url are two different expressions in the queue query, and a
    // future edit could disagree — fall through to the endpoint rather than
    // rendering an <img> with no src, which paints nothing and explains nothing.
    if (!report.content_image_deferred && report.content_image_url) {
      setImages((p) => ({ ...p, [report.id]: { status: 'ready', url: report.content_image_url } }));
      return;
    }
    setImages((p) => ({ ...p, [report.id]: { status: 'loading' } }));
    try {
      const data = await adminFetch(`/api/admin/reports/${report.id}/image`);
      if (!data || !data.imageUrl) throw new Error('The server returned no image for this report.');
      setImages((p) => ({ ...p, [report.id]: { status: 'ready', url: data.imageUrl } }));
    } catch (e) {
      // The server's own wording is worth keeping: "That content no longer
      // exists. Dismiss the report instead." names the next action.
      setImages((p) => ({ ...p, [report.id]: { status: 'error', error: e.message } }));
    }
  };

  // The rest of the words, on demand and one report at a time.
  //
  // The queue clips its excerpt at 280 characters so a 200-row response stays
  // small, and until GET /api/admin/reports/:id/content existed the console
  // could only be honest about that: it labelled the excerpt "(first 280
  // characters)" and offered no way to read the other 4,720 a flock message may
  // hold. A moderator judging harassment on a long message read the opening and
  // decided on it. That label is now this control.
  //
  // Fetched through adminFetch for the same reason the image is: the whole
  // admin router is behind a Bearer token, so a plain URL 401s.
  const toggleText = async (report) => {
    const cur = texts[report.id];
    if (cur && cur.status === 'loading') return;
    if (cur && cur.status === 'ready') {
      // Closing drops the bytes rather than parking them, exactly as a fetched
      // image does: this is reported UGC up to 20,000 characters per report,
      // and a moderator working a 200-row queue would otherwise accumulate
      // every message they had ever expanded for as long as the tab stayed
      // open. Re-opening costs one request. Nothing is cached to fall back on —
      // unlike an image url, the full text is never carried by the list — so
      // there is no 'collapsed' state to keep.
      setTexts((p) => {
        const next = { ...p };
        delete next[report.id];
        return next;
      });
      return;
    }
    setTexts((p) => ({ ...p, [report.id]: { status: 'loading' } }));
    try {
      const data = await adminFetch(`/api/admin/reports/${report.id}/content`);
      // A 200 with no text is still a failure to show anything, and rendering
      // an empty box under a button that just said "loading" explains nothing.
      if (!data || typeof data.text !== 'string' || data.text === '') {
        throw new Error('The server returned no text for this report.');
      }
      setTexts((p) => ({
        ...p,
        [report.id]: {
          status: 'ready',
          text: data.text,
          // The server caps what it will serve and says so; the console repeats
          // it rather than trailing off the way the 280-character excerpt did.
          clipped: !!data.clipped,
          totalLength: Number(data.totalLength) || data.text.length,
        },
      }));
    } catch (e) {
      // The server's own wording again: "That content no longer exists. Dismiss
      // the report instead." names the next action.
      setTexts((p) => ({ ...p, [report.id]: { status: 'error', error: e.message } }));
    }
  };

  const markImageBroken = (reportId) => {
    setImages((p) => (p[reportId] ? { ...p, [reportId]: { ...p[reportId], renderFailed: true } } : p));
  };

  const act = async (report, action) => {
    const noun = lowerLabel(report.content_type);
    const labels = {
      hide: `Hide this ${noun}`, ban: `Ban ${report.reported_user_name || 'this user'}`,
      dismiss: 'Dismiss this report', unban: `Unban ${report.reported_user_name || 'this user'}`,
      // Says what actually happens. A warning is an email to the account, not a
      // silent flag, and a moderator should know that before they send one.
      warn: `Email a warning to ${report.reported_user_name || 'this user'}`,
      // "…where everyone can see it" was a promise the action does not make. A
      // restored DM goes back to two people and a restored story goes back to
      // the author's friends; only the audience it was hidden from gets it
      // back. The confirm on the one screen that performs takedowns should not
      // describe a wider reversal than the one it is about to run.
      unhide: `Put this ${noun} back`,
    };
    if (!window.confirm(`${labels[action]}?`)) return;
    setBusyId(report.id);
    try {
      // The optional reason rides with WHICHEVER action is clicked. Trimmed,
      // and omitted entirely when empty: the server stores what it is sent
      // verbatim, and an audit row whose reason is '' reads as a moderator who
      // wrote nothing on purpose.
      const reason = (own(reasons, report.id) || '').trim();
      const result = await adminFetch(`/api/admin/reports/${report.id}`, {
        method: 'PUT',
        body: JSON.stringify(reason ? { action, reason } : { action }),
      });
      // A takedown closes every other open report about the same content, in
      // the same transaction. Those cards vanish on the refresh below, and a
      // moderator watching nine rows disappear deserves to be told why rather
      // than left to wonder what the click did.
      const swept = Number(result && result.alsoResolved) || 0;
      // A sentence for EVERY action, not only the sweep. The card dims and
      // re-sorts on the background reload, and at 1AM "did that take?" should
      // be answered in words rather than by diffing the list.
      const did = {
        hide: 'Content hidden.',
        unhide: 'Content restored.',
        warn: 'Warning sent.',
        ban: 'User banned.',
        unban: 'User unbanned.',
        dismiss: 'Report dismissed.',
      }[action] || 'Done.';
      setNote(swept > 0
        ? `${did} ${swept} other ${swept === 1 ? 'report' : 'reports'} about the same content ${swept === 1 ? 'was' : 'were'} closed with it.`
        : did);
      // Sent and recorded; a stale draft must not attach itself to the NEXT
      // action on this card.
      setReasons((p) => {
        if (!Object.prototype.hasOwnProperty.call(p, String(report.id))) return p;
        const next = { ...p };
        delete next[report.id];
        return next;
      });
      await load({ background: true });
    } catch (e) {
      setNote('');
      alert(e.message);
      // A refusal is news about the world, not just about the click. "That
      // content no longer exists" and "that account is a moderator" both mean
      // the card in front of the moderator is describing a row that has moved
      // on, and leaving it untouched leaves a button up that can only refuse
      // again. Re-read so the card re-gates itself. In the background, because
      // blanking the queue behind an alert is how you lose the report you were
      // in the middle of.
      await load({ background: true });
    } finally { setBusyId(null); }
  };

  // Verify a claim, or decline the request for one.
  //
  // Both are the same route with a different boolean, and `verified` is always
  // sent explicitly: PUT /api/admin/venues/:profileId/verify defaults an absent
  // key to TRUE, so a decline that forgot to say so would grant the badge it
  // meant to withhold.
  //
  // Declining does not un-verify anything (the claim is already unverified).
  // What it does is clear verification_requested_at, which is what takes the
  // claim out of the waiting group and off the front of the admin queue, and
  // write a 'venue_unverified' audit row saying a human decided. Leaving the
  // request standing would keep telling the owner somebody still has it.
  const decideVenue = async (venue, verified) => {
    const name = venue.business_name || 'this venue';
    const question = verified
      ? `Verify ${name} as the owner of this listing?`
      : `Decline the verification request from ${name}?`;
    if (!window.confirm(question)) return;
    setVenueBusyId(venue.id);
    setVenueErrors((p) => {
      if (!Object.prototype.hasOwnProperty.call(p, String(venue.id))) return p;
      const next = { ...p };
      delete next[venue.id];
      return next;
    });
    try {
      const reason = (own(venueReasons, venue.id) || '').trim();
      const body = reason ? { verified, reason } : { verified };
      await adminFetch(`/api/admin/venues/${venue.id}/verify`, {
        method: 'PUT',
        body: JSON.stringify(body),
      });
      setVenueNote(verified
        ? `${name} is verified. The badge, promotions and review replies are on for that account.`
        : `The request from ${name} is closed. The claim stays unverified and the owner can ask again.`);
    } catch (e) {
      setVenueNote('');
      // The server's own words, kept: "Another account (user 12) is already the
      // verified owner of Google place X. Un-verify that claim first." names
      // both the conflict and the next step, and no shorter sentence does.
      setVenueErrors((p) => ({ ...p, [venue.id]: e.message || 'That decision could not be applied.' }));
    } finally {
      setVenueBusyId(null);
      // Re-read either way. On success the claim has left the list; on a
      // refusal the card is describing a row that has moved on, and leaving it
      // untouched leaves a button up that can only refuse again.
      await loadVenues();
    }
  };

  const countOf = (s) => (queue.counts.find((c) => c.status === s) || {}).count || 0;
  const venuesRequested = venues.list.filter((v) => v.verification_requested_at);
  const venuesUnrequested = venues.list.filter((v) => !v.verification_requested_at);

  return (
    <div style={S.page}>
      <div style={S.wrap}>
        <h1 style={S.h1}>Moderation</h1>
        {typeof window !== 'undefined' && window.Capacitor?.isNativePlatform?.() === true ? (
          // In the native shell this page IS the app's WebView, navigated here
          // by a report notification tap or the dashboard's console button.
          // index.js reads the URL once at boot, so a plain link back to '/'
          // boots the app again; without this the only way home was
          // force-quitting.
          <p style={{ margin: '0 0 10px' }}>
            <a href="/" style={{ color: '#6cb8ff', fontSize: 14, textDecoration: 'none' }}>&larr; Back to Flock</a>
          </p>
        ) : null}
        <p style={S.sub}>
          Report queue. Act promptly. Hide content and/or ban the user. Every action is logged.
          <button
            onClick={() => load({ background: true })}
            disabled={loading || refreshing}
            style={{ ...S.refresh, opacity: (loading || refreshing) ? 0.6 : 1, cursor: (loading || refreshing) ? 'progress' : 'pointer' }}
          >
            {Icons.repeat('currentColor', 14)} {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        </p>

        {/* One banner per failed read, each naming its own list, and the admin
            hint attached to whichever message actually carries a 403 — so a
            queue that is down for an unrelated reason does not tell a signed-in
            moderator to go and sign in.

            The Set is load-bearing rather than tidy: an offline tab, a dropped
            VPN and a CORS refusal all fail BOTH reads with the identical
            message, and two children keyed on the same string is a React key
            collision on the error path of a moderation console. It also reads
            better — that sentence is about the network rather than about either
            list, so saying it twice says nothing extra. */}
        {Array.from(new Set([queue.error, log.error, venues.error].filter(Boolean))).map((m) => (
          <div key={m} style={S.err} role="alert">
            {m}{needsSignIn(m) ? '. Sign in to the app at flockcorp.com/app as the admin account, then reload this page.' : ''}
          </div>
        ))}

        <div style={S.counts}>
          <Badge label="Open" value={countOf('open')} color="#e5484d" />
          {/* content_reports also allows 'under_review'. Nothing writes it today,
              so the badge appears only when the number is real rather than
              parking a permanent zero on the header. */}
          {countOf('under_review') > 0 ? <Badge label="Under review" value={countOf('under_review')} color="#f5a623" /> : null}
          <Badge label="Resolved" value={countOf('resolved')} color="#30a46c" />
          <Badge label="Dismissed" value={countOf('dismissed')} color="#7c7c87" />
          {/* Venue claims are not reports and this row is otherwise about
              reports, so the badge appears only when a real number is waiting.
              Same rule as Under review above, and it is here rather than only
              down beside the list because the failure this whole section fixes
              is nobody knowing a venue asked. */}
          {venuesRequested.length > 0 ? <Badge label="Venues waiting" value={venuesRequested.length} color="#f5a623" /> : null}
        </div>
        {/* Counts survive a failed refresh so the header does not flash to zero,
            which means they can be older than the screen implies. Say so rather
            than presenting last week's tally as this minute's. */}
        {queue.error && queue.counts.length > 0 ? (
          <p style={{ ...S.dimSmall, margin: '8px 0 0' }}>These numbers are from the last load that worked, not from now.</p>
        ) : null}

        {note ? <div style={S.note} role="status">{note}</div> : null}

        {loading ? <p style={S.dim}>Loading…</p> : (
          <>
            <h2 style={S.h2}>Reports</h2>
            {/* "Queue is clear." is the most reassuring sentence on this
                screen, so it is never printed over a failed load. An empty list
                and an unread list look identical, and only one of them means
                there is nothing to do. */}
            {queue.reports.length === 0 ? (
              <p style={S.dim}>{queue.error ? 'The queue could not be loaded, so this is not a count of anything.' : 'Queue is clear.'}</p>
            ) : (
              <div style={S.list}>
                {queue.reports.map((r) => {
                  const unhandled = !!own(UNHANDLED_STATUS, r.status);
                  // Each button is gated on whether the SERVER can honour it and
                  // whether it would change anything — not on the report still
                  // being open. PUT /api/admin/reports/:id refuses a hide with no
                  // TAKEDOWN_TARGETS entry, a hide with no content_id, a hide of a
                  // row that is gone, and a ban with no reported user, and a
                  // control that can only produce a refusal is worse than no
                  // control on the screen where takedowns happen.
                  //
                  // Status is deliberately NOT part of the gate. Every action
                  // resolves the report, so gating on 'open' meant a moderator got
                  // exactly ONE move per report: ban the account and the Hide
                  // button disappeared with the abusive photo still live; hide the
                  // photo and the account could no longer be banned from the card
                  // that proved it. The server accepts either at any time. So does
                  // this now.
                  const takedownable = !!own(HIDEABLE, r.content_type) && !!r.content_id && !r.content_missing;
                  const canHide = takedownable && !r.content_is_hidden;
                  // Un-hide matters most after the fact: a mistaken takedown is
                  // discovered once the report is already resolved.
                  const canRestore = takedownable && !!r.content_is_hidden;
                  const canBan = !!r.reported_user_id;
                  // Dismissing something already finished changes nothing but the
                  // word on the row, so it stays with the unhandled reports.
                  // Warn sits between doing nothing and a permanent ban, which
                  // were the only two account outcomes this console had. It
                  // sends a real email, so it is offered only where there is
                  // somebody to send one to and a ban would not already have
                  // overtaken it.
                  const canWarn = canBan && !r.reported_user_banned;
                  const childSafety = isChildSafety(r);
                  const showActions = canHide || canRestore || canBan || unhandled;
                  return (
                  <div key={r.id} style={{ ...S.card, opacity: unhandled ? 1 : 0.7 }}>
                    <div style={S.cardTop}>
                      <span style={S.reason}>{own(REASON_LABEL, r.reason) || r.reason}</span>
                      <span style={S.type}>{typeLabel(r.content_type)}{r.content_id ? ` #${r.content_id}` : ''}</span>
                      {childSafety ? <span style={S.childTag}>CHILD SAFETY</span> : null}
                      <span style={{ ...S.status, color: unhandled ? '#e5484d' : '#7c7c87' }}>{String(r.status || '').replace(/_/g, ' ')}</span>
                    </div>
                    <div style={S.meta}>
                      Reported user: <b>{r.reported_user_name || '—'}</b>
                      {r.reported_user_banned ? <span style={S.banned}>BANNED</span> : null}
                      {'  ·  '}reporter: {r.reporter_name || '—'}{'  ·  '}{fmt(r.created_at)}
                      {reportAge(r.created_at)}
                    </div>
                    <ReportRecord report={r} unhandled={unhandled} />
                    {r.details ? <div style={S.details}>Reporter wrote: “{r.details}”</div> : null}

                    <ReportedContent
                      report={r}
                      image={images[r.id]}
                      onToggleImage={() => toggleImage(r)}
                      onImageBroken={() => markImageBroken(r.id)}
                      text={texts[r.id]}
                      onToggleText={() => toggleText(r)}
                    />

                    {showActions && (
                      <>
                        {/* The one thing on this card that has to be read
                            BEFORE a button is pressed, so it sits directly
                            above the buttons rather than in the header. The
                            wording is the runbook's own order of operations,
                            and it names the file instead of restating seven
                            steps a card has no room for. */}
                        {childSafety ? (
                          <div style={S.childNotice} role="note">
                            <b>Preserve the evidence before you act.</b> This report may carry a legal
                            reporting duty. Export the rows and file the CyberTipline report first, then
                            hide and ban. Closing a report also releases the holds that stop reported
                            stories and venue rows from being deleted. The steps are in
                            MODERATION-LEGAL.md in the repository root.
                            {/* The server answers "under 18" and never sends a date of
                                birth. Said out loud only where it changes the decision:
                                the whole app is 13 and up, so a flag on every card would
                                be noise, but on a report that may be reportable under
                                18 U.S.C. 2258A it is the fact the runbook turns on. */}
                            {r.reported_user_is_minor || r.reporter_is_minor ? (
                              <div style={{ marginTop: 6 }}>
                                <b>
                                  {r.reported_user_is_minor && r.reporter_is_minor
                                    ? 'Both accounts on this report are under 18.'
                                    : r.reported_user_is_minor
                                      ? 'The reported account is under 18.'
                                      : 'The account that filed this report is under 18.'}
                                </b>
                              </div>
                            ) : null}
                          </div>
                        ) : null}
                        {/* One optional line, sent with whichever action is
                            clicked, stored verbatim in the audit log by the
                            route that already validated it (string, <=1000).
                            maxLength matches that server cap so the console
                            cannot compose a reason the server will refuse.
                            16px font: below that, iOS zooms the viewport on
                            focus (same rule as the report sheet's box). */}
                        <input
                          value={own(reasons, r.id) || ''}
                          onChange={(e) => { const v = e.target.value; setReasons((p) => ({ ...p, [r.id]: v })); }}
                          disabled={busyId === r.id}
                          maxLength={1000}
                          placeholder="Reason for the audit log (optional)"
                          aria-label="Reason for actions on this report"
                          style={S.reasonInput}
                        />
                      <div style={S.actions}>
                        {canHide ? (
                          <button disabled={busyId === r.id} onClick={() => act(r, 'hide')} style={S.btnHide}>Hide content</button>
                        ) : null}
                        {canRestore ? (
                          <button disabled={busyId === r.id} onClick={() => act(r, 'unhide')} style={S.btn}>Restore content</button>
                        ) : null}
                        {canWarn ? (
                          <button disabled={busyId === r.id} onClick={() => act(r, 'warn')} style={S.btn}>Warn user</button>
                        ) : null}
                        {canBan ? (
                          r.reported_user_banned
                            ? <button disabled={busyId === r.id} onClick={() => act(r, 'unban')} style={S.btn}>Unban user</button>
                            : <button disabled={busyId === r.id} onClick={() => act(r, 'ban')} style={S.btnBan}>Ban user</button>
                        ) : null}
                        {unhandled ? <button disabled={busyId === r.id} onClick={() => act(r, 'dismiss')} style={S.btn}>Dismiss</button> : null}
                      </div>
                      </>
                    )}
                  </div>
                  );
                })}
              </div>
            )}
            {queue.hasMore ? (
              <div style={S.moreBlock}>
                <p style={{ ...S.dimSmall, margin: 0 }}>
                  {`Showing ${queue.reports.length} reports, oldest unhandled first, so the longest wait is already at the top. The counts above are of the whole table.`}
                </p>
                {more.error ? <div style={S.imgErr} role="alert">{more.error}</div> : null}
                {queue.reports.length >= WINDOW_MAX ? (
                  <p style={{ ...S.dimSmall, margin: 0 }}>
                    {`This console shows at most ${WINDOW_MAX} reports at once. Act on these and refresh to pull the next oldest forward.`}
                  </p>
                ) : (
                  <button onClick={loadMore} disabled={more.busy} style={S.imgBtn}>
                    {more.busy ? 'Loading more…' : `Load ${LIST_LIMIT} more`}
                  </button>
                )}
              </div>
            ) : null}

            <h2 style={S.h2}>Venue verification</h2>
            <p style={{ ...S.dimSmall, margin: '0 0 10px' }}>
              A venue owner asks to be verified from their dashboard. Check that the account really runs
              the listing before you decide. Verifying turns on the public badge, promotions and review
              replies for that business, and every decision is recorded in the audit log below.
            </p>
            {venueNote ? <div style={S.note} role="status">{venueNote}</div> : null}
            {venues.list.length === 0 ? (
              // Same rule as "Queue is clear.": an empty list and an unread
              // list look identical, and only one of them means there is
              // nothing to do.
              <p style={S.dim}>
                {venues.error
                  ? 'The venue queue could not be loaded, so this is not a count of anything.'
                  : 'No venue claims are waiting.'}
              </p>
            ) : (
              <div style={S.list}>
                {venuesRequested.length === 0 ? (
                  <p style={{ ...S.dim, margin: 0 }}>Nobody has asked to be verified.</p>
                ) : venuesRequested.map((v) => (
                  <VenueClaim
                    key={v.id}
                    venue={v}
                    busy={venueBusyId === v.id}
                    error={own(venueErrors, v.id)}
                    reason={own(venueReasons, v.id) || ''}
                    onReason={(value) => setVenueReasons((p) => ({ ...p, [v.id]: value }))}
                    onDecide={(verified) => decideVenue(v, verified)}
                  />
                ))}
                {venuesUnrequested.length > 0 ? (
                  <div style={S.moreBlock}>
                    <button onClick={() => setShowUnrequested((s) => !s)} style={S.imgBtn}>
                      {showUnrequested
                        ? 'Hide the claims nobody has asked about'
                        : `Show ${venuesUnrequested.length} ${venuesUnrequested.length === 1 ? 'claim' : 'claims'} nobody has asked about`}
                    </button>
                    {showUnrequested ? (
                      <>
                        <p style={{ ...S.dimSmall, margin: 0 }}>
                          These accounts claimed a venue and never pressed the verify button. Verifying one
                          nobody asked about is a decision you are making on your own, not an answer to a request.
                        </p>
                        {venuesUnrequested.map((v) => (
                          <VenueClaim
                            key={v.id}
                            venue={v}
                            busy={venueBusyId === v.id}
                            error={own(venueErrors, v.id)}
                            reason={own(venueReasons, v.id) || ''}
                            onReason={(value) => setVenueReasons((p) => ({ ...p, [v.id]: value }))}
                            onDecide={(verified) => decideVenue(v, verified)}
                          />
                        ))}
                      </>
                    ) : null}
                  </div>
                ) : null}
                {venues.list.length >= VENUE_LIST_LIMIT ? (
                  <p style={{ ...S.dimSmall, margin: 0 }}>
                    {`The server sends at most ${VENUE_LIST_LIMIT} unverified claims, requested ones first. Decide these and refresh to pull the next forward.`}
                  </p>
                ) : null}
              </div>
            )}

            <h2 style={S.h2}>
              Audit log
              {/* The server excludes evidence-access rows by default so they
                  cannot drown the decisions; this asks for them by name
                  (?include_evidence=true) and re-reads only the log. */}
              <button onClick={toggleEvidence} style={S.evidenceToggle}>
                {showEvidence ? 'Hide evidence access' : 'Show evidence access'}
              </button>
            </h2>
            {showEvidence ? (
              <p style={{ ...S.dimSmall, margin: '0 0 8px' }}>
                Access rows record which reports a moderator opened. They are records of reading, not decisions.
              </p>
            ) : null}
            {log.actions.length === 0 ? (
              <p style={S.dim}>{log.error ? 'The audit log could not be loaded.' : 'No actions yet.'}</p>
            ) : (
              <>
                <div style={S.log}>
                  {log.actions.map((a) => {
                    // An access record is not a decision, and the two must not
                    // read alike in the list that exists to answer "what did
                    // we do". Dimmer row, its own tag, and the reason ('image'
                    // or 'full text', written by the server) folded into a
                    // sentence instead of rendered as if a moderator wrote it.
                    const isAccess = a.action === 'evidence_viewed';
                    return (
                      <div key={a.id} style={isAccess ? { ...S.logRow, ...S.logRowAccess } : S.logRow}>
                        <b>{actionLabel(a.action)}</b>
                        {isAccess ? <span style={S.accessTag}>ACCESS</span> : null}
                        {a.target_user_name ? ` → ${a.target_user_name}` : ''}
                        {a.content_type ? `  (${typeLabel(a.content_type)}${a.content_id ? ` #${a.content_id}` : ''})` : ''}
                        <span style={S.logMeta}>  by {a.moderator_name || '—'} · {fmt(a.created_at)}</span>
                        {a.reason ? (
                          <div style={S.logReason}>
                            {isAccess ? `Opened the ${a.reason}.` : a.reason}
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
                {log.actions.length >= LIST_LIMIT ? (
                  <p style={{ ...S.dimSmall, margin: '8px 0 0' }}>
                    {`The last ${LIST_LIMIT} actions. Older ones are in moderation_actions and are not served to this screen.`}
                  </p>
                ) : null}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// WHAT THIS CARD COULD NOT ANSWER, and a moderator had no second screen to go
// and ask. Three questions, one line each, and every one of them changes the
// decision:
//
//   How many people are waiting on this?  Ten reporters on one message is ten
//     rows in this queue, because the duplicate check in routes/moderation.js
//     is per-reporter on purpose. Without this line the tenth report reads as
//     one more unrelated complaint instead of as the tenth person to complain.
//   What is this account's record?  "Nobody has ever reported them" and
//     "eleven earlier reports" are different decisions.
//   What did we do last time?  A warning already given is the argument for a
//     ban. A dismissal already made is the argument against one.
//
// And, for a report somebody has already closed, WHO closed it and when.
// content_reports.handled_by has been written since the first takedown and
// shown nowhere, so a second moderator opening a resolved report could not tell
// whether a colleague had acted a minute ago or a month ago. Nothing prevents
// two people acting on the same report (every action is accepted at any status,
// deliberately), so the defence is that the screen says who already did.
//
// Anything the server does not send renders as nothing at all. A server older
// than these columns leaves the line out rather than printing a confident zero.
function ReportRecord({ report: r, unhandled }) {
  const dup = Number(r.content_open_reports) || 0;
  const prior = Number(r.user_total_reports) || 0;
  const lastAction = r.user_last_action
    ? (own(PRIOR_ACTION_LABEL, r.user_last_action) || actionLabel(r.user_last_action))
    : '';
  const handled = !unhandled && r.handled_by_name;
  if (dup < 2 && prior === 0 && !lastAction && !handled) return null;
  return (
    <div style={S.record}>
      {dup >= 2 ? (
        <div><b>{dup} people</b> have reported this same {lowerLabel(r.content_type)}. Hiding it closes the rest.</div>
      ) : null}
      {prior > 0 ? (
        <div>
          {prior} earlier {prior === 1 ? 'report' : 'reports'} against this account
          {lastAction ? `. Last time we ${lastAction}${r.user_last_action_at ? ` on ${fmt(r.user_last_action_at)}` : ''}.` : '.'}
        </div>
      ) : lastAction ? (
        <div>{`Last time we ${lastAction}${r.user_last_action_at ? ` on ${fmt(r.user_last_action_at)}` : ''}.`}</div>
      ) : null}
      {handled ? <div>Already handled by {r.handled_by_name}{r.resolved_at ? ` on ${fmt(r.resolved_at)}` : ''}.</div> : null}
    </div>
  );
}

// The evidence half of the card. Before this, the queue told a moderator that a
// report existed and never once showed them the thing being reported — so
// "sexual content" filed against a photo arrived as an empty box above a button
// that permanently hides content and a button that bans a 15-year-old.
//
// Field names come from GET /api/admin/reports (backend/routes/admin.js):
// content_excerpt, content_excerpt_clipped, content_has_image, content_image_url,
// content_image_deferred, content_created_at, content_is_hidden, content_missing.
// The expanded body comes from GET /api/admin/reports/:id/content, which answers
// { text, clipped, totalLength } and is capped server-side.
function ReportedContent({ report: r, image, onToggleImage, onImageBroken, text, onToggleText }) {
  const label = lowerLabel(r.content_type);
  const gone = !!r.content_missing;
  const empty = !gone && !r.content_excerpt && !r.content_has_image && !r.content_created_at;
  // THE <img> GETS THE SAME ALLOWLIST THE <a> ALREADY HAD, and the asymmetry
  // was the bug. `image.url` is either a data: URL this app minted and screened
  // or a `content_image_url` the REPORTED USER chose (routes/admin.js only
  // withholds data: and anything over 500 characters from the queue payload —
  // it does not check the scheme). The "open in a new tab" link twenty lines
  // down is gated on `^https?:` so it can never be a dead link; nothing gated
  // the src, so any scheme at all reached it. `<img>` will not run script from
  // a `data:text/html` or a `javascript:` src in any current browser, so this
  // is not a live XSS — it is the allowlist being in one of the two places
  // that consume the same string, which is how it stops being true.
  //
  // Two schemes, both narrow: http(s), and `data:image/*` for what Flock
  // itself stored. `data:text/html` and `data:image/svg+xml` are BOTH refused —
  // an SVG is a document, and the one image type that can carry script has no
  // business being the thing a moderator's browser renders.
  const SAFE_IMG = /^(?:https?:\/\/|data:image\/(?:png|jpeg|jpg|gif|webp);base64,)/i;
  const ready = !!(image && image.status === 'ready');
  const badScheme = ready && !SAFE_IMG.test(image.url || '');
  const showable = ready && !image.renderFailed && !badScheme;
  const expanded = !!(text && text.status === 'ready');

  return (
    <div style={S.content}>
      <div style={S.contentHead}>
        <span>Reported {label}</span>
        {r.content_created_at ? <span>· posted {fmt(r.content_created_at)}</span> : null}
        {r.content_is_hidden ? <span style={S.hiddenTag}>HIDDEN</span> : null}
      </div>

      {gone ? (
        <div style={S.dimSmall}>That content no longer exists. Dismiss the report.</div>
      ) : empty ? (
        // The queue's LATERAL found no row. For a profile report that means the
        // account is gone; for anything else it means the report named no
        // content at all (both ids are optional — see the KNOWN GAP note in
        // routes/moderation.js). Nothing can be taken down either way, so the
        // action row below offers only a ban, if a user was named, and a
        // dismissal.
        <div style={S.dimSmall}>
          {r.content_type === 'profile' && r.reported_user_id
            ? 'That account is no longer in the database.'
            : 'This report names no content, so there is nothing to show or take down.'}
        </div>
      ) : (
        <>
          {r.content_excerpt ? (
            <>
              {/* Bounded once expanded. 20,000 characters is roughly 300 lines,
                  and pushing Hide and Ban that far down the card would make
                  reading the evidence and acting on it two different screens.
                  Nothing is withheld: the box scrolls. */}
              <div style={expanded ? { ...S.excerpt, ...S.excerptFull } : S.excerpt}>
                {expanded ? text.text : r.content_excerpt}
                {/* The ellipsis means "there is more than this", so it belongs
                    on the clipped excerpt AND on a full text the SERVER had to
                    cap — and on neither once everything is on the screen. */}
                {(expanded ? text.clipped : !!r.content_excerpt_clipped) ? <span style={S.clip}>…</span> : null}
              </div>

              {/* Gated on the queue's own clipped flag: when the excerpt is
                  already the whole thing there is nothing behind this control,
                  and a button that can only re-render what is on the screen is
                  the same defect as one that can only produce a refusal. */}
              {r.content_excerpt_clipped ? (
                <div style={S.textBlock}>
                  {text && text.status === 'error' ? (
                    <div style={S.imgErr}>{text.error || 'The rest of the text could not be loaded.'}</div>
                  ) : null}

                  {expanded && text.clipped ? (
                    // Says what was withheld and how much, rather than trailing
                    // off. The number is read back off the response, so it
                    // cannot drift from the server's own cap.
                    <div style={S.dimSmall}>
                      {`Showing the first ${text.text.length.toLocaleString()} of ${text.totalLength.toLocaleString()} characters. That is the most the server will serve for one report.`}
                    </div>
                  ) : null}

                  {/* One control, always present, whatever state the text is
                      in — same rule as the image button below. */}
                  {text && text.status === 'loading' ? (
                    <span style={S.dimSmall}>Loading the full text…</span>
                  ) : (
                    <button onClick={onToggleText} style={S.imgBtn}>
                      {expanded ? 'Show less'
                        : (text && text.status === 'error') ? 'Try again'
                        : 'Show the full text'}
                    </button>
                  )}
                </div>
              ) : null}
            </>
          ) : (
            <div style={S.dimSmall}>{r.content_has_image ? 'No text. Image only.' : 'No text on this item.'}</div>
          )}

          {r.content_has_image ? (
            <div style={S.imgBlock}>
              {image && image.status === 'error' ? (
                <div style={S.imgErr}>{image.error || 'The image could not be loaded.'}</div>
              ) : null}

              {ready && (image.renderFailed || badScheme) ? (
                <div style={S.imgErr}>
                  <span>
                    {badScheme
                      ? 'This image is not in a format the console will render.'
                      : 'The image could not be displayed.'}
                  </span>
                  {/* Only an http(s) url can be opened in a tab. Everything
                      uploaded through Flock is a data: URL, and browsers refuse
                      to navigate to those, so the link is offered where it works
                      and withheld where it would be a dead link. */}
                  {/^https?:\/\//i.test(image.url || '') ? (
                    <a href={image.url} target="_blank" rel="noopener noreferrer" style={S.link}>Open it in a new tab</a>
                  ) : null}
                </div>
              ) : null}

              {showable ? (
                <img
                  key={image.attempt || 0}
                  src={image.url}
                  alt={`Reported ${label}`}
                  style={S.img}
                  // A hosted content_image_url is a string the reported user
                  // chose. Fetching it from here otherwise hands whoever is on
                  // the other end the admin console's URL in a Referer header,
                  // i.e. tells the person being moderated that a moderator is
                  // looking at their report, and from where. data: URLs are
                  // unaffected; this costs nothing and closes that.
                  referrerPolicy="no-referrer"
                  onError={onImageBroken}
                />
              ) : null}

              {/* One control, always present, whatever state the image is in. An
                  earlier draft hid it once an <img> failed, which left the card
                  with a failure message and no way to try again. */}
              {image && image.status === 'loading' ? (
                <span style={S.dimSmall}>Loading image…</span>
              ) : (
                <button onClick={onToggleImage} style={S.imgBtn}>
                  {showable ? 'Hide image'
                    : (image && (image.status === 'error' || image.renderFailed)) ? 'Try again'
                    : image ? 'Show image again'
                    : 'Show image'}
                </button>
              )}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

// One unverified venue claim, and the decision on it.
//
// WHAT THE ADMIN HAS TO CHECK, all of it on the card, because the check is not
// something this console can do: does the account on file plausibly run the
// business at that Google listing. So the card carries the business name, the
// address the owner typed, the Google place id the claim is bound to, and the
// email of the account that would receive the badge. Nothing here is a
// judgement, and the console does not pretend to make one.
//
// NO VERIFY BUTTON WITHOUT A GOOGLE LISTING, and that is not the server
// refusing. PUT /api/admin/venues/:profileId/verify would happily set
// verified = true on a claim whose google_place_id is NULL, and migration 002's
// partial unique index does not stop it either, because NULLs are distinct.
// What lands is a verified profile bound to no place: /public-reviews and
// /public-promotions both serve by place id, so the badge attaches to nothing
// and the only thing the flip does is hand out entitlements. An owner cannot
// even ASK in that state (POST /request-verification refuses a claim with no
// listing and says to link one first), so a claim with no place id is
// somebody who has not finished, not somebody waiting. The card says that
// instead of offering a button whose result would be a badge on nothing.
function VenueClaim({ venue: v, busy, error, reason, onReason, onDecide }) {
  const requested = !!v.verification_requested_at;
  const waited = requested ? daysWaiting(v.verification_requested_at) : null;
  const linked = !!v.google_place_id;
  return (
    <div style={S.card}>
      <div style={S.cardTop}>
        <span style={S.reason}>{v.business_name || 'Unnamed venue'}</span>
        {requested ? <span style={S.requestedTag}>REQUESTED</span> : null}
        <span style={S.type}>claim #{v.id}</span>
      </div>
      <div style={S.meta}>
        {v.location || 'No address on file'}
        {'  ·  '}owner: {v.email || 'no address on file'}
      </div>
      <div style={{ ...S.dimSmall, marginTop: 2 }}>
        {linked ? `Google place ${v.google_place_id}` : 'No Google listing linked'}
        {'  ·  '}claimed {fmt(v.created_at)}
      </div>
      {requested ? (
        <div style={{ ...S.record, marginTop: 6 }}>
          <div>
            Asked on {fmt(v.verification_requested_at)}
            {waited === null ? '' : waited === 0 ? ', today.' : waited === 1 ? ', one day ago.' : `, ${waited} days ago.`}
          </div>
        </div>
      ) : null}

      {linked ? (
        <>
          <input
            value={reason}
            onChange={(e) => onReason(e.target.value)}
            disabled={busy}
            maxLength={1000}
            placeholder="Reason for the audit log (optional)"
            aria-label={`Reason for the decision on ${v.business_name || 'this venue'}`}
            style={S.reasonInput}
          />
          {error ? <div style={{ ...S.imgErr, marginTop: 8 }} role="alert">{error}</div> : null}
          <div style={S.actions}>
            <button disabled={busy} onClick={() => onDecide(true)} style={S.btnHide}>Verify</button>
            {/* Declining is only meaningful against a standing request: it
                clears the request and records the decision. On a claim nobody
                asked about there is nothing to decline, and a button that
                writes an audit row saying we refused something nobody asked
                for is a control that does not mean what it says. */}
            {requested ? (
              <button disabled={busy} onClick={() => onDecide(false)} style={S.btn}>Decline</button>
            ) : null}
          </div>
        </>
      ) : (
        <div style={{ ...S.dimSmall, marginTop: 8 }}>
          This claim names no Google listing, so there is nothing to check ownership against.
          The owner has to link one in Edit Profile before verification means anything.
        </div>
      )}
    </div>
  );
}

function Badge({ label, value, color }) {
  return (
    <div style={S.badge}>
      <div style={{ ...S.badgeVal, color }}>{value}</div>
      <div style={S.badgeLabel}>{label}</div>
    </div>
  );
}

const S = {
  page: { minHeight: '100vh', background: '#0e0e11', color: '#e7e7ea', fontFamily: "'Hanken Grotesk', -apple-system, system-ui, 'Segoe UI', Roboto, sans-serif" },
  // boxSizing: nothing in this app resets it (index.css has no `* { box-sizing }`
  // rule at all — checked), so a content-box max-width of 880 plus 40px of
  // padding is a 920px element. Between 880 and 920 CSS pixels of viewport that
  // is a horizontally scrolling page on a console that fits comfortably.
  wrap: { maxWidth: 880, margin: '0 auto', padding: '32px 20px 80px', boxSizing: 'border-box' },
  h1: { fontSize: 28, margin: '0 0 4px' },
  h2: { fontSize: 18, margin: '28px 0 12px', color: '#c7c7cd' },
  sub: { color: '#9a9aa3', margin: '0 0 20px', fontSize: 14 },
  refresh: { marginLeft: 12, background: 'transparent', color: '#6cb8ff', border: 'none', cursor: 'pointer', fontSize: 14, display: 'inline-flex', alignItems: 'center', gap: 5, verticalAlign: -3, padding: 0, fontFamily: 'inherit' },
  err: { background: '#3a1416', border: '1px solid #e5484d', color: '#ffb3b6', padding: '10px 14px', borderRadius: 10, marginBottom: 16, fontSize: 14 },
  // MEASURED at a 320px viewport, which is the narrowest phone SLOP-AUDIT rule 6
  // holds this app to. Content-box (no reset — see `wrap`), so each badge was
  // minWidth 88 + 36 padding + 2 border = 126px wide; four of them plus three
  // 12px gaps is 540px inside a 280px content column. That is 260px of
  // horizontal overflow on the header of the moderation console, i.e. the
  // sideways-scrolling, pinch-to-read screen this page was reported for. Wrap
  // plus border-box plus a smaller floor puts it at two rows of two.
  counts: { display: 'flex', flexWrap: 'wrap', gap: 12, marginBottom: 8 },
  badge: { background: '#17171b', border: '1px solid #25252b', borderRadius: 12, padding: '12px 18px', minWidth: 76, flex: '1 1 auto', boxSizing: 'border-box', textAlign: 'center' },
  badgeVal: { fontSize: 24, fontWeight: 700 },
  badgeLabel: { fontSize: 12, color: '#8a8a93', marginTop: 2 },
  dim: { color: '#7c7c87' },
  list: { display: 'flex', flexDirection: 'column', gap: 10 },
  card: { background: '#17171b', border: '1px solid #25252b', borderRadius: 12, padding: 14 },
  // Same measurement: "Nudity or sexual content" + "Venue promotion #123456" +
  // "UNDER REVIEW" is well over the 252px a card gets at 320px, and this row
  // had no wrap, so the status pushed off the right edge of the card.
  cardTop: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 10, marginBottom: 6 },
  reason: { fontWeight: 700 },
  type: { fontSize: 12, color: '#8a8a93', background: '#222228', padding: '2px 8px', borderRadius: 6, overflowWrap: 'anywhere' },
  status: { marginLeft: 'auto', fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.5 },
  meta: { fontSize: 13, color: '#9a9aa3' },
  banned: { color: '#e5484d', fontWeight: 700, marginLeft: 6, fontSize: 11 },
  details: { marginTop: 8, fontSize: 14, color: '#c7c7cd', fontStyle: 'italic' },
  // The account's record. Dimmer than the report itself and above the evidence:
  // it is context for the decision, never the thing being judged.
  record: { marginTop: 6, fontSize: 13, color: '#9a9aa3', display: 'flex', flexDirection: 'column', gap: 2 },
  // Amber, not the takedown steel and not the ban red. It is neither a state
  // the content is in nor an action taken: it is an instruction to stop and
  // read before pressing anything, and it has to be the loudest thing on the
  // card without pretending to be a button.
  childTag: { color: '#f5a623', border: '1px solid #7a5a12', borderRadius: 5, padding: '1px 6px', fontSize: 10, letterSpacing: 0.5, fontWeight: 700 },
  // Amber like the Under-review badge, not the child-safety amber weight: this
  // marks work that is waiting, not an instruction to stop and read. Deliberately
  // NOT the takedown steel, which on this screen means "a state the content is in".
  requestedTag: { color: '#f5a623', border: '1px solid #7a5a12', borderRadius: 5, padding: '1px 6px', fontSize: 10, letterSpacing: 0.5 },
  childNotice: { marginTop: 12, background: '#251c08', border: '1px solid #7a5a12', color: '#f0cf95', borderRadius: 10, padding: '10px 12px', fontSize: 13, lineHeight: 1.45 },
  note: { background: '#12281c', border: '1px solid #2d6a45', color: '#a7e0bf', padding: '10px 14px', borderRadius: 10, margin: '12px 0 0', fontSize: 14 },
  content: { marginTop: 10, background: '#121216', border: '1px solid #24242a', borderRadius: 10, padding: '10px 12px' },
  contentHead: { fontSize: 12, color: '#8a8a93', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  hiddenTag: { color: '#a8cbe8', border: '1px solid #2d5a87', borderRadius: 5, padding: '1px 6px', fontSize: 10, letterSpacing: 0.5 },
  excerpt: { fontSize: 14, color: '#e7e7ea', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' },
  excerptFull: { maxHeight: 360, overflowY: 'auto', paddingRight: 6 },
  clip: { color: '#7c7c87', fontSize: 12, marginLeft: 4 },
  dimSmall: { fontSize: 13, color: '#7c7c87' },
  textBlock: { marginTop: 8, display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 6 },
  imgBlock: { marginTop: 10, display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 6 },
  // border-box so the 1px border is inside the 100% cap. Without it a 320px
  // image in a 320px column is a 322px element.
  img: { width: 320, maxWidth: '100%', maxHeight: 320, boxSizing: 'border-box', objectFit: 'contain', borderRadius: 8, border: '1px solid #25252b', background: '#0a0a0c', display: 'block' },
  imgBtn: { background: '#222228', color: '#c7c7cd', border: '1px solid #33333a', borderRadius: 8, padding: '5px 10px', cursor: 'pointer', fontSize: 12, fontFamily: 'inherit' },
  imgErr: { fontSize: 13, color: '#ffb3b6', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  link: { color: '#6cb8ff' },
  actions: { display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' },
  btn: { background: '#222228', color: '#e7e7ea', border: '1px solid #33333a', borderRadius: 8, padding: '7px 12px', cursor: 'pointer', fontSize: 13 },
  // Steel, not the violet it used to be. Purple is off-palette everywhere in
  // Flock (SLOP-AUDIT.md A1/H2) and this is still a Flock surface.
  btnHide: { background: '#12283c', color: '#a8cbe8', border: '1px solid #2d5a87', borderRadius: 8, padding: '7px 12px', cursor: 'pointer', fontSize: 13 },
  btnBan: { background: '#3a1416', color: '#ffb3b6', border: '1px solid #e5484d', borderRadius: 8, padding: '7px 12px', cursor: 'pointer', fontSize: 13 },
  log: { display: 'flex', flexDirection: 'column', gap: 6 },
  logRow: { fontSize: 13, color: '#c7c7cd', padding: '6px 10px', background: '#141417', borderRadius: 8 },
  logMeta: { color: '#7c7c87' },
  // An access record must not read like a decision at a glance: dimmer text,
  // a hairline in the takedown steel rather than a new colour.
  logRowAccess: { color: '#8a8a93', background: '#101014', border: '1px solid #1d2b3a' },
  accessTag: { color: '#a8cbe8', border: '1px solid #2d5a87', borderRadius: 5, padding: '1px 6px', fontSize: 10, letterSpacing: 0.5, marginLeft: 6 },
  // The moderator's own words, quoted under the row they explain. pre-wrap +
  // anywhere for the same reason the excerpt has them: this is stored text up
  // to 1000 characters and an unbroken string must not widen the page.
  logReason: { marginTop: 4, color: '#9a9aa3', fontStyle: 'italic', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' },
  evidenceToggle: { marginLeft: 10, background: 'transparent', color: '#6cb8ff', border: 'none', cursor: 'pointer', fontSize: 13, padding: 0, fontFamily: 'inherit', verticalAlign: 1 },
  // 16, not smaller: an input under 16px makes iOS zoom the whole viewport on
  // focus — the same rule the report sheet's details box is held to.
  reasonInput: { marginTop: 10, width: '100%', maxWidth: '100%', boxSizing: 'border-box', background: '#101014', color: '#e7e7ea', border: '1px solid #2a2a31', borderRadius: 8, padding: '7px 10px', fontSize: 16, fontFamily: 'inherit' },
  moreBlock: { marginTop: 10, display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 8 },
};
