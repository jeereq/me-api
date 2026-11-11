import { abonnementsActifs, ESSAI_JOURS, etatAbonnement, type ChampsAbonnement } from '../abonnements/offres.js';

/**
 * Le forfait de SMS d'un compte : un SMS coûte (un SMS long coûte autant de SMS qu'il a de segments), l'abonnement n'en
 * inclut donc qu'un nombre. Module pur, testé dans tests/forfait-sms.test.ts.
 *
 * - Pro : FORFAIT_PRO segments par mois civil (UTC), pour les rappels, le rapport du soir et les avis de groupe.
 * - Essai : FORFAIT_ESSAI segments pour tout l'essai.
 * - Les autres comptes (gratuit, Finances, Projets) : FORFAIT_GRATUIT segments par mois, pour les avis des groupes de cotisation
 *   où ils sont membres (leurs rappels personnels par SMS sont une fonction Pro).
 * - Abonnements coupés ou compte admin : pas de limite.
 * Les SMS de sécurité (code, mot de passe) et les codes de vérification ne comptent pas ici : ils ont leurs propres limites.
 */
export const FORFAIT_PRO = 40;
export const FORFAIT_ESSAI = 10;
export const FORFAIT_GRATUIT = 10;

type Env = Record<string, string | undefined>;
const entier = (v: string | undefined, defaut: number) => {
  const n = Number(v);
  return v?.trim() && Number.isInteger(n) && n >= 0 ? n : defaut;
};

type Lecture = Record<string, string | undefined>;

/** SMS d'invitation à un groupe par organisateur sur 24 h. */
export const maxCotisationsParJour = (env: Lecture = process.env) => {
  const n = Number(env.COTISATIONS_SMS_PAR_JOUR);
  return Number.isInteger(n) && n > 0 ? n : 20;
};

/** Codes de vérification d'un numéro par compte sur 24 h : chaque code coûte, et un compte gratuit peut en demander. */
export const maxCodesParJour = (env: Lecture = process.env) => {
  const n = Number(env.SMS_CODES_PAR_JOUR);
  return Number.isInteger(n) && n > 0 ? n : 6;
};

export type ForfaitSms = {
  /** Segments permis sur la période, ou null : pas de limite. */
  limite: number | null;
  /** Début de la période comptée. */
  depuis: Date;
  periode: 'mois' | 'essai';
};

/** Le premier jour du mois civil (UTC) de `d`. */
export const debutMois = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));

export function forfaitSms(c: ChampsAbonnement, maintenant = new Date(), actif = abonnementsActifs(), env: Env = process.env): ForfaitSms {
  const e = etatAbonnement(c, maintenant, actif);
  const mois = debutMois(maintenant);
  if (e.offre === 'libre') return { limite: null, depuis: mois, periode: 'mois' };
  if (e.offre === 'essai' && e.jusqua) return { limite: entier(env.SMS_FORFAIT_ESSAI, FORFAIT_ESSAI), depuis: new Date(new Date(e.jusqua).getTime() - ESSAI_JOURS * 86400000), periode: 'essai' };
  if (e.offre === 'pro') return { limite: entier(env.SMS_FORFAIT_PRO, FORFAIT_PRO), depuis: mois, periode: 'mois' };
  return { limite: entier(env.SMS_FORFAIT_GRATUIT, FORFAIT_GRATUIT), depuis: mois, periode: 'mois' };
}

/** Reste-t-il de la place pour ce SMS ? Un SMS long est refusé en entier s'il dépasse. */
export const placeForfait = (utilises: number, segments: number, limite: number | null) => limite === null || utilises + Math.max(1, segments) <= limite;

/** Ce qui reste, pour l'afficher. Null : pas de limite. */
export const resteForfait = (utilises: number, limite: number | null) => (limite === null ? null : Math.max(0, limite - utilises));
