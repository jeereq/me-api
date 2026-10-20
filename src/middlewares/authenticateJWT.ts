import type { NextFunction, Request, Response } from 'express';

import { verifyToken } from '../utils/jwt.js';
import { prisma } from '../utils/prisma.js';

/** Vérifie le token et recharge le compte : un compte supprimé, rétrogradé ou dont le mot de passe a changé l'est tout de suite. */
export const authenticateJWT = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Token manquant' });
    return;
  }
  try {
    const { userId, iat } = verifyToken(header.substring(7));
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, email: true, nom: true, role: true, motDePasseLe: true, sessionsLe: true } });
    if (!user) {
      res.status(401).json({ error: 'Compte introuvable' });
      return;
    }
    // Mot de passe changé, ou tous les appareils déconnectés, depuis l'ouverture de cette session : on la ferme.
    const ouverte = (iat ?? 0) * 1000;
    if ((user.motDePasseLe && ouverte < user.motDePasseLe.getTime()) || (user.sessionsLe && ouverte < user.sessionsLe.getTime())) {
      res.status(401).json({ error: user.sessionsLe && ouverte < user.sessionsLe.getTime() ? 'Session fermée depuis un autre appareil, reconnecte-toi.' : 'Mot de passe changé, reconnecte-toi.' });
      return;
    }
    req.user = { id: user.id, email: user.email, nom: user.nom, role: user.role };
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
