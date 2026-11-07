// Two questions the focus code asks before it moves the caret.
//
// isTextEntryField: would focusing this element raise the on-screen keyboard?
// A text input, a textarea or an editable element does; a checkbox, a range or
// a button does not.
//
// isCoarsePointer: is this a touch screen, where focusing a text field raises
// that keyboard? On a laptop the caret going back into the search box is what
// a keyboard user wants; on a phone it is the keyboard sliding up over
// whatever the person just closed a sheet to look at.

const NON_TEXT_INPUTS = /^(button|submit|checkbox|radio|range|file|reset|color|image|hidden)$/i;

export const isTextEntryField = (el) => {
  if (!el || typeof el !== 'object') return false;
  if (el.isContentEditable) return true;
  const tag = String(el.tagName || '').toUpperCase();
  if (tag === 'TEXTAREA') return true;
  if (tag !== 'INPUT') return false;
  return !NON_TEXT_INPUTS.test(el.type || 'text');
};

export const isCoarsePointer = () => {
  try {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      && window.matchMedia('(pointer: coarse)').matches === true;
  } catch {
    return false;
  }
};
