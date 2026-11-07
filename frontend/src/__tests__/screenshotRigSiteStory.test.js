/**
 * THE SCREENSHOT RIG'S SITE STORY (--story=site), the parts that decide a run.
 *
 * scripts/capture-screenshots.mjs --story=site --suffix=-v3 shoots the frames
 * the website ships. The run boots a whole local stack, so, as
 * screenshotRigNotes.test.js does with writeManifest, this lifts the two pure
 * functions out of the rig's source and runs them: siteClock, which puts the
 * browser at 7 PM by moving its time zone (tools/e2e/clock.js) and turns the
 * story's wall-clock times into instants, and siteRefusal, which stops a run
 * on a Friday (Friday Night Crew would be a week out, past the venue
 * dashboard's seven days) or late in the hour. Then the source, for what a
 * run may spend and where it may write.
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
