/**
 * Press every visible button on every screen and say what happened.
 *
 * Runs against the stack capture-screenshots.mjs leaves up with --keep-alive
 * (backend on :5210 with seeded demo data, the built frontend on :3410). For
 * each root screen it enumerates the visible, enabled buttons, presses each
 * one from a fresh copy of that screen, and records what the press did: the
 * text that appeared or changed, whether a new screen or dialog opened, every
 * console error, page error, failed request and 4xx/5xx response, and a
 * screenshot of the result. Buttons that open a screen get their screen swept
 * one level down. Destructive buttons (sign out, delete, leave, block, report,
 * SOS, pay) are listed and skipped; nothing here should change what a real
 * account would care about, and the data is throwaway anyway.
 *
 *     node scripts/capture-screenshots.mjs --only=plans --keep-alive   (terminal 1)
 *     node scripts/sweep-buttons.mjs [--max=300] [--out=DIR]           (terminal 2)
 *
 * Output: DIR/report.json, DIR/report.md and DIR/shots/<root>/<n>-<slug>.png.
 * A button with "no visible effect" is a lead, not a verdict: some buttons are
 * legitimately inert in the demo data (nothing to show), and the screenshot
 * beside the row is how to tell.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright';

const API_ORIGIN = 'http://127.0.0.1:5210';
const WEB_ORIGIN = 'http://127.0.0.1:3410';
const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : dflt;
};
const MAX_CLICKS = Number(opt('max', 300));
const OUT = opt('out', path.join(os.tmpdir(), 'flock-button-sweep'));
const SHOTS = path.join(OUT, 'shots');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(SHOTS, { recursive: true });

const DEMO = {
  password: 'Screenshot1',
  person: 'maya@shots.flock.local',
  owner: 'owner@shots.flock.local',
};

// Never pressed. The sweep runs on throwaway data, but these either end the
// session, remove something the rest of the sweep needs, reach outside the
// app, or are the one-way doors a real user would want to be sure about.
const SKIP = /sign out|log out|logout|delete|remove|leave (this )?flock|leave plan|cancel (this )?(plan|flock|invite)|report|block|unfriend|sos|emergency|call 911|911|pay now|pay with|venmo|cash app|zelle|upgrade|subscribe|unsubscribe|deactivate|withdraw|revoke|clear all|reset|open in maps|directions|share|copy link|camera|photo|take a picture|upload/i;

const log = (...a) => console.log('[sweep]', ...a);
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'button';

async function apiLogin(email) {
  const r = await fetch(`${API_ORIGIN}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: DEMO.password }),
  });
  if (!r.ok) throw new Error(`login failed for ${email}: ${r.status} ${await r.text()}`);
  return (await r.json()).token;
}

async function newContext(browser, { token, userMode }) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    reducedMotion: 'reduce', permissions: ['geolocation'],
    geolocation: { latitude: 39.9526, longitude: -75.1652 }, locale: 'en-US', timezoneId: 'America/New_York',
    colorScheme: 'light',
  });
  await context.addInitScript(([jwt, uMode]) => {
    localStorage.setItem('flock-theme-mode', 'manual');
    localStorage.setItem('flock-theme', 'light');
    localStorage.setItem('flock_notif_denied', 'true');
    localStorage.setItem('flockUserMode', uMode);
    if (uMode === 'venue') localStorage.setItem('flockVenueOnboardingComplete', 'true');
    localStorage.setItem('flock_user_lat', '39.9526');
    localStorage.setItem('flock_user_lng', '-75.1652');
    if (jwt) localStorage.setItem('flockToken', jwt);
  }, [token || '', userMode]);
  return context;
}

// Everything that goes wrong on a page, tagged with the click it happened under.
function watch(page, sink) {
  page.on('console', (m) => {
    if (m.type() === 'error') sink.push({ kind: 'console.error', text: m.text().slice(0, 300) });
  });
  page.on('pageerror', (e) => sink.push({ kind: 'pageerror', text: String(e && e.message || e).slice(0, 300) }));
  page.on('requestfailed', (r) => {
    const u = r.url();
    if (/posthog|maptiler|googleapis|gstatic|fonts\./.test(u)) return; // third parties, not ours
    sink.push({ kind: 'requestfailed', text: `${r.method()} ${u.replace(API_ORIGIN, '')} ${r.failure()?.errorText || ''}`.slice(0, 300) });
  });
  page.on('response', (r) => {
    const u = r.url();
    if (!u.startsWith(API_ORIGIN)) return;
    if (r.status() >= 400) sink.push({ kind: `http ${r.status()}`, text: `${r.request().method()} ${u.replace(API_ORIGIN, '')}` });
  });
  page.on('dialog', async (d) => { sink.push({ kind: 'dialog', text: d.message().slice(0, 200) }); await d.dismiss().catch(() => {}); });
}

const mainNav = (page) => page.locator('nav[aria-label="Main"]').filter({ visible: true });

async function settle(page, quiet = 700) {
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  await page.waitForSelector('.skeleton', { state: 'detached', timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(quiet);
}

async function declineAnalyticsAsk(page) {
  const no = page.locator('.cb-wrap .cb-btn', { hasText: 'No thanks' });
  if (await no.count()) {
    await no.first().click().catch(() => {});
    await page.locator('.cb-wrap').waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
  }
}

async function openApp(page) {
  await page.goto(`${WEB_ORIGIN}/app`, { waitUntil: 'domcontentloaded' });
  await mainNav(page).waitFor({ timeout: 30000 }).catch(() => {});
  await page.getByText('Loading...', { exact: true }).waitFor({ state: 'detached', timeout: 20000 }).catch(() => {});
  await declineAnalyticsAsk(page);
  await settle(page);
}

// A cheap fingerprint of what is on screen: the visible text and the visible
// button names. Two fingerprints that differ mean the press did something.
async function fingerprint(page) {
  return page.evaluate(() => {
    const vis = (el) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && r.bottom > 0 && r.top < innerHeight;
    };
    const text = (document.body.innerText || '').replace(/\s+/g, ' ').trim();
    const buttons = Array.from(document.querySelectorAll('button, [role="button"], a[href]')).filter(vis)
      .map((b) => (b.getAttribute('aria-label') || b.innerText || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
    const pressed = Array.from(document.querySelectorAll('[aria-pressed], [aria-current], [aria-expanded], [aria-checked]'))
      .map((b) => `${b.getAttribute('aria-label') || b.innerText || ''}=${b.getAttribute('aria-pressed') ?? b.getAttribute('aria-current') ?? b.getAttribute('aria-expanded') ?? b.getAttribute('aria-checked')}`.replace(/\s+/g, ' ').slice(0, 60));
    const dialog = !!document.querySelector('[role="dialog"], dialog[open], .sheet-open, [aria-modal="true"]');
    return { text, buttons, pressed, dialog, url: location.href };
  });
}

function diffText(before, after) {
  const a = new Set(before.split(/(?<=[.!?])\s+|\s{2,}/));
  const fresh = after.split(/(?<=[.!?])\s+|\s{2,}/).filter((s) => s && !a.has(s));
  return fresh.join(' | ').slice(0, 240);
}

// Tag every visible, enabled button with a sweep id and return their names.
async function enumerateButtons(page) {
  return page.evaluate(() => {
    const vis = (el) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return r.width >= 8 && r.height >= 8 && cs.visibility !== 'hidden' && cs.display !== 'none'
        && cs.pointerEvents !== 'none' && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
    };
    const out = [];
    let n = 0;
    for (const el of document.querySelectorAll('button, [role="button"], a[href], input[type="submit"], summary')) {
      if (!vis(el)) continue;
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') continue;
      // Skip anything inside the hidden Explore copy of the tab bar and the
      // map's own controls (MapLibre attribution and nav are vendor UI).
      if (el.closest('.maplibregl-ctrl')) continue;
      const href = el.getAttribute('href') || '';
      if (/^(https?:|mailto:|tel:)/.test(href)) continue;
      const name = (el.getAttribute('aria-label') || el.innerText || el.value || el.title || '').replace(/\s+/g, ' ').trim();
      const id = `sw${n++}`;
      el.setAttribute('data-sweep', id);
      out.push({ id, name: name || `(unnamed ${el.tagName.toLowerCase()})`, tag: el.tagName.toLowerCase() });
    }
    return out;
  });
}

const results = [];
const errorsBySweep = [];
let clicks = 0;

async function sweepScreen(page, sink, { root, reopen, depth, cap, shotDir }) {
  fs.mkdirSync(shotDir, { recursive: true });
  const seen = new Set();
  let index = 0;
  let list = await enumerateButtons(page);
  for (let i = 0; i < list.length && index < cap && clicks < MAX_CLICKS; i += 1) {
    const b = list[i];
    const key = `${b.name}#${b.tag}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (SKIP.test(b.name)) { results.push({ root, button: b.name, tag: b.tag, skipped: true }); continue; }

    sink.length = 0;
    const before = await fingerprint(page);
    const t0 = Date.now();
    let clickError = null;
    try {
      await page.locator(`[data-sweep="${b.id}"]`).first().click({ timeout: 4000 });
    } catch (e) {
      clickError = String(e && e.message || e).split('\n')[0].slice(0, 160);
    }
    await settle(page, 600);
    const after = await fingerprint(page);
    const changed = before.text !== after.text || before.buttons.join('|') !== after.buttons.join('|')
      || before.pressed.join('|') !== after.pressed.join('|') || before.dialog !== after.dialog || before.url !== after.url;
    const navigated = before.url !== after.url || (await mainNav(page).count()) === 0 || after.buttons.length === 0
      || (before.buttons.length > 3 && after.buttons.filter((x) => before.buttons.includes(x)).length < before.buttons.length / 2);
    index += 1;
    clicks += 1;
    const shot = path.join(shotDir, `${String(index).padStart(2, '0')}-${slug(b.name)}.png`);
    await page.screenshot({ path: shot }).catch(() => {});
    const problems = sink.slice();
    const row = {
      root, button: b.name, tag: b.tag, ms: Date.now() - t0,
      effect: clickError ? `CLICK FAILED: ${clickError}` : (changed ? (navigated ? 'opened a screen' : 'changed the screen') : 'no visible effect'),
      newText: diffText(before.text, after.text),
      dialog: after.dialog,
      problems,
      shot: path.relative(OUT, shot),
    };
    results.push(row);
    log(`${root} :: ${b.name} -> ${row.effect}${problems.length ? ` (${problems.length} problem(s))` : ''}`);

    // A screen that opened gets one level of its own sweep, then we go home.
    if (!clickError && navigated && depth > 0) {
      // Reopening the child means reopening the root and pressing the same
      // button again by name; the sweep ids are reassigned on every pass.
      const childReopen = async () => {
        await reopen();
        const fresh = await enumerateButtons(page);
        const again = fresh.find((x) => x.name === b.name && x.tag === b.tag);
        if (again) await page.locator(`[data-sweep="${again.id}"]`).first().click({ timeout: 4000 }).catch(() => {});
        await settle(page, 600);
      };
      await sweepScreen(page, sink, {
        root: `${root} > ${b.name}`, reopen: childReopen, depth: depth - 1, cap: Math.min(cap, 18),
        shotDir: path.join(shotDir, slug(b.name)),
      });
    }
    // Back to a fresh copy of the root screen for the next button.
    await reopen();
    list = await enumerateButtons(page);
  }
}

async function main() {
  const health = await fetch(`${API_ORIGIN}/api/health`).then((r) => r.ok).catch(() => false);
  if (!health) throw new Error(`no stack on ${API_ORIGIN}. Start it: node scripts/capture-screenshots.mjs --only=plans --keep-alive`);
  const personToken = await apiLogin(DEMO.person);
  const ownerToken = await apiLogin(DEMO.owner);
  const browser = await chromium.launch({ headless: true });
  const sink = [];
  try {
    // ── The signed-out door: the auth screen's own buttons.
    {
      const ctx = await newContext(browser, { token: '', userMode: 'person' });
      const page = await ctx.newPage();
      watch(page, sink);
      const reopen = async () => {
        await page.goto(`${WEB_ORIGIN}/app`, { waitUntil: 'domcontentloaded' });
        await settle(page);
        await declineAnalyticsAsk(page);
      };
      await reopen();
      await sweepScreen(page, sink, { root: 'auth', reopen, depth: 1, cap: 24, shotDir: path.join(SHOTS, 'auth') });
      await ctx.close();
    }
    // ── The person's app: each tab is a root.
    {
      const ctx = await newContext(browser, { token: personToken, userMode: 'person' });
      const page = await ctx.newPage();
      watch(page, sink);
      const tabs = ['Nest', 'Discover', 'Plans', 'Messages', 'You'];
      for (const t of tabs) {
        const reopen = async () => {
          await openApp(page);
          const tb = mainNav(page).getByRole('button', { name: t });
          if (await tb.count()) await tb.first().click().catch(() => {});
          if (t === 'Discover') {
            await page.getByText('Finding venues near you...').waitFor({ state: 'detached', timeout: 45000 }).catch(() => {});
            await page.locator('.mlb-venue-marker').first().waitFor({ timeout: 30000 }).catch(() => {});
          }
          await settle(page);
        };
        await reopen();
        // Discover performs live Places searches; keep its share small.
        const cap = t === 'Discover' ? 14 : 40;
        await sweepScreen(page, sink, { root: t, reopen, depth: 1, cap, shotDir: path.join(SHOTS, slug(t)) });
      }
      await ctx.close();
    }
    // ── The venue owner's dashboard.
    {
      const ctx = await newContext(browser, { token: ownerToken, userMode: 'venue' });
      const page = await ctx.newPage();
      watch(page, sink);
      const reopen = async () => {
        await page.goto(`${WEB_ORIGIN}/app?venue=true`, { waitUntil: 'domcontentloaded' });
        await page.getByText('Loading your dashboard.').waitFor({ state: 'detached', timeout: 30000 }).catch(() => {});
        await declineAnalyticsAsk(page);
        await settle(page);
      };
      await reopen();
      await sweepScreen(page, sink, { root: 'venue-dashboard', reopen, depth: 1, cap: 40, shotDir: path.join(SHOTS, 'venue-dashboard') });
      await ctx.close();
    }
  } finally {
    await browser.close();
  }

  // ── Report.
  const flagged = results.filter((r) => !r.skipped && (r.problems?.length || /FAILED/.test(r.effect)));
  const inert = results.filter((r) => !r.skipped && r.effect === 'no visible effect');
  const skipped = results.filter((r) => r.skipped);
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ results, flagged: flagged.length, inert: inert.length, skipped: skipped.length }, null, 2));
  const md = [];
  md.push(`# Button sweep`, '', `${results.length - skipped.length} buttons pressed, ${skipped.length} skipped on purpose, ${flagged.length} with problems, ${inert.length} with no visible effect.`, '');
  md.push('## Problems', '');
  for (const r of flagged) {
    md.push(`- **${r.root} :: ${r.button}** (${r.effect}) ${r.shot}`);
    for (const p of r.problems || []) md.push(`  - ${p.kind}: ${p.text}`);
  }
  md.push('', '## No visible effect (leads, check the screenshot)', '');
  for (const r of inert) md.push(`- ${r.root} :: ${r.button} ${r.shot}`);
  md.push('', '## Everything pressed', '');
  for (const r of results.filter((r) => !r.skipped)) md.push(`- ${r.root} :: ${r.button} -> ${r.effect}${r.newText ? ` :: ${r.newText}` : ''}`);
  md.push('', '## Skipped on purpose', '');
  for (const r of skipped) md.push(`- ${r.root} :: ${r.button}`);
  fs.writeFileSync(path.join(OUT, 'report.md'), md.join('\n'));
  log(`done: ${results.length - skipped.length} pressed, ${flagged.length} flagged, ${inert.length} inert, ${skipped.length} skipped -> ${OUT}`);
}

main().catch((e) => { console.error('[sweep] FAILED', e); process.exit(1); });
