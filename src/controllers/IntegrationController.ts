import { randomBytes } from 'crypto';
import type { Request, Response } from 'express';

import { IntegrationService, lireState } from '../services/IntegrationService.js';
import { enTetesPiece, MAX_PIECES_OCTETS } from '../services/integrations/ecriture.js';
import { expliquerRefus } from '../services/integrations/erreurs.js';
import { lireFormulaire } from '../utils/formulaire.js';
import { HttpError } from '../utils/http.js';
import { envoyerMailSchema, repondreMailSchema } from '../validators/schemas.js';

/** Renvoie vers l'app avec le résultat de la connexion. */
const versApp = (retour: string, params: Record<string, string>) => `${retour}${retour.includes('?') ? '&' : '?'}${new URLSearchParams(params)}`;

/** Le résultat d'une vérification : un formulaire invalide est une erreur de saisie, pas une panne. */
function valider<T>(r: { success: true; data: T } | { success: false; error: { issues: { message: string }[] } }): T {
  if (!r.success) throw new HttpError(400, r.error.issues[0]?.message ?? 'Formulaire invalide.');
  return r.data;
}

async function formulaireMail(req: Request) {
  const form = await lireFormulaire(req, MAX_PIECES_OCTETS + 1024 * 1024, 'Pièces jointes trop lourdes : 20 Mo au plus par mail.');
  let donnees: unknown;
  try {
    donnees = JSON.parse(String(form.get('donnees')));
  } catch {
    throw new HttpError(400, 'Formulaire illisible.');
  }
  const fichiers = form.getAll('pieces').flatMap((x) => (x instanceof File ? [x] : []));
  const pieces = await Promise.all(fichiers.map(async (f) => ({ nom: f.name, type: f.type, octets: Buffer.from(await f.arrayBuffer()) })));
  return { donnees, pieces };
}

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
      if (req.query.error) throw new Error(expliquerRefus(`${req.query.error} ${req.query.error_description ?? ''}`) ?? String(req.query.error_description || 'Connexion annulée.'));
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
    res.json(await IntegrationService.repondre(req.user!.id, req.params.id, req.body.mail, req.body.texte, { a: req.body.a, cc: req.body.cc }, [], req.body.signature));
  },
  /** Répondre avec des fichiers : le formulaire porte `donnees` (le JSON habituel) et les fichiers dans `pieces`. */
  repondreAvecPieces: async (req: Request, res: Response) => {
    const { donnees, pieces } = await formulaireMail(req);
    const body = valider(repondreMailSchema.shape.body.safeParse(donnees));
    res.json(await IntegrationService.repondre(req.user!.id, req.params.id, body.mail, body.texte, { a: body.a, cc: body.cc }, pieces, body.signature));
  },
  envoyerAvecPieces: async (req: Request, res: Response) => {
    const { donnees, pieces } = await formulaireMail(req);
    res.json(await IntegrationService.envoyer(req.user!.id, req.params.id, valider(envoyerMailSchema.shape.body.safeParse(donnees)), pieces));
  },
  lienPiece: async (req: Request, res: Response) => {
    res.json(await IntegrationService.lienPiece(req.user!.id, req.params.id, req.params.mail, req.params.piece, typeof req.body?.message === 'string' ? req.body.message.slice(0, 500) : undefined));
  },
  /** Ouvert par un lien, sans en-tête d'authentification : le lien signé en tient lieu. */
  ouvrirPiece: async (req: Request, res: Response) => {
    const p = await IntegrationService.ouvrirPiece(String(req.query.j ?? ''));
    const en = enTetesPiece(p.nom, p.type);
    res.setHeader('Content-Type', en.type);
    res.setHeader('Content-Disposition', en.disposition);
    res.setHeader('Cache-Control', 'private, no-store');
    res.end(p.octets);
  },
  destinataires: async (req: Request, res: Response) => {
    res.json(await IntegrationService.destinataires(req.user!.id, req.params.id, req.params.mail));
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
  personnes: async (req: Request, res: Response) => {
    res.json(await IntegrationService.personnes(req.user!.id, String(req.query.q)));
  },
  chercherMails: async (req: Request, res: Response) => {
    const q = (k: string) => (typeof req.query[k] === 'string' && (req.query[k] as string).trim() ? (req.query[k] as string).trim() : undefined);
    res.json(await IntegrationService.chercherMails(req.user!.id, req.params.id, { de: q('de'), domaine: q('domaine'), dossier: q('dossier'), boite: q('boite'), depuis: q('depuis'), jusqua: q('jusqua'), nonLus: q('nonLus') === '1', pj: q('pj') === '1', objet: q('objet'), suivant: q('suivant'), max: q('max') ? Number(q('max')) : undefined }));
  },
  mailDuFil: async (req: Request, res: Response) => {
    res.json(await IntegrationService.mailDuFil(req.user!.id, req.params.id, req.params.fil));
  },
  trierMails: async (req: Request, res: Response) => {
    res.json(await IntegrationService.trierMails(req.user!.id, req.params.id, req.body.action, req.body.mails));
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

  nouveautes: async (req: Request, res: Response) => {
    res.json(await IntegrationService.nouveautes(req.user!.id));
  },
  signature: async (req: Request, res: Response) => {
    res.json(await IntegrationService.signatureDuCompte(req.user!.id, req.params.id));
  },

  synchroniser: async (req: Request, res: Response) => {
    await IntegrationService.synchroniserCompte(req.user!.id);
    res.json(await IntegrationService.elements(req.user!.id));
  },
};
