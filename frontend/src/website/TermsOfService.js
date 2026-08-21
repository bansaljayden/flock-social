import React, { useEffect } from 'react';
import './PrivacyPolicy.css';
import SiteFooter from './SiteFooter';

const EFFECTIVE_DATE = 'August 21, 2026';
const SUPPORT_EMAIL = 'social@flockcorp.com';

// THE OPERATOR NAME IS NOT VERIFIED FROM ANYTHING IN THIS REPO. The long note
// at the top of PrivacyPolicy.js explains why this is one constant in one
// place: no file in this repository records a company registration, a state of
// incorporation, or a business address behind "Flock Corp", and a EULA has to
// name a real counterparty. Settle the entity question, then change it here,
// in PrivacyPolicy.js and in SiteFooter.js together.
//
// OPERATOR_ADDRESS is null on purpose, and Apple's minimum EULA terms ask for
// the developer's name AND address in the contact section. Nothing renders
// while it is null, because an invented address is worse than a missing one.
const OPERATOR = 'Flock Corp';
const OPERATOR_ADDRESS = null;

// PER-ROUTE <meta name="description">. CRA has no server rendering, so
// public/index.html is the response for every route and its one static
// description was the description this page shipped with. There is no head
// manager in this app and adding one is a dependency, so the mechanism is the
// one LandingPage.js already uses: rewrite the tag index.html ships, from this
// route's own effect. Googlebot renders JS and reads the rewritten value.
const DESCRIPTION = 'The terms and EULA for Flock: age, acceptable use, reporting and blocking, your content, venue and Roost terms, subscriptions, and what we do not promise.';

export default function TermsOfService() {
  useEffect(() => {
    document.title = 'Terms of Service and EULA | Flock';
    const meta = document.querySelector('meta[name="description"]');
    if (meta) meta.setAttribute('content', DESCRIPTION);
  }, []);

  const mail = <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>;

  return (
    <main className="pp">
      {/* First focusable element on the page (SLOP-AUDIT Q1), off-screen
          until focused. The header carries tabIndex -1 so activating this
          moves focus with the scroll instead of leaving it behind here. */}
      <a className="pp-skip" href="#pp-content">Skip to the terms</a>

      {/* The arrow is decoration and must stay out of the link's accessible
          name, or it is announced as "left arrow flockcorp.com". */}
      <a href="/" className="pp-back">
        <span aria-hidden="true">&larr;</span> flockcorp.com
      </a>

      <header className="pp-header" id="pp-content" tabIndex={-1}>
        <h1>Terms of Service &amp; EULA</h1>
        <p className="pp-meta">Effective {EFFECTIVE_DATE}</p>
      </header>

      <aside className="pp-summary" aria-labelledby="tos-summary-title">
        <h2 id="tos-summary-title">The short version</h2>
        <ul>
          <li>You have to be 13 or older, and under 18 you need a parent's say-so.</li>
          <li>Be decent to people. We have zero tolerance for abuse and for objectionable content, and there are report and block buttons everywhere content appears.</li>
          <li>What you write stays yours. We get only the permission we need to show it to the people you sent it to.</li>
          <li>Crowd predictions are estimates. So is everything Roost tells a venue owner. Neither is a promise.</li>
          <li>Nothing costs money today. If that changes, the price and the term are on the purchase screen before you buy, and you cancel through Apple or Google.</li>
          <li>You can delete your account at any time, and it really deletes.</li>
        </ul>
        <p>
          The full terms are below. If anything is unclear, email {mail}.
        </p>
      </aside>

      <section>
        <p>
          These Terms of Service ("Terms") are a binding agreement between you and{' '}
          {OPERATOR} ("Flock", "we", "us"). They are also the end user licence agreement for the Flock
          app. By creating an account, by opening a Flock invite link, or by using the Flock
          app or flockcorp.com, you agree to these Terms and to our{' '}
          <a href="/privacy">Privacy Policy</a> and{' '}
          <a href="/guidelines">Community Guidelines</a>, both of which are part of this
          agreement. If you do not agree, do not use Flock.
        </p>
        <p>
          Flock is a social coordination app: it helps a group of friends pick where to go,
          see how busy a place is likely to be, keep track of who is in, and split the bill
          afterwards. It also has a side for venue owners, which section 9 covers.
        </p>
      </section>

      <section>
        <h2>1. Eligibility and age</h2>
        <p>
          You must be at least 13 years old to use Flock. Sign-up asks for your date of
          birth, our server works out your age from it, and an account for anyone under 13
          is refused. If you are under 18, you may use Flock only with the agreement of a
          parent or legal guardian, and by using it you tell us you have that agreement.
          Where you live, the age at which you can agree to an online service on your own
          may be higher than 13; if you are below it, the same rule applies.
        </p>
        <p>
          By using Flock you represent that the information you gave us at sign-up is true,
          that you are not barred from using Flock under any applicable law, and that you
          have not previously been banned from Flock.
        </p>
      </section>

      <section>
        <h2>2. Your account</h2>
        <p>
          You are responsible for your account and for keeping your credentials secure. You
          agree to provide accurate information and to be responsible for activity on your
          account. One account per person. Do not share it, do not sell it, and do not let
          somebody else use it. Tell us at {mail} if you think somebody else has got into
          it. You may delete your account at any time (see section 12).
        </p>
      </section>

      <section>
        <h2>3. Licence to use Flock</h2>
        <p>
          We grant you a personal, limited, non-exclusive, non-transferable, revocable
          licence to install and use the Flock app on a device you own or control, and to use
          flockcorp.com, for your own personal use, or to run a venue under section 9 if that
          is what you are here for, subject to these Terms and to the usage rules of the store
          you got the app from. This is a licence, not a sale.
          Flock, the software behind it, and everything in it that we made remain ours.
        </p>
        <p>
          You may not copy, modify, translate, reverse engineer, decompile or disassemble the
          app, except where the law says you may despite this sentence. You may not rent,
          lease, lend, sell, redistribute or sublicense it. You may not scrape Flock, use a
          bot or automated system against it, work around any rate limit or access control,
          probe it for vulnerabilities without telling us, or use it to build a competing
          product. Some of Flock's source code is published under its own licence; that
          licence governs the code, and this section governs the service we run.
        </p>
      </section>

      <section>
        <h2>4. Acceptable use &amp; zero tolerance</h2>
        <p>
          <strong>
            Flock has zero tolerance for objectionable content and abusive users.
          </strong>{' '}
          You agree not to post, send, or share content that is unlawful, harassing, bullying,
          hateful, threatening, sexually explicit, exploitative of minors, or otherwise
          objectionable, and not to harass, abuse, impersonate, stalk, or harm other users.
          Our <a href="/guidelines">Community Guidelines</a> describe prohibited content and
          behavior in detail and are part of these Terms.
        </p>
        <p>You also agree not to:</p>
        <ul>
          <li>Post anything that exploits or endangers a child. This is the one rule with no second chance attached to it.</li>
          <li>Post private information about somebody else without their permission.</li>
          <li>Spam, phish, run scams, or pretend to be someone you are not.</li>
          <li>File crowd reports or venue occupancy readings you know to be false. The number people open Flock for only works if the reports behind it are honest.</li>
          <li>Use the SOS feature when there is no emergency.</li>
          <li>Interfere with Flock's operation, attack it, or attempt to reach data that is not yours.</li>
          <li>Use Flock to arrange anything illegal.</li>
        </ul>
        <p>
          We may remove content and suspend or terminate accounts that violate these Terms. We
          act on reports of objectionable content and abusive behavior promptly, typically by
          removing the violating content and ejecting the responsible user, and we may report
          illegal content to the appropriate authorities.
        </p>
      </section>

      {/* This section used to say "reach our team", which named people who do
          not exist: Flock is one person, and /about says so. The first-person
          plural everywhere else in this document is NOT the same problem and
          was deliberately left alone. The preamble defines "we" and "us" as
          the operator, so "we act on reports of objectionable content
          promptly" in section 4 asserts a commitment rather than a headcount,
          and it is the commitment App Review reads for Guideline 1.2.
          Rewriting a binding agreement into the first-person singular would be
          the worse error.

          THE 24-HOUR LINE BELOW IS A COMMITMENT, NOT A MEASUREMENT. Nothing in
          this repo enforces it and no timer starts anywhere. What backs it is
          services/moderationAlerts.js, which pushes every report at a log line,
          an email and a socket the moment it is filed. If that alerting is ever
          removed, this sentence has to come out with it. */}
      <section>
        <h2>5. Reporting, blocking &amp; moderation</h2>
        <p>
          Flock provides in-app tools to report objectionable content and to block abusive
          users. You can report a flock chat message, a direct message, a profile, a venue
          review, and a guest's name on a plan. You can block anyone, from the menu at the
          top of a direct message or from their profile. Blocking is mutual: a blocked
          account cannot message you, add you, or see your content, and you do not see
          theirs. Blocking also ends the friendship if you had one. You can see and undo your
          blocks in <strong>Profile</strong> &rarr; <strong>Blocked accounts</strong>.
        </p>
        <p>
          Every report is reviewed. We aim to act on reports of objectionable content within
          24 hours, by removing the content and, where it is warranted, ejecting the user who
          posted it. Serious or repeated violations result in a permanent ban, and deleting a
          banned account does not lift the ban.
        </p>
        <p>
          Reporting is not the only line of defence. Text you type is screened before it is
          stored and every photo is screened against our content rules before anyone else can
          see it. If a check fails, or cannot run at all, the content does not post.
        </p>
        <p>
          You can also reach us at {mail}. If you believe someone is in immediate danger,
          contact your local emergency services first. We are not an emergency service.
        </p>
      </section>

      <section>
        <h2>6. Your content, and what you let us do with it</h2>
        <p>
          You keep ownership of everything you create on Flock. You grant us a
          non-exclusive, worldwide, royalty-free licence to host, store, reproduce and
          display your content, for the single purpose of operating the service: showing your
          messages to the other people in your flock, showing your avatar next to your name,
          showing your venue review on that venue's page, and making backups so none of it is
          lost. The licence lasts as long as the content is on Flock, plus the time it takes
          for caches and backups to age out. It ends when you delete the content or your
          account. It does not let us sell your content, license it to anybody else, put it
          in an advertisement, or use it to train an advertising model. You are responsible
          for the content you share and confirm you have the rights to share it.
        </p>
        <p>
          One narrower permission on top of that: when you report how busy a venue is, you
          allow us to use that report to correct our crowd predictions and to train the model
          that produces them. Nobody else is shown that you were the one who reported. This
          applies to crowd reports and to nothing else you post. Our{' '}
          <a href="/privacy">Privacy Policy</a> describes what is stored.
        </p>
        <p>
          If you send us an idea, a bug report or a suggestion, we can use it without owing
          you anything for it. That is the only reason we can act on feedback at all. It does
          not give us any right to the rest of your content.
        </p>
        <p>
          We may remove content that breaks these Terms or the{' '}
          <a href="/guidelines">Community Guidelines</a>. We are not obliged to store your
          content or to keep it available, and you should not treat Flock as the only copy of
          anything you care about.
        </p>
      </section>

      <section>
        <h2>7. Predictions, Birdie and Roost are estimates</h2>
        <p>
          <strong>Every number Flock shows you about how busy a place is, or will be, is an
          estimate.</strong> It is produced by a statistical model from historical patterns,
          the weather, listed events nearby, reports from people who were there, and where
          available a venue's own reading or a sensor at its door. It is not a measurement of
          the room you are about to walk into, and it is not a promise. A venue can be empty
          when Flock says it is busy, and packed when Flock says it is quiet. Opening hours,
          prices, addresses and event listings come from third parties and from venues
          themselves and can be wrong or out of date. Check with the venue before you rely on
          any of it.
        </p>
        <p>
          <strong>Birdie</strong> is an assistant built on a large language model. Its answers
          are generated, and generated answers can be confidently wrong. Nothing Birdie says
          is advice about your safety, your health, your money, or the law, and none of it is
          a statement by us that something is true.
        </p>
        <p>
          <strong>Roost</strong> is the advisor for venue owners. Where it reports your own
          measurements it names the source and the date of each figure, and where our data
          cannot answer, it says so instead of guessing. That does not make it right. It is
          built on the same kind of model as Birdie, the underlying data is incomplete, and
          part of the training corpus behind the crowd model is frozen in spring 2026 and
          says so wherever it is quoted. <strong>Nothing Roost says is a guarantee of foot
          traffic, revenue, or any other business outcome, and none of it is legal,
          accounting, tax, employment or financial advice.</strong> Do not make a spending
          decision, a staffing decision, or any other decision about your business on Roost
          alone.
        </p>
        <p>
          You use all of it at your own risk, and you are responsible for your own decisions.
        </p>
      </section>

      <section>
        <h2>8. Safety, and what Flock is not</h2>
        <p>
          Flock helps you coordinate plans. It does not vet the people you meet, it does not
          inspect the places you go, and it cannot keep you safe. You are responsible for your
          own safety and for your own judgement when meeting people or going out.
        </p>
        <p>
          The SOS feature emails the trusted contacts you set up, with your current location.
          It is a convenience, not an emergency service. It depends on your phone having
          signal, on our servers being up, on your email provider delivering the message, and
          on somebody reading it. <strong>It does not contact the police, an ambulance, or any
          emergency service, and it does not text or call anyone.</strong> In an emergency,
          call your local emergency number. Do not rely on Flock instead.
        </p>
        <p>
          Flock is not a place to arrange the sale of anything regulated, and it is not a
          dating service. If you are under 21, remember that Flock lists venues that serve
          alcohol; the venue's rules and your local law apply to you exactly as they would if
          Flock did not exist.
        </p>
      </section>

      <section>
        <h2>9. Venues and businesses</h2>
        <p>
          This section applies to you if you claim or manage a venue on Flock. It is in
          addition to everything above, which applies to a venue account like any other. If
          you agree to it on behalf of a business, you confirm that you have the authority to
          do that, and "you" in this section means the business.
        </p>

        <h3>9.1 Your listing</h3>
        <p>
          Your venue can appear on the map, in search, and in group votes whether or not you
          have an account, because listings are built from public sources including Google
          Places and from what Flock users post. Claiming your venue does not create the
          listing. It gives you tools to manage your part of it: the profile, your operating
          facts, promotions, events, replies to reviews, the occupancy slider, and the venue
          dashboard.
        </p>

        <h3>9.2 What you let us display</h3>
        <p>
          When you claim your venue and use the dashboard, you give us permission to display
          on any Flock surface: your business name, address, hours, category, logo and the
          photos you upload; the deals, specials and events you post; and your occupancy
          reports. This permission is worldwide and free of charge, lasts as long as the
          content is on Flock plus a wind-down period for caches and backups, and ends when
          you remove the content or close the account. You keep ownership of everything you
          upload, and we do not sell it.
        </p>
        <p>
          Content about your venue from public sources and from Flock users, such as reviews,
          votes, crowd reports and check-ins, also appears on your listing. That content is
          not yours, and this section is not a licence from you for it. It is named here so
          the whole picture is in one place.
        </p>

        <h3>9.3 What you assert has to be true</h3>
        <p>
          You are responsible for every fact you assert through the dashboard: hours, prices,
          deals, events, menu details, capacity, photos, and occupancy reports. Do not post a
          deal you will not honour. Do not post hours that are wrong. Do not upload photos of
          another venue or photos you have no right to use. Do not claim a venue you do not
          control.
        </p>

        <h3>9.4 Occupancy reports</h3>
        <p>
          The dashboard lets you report how busy your venue is right now, on a scale of 0 to
          100. This is free on every tier and it will stay free: we will not charge for the
          ability to post an occupancy report, or for how prominently a truthful one is
          labelled.
        </p>
        <ul>
          <li>Your report is shown to users as coming from your venue, and never as Flock's own estimate. The wording around it is ours and is built from your venue's category, so a cafe reads as a cafe. It is not text you write.</li>
          <li>It expires by itself 90 minutes after you set it. After that, users see our estimate again. You do not have to turn it off, and you can retract it early.</li>
          <li>Flock users can report busyness too. When enough of them do, currently three or more, their reports take precedence over yours. You cannot pay to change that, at any tier.</li>
          <li>Reports are attributable. We keep a record of who set what and when, and we keep it after a report expires or is retracted.</li>
          <li>You allow us to use your reports to correct predictions at your venue, to train the crowd model that serves every venue, and to contribute to aggregate comparisons across venues in your city and category. Those aggregates are built so that no single venue's number can be read back out of them, and they are not published at all until at least five owners other than you have reported into the same comparison and at least three of their readings land on the figure itself.</li>
        </ul>
        <p>
          Misreporting is the one venue behaviour that can cost you the feature, or the
          account, without notice. Saying you are quiet to fill seats, or packed to look
          popular, when it is not true, corrupts the one thing users open Flock for. Repeated,
          material divergence between your reports and what users in the room report is
          grounds for suspension.
        </p>

        <h3>9.5 What the dashboard gives you, and what it does not</h3>
        <p>
          The dashboard shows analytics built from Flock activity and from our model:
          consideration counts, check-in counts, busyness curves, and the Roost cards and
          answers. All of it is estimates, subject to section 7. Aggregated activity shown to
          you is anonymised: you do not receive individual users' identities, their budgets,
          their locations, or their messages.
        </p>
        <p>
          You cannot pay us to remove or bury honest negative content about your venue, and we
          will not offer it. We remove user content only under our own moderation rules. A
          removal decision is ours, and it is not a service you buy. Anything you post through
          the dashboard goes through the same screening as user content and can be removed
          under the same rules.
        </p>

        <h3>9.6 Venue fees</h3>
        <p>
          <strong>Today, nothing in the venue dashboard costs money and no payment method is
          collected.</strong> These Terms do not set a price for anything. When there is a
          price it will be published where you buy, and we will give at least 30 days' notice
          to the email on the venue account before we charge any venue anything. Nothing will
          be retroactive: you will never be billed for a period before you subscribed. If we
          comp your venue a paid tier during a pilot, that comp can end at any time and is not
          a promise of future pricing.
        </p>
        <p>
          If we do bill venues, a subscription will renew by itself until you cancel it, and we
          will give you a way to cancel it yourself, from inside the venue dashboard, that is
          at least as easy as the way you signed up. You will not have to email us, phone us,
          or wait for us to answer to stop a renewal.
        </p>
        <p>
          If paid features ever stop for non-payment, your listing, your ability to reply to
          reviews, and the occupancy slider do not stop with them.
        </p>

        <h3>9.7 Ending it</h3>
        <p>
          You can stop at any time: unclaim the venue or close the account. We can suspend or
          end dashboard access if you materially break these Terms, and for misreporting under
          9.4 we can do it without notice. For anything else we will tell you what the problem
          is and give you a reasonable chance to fix it. Ending it removes your dashboard
          access and your posted content. It does not remove the underlying public listing,
          which exists independently of your account, and it does not remove user content
          about your venue.
        </p>
        <p>
          We keep records of tier changes and of moderation actions after content is deleted
          or an account is closed, as our <a href="/privacy">Privacy Policy</a> describes.
          Occupancy reports are not in that set: they are attached to the venue account that
          posted them, so closing that account deletes them. While the account exists they
          outlive the reading itself, including ones you retracted, because each is a labelled
          observation the crowd model learns from.
        </p>
      </section>

      <section>
        <h2>10. Payments and subscriptions</h2>
        <p>
          <strong>Flock is free to use today. Nothing in the app is for sale, no subscription
          is on offer, and no payment method is collected from anyone.</strong> The rest of
          this section is the agreement that will apply if and when that changes, so it is
          written down before it can catch anybody out.
        </p>
        <p>
          Any consumer subscription will be an auto-renewable subscription sold through the
          App Store or Google Play, not by us. The following will always be true of it:
        </p>
        <ul>
          <li><strong>What it is:</strong> the title of the subscription, what it unlocks, the length of one term, and the price of one term, including any introductory or free trial period, are shown on the purchase screen and in the store listing before you buy. Nothing is charged until you confirm the purchase with your store account.</li>
          <li><strong>It renews by itself.</strong> The subscription renews automatically at the end of each term at the then-current price, and your store account is charged, unless you turn auto-renewal off at least 24 hours before the end of the current term.</li>
          <li><strong>How to cancel:</strong> you manage and cancel the subscription in your Apple ID or Google Play account settings, not in Flock. We cannot cancel it for you.</li>
          <li><strong>Cancelling does not end the term you already paid for.</strong> Turning off auto-renewal stops the next charge. It does not shorten, refund or pro-rate the period you are in, and you keep the paid features until that period ends.</li>
          <li><strong>Free trials:</strong> if a free trial is offered and you buy the subscription during it, the unused part of the trial is forfeited. A trial converts to a paid term unless you cancel before it ends.</li>
          <li><strong>Refunds</strong> are handled by Apple or Google under their own policies. We do not process payments and cannot issue a refund on their behalf.</li>
          <li><strong>Price changes</strong> take effect only on a renewal, after the store notifies you and, where the store requires it, obtains your agreement.</li>
          <li><strong>Deleting your Flock account does not cancel a store subscription.</strong> Cancel it in your store account as well, or it keeps renewing.</li>
        </ul>
        <p>
          If we ever bill venues directly rather than through a store, section 9.6 governs
          that and we will publish the billing terms before the first charge.
        </p>
        <p>
          We never collect or store card numbers, bank details, or any other payment
          credential. Bill splitting inside Flock moves no money: it opens Venmo, Cash App or
          Zelle on your phone, and what happens there is between you and them.
        </p>
      </section>

      <section>
        <h2>11. Intellectual property &amp; copyright</h2>
        <p>
          Flock, its name, its logo, its birds, its designs and the software behind the
          service are owned by {OPERATOR} and protected by copyright and trade mark law.
          Nothing in these Terms transfers any of that to you. You may not use our name or
          logo without our written permission, except to refer to Flock accurately.
        </p>
        <p>
          If you believe content on Flock infringes your copyright, send a notice to{' '}
          {mail} with: enough detail to identify the copyrighted work; enough detail to find the
          content you say infringes it; your contact details; a statement that you believe in
          good faith that the use is not authorised by the owner, its agent, or the law; a
          statement that the information in your notice is accurate and, under penalty of
          perjury, that you are the owner or authorised to act for the owner; and your
          signature, electronic or physical. We will respond in accordance with the Digital
          Millennium Copyright Act and other applicable law, which can include removing the
          content and terminating a repeat infringer's account. If your content was removed
          and you believe that was a mistake, you can send a counter-notice to the same
          address.
        </p>
      </section>

      <section>
        <h2>12. Termination, bans, and deleting your account</h2>
        <p>
          You may stop using Flock and delete your account at any time from the app (Profile
          &rarr; Delete account) or via our <a href="/delete-account">account deletion page</a>.
          Deleting your account also deletes every flock you created, including its chat,
          RSVPs, and votes, for everyone who was in it, and it removes your direct message
          threads from the other person's app as well. Deletion is irreversible. Our{' '}
          <a href="/privacy">Privacy Policy</a> lists exactly what is erased and the few
          things that survive.
        </p>
        <p>
          We may suspend or terminate your access, with or without notice, if you break these
          Terms or the <a href="/guidelines">Community Guidelines</a>, if we are required to by
          law, or if we reasonably believe it is necessary to protect other people. Serious
          violations, and anything involving a child, result in a permanent ban.
          <strong> Deleting a banned account does not lift the ban</strong>, and creating a new
          account to get around one is itself a violation.
        </p>
        <p>
          We may also stop offering Flock, in whole or in part, at any time. If we shut the
          service down we will give reasonable notice where we can. Sections 6, 7, 8, 11, 13,
          14, 15, 16 and 17 survive the end of this agreement. Section 16 is in that list
          because it is the part Apple is entitled to rely on, and a term that stops applying
          the moment the agreement ends would not be worth much to anybody.
        </p>
      </section>

      <section>
        <h2>13. Disclaimers</h2>
        <p>
          <strong>Flock is provided "as is" and "as available", without warranties of any
          kind, express or implied.</strong> To the maximum extent permitted by law we
          disclaim the implied warranties of merchantability, fitness for a particular
          purpose, title and non-infringement. We do not warrant that Flock will be
          uninterrupted, secure, error-free, or available at any particular time; that any
          prediction, listing, price, opening time, event or answer is accurate or complete;
          or that any defect will be corrected. Flock depends on services run by other
          companies, and we do not control them.
        </p>
        <p>
          We are not responsible for the conduct of any user, for any venue, or for anything
          that happens when you meet someone or go somewhere. Some places do not allow the
          exclusion of implied warranties, so parts of this may not apply to you.
        </p>
      </section>

      <section>
        <h2>14. Limitation of liability</h2>
        <p>
          To the maximum extent permitted by law, {OPERATOR} is not liable for indirect,
          incidental, special, consequential, exemplary or punitive damages, or for lost
          profits, lost revenue, lost data, lost goodwill or business interruption, arising
          from or relating to your use of Flock, whatever the theory of liability and even if
          we were told such damages were possible.
        </p>
        <p>
          To the maximum extent permitted by law, our total liability to you for all claims
          relating to Flock is limited to the greater of one hundred United States dollars or
          the amount you actually paid us in the twelve months before the claim arose. Since
          Flock is free today, for most people that figure is one hundred dollars.
        </p>
        <p>
          These limits do not apply to liability that cannot be excluded or limited by law,
          including for fraud, for death or personal injury caused by negligence, and,
          depending on where you live, to your statutory consumer rights. If you live
          somewhere that does not allow some of these limits, they apply to you only as far as
          that law allows.
        </p>
      </section>

      <section>
        <h2>15. Indemnity</h2>
        <p>
          If someone brings a claim against {OPERATOR} because of content you posted, because
          you broke these Terms or the law, or because you infringed someone else's rights, you
          agree to cover our costs for that claim, including reasonable legal fees.
        </p>
        <p>
          If you use Flock as a venue, that also covers claims brought against us because a
          fact <strong>you</strong> asserted through the dashboard was false or misleading:
          hours, prices, deals, events, capacity, or occupancy reports. It is deliberately
          narrow. It covers what you asserted. It does not cover what users or public sources
          said about you.
        </p>
        <p>
          We will tell you about any claim we want covered, and you may not settle it in a way
          that admits anything on our behalf without our agreement.
        </p>
      </section>

      {/* Apple's Minimum Terms for a developer EULA (Schedule 1 to the Apple
          Developer Program Licence Agreement). Reproduced in substance because
          Flock ships its own EULA rather than pointing at Apple's standard one.
          If this document is ever replaced by a link to Apple's standard EULA,
          this section is what would go. Apple asks for the developer's name AND
          address in the contact section, which is why OPERATOR_ADDRESS exists
          at the top of this file and why it renders as soon as it is set. */}
      <section>
        <h2>16. Terms that apply because Flock is on the App Store</h2>
        <p>
          If you got Flock from Apple's App Store, the following applies, and it prevails over
          anything in these Terms that conflicts with it.
        </p>
        <ul>
          <li><strong>This agreement is with us, not Apple.</strong> These Terms are between you and {OPERATOR} only. Apple is not a party to them and is not responsible for Flock or its content.</li>
          <li><strong>Scope of the licence.</strong> The licence in section 3 is non-transferable and is limited to using Flock on any Apple-branded product that you own or control, as permitted by the Usage Rules in the Apple Media Services Terms and Conditions, except that Flock may be accessed by other accounts associated with you through Family Sharing or volume purchasing.</li>
          <li><strong>Support.</strong> We are solely responsible for any maintenance and support for Flock. Apple has no obligation to furnish any maintenance or support services.</li>
          <li><strong>Warranty.</strong> We are solely responsible for any product warranties, whether express or implied by law, to the extent they are not effectively disclaimed. If Flock fails to conform to any applicable warranty, you may notify Apple, and Apple will refund the purchase price, if any, for the app. To the maximum extent permitted by applicable law, Apple has no other warranty obligation whatsoever with respect to Flock, and any other claims, losses, liabilities, damages, costs or expenses attributable to any failure to conform to any warranty are our responsibility.</li>
          <li><strong>Product claims.</strong> We, not Apple, are responsible for addressing any claims by you or a third party relating to Flock or your possession and use of it, including product liability claims, any claim that Flock fails to conform to any legal or regulatory requirement, and claims arising under consumer protection, privacy or similar legislation, including in connection with Flock's use of the HealthKit and HomeKit frameworks, which Flock does not use.</li>
          <li><strong>Intellectual property claims.</strong> If a third party claims that Flock or your possession and use of it infringes their intellectual property rights, we, not Apple, are solely responsible for the investigation, defence, settlement and discharge of that claim.</li>
          <li><strong>Legal compliance.</strong> You represent and warrant that you are not located in a country subject to a United States Government embargo or designated as a "terrorist supporting" country, and that you are not listed on any United States Government list of prohibited or restricted parties.</li>
          <li><strong>Contact.</strong> Questions, complaints and claims about Flock go to {OPERATOR} at {mail}{OPERATOR_ADDRESS ? `, ${OPERATOR_ADDRESS}` : ''}.</li>
          <li><strong>Third-party terms.</strong> You must comply with any applicable third-party terms of agreement when using Flock.</li>
          <li><strong>Apple as third-party beneficiary.</strong> Apple and Apple's subsidiaries are third-party beneficiaries of these Terms, and upon your acceptance of them Apple will have the right, and is deemed to have accepted the right, to enforce these Terms against you as a third-party beneficiary of them.</li>
        </ul>
        <p>
          If you got Flock from Google Play, Google's terms for the Play Store apply to the
          download and to any purchase, alongside these Terms.
        </p>
      </section>

      {/* GOVERNING LAW IS NOT SETTLED, AND THIS SENTENCE IS NOT COUNSEL'S WORK.
          VENUE-TOS-DRAFT.md lawyer flag 3 says governing law, forum, and whether
          to include arbitration and a class waiver are deliberately not drafted
          and must not be filled in without a lawyer. What shipped here filled in
          one of the four anyway, and did it with a drafting error: it named "the
          laws of the United States and the Commonwealth of Pennsylvania", and
          federal law is not something a contract chooses. A US contract picks a
          STATE's law; federal law applies of its own force wherever it applies.
          That error is corrected below. The three questions flag 3 actually
          raises are still open and still need counsel:
            1. is Pennsylvania the right choice, given the contracting entity is
               undecided (flag 1) and the operator is a minor;
            2. what the forum is, which this section still does not say;
            3. arbitration and class waiver, yes or no.
          Do not read the corrected sentence as those questions being answered. */}
      <section>
        <h2>17. Governing law</h2>
        <p>
          These Terms are governed by the laws of the Commonwealth of Pennsylvania, without
          regard to conflict-of-laws rules, and by any federal law of the United States that
          applies. Where the law of the place you live gives you rights that cannot be
          overridden by an agreement like this one, those rights still apply and nothing here
          takes them away.
        </p>
        <p>
          Before starting any formal dispute, please write to us at {mail} and give us a
          chance to sort it out. Most things can be.
        </p>
        <p>
          If any part of these Terms is found unenforceable, the rest stays in force. Our not
          enforcing something is not a waiver of it. You may not transfer these Terms to
          anyone else; we may transfer them to a successor if the business changes hands.
          These Terms, with the <a href="/privacy">Privacy Policy</a> and the{' '}
          <a href="/guidelines">Community Guidelines</a>, are the whole agreement between us
          about Flock.
        </p>
      </section>

      <section>
        <h2>18. Changes to these Terms</h2>
        <p>
          We may update these Terms. We will post the new effective date at the top and, for
          material changes, provide in-app notice before the change takes effect. If you keep
          using Flock after that, you accept the new version. If you do not agree with it,
          delete your account.
        </p>
      </section>

      <section>
        <h2>19. Contact</h2>
        <p>
          Questions about these Terms, or anything else: {mail}. A human reads that inbox.
          {OPERATOR_ADDRESS ? ` Our postal address is ${OPERATOR_ADDRESS}.` : ''}
        </p>
      </section>

      {/* The shared SiteFooter: legal links, the one real mailbox, and the
          copyright. It stays inside main.pp because .pp paints the page. */}
      <SiteFooter className="pp-footer" />
    </main>
  );
}
