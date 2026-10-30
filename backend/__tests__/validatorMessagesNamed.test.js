// Run: node --test  (from backend/)
//
// EVERY CHECK ON THESE ROUTES NAMES ITS MESSAGE.
//
// Each of these routes answers a failed check with `errors.array()[0].msg`,
// and the app prints that string to the person who sent the request. An
// express-validator check with no .withMessage() answers "Invalid value", so
// an edited calendar title left blank, an availability note one character
// too long, a plan edited to a date that does not parse, and a chat message
// with a type the server does not know were all answered with those two
// words and nothing about what to fix.
//
// The check below reads the chains the routers really mount (each chain
// carries the list it was built from), so a check added later without a
// message fails here with its field named, whichever line of the file it is
// on. The runtime half runs the same chains against a request and reads the
// message a person would see.

const test = require('node:test');
const assert = require('node:assert');
const { body, validationResult } = require('express-validator');
const { StandardValidation, CustomValidation } = require('express-validator/lib/context-items');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'validator-messages-test-secret';

const ROUTERS = {
  calendar: require('../routes/calendar'),
  flocks: require('../routes/flocks'),
  availability: require('../routes/availability'),
  messages: require('../routes/messages'),
};

// [router, method, path as the router declares it]
const ROUTES = [
  ['calendar', 'post', '/'],
  ['calendar', 'put', '/:id'],
  ['flocks', 'put', '/:id'],
  ['availability', 'post', '/'],
  ['messages', 'post', '/flocks/:id/messages'],
  ['messages', 'post', '/dm/:userId'],
];

function chainsOf(name, method, path) {
  const layer = ROUTERS[name].stack.find((l) => l.route && l.route.path === path && l.route.methods[method]);
  assert.ok(layer, `routes/${name}.js has no ${method.toUpperCase()} ${path}`);
  return layer.route.stack.map((s) => s.handle).filter((h) => h && h.builder);
}

// The checks in a chain that would answer "Invalid value". Sanitizers and
// optional() are not checks and never produce a message of their own.
function unnamedChecks(chain) {
  const context = chain.builder.build();
  const out = [];
  context.stack.forEach((item, i) => {
    const isCheck = item instanceof StandardValidation || item instanceof CustomValidation;
    if (isCheck && item.message === undefined) {
      const kind = item instanceof StandardValidation ? item.validator.name || 'check' : 'custom';
      out.push(`${context.fields.join('|')} (link ${i}, ${item.negated ? 'not ' : ''}${kind})`);
    }
  });
  return out;
}

test('the scanner sees a check with no message, and sees a message once there is one', () => {
  // Without this an empty finding list could mean a scanner that reads nothing.
  assert.deepStrictEqual(unnamedChecks(body('note').isLength({ max: 80 })), ['note (link 0, isLength)']);
  assert.deepStrictEqual(unnamedChecks(body('note').isLength({ max: 80 }).withMessage('Keep it short')), []);
  assert.deepStrictEqual(unnamedChecks(body('title').trim().notEmpty()), ['title (link 1, not isEmpty)']);
  assert.deepStrictEqual(unnamedChecks(body('x').optional().isObject()), ['x (link 0, custom)']);
});

for (const [name, method, path] of ROUTES) {
  test(`${method.toUpperCase()} ${path} in routes/${name}.js names every message`, () => {
    const chains = chainsOf(name, method, path);
    assert.ok(chains.length > 0, 'found no validator chains on the route, so this measured nothing');
    const unnamed = chains.flatMap(unnamedChecks);
    assert.deepStrictEqual(unnamed, [],
      `these checks answer "Invalid value", which the app shows as it is. Give each a .withMessage():\n  ${unnamed.join('\n  ')}`);
  });
}

// What a person is actually told, through the route's own chains.
async function firstMessage(name, method, path, { params = {}, reqBody = {} } = {}) {
  const req = { params, body: reqBody, query: {}, headers: {}, cookies: {} };
  for (const chain of chainsOf(name, method, path)) await chain.run(req);
  const errors = validationResult(req).array();
  assert.ok(errors.length > 0, `${method.toUpperCase()} ${path} accepted ${JSON.stringify(reqBody)}`);
  return errors[0].msg;
}

test('the messages a person reads are the ones these routes now name', async () => {
  const cases = [
    ['an edited calendar title left blank', 'calendar', 'put', '/:id',
      { params: { id: '5' }, reqBody: { title: '   ' } }, 'Title is required'],
    ['an edited calendar title past 120 characters', 'calendar', 'put', '/:id',
      { params: { id: '5' }, reqBody: { title: 'x'.repeat(121) } }, 'Keep the title under 120 characters'],
    ['a calendar time label past 20 characters', 'calendar', 'post', '/',
      { reqBody: { title: 'Dinner', date: '2026-11-06', time: 'x'.repeat(21) } }, 'Keep the time under 20 characters'],
    ['an availability note past 80 characters', 'availability', 'post', '/',
      { reqBody: { status: 'down', note: 'x'.repeat(81) } }, 'Keep the note under 80 characters'],
    ['a plan edited to a date that does not parse', 'flocks', 'put', '/:id',
      { params: { id: '5' }, reqBody: { event_time: 'next friday' } }, 'Invalid event time'],
    ['a plan status the server does not know', 'flocks', 'put', '/:id',
      { params: { id: '5' }, reqBody: { status: 'paused' } }, 'Status must be planning, confirmed, completed, or cancelled'],
    ['a chat message of an unknown type', 'messages', 'post', '/flocks/:id/messages',
      { params: { id: '5' }, reqBody: { message_text: 'hi', message_type: 'video' } }, 'Invalid message type'],
    ['a direct message whose venue card is not an object', 'messages', 'post', '/dm/:userId',
      { params: { userId: '5' }, reqBody: { message_type: 'venue_card', venue_data: 'oakwood' } }, 'Invalid venue card'],
  ];
  for (const [what, name, method, path, req, expected] of cases) {
    const msg = await firstMessage(name, method, path, req);
    assert.notStrictEqual(msg, 'Invalid value', `${what}: still answered "Invalid value"`);
    assert.strictEqual(msg, expected, `${what}`);
  }
});
