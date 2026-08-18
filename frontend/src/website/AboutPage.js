import React, { useEffect } from 'react';
import './PrivacyPolicy.css';
import SiteFooter from './SiteFooter';

const CONTACT_EMAIL = 'social@flockcorp.com';

// HISTORY, so the next reader is not misled: this override was added when
// --pp-ink-3 was #6b7a8c, a WCAG 1.4.3 failure at 3.75:1 on the cream paper.
// That token has since been fixed in PrivacyPolicy.css (#586473, 5.14:1 on
// paper, 4.70:1 on the panels), so the failure is gone either way. The
// override stays: marketingSiteAccessibility.test.js pins BY SOURCE SCAN that
// this page's back link, standfirst and footer links all carry it, and
// --pp-ink-2 (8.14:1 light, 10.12:1 dark) is the better reading colour for
// these strings regardless.
const READABLE = { color: 'var(--pp-ink-2)' };

// The public why-does-this-exist page: what users get, why venues pay, and
// what the forecast model actually is. Every claim on this page is real and
// verifiable in the product (SLOP-AUDIT.md C1: never advertise what doesn't
// ship). The numbers quoted for the model come from the committed
// model_metadata.json holdout evaluation. The rehearsal pitch with sourced
// market stats lives OUTSIDE this public repo, on purpose.
// PER-ROUTE <meta name="description">. CRA has no server rendering, so
// public/index.html is the response for every route and its one static
// description was the description this page shipped with. There is no head
// manager in this app and adding one is a dependency, so the mechanism is the
// one LandingPage.js already uses: rewrite the tag index.html ships, from this
// route's own effect. Googlebot renders JS and reads the rewritten value.
const DESCRIPTION = 'What Flock is, why group plans fall apart, how the crowd model works, and why venues pay while you never do.';

export default function AboutPage() {
  useEffect(() => {
    document.title = 'What Flock is, and why venues pay | Flock';
    const meta = document.querySelector('meta[name="description"]');
    if (meta) meta.setAttribute('content', DESCRIPTION);
  }, []);

  return (
    <main className="pp">
      <a href="/" className="pp-back" style={READABLE}>
        <span aria-hidden="true">&larr;</span> flockcorp.com
      </a>

      <header className="pp-header">
        <h1>What Flock is</h1>
        <p className="pp-meta" style={READABLE}>And why it works as a business.</p>
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
        <h2>Where Flock fits</h2>
        <p>
          The group chat is where plans start, and it is bad at finishing them.
          A place gets suggested, a few people react, and the message scrolls
          away under the next conversation. "Down" in a chat costs nothing, so
          nobody knows who actually meant it. Money is worse: nobody wants to
          ask what the table can afford, so the person with the tightest week
          just quietly drops out.
        </p>
        <p>
          Calendar and event apps sit at the other end. An invite assumes the
          hard part already happened: someone picked the place, the time, and
          the people before anything got sent. The stretch in between, where a
          maybe becomes a plan, is the part those tools skip and the part Flock
          is built for.
        </p>
        <p>
          Flock makes the decision itself the product. RSVPs live inside the
          flock, so a yes is on the record instead of buried in a thread. The
          group votes on where to go. Budgets go in privately and only a
          ceiling everyone can afford comes back. When the bill lands, it
          splits into Venmo, Cash App, or Zelle links, and showing up counts:
          your reliability score is built from the plans you joined and the
          ones you kept.
        </p>
        <p>
          Flock is not trying to be a feed, and it is not trying to replace
          your group chat. There is nothing to scroll and nobody to follow. The
          chat keeps the jokes. Flock keeps the plan.
        </p>
      </section>

      <section>
        <h2>Our crowd model</h2>
        <p>
          Flock runs its own machine-learning crowd model, not a wrapper around
          someone else's chart. It predicts how busy a venue will be, hour by hour,
          from 106 signals: time patterns, weather, nearby events, venue category,
          and how that specific spot actually behaves. It was trained on 1.9 million
          venue-hour observations across 30 cities and held out another 395,000 it
          never saw. Where it earns its place is live conditions: on 67,000 realtime
          observations it cuts the average error by 2.1 points against the
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

      {/* "how many groups considered it this week" was cut from the paragraph
          below. It does not exist: `grep -ri considered backend/` returns
          exactly one hit, and it is a comment in venueDashboard.js quoting the
          VENUE-BILLING.md PRICING TABLE. There is no route, no query and no UI
          for it. LandingPage cut the identical claim on 2026-08-12 and this
          page kept it, so the site was still advertising a screen that had
          already been deleted (SLOP-AUDIT C1 / design rule 5). All three
          replacements are shipping code: GET /incoming-flocks (the flocks that
          selected this venue), GET /intelligence (the hour-by-hour demand
          curve, same crowd model users see), and venue promotions, which
          App.js fetches through getPublicPromotions onto the venue detail
          screen, i.e. in front of a group while it is choosing.

          KEEP COMMENTS LIKE THIS OUTSIDE THE <p>. A JSX expression container
          between two text lines eats the whitespace on both sides of itself,
          so a comment dropped mid-sentence renders "chartsare". */}
      <section>
        <h2>Why venues pay (and users never do)</h2>
        <p>
          Every vote inside a flock is a group actively deciding where to go
          tonight. For a bar or restaurant, that is the moment every ad channel
          misses: review sites show what people thought after the fact, social ads
          broadcast to people who aren't going out, and busyness charts are
          read-only. Flock can show a venue the flocks that picked it, its own
          hour-by-hour demand curve, and let it put a deal in front of nearby groups,
          which matters most on the slow nights when a couple of extra
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

      {/* The shared SiteFooter carries the legal links, the mailbox and the
          copyright; the lead line below keeps this page's brand row. The
          anchor is written out here, not defaulted inside SiteFooter, because
          marketingSiteAccessibility.test.js pins BY SOURCE SCAN of this file
          that every footer link carries the READABLE override; linkStyle
          threads the same override onto the links SiteFooter renders. */}
      <SiteFooter className="pp-footer" linkStyle={READABLE}>
        <p>
          Flock &middot; <a href="/" style={READABLE}>flockcorp.com</a>
        </p>
      </SiteFooter>
    </main>
  );
}
