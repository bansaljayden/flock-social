// App Store listing images for Flock: 1290 x 2796, opaque PNG.
// Each image: a Fraunces headline, the app's own screen in an iPhone frame,
// one part of that screen lifted out as a floating card, and a painted bird
// scene from the website's art (frames.cjs says which). The screens are the
// screenshot rig's site story at 430x932 at 3, invented and drawn places only:
//
//   node scripts/capture-screenshots.mjs --story=site --viewport=430x932 --scale=3 --out=<raw>
//   node scripts/store-listing/compose.cjs --raw=<raw> --out=<out> [--only=01-nest,02-crowd]
//
// Both folders stay outside the repo: the listing images are submission
// material, not something the site serves.
const fs = require('fs');
const path = require('path');
const FRONT = path.resolve(__dirname, '..', '..');
const { chromium } = require('@playwright/test');
const sharp = require('sharp');

const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
if (!arg('raw') || !arg('out')) {
  console.error('usage: node scripts/store-listing/compose.cjs --raw=<rig masters> --out=<folder> [--only=ids]');
  process.exit(2);
}
const RAW = path.resolve(arg('raw'));
const OUT = path.resolve(arg('out'));
const ART = path.join(FRONT, 'public', 'art');
const FONTS = path.join(FRONT, 'src', 'fonts');
const url = (p) => 'file:///' + p.replace(/\\/g, '/');
fs.mkdirSync(OUT, { recursive: true });

const W = 1290;
const H = 2796;
const SHOT_W = 1290;
const SHOT_H = 2796;

const THEMES = {
  cream: { bg: '#f4efe3', glow: 'rgba(109,154,195,0.20)', glow2: 'rgba(244,198,207,0.32)', ink: '#0b1a2e', sub: '#33475e' },
  paper: { bg: '#f9f8f4', glow: 'rgba(45,90,135,0.14)', glow2: 'rgba(244,198,207,0.30)', ink: '#0b1a2e', sub: '#33475e' },
  navy: { bg: '#0b1a2e', glow: 'rgba(109,154,195,0.28)', glow2: 'rgba(244,198,207,0.12)', ink: '#f4efe3', sub: '#c8c3b2' },
};

const FRAMES = require('./frames.cjs');

function phoneHtml(f) {
  // iPhone 6.9-inch proportions: screen corner 12.5% of width, island
  // 28.6% x 3.9%, status bar 54 pt of 956.
  const pw = f.phone?.width ?? 1010;
  const bezel = Math.round(pw * 0.026);
  const sw = pw - bezel * 2;
  const sh = Math.round(sw * SHOT_H / SHOT_W);
  const r = Math.round(sw * 0.125);
  const bar = Math.round(sh * 54 / 956);
  const top = f.phone?.top ?? 860;
  // The status bar takes the colour of the screen's own top edge, as the
  // safe area does on a phone, with its glyphs in whichever of black or
  // white reads on it.
  const fg = f.topLight ? '#000000' : '#ffffff';
  const shift = bar;
  return `
  <div class="phone" style="width:${pw}px;height:${sh + bezel * 2}px;top:${top}px;left:${(W - pw) / 2 + (f.phone?.dx ?? 0)}px;border-radius:${r + bezel}px;transform:rotate(${f.phone?.tilt ?? 0}deg)">
    <div class="screen" style="inset:${bezel}px;border-radius:${r}px;background:${f.topColor}">
      <img class="shot" src="${url(path.join(RAW, f.screen + '-1290x2796.png'))}" style="top:${shift}px;width:${sw}px;height:${sh}px">
      <div class="bar" style="height:${bar}px;color:${fg};background:${f.topColor}">
        <span class="time" style="font-size:${Math.round(sw * 17 / 440)}px">9:41</span>
        <span class="icons">${statusIcons(fg, sw)}</span>
      </div>
      <div class="island" style="width:${Math.round(sw * 0.286)}px;height:${Math.round(sh * 0.0387)}px;top:${Math.round(sh * 0.0115)}px"></div>
    </div>
  </div>`;
}

function statusIcons(fg, sw) {
  const k = sw / 440;
  const h = Math.round(12 * k);
  return `
  <svg width="${Math.round(18 * k)}" height="${h}" viewBox="0 0 18 12"><g fill="${fg}"><rect x="0" y="8" width="3" height="4" rx="1"/><rect x="5" y="5.5" width="3" height="6.5" rx="1"/><rect x="10" y="3" width="3" height="9" rx="1"/><rect x="15" y="0" width="3" height="12" rx="1"/></g></svg>
  <svg width="${Math.round(16 * k)}" height="${h}" viewBox="0 0 16 12"><path fill="${fg}" d="M8 2.2c2.4 0 4.6.9 6.3 2.5l1.2-1.3C13.5 1.5 10.9.4 8 .4S2.5 1.5.5 3.4l1.2 1.3C3.4 3.1 5.6 2.2 8 2.2zm0 3.5c1.5 0 2.8.5 3.9 1.5l1.2-1.3C11.7 4.6 9.9 3.9 8 3.9s-3.7.7-5.1 2l1.2 1.3C5.2 6.2 6.5 5.7 8 5.7zm0 3.4c.6 0 1.1.2 1.5.6L8 11.4 6.5 9.7c.4-.4.9-.6 1.5-.6z"/></svg>
  <svg width="${Math.round(27 * k)}" height="${h}" viewBox="0 0 27 12"><rect x="0.5" y="0.5" width="23" height="11" rx="3.2" fill="none" stroke="${fg}" stroke-opacity="0.4"/><rect x="2" y="2" width="20" height="8" rx="2" fill="${fg}"/><path d="M25 4v4c.8-.3 1.3-1.1 1.3-2S25.8 4.3 25 4z" fill="${fg}" fill-opacity="0.45"/></svg>`;
}

// Where a point of the master lands in the phone (the same geometry as
// phoneHtml): the screen's left and top inside the bezel, below the bar.
function screenGeom(f) {
  const pw = f.phone?.width ?? 1010;
  const bezel = Math.round(pw * 0.026);
  const sw = pw - bezel * 2;
  const sh = Math.round(sw * SHOT_H / SHOT_W);
  const bar = Math.round(sh * 54 / 956);
  const left = (W - pw) / 2 + (f.phone?.dx ?? 0) + bezel;
  const top = (f.phone?.top ?? 860) + bezel + bar;
  return { left, top, k: sw / SHOT_W };
}

function calloutHtml(f, c) {
  // A part of the screen at its own scale, lifted over the phone. Without an
  // `at` it is centred on the place it came from, so it reads as that part
  // of the screen lifted toward you; `dx`/`dy` move it from there.
  const s = c.scale ?? 0.9;
  const [x, y, w, h] = c.crop;
  const g = screenGeom(f);
  const at = c.at || [
    Math.round(g.left + x * g.k - (w * s - w * g.k) / 2 + (c.dx ?? 0)),
    Math.round(g.top + y * g.k - (h * s - h * g.k) / 2 + (c.dy ?? 0)),
  ];
  return `<div class="callout" style="left:${at[0]}px;top:${at[1]}px;width:${Math.round(w * s)}px;height:${Math.round(h * s)}px;border-radius:${c.radius ?? 44}px;
    background-image:url('${url(path.join(RAW, (c.screen || f.screen) + '-1290x2796.png'))}');
    background-size:${Math.round(SHOT_W * s)}px ${Math.round(SHOT_H * s)}px;background-position:-${Math.round(x * s)}px -${Math.round(y * s)}px;
    transform:rotate(${c.tilt ?? 0}deg)"></div>`;
}

function artHtml(a) {
  return `<img class="art" src="${url(path.join(ART, a.src + '.webp'))}" style="left:${a.x}px;top:${a.y}px;width:${a.w}px;${a.flip ? 'transform:scaleX(-1);' : ''}${a.z ? `z-index:${a.z};` : ''}">`;
}

function pageHtml(f) {
  const t = THEMES[f.theme];
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  @font-face { font-family: 'Fraunces'; src: url('${url(path.join(FONTS, 'Fraunces-var.woff2'))}') format('woff2'); font-weight: 100 900; }
  @font-face { font-family: 'Hanken'; src: url('${url(path.join(FONTS, 'HankenGrotesk-var.woff2'))}') format('woff2'); font-weight: 100 900; }
  * { box-sizing: border-box; }
  html, body { margin: 0; width: ${W}px; height: ${H}px; overflow: hidden; background: ${t.bg}; }
  .canvas { position: relative; width: ${W}px; height: ${H}px; overflow: hidden;
    background:
      radial-gradient(1100px 900px at ${f.glowAt || '85% 42%'}, ${t.glow}, transparent 70%),
      radial-gradient(900px 800px at ${f.glow2At || '8% 70%'}, ${t.glow2}, transparent 70%),
      ${t.bg}; }
  .head { position: absolute; left: 100px; right: 100px; top: ${f.headTop ?? 150}px; text-align: ${f.align || 'center'}; z-index: 5; }
  h1 { font-family: 'Fraunces', Georgia, serif; font-variation-settings: 'opsz' 144; font-weight: ${f.weight ?? 600};
       font-size: ${f.size ?? 122}px; line-height: 1.06; letter-spacing: -0.012em; word-spacing: 0.08em; color: ${t.ink}; margin: 0; text-wrap: balance; }
  h1 mark { background: #F4C6CF; color: #16283d; border-radius: 16px; padding: 0 14px; margin: 0 -6px;
       -webkit-box-decoration-break: clone; box-decoration-break: clone; }
  .sub { font-family: 'Hanken', Arial, sans-serif; font-weight: 500; font-size: ${f.subSize ?? 50}px; line-height: 1.32;
       color: ${t.sub}; margin: 34px auto 0; max-width: 1000px; text-wrap: balance; }
  .phone { position: absolute; background: linear-gradient(150deg, #4a4d53 0%, #1d1e21 18%, #2c2e33 50%, #16171a 82%, #3d4045 100%);
       box-shadow: 0 0 0 3px rgba(255,255,255,0.06) inset, 0 90px 160px -40px rgba(11,26,46,0.45), 0 40px 70px -30px rgba(11,26,46,0.40); z-index: 2; }
  .screen { position: absolute; overflow: hidden; }
  .shot { position: absolute; left: 0; display: block; }
  .bar { position: absolute; left: 0; right: 0; top: 0; display: flex; align-items: center; justify-content: space-between; padding: 0 9.5% 0 13%;
       font-family: 'Hanken', Arial, sans-serif; font-weight: 650; z-index: 3; }
  .bar .icons { display: flex; gap: 0.9%; align-items: center; }
  .bar .icons svg { margin-left: 10px; }
  .island { position: absolute; left: 50%; transform: translateX(-50%); background: #000; border-radius: 999px; z-index: 4; }
  .callout { position: absolute; z-index: 6; background-repeat: no-repeat;
       box-shadow: 0 50px 90px -20px rgba(11,26,46,0.45), 0 18px 36px -12px rgba(11,26,46,0.35), 0 0 0 2px rgba(255,255,255,0.10); }
  .art { position: absolute; z-index: 7; filter: drop-shadow(0 22px 26px rgba(11,26,46,0.20)); }
  </style></head><body><div class="canvas">
    <div class="head"><h1>${f.h1}</h1>${f.sub ? `<p class="sub">${f.sub}</p>` : ''}</div>
    ${phoneHtml(f)}
    ${(f.callouts || []).map((c) => calloutHtml(f, c)).join('\n')}
    ${(f.art || []).map(artHtml).join('\n')}
  </div></body></html>`;
}

(async () => {
  const only = arg('only') ? arg('only').split(',') : null;
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const done = [];
  for (const f of FRAMES) {
    if (only && !only.includes(f.id)) continue;
    // The screen's top edge: the mean colour of its first rows.
    const { data } = await sharp(path.join(RAW, f.screen + '-1290x2796.png'))
      .extract({ left: 0, top: 2, width: SHOT_W, height: 6 }).removeAlpha()
      .resize(1, 1, { kernel: 'cubic' }).raw().toBuffer({ resolveWithObject: true });
    f.topColor = `rgb(${data[0]},${data[1]},${data[2]})`;
    f.topLight = (0.2126 * data[0] + 0.7152 * data[1] + 0.0722 * data[2]) > 150;
    const htmlFile = path.join(OUT, `${f.id}.html`);
    fs.writeFileSync(htmlFile, pageHtml(f));
    await page.goto(url(htmlFile));
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(150);
    const png = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: W, height: H } });
    const file = path.join(OUT, `${f.id}.png`);
    await sharp(png).removeAlpha().png({ compressionLevel: 9 }).toFile(file);
    done.push(f.id);
    console.log('wrote', f.id);
  }
  await browser.close();
  // Contact sheet at listing size, and a row at search-result thumbnail size.
  const ids = FRAMES.map((f) => f.id).filter((id) => fs.existsSync(path.join(OUT, `${id}.png`)));
  const tw = 300;
  const th = Math.round(tw * H / W);
  const gap = 16;
  const tiles = await Promise.all(ids.map(async (id, i) => ({
    input: await sharp(path.join(OUT, `${id}.png`)).resize(tw, th).png().toBuffer(), left: gap + i * (tw + gap), top: gap,
  })));
  await sharp({ create: { width: gap + ids.length * (tw + gap), height: th + gap * 2, channels: 3, background: '#d9d6cc' } })
    .composite(tiles).jpeg({ quality: 86 }).toFile(path.join(OUT, 'contact.jpg'));
  const sw = 120;
  const sh = Math.round(sw * H / W);
  const small = await Promise.all(ids.slice(0, 3).map(async (id, i) => ({
    input: await sharp(path.join(OUT, `${id}.png`)).resize(sw, sh).png().toBuffer(), left: 10 + i * (sw + 10), top: 10,
  })));
  await sharp({ create: { width: 10 + 3 * (sw + 10), height: sh + 20, channels: 3, background: '#ffffff' } })
    .composite(small).png().toFile(path.join(OUT, 'search-thumbs.png'));
  console.log('contact sheet + search thumbnails written');
})().catch((e) => { console.error(e); process.exit(1); });
