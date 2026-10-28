import type { Request, Response } from 'express';

import { EspaceService } from '../services/EspaceService.js';

export const EspaceController = {
  get: async (req: Request, res: Response) => {
    res.json({ espace: await EspaceService.get(req.user!.id) });
  },
  put: async (req: Request, res: Response) => {
    const r = await EspaceService.put(req.user!.id, req.body.data, req.body.baseRevision);
    if ('conflit' in r) {
      // 409 : un autre appareil a écrit entre-temps. L'app fusionne avec la version du serveur renvoyée ici, puis réessaie.
      res.status(409).json({ error: 'Ton espace a été modifié depuis un autre appareil.', code: 'CONFLIT', espace: r.espace });
      return;
    }
    res.json(r);
  },
  patch: async (req: Request, res: Response) => {
    const r = await EspaceService.patch(req.user!.id, req.body.operations, req.body.baseRevision);
    if ('conflit' in r) {
      res.status(409).json({ error: 'Ton espace a été modifié depuis un autre appareil.', code: 'CONFLIT', espace: r.espace });
      return;
    }
    res.json(r);
  },
};
