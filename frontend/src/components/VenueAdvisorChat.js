import React, { useCallback, useEffect, useRef, useState } from 'react';

// Roost, the chat half of the venue advisor: a chip-based Q&A thread on the
// venue dashboard, below the insight cards. There is no free-text field in
// this build, by contract, not by omission: the server accepts exactly the
// suggested questions it serves (GET /api/venue/advisor/questions), and
// POST /api/venue/advisor/ask answers 400 for anything else. Whatever the
// owner asks, the answer is built from typed facts with sources and dates;
// when the data cannot answer, the refusal says what is missing and what
// would fill it in, rendered with the same chrome as an answer. A refusal is
// the MAIN state for most venues today, not an error.
//
// The product name arrives from the server (`name` on /questions) so a rename
// is one backend line; ADVISOR_NAME below is only the offline fallback and
// must match services/advisorPhrasing.js.
//
// WIRING (App.js, venue dashboard). Render below <VenueInsightCards ...>:
//
//   import VenueAdvisorChat from './components/VenueAdvisorChat';
//   import { getAdvisorQuestions, askAdvisor } from './services/api';
//   ...
//   <VenueAdvisorChat
//     fetchQuestions={getAdvisorQuestions}
//     ask={askAdvisor}
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

const VenueAdvisorChat = ({ fetchQuestions, ask, colors }) => {
  const navy = colors?.navy || 'var(--text-primary)';
  // 'loading' | 'ready' | 'locked' | 'error'
  const [state, setState] = useState('loading');
  const [name, setName] = useState(ADVISOR_NAME);
  const [groups, setGroups] = useState([]);
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
      setGroups(Array.isArray(data?.groups) ? data.groups : []);
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
  }, [fetchQuestions]);

  useEffect(() => { load(); }, [load]);

  const askIntent = useCallback(async (id, label) => {
    if (busy || typeof ask !== 'function') return;
    setBusy(true);
    const key = `${id}-${Date.now()}`;
    setThread((t) => [...t, { key, id, question: label, status: 'pending', answer: null }]);
    try {
      const answer = await ask(id);
      if (!alive.current) return;
      setThread((t) => t.map((turn) => (turn.key === key ? { ...turn, status: 'done', answer } : turn)));
    } catch (err) {
      if (!alive.current) return;
      setThread((t) => t.map((turn) => (turn.key === key ? { ...turn, status: 'error' } : turn)));
    } finally {
      if (alive.current) setBusy(false);
    }
  }, [ask, busy]);

  const retry = useCallback((turn) => {
    setThread((t) => t.filter((x) => x.key !== turn.key));
    askIntent(turn.id, turn.question);
  }, [askIntent]);

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
        Pick a question. Every answer comes from measured data about your venue, with its sources named. What we cannot answer yet, we say so.
      </p>

      {thread.length > 0 && (
        <div style={{ margin: '10px 0 2px' }}>
          {thread.map((turn, i) => (
            <ThreadTurn key={turn.key} turn={turn} first={i === 0} navy={navy} onRetry={() => retry(turn)} />
          ))}
        </div>
      )}

      <div style={{ marginTop: '10px' }}>
        {groups.map((g) => (
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
    </div>
  );
};

export default VenueAdvisorChat;
