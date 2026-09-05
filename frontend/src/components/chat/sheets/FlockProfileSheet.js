/**
 * THE CHAT PROFILE SHEET. Opened by tapping the chat header.
 *
 * WHAT THIS REPLACES
 * The header "Features" drawer in screens/ChatDetail.js, the six round glass
 * buttons behind the word "Features" (Birdie, Vote, Invite, Search, Cash pool,
 * More). Nothing in it is being removed from Flock. Every one of those six
 * controls has a home here or in ComposerPlusSheet.js, which is the split the
 * rebuild plan settles: this sheet holds what the chat IS (its plan, its
 * people, its money, its pins, its history and its settings) and the "+" sheet
 * holds what you SEND into the stream. The stream itself is then free to carry
 * messages and nothing else, which is the whole point of the exercise.
 *
 * The same component serves a flock and a DM. `isDm` is the only switch, and
 * the sections it removes are removed because a DM genuinely does not have
 * them: there is no plan behind a one to one thread and there is nobody to
 * invite to it. See SECTION ORDER below for exactly what differs.
 *
 * SECTION ORDER, and it is fixed
 *   Plan  (flock only)   People   Money   Pins   Media and search   Settings
 * Every section carries data-chat-section, and __tests__/chatSheets.test.js
 * reads those attributes in DOM order. The order is not decorative: it runs
 * from the thing the chat is about, out through the people in it, to the
 * housekeeping. Reordering it is a product decision, not a refactor, so the
 * test will stop you.
 *
 * PRESENTATIONAL ONLY
 * No API calls, no context, no global state, the way ChatDetail and DmDetail
 * take their 146 and 93 names as parameters. Every row's handler arrives as a
 * prop and every fact arrives already computed. Two pieces of state are local
 * and both are view state that no other screen can see: whether the "Opened
 * by" style expansions are open, and nothing else. Anything the app has to
 * remember after this sheet closes lives in the shell.
 *
 * WHY THERE IS NO SHARED DialogBehavior IMPORT
 * App.js declares DialogBehavior at module scope and does not export it. It
 * reaches ChatDetail and DmDetail as a PROP, which is why those two screens
 * can use it and components/ModerationSheet.js and components/safety/
 * EmergencySheet.js both had to write their own. This file does the same as
 * those two: useSheetDialog below is a self-contained focus trap with the same
 * behaviour. It also accepts the real helper as an optional `DialogBehavior`
 * prop, so once the integration pass has it in hand it can pass it down and
 * the local trap stands aside rather than firing Escape twice.
 *
 * MEASUREMENTS AND WHY
 *   Sheet geometry is ChatDetail's own: 20px top corners, 20px padding, a
 *   40x4 grabber, backdrop at rgba(0,0,0,0.7), aligned to the bottom edge.
 *   Copied so this sheet and the ones still inline in the screen cannot be
 *   told apart while both exist.
 *   position: fixed, not the absolute those inline sheets use. Absolute
 *   resolves against whatever positioned ancestor App.js happens to provide;
 *   a component in components/ cannot know that, and EmergencySheet already
 *   made this call for the same reason.
 *   z-index 150. Above the chat's own inline sheets (50) and DELIBERATELY
 *   below ModerationSheet and PaywallSheet (200), because Report and Block are
 *   reachable from a member row here and the report sheet has to land on top
 *   of this one rather than under it.
 *   Rows are 44 minimum (Apple HIG, WCAG 2.5.5). Group labels sit outside
 *   their container and rows are divided by inset hairlines, never one card
 *   per row: SLOP-AUDIT section S, rules 1, 3 and 4.
 *   Rule 2 of that section is why so many rows take a `value`: a row whose
 *   destination holds a current value shows that value inline rather than
 *   making the user navigate to find out what it is set to.
 *
 * NO FAKE STATES
 * A presence dot renders only for a presence string the caller actually
 * supplied. A money row renders only when there is a pool or a bill. A media
 * count renders only when it is a number. An absence is written as an absence
 * ("No place yet") and never as a zero or a shrug, and every empty section
 * says what to do next instead of sitting there blank.
 */
import React, { useEffect, useRef } from 'react';
import Icons from '../../ui/Icons';
import './sheets.css';

/* Focusable-descendant selector, mirroring App.js's DialogBehavior and
   EmergencySheet's copy of it. Kept identical on purpose: three traps that
   disagree about what is focusable are three different Tab orders. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), '
  + 'select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), '
  + '[contenteditable="true"]';

/**
 * Lower the keyboard for a sheet that is about to rise over it.
 *
 * This is not incidental and it does not belong in the focus trap. Both sheets
 * open from a chat screen where the field is focused and the keyboard is
 * already up (that is the point of the keyboard workstream), and a bottom
 * sheet rising into a keyboard on an iPhone gets its bottom half eaten.
 * Blurring the active element is what actually lowers it in a WKWebView; there
 * is no other API for it from the web side.
 *
 * It lives in ChatSheet rather than in useSheetDialog because the trap stands
 * aside when the integration pass hands down App.js's DialogBehavior, and that
 * helper does not blur anything. Left inside the trap, the one dismissal that
 * matters would disappear on the exact path that ships.
 */
function useKeyboardDismiss(open) {
  useEffect(() => {
    if (!open) return;
    // Guarded: blurring something that is not a text control would steal focus
    // from a button for no reason.
    const active = document.activeElement;
    const tag = active && active.tagName ? active.tagName.toLowerCase() : '';
    if (tag === 'input' || tag === 'textarea' || (active && active.isContentEditable)) {
      try { active.blur(); } catch { /* detached */ }
    }
  }, [open]);
}

/**
 * Focus in on open, trap Tab, close on Escape, put focus back on close.
 *
 * The keyboard dismissal that used to live in here is useKeyboardDismiss
 * above, for the reason written on it.
 */
export function useSheetDialog(sheetRef, onClose, enabled = true) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!enabled) return undefined;
    const node = sheetRef.current;
    if (!node) return undefined;
    const restoreTo = document.activeElement;

    const focusables = () => {
      const all = Array.from(node.querySelectorAll(FOCUSABLE));
      const visible = all.filter((el) => el.offsetWidth > 0 || el.offsetHeight > 0);
      // jsdom measures every box at 0x0, and a real browser never reaches the
      // fallback. Same note as EmergencySheet, same reason.
      return visible.length > 0 ? visible : all;
    };

    // One tick late, matching DialogBehavior: the sheet animates in and a few
    // rows render after a state settle.
    const t = setTimeout(() => {
      if (node.contains(document.activeElement) && document.activeElement !== document.body) return;
      // The sheet, not the first row. The first row of the flock sheet opens
      // the plan screen and "open sheet, press Enter" must not navigate.
      try { node.focus({ preventScroll: true }); } catch { /* detached */ }
    }, 0);

    const onKeyDown = (e) => {
      // Only keys aimed at this sheet. A dialog stacked ABOVE this one binds
      // its own capture-phase keydown on document (ModerationSheet and
      // PaywallSheet both do, and Report opens from a member row here), and
      // window capture runs BEFORE document capture, so without this check the
      // covered sheet would swallow the visible modal's Escape and trap Tab in
      // controls nobody can see. App.js's DialogBehavior solves the same thing
      // with its openDialogNodes stack, which a component outside App.js
      // cannot reach. A key with no element behind it (window, document, the
      // body) still belongs to the top-most trap, which is this one.
      const from = e.target;
      const onAnElement = from && typeof from.nodeType === 'number'
        && from !== document && from !== document.body && from !== document.documentElement;
      if (onAnElement && !node.contains(from)) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        // Both calls, for the reason EmergencySheet writes out: App.js binds
        // its own capture-phase keydown on document, and a same-target
        // listener is not stopped by stopPropagation alone. Without these an
        // Escape here would also dismiss whatever is underneath.
        e.stopPropagation();
        e.stopImmediatePropagation();
        if (onCloseRef.current) onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      e.stopPropagation();
      const list = focusables();
      if (list.length === 0) { e.preventDefault(); node.focus({ preventScroll: true }); return; }
      const i = list.indexOf(document.activeElement);
      if (i === -1) {
        e.preventDefault();
        (e.shiftKey ? list[list.length - 1] : list[0]).focus();
      } else if (e.shiftKey && i === 0) {
        e.preventDefault();
        list[list.length - 1].focus();
      } else if (!e.shiftKey && i === list.length - 1) {
        e.preventDefault();
        list[0].focus();
      }
    };
    // window in the capture phase runs before document, which is how this acts
    // as the top-most dialog without being in App.js's private dialog stack.
    window.addEventListener('keydown', onKeyDown, true);

    return () => {
      clearTimeout(t);
      window.removeEventListener('keydown', onKeyDown, true);
      if (restoreTo && document.contains(restoreTo) && typeof restoreTo.focus === 'function') {
        try { restoreTo.focus({ preventScroll: true }); } catch { /* gone */ }
      }
    };
    // Mount and unmount only. Re-running the trap on every prop change is how
    // DialogBehavior once grabbed focus back on each render.
  }, [enabled, sheetRef]);
}

/**
 * The bottom-sheet shell both sheets in this folder use.
 *
 * Exported from this file rather than a seventh file of its own because the
 * workstream owns exactly five paths and a duplicated focus trap is a worse
 * outcome than one named export crossing between two files that already ship
 * together. ComposerPlusSheet imports { ChatSheet } from here.
 */
export function ChatSheet({
  open,
  onClose,
  label,
  title,
  subtitle,
  children,
  maxHeight = '86%',
  DialogBehavior = null,
  testId,
}) {
  const sheetRef = useRef(null);
  // The injected helper does the whole job when it is there. Running both
  // would close the sheet twice on one Escape. Coerced to a real boolean: a
  // default parameter treats an undefined `open` as "enabled", which is the
  // opposite of what an unset prop means here.
  useSheetDialog(sheetRef, onClose, !!(open && !DialogBehavior));
  // Runs on BOTH paths, which is the whole reason it is not in the hook.
  useKeyboardDismiss(!!open);

  if (!open) return null;

  return (
    <div
      className="cs-backdrop"
      onClick={(e) => { if (e.target === e.currentTarget) onClose?.(); }}
    >
      <div
        ref={sheetRef}
        className="cs-sheet"
        data-testid={testId}
        role={DialogBehavior ? undefined : 'dialog'}
        aria-modal={DialogBehavior ? undefined : 'true'}
        aria-label={DialogBehavior ? undefined : label}
        tabIndex={-1}
        style={{ maxHeight }}
      >
        {/* Inside the sheet, not beside it. DialogBehavior resolves its target
            as its own marker's parentElement, so mounted under .cs-backdrop it
            stamps role="dialog", aria-modal and the label onto the
            full-viewport overlay and traps Tab there, while the three lines
            above deliberately strip those same attributes off the sheet. The
            result would be an unnamed div for the sheet and a dialog
            announcement for the transparent backdrop. */}
        {DialogBehavior ? <DialogBehavior onClose={onClose} label={label} /> : null}
        {/* Drag affordance. Decorative: the sheet is dismissed by the close
            button, the backdrop and Escape, all of which are real controls. */}
        <div className="cs-grabber" aria-hidden="true" />
        <div className="cs-head">
          <div className="cs-head-text">
            <h2 className="cs-title">{title}</h2>
            {subtitle ? <p className="cs-subtitle">{subtitle}</p> : null}
          </div>
          <button
            type="button"
            aria-label="Close"
            className="hit44 cs-close"
            onClick={onClose}
          >
            {Icons.x('currentColor', 18)}
          </button>
        </div>
        <div className="cs-body">{children}</div>
      </div>
    </div>
  );
}

/* A labelled group. The label sits OUTSIDE the container (section S rule 4)
   and groups are separated by the sheet's own background (rule 3).
   `id` becomes data-chat-section, and there are exactly six of those. Invited
   is a SUB-group inside People rather than a seventh section, because a
   pending invite is part of the people story and promoting it would put a
   seventh heading into an order the test pins at six. */
function Group({ id, label, children, footer, extra }) {
  return (
    <section className="cs-group" data-chat-section={id}>
      <h3 className="cs-group-label">{label}</h3>
      <div className="cs-rows">{children}</div>
      {footer ? <p className="cs-group-foot">{footer}</p> : null}
      {extra}
    </section>
  );
}

/**
 * One row. 44 minimum, hairline underneath, value inline left of the chevron.
 *
 * `value` is section S rule 2: a row whose destination holds a current value
 * shows it here, so nobody has to navigate to find out what something is set
 * to. It renders only when the caller passes one, because a row that prints
 * "None" over a value the app never loaded is the fake state this whole
 * rebuild is trying to stop.
 */
function Row({
  glyph,
  label,
  value,
  onClick,
  danger = false,
  chevron = true,
  trailing = null,
  ariaLabel,
}) {
  return (
    <button
      type="button"
      className={danger ? 'cs-row cs-row-danger' : 'cs-row'}
      onClick={onClick}
      aria-label={ariaLabel}
    >
      {glyph ? <span className="cs-row-icon" aria-hidden="true">{glyph('currentColor', 17)}</span> : null}
      <span className="cs-row-label">{label}</span>
      {value ? <span className="cs-row-value">{value}</span> : null}
      {trailing}
      {chevron ? <span className="cs-row-chev" aria-hidden="true">{Icons.chevronRight('currentColor', 15)}</span> : null}
    </button>
  );
}

/* A two-state row. role="switch" rather than a checkbox: it takes effect the
   moment it is flipped, there is no form to submit. */
function SwitchRow({ glyph, label, checked, onChange, description }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={!!checked}
      className="cs-row"
      onClick={() => onChange?.(!checked)}
    >
      {glyph ? <span className="cs-row-icon" aria-hidden="true">{glyph('currentColor', 17)}</span> : null}
      <span className="cs-row-label">
        {label}
        {description ? <span className="cs-row-desc">{description}</span> : null}
      </span>
      <span className={checked ? 'cs-switch cs-switch-on' : 'cs-switch'} aria-hidden="true">
        <span className="cs-switch-knob" />
      </span>
    </button>
  );
}

/* Presence, and only presence the caller could actually prove.
   'in_chat' means the socket says they have this thread open, 'online' means
   they are connected somewhere. Anything else, including undefined, draws
   nothing at all: the flock header carried a hardcoded "online" literal wired
   to no data for months and it was one of the three defects the ChatDetail
   extraction had to fix. */
const PRESENCE_TEXT = { in_chat: 'In the chat', online: 'Online' };

function MemberRow({ member, onOpen }) {
  const presence = PRESENCE_TEXT[member.presence] || null;
  const colour = member.color || 'var(--text-secondary)';
  return (
    <button
      type="button"
      className="cs-row cs-member"
      onClick={() => onOpen?.(member)}
      /* The role travels with the name. An aria-label REPLACES the row's
         visible content, so leaving roleLabel out of it announced the host as
         plain "Maya, In the chat" and there was no way to hear who the host
         was. It is also WCAG 2.5.3: the visible word has to be in the name. */
      aria-label={[member.name, member.roleLabel, presence].filter(Boolean).join(', ')}
    >
      <span className="cs-avatar" aria-hidden="true" style={{ borderColor: colour }}>
        {member.avatarUrl
          ? <img src={member.avatarUrl} alt="" className="cs-avatar-img" />
          : <span className="cs-avatar-initial" style={{ color: colour }}>{(member.name || '?').charAt(0).toUpperCase()}</span>}
      </span>
      <span className="cs-row-label">
        {member.name}
        {member.roleLabel ? <span className="cs-row-desc">{member.roleLabel}</span> : null}
      </span>
      {presence ? (
        <span className="cs-presence">
          <span className={member.presence === 'in_chat' ? 'cs-dot cs-dot-here' : 'cs-dot'} aria-hidden="true" />
          {presence}
        </span>
      ) : null}
      <span className="cs-row-chev" aria-hidden="true">{Icons.chevronRight('currentColor', 15)}</span>
    </button>
  );
}

export default function FlockProfileSheet({
  open,
  onClose,
  // Flock or DM. The only switch in the file.
  isDm = false,
  title,
  subtitle,
  DialogBehavior = null,

  // PLAN. Flock only, and null is a legitimate value: a flock with nothing
  // settled yet still opens this sheet.
  plan = null,               // { timeLabel, venueLabel, statusLabel }
  onOpenPlan,

  // PEOPLE
  members = [],              // [{ id, name, color, avatarUrl, presence, roleLabel }]
  onOpenMember,
  onAddMembers,              // opens the invite flow the app already has
  invited = [],              // [{ id, name, avatarUrl, pulseLabel }]

  // MONEY. One summary line each, already formatted by the shell, because the
  // shell is the only place that knows whether the budget has settled and
  // whether the published figure is a band or a total.
  pool = null,               // { line, valueLabel }
  onOpenPool,
  bill = null,               // { line, valueLabel }
  onOpenBill,

  // PINS
  pins = [],                 // [{ id, preview }]
  onJumpToPin,
  onUnpinMessage,

  // MEDIA AND SEARCH
  onSearchInChat,            // docks the existing search field under the header
  onOpenMedia,
  mediaCount = null,         // a number, or null when nobody has counted

  // SETTINGS
  notificationsLabel = null, // "On", "Off", or null when the status is unknown
  onOpenNotifications,
  muted = false,
  onToggleMute,
  onLeave,                   // leave the flock, or delete the conversation
}) {
  const peopleLabel = isDm ? 'Person' : 'People';
  const leaveLabel = isDm ? 'Delete this conversation' : 'Leave this flock';
  const hasMoney = !!(pool || bill);

  return (
    <ChatSheet
      open={open}
      onClose={onClose}
      label={`About ${title}`}
      title={title}
      subtitle={subtitle}
      DialogBehavior={DialogBehavior}
      testId="flock-profile-sheet"
    >
      {/* PLAN. A DM has no plan, so the section is absent rather than empty. */}
      {!isDm && (
        <Group id="plan" label="Plan">
          <div className="cs-facts">
            <div className="cs-fact">
              <span className="cs-fact-key">When</span>
              <span className="cs-fact-val">{plan?.timeLabel || 'No time set'}</span>
            </div>
            <div className="cs-fact">
              <span className="cs-fact-key">Where</span>
              <span className="cs-fact-val">{plan?.venueLabel || 'No place yet'}</span>
            </div>
            {plan?.statusLabel ? (
              <div className="cs-fact">
                <span className="cs-fact-key">Status</span>
                <span className="cs-fact-val">{plan.statusLabel}</span>
              </div>
            ) : null}
          </div>
          <Row glyph={Icons.calendar} label="Open the plan" onClick={onOpenPlan} />
        </Group>
      )}

      {/* PEOPLE, and INVITED inside it. A pending invite is not a member, so
          the two never share a list (that is how a roster count goes wrong),
          but they do share the section, because they are one question. */}
      <Group
        id="people"
        label={peopleLabel}
        footer={!isDm && members.length === 0 ? 'Nobody has joined yet. Add people below.' : null}
        extra={!isDm && invited.length > 0 ? (
          <div data-chat-subsection="invited">
            <h4 className="cs-group-label cs-subgroup-label">Invited</h4>
            <div className="cs-rows">
              {invited.map((p) => (
                <div key={p.id} className="cs-row cs-row-static">
                  <span className="cs-avatar" aria-hidden="true">
                    {p.avatarUrl
                      ? <img src={p.avatarUrl} alt="" className="cs-avatar-img" />
                      : <span className="cs-avatar-initial">{(p.name || '?').charAt(0).toUpperCase()}</span>}
                  </span>
                  <span className="cs-row-label">
                    {p.name}
                    {/* The availability pulse, and only when the shell passed
                        one. App.js already drops a pulse past its expires_at,
                        which is why this is a plain string and not a timestamp
                        to format here. */}
                    {p.pulseLabel ? <span className="cs-row-desc">{p.pulseLabel}</span> : null}
                  </span>
                  <span className="cs-row-value">Waiting</span>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      >
        {/* First, not last. The rebuild plan puts the invite route at the top
            of this section by name, and it is the one row here that is an
            action rather than a person: below a roster of eight it reads as a
            ninth member. */}
        {!isDm && onAddMembers ? (
          <Row glyph={Icons.userPlus} label="Add members" onClick={onAddMembers} />
        ) : null}
        {members.map((m) => (
          <MemberRow key={m.id} member={m} onOpen={onOpenMember} />
        ))}
      </Group>

      {/* MONEY. One summary line each, and the section is absent when there is
          neither a pool nor a bill. An empty "$0.00" here would be a number the
          server never published. */}
      {hasMoney && (
        <Group id="money" label="Money">
          {pool ? (
            <Row
              glyph={Icons.dollar}
              label={pool.line}
              value={pool.valueLabel}
              onClick={onOpenPool}
            />
          ) : null}
          {bill ? (
            <Row
              glyph={Icons.creditCard}
              label={bill.line}
              value={bill.valueLabel}
              onClick={onOpenBill}
            />
          ) : null}
        </Group>
      )}

      {/* PINS */}
      <Group
        id="pins"
        label="Pins"
        footer={pins.length === 0 ? 'Nothing pinned yet. Press and hold a message to pin it.' : null}
      >
        {pins.map((pin) => (
          <div key={pin.id} className="cs-row cs-row-split">
            <button
              type="button"
              className="cs-row-main"
              onClick={() => onJumpToPin?.(pin)}
            >
              <span className="cs-row-icon" aria-hidden="true">{Icons.pinFilled('currentColor', 15)}</span>
              <span className="cs-row-label cs-clip">{pin.preview}</span>
            </button>
            <button
              type="button"
              className="hit44 cs-icon-btn"
              aria-label={`Unpin ${pin.preview}`}
              onClick={() => onUnpinMessage?.(pin)}
            >
              {Icons.x('currentColor', 15)}
            </button>
          </div>
        ))}
      </Group>

      {/* MEDIA AND SEARCH */}
      <Group id="media" label="Media and search">
        <Row glyph={Icons.search} label="Search in chat" onClick={onSearchInChat} />
        <Row
          glyph={Icons.image}
          label="Photos in this chat"
          // Only when somebody counted. A zero we did not measure reads as
          // "there are none", which is a different sentence.
          value={typeof mediaCount === 'number' ? String(mediaCount) : null}
          onClick={onOpenMedia}
        />
      </Group>

      {/* SETTINGS */}
      <Group id="settings" label="Settings">
        <Row
          glyph={Icons.bell}
          label="Notifications"
          value={notificationsLabel}
          onClick={onOpenNotifications}
        />
        <SwitchRow
          glyph={Icons.moon}
          label="Mute this chat"
          description={muted ? 'No pushes from here' : null}
          checked={muted}
          onChange={onToggleMute}
        />
        <Row
          glyph={Icons.logout}
          label={leaveLabel}
          onClick={onLeave}
          danger
          chevron={false}
        />
      </Group>
    </ChatSheet>
  );
}
