import React, { useCallback, useEffect, useRef, useState } from 'react';

// The advisor's T0 surface: four deterministic insight cards rendered below
// the This-week panel on the venue dashboard (ADVISOR-PRODUCT-SHAPE.md sec 5).
// No LLM anywhere near this file. The server computes every card; this file
// only lays them out.
//
// Data contract (GET /api/venue/advisor/cards, routes/advisor.js):
//   { cards: [{ id, title, facts: [{ text, value, source, asOf }], status,
//               reason?, whatWouldUnlock? }] }
//   status is 'ok' or 'refused'.
//
// Two rules carried over from the This-week panel in the same commit family:
//
// 1. Every number on screen arrives inside a fact object with a source and a
//    date. This component never computes, derives, or invents a figure; it
//    prints fact.value and fact.text as sent, and each row says where its
//    number came from. The fabricated stats box deleted from this dashboard
//    on 2026-08-14 is why this is structural, not stylistic.
//
// 2. A refusal is the MAIN state, not an error. Most venues are not in the
//    measured corpus (migration 030 records 'absent' as the modal case), so
//    a refused card renders with the same chrome as a served one: any facts
//    that DO exist, then the reason in plain words, then what would change
//    it. No lock icon, no upsell button, no apology. An upgrade CTA inside a
//    refusal is the dark pattern ADVISOR-PRODUCT-SHAPE.md names, because the
//    missing data is missing at every price.
//
// Props:
//   fetchCards  required. () => Promise resolving the payload above. App.js
//               passes getVenueAdvisorCards from services/api. Injected
//               rather than imported so this file has no dependency on the
//               contended api.js and the test can hand it fixtures.
//   colors      optional. App.js's palette object; only .navy is read. Falls
//               back to the ink token so the component stands alone.

const CARD_STYLE = {
  backgroundColor: 'var(--bg-card-solid)',
  borderRadius: '12px',
  padding: '12px',
  marginBottom: '12px',
  boxShadow: 'var(--card-shadow-sm)',
};

// "As of" arrives either as an ISO timestamp (live reads) or as a plain
// phrase like "spring 2026" (the frozen corpus, which must be dated as such
// rather than passed off as current). Parseable dates render short; anything
// else renders verbatim.
const formatAsOf = (asOf) => {
  if (asOf == null || asOf === '') return null;
  // Only ISO-shaped strings are treated as dates. Date.parse is lenient
  // enough to read "spring 2026" as January 1st, which would print a
  // precision the corpus does not have. A phrase stays a phrase.
  if (!/^\d{4}-\d{2}-\d{2}/.test(String(asOf))) return String(asOf);
  const t = Date.parse(asOf);
  if (Number.isNaN(t)) return String(asOf);
  const d = new Date(t);
  const opts = { month: 'short', day: 'numeric' };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString(undefined, opts);
};

// The provenance line under every fact: "From {source}, as of {date}." Same
// shape as the This-week panel's "From {source}." rows, extended with the
// date because advisor facts can be a season old and must say so.
const provenance = (fact) => {
  const parts = [];
  if (fact.source) parts.push(`From ${fact.source}`);
  const when = formatAsOf(fact.asOf);
  if (when) parts.push(parts.length ? `as of ${when}` : `As of ${when}`);
  return parts.length ? `${parts.join(', ')}.` : null;
};

const FactRow = ({ fact, first, navy }) => {
  const sub = provenance(fact);
  return (
    <div style={{ padding: '8px 0', borderTop: first ? 'none' : '1px solid var(--border-light)' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px' }}>
        <p style={{ flex: 1, fontSize: 'var(--t-meta)', fontWeight: '600', color: navy, margin: 0, lineHeight: 1.45 }}>{fact.text}</p>
        {fact.value != null && fact.value !== '' && (
          <span style={{ fontSize: 'var(--t-meta)', fontWeight: '600', color: navy, flexShrink: 0 }}>{fact.value}</span>
        )}
      </div>
      {sub && <p style={{ fontSize: 'var(--t-micro)', color: 'var(--text-tertiary)', margin: '2px 0 0' }}>{sub}</p>}
    </div>
  );
};

const VenueInsightCards = ({ fetchCards, colors }) => {
  const navy = colors?.navy || 'var(--text-primary)';
  // 'loading' | 'ready' | 'locked' | 'error'
  const [state, setState] = useState('loading');
  const [cards, setCards] = useState([]);
  const [lockedReason, setLockedReason] = useState(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const load = useCallback(async () => {
    if (typeof fetchCards !== 'function') return;
    setState('loading');
    try {
      const data = await fetchCards();
      if (!alive.current) return;
      setCards(Array.isArray(data?.cards) ? data.cards : []);
      setState('ready');
    } catch (err) {
      if (!alive.current) return;
      if (err?.status === 403) {
        // The server said which plan serves these; repeat it rather than
        // guessing. Dormant while VENUE_BILLING_ENABLED is unset.
        setLockedReason(err?.data?.error || 'Insight cards are a Pro feature.');
        setState('locked');
      } else {
        setState('error');
      }
    }
  }, [fetchCards]);

  useEffect(() => { load(); }, [load]);

  if (typeof fetchCards !== 'function') return null;

  if (state === 'loading') {
    // One skeleton card standing in for the stack (.skeleton is the global
    // shimmer App.js defines; SLOP-AUDIT rule 10, skeletons for page loads).
    return (
      <div style={CARD_STYLE} aria-hidden="true">
        <div className="skeleton" style={{ width: '45%', height: '14px', borderRadius: '4px', marginBottom: '10px' }} />
        <div className="skeleton" style={{ width: '85%', height: '11px', borderRadius: '4px', marginBottom: '8px' }} />
        <div className="skeleton" style={{ width: '60%', height: '11px', borderRadius: '4px' }} />
      </div>
    );
  }

  if (state === 'locked') {
    return (
      <div style={CARD_STYLE}>
        <h3 style={{ fontSize: 'var(--t-title)', fontWeight: '700', color: navy, margin: '0 0 4px' }}>Insights</h3>
        <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: 0 }}>{lockedReason}</p>
      </div>
    );
  }

  if (state === 'error') {
    return (
      <div style={CARD_STYLE}>
        <h3 style={{ fontSize: 'var(--t-title)', fontWeight: '700', color: navy, margin: '0 0 4px' }}>Insights</h3>
        <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: '0 0 10px' }}>These didn't load.</p>
        <button
          className="hit44"
          onClick={load}
          style={{ padding: '8px 14px', borderRadius: '8px', border: '1.5px solid var(--border-default)', backgroundColor: 'transparent', color: 'var(--text-secondary)', fontWeight: '600', fontSize: 'var(--t-meta)', cursor: 'pointer' }}
        >
          Try again
        </button>
      </div>
    );
  }

  if (!cards.length) return null;

  return (
    <>
      {cards.map((card) => {
        const facts = Array.isArray(card.facts) ? card.facts : [];
        const refused = card.status === 'refused';
        return (
          <div key={card.id} style={CARD_STYLE}>
            <h3 style={{ fontSize: 'var(--t-title)', fontWeight: '700', color: navy, margin: facts.length || refused ? '0 0 4px' : 0 }}>{card.title}</h3>
            {facts.map((fact, i) => (
              <FactRow key={`${card.id}-${i}`} fact={fact} first={i === 0} navy={navy} />
            ))}
            {refused && (
              <div style={{ padding: facts.length ? '8px 0 0' : '0', borderTop: facts.length ? '1px solid var(--border-light)' : 'none' }}>
                <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: 0, lineHeight: 1.5 }}>{card.reason}</p>
                {card.whatWouldUnlock && (
                  <p style={{ fontSize: 'var(--t-micro)', color: 'var(--text-tertiary)', margin: '4px 0 0', lineHeight: 1.5 }}>{card.whatWouldUnlock}</p>
                )}
              </div>
            )}
          </div>
        );
      })}
    </>
  );
};

export default VenueInsightCards;
