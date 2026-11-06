import type { Request, Response } from 'express';

import { CotisationService } from '../services/CotisationService.js';

const parametre = (v: string | string[] | undefined) => String(v ?? '');

export const CotisationController = {
  liste: async (req: Request, res: Response) => {
    res.json(await CotisationService.liste(req.user!.id));
  },
  supprimer: async (req: Request, res: Response) => {
    res.json(await CotisationService.supprimer(req.user!.id, parametre(req.params.id)));
  },
  retirerMembre: async (req: Request, res: Response) => {
    res.json(await CotisationService.retirerMembre(req.user!.id, parametre(req.params.membreId)));
  },
  retour: async (req: Request, res: Response) => {
    res.json(await CotisationService.retour((req.body ?? {}) as Record<string, unknown>));
  },
};
