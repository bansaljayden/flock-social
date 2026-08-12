import React, { useEffect, useState, useCallback } from 'react';
import './PrivacyPolicy.css';

const API = process.env.REACT_APP_API_URL || 'https://flock-app-production.up.railway.app';

// Guest invite page (/i/:token). The cold-start growth surface: an invitee
// sees the plan, RSVPs, and votes WITHOUT an account. The account ask comes
// after the value, not before. Design follows the site rules (SLOP-AUDIT.md):
// Fraunces headline via the pp styles, no em dashes, nothing fake.

const dayLabel = (dateStr) => {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
};

export default function GuestInvite() {
  const token = window.location.pathname.split('/i/')[1]?.split('/')[0] || '';
  const storageKey = `flock_guest_${token}`;

  const [state, setState] = useState('loading'); // loading | ready | gone | error
  const [data, setData] = useState(null);
  const [name, setName] = useState('');
  const [guest, setGuest] = useState(() => {
    try { return JSON.parse(localStorage.getItem(storageKey)) || null; } catch { return null; }
  });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/guest/${encodeURIComponent(token)}`);
      if (res.status === 404) { setState('gone'); return; }
      if (!res.ok) throw new Error();
      setData(await res.json());
      setState('ready');
    } catch {
      setState('error');
    }
  }, [token]);

  useEffect(() => {
    document.title = "You're invited · Flock";
    if (!token) { setState('gone'); return; }
    load();
  }, [token, load]);

  const rsvp = async (status) => {
    if (busy) return;
    const trimmed = (guest?.name || name).trim();
    if (!trimmed) { setMsg('Add your name first so they know who this is.'); return; }
    setBusy(true);
    setMsg('');
    try {
      const res = await fetch(`${API}/api/guest/${encodeURIComponent(token)}/rsvp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed, status, guestToken: guest?.guestToken }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || 'Could not save your RSVP');
      const next = { guestToken: body.guestToken, name: trimmed, status };
      setGuest(next);
      localStorage.setItem(storageKey, JSON.stringify(next));
      setMsg(status === 'in' ? "You're in. Vote on a spot below." : "Noted. They'll see you're out.");
      load();
    } catch (e) {
      setMsg(e.message);
    } finally {
      setBusy(false);
    }
  };

  const vote = async (venueName) => {
    if (busy) return;
    if (!guest?.guestToken) { setMsg('RSVP first, then vote.'); return; }
    setBusy(true);
    setMsg('');
    try {
      const res = await fetch(`${API}/api/guest/${encodeURIComponent(token)}/vote`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ guestToken: guest.guestToken, venueName }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || 'Could not save your vote');
      setData((d) => ({ ...d, venues: body.venues }));
      setMsg(`Vote counted for ${venueName}.`);
    } catch (e) {
      setMsg(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (state === 'loading') {
    return (
      <main className="pp"><header className="pp-header"><h1>Loading the plan...</h1></header></main>
    );
  }
  if (state === 'gone' || state === 'error') {
    return (
      <main className="pp">
        <header className="pp-header">
          <h1>{state === 'gone' ? 'This invite link is no longer active' : 'Something went wrong'}</h1>
          <p className="pp-meta">
            {state === 'gone'
              ? 'Ask your friend to send a fresh link, or start your own plan.'
              : 'Give it a second and refresh.'}
          </p>
        </header>
        <section>
          <p><a href="/signup">Create a Flock account</a> and start the next plan yourself.</p>
        </section>
      </main>
    );
  }

  const { flock, host, going, venues } = data;
  const maxVotes = Math.max(1, ...venues.map((v) => v.votes));

  return (
    <main className="pp">
      <a href="/" className="pp-back">&larr; flockcorp.com</a>

      <header className="pp-header">
        <h1>{flock.name}</h1>
        <p className="pp-meta">
          {host} invited you{flock.date ? ` · ${dayLabel(flock.date)}` : ''}{flock.time ? ` · ${flock.time}` : ''}
          {going > 0 ? ` · ${going} going` : ''}
        </p>
      </header>

      <section>
        <h2>Are you in?</h2>
        {!guest && (
          <p style={{ marginBottom: 12 }}>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Your name"
              aria-label="Your name"
              maxLength={60}
              style={{ padding: '10px 14px', borderRadius: 10, border: '1px solid rgba(22,40,61,0.25)', fontSize: 16, fontFamily: 'inherit', width: '100%', maxWidth: 320, boxSizing: 'border-box' }}
            />
          </p>
        )}
        {guest && <p style={{ marginBottom: 12 }}>RSVPing as <strong>{guest.name}</strong>{guest.status ? `, currently ${guest.status === 'in' ? 'in' : 'out'}` : ''}.</p>}
        <p style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <button onClick={() => rsvp('in')} disabled={busy} style={{ padding: '12px 26px', borderRadius: 12, border: 'none', background: '#16283d', color: '#f4efe3', fontWeight: 700, fontSize: 15, cursor: 'pointer', fontFamily: 'inherit' }}>I'm in</button>
          <button onClick={() => rsvp('out')} disabled={busy} style={{ padding: '12px 26px', borderRadius: 12, border: '1px solid rgba(22,40,61,0.3)', background: 'transparent', color: '#16283d', fontWeight: 600, fontSize: 15, cursor: 'pointer', fontFamily: 'inherit' }}>Can't make it</button>
        </p>
        <p role="status" style={{ minHeight: 20, fontSize: 14, color: '#2d5a87', fontWeight: 600 }}>{msg}</p>
      </section>

      {venues.length > 0 && (
        <section>
          <h2>Where should it be?</h2>
          <p style={{ marginBottom: 14 }}>
            {flock.chosenVenue
              ? `The group locked in ${flock.chosenVenue}, but votes are still open.`
              : 'Tap a spot to vote for it.'}
          </p>
          <div style={{ display: 'grid', gap: 8, maxWidth: 460 }}>
            {venues.map((v) => (
              <button
                key={v.venue_name}
                onClick={() => vote(v.venue_name)}
                disabled={busy}
                style={{ textAlign: 'left', padding: '12px 14px', borderRadius: 12, border: '1px solid rgba(22,40,61,0.18)', background: '#fff', cursor: 'pointer', fontFamily: 'inherit' }}
              >
                <span style={{ display: 'flex', justifyContent: 'space-between', fontSize: 15, fontWeight: 600, color: '#16283d' }}>
                  <span>{v.venue_name}</span>
                  <span>{v.votes} {v.votes === 1 ? 'vote' : 'votes'}</span>
                </span>
                <span style={{ display: 'block', height: 5, borderRadius: 3, background: 'rgba(22,40,61,0.08)', marginTop: 8, overflow: 'hidden' }}>
                  <span style={{ display: 'block', height: '100%', width: `${Math.round((v.votes / maxVotes) * 100)}%`, background: '#2d5a87', borderRadius: 3 }} />
                </span>
              </button>
            ))}
          </div>
        </section>
      )}

      <section>
        <h2>Get the full plan</h2>
        <p>
          Flock is where this plan lives: the group chat, the crowd levels, the
          bill split at the end of the night. It's free.{' '}
          <a href="/signup"><strong>Create your account</strong></a> and it'll be
          waiting for you.
        </p>
      </section>

      <footer className="pp-footer">
        <p>Flock &middot; <a href="/">flockcorp.com</a></p>
      </footer>
    </main>
  );
}
