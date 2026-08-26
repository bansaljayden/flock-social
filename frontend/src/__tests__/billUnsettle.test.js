/**
 * TAKING BACK "I PAID".
 *
 * POST /api/billing/:flockId/unsettle has always existed. It checks membership,
 * refuses the person who paid the bill, and updates exactly one row keyed on
 * the caller's own user_id. Nothing in the app called it.
 *
 * So settling was a one-way door. "Mark as Paid (cash or other)" disappears the
 * instant it succeeds, and there was no control that brought it back: a mis-tap
 * left a debt recorded as cleared, and the only remedy was asking whoever paid
 * to remember it differently. Six of the seven billing routes were wired and
 * this was the seventh.
 *
 * Money moving the wrong way by one tap, with no undo, on a feature built for
 * splitting a dinner bill between friends, is the kind of thing that is
 * remembered about an app.
 */

const fs = require('fs');
const path = require('path');

const CHAT = fs.readFileSync(path.join(__dirname, '..', 'screens', 'ChatDetail.js'), 'utf8');
const API = fs.readFileSync(path.join(__dirname, '..', 'services', 'api.js'), 'utf8');

// The bill-split panel, bounded so a moved anchor fails loudly rather than
// handing back the rest of a 1,700 line screen and passing on anything.
function panelSource() {
  const from = CHAT.indexOf('Mark as Paid');
  const to = CHAT.indexOf('All settled up', from);
  expect(from).toBeGreaterThan(-1);
  expect(to).toBeGreaterThan(from);
  const src = CHAT.slice(from, to);
  expect(src.length).toBeGreaterThan(300);
  expect(src.length).toBeLessThan(5000);
  return src;
}

describe('the request', () => {
  it('exists and points at the unsettle route', () => {
    expect(API).toContain('export async function unsettleShare');
    const fn = API.slice(API.indexOf('export async function unsettleShare'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    expect(body).toContain('/unsettle');
    expect(body).toContain("method: 'POST'");
  });

  it('is imported by the screen that owns the bill split', () => {
    // An exported wrapper with no caller is the state this change existed to
    // end, and it is the state the settle route's twin sat in.
    expect(CHAT).toMatch(/import \{[^}]*\bunsettleShare\b[^}]*\} from '\.\.\/services\/api'/s);
  });
});

describe('the control', () => {
  const panel = panelSource();

  it('offers a way back once your share is settled', () => {
    expect(panel).toContain('unsettleShare(selectedFlockId)');
    expect(panel).toContain('That was a mistake, I have not paid');
  });

  it('appears only for a share that is actually settled', () => {
    // The mirror image of the Mark as Paid condition just above it. Offering
    // "I have not paid" against an unpaid share is nonsense.
    expect(panel).toMatch(/String\(s\.userId\) === String\(authUser\?\.id\) && s\.settled/);
  });

  it('is hidden from the person who paid the bill, not shown and refused', () => {
    // The server answers 409 reason:'payer' because there is nothing of theirs
    // to unmark. A control that exists only to be rejected is a dead button,
    // which the design standard forbids outright.
    expect(panel).toMatch(/billSplit\.paidBy\?\.id/);
  });

  it('only ever changes the caller\'s own row in local state', () => {
    // The server keys its UPDATE on the caller's user_id, so the optimistic
    // edit has to agree or the panel would show somebody else's share flipping.
    const handler = panel.slice(panel.indexOf('unsettleShare(selectedFlockId)'));
    expect(handler).toMatch(/String\(s\.userId\) === String\(authUser\?\.id\) \? \{ \.\.\.s, settled: false/);
  });

  it('clears settledAt alongside settled, the way the server does', () => {
    // routes/billing.js sets settled_at = NULL in the same statement. Leaving a
    // timestamp on an unsettled share is a row that says two things at once.
    const handler = panel.slice(panel.indexOf('unsettleShare(selectedFlockId)'));
    expect(handler).toContain('settledAt: null');
  });

  it('reports a refusal instead of claiming the change happened', () => {
    const handler = panel.slice(panel.indexOf('unsettleShare(selectedFlockId)'));
    expect(handler).toMatch(/catch \(err\) \{ showToast\(err\.message, 'error'\); \}/);
    // The success toast must come after the await, never before it.
    expect(handler.indexOf('await unsettleShare')).toBeLessThan(handler.indexOf('showToast(\'Your share'));
  });
});
