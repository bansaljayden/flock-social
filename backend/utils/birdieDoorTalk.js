// ---------------------------------------------------------------------------
// DRINKS, ID AND THE DOOR, FOR A PLAN LOCKED IN AT A BAR (2026-11-04).
//
// Asked from inside a flock whose plan is locked in, Birdie answers about the
// group's venue (routes/ai.js THE GROUP'S PLAN). When that venue is a bar and
// the person asking is under 21, or has no date of birth on file (every account
// the iPhone app makes), the answer is still about the plan: how busy it will
// be and when to go. What it never carries is anything about drinks, ID, being
// carded, age limits or getting in. The prompt says so; this is the
// deterministic half, in the style of the other valves on Birdie's replies (the
// plain no to underage drinking, the bar filter for minors, the grounding of
// venue details): routes/ai.js takes every clause that matches out of such a
// reply (birdieGrounding.withoutClauses), and costs no further call.
//
// Before it, the only check on that reply was the plain no: a reply to someone
// under 21 that mentioned carding or ID ("heads up, they card at the door") was
// replaced wholesale with "can't help with drinking under 21. want a spot that
// fits the night without it?", which answers a question nobody asked, drops the
// crowd answer that was asked for, and invites the group to leave its own plan.
// Drink words ("the cocktails", "happy hour") and the door ("it's 21+, you won't
// get in") were not checked at all.
//
// WHAT COUNTS. Alcohol and drinking (a drink, beer, cocktails, shots, a bar
// tab, happy hour), ID and carding (IDs, licences, wristbands, "they card"),
// age limits ("21+", "under 21", "all ages", "old enough") and the door (being
// let in or turned away, bouncers, a cover charge, entry). Not the venue's own
// name: the caller covers venue names before it reads a clause, so "Yards Beer
// Hall" is a name, not talk. Not "get there before 9" or "your best shot",
// which are timing and idiom, and not Birdie's own cards ("the card's below").
//
// WHEN THE PERSON ASKED. A message that raises any of it ("can we drink
// there?", "will they let us in?", "is it 21+?") is answered by the hard rules
// and the plain no, as before, and nothing is taken out of the reply: a reply
// to a drinking ask with the drinking taken out could still answer it with a
// place. raisesDrinksIdOrDoor reads the person's message for that, more
// broadly than the reply is read, so an ask it is unsure of goes the plain no's
// way.
//
// Pure functions, no I/O: __tests__/birdieDoorTalk.test.js reads them pattern
// by pattern.
// ---------------------------------------------------------------------------

'use strict';

// Alcohol and drinking. "Shots" only as a plural or a thing taken ("your best
// shot" is an idiom), and no "brew" ("cold brew" is coffee).
const DRINKS = [
  "\\b(?:drinks?|drinking|drank|drunk|tipsy|buzzed|hammered|sober|booze|boozy|alcohol(?:ic)?|liquor)\\b",
  '\\b(?:cocktails?|mocktails?|beers?|lagers?|ipas?|ales?|stouts?|ciders?|wines?|champagne|prosecco|sangria|margaritas?|mimosas?|martinis?|mojitos?|seltzers?|whiske?ys?|bourbon|vodka|tequila|mezcal|rum|pints?|nightcaps?)\\b',
  '\\bshots\\b|\\b(?:take|takes|taking|took|do|doing)\\s+(?:a\\s+)?shot\\b',
  '\\b(?:bartenders?|mixologists?|happy hours?|bar tabs?|open bar|bottle service|pre-?gam(?:e|es|ing)|on tap|on draft|tap ?rooms?)\\b',
];

// ID and carding. Birdie's own plan and vote cards are not carding: "card" only
// counts with someone doing the carding, or a word about whom it is done to.
const ID = [
  '\\bcarded\\b|\\bcarding\\b',
  "\\b(?:won'?t|don'?t|doesn'?t|do|does|will|never|rarely|barely|always|definitely|strictly|usually)\\s+(?:even\\s+)?card\\b",
  '\\b(?:they|staff|security|bouncers?|doorm[ae]n|door staff|bartenders?|the (?:bar|club|door|place))\\s+(?:\\w+\\s+){0,2}cards?\\b',
  '\\bcards?\\s+(?:you|u|people|anyone|everyone|everybody|nobody|kids|minors|teens|students|hard|strictly|at the door)\\b',
  '\\b(?:check|checks|checked|checking|scan|scans|scanned|scanning)\\s+(?:your\\s+|an?\\s+|their\\s+|for\\s+)?(?:ids?|identification|cards|licen[cs]es?)\\b',
  '\\b(?:ask|asks|asked|asking)\\s+for\\s+(?:your\\s+|an?\\s+)?(?:ids?|identification)\\b',
  "\\bids?\\b|\\bidentification\\b|\\b(?:driver'?s\\s+)?licen[cs]es?\\b",
  '\\bwristbands?\\b|\\bhand ?stamps?\\b|\\bstamp(?:s|ed)?\\s+your\\s+hands?\\b',
];

// Age limits.
const AGE = [
  '\\b(?:18|19|20|21)\\s*\\+|\\b(?:18|19|20|21)\\s*(?:and|or)\\s*(?:up|over|older)\\b|\\b(?:18|21)[- ]plus\\b',
  '\\b(?:over|under)[- ]?(?:18|21)s?\\b|\\b(?:18|19|20|21)[- ]years?[- ]olds?\\b',
  "\\ball[- ]ages\\b|\\bunder ?age\\b|\\bminors?\\b|\\badults? only\\b|\\bgrown[- ]ups? only\\b|\\bold enough\\b",
  '\\b(?:of|legal|drinking) age\\b|\\bage (?:limits?|requirements?|restrictions?|polic(?:y|ies)|minimums?|checks?|cut-?offs?)\\b|\\bminimum age\\b|\\bage[- ]restricted\\b|\\byour age\\b',
];

// The door: being let in or turned away, who stands at it, what it costs.
const DOOR = [
  "\\b(?:let|lets|letting)\\s+(?:you|u|them|y'?all|us|everyone|anyone|people|minors|teens|kids|your\\s+\\w+|the\\s+\\w+|\\d+\\s+year\\s+olds?|under\\s*-?\\s*21s?)\\s+in\\b",
  "\\b(?:won'?t|can'?t|cannot|couldn'?t|wouldn'?t|might not|may not|not|never|probably not)\\s+(?:be\\s+)?(?:able\\s+to\\s+)?(?:get|be let|be allowed|go|make it|walk)\\s+in(?:side)?\\b",
  "\\bnot (?:getting|going to get|gonna get) in\\b|\\ballowed in(?:side)?\\b",
  '\\bturn(?:s|ed|ing)?\\s+(?:you\\s+|u\\s+|them\\s+|people\\s+|anyone\\s+)?away\\b|\\b(?:kicked|thrown|bounced) out\\b',
  "\\bbouncers?\\b|\\bdoorm[ae]n\\b|\\bdoor (?:staff|policy|policies|guy|person|check|list)\\b|\\b(?:at|on|past|through|by) the door\\b|\\bthe door(?:'s| is| gets)\\b",
  '\\bcover charges?\\b|\\b(?:no|a|the) cover\\b|\\bentry\\b|\\badmission\\b|\\bguest ?lists?\\b|\\bdress code\\b|\\bget(?:ting)? past\\b',
];

const DOOR_TALK = new RegExp([...DRINKS, ...ID, ...AGE, ...DOOR].join('|'), 'i');

// The person's own message: everything above, and the words around an ask
// about being served or getting in that a reply is not read for.
const RAISES = new RegExp([
  DOOR_TALK.source,
  "\\b(?:serve[ds]?|serving|server|underage|ages?|aged|years? old|year olds?|how old|1[3-9]|2[01]|adults?|fake|allowed|get in|getting in|let (?:us|me|them|my \\w+) in)\\b",
].join('|'), 'i');

/** Whether `text` says anything about drinks, ID, age limits or getting in. */
function talksAboutDrinksIdOrDoor(text) {
  return DOOR_TALK.test(String(text == null ? '' : text));
}

/**
 * Whether the person's own message raises any of it, read more broadly than a
 * reply is, so an ask this is unsure of is answered the plain no's way.
 */
function raisesDrinksIdOrDoor(text) {
  return RAISES.test(String(text == null ? '' : text));
}

module.exports = { DOOR_TALK, talksAboutDrinksIdOrDoor, raisesDrinksIdOrDoor };
