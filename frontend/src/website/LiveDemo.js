import React, { useEffect, useRef, useState, useCallback } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { BASE_URL } from '../services/api';
// The rating used to be a bare "*" character. Emoji and stray Unicode glyphs
// standing in for icons are a named tell (SLOP-AUDIT.md H14); this is the
// product's own star, same path the app uses.
import Icons from '../components/ui/Icons';

// ---------------------------------------------------------------------------
// Live crowd demo for the marketing site. A real slice of the app's Discover
// screen: same basemap, same photo pins, the same canvas dial, scored by the
// same model through the public /api/public/demo endpoints. No account needed.
// ---------------------------------------------------------------------------

const MAPTILER_KEY = process.env.REACT_APP_MAPTILER_KEY;
const MAP_STYLE = MAPTILER_KEY
  ? `https://api.maptiler.com/maps/basic-v2/style.json?key=${MAPTILER_KEY}`
  : 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json';

// Philadelphia by default: dense venues, works before anyone shares location.
const DEFAULT_CENTER = { lat: 39.9526, lng: -75.1652 };
const REFRESH_MS = 60_000; // live loop: re-score the open card every minute

// The colour has to break where the WORD breaks. It used to cut at 70 while the
// backend's getLabel cuts at 60, so a venue at 65 printed "Busy" in amber and
// one at 75 printed "Busy" in red: the same word, two colours, on the same card
// component. Bands here mirror crowdEngine.getLevel exactly.
//   green 0-40 (Quiet, Not Busy) | amber 41-60 (Moderate) | red 61+ (Busy, Very Busy)
const CROWD_GREEN = '#22C55E';
const CROWD_AMBER = '#F59E0B';
const CROWD_RED = '#EF4444';
// Shut. Slate rather than a crowd colour, because a closed venue is not quiet,
// it is unavailable. Dark enough to pass contrast as text on the pale card.
const CROWD_CLOSED = '#64748B';

const crowdColor = (score) => (score > 60 ? CROWD_RED : score > 40 ? CROWD_AMBER : CROWD_GREEN);
const isShut = (v) => v && v.is_open === false;

// The visitor's clock: predictions are for THEIR hour, not the server's UTC.
const clockParams = () => {
  const d = new Date();
  return { localHour: String(d.getHours()), localDay: String(d.getDay()) };
};

const reducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// The app's AnimatedDial (App.js), verbatim technique at 104px: canvas ring
// with pre-rendered track, cubic ease fill, counting number, glow on a sibling.
function DemoDial({ score, color }) {
  const textRef = useRef(null);
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cssSize = 104;
    const size = Math.round(cssSize * dpr);
    const center = size / 2;
    const radius = Math.round(45 * dpr);
    const lineWidth = Math.round(10 * dpr);
    canvas.width = size;
    canvas.height = size;

    const ctx = canvas.getContext('2d');
    const trackColor = 'rgba(22, 40, 61, 0.12)';

    const trackCanvas = document.createElement('canvas');
    trackCanvas.width = size;
    trackCanvas.height = size;
    const tctx = trackCanvas.getContext('2d');
    tctx.beginPath();
    tctx.arc(center, center, radius, 0, Math.PI * 2);
    tctx.strokeStyle = trackColor;
    tctx.lineWidth = lineWidth;
    tctx.stroke();

    const draw = (val) => {
      ctx.clearRect(0, 0, size, size);
      ctx.drawImage(trackCanvas, 0, 0);
      if (val > 0) {
        ctx.beginPath();
        ctx.arc(center, center, radius, -Math.PI / 2, -Math.PI / 2 + (val / 100) * Math.PI * 2);
        ctx.strokeStyle = color;
        ctx.lineWidth = lineWidth;
        ctx.lineCap = 'round';
        ctx.stroke();
      }
    };

    if (reducedMotion()) {
      draw(score);
      if (textRef.current) textRef.current.textContent = `${score}%`;
      return;
    }

    let raf;
    const start = performance.now();
    const ease = (t) => 1 - Math.pow(1 - t, 3);
    const tick = (now) => {
      const t = Math.min((now - start) / 1200, 1);
      const val = ease(t) * score;
      draw(val);
      if (textRef.current) textRef.current.textContent = `${Math.round(val)}%`;
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    draw(0);
    if (textRef.current) textRef.current.textContent = '0%';
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [score, color]);

  return (
    <div className="lpd-dial">
      <div aria-hidden className="lpd-dial-glow" style={{ boxShadow: `0 4px 12px rgba(0,0,0,0.18), 0 0 8px ${color}30` }} />
      <canvas ref={canvasRef} style={{ width: '104px', height: '104px', position: 'absolute', top: 0, left: 0 }} />
      <div className="lpd-dial-core">
        <span ref={textRef} className="lpd-dial-num" style={{ color }}>0%</span>
      </div>
    </div>
  );
}

// App-style circular photo pin (App.js buildPhotoPin): photo clipped in a
// circle, ring colored by crowd level, % badge underneath.
function buildDemoPin(venue, onClick) {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'lpd-pin';
  el.setAttribute('aria-label', isShut(venue)
    ? `${venue.name}, closed right now`
    : `${venue.name}, ${venue.score} percent busy`);
  el.addEventListener('click', onClick);

  // A shut venue has no crowd. Painting it green at 12% reads as "quiet, go
  // now" for a place with the lights off.
  const shut = isShut(venue);
  const ring = shut ? CROWD_CLOSED : crowdColor(venue.score);
  const photo = document.createElement('div');
  photo.className = 'lpd-pin-photo';
  photo.style.boxShadow = `0 0 0 3px ${ring}, 0 4px 14px rgba(0,0,0,0.35)`;
  if (venue.photo_url) {
    photo.style.backgroundImage = `url("${BASE_URL}${venue.photo_url}")`;
  } else {
    photo.classList.add('lpd-pin-noimg');
    photo.textContent = (venue.name || '?')[0];
  }
  el.appendChild(photo);

  const badge = document.createElement('span');
  badge.className = 'lpd-pin-badge';
  badge.style.backgroundColor = ring;
  badge.textContent = shut ? 'Closed' : `${venue.score}%`;
  el.appendChild(badge);

  return el;
}

function agoLabel(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  return `${Math.floor(s / 60)}m ago`;
}

export default function LiveDemo() {
  const mapDivRef = useRef(null);
  const mapRef = useRef(null);
  const markersRef = useRef([]);
  const selectedIdRef = useRef(null);
  const [queryText, setQueryText] = useState('');
  const [venues, setVenues] = useState([]);
  const [selected, setSelected] = useState(null); // full card payload
  const [phase, setPhase] = useState('loading'); // loading | ready | card-loading | error
  const [errorMsg, setErrorMsg] = useState('');
  const [ageTick, setAgeTick] = useState(0); // re-render the "updated X ago" line
  const centerRef = useRef(DEFAULT_CENTER);
  const lastSearchRef = useRef(null); // what the pins on screen were scored for

  const applyCard = useCallback((card) => {
    selectedIdRef.current = card.place_id;
    setSelected({ ...card, fetched_at: Date.now() });
  }, []);

  const loadCard = useCallback(async (placeId, { quiet } = {}) => {
    if (!quiet) setPhase('card-loading');
    try {
      const res = await fetch(`${BASE_URL}/api/public/demo/venue/${encodeURIComponent(placeId)}?${new URLSearchParams(clockParams())}`);
      const data = await res.json();
      if (!res.ok) throw new Error(res.status === 429 || res.status === 503 ? data.error : 'The demo hit a snag. Try again in a minute.');
      applyCard(data);
      setPhase('ready');
    } catch (e) {
      if (!quiet) { setPhase('error'); setErrorMsg(e.message || 'Demo unavailable'); }
    }
  }, [applyCard]);

  // 2 decimals ≈ 1km: neighborhood is all a venue search needs.
  const venuesUrl = useCallback((center, q) => {
    const params = new URLSearchParams({ lat: center.lat.toFixed(2), lng: center.lng.toFixed(2), ...clockParams() });
    if (q) params.set('q', q);
    return `${BASE_URL}/api/public/demo/venues?${params}`;
  }, []);

  const loadVenues = useCallback(async (center, q) => {
    setPhase('loading');
    setErrorMsg('');
    lastSearchRef.current = { center, q, hour: new Date().getHours() };
    try {
      const res = await fetch(venuesUrl(center, q));
      const data = await res.json();
      if (!res.ok) throw new Error(res.status === 429 || res.status === 503 ? data.error : 'The demo hit a snag. Try again in a minute.');
      setVenues(data.venues || []);
      if (data.card) {
        applyCard(data.card); // one round trip: card ships with the venues
        setPhase('ready');
      } else if ((data.venues || []).length > 0) {
        const busiest = [...data.venues].sort((a, b) => b.score - a.score)[0];
        loadCard(busiest.place_id);
      } else {
        setSelected(null);
        setPhase('ready');
      }
    } catch (e) {
      setPhase('error');
      setErrorMsg(e.message || 'Demo unavailable');
    }
  }, [applyCard, loadCard, venuesUrl]);

  // The card re-scores itself every minute but the pins were scored once, at
  // load. Leave the page open past the top of the hour and the pins were still
  // showing last hour's numbers while the dial had moved on: the same venue,
  // two different percentages, in one screenshot. Pins are re-scored quietly
  // when the hour rolls; nothing else about the view changes.
  const refreshPins = useCallback(async () => {
    const last = lastSearchRef.current;
    if (!last) return;
    try {
      const res = await fetch(venuesUrl(last.center, last.q));
      if (!res.ok) return;
      const data = await res.json();
      if (Array.isArray(data.venues)) {
        setVenues(data.venues);
        lastSearchRef.current = { ...last, hour: new Date().getHours() };
      }
    } catch { /* the next tick tries again */ }
  }, [venuesUrl]);

  // Map init. The first data load waits until the section actually scrolls
  // into view, then asks for the visitor's location so the demo is THEIR
  // neighborhood; Philadelphia is only the denied/unavailable fallback.
  useEffect(() => {
    if (!mapDivRef.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: mapDivRef.current,
      style: MAP_STYLE,
      center: [DEFAULT_CENTER.lng, DEFAULT_CENTER.lat],
      zoom: 13.2,
      attributionControl: { compact: true },
      cooperativeGestures: true,
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    mapRef.current = map;

    // Location is only ever requested by the explicit "Use my location"
    // button — scrolling a section into view is not consent to hand a
    // marketing page your coordinates (round 6). The demo opens on a real
    // city so it's alive either way.
    let started = false;
    const start = () => {
      if (started) return;
      started = true;
      loadVenues(DEFAULT_CENTER, '');
    };

    const obs = new IntersectionObserver((entries) => {
      if (entries.some(e => e.isIntersecting)) { start(); obs.disconnect(); }
    }, { threshold: 0.15 });
    obs.observe(mapDivRef.current);

    return () => { obs.disconnect(); map.remove(); mapRef.current = null; };
  }, [loadVenues]);

  // Pins
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    markersRef.current.forEach(m => m.remove());
    markersRef.current = [];
    if (venues.length === 0) return;

    // Busiest first, and never two pins crowding each other: any venue within
    // ~450m of an already-placed (busier) pin is skipped. 5 max — the demo is
    // a taste, not an inventory, and five photo pins read clean at city zoom.
    const MIN_GAP = 0.006; // degrees, ≈650m
    const shown = [];
    for (const v of [...venues].sort((a, b) => b.score - a.score)) {
      if (shown.length >= 5) break;
      const crowded = shown.some(s => Math.abs(s.lat - v.lat) < MIN_GAP && Math.abs(s.lng - v.lng) < MIN_GAP);
      if (!crowded) shown.push(v);
    }
    const bounds = new maplibregl.LngLatBounds();
    shown.forEach(v => {
      const el = buildDemoPin(v, () => loadCard(v.place_id));
      const marker = new maplibregl.Marker({ element: el }).setLngLat([v.lng, v.lat]).addTo(map);
      markersRef.current.push(marker);
      bounds.extend([v.lng, v.lat]);
    });
    // Tight zoom so downtown venues don't stack on each other
    map.fitBounds(bounds, { padding: 90, maxZoom: 16, duration: 600 });
  }, [venues, loadCard]);

  // Live loop: quietly re-score the open card every minute, and tick the
  // freshness label every 5s. Scores move when the model's inputs move
  // (hour, weather); nothing is invented between real updates.
  useEffect(() => {
    const refresh = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      if (selectedIdRef.current) loadCard(selectedIdRef.current, { quiet: true });
      const last = lastSearchRef.current;
      if (last && last.hour !== new Date().getHours()) refreshPins();
    }, REFRESH_MS);
    const age = setInterval(() => setAgeTick(t => t + 1), 5000);
    return () => { clearInterval(refresh); clearInterval(age); };
  }, [loadCard, refreshPins]);

  const onSearch = (e) => {
    e.preventDefault();
    loadVenues(centerRef.current, queryText.trim());
  };

  const useMyLocation = () => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const c = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        centerRef.current = c;
        mapRef.current?.jumpTo({ center: [c.lng, c.lat], zoom: 13.2 });
        loadVenues(c, queryText.trim());
      },
      () => { setErrorMsg("Couldn’t get your location. Search a city or spot instead."); }
    );
  };

  // The chart runs forward from the venue's current hour, so say so out loud
  // for anyone reading it with a screen reader.
  const chartSummary = selected?.hourly?.length
    ? `Crowd forecast for the next ${selected.hourly.length} hours, starting now: ${selected.hourly.map(h => (h.open === false ? `${h.hour} closed` : `${h.hour} ${h.score} percent`)).join(', ')}`
    : 'Hour by hour crowd forecast';
  const shut = isShut(selected);
  // Age is measured from the server's own stamp for the part that happened
  // before the response left, plus the time since it landed here. Subtracting a
  // server epoch from Date.now() made a phone whose clock is four minutes fast
  // read a card built one second ago as "4m ago".
  const ageMs = selected
    ? (selected.age_ms ?? 0) + Math.max(0, Date.now() - (selected.fetched_at || Date.now()))
    : null;
  // A star with no rating, or a separator with no address either side, is how
  // "★ 4.5 ·  · Open now" got on screen. Only real parts go in the line.
  const metaParts = [];
  if (selected) {
    if (selected.rating) {
      metaParts.push(
        <span className="lpd-rating">
          {Icons.starFilled('currentColor', 13)}
          {Number(selected.rating).toFixed(1)}
        </span>
      );
    }
    const street = (selected.address || '').split(',')[0].trim();
    if (street) metaParts.push(street);
    // When the venue is shut the label above already says so in slate; saying
    // it twice on one card reads like a stutter.
    if (selected.is_open === true) metaParts.push('Open now');
  }
  void ageTick; // freshness label re-renders on the 5s tick

  return (
    <div className="lpd">
      <form className="lpd-controls" onSubmit={onSearch}>
        <input
          className="lpd-input"
          value={queryText}
          onChange={(e) => setQueryText(e.target.value)}
          placeholder="Pizza, bars, bowling..."
          aria-label="What kind of place"
        />
        <button className="lp-btn lp-btn-navy lpd-go" type="submit">Check it</button>
        <button className="lpd-locate" type="button" onClick={useMyLocation}>Use my location</button>
      </form>

      <div className="lpd-stage">
        <div className="lpd-map" ref={mapDivRef} />

        <div className="lpd-card">
          {phase === 'error' && (
            <div className="lpd-empty"><p>{errorMsg}</p></div>
          )}

          {(phase === 'loading' || phase === 'card-loading') && (
            <div className="lpd-skel" aria-hidden>
              <div className="lpd-skel-dial" />
              <div className="lpd-skel-line" style={{ width: '70%' }} />
              <div className="lpd-skel-line" style={{ width: '45%' }} />
              <div className="lpd-skel-bars" />
            </div>
          )}

          {phase === 'ready' && selected && (
            <>
              <div className="lpd-card-head">
                {/* Closed means nobody is inside, so the dial reads zero in
                    slate rather than showing the model's guess at a crowd that
                    cannot exist. A red 74% over the word "Closed" was the worst
                    card this demo could draw. */}
                <DemoDial
                  score={shut ? 0 : selected.score}
                  color={shut ? CROWD_CLOSED : crowdColor(selected.score)}
                />
                <div className="lpd-card-title">
                  <h3>{selected.name}</h3>
                  <p className="lpd-label" style={{ color: shut ? CROWD_CLOSED : crowdColor(selected.score) }}>
                    {shut ? 'Closed right now' : selected.label}
                  </p>
                  {/* Built by joining the parts that exist. Interpolating them
                      straight left "★ 4.5 ·  · Open now" on a venue Google has
                      no address for, and a leading " · " when the rating was
                      missing too. */}
                  {metaParts.length > 0 && (
                    <p className="lpd-addr">
                      {metaParts.map((part, i) => (
                        <React.Fragment key={i}>
                          {i > 0 ? ' · ' : ''}
                          {part}
                        </React.Fragment>
                      ))}
                    </p>
                  )}
                </div>
              </div>

              {selected.best_time && (
                selected.best_is_now
                  // "Best time to go: Packed now, and it stays that way" is not
                  // a sentence. When the answer is "now" the copy is already a
                  // whole thought, so it stands on its own line.
                  ? <p className="lpd-best"><strong>{selected.best_time}</strong></p>
                  : <p className="lpd-best">Best time to go: <strong>{selected.best_time}</strong></p>
              )}

              {selected.hourly && selected.hourly.length > 0 && (
                <div className="lpd-chart" role="img" aria-label={chartSummary}>
                  {selected.hourly.map((h, i) => {
                    // The card's own hour is bar 0 and the backend names WHICH
                    // ENTRY it recommended, so the ring sits on the hour the
                    // sentence above named. Matching on the label instead would
                    // silently mark nothing when the recommendation lands past
                    // the twelfth bar.
                    const isNow = i === 0;
                    const isBest = selected.best_index === i;
                    // An hour the doors are shut has no crowd to draw. A stub
                    // in slate says "closed" instead of implying a quiet room.
                    const closed = h.open === false;
                    return (
                      <div className="lpd-bar-col" key={h.hour}>
                        <div
                          className="lpd-bar"
                          style={{
                            // Height is the percentage itself, the same number
                            // the dial counts to. Scaling to the tallest bar
                            // made a quiet 30% night look packed.
                            height: closed ? '6%' : `${Math.max(6, h.score)}%`,
                            backgroundColor: closed ? CROWD_CLOSED : crowdColor(h.score),
                            opacity: closed ? 0.45 : 1,
                            boxShadow: isBest ? '0 0 0 2px var(--ink)' : 'none',
                          }}
                          title={closed
                            ? `${h.hour}: closed`
                            : `${h.hour}: ${h.score}% busy${isNow ? ' (now)' : ''}${isBest ? ' (best time to go)' : ''}`}
                        />
                        <span
                          className="lpd-bar-hour"
                          // Every other label is hidden by the stylesheet to
                          // stop them colliding. Now and the recommended hour
                          // are the two that have to be readable.
                          style={isNow || isBest
                            ? { visibility: 'visible', fontWeight: 700, color: 'var(--ink)' }
                            : undefined}
                        >
                          {isNow ? 'Now' : String(h.hour).replace(' ', '')}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}

              <p className="lpd-note">
                <span className="lpd-live-dot" aria-hidden />
                Live from the model inside Flock{ageMs != null ? ` · updated ${agoLabel(ageMs)}` : ''}. Tap another pin to compare.
              </p>
              <a className="lp-btn lp-btn-navy lpd-cta" href="#get">Get the full picture in Flock</a>
            </>
          )}

          {phase === 'ready' && !selected && (
            <div className="lpd-empty"><p>No spots found there. Try a different search.</p></div>
          )}
        </div>
      </div>
    </div>
  );
}
