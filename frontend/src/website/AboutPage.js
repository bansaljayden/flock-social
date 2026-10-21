import React, { useEffect } from 'react';
import './LandingPage.css';
import './AboutPage.css';
import SiteFooter from './SiteFooter';
import SiteNav, { useSiteMenu } from './SiteNav';

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
//   Jayden Bansal, founder, an 11th grader in Pennsylvania                the pitch video's own description
//   Asad Ali, COO                                                         the pitch video's own description
//   1st place at PA DECA States                                           the landing page, since August
//   research paper, October 2026; Stevens pitch entry, October 2026        /research; the video, 18 Oct 2026
//   iPhone app in App Store review; no venue charged; Flock Pro not on public sale
// The photos, the bios, the full story and the milestone details are
// placeholders until the founders write them.
const DESCRIPTION = 'Who makes Flock, what it holds to, where it stands, and how to reach the people behind it.';

const PEOPLE = [
  { name: 'Jayden Bansal', role: 'Founder', line: 'An 11th grader in Pennsylvania, and the person who started Flock.' },
  { name: 'Asad Ali', role: 'COO', line: 'The voice of the two-minute pitch video.' },
];

// Commitments the product already keeps, each one enforced in code, which is
// why they can be stated here as fact rather than as aspiration.
const HOLDS = [
  { what: 'Your budget stays yours.', how: 'The group sees one rounded-down figure, and nobody else ever sees what you typed.' },
  { what: 'No ads and no feed.', how: 'There is nothing to scroll and nobody to follow.' },
  { what: 'Safety without tracking.', how: 'Live location is off until you share it, and two-tap SOS reaches the trusted contacts you picked.' },
  { what: 'The sensor sends a number.', how: 'Flux sends how many people are in the room, and that number is all that leaves it.' },
  { what: 'Only what ships.', how: 'If the site describes a feature, the app does it today.' },
];

const MILESTONES = [
  { when: 'September 2026', what: 'Flock Social LLC formed in Pennsylvania.' },
  { when: 'Recognition', what: '1st place at PA DECA States.' },
  { when: 'October 2026', what: 'Research paper on forecasting crowds and counting people, published on this site.' },
  { when: 'October 2026', what: 'Pitch video entered in the Stevens High School Entrepreneurship and AI Video Pitch.' },
  { when: 'October 2026', what: 'iPhone app submitted to the App Store, now in review.' },
];

export default function AboutPage() {
  const menu = useSiteMenu();
  const pageInert = menu.menuOpen ? { inert: true } : {};

  useEffect(() => {
    document.title = 'About Flock | Flock';
    const meta = document.querySelector('meta[name="description"]');
    if (meta) meta.setAttribute('content', DESCRIPTION);
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
              Flock is an app for making plans with friends. It is made by the maintainer
              Bansal and Asad Ali, and run as Flock Social LLC, a Pennsylvania
              company.
            </p>
          </div>
        </section>

        <section className="lp-sec lp-sec-paper" aria-labelledby="ab-h-story">
          <div className="lp-wrap ab-story">
            <h2 id="ab-h-story">How it started</h2>
            <p>
              Flock exists because the group chat kept killing perfectly good
              Friday nights.
            </p>
            <p className="ab-coming">
              The full story, from the first version to now, is being written and
              will be here soon.
            </p>
          </div>
        </section>

        <section className="lp-sec lp-sec-sand" aria-labelledby="ab-h-people">
          <div className="lp-wrap">
            <h2 id="ab-h-people">Who makes it</h2>
            <div className="ab-people">
              {PEOPLE.map((p) => (
                <div key={p.name} className="ab-person">
                  {/* Placeholder until the founders send their photos: the
                      same birds as the rest of the site, captioned as what it
                      is, so the spot reads as waiting rather than broken. */}
                  <figure className="ab-photo">
                    <img src="/birdie/warm-bird-400.webp" width="332" height="333" alt="" loading="lazy" decoding="async" />
                    <figcaption>Photo coming soon</figcaption>
                  </figure>
                  <h3>{p.name}</h3>
                  <p className="ab-role">{p.role}</p>
                  <p>{p.line}</p>
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
            <h2 id="ab-h-now">Where things stand</h2>
            <p>
              The web app is live at flockcorp.com, and the iPhone app is in App
              Store review. Venues can make a free account, and
              Roost, the paid plan for venues, is not charging anyone yet. There is
              a paid plan for people as well, Flock Pro, with more Birdie, more
              crowd forecasts and crowd alerts, and it is not on sale to the public
              today.
            </p>
            <p>
              The Flux sensor has been tested on research footage and not yet in a
              venue. A retrain of the crowd model is scored in early November, and
              it ships only if it beats today’s numbers on days it never saw.
            </p>
          </div>
        </section>

        <section className="lp-cta lp-on-navy" aria-labelledby="ab-h-contact">
          <div className="lp-wrap lp-cta-in">
            <div>
              <h2 id="ab-h-contact">Get in touch</h2>
              <p className="lp-lead ab-contact-lead">
                Write to <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>,
                including if you run a venue and want in early. The pitch and
                anything new go up on{' '}
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
