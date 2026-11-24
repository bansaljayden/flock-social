/**
 * ADD FRIENDS SCREEN
 *
 * One of the two doors on the empty Nest, and the screen a brand new account
 * opens within seconds of signing up. A compact navy header (back, the title,
 * Invite) over a segmented control with four tabs: Search (the default),
 * Requests, Contacts (only where an address book can be read) and QR code.
 * It is a drill-in, like a chat or a plan: there is no tab bar under it, and
 * the back arrow and a swipe from the left edge are the way out.
 *
 * WHY IT WAS REBUILT (2026-11-23)
 *
 * On an iPhone the old screen gave 306 of its 852 points to chrome (a 190pt
 * header and the app's tab bar under it), drew the friend requests above every
 * tab, and kept all four tabs in one scroll box that was never reset. So the
 * top half of every tab looked the same, the search field and the friend code
 * box sat below the fold or under the keys, and a tab opened wherever the last
 * one was left. In the dark theme, which turns on by itself in the evening,
 * the QR code had no light border and the app's own scanner could not read it.
 * The measurements and the decisions are in the Add Friends audit of that day.
 * What changed:
 *
 *   - Requests, incoming and sent, live on their own tab and nowhere else.
 *   - Search is field first: the field is sticky at the top of the scroller
 *     and the results come straight under it. With nothing typed it shows
 *     People you may know, which used to be a tab of its own that a new
 *     account always found empty.
 *   - The QR code is on a white tile with the standard quiet zone, in both
 *     themes, and is never inverted. It carries what the server says: the
 *     JSON every build's scanner reads, then the link once the build that
 *     reads links is the one in the App Store.
 *   - Every field stays above the keyboard (hooks/useScrollBoxKeyboard.js),
 *     Return does something on every field that has one, and a drag in the
 *     scroller or a tap on blank space puts the keys away.
 *   - No button shows a success tick before the server has answered.
 *
 * WHY THIS ONE IS A STATIC IMPORT
 *
 * Add Friends is one of the two calls to action on the empty home screen, and
 * the phone opening it is usually on a bar network. When it left App.js on
 * 2026-08-26 three production builds were measured: behind React.lazy it would
 * have saved 4.33 kB gzipped and cost one more round trip at the exact moment
 * a new account taps Add Friends, which is hundreds of milliseconds when it
 * works and an empty Suspense fallback when it does not. It stayed a static
 * import. The QR generator is the one part that is lazy (below).
 *
 * WHY EVERYTHING ARRIVES AS A PROP
 *
 * The state and the handlers behind this screen live in FlockAppInner, which
 * does not unmount when the person leaves, so a typed search, a contacts
 * result and a pending request survive a trip elsewhere. Each value comes in
 * as a parameter, so the whole dependency surface of this file is its
 * parameter list plus its imports, and a name it reads and does not receive
 * is an undefined identifier the build refuses rather than a prop that is
 * silently undefined at runtime (extractionEquivalence.test.js holds the
 * parameter list and App.js's addFriendsProps to the same set).
 *
 * THE ADDRESS BOOK
 *
 * The system prompt for the address book still fires only from the Continue
 * tap on the card that explains what leaves the phone, never from an effect or
 * a tab change, because iOS asks once per install and a denial stands until
 * the person walks into Settings. Opening the tab reads the permission without
 * prompting (App.js), and the card's state follows that reading.
 */
import React from 'react';
import { BirdieStill, BirdNote, WARM_BIRD } from '../components/ui/BirdieBird';
import Icons from '../components/ui/Icons';
import { BAND_HEAD } from '../components/nest/nestBand';
// The name search's rows, the sent requests and the Flock code, while they load.
import { SkeletonBar, SkeletonBlock, SkeletonRow, SkeletonStatus } from '../components/ui/Skeleton';
import useEdgeSwipeBack from '../hooks/useEdgeSwipeBack';
import useScrollBoxKeyboard, { revealInBox } from '../hooks/useScrollBoxKeyboard';
import { localeTime } from '../lib/localeFormat';
import { friendCodeFrom, friendQrText, qrTextIsLink } from '../lib/friendCode';
// How many numbers one contacts check sends, for the "Check the next N" button.
import { CONTACT_BATCH_SIZE, MAX_BATCHES } from '../services/contacts';

/* The QR GENERATOR is lazy. qrcode.react carries its own encoder and webpack
   gives it a chunk of its own, which was 53% of this route's gzipped weight for
   one element behind a tab the visitor has to tap. This screen is one of the
   chunks warmScreenChunks prefetches on idle, so that weight would have been
   real traffic on every session. In the iPhone app the chunk ships inside the
   app, so the code still draws with no network. */
const QRCodeSVG = React.lazy(() => import('qrcode.react').then((m) => ({ default: m.QRCodeSVG })));

/* THE CODE'S TILE. White, with dark modules, in BOTH themes. The dark theme
   used to put the code in a dark frame with no light margin, and html5-qrcode,
   the app's own scanner, read none of those renders (0 of 162 in the audit's
   simulation, and a live scan sat for 12 seconds and gave up). Never inverted:
   the decoder does not read light modules on a dark ground. Level M with the
   standard four module quiet zone: the payload is short (the old JSON, or the
   link once the server switches to it, lib/friendCode.js friendQrText), so M
   gives a 29 or 33 module code, about 5pt a module at 208, against 4.4pt for
   the old 41 module code at level H and 180. */
const QR_SIZE = 208;
const QR_PAPER = '#ffffff';
const QR_INK = '#1e293b';

/* One contacts check sends at most this many numbers (services/contacts.js). */
const CHECK_RUN = CONTACT_BATCH_SIZE * MAX_BATCHES;

/* A friend code is printed and read in capitals, so a code typed into the box
   is shown in capitals. A pasted link, invite or old QR text keeps its own
   case: the reader that takes a code out of any of them (lib/friendCode.js,
   through handleAddByCode) does the normalising. Declared here so its identity
   holds still across renders: SearchInputLocal watches this function alongside
   the value it was handed, and a new one on every render would wake that
   effect every time. */
const codeCase = (value) => (/[\s:/{]/.test(value) ? value : value.toUpperCase());

/* The QR mark on the scan button. Icons.js has no QR glyph, so it is drawn here
   in the set's own terms: a 24 unit box, currentColor, round caps and joins,
   and the set's stroke for its size (one unit of stroke per 10.5 of size, as
   Icons.js sw() works it out). Four viewfinder corners round three finder
   squares and a dot, the mark iPhone uses for scanning a code. */
const qrScanMark = (color, size) => (
  <span className="flock-icon-wrap" aria-hidden="true" style={{ color, display: 'inline-flex' }}>
    <svg className="flock-icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={Math.round(Math.min(4.5, Math.max(1, size / 10.5)) * 100) / 100} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M3.5 8V5.5a2 2 0 0 1 2-2H8M16 3.5h2.5a2 2 0 0 1 2 2V8M20.5 16v2.5a2 2 0 0 1-2 2H16M8 20.5H5.5a2 2 0 0 1-2-2V16" />
      <path d="M8 8h3v3H8zM13 8h3v3h-3zM8 13h3v3H8z" />
      <circle cx="14.5" cy="14.5" r="1.25" fill="currentColor" stroke="none" />
    </svg>
  </span>
);

const initialOf = (name) => {
  const ch = String(name || '').trim().charAt(0);
  return ch ? ch.toUpperCase() : '?';
};

const count = (n) => (Number(n) || 0).toLocaleString();

/* THE SHAPES. One field style, one row shape and one group for the whole
   screen: the old screen had three field looks on three tabs, a card per
   person, and four heading styles. Tokens only, so both themes come from
   index.css. */
const FIELD = {
  width: '100%', height: '44px', boxSizing: 'border-box', padding: '0 12px',
  borderRadius: 'var(--r-md)', border: '1px solid var(--border-default)',
  backgroundColor: 'var(--bg-card-solid)', color: 'var(--text-primary)',
  fontSize: 'var(--t-body)', fontWeight: '500', outline: 'none',
};
const GROUP = { backgroundColor: 'var(--bg-card-solid)', borderRadius: 'var(--r-md)' };
const ROW = { display: 'flex', alignItems: 'center', gap: '12px', minHeight: '60px', padding: '0 12px', position: 'relative' };
// The line between two rows, inset to start under the names, not the faces.
const HAIRLINE = { position: 'absolute', left: '64px', right: 0, top: 0, height: '1px', backgroundColor: 'var(--nest-edge)' };
const FACE = {
  width: '40px', height: '40px', flexShrink: 0, borderRadius: 'var(--r-pill)', border: 'none', padding: 0,
  backgroundColor: 'var(--face-bg)', color: 'var(--text-primary)', cursor: 'pointer',
  display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 'var(--t-body)', fontWeight: '600',
};
const FACE_IMG = { width: '40px', height: '40px', borderRadius: 'var(--r-pill)', objectFit: 'cover', display: 'block' };
const ROW_TEXT = { flex: 1, minWidth: 0 };
const ROW_NAME = { margin: 0, fontSize: 'var(--t-body)', fontWeight: '600', color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' };
const ROW_META = { margin: '2px 0 0', fontSize: 'var(--t-meta)', fontWeight: '500', color: 'var(--text-tertiary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' };
const ACTIONS = { display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 };
const QUIET = { fontSize: 'var(--t-meta)', fontWeight: '500', color: 'var(--text-tertiary)', padding: '0 4px' };
const GHOST = {
  width: '32px', height: '32px', flexShrink: 0, borderRadius: 'var(--r-pill)', border: 'none', padding: 0,
  backgroundColor: 'var(--bg-inset)', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
};
const TEXT_BUTTON = {
  minHeight: '32px', padding: '0 4px', border: 'none', background: 'none', cursor: 'pointer',
  color: 'var(--text-secondary)', fontSize: 'var(--t-label)', fontWeight: '600',
};
const LINK_BUTTON = { ...TEXT_BUTTON, color: 'var(--accent-purple-text)' };
const SECONDARY = {
  height: '44px', padding: '0 16px', flexShrink: 0, position: 'relative', cursor: 'pointer',
  borderRadius: 'var(--r-md)', border: '1px solid var(--border-default)',
  backgroundColor: 'var(--bg-card-solid)', color: 'var(--text-primary)', fontSize: 'var(--t-body)', fontWeight: '600',
};
const PRIMARY = {
  width: '100%', height: '48px', borderRadius: 'var(--r-md)', border: 'none', cursor: 'pointer',
  fontSize: 'var(--t-body)', fontWeight: '600', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
};
const BAND = { ...BAND_HEAD, margin: '20px 0 8px' };
const CARD_TITLE = { margin: 0, fontSize: 'var(--t-body)', fontWeight: '600', color: 'var(--text-primary)' };
const CARD_BODY = { margin: '6px 0 14px', fontSize: 'var(--t-label)', lineHeight: 1.5, color: 'var(--text-secondary)' };
const NOTE = { margin: '0 0 8px', fontSize: 'var(--t-meta)', lineHeight: 1.45, color: 'var(--text-secondary)' };
const ERROR_ROW = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', marginTop: '16px',
  padding: '10px 12px', borderRadius: 'var(--r-sm)', backgroundColor: 'var(--bg-tertiary)',
};
const ERROR_TEXT = { margin: 0, fontSize: 'var(--t-meta)', color: 'var(--text-secondary)' };
const RETRY = {
  padding: '8px 14px', flexShrink: 0, borderRadius: 'var(--r-sm)', border: '1px solid var(--border-mid)',
  backgroundColor: 'var(--bg-card-solid)', color: 'var(--text-primary)', fontWeight: '600', fontSize: 'var(--t-meta)', cursor: 'pointer',
};
// The small inline ring for an action running, over its word held invisible so
// the button keeps its width, with the words for a screen reader.
const RING = {
  position: 'absolute', top: '50%', left: '50%', width: '16px', height: '16px', margin: '-8px 0 0 -8px', boxSizing: 'border-box',
  border: '2px solid var(--border-mid)', borderTopColor: 'var(--text-primary)', borderRadius: '50%', animation: 'spin 0.8s linear infinite',
};
const BADGE = {
  minWidth: '18px', height: '18px', padding: '0 5px', boxSizing: 'border-box', borderRadius: 'var(--r-pill)',
  backgroundColor: '#B91C1C', color: '#ffffff', fontSize: 'var(--t-micro)', fontWeight: '700', lineHeight: 1,
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
};

/* Return, unless an input method is still composing a word (Japanese, Chinese,
   the iPhone's own dictation): that Enter belongs to the composition. */
const isReturn = (e) => e.key === 'Enter' && !(e.nativeEvent && e.nativeEvent.isComposing);

export default function AddFriends({
  // Module-level helpers and components that live in App.js and are shared
  // with screens that are not this one, so they stay there and come in here.
  DialogBehavior,
  EmailConfirmLine,
  ListSkeleton,
  SearchInputLocal,
  // Everything else is declared in FlockAppInner and stays declared there.
  addFriendsError,
  addFriendsResults,
  addFriendsSearch,
  addFriendsSearching,
  addFriendsTab,
  colors,
  confirmClick,
  contactsDenied,
  contactsLoading,
  contactsPermission,
  contactsResult,
  contactsRetryAt,
  contactsSupported,
  contactsUnavailable,
  contactsUsers,
  decliningRequests,
  emailUnconfirmed,
  focusCodeFieldRequest,
  friendCodeInput,
  friendCodeLoading,
  friendStatuses,
  friendSuggestions,
  friendSuggestionsError,
  handleAcceptFriendRequest,
  handleAddByCode,
  handleAddFriendsSearch,
  handleCancelOutgoingRequest,
  handleDeclineFriendRequest,
  handleInviteFriend,
  handleLookupByNumber,
  handleOpenAppSettings,
  handleSendFriendRequest,
  handleShareMyCode,
  handleSyncContacts,
  handleTogglePhoneDiscovery,
  handleUndoDecline,
  loadAddFriendsData,
  myFriendCode,
  myFriendCodeFailed,
  myFriendCodeQr,
  myName,
  myPhotoUrl,
  openEditProfile,
  openQrScanner,
  openUserProfile,
  outgoingRequests,
  outgoingRequestsLoaded,
  pendingRequests,
  pendingRequestsError,
  phoneDiscoverable,
  phoneLookupError,
  phoneLookupInput,
  phoneLookupLoading,
  phoneLookupUsers,
  phoneOnFile,
  requestsTabBadge,
  setAddFriendsResults,
  setAddFriendsSearch,
  setAddFriendsTab,
  setCurrentScreen,
  setFriendCodeInput,
  setPhoneLookupError,
  setPhoneLookupInput,
  setPhoneLookupUsers,
  showToast,
  startNewDmWithUser,
  styles,
}) {
    // Back, from the arrow or a swipe from the left edge (hooks/useEdgeSwipeBack.js).
    const leave = () => setCurrentScreen('main');
    const edgeBack = useEdgeSwipeBack(leave);

    // THE TABS. Contacts only appears where an address book can actually be
    // read: contactsAvailable() in services/contacts.js is true inside the iOS
    // app and false in a browser without the Contacts Picker.
    const tabs = [
      { id: 'username', label: 'Search' },
      { id: 'requests', label: 'Requests' },
      ...(contactsSupported ? [{ id: 'contacts', label: 'Contacts' }] : []),
      { id: 'qr', label: 'QR code' },
    ];
    // A tab that is not on screen must not be the one rendering. Quick Add was
    // a tab until 2026-11-23 and its id may still be remembered; its people are
    // on Search now. Contacts without an address book goes to Search too.
    const activeTab = tabs.some((t) => t.id === addFriendsTab) ? addFriendsTab : 'username';

    // THE SCROLLER, and what keeps its fields above the keys. Each tab opens at
    // its own top: one box holds all four, and it used to keep the last tab's
    // scroll, so a tab opened part way down with its heading cut off. A layout
    // effect, so the new tab's first paint is already at the top.
    const scrollRef = React.useRef(null);
    const kbSpacerRef = React.useRef(null);
    const codeRef = React.useRef(null);
    const codeKeepRef = React.useRef(null);
    const phoneRef = React.useRef(null);
    const byNumberRef = React.useRef(null);
    const tabButtonsRef = React.useRef({});
    useScrollBoxKeyboard(scrollRef, kbSpacerRef);
    React.useLayoutEffect(() => {
      if (scrollRef.current) scrollRef.current.scrollTop = 0;
    }, [activeTab]);

    // The segmented control is one tab stop, and the arrow keys move along it
    // (the WAI-ARIA tabs pattern).
    const onTabKey = (e, index) => {
      let next = null;
      if (e.key === 'ArrowRight') next = (index + 1) % tabs.length;
      else if (e.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = tabs.length - 1;
      if (next === null) return;
      e.preventDefault();
      const id = tabs[next].id;
      setAddFriendsTab(id);
      const el = tabButtonsRef.current[id];
      if (el && typeof el.focus === 'function') el.focus();
    };

    // THE SCANNER'S "TYPE THE CODE INSTEAD". The scanner is drawn at the App
    // root; when that is used, App.js counts it in focusCodeFieldRequest and
    // the code box here takes focus, on the QR tab. Only a change counts, so
    // arriving on the screen never focuses anything by itself.
    const seenCodeFocusRequest = React.useRef(focusCodeFieldRequest);
    const wantsCodeFocus = React.useRef(false);
    React.useEffect(() => {
      if (focusCodeFieldRequest === seenCodeFocusRequest.current) return;
      seenCodeFocusRequest.current = focusCodeFieldRequest;
      wantsCodeFocus.current = true;
      if (activeTab !== 'qr') setAddFriendsTab('qr');
    }, [focusCodeFieldRequest, activeTab, setAddFriendsTab]);
    React.useEffect(() => {
      if (!wantsCodeFocus.current || activeTab !== 'qr') return;
      const field = codeRef.current;
      if (!field) return;
      wantsCodeFocus.current = false;
      try { field.focus({ preventScroll: true }); } catch (err) { field.focus(); }
      revealInBox(scrollRef.current, codeKeepRef.current || field);
    }, [activeTab, focusCodeFieldRequest]);

    // LOOK UP'S ANSWER, BROUGHT INTO VIEW. Look up puts the keypad away first
    // (lookUp below), so the answer lands on a screen the person can read;
    // this scrolls it up from under the bottom edge when it arrives. Only a
    // new answer moves anything: opening the tab on an old one does not.
    const lookupShown = React.useRef({ users: phoneLookupUsers, error: phoneLookupError });
    React.useEffect(() => {
      const before = lookupShown.current;
      lookupShown.current = { users: phoneLookupUsers, error: phoneLookupError };
      if (before.users === phoneLookupUsers && before.error === phoneLookupError) return;
      if ((!phoneLookupUsers && !phoneLookupError) || activeTab !== 'contacts') return;
      revealInBox(scrollRef.current, byNumberRef.current);
    }, [phoneLookupUsers, phoneLookupError, activeTab]);

    // The count on the Requests tab, worked out once in App.js.
    const requestsBadge = Math.max(0, Number(requestsTabBadge) || 0);

    // LET FRIENDS FIND YOU. The switch moves on the tap and is dimmed and deaf
    // to a second tap until the server has answered, like the one in Settings;
    // the card stays for the rest of the visit once it has been shown, so
    // turning the switch on does not make it vanish under the finger.
    const [findMePending, setFindMePending] = React.useState(null);
    const [findMeShown, setFindMeShown] = React.useState(false);
    React.useEffect(() => {
      if (phoneDiscoverable === false) setFindMeShown(true);
    }, [phoneDiscoverable]);
    const findMeOn = findMePending !== null ? findMePending : phoneDiscoverable === true;
    const toggleFindMe = async () => {
      if (findMePending !== null) return;
      const next = phoneDiscoverable !== true;
      setFindMePending(next);
      try {
        await handleTogglePhoneDiscovery(next);
      } catch (err) {
        // The handler says why with a toast, and the switch goes back to the
        // value the server holds.
      } finally {
        setFindMePending(null);
      }
    };

    // WHEN A CONTACTS CHECK CAN RUN AGAIN. The server says when the allowance
    // comes back (retryAt); the button waits for it, and wakes by itself when
    // the time comes rather than staying grey until something else redraws.
    // A check refused before it had checked anything leaves no result, only
    // that time (contactsRetryAt), and Continue waits for it the same way.
    const retryAt = contactsResult ? contactsResult.retryAt : contactsRetryAt;
    const retryAtMs = retryAt ? new Date(retryAt).getTime() : NaN;
    const [, setClock] = React.useState(0);
    React.useEffect(() => {
      if (!Number.isFinite(retryAtMs)) return undefined;
      const wait = retryAtMs - Date.now();
      if (wait <= 0) return undefined;
      const timer = window.setTimeout(() => setClock((n) => n + 1), Math.min(wait + 250, 2147483647));
      return () => window.clearTimeout(timer);
    }, [retryAtMs]);
    const waitingForRetry = Number.isFinite(retryAtMs) && retryAtMs > Date.now();

    // WHO EACH PERSON IS TO YOU. friendStatuses is App.js's one record of a
    // relationship (accepted, pending for one you sent, incoming for one sent
    // to you, none once a request is cancelled, declined or withdrawn);
    // someone whose request is waiting on the Requests tab is incoming here
    // too; and a contacts match carries the server's word from when the check
    // ran, which counts only while App.js has written nothing about them.
    const incomingIds = new Set(pendingRequests.map((r) => r.id));
    const relationOf = (user) => {
      const known = friendStatuses[user.id];
      if (known === 'accepted' || known === 'pending' || known === 'incoming') return known;
      if (incomingIds.has(user.id)) return 'incoming';
      if (known != null) return 'none';
      const told = user.friendship_status;
      return told === 'accepted' || told === 'pending' || told === 'incoming' ? told : 'none';
    };

    // THE REQUESTS LIST AS THE PERSON LEFT IT. A request declined in the last
    // few seconds is off pendingRequests but still on the screen, in the place
    // it had (App.js keeps where, `at`), saying Declined with its own Undo.
    // Put back newest first: each place was counted with the older declines
    // already out of the list.
    const decliningRows = (Array.isArray(decliningRequests) ? decliningRequests : []).filter((r) => !incomingIds.has(r.id));
    const requestRows = pendingRequests.map((request) => ({ request, declining: false }));
    [...decliningRows].reverse().forEach((request) => {
      const at = Number.isInteger(request.at) && request.at >= 0 ? Math.min(request.at, requestRows.length) : requestRows.length;
      requestRows.splice(at, 0, { request, declining: true });
    });
    const lastDeclined = decliningRows.length ? decliningRows[decliningRows.length - 1] : null;
    const declinedNow = lastDeclined ? `Declined${lastDeclined.name ? ` ${lastDeclined.name}'s request` : ''}. Undo is on the row for a few seconds.` : '';

    const pill = {
      height: '32px', padding: '0 14px', flexShrink: 0, borderRadius: 'var(--r-pill)', border: 'none', cursor: 'pointer',
      background: colors.navyBg, color: 'white', fontSize: 'var(--t-label)', fontWeight: '600',
    };
    const card = { ...styles.card, marginTop: '16px', marginBottom: 0 };

    /* ONE ROW SHAPE FOR EVERY PERSON ON THE SCREEN: the face, which opens the
       person card (and its block and report, which is where someone needs them
       most for a request from a stranger), the Flock name, one quiet line, and
       the actions. Flock name and photo only: a contacts match never shows
       anything the phone knows about the contact. */
    const personRow = (user, { index = 0, meta = null, actions = null } = {}) => (
      <div key={user.id} style={ROW}>
        {index > 0 && <span aria-hidden="true" style={HAIRLINE} />}
        <button type="button" className="hit44" aria-label={`About ${user.name}`} onClick={() => openUserProfile({ id: user.id, name: user.name, image: user.profile_image_url })} style={FACE}>
          {user.profile_image_url ? <img src={user.profile_image_url} alt="" draggable="false" style={FACE_IMG} /> : initialOf(user.name)}
        </button>
        <div style={ROW_TEXT}>
          <p style={ROW_NAME}>{user.name}</p>
          {meta && <p style={ROW_META}>{meta}</p>}
        </div>
        {actions && <div style={ACTIONS}>{actions}</div>}
      </div>
    );

    // What a row offers, by relationship. No success tick on any of these:
    // Add marks Pending at once and puts the button back if the server says
    // no, and Accept says accepted when the server has.
    const relationActions = (user, { message = false } = {}) => {
      const relation = relationOf(user);
      return (
        <>
          {relation === 'accepted' ? (
            <span style={QUIET}>Friends</span>
          ) : relation === 'pending' ? (
            <span style={QUIET}>Pending</span>
          ) : relation === 'incoming' ? (
            <button type="button" aria-label={`Accept ${user.name}'s friend request`} className="hit44 glass-btn glass-navy" onClick={() => handleAcceptFriendRequest(user.id)} style={pill}>Accept</button>
          ) : (
            <button type="button" aria-label={`Add ${user.name}`} className="hit44 glass-btn glass-navy" onClick={() => handleSendFriendRequest(user)} style={pill}>Add</button>
          )}
          {message && (
            <button type="button" aria-label={`Message ${user.name}`} className="hit44" onClick={() => { setCurrentScreen('main'); startNewDmWithUser(user); }} style={GHOST}>{Icons.messageSquare('var(--text-secondary)', 15)}</button>
          )}
        </>
      );
    };

    // INVITE A FRIEND, where a search comes up empty: before anything is typed
    // (when nobody is suggested) and after a search that found nobody. On a new
    // app most of a new account's friends are not on Flock yet. The same
    // handler as the header's Invite, and it waits for the code it sends.
    const inviteButton = (
      <button type="button" className="hit44 glass-btn glass-navy" onClick={() => handleInviteFriend()} disabled={!myFriendCode}
        style={{ padding: '12px 20px', borderRadius: 'var(--r-md)', border: 'none', background: colors.navyBg, color: 'white', fontSize: 'var(--t-label)', fontWeight: '600', cursor: myFriendCode ? 'pointer' : 'default', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}>
        {Icons.share('white', 16)} Invite a friend
      </button>
    );

    // THE FIELDS' OWN BUTTONS. Each one hands over the value the box shows, so
    // a tap that lands inside the box's short publish delay still sends every
    // character, and each puts the keys away first so the answer is seen.
    const addCode = async (typed) => {
      if (friendCodeLoading) return;
      const value = typeof typed === 'string' ? typed : (codeRef.current ? codeRef.current.value : friendCodeInput);
      if (!String(value || '').trim()) return;
      if (codeRef.current) codeRef.current.blur();
      const added = await handleAddByCode(String(value).trim());
      if (!added) return;
      // Emptied once the code is added, and only while the box still shows
      // it: read from the box itself, which also holds keystrokes it has not
      // published yet, so a code typed or pasted while the answer was on its
      // way stays. With the QR tab left meanwhile there is no box, and what it
      // last published is what it would come back with.
      if (codeRef.current) {
        if (friendCodeFrom(codeRef.current.value) === added) setFriendCodeInput('');
      } else {
        setFriendCodeInput(cur => (friendCodeFrom(cur) === added ? '' : cur));
      }
    };
    const lookUp = (typed) => {
      if (phoneLookupLoading) return;
      const value = typeof typed === 'string' ? typed : (phoneRef.current ? phoneRef.current.value : phoneLookupInput);
      if (!String(value || '').trim()) return;
      if (phoneRef.current) phoneRef.current.blur();
      handleLookupByNumber(String(value).trim());
    };

    // AWAITED, INSIDE A CATCH: a refused clipboard write (denied permission, a
    // document that is not focused, both routine in a WKWebView) must not
    // become an unhandled rejection under the word "copied".
    const copyCode = async () => {
      try {
        await navigator.clipboard.writeText(myFriendCode);
        showToast('Code copied.');
      } catch (err) {
        showToast('Could not copy. Read it off the button instead.', 'error');
      }
    };

    // The confirm-your-email line, said once at the top of whichever tab is
    // open: the server refuses every friend action until the link is opened,
    // and this says so before a tap fails rather than after.
    const emailLine = emailUnconfirmed && EmailConfirmLine
      ? (React.isValidElement(EmailConfirmLine) ? EmailConfirmLine : <EmailConfirmLine />)
      : null;

    // What the QR carries is App.js's (the server's) to say; read again here so
    // a code on screen always has a QR that scans back to it.
    const qrValue = friendQrText(myFriendCode, myFriendCodeQr);
    const query = addFriendsSearch.trim();

    return (
      <div key="add-friends-container" ref={edgeBack} className="screen-enter" style={{ display: 'flex', flexDirection: 'column', height: '100%', backgroundColor: 'var(--bg-primary)' }}>
        {/* HEADER. Navy in both themes, so the status strip above it stays navy
            (services/systemBars.js). One 44pt row, the segmented control, and
            10pt of navy under it: 90pt, where it was 131 plus a tab bar. */}
        <div style={{ background: colors.navyBg, flexShrink: 0, paddingBottom: '10px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '4px', height: '44px', padding: '0 calc(var(--nest-gutter) - 10px) 0 4px' }}>
            <button aria-label="Back" className="hit44 af-on-navy" onClick={leave} type="button" style={{ width: '44px', height: '44px', flexShrink: 0, border: 'none', background: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Icons.arrowLeft('white', 20)}</button>
            <h1 style={{ flex: 1, minWidth: 0, margin: 0, fontFamily: 'var(--font-display)', fontWeight: '600', fontSize: 'var(--t-title)', letterSpacing: '-0.005em', color: 'white', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>Add friends</h1>
            <button type="button" aria-label="Invite a friend" className="hit44 af-on-navy" onClick={() => handleInviteFriend()} disabled={!myFriendCode}
              style={{ height: '44px', padding: '0 10px', flexShrink: 0, border: 'none', background: 'none', color: 'white', display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: 'var(--t-body)', fontWeight: '600', cursor: myFriendCode ? 'pointer' : 'default', opacity: myFriendCode ? 1 : 0.5 }}>
              {Icons.share('white', 18)} Invite
            </button>
          </div>
          {/* Text only, so it reads as one control and not as a second tab
              bar. The chosen segment's colours are index.css's (.af-seg-tab),
              white in light and cream in dark, with navy words. */}
          <div role="tablist" aria-label="Ways to add friends" style={{ display: 'flex', gap: '2px', height: '36px', boxSizing: 'border-box', padding: '2px', margin: '0 var(--nest-gutter)', borderRadius: 'var(--r-pill)', backgroundColor: 'rgba(255,255,255,0.14)' }}>
            {tabs.map((tab, i) => {
              const selected = tab.id === activeTab;
              const badge = tab.id === 'requests' ? requestsBadge : 0;
              return (
                <button
                  key={tab.id}
                  ref={(el) => { tabButtonsRef.current[tab.id] = el; }}
                  type="button"
                  role="tab"
                  id={`add-friends-tab-${tab.id}`}
                  aria-selected={selected}
                  aria-controls="add-friends-panel"
                  tabIndex={selected ? 0 : -1}
                  className="hit44 af-on-navy af-seg-tab"
                  onClick={() => setAddFriendsTab(tab.id)}
                  onKeyDown={(e) => onTabKey(e, i)}
                  style={{ flex: '1 1 0px', minWidth: 'max-content', padding: '0 6px', border: 'none', borderRadius: 'var(--r-pill)', cursor: 'pointer', whiteSpace: 'nowrap', fontSize: 'var(--t-label)', fontWeight: '600', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '5px' }}
                >
                  {tab.label}
                  {badge > 0 && (
                    <>
                      <span aria-hidden="true" style={BADGE}>{badge > 99 ? '99+' : badge}</span>
                      <span className="sr-only">{`, ${badge} new`}</span>
                    </>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* CONTENT. One scroller, the Nest's gutter, and room under the last
            row for the home indicator. data-kb-scroll marks a box whose
            fields are kept above the keys (hooks/useScrollBoxKeyboard.js). */}
        <div
          ref={scrollRef}
          role="tabpanel"
          id="add-friends-panel"
          aria-labelledby={`add-friends-tab-${activeTab}`}
          data-kb-scroll=""
          style={{ flex: 1, minHeight: 0, overflowY: 'auto', WebkitOverflowScrolling: 'touch', overscrollBehavior: 'contain', padding: '0 var(--nest-gutter) calc(24px + var(--safe-bottom))' }}
        >
          {emailLine && <div style={{ paddingTop: '12px' }}>{emailLine}</div>}

          {/* TAB: Search */}
          {activeTab === 'username' && (
            <div>
              {/* The field is the first thing on the tab and stays at the top
                  of the scroller, and while a query is typed nothing sits
                  between it and the results. With the keys up the hook brings
                  it to the top (data-kb-keep="top") so the results get the
                  room. */}
              <div data-kb-keep="top" style={{ position: 'sticky', top: 0, zIndex: 1, backgroundColor: 'var(--bg-primary)', margin: '0 calc(-1 * var(--nest-gutter))', padding: '12px var(--nest-gutter) 8px' }}>
                <div style={{ position: 'relative' }}>
                  <span aria-hidden="true" style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', display: 'flex', pointerEvents: 'none' }}>{Icons.search(query ? 'var(--text-primary)' : 'var(--text-tertiary)', 16)}</span>
                  {/* Return puts the keys away; the box publishes what it holds
                      and the search runs, so the results get the whole screen. */}
                  <SearchInputLocal aria-label="Search by name" type="text" initialValue={addFriendsSearch} onCommit={handleAddFriendsSearch} placeholder="Search by name"
                    autoComplete="off" autoCorrect="off" autoCapitalize="none" spellCheck={false} enterKeyHint="search"
                    onKeyDown={(e) => { if (!isReturn(e)) return; e.preventDefault(); e.currentTarget.blur(); }}
                    style={{ ...FIELD, padding: '0 44px 0 40px' }}
                  />
                  {addFriendsSearch && <button aria-label="Clear search" className="hit44" onClick={() => handleAddFriendsSearch('')} type="button" style={{ position: 'absolute', right: 0, top: 0, width: '44px', height: '44px', border: 'none', background: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Icons.x('var(--text-tertiary)', 14)}</button>}
                </div>
              </div>

              {query ? (
                <>
                  {/* The rows that are coming, in the row's own shape: the
                      face, the name, the Add and Message buttons. */}
                  {addFriendsSearching && (
                    <SkeletonStatus label="Searching people">
                      <div style={GROUP}>
                        {['46%', '38%', '52%'].map((w) => (
                          <SkeletonRow key={w} bare thumb={40} round lines={[w]} trailing={[{ width: 56, height: 32, radius: 'var(--r-pill)' }, { width: 32, height: 32, radius: 'var(--r-pill)' }]} padding="10px 12px" gap={12} marginBottom={0} style={{ minHeight: '60px' }} />
                        ))}
                      </div>
                    </SkeletonStatus>
                  )}

                  {/* A network or server failure, in the server's own words,
                      rather than "no one" drawn over a search that never ran. */}
                  {!addFriendsSearching && addFriendsError && (
                    <BirdNote layout="row" size={48} role="alert" body={addFriendsError} style={{ padding: '12px 4px' }}
                      action={<button type="button" className="hit44" onClick={() => handleAddFriendsSearch(addFriendsSearch)} style={RETRY}>Try again</button>} />
                  )}

                  {!addFriendsSearching && !addFriendsError && addFriendsSearch.trim() && addFriendsResults.length === 0 && (
                    <BirdNote size={64} title={`No one called "${query}" yet`} body="Not on Flock yet? Send them your code." action={inviteButton} style={{ padding: '20px 8px 8px' }} />
                  )}

                  {!addFriendsSearching && !addFriendsError && addFriendsResults.length > 0 && (
                    <div style={GROUP}>
                      {addFriendsResults.map((user, i) => personRow(user, { index: i, actions: relationActions(user, { message: true }) }))}
                    </div>
                  )}
                </>
              ) : (
                <>
                  {/* People you may know: mutual friends, then people from
                      plans. A failed read is its own sentence with a retry, and
                      the empty state is held back while it stands, because "no
                      one yet" over a read that never landed would tell a person
                      with twenty friends they had none. */}
                  {friendSuggestionsError && (
                    <div role="status" style={ERROR_ROW}>
                      <p style={ERROR_TEXT}>{friendSuggestionsError}</p>
                      <button type="button" className="hit44" onClick={() => loadAddFriendsData()} style={RETRY}>Try again</button>
                    </div>
                  )}
                  {friendSuggestionsError ? null : friendSuggestions.length === 0 ? (
                    <BirdNote
                      bird={WARM_BIRD}
                      size={72}
                      title="Find people you know"
                      body="Search by the name they signed up with. Not on Flock yet? Send them your code."
                      action={inviteButton}
                      style={{ padding: '24px 8px 8px' }}
                    />
                  ) : (
                    <>
                      <h2 style={{ ...BAND_HEAD, margin: '12px 0 8px' }}>People you may know</h2>
                      <div style={GROUP}>
                        {friendSuggestions.map((user, i) => personRow(user, {
                          index: i,
                          meta: user.shared_flocks != null
                            ? `${user.shared_flocks} plan${parseInt(user.shared_flocks) !== 1 ? 's' : ''} together`
                            : `${user.mutual_count} mutual friend${parseInt(user.mutual_count) !== 1 ? 's' : ''}`,
                          actions: relationActions(user),
                        }))}
                      </div>
                    </>
                  )}
                </>
              )}
            </div>
          )}

          {/* TAB: Requests */}
          {activeTab === 'requests' && (
            <div>
              {/* A failed read of the requests is said, with a retry, and never
                  rendered as "no requests" (friends audit, 2026-09-05). Plain
                  text, no bird: an error must not read like an empty inbox. */}
              {pendingRequestsError && (
                <div role="status" style={ERROR_ROW}>
                  <p style={ERROR_TEXT}>{pendingRequestsError}</p>
                  <button type="button" className="hit44" onClick={() => loadAddFriendsData()} style={RETRY}>Try again</button>
                </div>
              )}

              {/* Said to a screen reader as it happens. Always here while the
                  tab is, so the words arrive in a region it already knows. */}
              <p className="sr-only" role="status">{declinedNow}</p>

              {requestRows.length > 0 && (
                <>
                  <h2 style={BAND}>Wants to add you</h2>
                  <div style={GROUP}>
                    {requestRows.map(({ request: req, declining }, i) => personRow(req, declining ? {
                      index: i,
                      // Declined, for the few seconds it can still be taken
                      // back, in the place the request had. Its own Undo, so a
                      // toast that comes after cannot take it away (App.js
                      // handleDeclineFriendRequest).
                      meta: 'Declined.',
                      actions: <button type="button" className="hit44" aria-label={`Undo declining ${req.name || 'this request'}`} onClick={() => handleUndoDecline(req.id)} style={LINK_BUTTON}>Undo</button>,
                    } : {
                      index: i,
                      actions: (
                        <>
                          {/* No success tick on the tap: the row leaves at
                              once, and "accepted" is said when the server has
                              said it. A decline waits five seconds, with an
                              Undo on this row, before it is sent. */}
                          <button aria-label="Accept friend request" onClick={() => handleAcceptFriendRequest(req.id)} type="button" className="hit44 glass-btn glass-navy" style={pill}>Accept</button>
                          <button aria-label="Decline friend request" className="hit44" onClick={() => handleDeclineFriendRequest(req.id)} type="button" style={GHOST}>{Icons.x('var(--text-secondary)', 14)}</button>
                        </>
                      ),
                    }))}
                  </div>
                </>
              )}

              {/* What you sent. Read when the screen opens, so it can land a
                  moment after the rest: two rows in its shape until then,
                  under its own heading, where nothing it pushes can move. */}
              {(outgoingRequests.length > 0 || outgoingRequestsLoaded === false) && (
                <>
                  <h2 style={BAND}>Sent</h2>
                  {outgoingRequests.length > 0 ? (
                    <div style={GROUP}>
                      {outgoingRequests.map((req, i) => personRow(req, {
                        index: i,
                        meta: 'Pending',
                        actions: <button type="button" className="hit44" aria-label={`Cancel your request to ${req.name}`} onClick={() => handleCancelOutgoingRequest(req.id)} style={TEXT_BUTTON}>Cancel</button>,
                      }))}
                    </div>
                  ) : (
                    <SkeletonStatus label="Loading the requests you sent">
                      <div style={GROUP}>
                        {['44%', '36%'].map((w) => (
                          <SkeletonRow key={w} bare thumb={40} round lines={[w, '22%']} trailing={[{ width: 52, height: 20, radius: 4 }]} padding="10px 12px" gap={12} marginBottom={0} style={{ minHeight: '60px' }} />
                        ))}
                      </div>
                    </SkeletonStatus>
                  )}
                </>
              )}

              {!pendingRequestsError && requestRows.length === 0 && outgoingRequests.length === 0 && outgoingRequestsLoaded !== false && (
                <BirdNote
                  bird={WARM_BIRD}
                  size={72}
                  title="No requests right now"
                  body="When someone adds you, it shows up here."
                  action={<button type="button" className="hit44 glass-btn glass-secondary" onClick={() => setAddFriendsTab('username')} style={SECONDARY}>Search for people</button>}
                  style={{ padding: '28px 8px 8px' }}
                />
              )}
            </div>
          )}

          {/* TAB: Contacts */}
          {/* ------------------------------------------------------------------
              The address book card has these states, and every one of them is
              load-bearing.

              1. BEFORE THE TAP. This card IS the pre-prompt. iOS asks for the
                 address book once per install and a denial stands until the
                 person walks into Settings, so the explanation comes before
                 the system dialog rather than after it, and its one button
                 reads Continue (App Store Guideline 5.1.1(iv)). Nothing on
                 this screen speaks to the contacts service until it is
                 pressed. An unconfirmed email gets a sentence in its place:
                 the server would refuse the check after the one prompt had
                 been spent.
              2. DENIED. Where the switch is, a way there (Open Settings, in
                 the app), and Try again, which reads the permission again and
                 can never raise a second prompt: iOS does not ask twice.
              3. MATCHES. Flock name and photo, nothing else. The server never
                 says which uploaded number produced which person, and a row
                 that named the contact would rebuild the enumeration oracle
                 that refusal exists to prevent.
              4. NOBODY MATCHED, which is the ordinary answer at launch. It is
                 said as what the server knows: only people who turned on
                 being found by their number can be found.
              Under it: being findable yourself, a number typed by hand (no
              permission needed), and the invite.
              ------------------------------------------------------------------ */}
          {activeTab === 'contacts' && (() => {
            // WHICH CARD. contactsPermission is the permission as App.js last
            // read it without asking (null until it has); contactsDenied and
            // contactsUnavailable are what the last check ran into, earlier in
            // the session. A fresh reading outranks them. And in the app, a
            // reading of 'prompt' means the next look at the address book
            // raises the system dialog, so the only card offered is the one
            // that explains it first: a Try again on the refused or failed
            // card would raise the dialog with no explanation in front of it.
            // (On the web the browser asks every time and reports 'prompt'
            // throughout, so there a refusal stands as it was.)
            const inApp = typeof handleOpenAppSettings === 'function';
            const willPrompt = inApp && contactsPermission === 'prompt';
            const denied = contactsPermission === 'denied'
              || (contactsDenied && !willPrompt && (contactsPermission == null || contactsPermission === 'prompt'));
            const unavailable = !denied && !willPrompt && (contactsUnavailable || contactsPermission === 'unavailable');
            const result = contactsResult;
            const total = result ? Number(result.total) || 0 : 0;
            const checked = result ? Number(result.checked) || 0 : 0;
            const sent = result && result.sent != null ? Number(result.sent) || 0 : checked;
            const notReached = result && result.notReached != null ? Number(result.notReached) || 0 : Math.max(0, total - sent);
            const unreadable = result && result.unreadable != null ? Number(result.unreadable) || 0 : 0;
            // How far through the book the checks have got. A big book is
            // checked over several runs, each carrying on where the last one
            // stopped, so this counts from the start of the book, not from the
            // start of the last run.
            const reached = Math.max(0, total - notReached);
            // Every number it looked at was one it could not read as a phone
            // number, so nothing was compared with anybody.
            const nothingReadable = !!result && checked === 0 && notReached === 0;
            const matches = [...contactsUsers].sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));

            // The one line of counts. "Checked 600 of 1,240" while the book is
            // bigger than the checks so far, and numbers the server could not
            // read are counted on their own: they were looked at, and they are
            // not waiting for a later check.
            const countLine = !result || total === 0 ? '' : [
              notReached > 0
                ? `Checked ${count(reached)} of ${count(total)} ${total === 1 ? 'number' : 'numbers'}.`
                : checked > 0 ? `Checked ${count(checked)} ${checked === 1 ? 'number' : 'numbers'}.` : '',
              unreadable > 0 ? `${count(unreadable)} couldn't be read as ${unreadable === 1 ? 'a phone number' : 'phone numbers'}.` : '',
            ].filter(Boolean).join(' ');
            // iOS 18 lets a person share only some contacts. Said in one line,
            // and never as a push for more.
            const sharedCount = result ? Number(result.contactCount) || 0 : 0;
            const sharedLine = !result || result.permission !== 'limited' ? ''
              : sharedCount === 0 ? "You haven't shared any contacts with Flock."
                : `You shared ${count(sharedCount)} ${sharedCount === 1 ? 'contact' : 'contacts'} with Flock.`;
            const retryLine = waitingForRetry
              ? `You can check again after ${localeTime(retryAtMs, undefined, { hour: 'numeric', minute: '2-digit' })}.`
              : result && result.throttled && !result.retryAt ? "Flock can't check more numbers just now. Try again later." : '';
            const checkLabel = notReached > 0 ? `Check the next ${count(Math.min(CHECK_RUN, notReached))}` : 'Check again';
            const canCheck = !contactsLoading && !waitingForRetry && !emailUnconfirmed;
            const settingsButton = inApp
              ? <button type="button" className="hit44 glass-btn glass-secondary" onClick={() => handleOpenAppSettings()} style={SECONDARY}>Open Settings</button>
              : null;
            const notes = (
              <>
                {countLine && <p style={NOTE}>{countLine}</p>}
                {sharedLine && (
                  <p style={NOTE}>
                    {sharedLine}
                    {inApp && (
                      <> <button type="button" className="hit44" onClick={() => handleOpenAppSettings()} style={{ ...LINK_BUTTON, minHeight: 0, fontSize: 'var(--t-meta)' }}>Change in Settings</button></>
                    )}
                  </p>
                )}
                {retryLine && <p role="status" style={NOTE}>{retryLine}</p>}
              </>
            );

            return (
              <div>
                {/* The list is feed-shaped, so the wait draws the rows it is
                    about to fill rather than a spinner (DESIGN-STANDARD rule 10). */}
                {contactsLoading && (
                  <SkeletonStatus label="Checking your contacts" style={{ marginTop: '16px' }}>
                    <div style={GROUP}>
                      {['48%', '40%', '56%'].map((w) => (
                        <SkeletonRow key={w} bare thumb={40} round lines={[w]} trailing={[{ width: 56, height: 32, radius: 'var(--r-pill)' }]} padding="10px 12px" gap={12} marginBottom={0} style={{ minHeight: '60px' }} />
                      ))}
                    </div>
                  </SkeletonStatus>
                )}

                {/* STATE 2: denied. */}
                {!contactsLoading && denied && (
                  <div style={card}>
                    <BirdNote
                      layout="row"
                      size={48}
                      bird={WARM_BIRD}
                      title="Contacts are off for Flock"
                      body={inApp
                        ? 'Flock does not have permission to read your contacts. You can turn it on in Settings, under Flock, or add someone by their number below.'
                        : 'This browser did not let Flock read your contacts. You can add someone by their number below.'}
                      action={(
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                          {settingsButton}
                          <button type="button" className="hit44 glass-btn glass-secondary" onClick={() => handleSyncContacts()} disabled={contactsLoading} style={SECONDARY}>Try again</button>
                        </div>
                      )}
                    />
                  </div>
                )}

                {/* The contacts service could not be reached at all, which is
                    not a refusal and must not send anyone to Settings. */}
                {!contactsLoading && unavailable && (
                  <div style={card}>
                    <BirdNote
                      layout="row"
                      size={48}
                      bird={WARM_BIRD}
                      title="Couldn't open your contacts"
                      body="You can still add someone by their number below."
                      action={<button type="button" className="hit44 glass-btn glass-secondary" onClick={() => handleSyncContacts()} disabled={contactsLoading} style={SECONDARY}>Try again</button>}
                    />
                  </div>
                )}

                {/* STATE 1: before the tap. Nothing above this line has spoken
                    to the contacts service, so the system prompt has not fired
                    and cannot fire until the button below is pressed. */}
                {!contactsLoading && !denied && !unavailable && !contactsResult && (
                  <div style={card}>
                    <h2 style={CARD_TITLE}>Find friends from your contacts</h2>
                    {/* Every clause here is something services/contacts.js and
                        backend/routes/friends.js actually do: the projection is
                        phones only, matching is gated on the other person's own
                        opt-in, and a number belonging to a non-user is never
                        written down. */}
                    <p style={CARD_BODY}>Flock sends only phone numbers, checks them against people who chose to be findable, and keeps nothing. Names and everything else stay on your phone.</p>
                    {emailUnconfirmed ? (
                      <p style={{ ...NOTE, margin: 0 }}>Once your email is confirmed, you can check your contacts here.</p>
                    ) : (
                      <>
                        <button type="button" className="hit44 glass-btn glass-primary" onClick={() => handleSyncContacts()} disabled={contactsLoading || waitingForRetry} style={PRIMARY}>
                          Continue
                        </button>
                        {/* A check the server refused before it checked
                            anything: no result to show, only when to try. */}
                        {retryLine && <p role="status" style={{ ...NOTE, margin: '10px 0 0', textAlign: 'center' }}>{retryLine}</p>}
                      </>
                    )}
                  </div>
                )}

                {/* STATE 3: matches. Flock name and photo only. */}
                {!contactsLoading && !denied && result && matches.length > 0 && (
                  <>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', margin: '20px 0 8px' }}>
                      <h2 style={{ ...BAND_HEAD, margin: 0 }}>Contacts on Flock</h2>
                      <button type="button" className="hit44" onClick={() => handleSyncContacts()} disabled={!canCheck} style={{ ...LINK_BUTTON, opacity: canCheck ? 1 : 0.5, cursor: canCheck ? 'pointer' : 'default' }}>{checkLabel}</button>
                    </div>
                    {notes}
                    <div style={GROUP}>
                      {matches.map((user, i) => personRow(user, { index: i, meta: 'Uses a number from your contacts', actions: relationActions(user) }))}
                    </div>
                  </>
                )}

                {/* STATE 4: nobody matched. Said as what the server knows, with
                    the counts, never as a claim about every number on the
                    phone. */}
                {!contactsLoading && !denied && result && matches.length === 0 && (
                  <div style={{ ...card, textAlign: 'center' }}>
                    <BirdieStill bird={WARM_BIRD} size={64} style={{ margin: '0 auto 10px' }} />
                    <p style={{ margin: '0 0 8px', fontSize: 'var(--t-label)', lineHeight: 1.5, color: 'var(--text-primary)' }}>
                      {contactsResult.total === 0 || nothingReadable
                        ? 'None of your contacts have a phone number Flock can check. Add someone by their number below.'
                        : 'None of these numbers belong to someone who turned on being found by their number.'}
                    </p>
                    {notes}
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', justifyContent: 'center', marginTop: '6px' }}>
                      <button type="button" className="hit44 glass-btn glass-secondary" onClick={() => handleSyncContacts()} disabled={!canCheck} style={SECONDARY}>{checkLabel}</button>
                      {inviteButton}
                    </div>
                  </div>
                )}

                {/* LET FRIENDS FIND YOU. A check of somebody else's contacts
                    only finds people who turned this on, and it is off until
                    they do, two screens deep in Settings. So it is offered here,
                    beside the check, whenever it is off. Opt-in only: nothing
                    here ever turns it on without the tap. */}
                {(phoneDiscoverable === false || (findMeShown && phoneDiscoverable !== null)) && (
                  <div style={card}>
                    <h2 style={CARD_TITLE}>Let friends find you</h2>
                    <p style={{ ...CARD_BODY, marginBottom: phoneOnFile ? '12px' : '14px' }}>
                      {phoneOnFile
                        ? 'People who have your number in their contacts can find you here. It stays off until you turn it on.'
                        : 'People who have your number in their contacts can find you here, once your number is on your profile. It stays off until you turn it on.'}
                    </p>
                    {phoneOnFile ? (
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
                        <span style={{ fontSize: 'var(--t-label)', fontWeight: '600', color: 'var(--text-primary)' }}>Let friends find me by my phone number</span>
                        <button type="button" role="switch" aria-checked={findMeOn} aria-label="Let friends find me by my phone number" aria-busy={findMePending !== null || undefined} className="hit44"
                          onClick={findMePending !== null ? undefined : toggleFindMe}
                          style={{ width: '44px', height: '24px', flexShrink: 0, borderRadius: 'var(--r-pill)', border: 'none', padding: 0, backgroundColor: findMeOn ? 'var(--toggle-on)' : 'var(--toggle-off)', cursor: findMePending !== null ? 'wait' : 'pointer', opacity: findMePending !== null ? 0.6 : 1, transition: 'background-color 0.2s, opacity 0.2s' }}>
                          <span aria-hidden="true" style={{ position: 'absolute', top: '2px', left: findMeOn ? '22px' : '2px', width: '20px', height: '20px', borderRadius: 'var(--r-pill)', backgroundColor: 'var(--bg-card-solid)', boxShadow: '0 1px 3px rgba(0,0,0,0.2)', transition: 'left 0.2s' }} />
                        </button>
                      </div>
                    ) : (
                      <button type="button" className="hit44 glass-btn glass-secondary" onClick={() => openEditProfile()} style={SECONDARY}>Add your number</button>
                    )}
                  </div>
                )}

                {/* BY NUMBER. The half that needs no permission, so it works
                    in every state above, including the one where the address
                    book is closed for good. data-kb-keep: with the keys up the
                    field, Look up and the answer come up above them together. */}
                <div data-kb-keep="" ref={byNumberRef}>
                  <h2 style={{ ...BAND, marginTop: '24px' }}>By number</h2>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    {/* The number is typed into the box and reaches App.js on a
                        pause; Look up and Return hand over what the box shows,
                        so neither can look up a number one digit short. The
                        phone pad has no Return key, so Look up is the way out:
                        it puts the pad away, and the answer is brought into
                        view when it lands. */}
                    <SearchInputLocal aria-label="Phone number" type="tel" inputMode="tel" autoComplete="tel" enterKeyHint="search" inputRef={phoneRef} initialValue={phoneLookupInput}
                      onCommit={(value) => { setPhoneLookupInput(value); setPhoneLookupError(''); setPhoneLookupUsers(null); }}
                      onKeyDown={(e) => { if (!isReturn(e)) return; e.preventDefault(); const typed = e.currentTarget.value; e.currentTarget.blur(); lookUp(typed); }}
                      placeholder="(555) 555-0123" maxLength={20}
                      style={{ ...FIELD, flex: 1, minWidth: 0 }}
                    />
                    <button type="button" className="hit44 glass-btn glass-secondary" onClick={() => lookUp()} disabled={phoneLookupLoading || !phoneLookupInput.trim()} style={SECONDARY}>
                      {phoneLookupLoading ? (
                        <>
                          <span aria-hidden="true" style={{ visibility: 'hidden' }}>Look up</span>
                          <span aria-hidden="true" style={RING} />
                          <span className="sr-only">Looking up</span>
                        </>
                      ) : 'Look up'}
                    </button>
                  </div>

                  {phoneLookupError && (
                    <p role="alert" style={{ margin: '10px 0 0', fontSize: 'var(--t-meta)', fontWeight: '600', lineHeight: 1.4, color: colors.redText }}>{phoneLookupError}</p>
                  )}

                  {!phoneLookupError && phoneLookupUsers && phoneLookupUsers.length > 0 && (
                    <div style={{ ...GROUP, marginTop: '10px' }}>
                      {phoneLookupUsers.map((user, i) => personRow(user, { index: i, meta: 'Matches the number you typed', actions: relationActions(user) }))}
                    </div>
                  )}

                  {/* "Not on Flock" would be a false statement about somebody
                      who has an account and simply has not opted in to being
                      found by their number. The server cannot tell those two
                      apart on purpose, so neither may this line. */}
                  {!phoneLookupError && phoneLookupUsers && phoneLookupUsers.length === 0 && (
                    <BirdNote layout="row" bird={WARM_BIRD} size={48} body="Nobody on Flock has that number, or they have not turned on being found by it." style={{ marginTop: '10px' }} />
                  )}
                </div>

                {/* INVITE. One link, never one per contact: a per-contact invite
                    would need the server to say which number produced which
                    person, which is the one thing find-by-phone refuses to
                    answer. The share sheet picks the recipient, and Flock never
                    learns who it was. */}
                <button type="button" className="hit44" onClick={() => handleInviteFriend()} disabled={!myFriendCode}
                  style={{ ...LINK_BUTTON, display: 'inline-flex', alignItems: 'center', gap: '6px', minHeight: '44px', marginTop: '12px', opacity: myFriendCode ? 1 : 0.5, cursor: myFriendCode ? 'pointer' : 'default' }}>
                  {Icons.share('var(--accent-purple-text)', 15)} Not on Flock yet? Invite a friend
                </button>
              </div>
            );
          })()}

          {/* TAB: QR code */}
          {activeTab === 'qr' && (
            <div style={{ paddingTop: '20px' }}>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                <div style={{ width: `${QR_SIZE}px`, height: `${QR_SIZE}px`, flexShrink: 0, overflow: 'hidden', borderRadius: 'var(--r-lg)', backgroundColor: QR_PAPER, boxShadow: '0 1px 3px rgba(0,0,0,0.08)' }}>
                  {qrValue ? (
                    <React.Suspense fallback={<SkeletonBlock width={QR_SIZE} height={QR_SIZE} radius={0} />}>
                      <QRCodeSVG value={qrValue} size={QR_SIZE} level="M" marginSize={4} bgColor={QR_PAPER} fgColor={QR_INK} title={`QR code for ${myFriendCode || 'your Flock code'}`} style={{ display: 'block' }} />
                    </React.Suspense>
                  ) : myFriendCodeFailed ? (
                    // The code comes from the server, so a failed read is said,
                    // with a retry, inside the tile, instead of a square that
                    // waits for ever. The tile is white in both themes, so the
                    // words are the code's own ink.
                    <div role="status" style={{ width: '100%', height: '100%', boxSizing: 'border-box', padding: '16px', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '10px' }}>
                      <p style={{ margin: 0, fontSize: 'var(--t-label)', color: QR_INK, textAlign: 'center' }}>Your code did not load.</p>
                      <button type="button" className="hit44" onClick={() => loadAddFriendsData()} style={{ ...RETRY, backgroundColor: QR_PAPER, color: QR_INK, border: '1px solid #d1d5db' }}>Try again</button>
                    </div>
                  ) : (
                    /* The tile's square while the server mints the code. No
                       pattern in it: a QR-looking square would be a code that
                       scans to nothing. */
                    <SkeletonStatus label="Loading your Flock code">
                      <SkeletonBlock width={QR_SIZE} height={QR_SIZE} radius={0} />
                    </SkeletonStatus>
                  )}
                </div>

                {/* Whose code this is, for the friend looking at the screen. */}
                {myName ? (
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', maxWidth: '100%', marginTop: '14px' }}>
                    {myPhotoUrl && <img src={myPhotoUrl} alt="" draggable="false" style={{ width: '28px', height: '28px', flexShrink: 0, borderRadius: '50%', objectFit: 'cover' }} />}
                    <p style={{ margin: 0, minWidth: 0, fontFamily: 'var(--font-display)', fontWeight: '600', fontSize: 'var(--t-title)', letterSpacing: '-0.005em', color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{myName}</p>
                  </div>
                ) : null}
                {/* A phone's own camera opens the link, and only the link: the
                    JSON the QR carries until the server switches (friendQrText)
                    is read by Flock's scanner and nothing else. */}
                <p style={{ margin: '4px 0 0', fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', textAlign: 'center' }}>
                  {qrTextIsLink(qrValue) ? 'Friends can scan this with their phone camera.' : 'Friends can scan this in Flock.'}
                </p>

                {/* The code itself, which copies, and Share, which sends the
                    link. One row, in the place they will take, so nothing below
                    moves when the code lands. */}
                {myFriendCode ? (
                  <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: '8px', marginTop: '10px' }}>
                    <button type="button" className="hit44" aria-label={`Copy your code, ${myFriendCode}`} onClick={copyCode}
                      style={{ height: '40px', padding: '0 14px', borderRadius: 'var(--r-pill)', border: '1px solid var(--border-default)', backgroundColor: 'var(--bg-card-solid)', color: 'var(--text-primary)', display: 'inline-flex', alignItems: 'center', gap: '10px', cursor: 'pointer', fontSize: 'var(--t-body)', fontWeight: '600' }}>
                      <span style={{ letterSpacing: '1.5px' }}>{myFriendCode}</span>
                      <span aria-hidden="true" style={{ color: 'var(--accent-purple-text)', fontSize: 'var(--t-label)' }}>Copy</span>
                    </button>
                    <button type="button" className="hit44" onClick={() => handleShareMyCode()}
                      style={{ height: '40px', padding: '0 14px', borderRadius: 'var(--r-pill)', border: '1px solid var(--border-default)', backgroundColor: 'var(--bg-card-solid)', color: 'var(--text-primary)', display: 'inline-flex', alignItems: 'center', gap: '6px', cursor: 'pointer', fontSize: 'var(--t-label)', fontWeight: '600' }}>
                      {Icons.share('var(--text-primary)', 16)} Share
                    </button>
                  </div>
                ) : !myFriendCodeFailed ? (
                  <div aria-hidden="true" style={{ display: 'flex', justifyContent: 'center', gap: '8px', marginTop: '10px' }}>
                    <SkeletonBar width={190} height={40} radius="var(--r-pill)" />
                    <SkeletonBar width={96} height={40} radius="var(--r-pill)" />
                  </div>
                ) : null}
              </div>

              {/* The scanner opens over the whole app (App.js), not inside this
                  tab, so nothing on this screen shows through it. */}
              <button type="button" className="hit44 glass-btn glass-primary" onClick={() => openQrScanner()} style={{ ...PRIMARY, marginTop: '20px' }}>
                {qrScanMark('currentColor', 18)} Scan a friend's code
              </button>

              {/* HAVE A CODE? Return sends it, Add sends it, and both put the
                  keys away. The box takes a pasted link or a whole invite as
                  well as a bare code (maxLength 64), and the reader behind
                  handleAddByCode finds the code in any of them. */}
              <div data-kb-keep="" ref={codeKeepRef}>
                <h2 style={{ ...BAND, marginTop: '24px' }}>Have a code?</h2>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <SearchInputLocal aria-label="Friend code" type="text" inputRef={codeRef} initialValue={friendCodeInput} onCommit={setFriendCodeInput} transform={codeCase} placeholder="FLOCK-XXXXXXXX" maxLength={64}
                    autoComplete="off" autoCorrect="off" autoCapitalize="characters" spellCheck={false} enterKeyHint="go"
                    onKeyDown={(e) => { if (!isReturn(e)) return; e.preventDefault(); const typed = e.currentTarget.value; e.currentTarget.blur(); addCode(typed); }}
                    style={{ ...FIELD, flex: 1, minWidth: 0, letterSpacing: '1px' }}
                  />
                  <button type="button" className="hit44 glass-btn glass-secondary" onClick={() => addCode()} disabled={friendCodeLoading || !friendCodeInput.trim()} style={SECONDARY}>
                    {friendCodeLoading ? (
                      <>
                        <span aria-hidden="true" style={{ visibility: 'hidden' }}>Add</span>
                        <span aria-hidden="true" style={RING} />
                        <span className="sr-only">Adding</span>
                      </>
                    ) : 'Add'}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* The keyboard's room: the hook sizes this while the keys are up.
              Outside every tab, and no style prop, so React never resets the
              height the hook wrote. */}
          <div ref={kbSpacerRef} aria-hidden="true" />
        </div>
      </div>
    );
}
