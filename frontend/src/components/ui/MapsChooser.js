// "Open in": the choice of maps app behind every Directions button.
//
// App Review rejected 1.0 under Guideline 4 on 2026-10-07 because every way
// from the app to a map went to Google Maps, and asked for the option to
// launch Apple Maps. lib/mapsLinks.js builds the links and decides their
// order; this is the sheet that offers them. App.js mounts the one
// MapsChooserHost and hands it DialogBehavior (focus, Tab and Escape), the
// same way the extracted screens receive it, and any button anywhere calls
// openMapsChooser.
import React from 'react';
import { mapsChoices } from '../../lib/mapsLinks';

let present = null;

// noopener, as App.js openExternal does: a page opened with window.open keeps
// a handle back to this one unless it is told not to. In the iOS app the
// shell hands the url to the system, which opens Apple Maps for a
// maps.apple.com link and Google Maps (or Safari) for a Google one.
function openInNewWindow(url) {
  if (typeof window === 'undefined' || typeof window.open !== 'function') return false;
  window.open(url, '_blank', 'noopener,noreferrer');
  return true;
}

// Offers the maps apps for one place. `place` is { name, address, lat, lng };
// `googleUrl` is the caller's Google Maps link. Returns false when there is
// nothing to open. With no host mounted (a screen rendered on its own), the
// first choice opens directly, so the button never does nothing.
export function openMapsChooser({ place, googleUrl } = {}) {
  const choices = mapsChoices({ place, googleUrl });
  if (choices.length === 0) return false;
  if (present) {
    present(choices);
    return true;
  }
  return openInNewWindow(choices[0].url);
}

export default function MapsChooserHost({ DialogBehavior }) {
  const [choices, setChoices] = React.useState(null);
  React.useEffect(() => {
    present = setChoices;
    return () => {
      if (present === setChoices) present = null;
    };
  }, []);
  if (!choices) return null;
  const close = () => setChoices(null);
  return (
    <div
      onClick={(e) => { if (e.target === e.currentTarget) close(); }}
      style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, zIndex: 10050, backgroundColor: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}
    >
      {DialogBehavior ? <DialogBehavior onClose={close} label="Open in a maps app" /> : null}
      <div style={{ width: '100%', maxWidth: '420px', boxSizing: 'border-box', backgroundColor: 'var(--bg-card-solid)', borderRadius: '20px 20px 0 0', padding: '16px 16px calc(16px + env(safe-area-inset-bottom))', display: 'flex', flexDirection: 'column', gap: '8px' }}>
        <p style={{ margin: '0 0 4px', textAlign: 'center', color: 'var(--text-secondary)', fontSize: 'var(--t-meta)', fontWeight: '600' }}>Open in</p>
        {choices.map((c) => (
          <button
            key={c.app}
            type="button"
            className="hit44 glass-btn"
            onClick={() => { openInNewWindow(c.url); close(); }}
            style={{ minHeight: '48px', borderRadius: '12px', border: '1px solid var(--border-mid)', backgroundColor: 'var(--bg-primary)', color: 'var(--text-primary)', fontSize: 'var(--t-label)', fontWeight: '600', cursor: 'pointer' }}
          >
            {c.label}
          </button>
        ))}
        <button
          type="button"
          className="hit44"
          onClick={close}
          style={{ minHeight: '44px', borderRadius: '12px', border: 'none', background: 'none', color: 'var(--text-tertiary)', fontSize: 'var(--t-label)', fontWeight: '600', cursor: 'pointer' }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
