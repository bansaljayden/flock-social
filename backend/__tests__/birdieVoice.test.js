// Run: node --test  (from backend/)
//
// Birdie's system prompt is the only thing standing between a user and a
// chatbot voice, and it is also where three of the app's safety guardrails
// actually live. Those two facts pull in opposite directions: the prompt gets
// rewritten whenever someone decides Birdie sounds boring, and a voice rewrite
// that drops a line is indistinguishable, in the diff, from a voice rewrite
// that drops a rule. Nothing downstream can catch it. There is no client code
// between the model's prose and the user's screen.
//
// So this file pins the prompt in three layers:
//   1. VOICE. The specific assistant tells the 2026-08-18 rewrite banned.
//   2. SAFETY. Every age-bracket instruction, per bracket, word for word.
//   3. CAPABILITY. Every tool name and every rule about how to use them, so a
//      voice edit that eats a tool instruction fails here instead of silently
//      breaking the tool loop in production.
//
// Read via routes/ai.js's `__testables` rather than by driving POST /api/ai/chat
// with a mocked SDK: the age brackets have four branches and the tier line two,
// and combinations are the point. __tests__/confidenceForwarding.test.js and
// __tests__/forecastGateParity.test.js still assert the same prompt through the
// real route, which is what proves this function is the one the route calls.
const test = require('node:test');
const assert = require('node:assert');

const { buildSystemPrompt } = require('../routes/ai').__testables;

const BRACKETS = ['minor', 'under21', 'adult', null];

/** Every prompt this function can produce: 4 age brackets x 2 tiers. */
function everyPrompt() {
  const out = [];
  for (const ageBracket of BRACKETS) {
    for (const freeTier of [true, false]) {
      out.push({
        label: `ageBracket=${ageBracket} freeTier=${freeTier}`,
        text: buildSystemPrompt('Jay', {}, { ageBracket, freeTier }),
      });
    }
  }
  return out;
}

const adult = () => buildSystemPrompt('Jay', {}, { ageBracket: 'adult' });
const minor = () => buildSystemPrompt('Jay', {}, { ageBracket: 'minor' });

// ---------------------------------------------------------------------------
// 1. Voice
// ---------------------------------------------------------------------------

test('the prompt bans the assistant tells by name, not by vibe', () => {
  // "Be conversational" does nothing. A model drops "Great question!" when the
  // string "Great question" appears next to the word never, and not before.
  // Each entry is a phrase the rewrite was written to kill; the assertion is
  // that the phrase itself is quoted in the prompt so the model can match it.
  const bannedPhrases = [
    'Great question',
    'Sure thing',
    'Absolutely',
    'Happy to help',
    'Let me know if you',
    'Want me to',
    'Hope that helps',
    'Anything else',
  ];
  const prompt = adult();
  for (const phrase of bannedPhrases) {
    assert.ok(prompt.includes(phrase),
      `the prompt no longer quotes "${phrase}", so nothing stops Birdie opening or closing with it`);
  }
});

test('the four behaviours actually complained about in use are each forbidden', () => {
  const prompt = adult();
  const rules = [
    // Verbosity.
    [/Never use a list where a sentence works/, 'the no-bullets-for-one-sentence rule is gone'],
    [/Short sentences/, 'the length rule is gone'],
    // Trailing caveats. The live complaint: a good answer with an apology stapled on.
    [/Never trail a caveat/, 'nothing stops Birdie stapling a caveat to a finished answer'],
    [/Never hedge something you can just say/, 'the anti-hedging rule is gone'],
    // Restating the question back.
    [/Never restate the question before you answer it/, 'nothing stops Birdie echoing the prompt back'],
    // Sign-offs and enthusiasm.
    [/No sign-off of any kind/, 'the no-sign-off rule is gone'],
    [/Never use an exclamation mark for enthusiasm/, 'the exclamation-mark rule is gone'],
    [/At most one emoji per reply/, 'the emoji cap is gone'],
    // Breaking character.
    [/Never call yourself an AI/, 'nothing stops Birdie announcing that it is an AI assistant'],
  ];
  for (const [re, why] of rules) assert.match(prompt, re, why);
});

test('Birdie is told to pick one place, not to present a menu', () => {
  // The single most-requested change: an assistant that offers three options
  // and asks which you prefer has made the decision the user came to avoid.
  const prompt = adult();
  assert.match(prompt, /Pick ONE spot/, 'the pick-one instruction is gone');
  assert.match(prompt, /Never hand them three options/,
    'nothing stops Birdie listing options and asking the user to choose');
  assert.match(prompt, /You have opinions and you lead with them/,
    'the opinionated-voice instruction is gone');
});

test('the joke rule is a limit, not an instruction to be funny', () => {
  // "Be funny" produces a model that opens every reply with a bit. The rule has
  // to carry its own brake or the personality change costs more than it buys.
  assert.match(adult(), /A forced joke is worse than no joke/,
    'the anti-forced-joke brake is gone; "be funny" on its own makes Birdie insufferable');
});

// ---------------------------------------------------------------------------
// 2. DESIGN-STANDARD.md (repo root). Birdie's words are user-visible product copy,
//    so the site's copy rules bind them.
// ---------------------------------------------------------------------------

test('no em dash appears in the prompt itself, in any bracket or tier', () => {
  // The prompt instructs the model never to emit an em dash, and the prompt
  // used to be full of them: the app-description block used " — " as its
  // separator on eight lines. A rule contradicted by every example above it is
  // a rule the model discounts. Those separators are now colons and periods,
  // which is why this can be swept over the whole string rather than scoped to
  // one line the way __tests__/forecastGateParity.test.js had to scope it.
  for (const { label, text } of everyPrompt()) {
    const bad = text.split('\n').filter((l) => /[—–]/.test(l));
    assert.deepStrictEqual(bad, [],
      `DESIGN-STANDARD.md rule 1: em dash in the prompt (${label}):\n${bad.join('\n')}`);
  }
  // And the instruction it is meant to be consistent with is still there.
  assert.match(adult(), /Never use em dashes/, 'the em dash instruction left the prompt');
});

test('the cliche vocabulary is banned in the prompt, and absent from it', () => {
  const slop = ['seamless', 'effortless', 'unlock', 'elevate', 'curated', 'empower'];
  const prompt = adult();
  // Named, so the model can match them.
  const bannedLine = prompt.split('\n').find((l) => l.startsWith('- Banned words:'));
  assert.ok(bannedLine, 'the banned-words line is gone from the prompt');
  for (const w of slop) {
    assert.ok(bannedLine.includes(w), `"${w}" dropped off the banned-words list`);
  }
  // ...and not used anywhere else in the prompt, which would model the opposite.
  for (const { label, text } of everyPrompt()) {
    for (const line of text.split('\n')) {
      if (line.startsWith('- Banned words:')) continue;
      for (const w of slop) {
        assert.ok(!new RegExp(`\\b${w}`, 'i').test(line),
          `cliche word "${w}" used in the prompt itself (${label}): ${line}`);
      }
    }
  }
});

test('the negation-pivot cliche is banned', () => {
  assert.match(adult(), /No "it's not X, it's Y"/,
    'DESIGN-STANDARD.md section B: the negation-pivot ban left the prompt');
});

// ---------------------------------------------------------------------------
// 3. Safety. The enforced floor on this app is 13 (utils/age.js MIN_AGE), so
//    the age bracket is the whole of what keeps a 13-year-old out of a bar
//    recommendation. Personality went up in the 2026-08-18 rewrite; none of
//    this moved, and this test is what says so.
// ---------------------------------------------------------------------------

test('the under-18 instruction survives word for word', () => {
  const prompt = minor();
  assert.ok(prompt.includes('The user is UNDER 18. Never recommend bars, clubs, nightlife, or anything alcohol-centric.'),
    'the under-18 alcohol rule was reworded or removed');
  assert.ok(prompt.includes('Steer to all-ages spots: food, cafes, arcades, bowling, activities, events.'),
    'the all-ages steer was reworded or removed');
  // Reworded from "Do this silently — no lectures" only to drop the em dash the
  // prompt itself forbids. Same sentence, same meaning, no dash.
  assert.ok(prompt.includes('Do this silently, no lectures, just good picks.'),
    'the no-lectures instruction was removed');
  // Added by the voice rewrite: personality up, edge explicitly not.
  assert.match(prompt, /no profanity, nothing sexual, no drug or vape talk/,
    'the minor bracket lost its explicit clean-voice constraint');
});

test('the under-21 instruction survives word for word', () => {
  const prompt = buildSystemPrompt('Jay', {}, { ageBracket: 'under21' });
  assert.ok(prompt.includes('The user is under 21 (US drinking age). Skip bars and clubs unless they explicitly ask; favor restaurants, cafes, and activities.'),
    'the under-21 rule was reworded or removed');
  assert.match(prompt, /Never help anyone get served underage/,
    'the under-21 bracket lost the underage-service rule');
});

test('an unknown age is treated as a reason for caution, not as an adult', () => {
  // This branch used to emit the empty string. A user with no date of birth on
  // record therefore got the default voice with NO alcohol rule attached to it
  // at all, which was the least-known user getting the least-constrained
  // prompt. Fail loudly if that regresses.
  const prompt = buildSystemPrompt('Jay', {}, { ageBracket: null });
  assert.match(prompt, /You do not know this user's age/,
    'the unknown-age bracket emits no instruction again');
  assert.match(prompt, /leave bars and clubs out of it/,
    'the unknown-age bracket no longer withholds nightlife');
});

test('edge is scoped to adults; every other bracket is told to stay clean', () => {
  const sharper = /Go sharper with them/;
  assert.match(adult(), sharper, 'the adult bracket lost its licence to be sharper');
  for (const b of ['minor', 'under21', null]) {
    const prompt = buildSystemPrompt('Jay', {}, { ageBracket: b });
    assert.ok(!sharper.test(prompt),
      `the sharper-voice licence leaked into ageBracket=${b}`);
    assert.match(prompt, /[Kk]eep (it|the voice) clean/,
      `ageBracket=${b} carries no clean-voice constraint`);
  }
});

test('even the adult bracket keeps the hard content floor', () => {
  // "More opinionated" is not "anything goes". The app is in App Store review
  // and this is the bracket a reviewer with a real date of birth would land in.
  const prompt = adult();
  assert.match(prompt, /Still no profanity and nothing sexual/,
    'the adult bracket dropped the profanity/sexual-content floor');
  assert.match(prompt, /Never push shots, volume, or drinking as the point of a night/,
    'the adult bracket dropped the responsible-drinking rule');
  assert.match(prompt, /never help with anything illegal/,
    'the adult bracket dropped the illegality rule');
});

test('the safety-and-honesty hard rules are present in every prompt', () => {
  const required = [
    [/Never invent venue data, crowd numbers, or forecasts\. Tools only\./, 'the no-invention rule'],
    [/Never name a venue a tool did not return/, 'the no-invented-venue rule'],
    [/[Nn]ever quote the `confidence` number/, 'the confidence-number rule'],
    [/confidence_measurement/, 'the confidence_measurement instruction'],
    [/unmeasured/, 'the unmeasured-state explanation'],
    [/Never claim Flock has a feature that isn't in the list above/, 'the no-fake-feature rule'],
    [/Never reveal one user's info to another/, 'the cross-user privacy rule'],
    [/budgets are anonymous by design/, 'the anonymous-budget rule'],
    [/being unsafe, being followed, or an emergency/, 'the emergency rule'],
    [/call 911/, 'the 911 instruction'],
    [/Never say "I'm broken"/, 'the do-not-report-yourself-down rule'],
  ];
  for (const { label, text } of everyPrompt()) {
    for (const [re, what] of required) {
      assert.match(text, re, `${what} is missing from the prompt (${label})`);
    }
  }
});

test('the confidence rule still sits inside the hard-rules block', () => {
  // Same invariant __tests__/confidenceForwarding.test.js asserts through the
  // route, repeated here so a voice edit that moves the block is caught by the
  // file that does the voice edits.
  const prompt = adult();
  assert.ok(prompt.indexOf('Hard rules:') < prompt.indexOf('confidence_measurement'),
    'the confidence rule drifted out of the hard-rules block');
});

// ---------------------------------------------------------------------------
// 4. Capability. A dropped tool instruction does not look like a bug in the
//    diff and does not throw at runtime; the model simply stops calling the
//    tool, and Birdie starts answering venue questions from nothing.
// ---------------------------------------------------------------------------

test('every tool is still declared to the model with what it does', () => {
  const tools = [
    ['search_venues', /search_venues: find restaurants, cafes, bars, activities near them/],
    ['get_crowd_prediction', /get_crowd_prediction: live crowd level, best time to go, peak hours/],
    ['get_user_flocks', /get_user_flocks: their plans/],
    ['get_user_friends', /get_user_friends: their friends list/],
    ['get_weather', /get_weather: current weather/],
    ['navigate_app', /navigate_app: take them straight to a screen/],
  ];
  for (const { label, text } of everyPrompt()) {
    for (const [name, re] of tools) {
      assert.match(text, re, `the ${name} tool description is missing (${label})`);
    }
  }
});

test('the rules about WHEN to call a tool survive', () => {
  const prompt = adult();
  assert.match(prompt, /USE navigate_app to take them there\. Don't just describe the path\./,
    'the navigate-instead-of-describing rule is gone; Birdie will narrate menu paths again');
  assert.match(prompt, /Search real categories \(bars, food, activities\), never the slang words themselves/,
    'the "do not search the slang" rule is gone; Birdie will query Places for "poppin"');
  assert.match(prompt, /always pass location to search_venues/,
    'the location-passing rule is gone');
  assert.match(prompt, /If not, ask where they are, once\./,
    'the ask-once rule is gone; Birdie will re-ask for location every turn');
  assert.match(prompt, /Crowds: translate numbers into advice/,
    'the crowd-translation rule is gone');
});

test('the slang decoder survives intact', () => {
  const prompt = adult();
  for (const term of ['the move', 'pull up', 'dead', 'poppin', 'lowkey', 'bet', 'no cap']) {
    assert.ok(prompt.includes(`"${term}"`), `the slang decoder lost "${term}"`);
  }
});

test('the app map keeps every user-facing name and every tool enum', () => {
  // The enums on the right are what navigate_app actually accepts. The 2026-08-18
  // rewrite changed the separator on these lines from an em dash to a colon;
  // the pairs themselves must not have moved with it.
  const pairs = [
    ['**Nest**', '(tab: home)'],
    ['**Discover**', '(tab: explore)'],
    ['**Plans**', '(tab: calendar)'],
    // 'chat', not 'chats', since 2026-08-27: the plural was a tab id the app
    // never had, so Birdie's Take-me-there for Messages landed on the Nest.
    ['**Messages**', '(tab: chat)'],
    ['**You**', '(tab: profile)'],
    ['**Create a flock**', '(screen: create)'],
    ['**Add friends**', '(screen: addFriends)'],
    ['**Safety**', '(profile_section: safety)'],
  ];
  const prompt = adult();
  for (const [name, enumStr] of pairs) {
    const line = prompt.split('\n').find((l) => l.includes(name));
    assert.ok(line, `the app map lost ${name}`);
    assert.ok(line.includes(enumStr), `${name} lost its tool enum ${enumStr}: ${line}`);
  }
});

test('the flock and friend context rules survive', () => {
  const prompt = adult();
  assert.match(prompt, /anonymous budget matching/, 'the budget-matching description is gone');
  assert.match(prompt, /only ever sees the ceiling, never anyone's number, and only after 3\+ people submit/,
    'the budget privacy invariant was reworded; this sentence is what stops Birdie speculating about amounts');
  assert.match(prompt, /bill splitting after \(Venmo\/Cash App\/Zelle links, marked paid manually\)/,
    'the bill-splitting description is gone');
  assert.match(prompt, /guest invite links/, 'the guest-invite description is gone');
  assert.match(prompt, /venue voting/, 'the venue-voting description is gone');
});

test('the live-context block is still appended', () => {
  // buildContextLine is what teaches the model what "this place" refers to.
  const prompt = buildSystemPrompt('Jay',
    { screen: 'venue', venue: { name: 'Oakwood', place_id: 'PID' } },
    { ageBracket: 'adult' });
  assert.match(prompt, /WHAT THE USER IS DOING RIGHT NOW/,
    'the current-context block stopped being appended to the prompt');
  assert.match(prompt, /Oakwood/, 'the active venue no longer reaches the prompt');
});

test('the free-tier line is still accurate and still tier-scoped', () => {
  // Duplicated from __tests__/forecastGateParity.test.js on purpose. That file
  // proves the route sends it; this one proves a voice edit did not rewrite the
  // only description of the paywall the user ever reads.
  const free = buildSystemPrompt('Jay', {}, { ageBracket: 'adult', freeTier: true });
  assert.match(free, /free tier/, 'the free-tier line vanished');
  assert.match(free, /first 30 venues/, 'the forecast allowance was misdescribed');
  assert.match(free, /Mention it at most once per conversation, never unprompted/,
    'the once-per-conversation cap on the Pro pitch is gone');
  const paid = buildSystemPrompt('Jay', {}, { ageBracket: 'adult', freeTier: false });
  assert.ok(!/free tier/.test(paid), 'a paying subscriber is being pitched the free tier');
});

test('a client that sells nothing gets no plan name, no pitch and a neutral limit, on every tier and bracket', () => {
  // The App Store build sends purchases: 'off' (frontend/src/lib/purchasesBuild.js).
  // Birdie then describes the same limits without naming a plan or offering
  // one, and is told not to talk about anything for sale even if asked.
  for (const ageBracket of BRACKETS) {
    for (const freeTier of [true, false]) {
      const label = `ageBracket=${ageBracket} freeTier=${freeTier}`;
      const text = buildSystemPrompt('Jay', {}, { ageBracket, freeTier, salesOff: true });
      assert.ok(!/\bPro\b/.test(text), `${label}: the plan is named`);
      assert.ok(!/You can mention/.test(text), `${label}: a pitch is still allowed`);
      assert.ok(!/free tier/.test(text), `${label}: the tier is described as a plan`);
      assert.ok(!/150/.test(text), `${label}: the paid allowance is described`);
      assert.match(text, /Never mention a paid plan, a subscription, an upgrade, a price or anything for sale, even if they ask about one\./, `${label}: no instruction against sales talk`);
      assert.match(text, /past this account's limit for now/, `${label}: no neutral limit line`);
      assert.ok(!text.includes('—'), `${label}: em dash`);
      // Everything else in the prompt is the same prompt.
      assert.ok(text.startsWith('You are Birdie, the assistant inside Flock'), label);
    }
  }
  const free = buildSystemPrompt('Jay', {}, { ageBracket: 'adult', freeTier: true, salesOff: true });
  assert.match(free, /no crowd reading, that venue is past this account's limit for now: say so plainly and never guess how busy it is/,
    'the spent-month rule was lost with the sales copy');
  // Unset, the web prompt is exactly as before.
  const web = buildSystemPrompt('Jay', {}, { ageBracket: 'adult', freeTier: true });
  assert.strictEqual(web, buildSystemPrompt('Jay', {}, { ageBracket: 'adult', freeTier: true, salesOff: false }));
  assert.match(web, /then it is Flock Pro/);
});

test('the prompt still opens as Birdie', () => {
  // __tests__/geminiSpendLedger.test.js and __tests__/paidCallBudgets.test.js
  // both assert /You are Birdie/ off the wire. Keep the string.
  for (const { label, text } of everyPrompt()) {
    assert.ok(text.startsWith('You are Birdie, the assistant inside Flock'),
      `the prompt no longer opens as Birdie (${label})`);
  }
});

// ---------------------------------------------------------------------------
// The accuracy answer. Birdie may state how accurate Flock's crowd numbers are
// only with the figures measured for the serving configuration that is making
// them, and only while that configuration is on: with either switch off the
// numbers are made another way and the figures describe nothing being served.
// ---------------------------------------------------------------------------
function withServeEnv(mode, nowcast, fn) {
  const saved = { mode: process.env.CROWD_SERVE_MODE, nowcast: process.env.CROWD_NOWCAST_ENABLED };
  const set = (k, v) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
  set('CROWD_SERVE_MODE', mode);
  set('CROWD_NOWCAST_ENABLED', nowcast);
  try { return fn(); } finally {
    set('CROWD_SERVE_MODE', saved.mode);
    set('CROWD_NOWCAST_ENABLED', saved.nowcast);
  }
}

test('with curve_offset and the nowcast on, Birdie can quote the measured accuracy, and only that', () => {
  const served = require('../services/servedAccuracy.json');
  const prompt = withServeEnv('curve_offset', 'true', adult);
  assert.match(prompt, /If someone asks how accurate Flock's crowd levels are, answer from these measured figures and nothing else\./);
  assert.ok(prompt.includes(`Tested against ${served.rows.toLocaleString('en-US')} real live readings it had not seen (September 6 to 8, 2026), ${Math.round(served.within_one_band)}% of Flock's crowd numbers landed within one crowd level`),
    'the within-one-level figure is not the one servedAccuracy.json records');
  assert.ok(prompt.includes(`the average miss was ${Math.round(served.mae)} points`));
  assert.ok(prompt.includes(`${Math.round(served.reading_one_hour_earlier.within_one_band)}% landed within one level`));
  assert.match(prompt, /never how sure one number is\./);
  // Inside the hard rules, beside the confidence rule it qualifies.
  const at = prompt.indexOf('how accurate Flock');
  assert.ok(prompt.indexOf('Hard rules:') < at);
  assert.ok(!/—/.test(prompt.slice(at, at + 600)));
});

test('with either switch off, the prompt states no accuracy figure', () => {
  for (const [mode, nowcast] of [[undefined, undefined], ['curve_offset', undefined], [undefined, 'true'], ['model', 'true']]) {
    const prompt = withServeEnv(mode, nowcast, adult);
    assert.ok(!prompt.includes('how accurate Flock'), `accuracy line present with CROWD_SERVE_MODE=${mode} CROWD_NOWCAST_ENABLED=${nowcast}`);
    assert.ok(!/78\.8|79%/.test(prompt));
  }
});
