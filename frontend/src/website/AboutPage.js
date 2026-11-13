import React, { useEffect } from 'react';
import './LandingPage.css';
import './AboutPage.css';
import SiteFooter from './SiteFooter';
import SiteNav, { useSiteMenu } from './SiteNav';
import AppStoreBadge from './AppStoreBadge';
import { LISTING_ID } from './AppStoreListing';
import { shareThisPage } from './shareCard';
import { COMPETITIONS, HONORS } from './competitions';

const CONTACT_EMAIL = 'social@flockcorp.com';
const YOUTUBE_URL = 'https://www.youtube.com/@flock-social2026';

// /about, rebuilt on the landing page's system (.lp tokens, SiteNav) on
// 2026-10-21, in the order the best company About pages use: who and what,
// the story, the people, what the company holds to, the timeline, where things
// stand, how to reach it. Honors and competitions (2026-11-06) follow the
// timeline.
//
// THE RULE FOR THIS PAGE: every fact is real and on the record, and anything
// not yet written is a placeholder that says it is coming, never invented copy.
//   Flock Social LLC, a Pennsylvania company, organized September 2026   PA entity record
//   Jayden Bansal, solo technical founder and CEO, an 11th grader in      the pitch video's own description, and the company's own title for the role
//     Pennsylvania who builds all of it, from the app to the Flux sensor  the company's IP assignment: nobody else has contributed code, design or art
//   Asad Ali, growth and competitions lead since late August 2026         Asad Ali's own description of the role, Oct 2026
//   1st place in Innovation Plan at Pennsylvania DECA States, 2026        on the site since August; its sources are with HONORS in competitions.js
//   the timeline, each dot dated by month                                 the code history, Apple, the state record, the model and sensor logs, the honors (see TIMELINE)
//   the competitions and their statuses, and the honors                   competitions.js, which names its sources
// No team member's school is named anywhere on the page (a Diamond Challenge
// rule). The competitions' organizers are named, and some are universities;
// none is that school.
//   on the App Store since November 4, 2026                               Apple released 1.0; apps.apple.com/app/id6781442127
//   no venue charged; Flock Pro on sale on the web since November 13, 2026 (PAYWALL_ENABLED=true)
// The story and the bios were filled out on 2026-11-13 from the record (see
// PEOPLE and STORY); Asad's photo is up, the maintainer's is still to come.
// The names are in the title and description because the page is what a
// search for either name, or for the company, should land on.
const DESCRIPTION = 'Flock, an app for making plans with friends, is made by Jayden Bansal (Solo Technical Founder & CEO) and Asad Ali (Growth & Competitions Lead).';

// The people (2026-11-13, his asks: Asad's photo on the page, a longer story
// and the bios filled out). Every sentence is a fact the site already states
// elsewhere (the timeline, the competitions, the product) or the record holds;
// nothing about either of them is made up, and no school is named. Asad's
// photo is the one he sent, cropped round and lightly sharpened
// (public/people/asad-ali-*.webp); the maintainer's is still to come, so his spot shows
// his initials until it does.
const PEOPLE = [
  {
    name: 'Jayden Bansal',
    initials: 'JB',
    role: 'Solo Technical Founder & CEO',
    line: 'An 11th grader in Pennsylvania who started Flock and builds all of it, from the app to the Flux sensor.',
    more: 'That covers the iPhone app and the website, Birdie, Starling, and Owl, the model inside Flux that counts people from heat. He also published Flock’s research paper on forecasting crowds and counting people.',
  },
  {
    name: 'Asad Ali',
    initials: 'AA',
    role: 'Growth & Competitions Lead',
    line: 'On Flock since late August 2026.',
    more: 'He leads Flock’s growth and its competition entries. With the maintainer he took Flock into the Conrad Challenge’s Innovation Stage and is entering DECA’s Start-Up Business Plan and the Diamond Challenge. He also tests the app the way a new user would, and two of November’s fixes came from his notes.',
    photo: { src: '/people/asad-ali-280.webp', srcSet: '/people/asad-ali-280.webp 280w, /people/asad-ali-520.webp 520w' },
  },
];

// How it started, past its first line (same rule as PEOPLE: only what the
// record holds).
const STORY = [
  'Flock exists because the group chat kept killing perfectly good Friday nights.',
  'Someone suggests a place. A few people react, nobody commits, and by the time the group agrees, the spot is packed or the night is gone. Jayden Bansal started building Flock in 2025 to give a group one place to make the plan instead.',
  'In Flock a group starts a flock, votes on where to go and sees how busy each place will be before anyone leaves, from Starling, Flock’s crowd forecast model. Each person can set a budget, and the group sees only one rounded-down number. Birdie, Flock’s assistant, suggests places that fit, and the bill splits in the app at the end of the night.',
  'Asad Ali joined in August 2026 to grow it and take it to competitions. The timeline below has the rest, from the first website to the App Store.',
];

// Commitments the product already keeps, each one enforced in code, which is
// why they can be stated here as fact rather than as aspiration.
const HOLDS = [
  { what: 'Your budget stays yours.', how: 'The group sees one rounded-down number. Nobody else sees what you typed.' },
  { what: 'No ads and no feed.', how: 'There is nothing to scroll and nobody to follow.' },
  { what: 'Location stays off until you share it.', how: 'Nothing tracks you in the background, and two-tap SOS reaches the trusted contacts you picked.' },
  { what: 'The sensor never sends a picture.', how: 'Flux sends how many people are in the room and, on a unit set up for tables, how many are at each table and what state it is in. No images, video or identities leave it.' },
  { what: 'Only what ships.', how: 'If the site describes a feature, the app does it today.' },
];

// THE TIMELINE (his call, 2026-11-11): the company's story in ten dots, where
// it started, grew, changed and became. It replaced "Milestones so far", a
// dated log that grew to seventeen lines and, dated to the day, read as
// everything happening at once; so each dot is a stage with a month. Every
// dot is a fact from the company's own records (the code history, Apple's
// emails, the state record, the model and sensor logs, the honors in
// competitions.js). No accuracy figures (the model-metrics rule), no user
// counts.
//   2025             Flock started in 2025 (his correction, 2026-11-13; the
//                    first commit in this repository's history is January 18,
//                    2026, which the timeline used to give, but the work began
//                    the year before); the year alone, so no machine date
//   Early 2026       1st place in Innovation Plan at Pennsylvania DECA States,
//                    on the site since August; the state conference runs
//                    before April's international one, and its month is not
//                    on the record (see HONORS in competitions.js)
//   June 2026        the iPhone app rebuilt on the web app's code (June 17),
//                    first TestFlight build June 18
//   August 2026      flockcorp.com and Starling both went live August 12
//   August 2026      Asad Ali joined, late August (PEOPLE, below)
//   September 2026   Flock Social LLC organized, Pennsylvania
//   September 2026   the first Flux prototype ran, September 25
//   October 2026     the research paper, published here October 13
//   November 2026    Apple released Flock 1.0, November 4
//   November 2026    LionCage, November 6 (HONORS in competitions.js)
// The two competition dots carry the competition's logo, the same file the
// Competitions ledger shows (his call: a competition and its logo go
// together). The App Store dot is the one set apart (.is-milestone), and its
// words "on the App Store" link to the picture of the listing on the home
// page (AppStoreListing.js); Apple's badge is in "Where things stand" below.
const TIMELINE = [
  { stage: 'It started', when: '2025', what: 'the maintainer began building Flock, an app for making plans with friends.' },
  { stage: 'First win', when: 'Early 2026', what: 'Flock’s Innovation Plan took 1st place at the Pennsylvania DECA state conference.', logo: { src: '/logos/competitions/deca.png', width: 640, height: 132 } },
  { stage: 'Changed course', when: 'June 2026', date: '2026-06', what: 'The iPhone app was rebuilt on the web app’s code, so one Flock runs everywhere, and the first build reached TestFlight.' },
  { stage: 'Went live', when: 'August 2026', date: '2026-08', what: 'flockcorp.com went live, with Starling, Flock’s crowd forecast model, forecasting in the app.' },
  { stage: 'Grew', when: 'August 2026', date: '2026-08', what: 'Asad Ali joined as growth and competitions lead.' },
  { stage: 'Became a company', when: 'September 2026', date: '2026-09', what: 'Flock Social LLC formed in Pennsylvania.' },
  { stage: 'Built hardware', when: 'September 2026', date: '2026-09', what: 'The first Flux sensor ran: a box that counts the people in a room without sending a picture.' },
  { stage: 'Published', when: 'October 2026', date: '2026-10', what: 'Flock published its research paper on forecasting crowds and counting people.' },
  { stage: 'Launched', when: 'November 2026', date: '2026-11', what: 'Flock is on the App Store.', milestone: true, link: { words: 'on the App Store', href: `/#${LISTING_ID}` } },
  { stage: 'Recognized', when: 'November 2026', date: '2026-11', what: '2nd place in the Technology category and the Rising Entrepreneur Award at LionCage, Penn State Great Valley.', logo: { src: '/logos/competitions/launchbox.png', width: 640, height: 166 } },
];

// The competitions ledger's lead: the ones Flock is entering next and the
// ones it has been entered in (competitions.js says which is which).
const COMPETITIONS_LEAD = 'Where Flock competes.';

// An entry's words with one phrase in them made a link.
function withLink(what, { words, href }) {
  const at = what.indexOf(words);
  if (at < 0) return what;
  return (
    <>
      {what.slice(0, at)}
      <a href={href}>{words}</a>
      {what.slice(at + words.length)}
    </>
  );
}

export default function AboutPage() {
  const menu = useSiteMenu();
  const pageInert = menu.menuOpen ? { inert: true } : {};

  useEffect(() => {
    document.title = 'About Flock: Jayden Bansal and Asad Ali | Flock';
    const meta = document.querySelector('meta[name="description"]');
    if (meta) meta.setAttribute('content', DESCRIPTION);
    return shareThisPage('/about');
  }, []);

  return (
    <div className="lp ab">
      <a className="lp-skip" href="#ab-main">Skip to the main content</a>

      <SiteNav menu={menu} current="/about" />

      <main id="ab-main" tabIndex={-1} {...pageInert}>
        <section className="lp-sec lp-sec-navy lp-on-navy ab-hero" aria-labelledby="ab-h1">
          <div className="lp-wrap">
            <h1 id="ab-h1">About Flock</h1>
            <p className="lp-lead ab-lead">
              Flock is an app for making plans with friends. Jayden Bansal and
              Asad Ali make it, as Flock Social LLC, a Pennsylvania company.
            </p>
          </div>
        </section>

        <section className="lp-sec lp-sec-paper" aria-labelledby="ab-h-story">
          <div className="lp-wrap ab-story">
            <div>
              <h2 id="ab-h-story">How it started</h2>
              {STORY.map((s) => <p key={s}>{s}</p>)}
            </div>
            {/* Not lazy: on a phone this wren is the largest thing in the
                first screen (the page's LCP), and lazy loading held it back
                1.3 s in Lighthouse on 2026-10-29. */}
            <img
              className="lp-art ab-story-art"
              src="/art/spot-wren-perch-240.webp"
              srcSet="/art/spot-wren-perch-240.webp 240w, /art/spot-wren-perch-480.webp 480w"
              sizes="200px"
              width="240" height="267"
              decoding="async" fetchPriority="high"
              alt=""
            />
          </div>
        </section>

        <section className="lp-sec lp-sec-sand" aria-labelledby="ab-h-people">
          <div className="lp-wrap">
            <h2 id="ab-h-people">Who makes it</h2>
            {/* Each person's portrait above their name, round. A person
                without a photo yet gets their initials in the same circle, so
                the two columns stay level. The photo's alt is empty: the name
                is the heading right under it. */}
            <div className="ab-people">
              {PEOPLE.map((p) => (
                <div key={p.name} className="ab-person">
                  {p.photo ? (
                    <img
                      className="ab-portrait"
                      src={p.photo.src}
                      srcSet={p.photo.srcSet}
                      sizes="140px"
                      width="280" height="280"
                      loading="lazy" decoding="async"
                      alt=""
                    />
                  ) : (
                    <span className="ab-portrait ab-portrait-initials" aria-hidden="true">{p.initials}</span>
                  )}
                  <h3>{p.name}</h3>
                  <p className="ab-role">{p.role}</p>
                  {p.line && <p>{p.line}</p>}
                  {p.more && <p>{p.more}</p>}
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="lp-sec lp-sec-navy lp-on-navy" aria-labelledby="ab-h-holds">
          <div className="lp-wrap">
            <h2 id="ab-h-holds">What Flock holds to</h2>
            <div className="ab-holds">
              {HOLDS.map((h) => (
                <div key={h.what}>
                  <h3>{h.what}</h3>
                  <p>{h.how}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="lp-sec lp-sec-paper" aria-labelledby="ab-h-timeline">
          <div className="lp-wrap">
            <img
              className="lp-art ab-milestones-art"
              src="/art/spot-hop-240.webp"
              srcSet="/art/spot-hop-240.webp 240w, /art/spot-hop-480.webp 480w"
              sizes="180px"
              width="240" height="230"
              loading="lazy" decoding="async"
              alt=""
            />
            <h2 id="ab-h-timeline">Timeline</h2>
            {/* One dot to a stage on a line down the left; the stage's name,
                its month, what happened; a competition's logo beside its dot.
                Spans, not paragraphs, inside each item, with a space between
                them, so the item reads as one line ("Went live August 2026
                flockcorp.com went live ...") to a screen reader and in the
                copy AI crawlers are served. The logo's alt is empty: the words
                name the competition. */}
            <ol className="ab-timeline">
              {TIMELINE.map((t) => (
                <li key={t.what} className={t.milestone ? 'is-milestone' : undefined}>
                  <span className="ab-tl-dot" aria-hidden="true" />
                  <span className="ab-tl-body">
                    <span className="ab-tl-head">
                      <span className="ab-tl-stage">{t.stage}</span>{' '}
                      {t.date
                        ? <time className="ab-when" dateTime={t.date}>{t.when}</time>
                        : <span className="ab-when">{t.when}</span>}
                    </span>{' '}
                    <span className="ab-what">{t.link ? withLink(t.what, t.link) : t.what}</span>
                  </span>
                  {t.logo && (
                    <span className="ab-tl-logo">
                      <img src={t.logo.src} width={t.logo.width} height={t.logo.height} alt="" loading="lazy" decoding="async" />
                    </span>
                  )}
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* Honors, from competitions.js, on the stone band between the
            milestones' paper and the competitions' navy. The DECA result that
            was a milestone labelled "Award" lives here. If HONORS were empty
            the section would render nothing, never an empty heading or a
            "coming soon". */}
        {HONORS.length > 0 && (
          <section className="lp-sec lp-sec-sand" aria-labelledby="ab-h-honors">
            <div className="lp-wrap">
              <h2 id="ab-h-honors">Honors</h2>
              {/* The rosette is generated art (Higgsfield, 2026-11-07): a navy
                  ribbon with the fairywren in its medallion, no words in it.
                  It is decoration beside the list, which says what the honor
                  is, so it is hidden from screen readers. Drawn at 66 x 96,
                  with a 2x file. */}
              <div className="ab-honors-row">
                <img
                  className="ab-honors-badge"
                  src="/art/honors-rosette-96.webp"
                  srcSet="/art/honors-rosette-96.webp 1x, /art/honors-rosette-192.webp 2x"
                  width={66}
                  height={96}
                  alt=""
                  aria-hidden="true"
                  decoding="async"
                  loading="lazy"
                />
                <ol className="ab-honors">
                  {HONORS.map((h) => (
                    <li key={h.what}>
                      {h.date
                        ? <time className="ab-when" dateTime={h.date}>{h.when}</time>
                        : <span className="ab-when">{h.when}</span>}{' '}
                      <span className="ab-what">{h.what}</span>
                    </li>
                  ))}
                </ol>
              </div>
            </div>
          </section>
        )}

        {/* Competitions: a ledger on the navy, one entry to a row, from
            competitions.js. Each is the organizer's logo on a white tile (his
            call, 2026-11-11), then the name with who runs it and who entered
            it, then where it stands. The logo's alt is empty: the organizer is
            named in words right beside it, so a screen reader would only hear
            it twice. The line on what went in came off the same day. An entry
            with two logos (AwardX and LaunchX, 2026-11-13) stacks a tile for
            each in the same column. */}
        <section className="lp-sec lp-sec-navy lp-on-navy" aria-labelledby="ab-h-comps">
          <div className="lp-wrap">
            <h2 id="ab-h-comps">Competitions</h2>
            <p className="lp-lead">{COMPETITIONS_LEAD}</p>
            <div className="ab-comps">
              {COMPETITIONS.map((c) => (
                <div key={c.name} className="ab-comp">
                  <div className="ab-comp-logos">
                    {(c.logos || [c.logo]).map((l) => (
                      <div key={l.src} className="ab-comp-logo">
                        <img
                          src={l.src}
                          width={l.width}
                          height={l.height}
                          alt=""
                          loading="lazy"
                          decoding="async"
                        />
                      </div>
                    ))}
                  </div>
                  <div>
                    <h3>{c.name}</h3>
                    <p className="ab-comp-by">{c.organizer}</p>
                    <p className="ab-comp-team">{c.team}</p>
                  </div>
                  <p className="ab-comp-status">
                    {c.date ? <time dateTime={c.date}>{c.status}</time> : c.status}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="lp-sec lp-sec-sand" aria-labelledby="ab-h-now">
          <div className="lp-wrap ab-now">
            <img
              className="lp-art ab-now-art"
              src="/art/venues-360.webp"
              srcSet="/art/venues-360.webp 360w, /art/venues-720.webp 720w"
              sizes="min(300px, 70vw)"
              width="360" height="274"
              loading="lazy" decoding="async"
              alt=""
            />
            <h2 id="ab-h-now">Where things stand</h2>
            <p>
              Flock is on the App Store for iPhone, and the web app is live at
              flockcorp.com.
            </p>
            <div className="ab-store">
              <AppStoreBadge className="lp-appstore" />
            </div>
            <p>
              Venues can make a free account;
              Roost, the paid plan for venues, isn’t charging anyone yet. There’s
              a paid plan for people too, Flock Pro, with more Birdie, more crowd
              forecasts and crowd alerts, on sale <a href="/pro">on this site</a>{' '}
              since November 13, 2026. Buying it here unlocks it in the iPhone
              app too.
            </p>
            <p>
              Flux has only been tested on research footage so far. A retrained
              crowd model gets scored in late November on days it never saw, and
              it ships only if it passes thresholds set in September.
            </p>
          </div>
        </section>

        <section className="lp-cta lp-on-navy" aria-labelledby="ab-h-contact">
          <div className="lp-wrap lp-cta-in">
            <div>
              <h2 id="ab-h-contact">Get in touch</h2>
              <p className="lp-lead ab-contact-lead">
                Email <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a> about
                anything, venues included. The pitch and anything new go up on{' '}
                <a href={YOUTUBE_URL} target="_blank" rel="noopener noreferrer">our YouTube channel</a>.
              </p>
              <p className="ab-fine">
                Flock Social LLC is not affiliated with Flock Safety or its license
                plate cameras.
              </p>
              <p className="ab-fine">
                The cartoon avatars Flock can make for you are drawn with the
                open-source <a href="https://www.dicebear.com">DiceBear</a> library,
                from artwork by Lisa Wischofsky (Adventurer) and Draftbit (Personas),
                both under <a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>,
                Pablo Stanley (Avataaars and Bottts), and DiceBear (Pixel Art, CC0).
              </p>
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
