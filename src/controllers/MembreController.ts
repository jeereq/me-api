import type { Request, Response } from 'express';

import { MembreService } from '../services/MembreService.js';
import { HttpError } from '../utils/http.js';
import { gestionMembresSchema } from '../validators/schemas.js';

export const MembreController = {
  gestion: async (req: Request, res: Response) => {
    const { filtre, q, page } = gestionMembresSchema.parse({ query: req.query }).query;
    const r = await MembreService.gestion(filtre, q, page);
    // Les revenus de la plateforme restent à l'admin.
    res.json(req.user!.role === 'ADMIN' ? r : { ...r, stats: { ...r.stats, revenus: {} } });
  },
  fiche: async (req: Request, res: Response) => {
    res.json(await MembreService.fiche(req.params.id));
  },
  agir: async (req: Request, res: Response) => {
    // Personne ne s'offre un abonnement à soi-même, sauf un admin.
    if (req.params.id === req.user!.id && req.user!.role !== 'ADMIN') throw new HttpError(403, 'Un autre responsable doit le faire pour toi.');
    res.json(await MembreService.agir(req.params.id, { id: req.user!.id }, req.body));
  },
  list: async (_req: Request, res: Response) => {
    res.json({ membres: await MembreService.list() });
  },
  setRole: async (req: Request, res: Response) => {
    res.json({ membre: await MembreService.setRole(req.params.id, req.body.role, req.body.modules) });
  },
  remove: async (req: Request, res: Response) => {
    await MembreService.remove(req.params.id, req.user!.id);
    res.status(204).end();
  },
};
