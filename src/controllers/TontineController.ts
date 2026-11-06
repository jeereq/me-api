import type { Request, Response } from 'express';

import { TontineService as S } from '../services/TontineService.js';
import { prisma } from '../utils/prisma.js';

const p = (v: string | string[] | undefined) => String(v ?? '');
const compte = async (req: Request) => {
  const u = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.id }, select: { id: true, nom: true, fuseau: true } });
  return u;
};

export const TontineController = {
  mesGroupes: async (req: Request, res: Response) => {
    res.json(await S.mesGroupes(req.user!.id));
  },
  annuaire: async (req: Request, res: Response) => {
    res.json(await S.annuaire(req.user!.id, typeof req.query.q === 'string' ? req.query.q : undefined));
  },
  detail: async (req: Request, res: Response) => {
    res.json(await S.detail(req.user!.id, p(req.params.id)));
  },
  creer: async (req: Request, res: Response) => {
    res.status(201).json(await S.creer(await compte(req), req.body));
  },
  adherer: async (req: Request, res: Response) => {
    res.json(await S.adherer(await compte(req), p(req.params.id), req.body.telephone));
  },
  quitter: async (req: Request, res: Response) => {
    res.json(await S.quitter(req.user!.id, p(req.params.id)));
  },
  annuler: async (req: Request, res: Response) => {
    res.json(await S.annuler(req.user!.id, p(req.params.id)));
  },
  demarrer: async (req: Request, res: Response) => {
    res.json(await S.demarrer(req.user!.id, p(req.params.id)));
  },
  payer: async (req: Request, res: Response) => {
    res.json(await S.payer(req.user!.id, p(req.params.id), req.body.genre));
  },
  abandonner: async (req: Request, res: Response) => {
    res.json(await S.abandonner(req.user!.id, p(req.params.id)));
  },
  decider: async (req: Request, res: Response) => {
    res.json(await S.decider(req.user!.id, p(req.params.membreId), req.body.accepte));
  },
  rappeler: async (req: Request, res: Response) => {
    res.json(await S.rappeler(req.user!.id, p(req.params.membreId)));
  },
  utiliserCaution: async (req: Request, res: Response) => {
    res.json(await S.utiliserCaution(req.user!.id, p(req.params.membreId)));
  },
  retour: async (req: Request, res: Response) => {
    res.json(await S.retour((req.body ?? {}) as Record<string, unknown>));
  },
  adminResume: async (_req: Request, res: Response) => {
    res.json(await S.resumeAdmin());
  },
  adminVerser: async (req: Request, res: Response) => {
    const u = await compte(req);
    res.json(await S.verserTour(u.nom, p(req.params.tourId), req.body.preuve));
  },
  adminRendre: async (req: Request, res: Response) => {
    res.json(await S.rendreCaution(p(req.params.membreId), req.body.preuve));
  },
};
