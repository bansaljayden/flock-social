import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import './GuestInvite.css';

const API = process.env.REACT_APP_API_URL || 'https://flock-app-production.up.railway.app';

// Guest invite page (/i/:token). The cold-start growth surface: someone who has
// never heard of Flock opens this in Safari on a phone, understands it, RSVPs,
// and votes WITHOUT an account. The account ask comes after the value, never
// in front of it.
//
// Rules this page is held to (SLOP-AUDIT.md): no em dashes, no claim of a
// feature that does not ship, no dead buttons, nothing that only works on
// hover, 320px with zero horizontal overflow, and every failure says something
// a person would say.
//
// Server contract lives in backend/routes/guest.js. Every branch below maps to
// something that route actually returns:
//   GET  /api/guest/:token          400 malformed, 404 revoked/unknown, 200 plan
//   POST /api/guest/:token/rsvp     400 bad name/status, 403 taken down,
//                                   404 link died mid-session, 429 capped
//   POST /api/guest/:token/vote     400 unknown venue, 403 not RSVPed, 404, 429

// Matches the server's param('token').isLength({ min: 8, max: 20 }). Checking
// it here means a truncated paste gets an honest answer with no round trip.
const TOKEN_MIN = 8;
const TOKEN_MAX = 20;

// An event is treated as over six hours past its start time. Shorter than that
// and the night is probably still going, which is exactly when a late invite
// gets forwarded.
const OVER_AFTER_MS = 6 * 60 * 60 * 1000;

// Escaped rather than literal so the source file stays pure ASCII and cannot
// pick up mojibake from a tool that guesses the encoding wrong.
const DOT = String.fromCharCode(0xb7);

// decodeURIComponent throws a URIError on a lone "%" or a half-written escape,
// which a mangled paste produces easily. Thrown from the component body it
// takes the whole page down to a white screen, and the /i/ route in index.js
// mounts without an ErrorBoundary, so nothing would catch it.
const safeDecode = (s) => {
  try { return decodeURIComponent(s); } catch { return s; }
};

const readStore = (key) => {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    // Safari private mode, disabled storage, or corrupt JSON. The page still
    // works, it just cannot remember them between visits.
    return null;
  }
};

const writeStore = (key, value) => {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* not remembering is survivable; crashing on the RSVP is not */
  }
};

const clearStore = (key) => {
  try { window.localStorage.removeItem(key); } catch { /* see above */ }
};

const parseWhen = (ts) => {
  if (!ts) return null;
  const d = new Date(ts);
  return isNaN(d.getTime()) ? null : d;
};

const whenLabel = (d) => {
  if (!d) return null;
  const opts = { weekday: 'long', month: 'short', day: 'numeric' };
  // A plan five months out reading "Friday, Jan 9" with no year is the kind of
  // small ambiguity that makes someone answer for the wrong night.
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  const day = d.toLocaleDateString(undefined, opts);
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `${day} ${DOT} ${time}`;
};

// One place decides what the guest is told when a write fails, so a raw
// "TypeError: Failed to fetch" can never reach the screen.
const failureText = (status, serverText, fallback, host) => {
  if (status === 0) return 'That did not go through. Check your connection and try again.';
  if (status === 429) {
    // Two different 429s come out of routes/guest.js. The per-flock cap is
    // permanent for this link, so telling someone to wait would be a lie.
    if (serverText && /too many guest rsvps/i.test(serverText)) {
      return `This link has hit its limit of 50 guest answers. Ask ${host || 'whoever sent it'} to add you in the app instead.`;
    }
    return serverText || 'Too many tries from this network. Give it a few minutes.';
  }
  if (status >= 500) return 'Flock is having a problem on our end. Try that again in a second.';
  return serverText || fallback;
};

// Module scope, not a closure inside the component. Declared inside, it would
// be a brand new component type on every render, so React would unmount and
// remount the whole page on each keystroke and the name field would lose focus
// after the first letter.
// Feedback sits next to the control that produced it, not in one shared strip
// further down the page. An error about the name field that renders below the
// venue list tells you that something failed but not where, which is the exact
// pattern SLOP-AUDIT section G3 calls out.
//
// Both paragraphs stay mounted with empty text rather than being conditionally
// rendered: a live region has to exist before its content changes or screen
// readers can miss the first announcement.
function Feedback({ where, feedback }) {
  const isHere = feedback.where === where;
  return (
    <>
      <p className="gi-msg" role="status">
        {isHere && feedback.kind === 'note' ? feedback.text : ''}
      </p>
      <p className="gi-msg gi-msg-bad" id={`gi-problem-${where}`} role="alert">
        {isHere && feedback.kind === 'problem' ? feedback.text : ''}
      </p>
    </>
  );
}

function Shell({ children }) {
  return (
    <main className="gi">
      <div className="gi-wrap">
        <p className="gi-brand">
          <a className="gi-mark" href="/">Flock</a>
          <span className="gi-brand-line">Where a group picks the place and the time.</span>
        </p>
        {children}
      </div>
    </main>
  );
}

export default function GuestInvite() {
  const rawToken = window.location.pathname.split('/i/')[1] || '';
  const token = safeDecode(rawToken.split('/')[0].split('?')[0]).trim();
  const storageKey = `flock_guest_${token}`;

  // loading | ready | gone | badlink | error | slow
  const [phase, setPhase] = useState('loading');
  const [data, setData] = useState(null);
  const [name, setName] = useState('');
  const [guest, setGuest] = useState(() => readStore(storageKey));
  const [editingName, setEditingName] = useState(false);
  // { kind: 'rsvp' | 'vote', key } rather than a bare string, so a venue that
  // happens to be named "in" cannot put the RSVP button into a saving state.
  const [busy, setBusy] = useState(null);
  const [pendingRsvp, setPendingRsvp] = useState(null);
  const [feedback, setFeedback] = useState({ where: 'rsvp', kind: '', text: '' });
  const [nameProblem, setNameProblem] = useState(false);
  const nameRef = useRef(null);

  // `quiet` is for the refresh that runs AFTER a successful write. Without it a
  // rate-limited or flaky refetch would replace a just-saved RSVP with a
  // full-page error, telling the guest their answer failed when it landed.
  const load = useCallback(async (opts = {}) => {
    if (opts.showLoading) setPhase('loading');
    const fail = (next) => { if (!opts.quiet) setPhase(next); };
    let res;
    try {
      res = await fetch(`${API}/api/guest/${encodeURIComponent(token)}`);
    } catch {
      fail('error');
      return;
    }
    if (res.status === 404) { fail('gone'); return; }
    if (res.status === 400) { fail('badlink'); return; }
    if (res.status === 429) { fail('slow'); return; }
    if (!res.ok) { fail('error'); return; }
    try {
      const body = await res.json();
      if (!body || !body.flock) throw new Error('shape');
      setData(body);
      setPhase('ready');
    } catch {
      fail('error');
    }
  }, [token]);

  useEffect(() => {
    if (!token || token.length < TOKEN_MIN || token.length > TOKEN_MAX) {
      setPhase('badlink');
      return;
    }
    load();
  }, [token, load]);

  const flock = data && data.flock ? data.flock : null;
  const flockName = (flock && flock.name) || '';
  const host = (data && data.host) || '';
  const eventDate = useMemo(() => parseWhen(flock && flock.when), [flock]);

  useEffect(() => {
    if (phase === 'loading') { document.title = 'Invite | Flock'; return; }
    if (phase !== 'ready') { document.title = 'Invite link | Flock'; return; }
    const who = host ? `${host} invited you` : "You're invited";
    document.title = flockName ? `${who}: ${flockName} | Flock` : `${who} | Flock`;
  }, [phase, host, flockName]);

  // The three ways a plan can be closed to new answers. `status` comes straight
  // from flocks.status, which the guest preview returns.
  const calledOff = flock ? flock.status === 'cancelled' : false;
  const finished = flock
    ? flock.status === 'completed' || (!!eventDate && Date.now() - eventDate.getTime() > OVER_AFTER_MS)
    : false;
  const closed = calledOff || finished;

  // flocks.venue_name is NOT proof the group decided anything: a host can set a
  // venue at creation time, before a single vote exists. It only means "decided"
  // once the flock reaches confirmed, which is what selecting a venue sets
  // (sockets/handlers.js). Labelling a host's starting guess as the group's pick
  // would be the page inventing a fact.
  const settled = flock
    ? ['confirmed', 'locked', 'completed'].includes(flock.status)
    : false;

  // The venue the group locked in may have zero votes, in which case the tally
  // query never returns it. It is still a legal vote target on the server
  // (routes/guest.js checks flocks.venue_name), so it belongs in the list.
  const venues = useMemo(() => {
    const rows = (data && Array.isArray(data.venues) ? data.venues : [])
      .filter((v) => v && typeof v.venue_name === 'string' && v.venue_name)
      .map((v) => ({ venue_name: v.venue_name, votes: Number(v.votes) || 0 }));
    const chosen = flock && flock.chosenVenue;
    if (chosen && !rows.some((v) => v.venue_name === chosen)) {
      rows.push({ venue_name: chosen, votes: 0 });
    }
    return rows.sort((a, b) => b.votes - a.votes);
  }, [data, flock]);

  const topVotes = venues.reduce((m, v) => Math.max(m, v.votes), 0);
  const rsvpStatus = pendingRsvp || (guest && guest.status) || null;
  const answered = !!(guest && guest.guestToken);
  const canVote = answered && !closed;
  const savingRsvp = busy && busy.kind === 'rsvp' ? busy.key : null;

  const say = (where, text) => setFeedback({ where, kind: 'note', text });
  const complain = (where, text) => setFeedback({ where, kind: 'problem', text });
  const hush = (where) => setFeedback({ where, kind: '', text: '' });
  const rsvpProblem = feedback.where === 'rsvp' && feedback.kind === 'problem';

  // The stored identity is dead server-side. Drop it and put them back on the
  // name field, which is the only step that can actually get them unstuck.
  const startOver = () => {
    setGuest(null);
    clearStore(storageKey);
    setEditingName(true);
    setName('');
    setPendingRsvp(null);
  };

  const submitRsvp = async (status) => {
    if (busy) return;
    const typed = (editingName || !guest ? name : (guest.name || '')).trim();
    if (!typed) {
      setNameProblem(true);
      complain('rsvp', 'Put your name in first so they know who answered.');
      if (nameRef.current) nameRef.current.focus();
      return;
    }
    setNameProblem(false);
    setBusy({ kind: 'rsvp', key: status });
    setPendingRsvp(status); // optimistic: the choice reads as made immediately
    hush('rsvp');

    let res;
    let body = {};
    try {
      res = await fetch(`${API}/api/guest/${encodeURIComponent(token)}/rsvp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: typed,
          status,
          guestToken: (guest && guest.guestToken) || undefined,
        }),
      });
      body = await res.json().catch(() => ({}));
    } catch {
      setPendingRsvp(null);
      setBusy(null);
      complain('rsvp', failureText(0));
      return;
    }

    setBusy(null);

    if (res.status === 404) {
      // The host revoked the link while this page was open. Say so plainly
      // rather than leaving a button that will never work.
      setPendingRsvp(null);
      setPhase('gone');
      return;
    }
    if (res.status === 403) {
      // Either the RSVP behind this token was removed, or the name itself was
      // removed from this flock. Both leave them stuck holding a dead token.
      setPendingRsvp(null);
      startOver();
      complain('rsvp', body.error || 'That did not go through. Try a different name.');
      return;
    }
    if (!res.ok) {
      setPendingRsvp(null);
      complain('rsvp', failureText(res.status, body.error, 'Your answer did not save. Try again.', host));
      return;
    }

    if (!body.guestToken) {
      // A 2xx with no identity in it would leave them unable to vote and unable
      // to edit, silently re-creating a guest row on every tap.
      setPendingRsvp(null);
      complain('rsvp', 'Your answer did not save properly. Try that again.');
      return;
    }

    const next = { guestToken: body.guestToken, name: typed, status, vote: guest && guest.vote };
    setGuest(next);
    writeStore(storageKey, next);
    setPendingRsvp(null);
    setEditingName(false);
    say('rsvp', status === 'in'
      ? venues.length > 0
        ? "You're in. Now say where."
        : `You're in. ${host || 'They'} can see it.`
      : `Answered. ${host || 'They'} can see you can't make it.`);
    load({ quiet: true });
  };

  const submitVote = async (venueName) => {
    if (busy) return;
    if (!canVote) return;
    setBusy({ kind: 'vote', key: venueName });
    hush('vote');

    let res;
    let body = {};
    try {
      res = await fetch(`${API}/api/guest/${encodeURIComponent(token)}/vote`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ guestToken: guest.guestToken, venueName }),
      });
      body = await res.json().catch(() => ({}));
    } catch {
      setBusy(null);
      complain('vote', failureText(0));
      return;
    }

    setBusy(null);

    if (res.status === 404) { setPhase('gone'); return; }
    if (res.status === 403) {
      startOver();
      complain('rsvp', 'Your RSVP is not on this plan anymore. Answer again, then vote.');
      return;
    }
    if (res.status === 400) {
      // The group dropped that venue between the page load and the tap.
      complain('vote', 'That place is not on the list anymore. Getting the current options.');
      load({ quiet: true });
      return;
    }
    if (!res.ok) {
      complain('vote', failureText(res.status, body.error, 'Your vote did not save. Try again.', host));
      return;
    }

    if (Array.isArray(body.venues)) {
      setData((d) => ({ ...d, venues: body.venues }));
    }
    const next = { ...guest, vote: venueName };
    setGuest(next);
    writeStore(storageKey, next);
    say('vote', `Counted. You picked ${venueName}.`);
  };

  // ---------------------------------------------------------------- states

  if (phase === 'loading') {
    return (
      <Shell>
        <p className="gi-sr" role="status">Loading the plan.</p>
        <span className="gi-skel gi-skel-h1" />
        <span className="gi-skel gi-skel-meta" />
        <span className="gi-skel gi-skel-block" />
        <span className="gi-skel gi-skel-row" />
        <span className="gi-skel gi-skel-row" />
      </Shell>
    );
  }

  if (phase !== 'ready') {
    const copy = {
      gone: {
        title: 'This invite has closed',
        lead: 'The link was either switched off or the plan is over.',
        help: 'Ask whoever sent it for a new one. Links belong to one plan, so an old one never starts working again.',
        retry: false,
      },
      badlink: {
        title: "That link isn't complete",
        lead: 'Invite links break when only part of the message gets copied.',
        help: 'Open it straight from the message they sent you, or ask them to send it again.',
        retry: false,
      },
      slow: {
        title: 'Too many tries from here',
        lead: 'Your network has asked for this page a lot in a short time.',
        help: 'Wait a minute and load it again. Nothing is wrong with the link.',
        retry: true,
      },
      error: {
        title: "We couldn't load this invite",
        lead: 'Either your connection dropped or Flock is having a problem.',
        help: 'The link is probably fine. Try it again.',
        retry: true,
      },
    }[phase] || {
      title: "We couldn't load this invite",
      lead: 'Something unexpected happened.',
      help: 'Try it again.',
      retry: true,
    };

    return (
      <Shell>
        <header className="gi-header">
          <h1>{copy.title}</h1>
          <p className="gi-meta">{copy.lead}</p>
        </header>
        <section className="gi-sec">
          <p>{copy.help}</p>
          {copy.retry && (
            <p className="gi-row">
              <button type="button" className="gi-btn gi-btn-primary" onClick={() => load({ showLoading: true })}>
                Try again
              </button>
            </p>
          )}
          <p>
            Flock is a free app for sorting out where a group is going.{' '}
            <a href="/">See what it does</a>.
          </p>
        </section>
        <footer className="gi-footer">
          <p>Flock {DOT} <a href="/">flockcorp.com</a></p>
        </footer>
      </Shell>
    );
  }

  // ---------------------------------------------------------------- the plan

  const when = whenLabel(eventDate);
  const going = Number(data && data.going) || 0;
  const showNameField = !guest || editingName;

  const metaBits = [];
  // event_time is nullable, and a plan with no time yet is common early on.
  // Saying so beats leaving a blank where the date should be.
  metaBits.push(when || 'time not set yet');
  if (going > 0) metaBits.push(`${going} going`);

  return (
    <Shell>
      <header className="gi-header">
        <h1>{flockName || 'A plan with friends'}</h1>
        <p className="gi-meta">
          <strong>{host || 'Someone'}</strong> invited you
          {metaBits.length > 0 ? ` ${DOT} ${metaBits.join(` ${DOT} `)}` : ''}
        </p>
      </header>

      {closed && (
        <div className="gi-notice">
          <p><strong>{calledOff ? 'This plan was called off.' : 'This one already happened.'}</strong></p>
          <p>
            {calledOff
              ? 'Nothing to answer. Here is what it was, in case you were looking for it.'
              : 'You can still see how it went. Answers and votes are closed.'}
          </p>
        </div>
      )}

      {!closed && (
        <section className="gi-sec" aria-labelledby="gi-rsvp-h">
          <h2 id="gi-rsvp-h">Are you coming?</h2>
          <p className="gi-sub">
            Answer right here. You do not need an account.
          </p>

          <form
            onSubmit={(e) => { e.preventDefault(); submitRsvp('in'); }}
          >
            {showNameField ? (
              <span className="gi-field">
                <label className="gi-label" htmlFor="gi-name">Your name</label>
                <input
                  id="gi-name"
                  ref={nameRef}
                  className="gi-input"
                  type="text"
                  value={name}
                  onChange={(e) => { setName(e.target.value); if (nameProblem) setNameProblem(false); }}
                  placeholder="Maya"
                  autoComplete="name"
                  enterKeyHint="go"
                  maxLength={60}
                  aria-invalid={nameProblem ? 'true' : undefined}
                  aria-describedby="gi-problem-rsvp"
                />
              </span>
            ) : (
              <p className="gi-sub">
                Answering as <strong>{guest.name}</strong>.{' '}
                <button
                  type="button"
                  className="gi-btn-quiet"
                  onClick={() => {
                    setName(guest.name || '');
                    setEditingName(true);
                    setTimeout(() => nameRef.current && nameRef.current.focus(), 0);
                  }}
                >
                  Change name
                </button>
              </p>
            )}

            <div className="gi-row">
              <button
                type="submit"
                className={rsvpStatus === 'in' ? 'gi-btn' : 'gi-btn gi-btn-primary'}
                aria-pressed={rsvpStatus === 'in'}
                aria-disabled={busy !== null}
              >
                {savingRsvp === 'in' ? 'Saving' : "I'm in"}
              </button>
              <button
                type="button"
                className="gi-btn"
                aria-pressed={rsvpStatus === 'out'}
                onClick={() => submitRsvp('out')}
                aria-disabled={busy !== null}
              >
                {savingRsvp === 'out' ? 'Saving' : "Can't make it"}
              </button>
            </div>
          </form>

          <Feedback where="rsvp" feedback={feedback} />

          {rsvpStatus && !rsvpProblem && (
            <p className="gi-sub">
              {rsvpStatus === 'in'
                ? "You're down as coming. Tap the other button any time if that changes."
                : "You're down as out. Tap I'm in if that changes."}
            </p>
          )}
        </section>
      )}

      <section className="gi-sec" aria-labelledby="gi-vote-h">
        <h2 id="gi-vote-h">Where should it be?</h2>

        {venues.length === 0 ? (
          <div className="gi-empty">
            <p>
              {closed
                ? 'No places were put up for a vote on this one.'
                : answered
                  ? 'Nobody has suggested a place yet. The group adds them in the app, and they show up here when they do. Your answer is saved either way.'
                  : 'Nobody has suggested a place yet. The group adds them in the app, and they show up here when they do. You can still answer above.'}
            </p>
          </div>
        ) : (
          <>
            <p className="gi-sub">
              {closed
                ? 'How the votes landed.'
                : canVote
                  ? 'Pick one. You can change it.'
                  : 'Answer above first, then you can vote.'}
              {!closed && settled && flock.chosenVenue
                ? ` They have settled on ${flock.chosenVenue} for now.`
                : ''}
            </p>
            <ul className="gi-venues">
              {venues.map((v) => {
                const pct = topVotes > 0 ? Math.round((v.votes / topVotes) * 100) : 0;
                const mine = !!(guest && guest.vote === v.venue_name);
                const chosen = settled && !!(flock && flock.chosenVenue === v.venue_name);
                const inner = (
                  <>
                    <span className="gi-venue-top">
                      <span className="gi-venue-name">{v.venue_name}</span>
                      <span className="gi-venue-count">
                        {v.votes} {v.votes === 1 ? 'vote' : 'votes'}
                      </span>
                    </span>
                    <span className="gi-bar" style={{ '--gi-fill': `${pct}%` }} aria-hidden="true">
                      <span />
                    </span>
                    {(chosen || mine) && (
                      <span className="gi-tags">
                        {chosen && <span className="gi-tag">Locked in</span>}
                        {mine && <span className="gi-tag">Your vote</span>}
                      </span>
                    )}
                  </>
                );

                // Not answered yet, or the plan is closed: a row, not a button.
                // A control whose only job is to reject you is worse than no
                // control at all.
                if (!canVote) {
                  return <li key={v.venue_name}><div className="gi-venue">{inner}</div></li>;
                }
                return (
                  <li key={v.venue_name}>
                    <button
                      type="button"
                      className="gi-venue gi-venue-btn"
                      aria-pressed={mine}
                      aria-disabled={busy !== null}
                      onClick={() => submitVote(v.venue_name)}
                    >
                      {inner}
                    </button>
                  </li>
                );
              })}
            </ul>
          </>
        )}

        <Feedback where="vote" feedback={feedback} />
      </section>

      <section className="gi-sec" aria-labelledby="gi-app-h">
        <h2 id="gi-app-h">What Flock is</h2>
        <p>
          This plan was made in Flock. The app is where the rest of the night
          runs: the group chat, how packed a place is before you leave, and the
          bill split at the end.
        </p>
        <p>
          An account is free.{' '}
          {closed
            ? ''
            : answered
              ? 'You did not need one for any of this, and you still do not. '
              : 'You do not need one to answer above. '}
          <a href="/signup">Create one</a> when you want to run a plan yourself.
          Signing up will not pull this plan onto your account, so ask{' '}
          {host || 'the host'} to add you if you want it on your phone.
        </p>
      </section>

      <footer className="gi-footer">
        <p>
          Flock {DOT} <a href="/">flockcorp.com</a> {DOT} <a href="/privacy">Privacy</a>{' '}
          {DOT} <a href="/terms">Terms</a>
        </p>
      </footer>
    </Shell>
  );
}
