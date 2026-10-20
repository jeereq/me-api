import type { Request, Response } from 'express';

import { ConfigService } from '../services/ConfigService.js';

export const ConfigController = {
  get: async (_req: Request, res: Response) => {
    res.json({ config: await ConfigService.get() });
  },
  put: async (req: Request, res: Response) => {
    res.json({ config: await ConfigService.put(req.body.data, req.user!.id) });
  },
};
