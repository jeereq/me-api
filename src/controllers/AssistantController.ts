import type { Request, Response } from 'express';

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
};
