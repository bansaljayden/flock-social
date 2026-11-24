/**
 * SCANNING A FRIEND'S FLOCK CODE.
 *
 * Mounted by App.js at the root, beside the chat camera, never inside the QR
 * tab: it is a full screen of its own, opaque, padded by the safe areas, so
 * nothing of the page shows behind the viewfinder and a toast or a sheet
 * raised underneath it cannot be mistaken for part of it. It used to be a
 * see-through layer inside the tab's scroll box, with the person's own QR
 * floating above the camera like a second target.
 *
 * WHAT IT READS. html5-qrcode, fetched on the first open (it carries its own
 * decoder and was once the largest thing on the startup path:
 * bundleWeightManifest.test.js keeps it off it), set up for QR codes only.
 * With every barcode format on, each frame was searched for seventeen of them,
 * twice; one format and no mirrored retry is about thirty times less work per
 * frame. The decode box is seventy percent of the viewfinder's shorter side,
 * and the viewfinder is laid out at twice its size and drawn at half, because
 * the library decodes a canvas the size of the box in CSS pixels: at the
 * phone's own width a code had to fill a third of the frame, about nine
 * centimetres away, before it read. The stream asks for 1280 by 720 for the
 * same reason. What is read goes through lib/friendCode.js, which knows the
 * link, the JSON older builds drew and a bare code, and nothing else.
 *
 * THE CAMERA GOES OFF ON EVERY WAY OUT: Close, Escape, Type the code instead,
 * the app leaving Add Friends (App.js closes this), this unmounting for any
 * reason, and the page being hidden, when it comes back on by itself if the
 * scanner is still open. Starting takes a fetched library and a camera prompt,
 * and a close during either used to find nothing to stop, so the camera came
 * on behind a closed screen (app audit 2026-10-03). Every start and every stop
 * takes a number, and a start that finishes after its number moved on stops
 * itself.
 *
 * A link never adds anybody by itself; a scan does, because pointing your
 * camera at a friend's phone is the deliberate act. Your own code is caught
 * here and the camera keeps looking.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import Icons from './ui/Icons';
import { friendCodeFrom } from '../lib/friendCode';
import { cameraErrorName } from '../lib/cameraErrorCopy';

// The element html5-qrcode draws into. It empties it before every start, so
// nothing React renders may live inside it.
export const QR_READER_ID = 'flock-qr-reader';

// The decode canvas is the box's size in layout pixels, so laying the
// viewfinder out at twice its size and drawing it at half doubles what the
// decoder sees without changing what the person sees.
const DECODE_SCALE = 2;
// Of the viewfinder's shorter side.
const BOX_SHARE = 0.7;
const FPS = 12;
// How long a passing line (a wrong code, your own code) stays before the
// camera's own line comes back, and how long the answer stays before closing.
const PASSING_MS = 2500;
const DONE_MS = 1200;

// The chunk the scanner needs, asked for before anybody taps Scan. Fire and
// forget: a warm that fails just means the tap fetches it.
export const warmQrDecoder = () => import('html5-qrcode').catch(() => {});

const VIDEO = { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } };

const DENIED = new Set(['NotAllowedError', 'PermissionDeniedError']);
const NO_CAMERA = new Set(['NotFoundError', 'DevicesNotFoundError']);
const isChunkError = (err) => err?.name === 'ChunkLoadError'
  || /Loading chunk|dynamically imported module/i.test(err?.message || '');

const glassButton = {
  minHeight: '44px',
  padding: '0 18px',
  borderRadius: 'var(--r-pill)',
  border: '1px solid rgba(255,255,255,0.28)',
  background: 'rgba(255,255,255,0.14)',
  color: '#ffffff',
  fontSize: 'var(--t-body)',
  fontWeight: '600',
  cursor: 'pointer',
};
const solidButton = {
  ...glassButton,
  border: 'none',
  background: '#ffffff',
  color: '#1e293b',
};

export default function QrScanner({
  DialogBehavior,
  myFriendCode,
  native,
  onAdd,
  onClose,
  onOpenSettings,
  onTypeCode,
}) {
  // 'starting' | 'live' | 'wrong' | 'own' | 'adding' | 'done' | 'refused'
  // | 'denied' | 'noCamera' | 'failed' | 'loadFailed' | 'paused'
  const [phase, setPhase] = useState('starting');
  const [answer, setAnswer] = useState('');
  // The decode box's side as drawn, once the library has measured the
  // viewfinder; the guide square follows it so the two always agree.
  const [guideSide, setGuideSide] = useState(null);

  const sessionRef = useRef(0);
  const scannerRef = useRef(null);
  const mountedRef = useRef(false);
  const busyRef = useRef(false);
  const passingTimerRef = useRef(null);
  const doneTimerRef = useRef(null);
  // Whether the camera ought to be running, and whether a hidden page took it
  // away, so coming back turns it on again only when it was on.
  const wantCameraRef = useRef(false);
  const resumeOnVisibleRef = useRef(false);

  // The latest props, for the decode callback, which the library holds from
  // the start that registered it.
  const latest = useRef({});
  latest.current = { myFriendCode, onAdd, onClose, onTypeCode };

  const stopCamera = useCallback(async () => {
    // Moving the number on is what reaches a start still in flight.
    sessionRef.current += 1;
    wantCameraRef.current = false;
    const scanner = scannerRef.current;
    scannerRef.current = null;
    if (!scanner) return;
    try { await scanner.stop(); } catch { /* not running yet, or already stopped */ }
    try { scanner.clear(); } catch { /* already empty */ }
  }, []);

  const passing = useCallback((kind) => {
    setPhase((now) => (now === 'live' || now === 'wrong' || now === 'own' ? kind : now));
    if (passingTimerRef.current) clearTimeout(passingTimerRef.current);
    passingTimerRef.current = setTimeout(() => {
      passingTimerRef.current = null;
      setPhase((now) => (now === kind ? 'live' : now));
    }, PASSING_MS);
  }, []);

  const onDecoded = useCallback((text) => {
    if (busyRef.current) return;
    const code = friendCodeFrom(typeof text === 'string' ? text : '');
    if (!code) { passing('wrong'); return; }
    const mine = latest.current.myFriendCode;
    if (mine && code === mine) { passing('own'); return; }
    busyRef.current = true;
    if (passingTimerRef.current) { clearTimeout(passingTimerRef.current); passingTimerRef.current = null; }
    setPhase('adding');
    stopCamera();
    Promise.resolve()
      .then(() => latest.current.onAdd(code))
      .then((result) => {
        if (!mountedRef.current) return;
        if (result && result.close) { latest.current.onClose(); return; }
        setAnswer((result && result.message) || '');
        if (result && result.ok) {
          setPhase('done');
          doneTimerRef.current = setTimeout(() => latest.current.onClose(), DONE_MS);
          return;
        }
        busyRef.current = false;
        setPhase('refused');
      })
      .catch(() => {
        if (!mountedRef.current) return;
        busyRef.current = false;
        setAnswer("That didn't go through. Try again.");
        setPhase('refused');
      });
  }, [passing, stopCamera]);

  const startCamera = useCallback(async () => {
    const session = sessionRef.current + 1;
    sessionRef.current = session;
    const stillOpen = () => sessionRef.current === session && mountedRef.current;
    wantCameraRef.current = true;
    busyRef.current = false;
    setAnswer('');
    setPhase('starting');

    // No camera API at all (an old browser, an insecure page): the code field
    // is the way in, so that is where this goes.
    if (typeof navigator === 'undefined' || !navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
      wantCameraRef.current = false;
      latest.current.onTypeCode('unsupported');
      return;
    }

    let lib;
    try {
      lib = await import('html5-qrcode');
    } catch (err) {
      if (!stillOpen()) return;
      wantCameraRef.current = false;
      // A chunk that fails to load is a network problem, not a camera one.
      // Naming the camera here would send somebody into their permission
      // settings to fix something that is not broken.
      setPhase(isChunkError(err) ? 'loadFailed' : 'failed');
      return;
    }
    if (!stillOpen()) return;

    const { Html5Qrcode, Html5QrcodeSupportedFormats } = lib;
    let scanner;
    try {
      scanner = new Html5Qrcode(QR_READER_ID, {
        verbose: false,
        formatsToSupport: [Html5QrcodeSupportedFormats.QR_CODE],
        // The system decoder where the browser has one; ZXing otherwise.
        useBarCodeDetectorIfSupported: true,
      });
    } catch {
      wantCameraRef.current = false;
      setPhase('failed');
      return;
    }
    scannerRef.current = scanner;

    const config = (withVideo) => ({
      fps: FPS,
      disableFlip: true,
      qrbox: (width, height) => {
        const side = Math.max(50, Math.round(Math.min(width, height) * BOX_SHARE));
        setGuideSide(side / DECODE_SCALE);
        return { width: side, height: side };
      },
      ...(withVideo ? { videoConstraints: VIDEO } : {}),
    });

    let failure = null;
    try {
      await scanner.start({ facingMode: 'environment' }, config(true), onDecoded, () => {});
    } catch (err) {
      failure = err;
    }
    // A sharper stream is a nicety. A camera that refused it is asked once
    // more for whatever it has, unless the refusal was the person's.
    if (failure && stillOpen() && !DENIED.has(cameraErrorName(failure)) && !NO_CAMERA.has(cameraErrorName(failure))) {
      failure = null;
      try {
        await scanner.start({ facingMode: 'environment' }, config(false), onDecoded, () => {});
      } catch (err) {
        failure = err;
      }
    }

    if (!stillOpen()) {
      // Closed while the camera was coming up: turn it straight back off.
      try { await scanner.stop(); } catch { /* it never got going */ }
      try { scanner.clear(); } catch { /* already empty */ }
      if (scannerRef.current === scanner) scannerRef.current = null;
      return;
    }
    if (failure) {
      if (scannerRef.current === scanner) scannerRef.current = null;
      wantCameraRef.current = false;
      const name = cameraErrorName(failure);
      setPhase(DENIED.has(name) ? 'denied' : NO_CAMERA.has(name) ? 'noCamera' : 'failed');
      return;
    }
    setPhase('live');
  }, [onDecoded]);

  useEffect(() => {
    mountedRef.current = true;
    startCamera();
    return () => {
      mountedRef.current = false;
      if (passingTimerRef.current) clearTimeout(passingTimerRef.current);
      if (doneTimerRef.current) clearTimeout(doneTimerRef.current);
      stopCamera();
    };
  }, [startCamera, stopCamera]);

  // A hidden page takes the camera with it, and gets it back on its return if
  // the scanner was looking. iOS can interrupt capture in the background and
  // hand back a frozen frame, and a camera left running behind a locked phone
  // is the thing this file exists to prevent.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        if (wantCameraRef.current) {
          resumeOnVisibleRef.current = true;
          stopCamera();
          setPhase('paused');
        }
        return;
      }
      if (resumeOnVisibleRef.current && mountedRef.current) {
        resumeOnVisibleRef.current = false;
        startCamera();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [startCamera, stopCamera]);

  const close = () => { stopCamera(); onClose(); };
  const typeInstead = () => { stopCamera(); onTypeCode('asked'); };

  const looking = phase === 'starting' || phase === 'live' || phase === 'wrong' || phase === 'own' || phase === 'paused';
  const status = (() => {
    switch (phase) {
      case 'starting': return 'Starting the camera.';
      case 'live': return "Point your camera at a friend's Flock code.";
      case 'wrong': return "That isn't a Flock code.";
      case 'own': return "That's your own code.";
      case 'adding': return 'Adding…';
      case 'done':
      case 'refused': return answer || "That didn't go through. Try again.";
      case 'denied': return native
        ? "Flock can't use the camera."
        : "Flock can't use the camera. Allow it in your browser settings, then try again.";
      case 'noCamera': return 'No camera was found on this device.';
      case 'loadFailed': return "Couldn't load the scanner. Check your connection and try again.";
      case 'paused': return 'Paused.';
      default: return "The camera didn't start.";
    }
  })();

  // One action beside Type the code instead, by state.
  let action = null;
  if (phase === 'denied' && native && onOpenSettings) {
    action = <button type="button" className="hit44" onClick={onOpenSettings} style={solidButton}>Open Settings</button>;
  } else if (phase === 'denied' || phase === 'failed' || phase === 'loadFailed') {
    action = <button type="button" className="hit44" onClick={startCamera} style={solidButton}>Try again</button>;
  } else if (phase === 'refused') {
    action = <button type="button" className="hit44" onClick={startCamera} style={solidButton}>Scan again</button>;
  }

  return (
    <div
      data-testid="qr-scanner"
      style={{ position: 'fixed', inset: 0, zIndex: 9999, backgroundColor: '#000', display: 'flex', flexDirection: 'column', boxSizing: 'border-box', paddingBottom: 'var(--cb-height, 0px)', color: '#ffffff' }}
    >
      <DialogBehavior onClose={close} label="Scan a Flock code" />
      {/* The library's own shading and corner marks are drawn over by the
          guide square below, so they are hidden rather than doubled. */}
      <style>{`
        #${QR_READER_ID} #qr-shaded-region { display: none !important; }
        #${QR_READER_ID} video { display: block; }
      `}</style>

      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, zIndex: 3, display: 'flex', alignItems: 'center', gap: '8px', padding: 'calc(12px + var(--safe-top)) 16px 12px' }}>
        <button type="button" aria-label="Close the scanner" className="hit44" onClick={close} style={{ width: '44px', height: '44px', borderRadius: 'var(--r-pill)', border: 'none', backgroundColor: 'rgba(0,0,0,0.5)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          {Icons.x('#ffffff', 20)}
        </button>
        <h2 style={{ margin: 0, fontFamily: 'var(--font-display)', fontSize: 'var(--t-title)', fontWeight: '600', letterSpacing: '-0.005em', color: '#ffffff' }}>Scan a Flock code</h2>
      </div>

      <div style={{ flex: 1, minHeight: 0, position: 'relative', overflow: 'hidden' }}>
        {/* Laid out at DECODE_SCALE times the stage's width and drawn back at
            the stage's width, centred. The library sets its own element to
            position: relative on every start, so the placing is done by this
            wrapper, which it never touches. */}
        <div
          aria-hidden="true"
          style={{
            position: 'absolute',
            left: 0,
            top: '50%',
            width: `${DECODE_SCALE * 100}%`,
            transform: `translateY(-${50 / DECODE_SCALE}%) scale(${1 / DECODE_SCALE})`,
            transformOrigin: 'top left',
          }}
        >
          <div id={QR_READER_ID} />
        </div>
        {looking && (
          <div
            aria-hidden="true"
            style={{
              position: 'absolute',
              left: '50%',
              top: '50%',
              width: guideSide ? `${guideSide}px` : 'min(70vw, 300px)',
              height: guideSide ? `${guideSide}px` : 'min(70vw, 300px)',
              transform: 'translate(-50%, -50%)',
              borderRadius: 'var(--r-xl)',
              border: '2px solid rgba(255,255,255,0.9)',
              boxShadow: '0 0 0 9999px rgba(0,0,0,0.45)',
              opacity: phase === 'starting' || phase === 'paused' ? 0.5 : 1,
              pointerEvents: 'none',
            }}
          />
        )}
      </div>

      <div style={{ position: 'relative', zIndex: 3, padding: '16px 16px calc(16px + var(--safe-bottom))', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '12px', textAlign: 'center' }}>
        <p role="status" aria-live="polite" style={{ margin: 0, minHeight: '44px', display: 'flex', alignItems: 'center', fontSize: 'var(--t-body)', fontWeight: '600', lineHeight: 1.4, color: '#ffffff', maxWidth: '340px' }}>{status}</p>
        <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: '10px' }}>
          {action}
          {phase !== 'adding' && phase !== 'done' && (
            <button type="button" className="hit44" onClick={typeInstead} style={glassButton}>Type the code instead</button>
          )}
        </div>
      </div>
    </div>
  );
}
