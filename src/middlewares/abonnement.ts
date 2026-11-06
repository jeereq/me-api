import type { NextFunction, Request, Response } from 'express';

import { aDroit, etatAbonnement, formuleDe, messageReserve, photoManquante, SELECT_ABONNEMENT, type Fonction } from '../services/abonnements/offres.js';
import { prisma } from '../utils/prisma.js';

/**
 * Réserve une route à la formule qui inclut `fonction` (Finances ou Pro, essai compris). Renvoie 402
 * ABONNEMENT_REQUIS sinon, avec la formule à choisir ; les admins passent toujours.
 */
export const requireFonction =
  (fonction: Fonction) =>
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const u = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.id }, select: { ...SELECT_ABONNEMENT, photoUrl: true } });
      if (aDroit(etatAbonnement(u), fonction)) {
        // Les options de Finances demandent une photo de profil, pour Finances, Pro et l'essai.
        if (photoManquante(u, fonction)) {
          res.status(403).json({ error: 'Ajoute ta photo de profil pour utiliser cette option.', code: 'PHOTO_REQUISE', fonction });
          return;
        }
        next();
        return;
      }
      res.status(402).json({ error: messageReserve(fonction), code: 'ABONNEMENT_REQUIS', fonction, formule: formuleDe(fonction) });
    } catch (e) {
      next(e);
    }
  };

/** Réserve une route à Pro (voir `requireFonction`). */
export const requirePro = requireFonction;
