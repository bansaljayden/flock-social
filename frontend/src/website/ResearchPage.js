import React, { useEffect } from 'react';
import './LandingPage.css';
import './ResearchPage.css';
import SiteFooter from './SiteFooter';
import SiteNav, { useSiteMenu } from './SiteNav';
import { THERMAL_SETS, ROBOFLOW_SETS, COUNT_SOURCES, SOFTWARE } from './researchThanks';

// Two documents, read in order: a three-page summary first (the questions,
// the findings, the equations and every model input), and the full paper for
// a reader who wants every table and figure. The summary is the primary
// button and the thumbnail; its first page links to the paper. A mid-length
// cut of the paper was dropped: it repeated the full paper's abstract and
// findings without being short. They live in public/papers/, not
// public/research/: a folder named like the page makes a static server answer
// /research with the folder instead of the app. The paper keeps the URL the
// single paper always had, and the full paper's old URL redirects to it
// (vercel.json, cloudflare/_redirects), so old links still land.
const SUMMARY_URL = '/papers/flock-research-summary.pdf';
const SUMMARY_THUMB = '/papers/flock-research-summary-p1.png';
const SUMMARY_PAGES = 3;
const PAPER_URL = '/papers/flock-research-paper.pdf';
const PAPER_PAGES = 30;

// Why the research exists and what it found, in plain words, then the paper.
// Built on the landing page's own stylesheet (.lp: Fraunces display, Hanken
// body, navy chapters on cream stock) so it reads as the same site. Reached
// from the landing page's menu only: it is reference reading for the people
// who go looking, so nothing in the scrolling pages or the footer points here.
//
// Every number below is one the paper reports, on the data it names. The crowd
// figures are the served number and the stored weekly curve on all 119,939
// model-served live readings of 2026-09-09..10-08, the month after the serving
// weights were set (MODEL-METRICS.md, the month section). The
// counter's figures are owl-4.9 and the heat rule as deployed on the six real
// benchmark sets, which also guided Owl's development (paper Table 6).
const DESCRIPTION = 'Why Flock studies how busy places get, what the research found, and the full paper.';

// Share of readings or frames, in percent. `us` is Flock's number, `them` the
// thing it is measured against on the same data.
const FORECAST = [
  { label: 'Within one crowd level', us: 78.4, them: 64.8 },
  { label: 'Exact crowd level', us: 54.9, them: 30.2 },
  { label: 'Within 10 points', us: 55.2, them: 30.9 },
];
const COUNTER = [
  { label: "Flux's camera model", note: 'SDT (TU Wien), indoor rooms, 2,000 frames', us: 89.7, them: 77.1 },
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
              <a className="rs-thumb" href={SUMMARY_URL} target="_blank" rel="noopener noreferrer" aria-hidden="true" tabIndex={-1}>
                {/* The slot paints 96 to 150 CSS px, so a 520px PNG would be
                    3.5x its width at 1x. WebP candidates at 300w and 520w;
                    `sizes` mirrors .rs-thumb img in ResearchPage.css. The PNG
                    stays as the fallback for browsers without WebP. */}
                <picture>
                  <source
                    type="image/webp"
                    srcSet="/papers/flock-research-summary-p1-300.webp 300w, /papers/flock-research-summary-p1-520.webp 520w"
                    sizes="(max-width: 420px) 112px, (max-width: 600px) 96px, 150px"
                  />
                  <img src={SUMMARY_THUMB} width="520" height="673" alt="" />
                </picture>
              </a>
              <div>
                <p className="rs-paper-kicker">Research summary &middot; October 2026 &middot; {SUMMARY_PAGES} pages</p>
                <p className="rs-paper-title">Forecasting How Busy a Venue Will Be, and Counting How Many People Are There</p>
                <p className="rs-paper-by">Jayden Bansal, Flock Social LLC</p>
                <div className="rs-paper-actions">
                  <a className="lp-btn lp-btn-cream" href={SUMMARY_URL} target="_blank" rel="noopener noreferrer">Read the summary (PDF)</a>
                  <a className="lp-btn lp-btn-ghost" href={PAPER_URL} target="_blank" rel="noopener noreferrer">Full paper (PDF, {PAPER_PAGES} pages)</a>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="lp-sec lp-sec-paper">
          <div className="lp-wrap rs-why">
            <div className="rs-measure">
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
              So we asked two questions. Can AI tell how crowded a venue will
              be before you go? And can a credit-card-sized computer model be
              designed to count the number of people inside a venue using a
              thermal camera without identifying individuals?
            </p>
            </div>
            <img
              className="lp-art rs-why-art"
              src="/art/sensor-320.webp"
              srcSet="/art/sensor-320.webp 320w, /art/sensor-640.webp 640w"
              sizes="(min-width: 900px) 280px, min(240px, 70vw)"
              width="320" height="337"
              loading="lazy" decoding="async"
              alt=""
            />
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
              note="Share of the same 119,939 live readings, one hour ahead, every one the forecast was served for at 1,754 venues in Philadelphia, the Lehigh Valley and Miami from 9 September to 8 October 2026. None of them was used to set the forecast. Higher is better."
            />
            <Chart
              title="Owl against the heat rule it replaced"
              usLabel="Owl"
              themLabel="Rule"
              rows={COUNTER}
              note="Frames counted exactly, on six benchmark sets that no model trained on. The sealed tests, including the sets where the rule did better, are in the paper."
            />
          </div>
        </section>

        <section className="lp-sec lp-sec-paper">
          <div className="lp-wrap rs-two">
            <div>
              <h2>What it covers so far</h2>
              <p>
                Flock's crowd numbers are scores from 0 to 100 for each venue, not
                headcounts, and the live test covers one month. Its findings were
                tested on 6.5 million public hourly counts from 31 sources in
                15 countries, including people counted inside rooms and
                libraries. The counter has
                been tested on six research datasets and in fifteen sealed tests on
                public footage, including a café and a restaurant, and not yet
                inside a working venue.
              </p>
            </div>
            <div>
              <h2>What's next</h2>
              <p>
                A retrain of the crowd model is scored in early November against
                thresholds and held-out days written down before their data existed,
                and it ships only if it beats today's numbers on days it never saw. After that, the plan is to put
                a Flux sensor in a venue Flock already reads and compare its counts
                with the forecast hour by hour.
              </p>
            </div>
          </div>
        </section>

        {/* The credits. Generated from the research database (researchThanks.js
            says which rows and why), so a set the paper never scored is never
            thanked as if it had been, and every count source carries the
            attribution line its licence asks for, word for word. */}
        <section className="lp-sec lp-sec-sand rs-thanks" aria-labelledby="rs-h-thanks">
          <div className="lp-wrap">
            <img
              className="lp-art rs-thanks-art"
              src="/art/spot-wren-step-240.webp"
              srcSet="/art/spot-wren-step-240.webp 240w, /art/spot-wren-step-480.webp 480w"
              sizes="150px"
              width="240" height="248"
              loading="lazy" decoding="async"
              alt=""
            />
            <h2 id="rs-h-thanks">Thank you</h2>
            <p className="rs-thanks-lead">
              Both studies were tested on data that other people collected and
              chose to share. These are the labs, cities and libraries behind
              it, each with the credit its licence asks for.
            </p>
            <div className="rs-thanks-cols">
              <div>
                <h3>Thermal images, for Owl</h3>
                <ul className="rs-thanks-list">
                  {THERMAL_SETS.map((s) => (
                    <li key={s.name}>
                      <b>{s.name}</b>, {s.who} <span className="rs-terms">({s.terms})</span>
                    </li>
                  ))}
                </ul>
                <h3>From Roboflow Universe</h3>
                <ul className="rs-thanks-list">
                  {ROBOFLOW_SETS.map((s) => (
                    <li key={s.name}><b>{s.name}</b>, {s.who}</li>
                  ))}
                </ul>
                <h3>Software</h3>
                <ul className="rs-thanks-list">
                  {SOFTWARE.map((s) => (
                    <li key={s.name}><b>{s.name}</b>, {s.who}</li>
                  ))}
                </ul>
              </div>
              <div>
                <h3>Public counts, for the forecast</h3>
                <ul className="rs-thanks-list">
                  {COUNT_SOURCES.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        </section>

        <section className="lp-sec lp-sec-navy lp-on-navy rs-end">
          <div className="lp-wrap">
            <h2>Read the whole thing.</h2>
            <p className="lp-lead">
              Start with the {SUMMARY_PAGES}-page summary. The full paper covers both
              studies in detail, including what did not work.
            </p>
            <div className="rs-paper-actions">
              <a className="lp-btn lp-btn-cream" href={SUMMARY_URL} target="_blank" rel="noopener noreferrer">
                Read the summary (PDF, {SUMMARY_PAGES} pages)
              </a>
              <a className="lp-btn lp-btn-ghost" href={PAPER_URL} target="_blank" rel="noopener noreferrer">
                Full paper (PDF, {PAPER_PAGES} pages)
              </a>
            </div>
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
