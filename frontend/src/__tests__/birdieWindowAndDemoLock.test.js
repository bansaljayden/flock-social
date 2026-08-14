/**
 * The client half of two server changes.
 *
 * WHAT THIS COVERS
 *   1. Birdie's context window. backend/routes/ai.js takes at most 24 messages
 *      and answers 400 CONVERSATION_TOO_LONG past that; App.js used to send the
 *      whole conversation, so the 25th turn of every chat was refused. The
 *      trimming, the marker that says where Birdie's memory starts, and the
 *      one-shot retry are pure functions and source wiring, both checked here.
 *   2. The cross-file invariant behind that cap. The message count and the
 *      per-message character ceiling are spelled in THREE files: this client,
 *      backend/routes/ai.js (the validator) and backend/server.js (which sizes
 *      the route's scoped JSON parser from them). If the client ever sends more
 *      than the parser accepts, the honest 400 becomes a 413 that body-parser
 *      raises before any route code runs, carrying no code and nothing to act
 *      on. Three literals that must agree is exactly the shape of bug this repo
 *      has shipped three times (migrations 003, 016 and 017).
 *   3. The live demo's locked forecast. backend/routes/publicCrowd.js marks the
 *      paid boundary with `forecast_locked` and empties best_time, peak_hours
 *      and hourly. LiveDemo.js degraded correctly and said NOTHING, so the
 *      section silently lost its chart and read as a broken product.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test --watchAll=false
 *
 * This is a FRONTEND test (jest via react-scripts), not a `node --test` one.
 * Neither App.js nor LiveDemo.js can be imported here (one is the whole app,
 * the other pulls maplibre), so the pure helpers are lifted out by name and
 * evaluated, the same technique contentTakedownWiring.test.js uses.
 */

const fs = require('fs');
const path = require('path');

const APP_PATH = path.resolve(__dirname, '../App.js');
const DEMO_PATH = path.resolve(__dirname, '../website/LiveDemo.js');
const AI_ROUTE_PATH = path.resolve(__dirname, '../../../backend/routes/ai.js');
const SERVER_PATH = path.resolve(__dirname, '../../../backend/server.js');

// Normalised to LF: these files are CRLF on disk, and a multi-line assertion
// written with \n would pass on one checkout convention and fail on the other,
// which is a failure that says nothing about the code.
const readSource = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

const appSource = readSource(APP_PATH);
const demoSource = readSource(DEMO_PATH);
const aiRouteSource = readSource(AI_ROUTE_PATH);
const serverSource = readSource(SERVER_PATH);

// ───────────────────────────────────────────────────────────────────────────
// Source readers
// ───────────────────────────────────────────────────────────────────────────

/**
 * Walk `source` from `i`, returning the index just past any string, template
 * literal or comment that starts there, and `i` itself otherwise. Every scanner
 * below needs this: the declarations being lifted carry long prose comments
 * with apostrophes, braces and semicolons in them.
 */
function skipInert(source, i) {
  const ch = source[i];
  const next = source[i + 1];
  if (ch === '/' && next === '/') {
    const end = source.indexOf('\n', i);
    return end === -1 ? source.length : end;
  }
  if (ch === '/' && next === '*') {
    const end = source.indexOf('*/', i + 2);
    return end === -1 ? source.length : end + 2;
  }
  if (ch === "'" || ch === '"' || ch === '`') {
    let j = i + 1;
    while (j < source.length) {
      if (source[j] === '\\') { j += 2; continue; }
      if (source[j] === ch) return j + 1;
      j += 1;
    }
    return source.length;
  }
  return i;
}

/** `const <name> = …;` at column 0, to the semicolon that closes it. */
function extractDeclaration(source, name) {
  const start = source.search(new RegExp(`^const ${name} = `, 'm'));
  if (start === -1) throw new Error(`extractDeclaration: no module-scope \`const ${name} =\` in source`);
  let i = source.indexOf('=', start) + 1;
  let depth = 0;
  while (i < source.length) {
    const skipped = skipInert(source, i);
    if (skipped !== i) { i = skipped; continue; }
    const ch = source[i];
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    else if (ch === ';' && depth === 0) return source.slice(start, i + 1);
    i += 1;
  }
  throw new Error(`extractDeclaration: unterminated declaration for ${name}`);
}

/** `function <name>(…) { … }` at column 0, to its closing brace. */
function extractFunction(source, name) {
  const start = source.search(new RegExp(`^function ${name}\\(`, 'm'));
  if (start === -1) throw new Error(`extractFunction: no module-scope \`function ${name}(\` in source`);
  let i = source.indexOf('{', start);
  if (i === -1) throw new Error(`extractFunction: no body for ${name}`);
  let depth = 0;
  while (i < source.length) {
    const skipped = skipInert(source, i);
    if (skipped !== i) { i = skipped; continue; }
    const ch = source[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
    i += 1;
  }
  throw new Error(`extractFunction: unterminated body for ${name}`);
}

function evaluate(chunks, names) {
  // eslint-disable-next-line no-new-func
  return new Function(`${chunks.join('\n')}\nreturn { ${names.join(', ')} };`)();
}

// The single number the whole first half turns on, read out of each file that
// spells it rather than written down here a fourth time.
const readNumber = (source, name) => {
  const m = source.match(new RegExp(`^const ${name} = (\\d+);`, 'm'));
  if (!m) throw new Error(`no \`const ${name} = <number>;\` in source`);
  return Number(m[1]);
};

const APP_NAMES = [
  'AI_CHAT_MAX_MESSAGES',
  'AI_CHAT_MAX_MESSAGE_CHARS',
  'trimAiHistory',
  'aiMemoryCutIndex',
  'toAiWireMessages',
];
const {
  AI_CHAT_MAX_MESSAGES,
  AI_CHAT_MAX_MESSAGE_CHARS,
  trimAiHistory,
  aiMemoryCutIndex,
  toAiWireMessages,
} = evaluate(APP_NAMES.map((n) => extractDeclaration(appSource, n)), APP_NAMES);

const DEMO_CONSTS = ['pct', 'venueName', 'forecastIsLocked', 'LOCKED_FORECAST_COPY'];
const DEMO_FUNCS = ['crowdWord', 'cardSentence'];
const demo = evaluate(
  [
    ...DEMO_CONSTS.map((n) => extractDeclaration(demoSource, n)),
    ...DEMO_FUNCS.map((n) => extractFunction(demoSource, n)),
  ],
  [...DEMO_CONSTS, ...DEMO_FUNCS]
);
const { forecastIsLocked, LOCKED_FORECAST_COPY, cardSentence } = demo;

const turns = (n) => Array.from({ length: n }, (_, i) => ({
  role: i % 2 === 0 ? 'user' : 'assistant',
  text: `m${i}`,
}));

// ───────────────────────────────────────────────────────────────────────────
// 1. trimAiHistory — what actually goes on the wire
// ───────────────────────────────────────────────────────────────────────────
describe('trimAiHistory', () => {
  test('the cap is the server\'s 24, not a number this file made up', () => {
    expect(AI_CHAT_MAX_MESSAGES).toBe(24);
    expect(AI_CHAT_MAX_MESSAGE_CHARS).toBe(4000);
  });

  test('a conversation that fits comes back as the SAME array', () => {
    for (const n of [0, 1, 23, AI_CHAT_MAX_MESSAGES]) {
      const before = turns(n);
      expect(trimAiHistory(before)).toBe(before);
    }
  });

  test('the 25th turn sends 24 messages, and they are the LAST 24', () => {
    const before = turns(25);
    const after = trimAiHistory(before);
    expect(after).toHaveLength(AI_CHAT_MAX_MESSAGES);
    expect(after[0].text).toBe('m1');
    expect(after[after.length - 1].text).toBe('m24');
    expect(before).toHaveLength(25); // the transcript itself is not mutated
  });

  test('no conversation length can ever exceed the cap', () => {
    for (let n = 0; n <= 200; n += 7) {
      expect(trimAiHistory(turns(n)).length).toBeLessThanOrEqual(AI_CHAT_MAX_MESSAGES);
    }
  });

  test('the newest message is never the one dropped', () => {
    // The last element is the turn the user just typed. The server reads it as
    // the current input; trimming it away would answer the wrong question.
    const after = trimAiHistory(turns(90));
    expect(after[after.length - 1].text).toBe('m89');
  });

  test('an explicit smaller max is honoured, for the server\'s retry number', () => {
    expect(trimAiHistory(turns(25), 10)).toHaveLength(10);
    expect(trimAiHistory(turns(25), 10)[0].text).toBe('m15');
  });

  test('a nonsense max falls back to the cap instead of emptying the payload', () => {
    // `maxMessages` arrives over the wire. A 0, a negative or a non-integer
    // must not turn into a request with no messages in it, which the server
    // refuses with "messages array is required" and the user reads as Birdie
    // breaking for a second, unrelated reason.
    for (const bad of [0, -1, 1.5, NaN, null, undefined, 'ten', {}]) {
      expect(trimAiHistory(turns(30), bad)).toHaveLength(AI_CHAT_MAX_MESSAGES);
    }
  });

  test('a non-array is an empty payload, never a throw inside the send', () => {
    for (const bad of [null, undefined, 'nope', 7, {}]) {
      expect(trimAiHistory(bad)).toEqual([]);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 2. aiMemoryCutIndex — the line drawn in the transcript
// ───────────────────────────────────────────────────────────────────────────
describe('aiMemoryCutIndex', () => {
  test('nothing is marked while the whole conversation still fits', () => {
    for (let n = 0; n < AI_CHAT_MAX_MESSAGES; n += 1) {
      expect(aiMemoryCutIndex(n)).toBe(0);
    }
  });

  test('the mark appears exactly when the next send starts dropping turns', () => {
    expect(aiMemoryCutIndex(AI_CHAT_MAX_MESSAGES)).toBe(1);
    expect(aiMemoryCutIndex(AI_CHAT_MAX_MESSAGES + 1)).toBe(2);
    expect(aiMemoryCutIndex(100)).toBe(100 - (AI_CHAT_MAX_MESSAGES - 1));
  });

  test('THE INVARIANT: what is below the line is exactly what gets sent next', () => {
    // This is the whole reason the marker is honest. Everything from the cut
    // down, plus the message the visitor is about to type, is precisely the
    // payload trimAiHistory will build. If these two ever disagree, the line
    // is drawn in the wrong place and the UI is lying about what Birdie reads.
    for (let n = 0; n <= 60; n += 1) {
      const transcript = turns(n);
      const cut = aiMemoryCutIndex(n);
      const kept = transcript.slice(cut);
      const nextPayload = trimAiHistory([...transcript, { role: 'user', text: 'next' }]);
      expect(kept.length + 1).toBe(nextPayload.length);
      expect(nextPayload.map((m) => m.text)).toEqual([...kept.map((m) => m.text), 'next']);
    }
  });

  test('never negative and never past the end', () => {
    for (const n of [-5, 0, 3, 24, 500]) {
      const cut = aiMemoryCutIndex(n);
      expect(cut).toBeGreaterThanOrEqual(0);
      expect(cut).toBeLessThanOrEqual(Math.max(0, n));
    }
  });

  test('a nonsense count marks nothing rather than marking message zero', () => {
    for (const bad of [null, undefined, NaN, 1.5, 'twelve']) {
      expect(aiMemoryCutIndex(bad)).toBe(0);
    }
  });

  test('a nonsense max falls back to the cap, exactly as the trimmer does', () => {
    // Symmetry with trimAiHistory is the point: these two must agree about what
    // "the window" is under every argument, or the line on screen and the
    // payload on the wire are computed from different numbers. Today only the
    // trimmer is handed a max off the wire, and this keeps the pair honest if
    // the marker is ever handed one too.
    for (const bad of [0, -1, 1.5, NaN, null, undefined, 'ten', {}]) {
      expect(aiMemoryCutIndex(30, bad)).toBe(aiMemoryCutIndex(30));
      expect(aiMemoryCutIndex(10, bad)).toBe(0);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 3. toAiWireMessages — the shape the route validates
// ───────────────────────────────────────────────────────────────────────────
describe('toAiWireMessages', () => {
  test('exactly {role, text} goes out, and nothing else on the message', () => {
    const out = toAiWireMessages([
      { role: 'user', text: 'where tonight', navigate: { screen: 'main' }, venues: [] },
    ]);
    expect(Object.keys(out[0]).sort()).toEqual(['role', 'text']);
    expect(out[0]).toEqual({ role: 'user', text: 'where tonight' });
  });

  test('the venues Birdie showed are folded into its own turn', () => {
    const out = toAiWireMessages([
      { role: 'user', text: 'bars?' },
      {
        role: 'assistant',
        text: 'two good ones',
        venues: [
          { name: 'Good Dog Bar', crowd_label: 'Busy', is_open: true },
          { name: 'Tattooed Mom', is_open: false },
        ],
      },
    ]);
    expect(out[0].text).toBe('bars?');
    expect(out[1].text).toBe('two good ones\n[Venues shown: Good Dog Bar (Busy, open), Tattooed Mom (crowd unknown, closed)]');
  });

  test('a user turn is never annotated, even carrying a venues array', () => {
    const out = toAiWireMessages([{ role: 'user', text: 'hi', venues: [{ name: 'X' }] }]);
    expect(out[0].text).toBe('hi');
  });

  test('every message is clamped to the server\'s per-message ceiling', () => {
    // The cap applies to the HISTORY too, so one over-long message used to 400
    // every later send in the same conversation, permanently, with no way out.
    const out = toAiWireMessages([{ role: 'user', text: 'x'.repeat(AI_CHAT_MAX_MESSAGE_CHARS + 500) }]);
    expect(out[0].text).toHaveLength(AI_CHAT_MAX_MESSAGE_CHARS);
  });

  test('the venue annotation cannot push a turn over the ceiling either', () => {
    const out = toAiWireMessages([{
      role: 'assistant',
      text: 'y'.repeat(AI_CHAT_MAX_MESSAGE_CHARS - 5),
      venues: [{ name: 'A very long venue name that runs past the end', is_open: true }],
    }]);
    expect(out[0].text.length).toBeLessThanOrEqual(AI_CHAT_MAX_MESSAGE_CHARS);
  });

  test('a message that fits is not copied character by character', () => {
    const text = 'short enough';
    expect(toAiWireMessages([{ role: 'user', text }])[0].text).toBe(text);
  });

  test('a missing or non-string body becomes an empty string, not "undefined"', () => {
    // The route prefixes location onto the last message and hands the string
    // to Gemini. A literal "undefined" in there is a paid call for nothing.
    for (const bad of [undefined, null, 7, {}]) {
      expect(toAiWireMessages([{ role: 'user', text: bad }])[0].text).toBe('');
    }
  });

  test('a non-array is an empty payload rather than a throw', () => {
    // `messages || []` covers null and undefined and NOT the interesting cases:
    // a number or a string has no .map, and a throw here happens INSIDE the
    // send, after the user's bubble is already on screen, so it reads as
    // Birdie failing rather than as a bad argument.
    for (const bad of [null, undefined, 7, 'nope', {}, true]) {
      expect(toAiWireMessages(bad)).toEqual([]);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 4. Client and server agree about the cap
// ───────────────────────────────────────────────────────────────────────────
describe('the message cap is the same number in all three files', () => {
  test('routes/ai.js names it and the validator spells the same literal', () => {
    expect(readNumber(aiRouteSource, 'AI_CHAT_MAX_MESSAGES')).toBe(AI_CHAT_MAX_MESSAGES);
    const validator = aiRouteSource.match(/body\('messages'\)\.isArray\(\{ min: 1, max: (\d+) \}\)/);
    expect(validator).not.toBeNull();
    expect(Number(validator[1])).toBe(AI_CHAT_MAX_MESSAGES);
  });

  test('the per-message character ceiling matches the validator too', () => {
    const chars = aiRouteSource.match(/body\('messages\.\*\.text'\)[\s\S]{0,120}?isLength\(\{ max: (\d+) \}\)/);
    expect(chars).not.toBeNull();
    expect(Number(chars[1])).toBe(AI_CHAT_MAX_MESSAGE_CHARS);
  });

  test('server.js sizes the scoped body parser from those same two numbers', () => {
    // This is the reason the cap may not simply be raised on either side: more
    // messages than the parser was sized for turns an actionable 400 into a
    // 413 that body-parser raises before any route code runs.
    expect(readNumber(serverSource, 'AI_CHAT_MAX_MESSAGES')).toBe(AI_CHAT_MAX_MESSAGES);
    expect(readNumber(serverSource, 'AI_CHAT_MAX_MESSAGE_CHARS')).toBe(AI_CHAT_MAX_MESSAGE_CHARS);
    expect(serverSource).toContain('AI_CHAT_MAX_MESSAGES * AI_CHAT_MAX_MESSAGE_CHARS * JSON_STRING_BYTES_PER_CHAR');
  });

  test('the server really answers CONVERSATION_TOO_LONG with its own number', () => {
    expect(aiRouteSource).toContain("code: 'CONVERSATION_TOO_LONG'");
    expect(aiRouteSource).toContain('maxMessages: AI_CHAT_MAX_MESSAGES');
    expect(aiRouteSource).toContain('if (messageCount > AI_CHAT_MAX_MESSAGES)');
  });

  test('and the client acts on the code, reading the number off the payload', () => {
    expect(appSource).toContain("err?.code !== 'CONVERSATION_TOO_LONG'");
    expect(appSource).toContain('const serverMax = Number(err?.data?.maxMessages);');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 5. App.js wiring: the send path
// ───────────────────────────────────────────────────────────────────────────
describe('sendAiMessage wiring', () => {
  const sendAiMessageSource = (() => {
    const start = appSource.indexOf('const sendAiMessage = useCallback');
    expect(start).toBeGreaterThan(-1);
    const end = appSource.indexOf('const fillAiInput = useCallback', start);
    expect(end).toBeGreaterThan(start);
    return appSource.slice(start, end);
  })();

  test('the untruncated send is gone: every call goes through the trimmer', () => {
    // The old shape mapped `newMessages` inline and posted all of it.
    expect(appSource).not.toContain('const messagesToSend = newMessages.map');
    const calls = [...appSource.matchAll(/sendAiChat\(([^,]+),/g)].map((m) => m[1]);
    expect(calls).toHaveLength(2);
    for (const arg of calls) expect(arg).toBe('toAiWireMessages(outgoing)');
    expect(sendAiMessageSource).toContain('let outgoing = trimAiHistory(newMessages);');
  });

  test('the retry runs at most once, and only if it would send FEWER messages', () => {
    // A retry that resends the same payload is a request that cannot succeed,
    // and looping on it spends the free tier's daily meter on nothing.
    expect(sendAiMessageSource).toContain('serverMax >= outgoing.length) throw err;');
    expect(sendAiMessageSource).toContain('outgoing = trimAiHistory(outgoing, serverMax);');
    // Two sends in the function, no more: the first attempt and the one retry.
    expect(sendAiMessageSource.match(/await sendAiChat\(/g)).toHaveLength(2);
  });

  test('anything that is not a length refusal is rethrown untouched', () => {
    expect(sendAiMessageSource).toMatch(/if \(err\?\.code !== 'CONVERSATION_TOO_LONG'[\s\S]{0,200}?throw err;/);
  });

  test('a refusal that trimming cannot fix says the one thing that works', () => {
    // "try again" would be a suggestion that cannot succeed. New chat is a
    // control that exists, in the header of the same panel.
    expect(appSource).toContain("} else if (err?.code === 'CONVERSATION_TOO_LONG') {");
    expect(appSource).toContain('tap New chat up top');
    expect(appSource).toContain('const startNewAiChat = useCallback');
  });

  test('the length refusal is handled the way UPGRADE_REQUIRED already was', () => {
    // Same catch, same `err.code` switch, same "put a Birdie-voiced line in the
    // transcript" shape. Neither leaves the user with a spinner or a stack.
    expect(appSource).toContain("if (err?.code === 'UPGRADE_REQUIRED') {");
    const catchBlock = sendAiMessageSource.slice(sendAiMessageSource.indexOf('} catch (err) {\n      if (err?.code'));
    expect(catchBlock).toContain("role: 'assistant'");
  });

  test('only one turn can be in flight at a time', () => {
    expect(sendAiMessageSource).toContain('if (aiSendingRef.current) return;');
    expect(sendAiMessageSource).toContain('aiSendingRef.current = true;');
    // Released in `finally`, so a throw anywhere above cannot wedge Birdie shut.
    const finallyBlock = sendAiMessageSource.slice(sendAiMessageSource.indexOf('} finally {'));
    expect(finallyBlock).toContain('aiSendingRef.current = false;');
    expect(finallyBlock).toContain('setAiTyping(false);');
  });

  test('sending clears the has-text REF as well as the state', () => {
    // They are compared in the input\'s onInput to decide whether to re-render.
    // With the ref stuck true after the first send, typing the second message
    // never lit the send button again for the rest of the conversation.
    expect(sendAiMessageSource).toContain('aiInputHasTextRef.current = false;');
    expect(sendAiMessageSource).toContain('setAiInputHasText(false);');
  });
});

describe('the input box has one source of truth', () => {
  test('every setAiInputHasText call sits next to the matching ref write', () => {
    const lines = appSource.split('\n');
    const sites = [];
    lines.forEach((line, i) => {
      if (line.includes('setAiInputHasText(')) sites.push(i);
    });
    expect(sites.length).toBeGreaterThanOrEqual(4);
    for (const i of sites) {
      const window = lines.slice(Math.max(0, i - 4), i + 5).join('\n');
      expect(window).toContain('aiInputHasTextRef.current =');
    }
  });

  test('the controls that prefill the box go through one helper', () => {
    expect(appSource).toContain('const fillAiInput = useCallback((text, { send = false } = {}) => {');
    // The action row used to write the state and the DOM but not the ref, so
    // the box looked empty, the button stayed lit, and pressing it did nothing.
    expect(appSource).not.toContain('aiInputValueRef.current = action.prefix;');
    expect(appSource).not.toContain('aiInputValueRef.current = q.text;');
    expect(appSource).toContain('onClick={() => fillAiInput(q.text, { send: true })}');
    expect(appSource).toContain("onClick={() => fillAiInput(action.prefix, { send: action.prefix.endsWith('?') })}");
  });

  test('a chip tapped mid-answer fills the box instead of doing nothing', () => {
    const helper = appSource.slice(
      appSource.indexOf('const fillAiInput = useCallback'),
      appSource.indexOf('const startNewAiChat = useCallback')
    );
    expect(helper).toContain('if (send && !aiSendingRef.current) {');
    expect(helper).toContain('aiInputRef.current?.focus();');
  });

  test('the send button\'s look and its disabled state come off one value', () => {
    // `!aiInputHasText && !aiTyping` left it ENABLED over an empty box for the
    // whole time Birdie was answering, drawn at 0.4 opacity the entire time.
    expect(appSource).toContain('const canSendAi = aiInputHasText && !aiTyping;');
    expect(appSource).toContain('onClick={sendAiMessage} disabled={!canSendAi}');
    expect(appSource).not.toContain('disabled={!aiInputHasText && !aiTyping}');
  });

  test('the box cannot hold more than one message\'s worth of characters', () => {
    expect(appSource).toContain('maxLength={AI_CHAT_MAX_MESSAGE_CHARS}');
  });
});

describe('New chat', () => {
  const startNewSource = (() => {
    const start = appSource.indexOf('const startNewAiChat = useCallback');
    expect(start).toBeGreaterThan(-1);
    return appSource.slice(start, start + 700);
  })();

  test('it clears the thread and the box together', () => {
    expect(startNewSource).toContain('setAiMessages([]);');
    expect(startNewSource).toContain("aiInputValueRef.current = '';");
    expect(startNewSource).toContain('aiInputHasTextRef.current = false;');
    expect(startNewSource).toContain('setAiInputHasText(false);');
  });

  test('it refuses while a turn is in flight, in the handler AND on the button', () => {
    // Clearing the transcript under an outstanding request drops that reply
    // into an empty thread as an answer to a question that is no longer there.
    expect(startNewSource).toContain('if (aiSendingRef.current) return;');
    expect(appSource).toContain('onClick={startNewAiChat}');
    expect(appSource).toMatch(/onClick=\{startNewAiChat\}\n\s*disabled=\{aiTyping\}/);
  });

  test('it is a named control, not a bare glyph', () => {
    expect(appSource).toContain('aria-label="Start a new chat"');
    expect(appSource).toContain('title="New chat"');
  });
});

describe('the memory marker in the transcript', () => {
  const marker = (() => {
    const start = appSource.indexOf('{aiMemoryCut > 0 && i === aiMemoryCut && (');
    expect(start).toBeGreaterThan(-1);
    return appSource.slice(start, start + 700);
  })();

  test('it is computed from the same helper the payload uses', () => {
    expect(appSource).toContain('const aiMemoryCut = aiMemoryCutIndex(aiMessages.length);');
  });

  test('it prints the real number instead of hard-coding 24 a second time', () => {
    expect(marker).toContain('{AI_CHAT_MAX_MESSAGES} messages');
  });

  test('it says what is true and does not apologise for it', () => {
    // FUTURE TENSE. The cut marks the oldest message that survives the NEXT
    // send, so at exactly 24 messages the line appears while all 24 are still
    // being read: a present-tense "is out of view" is false at that moment and
    // true one message later, which is the wrong half of the boundary to be
    // wrong about.
    expect(marker).toContain('drops out of view on your next question.');
    expect(marker).not.toContain('is out of view.');
    for (const word of ['sorry', 'error', 'failed', 'oops']) {
      expect(marker.toLowerCase()).not.toContain(word);
    }
  });

  test('the tense matches the arithmetic: nothing is lost until the next send', () => {
    // At the length that first draws the line, the payload still carries every
    // message on screen. Only the send AFTER it drops anything.
    const atBoundary = Array.from({ length: AI_CHAT_MAX_MESSAGES }, (_, i) => ({ role: 'user', text: `m${i}` }));
    expect(aiMemoryCutIndex(atBoundary.length)).toBe(1);
    expect(trimAiHistory(atBoundary)).toBe(atBoundary);
    expect(trimAiHistory([...atBoundary, { role: 'user', text: 'next' }])[0].text).toBe('m1');
  });

  test('none of the new Birdie copy carries an em dash (SLOP-AUDIT A2/H18)', () => {
    // App.js as a whole cannot be swept: the admin-only moderation console uses
    // '—' as an empty-value placeholder. These are the strings this change
    // added, and they are the regression risk the audit names.
    const added = [
      marker,
      appSource.slice(appSource.indexOf('this thread got long for me'), appSource.indexOf('this thread got long for me') + 80),
      appSource.slice(appSource.indexOf('aria-label="Start a new chat"'), appSource.indexOf('aria-label="Start a new chat"') + 60),
    ];
    for (const copy of added) {
      expect(copy).not.toMatch(/[—–]/);
    }
  });

  test('the panel header can hold a third button at 320px', () => {
    // The title block has to be allowed to shrink, or the tagline wraps to
    // three lines and eats a panel that is only 55% of the screen tall.
    const header = appSource.slice(
      appSource.indexOf('{/* minWidth 0 and a one-line subtitle.'),
      appSource.indexOf('aria-label="Start a new chat"')
    );
    // BOTH: the outer row and the text block inside it. A flex item's default
    // min-width is auto, so one minWidth:0 without the other still refuses to
    // shrink past its content.
    expect(header.match(/minWidth: 0/g) || []).toHaveLength(2);
    expect(header).toContain("gap: '10px', minWidth: 0, flex: 1 }}");
    expect(header).toContain("whiteSpace: 'nowrap'");
    expect(header).toContain("textOverflow: 'ellipsis'");
    // The avatar and the button row are the two that must NOT shrink.
    expect(header.match(/flexShrink: 0/g) || []).toHaveLength(2);
    expect(header).toContain("<div style={{ position: 'relative', flexShrink: 0 }}>");
    expect(header).toContain("<div style={{ display: 'flex', gap: '6px', flexShrink: 0 }}>");
  });

  test('it sits inside the transcript, so the messages above it are still there', () => {
    // Trimming the payload must never trim the screen: the point of drawing
    // the boundary is that the conversation above it is still readable.
    expect(appSource).not.toContain('setAiMessages(trimAiHistory');
    const map = appSource.slice(appSource.indexOf('{aiMessages.map((msg, i) => ('));
    expect(map.indexOf('aiMemoryCut > 0 && i === aiMemoryCut')).toBeGreaterThan(-1);
    expect(map.indexOf('aiMemoryCut > 0 && i === aiMemoryCut')).toBeLessThan(map.indexOf('</React.Fragment>'));
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 6. The live demo's locked forecast
// ───────────────────────────────────────────────────────────────────────────
describe('forecastIsLocked', () => {
  const lockedCard = () => ({
    place_id: 'p1', name: 'Good Dog Bar', score: 68, label: 'Busy', is_open: true,
    forecast_locked: true, best_time: null, best_hour: null, best_index: null,
    best_is_now: null, peak_hours: null, hourly: [],
  });

  test('true for exactly the card gateDemoCard() builds', () => {
    expect(forecastIsLocked(lockedCard())).toBe(true);
  });

  test('false for an ordinary free card, which carries no flag at all', () => {
    const open = { ...lockedCard(), best_time: '9 PM', hourly: [{ hour: '8 PM', score: 60 }] };
    delete open.forecast_locked;
    expect(forecastIsLocked(open)).toBe(false);
  });

  test('false for no card, so the note cannot outlive the card it belongs to', () => {
    expect(forecastIsLocked(null)).toBe(false);
    expect(forecastIsLocked(undefined)).toBe(false);
  });

  test('the flag alone is not enough: never claim a chart is missing while drawing one', () => {
    expect(forecastIsLocked({ ...lockedCard(), hourly: [{ hour: '9 PM', score: 40 }] })).toBe(false);
    expect(forecastIsLocked({ ...lockedCard(), best_time: '10 PM' })).toBe(false);
  });

  test('a blank best_time does not count as a best time', () => {
    expect(forecastIsLocked({ ...lockedCard(), best_time: '   ' })).toBe(true);
  });

  test('only the real boolean counts, not a truthy stand-in', () => {
    expect(forecastIsLocked({ ...lockedCard(), forecast_locked: 'true' })).toBe(false);
    expect(forecastIsLocked({ ...lockedCard(), forecast_locked: 1 })).toBe(false);
  });
});

describe('the locked-forecast copy', () => {
  test('it names the three things that really are in the app', () => {
    expect(LOCKED_FORECAST_COPY).toContain('hour by hour');
    expect(LOCKED_FORECAST_COPY).toContain('best time to go');
    expect(LOCKED_FORECAST_COPY).toContain('peaks');
    expect(LOCKED_FORECAST_COPY).toContain('in the app');
  });

  test('it promises nothing that does not exist', () => {
    // No price, no trial, no "unlimited", no "forever". SLOP-AUDIT rule 5.
    for (const claim of ['free trial', 'trial', 'forever', '$', 'unlimited', '/mo', 'per month', 'sign up free']) {
      expect(LOCKED_FORECAST_COPY.toLowerCase()).not.toContain(claim);
    }
  });

  test('it does not read as a failure', () => {
    for (const word of ['error', 'sorry', 'unavailable', 'could not', 'failed', 'try again', 'locked', 'upgrade']) {
      expect(LOCKED_FORECAST_COPY.toLowerCase()).not.toContain(word);
    }
  });

  test('no em dash, anywhere in the new copy (SLOP-AUDIT A2/H18)', () => {
    expect(LOCKED_FORECAST_COPY).not.toMatch(/[—–]/);
  });

  test('the whole demo file is still clear of em dashes in user-visible strings', () => {
    // The rule is about copy, so JS comments are excluded the way the audit
    // itself excludes them. Every quoted string in the file is checked.
    const withoutComments = demoSource
      .replace(/^\s*\/\/.*$/gm, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
    expect(withoutComments).not.toMatch(/—/);
  });
});

describe('the demo card renders the boundary', () => {
  test('the note is drawn from the shared copy, not retyped', () => {
    expect(demoSource).toContain('{forecastLocked && (');
    expect(demoSource).toContain('{LOCKED_FORECAST_COPY}');
    expect(demoSource).toContain('const forecastLocked = forecastIsLocked(selected);');
  });

  test('it lives in the ready card, not in the error branch', () => {
    // A visitor must never meet this line dressed as a failure, and it must
    // never appear over a "Try again" button.
    const errorBranch = demoSource.slice(
      demoSource.indexOf("{phase === 'error' && ("),
      demoSource.indexOf('{busy && (')
    );
    expect(errorBranch).not.toContain('LOCKED_FORECAST_COPY');
    const ready = demoSource.slice(demoSource.indexOf("{phase === 'ready' && selected && ("));
    expect(ready).toContain('{LOCKED_FORECAST_COPY}');
  });

  test('it sits between the best-time line and the chart', () => {
    const ready = demoSource.slice(demoSource.indexOf("{phase === 'ready' && selected && ("));
    const best = ready.indexOf('{bestTime && (');
    const note = ready.indexOf('{forecastLocked && (');
    const chart = ready.indexOf('{hourly.length > 0 && (');
    expect(best).toBeGreaterThan(-1);
    expect(note).toBeGreaterThan(best);
    expect(chart).toBeGreaterThan(note);
  });

  test('the best-time line and the note read the same one value', () => {
    // Two independent reads of `selected.best_time` could disagree, and then
    // the card would say the best time is in the app directly under it.
    const ready = demoSource.slice(demoSource.indexOf("{phase === 'ready' && selected && ("));
    expect(ready).not.toContain('typeof selected.best_time');
    expect(demoSource).toContain('const bestTime = (typeof selected?.best_time === \'string\' && selected.best_time) ? selected.best_time : null;');
  });

  test('the CTA under it is the only call to action', () => {
    // Restraint (SLOP-AUDIT I): the section already has one button pointing at
    // the app; the note must not grow a second one.
    const ready = demoSource.slice(demoSource.indexOf("{phase === 'ready' && selected && ("));
    const noteBlock = ready.slice(ready.indexOf('{forecastLocked && ('), ready.indexOf('{hourly.length > 0 && ('));
    expect(noteBlock).not.toContain('<button');
    expect(noteBlock).not.toContain('<a ');
  });
});

describe('cardSentence speaks the boundary too', () => {
  const base = { name: 'Good Dog Bar', score: 68, label: 'Busy', is_open: true };

  test('an ordinary card says the score and stops there', () => {
    expect(cardSentence(base)).toBe('Good Dog Bar is busy, 68 percent.');
  });

  test('a locked card adds the same sentence the card prints', () => {
    const locked = { ...base, forecast_locked: true, best_time: null, hourly: [] };
    expect(cardSentence(locked)).toBe(`Good Dog Bar is busy, 68 percent. ${LOCKED_FORECAST_COPY}`);
  });

  test('a closed locked venue still says closed first', () => {
    const locked = { ...base, is_open: false, forecast_locked: true, best_time: null, hourly: [] };
    expect(cardSentence(locked)).toBe(`Good Dog Bar is closed right now. ${LOCKED_FORECAST_COPY}`);
  });

  test('a card with a chart is never announced as locked', () => {
    const odd = { ...base, forecast_locked: true, hourly: [{ hour: '9 PM', score: 40 }] };
    expect(cardSentence(odd)).toBe('Good Dog Bar is busy, 68 percent.');
  });

  test('no card is still the empty string', () => {
    expect(cardSentence(null)).toBe('');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 7. The app-side forecast gate, which the demo is a mirror of
// ───────────────────────────────────────────────────────────────────────────
describe('the venue sheet under the same paywall', () => {
  // Exactly the one tile: from its own label to the label of the tile beside it.
  const peakTile = () => {
    const start = appSource.indexOf('>Busiest Hours</span>');
    expect(start).toBeGreaterThan(-1);
    const end = appSource.indexOf("'Est. Wait Right Now'", start);
    expect(end).toBeGreaterThan(start);
    return appSource.slice(start, end);
  };

  test('Busiest Hours stops printing a label over nothing when peak is withheld', () => {
    // routes/crowd.js LOCKED_FORECAST_FIELDS sets `peak: null`, and the tile
    // rendered `peakText` straight, so the paywall drew an empty box under the
    // words BUSIEST HOURS: a card that reads as broken, not as a boundary.
    expect(appSource).not.toContain("{closedAllDay ? 'Closed Today' : peakText}");
    const tile = peakTile();
    expect(tile).toContain('cd?.forecastAccess?.locked ? (');
    expect(tile).toContain("setPaywallTrigger('forecast')");
    expect(tile).toContain('{peakText}');
  });

  test('it uses the same blurred stand-in as the best-time line above it', () => {
    const tile = peakTile();
    expect(tile).toContain("filter: 'blur(4px)'");
    expect(tile).toContain('aria-hidden');
    expect(tile).toContain('PRO');
  });

  test('closed still wins over the paywall, since it is true either way', () => {
    const tile = peakTile();
    expect(tile.indexOf('closedAllDay ? (')).toBeLessThan(tile.indexOf('cd?.forecastAccess?.locked ? ('));
  });
});
