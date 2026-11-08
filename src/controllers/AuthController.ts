import type { Request, Response } from 'express';

import { AuthService } from '../services/AuthService.js';
import { ConnexionGoogle, retourConnexion } from '../services/comptes/google.js';
import { PhotoProfil, TAILLE_PHOTO_MAX } from '../services/comptes/photo.js';
import { estFichier, lireFormulaire } from '../utils/formulaire.js';
import { HttpError } from '../utils/http.js';

/** Renvoie vers l'app avec le résultat de la connexion Google. */
const versApp = (retour: string, params: Record<string, string>) => `${retour}${retour.includes('?') ? '&' : '?'}${new URLSearchParams(params)}`;

/** L'email ou le numéro donné ; `email` pour les anciennes versions de l'app. */
const qui = (req: Request): string => req.body.identifiant ?? req.body.email;

export const AuthController = {
  /** La photo de profil, visible par les membres des groupes. */
  photo: async (req: Request, res: Response) => {
    const form = await lireFormulaire(req, TAILLE_PHOTO_MAX + 64 * 1024, 'Photo trop lourde : 5 Mo au plus.');
    const fichier = form.get('fichier');
    if (!estFichier(fichier)) throw new HttpError(400, 'Aucune photo reçue. Choisis la photo à nouveau.');
    res.status(201).json({ photo: await PhotoProfil.deposer(req.user!.id, new Uint8Array(await fichier.arrayBuffer())) });
  },
  options: async (_req: Request, res: Response) => {
    res.json(await AuthService.options());
  },
  register: async (req: Request, res: Response) => {
    res.status(201).json(await AuthService.register(req.body.email, req.body.password, req.body.nom, { confirmation: req.body.confirmation, telephone: req.body.telephone }));
  },
  login: async (req: Request, res: Response) => {
    res.json(await AuthService.login(qui(req), req.body.password));
  },
  verifier: async (req: Request, res: Response) => {
    res.json(await AuthService.verifier(req.body.jeton));
  },
  confirmerSms: async (req: Request, res: Response) => {
    res.json(await AuthService.confirmerSms(qui(req), req.body.code));
  },
  renvoyerCodeSms: async (req: Request, res: Response) => {
    res.json(await AuthService.renvoyerCodeSms(qui(req)));
  },
  renvoyerVerification: async (req: Request, res: Response) => {
    res.json(await AuthService.renvoyerVerification(qui(req)));
  },
  oubli: async (req: Request, res: Response) => {
    res.json(await AuthService.oubli(qui(req)));
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
  exporter: async (req: Request, res: Response) => {
    res.setHeader('Content-Disposition', 'attachment; filename="me-export.json"');
    res.json(await AuthService.exporter(req.user!.id));
  },
  deconnecterTout: async (req: Request, res: Response) => {
    res.json(await AuthService.deconnecterTout(req.user!.id));
  },
  supprimer: async (req: Request, res: Response) => {
    res.json(await AuthService.supprimer(req.user!.id, req.body.confirmation));
  },
};
