import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

// Roost, the advisor's T0 surface (ADVISOR-PRODUCT-SHAPE.md sec 5), grown into
// a screen a venue owner can poke at: a daypart-aware lead card, a tappable
// week scrubber, and the four deterministic cards. No LLM anywhere near this
// file. The server computes every fact; this file lays them out and never
// invents a number to fill a gap.
//
// Data contract (GET /api/venue/advisor/cards, routes/advisor.js +
// services/advisorFacts.js, verified against those files 2026-08-19):
//   { available, reason?, cards: [{ id, title, status, facts }] }
//   status: 'ok' | 'refused' | 'locked' (locked adds requiredTier).
//   facts mix two entry types:
//     fact     { id, value, source, asOf, label?, note?, predictionMethod? }
//     refusal  { id, status: 'refused', reason, whatWouldUnlock }
//   Week-ahead entries are per day: peak_YYYY-MM-DD facts whose value is
//   { date, weekday, peakHour, peakScore }, or refuse_peak_YYYY-MM-DD when
//   that day cannot honestly be forecast. Around-you entries are
//   event_YYYY-MM-DD and weather_YYYY-MM-DD, joinable to the scrubber by date.
//
// Rules this file holds, both structural:
//
// 1. NOTHING INVENTED. Every sentence with a number in it is a server-built
//    fact label, printed verbatim, with its source and date in quiet text
//    underneath. The component adds chrome and joins facts by date; it never
//    computes a figure. The fabricated stats box deleted from this dashboard
//    on 2026-08-14 is why.
//
// 2. REFUSAL IS THE MAIN STATE. Most venues are outside the measured corpus,
//    so refusals render with full card chrome: what exists, what is missing,
//    what fills it in. No lock icon, no upsell, no apology. An upgrade CTA
//    inside a refusal is the dark pattern the product doc names, because the
//    missing data is missing at every price.
//
// Roost serves every venue type, so nothing here assumes nightlife: the lead
// card is titled by the venue's current daypart, a closed venue leads with its
// next opening, and the hourly strip narrows to the venue's own listed hours.
// Operating hours are the owner's free-text rows ({ days, open, close },
// venueProfile.operating_hours); rows that do not parse are skipped, and with
// no parseable rows the screen falls back to the wall clock for the title and
// makes no open or closed claims at all.
//
// Props:
//   fetchCards      required. () => Promise of the payload above. App.js
//                   passes getVenueAdvisorCards from services/api. Injected
//                   rather than imported so this file does not depend on the
//                   contended api.js and tests can hand it fixtures.
//   colors          optional. App.js's palette; only .navy is read.
//   intel           optional. App.js's venueIntel (/intelligence response).
//                   Used only for the today row of the scrubber: todayHourly
//                   bars and the model-version line. Already fetched by the
//                   dashboard, so the scrubber costs zero extra requests.
//   liveReading     optional. venueBusyNow.live ({ percent, expiresAt }).
//                   When the owner sets the slider, App.js re-renders with
//                   the new value and the readings card reflects it
//                   instantly, labeled as the owner's own number.
//   operatingHours  optional. venueProfile.operating_hours rows.
//   now             optional Date, for tests. Defaults to the wall clock.

// The advisor surface's name, decided 2026-08-19. Title only; body copy stays
// unbranded. Every user-facing use goes through this constant.
const FEATURE_NAME = 'Roost';

const CARD_STYLE = {
  backgroundColor: 'var(--bg-card-solid)',
  borderRadius: '12px',
  padding: '12px',
  marginBottom: '12px',
  boxShadow: 'var(--card-shadow-sm)',
};

// The source vocabulary (advisorFacts.js FACT_SOURCES), translated for an
// owner. An unknown token renders as itself: raw provenance beats hidden
// provenance.
const SOURCE_LABELS = {
  model_holdout: 'our estimate',
  model_unverified_axis: 'our estimate, thin data',
  user_reports: 'people who were there',
  category_pattern: 'category pattern',
  intake: 'you told us',
  owner_report: 'your reading',
  votes: 'group votes',
  events: 'Ticketmaster',
  weather: 'weather outlook',
  served_prediction: 'what we showed users',
  google_baseline: "Google's pattern",
  arithmetic: 'arithmetic on your numbers',
};

// Once per device: the one-liner that explains why some cards decline.
const NOTE_SEEN_KEY = 'flock_advisor_refusal_note_seen';

const isRefusal = (entry) => !!entry && entry.status === 'refused';

// Strict ISO only. Date.parse is lenient enough to read "spring 2026" as
// January 1st, and the corpus asOf string ("2026-05-18 (corpus frozen,
// collected spring 2026)") must keep its parenthetical, so anything that is
// not purely a date or timestamp renders verbatim.
const ISO_RE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const formatAsOf = (asOf) => {
  if (asOf == null || asOf === '') return null;
  const s = String(asOf);
  if (!ISO_RE.test(s)) return s;
  const t = Date.parse(s.length === 10 ? `${s}T12:00:00Z` : s);
  if (Number.isNaN(t)) return s;
  const d = new Date(t);
  const opts = { month: 'short', day: 'numeric' };
  if (s.length === 10) opts.timeZone = 'UTC';
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString(undefined, opts);
};

// The quiet provenance line every number carries: "our estimate, as of Aug 19."
const provenance = (fact) => {
  const src = fact.source ? (SOURCE_LABELS[fact.source] || fact.source) : null;
  const when = formatAsOf(fact.asOf);
  // Parseable dates read "as of Aug 19"; phrases ("owner-set 2026-08-18",
  // the frozen-corpus line) already carry their own words and join plainly.
  const isDate = when != null && ISO_RE.test(String(fact.asOf));
  const whenPart = when == null ? null : (isDate ? `as of ${when}` : when);
  if (src && whenPart) return `${src}, ${whenPart}.`;
  if (src) return `${src}.`;
  if (whenPart) return `${whenPart}.`;
  return null;
};

const localDateStr = (d) => {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEKDAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const dowOf = (dateStr) => new Date(`${dateStr}T12:00:00Z`).getUTCDay();
const dayChipLabel = (dateStr) => {
  const d = new Date(`${dateStr}T12:00:00Z`);
  return { weekday: WEEKDAY_SHORT[d.getUTCDay()], dayNum: String(d.getUTCDate()) };
};

// ── Operating hours, owner-entered ───────────────────────────────────────────
// venue_profiles.operating_hours rows are free text: { days: "Mon-Fri",
// open: "9am", close: "11 PM" } and every variation an owner types. Parsing
// is deliberately conservative: a row that does not parse contributes
// nothing, and no parsed rows at all means the screen makes no open or closed
// claims. A wrong claim about their own hours reads worse than no claim.

const DAY_TOKENS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const dayIndex = (tok) => DAY_TOKENS.findIndex((d) => tok.toLowerCase().startsWith(d));

const parseDays = (text) => {
  if (typeof text !== 'string' || !text.trim()) return null;
  // Owners paste dashes of every width; normalize en and em dashes (by code
  // point, so no literal dash character lives in this file) before matching.
  const s = text.toLowerCase().replace(/[\u2013\u2014]/g, '-');
  if (/(daily|every ?day|all week|7 days)/.test(s)) return new Set([0, 1, 2, 3, 4, 5, 6]);
  const out = new Set();
  if (/weekend/.test(s)) { out.add(0); out.add(6); }
  if (/weekday/.test(s)) [1, 2, 3, 4, 5].forEach((d) => out.add(d));
  const range = s.match(/\b(sun|mon|tue|wed|thu|fri|sat)[a-z]*\s*(?:-|to|through|thru)\s*(sun|mon|tue|wed|thu|fri|sat)[a-z]*/);
  if (range) {
    let a = dayIndex(range[1]);
    const b = dayIndex(range[2]);
    out.add(a);
    let guard = 0;
    while (a !== b && guard < 7) { a = (a + 1) % 7; out.add(a); guard += 1; }
  } else {
    for (const tok of s.match(/\b(sun|mon|tue|wed|thu|fri|sat)[a-z]*/g) || []) out.add(dayIndex(tok));
  }
  out.delete(-1);
  return out.size ? out : null;
};

const parseClockHour = (text) => {
  if (typeof text !== 'string') return null;
  const m = text.trim().toLowerCase().match(/^(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?$/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  if (h > 24 || min > 59) return null;
  if (m[3] && m[3].startsWith('p') && h < 12) h += 12;
  if (m[3] && m[3].startsWith('a') && h === 12) h = 0;
  return h + min / 60;
};

const parseOperatingWindows = (rows) => {
  if (!Array.isArray(rows)) return [];
  const windows = [];
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    const days = parseDays(r.days);
    const open = parseClockHour(r.open);
    const close = parseClockHour(r.close);
    if (!days || open == null || close == null || open === close) continue;
    // close < open is an overnight window (a bar's 8pm to 2am), handled below.
    windows.push({ days, open, close });
  }
  return windows;
};

const isOpenAt = (windows, d) => {
  const day = d.getDay();
  const h = d.getHours() + d.getMinutes() / 60;
  return windows.some((w) => {
    if (w.close > w.open) return w.days.has(day) && h >= w.open && h < w.close;
    // Overnight: today's late half, or yesterday's spill past midnight.
    return (w.days.has(day) && h >= w.open) || (w.days.has((day + 6) % 7) && h < w.close);
  });
};

const nextOpening = (windows, from) => {
  const nowH = from.getHours() + from.getMinutes() / 60;
  for (let d = 0; d <= 7; d++) {
    const day = new Date(from);
    day.setDate(day.getDate() + d);
    const dow = day.getDay();
    const opens = windows.filter((w) => w.days.has(dow)).map((w) => w.open).sort((a, b) => a - b);
    for (const open of opens) {
      if (d === 0 && open <= nowH) continue;
      return { date: localDateStr(day), dow };
    }
  }
  return null;
};

// The lead card's title, from the clock. A breakfast cafe gets its morning, a
// lunch spot gets its day, and nothing here assumes the night.
const daypartTitle = (h) => (h >= 5 && h < 11 ? 'This morning' : h >= 11 && h < 17 ? 'Today' : 'Tonight');

// todayHourly entries label their hour as "6 AM" / "11 PM" strings.
const hourFromLabel = (label) => {
  const m = String(label).trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i);
  if (!m) return null;
  let h = Number(m[1]);
  if (/pm/i.test(m[3]) && h < 12) h += 12;
  if (/am/i.test(m[3]) && h === 12) h = 0;
  return h;
};

// One fact or refusal, as a row. Facts print their server-built label with
// the provenance chip under it; refusals print the reason and the path, no
// chip because a refusal quotes nothing.
const EntryRow = ({ entry, first, navy }) => {
  const border = { padding: '8px 0', borderTop: first ? 'none' : '1px solid var(--border-light)' };
  if (isRefusal(entry)) {
    return (
      <div style={border}>
        <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: 0, lineHeight: 1.5 }}>{entry.reason}</p>
        {entry.whatWouldUnlock && (
          <p style={{ fontSize: 'var(--t-micro)', color: 'var(--text-tertiary)', margin: '4px 0 0', lineHeight: 1.5 }}>{entry.whatWouldUnlock}</p>
        )}
      </div>
    );
  }
  // A fact without a label and without a primitive value has nothing honest
  // to print, so it prints nothing (defensive; the server always labels).
  const main = entry.label || ((typeof entry.value === 'string' || typeof entry.value === 'number') ? String(entry.value) : null);
  if (!main) return null;
  const chip = provenance(entry);
  return (
    <div style={border}>
      <p style={{ fontSize: 'var(--t-meta)', fontWeight: '600', color: navy, margin: 0, lineHeight: 1.45 }}>{main}</p>
      {entry.note && <p style={{ fontSize: 'var(--t-micro)', color: 'var(--text-tertiary)', margin: '3px 0 0', lineHeight: 1.5 }}>{entry.note}</p>}
      {chip && <p style={{ fontSize: 'var(--t-micro)', color: 'var(--text-tertiary)', margin: '2px 0 0' }}>{chip}</p>}
    </div>
  );
};

// Pull the per-day structure out of the week-ahead card. Facts carry their
// date in value.date; per-day refusals carry it in the id suffix.
const parseWeekDays = (entries) => {
  const days = [];
  for (const e of entries) {
    if (isRefusal(e)) {
      if (typeof e.id === 'string' && e.id.startsWith('refuse_peak_')) {
        days.push({ date: e.id.slice('refuse_peak_'.length), entry: e });
      }
    } else if (e.value && typeof e.value.date === 'string') {
      days.push({ date: e.value.date, entry: e });
    }
  }
  days.sort((a, b) => (a.date < b.date ? -1 : 1));
  return days;
};

const VenueInsightCards = ({ fetchCards, colors, intel, liveReading, operatingHours, now }) => {
  const navy = colors?.navy || 'var(--text-primary)';
  // 'loading' | 'ready' | 'locked' | 'error'
  const [state, setState] = useState('loading');
  const [payload, setPayload] = useState(null);
  const [lockedReason, setLockedReason] = useState(null);
  const [selectedDate, setSelectedDate] = useState(null);
  const [noteDismissed, setNoteDismissed] = useState(() => {
    try { return window.localStorage.getItem(NOTE_SEEN_KEY) === '1'; } catch { return true; }
  });
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
    if (typeof fetchCards !== 'function') return;
    setState('loading');
    try {
      const data = await fetchCards();
      if (!alive.current) return;
      setPayload(data || null);
      setState('ready');
    } catch (err) {
      if (!alive.current) return;
      if (err?.status === 403) {
        // The server said which plan serves these; repeat it rather than
        // guessing. Dormant while VENUE_BILLING_ENABLED is unset.
        setLockedReason(err?.data?.error || `${FEATURE_NAME} is a Pro feature.`);
        setState('locked');
      } else {
        setState('error');
      }
    }
  }, [fetchCards]);

  useEffect(() => { load(); }, [load]);

  const clock = now instanceof Date ? now : new Date();
  const todayStr = localDateStr(clock);

  const cards = useMemo(
    () => (Array.isArray(payload?.cards) ? payload.cards : []),
    [payload]
  );
  const byId = useMemo(() => {
    const m = {};
    for (const c of cards) m[c.id] = c;
    return m;
  }, [cards]);

  const weekDays = useMemo(
    () => parseWeekDays(Array.isArray(byId.week_ahead?.facts) ? byId.week_ahead.facts : []),
    [byId]
  );
  const aroundByDate = useMemo(() => {
    const m = { events: {}, weather: {} };
    const entries = Array.isArray(byId.around_you?.facts) ? byId.around_you.facts : [];
    for (const e of entries) {
      if (isRefusal(e) || !e.value || typeof e.value.date !== 'string') continue;
      if (typeof e.id === 'string' && e.id.startsWith('event_')) m.events[e.value.date] = e;
      if (typeof e.id === 'string' && e.id.startsWith('weather_')) m.weather[e.value.date] = e;
    }
    return m;
  }, [byId]);

  const windows = useMemo(() => parseOperatingWindows(operatingHours), [operatingHours]);

  const activeDate = selectedDate || (weekDays.some((d) => d.date === todayStr) ? todayStr : weekDays[0]?.date) || null;

  const anyRefusal = useMemo(
    () => cards.some((c) => c.status === 'refused' || (Array.isArray(c.facts) && c.facts.some(isRefusal))),
    [cards]
  );

  const dismissNote = () => {
    setNoteDismissed(true);
    try { window.localStorage.setItem(NOTE_SEEN_KEY, '1'); } catch { /* storage blocked */ }
  };

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
        <h3 style={{ fontSize: 'var(--t-title)', fontWeight: '700', color: navy, margin: '0 0 4px' }}>{FEATURE_NAME}</h3>
        <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: 0 }}>{lockedReason}</p>
      </div>
    );
  }

  if (state === 'error') {
    return (
      <div style={CARD_STYLE}>
        <h3 style={{ fontSize: 'var(--t-title)', fontWeight: '700', color: navy, margin: '0 0 4px' }}>{FEATURE_NAME}</h3>
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

  // The route's own unavailable states (no linked listing, unverified) are a
  // designed answer, not an error: say the reason in the server's words.
  if (payload && payload.available === false) {
    return (
      <div style={CARD_STYLE}>
        <h3 style={{ fontSize: 'var(--t-title)', fontWeight: '700', color: navy, margin: '0 0 4px' }}>{FEATURE_NAME}</h3>
        <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: 0, lineHeight: 1.5 }}>{payload.reason || 'Nothing to show yet.'}</p>
      </div>
    );
  }

  if (!cards.length) return null;

  // ── The lead card: the venue's active daypart, or its next opening ────────
  // Open now (or hours unknown): today's facts under a daypart title. Closed
  // by the owner's own listed hours: the next opening's facts instead, so a
  // Sunday-closed cafe leads with Monday rather than a dead today.
  const openNow = windows.length ? isOpenAt(windows, clock) : null;
  const upNext = openNow === false ? nextOpening(windows, clock) : null;
  const heroDate = upNext ? upNext.date : todayStr;
  const heroTitle = upNext ? 'When you open next' : daypartTitle(clock.getHours());
  const heroSub = upNext
    ? `Closed right now, by your listed hours. Next up: ${WEEKDAY_LONG[upNext.dow]}.`
    : null;

  const heroDay = weekDays.find((d) => d.date === heroDate) || null;
  const heroEvent = aroundByDate.events[heroDate] || null;
  const heroWeather = aroundByDate.weather[heroDate] || null;
  const hasLive = !!liveReading && Number.isFinite(Number(liveReading.percent));
  const showHero = !!(heroDay || heroEvent || heroWeather || hasLive);

  const liveRowEl = (first) => (
    <div style={{ padding: '8px 0', borderTop: first ? 'none' : '1px solid var(--border-light)' }}>
      <p style={{ fontSize: 'var(--t-meta)', fontWeight: '600', color: navy, margin: 0, lineHeight: 1.45 }}>
        Users currently see {Number(liveReading?.percent)}% full, set by you.
      </p>
      <p style={{ fontSize: 'var(--t-micro)', color: 'var(--text-tertiary)', margin: '2px 0 0' }}>your reading, live now.</p>
    </div>
  );

  // ── The selected scrubber day ─────────────────────────────────────────────
  const activeDay = weekDays.find((d) => d.date === activeDate) || null;
  const activeEvent = activeDate ? aroundByDate.events[activeDate] : null;
  const activeWeather = activeDate ? aroundByDate.weather[activeDate] : null;
  const activeDayClosed = windows.length > 0 && activeDate
    ? !windows.some((w) => w.days.has(dowOf(activeDate)))
    : false;

  // Today's hourly bars, narrowed to the venue's own listed hours (with an
  // hour of shoulder either side) when those hours parse. A strip cut below
  // four bars stops being a shape, so it falls back to the full day.
  let hourly = activeDate === todayStr && Array.isArray(intel?.todayHourly) && intel.todayHourly.length > 0
    ? intel.todayHourly
    : null;
  let hourlyWindowed = false;
  if (hourly && windows.length) {
    const todayWins = windows.filter((w) => w.days.has(clock.getDay()));
    if (todayWins.length) {
      const inWindow = (h) => todayWins.some((w) => (
        w.close > w.open
          ? h >= Math.floor(w.open) - 1 && h < Math.ceil(w.close) + 1
          : h >= Math.floor(w.open) - 1 || h < Math.ceil(w.close) + 1
      ));
      const cut = hourly.filter((e) => {
        const h = hourFromLabel(e.hour);
        return h == null ? true : inWindow(h);
      });
      if (cut.length >= 4 && cut.length < hourly.length) { hourly = cut; hourlyWindowed = true; }
    }
  }

  const renderCardShell = (card, children) => (
    <div key={card.id} style={CARD_STYLE}>
      <h3 style={{ fontSize: 'var(--t-title)', fontWeight: '700', color: navy, margin: '0 0 4px' }}>{card.title}</h3>
      {children}
    </div>
  );

  const renderPlainCard = (card, extraFirstRow) => {
    if (card.status === 'locked') {
      return renderCardShell(card, (
        <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: 0 }}>
          Part of the {card.requiredTier === 'premium' ? 'Premium' : 'Pro'} plan.
        </p>
      ));
    }
    const entries = Array.isArray(card.facts) ? card.facts : [];
    return renderCardShell(card, (
      <>
        {extraFirstRow}
        {entries.map((e, i) => (
          <EntryRow key={e.id || i} entry={e} first={i === 0 && !extraFirstRow} navy={navy} />
        ))}
      </>
    ));
  };

  return (
    <>
      {/* Section header: the surface's name and its one honest sentence. */}
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', margin: '4px 2px 8px' }}>
        <span style={{ fontSize: 'var(--t-title)', fontWeight: '700', color: navy }}>{FEATURE_NAME}</span>
        <span style={{ fontSize: 'var(--t-micro)', color: 'var(--text-tertiary)' }}>every line names its source</span>
      </div>

      {/* First run: one line on why some cards decline, shown once. */}
      {anyRefusal && !noteDismissed && (
        <div style={{ ...CARD_STYLE, display: 'flex', alignItems: 'center', gap: '10px' }}>
          <p style={{ flex: 1, fontSize: 'var(--t-micro)', color: 'var(--text-secondary)', margin: 0, lineHeight: 1.5 }}>
            Some cards here say what's missing instead of guessing. Each one names what would fill it in.
          </p>
          <button
            className="hit44"
            onClick={dismissNote}
            style={{ padding: '6px 10px', borderRadius: '8px', border: '1px solid var(--border-default)', backgroundColor: 'transparent', color: 'var(--text-secondary)', fontWeight: '600', fontSize: 'var(--t-micro)', cursor: 'pointer', flexShrink: 0 }}
          >
            Got it
          </button>
        </div>
      )}

      {/* THE LEAD: the venue's own daypart in progress, or its next opening.
          Every line is a fact another card already carries, joined by date,
          never restated. */}
      {showHero && (
        <div style={CARD_STYLE}>
          <h3 style={{ fontSize: 'var(--t-title)', fontWeight: '700', color: navy, margin: heroSub ? '0 0 2px' : '0 0 4px' }}>{heroTitle}</h3>
          {heroSub && <p style={{ fontSize: 'var(--t-micro)', color: 'var(--text-tertiary)', margin: '0 0 4px' }}>{heroSub}</p>}
          {hasLive && liveRowEl(true)}
          {heroDay && <EntryRow entry={heroDay.entry} first={!hasLive} navy={navy} />}
          {heroEvent && <EntryRow entry={heroEvent} first={!hasLive && !heroDay} navy={navy} />}
          {heroWeather && <EntryRow entry={heroWeather} first={!hasLive && !heroDay && !heroEvent} navy={navy} />}
        </div>
      )}

      {/* THE VERDICT, first of the server's cards. "How did we just do" is the
          question operators actually open a tool holding, and the forecast
          under it is the one they ask least. When there is no reading for
          yesterday this renders as its refusal, which is the honest screen and
          the plainest argument for the slider sitting above it. */}
      {byId.last_night_verdict && renderPlainCard(byId.last_night_verdict)}

      {/* WEEK AHEAD with the day scrubber. Days with a forecast show it; days
          the server refused show the refusal, selected like any other day,
          because the refusal is the honest content for that day. */}
      {byId.week_ahead && (byId.week_ahead.status === 'locked' || weekDays.length < 2
        ? renderPlainCard(byId.week_ahead)
        : renderCardShell(byId.week_ahead, (
          <>
            <div style={{ display: 'flex', gap: '4px', margin: '6px 0 4px' }} role="group" aria-label="Pick a day">
              {weekDays.map((d) => {
                const { weekday, dayNum } = dayChipLabel(d.date);
                const selected = d.date === activeDate;
                return (
                  <button
                    key={d.date}
                    className="hit44"
                    onClick={() => setSelectedDate(d.date)}
                    aria-pressed={selected}
                    style={{
                      flex: 1, padding: '6px 2px', border: 'none', cursor: 'pointer',
                      backgroundColor: 'transparent',
                      borderBottom: selected ? `2px solid ${navy}` : '2px solid transparent',
                      display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1px',
                    }}
                  >
                    <span style={{ fontSize: 'var(--t-micro)', fontWeight: selected ? '700' : '500', color: selected ? navy : 'var(--text-tertiary)' }}>{weekday}</span>
                    <span style={{ fontSize: 'var(--t-micro)', color: selected ? navy : 'var(--text-tertiary)' }}>{dayNum}</span>
                  </button>
                );
              })}
            </div>
            {activeDay && <EntryRow entry={activeDay.entry} first navy={navy} />}
            {activeDayClosed && (
              <p style={{ fontSize: 'var(--t-micro)', color: 'var(--text-tertiary)', margin: '2px 0 0' }}>Your listed hours say you're closed this day.</p>
            )}
            {hourly && (
              <div style={{ padding: '8px 0', borderTop: '1px solid var(--border-light)' }}>
                <div style={{ display: 'flex', gap: '3px', alignItems: 'flex-end', height: '40px' }}>
                  {hourly.map((h, i) => (
                    <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                      <div style={{ width: '100%', height: `${Math.max(2, (Number(h.score) || 0) * 0.4)}px`, backgroundColor: navy, opacity: 0.85, borderRadius: '2px' }} />
                      {i % 3 === 0 && <span style={{ fontSize: 'var(--t-micro)', color: 'var(--text-tertiary)', marginTop: '3px', whiteSpace: 'nowrap' }}>{h.hour}</span>}
                    </div>
                  ))}
                </div>
                <p style={{ fontSize: 'var(--t-micro)', color: 'var(--text-tertiary)', margin: '6px 0 0' }}>
                  {intel?.model ? `Today hour by hour, our estimate. Flock crowd model v${intel.model}.` : 'Today hour by hour. Flock rule engine while the model learns your venue.'}
                  {hourlyWindowed ? ' Shown across your listed hours.' : ''}
                </p>
              </div>
            )}
            {activeEvent && <EntryRow entry={activeEvent} navy={navy} />}
            {activeWeather && <EntryRow entry={activeWeather} navy={navy} />}
          </>
        )))}

      {/* AROUND YOU: the full 7 day list, the card that stays interesting at
          zero users. */}
      {byId.around_you && renderPlainCard(byId.around_you)}

      {/* YOUR LISTING, READ BACK: intake facts, arithmetic joins, and prompts
          for the blanks. */}
      {byId.listing_read_back && renderPlainCard(byId.listing_read_back)}

      {/* WHAT YOU SAID VS WHAT WE ESTIMATED: the slider habit card. A live
          reading shows up here the moment the owner sets one, so playing
          with the slider visibly does something. */}
      {byId.readings_vs_estimates && renderPlainCard(byId.readings_vs_estimates, hasLive ? liveRowEl(true) : null)}

      {/* Any card this file does not know by id still renders, generically:
          the server may grow a fifth card before this file learns its name. */}
      {cards.filter((c) => !['last_night_verdict', 'week_ahead', 'around_you', 'listing_read_back', 'readings_vs_estimates'].includes(c.id)).map((c) => renderPlainCard(c))}
    </>
  );
};

export default VenueInsightCards;
