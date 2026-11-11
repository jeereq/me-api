/**
 * Offres d'abonnement et droits d'un compte. Module pur (sans base ni réseau), testé dans tests/abonnements.test.ts.
 *
 * Quatre formules (et, pour Pro, quatre paliers de réunions : Pro 0 à Pro 3, voir PALIERS) :
 * - Gratuit : l'espace personnel (tâches, relances, habitudes, projets) et les finances de base (budgets, dépenses,
 *   revenus, objectifs, statistiques, export), avec les rappels dans l'app.
 * - Finances : en plus, les finances avancées (voir FONCTIONS_FINANCES), avec leurs alertes en push et par email.
 * - Projets : en plus, la gestion de projets avancée (voir FONCTIONS_PROJETS), sans les finances avancées. Distincte de Finances.
 * - Pro : tout Finances et tout Projets, plus les fonctions qui coûtent au serveur ou demandent des accès externes (voir FONCTIONS_PRO).
 *
 * - Chaque nouveau compte a un essai de ESSAI_JOURS jours de tout Pro, sans paiement, une fois par personne. Le jour où
 *   les abonnements sont mis en service (ABONNEMENTS_DEPUIS), chaque compte qui a un essai garde au moins ESSAI_JOURS
 *   jours à partir de cette date : personne ne perd Pro le jour de l'activation.
 * - Les formules sont prépayées (FlexPaie, mobile money) : un paiement ouvre un mois ou un an, sans renouvellement
 *   automatique. Payer avant la fin prolonge à partir de la fin en cours, et payer pendant l'essai commence après
 *   l'essai : rien n'est perdu. Changer de formule convertit le temps restant au prorata des prix (voir `prolonger`).
 *
 * Les prix doivent rester identiques à ceux des conditions générales de vente (me-mobile/public/cgv.html).
 */

export const ESSAI_JOURS = 14;
/** Version des conditions générales de vente acceptées au moment du paiement (à changer avec cgv.html). */
export const VERSION_CGV = '2026-11-11';

export type Periode = 'mensuel' | 'annuel';
export type Formule = 'finances' | 'projets' | 'pro';
/** Palier de réunions de Pro : 0 (sans réunions, le Pro d'origine), 1, 2 ou 3. */
export type Palier = 0 | 1 | 2 | 3;

const FORMULE_FINANCES = {
  nom: 'Finances',
  /** Prix TTC en centimes de la devise. */
  mensuel: { prix: 399, libelle: '3,99 $ par mois', mois: 1 },
  annuel: { prix: 4389, libelle: '43,89 $ par an', mois: 12, economie: '1 mois offert' },
} as const;
const FORMULE_PROJETS = {
  nom: 'Projets',
  mensuel: { prix: 399, libelle: '3,99 $ par mois', mois: 1 },
  annuel: { prix: 4389, libelle: '43,89 $ par an', mois: 12, economie: '1 mois offert' },
} as const;
const FORMULE_PRO = {
  nom: 'Pro',
  mensuel: { prix: 699, libelle: '6,99 $ par mois', mois: 1 },
  annuel: { prix: 7689, libelle: '76,89 $ par an', mois: 12, economie: '1 mois offert' },
} as const;

/**
 * Les paliers de Pro qui ajoutent l'enregistrement, la transcription et le résumé des réunions, avec l'attribution des tâches
 * aux membres, projets et plannings. Le prix d'un palier s'ajoute à celui de Pro (Pro 1 = 6,99 + 2,99 = 9,98 $ par mois).
 * `heures` : heures d'audio transcrites par mois civil, sans report. Les prix doivent rester ceux des CGV.
 */
export const PALIERS = {
  1: { nom: 'Pro 1', heures: 5, mensuel: { prix: 299, libelle: '+ 2,99 $ par mois' }, annuel: { prix: 3289, libelle: '+ 32,89 $ par an' } },
  2: { nom: 'Pro 2', heures: 20, mensuel: { prix: 699, libelle: '+ 6,99 $ par mois' }, annuel: { prix: 7689, libelle: '+ 76,89 $ par an' } },
  3: { nom: 'Pro 3', heures: 40, mensuel: { prix: 1299, libelle: '+ 12,99 $ par mois' }, annuel: { prix: 14289, libelle: '+ 142,89 $ par an' } },
} as const;
/** Minutes de réunion offertes pendant l'essai de 14 jours (une fois). */
export const ESSAI_REUNION_MINUTES = 45;

export const estPalier = (n: unknown): n is Palier => n === 0 || n === 1 || n === 2 || n === 3;
/** Palier lu sur un compte ou un paiement : tout ce qui n'est pas 1, 2 ou 3 est Pro 0. */
export const palierDe = (n: unknown): Palier => (n === 1 || n === 2 || n === 3 ? n : 0);

/** Prix d'une période, en centimes : celui de la formule, plus celui du palier (Pro seulement). */
export function prixPeriode(formule: Formule, periode: Periode, palier: Palier = 0): number {
  return OFFRES.formules[formule][periode].prix + (formule === 'pro' && palier ? PALIERS[palier][periode].prix : 0);
}

export const OFFRES = {
  devise: 'USD',
  essaiJours: ESSAI_JOURS,
  gratuit: { nom: 'Gratuit', prix: 0 },
  formules: { finances: FORMULE_FINANCES, projets: FORMULE_PROJETS, pro: FORMULE_PRO },
  /** Paliers de réunions de Pro (1 à 3) et minutes offertes à l'essai. */
  paliers: PALIERS,
  essaiReunionMinutes: ESSAI_REUNION_MINUTES,
  /** Gardé pour les anciennes versions de l'app, qui ne connaissent que Pro. */
  pro: FORMULE_PRO,
} as const;

/** Ce que Finances débloque (Pro le comprend). Le reste des finances est inclus dans l'offre gratuite. */
export const FONCTIONS_FINANCES = {
  justificatifs: 'Les reçus et factures joints aux dépenses',
  releves: 'L’import des relevés bancaires et mobile money',
  comptes: 'Plusieurs comptes et plusieurs devises',
  prets: 'Les prêts et dettes entre personnes, avec leurs rappels',
  echeances: 'Les paiements à venir, prévenus la veille',
  bilan: 'Le bilan du mois, à l’écran et par email',
  cotisations: 'Créer ou rejoindre des groupes de cotisation',
  alertes: 'Les alertes de budget et d’objectifs en push et par email',
} as const;

/** Ce que Projets débloque (Pro le comprend). Les projets de base (tâches, planning, import) sont inclus dans l'offre gratuite. */
export const FONCTIONS_PROJETS = {
  projetsVues: 'Les vues d’ensemble des projets : Ensemble, Feuille de route, À compléter, en plein écran et avec filtres',
  projetsRapport: 'Le rapport trimestriel (écran, impression, Excel) et les piliers configurables',
  projetsIA: 'L’IA des projets : état et résumé, plan depuis un objectif, risques, questions',
  projetsMails: 'Les mails aux responsables et les commandes vocales des projets, avec la lecture d’un projet',
} as const;

/** Ce que Pro ajoute à Finances. */
export const FONCTIONS_PRO = {
  assistant: 'Le copilote IA (questions, plans, brouillons de relance)',
  integrations: 'Les comptes connectés : Gmail, Outlook, Google Agenda, To Do, Trello, Slack',
  equipes: 'Les équipes et leurs espaces partagés',
  emails: 'Les rappels par email',
  push: 'Les notifications push sur tes appareils',
  sms: 'Les rappels et le rapport du soir par SMS, dans un forfait mensuel',
} as const;

/** Ce que les paliers Pro 1 à 3 ajoutent à Pro. */
export const FONCTIONS_REUNIONS = {
  reunions: 'L’enregistrement des réunions, leur transcription et leur résumé, avec l’attribution des tâches aux membres, projets et plannings',
} as const;

export type FonctionFinances = keyof typeof FONCTIONS_FINANCES;
export type FonctionProjets = keyof typeof FONCTIONS_PROJETS;
export type FonctionPro = keyof typeof FONCTIONS_PRO;
export type FonctionReunions = keyof typeof FONCTIONS_REUNIONS;
export type Fonction = FonctionFinances | FonctionProjets | FonctionPro | FonctionReunions;

const TOUT_FINANCES = Object.keys(FONCTIONS_FINANCES) as FonctionFinances[];
const TOUT_PROJETS = Object.keys(FONCTIONS_PROJETS) as FonctionProjets[];
const TOUT_PRO0 = [...TOUT_FINANCES, ...TOUT_PROJETS, ...(Object.keys(FONCTIONS_PRO) as FonctionPro[])];
const TOUT = [...TOUT_PRO0, ...(Object.keys(FONCTIONS_REUNIONS) as FonctionReunions[])];

/** La formule qui débloque une fonction. */
export const formuleDe = (f: Fonction): Formule => (f in FONCTIONS_FINANCES ? 'finances' : f in FONCTIONS_PROJETS ? 'projets' : 'pro');

/** Champs du compte qui décrivent son abonnement (colonnes de User). */
export type ChampsAbonnement = {
  role?: 'ADMIN' | 'COMMERCIAL' | 'UTILISATEUR';
  essaiJusqua?: Date | null;
  abonnementFormule?: string | null;
  /** Palier de réunions de Pro (0 à 3). */
  abonnementPalier?: number | null;
  abonnementPeriode?: string | null;
  abonnementFinLe?: Date | null;
};

/** Colonnes à lire pour calculer l'état d'un abonnement (select Prisma). */
export const SELECT_ABONNEMENT = { role: true, essaiJusqua: true, abonnementFormule: true, abonnementPalier: true, abonnementPeriode: true, abonnementFinLe: true } as const;

export type EtatAbonnement = {
  /** Les abonnements sont-ils en service sur ce serveur ? Sinon tout est ouvert. */
  actif: boolean;
  /** `libre` : abonnements coupés ou compte admin. */
  offre: 'gratuit' | 'essai' | 'finances' | 'projets' | 'pro' | 'libre';
  /** Les fonctions Pro sont ouvertes (essai, Pro, libre). */
  pro: boolean;
  /** Les finances avancées sont ouvertes (Finances, et tout ce qui ouvre Pro). */
  finances: boolean;
  /** La gestion de projets avancée est ouverte (Projets, et tout ce qui ouvre Pro). */
  projets: boolean;
  periode: Periode | null;
  /** Palier de réunions de la formule Pro payée (0 sans réunions). */
  palier: Palier;
  /** Réunions : de combien d'audio transcrit par période (clé de comptage), ou null si elles ne sont pas ouvertes. `illimite` : abonnements coupés ou admin. */
  reunions: { cle: 'essai' | string; secondes: number; illimite?: boolean } | null;
  /** Fin de l'essai (offre essai) ou de la période payée (offres finances et pro), ISO. */
  jusqua: string | null;
  /** Jours restants avant `jusqua`, arrondis au supérieur. */
  joursRestants: number | null;
  fonctions: Fonction[];
  /** Formule payée qui prend le relais à la fin de l'essai (payée pendant l'essai), et sa fin. */
  ensuite?: { formule: Formule; jusqua: string } | null;
};

/** Formule payée notée sur le compte. Un compte payé avant les formules Finances et Projets avait Pro. */
export const formulePayee = (c: ChampsAbonnement): Formule => (c.abonnementFormule === 'finances' ? 'finances' : c.abonnementFormule === 'projets' ? 'projets' : 'pro');

/** Les abonnements sont activés par ABONNEMENTS=true. Sans, le serveur reste ouvert à tous comme avant. */
export const abonnementsActifs = (env: Record<string, string | undefined> = process.env) => env.ABONNEMENTS?.trim().toLowerCase() === 'true';

/**
 * Date de mise en service des abonnements (ABONNEMENTS_DEPUIS, ex. 2026-11-15). À poser le jour où l'on passe
 * ABONNEMENTS à true : les essais comptent alors à partir de cette date au plus tôt. Absente ou illisible : null.
 */
export function debutAbonnements(env: Record<string, string | undefined> = process.env): Date | null {
  const v = env.ABONNEMENTS_DEPUIS?.trim();
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Fin réelle de l'essai : celle notée sur le compte, repoussée à ESSAI_JOURS jours après la mise en service des
 * abonnements si elle tombe avant. Un compte sans essai (essai déjà utilisé, compte créé par l'admin) n'en reçoit pas.
 */
export function finEssaiEffective(essaiJusqua: Date | null | undefined, depuis: Date | null = debutAbonnements()): Date | null {
  if (!essaiJusqua) return null;
  if (!depuis) return essaiJusqua;
  const plancher = finEssai(depuis);
  return essaiJusqua > plancher ? essaiJusqua : plancher;
}

const jours = (fin: Date, maintenant: Date) => Math.max(0, Math.ceil((fin.getTime() - maintenant.getTime()) / 86400000));

/** Clé de comptage des réunions du mois civil (UTC), ex. « 2026-11 ». */
export const moisReunions = (d: Date) => d.toISOString().slice(0, 7);

export function etatAbonnement(c: ChampsAbonnement, maintenant = new Date(), actif = abonnementsActifs(), depuis = debutAbonnements()): EtatAbonnement {
  const periode: Periode | null = c.abonnementPeriode === 'annuel' || c.abonnementPeriode === 'mensuel' ? c.abonnementPeriode : null;
  const palier = palierDe(c.abonnementPalier);
  const base = { actif, periode, palier };
  const tout = { pro: true, finances: true, projets: true, fonctions: TOUT };

  const fin = c.abonnementFinLe && c.abonnementFinLe > maintenant ? c.abonnementFinLe : null;
  const formule = formulePayee(c);
  if (fin && formule === 'pro') {
    // Pro 0 n'a pas les réunions ; Pro 1 à 3 en ont PALIERS[palier].heures par mois.
    const reunions = palier ? { cle: moisReunions(maintenant), secondes: PALIERS[palier].heures * 3600 } : null;
    return { ...base, offre: 'pro', ...tout, fonctions: palier ? TOUT : TOUT_PRO0, reunions, jusqua: fin.toISOString(), joursRestants: jours(fin, maintenant) };
  }

  if (!actif || c.role === 'ADMIN') return { ...base, offre: 'libre', ...tout, reunions: { cle: moisReunions(maintenant), secondes: 0, illimite: true }, jusqua: null, joursRestants: null };

  // L'essai ouvre tout (45 minutes de réunion, une fois) : une formule Finances payée pendant l'essai prend le relais à sa fin.
  const essai = finEssaiEffective(c.essaiJusqua, depuis);
  if (essai && essai > maintenant)
    return { ...base, offre: 'essai', ...tout, reunions: { cle: 'essai', secondes: ESSAI_REUNION_MINUTES * 60 }, jusqua: essai.toISOString(), joursRestants: jours(essai, maintenant), ensuite: fin ? { formule, jusqua: fin.toISOString() } : null };

  if (fin && formule === 'projets') return { ...base, offre: 'projets', pro: false, finances: false, projets: true, fonctions: TOUT_PROJETS, reunions: null, jusqua: fin.toISOString(), joursRestants: jours(fin, maintenant) };
  if (fin) return { ...base, offre: 'finances', pro: false, finances: true, projets: false, fonctions: TOUT_FINANCES, reunions: null, jusqua: fin.toISOString(), joursRestants: jours(fin, maintenant) };

  return { ...base, offre: 'gratuit', pro: false, finances: false, projets: false, reunions: null, jusqua: null, joursRestants: null, fonctions: [] };
}

/** Le compte a-t-il droit à cette fonction ? */
export const aDroit = (e: Pick<EtatAbonnement, 'fonctions'>, f: Fonction) => e.fonctions.includes(f);
/** Les options de Finances demandent une photo de profil, pour Finances, Pro et l'essai. Les admins passent toujours. */
export const photoManquante = (u: { role: string; photoUrl?: string | null }, f: Fonction) => formuleDe(f) === 'finances' && u.role !== 'ADMIN' && !u.photoUrl;

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

/** Prix d'un mois d'une formule (et de son palier), en centimes : sert à convertir le temps restant quand on change de formule ou de palier. */
const prixMois = (f: Formule, palier: Palier = 0) => prixPeriode(f, 'mensuel', palier);

/**
 * Nouvelle fin de l'abonnement après un paiement. La période part de la plus tardive de : la fin de l'essai en cours
 * (les jours d'essai ne sont pas perdus), maintenant. Le temps payé qui reste après ce départ s'y ajoute ; s'il était
 * payé pour une autre formule, il est converti au prorata des prix mensuels (un mois de Finances restant vaut
 * 3,99 / 6,99 mois de Pro, et inversement) : rien de ce qui est payé n'est perdu.
 */
export function prolonger(
  actuel: { fin?: Date | null; formule?: Formule | null; palier?: Palier } | Date | null | undefined,
  periode: Periode,
  maintenant = new Date(),
  finEssaiEnCours?: Date | null,
  formule: Formule = 'pro',
  palier: Palier = 0,
) {
  return prolongerDe(actuel, OFFRES.formules[formule][periode].mois, maintenant, finEssaiEnCours, formule, palier);
}

/** Comme `prolonger`, pour un nombre de mois quelconque (une formule offerte par l'admin). */
export function prolongerDe(
  actuel: { fin?: Date | null; formule?: Formule | null; palier?: Palier } | Date | null | undefined,
  mois: number,
  maintenant = new Date(),
  finEssaiEnCours?: Date | null,
  formule: Formule = 'pro',
  palier: Palier = 0,
) {
  const a = actuel instanceof Date || actuel == null ? { fin: actuel ?? null, formule: 'pro' as Formule, palier: 0 as Palier } : actuel;
  const depart = finEssaiEnCours && finEssaiEnCours > maintenant ? finEssaiEnCours : maintenant;
  let reste = a.fin && a.fin > depart ? a.fin.getTime() - depart.getTime() : 0;
  const avant = a.formule ?? 'pro';
  const avantPalier = avant === 'pro' ? (a.palier ?? 0) : 0;
  const apresPalier = formule === 'pro' ? palier : 0;
  if (reste && (avant !== formule || avantPalier !== apresPalier)) reste = Math.round((reste * prixMois(avant, avantPalier)) / prixMois(formule, apresPalier));
  return ajouterMois(new Date(depart.getTime() + reste), mois);
}

/** Message renvoyé (402) quand une fonction est demandée sans la formule qui l'inclut. */
export const messageReserve = (f: Fonction) =>
  formuleDe(f) === 'finances'
    ? `${FONCTIONS_FINANCES[f as FonctionFinances]} : c'est inclus dans Me Finances (et Pro). Choisis une formule dans Mon compte › Abonnement.`
    : formuleDe(f) === 'projets'
      ? `${FONCTIONS_PROJETS[f as FonctionProjets]} : c'est inclus dans Me Projets (et Pro). Choisis une formule dans Mon compte › Abonnement.`
      : f === 'reunions'
        ? `${FONCTIONS_REUNIONS.reunions} : c'est inclus dans Pro 1, Pro 2 et Pro 3. Choisis un palier dans Mon compte › Abonnement.`
        : `${FONCTIONS_PRO[f as FonctionPro]} : c'est inclus dans Me Pro. Passe à Pro depuis Mon compte › Abonnement.`;

export type AvisAbonnement = { cle: string; titre: string; corps: string; parEmail: boolean };

const SUITE =
  "Ensuite, Me reste gratuite pour l'essentiel. Finances (3,99 $ par mois) garde les finances avancées ; Projets (3,99 $ par mois) garde la gestion de projets avancée ; Pro (6,99 $ par mois) comprend les deux et ajoute le copilote IA, les comptes connectés, les équipes et les rappels par email et push ; Pro 1, 2 et 3 y ajoutent les réunions enregistrées (5, 20 ou 40 h par mois).";

/**
 * Messages liés à l'abonnement, envoyés une seule fois grâce à leur clé :
 * - fin d'essai : 3 jours avant, dans l'app (rien si une formule payée prend le relais) ;
 * - fin de la période payée : 7 jours puis 1 jour avant, dans l'app et par email (rien n'est prélevé automatiquement).
 */
export function avisAbonnement(c: ChampsAbonnement, maintenant = new Date(), actif = abonnementsActifs(), depuis = debutAbonnements()): AvisAbonnement | null {
  if (!actif) return null;
  const e = etatAbonnement(c, maintenant, actif, depuis);
  if (e.joursRestants === null || !e.jusqua) return null;
  const jour = e.jusqua.slice(0, 10);
  const quand = e.joursRestants <= 1 ? 'demain' : `dans ${e.joursRestants} jours`;
  if (e.offre === 'essai' && e.joursRestants <= 3) {
    if (e.ensuite?.formule === 'pro') return null;
    const corps = e.ensuite
      ? e.ensuite.formule === 'projets'
        ? `Ta formule Projets prend le relais : ta gestion de projets avancée reste ouverte. Les finances avancées, le copilote IA des mails, les comptes connectés, les équipes et les rappels par email et push demandent Finances ou Pro.`
        : `Ta formule Finances prend le relais : tes finances avancées restent ouvertes. Le copilote IA, les comptes connectés, les équipes et les rappels par email et push demandent Pro.`
      : `${SUITE} Pour choisir : Mon compte › Abonnement.`;
    return { cle: `abonnement:essai:${jour}`, titre: `Ton essai se termine ${quand}`, corps, parEmail: false };
  }
  if ((e.offre === 'pro' || e.offre === 'finances' || e.offre === 'projets') && e.joursRestants <= 7) {
    const palier = e.joursRestants <= 1 ? 1 : 7;
    const nom = e.offre === 'pro' ? (e.palier ? `Pro ${e.palier}` : 'Pro') : e.offre === 'projets' ? 'Projets' : 'Finances';
    return {
      cle: `abonnement:fin:${jour}:${palier}`,
      titre: `Ton abonnement ${nom} se termine ${quand}`,
      corps: `Il n'est pas renouvelé automatiquement : rien ne sera prélevé. Pour continuer, paie une nouvelle période dans Mon compte › Abonnement ; elle s'ajoutera à la fin de la période en cours. ${SUITE}`,
      parEmail: true,
    };
  }
  return null;
}
