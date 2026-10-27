import type { Request, Response } from 'express';

import { AbonnementService } from '../services/AbonnementService.js';

export const AbonnementController = {
  offres: async (_req: Request, res: Response) => {
    res.json(AbonnementService.offres());
  },
  etat: async (req: Request, res: Response) => {
    res.json(await AbonnementService.etat(req.user!.id));
  },
  payer: async (req: Request, res: Response) => {
    res.json(await AbonnementService.payer(req.user!.id, req.body.periode, req.body.telephone));
  },
  suivre: async (req: Request, res: Response) => {
    res.json(await AbonnementService.suivre(req.user!.id, req.params.reference));
  },
  retour: async (req: Request, res: Response) => {
    res.json(await AbonnementService.retour((req.body ?? {}) as Record<string, unknown>));
  },
};
