/**
 * Measure what the app actually draws at phone widths: tap targets, overflow,
 * clipped text, distorted images, and the spread of type sizes, corner radii
 * and icon sizes.
 *
 * Runs against the stack capture-screenshots.mjs leaves up with --keep-alive,
 * like sweep-buttons.mjs, and reads the same SHOTS_API_PORT / SHOTS_WEB_PORT.
 * Signed in as the demo person, it opens the Nest, Plans, Messages and You
 * tabs, a plan chat and that plan's detail screen, at each width in each
 * theme, then the public pages signed out.
 *
 *     node scripts/capture-screenshots.mjs --only=plans --keep-alive      (terminal 1)
 *     node scripts/audit-proportions.mjs [--widths=320,375,390,430] [--themes=light,dark] [--out=DIR]
 *
 * Output: DIR/proportions.json, DIR/proportions.txt and a screenshot per
 * screen. The text file has one line per screen and theme and width, then the
 * spreads.
 *
 * HOW A SMALL TARGET IS JUDGED. Most controls here are drawn under 44pt on
 * purpose and carry index.css's .hit44, which lays a transparent 44x44 box
 * over them, so the drawn box proves nothing either way. A control under 44 in
 * either axis is measured instead: from its centre, elementFromPoint is walked
 * out in half pixels each way until something else answers, and the span it
 * still owns has to reach 43 (44 less half a pixel of rounding each side).
 * That catches the real failures: two .hit44 overlays on a pitch under 44 (the
 * later one wins the overlap), an overlay clipped by an overflow:hidden host,
 * and a control with no overlay at all. A walk past the edge of the screen
 * counts as owned, since a target on the edge runs to it. Left out: visually hidden controls (screen-reader
 * actions, 1x1), a control covered at its centre by a fixed bar or a sheet
 * (scrolled to, not tapped where it sits), and an inline link inside a
 * paragraph (WCAG 2.5.8's inline exception).
 *
 * Known and accepted, so expect them in every run: the chat's full-width pin
 * strip and cash pool strip (36pt and 35pt tall, edge to edge; see the note on
 * .cs-strip in components/chat/sheets/sheets.css), the reaction pills under a
 * message (44 tall, a column each, 3px apart; see MessageRow.js), and the
 * composer field (40 tall inside a 52pt bar, measured from the iPhone capture
 * in chatInput.css).
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright';

const API_ORIGIN = `http://127.0.0.1:${Number(process.env.SHOTS_API_PORT) || 5210}`;
const WEB_ORIGIN = `http://127.0.0.1:${Number(process.env.SHOTS_WEB_PORT) || 3410}`;
const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : dflt;
};
const WIDTHS = opt('widths', '320,375,390,430').split(',').map(Number).filter(Boolean);
const THEMES = opt('themes', 'light,dark').split(',').map((s) => s.trim()).filter(Boolean);
const OUT = opt('out', path.join(os.tmpdir(), 'flock-proportions'));
const SHOTS = path.join(OUT, 'shots');
const SITE_PAGES = ['/', '/research', '/about', '/support', '/privacy', '/pro', '/tap'];
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(SHOTS, { recursive: true });

const log = (...a) => console.log('[proportions]', ...a);

// Runs in the page. Everything it returns is plain data.
function measure() {
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && r.bottom > 0 && r.top < innerHeight;
  };
  const name = (el) => (el.getAttribute('aria-label') || el.innerText || el.title || el.tagName).replace(/\s+/g, ' ').trim().slice(0, 50);
  const owns = (el, x, y) => {
    if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return true;
    const t = document.elementFromPoint(x, y);
    return !!t && (t === el || el.contains(t));
  };
  const small = [];
  for (const el of document.querySelectorAll('button, a[href], [role="button"], input:not([type="hidden"]), select, textarea, [role="tab"], [role="switch"], [role="checkbox"]')) {
    if (!vis(el) || el.closest('.maplibregl-ctrl')) continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 2 && r.height <= 2) continue;
    if (el.tagName === 'A' && el.closest('p, li') && getComputedStyle(el).display === 'inline') continue;
    if (r.width >= 44 && r.height >= 44) continue;
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    if (!owns(el, cx, cy)) continue;
    // How far the control still answers, walked out from the centre in half
    // pixels, each way. Two 36px buttons on a 44pt pitch answer exactly 22
    // each side of centre, so a single probe at 21.5 is decided by sub-pixel
    // layout; the walk measures the real span instead.
    const reach = (dx, dy) => {
      let d = 0;
      while (d < 30 && owns(el, cx + dx * (d + 0.5), cy + dy * (d + 0.5))) d += 0.5;
      return d >= 30 ? 99 : d;
    };
    const hitW = Math.min(99, reach(-1, 0) + reach(1, 0) + 0.5);
    const hitH = Math.min(99, reach(0, -1) + reach(0, 1) + 0.5);
    // Half a pixel of rounding either side is layout, not a finding.
    if (hitW >= 43 && hitH >= 43) continue;
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).slice(0, 3).join('.') : '';
    small.push({ name: name(el), w: Math.round(r.width), h: Math.round(r.height), hitW, hitH, cls });
  }
  const docW = document.documentElement.clientWidth;
  const overflow = [];
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && (r.right > docW + 1 || r.left < -1) && getComputedStyle(el).position !== 'fixed'
      && !el.closest('[data-hscroll], .maplibregl-map, [style*="overflow-x: auto"], [style*="overflow-x:auto"], [style*="overflow: auto"]')) {
      overflow.push({ el: el.tagName + (typeof el.className === 'string' && el.className ? `.${el.className.split(' ')[0]}` : ''), right: Math.round(r.right), text: name(el) });
    }
  }
  const clipped = [];
  for (const el of document.querySelectorAll('body *')) {
    if (!vis(el) || el.children.length > 0) continue;
    const cs = getComputedStyle(el);
    // clientWidth <= 2 is the visually hidden pattern, clipped on purpose.
    if ((cs.overflow === 'hidden' || cs.textOverflow === 'ellipsis') && el.clientWidth > 2 && el.scrollWidth > el.clientWidth + 1 && (el.innerText || '').trim().length > 3) {
      clipped.push({ text: (el.innerText || '').trim().slice(0, 60), ellipsis: cs.textOverflow === 'ellipsis' });
    }
  }
  const distorted = [];
  for (const img of document.querySelectorAll('img')) {
    if (!vis(img) || !img.naturalWidth) continue;
    if (['cover', 'contain', 'scale-down'].includes(getComputedStyle(img).objectFit)) continue;
    const r = img.getBoundingClientRect();
    const a = img.naturalWidth / img.naturalHeight;
    if (Math.abs(a - r.width / r.height) / a > 0.03) distorted.push({ src: img.currentSrc.split('/').pop().slice(0, 50), natural: `${img.naturalWidth}x${img.naturalHeight}`, shown: `${Math.round(r.width)}x${Math.round(r.height)}` });
  }
  const tally = (pick) => {
    const m = {};
    for (const el of document.querySelectorAll('body *')) {
      if (!vis(el)) continue;
      const v = pick(el);
      if (v) m[v] = (m[v] || 0) + 1;
    }
    return m;
  };
  const ownText = (el) => Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim());
  return {
    small,
    overflow: overflow.slice(0, 15),
    clipped: clipped.slice(0, 20),
    distorted,
    fontSizes: tally((el) => (ownText(el) ? getComputedStyle(el).fontSize : null)),
    radii: tally((el) => { const v = getComputedStyle(el).borderTopLeftRadius; return v && v !== '0px' ? v : null; }),
    iconSizes: tally((el) => { if (el.tagName.toLowerCase() !== 'svg') return null; const r = el.getBoundingClientRect(); return `${Math.round(r.width)}x${Math.round(r.height)}`; }),
  };
}

async function main() {
  const login = await fetch(`${API_ORIGIN}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'maya@shots.flock.local', password: 'Screenshot1' }),
  }).then((r) => r.json()).catch(() => ({}));
  if (!login.token) throw new Error(`no stack on ${API_ORIGIN}. Start it: node scripts/capture-screenshots.mjs --only=plans --keep-alive`);
  const browser = await chromium.launch({ headless: true });
  const all = [];
  const context = (width, theme, token) => browser.newContext({
    viewport: { width, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, reducedMotion: 'reduce',
    colorScheme: theme === 'dark' ? 'dark' : 'light', locale: 'en-US', timezoneId: 'America/New_York',
    permissions: ['geolocation'], geolocation: { latitude: 39.9526, longitude: -75.1652 },
  }).then(async (ctx) => {
    await ctx.addInitScript(([jwt, th]) => {
      localStorage.setItem('flock-theme-mode', 'manual');
      localStorage.setItem('flock-theme', th);
      localStorage.setItem('flock_notif_denied', 'true');
      localStorage.setItem('flockUserMode', 'person');
      localStorage.setItem('flock_user_lat', '39.9526');
      localStorage.setItem('flock_user_lng', '-75.1652');
      if (jwt) localStorage.setItem('flockToken', jwt);
    }, [token || '', theme]);
    return ctx;
  });
  try {
    for (const theme of THEMES) {
      for (const width of WIDTHS) {
        const ctx = await context(width, theme, login.token);
        const page = await ctx.newPage();
        const grab = async (screen) => {
          await page.waitForTimeout(900);
          all.push({ theme, width, screen, ...(await page.evaluate(measure)) });
          await page.screenshot({ path: path.join(SHOTS, `${theme}-${width}-${screen}.png`) }).catch(() => {});
        };
        await page.goto(`${WEB_ORIGIN}/app`);
        const nav = page.locator('nav[aria-label="Main"]').filter({ visible: true });
        await nav.waitFor({ timeout: 45000 }).catch(() => {});
        await page.waitForTimeout(2500);
        const no = page.locator('.cb-wrap .cb-btn', { hasText: 'No thanks' });
        if (await no.count()) await no.first().click().catch(() => {});
        for (const tab of ['Nest', 'Plans', 'Messages', 'You']) {
          await nav.getByRole('button', { name: new RegExp(`^${tab}`) }).first().click().catch(() => {});
          await grab(tab.toLowerCase());
        }
        await nav.getByRole('button', { name: /^Messages/ }).first().click().catch(() => {});
        await page.waitForTimeout(800);
        await page.getByText('Friday Night Crew').first().click().catch(() => {});
        await grab('chat');
        await page.getByRole('button', { name: 'Open the plan' }).first().click().catch(() => {});
        await grab('plan-details');
        await ctx.close();
        log(`${theme} ${width} done`);
      }
    }
    for (const width of WIDTHS) {
      const ctx = await context(width, 'light', '');
      const page = await ctx.newPage();
      for (const p of SITE_PAGES) {
        await page.goto(`${WEB_ORIGIN}${p}`).catch(() => {});
        await page.waitForTimeout(1500);
        const screen = `site-${p.slice(1) || 'home'}`;
        all.push({ theme: 'site', width, screen, ...(await page.evaluate(measure)) });
        await page.screenshot({ path: path.join(SHOTS, `${screen}-${width}.png`) }).catch(() => {});
      }
      await ctx.close();
    }
  } finally {
    await browser.close();
  }
  fs.writeFileSync(path.join(OUT, 'proportions.json'), JSON.stringify(all, null, 1));
  const lines = [];
  const agg = { fontSizes: {}, radii: {}, iconSizes: {} };
  for (const s of all) {
    for (const k of Object.keys(agg)) for (const [v, n] of Object.entries(s[k] || {})) agg[k][v] = (agg[k][v] || 0) + n;
    const issues = [];
    if (s.small.length) issues.push(`${s.small.length} small (${s.small.slice(0, 4).map((x) => `${x.name} ${x.w}x${x.h} reaches ${x.hitW}x${x.hitH}`).join('; ')})`);
    if (s.overflow.length) issues.push(`${s.overflow.length} overflow (${s.overflow.slice(0, 3).map((x) => `${x.el} r=${x.right}`).join('; ')})`);
    if (s.clipped.length) issues.push(`${s.clipped.length} clipped (${s.clipped.slice(0, 3).map((x) => x.text).join('; ')})`);
    if (s.distorted.length) issues.push(`${s.distorted.length} distorted`);
    lines.push(`${s.theme} ${s.width} ${s.screen}: ${issues.join(' | ') || 'clean'}`);
  }
  const top = (m) => Object.entries(m).sort((a, b) => b[1] - a[1]).map(([v, n]) => `${v}:${n}`).join(' ');
  lines.push('', `font sizes: ${top(agg.fontSizes)}`, '', `radii: ${top(agg.radii)}`, '', `icon sizes: ${top(agg.iconSizes)}`);
  fs.writeFileSync(path.join(OUT, 'proportions.txt'), lines.join('\n'));
  log(`done: ${all.length} screens -> ${OUT}`);
}

main().catch((e) => { console.error('[proportions] FAILED', e); process.exit(1); });
