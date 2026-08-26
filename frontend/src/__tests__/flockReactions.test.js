/**
 * FLOCK MESSAGE REACTIONS — the feature that was a local state edit.
 *
 * Before this, tapping a reaction on a flock message did exactly one thing:
 * it toggled an emoji into React state. It never called the server.
 * `addReaction` in services/api.js had no caller anywhere in the app, nothing
 * was ever written to emoji_reactions, and the reaction was gone on reload and
 * had never been seen by anybody else in the flock. App.js had subscribed to
 * flock_reaction_added and flock_reaction_removed the whole time, so the
 * receive half could not fire either: nothing was ever sent for it to receive.
 *
 * Two shapes were also in play for one field. The server returns one ROW per
 * person ({ emoji, user_id, user_name }) and both socket handlers push rows;
 * the local toggle pushed a bare STRING, and ChatDetail rendered the array
 * element directly. A string renders. A row is an object child, which React
 * refuses outright. Nothing had hit it only because nothing had ever persisted
 * a reaction, so the first real one from anybody would have taken the message
 * list down.
 *
 * These lock the send, the shape, and the grouping.
 */

import { groupReactions } from '../screens/ChatDetail';

const fs = require('fs');
const path = require('path');

const APP = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8');
const API = fs.readFileSync(path.join(__dirname, '..', 'services', 'api.js'), 'utf8');
const CHAT = fs.readFileSync(path.join(__dirname, '..', 'screens', 'ChatDetail.js'), 'utf8');

const row = (emoji, userId, name) => ({ emoji, user_id: userId, user_name: name });

// The handler is sliced out of a 20,000 line file by the name of the function
// that follows it. If that name ever moves, indexOf returns -1 and slice(from,
// -1) hands back the whole rest of the file, at which point every assertion
// below passes because the string it wants exists SOMEWHERE. This bounds it,
// so the slice failing is a red test rather than a green one.
function handlerSource() {
  const from = APP.indexOf('const addReactionToMessage');
  const to = APP.indexOf('const simulateTyping', from);
  expect(from).toBeGreaterThan(-1);
  expect(to).toBeGreaterThan(from);
  const src = APP.slice(from, to);
  // Big enough to be the handler, small enough not to be half the file.
  expect(src.length).toBeGreaterThan(400);
  expect(src.length).toBeLessThan(6000);
  return src;
}

describe('grouping: one pill per emoji, counting people', () => {
  it('collapses the same emoji from different people into one pill', () => {
    const groups = groupReactions([
      row('❤️', 1, 'Ava'),
      row('❤️', 2, 'Bo'),
      row('🔥', 3, 'Cal'),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups.find((g) => g.emoji === '❤️').count).toBe(2);
    expect(groups.find((g) => g.emoji === '🔥').count).toBe(1);
  });

  it('reports who is in each group, so the caller can tell if one is yours', () => {
    const groups = groupReactions([row('❤️', 1, 'Ava'), row('❤️', 2, 'Bo')]);
    expect(groups[0].userIds.map(String).sort()).toEqual(['1', '2']);
  });

  it('keeps insertion order, so pills do not reshuffle as reactions arrive', () => {
    const groups = groupReactions([row('🔥', 1), row('❤️', 2), row('🔥', 3)]);
    expect(groups.map((g) => g.emoji)).toEqual(['🔥', '❤️']);
  });

  it('degrades a legacy bare string to an ownerless pill instead of rendering an object', () => {
    // Anything still holding the pre-fix shape (a message in memory across the
    // change, an older cached payload) must not reach the renderer as-is.
    const groups = groupReactions(['❤️', row('❤️', 7, 'Dee')]);
    expect(groups).toHaveLength(1);
    expect(groups[0].count).toBe(2);
    expect(groups[0].userIds.map(String)).toEqual(['7']);
  });

  it('survives the empty and missing cases without throwing', () => {
    expect(groupReactions([])).toEqual([]);
    expect(groupReactions(undefined)).toEqual([]);
    expect(groupReactions([null, {}, { user_id: 3 }])).toEqual([]);
  });
});

describe('the reaction actually leaves the device', () => {
  const handler = handlerSource();

  it('calls the server on both halves of the toggle', () => {
    // The entire bug: this function used to end at setFlocks.
    expect(handler).toContain('removeReaction(messageId, emoji)');
    expect(handler).toContain('addReaction(messageId, emoji)');
  });

  it('imports both wrappers, so neither call is a free variable', () => {
    expect(APP).toMatch(/import \{[^}]*\baddReaction\b[^}]*\} from '\.\/services\/api'/s);
    expect(APP).toMatch(/import \{[^}]*\bremoveReaction\b[^}]*\} from '\.\/services\/api'/s);
  });

  it('api.js can reach the DELETE half, which POST cannot do for it', () => {
    // POST is ON CONFLICT DO NOTHING server side: add-only, never a toggle.
    expect(API).toContain('export async function removeReaction');
    const fn = API.slice(API.indexOf('export async function removeReaction'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    expect(body).toContain('/react/');
    expect(body).toContain("method: 'DELETE'");
    expect(body).toContain('encodeURIComponent(emoji)');
  });

  it('puts the reaction back when the write is refused', () => {
    expect(handler).toContain('previousReactions');
    expect(handler).toMatch(/\.catch\(/);
    // The movement has to be explained or it reads as a bug on its own.
    expect(handler).toContain("didn't save");
  });

  it('does not address a message the server has never issued', () => {
    // An optimistic bubble keeps its Date.now() placeholder id until the echo
    // lands. Reacting to one would POST against a row number nobody has.
    expect(handler).toContain("typeof messageId !== 'number'");
  });
});

describe('one shape for one field', () => {
  const handler = handlerSource();

  it('the local toggle stores the same row the socket handlers store', () => {
    // socket: { emoji: data.emoji, user_id: data.userId, user_name: data.userName }
    expect(handler).toMatch(/\{\s*emoji,\s*user_id:/);
    // And no longer the bare string it used to push.
    expect(handler).not.toContain('m.reactions.includes(reaction)');
  });

  it('identity is compared as a string, because ids arrive as both', () => {
    // users.id is a SERIAL integer, and it reaches this file as a number from
    // React state and as a string from a socket payload.
    expect(handler).toContain('String(r.user_id) === String(myId)');
  });

  it('the renderer never hands a raw reaction to React', () => {
    const block = CHAT.slice(CHAT.indexOf('{/* Reactions display'));
    const list = block.slice(0, block.indexOf('</div>'));
    expect(list).toContain('groupReactions(m.reactions)');
    // `{r}` was the crash: an object child is refused outright by React.
    expect(list).not.toMatch(/\{r\}/);
  });

  it('the pill shows how many people reacted, not a hardcoded 1', () => {
    const block = CHAT.slice(CHAT.indexOf('{/* Reactions display'));
    const list = block.slice(0, block.indexOf('</div>'));
    expect(list).toContain('{g.count}');
    expect(list).not.toMatch(/>1</);
  });

  it('a pill is tappable and announces whether the reaction is yours', () => {
    const block = CHAT.slice(CHAT.indexOf('{/* Reactions display'));
    const list = block.slice(0, block.indexOf('</button>'));
    expect(list).toContain('aria-pressed={mine}');
    expect(list).toContain('addReactionToMessage(flock.id, m.id, g.emoji)');
  });
});
