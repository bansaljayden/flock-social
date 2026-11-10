/**
 * THE SCREENSHOT RIG'S SITE STORY (--story=site), the parts that decide a run.
 *
 * scripts/capture-screenshots.mjs --story=site --suffix=-v3 shoots the frames
 * the website ships. The run boots a whole local stack, so, as
 * screenshotRigNotes.test.js does with writeManifest, this lifts the pure
 * functions out of the rig's source and runs them: siteClock, which puts the
 * browser at 7 PM by moving its time zone (tools/e2e/clock.js) and turns the
 * story's wall-clock times into instants; siteRefusal, which stops a run
 * on a Friday (Friday Night Crew would be a week out, past the venue
 * dashboard's seven days) or late in the hour; siteCrowdCard, the crowd card
 * the browser is given, whose hours come from the server's crowd engine; and
 * sheetRowOf, where a plate is cut down to its sheet. Then the source, for
 * what a run may spend, where it may write, which pictures a pool may hand
 * out and what the map's key changes.
 * FRONTEND test (jest via react-scripts).
 */
const fs = require('fs');
const path = require('path');
const { zoneForLocalHour } = require('../../../tools/e2e/clock');

const RIG = fs.readFileSync(path.resolve(__dirname, '..', '..', 'scripts', 'capture-screenshots.mjs'), 'utf8').replace(/\r\n/g, '\n');

function lift(name) {
  const start = RIG.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`no ${name} in the rig`);
  const src = RIG.slice(start, RIG.indexOf('\n}\n', start) + 2);
  // eslint-disable-next-line no-new-func
  return new Function(`${src}\nreturn ${name};`)();
}
const siteClock = lift('siteClock');
const siteRefusal = lift('siteRefusal');

test('a Saturday morning in New York is 7 PM on Saturday where the site story stands', () => {
  const c = siteClock(new Date('2026-11-07T13:13:41Z'), zoneForLocalHour);
  expect(c.zone).toBe('Etc/GMT-6');
  expect([c.offsetH, c.dow, c.hour, c.minute]).toEqual([6, 6, 19, 13]);
  // Tonight at 9, the coming Friday at 8, last Thursday at 7:30, as instants.
  expect(c.at(0, 21, 0)).toBe('2026-11-07T15:00:00.000Z');
  expect(c.at(6, 20, 0)).toBe('2026-11-13T14:00:00.000Z');
  expect(c.at(-2, 19, 30)).toBe('2026-11-05T13:30:00.000Z');
  expect(c.date(0)).toBe('2026-11-07');
  expect(c.date(1)).toBe('2026-11-08');
  expect(siteRefusal(c)).toBeNull();
});

test('after midnight UTC the zone is behind it, and the story is still the evening before', () => {
  const c = siteClock(new Date('2026-11-08T02:30:00Z'), zoneForLocalHour);
  expect(c.zone).toBe('Etc/GMT+7');
  expect([c.offsetH, c.dow, c.hour]).toEqual([-7, 6, 19]);
  expect(c.at(0, 21, 0)).toBe('2026-11-08T04:00:00.000Z');
  expect(c.date(0)).toBe('2026-11-07');
});

test('a run is refused on a Friday there, and in the last ten minutes of the hour', () => {
  const friday = siteClock(new Date('2026-11-06T13:00:00Z'), zoneForLocalHour);
  expect(friday.dow).toBe(5);
  expect(siteRefusal(friday)).toMatch(/Friday Night Crew would be a week out/);
  const late = siteClock(new Date('2026-11-07T13:52:00Z'), zoneForLocalHour);
  expect(siteRefusal(late)).toMatch(/first fifty minutes/);
});

/* THE CROWD CARD the site story serves, run as the rig runs it: its figures
   are the rig's, its quiet hour and busiest hours the server's crowd engine's
   (backend/services/crowdEngine.js, which the rig requires). The first -v3
   crowd frame said "Least crowded: 11 PM" over a chart whose midnight bar was
   lower, because a rule written in the rig looked only four hours ahead. */
function liftConst(name) {
  const line = new RegExp(`^const ${name} = .*;$`, 'm').exec(RIG);
  if (line) return line[0];
  const start = RIG.indexOf(`const ${name} = [`);
  if (start < 0) throw new Error(`no const ${name} in the rig`);
  return RIG.slice(start, RIG.indexOf('\n];\n', start) + 3);
}
function siteCrowd(clock) {
  const src = [
    ...['SITE_VENUES', 'SITE_FINCH_CURVE', 'siteLabel', 'siteHourLabel', 'siteOpenAt', 'DAY_NAMES', 'siteClockWords', 'siteClockNow'].map(liftConst),
    ...['siteOpeningHours', 'siteCrowdCard'].map((n) => {
      const start = RIG.indexOf(`function ${n}(`);
      return RIG.slice(start, RIG.indexOf('\n}\n', start) + 2);
    }),
  ].join('\n');
  // eslint-disable-next-line no-new-func
  return new Function('SITE_CLOCK', 'crowdEngine', 'RUN_T', `${src}\nreturn { siteCrowdCard, SITE_VENUES };`)(
    clock,
    // eslint-disable-next-line global-require
    require('../../../backend/services/crowdEngine'),
    new Date('2026-11-07T13:13:41Z'),
  );
}

test('the crowd card names the hour its own chart shows is quietest, as the server would', () => {
  const { siteCrowdCard, SITE_VENUES } = siteCrowd(siteClock(new Date('2026-11-07T13:13:41Z'), zoneForLocalHour));
  const finch = siteCrowdCard(SITE_VENUES.find((v) => v.key === 'finch'));
  // 7 PM to midnight, the hours The Copper Finch is open tonight.
  expect(finch.hourly.filter((b) => b.open).map((b) => `${b.hour} ${b.score}`))
    .toEqual(['7 PM 78', '8 PM 82', '9 PM 80', '10 PM 58', '11 PM 38', '12 AM 44']);
  expect([finch.bestTime, finch.bestHour, finch.bestIndex, finch.bestIsNow]).toEqual(['11 PM', '11 PM', 4, false]);
  expect(finch.peak).toBe('8 PM - 9 PM');
  // Every place: the bar a card marks is the lowest open bar after now.
  for (const v of SITE_VENUES) {
    const card = siteCrowdCard(v);
    if (card.bestIndex == null) continue;
    const later = card.hourly.slice(1).filter((b) => b.open).map((b) => b.score);
    expect(`${v.key} ${card.hourly[card.bestIndex].score}`).toBe(`${v.key} ${Math.min(...later)}`);
    expect(card.bestTime).toBe(card.hourly[card.bestIndex].hour);
  }
});

/* A sheet's first whole row, for the cut a plate down to its sheet takes. The
   page put the bill's sheet at 374.5 CSS px, and row 749 is that edge blended
   with the chat behind: a crop at 44.37% (749 of 1688) leaves a seam, and the
   cut script refuses it. */
test('a sheet is cut at its first whole row, not at the half pixel its edge falls on', () => {
  const start = RIG.indexOf('function sheetRowOf(');
  // eslint-disable-next-line no-new-func
  const sheetRowOf = new Function(`${RIG.slice(start, RIG.indexOf('\n}\n', start) + 2)}\nreturn sheetRowOf;`)();
  const W = 8;
  const H = 1688;
  const frame = (colourAt) => {
    const data = new Uint8Array(W * H * 3);
    for (let y = 0; y < H; y += 1) {
      for (let x = 0; x < W; x += 1) data.set(colourAt(y), (y * W + x) * 3);
    }
    return { data, width: W, height: H, channels: 3 };
  };
  const bill = frame((y) => (y >= 750 ? [31, 42, 61] : y === 749 ? [16, 29, 36] : [8, 12, 20]));
  expect(sheetRowOf(bill, 374.5, 844)).toMatchObject({ row: 750, crop: 44.43 });
  const budget = frame((y) => (y >= 610 ? [31, 42, 61] : [8, 12, 20]));
  expect(sheetRowOf(budget, 305, 844)).toMatchObject({ row: 610, crop: 36.14 });
  // The fill moves by a point or two from row to row (the bill's capture:
  // 32,43,60 on its first row, 31,41,59 eight rows down), and that is still
  // the sheet; a test of three points took row 751.
  const noisy = frame((y) => (y > 750 ? (y % 2 ? [31, 41, 59] : [30, 42, 60]) : y === 750 ? [32, 43, 60] : y === 749 ? [20, 25, 34] : [18, 23, 33]));
  expect(sheetRowOf(noisy, 374.5, 844)).toMatchObject({ row: 750, crop: 44.43 });
});

/* THE COPPER FINCH'S PICTURES ARE ITS OWN. It drew the burger until the site
   story gave it the dining room; the dining room stayed in the pool and in two
   screens' themes, so another venue in an App Store or web frame could carry
   the same picture. */
test('no pool or theme hands another venue one of The Copper Finch\'s pictures', () => {
  const ART = fs.readFileSync(path.resolve(__dirname, '..', '..', 'scripts', 'shot-art.mjs'), 'utf8').replace(/\r\n/g, '\n');
  const pinned = /const PINNED = \{([\s\S]*?)\};/.exec(ART)[1];
  const finchArt = [...pinned.matchAll(/: '([a-z-]+)'/g)].map((m) => m[1]);
  expect(finchArt).toEqual(['dining-room', 'counter', 'stage', 'wings', 'burger']);
  expect(ART).toContain('const COPPER_FINCH_ONLY = new Set(Object.values(PINNED));');
  expect(ART).toContain('const ALL = VENUE_ART.map((a) => a.id).filter((id) => !COPPER_FINCH_ONLY.has(id));');
  expect(ART).toMatch(/ids\.filter\(\(id\) => BY_ID\.has\(id\) && !COPPER_FINCH_ONLY\.has\(id\)\)/);
  const themes = [...RIG.matchAll(/setVenueArtTheme\(page\.context\(\), \[([^\]]*)\]\)/g)]
    .flatMap((m) => [...m[1].matchAll(/'([a-z-]+)'/g)].map((x) => x[1]));
  expect(themes.length).toBeGreaterThan(0);
  expect(themes.filter((id) => finchArt.includes(id))).toEqual([]);
});

/* THE MAP'S KEY, the one key a site run can be given. With it the build draws
   still maps on any screen (the plan card's strip, the venue sheet's header
   while its first photo decodes), so the audit takes MapTiler's pictures on
   any frame of such a run and on none without the key, and the plans keep
   their places' coordinates, which the strip is drawn from. */
test('a run with the map key can shoot the plan card\'s map, and a run without it cannot show one', () => {
  expect(RIG).toContain("if (SITE_MAP_KEY && u.startsWith('https://api.maptiler.com/')) return { u, ok: true, kind: 'map' };");
  expect(RIG).not.toMatch(/shot\.map && u\.startsWith/);
  expect(RIG).toMatch(/INSERT INTO flocks \(name, creator_id, venue_id, venue_name, venue_address, venue_latitude, venue_longitude,/);
  expect(RIG).toContain('spot ? spot.latitude : null, spot ? spot.longitude : null,');
});

test('the site story can reach no paid service, and writes nowhere the site ships from', () => {
  for (const key of ['GOOGLE_PLACES_API_KEY', 'GEMINI_API_KEY', 'WEATHER_API_KEY', 'TICKETMASTER_API_KEY', 'VISION_API_KEY',
    'GOOGLE_VISION_API_KEY', 'STRIPE_SECRET_KEY', 'REVENUECAT_SECRET_API_KEY', 'POSTHOG_API_KEY', 'MAPTILER_SERVICE_TOKEN']) {
    expect(RIG).toContain(`'${key}'`);
  }
  expect(RIG).toContain("...(SITE ? Object.fromEntries(SITE_BLANK_KEYS.map((k) => [k, ''])) : {}),");
  // Every request for another host is refused in the browser and recorded.
  expect(RIG).toContain("return route.abort('blockedbyclient');");
  // Its default folder is the scratch space's, and public/ is refused.
  expect(RIG).toContain("const OUT_OVERRIDE = opt('out') || (SITE ? path.join(SCRATCH, `site${SUFFIX}`) : null);");
  expect(RIG).toMatch(/--story=site writes outside frontend\/public/);
  // No photo-real picture: the generated venue covers fail a frame.
  expect(RIG).toContain("return { u, ok: false, kind: 'photo-real-cover' };");
});

test('at a size of its own the site story keeps whole masters in each mode, and the website run is unchanged', () => {
  // --viewport and --scale turn it on; it takes no --suffix and writes only to an --out of its own.
  expect(RIG).toContain("const SITE_SIZED = SITE && (opt('viewport') !== null || opt('scale') !== null);");
  expect(RIG).toContain("for (const o of SITE_SIZED ? ['set', 'suffix'] : ['viewport', 'scale', 'modes', 'set']) {");
  expect(RIG).toMatch(/--story=site at a size of its own writes only to --out=<folder>/);
  // Without them it is the website's run: dark, at 390x844 at 2, cut by exportSite.
  expect(RIG).toContain("const size = SITE_SIZED ? CUSTOM_SIZE : SIZES[0];");
  expect(RIG).toContain("const modes = SITE_SIZED ? MODES : ['dark'];");
  expect(RIG).toContain('if (SITE_SIZED) await exportSiteMasters(sharp, frames, report, size, modes);');
  // One frame per mode, so frames, audits and anchors are keyed by both.
  expect(RIG).toContain('const siteKey = (id, mode) => (SITE_SIZED ? `${id}-${mode}` : id);');
  // Opaque PNGs, as Apple takes them.
  expect(RIG).toContain('await sharp(raw).removeAlpha().png({ compressionLevel: 9, palette: false }).toBuffer()');
});
