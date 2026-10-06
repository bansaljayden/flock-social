import React, { useEffect } from 'react';
import './LandingPage.css';
import './ResearchPage.css';
import SiteFooter from './SiteFooter';
import SiteNav, { useSiteMenu } from './SiteNav';

// The paper itself, the full write-up of both studies summarised below, and a
// picture of its first page. They live in public/papers/, not
// public/research/: a folder named like the page makes a static server answer
// /research with the folder instead of the app.
const PAPER_URL = '/papers/flock-research-paper.pdf';
const PAPER_THUMB = '/papers/flock-research-paper-p1.png';
const PAPER_PAGES = 39;

// Why the research exists and what it found, in plain words, then the paper.
// Built on the landing page's own stylesheet (.lp: Fraunces display, Hanken
// body, navy chapters on cream stock) so it reads as the same site. Reached
// from the landing page's menu only: it is reference reading for the people
// who go looking, so nothing in the scrolling pages or the footer points here.
//
// Every number below is one the paper reports, on the data it names. The crowd
// figures are the served number and the weekly curve on 4,183 held-out live
// readings (paper Table 3; the same served figures the About page quotes from
// servedAccuracy.json). The counter's figures are owl-4.9 and the heat rule on
// the real test sets (paper Section 13).
const DESCRIPTION = 'Why Flock studies how busy places get, what the research found, and the full paper.';

// Share of readings or frames, in percent. `us` is Flock's number, `them` the
// thing it is measured against on the same data.
const FORECAST = [
  { label: 'Within one crowd level', us: 78.8, them: 65.9 },
  { label: 'Exact crowd level', us: 56.0, them: 31.5 },
  { label: 'Within 10 points', us: 53.8, them: 32.3 },
];
const COUNTER = [
  { label: "Flux's own camera", note: 'Indoor rooms, 2,000 frames', us: 89.7, them: 77.1 },
  { label: 'Ceiling camera', note: '2,347 frames', us: 92.9, them: 9.2 },
  { label: 'Rooms with hot laptops', note: '265 frames', us: 95.5, them: 71.3 },
  { label: 'Wall-mounted meeting rooms', note: '813 frames', us: 93.0, them: 51.5 },
  { label: 'Side view', note: '2,151 frames', us: 82.1, them: 36.6 },
];

const pct = (v) => `${v.toFixed(1)}%`;

// Bars are drawn to 80% of the row so the value printed after them always
// fits. The value is the information; the bar is decoration.
function Chart({ title, usLabel, themLabel, rows, note }) {
  return (
    <figure className="rs-chart">
      <h3>{title}</h3>
      <p className="rs-key">
        <span><i className="rs-sw us" aria-hidden="true" />{usLabel}</span>
        <span><i className="rs-sw them" aria-hidden="true" />{themLabel}</span>
      </p>
      <div className="rs-rows">
        {rows.map((r) => (
          <div className="rs-row" key={r.label}>
            <div className="rs-row-label">
              {r.label}
              {r.note ? <small>{r.note}</small> : null}
            </div>
            <div className="rs-bars">
              <div className="rs-bar us">
                <span className="rs-fill us" style={{ width: `${r.us * 0.8}%` }} aria-hidden="true" />
                <span className="rs-val">{usLabel} {pct(r.us)}</span>
              </div>
              <div className="rs-bar them">
                <span className="rs-fill them" style={{ width: `${r.them * 0.8}%` }} aria-hidden="true" />
                <span className="rs-val">{themLabel} {pct(r.them)}</span>
              </div>
            </div>
          </div>
        ))}
      </div>
      <figcaption className="rs-note">{note}</figcaption>
    </figure>
  );
}

export default function ResearchPage() {
  const menu = useSiteMenu();
  // Everything behind the open menu goes inert, as on the landing page.
  const pageInert = menu.menuOpen ? { inert: true } : {};

  useEffect(() => {
    document.title = 'Research: forecasting and counting crowds | Flock';
    const meta = document.querySelector('meta[name="description"]');
    if (meta) meta.setAttribute('content', DESCRIPTION);
  }, []);

  return (
    <div className="lp rs">
      <a className="lp-skip" href="#rs-main">Skip to the main content</a>

      <SiteNav menu={menu} current="/research" />

      <main id="rs-main" tabIndex={-1} {...pageInert}>
        <section className="lp-sec-navy lp-on-navy rs-hero">
          <div className="lp-wrap">
            <h1>Why we study crowds, and what we found.</h1>
            {/* The first study is the forecast the chart below scores: a
                venue's weekly pattern moved by its live readings, which only
                a venue with a pattern gets. A venue with none is scored by
                the rule engine (crowdEngine.js), which the chart does not
                measure as Flock's number, so the lead does not put the
                forecast behind every card. */}
            <p className="lp-lead rs-hero-lead">
              The first study is the forecast of how busy a place will be,
              behind the number on a venue card wherever Flock knows that
              venue's weekly pattern. A venue without one gets an estimate from
              what is typical for its kind. The second study, a sensor that
              counts the people actually there, has so far been tested on
              research footage.
            </p>

            <div className="rs-paper">
              <a className="rs-thumb" href={PAPER_URL} target="_blank" rel="noopener noreferrer" aria-hidden="true" tabIndex={-1}>
                {/* The slot paints 96 to 150 CSS px, so the 520px PNG (89 KB)
                    was 3.5x its width at 1x. WebP candidates at 300w (16 KB)
                    and 520w; `sizes` mirrors .rs-thumb img in ResearchPage.css.
                    The PNG stays as the fallback for browsers without WebP. */}
                <picture>
                  <source
                    type="image/webp"
                    srcSet="/papers/flock-research-paper-p1-300.webp 300w, /papers/flock-research-paper-p1-520.webp 520w"
                    sizes="(max-width: 420px) 112px, (max-width: 600px) 96px, 150px"
                  />
                  <img src={PAPER_THUMB} width="520" height="673" alt="" />
                </picture>
              </a>
              <div>
                <p className="rs-paper-kicker">Paper &middot; October 2026 &middot; {PAPER_PAGES} pages</p>
                <p className="rs-paper-title">Flock: Forecasting How Busy a Venue Will Be, and Counting Who Is There</p>
                <p className="rs-paper-by">Jayden Bansal, Flock Social LLC</p>
                <a className="lp-btn lp-btn-cream" href={PAPER_URL} target="_blank" rel="noopener noreferrer">Read the paper (PDF)</a>
              </div>
            </div>
          </div>
        </section>

        <section className="lp-sec lp-sec-paper">
          <div className="lp-wrap rs-measure">
            <h2>Why we did this research</h2>
            <p>
              Flock's venue card answers one question for a group deciding where
              to go: how busy will this place be when we get there? Map apps
              answer it with a popular-times chart, each venue's typical level for
              that weekday and hour. That chart cannot know tonight is different:
              the rain, the game two blocks away, the night a place suddenly fills
              up.
            </p>
            <p>
              So we asked two questions. Can a system that watches a venue over
              time beat that venue's own chart, one hour on one night? And can a
              small sensor count the people in a room by itself, with only the
              count ever leaving it, so that a busyness score can be checked
              against real people?
            </p>
          </div>
        </section>

        <section className="lp-sec lp-sec-sand">
          <div className="lp-wrap rs-charts">
            <h2>The numbers side by side</h2>
            <Chart
              title="Flock against the popular-times chart"
              usLabel="Flock"
              themLabel="Chart"
              rows={FORECAST}
              note="Share of the same 4,183 held-out live readings, at venues in the Lehigh Valley and Miami. Higher is better."
            />
            <Chart
              title="Owl against the heat rule it replaced"
              usLabel="Owl"
              themLabel="Rule"
              rows={COUNTER}
              note="Frames counted exactly, on real test sets no model trained on. On the hardest set, crowded classrooms filmed with Flux's camera, Owl is exact on 39.3% of frames and within one person on 73.9%."
            />
          </div>
        </section>

        <section className="lp-sec lp-sec-paper">
          <div className="lp-wrap rs-two">
            <div>
              <h2>Where it falls short</h2>
              <p>
                Flock's crowd numbers are scores from 0 to 100 for each venue, not
                headcounts, and the live test covers three days. The counter has
                been tested on research footage, not yet inside a working venue.
              </p>
            </div>
            <div>
              <h2>What's next</h2>
              <p>
                A retrain of the crowd model is scored in October against a test
                written down before its data existed, and it ships only if it beats
                today's numbers on days it never saw. After that, the plan is to put
                a Flux sensor in a venue Flock already reads and compare its counts
                with the forecast hour by hour.
              </p>
            </div>
          </div>
        </section>

        <section className="lp-sec lp-sec-navy lp-on-navy rs-end">
          <div className="lp-wrap">
            <h2>Read the whole thing.</h2>
            <p className="lp-lead">
              The paper covers both studies in detail, including what did not work.
            </p>
            <a className="lp-btn lp-btn-cream" href={PAPER_URL} target="_blank" rel="noopener noreferrer">
              Read the paper (PDF, {PAPER_PAGES} pages)
            </a>
          </div>
        </section>
      </main>

      <div {...pageInert}>
        <SiteFooter className="rs-footer" linkStyle={{ color: 'var(--cream-2)' }}>
          <p>
            Flock &middot; <a href="/" style={{ color: 'var(--cream-2)' }}>flockcorp.com</a>
          </p>
        </SiteFooter>
      </div>
    </div>
  );
}
