import React, { useEffect } from 'react';
import './PrivacyPolicy.css';
import './ResearchPage.css';
import SiteFooter from './SiteFooter';

// Same reading colour the About page uses for its back link, standfirst and
// footer links (--pp-ink-2, 8.14:1 light, 10.12:1 dark).
const READABLE = { color: 'var(--pp-ink-2)' };

// The paper itself, the full write-up of both studies summarised below, and a
// picture of its first page. They live in public/papers/, not
// public/research/: a folder named like the page makes a static server answer
// /research with the folder instead of the app.
const PAPER_URL = '/papers/flock-research-paper.pdf';
const PAPER_THUMB = '/papers/flock-research-paper-p1.png';
const PAPER_PAGES = 39;

// Why the research exists and what it found, in plain words, then the paper.
// Reached from the landing page's menu only: it is reference reading for the
// people who go looking, so nothing in the scrolling pages or the footer
// points here. Every number below is one the paper reports, on the data it
// names. The crowd figures are the served number and the weekly curve on
// 4,183 held-out live readings (paper Table 3; the same served figures the
// About page quotes from servedAccuracy.json). The counter's figures are
// owl-4.9 and the heat rule on the real test sets (paper Section 13).
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
function Chart({ title, usLabel, themLabel, rows }) {
  return (
    <figure className="rs-chart">
      <h3>{title}</h3>
      <p className="rs-chart-key">
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
    </figure>
  );
}

export default function ResearchPage() {
  useEffect(() => {
    document.title = 'Research: forecasting and counting crowds | Flock';
    const meta = document.querySelector('meta[name="description"]');
    if (meta) meta.setAttribute('content', DESCRIPTION);
  }, []);

  return (
    <main className="pp">
      <a className="pp-skip" href="#pp-content">Skip to the main content</a>
      <a href="/" className="pp-back" style={READABLE}>
        <span aria-hidden="true">&larr;</span> flockcorp.com
      </a>

      <header className="pp-header" id="pp-content" tabIndex={-1}>
        <h1>Research</h1>
        <p className="pp-meta" style={READABLE}>Why we study crowds, and what we found.</p>
      </header>

      <div className="rs-paper">
        <a className="rs-paper-thumb" href={PAPER_URL} target="_blank" rel="noopener noreferrer" aria-hidden="true" tabIndex={-1}>
          <img src={PAPER_THUMB} width="520" height="673" alt="" />
        </a>
        <div>
          <p className="rs-paper-kicker">Paper &middot; October 2026</p>
          <p className="rs-paper-title">Flock: Forecasting How Busy a Venue Will Be, and Counting Who Is There</p>
          <p className="rs-paper-by">Jayden Bansal &middot; Flock Social LLC &middot; {PAPER_PAGES} pages</p>
          <a className="rs-paper-link" href={PAPER_URL} target="_blank" rel="noopener noreferrer">Read the paper (PDF)</a>
        </div>
      </div>

      <section className="rs-section">
        <h2>Why we did this research</h2>
        <p>
          Flock's venue card answers one question for a group deciding where to
          go: how busy will this place be when we get there? Map apps answer it
          with a popular-times chart, each venue's typical level for that
          weekday and hour. That chart cannot know tonight is different: the
          rain, the game two blocks away, the night a place suddenly fills up.
        </p>
        <p>
          So we asked two questions. Can a system that watches a venue over time
          beat that venue's own chart, one hour on one night? And can a small
          sensor count the people in a room by itself, with only the count ever
          leaving it, so that a busyness score can be checked against real
          people?
        </p>
      </section>

      <section className="rs-section">
        <h2>What we found</h2>
        <ul className="rs-findings">
          <li>
            <span className="rs-big">78.8%</span>
            <div>
              <p>of Flock's crowd numbers landed within one of five crowd levels of the live reading.</p>
              <p className="rs-src">4,183 live readings the model had not seen, September 6 to 8, 2026.</p>
            </div>
          </li>
          <li>
            <span className="rs-big">56.0%</span>
            <div>
              <p>named the exact crowd level, against 31.5% for the popular-times chart. The average miss was 17 points, a third smaller than the chart's.</p>
            </div>
          </li>
          <li>
            <span className="rs-big">2&times;</span>
            <div>
              <p>is how far popular-times charts swing, compared with the live readings they are trying to predict.</p>
            </div>
          </li>
          <li>
            <span className="rs-big">3 hours</span>
            <div>
              <p>is about how long a venue's departure from its usual pattern lasts. The newest reading counts for a lot, and an old one barely at all.</p>
            </div>
          </li>
          <li>
            <span className="rs-big">82&ndash;96%</span>
            <div>
              <p>of frames counted exactly by Owl, the people counter inside Flux, Flock's venue sensor, on five real test sets. The heat rule it replaced managed 9 to 77%.</p>
              <p className="rs-src">14 to 16 milliseconds a frame on a Raspberry Pi 5, and only the count leaves the device.</p>
            </div>
          </li>
          <li>
            <span className="rs-big">0%</span>
            <div>
              <p>of real frames counted exactly when Owl learned only from generated scenes. Mixing in licensed real thermal footage fixed that, and a wider network did not help.</p>
            </div>
          </li>
        </ul>

        <Chart
          title="Flock against the popular-times chart"
          usLabel="Flock"
          themLabel="Chart"
          rows={FORECAST}
        />
        <p className="rs-note">Share of the same 4,183 held-out live readings. Higher is better.</p>

        <Chart
          title="Owl against the heat rule it replaced"
          usLabel="Owl"
          themLabel="Rule"
          rows={COUNTER}
        />
        <p className="rs-note">
          Frames counted exactly, on real test sets no model trained on. On the
          hardest set, crowded classrooms filmed with Flux's camera, Owl is
          exact on 39.3% of frames and within one person on 73.9%.
        </p>
      </section>

      <section className="rs-section">
        <h2>Where it falls short</h2>
        <p>
          Flock's crowd numbers are scores from 0 to 100 for each venue, not
          headcounts, and the live test covers three days. The counter has been
          tested on research footage, not yet inside a working venue.
        </p>
      </section>

      <section className="rs-section">
        <h2>What's next</h2>
        <p>
          A retrain of the crowd model is scored in October against a test
          written down before its data existed, and it ships only if it beats
          today's numbers on days it never saw. After that, the plan is to put a
          Flux sensor in a venue Flock already reads and compare its counts with
          the forecast hour by hour.
        </p>
        <p>
          The full paper covers both studies in detail, including what did not
          work.{' '}
          <a href={PAPER_URL} target="_blank" rel="noopener noreferrer">Read the research paper (PDF, {PAPER_PAGES} pages)</a>
        </p>
      </section>

      <SiteFooter className="pp-footer" linkStyle={READABLE}>
        <p>
          Flock &middot; <a href="/" style={READABLE}>flockcorp.com</a>
        </p>
      </SiteFooter>
    </main>
  );
}
