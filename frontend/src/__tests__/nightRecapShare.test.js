// THE MORNING-AFTER SHARE CARD IS DRAWN LOCALLY AND NEVER A DEAD BUTTON.
//
// The distribution audit's finding: the one moment a group is warm enough to
// post, the morning after, the app handed them nothing. shareNightRecap draws
// the card on a canvas (no network, no cost) and walks the share ladder:
// Web Share with the file where the platform has it, the plain share sheet
// next, a download last, so the button always does something real
// (SLOP-AUDIT: no dead buttons). These pins hold the ladder, the honest
// copy, and the completed-only gate still.

import fs from 'fs';
import path from 'path';

const APP = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8');
// The flock detail screen, where the share button lives, left App.js on
// 2026-09-01 for screens/FlockDetail.js. The canvas function stayed behind
// in FlockAppInner, so the ladder is read from App.js and the button from
// the screen file.
const DETAIL = fs.readFileSync(
  path.join(__dirname, '..', 'screens', 'FlockDetail.js'),
  'utf8'
);
const start = APP.indexOf('const shareNightRecap');
const fn = APP.slice(start, APP.indexOf('}, [recapSharing, showToast]);', start));

describe('the card is drawn, not fetched', () => {
  test('a 1080x1350 canvas on brand navy', () => {
    expect(start).toBeGreaterThan(-1);
    expect(fn).toContain('const W = 1080;');
    expect(fn).toContain('const H = 1350;');
    expect(fn).toContain("ctx.fillStyle = '#0d2847';");
  });

  test('the stat line never claims company that was not there', () => {
    expect(fn).toContain("count > 1 ? `${count} of us were out` : 'A night on the books'");
  });
});

describe('the share ladder has all three rungs', () => {
  test('file share is gated on canShare, sheet share on share, download last', () => {
    expect(fn).toContain('navigator.canShare && navigator.canShare({ files: [file] }) && navigator.share');
    expect(fn).toContain('} else if (navigator.share) {');
    expect(fn).toContain("a.download = 'flock-night.png';");
  });

  test('closing the share sheet is not an error', () => {
    expect(fn).toContain("err?.name !== 'AbortError'");
  });

  test('a double tap cannot render two cards', () => {
    expect(fn).toContain('if (recapSharing || !flock) return;');
  });
});

describe('the button lives on the completed detail only', () => {
  test('completed plans get it, cancelled plans do not', () => {
    const btn = DETAIL.indexOf("onClick={() => shareNightRecap(flock)}");
    expect(btn).toBeGreaterThan(-1);
    const gate = DETAIL.lastIndexOf("{flock.status === 'completed' && (", btn);
    expect(gate).toBeGreaterThan(-1);
    expect(btn - gate).toBeLessThan(400);
  });
});
