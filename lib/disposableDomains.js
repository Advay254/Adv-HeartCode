'use strict';

// v1.2.21: well-known throwaway email domains, refused for free deployments.
// The admin can add more from the Free Deployments page (one per line); this
// built-in list is the starting point and is never edited there.
const DISPOSABLE_DOMAINS = [
  '10minutemail.com', '10minutemail.net', '10minutemail.org', '20minutemail.com', '33mail.com',
  'anonbox.net', 'anonymbox.com', 'armyspy.com', 'burnermail.io', 'byom.de',
  'cuvox.de', 'dayrep.com', 'deadaddress.com', 'discard.email', 'discardmail.com',
  'dispostable.com', 'dropmail.me', 'einrot.com', 'emailondeck.com', 'emailfake.com',
  'email-fake.com', 'fakeinbox.com', 'fakemail.net', 'fleckens.hu', 'getairmail.com',
  'getnada.com', 'grr.la', 'guerrillamail.biz', 'guerrillamail.com', 'guerrillamail.de',
  'guerrillamail.info', 'guerrillamail.net', 'guerrillamail.org', 'guerrillamailblock.com', 'gustr.com',
  'harakirimail.com', 'inboxbear.com', 'inboxkitten.com', 'incognitomail.com', 'jourrapide.com',
  'mail-temporaire.fr', 'mail.tm', 'mailcatch.com', 'maildrop.cc', 'maildrop.gq',
  'mailforspam.com', 'mailinator.com', 'mailinator.net', 'mailinator2.com', 'mailnesia.com',
  'mailnull.com', 'mailsac.com', 'mailtemp.info', 'mintemail.com', 'moakt.com',
  'mohmal.com', 'mt2014.com', 'mytemp.email', 'nada.email', 'nowmymail.com',
  'pokemail.net', 'rhyta.com', 'sharklasers.com', 'spam4.me', 'spamavert.com',
  'spambox.us', 'spamfree24.org', 'spamgourmet.com', 'spamherelots.com', 'superrito.com',
  'teleworm.us', 'temp-mail.io', 'temp-mail.org', 'tempail.com', 'tempinbox.com',
  'tempmail.com', 'tempmail.net', 'tempmail.plus', 'tempmailo.com', 'tempr.email',
  'throwawaymail.com', 'throwam.com', 'tmail.ws', 'tmpmail.net', 'tmpmail.org',
  'trash-mail.com', 'trashmail.com', 'trashmail.de', 'trashmail.net', 'trashmail.org',
  'trbvm.com', 'wegwerfmail.de', 'wegwerfmail.net', 'yopmail.com', 'yopmail.fr',
  'yopmail.net', 'yopmail.gq', 'cool.fr.nf', 'jetable.org', 'zetmail.com',
  'mailpoof.com', 'mailtothis.com', 'fexbox.org', 'fexpost.com', 'ezztt.com',
  'luxusmail.org', 'mvrht.com', 'linshiyouxiang.net', 'emltmp.com', 'tmails.net',
  'tempmailaddress.com', 'tempmailer.com', 'tempmails.net', 'mailbox92.biz', 'inboxalias.com',
  'oneoffmail.com', 'onewaymail.com', 'owlymail.com', 'binkmail.com', 'bobmail.info',
  'chammy.info', 'devnullmail.com', 'letthemeatspam.com', 'mailmoat.com', 'safetymail.info',
  'sogetthis.com', 'spamcero.com', 'spamex.com', 'spamhole.com', 'spaml.com',
  'tradermail.info', 'veryrealemail.com', 'zippymail.info', 'smailpro.com', 'internxt.com'
];

module.exports = { DISPOSABLE_DOMAINS };
