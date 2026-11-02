import type { Request, Response } from 'express';

import { MembreService } from '../services/MembreService.js';
import { gestionMembresSchema } from '../validators/schemas.js';

export const MembreController = {
  gestion: async (req: Request, res: Response) => {
    const { filtre, q, page } = gestionMembresSchema.parse({ query: req.query }).query;
    res.json(await MembreService.gestion(filtre, q, page));
  },
  fiche: async (req: Request, res: Response) => {
    res.json(await MembreService.fiche(req.params.id));
  },
  agir: async (req: Request, res: Response) => {
    res.json(await MembreService.agir(req.params.id, { id: req.user!.id }, req.body));
  },
  list: async (_req: Request, res: Response) => {
    res.json({ membres: await MembreService.list() });
  },
  setRole: async (req: Request, res: Response) => {
    res.json({ membre: await MembreService.setRole(req.params.id, req.body.role) });
  },
  remove: async (req: Request, res: Response) => {
    await MembreService.remove(req.params.id, req.user!.id);
    res.status(204).end();
  },
};
