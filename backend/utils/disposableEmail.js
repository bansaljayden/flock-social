// Disposable / throwaway email domains, blocked at signup. A throwaway signup
// can't be reached for safety notices, defeats the one-account-per-person
// assumption behind rate limits, and (per the security review checklist) is
// the first thing app reviewers try. This is a curated list of the services
// that actually show up in the wild, not an exhaustive registry — extend as
// abuse appears. Subdomains of these are blocked too (x.mailinator.com).
const DISPOSABLE_DOMAINS = new Set([
  '10minutemail.com', '10minutemail.net', '10minemail.com',
  'guerrillamail.com', 'guerrillamail.net', 'guerrillamail.org',
  'guerrillamailblock.com', 'sharklasers.com', 'grr.la',
  'mailinator.com', 'mailinator.net', 'mailinator2.com',
  'tempmail.com', 'temp-mail.org', 'temp-mail.io', 'tempmail.dev',
  'tempmailo.com', 'tmpmail.org', 'tmpmail.net', 'tmails.net',
  'throwawaymail.com', 'trashmail.com', 'trashmail.de', 'kurzepost.de',
  'yopmail.com', 'yopmail.fr', 'yopmail.net', 'cool.fr.nf', 'jetable.org',
  'maildrop.cc', 'mailnesia.com', 'mintemail.com', 'mohmal.com',
  'dispostable.com', 'fakeinbox.com', 'spamgourmet.com', 'mytemp.email',
  'burnermail.io', 'getnada.com', 'nada.email', 'inboxkitten.com',
  'moakt.com', 'moakt.cc', 'tempr.email', 'discard.email', 'discardmail.com',
  'mail-temp.com', 'emailondeck.com', 'mailsac.com', 'tempinbox.com',
  '33mail.com', 'mailcatch.com', 'spamex.com', 'mailexpire.com',
  'harakirimail.com', 'meltmail.com', 'anonbox.net', 'emailfake.com',
  'crazymailing.com', 'tempail.com', 'cs.email', 'spam4.me',
]);

// True when the address's domain (or any parent domain) is a known
// disposable-email service.
function isDisposableEmail(email) {
  const at = String(email || '').lastIndexOf('@');
  if (at === -1) return false;
  let domain = email.slice(at + 1).toLowerCase().trim();
  while (domain) {
    if (DISPOSABLE_DOMAINS.has(domain)) return true;
    const dot = domain.indexOf('.');
    if (dot === -1) break;
    domain = domain.slice(dot + 1);
  }
  return false;
}

module.exports = { isDisposableEmail };
