/* WHAT IS TYPED IN A CHAT BOX, HELD WHERE ONLY THE BOX LISTENS.

   The flock chat and the DM thread used to keep the box's text as state at
   the top of the screen, so every character typed re-rendered the whole
   screen: the header, every sheet, the row cache's inputs, and MessageList
   whenever one of its props was a fresh element (the empty state is). On a
   phone that was the lag between a key and the letter appearing.

   A store is the smallest change that ends it. The screen still owns the text
   (it writes it on a change, empties it on a send and files it on the way
   out), but writing it notifies only ChatInputBar, which reads it through
   useSyncExternalStore. The screen re-renders for the things it draws, and a
   keystroke is not one of them. */

export function createDraftStore(initial = '') {
  let value = typeof initial === 'string' ? initial : '';
  const listeners = new Set();
  return {
    get: () => value,
    set: (next) => {
      const text = typeof next === 'string' ? next : '';
      if (text === value) return;
      value = text;
      listeners.forEach((listener) => listener());
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
