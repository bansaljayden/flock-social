import React, { useEffect } from 'react';
import './PrivacyPolicy.css';
import SiteFooter from './SiteFooter';

// Same reading colour the About page uses for its back link, standfirst and
// footer links (--pp-ink-2, 8.14:1 light, 10.12:1 dark).
const READABLE = { color: 'var(--pp-ink-2)' };

// The paper itself. It lives in public/research/ and is the published copy of
// the full write-up of both studies summarised below.
const PAPER_URL = '/research/flock-research-paper.pdf';

// Why the research exists and what it found, in plain words, then the paper.
// Reached from the landing page's menu only: it is reference reading for the
// people who go looking, so nothing in the scrolling pages or the footer
// points here. Every number below is one the paper reports, on the data it
// names: the crowd figures are the served number on 4,183 held-out live
// readings (the same figures the About page quotes from servedAccuracy.json),
// and the counter's figures are owl-4.9 on five real test sets.
const DESCRIPTION = 'Why Flock studies how busy places get, what the research found, and the full paper.';

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
        <p className="pp-meta" style={READABLE}>
          Why we study crowds, and what we found.{' '}
          <a href={PAPER_URL} target="_blank" rel="noopener noreferrer" style={READABLE}>Read the paper (PDF)</a>
        </p>
      </header>

      <section>
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

      <section>
        <h2>What we found</h2>
        <p>
          <strong>Watching a venue beats its chart.</strong> Tested against
          4,183 live readings it had not seen, from September 6 to 8, 2026, the
          number Flock shows landed within one of five crowd levels 78.8% of the
          time and named the exact level 56.0% of the time. Its average miss was
          17 points, a third smaller than the popular-times chart's.
        </p>
        <p>
          <strong>Popular-times charts overreact.</strong> Read as forecasts,
          they swing about twice as far as the live readings they are trying to
          predict.
        </p>
        <p>
          <strong>A fresh reading is worth the most.</strong> A venue's
          departure from its usual pattern fades within about three hours, so
          the newest reading counts for a lot and an old one barely at all.
        </p>
        <p>
          <strong>A thermal sensor can count a room on its own.</strong> Owl,
          the people counter inside Flux, Flock's venue sensor, counts 82 to 96%
          of frames exactly on five real test sets, where the simple heat rule
          it replaced managed 9 to 77%. It takes 14 to 16 milliseconds a frame
          on a Raspberry Pi 5, and only the count leaves the device.
        </p>
        <p>
          <strong>Real footage mattered more than a bigger model.</strong>
          Trained only on generated scenes, the counter got 0% of real frames
          exactly right. Mixing in licensed real thermal footage fixed that,
          and making the network wider did not help.
        </p>
        <p>
          Where it still falls short: Flock's crowd numbers are scores from 0 to
          100 for each venue, not headcounts, and the counter has been tested on
          research footage, not yet inside a working venue.
        </p>
      </section>

      <section>
        <h2>What's next</h2>
        <p>
          A retrain of the crowd model is scored in October against a test
          written down before its data existed, and it ships only if it beats
          today's numbers on days it never saw. After that, the plan is to put a
          Flux sensor in a venue Flock already reads and compare its counts with
          the forecast hour by hour.
        </p>
      </section>

      <section>
        <h2>The paper</h2>
        <p>
          The full paper covers both studies in detail, including what did not
          work.{' '}
          <a href={PAPER_URL} target="_blank" rel="noopener noreferrer">Read the research paper (PDF, 40 pages)</a>
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
