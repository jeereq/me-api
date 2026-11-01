import type { Request, Response } from 'express';

import { HttpError } from '../utils/http.js';
import { AnalyseMailService } from '../services/AnalyseMailService.js';
import { AssistantService } from '../services/AssistantService.js';

export const AssistantController = {
  status: async (_req: Request, res: Response) => {
    res.json({ disponible: await AssistantService.disponible() });
  },
  modeles: async (_req: Request, res: Response) => {
    res.json(await AssistantService.modeles());
  },
  demander: async (req: Request, res: Response) => {
    res.json({ text: await AssistantService.demander(req.body) });
  },
  /** L'analyse de mails lus par le serveur : `{ analyses }` comme la réponse de l'IA, avec ce qui venait de la mémoire. */
  analyserMails: async (req: Request, res: Response) => {
    if (!(await AssistantService.disponible())) throw new HttpError(503, "L'IA n'est pas activée sur ce serveur.");
    const { analyses, enCache, fraiches, illisibles } = await AnalyseMailService.analyser(req.user!.id, req.body);
    res.json({ analyses, enCache, fraiches, illisibles });
  },
};
