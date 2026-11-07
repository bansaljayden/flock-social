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
 */
import React from 'react';
import Icons from '../ui/Icons';
import { liftNestField, dropNestField } from '../../lib/nestKeyboard';

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
    <section data-nest-band="birdie" aria-labelledby="nest-birdie-title" style={{ marginBottom: '28px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
        <h2 id="nest-birdie-title" style={{ margin: 0, fontSize: 'var(--t-body)', fontWeight: '600', color: 'var(--text-primary)' }}>Ask Birdie</h2>
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
          <div style={{ backgroundColor: 'var(--bg-card-solid)', borderRadius: '12px', overflow: 'hidden' }}>
            <div data-nest-birdie-field="" style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: '10px', minHeight: '52px', padding: '0 12px' }}>
              <img src={isDark ? '/birdie-avatar.png' : '/birdie-avatar-light.png'} alt="" style={{ width: '28px', height: '28px', borderRadius: '999px', objectFit: 'cover', flexShrink: 0, background: isDark ? '#162046' : '#e8eaf0' }} />
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
                enterKeyHint="send"
                placeholder="Ask about a place or a night out"
                autoComplete="off"
                maxLength={maxChars}
                defaultValue={inputValueRef.current || ''}
                onFocus={(e) => { liftNestField(e); onFocusField(); }}
                onBlur={dropNestField}
                onInput={(e) => {
                  inputValueRef.current = e.target.value;
                  const has = !!e.target.value;
                  if (has !== inputHasTextRef.current) { inputHasTextRef.current = has; setInputHasText(has); }
                }}
                onKeyDown={(e) => { if (e.key === 'Enter') onSend(); }}
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
                style={{ position: 'absolute', right: '10px', top: '10px', width: '32px', height: '32px', borderRadius: '999px', border: 'none', backgroundColor: 'var(--btn-primary-bg)', color: 'var(--btn-primary-fg)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: canSend ? 'pointer' : 'default', opacity: inputHasText ? 1 : 0, transition: 'opacity 150ms ease', pointerEvents: inputHasText ? 'auto' : 'none' }}
              >
                <svg aria-hidden="true" focusable="false" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="12" y1="19" x2="12" y2="5" /><polyline points="5 12 12 5 19 12" />
                </svg>
              </button>
            </div>
            {chips.map((text) => (
              <button
                type="button"
                key={text}
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
