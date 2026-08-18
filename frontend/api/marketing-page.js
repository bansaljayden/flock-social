'use strict';

// ---------------------------------------------------------------------------
// /api/marketing-page - static HTML for AI and answer-engine crawlers.
//
// WHY THIS EXISTS
// flockcorp.com is a client-rendered React app, and the AI crawlers that decide
// whether Flock is "the answer" when someone asks an assistant for an app to
// plan things with friends do not execute JavaScript. The 2026-08-14 audit
// (seo-audit/findings/geo.md) issued live requests as ten of them: every one
// received the empty 2.9 KB CRA shell. llms.txt and the JSON-LD in
// public/index.html describe the site; this function IS the site for those
// crawlers. It serves a full static HTML rendering of the five marketing
// routes (/, /about, /support, /privacy, /terms), reached through
// user-agent-conditional rewrites in vercel.json - the exact pattern
// api/invite-preview.js already ships for link-preview bots on /i/<token>.
// Humans keep getting the React app at the same URLs.
//
// WHY THIS IS NOT CLOAKING, AND WHAT KEEPS IT THAT WAY
// Serving a bot different bytes is only legitimate while the CONTENT is the
// content a rendering human sees. Three design decisions hold that line:
//
//   1. The copy below is not written here. Every block in PAGE_BLOCKS is the
//      extracted text of the same React components humans render, produced by
//      ReactDOMServer over src/website/*.js. It is a strict subset: what is
//      excluded is navigation chrome, form controls, and the three synthetic
//      illustrations (the dead-group-chat mock, the example bill split, the
//      example SOS email), so the bot document can never quote example
//      numbers as if they were real data. Nothing is in this file that is not
//      on the rendered page.
//
//   2. src/__tests__/aiCrawlerSurface.test.js re-renders the five components
//      on every test run, re-extracts the blocks with the same rules, and
//      requires DEEP EQUALITY with PAGE_BLOCKS, plus equality of title and
//      description with what each page's own useEffect writes. The moment
//      marketing copy drifts, that suite goes red and the jest diff shows the
//      exact sentence to update here. Divergence cannot ship quietly.
//
//   3. The user-agent list deliberately EXCLUDES Googlebot, Bingbot and
//      Applebot. All three execute JavaScript and already see the rendered
//      site, and they are the crawlers whose owners police cloaking. Only
//      agents that cannot render the SPA at all get this document, and they
//      get the same claims in the same order.
//
// THE vercel.json WIRING (documented here because vercel.json is validated
// against Vercel's own schema and can carry no comments; same arrangement as
// api/invite-preview.js).
//
//   Two rewrites sit between the /i/:token invite rules and the SPA fallback:
//
//     /                          + AI user-agent -> /api/marketing-page?page=home
//     /:page(about|support|privacy|terms)
//                                + AI user-agent -> /api/marketing-page?page=:page
//
//   KNOWN LIMIT ON "/": Vercel gives "precedence to the filesystem prior to
//   rewrites being applied" (project-configuration docs), and the root path
//   resolves to the built index.html at the filesystem stage. The "/" rule may
//   therefore never fire; it is kept because it is correct if Vercel routes it
//   and harmless (today's behaviour) if not. AFTER DEPLOY, VERIFY with:
//     curl -A "GPTBot" https://www.flockcorp.com/        (want: this document)
//     curl -A "GPTBot" https://www.flockcorp.com/about   (want: this document)
//   If "/" still returns the shell, the fix is Vercel routing middleware,
//   which runs before the filesystem - a follow-up, not a config tweak.
//   The four subpage routes are not files and rewrite unconditionally.
//
// THE RULES THIS FILE IS HELD TO (same charter as invite-preview.js)
//   1. Never return a non-200 and never throw out of the handler. A crawler
//      that caches a failure repeats it in an answer index for weeks.
//   2. esc() every interpolated value. The copy is our own, but the rule is
//      cheaper than the exception.
//   3. Every claim served must be true of the shipping product. This is
//      enforced transitively: the source pages are claim-audited (see
//      landingPageClaims.test.js, legalPagesMatchCode.test.js) and this file
//      is pinned to the source pages.
//   4. No fabricated popularity. No ratings, counts, reviews, or invented
//      third-party mentions, in the copy or in the JSON-LD (SLOP-AUDIT
//      section M). The only credibility claim is the DECA award, which is on
//      the human-visible page in the same words.
//
// TO REGENERATE PAGE_BLOCKS after a copy change in src/website:
//   cd frontend && CI=true npx react-scripts test --watchAll=false \
//     --testPathPattern=aiCrawlerSurface
//   The failing diff prints the freshly extracted blocks next to these; update
//   the strings here to match. The extraction rules live in that test file.
// ---------------------------------------------------------------------------

const CANONICAL_HOST = 'https://www.flockcorp.com';
const OG_IMAGE = CANONICAL_HOST + '/og-image.png';
const OG_IMAGE_ALT = 'Flock. Plans die in the group chat. Flock is where they happen.';
const CONTACT_EMAIL = 'social@flockcorp.com';

// Title and description per route mirror what each React page writes via its
// own useEffect (document.title + the meta description rewrite). The drift
// test asserts these strings appear verbatim in the corresponding source file.
const PAGE_META = {
  home: {
    path: '/',
    title: 'Flock | Plans that actually happen',
    description: 'Flock turns “we should hang out” into a real night out. Vote on where to go, see how busy it is before you leave, split the bill, and go.',
  },
  about: {
    path: '/about',
    title: 'What Flock is, and why venues pay | Flock',
    description: 'What Flock is, why group plans fall apart, how the crowd model works, and why venues pay while you never do.',
  },
  support: {
    path: '/support',
    title: 'Support and common questions | Flock',
    description: 'Answers on signing in, notifications, location, deleting your account, how budget matching stays private, and what happens when you tap SOS.',
  },
  privacy: {
    path: '/privacy',
    title: 'Privacy Policy | Flock',
    description: 'What Flock collects, how location and anonymous budget data are handled, what venue sensors do and do not send, and how to get your data deleted.',
  },
  terms: {
    path: '/terms',
    title: 'Terms of Service and EULA | Flock',
    description: 'The terms and EULA for using Flock: eligibility, acceptable use, user content, reporting and moderation, and how to get in touch.',
  },
};

// Extracted from the rendered React pages. DO NOT EDIT BY HAND unless the
// drift test told you to; see the regeneration note in the header.
const PAGE_BLOCKS = {
  home: [
    ["h1", "Plans die in the group chat. Flock is where they happen."],
    ["p", "Start a flock, invite your people, and vote on where to go. Everyone ends up on the same plan without the 200-message thread."],
    ["p", "Free, and it runs in your browser right now, so there’s nothing to download. Flock took 1st place at PA DECA States."],
    ["h2", "Six people say yes. Then the chat goes quiet."],
    ["p", "The plan doesn’t fall apart because people don’t want to go. It falls apart because deciding is annoying, and one person always ends up carrying it."],
    ["h2", "Four steps, then you’re out the door."],
    ["h3", "Start a flock"],
    ["p", "Name the night, pick a date, invite your people. They RSVP in one tap."],
    ["h3", "Vote on where"],
    ["p", "Everyone throws in places. The group votes. No one has to be the decider."],
    ["h3", "Match budgets"],
    ["p", "Everyone types in what they can spend. The group only ever sees the ceiling, never anyone’s number."],
    ["h3", "Lock it in"],
    ["p", "The plan locks, everyone gets the details, and you’re going out."],
    ["p", "The chat, the venue cards and the votes all live in the flock, and everything you say yes to lands on one calendar."],
    ["p", "Crowd levels"],
    ["h2", "Know how busy it is before you leave."],
    ["p", "Flock reads the hour, the weather, and how busy a place usually runs, then estimates how packed it will be tonight. You stop driving across town to stand in a line."],
    ["li", "An hour-by-hour read on tonight"],
    ["li", "The best time to show up"],
    ["li", "Every spot near you, scored the same way"],
    ["p", "Everything below is live. The map, the pins, and the numbers come from the same model that ships inside Flock, trained on 1.9 million venue-hour observations across 30 cities. Pick a pin."],
    ["h2", "“Idk, you pick.” Birdie picks."],
    ["p", "Ask Birdie the way you’d ask a friend who knows the city. It comes back with real places near you, not a list it made up."],
    ["p", "Birdie is AI. It runs on Google Gemini, and the crowd numbers it quotes are the app’s own."],
    ["li", "Ask in plain words. “Where’s poppin rn” works"],
    ["li", "Crowd numbers come from the same model as the map above"],
    ["li", "Tap a card for the details, or send it straight to your flock"],
    ["h2", "Nobody wants to say “that’s too expensive” out loud."],
    ["p", "In Flock nobody has to. Everyone types a number privately, and the group only ever sees a ceiling that works for all of them."],
    ["li", "The ceiling stays hidden until three people have put a number in"],
    ["li", "Venue picks stay under the group’s ceiling"],
    ["li", "Split the bill and send Venmo, Cash App, or Zelle links"],
    ["p", "Safety"],
    ["h2", "Getting home matters as much as getting out."],
    ["p", "Share your live location with your group while the night is on, and only while it’s on. If something goes wrong, one button tells the people you picked where you are."],
    ["li", "One-tap SOS to your trusted contacts"],
    ["li", "Live location inside the flock, off by default"],
    ["li", "No background tracking, ever"],
    ["li", "Report and block on any message or profile"],
    ["h2", "Free for your friend group."],
    ["p", "You and your friends don’t pay. Venues are the side Flock is built to charge, and none of them is being charged yet."],
    ["h3", "Free"],
    ["p", "Plan the night and split the bill without paying us anything."],
    ["li", "Unlimited flocks and friends"],
    ["li", "Venue voting and group chat"],
    ["li", "Live crowd levels"],
    ["li", "Budget matching and bill splitting"],
    ["li", "SOS and trusted contacts"],
    ["h3", "For venues"],
    ["p", "A dashboard for your door: who picked you tonight, how the week ahead looks, and a card inside the app that you write."],
    ["li", "See the flocks that chose you"],
    ["li", "Put a deal on your venue’s card, where groups open it"],
    ["li", "Reply to reviews from people who went"],
    ["li", "Your own hour-by-hour forecast, from the model the app runs"],
    ["h2", "Give the next plan a fighting chance."],
    ["p", "Open Flock in your browser, or leave your email and you’ll hear the moment the iPhone app is out."],
  ],
  about: [
    ["h1", "What Flock is"],
    ["p", "And why it works as a business."],
    ["h2", "The problem"],
    ["p", "Group plans rarely die because people don't want to go. They die because deciding is annoying. Six people say yes, nobody picks a place, one person gets stuck carrying the whole thing, and the plan quietly expires in the chat. Groups don't choose by picking someone's favorite; they choose by finding the option nobody vetoes. A group chat has no mechanism for that. Flock is that mechanism."],
    ["h2", "What users get (free)"],
    ["p", "Start a flock, invite your people, and vote on where to go. Enter what you can spend privately: the group only ever sees a ceiling everyone can afford, never anyone's number, so money stops being the silent veto. Check how busy a place is before you leave. Split the bill and send Venmo, Cash App, or Zelle links. Share live location with your group while the night is on, with one-tap SOS to trusted contacts. Planning a night out with friends costs nothing, and the app has no ads and no feed."],
    ["h2", "Where Flock fits"],
    ["p", "The group chat is where plans start, and it is bad at finishing them. A place gets suggested, a few people react, and the message scrolls away under the next conversation. \"Down\" in a chat costs nothing, so nobody knows who actually meant it. Money is worse: nobody wants to ask what the table can afford, so the person with the tightest week just quietly drops out."],
    ["p", "Calendar and event apps sit at the other end. An invite assumes the hard part already happened: someone picked the place, the time, and the people before anything got sent. The stretch in between, where a maybe becomes a plan, is the part those tools skip and the part Flock is built for."],
    ["p", "Flock makes the decision itself the product. RSVPs live inside the flock, so a yes is on the record instead of buried in a thread. The group votes on where to go. Budgets go in privately and only a ceiling everyone can afford comes back. When the bill lands, it splits into Venmo, Cash App, or Zelle links, and showing up counts: your reliability score is built from the plans you joined and the ones you kept."],
    ["p", "Flock is not trying to be a feed, and it is not trying to replace your group chat. There is nothing to scroll and nobody to follow. The chat keeps the jokes. Flock keeps the plan."],
    ["h2", "Our crowd model"],
    ["p", "Flock runs its own machine-learning crowd model, not a wrapper around someone else's chart. It predicts how busy a venue will be, hour by hour, from 106 signals: time patterns, weather, nearby events, venue category, and how that specific spot actually behaves. It was trained on 1.9 million venue-hour observations across 30 cities and held out another 395,000 it never saw. Where it earns its place is live conditions: on 67,000 realtime observations it cuts the average error by 2.1 points against the popular-times baseline it started from. When a venue is too new or too small for the model to know it yet, a rule-based engine answers instead of guessing wildly."],
    ["p", "Busyness charts you've seen elsewhere measure who already showed up. Flock's votes measure something that exists nowhere else: which venues groups are considering right now, before they've gone anywhere."],
    ["h2", "Why venues pay (and users never do)"],
    ["p", "Every vote inside a flock is a group actively deciding where to go tonight. For a bar or restaurant, that is the moment every ad channel misses: review sites show what people thought after the fact, social ads broadcast to people who aren't going out, and busyness charts are read-only. Flock can show a venue the flocks that picked it, its own hour-by-hour demand curve, and let it put a deal in front of nearby groups, which matters most on the slow nights when a couple of extra tables changes the week."],
    ["p", "That's the business: the planning side stays free for you and your friends, and venues pay for demand they can see and act on. Venue tools are in development; if you run a venue and want in early, email social@flockcorp.com."],
    ["h2", "Who's behind it"],
    ["p", "Flock is built by Jayden Bansal, a student founder in Bethlehem, PA. It took 1st place at PA DECA States. It exists because the group chat kept killing perfectly good Friday nights."],
  ],
  support: [
    ["h1", "Support"],
    ["p", "I read every message."],
    ["h2", "Contact"],
    ["p", "The fastest way to reach me is email: social@flockcorp.com"],
    ["p", "Please include your username, your device (iPhone model + iOS version, or Android model + version), and a short description of what you were doing when the issue happened. Screenshots help."],
    ["h2", "Common questions"],
    ["h3", "Why can't I sign in to Flock?"],
    ["p", "Check that the email matches the one you signed up with. If you signed up with Google or Apple, use the same button. A password account isn't created automatically. Still stuck? Email me with the email you tried."],
    ["h3", "Why am I not getting Flock notifications?"],
    ["p", "Open Settings → Notifications → Flock and confirm Allow Notifications is on. On iOS, also check that Focus modes aren't silencing them. Inside the app, go to Profile and check that Push Notifications shows as enabled."],
    ["h3", "Why isn't the map showing my location?"],
    ["p", "Settings → Privacy & Security → Location Services → Flock should be set to \"While Using the App.\" If it's set to Never, the Discover map won't be able to center on you."],
    ["h3", "How do I delete my account?"],
    ["p", "Open Flock and go to Profile → Delete account, then type DELETE to confirm. You'll also enter your password (or sign in again if you use Apple or Google) so nobody else can delete your account from a borrowed phone. This immediately and permanently removes your account, messages, flocks you created, friend connections, and personal info. If you can't sign in to delete it yourself, email me from the address on the account and I'll do it."],
    ["h3", "How does the budget feature stay anonymous?"],
    ["p", "The app server never sends individual budget amounts back to the group. It only sends the aggregate ceiling, the submission count, and whether everyone has submitted. No member (including the flock creator) sees what you personally entered."],
    ["h3", "What happens when I tap SOS?"],
    ["p", "Your trusted contacts (Profile → Safety → Trusted Contacts) get an email with your current location and a timestamp. Add at least one contact before you need it."],
    ["h3", "How do I report a bug or suggest a feature?"],
    ["p", "Email social@flockcorp.com with \"Bug\" or \"Feature\" in the subject. I go through them every week."],
    ["h2", "Privacy"],
    ["p", "Read the Privacy Policy for details on what Flock collects and how it is used."],
  ],
  privacy: [
    ["h1", "Privacy Policy"],
    ["p", "Effective August 14, 2026"],
    ["h2", "The short version"],
    ["li", "We collect what Flock needs to work: your account, your plans, your messages."],
    ["li", "Location is used only while you're using the app. Never in the background."],
    ["li", "We don't sell your information, and we don't run ads."],
    ["li", "Budget amounts are never shown to other people. The group only sees a shared ceiling."],
    ["li", "A few venues have a Flock sensor at the door. It counts bodies and cannot identify anyone. Section 3 says exactly what it measures."],
    ["li", "You can delete your account from inside the app. It's a real delete, not a deactivation."],
    ["p", "The full detail is below. It's written in plain language on purpose. If anything is unclear, email social@flockcorp.com."],
    ["h2", "Who we are"],
    ["p", "Flock is a social coordination app that helps you plan nights out with friends. Flock (\"we\", \"us\", \"our\") is operated by Flock Corp. We are the data controller for personal information processed through the Flock app and flockcorp.com."],
    ["h2", "What we collect"],
    ["h3", "You provide directly"],
    ["li", "Account info: email, password (stored as a one-way hash, we never see your password), display name, optional avatar. We send a link to your email at sign-up to confirm it's really yours. Your friend code is worked out from your account number when you ask for it, so there is no separate code stored anywhere."],
    ["li", "Phone number (optional): sign-up never asks for one. You can add a phone number later from your profile so friends who already have your number can find you. Adding one requires confirming your password or a recent sign-in."],
    ["li", "Contacts you choose to match (optional): if you use \"Add friends\" from your phone contacts, the numbers you pick are sent to our server once to check for existing Flock accounts. We run the lookup and don't store those numbers."],
    ["li", "Date of birth: collected at sign-up so we can confirm you're 13 or older."],
    ["li", "Trusted contacts: if you add emergency contacts, we store the name, phone, email, and relationship you give us. SOS alerts are sent by email only. We store the phone number because the form asks for it and you may want it on file, but nothing in Flock texts or calls it."],
    ["li", "Messages and content: flock chat messages, direct messages, emoji reactions, images you upload, venue reviews you write."],
    ["li", "Plans and votes: flocks you create or join, RSVPs, venue votes, budget submissions, check-ins (including NFC taps at a venue)."],
    ["li", "Your calendar entries: anything you add to your Flock calendar (title, venue, date, time) is stored on our servers so it is there on your next device. It is yours alone; nobody else is shown it."],
    ["li", "Availability status: if you set \"down tonight\" or similar, we store that status, the note you attach, and when it expires. Your friends can see it until it expires or you clear it."],
    ["li", "Crowd reports: when you tell us how busy a venue actually is, we store that report with your account, the venue, and the time. We use it to correct our crowd predictions and to train the model that makes them. Other people see the corrected prediction, never that you were the one who reported."],
    ["li", "Guest RSVPs: if someone opens a flock invite link without a Flock account, we store the display name they type and the venues they vote for, tied to a random link token. No email, no phone, no account is created for them."],
    ["li", "Bill splits: if your group splits a bill, we store the total, the tip, who paid, each person's share, and whether a share has been marked settled. The people in that flock see it. No money moves through Flock: paying someone back happens in Venmo, Cash App, or Zelle."],
    ["li", "Payment handles (optional): if you add them for bill-splitting, we store your Venmo username, Cash App cashtag, or Zelle identifier so flockmates can pay you back. These are usernames/handles only. Flock never collects or processes card, bank-account, or payment-card numbers."],
    ["li", "Venue owner details (optional): if you claim a venue, we store the profile you fill in and the promotions, events, and replies you post. Those are shown publicly in the app. Your account is the same kind of account as anyone else's and everything above applies to it too."],
    ["li", "Waitlist email: if you enter your email on flockcorp.com to hear when Flock launches, we store that address and send you one confirmation. It is not linked to any Flock account, we do not sell it, and we will delete it if you ask us at social@flockcorp.com."],
    ["li", "Sign-in tokens: if you sign in with Apple or Google, we receive an identity token from the provider, verify it, and issue our own session token. Apple accounts have one extra piece: Apple's rules say deleting your Flock account should also revoke Flock's access to your Apple ID, and doing that needs a refresh token from Apple that we store for that single purpose. When you delete your account, we use it to revoke Flock's access to your Apple ID, and the token is deleted with the rest of your data. After that, Flock no longer appears under Sign in with Apple in your Apple ID settings."],
    ["h3", "We collect automatically"],
    ["li", "Product analytics: we use PostHog to understand how Flock is used: pages viewed and a short list of events we write by hand, such as signing up, logging in, creating a flock, sharing an invite link, and submitting a crowd report. Automatic capture of clicks and typing is switched off, so no message text, budget amount, or form content reaches PostHog. Events are tied to your account ID, not your name or email. Like any web request, the one that carries an event also carries your IP address to PostHog's servers."],
    ["li", "Push notification tokens: if you enable notifications, we store the device token issued by Apple Push Notification service or Firebase Cloud Messaging."],
    ["li", "Cookies and on-device storage: we use no advertising cookies and nothing that follows you around other websites. Your browser or app keeps your sign-in token, your display preferences (theme, map style, the order of your flocks), and your last known coordinates so the map opens where you are. Those coordinates stay on the device. PostHog sets its own cookie to tell a repeat visit from a new one, on flockcorp.com and in the app."],
    ["li", "Connection metadata: your IP address is used for rate limiting and to spot abuse. It appears in our server logs, and it is stored in our database alongside email verification records so we can limit how many verification emails one address or one network can trigger. Those records are deleted when your account is deleted."],
    ["h3", "Location"],
    ["li", "Live location share: only when you explicitly turn it on inside an active flock, and only while you leave it on. Your coordinates are passed straight through our server to the other members of that flock and are never written to our database, so there is no trail of where you were. Blocked accounts are excluded from the hand-off. You can stop it at any time."],
    ["li", "SOS: when you press SOS, we email your trusted contacts with your current location, and we store that alert (your account, the coordinates, and how many contacts were emailed) so there is a record of what happened. It is deleted with your account. You can also send your trusted contacts your location without an SOS, from the Safety screen; that sends the same kind of email and is not stored. We never collect background location: Flock only reads your location while you are using it."],
    ["li", "Map, venue search, weather, and crowd levels: your device location centers the map on the device itself. When you search for venues, load the weather, or ask Birdie for somewhere nearby, your coordinates are sent to our server so it can run that lookup, and the search area (not your account) goes on to Google Places or OpenWeatherMap. We do not store those coordinates in our database or build a location history from them."],
    ["h3", "Anonymous budget data"],
    ["p", "Budget submissions are stored on our servers but the system is designed so individual amounts are never returned to other flock members. Other members only see aggregated values (group ceiling, count of submissions, ready state). This is a core product guarantee enforced in code."],
    ["h2", "Venue occupancy sensors"],
    ["p", "A venue can install a small Flock sensor near its entrance. It is the only part of Flock that is hardware, and it measures the room rather than the people in it. This section applies to everyone who walks into a venue that has one, whether or not you use Flock."],
    ["h3", "What the sensor sends us"],
    ["p", "Every 30 seconds it sends three numbers, and nothing else:"],
    ["li", "Doorway crossings: how many times an infrared beam across the doorway was broken since the last reading."],
    ["li", "Warm bodies in view: a count of heat clusters in a grid of 768 temperature readings. The count is worked out on the device."],
    ["li", "Ambient loudness: one loudness level, averaged over the last 30 seconds."],
    ["h3", "What it does not do"],
    ["li", "No photo or video. The thermal part is a 24 by 32 grid of temperatures, not a picture. It is reduced to a count on the device and thrown away. It is never stored and never sent to us."],
    ["li", "No audio recording. The microphone's samples become a single loudness figure every five seconds and are discarded on the device. No sound is stored, buffered, or transmitted, and speech cannot be recovered from a loudness level."],
    ["li", "No phone detection. No wifi or Bluetooth scanning, no MAC addresses, no beacons. Nothing reads a device in anyone's pocket."],
    ["li", "No identity. The sensor counts bodies. It cannot tell one person from another, it cannot tell whether you have a Flock account, and it does not know who you are."],
    ["p", "A reading is filed against the venue and the sensor that sent it, and it holds nothing else: no name, no account, no phone or device belonging to anyone in the room, nothing that separates one person from the next. So there is nothing in one to trace back to you."],
    ["h3", "What we do with the readings"],
    ["p", "They produce the \"Live Occupancy\" figure and the 12-hour chart on that venue's page in the app, and the same figures in that venue owner's dashboard. We keep them as a record of how busy the venue has been over time. Because they contain no identifiers, deleting your Flock account does not touch them and there is nothing in them belonging to you to delete. We do not currently delete them on a schedule."],
    ["p", "The occupancy card also shows how many Flock accounts checked in at that venue in the last hour. That is a count of separate accounts. No names go with it."],
    ["p", "If we ever put anything in this device that can tell one person from another, this section is rewritten before the device goes in."],
    ["h2", "How we use your information"],
    ["li", "Operate the core product (auth, flocks, chat, voting, notifications)."],
    ["li", "Send transactional email (email verification at sign-up, SOS alerts) via Resend."],
    ["li", "Send push notifications you opted into."],
    ["li", "Improve our crowd forecasts. Crowd reports people submit at a venue correct the live prediction for that venue and go into the data the model is retrained on. Sensor readings are described in section 3."],
    ["li", "Monitor reliability and diagnose errors to keep the app working."],
    ["li", "Detect abuse, spam, and security incidents."],
    ["li", "Comply with legal obligations."],
    ["p", "We do not sell your personal information. We do not use your messages or content to train third-party advertising models."],
    ["h2", "Who we share with"],
    ["p", "We share information only with service providers that help us run Flock, and only to the extent needed for that work. Current providers include:"],
    ["li", "Vercel (web hosting), Railway (server + PostgreSQL hosting)."],
    ["li", "Resend (transactional email)."],
    ["li", "Apple Push Notification service and Firebase Cloud Messaging (push delivery)."],
    ["li", "Google Places (venue search results; we send the search text and map area, not your account)."],
    ["li", "MapTiler (the maps in the app; your device loads map tiles directly from MapTiler, which sees your IP address and the area of the map you're viewing, not your account)."],
    ["li", "Google Cloud Vision (checks images you upload against our content rules before anyone can see them; the image is sent for that check only)."],
    ["li", "OpenWeatherMap (weather context for crowd predictions; no personal info sent)."],
    ["li", "Ticketmaster (event listings near you; we send the search area, not your account)."],
    ["li", "BestTime (aggregate venue popularity data; no personal info sent)."],
    ["li", "Apple and Google (sign-in identity verification, only when you choose those options)."],
    ["li", "RevenueCat (subscription receipts). Flock sells nothing today. In an iOS build where purchases are switched on, RevenueCat receives your account ID and the receipt the App Store issues, and nothing else. Your card details go to Apple, never to us and never to RevenueCat."],
    ["li", "PostHog (product analytics; usage events tied to your account ID, and the IP address the request arrives from)."],
    ["li", "Google Gemini (powers Birdie, the in-app assistant). When you chat with Birdie, your messages in that conversation, your first name, your age bracket (under 18, under 21, or adult, never your birthday), and your approximate location (rounded to about a kilometer, only if you've allowed location) are sent to Google to generate the reply. If you ask Birdie about your plans or friends, the names, venues, and times of your flocks and your friends' display names are included so it can answer. Birdie conversations are not used by us for advertising, and we don't send your email, exact coordinates, or messages from your flocks or DMs."],
    ["p", "Other flock members see content you share inside that flock (messages, RSVP status, live location while you have it on). Your trusted contacts receive an email with your current location when you press SOS."],
    ["p", "We may disclose information to comply with a valid legal process, to protect users from imminent harm, or in connection with a corporate transaction (we will notify you)."],
    ["h2", "How long we keep it"],
    ["li", "Account data: until you delete your account."],
    ["li", "Messages and flocks: retained while your account exists; deleted with your account. Deleting your account also deletes the flocks you created, along with the messages, RSVPs, and votes inside them, for everybody who was in them, and it removes your direct message threads from the other person's app as well."],
    ["li", "Stories: there is no way to post or see a story anywhere in the Flock app, so using Flock does not create one. Our server does support them: a story there stops being visible to everyone 24 hours after it is posted, and the row is then removed by a cleanup that runs at most once an hour and takes stories that expired more than 24 hours ago. A story that has been reported is held until the report is closed."],
    ["li", "Push notification tokens: deleted when you sign out on that device or delete your account."],
    ["li", "Reports and moderation records: kept after an account is deleted so our moderation history stays intact, but with the deleted account unlinked from them."],
    ["li", "Banned accounts: if an account is banned and its owner then deletes it, we keep a one-way hashed code of its email, phone number, and Apple or Google sign-in ID for 12 months. This stops a banned person from signing straight back up. The code can't be turned back into the original email or number, contains no name or content, and expires on its own after 12 months. Nothing like this is kept for accounts that weren't banned."],
    ["li", "Plan statistics: when a flock ends we keep one row per plan describing how it went: group size, whether a budget was used, the group's ceiling, how many people submitted, whether it was confirmed, how long that took, and where it stalled. It carries no names, no messages, and no individual budget amounts, and once the plan is deleted it is not linked to anyone. We keep these to understand where planning breaks down."],
    ["li", "Sensor readings: kept as venue history. They contain no identifiers. See section 3."],
    ["li", "Server logs: short-term, for security and debugging. Our hosting provider ages them out; we do not archive them."],
    ["li", "Backups: we take database backups, so information you deleted can still sit in a backup until that backup is deleted. Our written rule is that no backup is kept longer than 90 days, with one exception: an occasional archive kept so the crowd-model training data is never lost. Until we can export that data on its own, that archive is a copy of the whole database, which means it can still hold your information after you delete your account."],
    ["h2", "Your choices and rights"],
    ["li", "Access, correction, export, deletion: you can request any of these by emailing social@flockcorp.com. You can delete your account in the app (Profile → Delete account) or from our account deletion page. To protect your account, deleting it asks you to confirm your password, or to sign in again if you use Apple or Google."],
    ["li", "Push notifications: Flock asks before it sends any. To stop them, turn notifications off for Flock in your device settings. Signing out also deletes that device's push token from our servers."],
    ["li", "Live location: stop sharing at any time from within the flock."],
    ["li", "Marketing email: we don't send marketing email. Transactional email (security, SOS) cannot be turned off while your account is active."],
    ["li", "EU/UK users (GDPR): you have rights to access, rectification, erasure, restriction, objection, and portability. Contact us to exercise them. The lawful basis for our processing is performance of the user agreement and our legitimate interest in operating a safe service."],
    ["li", "California users (CCPA/CPRA): you have rights to know, delete, correct, and opt out of \"selling\" or \"sharing\" of personal information. We do not sell or share for cross-context behavioral advertising."],
    ["h2", "Children"],
    ["p", "Flock is intended for users 13 and older. We do not knowingly collect personal information from children under 13. If you believe a child under 13 has created an account, contact us and we will delete it."],
    ["h2", "Security"],
    ["p", "We use industry-standard safeguards: passwords hashed with bcrypt, parameterized database queries, rate limiting, HTTPS everywhere, JWT session tokens, security headers via Helmet. No system is perfectly secure; we work to mitigate and disclose incidents promptly."],
    ["h2", "International transfers"],
    ["p", "Our servers are located in the United States. If you use Flock from outside the U.S., your information will be transferred to and processed in the U.S. By using Flock, you consent to this transfer."],
    ["h2", "Changes to this policy"],
    ["p", "We may update this policy. We will post the new effective date at the top and, for material changes, give in-app notice before the change takes effect."],
    ["h2", "Contact"],
    ["p", "Questions, requests, or concerns? A human reads this inbox:"],
    ["p", "social@flockcorp.com"],
  ],
  terms: [
    ["h1", "Terms of Service & EULA"],
    ["p", "Effective August 14, 2026"],
    ["p", "These Terms of Service (\"Terms\") are a binding agreement between you and Flock Corp (\"Flock\", \"we\", \"us\"). By creating an account or using the Flock app, you agree to these Terms and to our Privacy Policy and Community Guidelines. If you do not agree, do not use Flock."],
    ["h2", "1. Eligibility"],
    ["p", "You must be at least 13 years old to use Flock. By using Flock you represent that you are 13 or older and that you can form a binding contract with us."],
    ["h2", "2. Your account"],
    ["p", "You are responsible for your account and for keeping your credentials secure. You agree to provide accurate information and to be responsible for activity on your account. You may delete your account at any time (see Section 8)."],
    ["h2", "3. Acceptable use & zero tolerance"],
    ["p", "Flock has zero tolerance for objectionable content and abusive users. You agree not to post, send, or share content that is unlawful, harassing, bullying, hateful, threatening, sexually explicit, exploitative of minors, or otherwise objectionable, and not to harass, abuse, impersonate, stalk, or harm other users. Our Community Guidelines describe prohibited content and behavior in detail and are part of these Terms."],
    ["p", "We may remove content and suspend or terminate accounts that violate these Terms. We act on reports of objectionable content and abusive behavior promptly, typically by removing the violating content and ejecting the responsible user, and we may report illegal content to the appropriate authorities."],
    ["h2", "4. User content"],
    ["p", "You retain ownership of the content you create. You grant Flock a limited license to host, store, and display your content solely to operate the service (for example, showing your messages to other members of your flock). You are responsible for the content you share and confirm you have the rights to share it."],
    ["p", "One narrower permission on top of that: when you report how busy a venue is, you allow us to use that report to correct our crowd predictions and to train the model that produces them. Nobody else is shown that you were the one who reported. This applies to crowd reports and to nothing else you post. Our Privacy Policy describes what is stored."],
    ["h2", "5. Reporting & moderation"],
    ["p", "Flock provides in-app tools to report objectionable content and to block abusive users. We review reports and take action under our Community Guidelines. You can also reach us at social@flockcorp.com."],
    ["h2", "6. Intellectual property & DMCA"],
    ["p", "Flock and its branding are owned by Flock Corp. If you believe content on Flock infringes your copyright, contact social@flockcorp.com with enough detail to identify the work and the allegedly infringing content, and we will respond in accordance with applicable law."],
    ["h2", "7. Payments"],
    ["p", "Flock is currently free to use. If we offer paid subscriptions in the future, the applicable price and terms will be shown at the point of purchase and billed through the App Store or Google Play. Subscriptions auto-renew unless cancelled through your store account."],
    ["h2", "8. Termination"],
    ["p", "You may stop using Flock and delete your account at any time from the app (Profile → Delete account) or via our account deletion page. Deleting your account also deletes every flock you created, including its chat, RSVPs, and votes, for everyone who was in it. Deletion is irreversible. We may suspend or terminate your access for violations of these Terms, and deleting a banned account does not lift the ban."],
    ["h2", "9. Disclaimers & limitation of liability"],
    ["p", "Flock is provided \"as is\" without warranties of any kind. To the maximum extent permitted by law, Flock is not liable for indirect, incidental, or consequential damages arising from your use of the service. Flock helps coordinate plans; you are responsible for your own safety and decisions when meeting others or going out."],
    ["h2", "10. Governing law & changes"],
    ["p", "These Terms are governed by the laws of the United States and the State of Pennsylvania, without regard to conflict-of-laws rules. We may update these Terms; we will post the new effective date and, for material changes, provide in-app notice."],
    ["h2", "11. Contact"],
    ["p", "Questions about these Terms: social@flockcorp.com."],
  ],
};

// Every public page, so a crawler that lands on one document can discover the
// rest. /guidelines and /delete-account have no bot rendering yet; the links
// still resolve for the JS-rendering crawlers and for humans.
const NAV_LINKS = [
  ['/', 'Home'],
  ['/about', 'About: what Flock is and how the crowd model works'],
  ['/support', 'Support and common questions'],
  ['/privacy', 'Privacy Policy'],
  ['/terms', 'Terms of Service'],
  ['/guidelines', 'Community Guidelines'],
  ['/delete-account', 'Delete your account'],
];

// Verbatim copy of the @graph in public/index.html, which is the response a
// bot would otherwise have received on these routes. Kept identical so the
// site describes one Organization and one WebApplication no matter which
// surface a crawler read. aiCrawlerSurface.test.js pins the two copies to
// each other. The editing rules (no fabricated ratings, no App Store sameAs
// until the listing resolves, generic operatingSystem, price 0 only while
// PAYWALL_ENABLED is unset) are documented in index.html and bind here too.
const SITE_GRAPH = [
  {
    '@type': 'Organization',
    '@id': 'https://www.flockcorp.com/#organization',
    name: 'Flock',
    legalName: 'Flock Corp',
    url: 'https://www.flockcorp.com/',
    email: 'social@flockcorp.com',
    description: 'Flock makes a free group planning app that turns a group chat into an actual plan.',
    logo: {
      '@type': 'ImageObject',
      '@id': 'https://www.flockcorp.com/#logo',
      url: 'https://www.flockcorp.com/logo512.png',
      width: 512,
      height: 512,
      caption: 'Flock',
    },
    founder: {
      '@type': 'Person',
      name: 'Jayden Bansal',
    },
    award: '1st place, PA DECA States',
  },
  {
    '@type': 'WebSite',
    '@id': 'https://www.flockcorp.com/#website',
    url: 'https://www.flockcorp.com/',
    name: 'Flock',
    description: 'Vote on where to go, see how busy it is before you leave, and split the bill after.',
    inLanguage: 'en-US',
    publisher: { '@id': 'https://www.flockcorp.com/#organization' },
  },
  {
    '@type': 'WebApplication',
    '@id': 'https://www.flockcorp.com/#app',
    name: 'Flock',
    url: 'https://www.flockcorp.com/',
    applicationCategory: 'SocialNetworkingApplication',
    operatingSystem: 'Any (runs in a web browser)',
    browserRequirements: 'Requires JavaScript.',
    description: 'Flock is a free group planning app. Start a flock, invite your people, vote on where to go, match budgets privately, and split the bill after.',
    publisher: { '@id': 'https://www.flockcorp.com/#organization' },
    offers: {
      '@type': 'Offer',
      price: '0',
      priceCurrency: 'USD',
      availability: 'https://schema.org/InStock',
    },
    featureList: [
      'Create a group plan and collect RSVPs in one tap',
      'Vote as a group on where to go',
      'Private budget matching that shows the group a ceiling, never an individual amount',
      'Bill splitting with Venmo, Cash App and Zelle links',
      'Crowd level estimates for how busy a venue will be tonight',
      'Birdie, an assistant that answers plain-language questions about where to go',
      'Live location sharing inside the group, off by default',
      'One-tap SOS to trusted contacts',
    ],
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Same escaper as invite-preview.js: & first, then the four that matter in
// attributes and element content.
function esc(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// The support FAQ is DERIVED from the blocks rather than stored twice, so the
// FAQPage JSON-LD can never disagree with the visible Q&A. It reads the h3/p
// pairs between the "Common questions" h2 and the next h2. If SupportPage
// restructures, this returns fewer pairs rather than wrong ones, and the
// drift test notices the block change first anyway.
function supportFaq(blocks) {
  const faq = [];
  let inQuestions = false;
  for (let i = 0; i < blocks.length; i += 1) {
    const [tag, text] = blocks[i];
    if (tag === 'h2') {
      inQuestions = /common questions/i.test(text);
    } else if (inQuestions && tag === 'h3' && blocks[i + 1] && blocks[i + 1][0] === 'p') {
      faq.push({ q: text, a: blocks[i + 1][1] });
    }
  }
  return faq;
}

function buildJsonLd(key) {
  const meta = PAGE_META[key];
  const url = CANONICAL_HOST + meta.path;
  const graph = SITE_GRAPH.slice();
  graph.push({
    '@type': 'WebPage',
    '@id': url + '#webpage',
    url: url,
    name: meta.title,
    description: meta.description,
    inLanguage: 'en-US',
    isPartOf: { '@id': 'https://www.flockcorp.com/#website' },
    about: { '@id': 'https://www.flockcorp.com/#app' },
  });
  if (key === 'support') {
    const faq = supportFaq(PAGE_BLOCKS.support);
    if (faq.length) {
      graph.push({
        // Same @id SupportPage.js injects client-side, so the two surfaces
        // describe one FAQPage entity, not two competing ones.
        '@type': 'FAQPage',
        '@id': 'https://www.flockcorp.com/support#faq',
        mainEntity: faq.map(({ q, a }) => ({
          '@type': 'Question',
          name: q,
          acceptedAnswer: { '@type': 'Answer', text: a },
        })),
      });
    }
  }
  return { '@context': 'https://schema.org', '@graph': graph };
}

// Blocks -> semantic HTML. Consecutive li blocks join into one <ul>.
function renderBlocks(blocks) {
  let html = '';
  let inList = false;
  for (const [tag, text] of blocks) {
    if (tag === 'li' && !inList) { html += '<ul>\n'; inList = true; }
    if (tag !== 'li' && inList) { html += '</ul>\n'; inList = false; }
    html += '<' + tag + '>' + esc(text) + '</' + tag + '>\n';
  }
  if (inList) html += '</ul>\n';
  return html;
}

// Minimal, matching the site's paper palette (see GuestInvite.css). This page
// is read by machines almost every time; the CSS exists for the rare human.
const PAGE_CSS = ''
  + ':root{--mp-paper:#f1ede0;--mp-ink:#16283d;--mp-ink-2:#3d4d63;--mp-accent:#2d5a87}'
  + '@media (prefers-color-scheme:dark){:root{--mp-paper:#0f172a;--mp-ink:#f4efe3;--mp-ink-2:#c5cbd6;'
  + '--mp-accent:#8fb4d6;color-scheme:dark}}'
  + '*{box-sizing:border-box}'
  + 'body{margin:0;background:var(--mp-paper);color:var(--mp-ink-2);'
  + "font-family:'Hanken Grotesk',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.6}"
  + 'main{max-width:44rem;margin:0 auto;padding:clamp(20px,5vw,48px) clamp(16px,5vw,40px) 72px}'
  + 'h1,h2,h3{color:var(--mp-ink);line-height:1.2;letter-spacing:-.01em}'
  + 'h1{font-size:clamp(28px,6vw,40px)}h2{margin-top:2em}'
  + 'a{color:var(--mp-accent)}'
  + 'nav{margin-top:56px;padding-top:20px;border-top:1px solid var(--mp-ink-2)}';

function renderPage(key) {
  const meta = PAGE_META[key];
  const blocks = PAGE_BLOCKS[key];
  const url = CANONICAL_HOST + meta.path;
  const title = esc(meta.title);
  const description = esc(meta.description);
  // <-escaping < is the standard guard against a "</script" sequence in
  // any string terminating the JSON-LD block early. Our copy is our own, but
  // the guard costs nothing.
  const jsonLd = JSON.stringify(buildJsonLd(key)).replace(/</g, '\\u003c');

  const nav = NAV_LINKS
    .map(([href, label]) => '<li><a href="' + esc(href) + '">' + esc(label) + '</a></li>')
    .join('\n');

  return '<!doctype html>\n'
    + '<html lang="en">\n'
    + '<head>\n'
    + '<meta charset="utf-8">\n'
    + '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
    + '<title>' + title + '</title>\n'
    + '<meta name="description" content="' + description + '">\n'
    + '<link rel="canonical" href="' + esc(url) + '">\n'
    + '<meta property="og:type" content="website">\n'
    + '<meta property="og:site_name" content="Flock">\n'
    + '<meta property="og:locale" content="en_US">\n'
    + '<meta property="og:title" content="' + title + '">\n'
    + '<meta property="og:description" content="' + description + '">\n'
    + '<meta property="og:url" content="' + esc(url) + '">\n'
    + '<meta property="og:image" content="' + OG_IMAGE + '">\n'
    + '<meta property="og:image:width" content="1200">\n'
    + '<meta property="og:image:height" content="630">\n'
    + '<meta property="og:image:alt" content="' + esc(OG_IMAGE_ALT) + '">\n'
    + '<script type="application/ld+json">' + jsonLd + '</script>\n'
    + '<style>' + PAGE_CSS + '</style>\n'
    + '</head>\n'
    + '<body>\n'
    + '<main>\n'
    + '<article>\n'
    + renderBlocks(blocks)
    + '</article>\n'
    + '<nav aria-label="Flock pages">\n'
    + '<ul>\n' + nav + '\n</ul>\n'
    + '<p>Flock Corp · <a href="mailto:' + CONTACT_EMAIL + '">' + CONTACT_EMAIL + '</a> · '
    + '<a href="' + CANONICAL_HOST + '/llms.txt">llms.txt</a></p>\n'
    + '</nav>\n'
    + '</main>\n'
    + '</body>\n'
    + '</html>\n';
}

// ---------------------------------------------------------------------------
// Request handling
// ---------------------------------------------------------------------------

// The rewrite supplies ?page=<key> and Vercel merges the request's original
// query alongside it, so a crafted /about?page=privacy arrives as two values
// in undefined order. Same policy as invite-preview.js readToken: an
// ambiguous value is treated as absent, and absent falls back to the home
// document, which is true on any route.
function pickOne(values) {
  const distinct = values.filter((v, i) => values.indexOf(v) === i);
  return distinct.length === 1 ? distinct[0] : undefined;
}

function readPageKey(req) {
  let value;
  const raw = req && req.query ? req.query.page : undefined;
  if (Array.isArray(raw)) value = pickOne(raw);
  else if (typeof raw === 'string') value = raw;

  if (value === undefined && req && typeof req.url === 'string') {
    try {
      const all = new URL(req.url, 'http://localhost').searchParams.getAll('page');
      if (all.length) value = pickOne(all);
    } catch (err) {
      // Unparseable url is just a missing key.
    }
  }
  return Object.prototype.hasOwnProperty.call(PAGE_BLOCKS, value) ? value : 'home';
}

function send(res, html) {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  // Vary: User-Agent is REQUIRED, not decorative: the CDN cache key is
  // host + path + query and knows nothing about the user-agent condition that
  // routed the request here. Without it, a human requesting /about could be
  // served this static document out of the edge cache instead of the React
  // app. Same reasoning, verbatim, as invite-preview.js.
  res.setHeader('Vary', 'User-Agent');
  // Content is fully static per deploy, so the edge may hold it for an hour;
  // a deploy purges the CDN anyway.
  res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=3600, stale-while-revalidate=86400');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.end(html);
}

async function handler(req, res) {
  let key = 'home';
  try {
    key = readPageKey(req);
    const html = renderPage(key);
    res.setHeader('Link', '<' + CANONICAL_HOST + PAGE_META[key].path + '>; rel="canonical"');
    send(res, html);
  } catch (err) {
    // Never a 500: a crawler that caches a failure poisons the answer index.
    // The floor is a minimal true document, not an error page.
    console.error('marketing-page: fallback document:', (err && err.name) || 'Error');
    try {
      send(res, '<!doctype html>\n<html lang="en"><head><meta charset="utf-8">'
        + '<title>Flock | Plans that actually happen</title>'
        + '<meta name="description" content="Flock is a free group planning app. Vote on where to go, see how busy it is before you leave, and split the bill after.">'
        + '</head><body><main><h1>Flock</h1>'
        + '<p>Flock is a free group planning app. Start a flock, invite your people, vote on where to go, match budgets privately, and split the bill after.</p>'
        + '<p><a href="https://www.flockcorp.com/">flockcorp.com</a></p>'
        + '</main></body></html>\n');
    } catch (sendErr) {
      // Headers already flushed; throwing here would be the 500 this file
      // exists to avoid.
    }
  }
}

module.exports = handler;

// Named handles for unit testing. Vercel treats the function itself as the
// handler and ignores extra properties hung off it.
module.exports.PAGE_META = PAGE_META;
module.exports.PAGE_BLOCKS = PAGE_BLOCKS;
module.exports.NAV_LINKS = NAV_LINKS;
module.exports.SITE_GRAPH = SITE_GRAPH;
module.exports.supportFaq = supportFaq;
module.exports.buildJsonLd = buildJsonLd;
module.exports.renderPage = renderPage;
module.exports.renderBlocks = renderBlocks;
module.exports.readPageKey = readPageKey;
module.exports.esc = esc;
