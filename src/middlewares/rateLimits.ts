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

/** Assistant IA : 30 demandes / 10 min par compte, pour garder la facture OpenAI sous contrôle. */
export const assistantLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 30,
  keyGenerator: (req) => req.user?.id ?? ipKeyGenerator(req.ip ?? ''),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: "Beaucoup de demandes à l'IA d'un coup, réessaie dans quelques minutes." },
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
