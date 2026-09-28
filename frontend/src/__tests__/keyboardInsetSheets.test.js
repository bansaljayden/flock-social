/**
 * EVERY SHEET WITH A FIELD RISES WITH THE KEYBOARD.
 *
 * capacitor.config.ts sets the keyboard plugin to `resize: 'none'` app-wide.
 * The WebView then never shrinks for the keyboard, and the plugin removes
 * WKWebView's own keyboard observers, so WebKit cannot scroll a covered field
 * into view either. The chat composer has its own dock and the sign-in screens
 * pad themselves; everything else with a field near the bottom was under the
 * keys: Birdie's box, the budget and bill amounts with Submit under them, the
 * invite search, the New Message search and the report sheet's details.
 *
 * hooks/useKeyboardInset.js now writes the plugin's keyboardWillShow height
 * onto <html> as --kb-height, index.css derives --kb-inset (the height less the
 * home indicator strip), and `.kb-lift` pads a bottom-anchored backdrop by it.
 *
 * This file holds three things:
 *   1. the hook, run for real: the events in, the variable out;
 *   2. the CSS the lift depends on, and the shell mounting the hook;
 *   3. a sweep of every bottom-anchored overlay in src/ that contains a text
 *      field, so a new sheet with a field goes red here rather than under
 *      somebody's thumb. Each must use `.kb-lift` or pad by the keyboard
 *      variables itself, and its sheet must carry var(--safe-bottom), which is
 *      the strip --kb-inset has already taken off the keyboard's height.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test keyboardInsetSheets --watchAll=false
 */

import React from 'react';
import { render, act } from '@testing-library/react';
import useKeyboardInset, { KB_HEIGHT_VAR, keyboardHeightFromEvent } from '../hooks/useKeyboardInset';

const fs = require('fs');
const path = require('path');
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;

const SRC = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(SRC, ...p), 'utf8');
const CSS = read('index.css');
const APP = read('App.js');

/* The bridge builds these with document.createEvent('Events') and copies the
   data onto the event object (native-bridge.js, cap.createEvent). */
const nativeEvent = (name, data) => {
  const ev = document.createEvent('Events');
  ev.initEvent(name, false, false);
  Object.assign(ev, data || {});
  return ev;
};

function Probe() {
  useKeyboardInset();
  return null;
}

const kbHeight = () => document.documentElement.style.getPropertyValue(KB_HEIGHT_VAR);

describe('useKeyboardInset, run', () => {
  afterEach(() => {
    document.documentElement.style.removeProperty(KB_HEIGHT_VAR);
  });

  test('nothing is written until the plugin says something', () => {
    render(<Probe />);
    expect(kbHeight()).toBe('');
  });

  test('keyboardWillShow writes its height and keyboardWillHide puts it back to zero', () => {
    render(<Probe />);
    act(() => { window.dispatchEvent(nativeEvent('keyboardWillShow', { keyboardHeight: 336 })); });
    expect(kbHeight()).toBe('336px');
    act(() => { window.dispatchEvent(nativeEvent('keyboardWillHide')); });
    expect(kbHeight()).toBe('0px');
  });

  test('a second show for the emoji keyboard replaces the height, it does not add to it', () => {
    render(<Probe />);
    act(() => { window.dispatchEvent(nativeEvent('keyboardWillShow', { keyboardHeight: 336 })); });
    act(() => { window.dispatchEvent(nativeEvent('keyboardWillShow', { keyboardHeight: 381.5 })); });
    expect(kbHeight()).toBe('382px');
  });

  test('keyboardDidHide is a backstop for a will-hide that never arrived', () => {
    render(<Probe />);
    act(() => { window.dispatchEvent(nativeEvent('keyboardWillShow', { keyboardHeight: 300 })); });
    act(() => { window.dispatchEvent(nativeEvent('keyboardDidHide')); });
    expect(kbHeight()).toBe('0px');
  });

  test('unmounting removes the listeners and the variable', () => {
    const { unmount } = render(<Probe />);
    act(() => { window.dispatchEvent(nativeEvent('keyboardWillShow', { keyboardHeight: 300 })); });
    unmount();
    expect(kbHeight()).toBe('');
    window.dispatchEvent(nativeEvent('keyboardWillShow', { keyboardHeight: 300 }));
    expect(kbHeight()).toBe('');
  });

  test('a height that is not a positive number reads as no keyboard', () => {
    expect(keyboardHeightFromEvent(nativeEvent('keyboardWillShow', { keyboardHeight: 0 }))).toBe(0);
    expect(keyboardHeightFromEvent(nativeEvent('keyboardWillShow', { keyboardHeight: -20 }))).toBe(0);
    expect(keyboardHeightFromEvent(nativeEvent('keyboardWillShow', { keyboardHeight: 'abc' }))).toBe(0);
    expect(keyboardHeightFromEvent(nativeEvent('keyboardWillShow'))).toBe(0);
    expect(keyboardHeightFromEvent(null)).toBe(0);
    // A CustomEvent carrying it in `detail` is read too.
    expect(keyboardHeightFromEvent({ detail: { keyboardHeight: 291 } })).toBe(291);
  });
});

describe('the CSS and the mount the lift depends on', () => {
  test('--kb-inset is the keyboard height less the home indicator strip, floored at zero', () => {
    expect(CSS).toMatch(/--kb-inset:\s*max\(0px,\s*calc\(var\(--kb-height,\s*0px\)\s*-\s*var\(--safe-bottom\)\)\);/);
  });

  test('.kb-lift pads the backdrop by --kb-inset', () => {
    const at = CSS.indexOf('.kb-lift {');
    expect(at).toBeGreaterThan(-1);
    const block = CSS.slice(at, CSS.indexOf('}', at));
    expect(block).toMatch(/padding-bottom:\s*var\(--kb-inset,\s*0px\);/);
  });

  test('the signed-in shell mounts the hook once, unconditionally', () => {
    expect(APP).toMatch(/^import useKeyboardInset from '\.\/hooks\/useKeyboardInset';/m);
    const inner = APP.indexOf('const FlockAppInner = ');
    const call = APP.indexOf('useKeyboardInset();');
    expect(call).toBeGreaterThan(inner);
    expect(APP.indexOf('useKeyboardInset();', call + 1)).toBe(-1);
    // Before the first early return of the component, so no path skips it.
    const firstReturn = APP.indexOf('\n  if (', inner);
    expect(firstReturn === -1 || call < firstReturn).toBe(true);
  });

  test('the budget and bill amounts ask for the decimal keypad', () => {
    const chat = read('screens', 'ChatDetail.js');
    expect(chat).toMatch(/aria-label="Amount" type="number" inputMode="decimal"/);
    expect(chat).toMatch(/aria-label="Bill total" type="number" inputMode="decimal"/);
  });
});

/* ── The sweep ───────────────────────────────────────────────────────────── */

const PARSE = {
  sourceType: 'module',
  plugins: ['jsx', 'classProperties', 'optionalChaining', 'nullishCoalescingOperator', 'objectRestSpread', 'dynamicImport'],
};

const allFiles = () => {
  const out = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      if (fs.statSync(p).isDirectory()) {
        // The marketing site is a browser page, where the browser does move a
        // covered field, and the tests are not app code.
        if (name === '__tests__' || name === 'website') continue;
        walk(p);
      } else if (/\.js$/.test(name)) {
        out.push(p);
      }
    }
  };
  walk(SRC);
  return out;
};

const styleOf = (opening) => {
  const attr = opening.attributes.find((a) => a.type === 'JSXAttribute' && a.name && a.name.name === 'style');
  if (!attr || !attr.value || attr.value.type !== 'JSXExpressionContainer') return null;
  const expr = attr.value.expression;
  if (expr.type !== 'ObjectExpression') return null;
  const out = {};
  expr.properties.forEach((p) => {
    if (p.type === 'ObjectProperty') out[p.key.name || p.key.value] = p.value;
  });
  return out;
};

const TEXT_FIELD_TYPES_SKIPPED = new Set(['checkbox', 'radio', 'file', 'range', 'hidden', 'button', 'submit', 'color']);
const isTextField = (opening) => {
  const name = opening.name && opening.name.name;
  if (name !== 'input' && name !== 'textarea' && name !== 'SearchInputLocal') return false;
  const type = opening.attributes.find((a) => a.name && a.name.name === 'type');
  return !(type && type.value && TEXT_FIELD_TYPES_SKIPPED.has(type.value.value));
};

/** Every absolutely or fixed positioned, bottom-anchored overlay that has a
 *  text field somewhere inside it. */
function sheetsWithFields() {
  const found = [];
  allFiles().forEach((file) => {
    const src = fs.readFileSync(file, 'utf8');
    if (!/alignItems:\s*[^,}]*'flex-end'/.test(src)) return;
    const ast = parser.parse(src, PARSE);
    traverse(ast, {
      JSXElement(p) {
        const style = styleOf(p.node.openingElement);
        if (!style || !style.alignItems || !style.position) return;
        const text = (n) => src.slice(n.start, n.end);
        if (!/'flex-end'/.test(text(style.alignItems))) return;
        if (!/'(absolute|fixed)'/.test(text(style.position))) return;
        let field = false;
        p.traverse({ JSXOpeningElement(q) { if (isTextField(q.node)) field = true; } });
        if (!field) return;
        found.push({ file: path.relative(SRC, file).replace(/\\/g, '/'), line: p.node.loc.start.line, node: p.node, src });
      },
    });
  });
  return found;
}

const SHEETS = sheetsWithFields();
const where = (s) => `${s.file}:${s.line}`;

describe('every bottom sheet with a text field rises with the keyboard', () => {
  test('the sweep finds the sheets this was written for', () => {
    // If the walk stopped seeing sheets, every check below would pass on
    // nothing. These are the surfaces that were covered.
    const files = new Set(SHEETS.map((s) => s.file));
    ['screens/ChatDetail.js', 'components/NewDmModal.js', 'components/ModerationSheet.js', 'components/birdie/BirdiePanel.js']
      .forEach((f) => expect(files.has(f)).toBe(true));
    expect(SHEETS.filter((s) => s.file === 'screens/ChatDetail.js').length).toBeGreaterThanOrEqual(2);
  });

  test('each one is lifted by the keyboard variables', () => {
    const unlifted = SHEETS.filter((s) => {
      const open = s.src.slice(s.node.openingElement.start, s.node.openingElement.end);
      return !/\bkb-lift\b/.test(open) && !/--kb-(inset|height)/.test(open);
    });
    // A failure names the overlay. Add className "kb-lift" to it (and keep
    // any inline `padding` shorthand off it), or pad it by var(--kb-inset).
    expect(unlifted.map(where)).toEqual([]);
  });

  test('each one keeps its last control out of the home indicator strip', () => {
    // --kb-inset is the keyboard less var(--safe-bottom), so a lifted sheet
    // that does not pad its own bottom by var(--safe-bottom) ends that strip's
    // depth under the keys. The overlay's own subtree must mention it.
    const missing = SHEETS.filter((s) => !/var\(--safe-bottom\)/.test(s.src.slice(s.node.start, s.node.end)));
    expect(missing.map(where)).toEqual([]);
  });
});

describe('the flat-20px sheets that sat in the home indicator strip', () => {
  const sheetPaddings = (file) => {
    const src = read(...file.split('/'));
    const out = [];
    // One line per backdrop, and `[^\n]` rather than `[^>]` because the invite
    // sheet's backdrop has an arrow function in its onClick.
    const re = /<div className="modal-backdrop[^"]*"[^\n]*alignItems: 'flex-end'[^\n]*\n[\s\S]*?className="modal-content[^"]*" style=\{\{([^}]*)\}\}/g;
    let m;
    while ((m = re.exec(src))) {
      const pad = /padding: '([^']*)'/.exec(m[1]);
      out.push(pad ? pad[1] : '(none)');
    }
    return out;
  };

  test.each([
    ['screens/ChatDetail.js', 4],
    ['screens/DmDetail.js', 2],
  ])('every bottom sheet in %s pads by var(--safe-bottom)', (file, atLeast) => {
    const pads = sheetPaddings(file);
    expect(pads.length).toBeGreaterThanOrEqual(atLeast);
    pads.forEach((p) => expect(p).toMatch(/var\(--safe-bottom\)/));
  });
});
