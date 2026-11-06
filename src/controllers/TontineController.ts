import type { Request, Response } from 'express';

import { TAILLE_PIECE_MAX } from '../services/cotisations/approbations.js';
import { SmsService } from '../services/SmsService.js';
import { ApprobationService as A, TontineService as S } from '../services/TontineService.js';
import { lireFormulaire } from '../utils/formulaire.js';
import { HttpError } from '../utils/http.js';
import { prisma } from '../utils/prisma.js';

const p = (v: string | string[] | undefined) => String(v ?? '');
const compte = async (req: Request) => {
  const u = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.id }, select: { id: true, nom: true, fuseau: true, telephone: true } });
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
    res.json(await S.adherer(await compte(req), p(req.params.id)));
  },
  invitation: async (req: Request, res: Response) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' }).json(await S.invitation(p(req.params.code)));
  },
  rejoindre: async (req: Request, res: Response) => {
    res.json(await S.rejoindreParInvitation(await compte(req), p(req.params.code), req.body.telephone));
  },
  inviter: async (req: Request, res: Response) => {
    res.json(await S.inviter(req.user!.id, p(req.params.id), req.body.telephone));
  },
  payerPour: async (req: Request, res: Response) => {
    res.json(await S.payerPourMembre(req.user!.id, p(req.params.membreId)));
  },
  retirer: async (req: Request, res: Response) => {
    res.json(await S.retirer(req.user!.id, p(req.params.membreId)));
  },
  eligibilite: async (req: Request, res: Response) => {
    res.json(await A.etat(req.user!.id));
  },
  demanderCode: async (req: Request, res: Response) => {
    await SmsService.demanderCode(req.user!.id, req.body.telephone);
    res.json(await A.etat(req.user!.id));
  },
  confirmerCode: async (req: Request, res: Response) => {
    await SmsService.confirmerCode(req.user!.id, req.body.code);
    res.json(await A.etat(req.user!.id));
  },
  soumettre: async (req: Request, res: Response) => {
    const form = await lireFormulaire(req, TAILLE_PIECE_MAX + 64 * 1024, 'Photo trop lourde : 5 Mo au plus.');
    const fichier = form.get('fichier');
    if (!(fichier instanceof File)) throw new HttpError(400, 'Aucune photo reçue.');
    res.status(201).json(await A.soumettre(req.user!.id, new Uint8Array(await fichier.arrayBuffer())));
  },
  adminApprobations: async (_req: Request, res: Response) => {
    res.json(await A.aTraiter());
  },
  adminPiece: async (req: Request, res: Response) => {
    res.set({ 'Cache-Control': 'no-store' }).json(await A.piece(p(req.params.userId)));
  },
  adminDecider: async (req: Request, res: Response) => {
    const u = await compte(req);
    res.json(await A.decider(u.nom, p(req.params.userId), req.body.approuve, req.body.motif));
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
