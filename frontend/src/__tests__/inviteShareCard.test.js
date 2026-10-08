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
//
// And the signature the card URL carries once OG_CARD_SECRET is set (the
// Cloudflare Pages project and the API hold it, Vercel never does): without
// a secret of 32 characters or more the page is byte for byte what Vercel
// serves today, and Vercel's own renderer draws the same card either way.

import fs from 'fs';
import path from 'path';

// api/invite-og.js renders through @vercel/og at Vercel's edge. Here only the
// arguments it hands the renderer matter.
jest.mock('@vercel/og', () => ({ ImageResponse: jest.fn() }));

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
    // The three fields, and their signature when a secret is set.
    expect(block).toContain('new URLSearchParams(signedCardQuery({');
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

  test('it reads n, w and g only, so a signed card URL draws the same card on Vercel', () => {
    const { ImageResponse } = require('@vercel/og');
    const handler = require('../../api/invite-og.js').default;
    const unsigned = 'https://www.flockcorp.com/api/invite-og?n=Friday+Tacos&w=Fri%2C+Oct+9+at+9%3A00+PM+EDT&g=4';
    ImageResponse.mockClear();
    handler({ url: unsigned });
    handler({ url: unsigned + '&s=vY2GCt-sA90cCCipNMEOKC' });
    handler({ url: unsigned + '&s=' + 'A'.repeat(22) });
    expect(ImageResponse).toHaveBeenCalledTimes(3);
    const [plain, ...signed] = ImageResponse.mock.calls.map((call) => JSON.stringify(call));
    expect(plain).toContain('Friday Tacos');
    expect(plain).toContain('4 going');
    for (const call of signed) expect(call).toBe(plain);
  });
});

describe('the card URL is signed only with a secret of 32 characters or more', () => {
  const preview = require('../../api/invite-preview.js');
  const SITE = 'https://www.flockcorp.com';
  const TOKEN = 'GoodToken0123456789abcd';
  const CARD = { name: 'Friday Tacos', when: 'Fri, Oct 9 at 9:00 PM EDT', going: 4 };
  const UNSIGNED = SITE + '/api/invite-og?n=Friday+Tacos&w=Fri%2C+Oct+9+at+9%3A00+PM+EDT&g=4';
  const hmac = (secret, n, w, g) => require('crypto').createHmac('sha256', secret)
    .update(n + '\n' + w + '\n' + g).digest('base64url').slice(0, 22);
  const page = () => preview.renderPage({
    title: 'Sam invited you to Friday Tacos',
    description: 'Fri, Oct 9 at 9:00 PM EDT ' + String.fromCharCode(0xb7) + ' El Vez',
    card: CARD,
    token: TOKEN,
  });
  // og:image and twitter:image, unescaped.
  const imageUrls = (html) => [...html.matchAll(/<meta (?:property="og:image"|name="twitter:image") content="([^"]*)">/g)]
    .map((m) => m[1].replace(/&amp;/g, '&'));

  let saved;
  const setSecret = (value) => {
    if (value === undefined) delete process.env.OG_CARD_SECRET;
    else process.env.OG_CARD_SECRET = value;
  };
  beforeEach(() => { saved = process.env.OG_CARD_SECRET; });
  afterEach(() => { setSecret(saved); });

  test('unset, blank or under 32 characters: no s, the unsigned URL Vercel serves today', () => {
    const quiet = jest.spyOn(console, 'error').mockImplementation(() => {});
    for (const value of [undefined, '', ' '.repeat(40), 'k'.repeat(16), 'k'.repeat(31), ' ' + 'k'.repeat(31) + '\n']) {
      setSecret(value);
      expect([JSON.stringify(value), imageUrls(page())]).toEqual([JSON.stringify(value), [UNSIGNED, UNSIGNED]]);
      expect(preview.signedCardQuery({ n: 'a', w: 'b', g: '1' })).toEqual({ n: 'a', w: 'b', g: '1' });
    }
    quiet.mockRestore();
  });

  test('32 characters or more: the same URL plus s, and nothing else on the page changes', () => {
    setSecret(undefined);
    const before = page();
    for (const secret of ['k'.repeat(32), require('crypto').randomBytes(32).toString('base64url')]) {
      // A pasted value often carries a newline; the secret is the trimmed value.
      setSecret(' ' + secret + '\n');
      const s = hmac(secret, CARD.name, CARD.when, '4');
      const after = page();
      expect(imageUrls(after)).toEqual([UNSIGNED + '&s=' + s, UNSIGNED + '&s=' + s]);
      expect(after.split('&amp;s=' + s)).toHaveLength(3);
      expect(after.split('&amp;s=' + s).join('')).toBe(before);
      expect(after).not.toContain(secret);
      expect(after).not.toContain(TOKEN + '&');
    }
  });

  test('the signature is the contract every side shares: a pinned vector', () => {
    // HMAC-SHA256 over n + "\n" + w + "\n" + g, base64url, first 22
    // characters. The same vector is pinned against the Pages check,
    // functions/_lib/card-signature.js, in cloudflarePagesFunctions.test.js.
    expect(preview.cardSignature('k'.repeat(43), 'Friday dinner', 'Fri 8:00 PM', '3 going')).toBe('vY2GCt-sA90cCCipNMEOKC');
    setSecret('k'.repeat(43));
    expect(preview.signedCardQuery({ n: 'Friday dinner', w: 'Fri 8:00 PM', g: '3 going' }))
      .toEqual({ n: 'Friday dinner', w: 'Fri 8:00 PM', g: '3 going', s: 'vY2GCt-sA90cCCipNMEOKC' });
    expect(preview.OG_CARD_SECRET_MIN).toBe(32);
  });

  test('the handler as Vercel runs it signs only when the secret is set', async () => {
    const payload = {
      flock: { name: 'Friday Tacos', when: null, chosenVenue: 'El Vez', status: 'confirmed' },
      host: 'Sam',
      going: 4,
    };
    const answer = () => new Promise((resolve) => {
      const res = { setHeader() {}, end: (body) => resolve(body) };
      preview({ query: { token: TOKEN } }, res);
    });
    const savedFetch = global.fetch;
    global.fetch = jest.fn(async () => ({ status: 200, json: async () => payload }));
    try {
      setSecret(undefined);
      const plain = imageUrls(await answer());
      expect(plain[0]).toBe(SITE + '/api/invite-og?n=Friday+Tacos&w=Time+not+set+yet&g=4');
      setSecret('k'.repeat(43));
      const signed = imageUrls(await answer());
      expect(signed[0]).toBe(plain[0] + '&s=' + hmac('k'.repeat(43), 'Friday Tacos', 'Time not set yet', '4'));
    } finally {
      global.fetch = savedFetch;
    }
  });

  test('a secret that is set but short is named by its length once, never by its value', () => {
    const quiet = jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.isolateModules(() => {
      const fresh = require('../../api/invite-preview.js');
      setSecret('k'.repeat(31));
      fresh.signedCardQuery({ n: 'a', w: 'b', g: '1' });
      fresh.signedCardQuery({ n: 'a', w: 'b', g: '1' });
    });
    expect(quiet).toHaveBeenCalledTimes(1);
    expect(quiet.mock.calls[0].join(' ')).toContain('31 characters');
    expect(quiet.mock.calls[0].join(' ')).not.toContain('k'.repeat(31));
    quiet.mockRestore();
  });
});
