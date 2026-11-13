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
// the day that happens; and the main ones Flock is entering next, his call on
// 2026-11-11 ("add ... the main ones, like Diamond, Blue Ocean, Conrad"),
// which replaced the 2026-11-08 rule of submitted entries only. An upcoming
// one says "Entering, <month>", the month its first round is due, and never
// "Submitted" before it is. Upcoming entries come first, soonest first; then
// the rest, newest first. When an upcoming month passes, the entry's status
// moves to what happened (aboutCompetitions.test.js fails until it does). Not
// a competition only being watched, and not credits programs or App Store
// featuring. Every status is a true past or
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
// confirmation. Upcoming (the tracker, rechecked 2026-11-06 on each official
// page): DECA's District 7 round is 2026-12-15 (the maintainer and Asad); the Diamond
// Challenge is due 2027-01-14 (the maintainer and Asad); Blue Ocean is due 2027-02-21
// (the maintainer). AwardX International was submitted 2026-11-13 (its portal,
// apply.awardx.com, shows "You submitted your application" and "Under
// review"); Jacobson was submitted 2026-11-11 (the form's confirmation
// page); LionCage was pitched at its finale on 2026-11-06; MIT Solve's
// dashboard shows the entry submitted 2026-11-05; SXSW EDU 2026-10-24;
// Stevens 2026-10-18 (the upload page's confirmation); the Congressional App
// Challenge 2026-10-13; Pirates Pitch 2026-10-03 (its confirmation email);
// the Conrad Challenge's email of 2026-10-02 accepted the team into its
// Innovation Stage.

// "By", not "Entered by": true of an entry that is in and of one being
// entered next.
const JAYDEN = 'By Jayden Bansal';
const JAYDEN_AND_ASAD = 'By Jayden Bansal and Asad Ali';

// EACH ENTRY CARRIES ITS ORGANIZER'S LOGO (his call, 2026-11-11), drawn on a
// white tile beside the name so it reads on the navy band. The files are in
// public/logos/competitions, each taken from the organizer's own site and
// rendered to one height at twice its display size: DECA's brand page, Blue
// Ocean's media page, the Conrad Challenge, Diamond Challenge and Congressional
// App Challenge sites, Great Valley LaunchBox, MIT Solve, SXSW EDU, Stevens and
// Seton Hall (both only offer a white logo, so each is the same artwork in one
// dark colour), and for Jacobson the University of Iowa's, which runs it.
// AwardX shows two (his call, 2026-11-13: "the launchx logo and the award x
// logo", in colour): LaunchX's own colour logo, from launchx.com's footer, and
// AwardX's wordmark, which its site only offers in white, so the letters take
// the site's own dark (#171d24) and the X the teal of AwardX's own X mark
// (#5ec2d3). An entry with two carries `logos` in place of `logo`.
// They sit beside a status that is true; nothing on the page says certified,
// endorsed or partnered. `width` and `height` are the file's own pixels, so
// the tile keeps its shape before the picture arrives.
const logo = (file, width, height) => ({ src: `/logos/competitions/${file}`, width, height });

// Upcoming first (soonest first), then newest first. `status` is what
// renders; `date` is its machine-readable date.
export const COMPETITIONS = [
  {
    name: 'Start-Up Business Plan',
    organizer: 'DECA',
    logo: logo('deca.png', 640, 132),
    status: 'Entering, December 2026',
    date: '2026-12',
    team: JAYDEN_AND_ASAD,
  },
  {
    name: 'Diamond Challenge',
    organizer: 'University of Delaware Horn Entrepreneurship',
    logo: logo('diamond-challenge.png', 582, 192),
    status: 'Entering, January 2027',
    date: '2027-01',
    team: JAYDEN_AND_ASAD,
  },
  {
    name: 'Blue Ocean Competition',
    organizer: 'Blue Ocean Student Entrepreneurs',
    logo: logo('blue-ocean.png', 614, 192),
    status: 'Entering, February 2027',
    date: '2027-02',
    team: JAYDEN,
  },
  {
    name: 'AwardX International',
    organizer: 'LaunchX',
    // Two logos (his call, 2026-11-13): the competition's and the one who
    // runs it, a tile each.
    logos: [logo('awardx.png', 640, 114), logo('launchx.png', 192, 192)],
    status: 'Submitted November 13, 2026',
    date: '2026-11-13',
    team: JAYDEN,
  },
  {
    name: 'Jacobson Innovator Competition',
    organizer: 'University of Iowa',
    logo: logo('university-of-iowa.png', 640, 186),
    // The day, not the month: submitted after LionCage's November 6, and a
    // month alone would sort below it.
    status: 'Submitted November 11, 2026',
    date: '2026-11-11',
    team: JAYDEN,
  },
  {
    name: 'LionCage',
    organizer: 'Penn State Great Valley LaunchBox',
    logo: logo('launchbox.png', 640, 166),
    status: 'Pitched at the finale, November 6, 2026',
    date: '2026-11-06',
    team: JAYDEN,
  },
  {
    name: '2027 Global Health Challenge',
    organizer: 'MIT Solve',
    logo: logo('mit-solve.png', 640, 150),
    status: 'Submitted November 2026',
    date: '2026-11',
    team: JAYDEN,
  },
  {
    name: 'Student Impact Challenge',
    organizer: 'SXSW EDU',
    logo: logo('sxsw-edu.png', 360, 192),
    status: 'Submitted October 2026',
    date: '2026-10',
    team: JAYDEN,
  },
  {
    name: 'High School Entrepreneurship and AI Video Pitch',
    organizer: 'Stevens Institute of Technology',
    logo: logo('stevens.png', 640, 172),
    status: 'Submitted October 2026',
    date: '2026-10',
    team: JAYDEN,
  },
  {
    name: 'Congressional App Challenge',
    organizer: 'U.S. House of Representatives',
    logo: logo('congressional-app-challenge.png', 270, 192),
    status: 'Submitted October 2026',
    date: '2026-10',
    team: JAYDEN,
  },
  {
    name: 'Pirates Pitch for High School Students',
    organizer: 'Seton Hall University',
    logo: logo('seton-hall.png', 574, 192),
    status: 'Submitted October 2026',
    date: '2026-10',
    team: JAYDEN,
  },
  {
    name: 'Conrad Challenge',
    organizer: 'Space Center Houston',
    logo: logo('conrad.png', 340, 192),
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
