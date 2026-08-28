// THE INVITE LINK CARRIES ITS OWN IMAGE, AND NEVER ITS TOKEN.
//
// invite-preview.js pointed og:image at one static banner for every flock, so
// a group chat full of different invites looked like one repeated ad. The
// per-flock card (/api/invite-og, rendered from _og-card.js) fixes that, and
// these pins hold its two safety properties still:
//
//   1. The image URL is assembled from the card's three DISPLAY fields, which
//      og:title and og:description already publish in text. The invite token
//      never enters an image URL, because crawlers cache image URLs long
//      after the page is gone (the preview file's own rule 3).
//   2. A cancelled or completed plan keeps the static banner: a dead plan
//      does not advertise itself.

import fs from 'fs';
import path from 'path';

const ogCard = require('../../api/_og-card.js');
const PREVIEW = fs.readFileSync(path.join(__dirname, '..', '..', 'api', 'invite-preview.js'), 'utf8');
const OG_FN = fs.readFileSync(path.join(__dirname, '..', '..', 'api', 'invite-og.js'), 'utf8');

describe('cardParams clamps everything a hostile flock name could carry', () => {
  test('control characters are stripped and length is bounded', () => {
    const bell = String.fromCharCode(7);
    const p = ogCard.cardParams({ n: `Taco${bell} Night`, w: 'Fri 9:00 PM', g: '5' });
    expect(p.name).toBe('Taco Night');
    expect(p.when).toBe('Fri 9:00 PM');
    expect(p.going).toBe(5);
    const long = ogCard.cardParams({ n: 'x'.repeat(400) });
    expect(long.name.length).toBeLessThanOrEqual(60);
  });

  test('a missing or absurd count is a quiet zero or a capped number, never NaN', () => {
    expect(ogCard.cardParams({}).going).toBe(0);
    expect(ogCard.cardParams({ g: '-3' }).going).toBe(0);
    expect(ogCard.cardParams({ g: '2000' }).going).toBe(999);
    expect(ogCard.cardParams({ g: 'abc' }).going).toBe(0);
  });

  test('empty fields fall back to honest defaults', () => {
    const p = ogCard.cardParams({});
    expect(p.name).toBe('A night out');
    expect(p.when).toBe('Time not set yet');
  });
});

describe('the element tree says what the plan says', () => {
  test('name and meta line render, and the going count only when it exists', () => {
    const flat = JSON.stringify(ogCard.cardTree({ name: 'Friday Tacos', when: 'Fri 9:00 PM', going: 4 }));
    expect(flat).toContain('Friday Tacos');
    expect(flat).toContain('Fri 9:00 PM · 4 going');
    const none = JSON.stringify(ogCard.cardTree({ name: 'Friday Tacos', when: 'Fri 9:00 PM', going: 0 }));
    expect(none).not.toContain('0 going');
  });

  test('the tree carries no em dash anywhere', () => {
    const flat = JSON.stringify(ogCard.cardTree(ogCard.cardParams({})));
    expect(flat).not.toContain(String.fromCharCode(0x2014));
  });
});

describe('the preview page wires the card in without the token', () => {
  test('og:image and twitter:image both use the computed image', () => {
    expect(PREVIEW).toContain(`'<meta property="og:image" content="' + esc(ogImage) + '">`);
    expect(PREVIEW).toContain(`'<meta name="twitter:image" content="' + esc(ogImage) + '">`);
  });

  test('the image URL is built from exactly the three display fields', () => {
    const start = PREVIEW.indexOf('const ogImage = opts.card');
    expect(start).toBeGreaterThan(-1);
    const block = PREVIEW.slice(start, PREVIEW.indexOf(': OG_IMAGE;', start));
    expect(block).toContain('n: opts.card.name');
    expect(block).toContain('w: opts.card.when');
    expect(block).toContain('g: String(opts.card.going)');
    expect(block).not.toMatch(/token/);
  });

  test('only the live branch attaches a card; dead plans keep the static banner', () => {
    const describeStart = PREVIEW.indexOf('function describe(payload)');
    const describeEnd = PREVIEW.indexOf('function renderPage', describeStart);
    const body = PREVIEW.slice(describeStart, describeEnd);
    expect((body.match(/out\.card =/g) || []).length).toBe(1);
    const cancelled = body.slice(body.indexOf("status === 'cancelled'"), body.indexOf('let title;'));
    expect(cancelled).not.toContain('card');
  });
});

describe('the edge function stays thin and cacheable', () => {
  test('it runs at the edge and delegates everything to the pure module', () => {
    expect(OG_FN).toContain("export const config = { runtime: 'edge' };");
    expect(OG_FN).toContain('ogCard.cardParams(');
    expect(OG_FN).toContain('ogCard.cardTree(');
    expect(OG_FN).toContain('s-maxage=3600');
  });
});
