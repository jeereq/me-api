import { parse } from '../commun/jours.js';

/**
 * Le message qui te rappelle d'ouvrir Me quand tu ne l'as pas ouverte depuis des jours.
 * Il part le matin, une seule fois par seuil (2, 5, 10 et 21 jours d'absence), jamais chaque jour.
 * Module pur : pas de base ni d'envoi, il se teste seul.
 */
export const SEUILS_ABSENCE = [2, 5, 10, 21];

const pluriel = (n: number, un: string, plusieurs: string) => `${n} ${n > 1 ? plusieurs : un}`;
const joursEntre = (a: string, b: string) => Math.round((parse(b).getTime() - parse(a).getTime()) / 86400000);

export type AvisAbsence = { cle: string; titre: string; corps: string; jours: number };

/**
 * `derniereVue` et `aujourdhui` : des jours « AAAA-MM-JJ » à l'heure de la personne. `relances` et `taches` : ce qui attend déjà.
 * Rien avant deux jours d'absence ; au-delà, un message par seuil franchi (la clé change avec le seuil et avec la dernière visite).
 */
export function avisAbsence(o: { derniereVue: string; aujourdhui: string; relances: number; taches: number }): AvisAbsence | null {
  const jours = joursEntre(o.derniereVue, o.aujourdhui);
  const seuil = [...SEUILS_ABSENCE].reverse().find((s) => jours >= s);
  if (!seuil) return null;
  const attente = [o.relances ? pluriel(o.relances, 'relance', 'relances') : '', o.taches ? pluriel(o.taches, 'tâche', 'tâches') : ''].filter(Boolean).join(' et ');
  return {
    cle: `absence|${o.derniereVue}|${seuil}`,
    titre: `Ça fait ${jours} jours que tu n'as pas ouvert Me`,
    corps: attente ? `${attente} ${o.relances + o.taches > 1 ? 'attendent' : 'attend'} déjà. Deux minutes suffisent pour reprendre la main.` : 'Ton briefing du jour est prêt. Deux minutes suffisent pour reprendre la main.',
    jours,
  };
}
