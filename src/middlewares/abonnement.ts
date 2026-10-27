import type { NextFunction, Request, Response } from 'express';

import { etatAbonnement, messageReserve, type FonctionPro } from '../services/abonnements/offres.js';
import { prisma } from '../utils/prisma.js';

/** Réserve une route à Pro (essai compris). Renvoie 402 ABONNEMENT_REQUIS sinon ; les admins passent toujours. */
export const requirePro =
  (fonction: FonctionPro) =>
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const u = await prisma.user.findUniqueOrThrow({
        where: { id: req.user!.id },
        select: { role: true, essaiJusqua: true, abonnementPeriode: true, abonnementFinLe: true },
      });
      if (etatAbonnement(u).pro) {
        next();
        return;
      }
      res.status(402).json({ error: messageReserve(fonction), code: 'ABONNEMENT_REQUIS', fonction });
    } catch (e) {
      next(e);
    }
  };
