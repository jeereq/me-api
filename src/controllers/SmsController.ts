import type { Request, Response } from 'express';

import { NumerosAutorises } from '../services/sms/numeros.js';
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
  numeros: async (_req: Request, res: Response) => {
    res.json(await NumerosAutorises.liste());
  },
  autoriser: async (req: Request, res: Response) => {
    res.json(await NumerosAutorises.ajouter(req.user!.nom || req.user!.email, req.body.indicatif, req.body.numero));
  },
  retirerAutorisation: async (req: Request, res: Response) => {
    res.json(await NumerosAutorises.retirer(req.params.id));
  },
  retour: async (req: Request, res: Response) => {
    await SmsService.retour(req.query.cle, req.body);
    res.status(204).end();
  },
};
