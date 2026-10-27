/**
 * Offres d'abonnement et droits d'un compte. Module pur (sans base ni réseau), testé dans tests/abonnements.test.ts.
 *
 * - Gratuit : l'espace personnel complet (tâches, relances, habitudes, projets, finances, rappels dans l'app).
 * - Pro : en plus, les fonctions qui coûtent au serveur ou demandent des accès externes (voir FONCTIONS_PRO).
 * - Chaque nouveau compte a un essai Pro de ESSAI_JOURS jours, sans paiement.
 * - Pro est prépayé (FlexPaie, mobile money) : un paiement ouvre un mois ou un an, sans renouvellement automatique.
 *   Payer avant la fin prolonge à partir de la fin en cours, rien n'est perdu.
 *
 * Les prix doivent rester identiques à ceux des conditions générales de vente (me-mobile/public/cgv.html).
 */

export const ESSAI_JOURS = 14;
/** Version des conditions générales de vente acceptées au moment du paiement (à changer avec cgv.html). */
export const VERSION_CGV = '2026-10-27';

export type Periode = 'mensuel' | 'annuel';

export const OFFRES = {
  devise: 'USD',
  essaiJours: ESSAI_JOURS,
  gratuit: { nom: 'Gratuit', prix: 0 },
  pro: {
    nom: 'Pro',
    /** Prix TTC en centimes de la devise. */
    mensuel: { prix: 499, libelle: '4,99 $ par mois', mois: 1 },
    annuel: { prix: 4999, libelle: '49,99 $ par an', mois: 12, economie: '2 mois offerts' },
  },
} as const;

/** Ce que Pro débloque. Le reste de l'app est inclus dans l'offre gratuite. */
export const FONCTIONS_PRO = {
  assistant: 'Le copilote IA (questions, plans, brouillons de relance)',
  integrations: 'Les comptes connectés : Gmail, Outlook, Google Agenda, To Do, Trello, Slack',
  equipes: 'Les équipes et leurs espaces partagés',
  emails: 'Les rappels par email',
  push: 'Les notifications push sur tes appareils',
} as const;

export type FonctionPro = keyof typeof FONCTIONS_PRO;

/** Champs du compte qui décrivent son abonnement (colonnes de User). */
export type ChampsAbonnement = {
  role?: 'ADMIN' | 'UTILISATEUR';
  essaiJusqua?: Date | null;
  abonnementPeriode?: string | null;
  abonnementFinLe?: Date | null;
};

export type EtatAbonnement = {
  /** Les abonnements sont-ils en service sur ce serveur ? Sinon tout est ouvert. */
  actif: boolean;
  /** `libre` : abonnements coupés ou compte admin. */
  offre: 'gratuit' | 'essai' | 'pro' | 'libre';
  pro: boolean;
  periode: Periode | null;
  /** Fin de l'essai (offre essai) ou de la période payée (offre pro), ISO. */
  jusqua: string | null;
  /** Jours restants avant `jusqua`, arrondis au supérieur. */
  joursRestants: number | null;
  fonctions: FonctionPro[];
};

/** Les abonnements sont activés par ABONNEMENTS=true. Sans, le serveur reste ouvert à tous comme avant. */
export const abonnementsActifs = (env: Record<string, string | undefined> = process.env) => env.ABONNEMENTS?.trim().toLowerCase() === 'true';

const jours = (fin: Date, maintenant: Date) => Math.max(0, Math.ceil((fin.getTime() - maintenant.getTime()) / 86400000));

export function etatAbonnement(c: ChampsAbonnement, maintenant = new Date(), actif = abonnementsActifs()): EtatAbonnement {
  const toutes = Object.keys(FONCTIONS_PRO) as FonctionPro[];
  const periode: Periode | null = c.abonnementPeriode === 'annuel' || c.abonnementPeriode === 'mensuel' ? c.abonnementPeriode : null;
  const base = { actif, periode };

  const fin = c.abonnementFinLe ?? null;
  if (fin && fin > maintenant) return { ...base, offre: 'pro', pro: true, jusqua: fin.toISOString(), joursRestants: jours(fin, maintenant), fonctions: toutes };

  if (!actif || c.role === 'ADMIN') return { ...base, offre: 'libre', pro: true, jusqua: null, joursRestants: null, fonctions: toutes };

  const essai = c.essaiJusqua ?? null;
  if (essai && essai > maintenant) return { ...base, offre: 'essai', pro: true, jusqua: essai.toISOString(), joursRestants: jours(essai, maintenant), fonctions: toutes };

  return { ...base, offre: 'gratuit', pro: false, jusqua: null, joursRestants: null, fonctions: [] };
}

export const finEssai = (depuis = new Date()) => new Date(depuis.getTime() + ESSAI_JOURS * 86400000);

/** Ajoute des mois calendaires, en restant au dernier jour du mois si besoin (31 janvier + 1 mois = 28 ou 29 février). */
export function ajouterMois(d: Date, mois: number) {
  const r = new Date(d);
  const jour = r.getUTCDate();
  r.setUTCDate(1);
  r.setUTCMonth(r.getUTCMonth() + mois);
  const dernier = new Date(Date.UTC(r.getUTCFullYear(), r.getUTCMonth() + 1, 0)).getUTCDate();
  r.setUTCDate(Math.min(jour, dernier));
  return r;
}

/** Nouvelle fin de Pro après un paiement : à partir de la fin en cours si Pro est encore ouvert, sinon de maintenant. */
export function prolonger(finActuelle: Date | null | undefined, periode: Periode, maintenant = new Date()) {
  const depart = finActuelle && finActuelle > maintenant ? finActuelle : maintenant;
  return ajouterMois(depart, OFFRES.pro[periode].mois);
}

/** Message renvoyé (402) quand une fonction Pro est demandée sans abonnement. */
export const messageReserve = (f: FonctionPro) => `${FONCTIONS_PRO[f]} : c'est inclus dans Me Pro. Passe à Pro depuis Mon compte › Abonnement.`;

export type AvisAbonnement = { cle: string; titre: string; corps: string; parEmail: boolean };

const SUITE = "Ensuite, Me reste gratuite pour l'essentiel ; le copilote IA, les comptes connectés, les équipes et les rappels par email et push demandent Pro.";

/**
 * Messages liés à l'abonnement, envoyés une seule fois grâce à leur clé :
 * - fin d'essai : 3 jours avant, dans l'app ;
 * - fin de la période payée : 7 jours puis 1 jour avant, dans l'app et par email (rien n'est prélevé automatiquement).
 */
export function avisAbonnement(c: ChampsAbonnement, maintenant = new Date(), actif = abonnementsActifs()): AvisAbonnement | null {
  if (!actif) return null;
  const e = etatAbonnement(c, maintenant, actif);
  if (e.joursRestants === null || !e.jusqua) return null;
  const jour = e.jusqua.slice(0, 10);
  const quand = e.joursRestants <= 1 ? 'demain' : `dans ${e.joursRestants} jours`;
  if (e.offre === 'essai' && e.joursRestants <= 3) {
    return { cle: `abonnement:essai:${jour}`, titre: `Ton essai Pro se termine ${quand}`, corps: `${SUITE} Pour garder Pro : Mon compte › Abonnement.`, parEmail: false };
  }
  if (e.offre === 'pro' && e.joursRestants <= 7) {
    const palier = e.joursRestants <= 1 ? 1 : 7;
    return {
      cle: `abonnement:fin:${jour}:${palier}`,
      titre: `Ton abonnement Pro se termine ${quand}`,
      corps: `Il n'est pas renouvelé automatiquement : rien ne sera prélevé. Pour continuer, paie une nouvelle période dans Mon compte › Abonnement ; elle s'ajoutera à la fin de la période en cours. ${SUITE}`,
      parEmail: true,
    };
  }
  return null;
}
