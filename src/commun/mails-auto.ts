/** Reconnaître un mail envoyé par un robot : notifications, sans réponse possible, lettres d'information. Module pur. */

const ADRESSE_ROBOT = /^(?:(?:no-?reply|do-?not-?reply|ne-?pas-?repondre|mailer-daemon|postmaster|bounces?)[^@]*|(?:notifications?|newsletters?|alerts?)(?:\+[^@]*)?)@/i;
const NOM_ROBOT = /\[bot\]|no-?reply/i;

export const estAutomatique = (m: { contact?: string; adresse?: string }) => ADRESSE_ROBOT.test(m.adresse?.trim() ?? '') || NOM_ROBOT.test(m.contact ?? '');
