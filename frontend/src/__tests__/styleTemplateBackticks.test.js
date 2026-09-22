/**
 * A BACKTICK INSIDE AN INLINE STYLESHEET ENDS IT, AND NOTHING ELSE NOTICES.
 *
 * Several files build a stylesheet as a template literal and hand it to a
 * style element. A backtick anywhere inside that literal closes the string
 * early. What follows is still valid JavaScript, so the file compiles, the
 * production build succeeds, and the whole unit suite stays green, because no
 * unit test renders the screen that carries the stylesheet.
 *
 * The app then dies on its first render. This happened: a CSS comment naming a
 * class quoted it in backticks, and the signed-in shell threw with several
 * thousand characters of stylesheet as the error message, which is an error
 * nobody would read as "there is a backtick in a comment". Three thousand
 * passing tests and a clean build said the app was fine while it could not
 * boot at all.
 *
 * So the guard is on the source, where the mistake is visible and cheap to
 * name: inside a style element written this way, the only backticks allowed are
 * the two that open and close it.
 *
 * This does not replace rendering the app. It catches the one failure that a
 * compiler cannot, and it names the file, the line and the character.
 */

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..');

/** Every .js under src/, minus the tests, which write these strings on purpose. */
const sourceFiles = () => {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
        walk(full);
      } else if (entry.name.endsWith('.js')) {
        out.push(full);
      }
    }
  };
  walk(SRC);
  return out;
};

const OPEN = '<style>{`';

/**
 * Every inline stylesheet in one file, as { line, body }.
 *
 * The scan is deliberately literal rather than a parse: it looks for the open
 * marker and then for the first backtick after it, which IS the bug when that
 * backtick is not the closing one. A parser would resolve the ambiguity the
 * way the compiler does and report nothing, which is exactly the outcome this
 * file exists to prevent.
 */
const sheetsIn = (text) => {
  const sheets = [];
  let at = text.indexOf(OPEN);
  while (at !== -1) {
    const bodyStart = at + OPEN.length;
    const nextTick = text.indexOf('`', bodyStart);
    sheets.push({
      line: text.slice(0, at).split('\n').length,
      bodyStart,
      // Where the string actually ends, per the compiler.
      tick: nextTick,
      // Where the author meant it to end.
      close: text.indexOf('`}</style>', bodyStart),
    });
    at = text.indexOf(OPEN, bodyStart);
  }
  return sheets;
};

/* THE SCAN, CHECKED AGAINST THE BUG IT IS FOR. A sweep over real files that
   finds nothing is indistinguishable from a sweep that cannot find anything,
   and this one would be the second kind if the marker or the search drifted.
   The samples are built rather than written so this file carries no literal
   backtick of its own inside a string. */
const TICK = String.fromCharCode(96);

describe('the scan itself', () => {
  const firstBreak = (text) => {
    for (const sheet of sheetsIn(text)) {
      if (sheet.close === -1) return 'unterminated';
      if (sheet.tick !== sheet.close) return 'broken';
    }
    return null;
  };

  test('a clean stylesheet is clean', () => {
    expect(firstBreak(`const a = <style>{${TICK}.x{color:red}${TICK}}</style>;`)).toBe(null);
  });

  test('a backtick in a comment is caught', () => {
    // The exact shape that shipped: a class name quoted in a CSS comment.
    const src = `const a = <style>{${TICK}/* the ${TICK}.glass${TICK} rule */ .x{color:red}${TICK}}</style>;`;
    expect(firstBreak(src)).toBe('broken');
  });

  test('a backtick in a css value is caught too', () => {
    const src = `const a = <style>{${TICK}.x::after{content:"${TICK}"}${TICK}}</style>;`;
    expect(firstBreak(src)).toBe('broken');
  });

  test('two clean stylesheets in one file stay clean', () => {
    const one = `<style>{${TICK}.a{color:red}${TICK}}</style>`;
    const two = `<style>{${TICK}.b{color:blue}${TICK}}</style>`;
    expect(firstBreak(`const x = ${one};\nconst y = ${two};`)).toBe(null);
  });
});

describe('inline stylesheets are one unbroken template literal', () => {
  const files = sourceFiles();

  test('there are some to check, so a broken scan cannot pass by finding nothing', () => {
    const withSheets = files.filter((f) => fs.readFileSync(f, 'utf8').includes(OPEN));
    expect(withSheets.length).toBeGreaterThan(0);
  });

  test.each(files.map((f) => [path.relative(SRC, f), f]))('%s', (rel, full) => {
    const text = fs.readFileSync(full, 'utf8').replace(/\r\n/g, '\n');
    for (const sheet of sheetsIn(text)) {
      expect(sheet.close).toBeGreaterThan(-1);
      if (sheet.tick === sheet.close) continue;
      /* A backtick before the closing one. Say where it is and what it does,
         because the runtime error this produces names neither. */
      const before = text.slice(0, sheet.tick);
      const line = before.split('\n').length;
      const context = text.slice(Math.max(sheet.bodyStart, sheet.tick - 70), sheet.tick + 30)
        .replace(/\n/g, ' ');
      throw new Error(
        `${rel}:${line} has a backtick inside the stylesheet opened at line ${sheet.line}. `
        + 'It ends the string there, and everything after it becomes code. The file will '
        + 'still compile and the screen will throw on render.\n'
        + `  ...${context}...`
      );
    }
  });
});
