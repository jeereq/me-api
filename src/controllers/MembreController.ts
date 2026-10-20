import type { Request, Response } from 'express';

import { MembreService } from '../services/MembreService.js';

export const MembreController = {
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
