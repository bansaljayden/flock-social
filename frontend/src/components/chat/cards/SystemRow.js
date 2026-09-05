/**
 * THE SYSTEM ROW, AND THE THREE PRIMITIVES EVERY CARD IN THIS FOLDER SHARES.
 *
 * WHAT IT IS. The centred grey line the stream records a plan event on.
 * "Maya set the venue: Kome". "Time moved to 8:30". "Sam joined". "You unsent
 * a message". "Ava says they're OK". It is drawn at the measured notice type
 * from CHAT-REBUILD-PLAN.md: uppercase, tracked, on a 20 pitch, and it reads
 * the size, the pitch and the grey from the module's own tokens
 * (--chat-notice-size, --chat-notice-line, --chat-notice, all declared on
 * :root in chat.css) instead of restating them. MessageGroup draws the plain
 * system sentence from those same three, so the same event cannot end up at
 * two sizes and two cases in one stream depending on which path drew it.
 * No background, 6px vertical and 16px horizontal padding, one line, with the
 * value that actually changed printed in the navy accent.
 *
 * WHAT IT REPLACES. Today none of these events are in the stream at all. A
 * venue change repaints a 72pt banner above the first message, a time change
 * repaints the plan bar, a join changes a number in the header, and an unsend
 * removes the row and leaves nothing behind. The rebuild plan moves all of
 * them here as centred rows, because the stream is the record and the header
 * is the state.
 *
 * WHY `parts` AND NOT A SENTENCE. The parent hands over an array of pieces,
 * never assembled prose:
 *
 *     <SystemRow kind="venue_set" parts={[
 *       { text: 'Maya set the venue: ' },
 *       { text: 'Kome', accent: true },
 *     ]} />
 *
 * Three reasons, and the third is the one that matters. First, the accent is
 * per piece, so this component decides what navy means instead of parsing a
 * string for it. Second, a money piece is `{ money: 40 }` and gets formatted
 * here, so no caller ever writes `${'$'}${amount}` into a template and ships
 * "$undefined" the day the server withholds the figure. Third, a caller that
 * has to name its pieces cannot accidentally concatenate a value it does not
 * have: a piece whose text is empty, or whose money is not a finite number,
 * is dropped, and a row left with no pieces renders nothing at all rather
 * than an empty grey line the reader has to interpret.
 *
 * THE THREE PRIMITIVES BELOW, and why they live in this file. This workstream
 * owns exactly eight files and no more, and CardShell, MemberAvatar and
 * formatMoney are each needed by two or more of the other six. Putting them
 * in the folder's lowest level file means every import points one way, at
 * this file, and there is no cycle to unpick. The integration pass should
 * know they are here, so it is written at the top of the file rather than
 * buried beside them.
 */
import React from 'react';
import './cards.css';

/* ===========================================================================
 * formatMoney
 *
 * The ONLY place a dollar figure becomes a string in this folder. Money is
 * never assembled in JSX, because every way of doing that has already shipped
 * a bug in this app: `$${amount.toFixed(2)}` throws on a withheld figure,
 * `$${amount}` prints "$16.9", and `${'$'}${amount ?? ''}` prints a bare
 * dollar sign, which routes/billing.js deliberately withholds figures to
 * avoid (a shell bill under three submissions publishes null, not a number,
 * so that the budget ceiling cannot be read back off it).
 *
 * A value that is not a finite number returns null, and null is the caller's
 * signal to print no figure and no label around it. It is never the string
 * "null", never "$0.00", and never a dash.
 *
 * WHY THE TRAILING .00 IS TRIMMED. "$84.50" keeps its cents and "$40" does
 * not grow a pair it never had. Every figure in the rebuild plan is written
 * that way ("Bill $84.50", "Estimated share $40", "Settle up $16.90",
 * "Commit $40") and a card that prints "$40.00" beside a plan that says "$40"
 * is a card somebody will retype by hand later.
 * ========================================================================= */
export const formatMoney = (value) => {
  const n = typeof value === 'number' ? value : Number.NaN;
  if (!Number.isFinite(n)) return null;
  const body = Math.abs(n).toFixed(2);
  const trimmed = body.endsWith('.00') ? body.slice(0, -3) : body;
  return `${n < 0 ? '-' : ''}$${trimmed}`;
};

/* ===========================================================================
 * CardShell
 *
 * Every card in the stream: full width less a 16px gutter each side, radius
 * 16, padding 14, one hairline, no bubble tail and no sender name. Those are
 * measured from the capture and they are the same on all six cards on
 * purpose, so a bill and a poll read as the same class of object.
 *
 * The WHOLE CARD is the tap target when `onOpen` is given, which is why the
 * word "View" appears nowhere in this folder: a card with a View button is a
 * card that has told you its body is not tappable. It is a div with
 * role="button" rather than a <button>, because every one of these cards
 * carries its own controls inside it and a button inside a button is invalid
 * markup that browsers resolve by dropping the inner one. The repo already
 * uses that pattern for the vote rows in ChatDetail.js, keyboard handler and
 * all, and this is the same shape.
 *
 * `tone="settled"` is the green ground a fully settled bill turns, driven by
 * the server's `fullySettled` and never by counting rows the viewer can see.
 * `tone="alert"` is the red ground the SOS card takes, the one card in the
 * stream that has to be findable by somebody scrolling fast (rebuild plan,
 * SOS: "a red system card"). Three tones and no more, because a tone is a
 * claim about state and each one has to be something the server said.
 * ========================================================================= */
const TONES = {
  default: { bg: 'var(--chat-card-bg)', border: 'var(--chat-card-border)' },
  settled: { bg: 'var(--chat-card-settled-bg)', border: 'var(--chat-card-settled-border)' },
  alert: { bg: 'var(--chat-card-alert-bg)', border: 'var(--chat-card-alert-border)' },
};

export function CardShell({
  tone = 'default',
  onOpen,
  ariaLabel,
  className = '',
  style,
  children,
  ...rest
}) {
  const tappable = typeof onOpen === 'function';
  const paint = TONES[tone] || TONES.default;

  // Only a key pressed ON the shell opens the card. Every card in this folder
  // puts real buttons inside the shell (Settle up, Commit, Undo, Try again,
  // Vote, Pin, Stop, Lock it in) and their keydown bubbles to here. Without
  // this guard the preventDefault below cancels the focused button's own
  // activation and opens the card instead, so the primary action of every
  // card was unreachable by keyboard whenever onOpen was supplied. Their
  // stop() helpers only cover click, which is why the mouse path was fine.
  const onKeyDown = tappable
    ? (e) => {
      if (e.target !== e.currentTarget) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onOpen(e);
      }
    }
    : undefined;

  return (
    <div
      className={`chat-card${tappable ? ' chat-card-tappable' : ''}${className ? ` ${className}` : ''}`}
      data-card-tone={tone}
      role={tappable ? 'button' : undefined}
      tabIndex={tappable ? 0 : undefined}
      aria-label={tappable ? ariaLabel : undefined}
      onClick={tappable ? onOpen : undefined}
      onKeyDown={onKeyDown}
      style={{
        margin: '6px 16px',
        padding: '14px',
        borderRadius: '16px',
        backgroundColor: paint.bg,
        border: `1px solid ${paint.border}`,
        boxSizing: 'border-box',
        ...style,
      }}
      {...rest}
    >
      {children}
    </div>
  );
}

/* ===========================================================================
 * MemberAvatar
 *
 * One person in an avatar row, at whatever size the card asks for. The ring
 * is that member's colour, which arrives as a prop the way the message runs'
 * name and bar colours do: this folder never picks a colour for a person and
 * never derives one from a name.
 *
 * A photo is used when the card was given one. There is no generated avatar
 * service and no placeholder face; a member with no photo gets the first
 * letter of their name on the cream ground, which is what the rest of the app
 * does.
 *
 * ACCESSIBILITY. The badge is the whole point of the row, so it is in the
 * accessible name rather than left to colour: "Maya, settled", "Sam,
 * pre-committed", "Ava". A row of avatars where the only difference between
 * two people is a green tick and an amber dot is unreadable to roughly one
 * reader in twelve, and SLOP-AUDIT section N settled that argument for toasts
 * on exactly the same grounds.
 * ========================================================================= */
const BADGE_LABEL = {
  settled: 'settled',
  committed: 'pre-committed',
  near: 'nearby',
  onTheWay: 'on the way',
};

export function MemberAvatar({
  name,
  src,
  color,
  size = 28,
  badge = null,
  style,
}) {
  const label = badge && BADGE_LABEL[badge]
    ? `${name || 'Member'}, ${BADGE_LABEL[badge]}`
    : (name || 'Member');
  const initial = (name || '').trim().charAt(0).toUpperCase();
  const badgeSize = Math.max(10, Math.round(size * 0.4));

  return (
    <div
      role="img"
      aria-label={label}
      style={{
        position: 'relative',
        width: `${size}px`,
        height: `${size}px`,
        flexShrink: 0,
        ...style,
      }}
    >
      <div
        style={{
          width: '100%',
          height: '100%',
          borderRadius: '50%',
          overflow: 'hidden',
          backgroundColor: 'var(--bg-tertiary)',
          border: color ? `1.5px solid ${color}` : '1.5px solid var(--chat-card-border)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          boxSizing: 'border-box',
        }}
      >
        {src ? (
          <img
            src={src}
            alt=""
            loading="lazy"
            decoding="async"
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          />
        ) : (
          <span
            aria-hidden="true"
            style={{
              fontSize: `${Math.max(9, Math.round(size * 0.42))}px`,
              fontWeight: 600,
              color: color || 'var(--text-secondary)',
              lineHeight: 1,
            }}
          >
            {initial}
          </span>
        )}
      </div>

      {badge === 'settled' && (
        <span
          aria-hidden="true"
          style={{
            position: 'absolute',
            right: '-1px',
            bottom: '-1px',
            width: `${badgeSize}px`,
            height: `${badgeSize}px`,
            borderRadius: '50%',
            backgroundColor: 'var(--accent-green-text)',
            border: '1.5px solid var(--chat-card-bg)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxSizing: 'border-box',
          }}
        >
          <svg width={badgeSize - 5} height={badgeSize - 5} viewBox="0 0 24 24" fill="none" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" style={{ stroke: 'var(--chat-on-fill)' }}>
            <path d="M4 12.5 9.5 18 20 7.5" />
          </svg>
        </span>
      )}

      {/* A dot, not a second tick. Amber is "said yes but has not done it"
          (pre-committed on a bill, on the way to the venue); green is "is
          there". The check is reserved for money that has actually moved,
          because that is the only one of the four a person would be annoyed
          to see claimed wrongly. */}
      {(badge === 'committed' || badge === 'onTheWay' || badge === 'near') && (
        <span
          aria-hidden="true"
          style={{
            position: 'absolute',
            right: '-1px',
            bottom: '-1px',
            width: `${Math.max(8, badgeSize - 3)}px`,
            height: `${Math.max(8, badgeSize - 3)}px`,
            borderRadius: '50%',
            backgroundColor: badge === 'near' ? 'var(--accent-green-text)' : 'var(--accent-amber-text)',
            border: '1.5px solid var(--chat-card-bg)',
            boxSizing: 'border-box',
          }}
        />
      )}
    </div>
  );
}

/* ===========================================================================
 * SystemRow
 * ========================================================================= */

// A piece renders when it has something real to say. An empty string is not a
// piece and a money value the server withheld is not a piece, which is what
// keeps a row from printing a lone "$" or a trailing colon with nothing after
// it.
const pieceText = (part) => {
  if (!part || typeof part !== 'object') return null;
  if (Object.prototype.hasOwnProperty.call(part, 'money')) return formatMoney(part.money);
  if (typeof part.text === 'string' && part.text.length > 0) return part.text;
  return null;
};

export default function SystemRow({ kind = 'event', parts, onTap, ariaLabel }) {
  const list = Array.isArray(parts) ? parts : [];
  const drawn = list
    .map((part, i) => ({ key: i, text: pieceText(part), accent: !!part?.accent }))
    .filter((p) => p.text !== null);

  // Nothing to say, so nothing is drawn. A system row that renders an empty
  // grey line is a row the reader has to work out, and the plan's rule is that
  // a receipt only exists when the server can back it.
  if (drawn.length === 0) return null;

  // data-accent is not decoration. jsdom drops a var() colour off an inline
  // style, so the only way a test can prove the changed value is the accented
  // one is a marker in the DOM. It costs one attribute and it is the
  // difference between an assertion and a hope.
  const body = drawn.map((p) => (
    <span
      key={p.key}
      data-accent={p.accent ? 'true' : undefined}
      style={p.accent
        ? { color: 'var(--chat-accent)', fontWeight: 600 }
        : undefined}
    >
      {p.text}
    </span>
  ));

  const shared = {
    className: 'chat-system-row',
    'data-system-kind': kind,
    style: {
      display: 'block',
      width: '100%',
      textAlign: 'center',
      padding: '6px 16px',
      margin: 0,
      fontSize: 'var(--chat-notice-size)',
      lineHeight: 'var(--chat-notice-line)',
      fontWeight: 600,
      letterSpacing: '0.7px',
      textTransform: 'uppercase',
      color: 'var(--chat-notice)',
      background: 'none',
      border: 'none',
      boxSizing: 'border-box',
    },
  };

  if (typeof onTap === 'function') {
    // A REAL 44px box, not the .hit44 overlay. .chat-system-row sets
    // overflow: hidden for its ellipsis, and index.css's own note on the class
    // says a host that clips its own overflow swallows the pseudo element and
    // has to carry the box itself. 12 + the 20 pitch + 12 is 44 exactly, so
    // the text still sits on the stream's rhythm. The class stays because it
    // is how the rest of the app marks a control as a 44pt target and the
    // accessibility sweeps read it; with a real box behind it max(100%, 44px)
    // resolves to the button and the overlay changes nothing.
    //
    // fontFamily rather than `font: inherit`: the shorthand also resets
    // line-height, which threw away the 20 pitch shared.style had just set,
    // and only the size and the weight were being put back after it.
    return (
      <button
        type="button"
        {...shared}
        className={`${shared.className} hit44`}
        aria-label={ariaLabel}
        onClick={onTap}
        style={{
          ...shared.style,
          cursor: 'pointer',
          fontFamily: 'inherit',
          padding: '12px 16px',
          minHeight: '44px',
        }}
      >
        {body}
      </button>
    );
  }

  return <div {...shared}>{body}</div>;
}
