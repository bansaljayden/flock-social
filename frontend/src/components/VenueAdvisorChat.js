import React, { useCallback, useEffect, useRef, useState } from 'react';

// Roost, the chat half of the venue advisor: a Q&A thread on the venue
// dashboard, below the insight cards.
//
// TWO WAYS IN, AND THE ANSWER ALWAYS SAYS WHICH KIND IT IS.
//
// The FIELD IS THE SURFACE. A text box sits at the bottom of the card, always
// drawn, always the last thing the eye lands on, exactly the way Birdie's box
// sits under Birdie's thread. Suggested questions (chips) are starting points
// above it, four of them, chosen by the server from what this venue's data can
// actually answer; they are not the way in, they are a shortcut past the way
// in. The owner can ask anything about their business, and the server routes
// it to exactly one of three answers.
//
// It did not start that way. The field rendered only when the server said
// `freeText: true`, and the server said false on every deploy because both of
// its flags defaulted off, so a built and tested feature reached its owner as
// an ABSENCE: no field, no explanation, nothing to notice was missing. Both
// flags now default on (services/advisorFreeText.js), and this file no longer
// has a state where the field is gone: when the server declines, the box is
// still there, disabled, with the server's own sentence under it. A decline
// the owner can read is a decline. A decline they cannot see is a bug.
//
//   grounded  built from typed facts about this venue, with sources and dates.
//             Renders with its source line, exactly as a chip answer does,
//             because it IS a chip answer: free text is another way to reach
//             the same pipeline, never a second pipeline.
//   advice    general trade knowledge, marked as such under the answer. Any
//             number about this venue inside it still came through the fact
//             engine, so the source line still appears when one did.
//   refusal   declined, in quieter ink, saying what is missing. A refusal is
//             the MAIN state for most venues today, not an error, and it never
//             carries an upsell.
//
// The product name and the free-text field's availability both arrive from the
// server (`name` and `freeText` on /questions), so a rename is one backend
// line and the field explains itself rather than vanishing when the server
// would decline it.
//
// WIRING (App.js, venue dashboard). Render below <VenueInsightCards ...>:
//
//   import VenueAdvisorChat from './components/VenueAdvisorChat';
//   import { getAdvisorQuestions, askAdvisor, askAdvisorQuestion } from './services/api';
//   ...
//   <VenueAdvisorChat
//     fetchQuestions={getAdvisorQuestions}
//     ask={askAdvisor}
//     askQuestion={askAdvisorQuestion}
//     colors={colors}
//   />
//
// Props are injected rather than imported (the VenueInsightCards pattern) so
// this file has no dependency on the contended api.js and tests hand it
// fixtures.

// THE BRAND IS SAID ONCE ON THIS SCREEN. VenueInsightCards titles the surface
// "Roost"; this block sits a few hundred pixels below it in the same scroll, so
// titling it "Roost" too printed the product name twice on one screen and told
// the owner nothing either time. It is titled for what it is instead. The name
// still arrives from the server for the places it belongs (the field's screen
// reader label, the locked and error states, which can be read without the
// cards above them in view), so a rename is still one backend line.
const ADVISOR_NAME = 'Roost';
const BLOCK_TITLE = 'Ask a question';

const CARD_STYLE = {
  backgroundColor: 'var(--bg-card-solid)',
  borderRadius: '12px',
  padding: '12px',
  marginBottom: '12px',
  boxShadow: 'var(--card-shadow-sm)',
};

const CHIP_STYLE = {
  display: 'inline-block',
  padding: '6px 10px',
  margin: '0 6px 6px 0',
  fontSize: 'var(--t-meta)',
  lineHeight: 1.3,
  color: 'var(--text-primary)',
  backgroundColor: 'transparent',
  border: '1px solid var(--border-light)',
  borderRadius: '8px',
  cursor: 'pointer',
};

// Human names for fact sources, mirroring the server's vocabulary. Unknown
// sources fall back to their own id with the underscores removed, so a new
// server-side source never renders as raw snake_case.
const SOURCE_LABELS = {
  intake: 'your intake',
  owner_report: 'your own readings',
  model_holdout: 'model estimate',
  user_reports: 'user reports',
  votes: 'Flock group activity',
  events: 'Ticketmaster listings',
  weather: 'weather service',
  served_prediction: 'what Flock served',
  google_baseline: "your Google profile's pattern",
  arithmetic: 'arithmetic on the facts above',
  category_pattern: 'category pattern',
};
const sourceLabel = (s) => SOURCE_LABELS[s] || String(s || '').replace(/_/g, ' ');

// One line naming every distinct source an answer used. Answers with no
// sources (refusals) render no line: a refusal quotes nothing.
const sourcesLine = (sources) => {
  if (!Array.isArray(sources) || sources.length === 0) return null;
  const seen = [];
  for (const s of sources) {
    const label = sourceLabel(s.source);
    if (!seen.includes(label)) seen.push(label);
  }
  return `From ${seen.join(', ')}.`;
};

// Answer text arrives as plain sentences (phrased) or as one line per fact
// (template). Render each line as its own paragraph either way.
const AnswerText = ({ text, tone }) => (
  <>
    {String(text || '').split('\n').filter(Boolean).map((line, i) => (
      <p key={i} style={{ fontSize: 'var(--t-meta)', color: tone, margin: i === 0 ? 0 : '6px 0 0', lineHeight: 1.5 }}>{line}</p>
    ))}
  </>
);

// How the two kinds of answer are told apart, and why it is drawn twice.
//
// A grounded answer is flush with the question above it and carries its source
// line, because its sources ARE its claim to be believed. An advice answer is
// inset behind a hairline rule and carries this sentence, so the difference is
// legible before a word is read and unambiguous after. Colour alone would not
// do it: the two answers are the same ink, on purpose, because advice is not a
// lesser answer, it is a different KIND of answer.
const ADVICE_MARKER = 'General advice, not from your data.';

// What the owner reads while the server works. Which sentence is true depends
// on which door the question came in by: a chip is already routed, so we are
// genuinely reading their numbers. A typed question has not been routed yet,
// and the router may well send it somewhere their numbers cannot go, so
// promising to read them would be a small lie told several times a day.
const PENDING_CHIP = 'Reading your numbers…';
const PENDING_TYPED = 'Working on it…';

const ThreadTurn = ({ turn, first, navy, onRetry }) => {
  const advice = turn.status === 'done' && turn.answer && turn.answer.mode === 'advice';
  return (
    <div style={{ padding: '10px 0', borderTop: first ? 'none' : '1px solid var(--border-light)' }}>
      <p style={{ fontSize: 'var(--t-meta)', fontWeight: '600', color: navy, margin: 0, lineHeight: 1.4 }}>{turn.question}</p>
      <div
        style={{
          margin: '6px 0 0',
          paddingLeft: advice ? '10px' : '0px',
          // Longhand, not the `border-left` shorthand: a shorthand carrying a
          // custom property is dropped by the CSS parser the test suite runs
          // on, so the rule would be invisible to any check that it is there.
          borderLeftWidth: advice ? '2px' : '0px',
          borderLeftStyle: advice ? 'solid' : 'none',
          borderLeftColor: 'var(--border-light)',
        }}
      >
        {turn.status === 'pending' && (
          <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)', margin: 0 }}>
            {turn.typed ? PENDING_TYPED : PENDING_CHIP}
          </p>
        )}
        {turn.status === 'error' && (
          <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: 0 }}>
            That did not go through.{' '}
            <button
              type="button"
              onClick={onRetry}
              style={{ background: 'none', border: 'none', padding: 0, font: 'inherit', color: navy, textDecoration: 'underline', cursor: 'pointer' }}
            >
              Try again
            </button>
          </p>
        )}
        {turn.status === 'done' && (
          <>
            {/* A refusal wears the same chrome as an answer: quieter ink, no
                lock icon, no upsell. The text itself says what is missing. */}
            <AnswerText
              text={turn.answer.text}
              tone={turn.answer.mode === 'refusal' ? 'var(--text-secondary)' : 'var(--text-primary)'}
            />
            {advice && (
              <p style={{ fontSize: 'var(--t-micro)', color: 'var(--text-tertiary)', margin: '4px 0 0' }}>
                {ADVICE_MARKER}
              </p>
            )}
            {sourcesLine(turn.answer.sources) && (
              <p style={{ fontSize: 'var(--t-micro)', color: 'var(--text-tertiary)', margin: '4px 0 0' }}>
                {sourcesLine(turn.answer.sources)}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
};

// Matches services/advisorFreeText.js FREE_TEXT_MAX_CHARS. The server rejects
// anything longer with a plain message; this stops the owner writing past it in
// the first place, which is the kinder half of the same rule.
const QUESTION_MAX_CHARS = 280;
// Where the character count starts showing itself.
const COUNTER_FROM = 220;

// The invitation. It names both halves of what the field takes, because an
// owner who reads "ask about your venue" will only ever ask for numbers, and
// half of what Roost is good at is the other kind of question.
const PLACEHOLDER_TEXT = 'Your numbers, or how to run the room';
const PLACEHOLDER_OFF = 'Typed questions are off right now';
// Said where the field is, not instead of it.
const FREE_TEXT_OFF_NOTE = 'Typed questions are off for now. The suggested questions above still work, and every answer they give comes from your own numbers.';

const VenueAdvisorChat = ({ fetchQuestions, ask, askQuestion, colors }) => {
  const navy = colors?.navy || 'var(--text-primary)';
  // 'loading' | 'ready' | 'locked' | 'error'
  const [state, setState] = useState('loading');
  const [name, setName] = useState(ADVISOR_NAME);
  const [lead, setLead] = useState([]);
  const [groups, setGroups] = useState([]);
  const [freeText, setFreeText] = useState(false);
  const [showMore, setShowMore] = useState(false);
  const [draft, setDraft] = useState('');
  const [focused, setFocused] = useState(false);
  const [lockedReason, setLockedReason] = useState(null);
  const [thread, setThread] = useState([]);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  // Re-arm on mount, not just disarm on unmount. A ref initialised to true
  // is only true for the first mount: React 18 StrictMode mounts, unmounts and
  // remounts in dev, and a real remount happens any time the owner leaves the
  // Analytics tab and comes back. Without the re-arm the flag stays false, the
  // fetch resolves into a discarded update, and the card is a skeleton forever.
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const load = useCallback(async () => {
    if (typeof fetchQuestions !== 'function') return;
    setState('loading');
    try {
      const data = await fetchQuestions();
      if (!alive.current) return;
      setName(data?.name || ADVISOR_NAME);
      // `lead` is the four the server chose. An older server that only sends
      // `groups` still renders: the first four grouped questions become the
      // lead, so a deploy skew shows a shorter list, never an empty one.
      const grouped = Array.isArray(data?.groups) ? data.groups : [];
      const flat = grouped.flatMap((g) => (Array.isArray(g.questions) ? g.questions : []));
      setLead(Array.isArray(data?.lead) && data.lead.length ? data.lead : flat.slice(0, 4));
      setGroups(Array.isArray(data?.lead) ? grouped : []);
      setFreeText(!!data?.freeText && typeof askQuestion === 'function');
      setState('ready');
    } catch (err) {
      if (!alive.current) return;
      if (err?.status === 403) {
        setLockedReason(err?.data?.error || 'This is part of the Pro plan.');
        setState('locked');
      } else {
        setState('error');
      }
    }
  }, [fetchQuestions, askQuestion]);

  useEffect(() => { load(); }, [load]);

  // One turn, whichever door it came in by. `run` is the call that produces the
  // answer; the thread does not care which endpoint answered, only that the
  // answer arrived carrying its own mode.
  const runTurn = useCallback(async (key, question, run, typed = false) => {
    setBusy(true);
    setThread((t) => [...t, { key, question, typed, status: 'pending', answer: null }]);
    try {
      const answer = await run();
      if (!alive.current) return;
      setThread((t) => t.map((turn) => (turn.key === key ? { ...turn, status: 'done', answer } : turn)));
    } catch (err) {
      if (!alive.current) return;
      setThread((t) => t.map((turn) => (turn.key === key ? { ...turn, status: 'error' } : turn)));
    } finally {
      if (alive.current) setBusy(false);
    }
  }, []);

  const askIntent = useCallback((id, label) => {
    if (busy || typeof ask !== 'function') return;
    runTurn(`${id}-${Date.now()}`, label, () => ask(id));
  }, [ask, busy, runTurn]);

  const submitQuestion = useCallback((e) => {
    if (e && typeof e.preventDefault === 'function') e.preventDefault();
    const text = draft.trim();
    if (busy || !text || typeof askQuestion !== 'function') return;
    setDraft('');
    runTurn(`typed-${Date.now()}`, text, () => askQuestion(text), true);
  }, [askQuestion, busy, draft, runTurn]);

  // One value for the send control's look and its behaviour.
  const canAsk = !busy && freeText && draft.trim().length > 0;

  const retry = useCallback((turn) => {
    setThread((t) => t.filter((x) => x.key !== turn.key));
    if (turn.key.startsWith('typed-')) {
      if (typeof askQuestion === 'function') runTurn(`typed-${Date.now()}`, turn.question, () => askQuestion(turn.question), true);
      return;
    }
    askIntent(turn.key.slice(0, turn.key.lastIndexOf('-')), turn.question);
  }, [askIntent, askQuestion, runTurn]);

  if (state === 'locked') {
    return (
      <div style={CARD_STYLE}>
        <p style={{ fontSize: 'var(--t-meta)', fontWeight: '600', color: navy, margin: 0 }}>{ADVISOR_NAME}</p>
        <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: '6px 0 0', lineHeight: 1.5 }}>{lockedReason}</p>
      </div>
    );
  }

  if (state === 'error') {
    return (
      <div style={CARD_STYLE}>
        <p style={{ fontSize: 'var(--t-meta)', fontWeight: '600', color: navy, margin: 0 }}>{ADVISOR_NAME}</p>
        <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: '6px 0 0' }}>
          Could not load right now.{' '}
          <button
            type="button"
            onClick={load}
            style={{ background: 'none', border: 'none', padding: 0, font: 'inherit', color: navy, textDecoration: 'underline', cursor: 'pointer' }}
          >
            Try again
          </button>
        </p>
      </div>
    );
  }

  if (state === 'loading') {
    return (
      <div style={CARD_STYLE} aria-busy="true">
        <div style={{ height: 14, width: 90, borderRadius: 4, backgroundColor: 'var(--border-light)' }} />
        <div style={{ height: 12, width: '70%', borderRadius: 4, backgroundColor: 'var(--border-light)', marginTop: 10 }} />
      </div>
    );
  }

  return (
    <div style={CARD_STYLE}>
      <p style={{ fontSize: 'var(--t-meta)', fontWeight: '600', color: navy, margin: 0 }}>{BLOCK_TITLE}</p>
      <p style={{ fontSize: 'var(--t-micro)', color: 'var(--text-tertiary)', margin: '3px 0 0', lineHeight: 1.5 }}>
        {freeText
          ? 'Answers from your own numbers name their sources and dates. Anything from the trade is marked as advice. What we cannot answer, we say so.'
          : 'Pick a question. Every answer comes from measured data about your venue, with its sources named. What we cannot answer yet, we say so.'}
      </p>

      {thread.length > 0 && (
        <div style={{ margin: '10px 0 2px' }}>
          {thread.map((turn, i) => (
            <ThreadTurn key={turn.key} turn={turn} first={i === 0} navy={navy} onRetry={() => retry(turn)} />
          ))}
        </div>
      )}

      {/* The four the server picked for this venue. Every one of them has data
          behind it: a question that could only decline is not offered. */}
      <div style={{ marginTop: '10px' }}>
        {lead.map((q) => (
          <button
            key={q.id}
            type="button"
            onClick={() => askIntent(q.id, q.label)}
            disabled={busy}
            style={{ ...CHIP_STYLE, opacity: busy ? 0.5 : 1, cursor: busy ? 'default' : 'pointer' }}
          >
            {q.label}
          </button>
        ))}
      </div>

      {groups.length > 0 && (
        <div style={{ marginTop: '8px' }}>
          <button
            type="button"
            onClick={() => setShowMore((v) => !v)}
            aria-expanded={showMore}
            style={{ background: 'none', border: 'none', padding: 0, font: 'inherit', fontSize: 'var(--t-micro)', color: 'var(--text-tertiary)', textDecoration: 'underline', cursor: 'pointer' }}
          >
            {showMore ? 'Fewer questions' : 'More questions'}
          </button>
          {showMore && groups.map((g) => (
            <div key={g.id} style={{ marginTop: '8px' }}>
              <p style={{ fontSize: 'var(--t-micro)', color: 'var(--text-tertiary)', margin: '0 0 5px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{g.label}</p>
              <div>
                {g.questions.map((q) => (
                  <button
                    key={q.id}
                    type="button"
                    onClick={() => askIntent(q.id, q.label)}
                    disabled={busy}
                    style={{ ...CHIP_STYLE, opacity: busy ? 0.5 : 1, cursor: busy ? 'default' : 'pointer' }}
                  >
                    {q.label}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* THE FIELD. Last thing in the card, so it is the last thing the eye
          lands on and the thing a thumb reaches first, which is where Birdie
          puts its box for the same reason. It is drawn in every state: when
          the server declines free text the box stays and goes quiet, with the
          server's reason under it, because an owner who can see a disabled
          field knows the feature exists and knows why it is not answering,
          and an owner shown nothing at all knows neither. */}
      <form onSubmit={submitQuestion} style={{ marginTop: '12px' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            padding: '4px 4px 4px 12px',
            borderRadius: '20px',
            backgroundColor: 'var(--bg-hover)',
            border: '1.5px solid',
            borderColor: focused ? 'rgba(30,58,92,0.30)' : 'var(--border-subtle)',
            boxShadow: focused ? '0 0 0 1px rgba(45,90,135,0.15)' : 'none',
            transition: 'border-color 0.2s ease, box-shadow 0.2s ease',
            opacity: freeText ? 1 : 0.6,
          }}
        >
          <input
            type="text"
            value={draft}
            maxLength={QUESTION_MAX_CHARS}
            onChange={(e) => setDraft(e.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            disabled={busy || !freeText}
            placeholder={freeText ? PLACEHOLDER_TEXT : PLACEHOLDER_OFF}
            aria-label={`Ask ${name} a question`}
            autoComplete="off"
            style={{
              flex: 1,
              minWidth: 0,
              padding: '9px 0',
              fontSize: 'var(--t-meta)',
              lineHeight: 1.4,
              color: 'var(--text-primary)',
              backgroundColor: 'transparent',
              border: 'none',
              outline: 'none',
            }}
          />
          {/* One value drives the look AND the behaviour, the fix App.js's own
              Birdie button records having needed: a control drawn at half
              opacity that still accepts a press is a control that lies. */}
          {/* hit44: drawn at thirty two so it sits inside the pill without
              growing it, with a transparent forty four point target laid over
              it (index.css). The pill does not clip its overflow, which is the
              one condition that class has. */}
          <button
            className="hit44"
            type="submit"
            disabled={!canAsk}
            aria-label={`Send your question to ${name}`}
            style={{
              width: '32px',
              height: '32px',
              minWidth: '32px',
              borderRadius: '16px',
              border: 'none',
              backgroundColor: canAsk ? navy : 'transparent',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: canAsk ? 'pointer' : 'default',
              transition: 'background-color 0.2s ease',
            }}
          >
            <svg aria-hidden="true" focusable="false" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={canAsk ? 'white' : 'var(--text-tertiary)'} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="19" x2="12" y2="5" /><polyline points="5 12 12 5 19 12" />
            </svg>
          </button>
        </div>

        {/* The count appears only once it matters. A counter sitting under an
            empty box is noise; a counter that appears as the room runs out is
            the warning the server would otherwise deliver as a rejection. */}
        {freeText && draft.length > COUNTER_FROM && (
          <p style={{ fontSize: 'var(--t-micro)', color: 'var(--text-tertiary)', margin: '4px 0 0', textAlign: 'right' }}>
            {QUESTION_MAX_CHARS - draft.length} characters left
          </p>
        )}
        {!freeText && (
          <p style={{ fontSize: 'var(--t-micro)', color: 'var(--text-tertiary)', margin: '5px 0 0', lineHeight: 1.5 }}>
            {FREE_TEXT_OFF_NOTE}
          </p>
        )}
      </form>
    </div>
  );
};

export default VenueAdvisorChat;
