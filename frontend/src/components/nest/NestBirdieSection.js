/**
 * ASK BIRDIE, AS PART OF THE NEST'S PAGE (2026-11-06).
 *
 * Birdie was a disc floating over the list that opened a panel over the page:
 * on a brand-new account the open panel covered everything under the painted
 * birds, Start a flock and Add friends included, and left about 230px for the
 * answer. Now Birdie is a section of the page. At rest it says what Birdie is
 * before anyone types (the Terms' own Gemini sentence, at full strength), and
 * offers a field and a suggestion or two that are questions about the
 * person's own plans. Its answers render here, in the page, with the page's
 * full height, and the actions above stay where they are.
 *
 * This file is the resting state only, and it does not import BirdiePanel:
 * that is a fetched chunk, and the Nest's first paint must not pay for it.
 * App.js renders the panel's inline presentation into `inline` once there is
 * something to show (the consent question, or a thread), and warms the chunk
 * on the first focus or the first suggestion tap.
 *
 * The field writes the same refs Birdie's own box writes (aiInputValueRef and
 * aiInputHasTextRef), so a question typed here is the question sent.
 *
 * BEFORE THE ACCOUNT HAS SAID YES TO GEMINI the field is read-only and a tap
 * on it (or Enter, or Space) asks for that yes in its place, without the
 * field ever taking focus. It used to take focus and then be unmounted under
 * the consent question by that same focus: on iOS the keyboard started to
 * rise and dropped again, the first thing a new Birdie user saw, and a
 * keyboard user's focus fell to the top of the page. Tabbing onto it asks
 * nothing; Enter does.
 *
 * WHILE THE DAY'S MESSAGES ARE SPENT the field is off and says why, with the
 * time they come back and Get Flock Pro where it is sold: the composer's own
 * line (BirdiePanel.js OUT OF CHIRPS). The field used to take a question and
 * send nothing, with no thread open to say so.
 */
import React from 'react';
import Icons from '../ui/Icons';
import { liftNestField, dropNestField } from '../../lib/nestKeyboard';
import { birdieBackText } from '../../lib/meterResets';
import { BAND_HEAD, BAND_GAP } from './nestBand';

// The Terms' own words (BirdiePanel.js's empty state carries the same
// sentence; birdieDisclosurePinned.test.js holds the two to it).
export const BIRDIE_STANDFIRST = "Birdie is an assistant built on Google's Gemini. Its answers are generated and can be wrong.";
// Its first sentence alone, for while the section shows something that says
// the second itself: the consent question ends on "Answers are generated and
// can be wrong.", and so does the line under every answer. Said twice on one
// screen (three times with the consent card) it read as boilerplate pasted
// in, not something meant.
export const BIRDIE_GEMINI_LINE = "Birdie is an assistant built on Google's Gemini.";

const textLink = {
  minHeight: '44px',
  padding: 0,
  border: 'none',
  background: 'none',
  color: 'var(--accent-purple-text)',
  fontSize: 'var(--t-label)',
  fontWeight: '600',
  cursor: 'pointer',
};

export default function NestBirdieSection({
  sectionRef,
  consented = true,
  onAskConsent,
  outOfChirps = false,
  dailyLimit = null,
  resetsAt = null,
  onGetPro = null,
  isDark,
  inline,
  hasThread,
  showLastAnswer,
  onShowLastAnswer,
  onNewChat,
  newChatDisabled,
  chips,
  onChip,
  inputRef,
  inputValueRef,
  inputHasText,
  inputHasTextRef,
  setInputHasText,
  maxChars,
  onFocusField,
  onSend,
  canSend,
}) {
  return (
    <section ref={sectionRef} data-nest-band="birdie" aria-labelledby="nest-birdie-title" style={{ marginBottom: BAND_GAP }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
        <h2 id="nest-birdie-title" style={{ ...BAND_HEAD, margin: 0 }}>Ask Birdie</h2>
        {hasThread && (
          <button type="button" className="hit44" onClick={onNewChat} disabled={newChatDisabled} style={{ ...textLink, minHeight: '32px', opacity: newChatDisabled ? 0.5 : 1 }}>New chat</button>
        )}
      </div>
      <p data-birdie-standfirst="" style={{ margin: '4px 0 10px', fontSize: 'var(--t-label)', fontWeight: '500', lineHeight: 1.45, color: 'var(--text-secondary)' }}>{inline ? BIRDIE_GEMINI_LINE : BIRDIE_STANDFIRST}</p>

      {inline || (
        <>
          {/* Done kept the thread; this brings it back where it was. */}
          {showLastAnswer && (
            <button type="button" onClick={onShowLastAnswer} style={{ ...textLink, display: 'block', margin: '-6px 0 2px' }}>Show the last answer</button>
          )}
          <div style={{ backgroundColor: 'var(--bg-card-solid)', borderRadius: 'var(--r-md)', overflow: 'hidden' }}>
            {/* The field sets no outline: its keyboard ring is drawn on this
                row, inside the card that clips it (index.css
                .nest-birdie-field), and the suggestions below draw theirs
                inside themselves the same way (.nest-row-btn). */}
            <div data-nest-birdie-field="" className="nest-birdie-field" style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: '10px', minHeight: '52px', padding: '0 12px' }}>
              <img src={isDark ? '/birdie-avatar.png' : '/birdie-avatar-light.png'} alt="" style={{ width: '28px', height: '28px', borderRadius: 'var(--r-pill)', objectFit: 'cover', flexShrink: 0, background: isDark ? '#162046' : '#e8eaf0' }} />
              {/* Uncontrolled, seeded from the ref: aiInputValueRef holds the
                  typed text of record, the same as Birdie's own box. 16px on
                  a field (the --t-body floor in index.css), so iOS does not
                  zoom the page when it takes focus. */}
              {/* The send circle sits over the field's end rather than taking
                  room beside it, so the whole placeholder fits at 320. */}
              <input
                ref={inputRef}
                className="nest-birdie-input"
                type="text"
                aria-label="Ask Birdie"
                aria-describedby={outOfChirps ? 'nest-birdie-spent' : undefined}
                enterKeyHint="send"
                placeholder="Ask about a place or a night out"
                autoComplete="off"
                maxLength={maxChars}
                readOnly={!consented}
                disabled={outOfChirps}
                defaultValue={inputValueRef.current || ''}
                onPointerDown={consented ? undefined : (e) => { e.preventDefault(); if (onAskConsent) onAskConsent(); }}
                onFocus={consented ? (e) => { liftNestField(e); onFocusField(); } : undefined}
                onBlur={consented ? dropNestField : undefined}
                onInput={(e) => {
                  inputValueRef.current = e.target.value;
                  const has = !!e.target.value;
                  if (has !== inputHasTextRef.current) { inputHasTextRef.current = has; setInputHasText(has); }
                }}
                onKeyDown={(e) => {
                  if (!consented) {
                    if ((e.key === 'Enter' || e.key === ' ') && onAskConsent) { e.preventDefault(); onAskConsent(); }
                    return;
                  }
                  if (e.key === 'Enter') onSend();
                }}
                style={{ flex: 1, minWidth: 0, height: '44px', padding: inputHasText ? '0 40px 0 0' : 0, border: 'none', outline: 'none', background: 'transparent', color: 'var(--text-primary)', fontSize: 'var(--t-body)', fontWeight: '500' }}
              />
              <button
                type="button"
                aria-label="Send"
                className="hit44"
                onClick={onSend}
                disabled={!canSend}
                tabIndex={inputHasText ? undefined : -1}
                aria-hidden={inputHasText ? undefined : 'true'}
                style={{ position: 'absolute', right: '10px', top: '10px', width: '32px', height: '32px', borderRadius: 'var(--r-pill)', border: 'none', backgroundColor: 'var(--btn-primary-bg)', color: 'var(--btn-primary-fg)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: canSend ? 'pointer' : 'default', opacity: inputHasText ? 1 : 0, transition: 'opacity 150ms ease', pointerEvents: inputHasText ? 'auto' : 'none' }}
              >
                {Icons.send('currentColor', 15)}
              </button>
            </div>
            {outOfChirps && (
              <div role="status" id="nest-birdie-spent" style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: '12px', padding: '10px 14px 12px 16px' }}>
                <span aria-hidden="true" style={{ position: 'absolute', top: 0, left: '16px', right: 0, height: '1px', backgroundColor: 'var(--divider)' }} />
                <p style={{ flex: 1, minWidth: 0, margin: 0, fontSize: 'var(--t-label)', fontWeight: '500', lineHeight: 1.4, color: 'var(--text-secondary)' }}>
                  {Number.isFinite(dailyLimit) ? `You've used today's ${dailyLimit} messages.` : "You've used today's messages."} They come back {birdieBackText(resetsAt)}.
                </p>
                {onGetPro && (
                  <button type="button" className="hit44" onClick={onGetPro} style={{ flexShrink: 0, minHeight: '36px', padding: '0 14px', border: 'none', borderRadius: 'var(--r-md)', backgroundColor: 'var(--btn-primary-bg)', color: 'var(--btn-primary-fg)', fontSize: 'var(--t-label)', fontWeight: '600', cursor: 'pointer', whiteSpace: 'nowrap' }}>Get Flock Pro</button>
                )}
              </div>
            )}
            {chips.map((text) => (
              <button
                type="button"
                key={text}
                className="nest-row-btn"
                onClick={() => onChip(text)}
                style={{ position: 'relative', width: '100%', minHeight: '44px', padding: '11px 14px 11px 18px', border: 'none', background: 'none', display: 'flex', alignItems: 'center', gap: '14px', textAlign: 'left', cursor: 'pointer', color: 'var(--text-primary)', fontSize: 'var(--t-body)', fontWeight: '500', lineHeight: 1.35 }}
              >
                <span aria-hidden="true" style={{ position: 'absolute', top: 0, left: '50px', right: 0, height: '1px', backgroundColor: 'var(--divider)' }} />
                <span aria-hidden="true" style={{ display: 'flex', flexShrink: 0 }}>{Icons.search('var(--accent-purple-text)', 16)}</span>
                <span style={{ minWidth: 0 }}>{text}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
