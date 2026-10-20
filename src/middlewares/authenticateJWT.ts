import type { NextFunction, Request, Response } from 'express';

import { verifyToken } from '../utils/jwt.js';
import { prisma } from '../utils/prisma.js';

/** Vérifie le token et recharge le compte : un compte supprimé ou rétrogradé l'est tout de suite. */
export const authenticateJWT = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Token manquant' });
    return;
  }
  try {
    const { userId } = verifyToken(header.substring(7));
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, email: true, nom: true, role: true } });
    if (!user) {
      res.status(401).json({ error: 'Compte introuvable' });
      return;
    }
    req.user = user;
    next();
  } catch {
    res.status(401).json({ error: 'Session expirée, reconnecte-toi.' });
  }
};

export const requireAdmin = (req: Request, res: Response, next: NextFunction): void => {
  if (req.user?.role !== 'ADMIN') {
    res.status(403).json({ error: 'Réservé aux admins.' });
    return;
  }
  next();
};
