import React, { useEffect, useState } from 'react';
import { isNativeShell } from '../lib/nativeShell';
import './LandingPage.css';
import './HowItWorks.css';
import SiteFooter from './SiteFooter';
import SiteNav, { useSiteMenu } from './SiteNav';

// /how-it-works: one plan from the first invite to the bill, then the venue
// side and the four AIs, with the Stevens pitch video at the top. Built on the
// landing page's stylesheet (.lp tokens, Fraunces display, Hanken body) like
// /research, so it reads as the same site.
//
// Every step below was checked against the code it describes (and the budget
// line against getMaxPriceLevel, which drops places priced over the ceiling):
//   guests answer, vote and add a budget without an account   routes/guest.js, migration 071
//   the budget publishes one rounded-down figure, once        routes/budget.js bandCeiling + settledCeiling
//   "Still in?" before a deadline on the night                ChatDetail.js reconfirm strip, migration 072
//   events on a venue card only for a verified venue          routes/venueDashboard.js GET /public-events
//   Roost's forecast and advisor sit behind the venue plan    routes/advisor.js, GET /intelligence (requirePro)
// and the four AIs are described in the words of the video's own description.

const VIDEO_ID = 'Kdt9FI9CQZo';
const VIDEO_TITLE = 'Flock: four kinds of AI so the plan actually happens';
const CHANNEL_URL = 'https://www.youtube.com/@flock-social2026';
const CONTACT_EMAIL = 'social@flockcorp.com';

// The video's own chapter list, from its YouTube description.
const CHAPTERS = [
  { t: 0, label: 'The problem' },
  { t: 20, label: 'How Flock works' },
  { t: 30, label: 'Starling: the crowd forecast' },
  { t: 53, label: 'Owl: counting people on the Flux sensor' },
  { t: 68, label: 'Birdie and Roost' },
  { t: 80, label: 'Who it’s for' },
  { t: 92, label: 'How it makes money' },
  { t: 106, label: 'What’s next' },
];

const stamp = (t) => `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;

const DESCRIPTION = 'How a plan comes together in Flock, from the first invite to splitting the bill, plus the two-minute pitch video.';

/* The video is a poster until someone asks for it. A YouTube embed loads about
   a megabyte of player script and opens connections to Google the moment it
   renders, on a page whose point is to be quick to read. The poster is the
   video's own title card, served from this site, so nothing reaches YouTube
   until the visitor presses play; then the player comes from
   youtube-nocookie.com, which sets no cookie until playback. The chapter
   buttons start the player at their time.
   Inside the iPhone app's WebView the page origin is capacitor://localhost,
   which sends YouTube no usable Referer, and the embed answers with error
   153. The App Store build leaves this page out (src/index.js), but if it is
   ever mounted there, the poster becomes a plain link to watch on YouTube. */
function PitchVideo() {
  const [start, setStart] = useState(null);
  if (isNativeShell()) {
    return (
      <figure className="hw-video">
        <a className="hw-watch" href={`https://www.youtube.com/watch?v=${VIDEO_ID}`} target="_blank" rel="noopener noreferrer">
          Watch on YouTube: {VIDEO_TITLE}
        </a>
      </figure>
    );
  }
  return (
    <figure className="hw-video">
      <div className="hw-frame">
        {start === null ? (
          <button
            type="button"
            className="hw-poster"
            onClick={() => setStart(0)}
            aria-label={`Play the video: ${VIDEO_TITLE}`}
          >
            <picture>
              <source
                type="image/webp"
                srcSet="/how/pitch-poster-640.webp 640w, /how/pitch-poster-1280.webp 1280w"
                sizes="(min-width: 1100px) 860px, calc(100vw - 40px)"
              />
              <img src="/how/pitch-poster-960.jpg" width="1280" height="720" alt="" fetchPriority="high" />
            </picture>
            <span className="hw-play" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="28" height="28"><path d="M8 5.5v13l11-6.5z" fill="currentColor" /></svg>
            </span>
          </button>
        ) : (
          <iframe
            src={`https://www.youtube-nocookie.com/embed/${VIDEO_ID}?autoplay=1&rel=0&start=${start}`}
            title={VIDEO_TITLE}
            allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
            allowFullScreen
            referrerPolicy="strict-origin-when-cross-origin"
          />
        )}
      </div>
      <figcaption className="hw-video-cap">
        <span>
          Our entry to a 2026 high school entrepreneurship and AI video pitch
          competition, narrated by Asad Ali. 1 minute 59.
        </span>{' '}
        <a href={CHANNEL_URL} target="_blank" rel="noopener noreferrer">More on our YouTube channel</a>
      </figcaption>
      <div className="hw-chapters" role="group" aria-label="Start the video at a chapter">
        {CHAPTERS.map((c) => (
          <button type="button" key={c.t} onClick={() => setStart(c.t)}>
            <span className="hw-time">{stamp(c.t)}</span> {c.label}
          </button>
        ))}
      </div>
    </figure>
  );
}

// The plan, in order. Each `shot` is a real capture of the web app against
// seeded demo data (scripts/capture-screenshots.mjs, 2026-10-21), the same
// Friday Night Crew flock the home page follows, in the app's light theme
// (the home page uses the dark captures, so no screen repeats across the two). Paths are written out in full
// so publicScreenshotsShipped.test.js can see what ships.
const STEPS = [
  {
    id: 'start',
    art: { name: 'step-start', src: '/art/step-start-240.webp', srcSet: '/art/step-start-240.webp 240w, /art/step-start-480.webp 480w', width: 240, height: 121 },
    title: 'Start a flock',
    body: [
      'Pick a day and a time and invite people from your friends list. Anyone without the app gets a link and can join in from the browser, budget included, without making an account.',
    ],
    shot: {
      src: '/screenshots/create-light@2x.webp',
      srcSet: '/screenshots/create-light-480w.webp 480w, /screenshots/create-light@2x.webp 780w',
      alt: 'Starting a flock: which day, what time, and three friends invited.',
      caption: 'Invites go out as soon as the flock exists.',
    },
  },
  {
    id: 'vote',
    art: { name: 'step-vote', src: '/art/step-vote-240.webp', srcSet: '/art/step-vote-240.webp 240w, /art/step-vote-480.webp 480w', width: 240, height: 151 },
    title: 'Pick the place together',
    body: [
      'Anyone in the flock can add places. Each one arrives as a card with how busy it usually gets at that hour, plus anything the venue has posted, a deal or an upcoming event. The group votes, so nobody gets stuck being the decider.',
      'Stuck for ideas? Ask Birdie, the assistant inside the app, for spots near you that fit the group. Birdie is AI, built on Google’s Gemini, and it asks before it does anything for you.',
    ],
    shot: {
      src: '/screenshots/vote-light@2x.webp',
      srcSet: '/screenshots/vote-light-480w.webp 480w, /screenshots/vote-light@2x.webp 780w',
      alt: 'Vote for a Venue: five votes cast, The Copper Finch ahead with three, Juniper Bowl and Marigold Diner with one each.',
      caption: 'Five votes in. The Copper Finch is ahead.',
    },
  },
  {
    id: 'budget',
    art: { name: 'step-budget', src: '/art/step-budget-240.webp', srcSet: '/art/step-budget-240.webp 240w, /art/step-budget-480.webp 480w', width: 240, height: 134 },
    title: 'Budgets stay private',
    body: [
      'Everyone types what they can spend, and only they ever see it. When everyone going has answered, with at least three members’ amounts in, or the plan’s creator locks it, the group gets one figure: a ceiling rounded down, so it is never anyone’s exact number. The places Flock suggests for the plan stay under it.',
    ],
    shot: {
      src: '/screenshots/budget-light@2x.webp',
      srcSet: '/screenshots/budget-light-480w.webp 480w, /screenshots/budget-light@2x.webp 780w',
      alt: 'The budget sheet: preset amounts, a custom $35, and a note that no one else sees the answer.',
      caption: 'What you type here is never shown to the group.',
    },
  },
  {
    id: 'night',
    art: { name: 'step-go', src: '/art/step-go-240.webp', srcSet: '/art/step-go-240.webp 240w, /art/step-go-480.webp 480w', width: 240, height: 121 },
    title: 'On the night',
    body: [
      'The chat asks “Still in?” and counts who has said yes before a deadline, so you know who is actually coming. Check how busy the place is before anyone leaves.',
      'Sharing your live location with the group is there if you want it, and only while the plan is on. If something goes wrong, SOS sends where you are to the people you picked, with two taps.',
    ],
    shot: {
      src: '/screenshots/sos-light@2x.webp',
      srcSet: '/screenshots/sos-light-480w.webp 480w, /screenshots/sos-light@2x.webp 780w',
      alt: 'The SOS sheet: call 911, alert two trusted contacts by email, or share your location.',
      caption: 'Call 911 comes first, because Flock does not call emergency services for you.',
    },
  },
  {
    id: 'settle',
    art: { name: 'spot-seed', src: '/art/spot-seed-240.webp', srcSet: '/art/spot-seed-240.webp 240w, /art/spot-seed-480.webp 480w', width: 240, height: 232 },
    title: 'Settle up',
    body: [
      'Whoever paid enters the total and Flock splits it. Everyone gets a Venmo or Cash App link, or Zelle instructions, for their share, and the night stays on everyone’s calendar in Flock.',
    ],
    shot: {
      src: '/screenshots/bill-split-light@2x.webp',
      srcSet: '/screenshots/bill-split-light-480w.webp 480w, /screenshots/bill-split-light@2x.webp 780w',
      alt: 'Split the Bill: $142.60 with an 18% tip, paid by Jordan Avery, $28.52 each for five people.',
      caption: 'Jordan paid. Everyone else settles their $28.52 from here.',
    },
  },
];

const AIS = [
  { name: 'Starling', what: 'Forecasts how busy a place will be. It is 800 decision trees, tested on cities it never saw.' },
  { name: 'Birdie', what: 'Built on Google’s Gemini. Helps a group pick a place, and asks permission first.' },
  { name: 'Owl', what: 'A small neural network on the Flux heat sensor. It counts heads, and only the count leaves the device. It has been tested on research footage so far and has yet to run in a venue.' },
  { name: 'Roost’s advisor', what: 'Answers a venue owner’s questions. It is not allowed to write a single digit, so every number it shows comes from measured data.' },
];

// A plate, printed flat beside its step: the landing page's .lp-plate.
function Shot({ shot }) {
  if (!shot) return null;
  return (
    <figure className="lp-plate hw-shot">
      <img
        className="lp-shot"
        src={shot.src}
        srcSet={shot.srcSet}
        sizes="(min-width: 860px) 240px, 200px"
        width="390" height="844"
        loading="lazy" decoding="async"
        alt={shot.alt}
      />
      <figcaption className="lp-fig-cap">{shot.caption}</figcaption>
    </figure>
  );
}

export default function HowItWorksPage() {
  const menu = useSiteMenu();
  const pageInert = menu.menuOpen ? { inert: true } : {};

  useEffect(() => {
    document.title = 'How Flock works | Flock';
    const meta = document.querySelector('meta[name="description"]');
    if (meta) meta.setAttribute('content', DESCRIPTION);
  }, []);

  return (
    <div className="lp hw">
      <a className="lp-skip" href="#hw-main">Skip to the main content</a>

      <SiteNav menu={menu} current="/how-it-works" />

      <main id="hw-main" tabIndex={-1} {...pageInert}>
        <section className="lp-sec lp-sec-paper hw-hero" aria-labelledby="hw-h1">
          <div className="lp-wrap">
            <h1 id="hw-h1">How Flock works</h1>
            <p className="lp-lead hw-lead">
              Somebody has an idea for Friday. Here is every step from the first
              invite to splitting the bill.
            </p>
            <PitchVideo />
          </div>
        </section>

        <section className="lp-sec lp-sec-sand" aria-labelledby="hw-h-steps">
          <div className="lp-wrap">
            <h2 id="hw-h-steps" className="hw-steps-title">Every step of a plan</h2>
            <ol className="hw-steps">
              {STEPS.map((s) => (
                <li key={s.id} id={s.id} className={`hw-step${s.shot ? ' has-shot' : ''}`}>
                  <div className="hw-step-text">
                    {/* A painted vignette for the step, the same birds as the
                        rest of the site: decoration, so alt="" and lazy. */}
                    <img
                      className="lp-art hw-step-art"
                      src={s.art.src}
                      srcSet={s.art.srcSet}
                      sizes="140px"
                      width={s.art.width} height={s.art.height}
                      loading="lazy" decoding="async"
                      alt=""
                    />
                    <h3>{s.title}</h3>
                    {s.body.map((p) => <p key={p.slice(0, 24)}>{p}</p>)}
                  </div>
                  <Shot shot={s.shot} />
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section className="lp-sec lp-sec-navy lp-on-navy" aria-labelledby="hw-h-ai">
          <div className="lp-wrap">
            <h2 id="hw-h-ai">The four AIs inside</h2>
            <p className="lp-lead hw-ai-lead">
              The video names them. Here is what each one does, in a sentence or two.
            </p>
            <dl className="hw-ai">
              {AIS.map((a) => (
                <div key={a.name}>
                  <dt>{a.name}</dt>
                  <dd>{a.what}</dd>
                </div>
              ))}
            </dl>
          </div>
        </section>

        <section className="lp-sec lp-sec-paper" aria-labelledby="hw-h-venues">
          <div className="lp-wrap hw-venues">
            <div>
              <img
                className="lp-art hw-venues-art"
                src="/art/events-480.webp"
                srcSet="/art/events-480.webp 480w, /art/events-960.webp 960w"
                sizes="min(420px, 90vw)"
                width="480" height="234"
                loading="lazy" decoding="async"
                alt=""
              />
              <h2 id="hw-h-venues">If you run a venue</h2>
              <p>
                A free venue account shows which flocks have you in their vote
                this week. You can put a deal on your venue’s card, where groups
                see it while they choose, and reply to reviews. Once your venue
                is verified, its events show on the card under “Happening here”.
              </p>
              <p>
                Roost, the paid plan for venues, adds your own hour-by-hour
                forecast and the advisor above. No venue is being charged yet. To
                get in early, write to{' '}
                <a href={`mailto:${CONTACT_EMAIL}?subject=Flock%20for%20venues`}>{CONTACT_EMAIL}</a>.
              </p>
            </div>
            <figure className="lp-plate hw-venues-plate">
              <img
                className="lp-shot"
                src="/screenshots/venue-card-events-light@2x.webp"
                srcSet="/screenshots/venue-card-events-light-480w.webp 480w, /screenshots/venue-card-events-light@2x.webp 780w"
                sizes="(min-width: 860px) 240px, 200px"
                width="390" height="844"
                loading="lazy" decoding="async"
                alt="A venue card in Flock with three upcoming events under Happening here."
              />
              <figcaption className="lp-fig-cap">A verified venue’s card, as people in Flock see it.</figcaption>
            </figure>
          </div>
        </section>

        <section className="lp-cta lp-on-navy" aria-labelledby="hw-h-try">
          <div className="lp-wrap lp-cta-in">
            <div>
              <h2 id="hw-h-try">Try it on your next plan.</h2>
              <p className="lp-lead hw-try-lead">
                Flock runs in your browser today. The iPhone app is with Apple for review.
              </p>
              <div className="lp-cta-row">
                <a className="lp-btn lp-btn-cream lp-btn-lg" href="/signup">Create your account</a>
                <a className="hw-textlink" href="/app">Sign in</a>
              </div>
            </div>
          </div>
        </section>
      </main>

      <div {...pageInert}>
        <SiteFooter
          variant="landing"
          className="lp-footer"
          brand={(
            <a className="lp-brand" href="/">
              <img src="/marks/logo-64.png?v=2" width="24" height="24" alt="" aria-hidden="true" loading="lazy" style={{ borderRadius: '50%', display: 'block' }} />
              Flock
            </a>
          )}
        />
      </div>
    </div>
  );
}
