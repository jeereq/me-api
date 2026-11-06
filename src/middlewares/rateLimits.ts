import type { Request } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';

import { normaliserTelephone } from '../services/abonnements/flexpaie.js';

const message = { error: 'Trop de tentatives, réessaie plus tard.' };
const emailKey = (req: Request) => {
  const brut = req.body?.identifiant ?? req.body?.email;
  const texte = typeof brut === 'string' ? brut.trim().toLowerCase() : '';
  // 0817… et +243 817… sont le même numéro : la limite ne doit pas se contourner en changeant d'écriture.
  const email = texte && !texte.includes('@') ? (normaliserTelephone(texte) ?? texte) : texte;
  return email ? `email:${email}` : `ip:${ipKeyGenerator(req.ip ?? '')}`;
};

/** Connexion et inscription : 10 échecs / 15 min par email, 50 / 15 min par IP. */
export const authLimiter = [
  rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, keyGenerator: emailKey, skipSuccessfulRequests: true, standardHeaders: 'draft-7', legacyHeaders: false, message }),
  rateLimit({ windowMs: 15 * 60 * 1000, limit: 50, skipSuccessfulRequests: true, standardHeaders: 'draft-7', legacyHeaders: false, message }),
];

/** Inscription confirmée par SMS : chaque essai est un SMS payé, réussites comprises. 5 par heure et par IP. */
export const inscriptionSmsLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 5, skip: (req) => req.body?.confirmation !== 'sms', standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Trop d’inscriptions par SMS. Réessaie dans une heure, ou choisis l’email.' } });

/** Formulaire de contact, ouvert sans compte : 5 messages par heure et par IP. */
export const contactLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 5, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Trop de messages envoyés. Réessaie dans une heure.' } });

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

/** Transcription des réunions : 10 enregistrements / heure par compte (un enregistrement d'une heure coûte plus qu'une question). */
export const transcriptionLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  keyGenerator: cleCompte,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Beaucoup de réunions transcrites d’un coup, réessaie dans un moment.', code: 'LIMITE_ANALYSE' },
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

/** Liens temporaires des justificatifs : une liste de dépenses les demande par lots. */
export const liensJustificatifsLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  keyGenerator: (req) => req.user?.id ?? ipKeyGenerator(req.ip ?? ''),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Trop de demandes, réessaie dans un moment.' },
});

/** Ouverture d'un justificatif : chaque vignette d'une liste en est une. */
export const ouvrirJustificatifLimiter = rateLimit({ windowMs: 60 * 1000, limit: 600, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Trop de demandes, réessaie dans un moment.' } });

/** Lecture des factures par l'IA : 40 lectures / heure par compte (une image en haute définition coûte plus qu'une question). */
export const analyseJustificatifLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 40,
  keyGenerator: cleCompte,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Beaucoup de factures lues d’un coup, réessaie dans un moment.', code: 'LIMITE_ANALYSE' },
});

/**
 * Retour de paiement FlexPaie (adresse publique) : chaque appel déclenche une vérification chez FlexPaie,
 * donc 60 appels par minute et par IP au plus.
 */
export const retourPaiementLimiter = rateLimit({ windowMs: 60 * 1000, limit: 60, standardHeaders: 'draft-7', legacyHeaders: false, message });
/** Retour de livraison d'aSMSC (adresse publique, protégée par sa clé). */
export const retourSmsLimiter = rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false, message });

const compteKey = (req: Request) => `compte:${req.user?.id ?? ipKeyGenerator(req.ip ?? '')}`;
/** Chaque demande fait sonner un téléphone : 6 par compte en 10 minutes. */
export const payerTontineLimiter = rateLimit({ windowMs: 10 * 60 * 1000, limit: 6, keyGenerator: compteKey, standardHeaders: 'draft-7', legacyHeaders: false, message });
/** Envois par mail ou SMS : chaque SMS coûte. */
export const envoiCotisationLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 60, keyGenerator: compteKey, standardHeaders: 'draft-7', legacyHeaders: false, message });
/** Code d'approbation : chaque code est un SMS payé. */
export const codeTontineLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 3, keyGenerator: compteKey, standardHeaders: 'draft-7', legacyHeaders: false, message });
export const confirmerTontineLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 5, keyGenerator: compteKey, standardHeaders: 'draft-7', legacyHeaders: false, message });
export const pieceIdentiteLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 5, keyGenerator: compteKey, standardHeaders: 'draft-7', legacyHeaders: false, message });
/** Page d'invitation, ouverte sans compte : on ne devine pas un code en le testant. */
export const invitationTontineLimiter = rateLimit({ windowMs: 60 * 1000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false, message });
