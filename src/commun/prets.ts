import { montant } from './previsions.js';

/**
 * Finances avancées, communes au serveur et à l'app : prêts entre personnes, paiements à venir et bilan du mois.
 * Dates en texte « AAAA-MM-JJ », calculées en UTC : le fuseau du serveur n'intervient pas.
 */

/** Un remboursement reçu (prêt) ou fait (emprunt). */
export type Remboursement = { id: string; date: string; montant: number; note?: string };
/**
 * De l'argent prêté à quelqu'un (`prete` : on me doit) ou emprunté à quelqu'un (`emprunte` : je dois), dans la devise
 * principale. Ce n'est ni une dépense ni un revenu : le solde de la période n'en tient pas compte.
 */
export type Pret = {
  id: string;
  personne: string;
  sens: 'prete' | 'emprunte';
  montant: number;
  /** Jour du prêt. */
  date: string;
  /** Jour où l'argent doit être rendu (facultatif). */
  echeance?: string | null;
  remboursements?: Remboursement[];
  note?: string;
  archive?: boolean;
  creeLe?: string;
};
export type EtatPret = 'rembourse' | 'en_retard' | 'bientot' | 'en_cours';

/** Paiement récurrent, réduit à ce qu'il faut pour les échéances (me-mobile/src/lib/types.ts, `Recurrence`). */
export type RecurrenceRappel = { id: string; genre: 'depense' | 'revenu'; montant: number; note: string; frequence: 'semaine' | 'mois' | 'annee'; debut: string; derniere: string | null; fin?: string | null };
type Operation = { id: string; montant: number; date: string; categories?: string[]; lien?: string };
type Reglages = { devise?: string; alertes?: { heure?: string; push?: boolean; email?: boolean; prets?: boolean; echeances?: boolean; bilan?: boolean } };
export type FinancesAvancees = Reglages & { prets?: Pret[]; recurrences?: RecurrenceRappel[]; depenses?: Operation[]; revenus?: Operation[] };
export type AlerteAvancee = { heure: string; titre: string; corps: string; mode: 'agressif' | 'hebdo' | 'briefing'; id: string; canaux: { push: boolean; email: boolean } };

const pad = (n: number) => String(n).padStart(2, '0');
const parse = (s: string) => new Date(`${s}T00:00:00Z`);
const ymd = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const addDays = (s: string, n: number) => {
  const d = parse(s);
  d.setUTCDate(d.getUTCDate() + n);
  return ymd(d);
};
const arrondi = (n: number) => Math.round(n * 100) / 100;
const lundi = (s: string) => addDays(s, -((parse(s).getUTCDay() + 6) % 7));
const MOIS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
/** « 3 novembre » */
export const jourDit = (s: string) => `${Number(s.slice(8, 10))}${s.slice(8, 10) === '01' ? 'er' : ''} ${MOIS[Number(s.slice(5, 7)) - 1]}`;
/** « octobre 2026 » pour « 2026-10 » */
export const moisDit = (m: string) => `${MOIS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
const symbole = (f: Reglages | undefined) => (f?.devise === 'CDF' ? 'FC' : f?.devise || '€');

/* ---------- Prêts entre personnes ---------- */

/** Où en est un prêt : déjà rendu, ce qui reste, et son état au jour `jour`. */
export function suiviPret(p: Pret, jour: string) {
  const rendu = arrondi((p.remboursements || []).reduce((s, r) => s + (r.montant > 0 ? r.montant : 0), 0));
  const reste = arrondi(Math.max(0, p.montant - rendu));
  const etat: EtatPret = reste <= 0 ? 'rembourse' : p.echeance && p.echeance < jour ? 'en_retard' : p.echeance && p.echeance <= addDays(jour, 7) ? 'bientot' : 'en_cours';
  return { rendu, reste, etat };
}

/** Ce qu'on me doit, ce que je dois (prêts non archivés), et combien de prêts sont en retard. */
export function totauxPrets(prets: Pret[] | undefined, jour: string) {
  let onMeDoit = 0;
  let jeDois = 0;
  let enRetard = 0;
  for (const p of prets || []) {
    if (p.archive) continue;
    const s = suiviPret(p, jour);
    if (p.sens === 'prete') onMeDoit += s.reste;
    else jeDois += s.reste;
    if (s.etat === 'en_retard') enRetard++;
  }
  return { onMeDoit: arrondi(onMeDoit), jeDois: arrondi(jeDois), net: arrondi(onMeDoit - jeDois), enRetard };
}

/**
 * Rappels des prêts : la veille et le jour de l'échéance, puis une fois par semaine (le lundi) tant que l'argent n'est
 * pas rendu. Rien pour un prêt sans échéance, archivé ou entièrement remboursé.
 */
export function alertesPrets(f: FinancesAvancees | undefined, jour: string, heureParDefaut: string): AlerteAvancee[] {
  if (!f?.prets?.length || f.alertes?.prets === false) return [];
  const a = f.alertes || {};
  const heure = /^\d{2}:\d{2}$/.test(a.heure || '') ? a.heure! : heureParDefaut;
  const canaux = { push: a.push !== false, email: a.email !== false };
  const d = symbole(f);
  const out: AlerteAvancee[] = [];
  for (const p of f.prets) {
    if (p.archive || !p.echeance) continue;
    const s = suiviPret(p, jour);
    if (s.etat === 'rembourse') continue;
    const reste = montant(s.reste, d);
    const prete = p.sens === 'prete';
    const origine = `${montant(p.montant, d)} ${prete ? 'prêtés' : 'empruntés'} le ${jourDit(p.date)}${s.rendu > 0 ? `, ${montant(s.rendu, d)} déjà rendus` : ''}.`;
    if (addDays(jour, 1) === p.echeance)
      out.push({ heure, id: `pret|${p.id}|veille|${p.echeance}`, mode: 'hebdo', titre: prete ? `Demain, ${p.personne} doit te rendre ${reste}` : `Demain : rendre ${reste} à ${p.personne}`, corps: origine, canaux });
    else if (jour === p.echeance)
      out.push({ heure, id: `pret|${p.id}|jour|${p.echeance}`, mode: 'agressif', titre: prete ? `Aujourd'hui, ${p.personne} doit te rendre ${reste}` : `Aujourd'hui : rendre ${reste} à ${p.personne}`, corps: origine, canaux });
    else if (s.etat === 'en_retard' && jour === lundi(jour))
      out.push({ heure, id: `pret|${p.id}|retard|${jour}`, mode: 'agressif', titre: prete ? `${p.personne} te doit encore ${reste}` : `Tu dois encore ${reste} à ${p.personne}`, corps: `Prévu le ${jourDit(p.echeance)}. ${origine}`, canaux });
  }
  return out;
}

/* ---------- Paiements à venir ---------- */

/** n-ième échéance d'un paiement récurrent ; un 31 tombe le dernier jour des mois plus courts (comme l'app, `echeance`). */
export function echeanceRecurrence(r: Pick<RecurrenceRappel, 'debut' | 'frequence'>, n: number) {
  if (r.frequence === 'semaine') return addDays(r.debut, 7 * n);
  const d = parse(r.debut);
  const mois = d.getUTCMonth() + (r.frequence === 'mois' ? n : 12 * n);
  const dernier = new Date(Date.UTC(d.getUTCFullYear(), mois + 1, 0)).getUTCDate();
  return ymd(new Date(Date.UTC(d.getUTCFullYear(), mois, Math.min(d.getUTCDate(), dernier))));
}

export type Echeance = { recurrence: string; genre: 'depense' | 'revenu'; note: string; montant: number; date: string };

/** Les échéances des paiements récurrents après `jour`, jusqu'à `jour + jours` inclus, de la plus proche à la plus lointaine. */
export function echeancesAVenir(recurrences: RecurrenceRappel[] | undefined, jour: string, jours = 30): Echeance[] {
  const limite = addDays(jour, jours);
  const out: Echeance[] = [];
  for (const r of recurrences || []) {
    for (let n = 0; n < 5000; n++) {
      const x = echeanceRecurrence(r, n);
      if (x > limite || (r.fin && x > r.fin)) break;
      if (x <= jour || (r.derniere && x <= r.derniere)) continue;
      out.push({ recurrence: r.id, genre: r.genre, note: r.note, montant: r.montant, date: x });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || b.montant - a.montant);
}

/** La veille de chaque dépense récurrente : « Demain : Loyer, 300 $ ». Un seul rappel par jour, qui les regroupe. */
export function alertesEcheances(f: FinancesAvancees | undefined, jour: string, heureParDefaut: string): AlerteAvancee[] {
  if (!f?.recurrences?.length || f.alertes?.echeances === false) return [];
  const a = f.alertes || {};
  const demain = addDays(jour, 1);
  const l = echeancesAVenir(f.recurrences, jour, 1).filter((e) => e.genre === 'depense' && e.date === demain);
  if (!l.length) return [];
  const d = symbole(f);
  const total = arrondi(l.reduce((s, e) => s + e.montant, 0));
  const heure = /^\d{2}:\d{2}$/.test(a.heure || '') ? a.heure! : heureParDefaut;
  const titre = l.length === 1 ? `Demain : ${l[0].note || 'paiement récurrent'}, ${montant(l[0].montant, d)}` : `Demain : ${l.length} paiements, ${montant(total, d)}`;
  const corps = `${l.length === 1 ? 'Ce paiement revient' : `${l.map((e) => `${e.note || 'Paiement'} (${montant(e.montant, d)})`).join(', ')}. Ils reviennent`} régulièrement : prévois l'argent sur le bon compte.`;
  return [{ heure, id: `echeances|${demain}`, mode: 'hebdo', titre, corps, canaux: { push: a.push !== false, email: a.email !== false } }];
}

/* ---------- Bilan du mois ---------- */

const SANS_CATEGORIE = 'Sans catégorie';
const moisDe = (s: string) => s.slice(0, 7);
/** Le mois d'avant « AAAA-MM ». */
export const moisPrecedent = (m: string) => {
  const d = parse(`${m}-01`);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return ymd(d).slice(0, 7);
};

export type Bilan = {
  mois: string;
  depenses: number;
  revenus: number;
  /** Revenus moins dépenses : ce qui reste (positif) ou ce qui manque (négatif). */
  solde: number;
  operations: number;
  /** Les postes de dépense du mois, du plus gros au plus petit (première catégorie de chaque dépense). */
  categories: { categorie: string; montant: number; part: number }[];
  plusGrosse: { note: string; montant: number; date: string } | null;
  precedent: { depenses: number; revenus: number; solde: number };
};

/** Le bilan d'un mois « AAAA-MM » : dépenses, revenus, solde, postes, et le mois d'avant pour comparer. Virements entre comptes exclus. */
export function bilanMois(f: { depenses?: (Operation & { note?: string })[]; revenus?: Operation[] } | undefined, mois: string): Bilan {
  const dep = (f?.depenses || []).filter((x) => !x.lien);
  const rev = (f?.revenus || []).filter((x) => !x.lien);
  const somme = (l: Operation[], m: string) => arrondi(l.filter((x) => moisDe(x.date) === m).reduce((s, x) => s + x.montant, 0));
  const duMois = dep.filter((x) => moisDe(x.date) === mois);
  const depenses = somme(dep, mois);
  const revenus = somme(rev, mois);
  const parCat = new Map<string, number>();
  for (const x of duMois) {
    const c = x.categories?.[0] || SANS_CATEGORIE;
    parCat.set(c, (parCat.get(c) || 0) + x.montant);
  }
  const categories = [...parCat]
    .map(([categorie, m]) => ({ categorie, montant: arrondi(m), part: depenses > 0 ? Math.round((m / depenses) * 100) : 0 }))
    .sort((a, b) => b.montant - a.montant);
  const g = duMois.reduce<(typeof duMois)[number] | null>((m, x) => (!m || x.montant > m.montant ? x : m), null);
  const p = moisPrecedent(mois);
  const precedent = { depenses: somme(dep, p), revenus: somme(rev, p), solde: 0 };
  precedent.solde = arrondi(precedent.revenus - precedent.depenses);
  return {
    mois,
    depenses,
    revenus,
    solde: arrondi(revenus - depenses),
    operations: duMois.length + rev.filter((x) => moisDe(x.date) === mois).length,
    categories,
    plusGrosse: g ? { note: g.note || '', montant: g.montant, date: g.date } : null,
    precedent,
  };
}

/** Le bilan du mois écoulé, le 1er du mois au matin. Rien si le mois n'a aucune opération. */
export function alerteBilan(f: FinancesAvancees | undefined, jour: string, heureMatin: string): AlerteAvancee[] {
  if (!f || f.alertes?.bilan === false || jour.slice(8, 10) !== '01') return [];
  const b = bilanMois(f, moisPrecedent(moisDe(jour)));
  if (!b.operations) return [];
  const d = symbole(f);
  const solde = b.solde >= 0 ? `${montant(b.solde, d)} de côté` : `${montant(-b.solde, d)} de plus que reçu`;
  const poste = b.categories[0] && b.categories[0].categorie !== SANS_CATEGORIE ? ` Premier poste : ${b.categories[0].categorie} (${montant(b.categories[0].montant, d)}).` : '';
  const evolution =
    b.precedent.depenses > 0 ? ` ${b.depenses <= b.precedent.depenses ? 'Moins' : 'Plus'} de dépenses que le mois d'avant (${montant(b.precedent.depenses, d)}).` : '';
  const a = f.alertes || {};
  return [
    {
      heure: heureMatin,
      id: `bilan|${b.mois}`,
      mode: 'briefing',
      titre: `Ton bilan de ${moisDit(b.mois)}`,
      corps: `Dépensé ${montant(b.depenses, d)}, reçu ${montant(b.revenus, d)} : ${solde}.${poste}${evolution}`,
      canaux: { push: a.push !== false, email: a.email !== false },
    },
  ];
}
