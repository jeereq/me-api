import type { Request, Response } from 'express';

import { NotificationService } from '../services/NotificationService.js';
import { PushService } from '../services/PushService.js';

export const NotificationController = {
  liste: async (req: Request, res: Response) => {
    res.json(await NotificationService.liste(req.user!.id));
  },
  lues: async (req: Request, res: Response) => {
    await NotificationService.marquerLues(req.user!.id, req.body?.ids);
    res.status(204).end();
  },
  cle: async (req: Request, res: Response) => {
    res.json({ cle: PushService.clePublique(), appareils: await PushService.nombre(req.user!.id) });
  },
  abonner: async (req: Request, res: Response) => {
    await PushService.abonner(req.user!.id, req.body);
    res.status(204).end();
  },
  desabonner: async (req: Request, res: Response) => {
    await PushService.desabonner(req.user!.id, req.body.endpoint);
    res.status(204).end();
  },
  tester: async (req: Request, res: Response) => {
    res.json(await NotificationService.tester(req.user!.id));
  },
};
