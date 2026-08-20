import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
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
//
// maplibre-gl is ~230KB gzipped and this section sits well below the fold, so
// the library is code-split and only fetched when the section approaches the
// viewport. Nothing about the demo runs while a visitor is still reading the
// hero.
// ---------------------------------------------------------------------------

const MAPTILER_KEY = process.env.REACT_APP_MAPTILER_KEY;
const MAP_STYLE = MAPTILER_KEY
  ? `https://api.maptiler.com/maps/basic-v2/style.json?key=${MAPTILER_KEY}`
  : 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json';

// Philadelphia by default: dense venues, works before anyone shares location.
const DEFAULT_CENTER = { lat: 39.9526, lng: -75.1652 };
const REFRESH_MS = 60_000; // live loop: re-score the open card every minute
const REQUEST_TIMEOUT_MS = 15_000; // a request that hangs must not skeleton forever
const MAP_BOOT_TIMEOUT_MS = 15_000; // no style by then and the basemap is not coming

// The colour has to break where the WORD breaks. It used to cut at 70 while the
// backend's getLabel cuts at 60, so a venue at 65 printed "Busy" in amber and
// one at 75 printed "Busy" in red: the same word, two colours, on the same card
// component. Bands here mirror crowdEngine.getLevel exactly.
//   green 0-40 (Quiet, Not Busy) | amber 41-60 (Moderate) | red 61+ (Busy, Very Busy)
const CROWD_GREEN = '#22C55E';
const CROWD_AMBER = '#F59E0B';
const CROWD_RED = '#EF4444';
// Shut. Slate rather than a crowd colour, because a closed venue is not quiet,
// it is unavailable.
const CROWD_CLOSED = '#64748B';

// The same four bands again, dark enough to be READ. The bright hues are pigment:
// they work as a 10px ring, an 18px bar and a pin ring, and they fail badly the
// moment they become type on the white card. Measured on #fff, the card's own
// ground: green 2.28:1, amber 2.15:1, red 3.76:1. The dial number and the crowd
// label were painted with all three. Text now uses the darker sibling from the
// same ramp (green 5.02:1, amber 5.02:1, red 6.47:1, slate 7.58:1) while the
// ring, the glow, the bars and the pins keep the bright hue.
const CROWD_GREEN_TEXT = '#15803D';
const CROWD_AMBER_TEXT = '#B45309';
const CROWD_RED_TEXT = '#B91C1C';
const CROWD_CLOSED_TEXT = '#475569';

// Scores arrive from the model as integers, but a malformed or missing one must
// not become `NaN%` on the dial or a `height: NaN%` bar.
const pct = (n) => {
  const v = Math.round(Number(n));
  return Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : 0;
};

// Back into [-180, 180]. The map counts longitude forever; the API does not.
const wrapLng = (lng) => (((lng + 180) % 360) + 360) % 360 - 180;

// Google's displayName is optional, so the backend can legitimately send an
// empty name. A card headed by nothing, and a pin whose label starts with a
// comma, are worse than a plain stand-in.
const venueName = (v) => (v && typeof v.name === 'string' && v.name.trim()) || 'This spot';

const crowdColor = (score) => (score > 60 ? CROWD_RED : score > 40 ? CROWD_AMBER : CROWD_GREEN);
const crowdTextColor = (score) =>
  (score > 60 ? CROWD_RED_TEXT : score > 40 ? CROWD_AMBER_TEXT : CROWD_GREEN_TEXT);
const isShut = (v) => v && v.is_open === false;

// The visitor's clock: predictions are for THEIR hour, not the server's UTC.
const clockParams = () => {
  const d = new Date();
  return { localHour: String(d.getHours()), localDay: String(d.getDay()) };
};

const reducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// --- honest failures -------------------------------------------------------
// Every one of these used to reach the page as `e.message`, which is how a
// visitor with flaky wifi read "Failed to fetch" and a visitor past the demo's
// hourly cap read "Unexpected token < in JSON at position 0". Each state now
// says what happened, in words, and says whether trying again is worth it.
const OFFLINE_MSG = 'You are offline. The demo needs a connection to score anything.';

function demoError(message, { retry = true } = {}) {
  const err = new Error(message);
  err.human = message;
  err.retry = retry;
  return err;
}

function httpError(status, data) {
  const fromServer = typeof data?.error === 'string' && data.error.trim() ? data.error.trim() : null;
  if (status === 429 || status === 503) {
    return demoError(fromServer || 'The live demo is taking a breather. The full thing is in the app.', { retry: false });
  }
  if (status === 404) return demoError("That spot is not in Google's index anymore. Pick another one.", { retry: false });
  if (status === 400) return demoError('That search did not come through. Try a different one.', { retry: false });
  return demoError('The demo hit a snag on our side. Try again in a minute.');
}

async function fetchDemo(url, signal) {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    throw demoError(OFFLINE_MSG);
  }
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener('abort', onAbort);
  }
  // The clock covers the body read too. A response whose headers arrive and
  // whose body then stalls is the exact shape of a dead connection, and
  // clearing the timer at the header would have left the skeleton spinning on
  // it for as long as the visitor stayed on the page.
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    let res;
    try {
      res = await fetch(url, { signal: ctrl.signal });
    } catch (e) {
      if (signal?.aborted) throw e; // the component moved on; nothing to show
      if (typeof navigator !== 'undefined' && navigator.onLine === false) throw demoError(OFFLINE_MSG);
      if (e && e.name === 'AbortError') throw demoError('That took longer than it should have. Try again.');
      throw demoError('Could not reach the demo. Check your connection and try again.');
    }
    // A rate limiter, a proxy or a cold container can answer with HTML. Reading
    // the body must never be the thing that decides what the visitor is told.
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw httpError(res.status, data);
    return data;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

// --- the product boundary --------------------------------------------------
// The demo deliberately serves the FREE tier in full and stops where the paid
// product starts: live score, label, confidence and open/closed on every venue,
// no account needed, and the forecast half withheld once PAYWALL_ENABLED is on.
// backend/routes/publicCrowd.js gateDemoCard() marks that with `forecast_locked`
// and empties best_time, peak_hours and hourly.
//
// Without a line of copy for it the section just silently loses its chart, and
// a visitor reads a card with a hole in it as a thin or broken product, which
// is the exact opposite of what a demo is for. THE LINE IS NOT AN ERROR STATE:
// nothing failed, and the retry button and the failure styling stay well away
// from it.
//
// Guarded on the card really being without those parts, not on the flag alone.
// Saying the hour by hour forecast is in the app while drawing an hour by hour
// chart underneath would be the same dishonesty pointed the other way.
const forecastIsLocked = (card) => !!card
  && card.forecast_locked === true
  && !(Array.isArray(card.hourly) && card.hourly.length > 0)
  && !(typeof card.best_time === 'string' && card.best_time.trim());

// Copy lives here, said once, so the printed line and the spoken one cannot
// drift apart. Every noun in it is a real, shipping part of the venue sheet in
// the app: the 12-hour chart, the best-time line, the Busiest Hours tile. No
// price, no trial, no feature that does not exist.
const LOCKED_FORECAST_COPY = 'The hour by hour forecast, the best time to go and when it peaks are in the app.';

// What the live region says when a card lands. Kept next to the card shape it
// reads so the spoken sentence and the printed one cannot drift.
function cardSentence(card) {
  if (!card) return '';
  const s = pct(card.score);
  // Said out loud too. A visitor using a screen reader hears the score and
  // would otherwise never learn that the rest of the card is a boundary and
  // not an omission.
  const tail = forecastIsLocked(card) ? ` ${LOCKED_FORECAST_COPY}` : '';
  if (card.is_open === false) return `${venueName(card)} is closed right now.${tail}`;
  // "Good Dog Bar, 35 percent busy, Not Busy" is what reading the two fields in
  // order gets you. Said as a sentence it is "Good Dog Bar is not busy, 35 percent".
  return `${venueName(card)} is ${(card.label || crowdWord(s)).toLowerCase()}, ${s} percent.${tail}`;
}

// The app's AnimatedDial (App.js), verbatim technique at 104px: canvas ring
// with pre-rendered track, cubic ease fill, counting number, glow on a sibling.
function DemoDial({ score, color, textColor, label }) {
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
    if (!ctx) return;
    const trackColor = 'rgba(22, 40, 61, 0.12)';

    const trackCanvas = document.createElement('canvas');
    trackCanvas.width = size;
    trackCanvas.height = size;
    const tctx = trackCanvas.getContext('2d');
    if (tctx) {
      tctx.beginPath();
      tctx.arc(center, center, radius, 0, Math.PI * 2);
      tctx.strokeStyle = trackColor;
      tctx.lineWidth = lineWidth;
      tctx.stroke();
    }

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

  // A number counting up from zero inside a canvas ring is a picture, not a
  // reading. The whole assembly gets one name and the animating digits are
  // hidden, so a screen reader hears the final answer once instead of a stream
  // of percentages.
  return (
    <div className="lpd-dial" role="img" aria-label={label}>
      <div aria-hidden className="lpd-dial-glow" style={{ boxShadow: `0 4px 12px rgba(0,0,0,0.18), 0 0 8px ${color}30` }} />
      <canvas aria-hidden ref={canvasRef} style={{ width: '104px', height: '104px', position: 'absolute', top: 0, left: 0 }} />
      <div className="lpd-dial-core" aria-hidden>
        <span ref={textRef} className="lpd-dial-num" style={{ color: textColor }}>0%</span>
      </div>
    </div>
  );
}

// App-style circular photo pin (App.js buildPhotoPin): photo clipped in a
// circle, ring colored by crowd level, % badge underneath.
function buildDemoPin(venue, onClick) {
  const score = pct(venue.score);
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'lpd-pin';
  el.setAttribute('aria-label', isShut(venue)
    ? `${venueName(venue)}, closed right now`
    : `${venueName(venue)}, ${score} percent busy`);
  el.setAttribute('aria-pressed', 'false');
  el.addEventListener('click', onClick);

  // A shut venue has no crowd. Painting it green at 12% reads as "quiet, go
  // now" for a place with the lights off.
  const shut = isShut(venue);
  const ring = shut ? CROWD_CLOSED : crowdColor(score);
  const photo = document.createElement('div');
  photo.className = 'lpd-pin-photo';
  el.appendChild(photo);

  const initial = () => {
    photo.style.backgroundImage = '';
    photo.classList.add('lpd-pin-noimg');
    photo.textContent = venueName(venue)[0];
  };
  if (venue.photo_url) {
    // The photo proxy can rate limit, 404 a stale reference, or be blocked on a
    // locked-down network. `background-image` fails silently, which left a
    // matte navy disc with nothing in it. Load it first, keep the venue's
    // initial if it never arrives.
    // ENCODED ONCE, USED TWICE. `venue.photo_url` is a server string, and it
    // used to be interpolated raw into a CSS `url("...")` value. A `"` in it
    // closes the CSS string, and everything after it is parsed as more of the
    // declaration. `background-image` is a single property assignment so a `;`
    // cannot open a second declaration and this was never script execution —
    // but it is server data reaching a CSS parser unescaped, which is not a
    // property to keep. encodeURI percent-encodes `"` and `\` (and every
    // control character), so the value cannot leave the quotes, and it leaves
    // the characters a URL legitimately contains alone.
    const photoHref = encodeURI(`${BASE_URL}${venue.photo_url}`);
    const img = new Image();
    img.onload = () => {
      // The initial has to come back off. Setting only the background left the
      // letter sitting on top of the photo it was standing in for.
      photo.classList.remove('lpd-pin-noimg');
      photo.textContent = '';
      photo.style.backgroundImage = `url("${photoHref}")`;
    };
    img.onerror = initial;
    img.src = photoHref;
    initial(); // shown until (and unless) the photo lands
  } else {
    initial();
  }

  const badge = document.createElement('span');
  badge.className = 'lpd-pin-badge';
  badge.style.backgroundColor = ring;
  badge.textContent = shut ? 'Closed' : `${score}%`;
  el.appendChild(badge);

  return { el, photo, ring };
}

// The pin under the open card gets an ink collar so the card and the map are
// visibly about the same venue. Restyled in place rather than by rebuilding the
// markers, which would re-run fitBounds and fly the map on every tap.
function paintPin(entry, selected) {
  entry.photo.style.boxShadow = selected
    ? `0 0 0 3px ${entry.ring}, 0 0 0 6px var(--ink), 0 6px 18px rgba(0,0,0,0.4)`
    : `0 0 0 3px ${entry.ring}, 0 4px 14px rgba(0,0,0,0.35)`;
  entry.el.setAttribute('aria-pressed', selected ? 'true' : 'false');
}

function agoLabel(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

export default function LiveDemo() {
  const stageRef = useRef(null);
  const mapDivRef = useRef(null);
  const mapRef = useRef(null);
  const mlRef = useRef(null); // the maplibre module, once the chunk lands
  const markersRef = useRef([]);
  const selectedIdRef = useRef(null);
  const inViewRef = useRef(false);
  const abortRef = useRef(null);
  const retryRef = useRef(null); // what the "Try again" button re-runs
  const aliveRef = useRef(true);
  const bootTimerRef = useRef(null);
  const fittedRef = useRef(''); // which set of pins the map was last framed for
  const [queryText, setQueryText] = useState('');
  const [venues, setVenues] = useState([]);
  const [resultQuery, setResultQuery] = useState(''); // what the venues on screen answer
  // The venue this search opened on. Set only by a search, never by tapping a
  // pin, so choosing a different pin does not reshuffle the pins.
  const [featuredId, setFeaturedId] = useState(null);
  const [selected, setSelected] = useState(null); // full card payload
  const [phase, setPhase] = useState('loading'); // loading | ready | card-loading | error
  const [errorMsg, setErrorMsg] = useState('');
  const [canRetry, setCanRetry] = useState(true);
  const [notice, setNotice] = useState(''); // location troubles, told next to the button that caused them
  // Spoken, not derived. Deriving it from `selected` meant the silent 60-second
  // re-score announced "Good Dog Bar, 36 percent busy" into a screen reader
  // every minute, unprompted. It changes only when the visitor asked for
  // something and it arrived.
  const [announce, setAnnounce] = useState('Scoring venues.');
  const [locating, setLocating] = useState(false);
  const [mapState, setMapState] = useState('idle'); // idle | booting | ready | failed
  const [ageTick, setAgeTick] = useState(0); // re-render the "updated X ago" line
  const centerRef = useRef(DEFAULT_CENTER);
  const lastSearchRef = useRef(null); // what the pins on screen were scored for

  const applyCard = useCallback((card) => {
    selectedIdRef.current = card.place_id;
    setSelected({ ...card, fetched_at: Date.now() });
  }, []);

  // One in-flight user-visible request at a time. Without this, a visitor who
  // taps three pins in two seconds gets whichever response happens to land
  // last, which is not necessarily the pin they left highlighted.
  const beginRequest = useCallback(() => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    return ctrl.signal;
  }, []);

  const showError = useCallback((e) => {
    const msg = e?.human || 'The demo hit a snag. Try again in a minute.';
    setPhase('error');
    setErrorMsg(msg);
    setAnnounce(msg);
    setCanRetry(e?.retry !== false);
  }, []);

  const loadCard = useCallback(async (placeId, { quiet } = {}) => {
    const url = `${BASE_URL}/api/public/demo/venue/${encodeURIComponent(placeId)}?${new URLSearchParams(clockParams())}`;
    if (quiet) {
      // The minute loop. It borrows no state and reports no failures: the next
      // tick tries again and the card keeps saying how old it really is.
      try {
        const data = await fetchDemo(url);
        if (selectedIdRef.current === placeId) applyCard(data);
      } catch { /* the freshness line already tells the truth */ }
      return;
    }
    const signal = beginRequest();
    retryRef.current = { kind: 'card', placeId };
    setPhase('card-loading');
    setAnnounce('Scoring venues.');
    try {
      const data = await fetchDemo(url, signal);
      applyCard(data);
      setAnnounce(cardSentence(data));
      setPhase('ready');
    } catch (e) {
      if (signal.aborted) return;
      showError(e);
    }
  }, [applyCard, beginRequest, showError]);

  // 2 decimals is about 1km: neighborhood is all a venue search needs.
  const venuesUrl = useCallback((center, q) => {
    const params = new URLSearchParams({ lat: center.lat.toFixed(2), lng: center.lng.toFixed(2), ...clockParams() });
    if (q) params.set('q', q);
    return `${BASE_URL}/api/public/demo/venues?${params}`;
  }, []);

  const loadVenues = useCallback(async (center, q) => {
    const signal = beginRequest();
    retryRef.current = { kind: 'venues', center, q };
    setPhase('loading');
    setErrorMsg('');
    setAnnounce('Scoring venues.');
    lastSearchRef.current = { center, q, hour: new Date().getHours() };
    try {
      const data = await fetchDemo(venuesUrl(center, q), signal);
      if (signal.aborted) return;
      const list = Array.isArray(data.venues) ? data.venues : [];
      setVenues(list);
      setResultQuery(q || '');
      if (data.card) {
        applyCard(data.card); // one round trip: card ships with the venues
        setFeaturedId(data.card.place_id);
        setAnnounce(cardSentence(data.card));
        setPhase('ready');
      } else if (list.length > 0) {
        const busiest = [...list].sort((a, b) => pct(b.score) - pct(a.score))[0];
        setFeaturedId(busiest.place_id);
        loadCard(busiest.place_id);
      } else {
        selectedIdRef.current = null;
        setSelected(null);
        setFeaturedId(null);
        setAnnounce(emptySentence(q));
        setPhase('ready');
      }
    } catch (e) {
      if (signal.aborted) return;
      showError(e);
    }
  }, [applyCard, beginRequest, loadCard, showError, venuesUrl]);

  // The card re-scores itself every minute but the pins were scored once, at
  // load. Leave the page open past the top of the hour and the pins were still
  // showing last hour's numbers while the dial had moved on: the same venue,
  // two different percentages, in one screenshot. Pins are re-scored quietly
  // when the hour rolls; nothing else about the view changes.
  const refreshPins = useCallback(async () => {
    const last = lastSearchRef.current;
    if (!last) return;
    try {
      const data = await fetchDemo(venuesUrl(last.center, last.q));
      if (Array.isArray(data.venues)) {
        setVenues(data.venues);
        // Google can hand back a different set an hour later. Keep the venue
        // that is actually on the card pinned, or the card and the map drift
        // apart again on the hour, quietly.
        if (selectedIdRef.current) setFeaturedId(selectedIdRef.current);
        lastSearchRef.current = { ...last, hour: new Date().getHours() };
      }
    } catch { /* the next tick tries again */ }
  }, [venuesUrl]);

  // --- map ------------------------------------------------------------------
  // Built only once the section is close to the viewport, and only ever as an
  // enhancement: if the chunk, the WebGL context or the style sheet fails, the
  // section drops to a ruled list of the same venues instead of leaving a
  // 460px hole where a map was supposed to be.
  const initMap = useCallback(async () => {
    if (mapRef.current) return;
    setMapState('booting');
    let ml;
    try {
      const mod = await import('maplibre-gl');
      ml = mod.default || mod;
    } catch {
      setMapState('failed');
      return;
    }
    // The chunk can land after the visitor has navigated away. Building a WebGL
    // map into a detached container leaks the context for the life of the tab.
    if (!aliveRef.current) return;
    const container = mapDivRef.current;
    if (!container || mapRef.current) return;
    let map;
    try {
      // No WebGL (old hardware, a hardened browser, a headless crawler) throws
      // here. Uncaught, that took the whole landing page down with it.
      map = new ml.Map({
        container,
        style: MAP_STYLE,
        center: [DEFAULT_CENTER.lng, DEFAULT_CENTER.lat],
        zoom: 13.2,
        attributionControl: { compact: true },
        cooperativeGestures: true,
      });
    } catch {
      setMapState('failed');
      return;
    }
    mlRef.current = ml;
    mapRef.current = map;

    let styleUp = false;
    const markReady = () => {
      if (styleUp) return;
      styleUp = true;
      clearTimeout(bootTimerRef.current);
      setMapState('ready');
    };
    // A basemap that never came up still holds a live WebGL context and keeps
    // retrying tiles behind a hidden element. Torn down on the next tick rather
    // than inside maplibre's own event dispatch.
    const giveUp = () => {
      if (styleUp) return;
      clearTimeout(bootTimerRef.current);
      setMapState('failed');
      setTimeout(() => {
        if (mapRef.current === map) { map.remove(); mapRef.current = null; }
      }, 0);
    };
    // `style.load` is the honest signal: the sheet parsed and the map can draw.
    // Waiting for `load` instead means waiting for every tile of the first
    // frame, and a single 404 tile arriving in that window used to be read as a
    // dead basemap and blanked the whole map for a section that was fine.
    map.on('style.load', markReady);
    map.on('load', markReady);
    // maplibre reports a missing tile and a dead style sheet through the same
    // event. Tiles cannot load before the style does, so anything that arrives
    // while the style is still missing is the style.
    map.on('error', giveUp);
    bootTimerRef.current = setTimeout(giveUp, MAP_BOOT_TIMEOUT_MS);

    try {
      map.addControl(new ml.NavigationControl({ showCompass: false }), 'top-right');
    } catch { /* the map still pans and pinches without the buttons */ }
  }, []);

  // LandingPage only mounts this component when the section is within 800px of
  // the viewport (WhenNear), so mounting IS the "we're close" signal: starting
  // here rather than behind a second, tighter observer is what lets the demo be
  // scored and drawn before it reaches the screen. Location is only ever
  // requested by the explicit "Use my location" button, because scrolling a
  // section into view is not consent to hand a marketing page your coordinates.
  //
  // Start and teardown are deliberately the same effect. A "have I started
  // already" ref that survives unmount looks like it saves a duplicate request,
  // and under StrictMode's mount / unmount / remount it means the second mount
  // skips the start while the first mount's teardown has already destroyed the
  // map: a blank section for the whole of local development.
  useEffect(() => {
    aliveRef.current = true;
    initMap();
    loadVenues(DEFAULT_CENTER, '');
    return () => {
      aliveRef.current = false;
      clearTimeout(bootTimerRef.current);
      abortRef.current?.abort();
      markersRef.current.forEach(m => m.marker.remove());
      markersRef.current = [];
      mapRef.current?.remove();
      mapRef.current = null;
      fittedRef.current = '';
    };
  }, [initMap, loadVenues]);

  // Visibility is tracked separately, and only to decide whether the minute
  // loop is worth spending: the demo has a per-visitor hourly budget, and
  // burning it on a section 3000px up the page is how a real visitor ends up
  // reading the "taking a breather" message.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || typeof IntersectionObserver === 'undefined') {
      inViewRef.current = true;
      return undefined;
    }
    const obs = new IntersectionObserver((entries) => {
      inViewRef.current = entries.some(e => e.isIntersecting);
    }, { threshold: 0, rootMargin: '250px 0px' });
    obs.observe(stage);
    return () => obs.disconnect();
  }, []);

  // Busiest first, and never two pins crowding each other: any venue within
  // ~500m of an already-placed (busier) pin is skipped. 5 max, because the demo
  // is a taste, not an inventory, and five photo pins read clean at city zoom.
  //
  // The venue on the card takes the first slot no matter what it scored. The
  // server picks the featured venue by open-first-then-busiest while this list
  // sorted on score alone, so downtown Philadelphia opened with a card for Good
  // Dog Bar and a map with no Good Dog Bar on it: the headline venue thinned
  // out as a neighbour of a busier pin, nothing highlighted, and "tap another
  // pin to compare" pointing at four strangers.
  const ranked = useMemo(() => {
    const sorted = [...venues].sort((a, b) => pct(b.score) - pct(a.score));
    const feature = featuredId ? sorted.find(v => v.place_id === featuredId) : null;
    return feature ? [feature, ...sorted.filter(v => v !== feature)] : sorted;
  }, [venues, featuredId]);

  const shownVenues = useMemo(() => {
    const MIN_GAP = 0.006; // degrees, about 500m
    const shown = [];
    for (const v of ranked.filter(v => Number.isFinite(v.lat) && Number.isFinite(v.lng))) {
      if (shown.length >= 5) break;
      const crowded = shown.some(s => Math.abs(s.lat - v.lat) < MIN_GAP && Math.abs(s.lng - v.lng) < MIN_GAP);
      if (!crowded) shown.push(v);
    }
    return shown;
  }, [ranked]);

  // What the section lists when there is no map. It does NOT inherit the pin
  // thinning: two venues a block apart crowd each other on a map and do not
  // crowd each other in a list, and dropping half of downtown Philadelphia out
  // of a text list costs the visitor real information for a reason that only
  // existed while there was a map.
  const listVenues = useMemo(() => ranked.slice(0, 5), [ranked]);

  // Pins
  useEffect(() => {
    const map = mapRef.current;
    const ml = mlRef.current;
    if (!map || !ml || mapState !== 'ready') return;
    markersRef.current.forEach(m => m.marker.remove());
    markersRef.current = [];
    if (shownVenues.length === 0) return;

    const bounds = new ml.LngLatBounds();
    shownVenues.forEach(v => {
      const built = buildDemoPin(v, () => loadCard(v.place_id));
      const marker = new ml.Marker({ element: built.el }).setLngLat([v.lng, v.lat]).addTo(map);
      const entry = { ...built, id: v.place_id, marker };
      paintPin(entry, v.place_id === selectedIdRef.current);
      markersRef.current.push(entry);
      bounds.extend([v.lng, v.lat]);
    });
    // Tight zoom so downtown venues don't stack on each other. Only when the
    // set of pins actually changed: the hourly re-score returns the same five
    // venues with new numbers, and re-framing on that flew the map out from
    // under whoever was reading it, once an hour, for no new information.
    const signature = shownVenues.map(v => v.place_id).sort().join('|');
    if (signature !== fittedRef.current) {
      fittedRef.current = signature;
      map.fitBounds(bounds, { padding: 90, maxZoom: 16, duration: reducedMotion() ? 0 : 600 });
    }
  }, [shownVenues, loadCard, mapState]);

  // Which pin the open card belongs to. Markers get their first collar as they
  // are built, so this only has to handle the visitor changing their mind.
  useEffect(() => {
    markersRef.current.forEach(entry => paintPin(entry, entry.id === selected?.place_id));
  }, [selected]);

  // Live loop: quietly re-score the open card every minute, and tick the
  // freshness label every 5s. Scores move when the model's inputs move
  // (hour, weather); nothing is invented between real updates. Off-screen and
  // background tabs are skipped: the demo has a per-visitor hourly budget and
  // spending it on a section nobody is looking at is how a real visitor gets
  // the "taking a breather" message.
  useEffect(() => {
    const refresh = setInterval(() => {
      if (document.visibilityState !== 'visible' || !inViewRef.current) return;
      if (selectedIdRef.current) loadCard(selectedIdRef.current, { quiet: true });
      const last = lastSearchRef.current;
      if (last && last.hour !== new Date().getHours()) refreshPins();
    }, REFRESH_MS);
    const age = setInterval(() => setAgeTick(t => t + 1), 5000);
    return () => { clearInterval(refresh); clearInterval(age); };
  }, [loadCard, refreshPins]);

  // Where a search looks. Once the visitor has dragged the map somewhere, that
  // is the neighborhood they mean; the ref is only the fallback for a map that
  // never came up.
  const searchCenter = useCallback(() => {
    const map = mapRef.current;
    if (map && mapState === 'ready') {
      try {
        const c = map.getCenter();
        // maplibre keeps counting longitude past the antimeridian: drag east
        // across the Pacific twice and getCenter() reads 284, which the API
        // rejects as out of range and the page reported as "that search did not
        // come through". Wrapping is what the visitor meant either way.
        if (Number.isFinite(c.lat) && Number.isFinite(c.lng)) {
          return { lat: Math.max(-90, Math.min(90, c.lat)), lng: wrapLng(c.lng) };
        }
      } catch { /* fall through to the last known center */ }
    }
    return centerRef.current;
  }, [mapState]);

  const onSearch = (e) => {
    e.preventDefault();
    setNotice('');
    loadVenues(searchCenter(), queryText.trim());
  };

  const useMyLocation = () => {
    // A button that silently does nothing is a rejection reason on its own
    // (SLOP-AUDIT K1). Every branch here ends in either a map move or a
    // sentence next to the button.
    // The real double-press gate. The button below says aria-disabled while
    // locating instead of the disabled attribute, so this guard is what
    // actually stops a second request.
    if (locating) return;
    if (!navigator.geolocation) {
      setNotice('This browser will not share a location. Search a city or a kind of place instead.');
      return;
    }
    setNotice('');
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        const c = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        centerRef.current = c;
        try { mapRef.current?.jumpTo({ center: [c.lng, c.lat], zoom: 13.2 }); } catch { /* list still updates */ }
        loadVenues(c, queryText.trim());
      },
      (err) => {
        setLocating(false);
        // This used to set the error state's message without setting the error
        // state, so a denied prompt printed nothing anywhere on the page.
        setNotice(err && err.code === 1
          ? 'No location, no problem. Search a city or a kind of place instead.'
          : 'Could not get your location. Search a city or a kind of place instead.');
      },
      { timeout: 10_000, maximumAge: 300_000 }
    );
  };

  // Checked as an array, not for truthiness. This section has no error boundary
  // above it, so one malformed field would take the whole marketing page down
  // with a render throw rather than just dropping the chart.
  const hourly = Array.isArray(selected?.hourly) ? selected.hourly : [];
  // The chart runs forward from the venue's current hour, so say so out loud
  // for anyone reading it with a screen reader.
  const chartSummary = hourly.length
    ? `Crowd forecast for the next ${hourly.length} hours, starting now: ${hourly.map(h => (h.open === false ? `${h.hour} closed` : `${h.hour} ${pct(h.score)} percent`)).join(', ')}`
    : 'Hour by hour crowd forecast';
  const shut = isShut(selected);
  // Read once and used twice, so the "Best time to go" line and the locked
  // note can never both decide they are the right thing to draw.
  const bestTime = (typeof selected?.best_time === 'string' && selected.best_time) ? selected.best_time : null;
  const forecastLocked = forecastIsLocked(selected);
  const score = pct(selected?.score);
  const dialLabel = selected
    ? (shut
      ? `${venueName(selected)} is closed right now`
      : `Crowd right now: ${score} percent, ${selected.label || crowdWord(score)}`)
    : '';
  // Age is measured from the server's own stamp for the part that happened
  // before the response left, plus the time since it landed here. Subtracting a
  // server epoch from Date.now() made a phone whose clock is four minutes fast
  // read a card built one second ago as "4m ago".
  const ageMs = selected
    ? (selected.age_ms ?? 0) + Math.max(0, Date.now() - (selected.fetched_at || Date.now()))
    : null;
  // A star with no rating, or a separator with no address either side, is how
  // "star 4.5 ·  · Open now" got on screen. Only real parts go in the line.
  const metaParts = [];
  if (selected) {
    const rating = Number(selected.rating);
    if (Number.isFinite(rating) && rating > 0) {
      metaParts.push(
        <span className="lpd-rating">
          {Icons.starFilled('currentColor', 13)}
          {rating.toFixed(1)}
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

  const busy = phase === 'loading' || phase === 'card-loading';
  const emptyMsg = emptySentence(resultQuery);
  const comparable = (mapState === 'failed' ? listVenues : shownVenues).length;

  return (
    <div className="lpd">
      <form className="lpd-controls" onSubmit={onSearch} role="search" aria-label="Try the crowd model">
        <input
          className="lpd-input"
          type="search"
          name="demo-query"
          value={queryText}
          onChange={(e) => setQueryText(e.target.value)}
          placeholder="Pizza, bars, bowling..."
          aria-label="What kind of place"
          enterKeyHint="search"
          // type=search buys the phone keyboard a Search key and an inline
          // clear button. Safari also repaints the field as a native
          // searchfield unless appearance is dropped, which would throw away
          // the radius and padding the stylesheet sets.
          style={{ WebkitAppearance: 'none', appearance: 'none' }}
        />
        <button className="lp-btn lp-btn-navy lpd-go" type="submit">Check it</button>
        <button
          className="lpd-locate"
          type="button"
          onClick={useMyLocation}
          // aria-disabled, not disabled, same rule as the waitlist submit and
          // the guest invite buttons: the disabled attribute on the control
          // you just pressed hands browser focus to <body>, so a keyboard user
          // waiting on the geolocation permission prompt lost their place.
          // useMyLocation returns early while locating, and the stylesheet's
          // [aria-disabled='true'] rule carries cursor and pointer-events.
          aria-disabled={locating || undefined}
          // 44px is the touch floor; the stylesheet's padding lands this
          // control at 37px next to a 46px button.
          style={{ minHeight: 44, opacity: locating ? 0.6 : 1 }}
        >
          {locating ? 'Finding you...' : 'Use my location'}
        </button>
      </form>

      {/* Always in the DOM so it is a live region a screen reader is already
          watching, and it costs no space until it has something to say. */}
      <p role="status" style={{ margin: notice ? '0 0 12px' : 0, fontSize: 13, color: 'var(--cream-2)' }}>{notice}</p>

      <div className="lpd-stage" ref={stageRef}>
        <div
          className="lpd-map"
          role="region"
          // Named for what is actually in it. Calling the fallback panel a map
          // is the same lie in the accessibility tree that the empty frame used
          // to be on screen.
          aria-label={mapState === 'failed' ? 'Nearby venues' : 'Live crowd map'}
          style={{ position: 'relative' }}
        >
          <div
            ref={mapDivRef}
            style={{ position: 'absolute', inset: 0, visibility: mapState === 'failed' ? 'hidden' : 'visible' }}
          />
          {mapState === 'booting' && (
            <p style={{ position: 'absolute', inset: 0, margin: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, color: 'var(--ink-3)' }}>
              Bringing up the map.
            </p>
          )}
          {mapState === 'failed' && (
            <div style={{ position: 'absolute', inset: 0, overflow: 'auto', padding: 20 }}>
              <p style={{ margin: '0 0 14px', fontSize: 13.5, color: 'var(--ink-3)' }}>
                The map did not load here. The scores are live either way.
              </p>
              {listVenues.length === 0 ? (
                <p style={{ margin: 0, fontSize: 14, color: 'var(--ink-3)' }}>Nothing to list yet.</p>
              ) : (
                <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                  {listVenues.map(v => {
                    const s = pct(v.score);
                    const off = isShut(v);
                    return (
                      <li key={v.place_id} style={{ borderTop: '1px solid var(--rule)' }}>
                        <button
                          type="button"
                          onClick={() => loadCard(v.place_id)}
                          aria-pressed={v.place_id === selected?.place_id}
                          style={{
                            display: 'flex', width: '100%', gap: 12, alignItems: 'baseline',
                            padding: '12px 2px', minHeight: 44, background: 'none', border: 'none',
                            font: 'inherit', fontSize: 14, color: 'var(--ink)', textAlign: 'left', cursor: 'pointer',
                          }}
                        >
                          <span style={{ flex: 1, minWidth: 0 }}>{venueName(v)}</span>
                          <span style={{ fontWeight: 700, color: off ? CROWD_CLOSED_TEXT : crowdTextColor(s) }}>
                            {off ? 'Closed' : `${s}%`}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}
        </div>

        <div className="lpd-card" aria-busy={busy}>
          {/* One live region for the whole widget, mounted for the life of the
              section. A status node that appears at the same moment its text
              does is announced by some screen readers and missed by others,
              and a keyboard user who just activated a pin has no other signal
              that the card changed under them. */}
          <p className="sr-only" role="status">{announce}</p>

          {/* The map's own text equivalent, off screen: the same venues, the
              same numbers, in reading order. */}
          {shownVenues.length > 0 && mapState !== 'failed' && (
            <ul className="sr-only" aria-label="Venues on the map">
              {shownVenues.map(v => (
                <li key={v.place_id}>{isShut(v) ? `${venueName(v)}, closed right now` : `${venueName(v)}, ${pct(v.score)} percent busy`}</li>
              ))}
            </ul>
          )}

          {phase === 'error' && (
            <div className="lpd-empty">
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14 }}>
                <p style={{ margin: 0 }}>{errorMsg}</p>
                {canRetry && (
                  <button
                    className="lp-btn lp-btn-navy"
                    type="button"
                    onClick={() => {
                      const t = retryRef.current;
                      if (!t) loadVenues(centerRef.current, queryText.trim());
                      else if (t.kind === 'card') loadCard(t.placeId);
                      else loadVenues(t.center, t.q);
                    }}
                  >
                    Try again
                  </button>
                )}
              </div>
            </div>
          )}

          {busy && (
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
                  score={shut ? 0 : score}
                  color={shut ? CROWD_CLOSED : crowdColor(score)}
                  textColor={shut ? CROWD_CLOSED_TEXT : crowdTextColor(score)}
                  label={dialLabel}
                />
                <div className="lpd-card-title">
                  <h3>{venueName(selected)}</h3>
                  <p className="lpd-label" style={{ color: shut ? CROWD_CLOSED_TEXT : crowdTextColor(score) }}>
                    {shut ? 'Closed right now' : (selected.label || crowdWord(score))}
                  </p>
                  {/* Built by joining the parts that exist. Interpolating them
                      straight left a rating star, an empty gap and "Open now"
                      on a venue Google has no address for, and a leading
                      separator when the rating was missing too. */}
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

              {bestTime && (
                selected.best_is_now
                  // "Best time to go: Packed now, and it stays that way" is not
                  // a sentence. When the answer is "now" the copy is already a
                  // whole thought, so it stands on its own line.
                  ? <p className="lpd-best"><strong>{bestTime}</strong></p>
                  : <p className="lpd-best">Best time to go: <strong>{bestTime}</strong></p>
              )}

              {/* Where the free half ends. Quiet, ruled off, same ink as the
                  rest of the card: this is the product boundary, so it must
                  not borrow anything from the error state sitting a few lines
                  up. The CTA under it already says where to go, so this line
                  adds no second button and makes no offer. */}
              {forecastLocked && (
                <p style={{
                  margin: '14px 0 0',
                  paddingTop: 12,
                  borderTop: '1px solid var(--rule)',
                  fontSize: 13.5,
                  lineHeight: 1.5,
                  color: 'var(--ink-3)',
                }}>
                  {LOCKED_FORECAST_COPY}
                </p>
              )}

              {hourly.length > 0 && (
                <div className="lpd-chart" role="img" aria-label={chartSummary}>
                  {hourly.map((h, i) => {
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
                    const hs = pct(h.score);
                    return (
                      <div className="lpd-bar-col" key={`${i}-${h.hour}`}>
                        <div
                          className="lpd-bar"
                          style={{
                            // Height is the percentage itself, the same number
                            // the dial counts to. Scaling to the tallest bar
                            // made a quiet 30% night look packed.
                            height: closed ? '6%' : `${Math.max(6, hs)}%`,
                            backgroundColor: closed ? CROWD_CLOSED : crowdColor(hs),
                            opacity: closed ? 0.45 : 1,
                            boxShadow: isBest ? '0 0 0 2px var(--ink)' : 'none',
                          }}
                          title={closed
                            ? `${h.hour}: closed`
                            : `${h.hour}: ${hs}% busy${isNow ? ' (now)' : ''}${isBest ? ' (best time to go)' : ''}`}
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
                Live from the model inside Flock{ageMs != null ? ` · updated ${agoLabel(ageMs)}` : ''}.
                {/* Counted off whatever the visitor can actually reach: pins
                    when there is a map, the fallback list when there is not.
                    Reading the pin count while showing the list is how "tap
                    another pin" survives on a page with no pins. */}
                {comparable > 1 && (mapState === 'ready' ? ' Tap another pin to compare.' : ' Pick another spot to compare.')}
              </p>
              <a className="lp-btn lp-btn-navy lpd-cta" href="#get">Get the full picture in Flock</a>
            </>
          )}

          {phase === 'ready' && !selected && (
            <div className="lpd-empty"><p style={{ margin: 0 }}>{emptyMsg}</p></div>
          )}
        </div>
      </div>
    </div>
  );
}

// Said in the card and said in the live region, from one place, so a visitor
// reading it and a visitor hearing it are told the same thing.
function emptySentence(q) {
  return q
    ? `Google has no "${q}" around here. Try another word, or move the map.`
    : 'No venues came back for this spot. Move the map or search a kind of place.';
}

// The server sends the word with the score. This is only the stand-in for a
// response that arrived without one, and it uses the same cut points as
// crowdEngine.getLabel so the word can never disagree with the colour.
function crowdWord(s) {
  if (s <= 20) return 'Quiet';
  if (s <= 40) return 'Not Busy';
  if (s <= 60) return 'Moderate';
  if (s <= 80) return 'Busy';
  return 'Very Busy';
}
