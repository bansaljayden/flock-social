import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { BirdieStill, BirdNote } from './ui/BirdieBird';

// Roost, the chat half of the venue advisor: a Q&A thread on the venue
// dashboard, below the insight cards.
//
// TWO WAYS IN, AND THE ANSWER ALWAYS SAYS WHICH KIND IT IS.
//
// The COMPOSER IS THE SURFACE. A box you type into is anchored at the bottom of
// the card, always drawn, always the last thing the eye lands on, exactly the
// way Birdie's box sits under Birdie's thread. Suggested questions (chips) are
// the empty state's starting points, four of them, chosen by the server from
// what this venue's data can actually answer; once a conversation exists they
// fold away behind one line, because furniture that helped you start does not
// need to sit between you and the thing you are already doing. The owner can
// ask anything about their business, and the server routes it to exactly one of
// three answers.
//
// It did not start that way. The field rendered only when the server said
// `freeText: true`, and the server said false on every deploy because both of
// its flags defaulted off, so a built and tested feature reached its owner as
// an ABSENCE: no field, no explanation, nothing to notice was missing. Both
// flags now default on (services/advisorFreeText.js), and this file no longer
// has a state where the field is gone: when the server declines, the box is
// still there, disabled, with the server's own sentence under it. A decline
// the owner can read is a decline. A decline they cannot see is a bug.
//
// Then it read as a widget rather than a conversation: a heading, a paragraph,
// four chips, a disclosure, and a thin pill squeezed in underneath. Jayden's
// words were "you actually should be typing it, like how you would type to
// ChatGPT or Claude." What changed. The composer grew into a real box that
// grows with the question. The thread became an exchange: the owner's words in
// their own bubble on their own side, Roost's answer plain and full width
// beneath it, which is how every chat that has to print long answers with
// citations under them does it. The chips receded to one line once a
// conversation exists. The explainer became a first-run line. And the thread
// stopped being thrown away every time the owner touched the tab strip above
// it.
//
//   grounded  built from typed facts about this venue, with sources and dates.
//             Renders with its source line, exactly as a chip answer does,
//             because it IS a chip answer: free text is another way to reach
//             the same pipeline, never a second pipeline.
//   advice    general trade knowledge, marked as such under the answer. Any
//             number about this venue inside it still came through the fact
//             engine, so the source line still appears when one did.
//   refusal   declined, in quieter ink, saying what is missing. A refusal is
//             the MAIN state for most venues today, not an error, and it never
//             carries an upsell.
//
// The product name and the free-text field's availability both arrive from the
// server (`name` and `freeText` on /questions), so a rename is one backend
// line and the field explains itself rather than vanishing when the server
// would decline it.
//
// WIRING (App.js, venue dashboard). Render below <VenueInsightCards ...>:
//
//   import VenueAdvisorChat from './components/VenueAdvisorChat';
//   import { getAdvisorQuestions, askAdvisor, askAdvisorQuestion } from './services/api';
//   ...
//   <VenueAdvisorChat
//     fetchQuestions={getAdvisorQuestions}
//     ask={askAdvisor}
//     askQuestion={askAdvisorQuestion}
//     colors={colors}
//   />
//
// Props are injected rather than imported (the VenueInsightCards pattern) so
// this file has no dependency on the contended api.js and tests hand it
// fixtures.

// THE BRAND IS SAID ONCE ON THIS SCREEN. VenueInsightCards titles the surface
// "Roost"; this block sits a few hundred pixels below it in the same scroll, so
// titling it "Roost" too printed the product name twice on one screen and told
// the owner nothing either time. It is titled for what it is instead. The name
// still arrives from the server for the places it belongs (the field's screen
// reader label, the locked and error states, which can be read without the
// cards above them in view), so a rename is still one backend line.
const ADVISOR_NAME = 'Roost';
const BLOCK_TITLE = 'Ask a question';

const CARD_STYLE = {
  backgroundColor: 'var(--bg-card-solid)',
  borderRadius: '12px',
  padding: '12px',
  marginBottom: '12px',
  boxShadow: 'var(--card-shadow-sm)',
};

const CHIP_STYLE = {
  display: 'inline-block',
  padding: '7px 11px',
  margin: '0 6px 6px 0',
  fontSize: 'var(--t-meta)',
  lineHeight: 1.3,
  color: 'var(--text-primary)',
  backgroundColor: 'transparent',
  border: '1px solid var(--border-light)',
  borderRadius: '10px',
  cursor: 'pointer',
  textAlign: 'left',
};

const QUIET_LINK_STYLE = {
  background: 'none',
  border: 'none',
  padding: 0,
  font: 'inherit',
  fontSize: 'var(--t-micro)',
  color: 'var(--text-tertiary)',
  textDecoration: 'underline',
  cursor: 'pointer',
};

// Human names for fact sources, mirroring the server's vocabulary. Unknown
// sources fall back to their own id with the underscores removed, so a new
// server-side source never renders as raw snake_case.
const SOURCE_LABELS = {
  intake: 'your intake',
  owner_report: 'your own readings',
  model_holdout: 'model estimate',
  user_reports: 'user reports',
  votes: 'Flock group activity',
  events: 'Ticketmaster listings',
  weather: 'weather service',
  served_prediction: 'what Flock served',
  google_baseline: "your Google profile's pattern",
  arithmetic: 'arithmetic on the facts above',
  category_pattern: 'category pattern',
};
const sourceLabel = (s) => SOURCE_LABELS[s] || String(s || '').replace(/_/g, ' ');

// One line naming every distinct source an answer used. Answers with no
// sources (refusals) render no line: a refusal quotes nothing.
const sourcesLine = (sources) => {
  if (!Array.isArray(sources) || sources.length === 0) return null;
  const seen = [];
  for (const s of sources) {
    const label = sourceLabel(s.source);
    if (!seen.includes(label)) seen.push(label);
  }
  return `From ${seen.join(', ')}.`;
};

// Answer text arrives as plain sentences (phrased) or as one line per fact
// (template). Render each line as its own paragraph either way.
// `quiet` is the refusal ink. It is also written out as data-ink because the
// CSS parser the test suite runs on drops an inline colour that is a custom
// property, so the rendered tree would otherwise not say which ink it holds.
const AnswerText = ({ text, quiet }) => (
  <>
    {String(text || '').split('\n').filter(Boolean).map((line, i) => (
      <p
        key={i}
        data-ink={quiet ? 'quiet' : 'answer'}
        style={{ fontSize: 'var(--t-label)', color: quiet ? 'var(--text-secondary)' : 'var(--text-primary)', margin: i === 0 ? 0 : '8px 0 0', lineHeight: 1.55 }}
      >
        {line}
      </p>
    ))}
  </>
);

// How the two kinds of answer are told apart, and why it is drawn twice.
//
// A grounded answer is flush with the question above it and carries its source
// line, because its sources ARE its claim to be believed. An advice answer is
// inset behind a hairline rule and carries this sentence, so the difference is
// legible before a word is read and unambiguous after. Colour alone would not
// do it: the two answers are the same ink, on purpose, because advice is not a
// lesser answer, it is a different KIND of answer.
const ADVICE_MARKER = 'General advice, not from your data.';

// What the owner reads while the server works, and WHERE they read it: in the
// thread, in the place the answer is about to occupy, not as a word printed on
// the button they just pressed. Which sentence is true depends on which door
// the question came in by: a chip is already routed, so we are genuinely
// reading their numbers. A typed question has not been routed yet, and the
// router may well send it somewhere their numbers cannot go, so promising to
// read them would be a small lie told several times a day.
const PENDING_CHIP = 'Reading your numbers…';
const PENDING_TYPED = 'Working on it…';

// BIRDIE IS PRESENT WHILE ROOST WORKS, AND ONLY VISUALLY (Jayden, build 26
// review, 2026-08-21: "have Birdie pop out when it's talking so that it feels
// interactive. Like you're not just talking to a blank wall.")
//
// He is the ANSWER'S AVATAR, the way every chat that prints long answers draws
// one: he appears the moment the question is sent, in the place the answer is
// about to occupy, and he is still standing there when it lands. He does not
// blink out of existence at the exact moment there is finally something to
// read. That is what makes the card an exchange rather than a form that
// briefly played an animation.
//
// WHAT THE MOTION IS ALLOWED TO MEAN. Exactly one thing: an answer is in
// flight. He pops in when the turn opens and bobs while the server is working,
// and the bob stops when the turn resolves. Nothing about him changes with
// WHAT resolved. A refusal gets the same bird, the same size, in the same
// place, holding just as still as a grounded answer does, because a mascot
// that looked pleased with one answer and sorry about another would be making
// a claim about an answer it has not read. Roost's answers are fact-gated and
// the bird is not a fact: he is company, never a source, and he never lets a
// declined question look like a failed one.
//
// Still photographs plus two CSS keyframes (index.css, roostPop/roostBob,
// both collapsed by the global reduced-motion rule), never the animated
// BirdieBird — that rAF loop stays on Birdie's own consumer surface
// (birdBrandMoments.test.js rule 2), because this is a work tool.
//
// 44px, not smaller. Below about 40 the photograph turns to a smudge and the
// register belongs to an icon instead (the same rule the App.js call sites are
// held to).
const AVATAR_SIZE = 44;

const ThreadTurn = ({ turn, first, navy, navyBg, onRetry }) => {
  const advice = turn.status === 'done' && turn.answer && turn.answer.mode === 'advice';
  const pending = turn.status === 'pending';
  return (
    <div
      style={{
        padding: first ? '0 0 16px' : '16px 0',
        borderTop: first ? 'none' : '1px solid var(--border-light)',
        animation: 'fadeSlideIn 0.25s ease-out',
      }}
    >
      {/* THE OWNER'S SIDE. Their own words, in their own bubble, pushed to
          their own edge. Nothing else in this card is right aligned, so the
          shape alone says who is speaking before a word is read, and the
          answer below is then free to run the full width it needs. */}
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <p
          style={{
            maxWidth: '85%',
            margin: 0,
            padding: '9px 12px',
            borderRadius: '14px',
            borderBottomRightRadius: '4px',
            backgroundColor: navyBg,
            color: 'white',
            fontSize: 'var(--t-meta)',
            fontWeight: '500',
            lineHeight: 1.45,
            textAlign: 'left',
            whiteSpace: 'pre-wrap',
            overflowWrap: 'anywhere',
          }}
        >
          {turn.question}
        </p>
      </div>
      {/* ROOST'S SIDE, and Birdie standing in it. The bird is a fixed column
          on the left of every answer, so nothing moves vertically when the
          turn goes from pending to answered: the words simply arrive under a
          bird who was already there. `flex-start` puts his head level with the
          first line and his feet a couple of lines down, which is where a
          photographed bird wants to stand. */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', margin: '10px 0 0' }}>
        <span
          /* The two classes are the ONLY difference between a turn in flight
             and a turn that has resolved. They are added when the turn opens
             and removed when it settles, whatever it settled into. */
          className={pending ? 'roost-pop' : undefined}
          data-roost="avatar"
          aria-hidden="true"
          style={{ display: 'block', flexShrink: 0 }}
        >
          <span className={pending ? 'roost-bob' : undefined} style={{ display: 'block' }}>
            <BirdieStill size={AVATAR_SIZE} eager />
          </span>
        </span>
        <div
          style={{
            flex: 1,
            minWidth: 0,
            paddingLeft: advice ? '10px' : '0px',
            // Longhand, not the `border-left` shorthand: a shorthand carrying a
            // custom property is dropped by the CSS parser the test suite runs
            // on, so the rule would be invisible to any check that it is there.
            borderLeftWidth: advice ? '2px' : '0px',
            borderLeftStyle: advice ? 'solid' : 'none',
            borderLeftColor: 'var(--border-light)',
          }}
        >
          {pending && (
            <p style={{ fontSize: 'var(--t-label)', color: 'var(--text-tertiary)', margin: 0, lineHeight: 1.55 }}>
              {turn.typed ? PENDING_TYPED : PENDING_CHIP}
            </p>
          )}
          {turn.status === 'error' && (
            <p style={{ fontSize: 'var(--t-label)', color: 'var(--text-secondary)', margin: 0, lineHeight: 1.55 }}>
              That did not go through.{' '}
              <button
                type="button"
                onClick={onRetry}
                style={{ background: 'none', border: 'none', padding: 0, font: 'inherit', color: navy, textDecoration: 'underline', cursor: 'pointer' }}
              >
                Try again
              </button>
            </p>
          )}
          {turn.status === 'done' && (
            <>
              {/* A refusal wears the same chrome as an answer: quieter ink, no
                  lock icon, no upsell, and the same bird beside it holding the
                  same still pose. The text itself says what is missing.
                  Small talk ('small_talk', a greeting answered in kind) is
                  NOT a refusal and takes the normal ink: only 'refusal' is
                  drawn quiet. */}
              <AnswerText text={turn.answer.text} quiet={turn.answer.mode === 'refusal'} />
              {advice && (
                <p style={{ fontSize: 'var(--t-micro)', color: 'var(--text-tertiary)', margin: '6px 0 0' }}>
                  {ADVICE_MARKER}
                </p>
              )}
              {sourcesLine(turn.answer.sources) && (
                <p style={{ fontSize: 'var(--t-micro)', color: 'var(--text-tertiary)', margin: '6px 0 0' }}>
                  {sourcesLine(turn.answer.sources)}
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};

// Matches services/advisorFreeText.js FREE_TEXT_MAX_CHARS. The server rejects
// anything longer with a plain message; this stops the owner writing past it in
// the first place, which is the kinder half of the same rule.
const QUESTION_MAX_CHARS = 280;
// Where the character count starts showing itself.
const COUNTER_FROM = 220;

// The composer's resting height and its ceiling. It starts at one comfortable
// line and grows with the question, instead of scrolling a long one out of
// sight inside a single line, which is the difference between a box you write
// in and a box you fill in. Past the ceiling it scrolls, because a card on a
// dashboard cannot become a page.
const COMPOSER_MIN_HEIGHT = 44;
const COMPOSER_MAX_HEIGHT = 132;

// How tall the scrollback gets before it becomes scrollback. A short thread
// just makes the card taller; a long one keeps the composer where the thumb
// left it, and the conversation above it is scrolled, not the dashboard.
const THREAD_MAX_HEIGHT = 340;

// The invitation. It names both halves of what the field takes, because an
// owner who reads "ask about your venue" will only ever ask for numbers, and
// half of what Roost is good at is the other kind of question.
const PLACEHOLDER_TEXT = 'Your numbers, or how to run the room';
const PLACEHOLDER_OFF = 'Typed questions are off right now';
// Said where the field is, not instead of it.
const FREE_TEXT_OFF_NOTE = 'Typed questions are off for now. The suggested questions above still work, and every answer they give comes from your own numbers.';
// Only ever shown to a pointer with a keyboard behind it. On a phone the send
// button is the path and the return key is drawn as Send, so printing a
// keyboard shortcut there would be advice about a key the owner cannot press.
const KEY_HINT = 'Enter sends. Shift and Enter start a new line.';

// What the card says before it has said anything else. This paragraph is
// honest and it earned its place, but it earned it ONCE: it tells a first time
// owner what kind of answers this gives. It is not a standing notice to be
// scrolled past on top of every conversation they ever have. It comes back
// whenever the thread is empty again.
const LEAD_IN_FREE = 'Answers from your own numbers name their sources and dates. Anything from the trade is marked as advice. What we cannot answer, we say so.';
const LEAD_IN_CHIPS = 'Pick a question. Every answer comes from measured data about your venue, with its sources named. What we cannot answer yet, we say so.';

// A THREAD THAT SURVIVES THE TAB STRIP ABOVE IT.
//
// The venue dashboard unmounts this card the moment the owner switches to
// Promotions, Reviews or Settings, and Roost's own cards send them to Settings
// by name. A conversation thrown away by a trip to the tab it just told you to
// take is not a conversation, it is a form that clears itself. The turns live
// in module scope, keyed to the signed in session, so a remount picks the
// thread back up and a different account never inherits one. It is memory, not
// storage: a reload starts clean, and nothing about the venue is written to
// disk.
let threadStore = { key: null, turns: [] };

// Two DIFFERENT absences, and they used to answer to one name.
//
// `NO_SESSION` is nobody signed in. `UNREADABLE_SESSION` is a realm whose
// localStorage cannot be read at all, which a browser with storage blocked
// does deterministically on every access rather than intermittently. Both used
// to return 'anon', so in a storage-blocked realm every account would have
// collapsed to one key and the identity check below would have been inert.
//
// That state is not reachable today and the separation is here so it cannot
// become reachable quietly. services/api.js reads the same key with a bare
// `localStorage.getItem('flockToken')` and no try/catch, so a realm that
// throws on read has no working API client at all: there is no browser state
// where a request can be authorised AND this function cannot see under whose
// token it went. If that ever changes, these two keys are already told apart.
const NO_SESSION = 'anon';
const UNREADABLE_SESSION = 'storage-unreadable';

const sessionKey = () => {
  try {
    return (window.localStorage.getItem('flockToken') || '').slice(-32) || NO_SESSION;
  } catch (e) {
    return UNREADABLE_SESSION;
  }
};

// WHOSE TURNS THESE ARE IS RE-READ, NOT REMEMBERED (security rounds 26 and 27).
//
// `flockToken` is a SHARED localStorage key. A second tab signing in as another
// owner overwrites it under this realm's feet, and so does an in-app sign-in
// that never unmounts this card. Two shapes of the same bug, because the fix
// for the first left the second one standing.
//
// Round 26: the hand-off stamped `sessionKey()` onto the store on every thread
// change, re-reading localStorage at the moment of the write. The next turn
// re-labelled account A's conversation with account B's key, and the next mount
// of this card restored A's thread into B's. Reading the key once at mount
// closed that.
//
// Round 27: once at mount is not enough either, because the card does not have
// to remount for the account to change. A mounted card went on DRAWING A's
// thread after the token became B's, sent A's next question with B's token
// (services/api.js reads the token at call time, on every request), and
// appended B's answer to A's live conversation. Dropping the module store,
// which is all round 26 did, does nothing about any of that: the turns React is
// rendering are held in component state, and nothing was clearing it.
//
// So identity is a live value here. It is re-read when the browser says the
// store moved, when this tab comes back to the front, on a slow tick that costs
// one localStorage read, immediately before a question is sent, and again when
// its answer lands. Any of those finding a different key drops the module
// store, the rendered thread, and whatever was half typed in the box. That
// thread is the owner's revenue, footfall and staffing numbers, and this repo
// has already had one round of parallel sessions writing to production as the
// wrong user through exactly this shared key, so it is not hypothetical.
//
// The tick is the belt to the storage event's braces, and it is here because
// the storage event is delivered to every document EXCEPT the one that wrote
// the value. Cross tab, the listener fires. Same tab, nothing fires at all, and
// a listener that covers only half the cases is the half that reads as covered.
//
// HOW LONG THE PREVIOUS ACCOUNT'S ANSWERS CAN SIT ON THE NEW ONE'S SCREEN.
//
// At two seconds they could sit there for two seconds, measured: still drawn at
// 1999ms, gone at 2001ms. Two things shortened that without buying a second
// mechanism. The first is free: this card re-reads the key on every commit of
// its own (see the effect that calls checkOwner with no dependency array), and
// an in-app sign-in re-renders the tree that owns this card, so in the case the
// tick exists for the switch is usually caught in the same frame the app
// notices it. The second is the tick itself, now 400ms, which is what covers a
// sign-in that somehow re-renders nothing here. The cost of that is one
// localStorage read every 400ms, a synchronous string fetch measured in
// microseconds, against a window in which a venue's revenue and staffing
// answers are drawn for the wrong owner.
const IDENTITY_POLL_MS = 400;

const restoreThread = () => {
  // SECURITY ROUND 5, 2026-08-20. This used to `return []` and LEAVE THE TURNS
  // IN PLACE. The read was already safe — a different key never renders
  // somebody else's thread — but the previous account's questions and Roost's
  // answers about their venue's numbers went on sitting in this tab's memory
  // for as long as the tab lived, reachable from a heap snapshot and from any
  // later code that reads threadStore without asking whose it is. This repo has
  // already been bitten once by browser-scoped state outliving the account that
  // made it (parallel agents sharing one localStorage wrote to production as
  // the wrong user), so the rule here is that a key mismatch DROPS the data
  // rather than merely declining to show it. Sign-out is not the trigger and
  // must not have to be: the next read after the session changes is.
  if (threadStore.key !== sessionKey()) {
    if (threadStore.turns.length) threadStore = { key: null, turns: [] };
    return [];
  }
  // A turn still in flight when the card unmounted will never land: its
  // promise resolves into a discarded update. It comes back as something the
  // owner can press again, never as a thinking line that thinks forever.
  return threadStore.turns.map((t) => (t.status === 'pending' ? { ...t, status: 'error' } : t));
};

// Drops the held thread. Sign out is the real caller if a screen ever wants
// one; the suite calls it between tests so one conversation cannot leak into
// the next.
export const clearAdvisorThread = () => { threadStore = { key: null, turns: [] }; };

// True only where a real keyboard is. Wrapped because jsdom has no matchMedia.
const hasKeyboardPointer = () => {
  try {
    return typeof window !== 'undefined'
      && typeof window.matchMedia === 'function'
      && window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  } catch (e) {
    return false;
  }
};

const VenueAdvisorChat = ({ fetchQuestions, ask, askQuestion, colors }) => {
  const navy = colors?.navy || 'var(--text-primary)';
  const navyBg = colors?.navyBg || navy;
  // 'loading' | 'ready' | 'locked' | 'error'
  const [state, setState] = useState('loading');
  const [name, setName] = useState(ADVISOR_NAME);
  const [lead, setLead] = useState([]);
  const [groups, setGroups] = useState([]);
  const [freeText, setFreeText] = useState(false);
  // The server's one sentence for a venue it will not answer yet (unverified
  // or unlinked), in place of a menu of chips that all refused.
  const [offReason, setOffReason] = useState('');
  const [showMore, setShowMore] = useState(false);
  const [showChips, setShowChips] = useState(false);
  const [draft, setDraft] = useState('');
  const [focused, setFocused] = useState(false);
  const [lockedReason, setLockedReason] = useState(null);
  const [thread, setThread] = useState(restoreThread);
  // Lazy initialiser: read at mount alongside restoreThread above, so the two
  // agree about whose card this is on the first render. It does not stay fixed
  // after that; see forgetOwner below.
  const [ownerKey, setOwnerKey] = useState(sessionKey);
  // The same value, reachable from a callback created under an older render.
  // The turn handlers compare against this rather than the captured `ownerKey`,
  // so a switch is never missed by a stale closure.
  const ownerKeyRef = useRef(ownerKey);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  const boxRef = useRef(null);
  const scrollRef = useRef(null);
  const keyboardPointer = useMemo(hasKeyboardPointer, []);
  // Re-arm on mount, not just disarm on unmount. A ref initialised to true
  // is only true for the first mount: React 18 StrictMode mounts, unmounts and
  // remounts in dev, and a real remount happens any time the owner leaves the
  // Analytics tab and comes back. Without the re-arm the flag stays false, the
  // fetch resolves into a discarded update, and the card is a skeleton forever.
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  // The card changes hands. EVERYTHING the old hands wrote goes, and that is
  // more than the conversation.
  //
  // The thread and the draft are the obvious half: the thread is what is on
  // screen, and a half typed question would otherwise be sent under a token its
  // author never had. `ownerKeyRef` is written first and synchronously, so a
  // turn resolving in this same tick reads the new identity instead of the one
  // React has not committed yet.
  //
  // THE OTHER HALF IS THE CARD ITSELF, and dropping only the thread left it
  // standing. GET /questions answers FOR AN ACCOUNT: the server offers a venue
  // only the chips its own data can support, so the chip list that comes back
  // is a statement about which of that venue's data classes are populated, and
  // `freeText` is that account's entitlement. Clearing the turns and keeping
  // the chips handed owner A's data inventory and owner A's entitlement to
  // owner B, and the mirror case was worse for a paying customer: an owner A
  // locked out with a 403 left B reading A's locked card copy, with no way back
  // to a working one short of a remount, however entitled B was.
  //
  // So the surface goes back to knowing nothing, and the load effect below
  // re-runs because `ownerKey` is one of its inputs. A skeleton for one round
  // trip is the honest state here. Nothing about the new owner is known yet.
  const forgetOwner = useCallback((nextKey) => {
    ownerKeyRef.current = nextKey;
    threadStore = { key: null, turns: [] };
    setOwnerKey(nextKey);
    setThread([]);
    setDraft('');
    setBusy(false);
    setState('loading');
    setName(ADVISOR_NAME);
    setLead([]);
    setGroups([]);
    setFreeText(false);
    setLockedReason(null);
    setShowMore(false);
    setShowChips(false);
    setFocused(false);
  }, []);

  // Who is signed in NOW. It returns that key, so a caller about to issue a
  // request can stamp the request with the same read it just checked.
  const checkOwner = useCallback(() => {
    const live = sessionKey();
    if (live !== ownerKeyRef.current) forgetOwner(live);
    return live;
  }, [forgetOwner]);

  // Four ways to hear that the token moved, because no one of them hears all
  // of it. `storage` fires here when ANOTHER tab signs in, which is the case
  // the report describes and the only one an event covers. Focus and visibility
  // catch a switch made while this tab sat in the background. The interval
  // catches an in-app sign-in in this very tab, where no event of any kind is
  // dispatched to the document that did the writing. The fourth is below this
  // one: a read on every commit of this card, which usually beats the interval
  // to that same case.
  useEffect(() => {
    if (typeof window === 'undefined' || !window.addEventListener) return undefined;
    const onStorage = (e) => {
      // A storage event names the key that moved, and names none when the whole
      // store was cleared. A clear is a sign-out, so it counts.
      if (e && e.key && e.key !== 'flockToken') return;
      checkOwner();
    };
    const doc = typeof document !== 'undefined' && document.addEventListener ? document : null;
    window.addEventListener('storage', onStorage);
    window.addEventListener('focus', checkOwner);
    if (doc) doc.addEventListener('visibilitychange', checkOwner);
    const tick = setInterval(checkOwner, IDENTITY_POLL_MS);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('focus', checkOwner);
      if (doc) doc.removeEventListener('visibilitychange', checkOwner);
      clearInterval(tick);
    };
  }, [checkOwner]);

  // A FOURTH WAY, AND IT COSTS NOTHING BUT A STRING READ.
  //
  // No dependency array, so this runs after every commit of this card. An
  // in-app sign-in changes the state that owns the venue dashboard, which
  // re-renders this card in the same frame the app learns about the new
  // account, and that is the case the storage event cannot cover because a
  // document is never told about its own write. Catching it here is what keeps
  // the previous owner's answers from being drawn for a whole tick of the
  // interval below. The interval stays for the sign-in that re-renders nothing
  // here, which is the only case left.
  useEffect(() => { checkOwner(); });

  // Hand the thread to the next mount of this card, but only while the signed
  // in session is still the one these turns were written under. If the token
  // moved (another tab signed in, or this app did), the turns belong to an
  // account that is no longer the one being served: drop them rather than
  // re-label them. See the comment above restoreThread.
  useEffect(() => {
    if (sessionKey() !== ownerKey) {
      threadStore = { key: null, turns: [] };
      return;
    }
    threadStore = { key: ownerKey, turns: thread };
  }, [thread, ownerKey]);

  const load = useCallback(async () => {
    if (typeof fetchQuestions !== 'function') return;
    setState('loading');
    try {
      const data = await fetchQuestions();
      if (!alive.current) return;
      setName(data?.name || ADVISOR_NAME);
      // `lead` is the four the server chose. An older server that only sends
      // `groups` still renders: the first four grouped questions become the
      // lead, so a deploy skew shows a shorter list, never an empty one.
      const grouped = Array.isArray(data?.groups) ? data.groups : [];
      const flat = grouped.flatMap((g) => (Array.isArray(g.questions) ? g.questions : []));
      setLead(Array.isArray(data?.lead) && data.lead.length ? data.lead : flat.slice(0, 4));
      setGroups(Array.isArray(data?.lead) ? grouped : []);
      setFreeText(!!data?.freeText && typeof askQuestion === 'function');
      setOffReason(typeof data?.reason === 'string' ? data.reason : '');
      setState('ready');
    } catch (err) {
      if (!alive.current) return;
      // A 403 that says the plan could not be CHECKED is a retryable error,
      // not a lock; the locked state has no retry.
      if (err?.status === 403 && err?.data?.reason !== 'ENTITLEMENT_UNAVAILABLE') {
        setLockedReason(err?.data?.error || 'This is part of the Pro plan.');
        setState('locked');
      } else {
        setState('error');
      }
    }
  }, [fetchQuestions, askQuestion]);

  // `ownerKey` is a real input to this, not a spare dependency. The questions,
  // the free text entitlement and the locked state all belong to whoever is
  // signed in, so a change of account is a change of answer and has to re-run
  // the whole load rather than only emptying the thread above it.
  useEffect(() => { if (ownerKey) load(); }, [load, ownerKey]);

  // The box grows with what is in it. Measured against the real scroll height
  // rather than counted in characters, because where a line wraps depends on
  // the words and on how much room the screen gave them.
  const fitBox = useCallback(() => {
    const el = boxRef.current;
    if (!el || !el.style || typeof el.scrollHeight !== 'number') return;
    el.style.height = 'auto';
    let content = el.scrollHeight;
    // An empty box still has to be tall enough for its own invitation. A
    // placeholder contributes nothing to scrollHeight, and at 320px this one
    // wraps onto a second line, so the resting box measured one line high and
    // cut the invitation in half. The text is borrowed for the length of one
    // measurement and handed back before the browser paints; the value React
    // controls is the empty string on both sides of it.
    if (!el.value) {
      el.value = el.placeholder || '';
      content = el.scrollHeight;
      el.value = '';
    }
    const wanted = Math.max(COMPOSER_MIN_HEIGHT, Math.min(content, COMPOSER_MAX_HEIGHT));
    el.style.height = `${wanted}px`;
    el.style.overflowY = content > COMPOSER_MAX_HEIGHT ? 'auto' : 'hidden';
  }, []);

  useLayoutEffect(fitBox, [fitBox, draft, state, freeText]);

  // Rotation and a resized desktop window change where the words wrap, and a
  // box sized for the old width is either clipped or padded out.
  useEffect(() => {
    if (typeof window === 'undefined' || !window.addEventListener) return undefined;
    window.addEventListener('resize', fitBox);
    return () => window.removeEventListener('resize', fitBox);
  }, [fitBox]);

  // A new turn belongs at the bottom of the scrollback, which is where the
  // owner is looking: they just pressed send. Before paint, not after, because
  // this also runs on the remount that restores a thread and landing at the
  // top of an old conversation and then jumping is worse than either.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && typeof el.scrollHeight === 'number') el.scrollTop = el.scrollHeight;
    // `state` is in here because a restored thread is already in hand on the
    // first render and the card is still drawing its skeleton, so the scroller
    // does not exist yet and the thread never changes again. Without it a
    // remount landed the owner at the top of an old conversation.
  }, [thread, state]);

  // One turn, whichever door it came in by. `run` is the call that produces the
  // answer; the thread does not care which endpoint answered, only that the
  // answer arrived carrying its own mode.
  const runTurn = useCallback(async (key, question, run, typed = false) => {
    // WHO IS ASKING, read at the moment the request is issued rather than at
    // mount. If the token has already moved, this question was composed by
    // somebody who is no longer signed in: forget them and send nothing, since
    // the request would go out under the new account's token and its answer
    // would land in the old account's conversation.
    const askedUnder = ownerKeyRef.current;
    const issuedUnder = sessionKey();
    if (issuedUnder !== askedUnder) {
      forgetOwner(issuedUnder);
      return;
    }
    setBusy(true);
    setThread((t) => [...t, { key, question, typed, status: 'pending', answer: null }]);
    // The token can also move while this one request is in flight, and it is
    // the answer that carries the other account's business. Whatever comes back
    // was authorised by whoever was signed in when it left, so if that is no
    // longer who is signed in, it is not appended.
    //
    // A STALE RESPONSE DISCARDS ITSELF AND DOES NOTHING ELSE. It used to call
    // forgetOwner on the way out, which is a stale request reaching forward in
    // time to wipe state belonging to whoever is signed in NOW, and that was
    // destructive rather than merely late: owner A asks, owner B signs in and
    // the identity check correctly drops A's thread, B asks their own question,
    // and then A's request finally lands and takes B's live pending turn, B's
    // half typed follow up and, because it also released the busy flag under a
    // request that was still in flight, B's own answer with it. The turn B was
    // waiting on resolved into a thread that no longer had a row to update.
    //
    // Dropping the thread is the job of whoever NOTICES the change (checkOwner,
    // the storage listener, the guard at the top of this function). It already
    // happened, at the moment it was noticed, under the account it belongs to.
    // By the time a response from a replaced session arrives there is nothing
    // left for it to do but stop.
    const stillMine = () => sessionKey() === issuedUnder;
    try {
      const answer = await run();
      if (!alive.current || !stillMine()) return;
      setThread((t) => t.map((turn) => (turn.key === key ? { ...turn, status: 'done', answer } : turn)));
    } catch (err) {
      if (!alive.current || !stillMine()) return;
      // The server's own sentence for a refusal (too short, too many this
      // hour, plan, not connected yet) used to be thrown away for "That did
      // not go through. Try again", with a Try again that could not work
      // (chat audit, 2026-09-05). A 4xx with a real sentence renders as a
      // quiet answer; the error row stays for 5xx and the network.
      const said = [400, 403, 429].includes(Number(err?.status)) && typeof err?.message === 'string' && err.message.trim().length > 12
        ? err.message.trim()
        : null;
      setThread((t) => t.map((turn) => (turn.key === key
        ? (said ? { ...turn, status: 'done', answer: { mode: 'refusal', text: said } } : { ...turn, status: 'error' })
        : turn)));
    } finally {
      // Only the account that issued this request gets its busy flag back. The
      // new owner's own in flight question keeps the card busy, so a late
      // arrival from the replaced session cannot open the door to a double send.
      if (alive.current && stillMine()) setBusy(false);
    }
  }, [forgetOwner]);

  const askIntent = useCallback((id, label) => {
    if (busy || typeof ask !== 'function') return;
    runTurn(`${id}-${Date.now()}`, label, () => ask(id));
  }, [ask, busy, runTurn]);

  const submitQuestion = useCallback((e) => {
    if (e && typeof e.preventDefault === 'function') e.preventDefault();
    const text = draft.trim();
    if (busy || !text || typeof askQuestion !== 'function') return;
    setDraft('');
    runTurn(`typed-${Date.now()}`, text, () => askQuestion(text), true);
  }, [askQuestion, busy, draft, runTurn]);

  // Enter sends, Shift and Enter make a line. On a phone the return key is
  // drawn as Send (enterKeyHint below) and does the same thing, so the two
  // platforms agree without either being told about the other's keyboard.
  // isComposing is checked because an IME candidate list also ends on Enter,
  // and sending half a word someone was still spelling is a rude way to be
  // fast.
  const onKeyDown = useCallback((e) => {
    if (e.key !== 'Enter' || e.shiftKey) return;
    if (e.nativeEvent && e.nativeEvent.isComposing) return;
    e.preventDefault();
    submitQuestion();
  }, [submitQuestion]);

  // One value for the send control's look and its behaviour.
  const canAsk = !busy && freeText && draft.trim().length > 0;

  const retry = useCallback((turn) => {
    // The same guard askIntent and submitQuestion have. Without it a tap on
    // Retry while another turn was still pending sent a second paid
    // question on top of the first.
    if (busy) return;
    setThread((t) => t.filter((x) => x.key !== turn.key));
    if (turn.key.startsWith('typed-')) {
      if (typeof askQuestion === 'function') runTurn(`typed-${Date.now()}`, turn.question, () => askQuestion(turn.question), true);
      return;
    }
    askIntent(turn.key.slice(0, turn.key.lastIndexOf('-')), turn.question);
  }, [askIntent, askQuestion, busy, runTurn]);

  if (state === 'locked') {
    return (
      <div style={CARD_STYLE}>
        <p style={{ fontSize: 'var(--t-meta)', fontWeight: '600', color: navy, margin: '0 0 8px' }}>{ADVISOR_NAME}</p>
        <BirdNote layout="row" size={48} body={lockedReason} />
      </div>
    );
  }

  if (state === 'error') {
    return (
      <div style={CARD_STYLE}>
        <p style={{ fontSize: 'var(--t-meta)', fontWeight: '600', color: navy, margin: '0 0 8px' }}>{ADVISOR_NAME}</p>
        <BirdNote
          layout="row"
          size={48}
          body="Could not load right now."
          action={(
            <button
              type="button"
              onClick={load}
              style={{ background: 'none', border: 'none', padding: 0, font: 'inherit', fontSize: 'var(--t-meta)', color: navy, textDecoration: 'underline', cursor: 'pointer' }}
            >
              Try again
            </button>
          )}
        />
      </div>
    );
  }

  if (state === 'loading') {
    return (
      <div style={CARD_STYLE} aria-busy="true">
        <div style={{ height: 14, width: 90, borderRadius: 4, backgroundColor: 'var(--border-light)' }} />
        <div style={{ height: 12, width: '70%', borderRadius: 4, backgroundColor: 'var(--border-light)', marginTop: 10 }} />
      </div>
    );
  }

  const started = thread.length > 0;

  // The four the server picked for this venue, and the rest behind a word.
  // Every one of them has data behind it: a question that could only decline is
  // not offered. This is how a venue with nothing in the corpus finds out what
  // CAN be answered, which is why the chips are never deleted, only folded.
  const chipBlock = (
    <>
      <div>
        {lead.map((q) => (
          <button
            key={q.id}
            type="button"
            onClick={() => askIntent(q.id, q.label)}
            disabled={busy}
            style={{ ...CHIP_STYLE, opacity: busy ? 0.5 : 1, cursor: busy ? 'default' : 'pointer' }}
          >
            {q.label}
          </button>
        ))}
      </div>
      {groups.length > 0 && (
        <div style={{ marginTop: '4px' }}>
          <button
            type="button"
            onClick={() => setShowMore((v) => !v)}
            aria-expanded={showMore}
            style={QUIET_LINK_STYLE}
          >
            {showMore ? 'Fewer questions' : 'More questions'}
          </button>
          {showMore && groups.map((g) => (
            <div key={g.id} style={{ marginTop: '8px' }}>
              <p style={{ fontSize: 'var(--t-micro)', color: 'var(--text-tertiary)', margin: '0 0 5px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{g.label}</p>
              <div>
                {g.questions.map((q) => (
                  <button
                    key={q.id}
                    type="button"
                    onClick={() => askIntent(q.id, q.label)}
                    disabled={busy}
                    style={{ ...CHIP_STYLE, opacity: busy ? 0.5 : 1, cursor: busy ? 'default' : 'pointer' }}
                  >
                    {q.label}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );

  return (
    <div style={CARD_STYLE}>
      <p style={{ fontSize: 'var(--t-meta)', fontWeight: '600', color: navy, margin: 0 }}>{BLOCK_TITLE}</p>

      {/* First run only. Once there is a conversation, the conversation is the
          thing to read. */}
      {/* --t-meta, not --t-micro. index.css names the roles at the top of its
          scale: micro is 11px, "eyebrows, max twice per screen", and meta is
          12px "secondary/supporting text". This is a three-sentence paragraph
          explaining how the whole surface answers, and it is the first thing a
          new owner reads here. It is supporting text, so it gets the token for
          supporting text. */}
      {/* Before a word is exchanged, Birdie is the greeter — the same shape
          Birdie's own panel opens with, because Jayden asked for this surface
          to "feel like a regular chat" (build 26 review, 2026-08-21). The
          lead-in copy is unchanged: the bird adds presence, not promises. */}
      {!started && (
        <div data-roost="greeter" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', padding: '14px 0 2px' }}>
          <BirdieStill size={88} eager />
          <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)', margin: '10px 0 0', lineHeight: 1.5, maxWidth: '300px' }}>
            {offReason || (freeText ? LEAD_IN_FREE : LEAD_IN_CHIPS)}
          </p>
        </div>
      )}

      {/* Birdie stays behind the conversation as a whisper, exactly as he
          does behind his own thread in the consumer panel: fixed to the
          scrollback's frame (not its content, so he does not ride away with
          the scroll), faint enough to read through, and pointer-transparent.
          The opacity is a token (index.css --roost-whisper) because the same
          photograph needs a little more presence on the dark surface.

          HE IS SIZED BY THE PANE, not by a number. A fixed 150px bird was the
          obvious version and it was wrong: a one-turn thread is barely taller
          than that, so the first thing an owner ever saw behind their first
          answer was a cropped torso. Bottom-anchored and told to fill the
          frame instead, he scales down to stand on the floor of a short
          thread and up to 200px on a long one, and he is never cut. */}
      {started && (
        <div style={{ position: 'relative', margin: '12px 0 2px' }}>
          <div
            data-roost="whisper"
            aria-hidden="true"
            style={{ position: 'absolute', inset: 0, overflow: 'hidden', opacity: 'var(--roost-whisper, 0.05)', pointerEvents: 'none' }}
          >
            <BirdieStill size={200} style={{ position: 'absolute', left: 0, right: 0, bottom: 0, width: '100%', height: '100%', maxHeight: '200px' }} />
          </div>
          <div
            ref={scrollRef}
            style={{ position: 'relative', maxHeight: `${THREAD_MAX_HEIGHT}px`, overflowY: 'auto' }}
          >
            {thread.map((turn, i) => (
              <ThreadTurn key={turn.key} turn={turn} first={i === 0} navy={navy} navyBg={navyBg} onRetry={() => retry(turn)} />
            ))}
          </div>
        </div>
      )}

      {/* Empty, the chips are the offer. Started, they are one quiet line the
          owner can reopen. Above the composer either way, because they have
          always been a shortcut PAST the way in and never the way in. */}
      <div style={{ marginTop: started ? '6px' : '10px' }}>
        {started ? (
          <>
            <button
              type="button"
              onClick={() => setShowChips((v) => !v)}
              aria-expanded={showChips}
              style={QUIET_LINK_STYLE}
            >
              {showChips ? 'Hide suggested questions' : 'Suggested questions'}
            </button>
            {showChips && <div style={{ marginTop: '8px' }}>{chipBlock}</div>}
          </>
        ) : chipBlock}
      </div>

      {/* THE COMPOSER. Last thing in the card, so it is the last thing the eye
          lands on and the thing a thumb reaches first, which is where Birdie
          puts its box for the same reason. It is drawn in every state: when
          the server declines free text the box stays and goes quiet, with the
          server's reason under it, because an owner who can see a disabled
          field knows the feature exists and knows why it is not answering,
          and an owner shown nothing at all knows neither. */}
      <form onSubmit={submitQuestion} style={{ marginTop: '12px' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-end',
            gap: '8px',
            padding: '5px 5px 5px 12px',
            borderRadius: '16px',
            backgroundColor: 'var(--bg-hover)',
            border: '1.5px solid',
            borderColor: focused ? 'rgba(30,58,92,0.30)' : 'var(--border-subtle)',
            boxShadow: focused ? '0 0 0 1px rgba(45,90,135,0.15)' : 'none',
            transition: 'border-color 0.2s ease, box-shadow 0.2s ease',
            opacity: freeText ? 1 : 0.6,
          }}
        >
          <textarea
            ref={boxRef}
            /* Gives up the app-wide input focus ring, because the box around
               it already shows focus. See index.css. */
            className="roost-composer"
            rows={1}
            value={draft}
            maxLength={QUESTION_MAX_CHARS}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            disabled={busy || !freeText}
            placeholder={freeText ? PLACEHOLDER_TEXT : PLACEHOLDER_OFF}
            aria-label={`Ask ${name} a question`}
            autoComplete="off"
            enterKeyHint="send"
            style={{
              flex: 1,
              minWidth: 0,
              minHeight: `${COMPOSER_MIN_HEIGHT}px`,
              maxHeight: `${COMPOSER_MAX_HEIGHT}px`,
              padding: '12px 0',
              fontFamily: 'inherit',
              fontSize: 'var(--t-label)',
              lineHeight: 1.45,
              color: 'var(--text-primary)',
              backgroundColor: 'transparent',
              border: 'none',
              outline: 'none',
              resize: 'none',
              overflowY: 'hidden',
            }}
          />
          {/* One value drives the look AND the behaviour, the fix App.js's own
              Birdie button records having needed: a control drawn at half
              opacity that still accepts a press is a control that lies. */}
          {/* hit44: drawn at thirty four so it sits inside the box without
              growing it, with a transparent forty four point target laid over
              it (index.css). The box does not clip its overflow, which is the
              one condition that class has. */}
          <button
            className="hit44"
            type="submit"
            disabled={!canAsk}
            aria-label={`Send your question to ${name}`}
            style={{
              width: '34px',
              height: '34px',
              minWidth: '34px',
              marginBottom: '3px',
              borderRadius: '17px',
              border: 'none',
              backgroundColor: canAsk ? navy : 'transparent',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: canAsk ? 'pointer' : 'default',
              transition: 'background-color 0.2s ease',
            }}
          >
            <svg aria-hidden="true" focusable="false" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={canAsk ? 'white' : 'var(--text-tertiary)'} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="19" x2="12" y2="5" /><polyline points="5 12 12 5 19 12" />
            </svg>
          </button>
        </div>

        {/* The count appears only once it matters. A counter sitting under an
            empty box is noise; a counter that appears as the room runs out is
            the warning the server would otherwise deliver as a rejection. */}
        {freeText && draft.length > COUNTER_FROM && (
          <p style={{ fontSize: 'var(--t-micro)', color: 'var(--text-tertiary)', margin: '4px 0 0', textAlign: 'right' }}>
            {QUESTION_MAX_CHARS - draft.length} characters left
          </p>
        )}
        {freeText && keyboardPointer && !started && draft.length <= COUNTER_FROM && (
          <p style={{ fontSize: 'var(--t-micro)', color: 'var(--text-tertiary)', margin: '5px 0 0' }}>
            {KEY_HINT}
          </p>
        )}
        {/* "The suggested questions above still work" is only true when there
            ARE suggested questions above. An unlinked or unverified venue is
            answered with freeText false AND empty lead and groups, so the
            modal pilot venue read a disabled box pointing at chips that were
            not on the screen. The field is off there because the venue is not
            verified, which is what offReason says a few rows up, so this note
            has nothing to add and stands down. */}
        {!freeText && (lead.length > 0 || groups.length > 0) && (
          <p style={{ fontSize: 'var(--t-micro)', color: 'var(--text-tertiary)', margin: '5px 0 0', lineHeight: 1.5 }}>
            {FREE_TEXT_OFF_NOTE}
          </p>
        )}
      </form>
    </div>
  );
};

export default VenueAdvisorChat;
