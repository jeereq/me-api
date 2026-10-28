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

/** Un budget sur sa période : son montant (restes reportés compris) face aux seules dépenses notées et rangées dedans. */
type Suivi = { budget: Budget; debut: string; fin: string; plafond: number; depense: number };
function suivi(dep: Depense[], budgets: Budget[], rep: Map<string, Mouvement[]>, b: Budget, d: string): Suivi | null {
  const w = fenetre(b, d);
  if (!w) return null;
  const depense = arrondi(dep.filter((x) => x.date >= w.debut && x.date <= w.fin && (b.global || idBudgetDe(budgets, x) === b.id)).reduce((s, x) => s + x.montant, 0));
  return { budget: b, ...w, plafond: arrondi(b.montant + ajustement(rep.get(b.id), w.debut, w.fin)), depense };
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
  /** Budgets de catégorie presque atteints ou dépassés, le plus en difficulté d'abord. */
  budgets: { nom: string; debut: string; plafond: number; depense: number; reste: number; etat: Etat }[];
};

/**
 * Les budgets fixés pour cette durée (par jour, par semaine, par mois…) et en cours le jour `d` : montant, dépensé, reste.
 * `seuil` : part du budget à partir de laquelle il est « presque atteint » (1 = atteint). null sans budget de cette durée.
 */
export function prevision(f: FinancesRappels, horizon: Horizon, d: string, seuil = 1): Prevision | null {
  const budgets = f.budgets || [];
  const dep = (f.depenses || []).filter((x) => !x.lien);
  const rep = mouvementsReports(f);
  const suivis = budgets.filter((b) => b.periode === horizon).map((b) => suivi(dep, budgets, rep, b, d)).filter((s): s is Suivi => !!s);
  if (!suivis.length) return null;
  const etat = (x: number, pl: number): Etat => (x > pl ? 'depasse' : x > 0 && x >= seuil * pl ? 'risque' : 'ok');
  const g = suivis.find((s) => s.budget.global);
  const autres = suivis.filter((s) => !s.budget.global);
  const pl = g ? g.plafond : arrondi(autres.reduce((s, x) => s + x.plafond, 0));
  const x = g ? g.depense : arrondi(autres.reduce((s, y) => s + y.depense, 0));
  const lignes = autres
    .map((s) => ({ nom: `${s.budget.emoji} ${s.budget.nom}`, debut: s.debut, plafond: s.plafond, depense: s.depense, reste: arrondi(s.plafond - s.depense), etat: etat(s.depense, s.plafond) }))
    .filter((b) => b.etat !== 'ok')
    .sort((a, b) => b.depense / (b.plafond || 1) - a.depense / (a.plafond || 1));
  return { horizon, global: !!g, debut: g?.debut ?? bornes(horizon, d).debut, plafond: pl, depense: x, reste: arrondi(pl - x), etat: etat(x, pl), budgets: lignes };
}

/** Ce qui reste sur les budgets en cours le jour `d` : celui du budget global, sinon la somme des autres. null sans budget en cours. */
export function resteDesBudgets(f: FinancesRappels, d: string): number | null {
  const budgets = f.budgets || [];
  const dep = (f.depenses || []).filter((x) => !x.lien);
  const rep = mouvementsReports(f);
  const suivis = budgets.map((b) => suivi(dep, budgets, rep, b, d)).filter((s): s is Suivi => !!s);
  if (!suivis.length) return null;
  const g = suivis.find((s) => s.budget.global);
  return arrondi(g ? g.plafond - g.depense : suivis.reduce((s, x) => s + x.plafond - x.depense, 0));
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

  // Le matin : ce qui reste sur les budgets en cours, d'après les dépenses déjà notées.
  const reste = a.matin !== false ? resteDesBudgets(f, jour) : null;
  const resteBudgets = reste === null ? null : reste < 0 ? `Budgets dépassés de ${montant(-reste, devise)}` : `Reste sur tes budgets : ${montant(reste, devise)}`;

  for (const h of ['jour', 'semaine', 'mois', 'trimestre', 'annee'] as const) {
    if (!actif(h)) continue;
    const p = prevision(f, h, jour, seuil);
    if (!p) continue;
    // Le total, ou à défaut le budget de catégorie le plus en difficulté.
    const pire = p.etat !== 'ok' ? null : p.budgets[0];
    const etat = p.etat !== 'ok' ? p.etat : pire?.etat;
    if (!etat || etat === 'ok') continue;
    const x = pire ?? p;
    // Sans budget global, le total est la somme des budgets de catégorie : les citer en plus ne dirait rien de neuf.
    const autres = pire || p.global ? p.budgets.filter((b) => b !== pire).slice(0, 2).map((b) => b.nom) : [];
    const qui = pire ? `${pire.nom} : budget` : `Budget ${TITRES[h]}`;
    alertes.push({
      heure,
      id: `prevision|${h}|${x.debut}|${etat}${pire ? `|${pire.nom}` : ''}`,
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
