// A promotion's time slot and days: a choice from the editor's list, or the
// owner's own words ("5 to 7pm", "Tuesday to Thursday"). The server already
// takes either: both fields are free text there, 60 characters at most, with
// markup stripped and the profanity screen run on what is left
// (backend/routes/venueDashboard.js, POST and PUT /promotions). So "Custom" is
// only a way for the form to offer what the server accepts; it adds no rule of
// its own beyond refusing to save an empty box.
//
// The drink-deal rule reads the owner's words as well (backend/utils/over21.js
// promotionIsOver21 reads the time slot AND the days), so typing "happy hour"
// into a custom box hides the deal from anyone we do not know is 21, exactly as
// choosing Happy Hour from the list does.

// The select's value for the Custom choice. Not a label anybody sees, and not a
// value the server ever receives: joinPromoChoice turns it into the typed words.
export const PROMO_CUSTOM = 'custom';

// The server's own cap on time_slot and days (isLength({ max: 60 })).
export const PROMO_CUSTOM_MAX = 60;

// What the editor shows for a stored value. A value the list names is selected;
// anything else opens as Custom with the stored words in the box, where the owner
// can read and change them. An empty value gets the fallback.
export const splitPromoChoice = (stored, presets, fallback) => {
  const value = typeof stored === 'string' ? stored.trim() : '';
  if (!value) return { choice: fallback, custom: '' };
  if (presets.includes(value)) return { choice: value, custom: '' };
  return { choice: PROMO_CUSTOM, custom: value.slice(0, PROMO_CUSTOM_MAX) };
};

// What is saved: the chosen value, or the trimmed words when Custom is chosen.
// An empty string means Custom with nothing typed, which the form will not save.
export const joinPromoChoice = (choice, custom) => (
  choice === PROMO_CUSTOM ? String(custom || '').trim().slice(0, PROMO_CUSTOM_MAX) : choice
);
