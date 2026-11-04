import type { Fournisseur, Integration, Prisma } from '@prisma/client';
import jwt from 'jsonwebtoken';

import { chiffrer, dechiffrer } from '../utils/crypto.js';
import { HttpError } from '../utils/http.js';
import { jsonPropre } from '../utils/json.js';
import { prisma } from '../utils/prisma.js';
import { boitesValides, chargementValide, choixValides, mailsAAnnoncer, mailsApresTri, type MailImporte } from './integrations/choix.js';
import { NotificationService } from './NotificationService.js';
import { adresses, avecSignature, ErreurSaisie, signatureChoisie, signaturesValides, type PieceAJoindre, type SignatureMail } from './integrations/ecriture.js';
import { google } from './integrations/google.js';
import { ACCES_RETIRE } from './integrations/erreurs.js';
import { ErreurExterne, exiger, local } from './integrations/http.js';
import { microsoft } from './integrations/microsoft.js';
import { slackConnecteur } from './integrations/slack.js';
import { trello } from './integrations/trello.js';
import { CHARGEMENT_DEFAUT, vide, type Connecteur, type Ctx, type EcritureEvenement, type Elements, type Prefs, type PrefsCompte, type SourceKey } from './integrations/types.js';
import { etatAbonnement } from './abonnements/offres.js';

export const CONNECTEURS: Record<string, Connecteur> = { google, microsoft, trello, slack: slackConnecteur };
const parFournisseur = (f: Fournisseur) => Object.values(CONNECTEURS).find((c) => c.fournisseur === f)!;

export const connecteur = (nom: string) => {
  const c = CONNECTEURS[nom];
  if (!c) throw new HttpError(404, 'Service inconnu.');
  return c;
};

/** Une vérification par compte, au plus, sur cet intervalle : plusieurs appareils ouverts ne multiplient pas les appels au service. */
const INTERVALLE_VERIFICATION = 25_000;
/** Un mail arrivé juste avant la dernière relecture a pu lui échapper. */
const MARGE_ANNONCE = 10 * 60 * 1000;
const verifications = new Map<string, number>();

const textes = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined);
const prefsCompte = (i: Integration): PrefsCompte => {
  const p = i.prefs as { agendas?: unknown; boitesPartagees?: unknown; mails?: { jours?: unknown; max?: unknown }; analyseAuto?: unknown; signatures?: unknown; signatureDefaut?: unknown } | null;
  const signatures = signaturesValides(p?.signatures);
  return { agendas: textes(p?.agendas), boitesPartagees: textes(p?.boitesPartagees), mails: chargementValide(p?.mails), analyseAuto: p?.analyseAuto === true, signatures, signatureDefaut: signatures.some((x) => x.id === p?.signatureDefaut) ? (p?.signatureDefaut as string) : null };
};
const donneesDe = (i: Integration) => (i.donnees ?? vide()) as unknown as Elements;

const signe = (i: Integration, texte: string, choix?: string | null) => avecSignature(texte, signatureChoisie(prefsCompte(i), choix));

const publique = (i: Integration) => ({
  id: i.id,
  fournisseur: Object.entries(CONNECTEURS).find(([, c]) => c.fournisseur === i.fournisseur)![0],
  compte: i.compte,
  ctx: i.ctx as Ctx,
  derniereSync: i.derniereSync?.toISOString() ?? null,
  erreur: i.erreur,
  /** Agendas cochés pour ce compte ; vide = ceux que le service affiche par défaut. */
  agendas: prefsCompte(i).agendas ?? [],
  /** Le service sait lire des boîtes partagées avec ce compte (Microsoft 365). */
  partageables: !!parFournisseur(i.fournisseur).boitesPartagees,
  /** Boîtes partagées demandées, avec l'erreur de la dernière lecture s'il y en a eu une. */
  boites: (prefsCompte(i).boitesPartagees ?? []).map((adresse) => {
    const erreur = donneesDe(i).boites?.find((b) => b.adresse === adresse)?.erreur;
    return erreur ? { adresse, erreur } : { adresse };
  }),
  /** Étiquettes qu'on peut poser sur un mail de ce compte. */
  libelles: donneesDe(i).libelles ?? [],
  /** Comment la boîte de réception se charge (jours, nombre de fils). */
  chargement: prefsCompte(i).mails,
  /** Le copilote prépare à l'avance l'analyse des nouveaux mails non lus de ce compte (choisi par l'utilisateur, désactivé par défaut). */
  analyseAuto: prefsCompte(i).analyseAuto === true,
  /** Les signatures de ce compte, celle par défaut, et si le service permet d'en reprendre une. */
  signatures: prefsCompte(i).signatures ?? [],
  signatureDefaut: prefsCompte(i).signatureDefaut ?? null,
  signatureImportable: !!parFournisseur(i.fournisseur).signature,
  /** Ce que le service sait faire de plus avec la boîte : dossiers, règles. */
  dossiers: !!parFournisseur(i.fournisseur).dossiers,
  regles: !!parFournisseur(i.fournisseur).regles,
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
  const t = await c.rafraichir(refreshToken).catch(async (e: unknown) => {
    // Un accès retiré ne revient pas tout seul : le compte le dit, et on ne redemande rien au service avant qu'il soit reconnecté.
    if (e instanceof ErreurExterne && e.message === ACCES_RETIRE) await prisma.integration.update({ where: { id: i.id }, data: { erreur: ACCES_RETIRE } });
    throw e;
  });
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

  /** Change le contexte (perso/pro), les agendas synchronisés et/ou les boîtes partagées lues, puis relit le compte. */
  async modifier(userId: string, id: string, patch: { ctx?: Ctx; agendas?: string[]; boitesPartagees?: string[]; chargement?: { jours?: number; max?: number }; analyseAuto?: boolean; signatures?: SignatureMail[]; signatureDefaut?: string | null }) {
    const i = await prisma.integration.findFirst({ where: { id, userId } });
    if (!i) throw new HttpError(404, 'Compte connecté introuvable.');
    if (patch.boitesPartagees?.length && !parFournisseur(i.fournisseur).boitesPartagees)
      throw new HttpError(400, 'Gmail ne donne pas accès aux boîtes partagées : connecte cette boîte comme un compte Google de plus, elle apparaîtra avec les autres.');
    const data: Prisma.IntegrationUpdateInput = {};
    if (patch.ctx) data.ctx = patch.ctx;
    const prefs = { ...prefsCompte(i) };
    if (patch.agendas) prefs.agendas = [...new Set(patch.agendas)].slice(0, 50);
    if (patch.boitesPartagees) prefs.boitesPartagees = boitesValides(patch.boitesPartagees).filter((b) => b !== i.compte.toLowerCase());
    if (patch.chargement) prefs.mails = chargementValide({ ...prefs.mails, ...patch.chargement });
    if (patch.analyseAuto !== undefined) prefs.analyseAuto = patch.analyseAuto;
    if (patch.signatures) prefs.signatures = signaturesValides(patch.signatures);
    if (patch.signatureDefaut !== undefined) prefs.signatureDefaut = patch.signatureDefaut;
    if (!prefs.signatures?.some((x) => x.id === prefs.signatureDefaut)) prefs.signatureDefaut = null;
    const relire = !!(patch.agendas || patch.boitesPartagees || patch.chargement);
    // Choisir d'analyser à l'avance ou ses signatures n'a pas besoin de relire le compte.
    if (relire || patch.analyseAuto !== undefined || patch.signatures || patch.signatureDefaut !== undefined) data.prefs = prefs as Prisma.InputJsonObject;
    await prisma.integration.update({ where: { id }, data });
    // Les agendas, les boîtes et le chargement choisis ne changent rien tant que le compte n'a pas été relu.
    if (relire) await this.synchroniserUne(id).catch(() => {});
    return publique(await prisma.integration.findUniqueOrThrow({ where: { id } }));
  },

  /** La signature déjà utilisée sur ce compte, à reprendre dans Me. */
  async signatureDuCompte(userId: string, id: string) {
    const { i, c, jetons } = await this._pourEcrire(userId, id, 'signature');
    const texte = await this._ecrire(() => c.signature!(jetons), i, false);
    if (!texte.trim()) throw new HttpError(404, `Aucune signature trouvée sur ce compte ${c.nom}. Écris-la ici.`);
    return { texte: texte.trim().slice(0, 2000) };
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
  async synchroniserUne(id: string, o: { empreinte?: string; annoncer?: boolean } = {}) {
    const i = await prisma.integration.findUniqueOrThrow({ where: { id }, include: { user: { select: { id: true, fuseau: true, espace: { select: { data: true } } } } } });
    if (i.erreur === ACCES_RETIRE) return;
    const cfg = (await prisma.config.findUnique({ where: { id: 1 } }))?.data as { delaiRelanceJours?: number } | undefined;
    try {
      const jetons = await jetonsValides(i);
      const donnees = await parFournisseur(i.fournisseur).importer({
        jetons,
        fuseau: i.user.fuseau,
        delaiRelance: Math.max(1, Number(cfg?.delaiRelanceJours) || 3),
        prefs: lirePrefs(i.user.espace?.data),
        agendas: prefsCompte(i).agendas ?? [],
        boitesPartagees: prefsCompte(i).boitesPartagees ?? [],
        chargement: prefsCompte(i).mails ?? CHARGEMENT_DEFAUT,
      });
      // Les mails vus dans les dossiers restent : ils ne viennent pas de cet import.
      const vus = donneesDe(i).vus;
      const repere = o.empreinte ?? donneesDe(i).empreinte;
      await prisma.integration.update({ where: { id }, data: { donnees: jsonPropre({ ...donnees, ...(vus?.length ? { vus } : {}), ...(repere ? { empreinte: repere } : {}) }) as unknown as Prisma.InputJsonObject, derniereSync: new Date(), erreur: null } });
      // Un compte qui vient d'être connecté n'a rien de nouveau : tout y serait annoncé. Une panne de notification ne casse pas la relecture.
      if (o.annoncer && i.derniereSync) {
        const d = local(new Date(i.derniereSync.getTime() - MARGE_ANNONCE), i.user.fuseau);
        await NotificationService.nouveauxMails({ id: i.user.id, fuseau: i.user.fuseau, espace: i.user.espace }, i.id, mailsAAnnoncer(donneesDe(i).mails ?? [], donnees.mails ?? [], `${d.date}T${d.heure}`)).catch((e) => console.error('Annonce des mails', e));
      }
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

  /** Relit le compte si sa boîte a changé. Une panne ne remonte pas : la synchro planifiée dira l'erreur s'il y en a une. */
  async _verifierUne(i: Integration, annoncer = false) {
    const c = parFournisseur(i.fournisseur);
    if (!c.empreinte) return;
    const depuis = verifications.get(i.id) ?? 0;
    if (Date.now() - depuis < INTERVALLE_VERIFICATION) return;
    verifications.set(i.id, Date.now());
    if (i.erreur === ACCES_RETIRE) return;
    try {
      const e = await c.empreinte(await jetonsValides(i), { boitesPartagees: prefsCompte(i).boitesPartagees ?? [] });
      if (e && e !== donneesDe(i).empreinte) await this.synchroniserUne(i.id, { empreinte: e, annoncer });
    } catch (err) {
      if (!(err instanceof ErreurExterne)) console.error('Vérification', i.fournisseur, err);
    }
  },

  /** Ce que l'app demande souvent, tant qu'elle est ouverte : un repère de la boîte, relue seulement s'il a changé. `version` change quand il y a du neuf à relire. */
  async nouveautes(userId: string) {
    const avant = await prisma.integration.findMany({ where: { userId } });
    await Promise.all(avant.map((i) => this._verifierUne(i)));
    const apres = await prisma.integration.findMany({ where: { userId }, select: { derniereSync: true } });
    const dates = apres.flatMap((i) => (i.derniereSync ? [i.derniereSync.getTime()] : []));
    return { version: dates.length ? String(Math.max(...dates)) : null };
  },

  /** App fermée : regarde chaque boîte Pro et prévient de ce qui arrive. L'app ouverte fait ce travail elle-même et affiche le mail : pas besoin de notification en plus. */
  async verifierTout() {
    const liste = await prisma.integration.findMany({ include: { user: { select: { role: true, essaiJusqua: true, abonnementFormule: true, abonnementPeriode: true, abonnementFinLe: true, espace: { select: { data: true } } } } } });
    for (const i of liste) {
      const notifs = (i.user.espace?.data as { notifs?: { mails?: boolean } } | null | undefined)?.notifs;
      if (notifs?.mails !== false && etatAbonnement(i.user).pro) await this._verifierUne(i, true);
    }
  },

  async synchroniserTout() {
    const liste = await prisma.integration.findMany({
      select: { id: true, user: { select: { role: true, essaiJusqua: true, abonnementFormule: true, abonnementPeriode: true, abonnementFinLe: true } } },
    });
    // Les comptes connectés font partie de Pro : sans abonnement (ni essai), ils ne sont plus relus.
    // Un compte en échec ne doit pas empêcher la lecture des suivants.
    for (const { id, user } of liste) {
      if (etatAbonnement(user).pro) await this.synchroniserUne(id, { annoncer: true }).catch((e) => console.error('Synchro', id, e));
    }
  },

  /* ---------- Écrire dans le compte ---------- */

  /** Le compte, son connecteur et ses jetons, avec un message clair si le service ne sait pas faire. */
  async _pourEcrire(userId: string, id: string, quoi: keyof Connecteur) {
    const i = await prisma.integration.findFirst({ where: { id, userId }, include: { user: { select: { fuseau: true } } } });
    if (!i) throw new HttpError(404, 'Compte connecté introuvable.');
    const c = parFournisseur(i.fournisseur);
    if (typeof c[quoi] !== 'function') throw new HttpError(400, `${c.nom} ne permet pas cette action depuis Me.`);
    if (i.erreur === ACCES_RETIRE) throw new HttpError(403, ACCES_RETIRE);
    const jetons = await jetonsValides(i).catch((e: unknown) => {
      throw e instanceof ErreurExterne ? new HttpError(e.auth ? 403 : 502, e.message) : e;
    });
    return { i, c, jetons, fuseau: i.user.fuseau };
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

  /** Un mail gardé dans les messages relus du compte (objet, contact, fil, boîte). */
  _mailGarde(i: Integration, mailId: string) {
    const d = donneesDe(i);
    return [...(d.mails ?? []), ...(d.vus ?? [])].find((x) => x.id === mailId) as MailImporte | undefined;
  },

  /** Les dossiers de la boîte (la sienne ou une partagée lue avec le compte). */
  async dossiers(userId: string, id: string, boite?: string) {
    const { i, c, jetons } = await this._pourEcrire(userId, id, 'dossiers');
    if (boite && !(prefsCompte(i).boitesPartagees ?? []).includes(boite)) throw new HttpError(400, 'Ajoute d’abord cette boîte partagée dans Agendas & outils.');
    return { dossiers: await this._ecrire(() => c.dossiers!(jetons, boite), i, false) };
  },

  /**
   * Une page de mails d'un dossier, lue à la demande. Comme pour la réception, seuls l'objet, le contact, la date
   * et l'extrait sont gardés (les 200 derniers vus), pour pouvoir lire ou répondre à ces mails ensuite.
   */
  async mailsDuDossier(userId: string, id: string, dossier: string, o: { boite?: string; suivant?: string }) {
    const { i, c, jetons, fuseau } = await this._pourEcrire(userId, id, 'mailsDuDossier');
    if (o.boite && !(prefsCompte(i).boitesPartagees ?? []).includes(o.boite)) throw new HttpError(400, 'Ajoute d’abord cette boîte partagée dans Agendas & outils.');
    const max = prefsCompte(i).mails?.max ?? CHARGEMENT_DEFAUT.max;
    const page = await this._ecrire(() => c.mailsDuDossier!(jetons, { dossier, boite: o.boite, suivant: o.suivant, max, fuseau }), i, false);
    const d = donneesDe(i);
    const neufs = new Set(page.mails.map((m) => m.id));
    const vus = [...page.mails, ...(d.vus ?? []).filter((m) => !neufs.has(m.id))].slice(0, 200);
    await prisma.integration.update({ where: { id: i.id }, data: { donnees: jsonPropre({ ...d, vus }) as unknown as Prisma.InputJsonObject } }).catch(() => {});
    return { mails: page.mails.map((m) => ({ ...m, id: `ext:${i.id}:${m.id}`, ctx: i.ctx, compte: i.compte })), suivant: page.suivant ?? null };
  },

  /**
   * Les mails d'une personne, d'un domaine, d'un dossier ou d'une boîte partagée, sur une période : le lot que le copilote
   * analyse d'un coup. Gardés avec les mails vus (200 au plus), pour pouvoir les lire et y répondre ensuite.
   */
  async chercherMails(userId: string, id: string, r: { de?: string; domaine?: string; dossier?: string; boite?: string; depuis?: string; jusqua?: string; nonLus?: boolean; pj?: boolean; objet?: string; suivant?: string; max?: number }) {
    const { i, c, jetons, fuseau } = await this._pourEcrire(userId, id, 'chercherMails');
    if (r.boite && !(prefsCompte(i).boitesPartagees ?? []).includes(r.boite)) throw new HttpError(400, 'Ajoute d’abord cette boîte partagée dans Agendas & outils.');
    const page = await this._ecrire(() => c.chercherMails!(jetons, { ...r, max: Math.min(100, r.max ?? 50), fuseau }), i, false);
    const d = donneesDe(i);
    const neufs = new Set(page.mails.map((m) => m.id));
    const vus = [...page.mails, ...(d.vus ?? []).filter((m) => !neufs.has(m.id))].slice(0, 200);
    await prisma.integration.update({ where: { id: i.id }, data: { donnees: jsonPropre({ ...d, vus }) as unknown as Prisma.InputJsonObject } }).catch(() => {});
    return { mails: page.mails.map((m) => ({ ...m, id: `ext:${i.id}:${m.id}`, ctx: i.ctx, compte: i.compte })), suivant: page.suivant ?? null };
  },

  /** Range un mail dans un autre dossier, puis relit le compte pour que la réception suive. */
  async deplacer(userId: string, id: string, mailId: string, d: { dossier: string; depuis?: string }) {
    const { i, c, jetons } = await this._pourEcrire(userId, id, 'deplacer');
    const garde = this._mailGarde(i, mailId);
    await this._ecrire(() => c.deplacer!(jetons, { mailId, fil: garde?.fil, boite: garde?.boite, dossier: d.dossier, depuis: d.depuis ?? garde?.dossier ?? (i.fournisseur === 'GOOGLE' ? 'INBOX' : undefined) }), i);
  },

  /** Marque comme lus ou archive plusieurs mails : l'échec de l'un n'arrête pas les suivants, et l'app sait lesquels sont passés. */
  async trierMails(userId: string, id: string, action: 'lu' | 'archiver', mailIds: string[]) {
    const { i, c, jetons } = await this._pourEcrire(userId, id, action === 'lu' ? 'marquerLu' : 'archiver');
    const faits: string[] = [];
    const echecs: { id: string; message: string }[] = [];
    const file = [...new Set(mailIds)];
    const suivant = async () => {
      for (let mailId = file.shift(); mailId; mailId = file.shift()) {
        const garde = this._mailGarde(i, mailId);
        const m = { mailId, fil: garde?.fil, boite: garde?.boite };
        try {
          await this._ecrire(() => (action === 'lu' ? c.marquerLu!(jetons, m) : c.archiver!(jetons, m)), i, false);
          faits.push(mailId);
        } catch (e) {
          echecs.push({ id: mailId, message: (e as Error).message });
        }
      }
    };
    // Quelques-uns à la fois : Graph et Gmail limitent les appels par boîte.
    await Promise.all(Array.from({ length: 4 }, suivant));
    if (faits.length) {
      const d = donneesDe(i);
      await prisma.integration
        .update({ where: { id: i.id }, data: { donnees: jsonPropre({ ...d, mails: mailsApresTri(d.mails ?? [], faits, action), ...(d.vus ? { vus: mailsApresTri(d.vus, faits, 'lu') } : {}) }) as unknown as Prisma.InputJsonObject } })
        .catch(() => {});
    }
    return { faits, echecs };
  },

  /**
   * Le mail d'origine d'une relance ou d'une tâche, lu par son fil même s'il n'est plus dans la réception relue
   * (un mail envoyé qui attend sa réponse, un mail rangé). Il est gardé avec les mails vus pour le lire et y répondre.
   */
  async mailDuFil(userId: string, id: string, fil: string) {
    const { i, c, jetons, fuseau } = await this._pourEcrire(userId, id, 'mailDuFil');
    const m = await this._ecrire(() => c.mailDuFil!(jetons, { fil, fuseau, moi: i.compte ?? undefined }), i, false);
    if (!m) throw new HttpError(404, "Ce mail n'est plus dans la boîte : il a peut-être été supprimé.");
    const d = donneesDe(i);
    const vus = [m, ...(d.vus ?? []).filter((x) => x.id !== m.id)].slice(0, 200);
    await prisma.integration.update({ where: { id: i.id }, data: { donnees: jsonPropre({ ...d, vus }) as unknown as Prisma.InputJsonObject } }).catch(() => {});
    return { mail: { ...m, id: `ext:${i.id}:${m.id}`, ctx: i.ctx, compte: i.compte } };
  },

  /** Les règles de la boîte de réception (Outlook), décrites en français. */
  async regles(userId: string, id: string) {
    const { i, c, jetons } = await this._pourEcrire(userId, id, 'regles');
    return { regles: await this._ecrire(() => c.regles!(jetons), i, false) };
  },

  async activerRegle(userId: string, id: string, regle: string, active: boolean) {
    const { i, c, jetons } = await this._pourEcrire(userId, id, 'activerRegle');
    await this._ecrire(() => c.activerRegle!(jetons, regle, active), i, false);
    return this.regles(userId, id);
  },

  /** Envoie une réponse dans le fil d'un mail importé. Le contact et l'objet viennent du message gardé. */
  async repondre(userId: string, id: string, mailId: string, texte: string, choix?: { a?: string[]; cc?: string[] }, pieces: PieceAJoindre[] = [], signature?: string | null) {
    const { i, c, jetons } = await this._pourEcrire(userId, id, 'repondre');
    const m = this._mailGarde(i, mailId);
    if (!m) throw new HttpError(404, "Ce mail n'est plus dans les messages relus ; actualise la boîte et réessaie.");
    // Des destinataires choisis, vérifiés ; sans choix, la réponse va à toutes les personnes du mail.
    const dest = choix?.a?.length ? { a: adresses(choix.a.join(',')), cc: adresses((choix.cc ?? []).join(',')) } : undefined;
    // Relire le compte après un envoi ne sert à rien : la réponse part dans les messages envoyés, pas dans la réception.
    return this._ecrire(() => c.repondre!(jetons, { mailId: m.id, fil: m.fil, a: m.adresse || m.contact, sujet: m.sujet, texte: signe(i, texte, signature), messageId: m.messageId, references: m.references, boite: m.boite, dest, moi: this._mesAdresses(i, m.boite), ...(pieces.length ? { pieces } : {}) }), i, false);
  },

  _mesAdresses(i: Integration, boite?: string) {
    return [i.compte, boite].filter((x): x is string => !!x);
  },

  /**
   * Un lien court pour ouvrir une pièce jointe depuis l'app ou le navigateur, qui ne peuvent pas joindre un jeton de session à une adresse.
   * `message` : un ancien message du fil ; la boîte (perso ou partagée) reste celle du mail de la liste.
   */
  async lienPiece(userId: string, id: string, mailId: string, pieceId: string, message?: string) {
    const { i } = await this._pourEcrire(userId, id, 'lirePiece');
    const boite = this._mailGarde(i, mailId)?.boite;
    const jeton = jwt.sign({ typ: 'piece', userId, compte: id, mailId: message || mailId, pieceId, ...(boite ? { boite } : {}) }, process.env.JWT_SECRET as string, { expiresIn: '5m' });
    return { url: `/api/integrations/pieces/ouvrir?j=${encodeURIComponent(jeton)}` };
  },

  /** La pièce jointe d'un lien : rien n'est gardé, elle est lue chez le service à chaque ouverture. */
  async ouvrirPiece(jeton: string) {
    let p: { typ?: string; userId: string; compte: string; mailId: string; pieceId: string; boite?: string };
    try {
      p = jwt.verify(jeton, process.env.JWT_SECRET as string) as typeof p;
    } catch {
      throw new HttpError(401, 'Ce lien a expiré : rouvre la pièce jointe depuis le mail.');
    }
    if (p.typ !== 'piece') throw new HttpError(401, 'Lien invalide.');
    const { i, c, jetons } = await this._pourEcrire(p.userId, p.compte, 'lirePiece');
    return this._ecrire(() => c.lirePiece!(jetons, { mailId: p.mailId, pieceId: p.pieceId, boite: p.boite }), i, false);
  },

  /** Qui recevrait une réponse à tous : pour le montrer et laisser choisir. */
  async destinataires(userId: string, id: string, mailId: string) {
    const { i, c, jetons } = await this._pourEcrire(userId, id, 'destinataires');
    const garde = this._mailGarde(i, mailId);
    return this._ecrire(() => c.destinataires!(jetons, { mailId, boite: garde?.boite, moi: this._mesAdresses(i, garde?.boite) }), i, false);
  },

  /**
   * Lit un mail en entier, sans le garder : seul l'état « lu » est noté dans les messages relus.
   * `garderNonLu` : lu pour l'analyse du copilote, il reste « non lu » chez le service et dans Me.
   */
  async lireMail(userId: string, id: string, mailId: string, garderNonLu = false) {
    const { i, c, jetons, fuseau } = await this._pourEcrire(userId, id, 'lireMail');
    const garde = this._mailGarde(i, mailId);
    const contenu = await this._ecrire(() => c.lireMail!(jetons, mailId, fuseau, { fil: garde?.fil, boite: garde?.boite, garderNonLu, riche: true }), i, false);
    if (garde?.nonLu && !garderNonLu) await this._majMail(i, mailId, { nonLu: false });
    return { mail: { ...contenu, ...(garde?.boite ? { boite: garde.boite } : {}) } };
  },

  /**
   * Lit un mail pour l'analyse du copilote, sans le marquer comme lu : le contenu entier (texte, fil, pièces jointes),
   * avec la boîte (perso ou pro) et ce que le compte en a gardé (contact, fil, extrait). Utilisé par le serveur lui-même.
   */
  async lirePourAnalyse(userId: string, id: string, mailId: string) {
    const { i, c, jetons, fuseau } = await this._pourEcrire(userId, id, 'lireMail');
    const garde = this._mailGarde(i, mailId);
    const contenu = await this._ecrire(() => c.lireMail!(jetons, mailId, fuseau, { fil: garde?.fil, boite: garde?.boite, garderNonLu: true }), i, false);
    return { contenu, ctx: i.ctx as Ctx, garde, compte: i.compte ?? undefined };
  },

  /** Pose ou retire des étiquettes sur un mail ; la liste du compte et le mail gardé suivent tout de suite. */
  async etiqueter(userId: string, id: string, mailId: string, e: { ajouter?: string[]; retirer?: string[] }) {
    const { i, c, jetons } = await this._pourEcrire(userId, id, 'etiqueter');
    const garde = this._mailGarde(i, mailId);
    const propre = (l: string[] = []) => [...new Set(l.map((x) => x.trim()).filter(Boolean))];
    const ajouter = propre(e.ajouter);
    const retirer = propre(e.retirer);
    if (!ajouter.length && !retirer.length) throw new HttpError(400, 'Choisis une étiquette à poser ou à retirer.');
    const r = await this._ecrire(() => c.etiqueter!(jetons, { mailId, fil: garde?.fil, boite: garde?.boite, ajouter, retirer }), i, false);
    await this._majMail(i, mailId, { libelles: r.libelles }, ajouter);
    return r;
  },

  /** Corrige un mail gardé sans relire tout le compte ; `nouvelles` rejoint la liste des étiquettes du compte. */
  async _majMail(i: Integration, mailId: string, patch: Partial<MailImporte>, nouvelles: string[] = []) {
    const d = (i.donnees ?? null) as unknown as Elements | null;
    if (!d?.mails && !d?.vus) return;
    // Le mail peut venir de la réception relue ou d'un dossier ouvert (`vus`) : les deux suivent.
    const maj = (l?: MailImporte[]) => l?.map((m) => (m.id === mailId ? { ...m, ...patch } : m));
    const mails = maj(d.mails) ?? [];
    const vus = maj(d.vus);
    const connues = d.libelles ?? [];
    const libelles = [...connues, ...nouvelles.filter((n) => !connues.some((l) => l.nom.toLowerCase() === n.toLowerCase())).map((nom) => ({ nom }))];
    await prisma.integration.update({ where: { id: i.id }, data: { donnees: jsonPropre({ ...d, mails, ...(vus ? { vus } : {}), libelles }) as unknown as Prisma.InputJsonObject } }).catch(() => {});
  },

  /** Écrit un nouveau mail depuis le compte : destinataires séparés par des virgules. */
  async envoyer(userId: string, id: string, m: { a: string; cc?: string; sujet?: string; texte: string; signature?: string | null }, pieces: PieceAJoindre[] = []) {
    const { i, c, jetons } = await this._pourEcrire(userId, id, 'envoyer');
    return this._ecrire(() => c.envoyer!(jetons, { a: adresses(m.a), cc: adresses(m.cc), sujet: m.sujet ?? '', texte: signe(i, m.texte, m.signature), ...(pieces.length ? { pieces } : {}) }), i, false);
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
