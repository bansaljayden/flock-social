import React, { useEffect, useState } from 'react';
import { isNativeShell } from '../lib/nativeShell';
import './LandingPage.css';
import './HowItWorks.css';
import SiteFooter from './SiteFooter';
import SiteNav, { useSiteMenu } from './SiteNav';
import PhoneDevice from './PhoneDevice';
import { shareThisPage } from './shareCard';

// /how-it-works: one plan from the first invite to the bill, then the venue
// side and the four AIs, with the app's three-minute video at the top. Built on the
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
// The four AI lines began as the video's own description and were rewritten
// in plain sentences on 2026-10-21 (the maintainer's ask), with the same facts.

// The app's three-minute video (2:57), the Congressional App Challenge entry.
const VIDEO_ID = 'zpujGx88coU';
const VIDEO_TITLE = 'Flock: Nurturing friendship, one flock at a time';
const CONTACT_EMAIL = 'social@flockcorp.com';

// The video's own chapter list, from its YouTube description; each button
// starts the player at its time.
const CHAPTERS = [
  { t: 0, label: 'The problem, and who I am' },
  { t: 20, label: 'Making a plan with friends' },
  { t: 46, label: 'Where to go: the crowd forecast' },
  { t: 65, label: 'Voting, the budget and the bill' },
  { t: 91, label: 'How it’s built, and how the budget stays private' },
  { t: 115, label: 'The forecast data and model' },
  { t: 139, label: 'The iPhone app and the venue side' },
  { t: 159, label: 'Wrap-up' },
];

const stamp = (t) => `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;

const DESCRIPTION = 'How a plan comes together in Flock, from the first invite to splitting the bill, plus a three-minute video of the app.';

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
                srcSet="/how/video-poster-640.webp 640w, /how/video-poster-1280.webp 1280w"
                sizes="(min-width: 1100px) 860px, calc(100vw - 40px)"
              />
              <img src="/how/video-poster-960.jpg" width="1280" height="720" alt="" fetchPriority="high" />
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

// The plan, in order, one band per step, paper and navy in turn (the maintainer,
// 2026-10-21). Each `shot` is a real capture of the web app against seeded
// demo data (scripts/capture-screenshots.mjs, 2026-10-21), the same Friday
// Night Crew flock the home page follows, in the dark theme every capture on
// the site uses. The navy bands' vignettes are the robin and a sparrow: their
// pale and orange breasts read on navy, where the navy wrens would vanish.
// Paths are written out in full
// so publicScreenshotsShipped.test.js can see what ships.
const STEPS = [
  {
    id: 'start',
    art: { name: 'step-start', src: '/art/step-start-240.webp', srcSet: '/art/step-start-240.webp 240w, /art/step-start-480.webp 480w', width: 240, height: 121 },
    title: 'Start a flock',
    body: [
      'Pick a day and time and invite your friends. Anyone without the app gets a link and joins from the browser, budget included, no account needed.',
    ],
    shot: {
      src: '/screenshots/create-dark-v2@2x.webp',
      srcSet: '/screenshots/create-dark-v2-480w.webp 480w, /screenshots/create-dark-v2@2x.webp 780w',
      alt: 'Starting a flock: which day, what time, and three friends invited.',
      caption: 'Invites go out right away.',
    },
  },
  {
    id: 'vote',
    art: { name: 'spot-hop', src: '/art/spot-hop-240.webp', srcSet: '/art/spot-hop-240.webp 240w, /art/spot-hop-480.webp 480w', width: 240, height: 230 },
    title: 'Pick the place together',
    body: [
      'Anyone in the flock can add places. Each card shows how busy the place usually gets at that hour, plus any deal or event a verified venue has posted. Then everyone votes, so nobody gets stuck deciding.',
      'Out of ideas? Ask Birdie for spots near you that fit the group. Birdie is AI, built on Google’s Gemini, and it asks before it does anything for you.',
    ],
    shot: {
      src: '/screenshots/vote-dark-v2@2x.webp',
      srcSet: '/screenshots/vote-dark-v2-480w.webp 480w, /screenshots/vote-dark-v2@2x.webp 780w',
      alt: 'Vote for a Venue: five votes cast, Pizzeria Stella ahead with three, Oh Brother Philly and Silk City with one each.',
      // No caption; the alt says what it shows.
    },
  },
  {
    id: 'budget',
    art: { name: 'step-budget', src: '/art/step-budget-240.webp', srcSet: '/art/step-budget-240.webp 240w, /art/step-budget-480.webp 480w', width: 240, height: 134 },
    title: 'Budgets stay private',
    body: [
      'Everyone types what they can spend, and only they see it. Once at least three members have put in an amount, and everyone going has answered or the creator locks it, the group gets one number. It’s rounded down, so it’s never anyone’s exact budget, and the places Flock suggests stay under it.',
    ],
    shot: {
      src: '/screenshots/budget-dark-v2@2x.webp',
      srcSet: '/screenshots/budget-dark-v2-480w.webp 480w, /screenshots/budget-dark-v2@2x.webp 780w',
      alt: 'The budget sheet: preset amounts, a custom $35, and a note that no one else sees the answer.',
      caption: 'The group never sees this.',
    },
  },
  {
    id: 'night',
    art: { name: 'spot-flap', src: '/art/spot-flap-240.webp', srcSet: '/art/spot-flap-240.webp 240w, /art/spot-flap-480.webp 480w', width: 240, height: 308 },
    title: 'On the night',
    body: [
      'Before a deadline, the chat asks “Still in?” and counts the yeses, so you know who’s actually coming. Check how busy the place is before you leave.',
      'You can share your live location with the group while the plan is on, if you want. If something goes wrong, two taps on SOS send where you are to the people you picked.',
    ],
    shot: {
      src: '/screenshots/sos-dark-v2@2x.webp',
      srcSet: '/screenshots/sos-dark-v2-480w.webp 480w, /screenshots/sos-dark-v2@2x.webp 780w',
      alt: 'The SOS sheet: call 911, alert two trusted contacts by email, or share your location.',
      // No caption (the maintainer, 2026-10-21: "delete this"); the alt says what it shows.
    },
  },
  {
    id: 'settle',
    art: { name: 'step-go', src: '/art/step-go-240.webp', srcSet: '/art/step-go-240.webp 240w, /art/step-go-480.webp 480w', width: 240, height: 121 },
    title: 'Settle up',
    body: [
      'Whoever paid enters the total, and Flock splits it. Everyone gets a Venmo or Cash App link for their share, or Zelle instructions.',
    ],
    shot: {
      src: '/screenshots/bill-split-dark-v2@2x.webp',
      srcSet: '/screenshots/bill-split-dark-v2-480w.webp 480w, /screenshots/bill-split-dark-v2@2x.webp 780w',
      alt: 'Split the Bill: $142.60 with an 18% tip, paid by Asad Ali, $28.52 each for five people.',
      caption: '$28.52 each, paid back here.',
    },
  },
];

const AIS = [
  { name: 'Starling', what: 'The crowd forecast. It’s 800 small decision trees, and we tested it on three cities it never trained on.' },
  { name: 'Birdie', what: 'Built on Google’s Gemini. Ask it where to go and it suggests places that fit the group. It checks with you before it does anything.' },
  { name: 'Owl', what: 'A small neural network that counts people from body heat, on the Raspberry Pi inside Flux. Only counts leave the box: the people in view and, on a unit set up for tables, how many are at each table. So far it’s been tested on research footage.' },
  { name: 'Roost’s advisor', what: 'Helps a venue owner make more money: a short answer, a few points, and the sources at the end. Its advice builds on a playbook of tested moves from the trade, and numbers about the venue come from its measured data and are checked before the owner sees them.' },
];

// A plate beside its step, the capture in the site's drawn phone.
function Shot({ shot }) {
  if (!shot) return null;
  return (
    <figure className="lp-plate hw-shot">
      <div className="lp-phone">
        <PhoneDevice>
          <img
            className="lp-shot"
            src={shot.src}
            srcSet={shot.srcSet}
            sizes="(min-width: 860px) 224px, (min-width: 760px) 186px, min(242px, 65vw)"
            width="390" height="844"
            loading="lazy" decoding="async"
            alt={shot.alt}
          />
        </PhoneDevice>
      </div>
      {shot.caption ? <figcaption className="lp-fig-cap">{shot.caption}</figcaption> : null}
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
    return shareThisPage('/how-it-works');
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
              Somebody has an idea for Friday. In Flock that idea goes through
              five steps, and the last one is splitting the bill.
            </p>
            <PitchVideo />
          </div>
        </section>

        <section className="lp-sec lp-sec-sand hw-steps-intro" aria-labelledby="hw-h-steps">
          <div className="lp-wrap">
            <h2 id="hw-h-steps" className="hw-steps-title">Every step of a plan</h2>
            <p className="lp-lead">Every screen below is the web app, with the same five friends as the home page.</p>
          </div>
        </section>

        {STEPS.map((s, i) => (
          <section
            key={s.id}
            id={s.id}
            className={i % 2 ? 'lp-sec lp-sec-navy lp-on-navy hw-step-band' : 'lp-sec lp-sec-paper hw-step-band'}
            aria-labelledby={`hw-h-${s.id}`}
          >
            <div className="lp-wrap">
              <div className={`hw-step${s.shot ? ' has-shot' : ''}`}>
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
                  <h3 id={`hw-h-${s.id}`}>{s.title}</h3>
                  {s.body.map((para) => <p key={para.slice(0, 24)}>{para}</p>)}
                </div>
                <Shot shot={s.shot} />
              </div>
            </div>
          </section>
        ))}

        <section className="lp-sec lp-sec-navy lp-on-navy" aria-labelledby="hw-h-ai">
          <div className="lp-wrap">
            <h2 id="hw-h-ai">The four AIs inside</h2>
            <p className="lp-lead hw-ai-lead">
              The video names all four.
            </p>
            <dl className="hw-ai">
              {AIS.map((a) => (
                <div key={a.name}>
                  <dt>{a.name}</dt>
                  <dd>{a.what}</dd>
                </div>
              ))}
            </dl>
            <p className="hw-ai-more">
              Each one, with the figures from the video, is on{' '}
              <a href="/ai">How the AI works</a>. Owl’s sensor has a page of its
              own: <a href="/flux">Flux</a>.
            </p>
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
                this week, and you can reply to reviews. Once your venue is
                verified, your deals go on its card, and your events show under
                “Happening here”.
              </p>
              <p>
                A <a href="/flux">Flux</a> box over the door, still a prototype,
                is being built to show which tables are free, seated, waiting on
                a server or ready to clear.
              </p>
              <p>
                Roost, the paid plan, adds your own hour-by-hour forecast and the
                advisor above. No venue is being charged yet. Want in early? Write
                to <a href={`mailto:${CONTACT_EMAIL}?subject=Flock%20for%20venues`}>{CONTACT_EMAIL}</a>.
              </p>
            </div>
            <figure className="lp-plate hw-venues-plate">
              <div className="lp-phone">
                <PhoneDevice>
                  <img
                    className="lp-shot"
                    src="/screenshots/venue-card-events-dark-v2@2x.webp"
                    srcSet="/screenshots/venue-card-events-dark-v2-480w.webp 480w, /screenshots/venue-card-events-dark-v2@2x.webp 780w"
                    sizes="(min-width: 860px) 224px, (min-width: 760px) 186px, min(242px, 65vw)"
                    width="390" height="844"
                    loading="lazy" decoding="async"
                    alt="A verified venue’s card in Flock with three upcoming events under Happening here."
                  />
                </PhoneDevice>
              </div>
              {/* No caption (the maintainer, 2026-10-21); the alt names it. */}
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
