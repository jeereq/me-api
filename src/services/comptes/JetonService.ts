import { createHash, randomBytes } from 'crypto';

import type { TypeJeton } from '@prisma/client';

import { HttpError } from '../../utils/http.js';
import { prisma } from '../../utils/prisma.js';

const empreinte = (brut: string) => createHash('sha256').update(brut).digest('hex');

/**
 * Jetons à usage unique envoyés par email ou dans une redirection (confirmation, mot de passe oublié, retour de Google).
 * Seule leur empreinte SHA-256 est en base : une fuite de la base ne donne aucun lien utilisable.
 */
export const JetonService = {
  async creer(userId: string, type: TypeJeton, minutes: number) {
    const brut = randomBytes(32).toString('base64url');
    await prisma.jetonCompte.deleteMany({ where: { userId, expireLe: { lt: new Date() } } });
    await prisma.jetonCompte.create({ data: { userId, type, empreinte: empreinte(brut), expireLe: new Date(Date.now() + minutes * 60 * 1000) } });
    return brut;
  },

  /** Marque le jeton utilisé et renvoie son compte ; un jeton expiré, déjà servi ou inconnu est refusé. */
  async consommer(brut: string, type: TypeJeton, message = 'Ce lien n’est plus valable. Demande-en un nouveau.') {
    const e = empreinte(brut || '');
    const { count } = await prisma.jetonCompte.updateMany({ where: { empreinte: e, type, utiliseLe: null, expireLe: { gt: new Date() } }, data: { utiliseLe: new Date() } });
    if (!count) throw new HttpError(400, message, 'JETON_INVALIDE');
    const j = await prisma.jetonCompte.findUniqueOrThrow({ where: { empreinte: e }, include: { user: true } });
    return j.user;
  },

  /** Le dernier jeton de ce type a-t-il été envoyé il y a moins de `secondes` ? (évite d'inonder une boîte mail) */
  async recent(userId: string, type: TypeJeton, secondes = 60) {
    return !!(await prisma.jetonCompte.findFirst({ where: { userId, type, createdAt: { gt: new Date(Date.now() - secondes * 1000) } } }));
  },

  annulerTous: (userId: string, type: TypeJeton) => prisma.jetonCompte.updateMany({ where: { userId, type, utiliseLe: null }, data: { utiliseLe: new Date() } }),
};
