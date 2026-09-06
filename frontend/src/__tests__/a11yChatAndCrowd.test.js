/**
 * THE 2026-08-27 ACCESSIBILITY AUDIT'S FIXES, PINNED.
 *
 * Four defects this file keeps closed, each found by walking the app the way
 * a VoiceOver or keyboard user meets it:
 *
 *   1. Chat message actions were pointer-only: the reaction/reply/report row
 *      opened from an onClick on a plain div, so a screen-reader or keyboard
 *      user could never react to, reply to, or report a specific message (the
 *      per-content Guideline 1.2 surface). Every row carries a named button
 *      into the same menu now, the photo is named whether or not it opens,
 *      and the reaction pills are labeled, pressed-state buttons. Both chats
 *      draw one MessageRow rather than two bubbles that had drifted, so the
 *      assertions read the module and the screens are read for the wiring
 *      that keeps the door reachable at all.
 *   2. Keyboard focus was invisible on every text field in dark mode: the
 *      forced focus border was #1e293b, the dark theme's own input
 *      background, 1.00:1, and the rule's outline:none also defeated the
 *      :focus-visible ring. The fields now borrow the same --focus-ring token
 *      the button sweep installed.
 *   3. The safety receive modal declared role=alertdialog with no dialog
 *      behavior at all: nothing moved focus in, trapped Tab, handled Escape,
 *      or restored focus, on a dialog that arrives unprompted over a socket.
 *      It rides DialogBehavior now like every other overlay. (The sweep's
 *      derived-overlay scan missed it because its fixed lookahead window
 *      credited the NEIGHBORING modal's DialogBehavior to this one; that scan
 *      remains to be tightened, recorded here so the debt is findable.)
 *   4. Crowd readings were 12px text painted in the raw crowd hues, which
 *      measure 1.8 to 3.8:1 on the light surfaces (the sweep's own
 *      accent-as-text class, reintroduced through the computed crowdColorFor
 *      rather than the palette literals its guard matches). Text sites take
 *      crowdInkFor now; the saturated hue stays on the dot or bar beside it.
 */

const fs = require('fs');
const path = require('path');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8').replace(/\r\n/g, '\n');
const APP = read('App.js');
const CHAT = read('screens', 'ChatDetail.js');
const DM = read('screens', 'DmDetail.js');
/* THE MESSAGE ROW AND THE SCROLLER ARE `components/chat` NOW. Both screens
   stopped drawing their own bubble, their own photo and their own reaction
   pills and hand those to one module, so defect 1 above is pinned in the file
   that draws it, once, instead of twice in two screens that had drifted. The
   screens are still read for the half they kept: each has to WIRE the actions
   door, or the row has no way in at all. */
const ROW = read('components', 'chat', 'MessageRow.js');
const LIST = read('components', 'chat', 'MessageList.js');

describe('chat message actions are reachable without a pointer', () => {
  test('both screens still open the actions menu the row reports', () => {
    // A row draws its keyboard door only when a handler exists for it, so a
    // screen that stopped passing one would take the door away silently.
    // Same handler, passed through a stable wrapper for the row memo.
    expect(CHAT).toMatch(/onLongPress=\{stableLongPress\}/);
    expect(CHAT).toMatch(/const stableLongPress = useStableFn\(\(m, detail\) => openMessageActions\(m, detail\)\)/);
    expect(DM).toMatch(/onLongPress=\{openDmActions\}/);
  });

  test('every row carries a real button for its actions, not a press on a div', () => {
    // The press itself is a pointer gesture and always will be. What makes it
    // reachable is this: a focusable, named button in the row that opens the
    // same menu, so a screen-reader or keyboard user can react to, reply to or
    // report one specific message.
    expect(ROW).toMatch(/<button\s*\n\s*type="button"\s*\n\s*className="chat-actions-key"/);
    expect(ROW).toMatch(/onClick=\{\(\) => fireLongPress\('keyboard'\)\}/);
    // Named per message, so twenty of them in a thread are not twenty
    // identical announcements.
    expect(ROW).toContain("{isMine ? 'Actions for your message' : `Actions for ${who}'s message`}");
  });

  test('the photo in a row is named whether or not it opens', () => {
    // With a viewer the button carries the name and the image stays silent;
    // with no viewer there is no button, so the alt text is all a screen
    // reader has.
    expect(ROW).toContain("aria-label={isMine ? 'Open the photo you sent' : `Open the photo from ${who}`}");
    expect(ROW).toContain("alt={isMine ? 'Photo you sent' : `Photo from ${who}`}");
  });

  test('reaction pills are labeled buttons with pressed state, on both surfaces', () => {
    expect(ROW).toMatch(/aria-pressed=\{canTellMine \? mine : undefined\}/);
    expect(ROW).toMatch(/aria-label=\{`\$\{r\.emoji\} \$\{counted\}\$\{owned\}\$\{action\}`\}/);
    // Both screens still hand the row a tap handler, which is what earns the
    // pill the words "Tap to react" in the first place.
    expect(CHAT).toMatch(/onReactionTap=\{/);
    expect(DM).toMatch(/onReactionTap=\{toggleDmReaction\}/);
    // The old span pill is gone from both screens and did not come back.
    expect(CHAT).not.toMatch(/<span key=\{g\.emoji\} onClick/);
    expect(DM).not.toMatch(/<span key=\{g\.emoji\} onClick/);
  });

  test('scrolling the thread never drops focus at all', () => {
    // onScroll used to blur document.activeElement wholesale, so tabbing to
    // any control below the fold auto-scrolled, fired scroll, and dropped the
    // focus that was just placed: keyboard users could not walk the thread.
    // The screens' narrowed version, which blurred only a field, went with
    // their scroll containers. The one scroller both threads mount now blurs
    // nothing, so there is no focus for a scroll to take.
    for (const src of [CHAT, DM]) {
      expect(src).not.toMatch(/onScroll=/);
    }
    expect(LIST).toMatch(/const onScroll = \(e\) => \{/);
    expect(LIST).not.toMatch(/\.blur\(\)/);
    expect(LIST).not.toMatch(/document\.activeElement/);
  });
});

describe('keyboard focus is visible on fields in both themes', () => {
  test('the input focus rules use the focus-ring token and keep outlines alive', () => {
    const rules = APP.match(/input:focus[^{]*\{[^}]*\}/g) || [];
    expect(rules.length).toBeGreaterThanOrEqual(2);
    for (const rule of rules) {
      expect(rule).toContain('var(--focus-ring)');
      expect(rule).not.toContain('#1e293b');
      expect(rule).not.toContain('outline: none');
    }
  });
});

describe('the safety receive modal is a managed dialog', () => {
  test('DialogBehavior sits inside the safetyAlert overlay', () => {
    const at = APP.indexOf('{safetyAlert && (');
    expect(at).toBeGreaterThan(-1);
    const overlay = APP.slice(at, at + 1200);
    expect(overlay).toContain('<DialogBehavior onClose={() => setSafetyAlert(null)}');
  });
});

describe('crowd readings are readable text, not saturated swatch hues', () => {
  test('crowdInkFor exists beside crowdColorFor and maps to the text tokens', () => {
    expect(APP).toMatch(/const crowdInkFor = \(score, c\) => \{/);
    expect(APP).toContain("'var(--accent-green-text)'");
  });

  test('the text sites take the ink and keep the hue for the swatch', () => {
    // VenueCard chat chip: percentage in ink over the hue-tinted pill.
    expect(APP).toContain('color: crowdInk, padding: ');
    // Search rows, the no-photo variant on the card background.
    expect(APP).toMatch(/color: crowdInk, backgroundColor: `\$\{crowdColor\}12`/);
    // The map mini card label.
    expect(APP).toContain('color: crowdInkFor(score, colors) || crowdColor');
  });

  test('the Top Rated chip uses the amber token pair instead of white on translucent amber', () => {
    expect(APP).not.toContain("backgroundColor: 'rgba(245,158,11,0.9)'");
    const at = APP.indexOf('Top Rated');
    const chip = APP.slice(Math.max(0, at - 600), at + 100);
    expect(chip).toContain('var(--accent-amber-bg)');
    expect(chip).toContain('var(--accent-amber-text)');
  });
});

describe('reduced motion reaches the map camera', () => {
  test('mapEase exists and every flyTo call site rides through it', () => {
    expect(APP).toMatch(/const mapEase = \(map, opts\) => \{/);
    expect(APP).toContain("window.matchMedia('(prefers-reduced-motion: reduce)')");
    // Exactly one bare map.flyTo left: the helper's own else-branch. Every
    // call SITE rides through mapEase, so the tween, the one animation the
    // global CSS reduced-motion collapse cannot reach, honors the setting.
    expect((APP.match(/map\.flyTo\(/g) || []).length).toBe(1);
  });
});

describe('small state announcements', () => {
  test('attendance rows and calendar days carry pressed state', () => {
    expect(APP).toMatch(/aria-pressed=\{!!attendanceChecks\[m\.id\]\}/);
    expect(APP).toMatch(/aria-pressed=\{isSelected\}/);
  });

  test('the flock-row unread badge has words, and the bill paid check does too', () => {
    // The dot became a count pill with the migration 056 server cursor: the
    // visible number plus this sr-only suffix read together as, say,
    // "3 unread messages", which is more announcement, not less.
    expect(APP).toContain('<span className="sr-only"> unread messages</span>');
    expect(CHAT).toContain('<span className="sr-only">Paid</span>');
  });

  test('budget, payer, and tip chips announce selection', () => {
    expect(CHAT).toMatch(/aria-pressed=\{budgetAmount === p\}/);
    expect(CHAT).toMatch(/aria-pressed=\{\(billPaidBy \|\| authUser\?\.id\) === m\.id\}/);
    expect(CHAT).toMatch(/aria-pressed=\{billTip === t\}/);
  });
});
