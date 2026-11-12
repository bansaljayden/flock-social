// The competitions Flock is entered in, and the honors it has won, as /about
// shows them (AboutPage.js). The data lives here so a change is one edit.
//
// HOW TO ADD AN HONOR
//   1. Put it at the top of HONORS (newest first) in this shape:
//        { when: 'Month 2027', date: '2027-02', what: 'The award, at the competition.' }
//      `date` is the machine-readable form of `when` (YYYY-MM or YYYY-MM-DD).
//      While only the year is confirmed, `when` is the year and `date` is left
//      out.
//      `what` is one plain sentence that names the award and the competition.
//   2. Only an honor a source confirms goes in: the organizer's email, their
//      results page or the award itself. Never a guess at a result.
//   3. The Honors section on /about shows whenever HONORS has an entry. If
//      HONORS is ever empty it renders nothing at all, no heading and no
//      "coming soon".
//   4. Run the frontend tests. aiCrawlerSurface.test.js then fails and prints
//      the page's new text blocks; copy them into PAGE_BLOCKS.about in
//      api/marketing-page.js, the copy AI crawlers are served.
// A change to COMPETITIONS (a new entry, or a status that moved) is the same
// steps 2 and 4.
//
// WHAT GOES IN COMPETITIONS: entries that are submitted, accepted or pitched,
// the day that happens, and nothing still being prepared (his call,
// 2026-11-08). Not a competition being watched or not yet started, and not
// credits programs or App Store featuring. Every status is a true past or
// present fact; none says finalist, winner or award until a source does, and
// then the win goes in HONORS. No prizes, fees or deadlines. No team member's
// school is named (a Diamond Challenge rule); an organizer can be a
// university, and none of them is that school.
//
// AN ENTRY IS FOUR THINGS: the competition, who runs it, who entered it and
// where it stands. The line that described what went in ("A two-minute video
// pitch.") came off the page on 2026-11-11, his call: the middle of each row
// was not needed.
//
// Sources: the competition tracker, brought up to date with each entry's own
// confirmation. Jacobson was submitted 2026-11-11 (the form's confirmation
// page); LionCage was pitched at its finale on 2026-11-06; MIT Solve's
// dashboard shows the entry submitted 2026-11-05; SXSW EDU 2026-10-24;
// Stevens 2026-10-18 (the upload page's confirmation); the Congressional App
// Challenge 2026-10-13; Pirates Pitch 2026-10-03 (its confirmation email);
// the Conrad Challenge's email of 2026-10-02 accepted the team into its
// Innovation Stage.

const JAYDEN = 'Entered by Jayden Bansal';
const JAYDEN_AND_ASAD = 'Entered by Jayden Bansal and Asad Ali';

// Newest first. `status` is what renders;
// `date`, where there is one, is its machine-readable date.
export const COMPETITIONS = [
  {
    name: 'Jacobson Innovator Competition',
    organizer: 'University of Iowa',
    // The day, not the month: submitted after LionCage's November 6, and a
    // month alone would sort below it.
    status: 'Submitted November 11, 2026',
    date: '2026-11-11',
    team: JAYDEN,
  },
  {
    name: 'LionCage',
    organizer: 'Penn State Great Valley LaunchBox',
    status: 'Pitched at the finale, November 6, 2026',
    date: '2026-11-06',
    team: JAYDEN,
  },
  {
    name: '2027 Global Health Challenge',
    organizer: 'MIT Solve',
    status: 'Submitted November 2026',
    date: '2026-11',
    team: JAYDEN,
  },
  {
    name: 'Student Impact Challenge',
    organizer: 'SXSW EDU',
    status: 'Submitted October 2026',
    date: '2026-10',
    team: JAYDEN,
  },
  {
    name: 'High School Entrepreneurship and AI Video Pitch',
    organizer: 'Stevens Institute of Technology',
    status: 'Submitted October 2026',
    date: '2026-10',
    team: JAYDEN,
  },
  {
    name: 'Congressional App Challenge',
    organizer: 'U.S. House of Representatives',
    status: 'Submitted October 2026',
    date: '2026-10',
    team: JAYDEN,
  },
  {
    name: 'Pirates Pitch for High School Students',
    organizer: 'Seton Hall University',
    status: 'Submitted October 2026',
    date: '2026-10',
    team: JAYDEN,
  },
  {
    name: 'Conrad Challenge',
    organizer: 'Space Center Houston',
    status: 'Accepted into the Innovation Stage, October 2026',
    date: '2026-10',
    team: JAYDEN_AND_ASAD,
  },
];

// Newest first; see HOW TO ADD AN HONOR above.
//
// DECA States: Flock's Innovation Plan took 1st place at the Pennsylvania
// DECA state conference in 2026. The site has claimed it since August, as
// "1st place at PA DECA States" (the landing page, then a milestone here) and
// as the `award` in the Organization JSON-LD (public/index.html and
// api/marketing-page.js), which uses these words. The event is in the
// company's competition records. Its month is left out until the results page
// or the certificate confirms it.
export const HONORS = [
  { when: 'November 6, 2026', date: '2026-11-06', what: '2nd place in the Technology category and the Rising Entrepreneur Award at the LionCage Pitch Competition, Penn State Great Valley.' },
  { when: '2026', what: '1st place in Innovation Plan at Pennsylvania DECA States.' },
];
