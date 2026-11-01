import type { Request } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';

const message = { error: 'Trop de tentatives, réessaie plus tard.' };
const emailKey = (req: Request) => {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  return email ? `email:${email}` : `ip:${ipKeyGenerator(req.ip ?? '')}`;
};

/** Connexion et inscription : 10 échecs / 15 min par email, 50 / 15 min par IP. */
export const authLimiter = [
  rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, keyGenerator: emailKey, skipSuccessfulRequests: true, standardHeaders: 'draft-7', legacyHeaders: false, message }),
  rateLimit({ windowMs: 15 * 60 * 1000, limit: 50, skipSuccessfulRequests: true, standardHeaders: 'draft-7', legacyHeaders: false, message }),
];

/** Emails de compte (confirmation, mot de passe oublié) : 5 / 15 min par email, 30 / 15 min par IP, réussites comprises. */
export const mailLimiter = [
  rateLimit({ windowMs: 15 * 60 * 1000, limit: 5, keyGenerator: emailKey, standardHeaders: 'draft-7', legacyHeaders: false, message }),
  rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false, message }),
];

/** L'analyse des mails mail par mail : l'app envoie les non lus par paquets de 10, une demande par paquet. */
export const estAnalyseMails = (req: Request) => req.body?.type === 'mails';
const cleCompte = (req: Request) => req.user?.id ?? ipKeyGenerator(req.ip ?? '');

/** Assistant IA : 30 demandes / 10 min par compte, pour garder la facture OpenAI sous contrôle. */
const assistantGeneral = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 30,
  keyGenerator: cleCompte,
  skip: estAnalyseMails,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: "Beaucoup de demandes à l'IA d'un coup, réessaie dans quelques minutes." },
});
/**
 * L'analyse des mails a son propre compteur : 60 paquets (600 mails) / 10 min par compte. Analyser 200 non lus ne bloque
 * donc ni le plan du jour ni les questions, et l'app sait reprendre là où elle s'est arrêtée si la limite est atteinte.
 */
const assistantMails = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 60,
  keyGenerator: cleCompte,
  skip: (req) => !estAnalyseMails(req),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: "Beaucoup de mails analysés d'un coup : la suite reprendra dans quelques minutes.", code: 'LIMITE_ANALYSE' },
});
export const assistantLimiter = [assistantGeneral, assistantMails];
/** L'analyse de mails lus par le serveur : même compteur que les paquets de mails envoyés par l'app (60 paquets / 10 min par compte). */
export const analyseMailsLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 60,
  keyGenerator: cleCompte,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: "Beaucoup de mails analysés d'un coup : la suite reprendra dans quelques minutes.", code: 'LIMITE_ANALYSE' },
});

/** Justificatifs : 60 fichiers / heure par compte, pour garder le stockage Cloudinary sous contrôle. */
export const justificatifLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 60,
  keyGenerator: (req) => req.user?.id ?? ipKeyGenerator(req.ip ?? ''),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Beaucoup de justificatifs d’un coup, réessaie dans un moment.' },
});

/**
 * Retour de paiement FlexPaie (adresse publique) : chaque appel déclenche une vérification chez FlexPaie,
 * donc 60 appels par minute et par IP au plus.
 */
export const retourPaiementLimiter = rateLimit({ windowMs: 60 * 1000, limit: 60, standardHeaders: 'draft-7', legacyHeaders: false, message });
