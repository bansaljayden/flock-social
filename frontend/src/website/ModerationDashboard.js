import React, { useEffect, useState, useCallback } from 'react';
import { getToken, BASE_URL } from '../services/api';

// Admin-only moderation console (A6). Routed at /admin/moderation.
// Backed by GET/PUT /api/admin/reports + GET /api/admin/moderation-actions,
// all gated server-side by requireAdmin. Reviewers / the solo mod use this to
// action reports promptly (Apple 1.2 / Google UGC).

const REASON_LABEL = {
  harassment: 'Harassment', hate: 'Hate speech', sexual: 'Sexual content',
  violence: 'Violence/threats', self_harm: 'Self-harm', spam: 'Spam', other: 'Other',
};
const HIDEABLE = { flock_message: true, dm: true, story: true, profile: false };

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

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const r = await adminFetch('/api/admin/reports');
      setReports(r.reports || []);
      setCounts(r.counts || []);
      const a = await adminFetch('/api/admin/moderation-actions');
      setActions(a.actions || []);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const act = async (report, action) => {
    const labels = {
      hide: 'Hide this content', ban: `Ban ${report.reported_user_name || 'this user'}`,
      dismiss: 'Dismiss this report', unban: `Unban ${report.reported_user_name || 'this user'}`,
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
          Report queue. Act promptly — hide content and/or ban the user. Every action is logged.
          <button onClick={load} style={S.refresh}>↻ Refresh</button>
        </p>

        {error && (
          <div style={S.err}>
            {error}{/403|Admin/i.test(error) ? ' — sign in to the app as an admin account first, then reload this page.' : ''}
          </div>
        )}

        <div style={S.counts}>
          <Badge label="Open" value={countOf('open')} color="#e5484d" />
          <Badge label="Resolved" value={countOf('resolved')} color="#30a46c" />
          <Badge label="Dismissed" value={countOf('dismissed')} color="#7c7c87" />
        </div>

        {loading ? <p style={S.dim}>Loading…</p> : (
          <>
            <h2 style={S.h2}>Reports</h2>
            {reports.length === 0 ? <p style={S.dim}>No reports. 🎉</p> : (
              <div style={S.list}>
                {reports.map((r) => (
                  <div key={r.id} style={{ ...S.card, opacity: r.status === 'open' ? 1 : 0.6 }}>
                    <div style={S.cardTop}>
                      <span style={S.reason}>{REASON_LABEL[r.reason] || r.reason}</span>
                      <span style={S.type}>{r.content_type}{r.content_id ? ` #${r.content_id}` : ''}</span>
                      <span style={{ ...S.status, color: r.status === 'open' ? '#e5484d' : '#7c7c87' }}>{r.status}</span>
                    </div>
                    <div style={S.meta}>
                      Reported user: <b>{r.reported_user_name || '—'}</b>
                      {r.reported_user_banned ? <span style={S.banned}>BANNED</span> : null}
                      {'  ·  '}reporter: {r.reporter_name || '—'}{'  ·  '}{fmt(r.created_at)}
                    </div>
                    {r.details ? <div style={S.details}>“{r.details}”</div> : null}
                    {r.status === 'open' && (
                      <div style={S.actions}>
                        {HIDEABLE[r.content_type] && r.content_id ? (
                          <button disabled={busyId === r.id} onClick={() => act(r, 'hide')} style={S.btnHide}>Hide content</button>
                        ) : null}
                        {r.reported_user_id ? (
                          r.reported_user_banned
                            ? <button disabled={busyId === r.id} onClick={() => act(r, 'unban')} style={S.btn}>Unban user</button>
                            : <button disabled={busyId === r.id} onClick={() => act(r, 'ban')} style={S.btnBan}>Ban user</button>
                        ) : null}
                        <button disabled={busyId === r.id} onClick={() => act(r, 'dismiss')} style={S.btn}>Dismiss</button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            <h2 style={S.h2}>Audit log</h2>
            {actions.length === 0 ? <p style={S.dim}>No actions yet.</p> : (
              <div style={S.log}>
                {actions.map((a) => (
                  <div key={a.id} style={S.logRow}>
                    <b>{a.action}</b>{a.target_user_name ? ` → ${a.target_user_name}` : ''}
                    {a.content_type ? `  (${a.content_type}${a.content_id ? ` #${a.content_id}` : ''})` : ''}
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

function Badge({ label, value, color }) {
  return (
    <div style={S.badge}>
      <div style={{ ...S.badgeVal, color }}>{value}</div>
      <div style={S.badgeLabel}>{label}</div>
    </div>
  );
}

const S = {
  page: { minHeight: '100vh', background: '#0e0e11', color: '#e7e7ea', fontFamily: '-apple-system, system-ui, Segoe UI, Roboto, sans-serif' },
  wrap: { maxWidth: 880, margin: '0 auto', padding: '32px 20px 80px' },
  h1: { fontSize: 28, margin: '0 0 4px' },
  h2: { fontSize: 18, margin: '28px 0 12px', color: '#c7c7cd' },
  sub: { color: '#9a9aa3', margin: '0 0 20px', fontSize: 14 },
  refresh: { marginLeft: 12, background: 'transparent', color: '#6cb8ff', border: 'none', cursor: 'pointer', fontSize: 14 },
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
  actions: { display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' },
  btn: { background: '#222228', color: '#e7e7ea', border: '1px solid #33333a', borderRadius: 8, padding: '7px 12px', cursor: 'pointer', fontSize: 13 },
  btnHide: { background: '#2a2150', color: '#c9bbff', border: '1px solid #4a3aa0', borderRadius: 8, padding: '7px 12px', cursor: 'pointer', fontSize: 13 },
  btnBan: { background: '#3a1416', color: '#ffb3b6', border: '1px solid #e5484d', borderRadius: 8, padding: '7px 12px', cursor: 'pointer', fontSize: 13 },
  log: { display: 'flex', flexDirection: 'column', gap: 6 },
  logRow: { fontSize: 13, color: '#c7c7cd', padding: '6px 10px', background: '#141417', borderRadius: 8 },
  logMeta: { color: '#7c7c87' },
};
