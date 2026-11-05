import { estAutomatique } from '../../commun/mails-auto.js';

import type { Personne } from './ecriture.js';

/** Trouver une personne d'après les mails du compte : traduit la saisie pour Gmail et Outlook, puis garde qui correspond. Module pur. */

const propre = (q: string) => q.trim().replace(/["\\(){}]/g, '');
const norme = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

/** Gmail : la personne en expéditeur, destinataire ou copie. */
export function requetePersonneGmail(q: string): string {
  const v = propre(q);
  const x = /\s/.test(v) ? `"${v}"` : v;
  return `{from:${x} to:${x} cc:${x}}`;
}

/** Outlook : `participants` couvre l'expéditeur, les destinataires et les copies. */
export const requetePersonneOutlook = (q: string) => `"participants:${propre(q)}"`;

/** Les personnes qui correspondent : un mot qui commence par la saisie d'abord, puis les plus présentes. Sans moi ni les robots. */
export function personnesTrouvees(listes: Personne[][], q: string, moi: string[], max = 8): Personne[] {
  const cherche = norme(q.trim());
  if (cherche.length < 2) return [];
  const exclus = new Set(moi.map((x) => x.toLowerCase()));
  const vues = new Map<string, { p: Personne; n: number; debut: boolean }>();
  for (const p of listes.flat()) {
    const cle = p.adresse.toLowerCase();
    if (exclus.has(cle) || estAutomatique({ adresse: p.adresse })) continue;
    const texte = norme(`${p.nom ?? ''} ${p.adresse}`);
    if (!texte.includes(cherche)) continue;
    const deja = vues.get(cle);
    if (deja) {
      deja.n++;
      if (!deja.p.nom && p.nom) deja.p = p;
    } else vues.set(cle, { p, n: 1, debut: texte.split(/[\s.@_-]+/).some((m) => m.startsWith(cherche)) });
  }
  return [...vues.values()]
    .sort((a, b) => Number(b.debut) - Number(a.debut) || b.n - a.n)
    .slice(0, max)
    .map((x) => x.p);
}
