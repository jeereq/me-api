import type { Fournisseur, Integration, Prisma } from '@prisma/client';
import jwt from 'jsonwebtoken';

import { chiffrer, dechiffrer } from '../utils/crypto.js';
import { HttpError } from '../utils/http.js';
import { prisma } from '../utils/prisma.js';
import { choixValides, type MailImporte } from './integrations/choix.js';
import { adresses, ErreurSaisie } from './integrations/ecriture.js';
import { google } from './integrations/google.js';
import { ErreurExterne, exiger } from './integrations/http.js';
import { microsoft } from './integrations/microsoft.js';
import { slackConnecteur } from './integrations/slack.js';
import { trello } from './integrations/trello.js';
import { vide, type Connecteur, type Ctx, type EcritureEvenement, type Elements, type Prefs, type PrefsCompte, type SourceKey } from './integrations/types.js';
import { etatAbonnement } from './abonnements/offres.js';

export const CONNECTEURS: Record<string, Connecteur> = { google, microsoft, trello, slack: slackConnecteur };
const parFournisseur = (f: Fournisseur) => Object.values(CONNECTEURS).find((c) => c.fournisseur === f)!;

export const connecteur = (nom: string) => {
  const c = CONNECTEURS[nom];
  if (!c) throw new HttpError(404, 'Service inconnu.');
  return c;
};

const prefsCompte = (i: Integration): PrefsCompte => {
  const p = i.prefs as { agendas?: unknown } | null;
  return { agendas: Array.isArray(p?.agendas) ? p.agendas.filter((x): x is string => typeof x === 'string') : undefined };
};

const publique = (i: Integration) => ({
  id: i.id,
  fournisseur: Object.entries(CONNECTEURS).find(([, c]) => c.fournisseur === i.fournisseur)![0],
  compte: i.compte,
  ctx: i.ctx as Ctx,
  derniereSync: i.derniereSync?.toISOString() ?? null,
  erreur: i.erreur,
  /** Agendas cochés pour ce compte ; vide = ceux que le service affiche par défaut. */
  agendas: prefsCompte(i).agendas ?? [],
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

  /** Change le contexte (perso/pro) et/ou les agendas synchronisés, puis relit le compte. */
  async modifier(userId: string, id: string, patch: { ctx?: Ctx; agendas?: string[] }) {
    const i = await prisma.integration.findFirst({ where: { id, userId } });
    if (!i) throw new HttpError(404, 'Compte connecté introuvable.');
    const data: Prisma.IntegrationUpdateInput = {};
    if (patch.ctx) data.ctx = patch.ctx;
    if (patch.agendas) data.prefs = { ...(prefsCompte(i) as object), agendas: [...new Set(patch.agendas)].slice(0, 50) } as Prisma.InputJsonObject;
    await prisma.integration.update({ where: { id }, data });
    // Les agendas choisis ne changent rien tant que le compte n'a pas été relu.
    if (patch.agendas) await this.synchroniserUne(id).catch(() => {});
    return publique(await prisma.integration.findUniqueOrThrow({ where: { id } }));
  },

  /** Les agendas du compte, avec ceux qui sont cochés : de quoi régler la synchronisation dans l'app. */
  async agendas(userId: string, id: string) {
    const i = await prisma.integration.findFirst({ where: { id, userId } });
    if (!i) throw new HttpError(404, 'Compte connecté introuvable.');
    const c = parFournisseur(i.fournisseur);
    if (!c.agendas) throw new HttpError(400, `${c.nom} n'a pas d'agenda à choisir.`);
    try {
      const dispo = await c.agendas(await jetonsValides(i));
      return { agendas: dispo, choisis: choixValides(dispo, prefsCompte(i).agendas) };
    } catch (e) {
      throw new HttpError(502, e instanceof ErreurExterne ? e.message : `${c.nom} n'a pas renvoyé la liste des agendas.`);
    }
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
        agendas: prefsCompte(i).agendas ?? [],
      });
      await prisma.integration.update({ where: { id }, data: { donnees: donnees as unknown as Prisma.InputJsonObject, derniereSync: new Date(), erreur: null } });
    } catch (e) {
      const message = e instanceof ErreurExterne ? e.message : 'Synchronisation impossible pour l’instant.';
      if (!(e instanceof ErreurExterne)) console.error('Synchro', i.fournisseur, e);
      await prisma.integration.update({ where: { id }, data: { erreur: message } });
    }
  },

  async synchroniserCompte(userId: string) {
    const ids = await prisma.integration.findMany({ where: { userId }, select: { id: true } });
    for (const { id } of ids) await this.synchroniserUne(id);
  },

  async synchroniserTout() {
    const liste = await prisma.integration.findMany({
      select: { id: true, user: { select: { role: true, essaiJusqua: true, abonnementPeriode: true, abonnementFinLe: true } } },
    });
    // Les comptes connectés font partie de Pro : sans abonnement (ni essai), ils ne sont plus relus.
    for (const { id, user } of liste) if (etatAbonnement(user).pro) await this.synchroniserUne(id);
  },

  /* ---------- Écrire dans le compte ---------- */

  /** Le compte, son connecteur et ses jetons, avec un message clair si le service ne sait pas faire. */
  async _pourEcrire(userId: string, id: string, quoi: keyof Connecteur) {
    const i = await prisma.integration.findFirst({ where: { id, userId }, include: { user: { select: { fuseau: true } } } });
    if (!i) throw new HttpError(404, 'Compte connecté introuvable.');
    const c = parFournisseur(i.fournisseur);
    if (typeof c[quoi] !== 'function') throw new HttpError(400, `${c.nom} ne permet pas cette action depuis Me.`);
    return { i, c, jetons: await jetonsValides(i), fuseau: i.user.fuseau };
  },

  /** Transforme l'erreur d'un service externe en message lisible (et dit quand il faut reconnecter le compte). */
  async _ecrire<T>(fn: () => Promise<T>, i: { id: string }, relire = true): Promise<T> {
    try {
      const r = await fn();
      // Le compte est relu pour que l'app voie tout de suite le rendez-vous ou la tâche.
      if (relire) await this.synchroniserUne(i.id).catch(() => {});
      return r;
    } catch (e) {
      if (e instanceof ErreurSaisie) throw new HttpError(400, e.message);
      if (e instanceof ErreurExterne) throw new HttpError(e.auth ? 403 : 502, e.message);
      console.error('Écriture', e);
      throw new HttpError(502, "L'action n'a pas pu être faite, réessaie dans un moment.");
    }
  },

  /** Envoie une réponse dans le fil d'un mail importé. Le contact et l'objet viennent du message gardé. */
  async repondre(userId: string, id: string, mailId: string, texte: string) {
    const { i, c, jetons } = await this._pourEcrire(userId, id, 'repondre');
    const m = (((i.donnees ?? vide()) as unknown as Elements).mails ?? []).find((x) => x.id === mailId) as MailImporte | undefined;
    if (!m) throw new HttpError(404, "Ce mail n'est plus dans les messages relus ; actualise la boîte et réessaie.");
    // Relire le compte après un envoi ne sert à rien : la réponse part dans les messages envoyés, pas dans la réception.
    return this._ecrire(() => c.repondre!(jetons, { mailId: m.id, fil: m.fil, a: m.adresse || m.contact, sujet: m.sujet, texte, messageId: m.messageId, references: m.references }), i, false);
  },

  /** Lit un mail en entier, sans le garder : seul l'état « lu » est noté dans les messages relus. */
  async lireMail(userId: string, id: string, mailId: string) {
    const { i, c, jetons, fuseau } = await this._pourEcrire(userId, id, 'lireMail');
    const contenu = await this._ecrire(() => c.lireMail!(jetons, mailId, fuseau), i, false);
    const d = (i.donnees ?? null) as unknown as Elements | null;
    if (d?.mails?.some((m) => m.id === mailId && m.nonLu)) {
      const mails = d.mails.map((m) => (m.id === mailId ? { ...m, nonLu: false } : m));
      await prisma.integration.update({ where: { id: i.id }, data: { donnees: { ...d, mails } as unknown as Prisma.InputJsonObject } }).catch(() => {});
    }
    return { mail: contenu };
  },

  /** Écrit un nouveau mail depuis le compte : destinataires séparés par des virgules. */
  async envoyer(userId: string, id: string, m: { a: string; cc?: string; sujet?: string; texte: string }) {
    const { i, c, jetons } = await this._pourEcrire(userId, id, 'envoyer');
    return this._ecrire(() => c.envoyer!(jetons, { a: adresses(m.a), cc: adresses(m.cc), sujet: m.sujet ?? '', texte: m.texte }), i, false);
  },

  async creerEvenement(userId: string, id: string, e: Omit<EcritureEvenement, 'fuseau'>) {
    const { i, c, jetons, fuseau } = await this._pourEcrire(userId, id, 'creerEvenement');
    return this._ecrire(() => c.creerEvenement!(jetons, { ...e, fuseau }), i);
  },

  async modifierEvenement(userId: string, id: string, e: Omit<EcritureEvenement, 'fuseau'> & { id: string }) {
    const { i, c, jetons, fuseau } = await this._pourEcrire(userId, id, 'modifierEvenement');
    return this._ecrire(() => c.modifierEvenement!(jetons, { ...e, fuseau }), i);
  },

  async supprimerEvenement(userId: string, id: string, e: { agendaId: string; id: string }) {
    const { i, c, jetons } = await this._pourEcrire(userId, id, 'supprimerEvenement');
    await this._ecrire(() => c.supprimerEvenement!(jetons, e), i);
  },

  /** Listes de tâches du compte (Google Tasks, Microsoft To Do), pour choisir où envoyer une tâche. */
  async listesTaches(userId: string, id: string) {
    const { i, c, jetons } = await this._pourEcrire(userId, id, 'listesTaches');
    return { listes: await this._ecrire(() => c.listesTaches!(jetons), i, false) };
  },

  async creerTache(userId: string, id: string, t: { listeId: string; titre: string; echeance?: string | null }) {
    const { i, c, jetons } = await this._pourEcrire(userId, id, 'creerTache');
    return this._ecrire(() => c.creerTache!(jetons, t), i);
  },

  async majTache(userId: string, id: string, t: { listeId: string; id: string; titre: string; echeance?: string | null; fait?: boolean }) {
    const { i, c, jetons } = await this._pourEcrire(userId, id, 'majTache');
    await this._ecrire(() => c.majTache!(jetons, t), i);
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
      out.mails.push(...(d.mails ?? []).map((x) => ({ ...x, id: ext(x), ctx: r.ctx, compte: r.compte })));
    }
    return out;
  },
};
