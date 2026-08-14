import React, { useEffect, useState, useCallback } from 'react';
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
const typeLabel = (t) => own(TYPE_LABEL, t) || t || 'content';
// Mid-sentence form. Only the first letter drops, so "Guest RSVP" reads as
// "guest RSVP" in "Hide this guest RSVP?" instead of the shouted-down "guest rsvp".
const lowerLabel = (t) => {
  const s = typeLabel(t);
  return s.charAt(0).toLowerCase() + s.slice(1);
};

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

const fmt = (t) => (t ? new Date(t).toLocaleString() : '');

export default function ModerationDashboard() {
  const [reports, setReports] = useState([]);
  const [counts, setCounts] = useState([]);
  const [actions, setActions] = useState([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);
  // reportId -> { status: 'loading' | 'ready' | 'collapsed' | 'error',
  //               url, error, renderFailed, attempt }
  // Keyed by report id, which is stable across a refresh, so a picture a
  // moderator already opened is not re-fetched every time the queue reloads.
  const [images, setImages] = useState({});
  // reportId -> { status: 'loading' | 'ready' | 'error',
  //               text, clipped, totalLength, error }
  // Same keying, same reason, same shape as `images` above.
  const [texts, setTexts] = useState({});

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      // `|| []` on its own turned a malformed 200 into "Queue is clear." A
      // proxy, a gzip failure or a redirect to an HTML error page all arrive as
      // a 200 whose body adminFetch reduces to {}, and the most reassuring
      // sentence on a moderation console is the one it must never say by
      // accident. Same rule the strip view in routes/venueDashboard.js was
      // fixed for: an upstream failure is not an empty result set.
      const r = await adminFetch('/api/admin/reports');
      if (!Array.isArray(r.reports) || !Array.isArray(r.counts)) {
        throw new Error('The queue came back in a shape this console does not understand. Reload the page.');
      }
      setReports(r.reports);
      setCounts(r.counts);
      const a = await adminFetch('/api/admin/moderation-actions');
      if (!Array.isArray(a.actions)) {
        throw new Error('The audit log came back in a shape this console does not understand. Reload the page.');
      }
      setActions(a.actions);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

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
      unhide: `Put this ${noun} back where everyone can see it`,
    };
    if (!window.confirm(`${labels[action]}?`)) return;
    setBusyId(report.id);
    try {
      await adminFetch(`/api/admin/reports/${report.id}`, { method: 'PUT', body: JSON.stringify({ action }) });
      await load();
    } catch (e) { alert(e.message); }
    finally { setBusyId(null); }
  };

  const countOf = (s) => (counts.find((c) => c.status === s) || {}).count || 0;

  return (
    <div style={S.page}>
      <div style={S.wrap}>
        <h1 style={S.h1}>Moderation</h1>
        <p style={S.sub}>
          Report queue. Act promptly. Hide content and/or ban the user. Every action is logged.
          <button onClick={load} style={S.refresh}>{Icons.repeat('currentColor', 14)} Refresh</button>
        </p>

        {error && (
          <div style={S.err}>
            {error}{/403|Admin/i.test(error) ? '. Sign in to the app as an admin account first, then reload this page.' : ''}
          </div>
        )}

        <div style={S.counts}>
          <Badge label="Open" value={countOf('open')} color="#e5484d" />
          {/* content_reports also allows 'under_review'. Nothing writes it today,
              so the badge appears only when the number is real rather than
              parking a permanent zero on the header. */}
          {countOf('under_review') > 0 ? <Badge label="Under review" value={countOf('under_review')} color="#f5a623" /> : null}
          <Badge label="Resolved" value={countOf('resolved')} color="#30a46c" />
          <Badge label="Dismissed" value={countOf('dismissed')} color="#7c7c87" />
        </div>

        {loading ? <p style={S.dim}>Loading…</p> : (
          <>
            <h2 style={S.h2}>Reports</h2>
            {/* "Queue is clear." is the most reassuring sentence on this
                screen, so it is never printed over a failed load. An empty list
                and an unread list look identical, and only one of them means
                there is nothing to do. */}
            {reports.length === 0 ? (
              <p style={S.dim}>{error ? 'The queue could not be loaded, so this is not a count of anything.' : 'Queue is clear.'}</p>
            ) : (
              <div style={S.list}>
                {reports.map((r) => {
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
                  const showActions = canHide || canRestore || canBan || unhandled;
                  return (
                  <div key={r.id} style={{ ...S.card, opacity: unhandled ? 1 : 0.7 }}>
                    <div style={S.cardTop}>
                      <span style={S.reason}>{own(REASON_LABEL, r.reason) || r.reason}</span>
                      <span style={S.type}>{typeLabel(r.content_type)}{r.content_id ? ` #${r.content_id}` : ''}</span>
                      <span style={{ ...S.status, color: unhandled ? '#e5484d' : '#7c7c87' }}>{String(r.status || '').replace(/_/g, ' ')}</span>
                    </div>
                    <div style={S.meta}>
                      Reported user: <b>{r.reported_user_name || '—'}</b>
                      {r.reported_user_banned ? <span style={S.banned}>BANNED</span> : null}
                      {'  ·  '}reporter: {r.reporter_name || '—'}{'  ·  '}{fmt(r.created_at)}
                    </div>
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
                      <div style={S.actions}>
                        {canHide ? (
                          <button disabled={busyId === r.id} onClick={() => act(r, 'hide')} style={S.btnHide}>Hide content</button>
                        ) : null}
                        {canRestore ? (
                          <button disabled={busyId === r.id} onClick={() => act(r, 'unhide')} style={S.btn}>Restore content</button>
                        ) : null}
                        {canBan ? (
                          r.reported_user_banned
                            ? <button disabled={busyId === r.id} onClick={() => act(r, 'unban')} style={S.btn}>Unban user</button>
                            : <button disabled={busyId === r.id} onClick={() => act(r, 'ban')} style={S.btnBan}>Ban user</button>
                        ) : null}
                        {unhandled ? <button disabled={busyId === r.id} onClick={() => act(r, 'dismiss')} style={S.btn}>Dismiss</button> : null}
                      </div>
                    )}
                  </div>
                  );
                })}
              </div>
            )}

            <h2 style={S.h2}>Audit log</h2>
            {actions.length === 0 ? (
              <p style={S.dim}>{error ? 'The audit log could not be loaded.' : 'No actions yet.'}</p>
            ) : (
              <div style={S.log}>
                {actions.map((a) => (
                  <div key={a.id} style={S.logRow}>
                    <b>{String(a.action || '').replace(/_/g, ' ')}</b>{a.target_user_name ? ` → ${a.target_user_name}` : ''}
                    {a.content_type ? `  (${typeLabel(a.content_type)}${a.content_id ? ` #${a.content_id}` : ''})` : ''}
                    <span style={S.logMeta}>  by {a.moderator_name || '—'} · {fmt(a.created_at)}</span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
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
  const showable = image && image.status === 'ready' && !image.renderFailed;
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

              {image && image.status === 'ready' && image.renderFailed ? (
                <div style={S.imgErr}>
                  <span>The image could not be displayed.</span>
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
  wrap: { maxWidth: 880, margin: '0 auto', padding: '32px 20px 80px' },
  h1: { fontSize: 28, margin: '0 0 4px' },
  h2: { fontSize: 18, margin: '28px 0 12px', color: '#c7c7cd' },
  sub: { color: '#9a9aa3', margin: '0 0 20px', fontSize: 14 },
  refresh: { marginLeft: 12, background: 'transparent', color: '#6cb8ff', border: 'none', cursor: 'pointer', fontSize: 14, display: 'inline-flex', alignItems: 'center', gap: 5, verticalAlign: -3, padding: 0, fontFamily: 'inherit' },
  err: { background: '#3a1416', border: '1px solid #e5484d', color: '#ffb3b6', padding: '10px 14px', borderRadius: 10, marginBottom: 16, fontSize: 14 },
  counts: { display: 'flex', gap: 12, marginBottom: 8 },
  badge: { background: '#17171b', border: '1px solid #25252b', borderRadius: 12, padding: '12px 18px', minWidth: 88, textAlign: 'center' },
  badgeVal: { fontSize: 24, fontWeight: 700 },
  badgeLabel: { fontSize: 12, color: '#8a8a93', marginTop: 2 },
  dim: { color: '#7c7c87' },
  list: { display: 'flex', flexDirection: 'column', gap: 10 },
  card: { background: '#17171b', border: '1px solid #25252b', borderRadius: 12, padding: 14 },
  cardTop: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 },
  reason: { fontWeight: 700 },
  type: { fontSize: 12, color: '#8a8a93', background: '#222228', padding: '2px 8px', borderRadius: 6 },
  status: { marginLeft: 'auto', fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.5 },
  meta: { fontSize: 13, color: '#9a9aa3' },
  banned: { color: '#e5484d', fontWeight: 700, marginLeft: 6, fontSize: 11 },
  details: { marginTop: 8, fontSize: 14, color: '#c7c7cd', fontStyle: 'italic' },
  content: { marginTop: 10, background: '#121216', border: '1px solid #24242a', borderRadius: 10, padding: '10px 12px' },
  contentHead: { fontSize: 12, color: '#8a8a93', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  hiddenTag: { color: '#a8cbe8', border: '1px solid #2d5a87', borderRadius: 5, padding: '1px 6px', fontSize: 10, letterSpacing: 0.5 },
  excerpt: { fontSize: 14, color: '#e7e7ea', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' },
  excerptFull: { maxHeight: 360, overflowY: 'auto', paddingRight: 6 },
  clip: { color: '#7c7c87', fontSize: 12, marginLeft: 4 },
  dimSmall: { fontSize: 13, color: '#7c7c87' },
  textBlock: { marginTop: 8, display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 6 },
  imgBlock: { marginTop: 10, display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 6 },
  img: { width: 320, maxWidth: '100%', maxHeight: 320, objectFit: 'contain', borderRadius: 8, border: '1px solid #25252b', background: '#0a0a0c', display: 'block' },
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
};
