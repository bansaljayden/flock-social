/**
 * CREATE, THEN SHARE. Source contract for the last step of Start a Flock.
 *
 * Production showed three real flocks, each with exactly one member, because
 * the room a person landed in after Create Flock was empty and the invite
 * link was two taps deep inside it. The fix is an ordering: a successful
 * create now ends on a made step whose primary action sends the guest link,
 * and the chat is reached only from that step. These pins hold the ordering,
 * the share ladder (the same one the chat's invite sheet uses) and the fact
 * that no door on the step is dead.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test createThenShare --watchAll=false
 */
const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const create = read('screens/CreateScreen.js');

// The success half of handleCreate, from the API call to the catch that puts
// the form back. Both markers are lines the older suites already read, so a
// move of either would fail them first.
const successPath = () => {
  const start = create.indexOf('const data = await apiCreateFlock(');
  const end = create.indexOf('} catch (err) {', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return create.slice(start, end);
};

// The made step: its handlers and its JSX, from the first door to the form's
// own return.
const madeStep = () => {
  const start = create.indexOf('const goToChat = ');
  const end = create.indexOf('<div key="create-screen-container"', create.indexOf('if (made) {', start) + 1);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  // From the handlers through the end of the made return: the form's own
  // `return (` is the first one after the step's closing brace.
  const formReturn = create.indexOf('\n    return (', end);
  expect(formReturn).toBeGreaterThan(end);
  return create.slice(start, formReturn);
};

test('the screen imports the invite-link call from the api module, beside createFlock', () => {
  expect(create).toMatch(/import \{[^}]*\bcreateFlock as apiCreateFlock\b[^}]*\bcreateFlockInviteLink\b[^}]*\} from '\.\.\/services\/api';/);
});

test('a successful create lands on the made step, and the chat is not navigated to from there', () => {
  const fn = successPath();
  // Everything the chat needs is still set on the way in.
  expect(fn).toContain('newlyCreatedFlockRef.current = f.id;');
  expect(fn).toContain('setFlocks(prev => [...prev, newFlock]);');
  expect(fn).toContain('setSelectedFlockId(f.id);');
  expect(fn).toContain('setMade(newFlock);');
  // The one line that used to follow those is gone from this path.
  expect(fn).not.toContain("setCurrentScreen('chatDetail')");
});

test('the invite link starts minting the moment the flock exists, into a ref, without being awaited', () => {
  const fn = successPath();
  // The mint starts on the create and is never awaited there; the ref also
  // records when it settles, because the tap shares only a link already in
  // hand (the share sheet needs the tap's own activation, and a network wait
  // spends it).
  expect(fn).toContain('held.promise = createFlockInviteLink(f.id)');
  expect(fn).toContain('held.settled = true; held.result = r;');
  expect(fn).toContain('inviteLinkRef.current = held;');
  // Both outcomes settle, so a refused mint is neither an unhandled rejection
  // nor a swallowed one; the tap reads it.
  expect(fn).toMatch(/\.then\(\(r\) => \(\{ url: r\?\.url \|\| null \}\), \(err\) => \(\{ error: err \}\)\)/);
  expect(fn).not.toMatch(/await createFlockInviteLink/);
});

test('a mint that failed early is retried on the tap, and the retry\'s error is the one shown', () => {
  const step = madeStep();
  expect(step).toContain('const early = held && held.flockId === flock.id ? await held.promise : null;');
  expect(step).toContain('if (early?.url) return early.url;');
  expect(step).toContain('const fresh = await createFlockInviteLink(flock.id);');
  expect(step).toContain(`showToast(err?.message || "Couldn't make an invite link. Try again.", 'error');`);
  // A failed mint keeps the step up with the button live, rather than
  // leaving `sending` stuck true.
  expect(step).toMatch(/\} catch \(err\) \{[^}]*setSending\(false\);[^}]*showToast\(err\?\.message/);
});

test('the share ladder is the chat\'s: Web Share, a decline is an answer, the clipboard after that', () => {
  const step = madeStep();
  expect(step).toContain("if (typeof navigator.share === 'function') {");
  expect(step).toContain('await navigator.share({ title: made.name, text, url });');
  // Backing out of the sheet goes to the chat, not to a toast.
  expect(step).toContain("if (e?.name === 'AbortError') { goToChat(); return; }");
  // Any other refusal falls through to the clipboard, which toasts and then
  // goes to the chat as well.
  expect(step).toContain('await navigator.clipboard.writeText(url);');
  expect(step).toContain("showToast('Invite link copied');");
  const copied = step.indexOf("showToast('Invite link copied');");
  const after = step.slice(copied, step.indexOf('};', copied));
  expect(after).toContain('goToChat();');
});

test('the share text is one line: the name, the time only when one is set, and what the link does', () => {
  const step = madeStep();
  // 'TBD' is what formatEventTime answers for no time; the chat header reads
  // the same rule.
  expect(step).toContain("const when = made.time && made.time !== 'TBD' ? made.time : '';");
  // The interpolations are assembled rather than typed, the way
  // copyEmDashSweep does it: a plain string holding the two characters that
  // open one is exactly what no-template-curly-in-string exists to catch,
  // and here it is the subject.
  const hole = (name) => `$${'{'}${name}}`;
  const line = 'const text = `' + hole('made.name') + hole("when ? `, " + hole('when') + "` : ''") + ". Say if you're in, no app needed.`;";
  expect(step).toContain(line);
});

test("'chatDetail' is only ever navigated to after the made step exists", () => {
  // One call in the whole file, and it is goToChat, which is declared after
  // the line that puts the made step up.
  const calls = create.split("setCurrentScreen('chatDetail')").length - 1;
  expect(calls).toBe(1);
  const madeSet = create.indexOf('setMade(newFlock);');
  const goToChat = create.indexOf("const goToChat = () => { setCurrentScreen('chatDetail'); };");
  expect(madeSet).toBeGreaterThan(-1);
  expect(goToChat).toBeGreaterThan(madeSet);
});

test('the made step says what happened, asks for one thing, and has no dead control', () => {
  const step = madeStep();
  expect(step).toContain('{made.name} is made.</h2>');
  expect(step).toContain('Now put it where your friends already are.');
  expect(step).toContain('Send the link</>');
  expect(step).toMatch(/<button className="hit44 glass-btn glass-primary" onClick=\{sendLink\} disabled=\{sending\}/);
  // The quiet door is never disabled: a mint that hangs must not hold the
  // person on this screen.
  expect(step).toMatch(/<button className="hit44" onClick=\{goToChat\} style=\{\{[^}]*\}\}>Not now<\/button>/);
  // Escape and the system back go where every other door goes.
  expect(step).toContain('<DialogBehavior modal={false} onClose={goToChat} />');
  // The form is still the other branch, with the strings the older suites
  // and the Maestro flow read.
  expect(create).toContain('>Start a Flock</h1>');
  expect(create).toContain('Create Flock</>');
});

test('the primary button is the Create button\'s shape, not a second style', () => {
  const step = madeStep();
  const form = create.slice(create.indexOf('<button className="hit44 glass-btn glass-primary" onClick={handleCreate}'));
  for (const rule of ["width: '100%', padding: '16px', borderRadius: '16px', border: 'none',", "boxShadow: '0 1px 2px rgba(30,41,59,0.10)',"]) {
    expect(step).toContain(rule);
    expect(form).toContain(rule);
  }
});

test('the copy the step adds carries no em dash', () => {
  expect(madeStep().includes('—')).toBe(false);
  expect(successPath().includes('—')).toBe(false);
});
