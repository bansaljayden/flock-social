// WHO SEES A DRINK DEAL, said on every form that writes one.
//
// The server serves a promotion or event about alcohol only to an account whose
// date of birth makes it 21 (backend utils/over21.js, App Store Guideline
// 1.4.3), and the iPhone app asks nobody for a date of birth, so an owner who
// is not told would watch a deal go quiet with no reason given. The promotion
// forms name Happy Hour as well, because a deal in that slot counts as one.
// One copy of each sentence, read by the Promotions tab form, the event form
// and the dashboard's Post a Deal card alike.
export const DRINK_DEAL_LINE = 'Drink deals are shown only to people we know are 21 or older.';
export const DRINK_DEAL_LINE_PROMO = 'Drink deals, and anything set in Happy Hour, are shown only to people we know are 21 or older.';
