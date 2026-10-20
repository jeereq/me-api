import type { Request, Response } from 'express';

import { NotificationService } from '../services/NotificationService.js';

export const NotificationController = {
  liste: async (req: Request, res: Response) => {
    res.json(await NotificationService.liste(req.user!.id));
  },
  lues: async (req: Request, res: Response) => {
    await NotificationService.marquerLues(req.user!.id, req.body?.ids);
    res.status(204).end();
  },
  tester: async (req: Request, res: Response) => {
    res.json(await NotificationService.tester(req.user!.id));
  },
};
