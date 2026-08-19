import React, { useEffect, useRef, useState } from 'react';
import './PrivacyPolicy.css';
import SiteFooter from './SiteFooter';

const EFFECTIVE_DATE = 'August 18, 2026';
const CONTACT_EMAIL = 'social@flockcorp.com';

// EVERY CLAIM ON THIS PAGE IS SOURCED TO CODE. If you change behaviour in the
// backend or the client, change this page in the same commit. The rule that
// keeps it honest: a sentence here that no file can back up does not ship.
// frontend/src/__tests__/legalPagesMatchCode.test.js pins the load-bearing ones
// to the files they came from, so a feature that lands or leaves fails a test
// rather than quietly making this page a lie.

// PER-ROUTE <meta name="description">. CRA has no server rendering, so
// public/index.html is the response for every route, and until this was added
// /privacy described itself to searchers as "Vote on where to go, see how busy
// it is before you leave, and split the bill after." There is no head manager
// in this app and adding one is a dependency, so the mechanism is the one
// LandingPage.js already uses: rewrite the tag index.html ships, from this
// route's own effect. Googlebot renders JS and reads the rewritten value.
const DESCRIPTION = 'What Flock collects, how location and anonymous budget data are handled, what venue sensors do and do not send, and how to get your data deleted.';

// Section order drives both the document and the contents rail.
const SECTIONS = [
  { id: 'who-we-are', title: 'Who we are' },
  { id: 'what-we-collect', title: 'What we collect' },
  { id: 'venue-sensors', title: 'Venue occupancy sensors' },
  { id: 'how-we-use-it', title: 'How we use your information' },
  { id: 'who-we-share-with', title: 'Who we share with' },
  { id: 'how-long', title: 'How long we keep it' },
  { id: 'your-choices', title: 'Your choices and rights' },
  { id: 'children', title: 'Children' },
  { id: 'security', title: 'Security' },
  { id: 'international', title: 'International transfers' },
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
      {/* Twelve contents links stand between the top of the document and the
          first word of the policy. Without this a keyboard user pays that toll
          on every visit. */}
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
              <li>We don't sell your information, and we don't run ads.</li>
              <li>Budget amounts are never shown to other people. The group only sees a shared ceiling.</li>
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
                friends. Flock ("we", "us", "our") is operated by Flock Corp. We are the
                data controller for personal information processed through the Flock app
                and flockcorp.com.
              </p>
            </section>

            <section id="what-we-collect">
              <h2>{num('what-we-collect')} What we collect</h2>

              <h3>You provide directly</h3>
              <ul>
                <li><strong>Account info:</strong> email, password (stored as a one-way hash, we never see your password), display name, optional avatar. We send a link to your email at sign-up to confirm it's really yours. Your friend code is worked out from your account number when you ask for it, so there is no separate code stored anywhere.</li>
                <li><strong>Phone number (optional):</strong> sign-up never asks for one. You can add a phone number later from your profile so friends who already have your number can find you. Adding one requires confirming your password or a recent sign-in.</li>
                <li><strong>Contacts you choose to match (optional):</strong> if you use "Add friends" from your phone contacts, the numbers you pick are sent to our server once to check for existing Flock accounts. We run the lookup and don't store those numbers.</li>
                <li><strong>Date of birth:</strong> collected at sign-up so we can confirm you're 13 or older.</li>
                <li><strong>Trusted contacts:</strong> if you add emergency contacts, we store the name, phone, email, and relationship you give us. SOS alerts are sent by <strong>email only</strong>. We store the phone number because the form asks for it and you may want it on file, but nothing in Flock texts or calls it.</li>
                <li><strong>Messages and content:</strong> flock chat messages, direct messages, emoji reactions, images you upload, venue reviews you write.</li>
                <li><strong>Plans and votes:</strong> flocks you create or join, RSVPs, venue votes, budget submissions, check-ins (including NFC taps at a venue).</li>
                <li><strong>Your calendar entries:</strong> anything you add to your Flock calendar (title, venue, date, time) is stored on our servers so it is there on your next device. It is yours alone; nobody else is shown it.</li>
                <li><strong>Availability status:</strong> if you set "down tonight" or similar, we store that status, the note you attach, and when it expires. Your friends can see it until it expires or you clear it.</li>
                <li><strong>Crowd reports:</strong> when you tell us how busy a venue actually is, we store that report with your account, the venue, and the time. We use it to correct our crowd predictions and to train the model that makes them. Other people see the corrected prediction, never that you were the one who reported.</li>
                <li><strong>Guest RSVPs:</strong> if someone opens a flock invite link without a Flock account, we store the display name they type and the venues they vote for, tied to a random link token. No email, no phone, no account is created for them.</li>
                <li><strong>Bill splits:</strong> if your group splits a bill, we store the total, the tip, who paid, each person's share, and whether a share has been marked settled. The people in that flock see it. No money moves through Flock: paying someone back happens in Venmo, Cash App, or Zelle.</li>
                <li><strong>Payment handles (optional):</strong> if you add them for bill-splitting, we store your Venmo username, Cash App cashtag, or Zelle identifier so flockmates can pay you back. These are usernames/handles only. Flock never collects or processes card, bank-account, or payment-card numbers.</li>
                <li><strong>Venue owner details (optional):</strong> if you claim a venue, we store the profile you fill in and the promotions, events, and replies you post. Those are shown publicly in the app. Your account is the same kind of account as anyone else's and everything above applies to it too.</li>
                <li><strong>Waitlist email:</strong> if you enter your email on flockcorp.com to hear when Flock launches, we store that address and send you one confirmation. It is not linked to any Flock account, we do not sell it, and we will delete it if you ask us at {mail}.</li>
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

              <h3>We collect automatically</h3>
              <ul>
                <li><strong>Product analytics:</strong> we use PostHog to understand how Flock is used: pages viewed and a short list of events we write by hand, such as signing up, logging in, creating a flock, sharing an invite link, and submitting a crowd report. Automatic capture of clicks and typing is switched off, so no message text, budget amount, or form content reaches PostHog. Events are tied to your account ID, not your name or email. Like any web request, the one that carries an event also carries your IP address to PostHog's servers.</li>
                <li><strong>Push notification tokens:</strong> if you enable notifications, we store the device token issued by Apple Push Notification service or Firebase Cloud Messaging.</li>
                <li><strong>Cookies and on-device storage:</strong> we use no advertising cookies and nothing that follows you around other websites. Your browser or app keeps your sign-in token, your display preferences (theme, map style, the order of your flocks), and your last known coordinates so the map opens where you are. Those coordinates stay on the device. PostHog sets its own cookie to tell a repeat visit from a new one, on flockcorp.com and in the app.</li>
                <li><strong>Connection metadata:</strong> your IP address is used for rate limiting and to spot abuse. It appears in our server logs, and it is stored in our database alongside email verification records so we can limit how many verification emails one address or one network can trigger. Those records are deleted when your account is deleted.</li>
              </ul>

              <h3>Location</h3>
              <ul>
                <li><strong>Live location share:</strong> only when you explicitly turn it on inside an active flock, and only while you leave it on. Your coordinates are passed straight through our server to the other members of that flock and are never written to our database, so there is no trail of where you were. Blocked accounts are excluded from the hand-off. You can stop it at any time.</li>
                <li><strong>SOS:</strong> when you press SOS, we email your trusted contacts with your current location, and we store that alert (your account, the coordinates, and how many contacts were emailed) so there is a record of what happened. It is deleted with your account. You can also send your trusted contacts your location without an SOS, from the Safety screen; that sends the same kind of email and is not stored. We never collect background location: Flock only reads your location while you are using it.</li>
                <li><strong>Map, venue search, weather, and crowd levels:</strong> your device location centers the map on the device itself. When you search for venues, load the weather, or ask Birdie for somewhere nearby, your coordinates are sent to our server so it can run that lookup, and the search area (not your account) goes on to Google Places or OpenWeatherMap. We do not store those coordinates in our database or build a location history from them.</li>
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
                <li>Operate the core product (auth, flocks, chat, voting, notifications).</li>
                <li>Send transactional email (email verification at sign-up, SOS alerts) via Resend.</li>
                <li>Send push notifications you opted into.</li>
                <li>Improve our crowd forecasts. Crowd reports people submit at a venue correct the live prediction for that venue and go into the data the model is retrained on. Sensor readings are described in section 3.</li>
                <li>Monitor reliability and diagnose errors to keep the app working.</li>
                <li>Detect abuse, spam, and security incidents.</li>
                <li>Comply with legal obligations.</li>
              </ul>
              <p>
                We do not sell your personal information. We do not use your messages or
                content to train third-party advertising models.
              </p>
            </section>

            <section id="who-we-share-with">
              <h2>{num('who-we-share-with')} Who we share with</h2>
              <p>
                We share information only with service providers that help us run Flock, and
                only to the extent needed for that work. Current providers include:
              </p>
              <ul>
                <li><strong>Vercel</strong> (web hosting), <strong>Railway</strong> (server + PostgreSQL hosting).</li>
                <li><strong>Resend</strong> (transactional email).</li>
                <li><strong>Apple Push Notification service</strong> and <strong>Firebase Cloud Messaging</strong> (push delivery).</li>
                <li><strong>Google Places</strong> (venue search results; we send the search text and map area, not your account).</li>
                <li><strong>MapTiler</strong> (the maps in the app; your device loads map tiles directly from MapTiler, which sees your IP address and the area of the map you're viewing, not your account).</li>
                <li><strong>Google Cloud Vision</strong> (checks images you upload against our content rules before anyone can see them; the image is sent for that check only).</li>
                <li><strong>OpenWeatherMap</strong> (weather context for crowd predictions; no personal info sent).</li>
                <li><strong>Ticketmaster</strong> (event listings near you; we send the search area, not your account).</li>
                <li><strong>BestTime</strong> (aggregate venue popularity data; no personal info sent).</li>
                <li><strong>Apple</strong> and <strong>Google</strong> (sign-in identity verification, only when you choose those options).</li>
                <li><strong>RevenueCat</strong> (subscription receipts). Flock sells nothing today. In an iOS build where purchases are switched on, RevenueCat receives your account ID and the receipt the App Store issues, and nothing else. Your card details go to Apple, never to us and never to RevenueCat.</li>
                <li><strong>PostHog</strong> (product analytics; usage events tied to your account ID, and the IP address the request arrives from).</li>
                <li><strong>Google Gemini</strong> (powers Birdie, the in-app assistant). When you chat with Birdie, your messages in that conversation, your first name, your age bracket (under 18, under 21, or adult, never your birthday), and your approximate location (rounded to about a kilometer, only if you've allowed location) are sent to Google to generate the reply. If you ask Birdie about your plans or friends, the names, venues, and times of your flocks and your friends' display names are included so it can answer. Birdie conversations are not used by us for advertising, and we don't send your email, exact coordinates, or messages from your flocks or DMs.</li>
              </ul>
              <p>
                Other flock members see content you share inside that flock (messages, RSVP
                status, live location while you have it on). Your trusted contacts receive
                an email with your current location when you press SOS.
              </p>
              <p>
                We may disclose information to comply with a valid legal process, to protect
                users from imminent harm, or in connection with a corporate transaction (we
                will notify you).
              </p>
            </section>

            <section id="how-long">
              <h2>{num('how-long')} How long we keep it</h2>
              <ul>
                <li><strong>Account data:</strong> until you delete your account.</li>
                <li><strong>Messages and flocks:</strong> retained while your account exists; deleted with your account. Deleting your account also deletes the flocks you created, along with the messages, RSVPs, and votes inside them, for everybody who was in them, and it removes your direct message threads from the other person's app as well.</li>
                <li><strong>Stories:</strong> there is no way to post or see a story anywhere in the Flock app, so using Flock does not create one. Our server does support them: a story there stops being visible to everyone 24 hours after it is posted, and the row is then removed by a cleanup that runs at most once an hour and takes stories that expired more than 24 hours ago. A story that has been reported is held until the report is closed.</li>
                <li><strong>Push notification tokens:</strong> deleted when you sign out on that device or delete your account.</li>
                <li><strong>Reports and moderation records:</strong> kept after an account is deleted so our moderation history stays intact, but with the deleted account unlinked from them.</li>
                <li><strong>Banned accounts:</strong> if an account is banned and its owner then deletes it, we keep a one-way hashed code of its email, phone number, and Apple or Google sign-in ID for 12 months. This stops a banned person from signing straight back up. The code can't be turned back into the original email or number, contains no name or content, and expires on its own after 12 months. Nothing like this is kept for accounts that weren't banned.</li>
                <li><strong>Plan statistics:</strong> when a flock ends we keep one row per plan describing how it went: group size, whether a budget was used, the group's ceiling, how many people submitted, whether it was confirmed, how long that took, and where it stalled. It carries no names, no messages, and no individual budget amounts, and once the plan is deleted it is not linked to anyone. We keep these to understand where planning breaks down.</li>
                <li><strong>Sensor readings:</strong> kept as venue history. They contain no identifiers. See section 3.</li>
                <li><strong>Server logs:</strong> short-term, for security and debugging. Our hosting provider ages them out; we do not archive them.</li>
                <li><strong>Backups:</strong> we take database backups, so information you deleted can still sit in a backup until that backup is deleted. Our written rule is that no backup is kept longer than 90 days, with one exception: an occasional archive kept so the crowd-model training data is never lost. Until we can export that data on its own, that archive is a copy of the whole database, which means it can still hold your information after you delete your account.</li>
              </ul>
            </section>

            <section id="your-choices">
              <h2>{num('your-choices')} Your choices and rights</h2>
              <ul>
                <li><strong>Access, correction, export, deletion:</strong> you can request any of these by emailing {mail}. You can delete your account in the app (Profile &rarr; Delete account) or from our <a href="/delete-account">account deletion page</a>. To protect your account, deleting it asks you to confirm your password, or to sign in again if you use Apple or Google.</li>
                <li><strong>Push notifications:</strong> Flock asks before it sends any. To stop them, turn notifications off for Flock in your device settings. Signing out also deletes that device's push token from our servers.</li>
                <li><strong>Live location:</strong> stop sharing at any time from within the flock.</li>
                <li><strong>Marketing email:</strong> we don't send marketing email. Transactional email (security, SOS) cannot be turned off while your account is active.</li>
                <li><strong>EU/UK users (GDPR):</strong> you have rights to access, rectification, erasure, restriction, objection, and portability. Contact us to exercise them. The lawful basis for our processing is performance of the user agreement and our legitimate interest in operating a safe service.</li>
                <li><strong>California users (CCPA/CPRA):</strong> you have rights to know, delete, correct, and opt out of "selling" or "sharing" of personal information. We do not sell or share for cross-context behavioral advertising.</li>
              </ul>
            </section>

            <section id="children">
              <h2>{num('children')} Children</h2>
              <p>
                Flock is intended for users <strong>13 and older</strong>. We do not
                knowingly collect personal information from children under 13. If you
                believe a child under 13 has created an account, contact us and we will
                delete it.
              </p>
            </section>

            <section id="security">
              <h2>{num('security')} Security</h2>
              <p>
                We use industry-standard safeguards: passwords hashed with bcrypt,
                parameterized database queries, rate limiting, HTTPS everywhere, JWT session
                tokens, security headers via Helmet. No system is perfectly secure; we work
                to mitigate and disclose incidents promptly.
              </p>
            </section>

            <section id="international">
              <h2>{num('international')} International transfers</h2>
              <p>
                Our servers are located in the United States. If you use Flock from outside
                the U.S., your information will be transferred to and processed in the U.S.
                By using Flock, you consent to this transfer.
              </p>
            </section>

            <section id="changes">
              <h2>{num('changes')} Changes to this policy</h2>
              <p>
                We may update this policy. We will post the new effective date at the top
                and, for material changes, give in-app notice before the change takes effect.
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
