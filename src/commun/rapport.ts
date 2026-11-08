/**
 * Le rapport des dépenses d'une période (le jour, la semaine, le mois, le trimestre ou l'année) et ses conseils.
 * Le serveur l'envoie le soir aux abonnés (push, email, SMS) ; l'app le montre pour la période affichée dans Finances.
 * Rien n'est deviné : seulement les dépenses, revenus et budgets notés. Les conseils sont des règles simples, pas de l'IA.
 */

import { bilan, bornes, depensesComptees, type FinancesRappels, idBudgetDe } from './previsions.js';

export type PeriodeRapport = 'jour' | 'semaine' | 'mois' | 'trimestre' | 'annee';
export const PERIODES_RAPPORT: PeriodeRapport[] = ['jour', 'semaine', 'mois', 'trimestre', 'annee'];

/** Réglages du rapport (dans `finances.alertes.rapport`) ; chaque réglage absent prend sa valeur par défaut. */
export type ReglagesRapport = {
  /** Le rapport du jour, chaque soir (oui par défaut). */
  soir?: boolean;
  /** Les rapports plus longs, le soir du dernier jour de la période (non par défaut). */
  periodes?: Partial<Record<Exclude<PeriodeRapport, 'jour'>, boolean>>;
  /** Heure d'envoi, « HH:MM » (21 h par défaut). */
  heure?: string;
  /** Par SMS aussi, si le SMS est activé dans Mon compte (oui par défaut). */
  sms?: boolean;
};
export const HEURE_RAPPORT = '21:00';

type Operation = { id: string; montant: number; date: string; note?: string; categories?: string[]; lien?: string };
export type FinancesRapport = Omit<FinancesRappels, 'depenses'> & {
  depenses?: (NonNullable<FinancesRappels['depenses']>[number] & { note?: string })[];
  revenus?: Operation[];
  alertes?: FinancesRappels['alertes'] & { rapport?: ReglagesRapport };
};
/** Noms des catégories (l'espace range leurs identifiants dans les opérations). */
export type NomsCategories = { id: string; nom: string; emoji?: string }[];

/** Un conseil, et sa version courte pour un SMS. */
export type Conseil = { ton: 'alerte' | 'conseil' | 'bravo'; texte: string; court: string };
export type LigneRapport = { nom: string; montant: number; part: number };
export type BudgetRapport = { nom: string; depense: number; plafond: number; reste: number; depasse: boolean };

export type Rapport = {
  periode: PeriodeRapport;
  debut: string;
  fin: string;
  /** « Tes dépenses du 8 novembre », « de la semaine du 2 au 8 novembre », « de novembre 2026 »… */
  titre: string;
  devise: string;
  depenses: number;
  revenus: number;
  /** Nombre de dépenses notées. */
  nombre: number;
  /** Moyenne des périodes précédentes de même durée (celles où des dépenses étaient déjà notées) ; null sans historique. */
  habitude: number | null;
  categories: LigneRapport[];
  plusGrosse: { note: string; montant: number } | null;
  budgets: BudgetRapport[];
  /** Ce qui reste sur les budgets du mois, et par jour jusqu'à la fin du mois (rapports du jour et de la semaine). */
  resteMois: { reste: number; jours: number; parJour: number } | null;
  conseils: Conseil[];
};

const MOIS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
const COURTS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
const pad = (n: number) => String(n).padStart(2, '0');
const parse = (s: string) => new Date(`${s}T00:00:00Z`);
const ymd = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const addDays = (s: string, n: number) => {
  const d = parse(s);
  d.setUTCDate(d.getUTCDate() + n);
  return ymd(d);
};
const nbJours = (a: string, b: string) => Math.round((parse(b).getTime() - parse(a).getTime()) / 864e5) + 1;
const arrondi = (n: number) => Math.round(n * 100) / 100;
const jourN = (s: string) => `${Number(s.slice(8, 10))}${s.slice(8, 10) === '01' ? 'er' : ''}`;
/** « 8 novembre », « 1er décembre ». */
export const jourDit = (s: string) => `${jourN(s)} ${MOIS[Number(s.slice(5, 7)) - 1]}`;
/** « 8/11 » : pour un SMS. */
const jourCourt = (s: string) => `${Number(s.slice(8, 10))}/${s.slice(5, 7)}`;
export const symbole = (devise: string | undefined) => (devise === 'CDF' ? 'FC' : devise || '€');
/** « 372 000 FC », « 12,50 $ » : les milliers séparés, sans centimes au-delà de 100. */
export function somme(n: number, devise: string): string {
  const a = Math.abs(n);
  const v = a >= 100 ? Math.round(a) : Math.round(a * 100) / 100;
  const [e, d] = (v % 1 ? v.toFixed(2) : String(v)).split('.');
  return `${n < 0 ? '-' : ''}${e.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')}${d ? `,${d}` : ''} ${devise}`;
}
const decimal = (n: number) => String(Math.round(n * 10) / 10).replace('.', ',');

/** « du 8 novembre », « de la semaine du 2 au 8 novembre », « de novembre 2026 », « du 4e trimestre 2026 », « de 2026 ». */
export function periodeDite(p: PeriodeRapport, d: string): string {
  const { debut, fin } = bornes(p, d);
  const an = debut.slice(0, 4);
  if (p === 'jour') return `du ${jourDit(debut)}`;
  if (p === 'semaine') return debut.slice(5, 7) === fin.slice(5, 7) ? `de la semaine du ${jourN(debut)} au ${jourDit(fin)}` : `de la semaine du ${jourDit(debut)} au ${jourDit(fin)}`;
  if (p === 'mois') return `${/^[aeiouy]/.test(MOIS[Number(debut.slice(5, 7)) - 1]) ? "d'" : 'de '}${MOIS[Number(debut.slice(5, 7)) - 1]} ${an}`;
  if (p === 'trimestre') return `du ${(Number(debut.slice(5, 7)) + 2) / 3 === 1 ? '1er' : `${(Number(debut.slice(5, 7)) + 2) / 3}e`} trimestre ${an}`;
  return `de ${an}`;
}

/** La même période, n fois plus tôt (n < 0) ou plus tard. */
function decaler(p: PeriodeRapport, d: string, n: number) {
  if (p === 'jour') return addDays(d, n);
  if (p === 'semaine') return addDays(d, 7 * n);
  const x = parse(bornes(p, d).debut);
  const m = p === 'mois' ? 1 : p === 'trimestre' ? 3 : 12;
  return ymd(new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + m * n, 1)));
}
/** Combien de périodes passées font « l'habitude ». */
const HISTORIQUE: Record<PeriodeRapport, number> = { jour: 28, semaine: 4, mois: 3, trimestre: 4, annee: 2 };
const MOT: Record<PeriodeRapport, string> = { jour: 'jour', semaine: 'semaine', mois: 'mois', trimestre: 'trimestre', annee: 'année' };
const CE: Record<PeriodeRapport, string> = { jour: "aujourd'hui", semaine: 'cette semaine', mois: 'ce mois-ci', trimestre: 'ce trimestre', annee: 'cette année' };

/**
 * Le rapport de la période `p` qui contient `ref`. `aujourdhui` sert au reste du mois : on ne compte que les jours
 * qui restent après aujourd'hui.
 */
export function rapportDepenses(f: FinancesRapport | undefined, p: PeriodeRapport, ref: string, aujourdhui: string, noms: NomsCategories = []): Rapport {
  const fr = (f ?? {}) as FinancesRapport;
  const devise = symbole(fr.devise);
  const { debut, fin } = bornes(p, ref);
  const dans = (x: { date: string }, a: string, z: string) => x.date >= a && x.date <= z;
  const toutes = depensesComptees(fr as FinancesRappels) as NonNullable<FinancesRapport['depenses']>;
  const dep = toutes.filter((x) => dans(x, debut, fin));
  const total = arrondi(dep.reduce((s, x) => s + x.montant, 0));
  const revenus = arrondi((fr.revenus ?? []).filter((x) => !x.lien && dans(x, debut, fin)).reduce((s, x) => s + x.montant, 0));

  // L'habitude : la moyenne des périodes précédentes depuis la première dépense notée.
  const premiere = toutes.reduce<string | null>((m, x) => (!m || x.date < m ? x.date : m), null);
  let habitude: number | null = null;
  if (premiere) {
    const sommes: number[] = [];
    for (let i = 1; i <= HISTORIQUE[p]; i++) {
      const b = bornes(p, decaler(p, debut, -i));
      if (b.fin < premiere) break;
      sommes.push(toutes.filter((x) => dans(x, b.debut, b.fin)).reduce((s, x) => s + x.montant, 0));
    }
    // Il faut assez de recul : une semaine de jours, deux semaines, un mois…
    if (sommes.length >= (p === 'jour' ? 7 : p === 'semaine' ? 2 : 1)) habitude = arrondi(sommes.reduce((s, x) => s + x, 0) / sommes.length);
  }

  const nom = (id: string) => {
    const c = noms.find((x) => x.id === id);
    return c ? `${c.emoji ? `${c.emoji} ` : ''}${c.nom}` : null;
  };
  const budgets = fr.budgets ?? [];
  const parCat = new Map<string, number>();
  for (const x of dep) {
    const b = budgets.find((y) => y.id === idBudgetDe(budgets, x));
    const n = (x.categories ?? []).map(nom).find(Boolean) ?? (b ? `${b.emoji ? `${b.emoji} ` : ''}${b.nom}` : 'Sans catégorie');
    parCat.set(n, (parCat.get(n) ?? 0) + x.montant);
  }
  const categories = [...parCat]
    .map(([n, m]) => ({ nom: n, montant: arrondi(m), part: total > 0 ? Math.round((m / total) * 100) : 0 }))
    .sort((a, b) => b.montant - a.montant)
    .slice(0, 5);
  const g = dep.reduce<(typeof dep)[number] | null>((m, x) => (!m || x.montant > m.montant ? x : m), null);

  const bl = bilan(fr as FinancesRappels, p, ref, aujourdhui);
  const lignes: BudgetRapport[] = bl.lignes
    .filter((l) => l.plafond > 0 || l.depense > 0)
    .map((l) => ({ nom: `${l.budget.emoji ? `${l.budget.emoji} ` : ''}${l.budget.nom}`, depense: l.depense, plafond: l.plafond, reste: arrondi(l.plafond - l.depense), depasse: l.depense > l.plafond + 0.004 }))
    .sort((a, b) => b.depense / (b.plafond || 1) - a.depense / (a.plafond || 1));

  let resteMois: Rapport['resteMois'] = null;
  if ((p === 'jour' || p === 'semaine') && budgets.length) {
    const m = bilan(fr as FinancesRappels, 'mois', aujourdhui, aujourdhui);
    if (m.comptees.length) {
      const jours = Math.max(0, nbJours(aujourdhui, m.fin) - 1);
      const reste = arrondi(m.plafondTotal - m.compte);
      resteMois = { reste, jours, parJour: jours > 0 && reste > 0 ? Math.floor(reste / jours) : 0 };
    }
  }

  const r: Rapport = {
    periode: p,
    debut,
    fin,
    titre: `Tes dépenses ${periodeDite(p, ref)}`,
    devise,
    depenses: total,
    revenus,
    nombre: dep.length,
    habitude,
    categories,
    plusGrosse: g ? { note: (g.note ?? '').trim(), montant: g.montant } : null,
    budgets: lignes,
    resteMois,
    conseils: [],
  };
  r.conseils = conseilsRapport(r, aujourdhui >= debut && aujourdhui < fin);
  return r;
}

/** Au plus trois conseils, du plus urgent au plus encourageant. `enCours` : la période n'est pas finie. */
export function conseilsRapport(r: Rapport, enCours = false): Conseil[] {
  const m = (n: number) => somme(n, r.devise);
  const out: Conseil[] = [];
  const ce = CE[r.periode];
  const suite = r.periode === 'jour' ? 'demain' : `${r.periode === 'semaine' ? 'la semaine' : r.periode === 'annee' ? "l'année" : r.periode === 'mois' ? 'le mois' : 'le trimestre'} prochain${r.periode === 'semaine' || r.periode === 'annee' ? 'e' : ''}`;

  // 1. Budgets dépassés : le plus gros dépassement d'abord.
  const depasses = r.budgets.filter((b) => b.depasse).sort((a, b) => a.reste - b.reste);
  if (depasses.length) {
    const b = depasses[0];
    const autres = depasses.length > 1 ? ` (et ${depasses.length - 1} autre${depasses.length > 2 ? 's' : ''})` : '';
    out.push({
      ton: 'alerte',
      texte: `${b.nom} : ${m(-b.reste)} au-dessus du budget${autres}. ${enCours ? `Plus rien sur ce poste ${ce}.` : `Vise moins de ${m(b.plafond)} ${suite}, ou augmente ce budget s'il est trop juste.`}`,
      court: `${b.nom} dépassé de ${m(-b.reste)}${autres}.`,
    });
  }

  // 2. Le reste du mois, ramené à un montant par jour.
  if (r.resteMois) {
    const x = r.resteMois;
    if (x.reste < 0) out.push({ ton: 'alerte', texte: `Budgets du mois dépassés de ${m(-x.reste)}. Jusqu'à la fin du mois, seulement l'essentiel.`, court: `Budgets du mois dépassés de ${m(-x.reste)}.` });
    else if (x.jours > 0) out.push({ ton: 'conseil', texte: `Il reste ${m(x.reste)} sur les budgets du mois pour ${x.jours} jour${x.jours > 1 ? 's' : ''} : ${m(x.parJour)} par jour au plus.`, court: `Reste du mois : ${m(x.reste)}, soit ${m(x.parJour)}/jour.` });
  }

  // 3. Par rapport à d'habitude.
  if (r.habitude !== null && r.habitude > 0 && r.nombre > 0) {
    const ratio = r.depenses / r.habitude;
    const plus = ratio >= 2 ? `${decimal(ratio)} fois plus que d'habitude` : `${Math.round((ratio - 1) * 100)} % de plus que d'habitude`;
    if (ratio >= 1.5) out.push({ ton: 'alerte', texte: `${plus} (${m(r.habitude)} par ${MOT[r.periode]} en moyenne).`, court: `${plus}.` });
    else if (ratio <= 0.7 && !enCours) out.push({ ton: 'bravo', texte: `${m(r.habitude - r.depenses)} de moins que d'habitude : bien joué.`, court: `${m(r.habitude - r.depenses)} de moins que d'habitude.` });
  }

  // 4. Ce qui pèse le plus.
  const c = r.categories[0];
  if (c && r.nombre >= 3 && c.part >= 40 && c.nom !== 'Sans catégorie') out.push({ ton: 'conseil', texte: `${c.nom} fait ${c.part} % des dépenses : c'est là qu'il y a le plus à gagner.`, court: `${c.nom} : ${c.part} % des dépenses.` });

  // 5. Ce qui rentre et ce qui sort (à partir du mois).
  if (r.periode !== 'jour' && r.periode !== 'semaine' && r.revenus > 0) {
    if (r.depenses > r.revenus) out.push({ ton: 'alerte', texte: `${m(r.depenses - r.revenus)} dépensés de plus que reçus. Vois ce qui peut attendre.`, court: `${m(r.depenses - r.revenus)} dépensés de plus que reçus.` });
    else if (r.depenses > 0) {
      const p = Math.round(((r.revenus - r.depenses) / r.revenus) * 100);
      out.push({ ton: 'bravo', texte: `${p} % de ce qui est entré est resté de côté (${m(r.revenus - r.depenses)}).`, court: `${m(r.revenus - r.depenses)} mis de côté (${p} % des revenus).` });
    }
  }

  // 6. Rien de noté, ou pas de budget.
  if (!r.nombre)
    out.push(
      r.periode === 'jour'
        ? { ton: 'conseil', texte: "Aucune dépense notée aujourd'hui. Un achat oublié ? Note-le maintenant, ça prend 10 secondes.", court: 'Un achat oublié ? Note-le dans Me.' }
        : { ton: 'conseil', texte: `Aucune dépense notée ${ce}.`, court: `Rien de noté ${ce}.` },
    );
  else if (!r.budgets.length) out.push({ ton: 'conseil', texte: 'Fixe un budget : Me te dira chaque soir combien il te reste.', court: 'Fixe un budget pour suivre ce qui reste.' });

  return out.slice(0, 3);
}

/** Le résumé en une ligne : « 3 dépenses, 42 500 FC. » */
export function resumeRapport(r: Rapport): string {
  if (!r.nombre) return 'Aucune dépense notée.';
  const habitude = r.habitude !== null && r.habitude > 0 ? ` (d'habitude ${somme(r.habitude, r.devise)})` : '';
  return `${somme(r.depenses, r.devise)} dépensés en ${r.nombre} dépense${r.nombre > 1 ? 's' : ''}${habitude}.`;
}

/** La période d'un rapport à envoyer, dite courte pour un SMS : « 8/11 », « sem. du 2/11 », « nov. 2026 », « T4 2026 », « 2026 ». */
export function periodeCourte(p: PeriodeRapport, debut: string): string {
  if (p === 'jour') return `du ${jourCourt(debut)}`;
  if (p === 'semaine') return `sem. du ${jourCourt(debut)}`;
  if (p === 'mois') return `${COURTS[Number(debut.slice(5, 7)) - 1]} ${debut.slice(0, 4)}`;
  if (p === 'trimestre') return `T${(Number(debut.slice(5, 7)) + 2) / 3} ${debut.slice(0, 4)}`;
  return debut.slice(0, 4);
}

/** Les rapports à envoyer le soir du jour `jour` : celui du jour, et ceux des périodes qui finissent ce jour-là, si demandés. */
export function rapportsDuSoir(f: FinancesRapport | undefined, jour: string): { periode: PeriodeRapport; heure: string; cle: string }[] {
  const r = f?.alertes?.rapport ?? {};
  const heure = /^\d{2}:\d{2}$/.test(r.heure ?? '') ? r.heure! : HEURE_RAPPORT;
  const out: { periode: PeriodeRapport; heure: string; cle: string }[] = [];
  if (r.soir !== false) out.push({ periode: 'jour', heure, cle: `rapport|jour|${jour}` });
  for (const p of ['semaine', 'mois', 'trimestre', 'annee'] as const) {
    if (r.periodes?.[p] && bornes(p, jour).fin === jour) out.push({ periode: p, heure, cle: `rapport|${p}|${bornes(p, jour).debut}` });
  }
  return out;
}

/** A-t-on de quoi faire un rapport ? Des dépenses ou des budgets : un compte vide ne reçoit rien. */
export const aDesFinances = (f: FinancesRapport | undefined) => !!(f?.depenses?.length || f?.budgets?.length);
