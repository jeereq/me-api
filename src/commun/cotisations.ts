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
/** Commission de la plateforme : 5 %, retenus sur la cagnotte. */
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
};
export const REGLES_DEFAUT: ReglesGroupe = { especes: false, penalite: { montant: 0, grace: 0 }, ordre: 'tirage', exclusion: { retards: 0 }, entree: { automatique: false, compteApprouve: false, retardsMax: -1 } };
export const GRACES = [0, 1, 2, 3, 7];
export const SEUILS_EXCLUSION = [0, 2, 3, 5];
export const RETARDS_MAX = [-1, 0, 1, 3];
const entier = (v: unknown, min: number, max: number, defaut: number) => (typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : defaut);

/**
 * Des règles reçues, ramenées à ce qui est permis : les espèces seulement dans un groupe privé (dans l'annuaire, Me garantit
 * les paiements), l'entrée d'office seulement dans l'annuaire, une pénalité d'au plus une cotisation.
 */
export function reglesDe(brut: unknown, g: { visibilite: 'public' | 'prive'; montant: number }): ReglesGroupe {
  const b = (brut ?? {}) as Partial<ReglesGroupe> & { penalite?: Partial<ReglesGroupe['penalite']>; exclusion?: Partial<ReglesGroupe['exclusion']>; entree?: Partial<ReglesGroupe['entree']> };
  const prive = g.visibilite === 'prive';
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
  };
}

/** La pénalité due pour une cotisation payée le `jour` : après l'échéance et les jours de grâce. */
export function penaliteDue(r: ReglesGroupe, echeance: string, jour: string) {
  if (!r.penalite.montant) return 0;
  const limite = enJour(new Date(enDate(echeance).getTime() + r.penalite.grace * JOUR_MS));
  return jour > limite ? r.penalite.montant : 0;
}

/** Les règles en phrases courtes, pour les membres et l'annuaire. */
export function texteRegles(r: ReglesGroupe, devise: string): string[] {
  const l: string[] = [];
  l.push(r.ordre === 'arrivee' ? 'Ordre des tours : ordre d’arrivée dans le groupe.' : r.ordre === 'organisateur' ? 'Ordre des tours : choisi par l’organisateur.' : 'Ordre des tours : tiré au sort au démarrage.');
  if (r.penalite.montant) l.push(`Retard : ${montantCotisation(r.penalite.montant, devise)} de pénalité${r.penalite.grace ? ` après ${r.penalite.grace} jour${r.penalite.grace > 1 ? 's' : ''} de grâce` : ''}, versés au bénéficiaire du tour.`);
  if (r.exclusion.retards) l.push(`Après ${r.exclusion.retards} retards, l’organisateur peut exclure le membre.`);
  if (r.especes) l.push('Paiement en espèces accepté, noté par l’organisateur.');
  if (r.entree.automatique) l.push('Demandes acceptées d’office.');
  if (r.entree.compteApprouve) l.push('Compte approuvé par Me exigé pour entrer.');
  if (r.entree.retardsMax >= 0) l.push(r.entree.retardsMax ? `Au plus ${r.entree.retardsMax} retard${r.entree.retardsMax > 1 ? 's' : ''} dans d’autres groupes pour entrer.` : 'Aucun retard dans d’autres groupes pour entrer.');
  return l;
}
