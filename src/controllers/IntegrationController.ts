import { randomBytes } from 'crypto';
import type { Request, Response } from 'express';

import { IntegrationService, lireState } from '../services/IntegrationService.js';

/** Renvoie vers l'app avec le résultat de la connexion. */
const versApp = (retour: string, params: Record<string, string>) => `${retour}${retour.includes('?') ? '&' : '?'}${new URLSearchParams(params)}`;

export const IntegrationController = {
  liste: async (req: Request, res: Response) => {
    res.json({ disponibles: IntegrationService.disponibles(), comptes: await IntegrationService.liste(req.user!.id) });
  },

  connecter: async (req: Request, res: Response) => {
    res.json({ url: IntegrationService.urlConnexion(req.user!.id, req.params.nom, String(req.query.retour || '')) });
  },

  /** Retour OAuth (Google, Microsoft, Slack) : le navigateur arrive ici, puis repart vers l'app. */
  callback: async (req: Request, res: Response) => {
    const { nom } = req.params;
    const state = String(req.query.state || '');
    let retour = 'me://sources';
    try {
      retour = lireState(state, nom).retour;
      if (req.query.error) throw new Error(String(req.query.error_description || 'Connexion annulée.'));
      await IntegrationService.terminer(nom, state, String(req.query.code || ''));
      res.redirect(versApp(retour, { connecte: nom }));
    } catch (e) {
      res.redirect(versApp(retour, { erreur: (e as Error).message }));
    }
  },

  /** Trello renvoie le jeton dans le fragment (#token=…), invisible du serveur : cette page le lit et le transmet. */
  trelloRetour: (_req: Request, res: Response) => {
    const nonce = randomBytes(16).toString('base64');
    res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; style-src 'unsafe-inline'`);
    res.type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Me</title>
<body style="background:#04080C;color:#E6F7FF;font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0"><p id="m">Connexion à Trello…</p>
<script nonce="${nonce}">
const token = new URLSearchParams(location.hash.slice(1)).get('token');
const state = new URLSearchParams(location.search).get('state');
fetch('jeton', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state, token }) })
  .then((r) => r.json()).then((r) => { location.replace(r.redirection); })
  .catch(() => { document.getElementById('m').textContent = 'La connexion a échoué. Retourne dans Me et réessaie.'; });
</script>`);
  },

  trelloJeton: async (req: Request, res: Response) => {
    const { state, token } = req.body as { state?: string; token?: string };
    let retour = 'me://sources';
    try {
      retour = lireState(String(state || ''), 'trello').retour;
      if (!token) throw new Error('Connexion annulée.');
      await IntegrationService.terminer('trello', String(state), token);
      res.json({ redirection: versApp(retour, { connecte: 'trello' }) });
    } catch (e) {
      res.json({ redirection: versApp(retour, { erreur: (e as Error).message }) });
    }
  },

  agendas: async (req: Request, res: Response) => {
    res.json(await IntegrationService.agendas(req.user!.id, req.params.id));
  },
  modifier: async (req: Request, res: Response) => {
    res.json({ integration: await IntegrationService.modifier(req.user!.id, req.params.id, req.body) });
  },

  repondre: async (req: Request, res: Response) => {
    res.json(await IntegrationService.repondre(req.user!.id, req.params.id, req.body.mail, req.body.texte));
  },
  lireMail: async (req: Request, res: Response) => {
    res.json(await IntegrationService.lireMail(req.user!.id, req.params.id, req.params.mail, req.query.lu === '0'));
  },
  dossiers: async (req: Request, res: Response) => {
    res.json(await IntegrationService.dossiers(req.user!.id, req.params.id, typeof req.query.boite === 'string' ? req.query.boite : undefined));
  },
  mailsDuDossier: async (req: Request, res: Response) => {
    const q = (k: string) => (typeof req.query[k] === 'string' ? (req.query[k] as string) : undefined);
    res.json(await IntegrationService.mailsDuDossier(req.user!.id, req.params.id, req.params.dossier, { boite: q('boite'), suivant: q('suivant') }));
  },
  mailDuFil: async (req: Request, res: Response) => {
    res.json(await IntegrationService.mailDuFil(req.user!.id, req.params.id, req.params.fil));
  },
  deplacer: async (req: Request, res: Response) => {
    await IntegrationService.deplacer(req.user!.id, req.params.id, req.params.mail, req.body);
    res.status(204).end();
  },
  regles: async (req: Request, res: Response) => {
    res.json(await IntegrationService.regles(req.user!.id, req.params.id));
  },
  activerRegle: async (req: Request, res: Response) => {
    res.json(await IntegrationService.activerRegle(req.user!.id, req.params.id, req.params.regle, req.body.active));
  },
  etiqueter: async (req: Request, res: Response) => {
    res.json(await IntegrationService.etiqueter(req.user!.id, req.params.id, req.params.mail, req.body));
  },
  envoyer: async (req: Request, res: Response) => {
    res.json(await IntegrationService.envoyer(req.user!.id, req.params.id, req.body));
  },
  creerEvenement: async (req: Request, res: Response) => {
    res.status(201).json(await IntegrationService.creerEvenement(req.user!.id, req.params.id, req.body));
  },
  modifierEvenement: async (req: Request, res: Response) => {
    res.json(await IntegrationService.modifierEvenement(req.user!.id, req.params.id, req.body));
  },
  supprimerEvenement: async (req: Request, res: Response) => {
    await IntegrationService.supprimerEvenement(req.user!.id, req.params.id, req.body);
    res.status(204).end();
  },
  listesTaches: async (req: Request, res: Response) => {
    res.json(await IntegrationService.listesTaches(req.user!.id, req.params.id));
  },
  creerTache: async (req: Request, res: Response) => {
    res.status(201).json(await IntegrationService.creerTache(req.user!.id, req.params.id, req.body));
  },
  majTache: async (req: Request, res: Response) => {
    await IntegrationService.majTache(req.user!.id, req.params.id, req.body);
    res.status(204).end();
  },

  supprimer: async (req: Request, res: Response) => {
    await IntegrationService.supprimer(req.user!.id, req.params.id);
    res.status(204).end();
  },

  elements: async (req: Request, res: Response) => {
    res.json(await IntegrationService.elements(req.user!.id));
  },

  synchroniser: async (req: Request, res: Response) => {
    await IntegrationService.synchroniserCompte(req.user!.id);
    res.json(await IntegrationService.elements(req.user!.id));
  },
};
