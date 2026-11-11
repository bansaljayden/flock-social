/**
 * IN A DESKTOP BROWSER THE PHONE FRAME FITS THE WINDOW, AND SITS UNDER A
 * NOTICE.
 *
 * Off a phone, flockcorp.com/app draws the app inside a 375px phone frame on
 * a dark backdrop (App.js makeStyles, phoneContainer with fullBleed off). The
 * frame was 100vh tall with a 20px margin, inside a wrapper with 20px of
 * padding, so it was 80px taller than the window. Below about 892px of
 * window height its bottom was off the screen: in a 1280 x 800 window the
 * tab bar ran to 822px with its labels cut, and the page scrolled, so
 * opening Discover lifted the frame 22px. The admin console's wide frame
 * was 40px taller than the window the same way.
 *
 * The notice bar (components/NoticeBar.js) is fixed across the top of the
 * whole window. On a phone the shell's top spacer makes room for it; the
 * desktop frame has no such spacer, so its top, and with the scroll the
 * Discover search box, sat under the bar.
 *
 * Now the frame is the window less the wrapper's padding, the wrapper's top
 * padding includes the notice bar's height while one is up, and the frame
 * is still no taller than a phone. The cold-start skeleton draws the same
 * frame, so it is sized the same way and the frame does not move when the
 * app arrives.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test desktopFrameFitsWindow --watchAll=false
 */
const fs = require('fs');
const path = require('path');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8').replace(/\r\n/g, '\n');
const APP = read('App.js');
const SKELETON = read('components', 'ui', 'Skeleton.js');

function between(src, open, close) {
  const start = src.indexOf(open);
  if (start === -1) throw new Error(`"${open}" moved`);
  const end = src.indexOf(close, start + open.length);
  if (end === -1) throw new Error(`the close after "${open}" moved`);
  return src.slice(start, end);
}

// The desktop half of phoneContainer: everything after its `} : {`.
const PHONE = (() => {
  const block = between(APP, 'phoneContainer: fullBleed ? {', 'consoleContainer: {');
  return block.slice(block.indexOf('} : {'));
})();
const CONSOLE = between(APP, 'consoleContainer: {', '\n  },');
// The outer wrapper's desktop style: the second branch of its ternary.
const WRAPPER = (() => {
  const block = between(APP, '<div style={fullBleed', '<style>{');
  return block.slice(block.indexOf("      : { minHeight: '100vh'"));
})();
const BOOT_FRAME = between(SKELETON, 'function BootFrame(', '\n}\n');

const FRAME_HEIGHT = "height: 'calc(100vh - 40px - var(--notice-h, 0px))'";
const WRAPPER_PADDING = "padding: 'calc(20px + var(--notice-h, 0px)) 20px 20px'";

/* The sum the bug was about, read off the source: what the wrapper puts
   above and below the frame plus the frame's own margins must be exactly
   what the frame takes off the window, and the notice bar's height must be
   on both sides of that or on neither. */
function fits(wrapper, frame) {
  const pad = wrapper.match(/padding: 'calc\((\d+)px \+ var\(--notice-h, 0px\)\) (\d+)px (\d+)px'/);
  const height = frame.match(/height: 'calc\(100vh - (\d+)px - var\(--notice-h, 0px\)\)'/);
  const margin = frame.match(/margin: '(\d+)(?:px)? auto'/);
  if (!pad || !height || !margin) return { pad: !!pad, height: !!height, margin: !!margin };
  const around = Number(pad[1]) + Number(pad[3]) + 2 * Number(margin[1]);
  return around === Number(height[1]) ? true : { around, takenOff: Number(height[1]) };
}

describe('the app frame in a desktop browser', () => {
  test('the phone frame is the window less the padding around it, and no taller than a phone', () => {
    expect(PHONE).toContain(FRAME_HEIGHT);
    expect(PHONE).toContain("maxHeight: '812px'");
    expect(PHONE).toContain("margin: '0 auto'");
    expect(PHONE).not.toMatch(/height: '100vh'/);
    expect(fits(WRAPPER, PHONE)).toBe(true);
  });

  test('the admin console frame fits the same way', () => {
    expect(CONSOLE).toContain(FRAME_HEIGHT);
    expect(CONSOLE).toContain("margin: '0 auto'");
    expect(fits(WRAPPER, CONSOLE)).toBe(true);
  });

  test('the space above the frame clears the notice bar while one is up', () => {
    expect(WRAPPER).toContain(WRAPPER_PADDING);
    expect(WRAPPER).toContain("minHeight: '100vh'");
  });

  test('on a phone nothing changed: the shell is the screen and its spacer makes the room', () => {
    const phone = between(APP, 'phoneContainer: fullBleed ? {', '} : {');
    expect(phone).toContain("height: '100dvh'");
    expect(phone).toContain('margin: 0,');
    expect(between(APP, 'notch: fullBleed ? {', '} : {')).toContain("height: 'var(--safe-top)'");
  });
});

describe('the cold-start skeleton draws the same frame', () => {
  test('same padding, same height, same margin, so nothing moves when the app arrives', () => {
    expect(BOOT_FRAME).toContain(WRAPPER_PADDING);
    expect(BOOT_FRAME).toContain(FRAME_HEIGHT);
    expect(BOOT_FRAME).toContain("maxHeight: '812px'");
    expect(BOOT_FRAME).toContain("margin: '0 auto'");
    expect(BOOT_FRAME).not.toMatch(/height: '100vh'/);
    expect(fits(BOOT_FRAME, BOOT_FRAME.slice(BOOT_FRAME.indexOf('aria-busy="true" style={{')))).toBe(true);
  });
});
