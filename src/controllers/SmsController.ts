import type { Request, Response } from 'express';

import { SmsService } from '../services/SmsService.js';

export const SmsController = {
  etat: async (req: Request, res: Response) => {
    res.json(await SmsService.etat(req.user!.id));
  },
  demanderCode: async (req: Request, res: Response) => {
    res.json(await SmsService.demanderCode(req.user!.id, req.body.telephone));
  },
  confirmerCode: async (req: Request, res: Response) => {
    res.json(await SmsService.confirmerCode(req.user!.id, req.body.code));
  },
  retirer: async (req: Request, res: Response) => {
    res.json(await SmsService.retirer(req.user!.id));
  },
  tester: async (req: Request, res: Response) => {
    await SmsService.tester(req.user!.id);
    res.status(204).end();
  },
  solde: async (_req: Request, res: Response) => {
    res.json(await SmsService.solde());
  },
  retour: async (req: Request, res: Response) => {
    await SmsService.retour(req.query.cle, req.body);
    res.status(204).end();
  },
};
