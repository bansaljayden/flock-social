// THE VOTE ROW SHOWS THE VENUE'S NAME.
//
// The 21 Oct screenshot run found the host's vote row cutting names to "The
// Coppe..." at 390px: the name was one line with an ellipsis, and the host's
// Confirm button on the same row left it about 100px. It now takes two lines
// before the ellipsis.

import fs from 'fs';
import path from 'path';

const CHAT = fs.readFileSync(path.join(__dirname, '..', 'screens', 'ChatDetail.js'), 'utf8');

test('the vote row name clamps at two lines instead of one', () => {
  const at = CHAT.indexOf('}}>{v.venue}</h4>');
  expect(at).toBeGreaterThan(-1);
  const style = CHAT.slice(CHAT.lastIndexOf('<h4 style={{', at), at);
  expect(style).toContain("display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical'");
  expect(style).not.toContain("whiteSpace: 'nowrap'");
});

test('the host still gets the Confirm button on the same row', () => {
  expect(CHAT).toContain("aria-label={`${isAssigned ? 'Lock in' : 'Confirm'} ${v.venue}`}");
});
