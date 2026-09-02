/**
 * THE PAID-INVOICE FORM EXISTS, IS GUARDED, AND POSTS TO THE RIGHT PLACE.
 *
 * The reconciled Google line used to be a constant in services/costModel.js,
 * so recording a bill meant editing code; on 2026-09-01 it became a form on
 * the Revenue screen's Reconciled card, saved through the admin route and
 * merged over the code figure. adminCostsRendered.test.js pins the rest of
 * that panel by reading the source, so this does the same for the form. Three
 * things it must keep true:
 *   1. The form is rendered per reconciled line, and only when the payload
 *      carries a real lines array, because the rendered-costs fixture hands
 *      the panel a placeholder string for `reconciled` and must not explode.
 *   2. Saving refetches the whole payload rather than trusting the form, so
 *      what the card shows afterwards is what the server merged.
 *   3. The client posts to the admin route the server actually mounts, with
 *      the four fields the server validates, and the screen imports it from
 *      the API client rather than reaching for fetch itself.
 */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8').replace(/\r\n/g, '\n');
const screen = read('screens/RevenueScreen.js');
const api = read('services/api.js');

describe('the paid-invoice form on the Reconciled card', () => {
  test('renders one form per reconciled line, guarded on a real lines array', () => {
    expect(screen).toContain("d.reconciled && Array.isArray(d.reconciled.lines) && (");
    expect(screen).toContain('d.reconciled.lines.map((l) => (');
    expect(screen).toContain('<ReconciledLineForm key={l.id} line={l} colors={colors} onSaved={() => fetchCosts()} />');
  });

  test('says which lines were recorded here and which still come from code', () => {
    expect(screen).toContain("line.source === 'dashboard' ? `saved ${line.asOf}` : 'from code, never recorded here'");
  });

  test('a failed read of saved entries is named, not silently shown as the code figure', () => {
    expect(screen).toContain('d.reconciled.readError && (');
    expect(screen).toContain('so the figures above are the code fallback');
  });

  test('saving posts through the API client and then refetches the merged payload', () => {
    expect(screen).toContain("import { saveAdminReconciled } from '../services/api';");
    expect(screen).toContain('await saveAdminReconciled({ id: line.id, usdPerMonth: Number(usd), asOf });');
    expect(screen).toContain('if (onSaved) onSaved();');
    expect(screen).not.toMatch(/fetch\(['"`][^'"`]*costs\/reconciled/);
  });

  test('the client helper targets the mounted admin route with the validated fields', () => {
    expect(api).toContain("return request('/api/admin/costs/reconciled', {");
    expect(api).toContain("method: 'POST',");
    expect(api).toContain('body: JSON.stringify({ id, usdPerMonth, asOf, note }),');
  });

  test('the amount cannot be saved empty and the date cannot be in the future', () => {
    expect(screen).toContain("disabled={busy || usd === ''}");
    expect(screen).toContain('max={new Date().toISOString().slice(0, 10)}');
  });
});
