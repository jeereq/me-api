/**
 * Groupes de cotisation et anciennes collectes : périodes, échéances, commission et montants.
 * Commun au serveur et à l'app.
 */

export type RythmeCotisation = 'unique' | 'hebdomadaire' | 'mensuel';
/** Une seule période pour une collecte unique. */
export const PERIODE_UNIQUE = 'unique';

const MOIS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
const JOUR_MS = 86400000;
const enDate = (jour: string) => new Date(`${jour}T00:00:00Z`);
const enJour = (d: Date) => d.toISOString().slice(0, 10);

/** Le lundi de la semaine d'un jour « AAAA-MM-JJ ». */
function lundi(jour: string) {
  const d = enDate(jour);
  return enJour(new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * JOUR_MS));
}

/** La période d'un jour : « unique », « 2026-11 », ou le lundi de la semaine. */
export function periodeDuJour(rythme: RythmeCotisation, jour: string) {
  if (rythme === 'unique') return PERIODE_UNIQUE;
  return rythme === 'mensuel' ? jour.slice(0, 7) : lundi(jour);
}

/** Toutes les périodes du début à aujourd'hui, de la plus ancienne à la plus récente. */
export function periodesDepuis(rythme: RythmeCotisation, debut: string, jour: string): string[] {
  if (rythme === 'unique') return [PERIODE_UNIQUE];
  const fin = periodeDuJour(rythme, jour);
  const liste: string[] = [];
  if (rythme === 'mensuel') {
    let [a, m] = debut.slice(0, 7).split('-').map(Number);
    for (;;) {
      const p = `${a}-${String(m).padStart(2, '0')}`;
      if (p > fin) break;
      liste.push(p);
      m += 1;
      if (m > 12) {
        m = 1;
        a += 1;
      }
    }
    return liste;
  }
  for (let p = lundi(debut); p <= fin; p = enJour(new Date(enDate(p).getTime() + 7 * JOUR_MS))) liste.push(p);
  return liste;
}

/** « novembre 2026 », « semaine du 2 novembre », ou rien pour une collecte unique. */
export function libellePeriode(periode: string) {
  if (periode === PERIODE_UNIQUE) return '';
  const [a, m, j] = periode.split('-').map(Number);
  return j ? `semaine du ${j === 1 ? '1er' : j} ${MOIS[m - 1]}` : `${MOIS[m - 1]} ${a}`;
}

/** 1000 → « 10 USD », 1050 → « 10,50 USD », 5000000 → « 50 000 CDF ». */
export function montantCotisation(centimes: number, devise: string) {
  const [entier, decimales] = (centimes / 100).toFixed(2).split('.');
  const milliers = entier.replace(/\B(?=(\d{3})+$)/g, ' ');
  return `${milliers}${decimales === '00' ? '' : `,${decimales}`} ${devise}`;
}

/** « 10 USD par mois ». */
export function montantEtRythme(centimes: number, devise: string, rythme: RythmeCotisation) {
  return `${montantCotisation(centimes, devise)}${rythme === 'mensuel' ? ' par mois' : rythme === 'hebdomadaire' ? ' par semaine' : ''}`;
}

/** Le premier mot du nom : « Marie » pour « Marie Kabila ». */
export const prenomDe = (nom: string) => nom.trim().split(/\s+/)[0] ?? '';

/** Pour les écrans et les traces de paiement : 243•••••5678. */
export function numeroMasque(telephone: string) {
  return telephone.length < 8 ? '•••' : `${telephone.slice(0, 3)}•••••${telephone.slice(-4)}`;
}

/* Tontines : chaque tour, tous cotisent et un membre reçoit la cagnotte. */

export type RythmeTontine = 'quotidien' | 'hebdomadaire' | 'mensuel';
export type RythmeObjectif = RythmeTontine | 'unique';
/** Commission par défaut (5 %) : chaque groupe prend celle des règles de la plateforme pour sa sorte (REGLES_PLATEFORME_DEFAUT). */
export const COMMISSION_BPS = 500;

/** Pour 10 membres à 10 $ : 100 $ collectés, 5 $ de commission, 95 $ versés. Le tout en centimes. */
export function repartitionCagnotte(montant: number, membres: number, bps: number = COMMISSION_BPS) {
  const brut = montant * membres;
  const commission = Math.round((brut * bps) / 10000);
  return { brut, commission, net: brut - commission };
}

/** Les jours limites des tours : un jour, une semaine ou un mois après le précédent. Le 31 devient le dernier jour d'un mois plus court. */
export function echeancesTontine(rythme: RythmeTontine, debut: string, tours: number) {
  const d = enDate(debut);
  const jour = d.getUTCDate();
  return Array.from({ length: tours }, (_, i) => {
    const n = i + 1;
    if (rythme === 'quotidien') return enJour(new Date(d.getTime() + n * JOUR_MS));
    if (rythme === 'hebdomadaire') return enJour(new Date(d.getTime() + 7 * n * JOUR_MS));
    const fin = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n + 1, 0));
    return enJour(new Date(Date.UTC(fin.getUTCFullYear(), fin.getUTCMonth(), Math.min(jour, fin.getUTCDate()))));
  });
}

/**
 * Les échéances d'une rotation au jour fixe choisi par l'initiateur : le 5 du mois (1 à 28), ou un jour de la semaine
 * (1 lundi … 7 dimanche). La première tombe au moins 3 jours après le démarrage. Sans jour fixe : `echeancesTontine`.
 */
export function echeancesAuJour(rythme: RythmeTontine, debut: string, tours: number, jourFixe: number) {
  if (!jourFixe || rythme === 'quotidien') return echeancesTontine(rythme, debut, tours);
  const premier = enDate(debut).getTime() + 3 * JOUR_MS;
  if (rythme === 'hebdomadaire') {
    let d = premier;
    while (((new Date(d).getUTCDay() + 6) % 7) + 1 !== jourFixe) d += JOUR_MS;
    return Array.from({ length: tours }, (_, i) => enJour(new Date(d + 7 * i * JOUR_MS)));
  }
  const p = new Date(premier);
  let an = p.getUTCFullYear();
  let mois = p.getUTCMonth();
  if (Date.UTC(an, mois, jourFixe) < premier) mois++;
  return Array.from({ length: tours }, (_, i) => enJour(new Date(Date.UTC(an, mois + i, jourFixe))));
}

/** Les jours limites d'une cotisation à raison précise : selon le rythme jusqu'à la date de fin, qui reste toujours le dernier. */
export function echeancesObjectif(rythme: RythmeObjectif, debut: string, fin: string) {
  if (rythme === 'unique') return [fin];
  const dates = echeancesTontine(rythme, debut, 800).filter((d) => d < fin);
  return [...dates, fin];
}

/** Limites réglées par l'admin : montant maximum d'une cotisation, par devise, et nombre de membres d'un groupe. */
export type LimitesCotisation = { montantMax: { USD: number; CDF: number }; membresMax: number };
export const LIMITES_DEFAUT: LimitesCotisation = { montantMax: { USD: 100000, CDF: 30000000 }, membresMax: 50 };
/** La plus grosse cagnotte qu'une base en entiers 32 bits sait compter : 20 millions, en centimes. */
export const CAGNOTTE_MAX = 2000000000;
export const MEMBRES_PLAFOND = 200;

export function limitesDe(brut: unknown): LimitesCotisation {
  const b = (brut ?? {}) as { montantMax?: { USD?: unknown; CDF?: unknown }; membresMax?: unknown };
  const entier = (v: unknown, defaut: number, max: number) => (typeof v === 'number' && Number.isInteger(v) && v >= 1 ? Math.min(v, max) : defaut);
  return {
    montantMax: { USD: entier(b.montantMax?.USD, LIMITES_DEFAUT.montantMax.USD, 100000000), CDF: entier(b.montantMax?.CDF, LIMITES_DEFAUT.montantMax.CDF, 100000000) },
    membresMax: Math.max(2, entier(b.membresMax, LIMITES_DEFAUT.membresMax, MEMBRES_PLAFOND)),
  };
}

/** Rappels obligatoires d'un groupe : l'initiateur règle les jours et les canaux. L'app prévient toujours. */
export type RappelsGroupe = { avant: number[]; apres: number[]; mail: boolean; sms: boolean };
export const JOURS_AVANT = [7, 3, 1, 0];
export const JOURS_APRES = [1, 3, 7];
export const RAPPELS_DEFAUT: RappelsGroupe = { avant: [1, 0], apres: [1], mail: true, sms: true };

/** Un rappel est dû aujourd'hui ? « avant:1 », « apres:3 », ou null. */
export function rappelDuJour(r: RappelsGroupe, jour: string, echeance: string) {
  const ecart = Math.round((enDate(echeance).getTime() - enDate(jour).getTime()) / JOUR_MS);
  if (ecart >= 0) return r.avant.includes(ecart) ? `avant:${ecart}` : null;
  return r.apres.includes(-ecart) ? `apres:${-ecart}` : null;
}

/** Un réglage reçu : au moins un rappel avant l'échéance, seulement les jours proposés. */
export function rappelsDe(brut: unknown): RappelsGroupe {
  const b = (brut ?? {}) as Partial<RappelsGroupe>;
  const avant = (Array.isArray(b.avant) ? b.avant : []).filter((j) => JOURS_AVANT.includes(j));
  const apres = (Array.isArray(b.apres) ? b.apres : []).filter((j) => JOURS_APRES.includes(j));
  if (!avant.length) return { ...RAPPELS_DEFAUT, mail: b.mail !== false, sms: b.sms !== false };
  return { avant, apres, mail: b.mail !== false, sms: b.sms !== false };
}

/** « 10 USD par mois », « par jour », « par semaine », « une fois ». */
export function montantTontine(centimes: number, devise: string, rythme: RythmeObjectif) {
  const quand = { mensuel: 'par mois', hebdomadaire: 'par semaine', quotidien: 'par jour', unique: 'une fois' }[rythme];
  return `${montantCotisation(centimes, devise)} ${quand}`;
}

/* Règles d'un groupe, choisies par l'organisateur avant le démarrage. */

export type OrdreTours = 'tirage' | 'arrivee' | 'organisateur';
export type ReglesGroupe = {
  /** L'organisateur peut noter une cotisation payée en espèces (groupe privé seulement). */
  especes: boolean;
  /** Pénalité par cotisation payée en retard, en centimes ; `grace` : jours de tolérance après l'échéance. */
  penalite: { montant: number; grace: number };
  /** Ordre de réception : tirage au sort, ordre d'arrivée dans le groupe, ou choisi par l'organisateur. */
  ordre: OrdreTours;
  /** Retards au-delà desquels l'organisateur est prévenu et peut exclure (0 : jamais). */
  exclusion: { retards: number };
  /** Entrée : acceptée d'office (annuaire), compte approuvé exigé (invitation), retards permis dans les autres groupes (-1 : sans limite). */
  entree: { automatique: boolean; compteApprouve: boolean; retardsMax: number };
  /** Jour fixe des échéances d'une rotation (0 : selon le démarrage ; 1-28 du mois, ou 1-7 lundi-dimanche) et heure limite (-1 : fin de journée). */
  echeance: { jour: number; heure: number };
};
/** Des règles reçues ou en cours de saisie : chaque partie peut manquer. */
export type ReglesPartielles = { especes?: boolean; penalite?: Partial<ReglesGroupe['penalite']>; ordre?: OrdreTours; exclusion?: Partial<ReglesGroupe['exclusion']>; entree?: Partial<ReglesGroupe['entree']>; echeance?: Partial<ReglesGroupe['echeance']> };
export const REGLES_DEFAUT: ReglesGroupe = { especes: false, penalite: { montant: 0, grace: 0 }, ordre: 'tirage', exclusion: { retards: 0 }, entree: { automatique: false, compteApprouve: false, retardsMax: -1 }, echeance: { jour: 0, heure: -1 } };
export const GRACES = [0, 1, 2, 3, 7];
export const SEUILS_EXCLUSION = [0, 2, 3, 5];
export const RETARDS_MAX = [-1, 0, 1, 3];
/** Heures limites proposées : fin de journée, midi, 15 h, 18 h, 20 h. */
export const HEURES_LIMITE = [-1, 12, 15, 18, 20];
export const JOURS_DU_MOIS = [0, 1, 5, 10, 15, 20, 25, 28];
export const JOURS_SEMAINE = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'];
const entier = (v: unknown, min: number, max: number, defaut: number) => (typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : defaut);

/**
 * Des règles reçues, ramenées à ce qui est permis : les espèces seulement dans un groupe privé (dans l'annuaire, Me garantit
 * les paiements), l'entrée d'office seulement dans l'annuaire, une pénalité d'au plus une cotisation.
 */
export function reglesDe(brut: unknown, g: { visibilite: 'public' | 'prive'; montant: number; rythme?: string; mode?: string }): ReglesGroupe {
  const b = (brut ?? {}) as ReglesPartielles;
  const prive = g.visibilite === 'prive';
  const jour = b.echeance?.jour as number;
  const jourPermis = g.mode === 'objectif' ? false : g.rythme === 'mensuel' ? JOURS_DU_MOIS.includes(jour) : g.rythme === 'hebdomadaire' ? Number.isInteger(jour) && jour >= 0 && jour <= 7 : false;
  return {
    especes: prive && b.especes === true,
    penalite: { montant: entier(b.penalite?.montant, 0, Math.max(0, g.montant), 0), grace: GRACES.includes(b.penalite?.grace as number) ? (b.penalite!.grace as number) : 0 },
    ordre: b.ordre === 'arrivee' || b.ordre === 'organisateur' ? b.ordre : 'tirage',
    exclusion: { retards: SEUILS_EXCLUSION.includes(b.exclusion?.retards as number) ? (b.exclusion!.retards as number) : 0 },
    entree: {
      automatique: !prive && b.entree?.automatique === true,
      compteApprouve: prive && b.entree?.compteApprouve === true,
      retardsMax: RETARDS_MAX.includes(b.entree?.retardsMax as number) ? (b.entree!.retardsMax as number) : -1,
    },
    echeance: { jour: jourPermis ? jour : 0, heure: HEURES_LIMITE.includes(b.echeance?.heure as number) ? (b.echeance!.heure as number) : -1 },
  };
}

/**
 * Une cotisation est-elle en retard à cet instant (jour et heure du groupe) ? Après le jour limite, ou le jour même
 * passée l'heure limite. `grace` ajoute des jours de tolérance (pénalités).
 */
export function apresLimite(r: Pick<ReglesGroupe, 'echeance'>, echeance: string, jour: string, heure = '00:00', grace = 0) {
  const limite = grace ? enJour(new Date(enDate(echeance).getTime() + grace * JOUR_MS)) : echeance;
  if (jour !== limite) return jour > limite;
  return r.echeance.heure >= 0 && heure >= `${String(r.echeance.heure).padStart(2, '0')}:00`;
}

/** « avant le 5 décembre à 18 h », « avant 18 h ». */
export const texteHeure = (r: Pick<ReglesGroupe, 'echeance'>) => (r.echeance.heure >= 0 ? ` à ${r.echeance.heure} h` : '');

/** La pénalité due pour une cotisation payée le `jour` (à l'`heure`) : après l'échéance, l'heure limite et les jours de grâce. */
export function penaliteDue(r: ReglesGroupe, echeance: string, jour: string, heure = '00:00') {
  if (!r.penalite.montant) return 0;
  return apresLimite(r, echeance, jour, heure, r.penalite.grace) ? r.penalite.montant : 0;
}

/** Les règles en phrases courtes, pour les membres et l'annuaire. */
export function texteRegles(r: ReglesGroupe, devise: string, rythme?: string): string[] {
  const l: string[] = [];
  l.push(r.ordre === 'arrivee' ? 'Ordre des tours : ordre d’arrivée dans le groupe.' : r.ordre === 'organisateur' ? 'Ordre des tours : choisi par l’organisateur.' : 'Ordre des tours : tiré au sort au démarrage.');
  if (r.penalite.montant) l.push(`Retard : ${montantCotisation(r.penalite.montant, devise)} de pénalité${r.penalite.grace ? ` après ${r.penalite.grace} jour${r.penalite.grace > 1 ? 's' : ''} de grâce` : ''}, versés au bénéficiaire du tour.`);
  if (r.exclusion.retards) l.push(`Après ${r.exclusion.retards} retards, l’organisateur peut exclure le membre.`);
  if (r.especes) l.push('Paiement en espèces accepté, noté par l’organisateur.');
  if (r.entree.automatique) l.push('Demandes acceptées d’office.');
  if (r.entree.compteApprouve) l.push('Compte approuvé par Me exigé pour entrer.');
  if (r.echeance.jour) l.push(`Échéance fixe : ${rythme !== 'hebdomadaire' ? `le ${r.echeance.jour === 1 ? '1er' : r.echeance.jour} du mois` : `chaque ${JOURS_SEMAINE[r.echeance.jour - 1]}`}${texteHeure(r)}.`);
  else if (r.echeance.heure >= 0) l.push(`Paiement avant ${r.echeance.heure} h le jour de l’échéance.`);
  if (r.entree.retardsMax >= 0) l.push(r.entree.retardsMax ? `Au plus ${r.entree.retardsMax} retard${r.entree.retardsMax > 1 ? 's' : ''} dans d’autres groupes pour entrer.` : 'Aucun retard dans d’autres groupes pour entrer.');
  return l;
}

/* Règles de la plateforme, fixées par l'admin pour chaque sorte de groupe : sur invitation ou dans l'annuaire. */

export type Visibilite = 'public' | 'prive';
export type ReglesPlateformeType = {
  /** Commission de Me en points de base (500 = 5 %), figée à la création de chaque groupe. */
  commissionBps: number;
  /** Qui lance les demandes de paiement mobile money : l'initiateur seul, ou aussi chaque membre. */
  demandes: 'initiateur' | 'tous';
  /** Caution obligatoire pour une rotation. */
  cautionObligatoire: boolean;
  /** L'initiateur peut accepter les espèces (groupes sur invitation seulement). */
  especes: boolean;
  /** Compte approuvé par Me exigé pour entrer (toujours vrai dans l'annuaire). */
  compteApprouve: boolean;
  /** Pénalité de retard au plus, en pourcentage de la cotisation. */
  penaliteMaxPct: number;
  /** Retards permis dans d'autres groupes pour entrer, imposé à tous les groupes (-1 : pas de limite imposée). */
  retardsMax: number;
};
export type Devise = 'USD' | 'CDF';
export const DEVISES: Devise[] = ['USD', 'CDF'];
export type ParDevise = Record<Devise, number>;
export const RYTHMES: RythmeObjectif[] = ['quotidien', 'hebdomadaire', 'mensuel', 'unique'];
/** Limites d'une sorte de groupe : cotisation au moins et au plus (par rythme et par devise), membres, durée d'une raison précise. */
export type LimitesType = { montantMin: ParDevise; montantMax: Record<RythmeObjectif, ParDevise>; membresMax: number; dureeMaxMois: number };
/** Le niveau d'un compte : non approuvé, approuvé par Me, ou abonné Pro. */
export type NiveauCompte = 'standard' | 'approuve' | 'pro';
export const NIVEAUX: NiveauCompte[] = ['standard', 'approuve', 'pro'];
/** Par niveau : groupes en cours au plus, et cotisation au plus d'un groupe qu'on crée ou rejoint. */
export type LimiteNiveau = { groupesMax: number; montantMax: ParDevise };
export type ReglesPlateforme = Record<Visibilite, ReglesPlateformeType & { limites: LimitesType }> & { niveaux: Record<NiveauCompte, LimiteNiveau> };
/** Groupes en cours par personne, au plus, quel que soit le niveau. */
export const GROUPES_PLAFOND = 20;
export const DUREE_MAX_MOIS = 36;
const limitesTypeDefaut = (l: LimitesCotisation = LIMITES_DEFAUT): LimitesType => ({
  montantMin: { USD: 100, CDF: 100000 },
  montantMax: Object.fromEntries(RYTHMES.map((r) => [r, { ...l.montantMax }])) as LimitesType['montantMax'],
  membresMax: l.membresMax,
  dureeMaxMois: 12,
});
const niveauxDefaut = (l: LimitesCotisation = LIMITES_DEFAUT): Record<NiveauCompte, LimiteNiveau> => ({
  standard: { groupesMax: GROUPES_PLAFOND, montantMax: { ...l.montantMax } },
  approuve: { groupesMax: GROUPES_PLAFOND, montantMax: { ...l.montantMax } },
  pro: { groupesMax: GROUPES_PLAFOND, montantMax: { ...l.montantMax } },
});
export const REGLES_PLATEFORME_DEFAUT: ReglesPlateforme = {
  prive: { commissionBps: 500, demandes: 'initiateur', cautionObligatoire: false, especes: true, compteApprouve: false, penaliteMaxPct: 100, retardsMax: -1, limites: limitesTypeDefaut() },
  public: { commissionBps: 1000, demandes: 'initiateur', cautionObligatoire: true, especes: false, compteApprouve: true, penaliteMaxPct: 100, retardsMax: -1, limites: limitesTypeDefaut() },
  niveaux: niveauxDefaut(),
};
/** 20 % au plus : au-delà, la cagnotte ne vaut plus la peine. */
export const COMMISSION_MAX_BPS = 2000;
export const PENALITES_MAX_PCT = [0, 10, 25, 50, 100];

const montant = (v: unknown, defaut: number) => entier(v, 1, 100000000, defaut);
const parDevise = (v: unknown, d: ParDevise): ParDevise => {
  const x = (v ?? {}) as Partial<ParDevise>;
  return { USD: montant(x.USD, d.USD), CDF: montant(x.CDF, d.CDF) };
};

/**
 * Les règles enregistrées par l'admin, ramenées à ce qui est permis. Dans l'annuaire : jamais d'espèces, compte toujours
 * approuvé. `anciennes` : les limites d'avant (montant max par devise, membres), qui servent de valeurs par défaut.
 */
export function reglesPlateformeDe(brut: unknown, anciennes: LimitesCotisation = LIMITES_DEFAUT): ReglesPlateforme {
  const b = (brut ?? {}) as Partial<Record<Visibilite, Partial<ReglesPlateformeType> & { limites?: Partial<LimitesType> }> & { niveaux?: Partial<Record<NiveauCompte, Partial<LimiteNiveau>>> }>;
  const lim = (x: Partial<LimitesType> | undefined): LimitesType => {
    const d = limitesTypeDefaut(anciennes);
    const min = parDevise(x?.montantMin, d.montantMin);
    const max = Object.fromEntries(RYTHMES.map((r) => {
      const m = parDevise(x?.montantMax?.[r], d.montantMax[r]);
      return [r, { USD: Math.max(m.USD, min.USD), CDF: Math.max(m.CDF, min.CDF) }];
    })) as LimitesType['montantMax'];
    return { montantMin: min, montantMax: max, membresMax: Math.max(2, entier(x?.membresMax, 2, MEMBRES_PLAFOND, d.membresMax)), dureeMaxMois: entier(x?.dureeMaxMois, 1, DUREE_MAX_MOIS, d.dureeMaxMois) };
  };
  const nd = niveauxDefaut(anciennes);
  const niveaux = Object.fromEntries(NIVEAUX.map((n) => [n, { groupesMax: entier(b.niveaux?.[n]?.groupesMax, 1, GROUPES_PLAFOND, nd[n].groupesMax), montantMax: parDevise(b.niveaux?.[n]?.montantMax, nd[n].montantMax) }])) as Record<NiveauCompte, LimiteNiveau>;
  const un = (v: Visibilite): ReglesPlateformeType & { limites: LimitesType } => {
    const x = b[v] ?? {};
    const d = REGLES_PLATEFORME_DEFAUT[v];
    return {
      commissionBps: entier(x.commissionBps, 0, COMMISSION_MAX_BPS, d.commissionBps),
      demandes: x.demandes === 'tous' || x.demandes === 'initiateur' ? x.demandes : d.demandes,
      cautionObligatoire: v === 'public' ? x.cautionObligatoire !== false : x.cautionObligatoire === true,
      especes: v === 'prive' && (x.especes ?? d.especes) === true,
      compteApprouve: v === 'public' || x.compteApprouve === true,
      penaliteMaxPct: PENALITES_MAX_PCT.includes(x.penaliteMaxPct as number) ? (x.penaliteMaxPct as number) : d.penaliteMaxPct,
      retardsMax: RETARDS_MAX.includes(x.retardsMax as number) ? (x.retardsMax as number) : d.retardsMax,
      limites: lim(x.limites),
    };
  };
  return { prive: un('prive'), public: un('public'), niveaux };
}

/** Ce qu'un groupe peut être, pour cette sorte, ce rythme, cette devise et le niveau de la personne. */
export function bornesGroupe(p: ReglesPlateforme, c: { visibilite: Visibilite; rythme: RythmeObjectif; devise: string }, niveau?: NiveauCompte) {
  const l = p[c.visibilite].limites;
  const dv = (c.devise === 'CDF' ? 'CDF' : 'USD') as Devise;
  const max = Math.min(l.montantMax[c.rythme][dv], niveau ? p.niveaux[niveau].montantMax[dv] : Infinity);
  return { montantMin: l.montantMin[dv], montantMax: max, membresMax: l.membresMax, dureeMaxMois: l.dureeMaxMois, groupesMax: niveau ? p.niveaux[niveau].groupesMax : GROUPES_PLAFOND };
}

const NOM_NIVEAU: Record<NiveauCompte, string> = { standard: 'un compte non approuvé', approuve: 'un compte approuvé', pro: 'un compte Pro' };
export const libelleNiveau = (n: NiveauCompte) => ({ standard: 'Compte non approuvé', approuve: 'Compte approuvé', pro: 'Abonné Pro' })[n];
export const libelleRythme = (r: RythmeObjectif) => ({ quotidien: 'Par jour', hebdomadaire: 'Par semaine', mensuel: 'Par mois', unique: 'Une fois' })[r];

/**
 * Ce qui empêche ce groupe d'être créé (ou rejoint, sans `places` ni `dateFin`) : un message clair, ou null.
 * `jour` : aujourd'hui, pour la durée d'une raison précise.
 */
export function horsLimites(p: ReglesPlateforme, c: { visibilite: Visibilite; rythme: RythmeObjectif; devise: string; montant: number; places?: number; dateFin?: string | null; jour?: string }, niveau?: NiveauCompte): string | null {
  const b = bornesGroupe(p, c);
  const sorte = c.visibilite === 'public' ? 'dans l’annuaire' : 'sur invitation';
  if (c.montant < b.montantMin) return `Cotisation d’au moins ${montantCotisation(b.montantMin, c.devise)} pour un groupe ${sorte}.`;
  if (c.montant > b.montantMax) return `Cotisation d’au plus ${montantCotisation(b.montantMax, c.devise)} ${libelleRythme(c.rythme).toLowerCase()} pour un groupe ${sorte}.`;
  if (niveau) {
    const n = p.niveaux[niveau];
    const dv = (c.devise === 'CDF' ? 'CDF' : 'USD') as Devise;
    if (c.montant > n.montantMax[dv]) return `Avec ${NOM_NIVEAU[niveau]}, la cotisation va jusqu’à ${montantCotisation(n.montantMax[dv], c.devise)}.${niveau === 'standard' ? ' Fais approuver ton compte pour aller plus haut.' : ''}`;
  }
  if (c.places !== undefined && c.places > b.membresMax) return `Un groupe ${sorte} compte au plus ${b.membresMax} membres.`;
  if (c.dateFin && c.jour) {
    const d = enDate(c.jour);
    const fin = enJour(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + b.dureeMaxMois, d.getUTCDate())));
    if (c.dateFin > fin) return `Une cotisation ${sorte} dure au plus ${b.dureeMaxMois} mois : choisis une date de fin avant le ${fin.split('-').reverse().join('/')}.`;
  }
  return null;
}

/** Le plafond de groupes en cours pour ce niveau : un message, ou null. */
export function tropDeGroupes(p: ReglesPlateforme, niveau: NiveauCompte, enCours: number): string | null {
  const max = p.niveaux[niveau].groupesMax;
  return enCours >= max ? `Avec ${NOM_NIVEAU[niveau]}, ${max} groupe${max > 1 ? 's' : ''} en cours au plus.${niveau === 'standard' ? ' Fais approuver ton compte pour en rejoindre plus.' : ''}` : null;
}

/** Les règles d'un groupe, dans le cadre fixé par la plateforme pour sa sorte. */
export function reglesDansLeCadre(r: ReglesGroupe, p: ReglesPlateformeType, montant: number): ReglesGroupe {
  const penaliteMax = Math.floor((montant * p.penaliteMaxPct) / 100);
  const retardsMax = p.retardsMax < 0 ? r.entree.retardsMax : r.entree.retardsMax < 0 ? p.retardsMax : Math.min(r.entree.retardsMax, p.retardsMax);
  return {
    ...r,
    especes: r.especes && p.especes,
    penalite: { ...r.penalite, montant: Math.min(r.penalite.montant, penaliteMax) },
    entree: { ...r.entree, compteApprouve: r.entree.compteApprouve || p.compteApprouve, retardsMax },
  };
}

/** « 5 % », « 7,5 % ». */
export const tauxCommission = (bps: number) => `${String(bps / 100).replace('.', ',')} %`;
