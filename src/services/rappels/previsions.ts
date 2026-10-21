/**
 * Prévisions de dépenses et alertes, reprises de l'app (me-mobile/src/lib/previsions.ts et finances.ts).
 * Au rythme actuel, où en seront les dépenses à la fin du jour, de la semaine, du mois, du trimestre, de l'année ?
 * Dates en texte « AAAA-MM-JJ », calculées en UTC : le fuseau du serveur n'intervient pas.
 */

type Periode = 'jour' | 'semaine' | 'mois' | 'trimestre' | 'annee';
export type Horizon = Periode;
type Budget = { id: string; nom: string; emoji: string; montant: number; periode: Periode; global?: boolean };
type Depense = { id: string; montant: number; budget: string | null; date: string };
export type AlertesFinances = { horizons?: Partial<Record<Horizon, boolean>>; seuil?: number; heure?: string; matin?: boolean; push?: boolean; email?: boolean };
export type FinancesRappels = { devise?: string; budgets?: Budget[]; depenses?: Depense[]; alertes?: AlertesFinances };
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
function plafondTotal(budgets: Budget[], vue: Periode) {
  const g = budgets.find((b) => b.global);
  return g ? plafond(g, vue) : budgets.reduce((s, b) => s + plafond(b, vue), 0);
}
/** Le budget total est fixé par jour (budget global « par jour », ou seulement des budgets par jour). */
const budgetJournalier = (budgets: Budget[]) => {
  const g = budgets.find((b) => b.global);
  return g ? g.periode === 'jour' : budgets.length > 0 && budgets.every((b) => b.periode === 'jour');
};
const somme = (dep: Depense[], a: string, b: string, budget?: string) => arrondi(dep.filter((x) => x.date >= a && x.date <= b && (budget === undefined || x.budget === budget)).reduce((s, x) => s + x.montant, 0));

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
  const dep = f.depenses || [];
  if (!budgets.length) return null;
  if (horizon === 'jour') {
    const auj = somme(dep, d, d);
    const etatJour = (x: number, pl: number): Etat => (x > pl ? 'depasse' : x > 0 && x >= seuil * pl ? 'risque' : 'ok');
    // Budgets de catégorie fixés par jour : comparés à la dépense du jour.
    const lignes = budgets
      .filter((b) => !b.global && b.periode === 'jour')
      .map((b) => {
        const y = somme(dep, d, d, b.id);
        return { nom: `${b.emoji} ${b.nom}`, plafond: b.montant, depense: y, projection: y, etat: etatJour(y, b.montant) };
      })
      .filter((b) => b.etat !== 'ok')
      .sort((a, b) => b.depense / b.plafond - a.depense / a.plafond);
    if (budgetJournalier(budgets)) {
      // Budget fixé par jour : le même montant chaque jour, sans report.
      const pl = arrondi(plafondTotal(budgets, 'jour'));
      return { horizon, plafond: pl, depense: auj, projection: auj, parJour: pl, etat: etatJour(auj, pl), budgets: lignes };
    }
    // Sinon, ce qui reste du mois, réparti sur les jours restants (aujourd'hui compris).
    const { debut, fin } = bornes('mois', d);
    const pl = plafondTotal(budgets, 'mois');
    const avant = somme(dep, debut, addDays(d, -1));
    const parJour = Math.max(0, arrondi((pl - avant) / jours(d, fin)));
    return { horizon, plafond: parJour, depense: auj, projection: auj, parJour: Math.max(0, arrondi((pl - avant - auj) / Math.max(1, jours(d, fin) - 1))), etat: etatJour(auj, parJour), budgets: lignes };
  }
  const { debut, fin } = bornes(horizon, d);
  const ecoules = jours(debut, d);
  const total = jours(debut, fin);
  const assez = ecoules >= JOURS_MIN[horizon];
  const etat = (x: number, pl: number, proj: number): Etat => (x > pl ? 'depasse' : assez && x > 0 && proj >= seuil * pl && (seuil < 1 || proj > pl) ? 'risque' : 'ok');
  const pl = arrondi(plafondTotal(budgets, horizon));
  const x = somme(dep, debut, d);
  const proj = arrondi((x / ecoules) * total);
  const lignes = budgets
    .filter((b) => !b.global)
    .map((b) => {
      const p = plafond(b, horizon);
      const y = somme(dep, debut, d, b.id);
      const pr = arrondi((y / ecoules) * total);
      return { nom: `${b.emoji} ${b.nom}`, plafond: p, depense: y, projection: pr, etat: etat(y, p, pr) };
    })
    .filter((b) => b.etat !== 'ok')
    .sort((a, b) => b.projection / b.plafond - a.projection / a.plafond);
  return { horizon, plafond: pl, depense: x, projection: proj, parJour: Math.max(0, arrondi((pl - x) / jours(d, fin))), etat: etat(x, pl, proj), budgets: lignes };
}

const montant = (n: number, devise: string) => `${(Math.abs(n % 1) < 0.005 ? Math.round(n) : n.toFixed(2)).toString().replace('.', ',')} ${devise}`;

export type AlerteFinance = { heure: string; titre: string; corps: string; mode: 'agressif' | 'hebdo'; id: string; canaux: { push: boolean; email: boolean } };

/**
 * Alertes d'une journée. Une alerte part une seule fois par période et par niveau (« à risque », puis « dépassé ») :
 * son identifiant porte le début de la période, pas le jour.
 */
export function alertesFinances(f: FinancesRappels | undefined, jour: string, heureParDefaut: string): { alertes: AlerteFinance[]; budgetDuJour: string | null } {
  if (!f?.budgets?.length) return { alertes: [], budgetDuJour: null };
  const a = f.alertes || {};
  const devise = f.devise || '€';
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
