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

  modifier: async (req: Request, res: Response) => {
    await IntegrationService.modifier(req.user!.id, req.params.id, req.body.ctx);
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
