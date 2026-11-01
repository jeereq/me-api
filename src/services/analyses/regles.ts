/**
 * L'analyse des mails préparée côté serveur : ce qui se garde, ce qui se refait, quels mails préparer à l'avance (module pur, testé).
 *
 * - Une analyse est gardée 30 jours par mail (`AnalyseMail`). Elle n'est refaite que si la demande change :
 *   le ton, les consignes de l'utilisateur ou la version de l'analyse (voir `empreinte`).
 * - Le texte des mails n'est jamais gardé, seulement ce que l'IA en a tiré.
 * - `analyserLot` enchaîne : ce qui est déjà gardé, la lecture des autres mails, une demande à l'IA pour eux, puis leur enregistrement.
 */
import { createHash } from 'node:crypto';

import { consignesPropres, texteUtile } from '../analyse-mails.js';

/** Combien de temps une analyse est gardée. */
export const AGE_MAX_JOURS = 30;
/** À changer quand le prompt ou le schéma de l'analyse change : les analyses gardées sont alors refaites. */
export const VERSION_ANALYSE = 'v1';

/** Au plus autant de mails par demande, comme l'app (une réponse JSON plus longue devient lente et coûteuse). */
export const MAX_MAILS_DEMANDE = 10;
/** Ce qui part à l'IA pour un mail : son texte (nettoyé), les derniers messages du fil et les noms des pièces jointes. */
export const MAX_TEXTE_MAIL = 4000;
export const MAX_PRECEDENTS = 3;
export const MAX_TEXTE_PRECEDENT = 600;
export const MAX_PIECES_JOINTES = 10;

/** Analyse préparée à l'avance : seulement les mails reçus non lus des 3 derniers jours, 10 par compte et 100 par passage au plus. */
export const AUTO_JOURS = 3;
export const AUTO_PAR_COMPTE = 10;
export const AUTO_PAR_PASSAGE = 100;

/** Une analyse telle que l'IA l'a rendue (voir SCHEMA_MAILS), avec en plus l'`id` du mail demandé. */
export type AnalyseIA = Record<string, unknown> & { id: string };

/** Ce que l'IA sait des relances, tâches et projets de l'utilisateur, chacun avec sa ref. */
export type ContexteCrm = {
  relances: { ref: string; contact: string; sujet: string; depuis: string }[];
  taches: { ref: string; titre: string; echeance: string | null }[];
  projets: { ref: string; nom: string }[];
};

/* ——— Références de mails : `ext:<compte connecté>:<mail>` (comme dans l'app) ——— */

export const refMail = (integrationId: string, mailId: string) => `ext:${integrationId}:${mailId}`;

/** Découpe `ext:<compte>:<mail>` ; le mail peut contenir des « : », pas le compte. */
export function lireRef(ref: string): { integrationId: string; mailId: string } | null {
  if (!ref?.startsWith('ext:')) return null;
  const reste = ref.slice(4);
  const coupe = reste.indexOf(':');
  if (coupe <= 0 || coupe === reste.length - 1) return null;
  return { integrationId: reste.slice(0, coupe), mailId: reste.slice(coupe + 1) };
}

/* ——— Ce qui se garde ——— */

/** Empreinte de la demande : une analyse gardée avec une autre empreinte est refaite. */
export function empreinte(ton: string | undefined, consignes: string | undefined): string {
  const t = String(ton ?? '').trim().toLowerCase() || 'neutre';
  return createHash('sha256').update(`${VERSION_ANALYSE}|${t}|${consignesPropres(consignes)}`).digest('hex').slice(0, 24);
}

/** Date avant laquelle une analyse gardée est trop vieille. */
export const limiteAge = (maintenant = new Date()) => new Date(maintenant.getTime() - AGE_MAX_JOURS * 86400000);

/* ——— Le mail tel que l'IA le reçoit ——— */

export type MailLisible = {
  sujet?: string;
  de?: string;
  adresse?: string;
  date?: string;
  texte?: string;
  piecesJointes?: string[];
  fil?: { de?: string; date?: string; texte?: string }[];
};

/** Un mail lu en entier, ramené à ce qui sert à l'analyse : texte nettoyé, derniers messages du fil, pièces jointes. */
export function mailPourIA(ref: string, m: MailLisible, boite: string, extrait?: string) {
  const texte = texteUtile(m.texte || extrait || '').slice(0, MAX_TEXTE_MAIL);
  const precedents = (m.fil ?? [])
    .slice(-MAX_PRECEDENTS)
    .map((x) => ({ de: x.de ?? '', ...(x.date ? { date: x.date } : {}), texte: texteUtile(x.texte ?? '').slice(0, MAX_TEXTE_PRECEDENT) }))
    .filter((x) => x.texte);
  const pj = (m.piecesJointes ?? []).filter(Boolean).slice(0, MAX_PIECES_JOINTES);
  return {
    id: ref,
    de: m.de ?? '',
    ...(m.adresse ? { adresse: m.adresse } : {}),
    ...(m.date ? { date: m.date } : {}),
    sujet: m.sujet ?? '',
    boite,
    texte,
    ...(precedents.length ? { precedents } : {}),
    ...(pj.length ? { pj } : {}),
  };
}

/* ——— Le contexte de Me, quand l'app ne l'envoie pas ——— */

const norm = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
const adresseDe = (v = '') => (v.match(/<([^>]+)>/)?.[1] ?? v).trim().toLowerCase();
const PETITS = new Set(['le', 'la', 'les', 'un', 'une', 'des', 'de', 'du', 'au', 'aux', 'et', 'ou', 'a', 'en', 'pour', 'sur', 'avec', 'the', 'of', 'to', 'and']);
const mots = (nom?: string, adresse?: string) =>
  new Set(norm(`${nom ?? ''} ${adresseDe(adresse).replace(/@.*$/, '')}`).split(/[^a-z0-9]+/).filter((x) => x.length > 1 && !PETITS.has(x)));

/** Le contact d'une relance (« Marie », « marie@exemple.fr ») est celui du mail. */
export function memeContact(qui: string, m: { contact?: string; adresse?: string }): boolean {
  const q = norm(qui).trim();
  if (!q) return false;
  if (q.includes('@')) return !!m.adresse && adresseDe(q) === adresseDe(m.adresse);
  const cherche = [...mots(q)];
  const dans = [...mots(m.contact, m.adresse)];
  return cherche.length > 0 && cherche.every((c) => dans.some((d) => d.startsWith(c)));
}

type EspaceJson = {
  relances?: { id?: unknown; contact?: unknown; sujet?: unknown; statut?: unknown; date?: unknown; mail?: { fil?: unknown } }[];
  taches?: { id?: unknown; titre?: unknown; statut?: unknown; echeance?: unknown; creeLe?: unknown }[];
  projets?: { id?: unknown; nom?: unknown; archive?: unknown }[];
  audio?: { ton?: unknown };
};
const txt = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');

/**
 * Ce que l'utilisateur suit déjà, lu dans son espace privé : ses relances ouvertes avec les expéditeurs de ces mails
 * (ou rattachées à leur fil), ses 30 tâches ouvertes les plus récentes et ses projets en cours.
 * Même forme et mêmes refs (`r:`, `t:`, `p:`) que celles de l'app, qui les relit.
 */
export function contexteDepuisEspace(espace: unknown, mails: { contact?: string; adresse?: string; cleFil?: string }[]): ContexteCrm {
  const e = (espace ?? {}) as EspaceJson;
  const fils = new Set(mails.map((m) => m.cleFil).filter((x): x is string => !!x));
  const relances = (Array.isArray(e.relances) ? e.relances : [])
    .filter((r) => r && typeof r.id === 'string' && r.statut !== 'repondu' && ((typeof r.mail?.fil === 'string' && fils.has(r.mail.fil)) || mails.some((m) => memeContact(txt(r.contact, 200), m))))
    .slice(0, 20)
    .map((r) => ({ ref: `r:${r.id}`, contact: txt(r.contact, 200), sujet: txt(r.sujet, 300), depuis: txt(r.date, 10) }));
  const taches = (Array.isArray(e.taches) ? e.taches : [])
    .filter((t) => t && typeof t.id === 'string' && t.statut !== 'fait')
    .sort((a, b) => txt(b.creeLe, 40).localeCompare(txt(a.creeLe, 40)))
    .slice(0, 30)
    .map((t) => ({ ref: `t:${t.id}`, titre: txt(t.titre, 300), echeance: typeof t.echeance === 'string' && t.echeance ? t.echeance.slice(0, 10) : null }));
  const projets = (Array.isArray(e.projets) ? e.projets : [])
    .filter((p) => p && typeof p.id === 'string' && !p.archive)
    .slice(0, 20)
    .map((p) => ({ ref: `p:${p.id}`, nom: txt(p.nom, 200) }));
  return { relances, taches, projets };
}

/** Le ton choisi dans l'espace de l'utilisateur (comme l'app l'envoie à chaque demande). */
export const tonDe = (espace: unknown): string => {
  const t = (espace as EspaceJson | null)?.audio?.ton;
  return typeof t === 'string' && t.trim() ? t.trim() : 'neutre';
};

/* ——— Quels mails préparer à l'avance ——— */

type MailGarde = { id: string; sens?: string; nonLu?: boolean; date?: string; heure?: string; contact?: string; adresse?: string; fil?: string };

/** Le jour (AAAA-MM-JJ, UTC) d'il y a `jours` jours : une marge d'une journée de fuseau ne change rien à « les 3 derniers jours ». */
const jourMoins = (maintenant: Date, jours: number) => new Date(maintenant.getTime() - jours * 86400000).toISOString().slice(0, 10);

/**
 * Les mails reçus non lus des derniers jours que le compte vient de relire et qui n'ont pas encore d'analyse,
 * les plus récents d'abord, au plus `max`. `abandonnes` : mails déjà essayés plusieurs fois sans résultat, laissés de côté.
 */
export function mailsAPreparer(mails: MailGarde[] | undefined, dejaAnalyses: Set<string>, maintenant: Date, max = AUTO_PAR_COMPTE, abandonnes: Set<string> = new Set()): MailGarde[] {
  const depuis = jourMoins(maintenant, AUTO_JOURS);
  return (mails ?? [])
    .filter((m) => m?.id && m.sens === 'recu' && m.nonLu && (m.date ?? '') >= depuis && !dejaAnalyses.has(m.id) && !abandonnes.has(m.id))
    .sort((a, b) => `${b.date}${b.heure ?? ''}`.localeCompare(`${a.date}${a.heure ?? ''}`))
    .slice(0, max);
}

/* ——— L'enchaînement ——— */

export type Reponse = { analyses: AnalyseIA[]; enCache: number; fraiches: number; illisibles: string[]; modeles: string[] };

export type Dependances = {
  /** Les analyses déjà gardées (et encore bonnes) parmi ces refs. */
  gardees: (refs: string[]) => Promise<Map<string, AnalyseIA>>;
  /** Le mail tel que l'IA le reçoit ; null s'il est illisible (supprimé, compte à reconnecter…). */
  lire: (ref: string) => Promise<Record<string, unknown> | null>;
  /** La demande à l'IA : les données JSON → le JSON `{ analyses: [...] }` rendu, et les modèles qui ont répondu. */
  demander: (donnees: string) => Promise<{ texte: string; modeles: string[] }>;
  /** Garde l'analyse d'un mail. */
  garder: (ref: string, analyse: AnalyseIA, modeles: string[]) => Promise<void>;
};

/** Combien de mails sont lus en même temps chez le service (Gmail, Outlook). */
const LECTURES_PARALLELES = 5;

/**
 * Les analyses de ces mails, dans l'ordre demandé : celles déjà gardées d'abord, les autres lues puis envoyées à l'IA en une demande.
 * Un mail illisible, ou que l'IA oublie, n'a pas d'analyse (il est listé dans `illisibles` s'il n'a pas pu être lu).
 */
export async function analyserLot(refs: string[], contexte: { aujourdhui: string; crm?: ContexteCrm }, d: Dependances): Promise<Reponse> {
  const uniques = [...new Set(refs)];
  const gardees = await d.gardees(uniques);
  const aFaire = uniques.filter((r) => !gardees.has(r));

  const lus: Record<string, unknown>[] = [];
  const illisibles: string[] = [];
  for (let i = 0; i < aFaire.length; i += LECTURES_PARALLELES) {
    const groupe = aFaire.slice(i, i + LECTURES_PARALLELES);
    const r = await Promise.all(groupe.map((ref) => d.lire(ref).catch(() => null)));
    r.forEach((m, k) => (m ? lus.push(m) : illisibles.push(groupe[k])));
  }

  const fraiches = new Map<string, AnalyseIA>();
  let modeles: string[] = [];
  if (lus.length) {
    const reponse = await d.demander(JSON.stringify({ aujourdhui: contexte.aujourdhui, ...(contexte.crm ? { crm: contexte.crm } : {}), mails: lus }));
    modeles = reponse.modeles;
    let liste: unknown;
    try {
      liste = (JSON.parse(reponse.texte) as { analyses?: unknown })?.analyses;
    } catch {
      liste = undefined;
    }
    if (!Array.isArray(liste)) throw new Error('reponse_illisible');
    const demandes = new Set(lus.map((m) => String(m.id)));
    for (const a of liste) {
      const id = a && typeof a === 'object' ? String((a as { id?: unknown }).id ?? '') : '';
      if (!demandes.has(id) || fraiches.has(id)) continue;
      fraiches.set(id, a as AnalyseIA);
    }
    for (const [ref, a] of fraiches) await d.garder(ref, a, modeles);
  }

  return {
    analyses: uniques.map((r) => gardees.get(r) ?? fraiches.get(r)).filter((a): a is AnalyseIA => !!a),
    enCache: gardees.size,
    fraiches: fraiches.size,
    illisibles,
    modeles,
  };
}
