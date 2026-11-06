/**
 * THE APP'S OWN WORDS ARE NOT TEXT TO COPY (2026-11-06).
 *
 * On the iPhone a long press on "No suggestions yet" under Add friends raised
 * iOS's Copy / Translate / Share bar, and a drag selected every label on the
 * You screen (the name, the handle, the Flocks and Friends counts, each
 * settings row) and pasted it as one block of text. A native app's chrome is
 * not a document. index.js now marks <html> with `flock-app` when, and only
 * when, it mounts the app, and index.css turns selection and the long-press
 * callout off under that mark with an allow-list for the things people copy:
 * fields, message text, Birdie's answers, a venue's address and phone, the
 * admin console. The website, the paper and the legal pages never get the
 * mark, so they keep ordinary selection.
 *
 * jsdom applies no stylesheet, so the cascade is resolved here the way WebKit
 * resolves it: -webkit-user-select and -webkit-touch-callout are inherited, so
 * an element's value is the one declared on it or on its nearest ancestor. The
 * rules are the real ones, parsed out of index.css and chat.css.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npm test -- --watchAll=false --testPathPattern=appChromeNotSelectable
 */
import React from 'react';
import { render } from '@testing-library/react';
import VenueDetailSheet from '../components/overlays/VenueDetailSheet';

const fs = require('fs');
const path = require('path');
const postcss = require('postcss');

const SRC = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(SRC, ...p), 'utf8').replace(/\r\n/g, '\n');
const INDEX_JS = read('index.js');
const INDEX_CSS = read('index.css');
const CHAT_CSS = read('components', 'chat', 'chat.css');

const PROPS = ['-webkit-user-select', 'user-select', '-webkit-touch-callout'];

/** Every rule in a stylesheet that declares one of the three properties, in source order. */
function selectionRules(css, file) {
  const out = [];
  postcss.parse(css).walkRules((rule) => {
    // A rule inside @media only applies under that query; none of these
    // properties is set that way, and the test says so rather than guessing.
    const decls = {};
    rule.walkDecls((d) => { if (PROPS.includes(d.prop)) decls[d.prop] = d.value.trim(); });
    if (Object.keys(decls).length === 0) return;
    const inMedia = rule.parent && rule.parent.type === 'atrule';
    out.push({ file, selectors: rule.selectors, decls, inMedia });
  });
  return out;
}

const RULES = [...selectionRules(INDEX_CSS, 'index.css'), ...selectionRules(CHAT_CSS, 'chat.css')];

/** The value WebKit uses: declared on the element, else inherited from the nearest ancestor that declares it. */
function used(el, prop) {
  for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
    let value = null;
    for (const r of RULES) {
      if (r.inMedia || r.decls[prop] === undefined) continue;
      if (r.selectors.some((s) => n.matches(s))) value = r.decls[prop];
    }
    if (value) return value;
  }
  return 'auto';
}

const selectable = (el) => used(el, '-webkit-user-select') !== 'none' && used(el, 'user-select') !== 'none';

function mountScreens({ app }) {
  document.documentElement.className = app ? 'flock-app' : '';
  document.body.innerHTML = `
    <div id="root">
      <section aria-label="You">
        <h1 id="name">Ada Tester</h1>
        <p id="handle">@adatester</p>
        <div><p id="count">0</p><p id="countLabel">Flocks</p></div>
        <button id="row"><span id="rowLabel">Edit Profile</span></button>
      </section>
      <section aria-label="Quick Add"><p id="empty">No suggestions yet</p></section>
      <a id="link" href="https://example.com">Website</a>
      <img id="photo" alt="" src="data:,">
      <input id="field" type="text">
      <textarea id="area"></textarea>
      <div id="editable" contenteditable="true"><span id="editableChild">draft</span></div>
      <div class="chat-swipe"><div class="chat-row-body"><span id="message">meet at 214 Main St</span></div></div>
      <div class="selectable"><span id="birdie">Try Torre, it is quiet until 9.</span></div>
      <div class="hub-root"><p id="admin">receipt 1182</p><code id="command">npm run build</code></div>
      <pre id="pre">example</pre>
    </div>`;
  return (id) => document.getElementById(id);
}

afterEach(() => {
  document.documentElement.className = '';
  document.body.innerHTML = '';
});

describe('index.js marks the app, and only the app', () => {
  const branch = INDEX_JS.slice(INDEX_JS.indexOf('} else if (appMounted) {'), INDEX_JS.indexOf('\n} else {', INDEX_JS.indexOf('} else if (appMounted) {')));

  test('the class goes on <html> in the branch that mounts the app', () => {
    expect(branch.length).toBeGreaterThan(100);
    expect(branch).toMatch(/document\.documentElement\.classList\.add\('flock-app'\)/);
  });

  test('no other route adds it: the website, the paper, the legal pages and the invite page keep selection', () => {
    expect((INDEX_JS.match(/classList\.add\('flock-app'\)/g) || []).length).toBe(1);
  });
});

describe('index.css', () => {
  test('every rule that turns selection or the callout off is scoped to the app', () => {
    const offs = RULES.filter((r) => r.file === 'index.css' && Object.values(r.decls).includes('none'));
    expect(offs.length).toBeGreaterThan(0);
    for (const r of offs) {
      for (const s of r.selectors) expect(s).toMatch(/^html\.flock-app\b/);
    }
  });

  test('the allow-list is one place in the global stylesheet', () => {
    const allow = RULES.filter((r) => r.file === 'index.css' && r.decls['-webkit-user-select'] === 'text' && r.decls['user-select'] === 'text');
    const selectors = allow.flatMap((r) => r.selectors);
    for (const want of ['html.flock-app input', 'html.flock-app textarea', 'html.flock-app .chat-row-body', 'html.flock-app .selectable', 'html.flock-app .hub-root', 'html.flock-app pre', 'html.flock-app code']) {
      expect(selectors).toContain(want);
    }
    expect(selectors.some((s) => /^html\.flock-app \[contenteditable\]/.test(s))).toBe(true);
  });
});

describe('inside the app', () => {
  test('the chrome is not selectable: the You screen and Quick Add\'s empty state', () => {
    const $ = mountScreens({ app: true });
    for (const id of ['name', 'handle', 'count', 'countLabel', 'rowLabel', 'empty']) {
      expect([id, selectable($(id))]).toEqual([id, false]);
    }
  });

  test('a long press on a link or a photo raises no callout', () => {
    const $ = mountScreens({ app: true });
    expect(used($('link'), '-webkit-touch-callout')).toBe('none');
    expect(used($('photo'), '-webkit-touch-callout')).toBe('none');
  });

  test('fields still take the caret and paste: text selection on, callout back to default', () => {
    const $ = mountScreens({ app: true });
    for (const id of ['field', 'area', 'editable', 'editableChild']) {
      expect([id, used($(id), '-webkit-user-select'), used($(id), 'user-select')]).toEqual([id, 'text', 'text']);
    }
    for (const id of ['field', 'area', 'editable']) {
      expect([id, used($(id), '-webkit-touch-callout')]).toEqual([id, 'default']);
    }
  });

  test('message text, Birdie\'s answers and the admin console stay copyable', () => {
    const $ = mountScreens({ app: true });
    for (const id of ['message', 'birdie', 'admin', 'command', 'pre']) {
      expect([id, selectable($(id))]).toEqual([id, true]);
    }
    // A message still raises no grey callout (chat.css), only the text bar.
    expect(used($('message'), '-webkit-touch-callout')).toBe('none');
  });
});

describe('on the website', () => {
  test('nothing is switched off: every line selects the way a page does', () => {
    const $ = mountScreens({ app: false });
    for (const id of ['name', 'handle', 'count', 'rowLabel', 'empty', 'field', 'birdie']) {
      expect([id, selectable($(id))]).toEqual([id, true]);
    }
    expect(used($('link'), '-webkit-touch-callout')).toBe('auto');
  });
});

describe('the things people copy carry the mark', () => {
  const sheetSrc = read('components', 'overlays', 'VenueDetailSheet.js');
  const PARAMS = (() => {
    const start = sheetSrc.indexOf('const VenueDetailSheet = ({');
    const end = sheetSrc.indexOf('}) => {', start);
    return sheetSrc.slice(start, end).split('\n').map((l) => l.trim()).filter((l) => /^[A-Za-z_]\w*,$/.test(l)).map((l) => l.slice(0, -1));
  })();

  test('the venue sheet: the address and the phone number', () => {
    const p = {};
    for (const name of PARAMS) p[name] = jest.fn();
    Object.assign(p, {
      DialogBehavior: () => null,
      SearchInputLocal: () => null,
      httpUrl: (u) => (typeof u === 'string' && /^https?:/.test(u) ? u : null),
      colors: {},
      venueDetailModal: { place_id: 'ChIJcopperFinch01', name: 'The Copper Finch', loading: false, formatted_address: '214 Main St, Bethlehem, PA 18018', formatted_phone_number: '(610) 555-0142' },
      venueDetailPhotoIdx: 0,
      venueDetailPromos: [],
      venueDetailEvents: [],
      venueDetailReviews: [],
      venueDetailReviewTotal: 0,
      venueDetailReviewsError: null,
      venueDetailReturnTo: null,
      pickingVenueForDm: null,
      pickingVenueForFlockId: null,
      showReviewForm: false,
      reviewRating: 0,
      reviewText: '',
      reviewSubmitting: false,
      flocks: [],
      flocksRef: { current: [] },
      meRef: { current: null },
      // The sheet's own crowd read: none of this place, none on the way.
      venueDetailCrowd: null,
      partySize: null,
    });
    const { container } = render(<VenueDetailSheet {...p} />);
    const marked = Array.from(container.querySelectorAll('.selectable')).map((el) => el.textContent);
    expect(marked).toEqual(expect.arrayContaining(['214 Main St, Bethlehem, PA 18018', '(610) 555-0142']));
  });

  test('the map card\'s address, Birdie\'s answer text and an error\'s reference number', () => {
    expect(read('components', 'venue', 'ConsumerVenueCard.js')).toContain('<span className="selectable">{activeVenue.addr}</span>');
    const birdie = read('components', 'birdie', 'BirdiePanel.js');
    const text = birdie.indexOf('{msg.text}');
    const bubble = birdie.slice(birdie.lastIndexOf('<div', text), text);
    expect(bubble).toMatch(/^<div className="selectable" /);
    expect(read('components', 'ErrorBoundary.js')).toContain('<p className="selectable" style={styles.detail}>Reference {eventId}</p>');
  });

  test('the You screen\'s handle has no copy control, so it is chrome like the rest', () => {
    const you = read('screens', 'ProfileSettings.js');
    expect(you).toContain("<p style={{ fontSize: 'var(--t-meta)', color: 'rgba(255,255,255,0.6)', margin: 0 }}>@{profileHandle}</p>");
  });
});
