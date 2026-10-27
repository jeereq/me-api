import { montant } from './previsions.js';

/**
 * Rappels des objectifs financiers, repris de l'app (me-mobile/src/lib/objectifs.ts, `suiviObjectif` et `datesVersements`).
 * Dates en texte « AAAA-MM-JJ », calculées en UTC : le fuseau du serveur n'intervient pas.
 */

export type ObjectifRappel = {
  id: string;
  nom: string;
  emoji?: string;
  genre?: 'epargne' | 'dette';
  cible: number;
  depart?: number;
  debut: string;
  echeance: string;
  versements?: { id: string; date: string; montant: number }[];
  plan?: { cadence?: 'semaine' | 'mois'; versement?: number };
  archive?: boolean;
};
export type AlerteObjectif = { heure: string; titre: string; corps: string; mode: 'agressif' | 'hebdo'; id: string; canaux: { push: boolean; email: boolean } };
type Reglages = { devise?: string; alertes?: { heure?: string; push?: boolean; email?: boolean } };

const pad = (n: number) => String(n).padStart(2, '0');
const parse = (s: string) => new Date(`${s}T00:00:00Z`);
const ymd = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const addDays = (s: string, n: number) => {
  const d = parse(s);
  d.setUTCDate(d.getUTCDate() + n);
  return ymd(d);
};
const ecart = (a: string, b: string) => Math.round((parse(b).getTime() - parse(a).getTime()) / 864e5);
const arrondi = (n: number) => Math.round(n * 100) / 100;
const hautCent = (n: number) => Math.ceil(n * 100 - 1e-9) / 100;

/** n-ième date de versement : même jour du mois (un 31 tombe le dernier jour des mois plus courts), ou même jour de la semaine. */
function dateVersement(o: Pick<ObjectifRappel, 'debut' | 'plan'>, n: number) {
  if (o.plan?.cadence === 'semaine') return addDays(o.debut, 7 * n);
  const d = parse(o.debut);
  const mois = d.getUTCMonth() + n;
  const dernier = new Date(Date.UTC(d.getUTCFullYear(), mois + 1, 0)).getUTCDate();
  return ymd(new Date(Date.UTC(d.getUTCFullYear(), mois, Math.min(d.getUTCDate(), dernier))));
}
/** Les dates de versement du plan jusqu'à l'échéance ; si elle est plus proche que la première, un seul versement : l'échéance. */
export function datesVersements(o: Pick<ObjectifRappel, 'debut' | 'echeance' | 'plan'>): string[] {
  const l: string[] = [];
  for (let n = 1; n <= 1500; n++) {
    const x = dateVersement(o, n);
    if (x > o.echeance) break;
    l.push(x);
  }
  return l.length ? l : [o.echeance];
}

/** Le même suivi que l'app, réduit à ce qu'il faut aux rappels. */
export function suiviRappel(o: ObjectifRappel, d: string) {
  const verse = arrondi((o.versements || []).reduce((s, v) => s + v.montant, 0));
  const acquis = arrondi((o.depart || 0) + verse);
  const cible = Math.max(0, o.cible);
  const reste = arrondi(Math.max(0, cible - acquis));
  const atteint = cible > 0 && acquis >= cible;
  const jours = Math.max(1, ecart(o.debut, o.echeance));
  const ecoules = Math.min(jours, Math.max(0, ecart(o.debut, d)));
  const base = Math.min(o.depart || 0, cible);
  const attendu = arrondi(base + ((cible - base) * ecoules) / jours);
  const tolerance = cible * 0.03;
  const etat = atteint ? 'atteint' : o.debut > d ? 'a_venir' : o.echeance < d ? 'depasse' : acquis - attendu < -tolerance ? 'en_retard' : 'ok';
  const restants = datesVersements(o).filter((x) => x >= d).length;
  const requis = reste > 0 ? hautCent(reste / Math.max(1, restants)) : 0;
  const versement = o.plan?.versement && o.plan.versement > 0 ? o.plan.versement : requis;
  return { acquis, reste, atteint, etat, attendu, versement: Math.min(versement, reste) };
}

/** Lundi de la semaine : une alerte de retard part au plus une fois par semaine. */
const lundi = (s: string) => addDays(s, -((parse(s).getUTCDay() + 6) % 7));

/**
 * Alertes d'une journée pour les objectifs : versement prévu aujourd'hui (s'il n'est pas déjà noté), retard sur le plan
 * (une fois par semaine), échéance passée (une fois) et objectif atteint (une fois, dans les deux jours).
 */
export function alertesObjectifs(f: Reglages & { objectifs?: ObjectifRappel[] } | undefined, jour: string, heureParDefaut: string): AlerteObjectif[] {
  if (!f?.objectifs?.length) return [];
  const a = f.alertes || {};
  const devise = f.devise === 'CDF' ? 'FC' : f.devise || '€';
  const heure = /^\d{2}:\d{2}$/.test(a.heure || '') ? a.heure! : heureParDefaut;
  const canaux = { push: a.push !== false, email: a.email !== false };
  const out: AlerteObjectif[] = [];
  for (const o of f.objectifs) {
    if (o.archive) continue;
    const s = suiviRappel(o, jour);
    const nom = `${o.emoji ? `${o.emoji} ` : ''}${o.nom}`;
    const dette = o.genre === 'dette';
    if (s.atteint) {
      const dernier = (o.versements || []).reduce((m, v) => (v.date > m ? v.date : m), '');
      if (dernier && dernier >= addDays(jour, -2) && dernier <= jour)
        out.push({ heure, id: `objectif|${o.id}|atteint`, mode: 'hebdo', titre: `Objectif atteint : ${nom}`, corps: dette ? `Tout est remboursé : ${montant(o.cible, devise)}.` : `${montant(o.cible, devise)} de côté. Bravo !`, canaux });
      continue;
    }
    if (s.etat === 'a_venir') continue;
    const paye = (o.versements || []).some((v) => v.date === jour);
    if (s.etat === 'depasse') {
      out.push({ heure, id: `objectif|${o.id}|depasse`, mode: 'agressif', titre: `Échéance passée : ${nom}`, corps: `Il manque ${montant(s.reste, devise)} sur ${montant(o.cible, devise)}. Verse ce que tu peux, ou repousse la date.`, canaux });
      continue;
    }
    if (!paye && s.versement > 0 && datesVersements(o).includes(jour))
      out.push({ heure, id: `objectif|${o.id}|versement|${jour}`, mode: 'hebdo', titre: `${dette ? 'Remboursement' : 'Versement'} prévu aujourd'hui : ${nom}`, corps: `${montant(s.versement, devise)} à ${dette ? 'rembourser' : 'mettre de côté'} (${montant(s.acquis, devise)} sur ${montant(o.cible, devise)}).`, canaux });
    else if (s.etat === 'en_retard')
      out.push({ heure, id: `objectif|${o.id}|retard|${lundi(jour)}`, mode: 'hebdo', titre: `En retard sur ton plan : ${nom}`, corps: `${montant(s.acquis, devise)} réunis alors que ${montant(s.attendu, devise)} étaient attendus. Prochain versement conseillé : ${montant(s.versement, devise)}.`, canaux });
  }
  return out;
}
