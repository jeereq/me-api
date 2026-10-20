import type { Request, Response } from 'express';

import { EspaceService } from '../services/EspaceService.js';

export const EspaceController = {
  get: async (req: Request, res: Response) => {
    res.json({ espace: await EspaceService.get(req.user!.id) });
  },
  put: async (req: Request, res: Response) => {
    res.json(await EspaceService.put(req.user!.id, req.body.data));
  },
};
