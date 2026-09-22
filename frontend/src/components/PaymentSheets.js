/**
 * THE PAY SHEETS. Moved out of App.js to get them off the boot path.
 *
 * WHAT MOVED. Both money sheets: the pay picker that opens when a payer taps
 * Settle Up, and the fallback sheet that catches a wallet handoff that never
 * happened. Their own explanatory comments came with them, because each one
 * records a defect this surface already shipped once.
 *
 * ONE LINE OF THOSE COMMENTS CHANGED, and it is the only textual difference
 * between this file's JSX and the block it replaced. The pay picker's header
 * comment credited a named person for the redesign, which the repo's
 * provenance rule forbids in a tracked file; it now states the design itself.
 * Every other one of the 171 moved lines is byte for byte what App.js held.
 *
 * WHY IT MOVED. App.js is 515 kB of the 606 kB boot chunk, which is 85% of the
 * bytes every launch downloads before anything is on screen. These 171 lines
 * were declared inside FlockAppInner and rendered from its root JSX, so they
 * were parsed on every launch and re-rendered on every one of that component's
 * state changes, to be shown to the small share of sessions that split a bill.
 * Nothing here is reachable on first paint: the only route in is the Settle Up
 * control inside the flock chat screen, which is itself a lazy chunk, so this
 * file can be fetched at the moment the sheet is actually wanted.
 *
 * WHAT IT STILL SEES. Nothing is read from a closure any more. Everything the
 * sheets used to reach up for arrives as a prop, listed below. Four of those
 * props are module-scope helpers in App.js rather than state: DialogBehavior,
 * paymentRoutes, paymentWebHost and openExternal. They are passed rather than
 * imported because App.js exports none of them, and because paymentRoutes is
 * also lifted out of App.js source and evaluated by two test files, which pins
 * where it is declared. The handoff race itself (attemptPaymentHandoff, and
 * startPaymentHandoff around it) deliberately stayed behind: startPaymentHandoff
 * is reached from the boot chunk, so importing it here would pull this chunk
 * back into the boot graph and buy nothing.
 *
 * No hooks are called in this file. Both sheets are pure functions of their
 * props, which is what makes the move a relocation rather than a rewrite.
 */
import React from 'react';
import Icons from './ui/Icons';
// The still mascot, not the animated one: the empty state is a photograph and
// a sentence, never a rAF loop.
import { BirdieStill } from './ui/BirdieBird';

const PaymentSheets = ({
  // Picker state.
  showPaymentPicker,
  setShowPaymentPicker,
  paymentOptions,
  // Fallback sheet state. Shape: { method, routes, reason, payTo, amount }.
  paymentFallback,
  setPaymentFallback,
  // The one entry point for tapping a payment method. It arms the handoff race
  // and is what raises the fallback sheet. It stays in App.js.
  startPaymentHandoff,
  showToast,
  // The memoized light/dark pair from App.js, not the module-scope defaults of
  // the same names, so these must be passed or both sheets go light in dark
  // mode.
  colors,
  styles,
  // Module-scope helpers in App.js, which exports none of them.
  DialogBehavior,
  paymentRoutes,
  paymentWebHost,
  openExternal,
}) => (
  <>
      {/* THE PAY SURFACE. One sheet, whatever the payee has saved.

          It used to be a stack of 40px rounded squares, each filled with that
          wallet's brand GRADIENT and holding a single letter (V, $, Z). That
          is two banned patterns in one control: the icon-in-rounded-square
          card formula (DESIGN-STANDARD A14) and a blue gradient (H2/M). It also
          only ever appeared when the payee had two or more handles saved, so
          the two states that matter most (exactly one handle, and none at all)
          had no design at all.

          What replaces it: a plain link to their Venmo, and if they have not
          got one, a bird saying so.

          The wallet rows are REAL anchors carrying the audited web link, so a
          long press copies something true and the row survives its own click
          handler never running. The click is intercepted so it still goes
          through startPaymentHandoff, which is the whole audited race: deep
          link first, and the fallback sheet when the wallet app never comes to
          the foreground. Nothing about that machinery changed here.

          Zelle is a BUTTON, not an anchor. backend/routes/billing.js builds it
          with deepLink and webLink null on purpose (Zelle lives inside each
          bank's own app and has no shared scheme), so there is no destination
          to put in an href and a link with nowhere to go is the dead control
          this file has been removing all week. It opens the instructions sheet
          through the same entry point. */}
      {showPaymentPicker && paymentOptions && (() => {
        const methods = paymentOptions.methods || [];
        const payee = typeof paymentOptions.payTo === 'string' && paymentOptions.payTo.trim()
          ? paymentOptions.payTo.trim()
          : null;
        const close = () => setShowPaymentPicker(false);
        // A handle with nothing readable in it is not a handle. The route
        // builds the display string ('@' + username), so a stored value of
        // nothing but punctuation or spaces arrives here as a bare '@'.
        const readableHandle = (h) => {
          const t = typeof h === 'string' ? h.trim() : '';
          return /[a-zA-Z0-9]/.test(t) ? t : null;
        };
        const noHandleLine = payee
          ? `${payee} has not added a Venmo, Cash App, or Zelle handle.`
          : 'They have not added a Venmo, Cash App, or Zelle handle.';
        return (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.5)', zIndex: 9999, display: 'flex', alignItems: 'flex-end', justifyContent: 'center', paddingBottom: 'var(--cb-height, 0px)', boxSizing: 'border-box' }} onClick={close}>
          <DialogBehavior onClose={close} label={`Pay ${payee || 'them'}`} />
          <div style={{ backgroundColor: 'var(--bg-card-solid)', borderRadius: '16px 16px 0 0', padding: '20px', width: '100%', maxWidth: '420px', boxSizing: 'border-box', paddingBottom: 'calc(20px + var(--safe-bottom))' }} onClick={e => e.stopPropagation()}>
            <h3 style={{ fontSize: 'var(--t-title)', fontWeight: '700', color: colors.navy, margin: '0 0 4px' }}>Pay {payee || 'them'}</h3>
            {/* The money is the same whether or not there is a link to open. */}
            <p style={{ fontSize: 'var(--t-label)', color: 'var(--text-secondary)', margin: '0 0 14px' }}>${Number(paymentOptions.amount || 0).toFixed(2)} · {paymentOptions.note}</p>
            {methods.length > 0 ? methods.map((m, i) => {
              const r = paymentRoutes(m);
              // The first saved handle leads. The rest are real rows under it,
              // quieter and ruled off, rather than a row of equal-weight tiles
              // that makes the payer read three identical things.
              const lead = i === 0;
              const handle = readableHandle(m.handle);
              const rowStyle = {
                display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px',
                width: '100%', boxSizing: 'border-box', padding: lead ? '2px 0 13px' : '13px 0',
                border: 'none', borderTop: lead ? 'none' : '1px solid var(--divider)',
                backgroundColor: 'transparent', textAlign: 'left', cursor: 'pointer',
              };
              const body = (
                <>
                  <span style={{ minWidth: 0 }}>
                    <span style={{ display: 'block', fontSize: lead ? 'var(--t-body)' : 'var(--t-label)', fontWeight: lead ? '700' : '600', color: colors.navy, textDecoration: r.webUrl ? 'underline' : 'none', textUnderlineOffset: '3px' }}>
                      {r.webUrl ? `Pay on ${m.label}` : `Pay with ${m.label}`}
                    </span>
                    {handle && (
                      <span style={{ display: 'block', marginTop: '2px', fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', overflowWrap: 'anywhere' }}>{handle}</span>
                    )}
                  </span>
                  <span style={{ flexShrink: 0, display: 'flex', alignItems: 'center' }}>
                    {r.webUrl ? Icons.externalLink('var(--text-tertiary)', 16) : Icons.chevronRight('var(--text-tertiary)', 16)}
                  </span>
                </>
              );
              return r.webUrl ? (
                <a
                  className="hit44"
                  key={m.method}
                  href={r.webUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => {
                    // The href is the honest destination and the fallback of
                    // last resort. The handler is the better route: try the
                    // wallet app first, and raise the audited sheet when the
                    // phone does nothing.
                    e.preventDefault();
                    startPaymentHandoff(m, paymentOptions);
                    close();
                  }}
                  style={rowStyle}
                >
                  {body}
                </a>
              ) : (
                <button className="hit44" type="button" key={m.method} onClick={() => {
                  startPaymentHandoff(m, paymentOptions);
                  close();
                }} style={rowStyle}>
                  {body}
                </button>
              );
            }) : (
              // Nothing to link to, so nothing that looks like a control. The
              // app cannot make somebody add a handle, so it does not pretend
              // to offer that; it says the true thing and stops. Marking the
              // debt paid another way is on the screen behind this sheet.
              <div style={{ display: 'flex', alignItems: 'center', gap: '14px', padding: '2px 0 4px' }}>
                <BirdieStill size={64} style={{ flexShrink: 0 }} />
                <p style={{ margin: 0, fontSize: 'var(--t-label)', color: 'var(--text-secondary)', lineHeight: 1.5 }}>{noHandleLine}</p>
              </div>
            )}
            <button className="hit44" type="button" onClick={close} style={{ width: '100%', padding: '12px', border: 'none', borderTop: '1px solid var(--divider)', backgroundColor: 'transparent', color: 'var(--text-secondary)', fontSize: 'var(--t-label)', fontWeight: '600', cursor: 'pointer', marginTop: '10px' }}>Close</button>
          </div>
        </div>
        );
      })()}

      {/* The wallet app never came to the foreground, or there was never one to
          open. Either way the payer is owed an explanation and a route that
          works, instead of a tap that did nothing. See attemptPaymentHandoff. */}
      {paymentFallback && (() => {
        const { method: fm, routes: fr, reason, payTo, amount } = paymentFallback;
        const label = fm?.label || 'that app';
        const host = paymentWebHost(fr?.webUrl);
        const close = () => setPaymentFallback(null);
        return (
          <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.5)', zIndex: 9999, display: 'flex', alignItems: 'flex-end', justifyContent: 'center', paddingBottom: 'var(--cb-height, 0px)', boxSizing: 'border-box' }} onClick={close}>
            <DialogBehavior onClose={close} label={`Pay ${payTo || 'them'} with ${label}`} />
            <div style={{ backgroundColor: 'var(--bg-card-solid)', borderRadius: '16px 16px 0 0', padding: '20px', width: '100%', maxWidth: '420px', paddingBottom: 'calc(20px + var(--safe-bottom))' }} onClick={e => e.stopPropagation()}>
              <h3 style={{ fontSize: 'var(--t-title)', fontWeight: '700', color: colors.navy, margin: '0 0 8px' }}>
                {reason === 'instructions' ? `Pay ${payTo || 'them'} with ${label}` : `${label} did not open`}
              </h3>
              <p style={{ fontSize: 'var(--t-label)', color: 'var(--text-secondary)', margin: '0 0 14px', lineHeight: 1.5 }}>
                {reason === 'instructions'
                  ? (fr?.instructions || `Send ${fm?.handle || payTo} the money in ${label}, then come back here.`)
                  : `Nothing happened when your phone tried to open ${label}. That usually means it is not installed on this device.`}
              </p>
              {typeof amount === 'number' && (
                <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)', margin: '0 0 14px' }}>
                  You owe ${amount.toFixed(2)}{fm?.handle ? ` to ${fm.handle}` : ''}.
                </p>
              )}
              {fr?.webUrl && (
                <button className="hit44 glass-btn glass-primary" onClick={() => {
                  // A fresh tap, so this window.open is inside a user gesture
                  // and WKWebView will hand it to the system. That is the whole
                  // reason the fallback is a prompt and not an automatic
                  // redirect on the timeout.
                  openExternal(fr.webUrl);
                  close();
                  showToast('After paying, tap "Mark as paid"');
                }} style={{ ...styles.gradientButton, padding: '14px', marginBottom: '8px' }}>
                  {host ? `Pay on ${host}` : `Pay ${label} in your browser`}
                </button>
              )}
              {!fr?.webUrl && reason === 'no-handoff' && (
                <p style={{ fontSize: 'var(--t-label)', color: 'var(--text-secondary)', margin: '0 0 14px', lineHeight: 1.5 }}>
                  Install {label}, or pay {fm?.handle || payTo} another way and mark it paid below.
                </p>
              )}
              <button className="hit44" onClick={close} style={{ width: '100%', padding: '12px', border: 'none', backgroundColor: 'transparent', color: 'var(--text-secondary)', fontSize: 'var(--t-label)', fontWeight: '600', cursor: 'pointer' }}>
                Close
              </button>
            </div>
          </div>
        );
      })()}
  </>
);

export default PaymentSheets;
