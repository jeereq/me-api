import type { Fournisseur, Integration, Prisma } from '@prisma/client';
import jwt from 'jsonwebtoken';

import { chiffrer, dechiffrer } from '../utils/crypto.js';
import { HttpError } from '../utils/http.js';
import { prisma } from '../utils/prisma.js';
import { google } from './integrations/google.js';
import { ErreurExterne, exiger } from './integrations/http.js';
import { microsoft } from './integrations/microsoft.js';
import { slackConnecteur } from './integrations/slack.js';
import { trello } from './integrations/trello.js';
import { vide, type Connecteur, type Ctx, type Elements, type Prefs, type SourceKey } from './integrations/types.js';

export const CONNECTEURS: Record<string, Connecteur> = { google, microsoft, trello, slack: slackConnecteur };
const parFournisseur = (f: Fournisseur) => Object.values(CONNECTEURS).find((c) => c.fournisseur === f)!;

export const connecteur = (nom: string) => {
  const c = CONNECTEURS[nom];
  if (!c) throw new HttpError(404, 'Service inconnu.');
  return c;
};

const publique = (i: Integration) => ({
  id: i.id,
  fournisseur: Object.entries(CONNECTEURS).find(([, c]) => c.fournisseur === i.fournisseur)![0],
  compte: i.compte,
  ctx: i.ctx as Ctx,
  derniereSync: i.derniereSync?.toISOString() ?? null,
  erreur: i.erreur,
});

/** Le paramètre `state` d'OAuth : signé, lié au compte me, valable 10 minutes. */
const signerState = (userId: string, fournisseur: string, retour: string) => jwt.sign({ userId, fournisseur, retour, typ: 'oauth' }, process.env.JWT_SECRET as string, { expiresIn: '10m' });
export function lireState(state: string, fournisseur: string) {
  try {
    const p = jwt.verify(state, process.env.JWT_SECRET as string) as { userId: string; fournisseur: string; retour: string; typ: string };
    if (p.typ !== 'oauth' || p.fournisseur !== fournisseur) throw new Error();
    return p;
  } catch {
    throw new HttpError(400, 'Lien de connexion expiré, recommence depuis l’app.');
  }
}

/** Seules les adresses de l'app sont acceptées comme retour, jamais un site quelconque. */
export function retourAutorise(retour: string) {
  const autorises = (process.env.APP_REDIRECT_URLS || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (/^(me|exp|exps):\/\//.test(retour) || autorises.some((a) => retour.startsWith(a))) return retour;
  return 'me://sources';
}

/** Réglages de l'écran Agendas & outils, lus dans l'espace de l'utilisateur. */
function lirePrefs(espace: unknown): (k: SourceKey) => Prefs {
  const sources = ((espace as { sources?: Record<string, { actif?: boolean; imports?: string[]; filtre?: string }> } | null)?.sources ?? {});
  return (k) => {
    const s = sources[k];
    // Source jamais réglée dans l'app : on importe tout ce qu'elle propose.
    if (!s) return { actif: true, imports: ['agenda', 'taches', 'relances'], filtre: [] };
    return { actif: s.actif !== false, imports: (s.imports ?? []) as Prefs['imports'], filtre: (s.filtre || '').split(',').map((x) => x.trim()).filter(Boolean) };
  };
}

async function jetonsValides(i: Integration) {
  const c = parFournisseur(i.fournisseur);
  const accessToken = dechiffrer(i.accessToken);
  const refreshToken = i.refreshToken ? dechiffrer(i.refreshToken) : null;
  if (!i.expiresAt || i.expiresAt.getTime() > Date.now() + 5 * 60 * 1000 || !refreshToken || !c.rafraichir) return { accessToken, refreshToken };
  const t = await c.rafraichir(refreshToken);
  await prisma.integration.update({
    where: { id: i.id },
    data: { accessToken: chiffrer(t.accessToken), refreshToken: t.refreshToken ? chiffrer(t.refreshToken) : i.refreshToken, expiresAt: t.expiresAt ?? null },
  });
  return t;
}

export const IntegrationService = {
  disponibles: () => Object.entries(CONNECTEURS).map(([nom, c]) => ({ nom, sources: c.sources, configure: c.configure() })),

  liste: async (userId: string) => (await prisma.integration.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } })).map(publique),

  /** `retour` : adresse de l'app où revenir après la connexion (me://…, ou exp://… dans Expo Go). */
  urlConnexion(userId: string, nom: string, retour: string) {
    const c = connecteur(nom);
    exiger(c.configure(), c.nom);
    return c.urlAutorisation(signerState(userId, nom, retourAutorise(retour)));
  },

  /** Termine la connexion (code OAuth, ou jeton pour Trello), enregistre le compte et lance un premier import. */
  async terminer(nom: string, state: string, code: string) {
    const c = connecteur(nom);
    const { userId } = lireState(state, nom);
    let r;
    try {
      r = await c.echanger(code);
    } catch (e) {
      throw new HttpError(502, e instanceof ErreurExterne ? e.message : `${c.nom} n'a pas accepté la connexion.`);
    }
    const data = { accessToken: chiffrer(r.accessToken), refreshToken: r.refreshToken ? chiffrer(r.refreshToken) : null, expiresAt: r.expiresAt ?? null, erreur: null };
    const i = await prisma.integration.upsert({
      where: { userId_fournisseur_compte: { userId, fournisseur: c.fournisseur, compte: r.compte } },
      create: { userId, fournisseur: c.fournisseur, compte: r.compte, ctx: c.ctx, ...data },
      update: data,
    });
    await this.synchroniserUne(i.id).catch(() => {});
    return publique(i);
  },

  async modifier(userId: string, id: string, ctx: Ctx) {
    const { count } = await prisma.integration.updateMany({ where: { id, userId }, data: { ctx } });
    if (!count) throw new HttpError(404, 'Compte connecté introuvable.');
  },

  async supprimer(userId: string, id: string) {
    const { count } = await prisma.integration.deleteMany({ where: { id, userId } });
    if (!count) throw new HttpError(404, 'Compte connecté introuvable.');
  },

  /** Importe les éléments d'un compte connecté et les garde ; l'erreur éventuelle reste visible dans l'app. */
  async synchroniserUne(id: string) {
    const i = await prisma.integration.findUniqueOrThrow({ where: { id }, include: { user: { select: { fuseau: true, espace: { select: { data: true } } } } } });
    const cfg = (await prisma.config.findUnique({ where: { id: 1 } }))?.data as { delaiRelanceJours?: number } | undefined;
    try {
      const jetons = await jetonsValides(i);
      const donnees = await parFournisseur(i.fournisseur).importer({
        jetons,
        fuseau: i.user.fuseau,
        delaiRelance: Math.max(1, Number(cfg?.delaiRelanceJours) || 3),
        prefs: lirePrefs(i.user.espace?.data),
      });
      await prisma.integration.update({ where: { id }, data: { donnees: donnees as unknown as Prisma.InputJsonObject, derniereSync: new Date(), erreur: null } });
    } catch (e) {
      const message = e instanceof ErreurExterne ? (e.auth ? 'Accès refusé : reconnecte ce compte.' : e.message) : 'Synchronisation impossible pour l’instant.';
      if (!(e instanceof ErreurExterne)) console.error('Synchro', i.fournisseur, e);
      await prisma.integration.update({ where: { id }, data: { erreur: message } });
    }
  },

  async synchroniserCompte(userId: string) {
    const ids = await prisma.integration.findMany({ where: { userId }, select: { id: true } });
    for (const { id } of ids) await this.synchroniserUne(id);
  },

  async synchroniserTout() {
    const ids = await prisma.integration.findMany({ select: { id: true } });
    for (const { id } of ids) await this.synchroniserUne(id);
  },

  /** Tous les éléments importés du compte, chacun avec son contexte et un identifiant stable. */
  async elements(userId: string) {
    const rows = await prisma.integration.findMany({ where: { userId } });
    const out = { ...vide(), integrations: rows.map(publique) } as Elements & { integrations: ReturnType<typeof publique>[] };
    for (const r of rows) {
      const d = (r.donnees ?? vide()) as unknown as Elements;
      const ext = (x: { id: string }) => `ext:${r.id}:${x.id}`;
      out.agenda.push(...d.agenda.map((x) => ({ ...x, id: ext(x), ctx: r.ctx })));
      out.taches.push(...d.taches.map((x) => ({ ...x, id: ext(x), ctx: r.ctx })));
      out.relances.push(...d.relances.map((x) => ({ ...x, id: ext(x), ctx: r.ctx })));
    }
    return out;
  },
};
