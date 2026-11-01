/**
 * Où en sont les budgets, et les alertes qui en découlent, repris de l'app (me-mobile/src/lib/previsions.ts et finances.ts).
 * Un budget se suit sur sa propre période (le jour, la semaine, le mois… qui contient la date, ou toute la durée d'une
 * enveloppe) : son montant, restes reportés compris, moins les dépenses notées et rangées dedans. Rien n'est supposé :
 * ni budget du jour tiré d'un budget au mois, ni rythme prolongé jusqu'à la fin de la période.
 * Dates en texte « AAAA-MM-JJ », calculées en UTC : le fuseau du serveur n'intervient pas.
 */

import type { ObjectifRappel } from './objectifs.js';

type Periode = 'jour' | 'semaine' | 'mois' | 'trimestre' | 'annee';
export type Horizon = Periode;
type Budget = { id: string; nom: string; emoji: string; montant: number; periode: Periode; global?: boolean; /** Catégories suivies : une dépense de l'une d'elles va dans ce budget si elle n'en a pas choisi un. */ categories?: string[]; /** Premier et dernier jour où le budget compte (facultatifs). */ debut?: string; fin?: string; /** Le montant couvre toute la durée `debut`–`fin` au lieu de revenir chaque période. */ enveloppe?: boolean };
type Depense = { id: string; montant: number; budget: string | null; categories?: string[]; date: string; /** Moitié d'un virement entre deux comptes de l'utilisateur : ce n'est pas une dépense. */ lien?: string };
export type AlertesFinances = { horizons?: Partial<Record<Horizon, boolean>>; seuil?: number; heure?: string; matin?: boolean; push?: boolean; email?: boolean; objectifs?: boolean };
/** Un budget sur une période précise (le jour, la semaine, le mois qui commence à `debut`). */
type CaseBudget = { budget: string; periode: Periode; debut: string };
/** Reste non dépensé reporté par l'utilisateur sur une autre période ou versé sur un objectif (me-mobile/src/lib/reports.ts). */
type Report = { id: string; montant: number; de: CaseBudget; vers: CaseBudget | { objectif: string } };
export type FinancesRappels = { devise?: string; budgets?: Budget[]; depenses?: Depense[]; alertes?: AlertesFinances; objectifs?: ObjectifRappel[]; reports?: Report[] };
type Etat = 'ok' | 'risque' | 'depasse';

const pad = (n: number) => String(n).padStart(2, '0');
const parse = (s: string) => new Date(`${s}T00:00:00Z`);
const ymd = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const addDays = (s: string, n: number) => {
  const d = parse(s);
  d.setUTCDate(d.getUTCDate() + n);
  return ymd(d);
};
const jours = (a: string, b: string) => Math.round((parse(b).getTime() - parse(a).getTime()) / 864e5) + 1;
const arrondi = (n: number) => Math.round(n * 100) / 100;

export const TITRES: Record<Horizon, string> = { jour: 'du jour', semaine: 'de la semaine', mois: 'du mois', trimestre: 'du trimestre', annee: "de l'année" };

export function bornes(p: Periode, d: string) {
  const x = parse(d);
  if (p === 'jour') return { debut: d, fin: d };
  if (p === 'semaine') {
    const debut = addDays(d, -((x.getUTCDay() + 6) % 7));
    return { debut, fin: addDays(debut, 6) };
  }
  const mois = p === 'mois' ? x.getUTCMonth() : p === 'trimestre' ? x.getUTCMonth() - (x.getUTCMonth() % 3) : 0;
  const duree = p === 'mois' ? 1 : p === 'trimestre' ? 3 : 12;
  return { debut: ymd(new Date(Date.UTC(x.getUTCFullYear(), mois, 1))), fin: ymd(new Date(Date.UTC(x.getUTCFullYear(), mois + duree, 0))) };
}

const etatBudget = (b: Budget, d: string) => (b.fin && b.fin < d ? 'termine' : b.debut && b.debut > d ? 'a_venir' : 'en_cours');

/**
 * La période d'un budget qui contient `d`, bornée par ses dates : toute la durée d'une enveloppe, sinon le jour,
 * la semaine, le mois… de sa périodicité. null si le budget ne court pas ce jour-là. Même règle que l'app (finances.ts, `fenetre`).
 */
export function fenetre(b: Budget, d: string): { debut: string; fin: string } | null {
  if (etatBudget(b, d) !== 'en_cours') return null;
  if (b.enveloppe && b.debut && b.fin) return { debut: b.debut, fin: b.fin };
  const p = bornes(b.periode, d);
  return { debut: b.debut && b.debut > p.debut ? b.debut : p.debut, fin: b.fin && b.fin < p.fin ? b.fin : p.fin };
}

/* Restes reportés : même calcul que l'app (finances.ts, `ajustementReports`). */

type Mouvement = { c: CaseBudget; m: number };
/** Ce que les reports retirent (départ) et ajoutent (arrivée) à chaque budget. Un report vers un objectif ne compte que tant que son versement existe. */
function mouvementsReports(f: FinancesRappels): Map<string, Mouvement[]> {
  const verses = new Set((f.objectifs ?? []).flatMap((o) => (o.versements ?? []).map((v) => v.report).filter(Boolean)));
  const out = new Map<string, Mouvement[]>();
  const ajouter = (c: CaseBudget, m: number) => out.set(c.budget, [...(out.get(c.budget) ?? []), { c, m }]);
  for (const r of f.reports ?? []) {
    if (!(r.montant > 0) || !r.de?.budget || !r.vers) continue;
    if ('objectif' in r.vers) {
      if (!verses.has(r.id)) continue;
    } else ajouter(r.vers, r.montant);
    ajouter(r.de, -r.montant);
  }
  return out;
}
/** Part d'une période reportée qui tombe dans les jours `debut`–`fin`, au prorata des jours. */
function partCase(c: CaseBudget, debut: string, fin: string) {
  const z0 = bornes(c.periode, c.debut).fin;
  const a = c.debut > debut ? c.debut : debut;
  const z = z0 < fin ? z0 : fin;
  return a > z ? 0 : jours(a, z) / jours(c.debut, z0);
}
const ajustement = (mv: Mouvement[] | undefined, debut: string, fin: string) => arrondi((mv ?? []).reduce((s, x) => s + x.m * partCase(x.c, debut, fin), 0));

/**
 * Le budget d'une dépense : celui choisi à la main, sinon le premier budget (hors global) qui suit l'une de ses catégories.
 * Même règle que l'app (me-mobile/src/lib/categories.ts, `idBudgetDe`).
 */
export function idBudgetDe(budgets: Budget[], d: { budget?: string | null; categories?: string[]; date?: string }): string | null {
  if (d.budget) {
    const b = budgets.find((x) => x.id === d.budget && !x.global);
    if (b) return b.id;
  }
  if (!d.categories?.length) return null;
  // Un budget daté ne suit ses catégories que pendant ses dates.
  const actif = (b: Budget) => !d.date || ((!b.debut || d.date >= b.debut) && (!b.fin || d.date <= b.fin));
  return budgets.find((b) => !b.global && actif(b) && b.categories?.some((c) => d.categories!.includes(c)))?.id ?? null;
}

const RANG: Record<Periode, number> = { jour: 0, semaine: 1, mois: 2, trimestre: 3, annee: 4 };

/** La même période, n fois plus tard (même règle que l'app, finances.ts `decaler`). */
function decaler(p: Periode, d: string, n: number) {
  if (!n) return d;
  if (p === 'jour') return addDays(d, n);
  if (p === 'semaine') return addDays(d, 7 * n);
  const x = parse(bornes(p, d).debut);
  const mois = p === 'mois' ? 1 : p === 'trimestre' ? 3 : 12;
  return ymd(new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + mois * n, 1)));
}

/**
 * Les dépenses qui comptent : ni les moitiés de virement entre deux comptes (`lien`), ni les dépenses comptées comme
 * versement vers un objectif (de l'argent mis de côté). Même règle que l'app (finances.ts, `depensesEntre`).
 */
export function depensesComptees(f: FinancesRappels): Depense[] {
  const epargne = new Set((f.objectifs ?? []).flatMap((o) => (o.versements ?? []).map((v) => v.depense).filter((x): x is string => !!x)));
  return (f.depenses || []).filter((x) => !x.lien && !epargne.has(x.id));
}

/** Un budget dans une période affichée : son montant et ce qui y est dépensé, sur sa propre période (ou la somme de ses périodes). */
export type LigneBilan = { budget: Budget; debut: string; fin: string; plafond: number; depense: number; /** Nombre de ses périodes additionnées (7 pour un budget par jour vu sur la semaine), 1 sinon. */ nb: number };
export type BilanCommun = { debut: string; fin: string; lignes: LigneBilan[]; /** Les lignes qui comptent dans les totaux. */ comptees: LigneBilan[]; plafondTotal: number; compte: number };

/**
 * Les budgets d'une période affichée (`vue` qui contient `ref`), exactement comme l'écran Finances (finances.ts, `bilan`) :
 * - un budget de la même durée se compte sur cette période ;
 * - un budget plus court s'additionne : un budget par jour vu sur la semaine compte ses 7 jours, un budget à la semaine
 *   vu sur le mois compte les semaines qui commencent dans le mois ;
 * - un budget plus long n'y est pas ;
 * - une enveloppe se compte sur toute sa durée, mais n'entre dans les totaux que si elle tient dans la période.
 * Total : le budget « toutes les dépenses » s'il existe, sinon la somme des autres budgets.
 */
export function bilan(f: FinancesRappels, vue: Periode, ref: string, aujourdhui: string): BilanCommun {
  const { debut, fin } = bornes(vue, ref);
  const budgets = f.budgets || [];
  const dep = depensesComptees(f);
  const rep = mouvementsReports(f);
  const r0 = aujourdhui >= debut && aujourdhui <= fin ? aujourdhui : aujourdhui < debut ? debut : fin;
  const lignes: LigneBilan[] = [];
  const depense = (b: Budget, w: { debut: string; fin: string }) => dep.filter((x) => x.date >= w.debut && x.date <= w.fin && (b.global || idBudgetDe(budgets, x) === b.id)).reduce((s, x) => s + x.montant, 0);
  const ajouter = (b: Budget, fenetres: { debut: string; fin: string }[]) => {
    if (!fenetres.length) return;
    const plafond = arrondi(fenetres.reduce((s, w) => s + arrondi(b.montant + ajustement(rep.get(b.id), w.debut, w.fin)), 0));
    const d = arrondi(fenetres.reduce((s, w) => s + arrondi(depense(b, w)), 0));
    lignes.push({ budget: b, debut: fenetres[0].debut, fin: fenetres[fenetres.length - 1].fin, plafond, depense: d, nb: fenetres.length });
  };
  for (const b of budgets) {
    if (b.enveloppe || b.periode === vue) {
      const r = b.debut && b.debut > r0 ? b.debut : b.fin && b.fin < r0 ? b.fin : r0;
      const w = r >= debut && r <= fin ? fenetre(b, r) : null;
      if (w) ajouter(b, [w]);
    } else if (RANG[b.periode] < RANG[vue]) {
      const fenetres: { debut: string; fin: string }[] = [];
      let x = bornes(b.periode, debut).debut;
      if (x < debut) x = decaler(b.periode, x, 1);
      for (let i = 0; x <= fin && i < 400; i++, x = decaler(b.periode, x, 1)) {
        const pf = bornes(b.periode, x);
        const a = b.debut && b.debut > pf.debut ? b.debut : pf.debut;
        const z = b.fin && b.fin < pf.fin ? b.fin : pf.fin;
        if (a <= z) fenetres.push({ debut: a, fin: z });
      }
      ajouter(b, fenetres);
    }
  }
  const global = lignes.find((l) => l.budget.global);
  const autres = lignes.filter((l) => !l.budget.global && (!l.budget.enveloppe || (l.debut >= debut && l.fin <= fin)));
  return {
    debut,
    fin,
    lignes,
    comptees: global ? [global] : autres,
    plafondTotal: global ? global.plafond : arrondi(autres.reduce((s, l) => s + l.plafond, 0)),
    compte: global ? global.depense : arrondi(autres.reduce((s, l) => s + l.depense, 0)),
  };
}

export type Prevision = {
  horizon: Horizon;
  /** Le total est celui d'un budget « toutes les dépenses » ; sinon c'est la somme des budgets de catégorie. */
  global: boolean;
  /** Premier jour de la période suivie (celle du budget global s'il y en a un). */
  debut: string;
  plafond: number;
  depense: number;
  reste: number;
  etat: Etat;
  /** Budgets de catégorie de cette durée presque atteints ou dépassés, le plus en difficulté d'abord. */
  budgets: { id: string; nom: string; emoji: string; debut: string; plafond: number; depense: number; reste: number; etat: Etat }[];
};

/**
 * Où en sont les budgets de la période `horizon` qui contient `d` : le même total que l'écran Finances pour cette
 * période (voir `bilan`). Les budgets à surveiller sont ceux de cette durée (ou une enveloppe de cette durée) :
 * un budget à la semaine se surveille dans l'horizon Semaine, pas une seconde fois dans le mois.
 * `seuil` : part du budget à partir de laquelle il est « presque atteint » (1 = atteint). null sans budget sur la période.
 */
export function prevision(f: FinancesRappels, horizon: Horizon, d: string, seuil = 1): Prevision | null {
  const b = bilan(f, horizon, d, d);
  if (!b.comptees.length) return null;
  const etat = (x: number, pl: number): Etat => (x > pl ? 'depasse' : x > 0 && x >= seuil * pl ? 'risque' : 'ok');
  const g = b.lignes.find((l) => l.budget.global);
  const lignes = b.lignes
    .filter((l) => !l.budget.global && l.budget.periode === horizon && l.nb === 1)
    .map((l) => ({ id: l.budget.id, nom: l.budget.nom, emoji: l.budget.emoji, debut: l.debut, plafond: l.plafond, depense: l.depense, reste: arrondi(l.plafond - l.depense), etat: etat(l.depense, l.plafond) }))
    .filter((x) => x.etat !== 'ok')
    .sort((x, y) => y.depense / (y.plafond || 1) - x.depense / (x.plafond || 1));
  return { horizon, global: !!g, debut: g?.debut ?? b.debut, plafond: b.plafondTotal, depense: b.compte, reste: arrondi(b.plafondTotal - b.compte), etat: etat(b.compte, b.plafondTotal), budgets: lignes };
}

/** Ce qui reste sur les budgets du mois qui contient `d`, comme l'accueil et l'écran Finances (vue Mois). null sans budget ce mois-là. */
export function resteDesBudgets(f: FinancesRappels, d: string): number | null {
  const b = bilan(f, 'mois', d, d);
  return b.comptees.length ? arrondi(b.plafondTotal - b.compte) : null;
}

export const montant = (n: number, devise: string) => `${(Math.abs(n % 1) < 0.005 ? Math.round(n) : n.toFixed(2)).toString().replace('.', ',')} ${devise}`;

export type AlerteFinance = { heure: string; titre: string; corps: string; mode: 'agressif' | 'hebdo'; id: string; canaux: { push: boolean; email: boolean } };

/**
 * Alertes d'une journée, sur les seules dépenses notées. Une alerte part une seule fois par période et par niveau
 * (« presque atteint », puis « dépassé ») : son identifiant porte le début de la période, pas le jour.
 */
export function alertesFinances(f: FinancesRappels | undefined, jour: string, heureParDefaut: string): { alertes: AlerteFinance[]; resteBudgets: string | null } {
  if (!f?.budgets?.length) return { alertes: [], resteBudgets: null };
  const a = f.alertes || {};
  // Le franc congolais est enregistré « CDF » mais s'écrit « FC », comme dans l'app.
  const devise = f.devise === 'CDF' ? 'FC' : f.devise || '€';
  const seuil = a.seuil && a.seuil > 0 ? a.seuil : 1;
  const heure = /^\d{2}:\d{2}$/.test(a.heure || '') ? a.heure! : heureParDefaut;
  const canaux = { push: a.push !== false, email: a.email !== false };
  const actif = (h: Horizon) => a.horizons?.[h] !== false;
  const alertes: AlerteFinance[] = [];

  // Le matin : ce qui reste sur les budgets du mois, d'après les dépenses déjà notées (le chiffre de l'accueil).
  const reste = a.matin !== false ? resteDesBudgets(f, jour) : null;
  const resteBudgets = reste === null ? null : reste < 0 ? `Budgets du mois dépassés de ${montant(-reste, devise)}` : `Reste sur tes budgets du mois : ${montant(reste, devise)}`;

  for (const h of ['jour', 'semaine', 'mois', 'trimestre', 'annee'] as const) {
    if (!actif(h)) continue;
    const p = prevision(f, h, jour, seuil);
    if (!p) continue;
    // Le total, ou à défaut le budget de catégorie le plus en difficulté.
    const pire = p.etat !== 'ok' ? null : p.budgets[0];
    const etat = p.etat !== 'ok' ? p.etat : pire?.etat;
    if (!etat || etat === 'ok') continue;
    const x = pire ?? p;
    const nom = (b: Prevision['budgets'][number]) => `${b.emoji} ${b.nom}`;
    // Sans budget global, le total est la somme des budgets de catégorie : les citer en plus ne dirait rien de neuf.
    const autres = pire || p.global ? p.budgets.filter((b) => b !== pire).slice(0, 2).map(nom) : [];
    const qui = pire ? `${nom(pire)} : budget` : `Budget ${TITRES[h]}`;
    alertes.push({
      heure,
      id: `prevision|${h}|${x.debut}|${etat}${pire ? `|${nom(pire)}` : ''}`,
      mode: etat === 'depasse' ? 'agressif' : 'hebdo',
      titre: etat === 'depasse' ? `${qui} dépassé` : `${qui} presque atteint`,
      corps:
        (etat === 'depasse'
          ? `${montant(x.depense, devise)} dépensés pour ${montant(x.plafond, devise)} prévus.`
          : `${montant(x.depense, devise)} dépensés sur ${montant(x.plafond, devise)} prévus (${Math.round((x.depense / x.plafond) * 100)} %), reste ${montant(x.reste, devise)}.`) +
        (autres.length ? ` Aussi : ${autres.join(', ')}.` : ''),
      canaux,
    });
  }
  return { alertes, resteBudgets };
}
