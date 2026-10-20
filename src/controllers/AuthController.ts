import type { Request, Response } from 'express';

import { AuthService } from '../services/AuthService.js';
import { ConnexionGoogle, retourConnexion } from '../services/comptes/google.js';

/** Renvoie vers l'app avec le résultat de la connexion Google. */
const versApp = (retour: string, params: Record<string, string>) => `${retour}${retour.includes('?') ? '&' : '?'}${new URLSearchParams(params)}`;

export const AuthController = {
  options: async (_req: Request, res: Response) => {
    res.json(AuthService.options());
  },
  register: async (req: Request, res: Response) => {
    res.status(201).json(await AuthService.register(req.body.email, req.body.password, req.body.nom));
  },
  login: async (req: Request, res: Response) => {
    res.json(await AuthService.login(req.body.email, req.body.password));
  },
  verifier: async (req: Request, res: Response) => {
    res.json(await AuthService.verifier(req.body.jeton));
  },
  renvoyerVerification: async (req: Request, res: Response) => {
    res.json(await AuthService.renvoyerVerification(req.body.email));
  },
  oubli: async (req: Request, res: Response) => {
    res.json(await AuthService.oubli(req.body.email));
  },
  reinitialiser: async (req: Request, res: Response) => {
    res.json(await AuthService.reinitialiser(req.body.jeton, req.body.password));
  },

  /** Ouvre l'écran de choix du compte Google ; `retour` est l'adresse de l'app où revenir. */
  googleDebut: async (req: Request, res: Response) => {
    res.redirect(ConnexionGoogle.url(String(req.query.retour || '')));
  },

  /** Retour de Google : le navigateur arrive ici, puis repart vers l'app avec un code à usage unique. */
  googleCallback: async (req: Request, res: Response) => {
    const retour = ConnexionGoogle.lireState(String(req.query.state || ''));
    if (!retour) {
      res.redirect(versApp(retourConnexion(''), { erreur_google: 'Connexion Google expirée, recommence.' }));
      return;
    }
    try {
      if (req.query.error) throw new Error(req.query.error === 'access_denied' ? 'Connexion Google annulée.' : String(req.query.error_description || 'Connexion Google refusée.'));
      const code = await AuthService.google(await ConnexionGoogle.profil(String(req.query.code || '')));
      res.redirect(versApp(retour, { google: code }));
    } catch (e) {
      res.redirect(versApp(retour, { erreur_google: (e as Error).message }));
    }
  },

  googleEchange: async (req: Request, res: Response) => {
    res.json(await AuthService.echangerGoogle(req.body.code));
  },

  me: async (req: Request, res: Response) => {
    res.json({ user: await AuthService.moi(req.user!.id) });
  },
  updateMe: async (req: Request, res: Response) => {
    res.json(await AuthService.updateMe(req.user!.id, req.body));
  },
  supprimer: async (req: Request, res: Response) => {
    res.json(await AuthService.supprimer(req.user!.id, req.body.confirmation));
  },
};
