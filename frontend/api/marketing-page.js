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
    description: 'What Flock collects, what Birdie and Roost send to Google, how location and photos are handled, what venue sensors do not send, and how to delete it all.',
  },
  terms: {
    path: '/terms',
    title: 'Terms of Service and EULA | Flock',
    description: 'The terms and EULA for Flock: age, acceptable use, reporting and blocking, your content, venue and Roost terms, subscriptions, and what we do not promise.',
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
    ["p", "Effective August 21, 2026"],
    ["h2", "The short version"],
    ["li", "We collect what Flock needs to work: your account, your plans, your messages."],
    ["li", "Location is used only while you're using the app. Never in the background."],
    ["li", "We don't sell your information, we don't share it for advertising, and we don't run ads."],
    ["li", "Budget amounts are never shown to other people. The group only sees a shared ceiling."],
    ["li", "Photos you upload have their hidden camera data, including any GPS fix, removed before we store them."],
    ["li", "Two features send text to Google's Gemini: Birdie, the assistant in the app, and Roost, the advisor for venue owners. Each has its own paragraph below saying exactly what leaves."],
    ["li", "A few venues have a Flock sensor at the door. It counts bodies and cannot identify anyone. Section 3 says exactly what it measures."],
    ["li", "You can delete your account from inside the app. It's a real delete, not a deactivation."],
    ["p", "The full detail is below. It's written in plain language on purpose. If anything is unclear, email social@flockcorp.com."],
    ["h2", "Who we are"],
    ["p", "Flock is a social coordination app that helps you plan nights out with friends. Flock (\"we\", \"us\", \"our\") is operated by Flock Corp. We are the data controller for personal information processed through the Flock app, flockcorp.com, the venue dashboard, and the venue sensors described in section 3."],
    ["p", "This policy covers all of those. It applies whether you use Flock on iOS, on Android, or in a browser, whether you have an account or answer an invite link as a guest, and whether you use Flock to make plans or to run a venue. Write to us at social@flockcorp.com."],
    ["h2", "What we collect"],
    ["h3", "You provide directly"],
    ["li", "Account info: email, password (stored as a one-way hash, we never see your password), display name, optional avatar, optional short bio. We send a link to your email at sign-up to confirm it's really yours. Your friend code is worked out from your account number when you ask for it, so there is no separate code stored anywhere."],
    ["li", "Phone number (optional): sign-up never asks for one. You can add a phone number later from your profile so friends who already have your number can find you. Adding one requires confirming your password or a recent sign-in."],
    ["li", "Contacts you choose to match (optional): if you use \"Add friends\" from your phone contacts, the numbers you pick are sent to our server once to check for existing Flock accounts. We run the lookup and don't store those numbers."],
    ["li", "Date of birth: collected at sign-up so we can confirm you're 13 or older. The check runs on our server, which recalculates your age from the date rather than trusting what the app says."],
    ["li", "Your acceptance of the terms: we store the moment you agreed to the Terms of Service, so both of us know what you agreed to and when."],
    ["li", "Interests: the tags you pick on your profile, such as live music or trivia. They are kept on your device and synced to your account so a second device agrees with the first."],
    ["li", "Trusted contacts: if you add emergency contacts, we store the name, phone, email, and relationship you give us. SOS alerts are sent by email only. We store the phone number because the form asks for it and you may want it on file, but nothing in Flock texts or calls it."],
    ["li", "Messages and content: flock chat messages, direct messages, emoji reactions, images you upload, venue reviews you write."],
    ["li", "Plans and votes: flocks you create or join, RSVPs, venue votes, budget submissions, check-ins (including NFC taps at a venue), and the venues you pin or vote on inside a direct message."],
    ["li", "Your calendar entries: anything you add to your Flock calendar (title, venue, date, time) is stored on our servers so it is there on your next device. It is yours alone; nobody else is shown it."],
    ["li", "Availability status: if you set \"down tonight\" or similar, we store that status, the note you attach, and when it expires. Your friends can see it until it expires or you clear it."],
    ["li", "Crowd reports: when you tell us how busy a venue actually is, we store that report with your account, the venue, and the time. We use it to correct our crowd predictions and to train the model that makes them. Other people see the corrected prediction, never that you were the one who reported."],
    ["li", "Reports and blocks: if you report content or block someone, we store what you reported, who you blocked, and what we did about it. Blocking is mutual, and it also ends the friendship if you had one."],
    ["li", "Guest RSVPs: if someone opens a flock invite link without a Flock account, we store the display name they type and the venues they vote for, tied to a random link token. No email, no phone, no account is created for them."],
    ["li", "Bill splits: if your group splits a bill, we store the total, the tip, who paid, each person's share, and whether a share has been marked settled. The people in that flock see it. No money moves through Flock: paying someone back happens in Venmo, Cash App, or Zelle."],
    ["li", "Payment handles (optional): if you add them for bill-splitting, we store your Venmo username, Cash App cashtag, or Zelle identifier so flockmates can pay you back. These are usernames and handles only. Flock never collects or processes card, bank-account, or payment-card numbers."],
    ["li", "Venue owner details (optional): if you claim a venue, we store the business profile you fill in, the operating facts you tell us, and the promotions, events, occupancy readings and replies you post. That has its own section below, Venue owners and business data."],
    ["li", "Waitlist email: if you enter your email on flockcorp.com to hear when Flock launches, we store that address and send you one confirmation. It is not linked to any Flock account, we do not sell it, every message carries an unsubscribe link, and we will delete it if you ask us at social@flockcorp.com."],
    ["li", "Sign-in tokens: if you sign in with Apple or Google, we receive an identity token from the provider, verify it, and issue our own session token. Apple accounts have one extra piece: Apple's rules say deleting your Flock account should also revoke Flock's access to your Apple ID, and doing that needs a refresh token from Apple that we store for that single purpose. When you delete your account, we use it to revoke Flock's access to your Apple ID, and the token is deleted with the rest of your data. After that, Flock no longer appears under Sign in with Apple in your Apple ID settings."],
    ["h3", "Photos, and what is hidden inside them"],
    ["p", "A photo from a phone carries more than the picture. The file can hold the exact spot it was taken, accurate to a few metres, the make and model of the camera, the moment of capture, and on many cameras a small copy of the original frame from before you cropped it. None of that shows up in any app, so nobody knows they sent it."],
    ["p", "Before we store an image you upload, our server strips that hidden data out. It covers avatars, chat photos and direct message photos, in JPEG, PNG and WebP, which is what phones produce. What comes off is the EXIF, XMP and IPTC blocks: GPS position, device identifiers, capture times, embedded thumbnails, and free-text comments. What stays is the colour profile, because dropping that changes how the picture looks. The picture itself is not re-encoded, so nothing about its quality changes. If a file does not parse the way its format says it should, we store it unchanged rather than risk corrupting it, and we do not claim to have cleaned it."],
    ["p", "Every image is also screened against our content rules before anyone can see it. That check is described under Who we share with and in our Community Guidelines."],
    ["h3", "We collect automatically"],
    ["li", "Product analytics: we use PostHog. The detail, including the long list of things we have switched off, is in Analytics, error reports, and email."],
    ["li", "Push notification tokens: if you enable notifications, we store the device token issued by Apple Push Notification service or Firebase Cloud Messaging."],
    ["li", "What we showed you: when the app shows you a crowd prediction for a venue, we record the venue, the number we published, which model produced it, and when. That record is what lets us check the prediction against what you or the venue later reported, which is how the model gets better. It is tied to your account and kept for 180 days."],
    ["li", "Check-ins: a check-in inside the app is stored with your account and the venue. A tap on an NFC tag at a venue while you are signed out is stored with the venue and no account at all."],
    ["li", "Reliability: when a plan ends, the host can mark who turned up. We keep a running score from that on your account, and the people in a flock with you can see it. It is a number about attendance and nothing else."],
    ["li", "On-device storage: your browser or app keeps your sign-in token, your display preferences (theme, map style, the order of your flocks), your interests, and your last known coordinates so the map opens where you are. Those coordinates stay on the device. PostHog keeps its identifier in local storage rather than in a cookie, so no analytics cookie rides on requests and clearing site data removes it."],
    ["li", "Connection metadata: your IP address is used for rate limiting and to spot abuse. It appears in our server logs. Two places also write it to the database: the record of an email verification link, so we can limit how many verification emails one address or one network can trigger, and the record of a password reset request, which holds the requesting address next to a one-way hash of the email and is deleted after 7 days. Verification records are deleted when your account is deleted."],
    ["h3", "Location"],
    ["li", "Live location share in a flock: only when you explicitly turn it on inside an active flock, and only while you leave it on. Your coordinates are passed straight through our server to the other members of that flock and are never written to our database, so there is no trail of where you were. Blocked accounts are excluded from the hand-off. You can stop it at any time."],
    ["li", "Live location share in a direct message: the same thing, one to one. It reaches only the person you are talking to, only while you leave it on, only if the two of you are connected, never anyone either of you has blocked, and it is not written to our database either."],
    ["li", "SOS: when you press SOS, we email your trusted contacts with your current location, and we store that alert (your account, the coordinates, and how many contacts were emailed) so there is a record of what happened. It is deleted with your account. You can also send your trusted contacts your location without an SOS, from the Safety screen; that sends the same kind of email and is not stored. We never collect background location: Flock only reads your location while you are using it."],
    ["li", "Map, venue search, weather, events, and crowd levels: your device location centers the map on the device itself. When you search for venues, load the weather, look for events nearby, or ask Birdie for somewhere close, your coordinates are sent to our server so it can run that lookup, and the search area, not your account, goes on to Google Places, OpenWeatherMap or Ticketmaster. We do not store those coordinates in our database and we do not build a location history from them."],
    ["li", "Coordinates stay out of analytics: a few of those lookups carry your position inside the web address they request. Anything shaped like a coordinate is replaced with the word \"redacted\" before any analytics or error report leaves your device, in the address, in the referrer, in breadcrumbs, and in performance traces. A place name you typed is left readable, because a place name is not a position."],
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
    ["li", "Operate the core product: accounts and sign-in, flocks, chat, voting, budgets, bill splits, the calendar, notifications."],
    ["li", "Show you crowd predictions, venue details, weather and nearby events for the area you are looking at."],
    ["li", "Send transactional email (email verification at sign-up, password resets, SOS alerts) through Resend."],
    ["li", "Send push notifications you opted into, including the crowd alerts for a plan you have confirmed."],
    ["li", "Answer questions in Birdie, and answer venue owners' questions in Roost. Both are described in Birdie and Roost."],
    ["li", "Improve our crowd forecasts. Crowd reports people submit at a venue correct the live prediction for that venue and go into the data the model is retrained on. Venue owners' occupancy readings do the same. Sensor readings are described in section 3."],
    ["li", "Screen text and images against our content rules before they are stored, and act on reports of content and behaviour that break them."],
    ["li", "Keep the service up: monitor reliability, diagnose errors, rate limit, and stop abuse, spam and account takeovers."],
    ["li", "Understand how Flock is used, at the level of counts and events rather than content."],
    ["li", "Comply with legal obligations, including child-safety reporting."],
    ["p", "We do not sell your personal information. We do not share it for cross-context behavioural advertising. We do not run ads, and we do not use your messages or your content to train advertising models, ours or anybody else's."],
    ["h2", "Our legal bases"],
    ["p", "If you are in the EEA or the UK, the law wants us to say why each kind of processing is lawful. Here it is, plainly."],
    ["li", "Performing our agreement with you: your account, your flocks, chat and direct messages, votes, RSVPs, budgets, bill splits, the calendar, venue search, crowd predictions, the venue dashboard, and the transactional email that keeps an account working. Without these there is no product to deliver."],
    ["li", "Your consent: location, push notifications, access to your photo library or camera, matching your phone contacts, and the waitlist email. Each of those is asked for and each can be withdrawn, in your device settings or by clearing the thing you set. Withdrawing consent does not undo processing that already happened."],
    ["li", "Our legitimate interests: keeping Flock safe and working. Rate limiting, abuse and fraud prevention, moderation and the records it produces, error monitoring, product analytics at the level of counts, and improving the crowd model from reports people choose to file. We have weighed these against your interests, which is why the analytics are configured the way Analytics, error reports, and email describes and why the model's training data carries no account identifiers."],
    ["li", "Legal obligation: responding to lawful requests, and reporting apparent child sexual abuse material to the National Center for Missing and Exploited Children or the relevant authority."],
    ["li", "Vital interests: the SOS feature. When you press it, we email your trusted contacts your location because you are telling us something is wrong."],
    ["p", "Where we rely on legitimate interests, you can object. See If you are in the EEA or the UK."],
    ["h2", "Birdie and Roost"],
    ["p", "Flock has two features that send text to a large language model. Both use Google's Gemini API. They are separate features with separate audiences and separate payloads, so they get separate paragraphs. Neither one has any ability to write to your account, post on your behalf, or change anything. They read and they answer."],
    ["h3", "Birdie, the assistant in the app"],
    ["p", "When you chat with Birdie, what goes to Google to produce the reply is your first name, your age bracket (under 18, under 21, or adult, never your birthday), your messages in that conversation, and, only if you have allowed location, your approximate position rounded to about a kilometer. If you ask Birdie about your plans or your friends, the names, venues and times of your flocks and your friends' display names are included so it can answer. When Birdie looks up a venue, the venue and the crowd numbers we hold for it go with the question."],
    ["p", "What is not sent: we don't send your email, exact coordinates, or messages from your flocks or your direct messages. The roster of who is in a flock is replaced by a count. Birdie conversations are not used by us for advertising and we do not use them to train any model of our own. What Google may do with the text it receives is governed by Google's own terms for the Gemini API."],
    ["p", "Birdie's answers are generated. They can be wrong. Nothing Birdie says is advice about your safety, your health, your money, or the law."],
    ["h3", "Roost, the advisor for venue owners"],
    ["p", "Roost is the paid product for venue owners, and it works two ways. You can tap one of the suggested questions, or you can type your own question about your business."],
    ["p", "When you tap a suggested question, what goes to Google is the identifier of that question and a block of facts our server has already computed about your venue: things like your projected peak hour, your own recent occupancy readings, the operating facts you gave us at intake, the weather, the ticketed events listed near you, and where your venue sits inside its cohort. The model's only job there is wording. Every number in the answer is put back in by our server afterwards, and an answer that contains a number the model wrote is thrown away unread."],
    ["p", "When you type your own question, the question itself goes to Google as well, inside the same request. It is capped at 280 characters and stripped of control characters first. It is used to route your question and, where the answer is general trade advice rather than a reading of your own numbers, to write that advice."],
    ["p", "What Roost does not send: nothing about any Flock user. No consumer's name, account, message, budget, or position. No other venue's identity or figures. The cohort comparison your answer may draw on is an aggregate, and it is only computed when at least five venues other than yours have reported. See Venue owners and business data."],
    ["p", "What Roost stores: not your question. We keep counts, how many questions your venue asked today and how many tokens they cost, so we can meter the feature. The text of a typed question is not written to our database."],
    ["p", "Roost is an analyst, not an oracle. Every figure it quotes carries its source and its date. Where our data cannot answer, it refuses instead of guessing. Predictions are estimates. Nothing Roost says is a guarantee about how your business will do, and nothing it says is legal, tax, employment or financial advice."],
    ["h2", "Venue owners and business data"],
    ["p", "Venues appear on Flock whether or not anybody claims them, because listings are built from public sources such as Google Places and from what Flock users post. Claiming a venue does not create the listing; it gives you tools to manage your side of it. This section is about what we collect from the person and the business behind a claimed venue."],
    ["p", "A venue account is an ordinary Flock account, so everything above applies to it too. On top of that we store:"],
    ["li", "Your business profile: business name, category, location, description, phone, operating hours, logo or photo, goals, and the Google place your venue corresponds to. This is shown publicly in the app."],
    ["li", "Operating facts you tell us: when the kitchen stops, your capacity, how long a table usually turns, your age policy, your reservation policy, the largest walk-in group you take, your typical spend per person, what you believe your busy nights are, and what sits near you that pulls a crowd. Google's opening hours describe your door, not your pass, so this is the only place these facts exist. We use them to answer your own questions and to give groups useful answers about your venue. They are not features in the crowd model."],
    ["li", "Occupancy readings you post: the 0 to 100 slider. Every reading is stored with your account, your venue, and the time. It is shown to users attributed to you, in your venue's own words, never as Flock's own estimate, and it expires by itself 90 minutes after you set it. You can retract one. Retracted and expired readings are not deleted, because a labelled observation of a venue-hour is exactly what the crowd model learns from, which is the other half of why this feature exists."],
    ["li", "What you post to your listing: promotions, events, and replies to reviews. Public, and screened by the same moderation rules as anything else."],
    ["li", "Records about your account: your tier, any comped tier we granted, whether the weekly digest is switched on, and the digest sends we have made."],
    ["h3", "What we do with what you submit"],
    ["p", "Your occupancy readings do three things. They set the live number users see at your venue while they are fresh. They become training labels for the crowd model, which serves every venue, not only yours. And once enough venues in one city and category are reporting, they contribute to a cohort figure that answers the question every operator asks: was it just us, or was everyone slow."],
    ["p", "That cohort figure is built so that no venue's own number can be read out of it. It is not published at all until at least five venues other than the one asking have reported into the same city, category, night and hour band, which is a higher floor than we use anywhere else, because a venue is a pin on a public map with a name and an address and the set of them is short enough to count. The statistic published is a value some venue actually posted, never an interpolation, and the most anyone can learn about another venue's reading is which published band it fell in."],
    ["p", "Readings are accountable in the other direction too. When three or more verified users in the room contradict a live owner reading by a wide margin, we mark it, and repeated divergence suspends the override for that venue so users see our own estimate again."],
    ["h3", "What venue owners see, and do not see"],
    ["p", "The dashboard shows counts and curves built from Flock activity: how many groups considered the venue, check-in counts, predicted busyness, review text that is already public. It never shows individual users' identities, their budgets, their positions, their messages, or who voted for what. The advisor that reads this data is structurally forbidden from touching budgets at all."],
    ["p", "Venue billing is not switched on. Nothing in the venue dashboard costs money today and no payment method is collected. See the venue section of our Terms of Service for what happens when that changes."],
    ["h2", "Who we share with"],
    ["p", "We share information only with the companies that help us run Flock, and only as much as the job needs. This is the whole list, taken from the dependency inventory the codebase keeps of every outside service Flock touches. Each entry says what that company receives."],
    ["h3", "They run Flock itself"],
    ["li", "Railway hosts our server and our PostgreSQL database. Everything described in this policy that is stored is stored there. Railway's Postgres also writes a continuous backup to object storage."],
    ["li", "Vercel hosts flockcorp.com and the web build of the app. It sees the requests your browser makes for the site, including your IP address."],
    ["h3", "They receive something about you"],
    ["li", "Resend sends our email. It receives your email address and the contents of the message: the verification link, a password reset, an SOS alert with your location, the waitlist confirmation, the Monday venue digest. It also tells us when an address bounces or someone marks a message as spam, which is how our do-not-mail list gets written."],
    ["li", "Apple Push Notification service and Firebase Cloud Messaging deliver push notifications. They receive the device token and the notification."],
    ["li", "Google Cloud Vision screens every image you upload against our content rules before anyone can see it. The image is sent for that check and for nothing else. If the check cannot run, the upload is refused rather than let through."],
    ["li", "Google Gemini powers Birdie and Roost. Birdie and Roost says exactly what each of them sends."],
    ["li", "PostHog receives product analytics events tied to your account number, and the IP address the request arrives from. It also receives the cost and speed measurements behind Birdie: token counts and latency, never the words. See Analytics, error reports, and email."],
    ["li", "Apple and Google verify sign-in identity, only when you choose those options. Apple additionally receives the revocation call when you delete an account you created with Sign in with Apple."],
    ["li", "MapTiler and CARTO serve the map tiles. Your device loads tiles from them directly, so whichever one is in use sees your IP address and the area of the map you are looking at. It does not see your account."],
    ["li", "DiceBear serves the default avatar for an account with no photo. Your device loads that image directly, so it sees your IP address and nothing else."],
    ["li", "RevenueCat would handle subscription receipts. Flock sells nothing today and the paywall has never been switched on. In a build where purchases are on, RevenueCat receives your account number and the receipt the App Store issues, and nothing else. Your card details go to Apple, never to us and never to RevenueCat."],
    ["li", "Sentry would receive crash and error reports. It is wired up and switched off. Analytics, error reports, and email says what would happen if it were turned on."],
    ["h3", "They receive a place or a search, not a person"],
    ["li", "Google Places returns venue search results, venue details, nearby venues for a venue owner's competitor view, and venue photos. We send the search text and the map area, never your account."],
    ["li", "OpenWeatherMap returns the weather for an area, which the crowd model reads as an input. No personal information is sent."],
    ["li", "Ticketmaster returns ticketed events near an area, which the crowd model also reads. We send the search area, not your account."],
    ["h3", "They receive nothing about anyone"],
    ["li", "BestTime is where the crowd model's original training corpus came from. Collection stopped in May 2026 and the corpus is frozen. No part of the running product calls it."],
    ["li", "SeatGeek is a second event source used only by offline training scripts. No server code reads it."],
    ["li", "Venmo, Cash App and Zelle are opened as links from your phone. There is no integration and no account. Flock builds a web address and your phone opens it. No money and no payment detail moves through Flock."],
    ["li", "Codemagic builds the iOS app, GitHub Actions scans our code for leaked secrets, and the development tools we write Flock with never touch the product. None of them receives user data."],
    ["h3", "The people around you"],
    ["p", "Other members of a flock see what you share inside it: your messages, your RSVP, your vote, your reliability score, and your live location while you have it turned on. The person you are in a direct message with sees what you send them. Your friends see your availability status while it is set. Your trusted contacts receive an email with your current location when you press SOS. A venue owner sees the reviews written about their venue, including yours."],
    ["h3", "Everyone else"],
    ["p", "We may disclose information to comply with a valid legal process, to protect people from imminent harm, to report apparent child sexual abuse material as the law requires, or in connection with a merger or sale of the business, in which case we will tell you before your information becomes subject to a different policy."],
    ["p", "We do not sell personal information, and we do not share it with anyone for advertising."],
    ["h2", "Analytics, error reports, and email"],
    ["h3", "Product analytics, with PostHog"],
    ["p", "We use PostHog to understand how Flock is used: pages viewed, and a short list of events we write by hand, such as signing up, logging in, creating a flock, sharing an invite link, and submitting a crowd report. Events are tied to your account number, never to your name or your email, and only signed-in people get a profile at all. Like any web request, the one that carries an event also carries your IP address to PostHog's servers."],
    ["p", "The youngest person allowed on Flock is 13, so the settings are written to collect as little as they can, in code rather than in a dashboard where a toggle could widen them later:"],
    ["li", "Automatic capture of clicks and typing is switched off, so no message text, budget amount or form content reaches PostHog."],
    ["li", "Session replay is off. Nothing records your screen."],
    ["li", "Heatmaps, dead-click capture, error autocapture and in-app surveys are all off."],
    ["li", "A browser that sends a Do Not Track signal is not tracked."],
    ["li", "Advertising click identifiers are masked, and invite tokens and coordinates are scrubbed out of every property before an event leaves your device."],
    ["li", "We ask PostHog not to derive a city or region from your IP address."],
    ["li", "PostHog keeps its identifier in your device's local storage rather than in a cookie."],
    ["p", "Birdie has one extra measurement. Every call to the model records how many tokens it used and how long it took, against your account number. The words are deliberately left out: PostHog is where we measure cost and speed, not where conversations go."],
    ["h3", "Crash and error reporting, with Sentry"],
    ["p", "Sentry is wired into both the app and the server and it is not switched on. With no connection string configured, the code never starts it and the software is not even downloaded to your device, so no crash report is being sent anywhere today."],
    ["p", "If we turn it on, this is what it will do. Sentry will receive unhandled errors and a sample of performance traces: the error, where in our code it happened, the page or request it happened on, and the recent steps that led to it. Before any of that leaves your device, invite tokens and anything shaped like a coordinate are replaced with the word \"redacted\", in the address, in the referrer, in breadcrumbs, in the trace name, and in the individual spans. We do not attach your name or your email to a Sentry event. We will update the effective date on this page when it is switched on."],
    ["h3", "Email, and how to stop it"],
    ["p", "Flock sends two kinds of email. Transactional email keeps your account working: the verification link at sign-up, a password reset you asked for, and SOS alerts to your trusted contacts. Those cannot be turned off while your account is active, because turning them off would break the account."],
    ["p", "Everything else is optional and every message carries an unsubscribe link that works without signing in. The waitlist confirmation and the Monday venue digest both do. The digest is off by default and only sends if a venue owner switches weekly reports on. Unsubscribing writes your address to a do-not-mail list that is checked inside the one function every outgoing message in Flock passes through, so nothing can walk past it. An address that hard-bounces or is reported as spam is added to the same list automatically."],
    ["p", "One deliberate exception: unsubscribing from a list does not stop a password reset or an SOS alert. Those are different in kind, and a bounce is not a reason to swallow one."],
    ["h2", "How long we keep it"],
    ["li", "Account data: until you delete your account."],
    ["li", "Messages, flocks, calendar entries, bill splits, votes and budgets: retained while your account exists; deleted with your account. What that takes with it is described in Deleting your account."],
    ["li", "Crowd reports you file: kept while your account exists and deleted with it. A model that has already been trained on a report does not forget it, and the training set itself carries no account numbers."],
    ["li", "Predictions we served you: 180 days, then deleted automatically."],
    ["li", "Availability status: expires at the time you set. You can clear it yourself."],
    ["li", "Invite links: expire 14 days after they are created, or a week after the plan, whichever comes first."],
    ["li", "Password reset requests: the record of one, which holds the requesting IP address and a one-way hash of the email, is deleted after 7 days."],
    ["li", "Stories: there is no way to post or see a story anywhere in the Flock app, so using Flock does not create one. Our server does support them: a story there stops being visible to everyone 24 hours after it is posted, and the row is then removed by a cleanup that runs at most once an hour and takes stories that expired more than 24 hours ago. A story that has been reported is held until the report is closed."],
    ["li", "Push notification tokens: deleted when you sign out on that device or delete your account."],
    ["li", "Do-not-mail entries: kept for as long as the address should not be mailed. Removing it is what would let mail resume, so it has no expiry."],
    ["li", "Reports and moderation records: kept after an account is deleted so our moderation history stays intact, but with the deleted account unlinked from them."],
    ["li", "Banned accounts: if an account is banned and its owner then deletes it, we keep a one-way hashed code of its email, phone number, and Apple or Google sign-in ID for 12 months. This stops a banned person from signing straight back up. The code can't be turned back into the original email or number, contains no name or content, and expires on its own after 12 months. Nothing like this is kept for accounts that weren't banned."],
    ["li", "Plan statistics: when a flock ends we keep one row per plan describing how it went: group size, whether a budget was used, the group's ceiling, how many people submitted, whether it was confirmed, how long that took, and where it stalled. It carries no names, no messages, and no individual budget amounts, and once the plan is deleted it is not linked to anyone. We keep these to understand where planning breaks down."],
    ["li", "Venue occupancy readings by owners: kept indefinitely, including retracted and expired ones, because each is a labelled observation the crowd model learns from. They are deleted if the venue account is deleted."],
    ["li", "Venue digest send records: 90 days, then deleted."],
    ["li", "Cached venue photos from Google: 30 days, then re-fetched."],
    ["li", "Sensor readings: kept as venue history. They contain no identifiers. See section 3."],
    ["li", "Waitlist emails: kept until you unsubscribe or ask us to delete the address."],
    ["li", "Server logs: short-term, for security and debugging. Our hosting provider ages them out; we do not archive them."],
    ["li", "Backups: we take database backups, so information you deleted can still sit in a backup until that backup is deleted. Our written rule is that no backup is kept longer than 90 days, with one exception: an occasional archive kept so the crowd-model training data is never lost. Until we can export that data on its own, that archive is a copy of the whole database, which means it can still hold your information after you delete your account."],
    ["h2", "Deleting your account"],
    ["p", "You can delete your account from inside the app (Profile → Delete account) or from our account deletion page. It is a real delete, not a deactivation, and it cannot be undone. To protect your account, deleting it asks you to confirm your password, or to sign in again if you use Apple or Google."],
    ["p", "What is erased"],
    ["li", "Your account row and everything hanging off it: email, password hash, phone, date of birth, display name, avatar, bio, interests, payment handles, and your settings."],
    ["li", "Every message you sent in a flock chat, and your direct messages. A direct message belongs to both people, so deleting your account removes your direct message threads from the other person's app as well, along with anything pinned or voted on inside them."],
    ["li", "Every flock you created, including its chat, RSVPs and votes, for everybody who was in it. Flocks you only joined survive; your membership in them does not."],
    ["li", "Your crowd reports, your check-ins, your calendar entries, your availability status, your budget submissions, your bill split shares, your trusted contacts, your SOS alert records, your emoji reactions, your friendships, your blocks, your push tokens, your email verification records, and the record of the predictions we served you."],
    ["li", "Your venue profile and everything on it, if you had one, including your occupancy readings, promotions and events."],
    ["li", "If you signed in with Apple, the refresh token we held, after we use it to revoke Flock's access to your Apple ID."],
    ["p", "What survives, and why"],
    ["li", "Moderation records. Reports filed about content and the actions taken on them stay, with your account unlinked from them, so somebody cannot erase an open report about themselves by deleting their account. The de-attribution and the delete happen together: either both worked or neither did."],
    ["li", "A ban tombstone, but only if the account was banned. A one-way hashed code of the email, phone and sign-in ID, for 12 months, so a banned person cannot sign straight back up. Nothing like it is kept for an account that was not banned."],
    ["li", "One row per finished plan, with no names, no messages and no individual amounts, as described under How long we keep it."],
    ["li", "Sensor readings, which never contained anything belonging to you. See section 3."],
    ["li", "Backups, until they age out."],
    ["li", "Anything already learned by the crowd model. A trained model is not a database and cannot have one row removed from it. The training data itself carries no account numbers."],
    ["p", "If you would rather have a copy of your data before you delete it, ask us at social@flockcorp.comand we will send you one."],
    ["h2", "Your choices and rights"],
    ["li", "Access, correction, export, deletion: you can request any of these by emailing social@flockcorp.com. An export is a machine-readable copy of your account, your plans, your messages, your reports and everything else listed under What we collect. You can delete your account yourself in the app (Profile → Delete account) or from our account deletion page. To protect your account, deleting it asks you to confirm your password, or to sign in again if you use Apple or Google."],
    ["li", "Location: Flock asks before it reads your location and never reads it in the background. You can turn the permission off for Flock in your device settings at any time. The map then opens on a default area and venue search asks you where to look."],
    ["li", "Live location sharing: stop at any time from within the flock or the conversation you started it in."],
    ["li", "Push notifications: Flock asks before it sends any. To stop them, turn notifications off for Flock in your device settings. Signing out also deletes that device's push token from our servers."],
    ["li", "Photos and contacts: both are asked for at the moment you use them, and both can be withdrawn in your device settings. Phone numbers you matched were never stored."],
    ["li", "Email: we don't send marketing email. Optional email, which today means the waitlist confirmation and the Monday venue digest, carries an unsubscribe link in every message and needs no sign-in. Transactional email cannot be turned off while your account is active."],
    ["li", "Blocking and reporting: you can block anyone and report any message, profile, review or guest from inside the app. Our Community Guidelines say where every one of those controls is."],
    ["li", "Complaints: if you think we have handled your information badly, tell us first at social@flockcorp.com. If you are in the EEA or the UK you can also complain to your national data protection authority."],
    ["h2", "If you are in the EEA or the UK"],
    ["p", "Flock Corp is the controller for the processing described here, and Our legal bases says which basis covers what. You have the following rights, and you exercise all of them the same way, by writing to social@flockcorp.com:"],
    ["li", "Access. A copy of the personal data we hold about you, and the information in this policy about how it is used."],
    ["li", "Rectification. Corrections to anything inaccurate. Most of it you can edit yourself in the app."],
    ["li", "Erasure. Deletion, which you can also do yourself. Deleting your account says exactly what goes and what does not."],
    ["li", "Restriction. Ask us to stop using your data while a dispute about it is settled."],
    ["li", "Objection. Object to processing we base on legitimate interests. Say what you object to and we will either stop or explain why we believe our grounds override yours."],
    ["li", "Portability. Your data in a structured, machine-readable form, for the parts you gave us and the parts we process by consent or under our agreement with you."],
    ["li", "Withdraw consent. Location, notifications, photo access, contacts, and the waitlist. Withdrawing does not undo processing that already happened."],
    ["li", "Complain to your supervisory authority."],
    ["p", "We answer within one month. We will not charge you and we will not make the service worse for asking. If we cannot identify you from what you send us, we will ask for enough to be sure we are not handing your data to somebody else."],
    ["p", "We do not make decisions about you by automated means that produce legal effects or anything similarly significant. The crowd model predicts how busy a building is; it does not decide anything about a person."],
    ["h2", "If you are in California"],
    ["p", "Under the California Consumer Privacy Act, as amended by the CPRA, these are the categories of personal information Flock has collected in the last twelve months, why, and who it goes to. Every one of them is described in more detail earlier in this policy."],
    ["li", "Identifiers: email, display name, optional phone, account number, sign-in identifiers from Apple or Google, IP address, push tokens. Collected to run the service and keep it safe. Shared with our hosting, email, push, analytics and sign-in providers."],
    ["li", "Customer records: password hash, payment handles such as a Venmo username. Collected to run sign-in and bill splitting. Not shared, except the hosting that stores them."],
    ["li", "Protected classifications: date of birth, which yields age. Collected only to enforce the minimum age. An age bracket, never the date, is sent to Google for Birdie."],
    ["li", "Commercial information: venues you voted on, checked into, reviewed or reported on, bill splits, and subscription receipts if you ever buy one. Collected to run the product."],
    ["li", "Internet activity: pages viewed and the short list of hand-written events described under Analytics, error reports, and email. Shared with PostHog."],
    ["li", "Geolocation: precise location while you are using the app, for the map, venue search, weather, events and SOS. Relayed, not stored, except for the coordinates in an SOS record. A rounded position goes to Google for Birdie."],
    ["li", "Audio, electronic, visual information: photos you upload, with their hidden camera data removed, and the messages you write. Photos are screened by Google Cloud Vision."],
    ["li", "Inferences: your reliability score, and the crowd predictions we compute for venues."],
    ["p", "Sensitive personal information, in the CPRA's sense, means your precise geolocation and your account credentials. We use them only to deliver the features you asked for and to secure your account, which is a use the law does not require us to offer a limit on. We do not use or disclose sensitive personal information for any other purpose, and we do not sell or share it."],
    ["p", "We have not sold personal information, and we have not shared it for cross-context behavioural advertising. We do not have an advertising business, we run no advertising software, and there is no \"Do Not Sell or Share My Personal Information\" link on Flock because there is nothing for it to switch off."],
    ["p", "You have the right to know what we collect and why, to get a copy, to correct it, to delete it, and not to be discriminated against for asking. Email social@flockcorp.comand say which one you want. An authorised agent may ask on your behalf with written permission we can verify. We verify a request by checking that it comes from the address on the account, or by asking you to confirm from inside the app."],
    ["h2", "Children"],
    ["p", "Flock is for people 13 and older. Sign-up asks for a date of birth and our server recalculates the age from it rather than trusting the app, so an under-13 account is refused rather than merely discouraged. We do not knowingly collect personal information from children under 13. If you believe a child under 13 has created an account, write to social@flockcorp.com and we will delete it."],
    ["p", "Several countries in the EEA set the age at which a young person can consent to an online service above 13, most often at 16. Flock has no way to collect and verify a parent's consent. So if you are between 13 and the age of digital consent where you live, you need your parent or guardian's permission to use Flock, and by using it you are telling us you have it. A parent or guardian who wants an account closed can write to social@flockcorp.com and we will close it."],
    ["p", "Flock has zero tolerance for child sexual abuse and exploitation. Our Community Guidelines describe what we do about it, including reporting apparent material to the National Center for Missing and Exploited Children."],
    ["p", "We do not build advertising profiles of anyone, so we do not build them of minors either. The analytics settings under Analytics, error reports, and email were written with the 13-year-old in mind."],
    ["h2", "Security"],
    ["p", "These are the protections that are actually in place, not a list of aspirations:"],
    ["li", "Passwords are hashed with bcrypt. We never see or store the password itself."],
    ["li", "Every connection is HTTPS, and the browser is told to keep it that way."],
    ["li", "Sessions are signed tokens with a fixed algorithm and a version stamp, so signing out everywhere really does invalidate the old ones."],
    ["li", "The most destructive actions, deleting your account and exporting your data, need proof it is really you: your password again, or a fresh sign-in. Wrong guesses are counted and locked out."],
    ["li", "Every database query is parameterised, so a message cannot become a command."],
    ["li", "Rate limits sit on every route, with tighter ones on sign-in, on the assistant, on the venue advisor, and on anything unauthenticated."],
    ["li", "Security headers are set by Helmet, including a content security policy."],
    ["li", "Text and images are screened before they are stored, and an image that cannot be screened is refused rather than let through."],
    ["li", "Uploaded images have their embedded metadata removed before storage."],
    ["li", "Webhooks from our email and subscription providers are verified against a shared secret in constant time, over the exact bytes that were signed, and refused outright if the secret is missing."],
    ["li", "Every push to our code is scanned for leaked secrets automatically."],
    ["li", "We take database backups, and the tool that makes them restores each one into a throwaway database and checks it before the backup is kept. An untested backup is a guess."],
    ["p", "No system is perfectly secure. If you find a problem, write to social@flockcorp.com and we will take it seriously."],
    ["h2", "If something goes wrong"],
    ["p", "If personal information is exposed by a breach, we will investigate it, fix what caused it, and tell the people affected without undue delay, describing what happened, what was involved, and what we are doing about it. Where the law sets a deadline, we will meet it: for people in the EEA or the UK that means notifying the relevant supervisory authority within 72 hours of becoming aware of a reportable breach, and telling you directly when the risk to you is high. We will not wait for certainty about every detail before telling you something happened."],
    ["h2", "International transfers"],
    ["p", "Our servers are in the United States, and the companies listed under Who we share with are United States companies or process there. If you use Flock from outside the United States, your information is transferred to and processed in the United States, which may not give it the same legal protection as your own country."],
    ["p", "We want to be straight about the mechanism. Flock has not signed separate transfer agreements or Standard Contractual Clauses with anyone. For people in the EEA or the UK, the transfer happens because it is necessary to provide the service you asked us for, and because you agree to it by using Flock. If that changes, this section changes with it."],
    ["h2", "What Flock does not do"],
    ["p", "A privacy policy that only lists what a company takes is half a document. Here is the other half. None of the following happens, anywhere in Flock, today:"],
    ["li", "We do not sell personal information, and we do not share it for advertising."],
    ["li", "We do not run ads, and there is no advertising software in the app or on the site."],
    ["li", "We do not track you across other apps or websites. There is no advertising cookie, no pixel, and no data broker."],
    ["li", "We do not read your location in the background, ever. Only while Flock is open and only when you have allowed it."],
    ["li", "We do not keep a location history. Live location is relayed and never written down."],
    ["li", "We do not upload or store your address book. The numbers you pick for a friend match are checked and discarded."],
    ["li", "We do not touch card numbers, bank accounts or any payment credential. No money moves through Flock."],
    ["li", "We do not record your screen, your keystrokes, your microphone or your camera. The only time the camera opens is when you ask it to take a photo or scan a code."],
    ["li", "We do not send your message content, your budgets, or your exact position to any AI model."],
    ["li", "We do not use your messages to train the crowd model. It learns from venue observations, and its training data holds no account numbers."],
    ["li", "We do not show any other person your budget amount."],
    ["li", "We do not tell anybody that a crowd report came from you."],
    ["li", "We do not let a venue see who is in the room, only how many."],
    ["li", "We do not collect health data, biometrics, race, religion, politics, or sexual orientation."],
    ["li", "We do not sell venue owners influence over what consumers see, and we do not accept payment to change a busyness number or bury an honest review."],
    ["p", "If any of that ever stops being true, it changes on this page before it changes in the product."],
    ["h2", "Changes to this policy"],
    ["p", "We may update this policy. We will post the new effective date at the top and, for material changes, give in-app notice before the change takes effect. If a change means we need your consent for something, we will ask."],
    ["h2", "Contact"],
    ["p", "Questions, requests, or concerns? A human reads this inbox:"],
    ["p", "social@flockcorp.com"],
  ],
  terms: [
    ["h1", "Terms of Service & EULA"],
    ["p", "Effective August 21, 2026"],
    ["h2", "The short version"],
    ["li", "You have to be 13 or older, and under 18 you need a parent's say-so."],
    ["li", "Be decent to people. We have zero tolerance for abuse and for objectionable content, and there are report and block buttons everywhere content appears."],
    ["li", "What you write stays yours. We get only the permission we need to show it to the people you sent it to."],
    ["li", "Crowd predictions are estimates. So is everything Roost tells a venue owner. Neither is a promise."],
    ["li", "Nothing costs money today. If that changes, the price and the term are on the purchase screen before you buy, and you cancel through Apple or Google."],
    ["li", "You can delete your account at any time, and it really deletes."],
    ["p", "The full terms are below. If anything is unclear, email social@flockcorp.com."],
    ["p", "These Terms of Service (\"Terms\") are a binding agreement between you and Flock Corp(\"Flock\", \"we\", \"us\"). They are also the end user licence agreement for the Flock app. By creating an account, by opening a Flock invite link, or by using the Flock app or flockcorp.com, you agree to these Terms and to our Privacy Policy and Community Guidelines, both of which are part of this agreement. If you do not agree, do not use Flock."],
    ["p", "Flock is a social coordination app: it helps a group of friends pick where to go, see how busy a place is likely to be, keep track of who is in, and split the bill afterwards. It also has a side for venue owners, which section 9 covers."],
    ["h2", "1. Eligibility and age"],
    ["p", "You must be at least 13 years old to use Flock. Sign-up asks for your date of birth, our server works out your age from it, and an account for anyone under 13 is refused. If you are under 18, you may use Flock only with the agreement of a parent or legal guardian, and by using it you tell us you have that agreement. Where you live, the age at which you can agree to an online service on your own may be higher than 13; if you are below it, the same rule applies."],
    ["p", "By using Flock you represent that the information you gave us at sign-up is true, that you are not barred from using Flock under any applicable law, and that you have not previously been banned from Flock."],
    ["h2", "2. Your account"],
    ["p", "You are responsible for your account and for keeping your credentials secure. You agree to provide accurate information and to be responsible for activity on your account. One account per person. Do not share it, do not sell it, and do not let somebody else use it. Tell us at social@flockcorp.com if you think somebody else has got into it. You may delete your account at any time (see section 12)."],
    ["h2", "3. Licence to use Flock"],
    ["p", "We grant you a personal, limited, non-exclusive, non-transferable, revocable licence to install and use the Flock app on a device you own or control, and to use flockcorp.com, for your own non-commercial use, subject to these Terms and to the usage rules of the store you got the app from. This is a licence, not a sale. Flock, the software behind it, and everything in it that we made remain ours."],
    ["p", "You may not copy, modify, translate, reverse engineer, decompile or disassemble the app, except where the law says you may despite this sentence. You may not rent, lease, lend, sell, redistribute or sublicense it. You may not scrape Flock, use a bot or automated system against it, work around any rate limit or access control, probe it for vulnerabilities without telling us, or use it to build a competing product. Some of Flock's source code is published under its own licence; that licence governs the code, and this section governs the service we run."],
    ["h2", "4. Acceptable use & zero tolerance"],
    ["p", "Flock has zero tolerance for objectionable content and abusive users. You agree not to post, send, or share content that is unlawful, harassing, bullying, hateful, threatening, sexually explicit, exploitative of minors, or otherwise objectionable, and not to harass, abuse, impersonate, stalk, or harm other users. Our Community Guidelines describe prohibited content and behavior in detail and are part of these Terms."],
    ["p", "You also agree not to:"],
    ["li", "Post anything that exploits or endangers a child. This is the one rule with no second chance attached to it."],
    ["li", "Post private information about somebody else without their permission."],
    ["li", "Spam, phish, run scams, or pretend to be someone you are not."],
    ["li", "File crowd reports or venue occupancy readings you know to be false. The number people open Flock for only works if the reports behind it are honest."],
    ["li", "Use the SOS feature when there is no emergency."],
    ["li", "Interfere with Flock's operation, attack it, or attempt to reach data that is not yours."],
    ["li", "Use Flock to arrange anything illegal."],
    ["p", "We may remove content and suspend or terminate accounts that violate these Terms. We act on reports of objectionable content and abusive behavior promptly, typically by removing the violating content and ejecting the responsible user, and we may report illegal content to the appropriate authorities."],
    ["h2", "5. Reporting, blocking & moderation"],
    ["p", "Flock provides in-app tools to report objectionable content and to block abusive users. You can report a flock chat message, a direct message, a profile, a venue review, and a guest's name on a plan. You can block anyone, from the menu at the top of a direct message or from their profile. Blocking is mutual: a blocked account cannot message you, add you, or see your content, and you do not see theirs. Blocking also ends the friendship if you had one. You can see and undo your blocks in Profile → Blocked accounts."],
    ["p", "Every report is reviewed. We aim to act on reports of objectionable content within 24 hours, by removing the content and, where it is warranted, ejecting the user who posted it. Serious or repeated violations result in a permanent ban, and deleting a banned account does not lift the ban."],
    ["p", "Reporting is not the only line of defence. Text you type is screened before it is stored and every photo is screened against our content rules before anyone else can see it. If a check fails, or cannot run at all, the content does not post."],
    ["p", "You can also reach us at social@flockcorp.com. If you believe someone is in immediate danger, contact your local emergency services first. We are not an emergency service."],
    ["h2", "6. Your content, and what you let us do with it"],
    ["p", "You keep ownership of everything you create on Flock. You grant us a non-exclusive, worldwide, royalty-free licence to host, store, reproduce and display your content, for the single purpose of operating the service: showing your messages to the other people in your flock, showing your avatar next to your name, showing your venue review on that venue's page, and making backups so none of it is lost. The licence lasts as long as the content is on Flock, plus the time it takes for caches and backups to age out. It ends when you delete the content or your account. It does not let us sell your content, license it to anybody else, put it in an advertisement, or use it to train an advertising model. You are responsible for the content you share and confirm you have the rights to share it."],
    ["p", "One narrower permission on top of that: when you report how busy a venue is, you allow us to use that report to correct our crowd predictions and to train the model that produces them. Nobody else is shown that you were the one who reported. This applies to crowd reports and to nothing else you post. Our Privacy Policy describes what is stored."],
    ["p", "If you send us an idea, a bug report or a suggestion, we can use it without owing you anything for it. That is the only reason we can act on feedback at all. It does not give us any right to the rest of your content."],
    ["p", "We may remove content that breaks these Terms or the Community Guidelines. We are not obliged to store your content or to keep it available, and you should not treat Flock as the only copy of anything you care about."],
    ["h2", "7. Predictions, Birdie and Roost are estimates"],
    ["p", "Every number Flock shows you about how busy a place is, or will be, is an estimate. It is produced by a statistical model from historical patterns, the weather, listed events nearby, reports from people who were there, and where available a venue's own reading or a sensor at its door. It is not a measurement of the room you are about to walk into, and it is not a promise. A venue can be empty when Flock says it is busy, and packed when Flock says it is quiet. Opening hours, prices, addresses and event listings come from third parties and from venues themselves and can be wrong or out of date. Check with the venue before you rely on any of it."],
    ["p", "Birdie is an assistant built on a large language model. Its answers are generated, and generated answers can be confidently wrong. Nothing Birdie says is advice about your safety, your health, your money, or the law, and none of it is a statement by us that something is true."],
    ["p", "Roost is the advisor for venue owners. Where it reports your own measurements it names the source and the date of each figure, and where our data cannot answer, it says so instead of guessing. That does not make it right. It is built on the same kind of model as Birdie, the underlying data is incomplete, and part of the training corpus behind the crowd model is frozen in spring 2026 and says so wherever it is quoted. Nothing Roost says is a guarantee of foot traffic, revenue, or any other business outcome, and none of it is legal, accounting, tax, employment or financial advice. Do not make a spending decision, a staffing decision, or any other decision about your business on Roost alone."],
    ["p", "You use all of it at your own risk, and you are responsible for your own decisions."],
    ["h2", "8. Safety, and what Flock is not"],
    ["p", "Flock helps you coordinate plans. It does not vet the people you meet, it does not inspect the places you go, and it cannot keep you safe. You are responsible for your own safety and for your own judgement when meeting people or going out."],
    ["p", "The SOS feature emails the trusted contacts you set up, with your current location. It is a convenience, not an emergency service. It depends on your phone having signal, on our servers being up, on your email provider delivering the message, and on somebody reading it. It does not contact the police, an ambulance, or any emergency service, and it does not text or call anyone. In an emergency, call your local emergency number. Do not rely on Flock instead."],
    ["p", "Flock is not a place to arrange the sale of anything regulated, and it is not a dating service. If you are under 21, remember that Flock lists venues that serve alcohol; the venue's rules and your local law apply to you exactly as they would if Flock did not exist."],
    ["h2", "9. Venues and businesses"],
    ["p", "This section applies to you if you claim or manage a venue on Flock. It is in addition to everything above, which applies to a venue account like any other. If you agree to it on behalf of a business, you confirm that you have the authority to do that, and \"you\" in this section means the business."],
    ["h3", "9.1 Your listing"],
    ["p", "Your venue can appear on the map, in search, and in group votes whether or not you have an account, because listings are built from public sources including Google Places and from what Flock users post. Claiming your venue does not create the listing. It gives you tools to manage your part of it: the profile, your operating facts, promotions, events, replies to reviews, the occupancy slider, and the venue dashboard."],
    ["h3", "9.2 What you let us display"],
    ["p", "When you claim your venue and use the dashboard, you give us permission to display on any Flock surface: your business name, address, hours, category, logo and the photos you upload; the deals, specials and events you post; and your occupancy reports. This permission is worldwide and free of charge, lasts as long as the content is on Flock plus a wind-down period for caches and backups, and ends when you remove the content or close the account. You keep ownership of everything you upload, and we do not sell it."],
    ["p", "Content about your venue from public sources and from Flock users, such as reviews, votes, crowd reports and check-ins, also appears on your listing. That content is not yours, and this section is not a licence from you for it. It is named here so the whole picture is in one place."],
    ["h3", "9.3 What you assert has to be true"],
    ["p", "You are responsible for every fact you assert through the dashboard: hours, prices, deals, events, menu details, capacity, photos, and occupancy reports. Do not post a deal you will not honour. Do not post hours that are wrong. Do not upload photos of another venue or photos you have no right to use. Do not claim a venue you do not control."],
    ["h3", "9.4 Occupancy reports"],
    ["p", "The dashboard lets you report how busy your venue is right now, on a scale of 0 to 100. This is free on every tier and it will stay free: we will not charge for the ability to post an occupancy report, or for how prominently a truthful one is labelled."],
    ["li", "Your report is shown to users as coming from you, in your venue's own words, and never as Flock's own estimate."],
    ["li", "It expires by itself 90 minutes after you set it. After that, users see our estimate again. You do not have to turn it off, and you can retract it early."],
    ["li", "Flock users can report busyness too. When enough of them do, currently three or more, their reports take precedence over yours. You cannot pay to change that, at any tier."],
    ["li", "Reports are attributable. We keep a record of who set what and when, and we keep it after a report expires or is retracted."],
    ["li", "You allow us to use your reports to correct predictions at your venue, to train the crowd model that serves every venue, and to contribute to aggregate comparisons across venues in your city and category. Those aggregates are built so that no single venue's number can be read back out of them, and they are not published at all until at least five venues other than yours have reported into the same comparison."],
    ["p", "Misreporting is the one venue behaviour that can cost you the feature, or the account, without notice. Saying you are quiet to fill seats, or packed to look popular, when it is not true, corrupts the one thing users open Flock for. Repeated, material divergence between your reports and what users in the room report is grounds for suspension."],
    ["h3", "9.5 What the dashboard gives you, and what it does not"],
    ["p", "The dashboard shows analytics built from Flock activity and from our model: consideration counts, check-in counts, busyness curves, and the Roost cards and answers. All of it is estimates, subject to section 7. Aggregated activity shown to you is anonymised: you do not receive individual users' identities, their budgets, their locations, or their messages."],
    ["p", "You cannot pay us to remove or bury honest negative content about your venue, and we will not offer it. We remove user content only under our own moderation rules. A removal decision is ours, and it is not a service you buy. Anything you post through the dashboard goes through the same screening as user content and can be removed under the same rules."],
    ["h3", "9.6 Venue fees"],
    ["p", "Today, nothing in the venue dashboard costs money and no payment method is collected. Any tier price shown in the app describes a plan we intend to charge for later, not a charge that exists now. Before we charge any venue anything, we will give at least 30 days' notice to the email on the venue account. Nothing will be retroactive: you will never be billed for a period before you subscribed. If we comp your venue a paid tier during a pilot, that comp can end at any time and is not a promise of future pricing."],
    ["p", "If paid features ever stop for non-payment, your listing, your ability to reply to reviews, and the occupancy slider do not stop with them."],
    ["h3", "9.7 Ending it"],
    ["p", "You can stop at any time: unclaim the venue or close the account. We can suspend or end dashboard access if you materially break these Terms, and for misreporting under 9.4 we can do it without notice. For anything else we will tell you what the problem is and give you a reasonable chance to fix it. Ending it removes your dashboard access and your posted content. It does not remove the underlying public listing, which exists independently of your account, and it does not remove user content about your venue."],
    ["p", "We keep records of occupancy reports, tier changes and moderation actions after content is deleted or an account is closed, as our Privacy Policy describes."],
    ["h2", "10. Payments and subscriptions"],
    ["p", "Flock is free to use today. Nothing in the app is for sale, no subscription is on offer, and no payment method is collected from anyone. The rest of this section is the agreement that will apply if and when that changes, so it is written down before it can catch anybody out."],
    ["p", "Any consumer subscription will be an auto-renewable subscription sold through the App Store or Google Play, not by us. The following will always be true of it:"],
    ["li", "What it is: the title of the subscription, what it unlocks, the length of one term, and the price of one term, including any introductory or free trial period, are shown on the purchase screen and in the store listing before you buy. Nothing is charged until you confirm the purchase with your store account."],
    ["li", "It renews by itself. The subscription renews automatically at the end of each term at the then-current price, and your store account is charged, unless you turn auto-renewal off at least 24 hours before the end of the current term."],
    ["li", "How to cancel: you manage and cancel the subscription in your Apple ID or Google Play account settings, not in Flock. We cannot cancel it for you."],
    ["li", "Cancelling does not end the term you already paid for. Turning off auto-renewal stops the next charge. It does not shorten, refund or pro-rate the period you are in, and you keep the paid features until that period ends."],
    ["li", "Free trials: if a free trial is offered and you buy the subscription during it, the unused part of the trial is forfeited. A trial converts to a paid term unless you cancel before it ends."],
    ["li", "Refunds are handled by Apple or Google under their own policies. We do not process payments and cannot issue a refund on their behalf."],
    ["li", "Price changes take effect only on a renewal, after the store notifies you and, where the store requires it, obtains your agreement."],
    ["li", "Deleting your Flock account does not cancel a store subscription. Cancel it in your store account as well, or it keeps renewing."],
    ["p", "If we ever bill venues directly rather than through a store, section 9.6 governs that and we will publish the billing terms before the first charge."],
    ["p", "We never collect or store card numbers, bank details, or any other payment credential. Bill splitting inside Flock moves no money: it opens Venmo, Cash App or Zelle on your phone, and what happens there is between you and them."],
    ["h2", "11. Intellectual property & copyright"],
    ["p", "Flock, its name, its logo, its birds, its designs and the software behind the service are owned by Flock Corp and protected by copyright and trade mark law. Nothing in these Terms transfers any of that to you. You may not use our name or logo without our written permission, except to refer to Flock accurately."],
    ["p", "If you believe content on Flock infringes your copyright, send a notice to social@flockcorp.comwith: enough detail to identify the copyrighted work; enough detail to find the content you say infringes it; your contact details; a statement that you believe in good faith that the use is not authorised by the owner, its agent, or the law; a statement that the information in your notice is accurate and, under penalty of perjury, that you are the owner or authorised to act for the owner; and your signature, electronic or physical. We will respond in accordance with the Digital Millennium Copyright Act and other applicable law, which can include removing the content and terminating a repeat infringer's account. If your content was removed and you believe that was a mistake, you can send a counter-notice to the same address."],
    ["h2", "12. Termination, bans, and deleting your account"],
    ["p", "You may stop using Flock and delete your account at any time from the app (Profile → Delete account) or via our account deletion page. Deleting your account also deletes every flock you created, including its chat, RSVPs, and votes, for everyone who was in it, and it removes your direct message threads from the other person's app as well. Deletion is irreversible. Our Privacy Policy lists exactly what is erased and the few things that survive."],
    ["p", "We may suspend or terminate your access, with or without notice, if you break these Terms or the Community Guidelines, if we are required to by law, or if we reasonably believe it is necessary to protect other people. Serious violations, and anything involving a child, result in a permanent ban. Deleting a banned account does not lift the ban, and creating a new account to get around one is itself a violation."],
    ["p", "We may also stop offering Flock, in whole or in part, at any time. If we shut the service down we will give reasonable notice where we can. Sections 6, 7, 8, 11, 13, 14, 15 and 17 survive the end of this agreement."],
    ["h2", "13. Disclaimers"],
    ["p", "Flock is provided \"as is\" and \"as available\", without warranties of any kind, express or implied. To the maximum extent permitted by law we disclaim the implied warranties of merchantability, fitness for a particular purpose, title and non-infringement. We do not warrant that Flock will be uninterrupted, secure, error-free, or available at any particular time; that any prediction, listing, price, opening time, event or answer is accurate or complete; or that any defect will be corrected. Flock depends on services run by other companies, and we do not control them."],
    ["p", "We are not responsible for the conduct of any user, for any venue, or for anything that happens when you meet someone or go somewhere. Some places do not allow the exclusion of implied warranties, so parts of this may not apply to you."],
    ["h2", "14. Limitation of liability"],
    ["p", "To the maximum extent permitted by law, Flock Corp is not liable for indirect, incidental, special, consequential, exemplary or punitive damages, or for lost profits, lost revenue, lost data, lost goodwill or business interruption, arising from or relating to your use of Flock, whatever the theory of liability and even if we were told such damages were possible."],
    ["p", "To the maximum extent permitted by law, our total liability to you for all claims relating to Flock is limited to the greater of one hundred United States dollars or the amount you actually paid us in the twelve months before the claim arose. Since Flock is free today, for most people that figure is one hundred dollars."],
    ["p", "These limits do not apply to liability that cannot be excluded or limited by law, including for fraud, for death or personal injury caused by negligence, and, depending on where you live, to your statutory consumer rights. If you live somewhere that does not allow some of these limits, they apply to you only as far as that law allows."],
    ["h2", "15. Indemnity"],
    ["p", "You agree to defend and indemnify Flock Corp against claims, damages and reasonable legal costs arising from content you post, from your breach of these Terms or of the law, or from your infringement of someone else's rights."],
    ["p", "If you use Flock as a venue, that also covers claims brought against us because a fact you asserted through the dashboard was false or misleading: hours, prices, deals, events, capacity, or occupancy reports. It is deliberately narrow. It covers what you asserted. It does not cover what users or public sources said about you."],
    ["p", "We will tell you about any claim we want covered, and you may not settle it in a way that admits anything on our behalf without our agreement."],
    ["h2", "16. Terms that apply because Flock is on the App Store"],
    ["p", "If you got Flock from Apple's App Store, the following applies, and it prevails over anything in these Terms that conflicts with it."],
    ["li", "This agreement is with us, not Apple. These Terms are between you and Flock Corp only. Apple is not a party to them and is not responsible for Flock or its content."],
    ["li", "Scope of the licence. The licence in section 3 is non-transferable and is limited to using Flock on any Apple-branded product that you own or control, as permitted by the Usage Rules in the Apple Media Services Terms and Conditions, except that Flock may be accessed by other accounts associated with you through Family Sharing or volume purchasing."],
    ["li", "Support. We are solely responsible for any maintenance and support for Flock. Apple has no obligation to furnish any maintenance or support services."],
    ["li", "Warranty. We are solely responsible for any product warranties, whether express or implied by law, to the extent they are not effectively disclaimed. If Flock fails to conform to any applicable warranty, you may notify Apple, and Apple will refund the purchase price, if any, for the app. To the maximum extent permitted by applicable law, Apple has no other warranty obligation whatsoever with respect to Flock, and any other claims, losses, liabilities, damages, costs or expenses attributable to any failure to conform to any warranty are our responsibility."],
    ["li", "Product claims. We, not Apple, are responsible for addressing any claims by you or a third party relating to Flock or your possession and use of it, including product liability claims, any claim that Flock fails to conform to any legal or regulatory requirement, and claims arising under consumer protection, privacy or similar legislation, including in connection with Flock's use of the HealthKit and HomeKit frameworks, which Flock does not use."],
    ["li", "Intellectual property claims. If a third party claims that Flock or your possession and use of it infringes their intellectual property rights, we, not Apple, are solely responsible for the investigation, defence, settlement and discharge of that claim."],
    ["li", "Legal compliance. You represent and warrant that you are not located in a country subject to a United States Government embargo or designated as a \"terrorist supporting\" country, and that you are not listed on any United States Government list of prohibited or restricted parties."],
    ["li", "Contact. Questions, complaints and claims about Flock go to Flock Corp at social@flockcorp.com."],
    ["li", "Third-party terms. You must comply with any applicable third-party terms of agreement when using Flock."],
    ["li", "Apple as third-party beneficiary. Apple and Apple's subsidiaries are third-party beneficiaries of these Terms, and upon your acceptance of them Apple will have the right, and is deemed to have accepted the right, to enforce these Terms against you as a third-party beneficiary of them."],
    ["p", "If you got Flock from Google Play, Google's terms for the Play Store apply to the download and to any purchase, alongside these Terms."],
    ["h2", "17. Governing law"],
    ["p", "These Terms are governed by the laws of the United States and the Commonwealth of Pennsylvania, without regard to conflict-of-laws rules. Where the law of the place you live gives you rights that cannot be overridden by an agreement like this one, those rights still apply and nothing here takes them away."],
    ["p", "Before starting any formal dispute, please write to us at social@flockcorp.com and give us a chance to sort it out. Most things can be."],
    ["p", "If any part of these Terms is found unenforceable, the rest stays in force. Our not enforcing something is not a waiver of it. You may not transfer these Terms to anyone else; we may transfer them to a successor if the business changes hands. These Terms, with the Privacy Policy and the Community Guidelines, are the whole agreement between us about Flock."],
    ["h2", "18. Changes to these Terms"],
    ["p", "We may update these Terms. We will post the new effective date at the top and, for material changes, provide in-app notice before the change takes effect. If you keep using Flock after that, you accept the new version. If you do not agree with it, delete your account."],
    ["h2", "19. Contact"],
    ["p", "Questions about these Terms, or anything else: social@flockcorp.com. A human reads that inbox."],
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
