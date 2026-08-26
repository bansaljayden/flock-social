import React, { useEffect, useRef, useState } from 'react';
import './PrivacyPolicy.css';
import SiteFooter from './SiteFooter';

const EFFECTIVE_DATE = 'August 25, 2026';
const CONTACT_EMAIL = 'social@flockcorp.com';

// THE OPERATOR NAME IS NOT VERIFIED FROM ANYTHING IN THIS REPO.
//
// "Flock Corp" is the name this page, TermsOfService.js and SiteFooter.js have
// always printed, and no file anywhere in the repository records a company
// registration, a state of incorporation, a registered agent or a business
// address behind it. AboutPage.js says Flock is built by one student in
// Bethlehem, Pennsylvania, and VENUE-TOS-DRAFT.md's own lawyer-flag list says
// the contracting entity is undecided and that nothing is safe to publish with
// it blank.
//
// A privacy policy has to name the controller correctly (GDPR Article 13 wants
// the identity AND contact details of the controller, and a postal address is
// what regulators expect there). A EULA has to name a real counterparty. So
// this constant is deliberately ONE string in ONE place: when the entity
// question is settled, change it here and in TermsOfService.js and
// SiteFooter.js, and fill in OPERATOR_ADDRESS below.
//
// OPERATOR_ADDRESS is null on purpose. An invented address is worse than a
// missing one, so nothing renders while it is null. Set it to a real postal
// address and the "Who we are" section prints it without any other edit.
const OPERATOR = 'Flock Corp';
const OPERATOR_ADDRESS = null;

// EVERY CLAIM ON THIS PAGE IS SOURCED TO CODE. If you change behaviour in the
// backend or the client, change this page in the same commit. The rule that
// keeps it honest: a sentence here that no file can back up does not ship.
// frontend/src/__tests__/legalPagesMatchCode.test.js pins the load-bearing ones
// to the files they came from, so a feature that lands or leaves fails a test
// rather than quietly making this page a lie.
//
// The vendor list in "Who we share with" is derived from the DEPENDENCIES
// inventory in backend/services/costModel.js, which is the one place in the
// repo that enumerates every outside service Flock touches. When a row is added
// there, decide here whether it receives anything about a person, and say so.
//
// ONE ENTRY IS NOT DERIVED FROM THAT FILE: Cloudflare. It runs the DNS and the
// Email Routing behind the contact address on flockcorp.com (DOMAIN.md,
// 2026-08-12), it costs
// nothing, and costModel.js only carries services that have a meter or a bill,
// so it never appeared there and therefore never appeared here. It handles
// every access request, deletion request, child-safety report and copyright
// notice a person sends us, which makes it a processor whatever it costs. A
// list that calls itself the whole list has to be derived from what we USE and
// not from what we PAY FOR; treat costModel.js as a starting point, not as the
// boundary.

// PER-ROUTE <meta name="description">. CRA has no server rendering, so
// public/index.html is the response for every route, and until this was added
// /privacy described itself to searchers as "Vote on where to go, see how busy
// it is before you leave, and split the bill after." There is no head manager
// in this app and adding one is a dependency, so the mechanism is the one
// LandingPage.js already uses: rewrite the tag index.html ships, from this
// route's own effect. Googlebot renders JS and reads the rewritten value.
const DESCRIPTION = 'What Flock collects, what Birdie and Roost send to Google, how location and photos are handled, what venue sensors do not send, and how to delete it all.';

// Section order drives both the document and the contents rail.
//
// venue-sensors is third, and it has to stay third: the prose cross-references
// it as "section 3" and the standing test walks every numbered reference on
// this page and checks that it lands on this id. Everything else is
// cross-referenced by its own anchor link, which cannot go stale.
const SECTIONS = [
  { id: 'who-we-are', title: 'Who we are' },
  { id: 'what-we-collect', title: 'What we collect' },
  { id: 'venue-sensors', title: 'Venue occupancy sensors' },
  { id: 'how-we-use-it', title: 'How we use your information' },
  { id: 'legal-bases', title: 'Our legal bases' },
  { id: 'ai', title: 'Birdie and Roost' },
  { id: 'venues', title: 'Venue owners and business data' },
  { id: 'who-we-share-with', title: 'Who we share with' },
  { id: 'analytics', title: 'Analytics, error reports, and email' },
  { id: 'how-long', title: 'How long we keep it' },
  { id: 'deletion', title: 'Deleting your account' },
  { id: 'your-choices', title: 'Your choices and rights' },
  { id: 'gdpr', title: 'If you are in the EEA or the UK' },
  { id: 'california', title: 'If you are in California' },
  { id: 'children', title: 'Children' },
  { id: 'security', title: 'Security' },
  { id: 'breach', title: 'If something goes wrong' },
  { id: 'international', title: 'International transfers' },
  { id: 'what-we-dont', title: 'What Flock does not do' },
  { id: 'changes', title: 'Changes to this policy' },
  { id: 'contact', title: 'Contact' },
];

export default function PrivacyPolicy() {
  const [activeId, setActiveId] = useState(SECTIONS[0].id);
  const pinnedRef = useRef(null);

  useEffect(() => {
    document.title = 'Privacy Policy | Flock';
    const meta = document.querySelector('meta[name="description"]');
    if (meta) meta.setAttribute('content', DESCRIPTION);
  }, []);

  // Highlight the section you're reading in the contents rail. Scroll-based
  // rather than IntersectionObserver: the last sections are short and never
  // reach an observer's top band, which left the rail stuck on an earlier
  // section while you were looking at Contact.
  useEffect(() => {
    const ids = SECTIONS.map((s) => s.id);
    let raf = 0;

    const update = () => {
      raf = 0;
      // A section you jumped to stays highlighted even when the page has run
      // out of scroll and can't bring it to the top. Cleared on your next scroll.
      if (pinnedRef.current) {
        setActiveId(pinnedRef.current);
        return;
      }
      const doc = document.documentElement;
      if (window.innerHeight + window.scrollY >= doc.scrollHeight - 4) {
        setActiveId(ids[ids.length - 1]);
        return;
      }
      const threshold = 140;
      let current = ids[0];
      for (const id of ids) {
        const el = document.getElementById(id);
        if (el && el.getBoundingClientRect().top <= threshold) current = id;
      }
      setActiveId(current);
    };

    const onScroll = () => { if (!raf) raf = window.requestAnimationFrame(update); };
    const releasePin = () => { pinnedRef.current = null; };

    update();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    // Only a deliberate scroll gesture releases the pin, not the smooth-scroll
    // the click itself triggers.
    window.addEventListener('wheel', releasePin, { passive: true });
    window.addEventListener('touchmove', releasePin, { passive: true });
    window.addEventListener('keydown', releasePin);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      window.removeEventListener('wheel', releasePin);
      window.removeEventListener('touchmove', releasePin);
      window.removeEventListener('keydown', releasePin);
      if (raf) window.cancelAnimationFrame(raf);
    };
  }, []);

  const mail = <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>;
  // Numbered from SECTIONS, not by hand. Inserting a section used to mean
  // renumbering every heading below it, and a heading that says 5 while the
  // contents rail says 6 is the kind of small wrongness a legal page cannot
  // afford. An id that is not in SECTIONS renders no number rather than a wrong
  // one.
  const num = (id) => {
    const i = SECTIONS.findIndex((s) => s.id === id);
    return i === -1 ? null : <span className="pp-num">{String(i + 1).padStart(2, '0')}</span>;
  };

  return (
    <main className="pp">
      {/* Twenty-one contents links stand between the top of the document and
          the first word of the policy. Without this a keyboard user pays that
          toll on every visit. */}
      <a className="pp-skip" href="#pp-body">Skip to the policy</a>

      <a href="/" className="pp-back">
        {/* The glyph is decoration. Left in the link's text it becomes part of
            the accessible name, which speech engines render as "left arrow
            flockcorp.com" or, worse, drop entirely and leave the name looking
            like a stray character. */}
        <span aria-hidden="true">&larr;</span> flockcorp.com
      </a>

      <div className="pp-shell">
        {/* Named from the heading a sighted reader sees, so the landmark and
            the label on screen cannot drift apart. It said "Sections" while
            the page said "Contents". */}
        <nav className="pp-toc" aria-labelledby="pp-toc-label">
          <div className="pp-toc-inner">
          <p className="pp-toc-label" id="pp-toc-label">Contents</p>
          <ol>
            {SECTIONS.map((s, i) => (
              <li key={s.id}>
                <a
                  href={`#${s.id}`}
                  aria-current={activeId === s.id ? 'location' : undefined}
                  onClick={() => { pinnedRef.current = s.id; setActiveId(s.id); }}
                >
                  <span className="pp-toc-num">{String(i + 1).padStart(2, '0')}</span>
                  <span>{s.title}</span>
                </a>
              </li>
            ))}
          </ol>
          </div>
        </nav>

        {/* tabIndex -1 makes this a real jump destination. A skip link that
            points at a non-focusable element moves the SCROLL and leaves focus
            behind in the contents rail, so the next Tab walks straight back
            into the list the user just asked to skip. */}
        <div id="pp-body" tabIndex={-1}>
          <header className="pp-header">
            <h1>Privacy Policy</h1>
            <p className="pp-meta">Effective {EFFECTIVE_DATE}</p>
          </header>

          {/* <aside> is a complementary landmark. Unnamed, it is announced as
              "complementary" with nothing to say what it complements. */}
          <aside className="pp-summary" aria-labelledby="pp-summary-title">
            <h2 id="pp-summary-title">The short version</h2>
            <ul>
              <li>We collect what Flock needs to work: your account, your plans, your messages.</li>
              <li>Location is used only while you're using the app. Never in the background.</li>
              <li>We don't sell your information, we don't share it for advertising, and we don't run ads.</li>
              <li>Budget amounts are never shown to other people. The group only sees a shared ceiling.</li>
              <li>Photos you upload have their hidden camera data, including any GPS fix, removed before we store them.</li>
              <li>Two features send text to Google's Gemini: Birdie, the assistant in the app, and Roost, the advisor for venue owners. Each has its own paragraph below saying exactly what leaves.</li>
              <li>A few venues have a Flock sensor at the door. It counts bodies and cannot identify anyone. Section 3 says exactly what it measures.</li>
              <li>You can delete your account from inside the app. It's a real delete, not a deactivation.</li>
            </ul>
            <p>
              The full detail is below. It's written in plain language on purpose. If
              anything is unclear, email {mail}.
            </p>
          </aside>

          <div className="pp-doc">
            <section id="who-we-are">
              <h2>{num('who-we-are')} Who we are</h2>
              <p>
                Flock is a social coordination app that helps you plan nights out with
                friends. Flock ("we", "us", "our") is operated by {OPERATOR}. We are the
                data controller for personal information processed through the Flock app,
                flockcorp.com, the venue dashboard, and the venue sensors described in
                section 3.
              </p>
              <p>
                This policy covers all of those. It applies whether you use Flock on iOS, on
                Android, or in a browser, whether you have an account or answer an invite
                link as a guest, and whether you use Flock to make plans or to run a venue.
                Write to us at {mail}.
                {OPERATOR_ADDRESS ? ` Our postal address is ${OPERATOR_ADDRESS}.` : ''}
              </p>
            </section>

            <section id="what-we-collect">
              <h2>{num('what-we-collect')} What we collect</h2>

              <h3>You provide directly</h3>
              <ul>
                <li><strong>Account info:</strong> email, password (stored as a one-way hash, we never see your password), display name, optional avatar, optional short bio. We send a link to your email at sign-up to confirm it's really yours. Your friend code is worked out from your account number when you ask for it, so there is no separate code stored anywhere.</li>
                <li><strong>Phone number (optional):</strong> sign-up never asks for one. You can add a phone number later from your profile. It is not used to find you unless you turn on "Let friends find me by my phone number" in Settings, which is off until you turn it on. Adding a number requires confirming your password or a recent sign-in, and turning discovery off erases the code we match against.</li>
                <li><strong>Contacts you choose to match (optional):</strong> if you use "Add friends" from your phone contacts, only phone numbers are sent, never names or anything else on a contact card. We turn each one into a one-way keyed code and compare it with the codes of people who chose to be findable by phone. We run the lookup and don't store those numbers, and a number belonging to someone who is not on Flock leaves nothing behind.</li>
                <li><strong>Date of birth:</strong> collected at sign-up so we can confirm you're 13 or older. The check runs on our server, which recalculates your age from the date rather than trusting what the app says.</li>
                <li><strong>Your acceptance of the terms:</strong> we store the moment you agreed to the Terms of Service, so both of us know what you agreed to and when.</li>
                <li><strong>Interests:</strong> the tags you pick on your profile, such as live music or trivia. They are kept on your device and synced to your account so a second device agrees with the first.</li>
                <li><strong>Trusted contacts:</strong> if you add emergency contacts, we store the name, phone, email, and relationship you give us. SOS alerts are sent by <strong>email only</strong>. We store the phone number because the form asks for it and you may want it on file, but nothing in Flock texts or calls it.</li>
                <li><strong>Messages and content:</strong> flock chat messages, direct messages, emoji reactions, images you upload, venue reviews you write.</li>
                <li><strong>Plans and votes:</strong> flocks you create or join, RSVPs, venue votes, budget submissions, check-ins (including NFC taps at a venue), and the venues you pin or vote on inside a direct message.</li>
                <li><strong>Your calendar entries:</strong> anything you add to your Flock calendar (title, venue, date, time) is stored on our servers so it is there on your next device. It is yours alone; nobody else is shown it.</li>
                <li><strong>Availability status:</strong> if you set "down tonight" or similar, we store that status, the note you attach, and when it expires. Your friends can see it until it expires or you clear it.</li>
                <li><strong>Crowd reports:</strong> when you tell us how busy a venue actually is, we store that report with your account, the venue, and the time. We use it to correct our crowd predictions and to train the model that makes them. Other people see the corrected prediction, never that you were the one who reported.</li>
                <li><strong>Reports and blocks:</strong> if you report content or block someone, we store what you reported, who you blocked, and what we did about it. Blocking is mutual, and it also ends the friendship if you had one.</li>
                <li><strong>Guest RSVPs:</strong> if someone opens a flock invite link without a Flock account, we store the display name they type and the venues they vote for, tied to a random link token. No email, no phone, no account is created for them.</li>
                <li><strong>Bill splits:</strong> if your group splits a bill, we store the total, the tip, who paid, each person's share, and whether a share has been marked settled. The people in that flock see it. No money moves through Flock: paying someone back happens in Venmo, Cash App, or Zelle.</li>
                <li><strong>Payment handles (optional):</strong> if you add them for bill-splitting, we store your Venmo username, Cash App cashtag, or Zelle identifier so flockmates can pay you back. These are usernames and handles only. Flock never collects or processes card, bank-account, or payment-card numbers.</li>
                <li><strong>Venue owner details (optional):</strong> if you claim a venue, we store the business profile you fill in, the operating facts you tell us, and the promotions, events, occupancy readings and replies you post. That has its own section below, <a href="#venues">Venue owners and business data</a>.</li>
                <li><strong>Waitlist email:</strong> if you enter your email on flockcorp.com to hear when Flock launches, we store that address and send you one confirmation. It is not linked to any Flock account, we do not sell it, every message carries an unsubscribe link, and we will delete it if you ask us at {mail}.</li>
                {/*
                  APPLE REVOCATION IS LIVE (promise restored 2026-08-18).
                  APPLE_TEAM_ID, APPLE_KEY_ID and APPLE_PRIVATE_KEY (plus
                  APPLE_CLIENT_ID and APPLE_BUNDLE_ID) confirmed set on the
                  Railway production service 2026-08-16, so
                  services/appleAuth.js `isConfigured()` is true: routes/auth.js
                  stores the refresh token at sign-in and routes/users.js
                  revokes it on deletion. If those variables are ever removed,
                  withdraw this promise again here and in DeleteAccount.js and
                  flip the pinning test in legalPagesMatchCode.test.js back.
                */}
                <li><strong>Sign-in tokens:</strong> if you sign in with Apple or Google, we receive an identity token from the provider, verify it, and issue our own session token. Apple accounts have one extra piece: Apple's rules say deleting your Flock account should also revoke Flock's access to your Apple ID, and doing that needs a refresh token from Apple that we store for that single purpose. When you delete your account, we use it to revoke Flock's access to your Apple ID, and the token is deleted with the rest of your data. After that, Flock no longer appears under Sign in with Apple in your Apple ID settings.</li>
              </ul>

              <h3>Photos, and what is hidden inside them</h3>
              <p>
                A photo from a phone carries more than the picture. The file can hold the
                exact spot it was taken, accurate to a few metres, the make and model of
                the camera, the moment of capture, and on many cameras a small copy of the
                original frame from before you cropped it. None of that shows up in any
                app, so nobody knows they sent it.
              </p>
              <p>
                Before we store an image you upload, our server strips that hidden data
                out. It covers avatars, chat photos and direct message photos, in JPEG,
                PNG and WebP, which is what phones produce. What comes off is the EXIF,
                XMP and IPTC blocks: GPS position, device identifiers, capture times,
                embedded thumbnails, and free-text comments. What stays is the colour
                profile, because dropping that changes how the picture looks. The picture
                itself is not re-encoded, so nothing about its quality changes. If a file
                does not parse the way its format says it should, we store it unchanged
                rather than risk corrupting it, and we do not claim to have cleaned it.
              </p>
              <p>
                Every image is also screened against our content rules before anyone can
                see it. That check is described under <a href="#who-we-share-with">Who we
                share with</a> and in our <a href="/guidelines">Community Guidelines</a>.
              </p>

              <h3>We collect automatically</h3>
              <ul>
                <li><strong>Product analytics:</strong> we use PostHog. The detail, including the long list of things we have switched off, is in <a href="#analytics">Analytics, error reports, and email</a>.</li>
                <li><strong>Push notification tokens:</strong> if you enable notifications, we store the device token issued by Apple Push Notification service or Firebase Cloud Messaging.</li>
                <li><strong>What we showed you:</strong> when the app shows you a crowd prediction for a venue, we record the venue, the number we published, which model produced it, and when. That record is what lets us check the prediction against what you or the venue later reported, which is how the model gets better. It is tied to your account and kept for 180 days.</li>
                <li><strong>Check-ins:</strong> a check-in inside the app is stored with your account and the venue. A tap on an NFC tag at a venue while you are signed out is stored with the venue and no account at all.</li>
                <li><strong>Reliability:</strong> when a plan ends, the host can mark who turned up. We keep a running score from that on your account, and the people in a flock with you can see it. It is a number about attendance and nothing else.</li>
                <li><strong>On-device storage:</strong> your browser or app keeps your sign-in token, your display preferences (theme, map style, the order of your flocks), your interests, and your last known coordinates so the map opens where you are. Those coordinates stay on the device. PostHog keeps its identifier in local storage rather than in a cookie, so no analytics cookie rides on requests and clearing site data removes it.</li>
                <li><strong>Connection metadata:</strong> your IP address is used for rate limiting and to spot abuse. It appears in our server logs. Three places also write it to the database. The record of an email verification link, so we can limit how many verification emails one address or one network can trigger; those are deleted when your account is deleted. The record of a password reset <em>request</em>, which holds the requesting address next to a one-way hash of the email and is deleted after 7 days. And the record of a password reset <em>link</em>, which holds the requesting address next to your account number and the email address the link was sent to, in the clear, so that a link cannot keep working after you change your address. That third record is deleted with your account, and separately once the link is spent or expired and old enough that nothing needs it.</li>
              </ul>

              <h3>Location</h3>
              <ul>
                <li><strong>Live location share in a flock:</strong> only when you explicitly turn it on inside an active flock, and only while you leave it on. Your coordinates are passed straight through our server to the other members of that flock and are never written to our database, so there is no trail of where you were. Blocked accounts are excluded from the hand-off. You can stop it at any time.</li>
                <li><strong>Live location share in a direct message:</strong> the same thing, one to one. It reaches only the person you are talking to, only while you leave it on, only if the two of you are connected, never anyone either of you has blocked, and it is not written to our database either.</li>
                <li><strong>SOS:</strong> when you press SOS, we email your trusted contacts with your current location, and we store that alert (your account, the coordinates, and how many contacts were emailed) so there is a record of what happened. It is deleted with your account. You can also send your trusted contacts your location without an SOS, from the Safety screen; that sends the same kind of email and is not stored. We never collect background location: Flock only reads your location while you are using it.</li>
                <li><strong>Map, venue search, weather, events, and crowd levels:</strong> your device location centers the map on the device itself. When you search for venues, load the weather, look for events nearby, or ask Birdie for somewhere close, your coordinates are sent to our server so it can run that lookup, and the search area, not your account, goes on to Google Places, OpenWeatherMap or Ticketmaster. We do not store those coordinates in our database and we do not build a location history from them.</li>
                <li><strong>Coordinates stay out of analytics:</strong> a few of those lookups carry your position inside the web address they request. Anything shaped like a coordinate is replaced with the word "redacted" before any analytics or error report leaves your device, in the address, in the referrer, in breadcrumbs, and in performance traces. A place name you typed is left readable, because a place name is not a position.</li>
              </ul>

              <h3>Anonymous budget data</h3>
              <p>
                Budget submissions are stored on our servers but the system is designed so
                individual amounts are <strong>never</strong> returned to other flock
                members. Other members only see aggregated values (group ceiling, count of
                submissions, ready state). This is a core product guarantee enforced in code.
              </p>
            </section>

            <section id="venue-sensors">
              <h2>{num('venue-sensors')} Venue occupancy sensors</h2>
              <p>
                A venue can install a small Flock sensor near its entrance. It is the
                only part of Flock that is hardware, and it measures the room rather
                than the people in it. This section applies to everyone who walks into
                a venue that has one, whether or not you use Flock.
              </p>

              <h3>What the sensor sends us</h3>
              <p>Every 30 seconds it sends three numbers, and nothing else:</p>
              <ul>
                <li><strong>Doorway crossings:</strong> how many times an infrared beam across the doorway was broken since the last reading.</li>
                <li><strong>Warm bodies in view:</strong> a count of heat clusters in a grid of 768 temperature readings. The count is worked out on the device.</li>
                <li><strong>Ambient loudness:</strong> one loudness level, averaged over the last 30 seconds.</li>
              </ul>

              <h3>What it does not do</h3>
              <ul>
                <li><strong>No photo or video.</strong> The thermal part is a 24 by 32 grid of temperatures, not a picture. It is reduced to a count on the device and thrown away. It is never stored and never sent to us.</li>
                <li><strong>No audio recording.</strong> The microphone's samples become a single loudness figure every five seconds and are discarded on the device. No sound is stored, buffered, or transmitted, and speech cannot be recovered from a loudness level.</li>
                <li><strong>No phone detection.</strong> No wifi or Bluetooth scanning, no MAC addresses, no beacons. Nothing reads a device in anyone's pocket.</li>
                <li><strong>No identity.</strong> The sensor counts bodies. It cannot tell one person from another, it cannot tell whether you have a Flock account, and it does not know who you are.</li>
              </ul>
              <p>
                A reading is filed against the venue and the sensor that sent it, and it
                holds nothing else: no name, no account, no phone or device belonging to
                anyone in the room, nothing that separates one person from the next. So
                there is nothing in one to trace back to you.
              </p>

              <h3>What we do with the readings</h3>
              <p>
                They produce the "Live Occupancy" figure and the 12-hour chart on that
                venue's page in the app, and the same figures in that venue owner's
                dashboard. We keep them as a record of how busy the venue has been over
                time. Because they contain no identifiers, deleting your Flock account
                does not touch them and there is nothing in them belonging to you to
                delete. We do not currently delete them on a schedule.
              </p>
              <p>
                The occupancy card also shows how many Flock accounts checked in at that
                venue in the last hour. That is a count of separate accounts. No names go
                with it.
              </p>
              <p>
                If we ever put anything in this device that can tell one person from
                another, this section is rewritten before the device goes in.
              </p>
            </section>

            <section id="how-we-use-it">
              <h2>{num('how-we-use-it')} How we use your information</h2>
              <ul>
                <li>Operate the core product: accounts and sign-in, flocks, chat, voting, budgets, bill splits, the calendar, notifications.</li>
                <li>Show you crowd predictions, venue details, weather and nearby events for the area you are looking at.</li>
                <li>Send transactional email (email verification at sign-up, password resets, SOS alerts) through Resend.</li>
                <li>Send push notifications you opted into, including the crowd alerts for a plan you have confirmed.</li>
                <li>Answer questions in Birdie, and answer venue owners' questions in Roost. Both are described in <a href="#ai">Birdie and Roost</a>.</li>
                <li>Improve our crowd forecasts. Crowd reports people submit at a venue correct the live prediction for that venue and go into the data the model is retrained on. Venue owners' occupancy readings do the same. Sensor readings are described in section 3.</li>
                <li>Screen text and images against our content rules before they are stored, and act on reports of content and behaviour that break them.</li>
                <li>Keep the service up: monitor reliability, diagnose errors, rate limit, and stop abuse, spam and account takeovers.</li>
                <li>Understand how Flock is used, at the level of counts and events rather than content.</li>
                <li>Comply with legal obligations, including child-safety reporting.</li>
              </ul>
              <p>
                We do not sell your personal information. We do not share it for
                cross-context behavioural advertising. We do not run ads, and we do not
                use your messages or your content to train advertising models, ours or
                anybody else's.
              </p>
            </section>

            <section id="legal-bases">
              <h2>{num('legal-bases')} Our legal bases</h2>
              <p>
                If you are in the EEA or the UK, the law wants us to say why each kind of
                processing is lawful. Here it is, plainly.
              </p>
              <ul>
                <li><strong>Performing our agreement with you:</strong> your account, your flocks, chat and direct messages, votes, RSVPs, budgets, bill splits, the calendar, venue search, crowd predictions, the venue dashboard, and the transactional email that keeps an account working. Without these there is no product to deliver.</li>
                <li><strong>Your consent:</strong> location, push notifications, access to your photo library or camera, matching your phone contacts, and the waitlist email. Each of those is asked for and each can be withdrawn, in your device settings or by clearing the thing you set. Withdrawing consent does not undo processing that already happened.</li>
                <li><strong>Our legitimate interests:</strong> keeping Flock safe and working. Rate limiting, abuse and fraud prevention, moderation and the records it produces, error monitoring, product analytics at the level of counts, and improving the crowd model from reports people choose to file. We have weighed these against your interests, which is why the analytics are configured the way <a href="#analytics">Analytics, error reports, and email</a> describes and why the model's training data carries no account identifiers.</li>
                <li><strong>Legal obligation:</strong> responding to lawful requests, and reporting apparent child sexual abuse material to the National Center for Missing and Exploited Children or the relevant authority.</li>
                <li><strong>Vital interests:</strong> the SOS feature. When you press it, we email your trusted contacts your location because you are telling us something is wrong.</li>
              </ul>
              <p>
                Where we rely on legitimate interests, you can object. See <a href="#gdpr">If
                you are in the EEA or the UK</a>.
              </p>
            </section>

            <section id="ai">
              <h2>{num('ai')} Birdie and Roost</h2>
              <p>
                Flock has two features that send text to a large language model. Both use
                Google's Gemini API. They are separate features with separate audiences and
                separate payloads, so they get separate paragraphs. Neither one has any
                ability to write to your account, post on your behalf, or change anything.
                They read and they answer.
              </p>

              <h3>Birdie, the assistant in the app</h3>
              <p>
                When you chat with Birdie, what goes to Google to produce the reply is
                your first name, your age bracket (under 18, under 21, or adult, never
                your birthday), your messages in that conversation, and, only if you have
                allowed location, your approximate position rounded to about a kilometer.
              </p>
              <p>
                Every message also carries where you are in the app, because otherwise Birdie
                cannot answer "is this place busy". That means the screen and tab you are on
                and, when you have one open, the name of the flock you are looking at with its
                venue and status, and the name of the venue you are looking at with its Google
                place identifier. This goes with every message, not only when you ask about a
                plan.
              </p>
              <p>
                On top of that, if you ask Birdie about your plans or your friends, the names,
                venues and times of your flocks and your friends' display names are included so
                it can answer. When Birdie looks up a venue, the venue and the crowd numbers we
                hold for it go with the question.
              </p>
              <p>
                What is not sent: we don't send your email, exact coordinates, or messages
                from your flocks or your direct messages. The roster of who is in a flock is
                replaced by a count. Birdie conversations are not used by us for advertising
                and we do not use them to train any model of our own. What Google may do
                with the text it receives is governed by Google's own terms for the Gemini
                API.
              </p>
              <p>
                Birdie's answers are generated. They can be wrong. Nothing Birdie says is
                advice about your safety, your health, your money, or the law.
              </p>

              <h3>Roost, the advisor for venue owners</h3>
              <p>
                Roost is the product venue owners will pay for, and it works two ways. You can
                tap one of the suggested questions, or you can type your own question about
                your business.
              </p>
              <p>
                When you tap a suggested question, what goes to Google is the identifier of
                that question and a block of facts our server has already computed about
                your venue: things like your projected peak hour, your own recent occupancy
                readings, the operating facts you gave us at intake, the weather, the
                ticketed events listed near you, and where your venue sits inside its cohort.
                The model's only job there is wording. Every number in the answer is put
                back in by our server afterwards, and an answer that contains a number the
                model wrote is thrown away unread.
              </p>
              <p>
                When you type your own question, the question itself goes to Google as well,
                inside the same request. It is capped at 280 characters and stripped of
                control characters first. It is used to route your question and, where the
                answer is general trade advice rather than a reading of your own numbers, to
                write that advice.
              </p>
              <p>
                What Roost does not send: nothing about any Flock user. No consumer's name,
                account, message, budget, or position. No other venue's identity or figures.
                The cohort comparison your answer may draw on is an aggregate, and it is only
                computed once two floors are cleared: five reporting owners besides you, and
                three of their readings landing on the number itself. See{' '}
                <a href="#venues">Venue owners and business data</a>.
              </p>
              <p>
                What Roost stores: not your question. We keep counts, how many questions
                your venue asked today and how many tokens they cost, so we can meter the
                feature. The text of a typed question is not written to our database.
              </p>
              <p>
                Roost is an analyst, not an oracle. Every figure it quotes carries its source
                and its date. Where our data cannot answer, it refuses instead of guessing.
                Predictions are estimates. Nothing Roost says is a guarantee about how your
                business will do, and nothing it says is legal, tax, employment or financial
                advice.
              </p>
            </section>

            <section id="venues">
              <h2>{num('venues')} Venue owners and business data</h2>
              <p>
                Venues appear on Flock whether or not anybody claims them, because listings
                are built from public sources such as Google Places and from what Flock users
                post. Claiming a venue does not create the listing; it gives you tools to
                manage your side of it. This section is about what we collect from the person
                and the business behind a claimed venue.
              </p>
              <p>
                A venue account is an ordinary Flock account, so everything above applies to
                it too. On top of that we store:
              </p>
              <ul>
                <li><strong>Your business profile:</strong> business name, category, location, description, phone, operating hours, logo or photo, goals, and the Google place your venue corresponds to. This is shown publicly in the app.</li>
                <li><strong>Operating facts you tell us:</strong> when the kitchen stops, your capacity, how long a table usually turns, your age policy, your reservation policy, the largest walk-in group you take, your typical spend per person, what you believe your busy nights are, and what sits near you that pulls a crowd. Google's opening hours describe your door, not your pass, so this is the only place these facts exist. We use them to answer your own questions and to give groups useful answers about your venue. They are not features in the crowd model.</li>
                <li><strong>Occupancy readings you post:</strong> the 0 to 100 slider. Every reading is stored with your account, your venue, and the time. It is shown to users as coming from your venue, never as Flock's own estimate. The wording that carries it is ours, built from your venue's category rather than from anything you typed, and it expires by itself 90 minutes after you set it. You can retract one. Retracted and expired readings are not deleted, because a labelled observation of a venue-hour is exactly what the crowd model learns from, which is the other half of why this feature exists.</li>
                <li><strong>What you post to your listing:</strong> promotions, events, and replies to reviews. Public, and screened by the same moderation rules as anything else.</li>
                <li><strong>Records about your account:</strong> your tier, any comped tier we granted, whether the weekly digest is switched on, and the digest sends we have made.</li>
              </ul>

              <h3>What we do with what you submit</h3>
              <p>
                Your occupancy readings do three things. They set the live number users see
                at your venue while they are fresh. They become training labels for the crowd
                model, which serves every venue, not only yours. And once enough venues in one
                city and category are reporting, they contribute to a cohort figure that
                answers the question every operator asks: was it just us, or was everyone slow.
              </p>
              <p>
                That cohort figure is built so that no venue's own number can be read out of
                it, and it has to clear two floors before it is published at all. First, at
                least five reporting <strong>owners</strong> other than the one asking must
                have posted into the same city, category, night and hour band. We count owners
                rather than venues so that one company with five rooms cannot become five
                voices. Second, at least three of those owners' readings must round to the very
                number we are about to print, so the number describes several businesses rather
                than sitting on top of one. Both are higher floors than we use anywhere else,
                because a venue is a pin on a public map with a name and an address and the set
                of them is short enough to count.
              </p>
              <p>
                The asking venue is inside the group its own figure is drawn from. Leaving it
                out would make the number change depending on who asked, which is its own way
                of leaking. The figure itself is the middle reading of that group, rounded to
                the nearest ten, so it is not read off any single venue exactly: we pick the
                middle reading rather than averaging the two either side of it, precisely so
                that no arithmetic connects the published number back to one reading. The most
                anyone can learn about another venue's reading is which rounded step it fell
                near. When either floor is missed we say so and give no number, and we do not
                say which floor it was, because that would itself describe who reported.
              </p>
              <p>
                Readings are accountable in the other direction too. When three or more
                verified users in the room contradict a live owner reading by a wide margin, we
                mark it, and repeated divergence suspends the override for that venue so users
                see our own estimate again.
              </p>

              <h3>What venue owners see, and do not see</h3>
              <p>
                The dashboard shows counts and curves built from Flock activity: how many
                groups considered the venue, check-in counts, predicted busyness, review text
                that is already public. It never shows individual users' identities, their
                budgets, their positions, their messages, or who voted for what. The advisor
                that reads this data is structurally forbidden from touching budgets at all.
              </p>
              <p>
                Venue billing is not switched on. Nothing in the venue dashboard costs money
                today and no payment method is collected. See the venue section of our{' '}
                <a href="/terms">Terms of Service</a> for what happens when that changes.
              </p>
            </section>

            <section id="who-we-share-with">
              <h2>{num('who-we-share-with')} Who we share with</h2>
              <p>
                We share information only with the companies that help us run Flock, and only
                as much as the job needs. This is the whole list, taken from the dependency
                inventory the codebase keeps of every outside service Flock touches. Each
                entry says what that company receives.
              </p>

              <h3>They run Flock itself</h3>
              <ul>
                <li><strong>Railway</strong> hosts our server and our PostgreSQL database. Everything described in this policy that is stored is stored there. Railway's Postgres also writes a continuous backup to object storage.</li>
                <li><strong>Vercel</strong> hosts flockcorp.com and the web build of the app. It sees the requests your browser makes for the site, including your IP address.</li>
              </ul>

              <h3>They receive something about you</h3>
              <ul>
                <li><strong>Resend</strong> sends our email. It receives your email address and the contents of the message: the verification link, a password reset, an SOS alert with your location, the waitlist confirmation, the Monday venue digest. It also tells us when an address bounces or someone marks a message as spam, which is how our do-not-mail list gets written.</li>
                <li><strong>Apple Push Notification service</strong> and <strong>Firebase Cloud Messaging</strong> deliver push notifications. They receive the device token and the notification.</li>
                <li><strong>Google Cloud Vision</strong> screens every image you upload against our content rules before anyone can see it. The image is sent for that check and for nothing else. If the check cannot run, the upload is refused rather than let through.</li>
                <li><strong>Google Gemini</strong> powers Birdie and Roost. <a href="#ai">Birdie and Roost</a> says exactly what each of them sends.</li>
                <li><strong>PostHog</strong> receives product analytics events tied to your account number, and the IP address the request arrives from. It also receives the cost and speed measurements behind Birdie: token counts and latency, never the words. See <a href="#analytics">Analytics, error reports, and email</a>.</li>
                <li><strong>Apple</strong> and <strong>Google</strong> verify sign-in identity, only when you choose those options. Apple additionally receives the revocation call when you delete an account you created with Sign in with Apple.</li>
                <li><strong>MapTiler</strong> and <strong>CARTO</strong> serve the map tiles. Your device loads tiles from them directly, so whichever one is in use sees your IP address and the area of the map you are looking at. It does not see your account.</li>
                <li><strong>DiceBear</strong> serves the default avatar for an account with no photo. Your device loads that image directly, so it sees your IP address and nothing else.</li>
                <li><strong>RevenueCat</strong> handles subscription receipts, and it is the one vendor here whose answer depends on which build you are running. In the iOS app, if the RevenueCat key was compiled into that build, Flock tells RevenueCat your account number when you sign in, whether or not anything is for sale. On the website it is never loaded at all. Flock sells nothing today and the paywall has never been switched on, so no receipt exists to send; if purchases are ever turned on, RevenueCat receives the receipt the App Store issues alongside that account number, and nothing else. Your card details go to Apple, never to us and never to RevenueCat.</li>
                <li><strong>Cloudflare</strong> runs our domain's DNS and the mailbox behind {CONTACT_EMAIL}, which it forwards to the inbox we read. Every message you send us passes through it: a request to see your data, a deletion request, a complaint, a child-safety report, a copyright notice. It receives the address you write from and everything you put in the message. This page names it because a data-protection request that arrives by email is handled by whoever carries the email.</li>
                <li><strong>Sentry</strong> would receive crash and error reports. It is wired up and switched off. <a href="#analytics">Analytics, error reports, and email</a> says what would happen if it were turned on.</li>
              </ul>

              <h3>They receive a place or a search, not a person</h3>
              <ul>
                <li><strong>Google Places</strong> returns venue search results, venue details, nearby venues for a venue owner's competitor view, and venue photos. We send the search text and the map area, never your account.</li>
                <li><strong>OpenWeatherMap</strong> returns the weather for an area, which the crowd model reads as an input. No personal information is sent.</li>
                <li><strong>Ticketmaster</strong> returns ticketed events near an area, which the crowd model also reads. We send the search area, not your account.</li>
              </ul>

              <h3>They receive nothing about anyone</h3>
              <ul>
                <li><strong>BestTime</strong> is where the crowd model's original training corpus came from. Collection stopped in May 2026 and the corpus is frozen. No part of the running product calls it.</li>
                <li><strong>SeatGeek</strong> is a second event source used only by offline training scripts. No server code reads it.</li>
                <li><strong>Venmo, Cash App and Zelle</strong> are opened as links from your phone. There is no integration and no account. Flock builds a web address and your phone opens it. No money and no payment detail moves through Flock.</li>
                <li><strong>Codemagic</strong> builds the iOS app, <strong>GitHub Actions</strong> scans our code for leaked secrets, and the development tools we write Flock with never touch the product. None of them receives user data.</li>
              </ul>

              <h3>The people around you</h3>
              <p>
                Other members of a flock see what you share inside it: your messages, your
                RSVP, your vote, your reliability score, and your live location while you have
                it turned on. The person you are in a direct message with sees what you send
                them. Your friends see your availability status while it is set. Your trusted
                contacts receive an email with your current location when you press SOS. A
                venue owner sees the reviews written about their venue, including yours.
              </p>

              <h3>Everyone else</h3>
              <p>
                We may disclose information to comply with a valid legal process, to protect
                people from imminent harm, to report apparent child sexual abuse material as
                the law requires, or in connection with a merger or sale of the business, in
                which case we will tell you before your information becomes subject to a
                different policy.
              </p>
              <p>
                We do not sell personal information, and we do not share it with anyone for
                advertising.
              </p>
            </section>

            <section id="analytics">
              <h2>{num('analytics')} Analytics, error reports, and email</h2>

              <h3>Product analytics, with PostHog</h3>
              <p>
                We use PostHog to understand how Flock is used: pages viewed, and a short list
                of events we write by hand, such as signing up, logging in, creating a flock,
                sharing an invite link, and submitting a crowd report. Events are tied to your
                account number, never to your name or your email, and only signed-in people get
                a profile at all. Like any web request, the one that carries an event also
                carries your IP address to PostHog's servers.
              </p>
              <p>
                The youngest person allowed on Flock is 13, so the settings are written to
                collect as little as they can, in code rather than in a dashboard where a
                toggle could widen them later:
              </p>
              <ul>
                <li>Automatic capture of clicks and typing is switched off, so no message text, budget amount or form content reaches PostHog.</li>
                <li>Session replay is off. Nothing records your screen.</li>
                <li>Heatmaps, dead-click capture, error autocapture and in-app surveys are all off.</li>
                <li>A browser that sends a Do Not Track signal is not tracked.</li>
                <li>Advertising click identifiers are masked, and invite tokens and coordinates are scrubbed out of every property before an event leaves your device.</li>
                <li>We ask PostHog not to derive a city or region from your IP address.</li>
                <li>PostHog keeps its identifier in your device's local storage rather than in a cookie.</li>
              </ul>
              <p>
                Birdie has one extra measurement. Every call to the model records how many
                tokens it used and how long it took, against your account number. The words
                are deliberately left out: PostHog is where we measure cost and speed, not
                where conversations go.
              </p>

              <h3>Crash and error reporting, with Sentry</h3>
              <p>
                Sentry is wired into both the app and the server and it is <strong>not
                switched on</strong>. With no connection string configured, the code never
                starts it and the software is not even downloaded to your device, so no crash
                report is being sent anywhere today.
              </p>
              <p>
                If we turn it on, this is what it will do. Sentry will receive unhandled errors
                and a sample of performance traces: the error, where in our code it happened,
                the page or request it happened on, and the recent steps that led to it. Before
                any of that leaves your device, invite tokens and anything shaped like a
                coordinate are replaced with the word "redacted", in the address, in the
                referrer, in breadcrumbs, in the trace name, and in the individual spans. We do
                not attach your name or your email to a Sentry event. We will update the
                effective date on this page when it is switched on.
              </p>

              <h3>Email, and how to stop it</h3>
              <p>
                Flock sends two kinds of email. Transactional email keeps your account working:
                the verification link at sign-up, a password reset you asked for, and SOS alerts
                to your trusted contacts. Those cannot be turned off while your account is
                active, because turning them off would break the account.
              </p>
              <p>
                Everything else is optional and every message carries an unsubscribe link that
                works without signing in. The waitlist confirmation and the Monday venue digest
                both do, and the two links work differently because the lists are different.
                Unsubscribing from the waitlist writes your address to a do-not-mail list.
                Turning off the Monday digest switches off a setting on your venue account
                instead, so it stops that one email and writes nothing about your address. The
                digest is off by default and only sends if a venue owner switches weekly
                reports on. An address that hard-bounces or is reported as spam is added to the
                do-not-mail list automatically.
              </p>
              <p>
                The do-not-mail list is checked inside the one function every outgoing message
                in Flock passes through, rather than in each sender, so there is nothing to
                forget. One honest limit: if that check cannot reach our database it lets the
                message go rather than holding it. We would rather send a message we should not
                have than swallow a password reset or an emergency alert because of a database
                blip.
              </p>
              <p>
                Two deliberate exceptions. Unsubscribing from a list does not stop a password
                reset or an SOS alert, because those are not lists you are on. And an SOS alert
                is sent even to an address that has hard-bounced or reported us as spam. A
                bounce says a message failed, not that the person refuses to hear from you, and
                a complaint about a marketing email is not a refusal of an emergency from the
                person who named that contact. Because nothing on our side stops that send any
                more, the Safety screen marks a trusted contact whose address has been failing,
                so you can fix the address rather than find out later.
              </p>
            </section>

            <section id="how-long">
              <h2>{num('how-long')} How long we keep it</h2>
              <ul>
                <li><strong>Account data:</strong> until you delete your account.</li>
                <li><strong>Messages, flocks, calendar entries, bill splits, votes and budgets:</strong> retained while your account exists; deleted with your account. What that takes with it is described in <a href="#deletion">Deleting your account</a>.</li>
                <li><strong>Crowd reports you file:</strong> kept while your account exists and deleted with it. A model that has already been trained on a report does not forget it, and the training set itself carries no account numbers.</li>
                <li><strong>Predictions we served you:</strong> 180 days, then deleted automatically.</li>
                <li><strong>Availability status:</strong> expires at the time you set. You can clear it yourself.</li>
                <li><strong>Invite links:</strong> expire 14 days after they are created, or a week after the plan, whichever is <strong>later</strong>. A link made today for a plan two months out therefore lives about ten weeks. An invite link is a bearer credential: anyone holding it can join the flock, read its chat and see live location, so the expiry is the only thing that retires it on its own. If a link gets somewhere it should not, the person who created the plan can ask us to kill it.</li>
                <li><strong>Password reset records:</strong> the record of a reset <em>request</em>, which holds the requesting IP address and a one-way hash of the email, is deleted after 7 days. The record of an issued reset <em>link</em>, which holds your account number, the address it was mailed to and the requesting IP address, is deleted 7 days after it is spent or expires, and immediately with your account.</li>
                <li><strong>Stories:</strong> there is no way to post or see a story anywhere in the Flock app, so using Flock does not create one. Our server does support them: a story there stops being visible to everyone 24 hours after it is posted, and the row is then removed by a cleanup that runs at most once an hour and takes stories that expired more than 24 hours ago. A story that has been reported is held until the report is closed.</li>
                <li><strong>Push notification tokens:</strong> deleted when you sign out on that device or delete your account.</li>
                <li><strong>Do-not-mail entries:</strong> kept for as long as the address should not be mailed. Removing it is what would let mail resume, so it has no expiry.</li>
                <li><strong>Reports and moderation records:</strong> kept after an account is deleted so our moderation history stays intact, but with the deleted account unlinked from them.</li>
                <li><strong>Banned accounts:</strong> if an account is banned and its owner then deletes it, we keep a one-way hashed code of its email, phone number, and Apple or Google sign-in ID for 12 months. This stops a banned person from signing straight back up. The code can't be turned back into the original email or number, contains no name or content, and expires on its own after 12 months. Nothing like this is kept for accounts that weren't banned.</li>
                <li><strong>A phone matching code,</strong> only while you have "Let friends find me by my phone number" switched on. It is a one-way keyed code of your number, it cannot be turned back into the number, and it is deleted the moment you switch discovery off or delete your account.</li>
                <li><strong>Plan statistics:</strong> when a flock ends we keep one row per plan describing how it went: group size, whether a budget was used, the group's ceiling, how many people submitted, whether it was confirmed, how long that took, and where it stalled. It carries no names, no messages, and no individual budget amounts, and once the plan is deleted it is not linked to anyone. We keep these to understand where planning breaks down.</li>
                <li><strong>Venue occupancy readings by owners:</strong> kept indefinitely, including retracted and expired ones, because each is a labelled observation the crowd model learns from. They are deleted if the venue account is deleted.</li>
                <li><strong>Venue digest send records:</strong> 90 days, then deleted.</li>
                <li><strong>Cached venue photos from Google:</strong> 30 days, then re-fetched.</li>
                <li><strong>Sensor readings:</strong> kept as venue history. They contain no identifiers. See section 3.</li>
                <li><strong>Waitlist emails:</strong> kept until you unsubscribe or ask us to delete the address.</li>
                <li><strong>Server logs:</strong> short-term, for security and debugging. Our hosting provider ages them out; we do not archive them.</li>
                <li><strong>Backups:</strong> we take database backups, so information you deleted can still sit in a backup until that backup is deleted. Our written rule is that no backup is kept longer than 90 days, with one exception: an occasional archive kept so the crowd-model training data is never lost. Until we can export that data on its own, that archive is a copy of the whole database, which means it can still hold your information after you delete your account.</li>
              </ul>
            </section>

            <section id="deletion">
              <h2>{num('deletion')} Deleting your account</h2>
              <p>
                You can delete your account from inside the app (Profile &rarr; Delete account)
                or from our <a href="/delete-account">account deletion page</a>. It is a real
                delete, not a deactivation, and it cannot be undone. To protect your account,
                deleting it asks you to confirm your password, or to sign in again if you use
                Apple or Google.
              </p>
              <p><strong>What is erased</strong></p>
              <ul>
                <li>Your account row and everything hanging off it: email, password hash, phone, date of birth, display name, avatar, bio, interests, payment handles, and your settings.</li>
                <li>Every message you sent in a flock chat, and your direct messages. A direct message belongs to both people, so deleting your account removes your direct message threads from the other person's app as well, along with anything pinned or voted on inside them.</li>
                <li>Every flock you created, including its chat, RSVPs and votes, for everybody who was in it. Flocks you only joined survive; your membership in them does not.</li>
                <li>Your crowd reports, your check-ins, your calendar entries, your availability status, your budget submissions, your bill split shares, your trusted contacts, your SOS alert records, your emoji reactions, your friendships, your blocks, your push tokens, your email verification records, and the record of the predictions we served you.</li>
                <li>Your venue profile and everything on it, if you had one, including your occupancy readings, promotions and events.</li>
                <li>If you signed in with Apple, the refresh token we held, after we use it to revoke Flock's access to your Apple ID.</li>
              </ul>
              <p><strong>What survives, and why</strong></p>
              <ul>
                <li><strong>Moderation records.</strong> Reports filed about content and the actions taken on them stay, with your account unlinked from them, so somebody cannot erase an open report about themselves by deleting their account. The de-attribution and the delete happen together: either both worked or neither did.</li>
                <li><strong>A ban tombstone,</strong> but only if the account was banned. A one-way hashed code of the email, phone and sign-in ID, for 12 months, so a banned person cannot sign straight back up. Nothing like it is kept for an account that was not banned.</li>
                <li><strong>One row per finished plan,</strong> with no names, no messages and no individual amounts, as described under <a href="#how-long">How long we keep it</a>.</li>
                <li><strong>Sensor readings,</strong> which never contained anything belonging to you. See section 3.</li>
                <li><strong>Your address on the do-not-mail list,</strong> if it is on it. That list is keyed on the address itself and has no link to your account, so deleting your account does not remove it, and it has no expiry. It exists so that an address that bounced or reported us as spam is not mailed again, which is a promise to whoever holds that mailbox rather than to the account. You can ask us to take an address off it at {mail}.</li>
                <li><strong>Two references, emptied rather than removed.</strong> If a plan you did not create had a bill split, that split's record of who paid stops pointing at you rather than being deleted, because it belongs to the plan and the plan is somebody else's. The same is true of an invite link somebody else's flock still holds: it stops saying who made it. Neither carries anything about you once your account is gone.</li>
                <li><strong>Backups,</strong> until they age out.</li>
                <li><strong>Anything already learned by the crowd model.</strong> A trained model is not a database and cannot have one row removed from it. The training data itself carries no account numbers.</li>
              </ul>
              <p>
                If you would rather have a copy of your data before you delete it, ask us at{' '}
                {mail} and we will send you one.
              </p>
            </section>

            <section id="your-choices">
              <h2>{num('your-choices')} Your choices and rights</h2>
              <ul>
                <li><strong>Access, correction, export, deletion:</strong> you can request any of these by emailing {mail}. An export is a machine-readable copy of your account, your settings, your plans and calendar entries, the messages you sent, your votes, budgets, reactions, reviews, crowd reports, check-ins, bill-split shares, SOS records, friends, reports you filed, your trusted contacts, and your reliability score. Four things are not in that file today and we would rather say so than let you assume otherwise: the record of which crowd predictions we showed you, the list of accounts you have blocked, your registered push notification tokens, and your venue profile if you run a venue. Ask and we will send those too. The file itself also lists what it leaves out and why. You can delete your account yourself in the app (Profile &rarr; Delete account) or from our <a href="/delete-account">account deletion page</a>. To protect your account, deleting it asks you to confirm your password, or to sign in again if you use Apple or Google.</li>
                <li><strong>Location:</strong> Flock asks before it reads your location and never reads it in the background. You can turn the permission off for Flock in your device settings at any time. The map then opens on a default area and venue search asks you where to look.</li>
                <li><strong>Live location sharing:</strong> stop at any time from within the flock or the conversation you started it in.</li>
                <li><strong>Push notifications:</strong> Flock asks before it sends any. To stop them, turn notifications off for Flock in your device settings. Signing out also deletes that device's push token from our servers.</li>
                <li><strong>Photos and contacts:</strong> both are asked for at the moment you use them, and both can be withdrawn in your device settings. Phone numbers you matched were never stored. Turning off "Let friends find me by my phone number" erases the code we matched you against.</li>
                <li><strong>Email:</strong> we don't send marketing email. Optional email, which today means the waitlist confirmation and the Monday venue digest, carries an unsubscribe link in every message and needs no sign-in. Transactional email cannot be turned off while your account is active.</li>
                <li><strong>Blocking and reporting:</strong> you can block anyone and report any message, profile, review or guest from inside the app. Our <a href="/guidelines">Community Guidelines</a> say where every one of those controls is.</li>
                <li><strong>Complaints:</strong> if you think we have handled your information badly, tell us first at {mail}. If you are in the EEA or the UK you can also complain to your national data protection authority.</li>
              </ul>
            </section>

            <section id="gdpr">
              <h2>{num('gdpr')} If you are in the EEA or the UK</h2>
              <p>
                {OPERATOR} is the controller for the processing described here, and{' '}
                <a href="#legal-bases">Our legal bases</a> says which basis covers what. You
                have the following rights, and you exercise all of them the same way, by
                writing to {mail}:
              </p>
              <ul>
                <li><strong>Access.</strong> A copy of the personal data we hold about you, and the information in this policy about how it is used.</li>
                <li><strong>Rectification.</strong> Corrections to anything inaccurate. Most of it you can edit yourself in the app.</li>
                <li><strong>Erasure.</strong> Deletion, which you can also do yourself. <a href="#deletion">Deleting your account</a> says exactly what goes and what does not.</li>
                <li><strong>Restriction.</strong> Ask us to stop using your data while a dispute about it is settled.</li>
                <li><strong>Objection.</strong> Object to processing we base on legitimate interests. Say what you object to and we will either stop or explain why we believe our grounds override yours.</li>
                <li><strong>Portability.</strong> Your data in a structured, machine-readable form, for the parts you gave us and the parts we process by consent or under our agreement with you.</li>
                <li><strong>Withdraw consent.</strong> Location, notifications, photo access, contacts, and the waitlist. Withdrawing does not undo processing that already happened.</li>
                <li><strong>Complain</strong> to your supervisory authority.</li>
              </ul>
              <p>
                We answer within one month. We will not charge you and we will not make the
                service worse for asking. If we cannot identify you from what you send us, we
                will ask for enough to be sure we are not handing your data to somebody else.
              </p>
              <p>
                We do not make decisions about you by automated means that produce legal
                effects or anything similarly significant. The crowd model predicts how busy a
                building is; it does not decide anything about a person.
              </p>
            </section>

            <section id="california">
              <h2>{num('california')} If you are in California</h2>
              <p>
                Under the California Consumer Privacy Act, as amended by the CPRA, these are
                the categories of personal information Flock has collected in the last twelve
                months, why, and who it goes to. Every one of them is described in more detail
                earlier in this policy.
              </p>
              <ul>
                <li><strong>Identifiers:</strong> email, display name, optional phone, account number, sign-in identifiers from Apple or Google, IP address, push tokens. Collected to run the service and keep it safe. Shared with our hosting, email, push, analytics and sign-in providers.</li>
                <li><strong>Customer records:</strong> password hash, payment handles such as a Venmo username. Collected to run sign-in and bill splitting. Not shared, except the hosting that stores them.</li>
                <li><strong>Protected classifications:</strong> date of birth, which yields age. Collected only to enforce the minimum age. An age bracket, never the date, is sent to Google for Birdie.</li>
                <li><strong>Commercial information:</strong> venues you voted on, checked into, reviewed or reported on, bill splits, and subscription receipts if you ever buy one. Collected to run the product.</li>
                <li><strong>Internet activity:</strong> pages viewed and the short list of hand-written events described under <a href="#analytics">Analytics, error reports, and email</a>. Shared with PostHog.</li>
                <li><strong>Geolocation:</strong> precise location while you are using the app, for the map, venue search, weather, events and SOS. Relayed, not stored, except for the coordinates in an SOS record. A rounded position goes to Google for Birdie.</li>
                <li><strong>Audio, electronic, visual information:</strong> photos you upload, with their hidden camera data removed, and the messages you write. Photos are screened by Google Cloud Vision.</li>
                <li><strong>Inferences:</strong> your reliability score, and the crowd predictions we compute for venues.</li>
              </ul>
              <p>
                Sensitive personal information, in the CPRA's sense, means your precise
                geolocation and your account credentials. We use them only to deliver the
                features you asked for and to secure your account, which is a use the law does
                not require us to offer a limit on. We do not use or disclose sensitive
                personal information for any other purpose, and we do not sell or share it.
              </p>
              <p>
                <strong>We have not sold personal information, and we have not shared it for
                cross-context behavioural advertising.</strong> We do not have an advertising
                business, we run no advertising software, and there is no "Do Not Sell or Share
                My Personal Information" link on Flock because there is nothing for it to
                switch off.
              </p>
              <p>
                You have the right to know what we collect and why, to get a copy, to correct
                it, to delete it, and not to be discriminated against for asking. Email{' '}
                {mail} and say which one you want. An authorised agent may ask on your behalf with
                written permission we can verify. We verify a request by checking that it comes
                from the address on the account, or by asking you to confirm from inside the app.
              </p>
            </section>

            <section id="children">
              <h2>{num('children')} Children</h2>
              <p>
                Flock is for people <strong>13 and older</strong>. Sign-up asks for a date of
                birth and our server recalculates the age from it rather than trusting the app,
                so an under-13 account is refused rather than merely discouraged. We do not
                knowingly collect personal information from children under 13. If you believe a
                child under 13 has created an account, write to {mail} and we will delete it.
              </p>
              <p>
                Several countries in the EEA set the age at which a young person can consent to
                an online service above 13, most often at 16. Flock has no way to collect and
                verify a parent's consent. So if you are between 13 and the age of digital
                consent where you live, you need your parent or guardian's permission to use
                Flock, and by using it you are telling us you have it. A parent or guardian who
                wants an account closed can write to {mail} and we will close it.
              </p>
              <p>
                Flock has zero tolerance for child sexual abuse and exploitation. Our{' '}
                <a href="/guidelines">Community Guidelines</a> describe what we do about it,
                including reporting apparent material to the National Center for Missing and
                Exploited Children.
              </p>
              <p>
                We do not build advertising profiles of anyone, so we do not build them of
                minors either. The analytics settings under <a href="#analytics">Analytics,
                error reports, and email</a> were written with the 13-year-old in mind.
              </p>
            </section>

            <section id="security">
              <h2>{num('security')} Security</h2>
              <p>These are the protections that are actually in place, not a list of aspirations:</p>
              <ul>
                <li>Passwords are hashed with bcrypt. We never see or store the password itself.</li>
                <li>Every connection is HTTPS, and the browser is told to keep it that way.</li>
                <li>Sessions are signed tokens with a fixed algorithm and a version stamp, so signing out everywhere really does invalidate the old ones.</li>
                <li>The most destructive actions, deleting your account and exporting your data, need proof it is really you: your password again, or a fresh sign-in. Wrong guesses are counted and locked out.</li>
                <li>Every database query is parameterised, so a message cannot become a command.</li>
                <li>Rate limits sit on every route people use, with tighter ones on sign-in, on the assistant, on the venue advisor, and on anything unauthenticated. Two routes are exempt and both are machine-to-machine: the notices our email provider and our subscription provider send us. Neither is reachable without the shared secret it is checked against, and rate limiting them would mean discarding a delivery notice we asked for.</li>
                <li>Security headers are set by Helmet, including a content security policy.</li>
                <li>Text and images are screened before they are stored, and an image that cannot be screened is refused rather than let through.</li>
                <li>Uploaded images have their embedded metadata removed before storage.</li>
                <li>Notices from our email provider carry a signature over the exact bytes they sent, and we verify it before reading a word of the message. Our subscription provider does not sign anything; it presents a shared secret in a header, which we compare in constant time. Both are refused outright if the secret on our side is missing or too short to be one.</li>
                <li>Every push to our code is scanned for leaked secrets automatically.</li>
                <li>We take database backups, and we have a tool that restores one into a throwaway database and checks it, because an untested backup is a guess. Being straight about it: running that tool is a manual step today. Making a backup does not run it.</li>
              </ul>
              <p>
                No system is perfectly secure. If you find a problem, write to {mail} and we
                will take it seriously.
              </p>
            </section>

            <section id="breach">
              <h2>{num('breach')} If something goes wrong</h2>
              <p>
                If personal information is exposed by a breach, we will investigate it, fix
                what caused it, and tell the people affected without undue delay, describing
                what happened, what was involved, and what we are doing about it. Where the law
                sets a deadline, we will meet it: for people in the EEA or the UK that means
                notifying the relevant supervisory authority within 72 hours of becoming aware
                of a reportable breach, and telling you directly when the risk to you is high.
                We will not wait for certainty about every detail before telling you something
                happened.
              </p>
            </section>

            <section id="international">
              <h2>{num('international')} International transfers</h2>
              <p>
                Our servers are in the United States, and the companies listed under{' '}
                <a href="#who-we-share-with">Who we share with</a> are United States companies
                or process there. If you use Flock from outside the United States, your
                information is transferred to and processed in the United States, which may not
                give it the same legal protection as your own country.
              </p>
              <p>
                We want to be straight about the mechanism, including about what we do not
                know. Flock has not separately negotiated a transfer agreement with any of the
                companies listed above. Several of them apply their own data processing terms,
                including Standard Contractual Clauses, to every account by default, so those
                may well cover some of these transfers without our having signed anything
                bespoke. We have not audited each vendor's terms to tell you which, and we will
                not claim a protection we have not checked. For people in the EEA or the UK,
                the transfer happens because it is necessary to provide the service you asked
                us for, and because you agree to it by using Flock. If we put a specific
                agreement in place, this section changes with it.
              </p>
            </section>

            <section id="what-we-dont">
              <h2>{num('what-we-dont')} What Flock does not do</h2>
              <p>
                A privacy policy that only lists what a company takes is half a document. Here
                is the other half. None of the following happens, anywhere in Flock, today:
              </p>
              <ul>
                <li>We do not sell personal information, and we do not share it for advertising.</li>
                <li>We do not run ads, and there is no advertising software in the app or on the site.</li>
                <li>We do not track you across other apps or websites. There is no advertising cookie, no pixel, and no data broker.</li>
                <li>We do not read your location in the background, ever. Only while Flock is open and only when you have allowed it.</li>
                <li>We do not keep a location history. Live location sharing is relayed and never written down. The single exception is the SOS record: when you press SOS we store the coordinates that went out, so there is a record of what happened, and it is deleted with your account.</li>
                <li>We do not upload or store your address book. The numbers you pick for a friend match are checked and discarded.</li>
                <li>We do not touch card numbers, bank accounts or any payment credential. No money moves through Flock.</li>
                <li>We do not record your screen, your keystrokes, your microphone or your camera. The only time the camera opens is when you ask it to take a photo or scan a code.</li>
                <li>We do not send your flock chat, your direct messages, your budgets, or your exact position to any AI model. What you type to Birdie itself does go to Google, because that is the only way it can answer you, along with the context named under <a href="#ai">Birdie and Roost</a>.</li>
                <li>We do not use your messages to train the crowd model. It learns from venue observations, and its training data holds no account numbers.</li>
                <li>We do not show any other person your budget amount.</li>
                <li>We do not tell anybody that a crowd report came from you.</li>
                <li>We do not let a venue see who is in the room, only how many.</li>
                <li>We do not collect health data, biometrics, race, religion, politics, or sexual orientation.</li>
                <li>We do not sell venue owners influence over what consumers see, and we do not accept payment to change a busyness number or bury an honest review.</li>
              </ul>
              <p>
                If any of that ever stops being true, it changes on this page before it changes
                in the product.
              </p>
            </section>

            <section id="changes">
              <h2>{num('changes')} Changes to this policy</h2>
              <p>
                We may update this policy. We will post the new effective date at the top
                and, for material changes, give in-app notice before the change takes effect.
                If a change means we need your consent for something, we will ask.
              </p>
            </section>

            <section id="contact">
              <h2>{num('contact')} Contact</h2>
              <p>Questions, requests, or concerns? A human reads this inbox:</p>
              <div className="pp-contact">
                <a className="pp-contact-mail" href={`mailto:${CONTACT_EMAIL}`}>
                  {CONTACT_EMAIL}
                </a>
              </div>
            </section>
          </div>

          {/* The shared SiteFooter: legal links, the one real mailbox, and the
              copyright. It stays inside main.pp because .pp paints the page. */}
          <SiteFooter className="pp-footer" />
        </div>
      </div>
    </main>
  );
}
