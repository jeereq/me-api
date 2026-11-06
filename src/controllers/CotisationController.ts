import type { Request, Response } from 'express';

import { CotisationService } from '../services/CotisationService.js';
import { prisma } from '../utils/prisma.js';

const prive = (res: Response) => res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' });
const parametre = (v: string | string[] | undefined) => String(v ?? '');

export const CotisationController = {
  liste: async (req: Request, res: Response) => {
    res.json(await CotisationService.liste(req.user!.id));
  },
  creer: async (req: Request, res: Response) => {
    const u = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.id }, select: { fuseau: true } });
    res.status(201).json(await CotisationService.creer(req.user!.id, req.body, u.fuseau));
  },
  modifier: async (req: Request, res: Response) => {
    res.json(await CotisationService.modifier(req.user!.id, parametre(req.params.id), req.body));
  },
  supprimer: async (req: Request, res: Response) => {
    res.json(await CotisationService.supprimer(req.user!.id, parametre(req.params.id)));
  },
  ajouterMembre: async (req: Request, res: Response) => {
    res.status(201).json(await CotisationService.ajouterMembre(req.user!.id, parametre(req.params.id), req.body));
  },
  modifierMembre: async (req: Request, res: Response) => {
    res.json(await CotisationService.modifierMembre(req.user!.id, parametre(req.params.membreId), req.body));
  },
  retirerMembre: async (req: Request, res: Response) => {
    res.json(await CotisationService.retirerMembre(req.user!.id, parametre(req.params.membreId)));
  },
  demande: async (req: Request, res: Response) => {
    res.json(await CotisationService.noterDemande(req.user!.id, parametre(req.params.membreId), req.body.periode));
  },
  envoyer: async (req: Request, res: Response) => {
    res.json(await CotisationService.envoyerDemande(req.user!.id, parametre(req.params.membreId), req.body.periode));
  },
  marquer: async (req: Request, res: Response) => {
    res.json(await CotisationService.marquer(req.user!.id, parametre(req.params.membreId), req.body.periode, req.body.paye));
  },
  page: async (req: Request, res: Response) => {
    prive(res).json(await CotisationService.page(parametre(req.params.jeton)));
  },
  payer: async (req: Request, res: Response) => {
    prive(res).json(await CotisationService.payer(parametre(req.params.jeton)));
  },
  abandonner: async (req: Request, res: Response) => {
    prive(res).json(await CotisationService.abandonner(parametre(req.params.jeton)));
  },
  retour: async (req: Request, res: Response) => {
    res.json(await CotisationService.retour((req.body ?? {}) as Record<string, unknown>));
  },
};
