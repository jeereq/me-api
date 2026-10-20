import type { Request, Response } from 'express';

import { AuthService } from '../services/AuthService.js';

export const AuthController = {
  register: async (req: Request, res: Response) => {
    res.status(201).json(await AuthService.register(req.body.email, req.body.password, req.body.nom));
  },
  login: async (req: Request, res: Response) => {
    res.json(await AuthService.login(req.body.email, req.body.password));
  },
  me: async (req: Request, res: Response) => {
    res.json({ user: req.user });
  },
  updateMe: async (req: Request, res: Response) => {
    res.json({ user: await AuthService.updateMe(req.user!.id, req.body) });
  },
};
