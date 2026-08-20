import React, { useCallback, useEffect, useRef, useState } from 'react';

// Roost, the chat half of the venue advisor: a Q&A thread on the venue
// dashboard, below the insight cards.
//
// TWO WAYS IN, AND THE ANSWER ALWAYS SAYS WHICH KIND IT IS.
//
// Suggested questions (chips) are the starting points, four of them, chosen by
// the server from what this venue's data can actually answer. Below them is a
// text field: the owner can ask anything about their business, and the server
// routes it to exactly one of three answers.
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
// server (`name` and `freeText` on /questions), so a rename is one backend line
// and the input never renders when the server would decline it.
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

const ADVISOR_NAME = 'Roost';

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

// The one visible difference between the two kinds of answer. A grounded
// answer carries its source line and nothing else, because its sources ARE its
// claim to be believed. An advice answer carries this instead, quietly, so the
// owner is never left guessing whether a sentence came from their data.
const ADVICE_MARKER = 'General advice, not from your data.';

const ThreadTurn = ({ turn, first, navy, onRetry }) => (
  <div style={{ padding: '10px 0', borderTop: first ? 'none' : '1px solid var(--border-light)' }}>
    <p style={{ fontSize: 'var(--t-meta)', fontWeight: '600', color: navy, margin: 0, lineHeight: 1.4 }}>{turn.question}</p>
    <div style={{ margin: '6px 0 0' }}>
      {turn.status === 'pending' && (
        <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)', margin: 0 }}>Reading your numbers…</p>
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
          {turn.answer.mode === 'advice' && (
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

// Matches services/advisorFreeText.js FREE_TEXT_MAX_CHARS. The server rejects
// anything longer with a plain message; this stops the owner writing past it in
// the first place, which is the kinder half of the same rule.
const QUESTION_MAX_CHARS = 280;

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
  const [lockedReason, setLockedReason] = useState(null);
  const [thread, setThread] = useState([]);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

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
  const runTurn = useCallback(async (key, question, run) => {
    setBusy(true);
    setThread((t) => [...t, { key, question, status: 'pending', answer: null }]);
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
    runTurn(`typed-${Date.now()}`, text, () => askQuestion(text));
  }, [askQuestion, busy, draft, runTurn]);

  const retry = useCallback((turn) => {
    setThread((t) => t.filter((x) => x.key !== turn.key));
    if (turn.key.startsWith('typed-')) {
      if (typeof askQuestion === 'function') runTurn(`typed-${Date.now()}`, turn.question, () => askQuestion(turn.question));
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
      <p style={{ fontSize: 'var(--t-meta)', fontWeight: '600', color: navy, margin: 0 }}>{name}</p>
      <p style={{ fontSize: 'var(--t-micro)', color: 'var(--text-tertiary)', margin: '3px 0 0', lineHeight: 1.5 }}>
        {freeText
          ? 'Ask about your own numbers or about running the room. Answers from your data name their sources and dates. What we cannot answer, we say so.'
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

      {freeText && (
        <form onSubmit={submitQuestion} style={{ display: 'flex', gap: '6px', marginTop: '8px' }}>
          <input
            type="text"
            value={draft}
            maxLength={QUESTION_MAX_CHARS}
            onChange={(e) => setDraft(e.target.value)}
            disabled={busy}
            placeholder="Ask your own question"
            aria-label={`Ask ${name} a question`}
            style={{
              flex: 1,
              minWidth: 0,
              padding: '8px 10px',
              fontSize: 'var(--t-meta)',
              color: 'var(--text-primary)',
              backgroundColor: 'transparent',
              border: '1px solid var(--border-light)',
              borderRadius: '8px',
            }}
          />
          <button
            type="submit"
            disabled={busy || !draft.trim()}
            style={{
              ...CHIP_STYLE,
              margin: 0,
              opacity: busy || !draft.trim() ? 0.5 : 1,
              cursor: busy || !draft.trim() ? 'default' : 'pointer',
            }}
          >
            Ask
          </button>
        </form>
      )}

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
    </div>
  );
};

export default VenueAdvisorChat;
