import React, { useEffect } from 'react';
import './PrivacyPolicy.css';

const CONTACT_EMAIL = 'social@flockcorp.com';

// The public why-does-this-exist page: what users get, why venues pay, and
// what the forecast model actually is. Every claim on this page is real and
// verifiable in the product (SLOP-AUDIT.md C1: never advertise what doesn't
// ship). The numbers quoted for the model come from the committed
// model_metadata.json holdout evaluation. The rehearsal pitch with sourced
// market stats lives OUTSIDE this public repo, on purpose.
export default function AboutPage() {
  useEffect(() => {
    document.title = 'About · Flock';
  }, []);

  return (
    <main className="pp">
      <a href="/" className="pp-back">&larr; flockcorp.com</a>

      <header className="pp-header">
        <h1>What Flock is</h1>
        <p className="pp-meta">And why it works as a business.</p>
      </header>

      <section>
        <h2>The problem</h2>
        <p>
          Group plans rarely die because people don't want to go. They die because
          deciding is annoying. Six people say yes, nobody picks a place, one person
          gets stuck carrying the whole thing, and the plan quietly expires in the
          chat. Groups don't choose by picking someone's favorite; they choose by
          finding the option nobody vetoes. A group chat has no mechanism for that.
          Flock is that mechanism.
        </p>
      </section>

      <section>
        <h2>What users get (free)</h2>
        <p>
          Start a flock, invite your people, and vote on where to go. Enter what you
          can spend privately: the group only ever sees a ceiling everyone can
          afford, never anyone's number, so money stops being the silent veto. Check
          how busy a place is before you leave. Split the bill and send Venmo, Cash
          App, or Zelle links. Share live location with your group while the night
          is on, with one-tap SOS to trusted contacts. Planning a night out with
          friends costs nothing, and the app has no ads and no feed.
        </p>
      </section>

      <section>
        <h2>Our crowd model</h2>
        <p>
          Flock runs its own machine-learning crowd model, not a wrapper around
          someone else's chart. It predicts how busy a venue will be, hour by hour,
          from 106 signals: time patterns, weather, nearby events, venue category,
          and how that specific spot actually behaves. It was trained on 2.1 million
          venue-hour observations across 31 cities and held out another 419,000 it
          never saw. Where it earns its place is live conditions: on 68,000 realtime
          observations it cuts the average error by 2.3 points against the
          popular-times baseline it started from.
          When a venue is too new or too small for the model to know it yet, a
          rule-based engine answers instead of guessing wildly.
        </p>
        <p>
          Busyness charts you've seen elsewhere measure who already showed up.
          Flock's votes measure something that exists nowhere else: which venues
          groups are <em>considering</em> right now, before they've gone anywhere.
        </p>
      </section>

      <section>
        <h2>Why venues pay (and users never do)</h2>
        <p>
          Every vote inside a flock is a group actively deciding where to go
          tonight. For a bar or restaurant, that is the moment every ad channel
          misses: review sites show what people thought after the fact, social ads
          broadcast to people who aren't going out, and busyness charts are
          read-only. Flock can tell a venue how many groups considered it this week,
          when demand for it peaks, and let it put a deal in front of nearby groups
          mid-decision, which matters most on the slow nights when a couple of extra
          tables changes the week.
        </p>
        <p>
          That's the business: the planning side stays free for you and your
          friends, and venues pay for demand they can see and act on. Venue tools
          are in development; if you run a venue and want in early, email{' '}
          <a href={`mailto:${CONTACT_EMAIL}?subject=Flock%20for%20venues`}>{CONTACT_EMAIL}</a>.
        </p>
      </section>

      <section>
        <h2>Who's behind it</h2>
        <p>
          Flock is built by Jayden Bansal, a student founder in Bethlehem, PA. It
          took 1st place at PA DECA States. It exists because the group chat kept
          killing perfectly good Friday nights.
        </p>
      </section>

      <footer className="pp-footer">
        <p>
          Flock &middot; <a href="/">flockcorp.com</a> &middot;{' '}
          <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
        </p>
      </footer>
    </main>
  );
}
