import type { Request, Response } from 'express';

import { EquipeService } from '../services/EquipeService.js';
import { EspaceEquipeService } from '../services/EspaceEquipeService.js';

export const EquipeController = {
  list: async (req: Request, res: Response) => {
    res.json({ equipes: await EquipeService.list(req.user!.id) });
  },

  creer: async (req: Request, res: Response) => {
    const id = await EquipeService.creer(req.user!.id, req.body.nom, req.body.emoji);
    res.status(201).json({ id });
  },

  renommer: async (req: Request, res: Response) => {
    await EquipeService.renommer(req.params.id, req.user!.id, { nom: req.body.nom, emoji: req.body.emoji });
    res.json({ ok: true });
  },

  supprimer: async (req: Request, res: Response) => {
    await EquipeService.supprimer(req.params.id, req.user!.id);
    res.json({ ok: true });
  },

  inviter: async (req: Request, res: Response) => {
    res.status(201).json(await EquipeService.inviter(req.params.id, req.user!.id, req.body.email, req.body.role));
  },

  annulerInvitation: async (req: Request, res: Response) => {
    await EquipeService.annulerInvitation(req.params.id, req.user!.id, req.params.invitationId);
    res.json({ ok: true });
  },

  /** Ce que l'app montre avant d'accepter : quelle équipe, qui invite, et si le compte connecté peut accepter. */
  apercuInvitation: async (req: Request, res: Response) => {
    res.json(await EquipeService.apercuInvitation(req.body.jeton, req.user!.email));
  },

  rejoindre: async (req: Request, res: Response) => {
    res.json({ id: await EquipeService.rejoindre(req.user!.id, req.user!.email, req.body.jeton) });
  },

  changerRole: async (req: Request, res: Response) => {
    await EquipeService.changerRole(req.params.id, req.user!.id, req.params.membreId, req.body.role);
    res.json({ ok: true });
  },

  retirer: async (req: Request, res: Response) => {
    await EquipeService.retirer(req.params.id, req.user!.id, req.params.membreId);
    res.json({ ok: true });
  },

  getEspace: async (req: Request, res: Response) => {
    res.json({ espace: await EspaceEquipeService.get(req.params.id, req.user!.id) });
  },

  putEspace: async (req: Request, res: Response) => {
    const r = await EspaceEquipeService.put(req.params.id, req.user!.id, req.body.data, req.body.baseRevision);
    if ('conflit' in r) {
      // 409 : quelqu'un d'autre a écrit entre-temps. L'app fusionne avec la version renvoyée ici, puis réessaie.
      res.status(409).json({ error: "L'espace de l'équipe a été modifié entre-temps.", code: 'CONFLIT', espace: r.espace });
      return;
    }
    res.json(r);
  },
};
