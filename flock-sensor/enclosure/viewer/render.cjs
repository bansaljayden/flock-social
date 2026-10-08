// Renders the build sheet's pictures from the 3D viewer.
//
//   node viewer/render.cjs
//
// Serves viewer/index.html with preview/flux-assembly.glb beside it on a local
// port, opens it in headless Chrome through Playwright (the copy the frontend
// already installs), and saves one PNG per view into preview/.
const http = require('http');
const fs = require('fs');
const path = require('path');

const HERE = path.resolve(__dirname, '..');
const PW = path.resolve(HERE, '..', '..', 'frontend', 'node_modules', 'playwright');
const { chromium } = require(PW);

const FILES = {
  '/': path.join(__dirname, 'index.html'),
  '/index.html': path.join(__dirname, 'index.html'),
  '/flux-assembly.glb': path.join(HERE, 'preview', 'flux-assembly.glb'),
};
const TYPES = { '.html': 'text/html; charset=utf-8', '.glb': 'model/gltf-binary' };

const VIEWS = [
  ['Assembled', 'flux-assembled'], ['Front', 'flux-front'], ['Back', 'flux-back'], ['Inside', 'flux-inside'],
  ['Step 1', 'flux-step1'], ['Step 2', 'flux-step2'], ['Step 3', 'flux-step3'],
  ['Step 4', 'flux-step4'], ['Step 5', 'flux-step5'], ['Step 6', 'flux-step6'], ['Step 7', 'flux-step7'],
  ['On the wall', 'flux-arm'],
];

(async () => {
  const server = http.createServer((req, res) => {
    const file = FILES[req.url.split('#')[0].split('?')[0]];
    if (!file) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const browser = await chromium.launch({ channel: 'chrome', headless: true,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 1050 }, deviceScaleFactor: 1 });
    page.on('console', m => { if (m.type() === 'error') console.error('page:', m.text()); });
    await page.goto(`http://127.0.0.1:${port}/index.html#render`);
    await page.waitForFunction(() => window.fluxReady === true, null, { timeout: 120000 });
    for (const [view, name] of VIEWS) {
      await page.evaluate(v => window.fluxShow(v), view);
      await page.waitForTimeout(400);
      await page.locator('canvas').screenshot({ path: path.join(HERE, 'preview', `${name}.png`) });
      console.log(`preview/${name}.png`);
    }
  } finally {
    await browser.close();
    server.close();
  }
})().catch(e => { console.error(e); process.exit(1); });
