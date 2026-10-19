import React, { useEffect } from 'react';
import './LandingPage.css';
import './ResearchPage.css';
import SiteFooter from './SiteFooter';
import SiteNav, { useSiteMenu } from './SiteNav';

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
              note="Share of the same 119,939 live readings, one hour ahead, every one the forecast was served for at 1,754 venues in Philadelphia, the Lehigh Valley and Miami from 9 September to 8 October 2026. None of them was used to set the forecast. Higher is better."
            />
            <Chart
              title="Owl against the heat rule it replaced"
              usLabel="Owl"
              themLabel="Rule"
              rows={COUNTER}
              note="Frames counted exactly, on six real benchmark sets no model trained on. On a sealed held-out set of 300 frames, Owl counted 94.3% exactly and the rule 40.7%. On sealed lab-room frames of three or more people (BU-TIV), Owl was exact on 34.6% and the rule on 3.6%; on unseen frames from 15 more public sets Owl led 40.4% to 33.0% (12 sets, 2,976 frames) and 69.7% to 52.2% (three sets, 1,132 frames); beside two hot robot arms on a factory floor (WLRI-HRC) it led 22.7% to 3.0%; and on an outdoor harbour front (LTD) it led 16.7% to 3.8%. On low-resolution sensor arrays, on pooled frames of three or more people, in an atrium of lone, distant people and in a room of people walking past a head-height camera (LITIV), the rule did better, and dense or distant crowds, in an industrial hall, a café and a harbour, defeat both. On the hardest benchmark set, crowded classrooms filmed with Flux's camera model (Thermal Vision, IISER Bhopal), Owl is exact on 39.3% of frames and within one person on 73.9%. Test sets: SDT, Computer Vision Lab, TU Wien (Pramerdorfer, Strohmayer and Kampel, ICIP 2020); Thermal Vision, IISER Bhopal (Samal and Lone, Smart Health 2025); PUT Thermo Presence; SenSys 2021; AAU VAP Trimodal; OpenThermalPose2; sealed sets from BU-TIV (Wu, Fuller, Theriault and Betke, CVPRW 2014), UPPET (Cormier, Specker and Beyerer, CVPRW 2025), WLRI-HRC (Süme, Ponomarjova, Wendt and Rupitsch, JSSS 2025), LTD (Nikolov et al., NeurIPS Datasets and Benchmarks 2021) and LITIV (Bilodeau, Torabi, St-Charles and Riahi, Infrared Physics & Technology 2014). Used with their authors' permission or under their licences."
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
                tested on 6.4 million public hourly counts from 29 sources in
                15 countries, including people counted inside rooms and
                libraries. The counter has
                been tested on six research datasets and in twelve sealed tests on
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
