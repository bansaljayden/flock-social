/**
 * "FLOCK WAS UPDATED" ON A SHEET THAT DID NOT LOAD.
 *
 * Nine overlays in App.js are fetched the first time they open (the wrap-up
 * sheet, the event page, the pay sheets, the results list, the venue sheet,
 * Birdie, the report sheet, Flock Pro, the venue sign-in), and each one's
 * loader resolves a failed download to a "This did not load" sheet with a way
 * out that re-arms it, so the next tap asks the network again. That is right
 * when the download died on a weak connection. It is wrong for a tab left open
 * across a deploy, past the 30 days the site keeps earlier builds' files: the
 * file is gone from the site, and every later tap asks for the same missing
 * file. Only a reload gets that tab the overlay.
 *
 * So the sheet asks the site, once, with the same two questions the crash net
 * asks (lib/staleBuild.js): is the file that failed still there, and if not,
 * is the site on a newer build than this tab. Only a newer build draws
 * anything here: the line the crash cards use and a Reload button. Every
 * other answer, and no answer, draws nothing, and the sheet reads as it did.
 *
 * THE RELOAD IS THE PERSON'S. The crash net reloads by itself because the
 * screen it covers has already crashed. These sheets open over a live screen,
 * a chat with a half-typed message among them, so nothing here reloads
 * without a press.
 */
import React, { useEffect, useState } from 'react';
import { checkStaleBuild, NEWER_BUILD_NOTE } from '../../lib/staleBuild';

const reloadPage = () => window.location.reload();

export default function NewerBuildNote({ error, check = checkStaleBuild, reload = reloadPage }) {
  const [newer, setNewer] = useState(false);

  useEffect(() => {
    if (!error) return undefined;
    // The site answers seconds later; a sheet closed by then sets nothing.
    let open = true;
    Promise.resolve()
      .then(() => check(error))
      .then((state) => { if (open && state === 'newer') setNewer(true); })
      .catch(() => { /* no answer is the sheet as it was */ });
    return () => { open = false; };
  }, [error, check]);

  if (!newer) return null;
  return (
    <div data-newer-build="" style={{ margin: '0 0 12px' }}>
      <p role="status" style={{ fontSize: 'var(--t-label)', lineHeight: 1.55, fontWeight: '600', color: 'var(--text-primary)', margin: '0 0 12px' }}>
        {NEWER_BUILD_NOTE}
      </p>
      <button
        type="button"
        className="hit44"
        onClick={reload}
        style={{ width: '100%', padding: '13px', borderRadius: 'var(--r-md)', border: 'none', background: 'var(--text-primary)', color: 'var(--bg-card-solid)', fontSize: 'var(--t-body)', fontWeight: '600', cursor: 'pointer' }}
      >
        Reload the app
      </button>
    </div>
  );
}
