'use strict';
// ---------------------------------------------------------------------------
// THE CARTOON AVATARS ARE DRAWN HERE (services/avatarArt.js, 2026-10-05)
//
//   * the same picture DiceBear's hosted 7.x API drew for a style and seed
//     (the hashes below were checked against api.dicebear.com/7.x on
//     2026-10-05), so a package upgrade that would change everybody's avatar
//     fails here first;
//   * one stored form: a hosted 7.x link from an older build is stored as our
//     link, and anything else is refused;
//   * migration 116 rewrites exactly the rows the save rule would accept, to
//     exactly the link it would store;
//   * the route answers a year-cacheable, sandboxed SVG, and nothing for a
//     style or seed it does not draw.
// ---------------------------------------------------------------------------
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const express = require('express');

const art = require('../services/avatarArt');
const avatarRoutes = require('../routes/avatars');

const BASE = 'https://api.flockcorp.com';

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);

test('every style draws the picture the hosted 7.x API drew for the same seed', async () => {
  const expected = {
    adventurer: 'dd504b17f731154f',
    avataaars: '44878445c21d3e01',
    bottts: '025cad1a10c778d9',
    personas: '316fbd3be6dcc6e9',
    'pixel-art': '469d3428eb232a0b',
  };
  assert.deepStrictEqual([...art.STYLES].sort(), Object.keys(expected).sort());
  for (const [style, hash] of Object.entries(expected)) {
    const svg = await art.renderAvatarSvg(style, 'k3x9q');
    assert.match(svg, /^<svg/);
    assert.strictEqual(sha(svg), hash, `${style} no longer draws the picture people already have`);
  }
});

test('a style or seed the button never draws gets nothing', async () => {
  assert.strictEqual(await art.renderAvatarSvg('thumbs', 'abc'), null);
  assert.strictEqual(await art.renderAvatarSvg('bottts', ''), null);
  assert.strictEqual(await art.renderAvatarSvg('bottts', 'a'.repeat(65)), null);
  assert.strictEqual(await art.renderAvatarSvg('bottts', 'ab/c'), null);
  assert.strictEqual(await art.renderAvatarSvg('__proto__', 'abc'), null);
});

test('a hosted link and our own link are both stored as our link, and nothing else is', () => {
  const ours = `${BASE}/api/avatars/bottts/svg?seed=abc123`;
  assert.strictEqual(art.canonicalAvatarUrl('https://api.dicebear.com/7.x/bottts/svg?seed=abc123', BASE), ours);
  assert.strictEqual(art.canonicalAvatarUrl(ours, BASE), ours);
  assert.strictEqual(art.canonicalAvatarUrl(ours, `${BASE}/`), ours);
  // Our path on any origin is stored on ours: a local build calls its API over
  // http, and nothing of the origin it named survives.
  assert.strictEqual(art.canonicalAvatarUrl('http://127.0.0.1:5199/api/avatars/bottts/svg?seed=abc123', BASE), ours);
  assert.strictEqual(art.canonicalAvatarUrl('https://evil.example/api/avatars/bottts/svg?seed=abc123', BASE), ours);
  for (const bad of [
    'https://api.dicebear.com/9.x/bottts/svg?seed=abc',          // a version the button never wrote
    'https://api.dicebear.com/7.x/thumbs/svg?seed=abc',          // a style it never picked
    'https://api.dicebear.com/7.x/bottts/svg?seed=abc&radius=50', // an extra parameter
    'https://api.dicebear.com/7.x/bottts/svg?seed=abc#x',        // a fragment
    'https://api.dicebear.com/7.x/bottts/png?seed=abc',          // another format
    'http://api.dicebear.com/7.x/bottts/svg?seed=abc',           // not https
    'ftp://api.flockcorp.com/api/avatars/bottts/svg?seed=abc',   // not http(s)
    'https://evil.example/avatars/bottts/svg?seed=abc',          // not our path
    'https://user:pw@api.flockcorp.com/api/avatars/bottts/svg?seed=abc',
    `${BASE}/api/avatars/bottts/svg?seed=${'a'.repeat(65)}`,
    `${BASE}/api/avatars/bottts/svg`,
    'not a url',
    ['https://api.dicebear.com/7.x/bottts/svg?seed=abc'],
  ]) {
    assert.strictEqual(art.canonicalAvatarUrl(bad, BASE), null, String(bad));
  }
});

test('migration 116 rewrites the rows the save rule accepts, to the link it stores', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '116_self_hosted_avatars.sql'), 'utf8');
  const [, pattern, replacement] = /regexp_replace\(\s*profile_image_url,\s*'([^']+)',\s*'([^']+)'/.exec(sql);
  const where = /WHERE profile_image_url ~ '([^']+)'/.exec(sql)[1];
  const re = new RegExp(pattern);
  const whereRe = new RegExp(where);
  const jsReplacement = replacement.replace(/\\(\d)/g, '$$$1');
  const samples = [
    'https://api.dicebear.com/7.x/adventurer/svg?seed=k3x9q',
    'https://api.dicebear.com/7.x/pixel-art/svg?seed=Z9',
    'https://api.dicebear.com/7.x/thumbs/svg?seed=abc',
    'https://api.dicebear.com/7.x/bottts/svg?seed=abc&radius=5',
    'https://api.dicebear.com/9.x/bottts/svg?seed=abc',
    'data:image/jpeg;base64,AAAA',
    `${BASE}/api/avatars/bottts/svg?seed=abc`,
  ];
  for (const url of samples) {
    const canonical = art.canonicalAvatarUrl(url, BASE);
    const legacy = url.startsWith('https://api.dicebear.com/');
    assert.strictEqual(whereRe.test(url), legacy && canonical !== null, `WHERE disagrees with the save rule on ${url}`);
    if (whereRe.test(url)) assert.strictEqual(url.replace(re, jsReplacement), canonical);
  }
  assert.match(replacement, /^https:\/\/api\.flockcorp\.com\/api\/avatars\//);
});

async function get(urlPath) {
  const app = express();
  app.use('/api/avatars', avatarRoutes);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${urlPath}`);
    return { status: res.status, headers: res.headers, body: await res.text() };
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test('the route answers a year-cacheable, sandboxed SVG', async () => {
  const res = await get('/api/avatars/bottts/svg?seed=k3x9q');
  assert.strictEqual(res.status, 200);
  assert.match(res.headers.get('content-type'), /^image\/svg\+xml/);
  assert.match(res.headers.get('cache-control'), /max-age=31536000/);
  assert.match(res.headers.get('cache-control'), /immutable/);
  assert.match(res.headers.get('content-security-policy'), /sandbox/);
  assert.match(res.headers.get('content-security-policy'), /default-src 'none'/);
  assert.strictEqual(sha(res.body), '025cad1a10c778d9');
});

test('the route draws nothing for a style or seed outside the rule', async () => {
  assert.strictEqual((await get('/api/avatars/thumbs/svg?seed=abc')).status, 404);
  assert.strictEqual((await get('/api/avatars/bottts/svg')).status, 400);
  assert.strictEqual((await get('/api/avatars/bottts/svg?seed=ab%2Fc')).status, 400);
  assert.strictEqual((await get('/api/avatars/bottts/svg?seed=a&seed=b')).status, 400);
  assert.strictEqual((await get(`/api/avatars/bottts/svg?seed=${'a'.repeat(65)}`)).status, 400);
});
