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
