import React from 'react';

/**
 * The app's crash net.
 *
 * Before this existed, a single throw anywhere inside the App tree unmounted
 * the whole React root and left a blank white screen. On the web that reads as
 * "the site is down"; inside the Capacitor shell there is no URL bar and no
 * pull-to-refresh, so the only way out was force-quitting the app. It has
 * already happened in production once (see the normalizeVotes note in App.js,
 * where a guest-link vote payload set flock.votes to undefined and crashed the
 * render).
 *
 * Why this is hand-rolled instead of Sentry.ErrorBoundary: importing
 * @sentry/react at module scope pulls the entire SDK into the entry chunk even
 * on builds that have no DSN configured. This class reports through the exact
 * same SDK, but loads it on demand and only when there is a DSN AND something
 * has actually crashed. See index.js for the matching lazy Sentry.init.
 *
 * REUSABLE ON PURPOSE. index.js wraps the whole tree in one of these, which is
 * the last line of defence: it catches everything, including a failed lazy
 * chunk load after a deploy, but the only recovery it can offer is a full
 * reload. App.js now mounts SECOND-LEVEL instances around the screen renderer
 * and the persistent Discover layer (search for ScreenSlot there), so a crash
 * in one screen no longer tears down the socket, the session or the
 * already-loaded flocks: the tab bar keeps working and the user keeps their
 * place instead of rebooting the app.
 *
 * Props:
 *   label     string   identifies the boundary in logs and Sentry tags
 *   onReset   fn       optional. When given, a secondary button calls it and
 *                      clears the error so the subtree re-renders in place.
 *   resetLabel string  copy for that secondary button
 *   resetKey  any      optional. When this value changes while the boundary is
 *                      showing its fallback, the error is dropped and the
 *                      children get another go. App.js passes the identity of
 *                      the screen being shown, so navigating away from a
 *                      crashed screen and back does not arrive at a permanent
 *                      error state. Compared with Object.is: pass a string or
 *                      a number, never a fresh object.
 *   fallback  fn|node  optional override. As a function it receives
 *                      { error, eventId, reload, reset }.
 */
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null, eventId: null };
    this._mounted = false;
    this.reload = this.reload.bind(this);
    this.reset = this.reset.bind(this);
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidMount() {
    this._mounted = true;
  }

  componentWillUnmount() {
    this._mounted = false;
  }

  // Navigating away from a crashed screen and back must not land on the error
  // state again. The boundary around App.js's screen switch never unmounts (it
  // is the same element for every screen), so without this the first crash
  // would pin the fallback over every screen the switch can render.
  //
  // Clearing here rather than in getDerivedStateFromProps is deliberate: this
  // runs after the fallback has painted, and the re-render it triggers is the
  // one that re-mounts the children. If they throw again straight away the
  // boundary catches again, and prevProps.resetKey now equals this.props one,
  // so it stops. No loop.
  componentDidUpdate(prevProps) {
    if (!this.state.error) return;
    if (Object.is(prevProps.resetKey, this.props.resetKey)) return;
    this.setState({ error: null, eventId: null });
  }

  componentDidCatch(error, info) {
    const label = this.props.label || 'root';
    // Console first and unconditionally. Sentry is best-effort; a crash must
    // always leave a trace someone can read off a device log.
    console.error(`[ErrorBoundary:${label}]`, error, info && info.componentStack);

    if (!process.env.REACT_APP_SENTRY_DSN) return; // silent when unconfigured
    import('@sentry/react')
      .then((Sentry) => {
        const eventId = Sentry.captureException(error, {
          tags: { boundary: label },
          contexts: { react: { componentStack: info && info.componentStack } },
        });
        // The reference id is the one thing that turns "it crashed" into a
        // searchable report, so surface it to the user.
        //
        // Still-the-same-error check: the SDK loads asynchronously, and with
        // resetKey in play the boundary can have recovered, or crashed on a
        // different screen, before this resolves. Without it the app would
        // print one crash's reference under another crash's message.
        if (eventId && this._mounted && this.state.error === error) this.setState({ eventId });
      })
      .catch(() => { /* reporting must never crash the fallback */ });
  }

  reload() {
    window.location.reload();
  }

  reset() {
    this.setState({ error: null, eventId: null });
    if (typeof this.props.onReset === 'function') this.props.onReset();
  }

  render() {
    const { error, eventId } = this.state;
    if (!error) return this.props.children;

    // Development: hand the error straight back to React. Swallowing it here
    // would replace CRA's error overlay (real stack, real source, live
    // reload on fix) with a polite card that hides the bug. React re-throws
    // to window.onerror once no boundary handles it, which is what the
    // overlay listens for.
    if (process.env.NODE_ENV === 'development') throw error;

    if (typeof this.props.fallback === 'function') {
      return this.props.fallback({ error, eventId, reload: this.reload, reset: this.reset });
    }
    if (this.props.fallback) return this.props.fallback;

    const canReset = typeof this.props.onReset === 'function';

    // A failed lazy chunk is a network event, not a bug: the download died on
    // weak signal, or a deploy replaced the file mid-session. Say that, and
    // if the device knows it is offline right now, say reloading can wait.
    const isChunkError = !!error && (
      error.name === 'ChunkLoadError' ||
      /Loading (CSS )?chunk/i.test(error.message || '')
    );
    const offlineNow = typeof navigator !== 'undefined' && navigator.onLine === false;

    return (
      <div style={styles.screen} role="alert">
        <div style={styles.card}>
          <h1 style={styles.title}>{isChunkError ? "Part of the app didn't load" : 'The app hit an error'}</h1>
          {isChunkError ? (
            <p style={styles.body}>
              A piece of the app didn't finish downloading. That happens on a
              weak connection, or right after we ship an update. Nothing of
              yours is lost.
            </p>
          ) : (
            <p style={styles.body}>
              This screen stopped working and had to close. Your account, your flocks
              and your messages are saved on the server. Anything you were typing here
              is gone.
            </p>
          )}
          <p style={styles.body}>
            {offlineNow
              ? "You're offline right now. Reload once you're back on signal."
              : 'Reloading gets you back in.'}
          </p>

          <div style={styles.actions}>
            <button
              type="button"
              onClick={this.reload}
              className="glass-btn glass-primary"
              style={styles.button}
            >
              Reload the app
            </button>
            {canReset && (
              <button
                type="button"
                onClick={this.reset}
                className="glass-btn glass-secondary"
                style={styles.button}
              >
                {this.props.resetLabel || 'Go back'}
              </button>
            )}
          </div>

          <p style={styles.detail}>
            {error && error.message ? error.message : 'Unknown error'}
          </p>
          {eventId && <p style={styles.detail}>Reference {eventId}</p>}
        </div>
      </div>
    );
  }
}

// Inline styles, all off the index.css tokens, so the fallback follows the
// active theme and the safe-area contract without needing App.js's makeStyles
// (which lives inside the component that just crashed).
const styles = {
  screen: {
    minHeight: '100vh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    boxSizing: 'border-box',
    padding: 'calc(24px + var(--safe-top)) 20px calc(24px + var(--safe-bottom))',
    background: 'var(--bg-primary)',
    color: 'var(--text-primary)',
    fontFamily: 'var(--font-body)',
  },
  card: {
    width: '100%',
    maxWidth: 360,
    boxSizing: 'border-box',
    background: 'var(--bg-card-solid)',
    border: '1px solid var(--border-color)',
    borderRadius: 16,
    boxShadow: 'var(--card-shadow)',
    padding: 24,
  },
  title: {
    margin: '0 0 10px',
    fontSize: 20,
    fontWeight: 600,
    letterSpacing: '-0.01em',
    color: 'var(--text-primary)',
  },
  body: {
    margin: '0 0 12px',
    fontSize: 14,
    lineHeight: 1.55,
    color: 'var(--text-secondary)',
  },
  actions: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 8,
    margin: '18px 0 0',
  },
  button: {
    flex: '1 1 140px',
    padding: '12px 16px',
    borderRadius: 12,
    fontSize: 14,
    fontWeight: 600,
  },
  detail: {
    margin: '14px 0 0',
    fontSize: 11,
    lineHeight: 1.5,
    wordBreak: 'break-word',
    color: 'var(--text-tertiary)',
  },
};

export default ErrorBoundary;
