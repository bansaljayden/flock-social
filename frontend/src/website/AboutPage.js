import React, { useEffect } from 'react';
import './LandingPage.css';
import './AboutPage.css';
import SiteFooter from './SiteFooter';
import SiteNav, { useSiteMenu } from './SiteNav';
import { shareThisPage } from './shareCard';

const CONTACT_EMAIL = 'social@flockcorp.com';
const YOUTUBE_URL = 'https://www.youtube.com/@flock-social2026';

// /about, rebuilt on the landing page's system (.lp tokens, SiteNav) on
// 2026-10-21, in the order the best company About pages use: who and what,
// the story, the people, what the company holds to, milestones, where things
// stand, how to reach it.
//
// THE RULE FOR THIS PAGE: every fact is real and on the record, and anything
// not yet written is a placeholder that says it is coming, never invented copy.
//   Flock Social LLC, a Pennsylvania company, organized September 2026   PA entity record
//   Jayden Bansal, solo technical founder and CEO, an 11th grader in      the pitch video's own description, and the company's own title for the role
//     Pennsylvania who builds all of it, from the app to the Flux sensor  the company's IP assignment: nobody else has contributed code, design or art
//   Asad Ali, growth and competitions lead since late August 2026         Asad Ali's own description of the role, Oct 2026
//   1st place at PA DECA States                                           the landing page, since August
//   research paper, October 2026; pitch video entry, October 2026         /research; the video, 18 Oct 2026
// No school is named anywhere on the page (a Diamond Challenge rule).
//   iPhone app in App Store review; no venue charged; Flock Pro not on public sale
// The photos, the bios, the full story and the milestone details are
// placeholders until the founders write them.
// The names are in the title and description because the page is what a
// search for either name, or for the company, should land on.
const DESCRIPTION = 'Flock, an app for making plans with friends, is made by Jayden Bansal (Solo Technical Founder & CEO) and Asad Ali (Growth & Competitions Lead).';

const PEOPLE = [
  { name: 'Jayden Bansal', role: 'Solo Technical Founder & CEO', line: 'An 11th grader in Pennsylvania who started Flock and builds all of it, from the app to the Flux sensor.' },
  { name: 'Asad Ali', role: 'Growth & Competitions Lead', line: 'On Flock since late August 2026.' },
];

// Commitments the product already keeps, each one enforced in code, which is
// why they can be stated here as fact rather than as aspiration.
const HOLDS = [
  { what: 'Your budget stays yours.', how: 'The group sees one rounded-down number. Nobody else sees what you typed.' },
  { what: 'No ads and no feed.', how: 'There is nothing to scroll and nobody to follow.' },
  { what: 'Location stays off until you share it.', how: 'Nothing tracks you in the background, and two-tap SOS reaches the trusted contacts you picked.' },
  { what: 'The sensor sends a number.', how: 'Flux sends how many people are in the room and, on a unit set up for tables, how many are at each table and what state it is in. No images, video or identities leave it.' },
  { what: 'Only what ships.', how: 'If the site describes a feature, the app does it today.' },
];

const MILESTONES = [
  { when: 'September 2026', what: 'Flock Social LLC formed in Pennsylvania.' },
  { when: 'Award', what: '1st place at PA DECA States.' },
  { when: 'October 2026', what: 'Research paper on forecasting crowds and counting people, published on this site.' },
  { when: 'October 2026', what: 'Two-minute pitch video entered in a high school entrepreneurship and AI video competition.' },
  { when: 'October 2026', what: 'iPhone app submitted to the App Store, now in review.' },
];

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
              <p>
                Flock exists because the group chat kept killing perfectly good
                Friday nights.
              </p>
              <p className="ab-coming">
                The full story is coming soon.
              </p>
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
            {/* Two empty perches, one for each founder's photo, until the
                photos arrive: captioned as what it is, so the spot reads as
                waiting rather than broken. */}
            <figure className="ab-perch">
              <img
                className="lp-art ab-perch-art"
                src="/art/about-perch-480.webp"
                srcSet="/art/about-perch-480.webp 480w, /art/about-perch-960.webp 960w"
                sizes="min(560px, 90vw)"
                width="480" height="171"
                loading="lazy" decoding="async"
                alt=""
              />
              <figcaption>Photos of the maintainer and Asad are coming soon.</figcaption>
            </figure>
            <div className="ab-people">
              {PEOPLE.map((p) => (
                <div key={p.name} className="ab-person">
                  <h3>{p.name}</h3>
                  <p className="ab-role">{p.role}</p>
                  {p.line && <p>{p.line}</p>}
                  <p className="ab-coming">A longer bio is coming soon.</p>
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

        <section className="lp-sec lp-sec-paper" aria-labelledby="ab-h-milestones">
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
            <h2 id="ab-h-milestones">Milestones so far</h2>
            <ol className="ab-milestones">
              {MILESTONES.map((m) => (
                <li key={m.what}>
                  <span className="ab-when">{m.when}</span>{' '}
                  <span>{m.what}</span>
                </li>
              ))}
            </ol>
            <p className="ab-coming">Photos and the story behind each one are coming soon.</p>
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
              The web app is live at flockcorp.com, and the iPhone app is in App
              Store review. Venues can make a free account;
              Roost, the paid plan for venues, isn’t charging anyone yet. There’s
              a paid plan for people too, Flock Pro, with more Birdie, more crowd
              forecasts and crowd alerts, and it is not on sale to the public today.
            </p>
            <p>
              Flux has only been tested on research footage so far. A retrained
              crowd model gets scored in early November, and it ships only if it
              beats today’s numbers on days it never saw.
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
