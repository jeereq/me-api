/**
 * Prévisions de dépenses et alertes, reprises de l'app (me-mobile/src/lib/previsions.ts et finances.ts).
 * Au rythme actuel, où en seront les dépenses à la fin du jour, de la semaine, du mois, du trimestre, de l'année ?
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

const PAR_AN: Record<Periode, number> = { jour: 365.25, semaine: 365.25 / 7, mois: 12, trimestre: 4, annee: 1 };
const JOURS_MIN: Record<Periode, number> = { jour: 1, semaine: 2, mois: 5, trimestre: 14, annee: 30 };
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

const plafond = (b: Budget, vue: Periode) => (b.periode === vue ? b.montant : arrondi((b.montant * PAR_AN[b.periode]) / PAR_AN[vue]));
/**
 * Plafond d'un budget sur les jours `debut`–`fin` (une période de la vue) : 0 hors de ses dates, au prorata des jours
 * couverts sinon ; une enveloppe est répartie sur toute sa durée. Même calcul que l'app (finances.ts, `plafondSur`).
 */
function plafondSur(b: Budget, vue: Periode, debut: string, fin: string) {
  const a = b.debut && b.debut > debut ? b.debut : debut;
  const z = b.fin && b.fin < fin ? b.fin : fin;
  if (a > z) return 0;
  if (b.enveloppe && b.debut && b.fin) return arrondi((b.montant * jours(a, z)) / jours(b.debut, b.fin));
  const p = plafond(b, vue);
  return a === debut && z === fin ? p : arrondi((p * jours(a, z)) / jours(debut, fin));
}

/* Restes reportés : même calcul que l'app (finances.ts, `ajustementReports` et `plafondDuJour`). */

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
/** Plafond d'un budget sur les jours `debut`–`fin`, restes reportés compris. */
const plafondPeriode = (rep: Map<string, Mouvement[]>, b: Budget, vue: Periode, debut: string, fin: string) => arrondi(plafondSur(b, vue, debut, fin) + ajustement(rep.get(b.id), debut, fin));

function plafondTotal(rep: Map<string, Mouvement[]>, budgets: Budget[], vue: Periode, debut: string, fin: string) {
  const g = budgets.find((b) => b.global && plafondPeriode(rep, b, vue, debut, fin) > 0);
  return g ? plafondPeriode(rep, g, vue, debut, fin) : budgets.filter((b) => !b.global).reduce((s, b) => s + plafondPeriode(rep, b, vue, debut, fin), 0);
}
/** Le budget total est fixé par jour (budget global « par jour », ou seulement des budgets par jour). */
const budgetJournalier = (budgets: Budget[]) => {
  const g = budgets.find((b) => b.global);
  return g ? g.periode === 'jour' : budgets.length > 0 && budgets.every((b) => b.periode === 'jour');
};
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
/**
 * Dépenses du `a` au `b` : celles d'un budget, ou toutes celles qui comptent face au plafond total
 * (toutes avec un budget global, sinon les seules rangées dans un budget). Même règle que l'app (previsions.ts, `somme`).
 */
const somme = (dep: Depense[], a: string, b: string, budget: string | undefined, budgets: Budget[]) => {
  const global = budgets.some((x) => x.global);
  return arrondi(dep.filter((x) => x.date >= a && x.date <= b && (budget !== undefined ? idBudgetDe(budgets, x) === budget : global || !!idBudgetDe(budgets, x))).reduce((s, x) => s + x.montant, 0));
};
const etatBudget = (b: Budget, d: string) => (b.fin && b.fin < d ? 'termine' : b.debut && b.debut > d ? 'a_venir' : 'en_cours');

/**
 * Le plafond d'un budget pour la seule journée `d` : son montant pour un budget fixé par jour, sinon ce qui lui reste
 * sur la semaine (budget à la semaine) ou le mois (dépenses d'avant ce jour retirées), restes reportés compris, réparti sur les jours restants, ce jour compris.
 * Même calcul que l'app (finances.ts, `plafondDuJour`).
 */
function plafondDuJour(dep: Depense[], budgets: Budget[], b: Budget, d: string, rep: Map<string, Mouvement[]>) {
  if (b.periode === 'jour' && !b.enveloppe) return Math.max(0, plafondPeriode(rep, b, 'jour', d, d));
  // Un budget à la semaine se répartit sur sa semaine, les autres sur le mois.
  const cadre: Periode = b.periode === 'semaine' && !b.enveloppe ? 'semaine' : 'mois';
  const { debut, fin } = bornes(cadre, d);
  if (etatBudget(b, d) !== 'en_cours') return 0;
  const z = b.fin && b.fin < fin ? b.fin : fin;
  const a = b.debut && b.debut > debut ? b.debut : debut;
  const pl = plafondSur(b, cadre, debut, fin);
  const avant = d > a ? arrondi(dep.filter((x) => x.date >= a && x.date < d && (b.global || idBudgetDe(budgets, x) === b.id)).reduce((s, x) => s + x.montant, 0)) : 0;
  // Reste d'une semaine ou d'un mois, ou d'un jour passé : réparti ; celui d'aujourd'hui : pour aujourd'hui ; d'un jour à venir : il attend.
  let commun = 0;
  let ceJour = 0;
  for (const x of rep.get(b.id) ?? []) {
    if (x.c.periode !== 'jour') commun += x.m * partCase(x.c, a, z);
    else if (x.c.debut >= a && x.c.debut < d) commun += x.m;
    else if (x.c.debut === d) ceJour += x.m;
  }
  return Math.max(0, arrondi(Math.max(0, (pl + commun - avant) / jours(d, z)) + ceJour));
}

/** Le bilan d'une journée, comme `bilan(f, 'jour', d, d)` dans l'app : le budget du jour et ce qui compte face à lui. */
function bilanJour(dep: Depense[], budgets: Budget[], d: string, rep: Map<string, Mouvement[]>) {
  const duJour = dep.filter((x) => x.date === d);
  const total = arrondi(duJour.reduce((s, x) => s + x.montant, 0));
  const lignes = budgets
    .map((b) => {
      const p = plafondDuJour(dep, budgets, b, d, rep);
      const x = b.global ? total : arrondi(duJour.filter((y) => idBudgetDe(budgets, y) === b.id).reduce((s, y) => s + y.montant, 0));
      return { budget: b, plafond: p, depense: x };
    })
    .filter((l) => l.plafond > 0 || l.depense > 0 || (!l.budget.fin && !l.budget.debut));
  const global = lignes.find((l) => l.budget.global);
  const horsBudget = arrondi(duJour.filter((x) => !idBudgetDe(budgets, x)).reduce((s, x) => s + x.montant, 0));
  return {
    lignes,
    plafondTotal: global ? global.plafond : arrondi(lignes.reduce((s, l) => s + l.plafond, 0)),
    compte: global ? total : arrondi(total - horsBudget),
  };
}

export type Prevision = {
  horizon: Horizon;
  plafond: number;
  depense: number;
  projection: number;
  parJour: number;
  etat: Etat;
  budgets: { nom: string; plafond: number; depense: number; projection: number; etat: Etat }[];
};

export function prevision(f: FinancesRappels, horizon: Horizon, d: string, seuil = 1): Prevision | null {
  const budgets = f.budgets || [];
  const dep = (f.depenses || []).filter((x) => !x.lien);
  if (!budgets.length) return null;
  const rep = mouvementsReports(f);
  if (horizon === 'jour') {
    // Le budget du jour de l'app (finances.ts, `budgetDuJour`) : le même chiffre dans les alertes et à l'écran.
    const j = bilanJour(dep, budgets, d, rep);
    const etatJour = (x: number, pl: number): Etat => (x > pl ? 'depasse' : x > 0 && x >= seuil * pl ? 'risque' : 'ok');
    const lignes = j.lignes
      .filter((l) => !l.budget.global && l.plafond > 0)
      .map((l) => ({ nom: `${l.budget.emoji} ${l.budget.nom}`, plafond: l.plafond, depense: l.depense, projection: l.depense, etat: etatJour(l.depense, l.plafond) }))
      .filter((b) => b.etat !== 'ok')
      .sort((a, b) => b.depense / b.plafond - a.depense / a.plafond);
    const pl = j.plafondTotal;
    // Pour tenir : le budget de demain, une fois la dépense d'aujourd'hui retirée (le même montant pour un budget fixé par jour).
    const apres = budgetJournalier(budgets) ? pl : d >= bornes('mois', d).fin ? 0 : bilanJour(dep, budgets, addDays(d, 1), rep).plafondTotal;
    return { horizon, plafond: pl, depense: j.compte, projection: j.compte, parJour: apres, etat: etatJour(j.compte, pl), budgets: lignes };
  }
  const { debut, fin } = bornes(horizon, d);
  const ecoules = jours(debut, d);
  const total = jours(debut, fin);
  const assez = ecoules >= JOURS_MIN[horizon];
  const etat = (x: number, pl: number, proj: number): Etat => (x > pl ? 'depasse' : assez && x > 0 && proj >= seuil * pl && (seuil < 1 || proj > pl) ? 'risque' : 'ok');
  const pl = arrondi(plafondTotal(rep, budgets, horizon, debut, fin));
  const x = somme(dep, debut, d, undefined, budgets);
  const proj = arrondi((x / ecoules) * total);
  const lignes = budgets
    .filter((b) => !b.global)
    .map((b) => {
      const p = plafondPeriode(rep, b, horizon, debut, fin);
      const y = somme(dep, debut, d, b.id, budgets);
      const pr = arrondi((y / ecoules) * total);
      return { nom: `${b.emoji} ${b.nom}`, plafond: p, depense: y, projection: pr, etat: etat(y, p, pr) };
    })
    .filter((b) => b.etat !== 'ok' && (b.plafond > 0 || b.depense > 0))
    .sort((a, b) => b.projection / b.plafond - a.projection / a.plafond);
  return { horizon, plafond: pl, depense: x, projection: proj, parJour: Math.max(0, arrondi((pl - x) / jours(d, fin))), etat: etat(x, pl, proj), budgets: lignes };
}

export const montant = (n: number, devise: string) => `${(Math.abs(n % 1) < 0.005 ? Math.round(n) : n.toFixed(2)).toString().replace('.', ',')} ${devise}`;

export type AlerteFinance = { heure: string; titre: string; corps: string; mode: 'agressif' | 'hebdo'; id: string; canaux: { push: boolean; email: boolean } };

/**
 * Alertes d'une journée. Une alerte part une seule fois par période et par niveau (« à risque », puis « dépassé ») :
 * son identifiant porte le début de la période, pas le jour.
 */
export function alertesFinances(f: FinancesRappels | undefined, jour: string, heureParDefaut: string): { alertes: AlerteFinance[]; budgetDuJour: string | null } {
  if (!f?.budgets?.length) return { alertes: [], budgetDuJour: null };
  const a = f.alertes || {};
  // Le franc congolais est enregistré « CDF » mais s'écrit « FC », comme dans l'app.
  const devise = f.devise === 'CDF' ? 'FC' : f.devise || '€';
  const seuil = a.seuil && a.seuil > 0 ? a.seuil : 1;
  const heure = /^\d{2}:\d{2}$/.test(a.heure || '') ? a.heure! : heureParDefaut;
  const canaux = { push: a.push !== false, email: a.email !== false };
  const actif = (h: Horizon) => a.horizons?.[h] !== false;
  const alertes: AlerteFinance[] = [];

  const j = prevision(f, 'jour', jour, seuil);
  const budgetDuJour = a.matin !== false && actif('jour') && j ? montant(j.plafond, devise) : null;
  const journalier = budgetJournalier(f.budgets);
  if (j && actif('jour') && j.etat !== 'ok')
    alertes.push({
      heure,
      id: `prevision|jour|${jour}|${j.etat}`,
      mode: j.etat === 'depasse' ? 'agressif' : 'hebdo',
      titre: j.etat === 'depasse' ? 'Budget du jour dépassé' : `Budget du jour presque atteint`,
      corps:
        `${montant(j.depense, devise)} dépensés aujourd'hui pour ${montant(j.plafond, devise)} prévus.` +
        (journalier ? '' : j.parJour > 0 ? ` Pour tenir le mois, vise ${montant(j.parJour, devise)} par jour.` : ' Le budget du mois est déjà épuisé.') +
        (j.budgets.length ? ` Aussi : ${j.budgets.slice(0, 2).map((b) => b.nom).join(', ')}.` : ''),
      canaux,
    });
  else if (j && actif('jour') && j.budgets.length) {
    // Total tenu, mais un budget de catégorie par jour menacé ou dépassé.
    const b = j.budgets[0];
    alertes.push({
      heure,
      id: `prevision|jour|${jour}|${b.etat}|${b.nom}`,
      mode: b.etat === 'depasse' ? 'agressif' : 'hebdo',
      titre: b.etat === 'depasse' ? `${b.nom} : budget du jour dépassé` : `${b.nom} : budget du jour presque atteint`,
      corps: `${montant(b.depense, devise)} dépensés aujourd'hui pour ${montant(b.plafond, devise)} prévus.`,
      canaux,
    });
  }

  for (const h of ['semaine', 'mois', 'trimestre', 'annee'] as const) {
    if (!actif(h)) continue;
    const p = prevision(f, h, jour, seuil);
    if (!p) continue;
    // Le total, ou à défaut le budget de catégorie le plus en difficulté.
    const pire = p.etat !== 'ok' ? null : p.budgets[0];
    const etat = p.etat !== 'ok' ? p.etat : pire?.etat;
    if (!etat || etat === 'ok') continue;
    const cible = pire ? `${pire.nom} : à ce rythme` : 'À ce rythme';
    const dep = pire ? pire.depense : p.depense;
    const pl = pire ? pire.plafond : p.plafond;
    const proj = pire ? pire.projection : p.projection;
    const autres = p.budgets.filter((b) => b !== pire).slice(0, 2).map((b) => b.nom);
    alertes.push({
      heure,
      id: `prevision|${h}|${bornes(h, jour).debut}|${etat}${pire ? `|${pire.nom}` : ''}`,
      mode: etat === 'depasse' ? 'agressif' : 'hebdo',
      titre: etat === 'depasse' ? `Budget ${TITRES[h]} dépassé` : `Prévision ${TITRES[h]} : budget en danger`,
      corps:
        (etat === 'depasse'
          ? `${pire ? `${pire.nom} : ` : ''}${montant(dep, devise)} dépensés pour ${montant(pl, devise)} prévus.`
          : `${cible}, environ ${montant(Math.round(proj), devise)} sur ${montant(pl, devise)} prévus (${Math.round((proj / pl) * 100)} %).`) +
        (!pire && etat !== 'depasse' ? ` Pour tenir : ${montant(p.parJour, devise)} par jour.` : '') +
        (autres.length ? ` Aussi : ${autres.join(', ')}.` : ''),
      canaux,
    });
  }
  return { alertes, budgetDuJour };
}
