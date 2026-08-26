import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import Icons from '../components/ui/Icons';
import './GuestInvite.css';

const API = process.env.REACT_APP_API_URL || 'https://flock-app-production.up.railway.app';

// ---------------------------------------------------------------------------
// GUEST INVITE (/i/:token) — the growth channel's entire first impression.
//
// THE JOB, stated as the person doing it: a link lands in a group chat. They
// open it on a phone, on data, having never heard of Flock, and inside about
// five seconds they decide whether these people and this plan are worth
// tapping into. Three things answer that, and the page is those three things:
//
//   1. THE PLAN.    What it is, where, when. Two ruled rows under a headline.
//   2. THE ROSTER.  Who is going, who is not, and who has not said. Per person,
//                   by name, because the decision is about people.
//   3. THE WAY IN.  One unmistakable primary action that puts them in the chat.
//
// Anything that is not one of those three had to earn its place. What was cut
// in the 2026-08-14 rebuild: a "What Flock is" prose section (its one useful
// sentence moved into the join band), a duplicated going-count, and the
// equal-weight RSVP button row that used to compete with the primary action.
//
// WHAT JOINING MEANS, AND WHY GUESTS STILL CANNOT TEXT. Joining is a real
// account and real membership (POST /api/guest/:token/join). Guest RSVP stays
// as the quieter second path for someone who will not make an account, and it
// deliberately does NOT reach the chat: a guest has no age gate, no account to
// suspend and no ban to enforce, so unauthenticated posting would put
// unmoderated content on a public link. The page says that plainly rather than
// implying the guest path is the same thing in fewer steps.
//
// Rules this page is held to (SLOP-AUDIT.md): no em dashes, no pill badge over
// the headline, no gradients, no icon-in-rounded-square tiles, no card stack,
// no scroll reveals, no claim of a feature that does not ship, no dead buttons,
// nothing that only works on hover, 320px with zero horizontal overflow, and
// every failure says something a person would say.
//
// Server contract lives in backend/routes/guest.js. Every branch below maps to
// something that route actually returns:
//   GET  /api/guest/:token          400 malformed, 404 revoked/unknown, 200 plan
//   POST /api/guest/:token/rsvp     400 bad name/status, 403 taken down,
//                                   404 link died mid-session, 429 capped
//   POST /api/guest/:token/vote     400 unknown venue, 403 not RSVPed, 404, 429
//   POST /api/guest/:token/join     authenticated; the app redeems it, not this
//                                   page (services/inviteHandoff.js)
// ---------------------------------------------------------------------------

// Matches the server's param('token').isLength({ min: 8, max: 64 }) in
// backend/routes/guest.js. Checking it here means a truncated paste gets an
// honest answer with no round trip.
//
// THIS WAS 20, AND 20 WAS A LIVE BUG. The token generator was widened to 24
// characters (LINK_TOKEN_LENGTH, ~138 bits) and the column to VARCHAR(64), so
// every freshly minted invite link was 24 characters long and this page
// answered every one of them with "That link isn't complete" before it ever
// asked the server. The only links that still worked were the legacy 12-char
// ones. Pinned against the server's bound, in a comment, so the next widening
// cannot quietly do it again.
const TOKEN_MIN = 8;
const TOKEN_MAX = 64;

// An event is treated as over six hours past its start time. Shorter than that
// and the night is probably still going, which is exactly when a late invite
// gets forwarded.
const OVER_AFTER_MS = 6 * 60 * 60 * 1000;

// The longest flock name that still fits on one line inside the join button at
// 320px, measured in a real Chromium against the production build rather than
// guessed: `Join "..."` adds three characters, and the button's inner width
// there is 252px at 16.5px/800.
const JOIN_NAME_MAX = 18;

// A roster is a list of people, not a directory. The server caps at 60; a
// phone screen stops being scannable long before that, so the rest becomes one
// honest line instead of an endless column.
const ROSTER_SHOWN = 14;

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

// The invite token, handed to the app so it survives signup, login, the Google
// popup and the native Sign in with Apple sheet. Written with the same key and
// the same shape services/inviteHandoff.js reads, and inlined here rather than
// imported because that module pulls in the whole REST client, which this page
// deliberately does not ship (it talks to three endpoints with bare fetch).
const HANDOFF_KEY = 'flock_pending_invite';

const stashInvite = (token, flockName) => {
  try {
    window.localStorage.setItem(HANDOFF_KEY, JSON.stringify({
      token,
      at: Date.now(),
      flockName: flockName ? String(flockName).slice(0, 80) : null,
    }));
    return true;
  } catch {
    // Storage is off. The account still gets made, they just land on the home
    // screen instead of in this flock, which is why the button copy below
    // promises the chat and not "instantly".
    return false;
  }
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

// The three answers, in one table, so the icon, the word and the row's weight
// can never drift apart. Type is carried by an icon AND a word AND the row's
// own contrast, never by colour alone (SLOP-AUDIT section N5).
const ANSWERS = {
  in: { word: 'Going', glyph: 'check', tone: 'yes' },
  out: { word: 'Out', glyph: 'x', tone: 'no' },
  none: { word: 'No answer', glyph: 'clock', tone: 'quiet' },
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

// The letterhead. The circular mark is the actual app icon, not a stand-in:
// somebody opening an unfamiliar link is entitled to see whose product this is
// before they read anything else.
function Shell({ children }) {
  return (
    <main className="gi">
      {/* First focusable element on the page (SLOP-AUDIT Q1), off-screen
          until focused. The target div carries tabIndex -1 so activating
          this moves focus past the letterhead with the scroll. */}
      <a className="gi-skip" href="#gi-content">Skip to the invitation</a>
      <div className="gi-wrap">
        <p className="gi-brand">
          <a className="gi-mark" href="/">
            <img src="/logo192.png" width="24" height="24" alt="" aria-hidden="true" />
            Flock
          </a>
          <span className="gi-brand-line">Where a group picks the place and the time.</span>
        </p>
        <div id="gi-content" tabIndex={-1}>
          {children}
        </div>
      </div>
    </main>
  );
}

// One ruled row of the plan rail. Label column is fixed so the two values line
// up on a single vertical edge, which is the whole reason this reads faster
// than a paragraph.
function Fact({ glyph, label, children }) {
  return (
    <div className="gi-fact">
      <span className="gi-fact-k">
        {Icons[glyph]('var(--gi-accent)', 13)}
        {label}
      </span>
      <span className="gi-fact-v">{children}</span>
    </div>
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
  const deadEndRef = useRef(null);
  // Which phase the last committed render used, so a phase CHANGE can be told
  // apart from the phase this page happened to open on.
  const lastPhase = useRef(null);

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

  // Two ways this page replaces itself under someone without them asking:
  //
  //   1. The host revokes the link while the tab is open, so an RSVP or a vote
  //      comes back 404 and the whole plan is swapped for "This invite has
  //      closed". Nothing announced that. A screen reader user heard silence
  //      after tapping "I'm in", and a sighted keyboard user's focus was on a
  //      button that no longer exists, which drops focus to <body>.
  //   2. "Try again" unmounts itself while it refetches. If the retry fails the
  //      button comes back as a NEW element, so the keyboard user who pressed
  //      it is back at the top of the document with no way to know.
  //
  // Moving focus to the heading covers both: it is announced, and Tab resumes
  // from the message rather than from nowhere. Deliberately NOT done on the
  // first render: stealing focus from someone who just opened a link is the
  // bug this is meant to avoid, not a fix for it.
  useEffect(() => {
    const changed = lastPhase.current !== null && lastPhase.current !== phase;
    lastPhase.current = phase;
    if (!changed) return;
    if (phase === 'ready' || phase === 'loading') return;
    if (deadEndRef.current) deadEndRef.current.focus();
  }, [phase]);

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

  // The roster, defended against a payload that is not the shape it should be.
  // This is an unauthenticated page rendering names it did not choose, and the
  // server is already the only thing that decides what crosses; the filtering
  // here is about never rendering `undefined` at somebody, not about trust.
  // The frontend deploys to Vercel and the backend to Railway, separately, so
  // there is always a window where one is newer than the other. A payload with
  // no `people` at all is an OLD SERVER, and it is not the same fact as "nobody
  // has answered": claiming an empty roster there would be the page inventing a
  // fact in the one direction that discourages the reader. `going` has been in
  // the payload since long before the roster and still answers "how many".
  const hasRoster = !!(data && Array.isArray(data.people));
  const people = useMemo(() => {
    const rows = (data && Array.isArray(data.people) ? data.people : [])
      .filter((p) => p && typeof p.name === 'string' && p.name.trim())
      .map((p) => ({
        name: p.name.trim(),
        rsvp: ANSWERS[p.rsvp] ? p.rsvp : 'none',
        isGuest: p.kind === 'guest',
      }));
    const RANK = { in: 0, out: 1, none: 2 };
    return rows.sort((a, b) => RANK[a.rsvp] - RANK[b.rsvp]);
  }, [data]);

  const tally = useMemo(() => {
    const t = { in: 0, out: 0, none: 0 };
    for (const p of people) t[p.rsvp] += 1;
    return t;
  }, [people]);

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
    // The name field is the only step that unsticks them, and it did not exist
    // a moment ago. Without this, a 403 on a VOTE left focus on a venue button
    // near the bottom of the page while the thing to fix appeared above the
    // fold, so a keyboard or switch user had to go looking for it. The field
    // carries aria-describedby="gi-problem-rsvp", so landing on it reads the
    // complaint out as the field's description rather than racing the alert.
    setTimeout(() => nameRef.current && nameRef.current.focus(), 0);
  };

  // THE PRIMARY ACTION. Stash the token, then hand the browser to the app's
  // signup entry. index.js routes /signup into App.js, which opens on the
  // create-account screen; App.js redeems the stash the moment a session
  // exists and opens this flock's chat (services/inviteHandoff.js).
  //
  // A real navigation, not a fetch: the two live in different entry points and
  // the app has to boot. window.location.assign rather than an <a href> is
  // deliberate, because the write has to happen first and a plain link would
  // race it.
  const goJoin = (where) => {
    stashInvite(token, flockName);
    window.location.assign(where);
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
        <span className="gi-skel gi-skel-row" />
        <span className="gi-skel gi-skel-row" />
        <span className="gi-skel gi-skel-block" />
      </Shell>
    );
  }

  if (phase !== 'ready') {
    const copy = {
      gone: {
        title: 'This invite has closed',
        // Expiry is a real state and it is the common one. Invite links carry
        // an expires_at (migrations/028_invite_link_expiry.sql: 14 days, or a
        // week past the plan's own start time, whichever is later), and
        // resolveLink answers an expired row exactly as it answers a revoked
        // one. Saying only "switched off" left the most likely reader of this
        // screen thinking the host had shut them out on purpose.
        lead: 'Invite links stop working after a couple of weeks, and a host can switch one off. The plan may also be over.',
        help: 'Ask whoever sent it for a new link. They can make one from the plan in the app. An old link never starts working again.',
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
          {/* tabIndex -1 so the effect above can put focus here when the page
              swaps itself out. It is not in the Tab order. */}
          <h1 ref={deadEndRef} tabIndex={-1}>{copy.title}</h1>
          <p className="gi-meta">{copy.lead}</p>
        </header>
        <section className="gi-sec">
          <p>{copy.help}</p>
          {copy.retry && (
            <p className="gi-row">
              <button type="button" className="gi-btn gi-btn-strong" onClick={() => load({ showLoading: true })}>
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
  // The server's answer to "can a NEW account still be admitted", which is a
  // different question from "is this plan closed". A flock at the link-join
  // ceiling still takes guest answers, so this changes the join band and
  // nothing else on the page.
  //
  // === true, not a truthiness test: the frontend and the backend deploy
  // separately, so an OLD SERVER omits this key entirely, and an absent key
  // must read as "not full" rather than as anything. Same rule as hasRoster.
  const atCapacity = !!(data && data.full === true);
  const showNameField = !guest || editingName;
  const shown = people.slice(0, ROSTER_SHOWN);
  const hidden = people.length - shown.length;

  return (
    <Shell>
      <header className="gi-header">
        {/* An eyebrow, not a badge: no pill, no fill, no border (SLOP-AUDIT
            A4/H20). It names the sender before the plan, because "who sent me
            this" is the first question an unfamiliar link raises. */}
        <p className="gi-eyebrow">{host ? `${host} invited you to` : 'You are invited to'}</p>
        <h1>{flockName || 'A plan with friends'}</h1>

        <div className="gi-facts">
          <Fact glyph="calendar" label="When">
            {when || 'Not set yet'}
          </Fact>
          <Fact glyph="mapPin" label="Where">
            {settled && flock.chosenVenue
              ? flock.chosenVenue
              : flock.chosenVenue
                // A host can set a venue at creation, before a single vote
                // exists, so an unconfirmed one is a proposal and is named as
                // one. Past tense once the plan is over: "up for a vote" about
                // a night that already happened is nonsense.
                ? `${flock.chosenVenue}${closed ? '' : ', if the vote holds'}`
                : closed
                  ? 'Never settled'
                  : venues.length > 0
                    ? `Up for a vote, ${venues.length} ${venues.length === 1 ? 'place' : 'places'}`
                    : 'Not decided yet'}
          </Fact>
        </div>
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

      {/* ------------------------------------------------------------ roster */}
      <section className="gi-sec" aria-labelledby="gi-who-h">
        {/* Past tense once it is over. "Who is coming" over a plan that was
            called off last week is the page not reading its own data. */}
        <h2 id="gi-who-h">{closed ? 'Who was coming' : 'Who is coming'}</h2>

        {people.length === 0 ? (
          <p className="gi-sub">
            {!hasRoster && going > 0
              ? `${going} ${going === 1 ? 'person is' : 'people are'} in so far.`
              : closed
                ? 'Nobody answered this one.'
                : 'Nobody has answered yet. You would be the first.'}
          </p>
        ) : (
          <>
            {/* Counts AND legend in one strip. Repeating the answer word on
                every row put a grey column of GOING / GOING / GOING down the
                right of the list, which is noise: the count is the one-second
                read, and once the strip says which glyph means which answer,
                the rows only need the glyph. Nothing here is carried by tint,
                which is the rule the repeated word was there to satisfy. */}
            <div className="gi-tally">
              {[['in', tally.in], ['out', tally.out], ['none', tally.none]].map(([key, n]) => (
                <p className="gi-tally-cell" key={key}>
                  <span className="gi-tally-n">{n}</span>
                  <span className="gi-tally-k">
                    {Icons[ANSWERS[key].glyph](key === 'in' ? 'var(--gi-accent)' : 'var(--gi-ink-3)', 12)}
                    {ANSWERS[key].word}
                  </span>
                </p>
              ))}
            </div>

            <ul className="gi-who">
              {shown.map((p, i) => {
                const a = ANSWERS[p.rsvp];
                return (
                  <li className={`gi-who-row gi-tone-${a.tone}`} key={`${p.name}-${i}`}>
                    <span className="gi-who-mark">
                      {Icons[a.glyph](a.tone === 'yes' ? 'var(--gi-accent)' : 'var(--gi-ink-3)', 14)}
                    </span>
                    <span className="gi-who-name">{p.name}</span>
                    {/* Somebody who answered the link but has no account. Worth
                        saying, because it is the difference between the people
                        in the chat and the people who only answered. */}
                    {p.isGuest && <span className="gi-who-kind">guest</span>}
                    {/* The glyph is decoration, so the answer is spelled out
                        here for anyone who is not looking at the legend. */}
                    <span className="gi-sr">{a.word}</span>
                  </li>
                );
              })}
            </ul>
            {hidden > 0 && (
              <p className="gi-sub gi-who-more">
                and {hidden} more {hidden === 1 ? 'person' : 'people'} on the plan.
              </p>
            )}
          </>
        )}
      </section>

      {/* -------------------------------------------------------- the way in */}
      {!closed && (
        <section className="gi-join" aria-labelledby="gi-join-h">
          <div className="gi-join-body">
            {/* A FULL PLAN GETS A DIFFERENT BAND, not a disabled button.
                POST /:token/join refuses a new account past the member ceiling
                with a 429, and until the server started saying so up front,
                this page's answer to a full flock was to send a stranger
                through a whole signup that could not end in this flock and
                then say nothing at all. A control whose only job is to reject
                you is worse than no control (SLOP-AUDIT H5), so the button is
                not drawn. The quiet sign-in line stays, because someone who is
                ALREADY on this plan tapping their own link is a 200 that opens
                the chat, and taking that away would be a new dead end in place
                of the old one. */}
            <h2 id="gi-join-h">{atCapacity ? 'This plan is full' : 'Get in the chat'}</h2>
            {atCapacity ? (
              <>
                <p className="gi-join-lead">
                  It already holds as many people as a flock can, so making an
                  account will not put you in this one. You can still answer
                  below, and {host || 'they'} will see it.
                </p>
                <p className="gi-join-alt">
                  Already on this plan?{' '}
                  <button type="button" className="gi-join-link" onClick={() => goJoin('/app')}>
                    Sign in and open it
                  </button>
                </p>
              </>
            ) : (
              <>
                <p className="gi-join-lead">
                  Making an account puts you in this group chat, on the vote, and
                  on the plan when it moves. It is free and it takes a minute.
                </p>
                <button type="button" className="gi-join-btn" onClick={() => goJoin('/signup')}>
                  {/* Naming the plan makes the button specific, which is worth
                      having. It is only worth having while it FITS: flocks.name
                      is long enough that a 60-character title turned the one
                      primary action on the page into a five-line block at
                      320px, which is the opposite of unmistakable. Past the
                      bound the headline two inches above already says which
                      flock this is. */}
                  {flockName && flockName.length <= JOIN_NAME_MAX
                    ? `Join "${flockName}"`
                    : 'Join this flock'}
                </button>
                <p className="gi-join-alt">
                  Already have Flock?{' '}
                  <button type="button" className="gi-join-link" onClick={() => goJoin('/app')}>
                    Sign in and join
                  </button>
                </p>
                {/* THE STEP THIS PAGE USED TO LEAVE OUT, and it is the one that
                    decides whether the trip finishes. A password signup writes
                    users.email_verified FALSE (routes/auth.js), and
                    POST /api/guest/:token/join is behind requireVerified, so
                    the membership is refused until the address is confirmed.
                    The refusal is the right one and it is not being argued
                    with here: an unverified account never becomes an accepted
                    member. What was wrong was the promise. The band above said
                    making an account puts you in the chat, and for the default
                    signup path it does not, not yet, which is exactly the
                    claim SLOP-AUDIT rule 5 forbids. Say the step instead.
                    No provider is named: which buttons the signup screen shows
                    depends on build configuration this page cannot see. */}
                <p className="gi-join-note">
                  If you sign up with an email and a password, open the
                  confirmation email we send you. That is the step that puts you
                  in the chat.
                </p>
              </>
            )}
          </div>
          {/* The brand bird, and the one place on this page it earns its keep:
              a stranger is being asked to make an account, and this is the
              product's face at the moment of the ask.

              THE WARM BIRD, NOT THE COBALT ONE, for a reason that is not
              preference: this band is navy in both themes, and cobalt Birdie is
              navy plumage. He would read as a smudge on it. The warm bird is
              sand against the same navy in light mode and against #1d293d in
              dark, so one asset carries both themes.
              A COMPOSITE, because the body file's own head is deliberately soft
              (the sharp turning head normally sits over it) and a bare body is
              a blurry-faced bird. Same two-layer construction BirdieStill uses,
              written out here rather than imported: this page ships its own
              tiny chunk and must not pull in the rAF mascot to draw a still
              one. Both layers are 166x166 on an identical canvas, so they line
              up with no offset maths. 10.5 KB of WebP for the pair, lazy and
              low priority, so it never delays the plan. */}
          <span className="gi-join-bird" aria-hidden="true">
            <picture>
              <source type="image/webp" srcSet="/birdie/warm-bird-400.webp" />
              <img src="/birdie/warm-bird-400.png" alt="" width="166" height="166" loading="lazy" decoding="async" fetchPriority="low" />
            </picture>
            <picture>
              <source type="image/webp" srcSet="/birdie/warm-bird-head-400.webp" />
              <img src="/birdie/warm-bird-head-400.png" alt="" width="166" height="166" loading="lazy" decoding="async" fetchPriority="low" />
            </picture>
          </span>
        </section>
      )}

      {/* ------------------------------------------------- the quieter path */}
      {!closed && (
        <section className="gi-sec" aria-labelledby="gi-rsvp-h">
          <h2 id="gi-rsvp-h">Or just answer</h2>
          <p className="gi-sub">
            No account needed. Your name and your answer show up here and in
            their app. It does not put you in the chat.
          </p>

          <form onSubmit={(e) => { e.preventDefault(); submitRsvp('in'); }}>
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

            {/* Both outline, never filled: the join band above is the only
                filled control on this page until an answer is given, which is
                what makes it unmistakable. A pressed answer fills in the
                accent, so the state is still obvious once it exists. */}
            <div className="gi-row">
              <button
                type="submit"
                className="gi-btn"
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

      {/* ------------------------------------------------------------ venues */}
      <section className="gi-sec" aria-labelledby="gi-vote-h">
        <h2 id="gi-vote-h">Where should it be?</h2>

        {venues.length === 0 ? (
          <p className="gi-sub">
            {closed
              ? 'No places were put up for a vote on this one.'
              : 'Nobody has suggested a place yet. The group adds them in the app, and they show up here when they do.'}
          </p>
        ) : (
          <>
            <p className="gi-sub">
              {closed
                ? 'How the votes landed.'
                : canVote
                  ? 'Pick one. You can change it.'
                  : 'Answer above first, then you can vote.'}
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

      <footer className="gi-footer">
        <p>
          Flock {DOT} <a href="/">flockcorp.com</a> {DOT} <a href="/privacy">Privacy</a>{' '}
          {DOT} <a href="/terms">Terms</a>
        </p>
      </footer>
    </Shell>
  );
}
